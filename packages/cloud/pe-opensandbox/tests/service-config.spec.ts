/** Pure serialized configuration and real byte-tail projections; no provider, process or network is started. */
import { expect, it, vi } from 'vitest'
import { parseManagedCoordinatorConfig } from '../src/managed-config.ts'
import { SLICE_LIMITS } from '../src/agent-data/constants.ts'
import { CollectedOutputMirror } from '../src/collected-output.ts'
import { guardianEncodedBudget } from '../src/agent-data/encoded-budget.ts'

function legacy() {
  return { maxBoundAccounts: 2, maxActiveCommands: 4, maxActiveCommandsPerAccount: 2,
    maxResidentCommands: 8, maxResidentCommandsPerAccount: 4, maxResidentBytes: 524288, maxResidentBytesPerAccount: 262144,
    maxStopObservers: 4, stopWaitBudgetMs: 10000, recoveryPageSize: 2,
    allocations: { environmentVersion: 'env-v1', provider: 'opensandbox', createBudgetMs: 30000,
      maxAllocations: 4, maxAllocationsPerAccount: 2, maxWaiters: 8, maxWaitersPerAllocation: 4 },
    store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 32768,
      maxRows: 8, maxCapabilities: 5, maxPendingQueries: 4, maxMutationResponsibilities: 8, maxRetainedBytes: 1048576 },
    commands: { allowedTools: ['bash'], maxScopes: 4, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16,
      maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
      pollIntervalMs: 1000, maxWaiters: 4, maxLifetimeMs: 12000, stopWaitMs: 2000 } },
    shell: { bashPath: '/bin/bash', timeoutMs: 3000, maxTimeoutMs: 5000, maxOutputBytes: 4096, graceMs: 1000 } }
}
function enabled(output = 32) {
  const base = legacy()
  return { ...base, commands: { ...base.commands, allowedTools: ['bash', 'dev_service'],
    commandLimits: { ...base.commands.commandLimits, maxLifetimeMs: 190000 },
    services: { profile: { kind: 'python-http-v1', port: 8000, startWaitMs: 5000, runMs: 120000,
      stopWaitMs: 5000, maxLogReadBytes: 3 * output, maxReplyBytes: 32768,
      maxScriptBytes: 256, maxArgs: 8, maxArgBytes: 256, maxArgsBytes: 2048 },
    maxOutputBytes: output, graceMs: 1000 } } }
}

it('keeps old complete JSON explicitly service-closed without requiring the service lifetime window', () => {
  const input = legacy(), parsed = parseManagedCoordinatorConfig(JSON.parse(JSON.stringify(input)))
  expect(parsed).toEqual(input)
  expect(Object.hasOwn(parsed.commands, 'services')).toBe(false)
  expect(parsed.commands.allowedTools).toEqual(['bash'])
  expect(parsed.commands.commandLimits.maxLifetimeMs).toBe(12000)
})

it('resolves the complete serialized service policy once into independent frozen values', () => {
  const input = enabled(), parsed = parseManagedCoordinatorConfig(input)
  expect(parsed).toEqual(input)
  for (const value of [parsed.commands, parsed.commands.allowedTools, parsed.commands.services,
    parsed.commands.services?.profile]) expect(Object.isFrozen(value)).toBe(true)
  input.commands.services.profile.runMs = 1; input.commands.services.maxOutputBytes = 1
  expect(parsed.commands.services?.profile.runMs).toBe(120000)
  expect(parsed.commands.services?.maxOutputBytes).toBe(32)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  expect(parsed.commands.services).not.toHaveProperty('operationLimits')
  expect(parsed.commands.services).not.toHaveProperty('assertQualified')
})

it('requires exact ordered consumers to match the presence of the service policy', () => {
  for (const allowedTools of [['bash'], ['dev_service', 'bash'], ['bash', 'dev_service', 'other'], ['bash', 'bash'], []]) {
    const input = enabled(); input.commands.allowedTools = allowedTools
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.allowedTools')
  }
  const input = legacy(); input.commands.allowedTools = ['bash', 'dev_service']
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.allowedTools')
})

it('requires services to be an own enumerable data property without invoking accessors', () => {
  const getter = vi.fn(() => { throw new Error('must-not-evaluate') })
  for (const descriptor of [{ get: getter, enumerable: true }, { value: enabled().commands.services, enumerable: false }]) {
    const input = enabled(); Object.defineProperty(input.commands, 'services', descriptor)
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands')
  }
  expect(getter).not.toHaveBeenCalled()
  for (const services of [undefined, null, false, [], 'disabled']) {
    const input = enabled()
    Object.defineProperty(input.commands, 'services', { value: services, enumerable: true })
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services')
  }
  const input = enabled(), { services, ...commands } = input.commands
  const inherited: unknown = Object.assign(Object.create({ services }), commands)
  expect(() => parseManagedCoordinatorConfig({ ...input, commands: inherited })).toThrow('commands')
  const nullPrototype: unknown = Object.assign(Object.create(null), input.commands)
  expect(parseManagedCoordinatorConfig({ ...input, commands: nullPrototype }).commands.services).toEqual(services)
})

it('does not relax exact keys or own data checks at the service/profile/consumer-array levels', () => {
  for (const target of ['services', 'profile'] as const) {
    const input = enabled(), value = target === 'services' ? input.commands.services : input.commands.services.profile
    Object.assign(value, { privateUnexpected: 'do-not-echo-this' })
    let failure: unknown
    try { parseManagedCoordinatorConfig(input) } catch (cause) { failure = cause }
    expect(String(failure)).not.toContain('privateUnexpected'); expect(String(failure)).not.toContain('do-not-echo-this')
    expect(failure).toMatchObject({ code: 'cloud/invalid-config' })
  }
  const getter = vi.fn(() => 5000), input = enabled()
  Object.defineProperty(input.commands.services.profile, 'startWaitMs', { get: getter, enumerable: true })
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('profile'); expect(getter).not.toHaveBeenCalled()
  for (const extra of ['own', Symbol('private')]) {
    const value = enabled(); Object.defineProperty(value.commands.allowedTools, extra, { value: 'private' })
    expect(() => parseManagedCoordinatorConfig(value)).toThrow('allowedTools')
  }
  const array = enabled()
  Object.defineProperty(array.commands.allowedTools, '1', { get: getter, enumerable: true })
  expect(() => parseManagedCoordinatorConfig(array)).toThrow('allowedTools'); expect(getter).not.toHaveBeenCalled()
})

it('requires all eleven profile fields and all three service fields without defaults', () => {
  const complete = enabled()
  expect(Object.keys(complete.commands.services.profile)).toHaveLength(11)
  for (const key of Object.keys(complete.commands.services.profile)) {
    const input = enabled()
    Reflect.deleteProperty(input.commands.services.profile, key)
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services.profile')
  }
  for (const key of ['profile', 'maxOutputBytes', 'graceMs']) {
    const input = enabled(); Reflect.deleteProperty(input.commands.services, key)
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services')
  }
})

it('rejects nonfinite, nonpositive, fractional, overflowing and nonnumeric limits', () => {
  const numeric = ['startWaitMs', 'runMs', 'stopWaitMs', 'maxLogReadBytes', 'maxReplyBytes',
    'maxScriptBytes', 'maxArgs', 'maxArgBytes', 'maxArgsBytes']
  for (const key of numeric) for (const value of [0, -1, 1.5, NaN, Infinity, 2147483648, '1', true]) {
    const input = enabled(); Object.assign(input.commands.services.profile, { [key]: value })
    expect(() => parseManagedCoordinatorConfig(input)).toThrow(`profile.${key}`)
  }
  for (const key of ['maxOutputBytes', 'graceMs']) for (const value of [0, -1, 1.5, Infinity, 2147483648]) {
    const input = enabled(); Object.assign(input.commands.services, { [key]: value })
    expect(() => parseManagedCoordinatorConfig(input)).toThrow(`services.${key}`)
  }
})

it('accepts only the fixed kind/port and actual v9 remote role duration', () => {
  for (const profile of [{ kind: 'shell' }, { port: 8001 }, { port: '8000' }, { runMs: 20000 }, { runMs: 120001 }]) {
    const input = enabled(); Object.assign(input.commands.services.profile, profile)
    expect(() => parseManagedCoordinatorConfig(input)).toThrow('commands.services.profile')
  }
  expect(parseManagedCoordinatorConfig(enabled()).commands.services?.profile.runMs).toBe(SLICE_LIMITS.serviceRunMs)
})

it('reuses the controller and requires the exact remote run/prepare/stop window while keeping observers independent', () => {
  const input = enabled()
  const minimum = SLICE_LIMITS.serviceRunMs + SLICE_LIMITS.prepareMs + SLICE_LIMITS.stopMs
  input.commands.commandLimits.maxLifetimeMs = minimum
  input.commands.services.profile.startWaitMs = minimum
  input.commands.services.profile.stopWaitMs = minimum
  const parsed = parseManagedCoordinatorConfig(input)
  expect(parsed.commands.commandLimits.maxLifetimeMs).toBe(125000)
  expect(parsed.commands.services?.profile.runMs).toBe(120000)
  expect(parsed.commands.services?.profile.startWaitMs).toBe(125000)
  input.commands.commandLimits.maxLifetimeMs--
  input.commands.services.profile.startWaitMs = 5000; input.commands.services.profile.stopWaitMs = 5000
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxLifetimeMs')
  for (const key of ['startWaitMs', 'stopWaitMs']) {
    const value = enabled(); Object.assign(value.commands.services.profile, { [key]: 190001 })
    expect(() => parseManagedCoordinatorConfig(value)).toThrow(`profile.${key}`)
  }
})

it('bounds raw collection and drain grace by the same command controller', () => {
  const input = enabled(4096)
  expect(parseManagedCoordinatorConfig(input).commands.services?.maxOutputBytes).toBe(4096)
  input.commands.services.maxOutputBytes++
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxOutputBytes')
  const grace = enabled(); grace.commands.services.graceMs = 190001
  expect(() => parseManagedCoordinatorConfig(grace)).toThrow('graceMs')
})

it('plans final UTF8 logs for actual mirror replacement expansion instead of equating raw and string byte sizes', () => {
  const input = enabled(256), mirror = new CollectedOutputMirror({ maxBytes: 256 }, 65536)
  mirror.push(Buffer.alloc(256, 255))
  const textBytes = Buffer.byteLength(mirror.readFrom(0).text)
  expect(textBytes).toBe(768)
  input.commands.services.profile.maxLogReadBytes = textBytes
  expect(parseManagedCoordinatorConfig(input).commands.services?.profile.maxLogReadBytes).toBe(textBytes)
  input.commands.services.profile.maxLogReadBytes--
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxLogReadBytes')
  mirror.release()
})

it('accepts the exact complete JSON log envelope budget and rejects one byte less', () => {
  const input = enabled(256), mirror = new CollectedOutputMirror({ maxBytes: 256 }, 65536)
  mirror.replaceTail(Buffer.alloc(256), 65536)
  const value = { action: 'log', serviceHandle: 'x'.repeat(64), observation: mirror.readFrom(65536 - 256) }
  const completeBytes = Buffer.byteLength(JSON.stringify(value))
  expect(completeBytes).toBeGreaterThan(6 * 256)
  input.commands.services.profile.maxReplyBytes = completeBytes
  expect(parseManagedCoordinatorConfig(input).commands.services?.profile.maxReplyBytes).toBe(completeBytes)
  input.commands.services.profile.maxReplyBytes--
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxReplyBytes')
  mirror.release()
})

it('reserves startup/status metadata even for tiny logs and keeps the consumer log/reply relation', () => {
  const input = enabled(1)
  const startup = { action: 'start', serviceHandle: 'x'.repeat(64), observation: { phase: 'process-submitted',
    serviceId: 'x'.repeat(64), processSubmitted: false, httpReady: false, direct: 'pending', range: 'pending',
    exitCode: null, signal: 'SIGVTALRM', uncertain: true } }
  const bytes = Buffer.byteLength(JSON.stringify(startup))
  input.commands.services.profile.maxReplyBytes = bytes
  expect(parseManagedCoordinatorConfig(input).commands.services?.profile.maxReplyBytes).toBe(bytes)
  input.commands.services.profile.maxReplyBytes--
  expect(() => parseManagedCoordinatorConfig(input)).toThrow('maxReplyBytes')
  const inconsistent = enabled(); inconsistent.commands.services.profile.maxLogReadBytes = 32769
  expect(() => parseManagedCoordinatorConfig(inconsistent)).toThrow('maxReplyBytes')
})

it('plans argument limits but still relies on the actual complete guardian argv/cwd encoding rejection', () => {
  const input = enabled(); input.commands.services.profile.maxArgs = 16
  expect(parseManagedCoordinatorConfig(input).commands.services?.profile.maxArgs).toBe(16)
  const argv = ['/opt/session-env/venv/bin/python', '-B', '/srv/project/hello.py', ...Array.from({ length: 16 }, () => 'x')]
  expect(() => guardianEncodedBudget('/srv/project', { argv, cwd: '/srv/project', stdin: { mode: 'ignore' } })).toThrow()
  expect(() => guardianEncodedBudget('/srv/project', { argv: argv.slice(0, 3), cwd: '/srv/project/' + 'x'.repeat(512), stdin: { mode: 'ignore' } })).toThrow()
  expect(() => guardianEncodedBudget('/srv/project', { argv: [...argv.slice(0, 3), '\x01'.repeat(1000)], cwd: '/srv/project', stdin: { mode: 'ignore' } })).toThrow()
  for (const [field, value] of Object.entries({ maxArgs: 17, maxScriptBytes: 4097, maxArgBytes: 4097, maxArgsBytes: 4097 })) {
    const invalid = enabled(); Object.assign(invalid.commands.services.profile, { [field]: value })
    expect(() => parseManagedCoordinatorConfig(invalid)).toThrow(field)
  }
})
