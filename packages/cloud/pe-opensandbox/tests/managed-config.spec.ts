/** Pure configuration parsing for the frozen collected carrier; no deployment or service activation. */
import { expect, it } from 'vitest'
import { parseManagedCoordinatorConfig } from '../src/managed-config.ts'
import { SLICE_LIMITS } from '../src/agent-data/constants.ts'

function input() {
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

it('keeps Session file-policy enforcement explicit and preserves the legacy omission', () => {
  expect(parseManagedCoordinatorConfig(input()).shell).not.toHaveProperty('enforceSessionFilePolicy')
  for (const value of [false, true]) {
    const raw = input()
    Object.assign(raw.shell, { enforceSessionFilePolicy: value })
    expect(parseManagedCoordinatorConfig(raw).shell.enforceSessionFilePolicy).toBe(value)
  }
})

it('rejects malformed or accessor Session file-policy flags without invoking code', () => {
  for (const value of [undefined, null, 'true', 1, {}, []]) {
    const raw = input()
    Object.assign(raw.shell, { enforceSessionFilePolicy: value })
    expect(() => parseManagedCoordinatorConfig(raw)).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  }
  const raw = input()
  Object.defineProperty(raw.shell, 'enforceSessionFilePolicy', { enumerable: true, get() { throw new Error('Do not execute configuration accessors') } })
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
})

it('requires complete explicit limits and returns independent frozen settings without changing any values', () => {
  const raw = input(), parsed = parseManagedCoordinatorConfig(raw)
  expect(parsed).toEqual(raw)
  expect(parsed).not.toHaveProperty('mode')
  for (const object of [parsed, parsed.allocations, parsed.store, parsed.commands, parsed.commands.allowedTools,
    parsed.commands.commandLimits, parsed.shell]) expect(Object.isFrozen(object)).toBe(true)
  raw.commands.allowedTools[0] = 'changed'; raw.shell.timeoutMs = 1
  expect(parsed.commands.allowedTools).toEqual(['bash']); expect(parsed.shell.timeoutMs).toBe(3000)
})

it('rejects missing or unknown keys at every object level without echoing unexpected names or values', () => {
  for (const target of ['root', 'allocations', 'store', 'commands', 'commandLimits', 'shell'] as const) {
    const raw = input()
    const object = target === 'root' ? raw : target === 'commandLimits' ? raw.commands.commandLimits : raw[target]
    Object.assign(object, { privateUnexpectedKey: 'private-value-must-not-leak' })
    let failure: unknown
    try { parseManagedCoordinatorConfig(raw) }
    catch (cause) { failure = cause }
    expect(failure).toMatchObject({ code: 'cloud/invalid-config' })
    expect(String(failure)).not.toContain('privateUnexpectedKey')
    expect(String(failure)).not.toContain('private-value-must-not-leak')
  }
  const { shell: _shell, ...missing } = input()
  expect(() => parseManagedCoordinatorConfig(missing)).toThrow('configuration')
  for (const mode of ['session-collect', 'closed', 'pip', 'FastAPI', undefined]) {
    expect(() => parseManagedCoordinatorConfig({ ...input(), mode })).toThrow('configuration')
  }
})

it('rejects non-JSON objects and non-positive, unsafe or timer-overflowing integers', () => {
  for (const value of [null, [], 'session-collect', new Date()]) expect(() => parseManagedCoordinatorConfig(value)).toThrow()
  for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2147483648]) {
    expect(() => parseManagedCoordinatorConfig({ ...input(), maxBoundAccounts: number })).toThrow('maxBoundAccounts')
  }
  const raw = input()
  Object.defineProperty(raw, 'maxBoundAccounts', { enumerable: true, get() { throw new Error('must not execute') } })
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('configuration')
})

it('rejects limits above the actual argv, stdin, tail, observation and runtime capacities', () => {
  const changes = { maxArgvBytes: 4097, maxArgvEntries: 17, maxPathBytes: 513, maxStdinBytes: 4097,
    maxTailBytes: 4097, maxObservedBytes: 65537, maxLifetimeMs: SLICE_LIMITS.residentMs + 1, stopWaitMs: 2001 }
  for (const [key, value] of Object.entries(changes)) {
    const raw = input()
    Object.assign(raw.commands.commandLimits, { [key]: value })
    expect(() => parseManagedCoordinatorConfig(raw)).toThrow(key)
  }
  const raw = input(); raw.shell.maxTimeoutMs = 12001
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxTimeoutMs')
  raw.shell.maxTimeoutMs = 5000; raw.commands.allowedTools = ['bash', 'other']
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('allowedTools')
  raw.commands.allowedTools = ['bash']; Object.assign(raw.commands, { lifetimeOperations: 5 })
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('commands')
})

it('keeps Shell output and first deadlines within their actual command limits and literal image paths', () => {
  const cold = input()
  cold.commands.commandLimits.maxLifetimeMs = 60000
  cold.shell.timeoutMs = 45000; cold.shell.maxTimeoutMs = 60000
  const parsed = parseManagedCoordinatorConfig(cold)
  expect(parsed.shell.timeoutMs).toBe(45000)
  expect(parsed.allocations.createBudgetMs).toBe(30000)
  expect(parsed.commands.commandLimits.maxLifetimeMs).toBe(60000)
  const raw = input(); raw.shell.maxOutputBytes = 4097
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxOutputBytes')
  raw.shell.maxOutputBytes = 4096; raw.commands.commandLimits.maxObservedBytes = 4095
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxObservedBytes')
  for (const path of ['bash', '/', '//bin/bash', '/bin/../bin/bash', '/bin/bash/', '/bin/bash\0', '/bin/\ud800']) {
    expect(() => parseManagedCoordinatorConfig({ ...input(), shell: { ...input().shell, bashPath: path } })).toThrow('bashPath')
  }
  const deadline = input(); deadline.shell.timeoutMs = 5000; deadline.shell.maxTimeoutMs = 4000
  expect(() => parseManagedCoordinatorConfig(deadline)).toThrow('timeoutMs')
  deadline.shell.timeoutMs = 3000; deadline.shell.maxTimeoutMs = 4000; deadline.commands.commandLimits.maxLifetimeMs = 3000
  expect(() => parseManagedCoordinatorConfig(deadline)).toThrow('maxTimeoutMs')
  const argv = input(); argv.commands.commandLimits.maxArgvEntries = 4
  expect(() => parseManagedCoordinatorConfig(argv)).toThrow('maxArgvEntries')
  argv.commands.commandLimits.maxArgvEntries = 16; argv.commands.commandLimits.maxArgvBytes = 1
  expect(() => parseManagedCoordinatorConfig(argv)).toThrow('maxArgvBytes')
})

it('leaves request allowance for four bounded operations instead of exhausting the fixed client through fast polling', () => {
  const raw = input(); raw.commands.commandLimits.pollIntervalMs = 1
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('pollIntervalMs')
  raw.commands.commandLimits.pollIntervalMs = 1000
  expect(parseManagedCoordinatorConfig(raw).commands.commandLimits.pollIntervalMs).toBe(1000)
})

it('enforces Root/account capacity relationships and a complete largest-command resident reservation', () => {
  const raw = input(); raw.maxActiveCommandsPerAccount = 5
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxActiveCommandsPerAccount')
  raw.maxActiveCommandsPerAccount = 2; raw.maxResidentCommands = 3; raw.maxResidentCommandsPerAccount = 3
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxActiveCommands')
  const exact = input(); exact.maxResidentBytesPerAccount = 144384
  expect(parseManagedCoordinatorConfig(exact).maxResidentBytesPerAccount).toBe(144384)
  exact.maxResidentBytesPerAccount--
  expect(() => parseManagedCoordinatorConfig(exact)).toThrow('maxResidentBytesPerAccount')
  const allocation = input(); allocation.allocations.maxAllocationsPerAccount = 5
  expect(() => parseManagedCoordinatorConfig(allocation)).toThrow('maxAllocationsPerAccount')
  allocation.allocations.maxAllocationsPerAccount = 2; allocation.allocations.maxWaitersPerAllocation = 9
  expect(() => parseManagedCoordinatorConfig(allocation)).toThrow('maxWaitersPerAllocation')
})

it('keeps metadata migration, rows, result pages and fixed recipe tokens within their explicit store budgets', () => {
  const raw = input(); raw.store.maxInputBytes = 1
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxInputBytes')
  raw.store.maxInputBytes = 65536; raw.store.maxRetainedBytes = 65535
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxRetainedBytes')
  raw.store.maxRetainedBytes = 1048576; raw.recoveryPageSize = 9
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('recoveryPageSize')
  raw.recoveryPageSize = 2; raw.store.maxResultBytes = 8195
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxResultBytes')
  raw.store.maxResultBytes = 32768; raw.allocations.provider = 'not a durable token'
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('provider')
  raw.allocations.provider = 'opensandbox'; raw.store.maxFieldBytes = 63
  expect(() => parseManagedCoordinatorConfig(raw)).toThrow('maxFieldBytes')
})
