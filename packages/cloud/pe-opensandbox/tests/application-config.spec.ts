/** Pure application policy resolution and pre-I/O refusals; no service, socket or resource is created. */
import { expect, it, vi } from 'vitest'
import { parseManagedCoordinatorConfig } from '../src/managed-config.ts'
import { SLICE_LIMITS } from '../src/agent-data/constants.ts'
import { createSelectedServerHttp, type PreviewHttpOwner } from '../src/application-http.ts'

function serviceOnly() {
  return { maxBoundAccounts: 2, maxActiveCommands: 4, maxActiveCommandsPerAccount: 2,
    maxResidentCommands: 8, maxResidentCommandsPerAccount: 4, maxResidentBytes: 524288, maxResidentBytesPerAccount: 262144,
    maxStopObservers: 4, stopWaitBudgetMs: 10000, recoveryPageSize: 2,
    allocations: { environmentVersion: 'env-v1', provider: 'opensandbox', createBudgetMs: 30000,
      maxAllocations: 4, maxAllocationsPerAccount: 2, maxWaiters: 8, maxWaitersPerAllocation: 4 },
    store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 32768,
      maxRows: 8, maxCapabilities: 5, maxPendingQueries: 4, maxMutationResponsibilities: 8, maxRetainedBytes: 1048576 },
    commands: { allowedTools: ['bash', 'dev_service'], maxScopes: 4, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16,
      maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
      pollIntervalMs: 1000, maxWaiters: 4, maxLifetimeMs: 190000, stopWaitMs: 2000 },
    services: { profile: { kind: 'python-http-v1', port: 8000, startWaitMs: 5000, runMs: SLICE_LIMITS.serviceRunMs,
      stopWaitMs: 5000, maxLogReadBytes: 96, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 8,
      maxArgBytes: 256, maxArgsBytes: 2048 }, maxOutputBytes: 32, graceMs: 1000 } },
    shell: { bashPath: '/bin/bash', timeoutMs: 3000, maxTimeoutMs: 5000, maxOutputBytes: 4096, graceMs: 1000 } }
}
function enabled() {
  const input = serviceOnly()
  return { ...input, commands: { ...input.commands, services: { ...input.commands.services,
    application: { maxRequests: 4, maxRequestsPerAccount: 2, maxRequestsPerService: 1,
      transport: { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes: 1048576, maxRequestHeaderBytes: 4096,
        maxPathBytes: 2048, timeoutMs: 5000, maxBufferPoolBytes: 8192 } } } } }
}

it('preserves old service JSON with HTTP absent and leaves both existing native consumers unchanged', () => {
  const input = serviceOnly(), parsed = parseManagedCoordinatorConfig(input)
  expect(parsed).toEqual(input)
  expect(parsed.commands.allowedTools).toEqual(['bash', 'dev_service'])
  expect(Object.hasOwn(parsed.commands.services ?? {}, 'application')).toBe(false)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(input)
})

it('resolves only serialized counts and transport into independent frozen policy, without authority', () => {
  const input = enabled(), parsed = parseManagedCoordinatorConfig(input)
  expect(parsed).toEqual(input)
  expect(parseManagedCoordinatorConfig(JSON.parse(JSON.stringify(input)))).toEqual(parsed)
  const application = parsed.commands.services?.application
  expect(Object.isFrozen(application)).toBe(true); expect(Object.isFrozen(application?.transport)).toBe(true)
  input.commands.services.application.maxRequests = 1
  input.commands.services.application.transport.timeoutMs = 1
  expect(application?.maxRequests).toBe(4); expect(application?.transport.timeoutMs).toBe(5000)
  expect(application).not.toHaveProperty('reserve'); expect(application).not.toHaveProperty('enabled')
  expect(application).not.toHaveProperty('qualified'); expect(application).not.toHaveProperty('withResponse')
  expect(parsed.commands.allowedTools).toEqual(['bash', 'dev_service'])
})

it('checks optional application presence through exact own enumerable data properties without invoking getters', () => {
  const getter = vi.fn(() => { throw new Error('must-not-run') })
  for (const descriptor of [{ enumerable: true, get: getter }, { enumerable: false, value: enabled().commands.services.application }]) {
    const input = enabled(); Object.defineProperty(input.commands.services, 'application', descriptor)
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services')
  }
  expect(getter).not.toHaveBeenCalled()
  for (const application of [undefined, null, false, [], 'enabled']) {
    const input = enabled(); Object.defineProperty(input.commands.services, 'application', { value: application, enumerable: true })
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services.application')
  }
  const input = enabled(), { application, ...services } = input.commands.services
  const inherited = { ...services }
  Object.setPrototypeOf(inherited, { application })
  expect(() => parseManagedCoordinatorConfig({ ...input, commands: { ...input.commands, services: inherited } })).toThrow('commands.services')
  const plain = { ...input.commands.services }
  Object.setPrototypeOf(plain, null)
  const parsed = parseManagedCoordinatorConfig({ ...input, commands: { ...input.commands, services: plain } })
  expect(parsed.commands.services?.application).toEqual(application)
})

it('requires all three counts and all seven transport fields without defaults', () => {
  for (const key of ['maxRequests', 'maxRequestsPerAccount', 'maxRequestsPerService', 'transport']) {
    const input = enabled(); Reflect.deleteProperty(input.commands.services.application, key)
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services.application')
  }
  const input = enabled()
  expect(Object.keys(input.commands.services.application.transport)).toHaveLength(7)
  for (const key of Object.keys(input.commands.services.application.transport)) {
    const value = enabled(); Reflect.deleteProperty(value.commands.services.application.transport, key)
    expect(() => parseManagedCoordinatorConfig(value)).toThrow('application.transport')
  }
})

it('keeps exact keys at every level and does not accept an application-controlled method, target, secret or qualification', () => {
  for (const target of ['application', 'transport'] as const) {
    for (const key of ['method', 'url', 'apiKey', 'port', 'headers', 'reserve', 'qualified']) {
      const input = enabled(), application = input.commands.services.application
      Object.assign(target === 'application' ? application : application.transport, { [key]: 'private-value' })
      let failure: unknown
      try { parseManagedCoordinatorConfig(input) } catch (cause) { failure = cause }
      expect(failure).toMatchObject({ code: 'cloud/invalid-config' })
      expect(String(failure)).not.toContain('private-value')
    }
  }
  const input = enabled(); Object.assign(input.commands, { application: input.commands.services.application })
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands')
})

it('rejects accessor, nonenumerable and symbolic fields inside application and transport without evaluating them', () => {
  const getter = vi.fn(() => 1)
  for (const target of ['application', 'transport'] as const) {
    const input = enabled(), application = input.commands.services.application
    const value = target === 'application' ? application : application.transport
    const field = target === 'application' ? 'maxRequests' : 'readBufferBytes'
    Object.defineProperty(value, field, { get: getter, enumerable: true })
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('application')
    const hidden = enabled(), row = target === 'application' ? hidden.commands.services.application : hidden.commands.services.application.transport
    Object.defineProperty(row, field, { value: 1, enumerable: false })
    expect(() => parseManagedCoordinatorConfig(hidden)).toThrow('application')
    const symbolic = enabled(), symbolRow = target === 'application' ? symbolic.commands.services.application : symbolic.commands.services.application.transport
    Object.defineProperty(symbolRow, Symbol('private'), { value: 1 })
    expect(() => parseManagedCoordinatorConfig(symbolic)).toThrow('application')
  }
  expect(getter).not.toHaveBeenCalled()
})

it('requires every count and transport quantity to be positive, finite, integral and timer-safe', () => {
  const fields = ['maxRequests', 'maxRequestsPerAccount', 'maxRequestsPerService']
  const transport = Object.keys(enabled().commands.services.application.transport)
  for (const key of [...fields, ...transport]) for (const value of [0, -1, 0.5, NaN, Infinity, 2147483648, '1', true]) {
    const input = enabled(), application = input.commands.services.application
    Object.assign(fields.includes(key) ? application : application.transport, { [key]: value })
    expect(() => parseManagedCoordinatorConfig(input)).toThrow(key)
  }
})

it('keeps per-service and per-account counts within the original global request count', () => {
  const input = enabled()
  Object.assign(input.commands.services.application, { maxRequests: 1, maxRequestsPerAccount: 1, maxRequestsPerService: 1 })
  expect(parseManagedCoordinatorConfig(input).commands.services?.application?.maxRequestsPerService).toBe(1)
  input.commands.services.application.maxRequestsPerAccount = 2
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxRequestsPerAccount')
  input.commands.services.application.maxRequestsPerAccount = 1; input.commands.services.application.maxRequestsPerService = 2
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxRequestsPerService')
})

it('checks read-buffer equality boundaries against both prefetch and wire caps', () => {
  const input = enabled(), transport = input.commands.services.application.transport
  transport.readBufferBytes = transport.prefetchBytes = transport.maxWireBytes = 64
  expect(parseManagedCoordinatorConfig(input).commands.services?.application?.transport.readBufferBytes).toBe(64)
  transport.prefetchBytes--
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('prefetchBytes')
  transport.prefetchBytes++; transport.maxWireBytes--
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxWireBytes')
})

it('caps the HTTP observer by the original controller and service role and does not extend either lifetime', () => {
  const input = enabled(); input.commands.services.application.transport.timeoutMs = SLICE_LIMITS.serviceRunMs
  const parsed = parseManagedCoordinatorConfig(input)
  expect(parsed.commands.services?.application?.transport.timeoutMs).toBe(120000)
  expect(parsed.commands.commandLimits.maxLifetimeMs).toBe(190000)
  expect(parsed.commands.services?.profile.runMs).toBe(120000)
  input.commands.services.application.transport.timeoutMs++
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('timeoutMs')
  input.commands.commandLimits.maxLifetimeMs = 125000; input.commands.services.application.transport.timeoutMs = 125001
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('timeoutMs')
})

it('keeps byte-pool values as declarations rather than a process-pool or Root byte-reservation qualification', () => {
  const input = enabled(); input.commands.services.application.transport.maxBufferPoolBytes = 1
  expect(parseManagedCoordinatorConfig(input).commands.services?.application?.transport.maxBufferPoolBytes).toBe(1)
  const application = parseManagedCoordinatorConfig(input).commands.services?.application
  expect(application).not.toHaveProperty('retainedPayloadBytes')
  expect(application).not.toHaveProperty('headerEntries')
  expect(application).not.toHaveProperty('enabled')
})

it('uses the real GET-only adapter refusal before request retention and cannot turn declarations into transport authority', async () => {
  const config = parseManagedCoordinatorConfig(enabled()).commands.services?.application
  expect(config).toBeDefined()
  if (config === undefined) throw new Error('Expected fixture application policy')
  const refusal = new Error('original Root request reservation was not granted')
  const retain = vi.fn<PreviewHttpOwner['retainRequest']>(() => { throw refusal })
  const transport = createSelectedServerHttp({ lifecycleBaseUrl: 'http://127.0.0.1:4477/v1', apiKey: 'component-only-key',
    limits: config.transport, assertCurrent() {} }, { sandboxId: 'component-only-sandbox', port: 8000, deadlineAtMs: performance.now() + 300000, assertCurrent() {} },
  { retainRequest: retain })
  const consume = vi.fn(async () => {})
  const limits = { maxBodyBytes: 4096, maxChunkBytes: 256, maxChunks: 32, maxHeaderCount: 8, maxHeaderBytes: 4096 }
  await expect(transport.withResponse({ method: 'HEAD', resourcePath: '/', headers: [] }, limits, new AbortController().signal, consume)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(retain).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled()
  await expect(transport.withResponse({ method: 'GET', resourcePath: '/', headers: [] }, limits, new AbortController().signal, consume)).rejects.toBe(refusal)
  expect(retain).toHaveBeenCalledTimes(1); expect(consume).not.toHaveBeenCalled()
  const first = retain.mock.calls[0]
  if (first === undefined) throw new Error('Expected original owner charge before I/O')
  expect(first[0].charge).toEqual({ retainedPayloadBytes: 86529, headerEntries: 12,
    maxWireBytes: 1048576, timeoutMs: 5000 })
})
