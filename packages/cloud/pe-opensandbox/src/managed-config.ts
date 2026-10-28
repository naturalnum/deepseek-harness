/** Strict private JSON configuration for the current finite collected-command carrier. */
import { posix } from 'node:path'
import type { ManagedCoordinatorConfig } from './managed-coordinator.ts'
import type { AllocationOwnerConfig } from './allocation-owner.ts'
import type { AllocationStoreLimits } from './allocation-types.ts'
import type { ManagedNativeCommandConfig, ManagedServiceConfig } from './service-config.ts'
import type { CommandOperationLimits } from './command-operation.ts'
import type { NativeExecutionConfig } from './native-providers.ts'
import { SLICE_LIMITS, CARRIER_LIMITS } from './agent-data/constants.ts'
import { allocationMigrationSql } from './migrations/allocations.ts'
import { ExecutionStateError } from './errors.ts'

const INTEGER_MAX = 2147483647
const rootKeys = ['maxBoundAccounts', 'maxActiveCommands', 'maxActiveCommandsPerAccount', 'maxResidentCommands',
  'maxResidentCommandsPerAccount', 'maxResidentBytes', 'maxResidentBytesPerAccount', 'maxStopObservers',
  'stopWaitBudgetMs', 'recoveryPageSize', 'allocations', 'store', 'commands', 'shell'] as const
const allocationKeys = ['environmentVersion', 'provider', 'createBudgetMs', 'maxAllocations', 'maxAllocationsPerAccount',
  'maxWaiters', 'maxWaitersPerAllocation'] as const
const storeKeys = ['maxFieldBytes', 'maxInputBytes', 'maxRowBytes', 'maxResultBytes', 'maxRows', 'maxCapabilities',
  'maxPendingQueries', 'maxMutationResponsibilities', 'maxRetainedBytes'] as const
const commandKeys = ['maxArgvBytes', 'maxArgvEntries', 'maxPathBytes', 'maxStdinBytes', 'maxTailBytes',
  'maxObservedBytes', 'pollIntervalMs', 'maxWaiters', 'maxLifetimeMs', 'stopWaitMs'] as const
const shellKeys = ['bashPath', 'timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'graceMs'] as const
const serviceProfileKeys = ['kind', 'port', 'startWaitMs', 'runMs', 'stopWaitMs', 'maxLogReadBytes', 'maxReplyBytes',
  'maxScriptBytes', 'maxArgs', 'maxArgBytes', 'maxArgsBytes'] as const
const applicationTransportKeys = ['readBufferBytes', 'prefetchBytes', 'maxWireBytes', 'maxRequestHeaderBytes',
  'maxPathBytes', 'timeoutMs', 'maxBufferPoolBytes'] as const

function refuse(path: string): never {
  throw new ExecutionStateError('cloud/invalid-config', `Managed execution configuration is invalid at ${path}.`)
}

function requireLimit(condition: boolean, path: string): asserts condition { if (!condition) refuse(path) }

function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(path)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) refuse(path)
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) refuse(path)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) refuse(path)
  }
  return value as Record<string, unknown>
}

function integer(row: Record<string, unknown>, key: string, path: string, max = INTEGER_MAX, min = 1): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) refuse(`${path}.${key}`)
  return value
}

function token(row: Record<string, unknown>, key: string, maximum: number): string {
  const value = row[key]
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    refuse(`allocations.${key}`)
  }
  return value
}

function storeLimits(value: unknown): AllocationStoreLimits {
  const row = object(value, storeKeys, 'store')
  const limits: AllocationStoreLimits = Object.freeze({
    maxFieldBytes: integer(row, 'maxFieldBytes', 'store', 4096, 64),
    maxInputBytes: integer(row, 'maxInputBytes', 'store'), maxRowBytes: integer(row, 'maxRowBytes', 'store'),
    maxResultBytes: integer(row, 'maxResultBytes', 'store', INTEGER_MAX, 2), maxRows: integer(row, 'maxRows', 'store', INTEGER_MAX, 2),
    maxCapabilities: integer(row, 'maxCapabilities', 'store', 5), maxPendingQueries: integer(row, 'maxPendingQueries', 'store'),
    maxMutationResponsibilities: integer(row, 'maxMutationResponsibilities', 'store'),
    maxRetainedBytes: integer(row, 'maxRetainedBytes', 'store'),
  })
  const migrationBytes = Buffer.byteLength(allocationMigrationSql) + 2 * Buffer.byteLength('[]') + Buffer.byteLength('migration')
  requireLimit(limits.maxInputBytes >= migrationBytes, 'store.maxInputBytes')
  requireLimit(limits.maxRetainedBytes >= limits.maxInputBytes, 'store.maxRetainedBytes')
  requireLimit(limits.maxResultBytes >= limits.maxRowBytes + 3, 'store.maxResultBytes')
  return limits
}

function allocationLimits(value: unknown, store: AllocationStoreLimits): AllocationOwnerConfig {
  const row = object(value, allocationKeys, 'allocations')
  const limits: AllocationOwnerConfig = Object.freeze({ environmentVersion: token(row, 'environmentVersion', store.maxFieldBytes),
    provider: token(row, 'provider', store.maxFieldBytes), createBudgetMs: integer(row, 'createBudgetMs', 'allocations'),
    maxAllocations: integer(row, 'maxAllocations', 'allocations'),
    maxAllocationsPerAccount: integer(row, 'maxAllocationsPerAccount', 'allocations'),
    maxWaiters: integer(row, 'maxWaiters', 'allocations'), maxWaitersPerAllocation: integer(row, 'maxWaitersPerAllocation', 'allocations') })
  requireLimit(limits.maxAllocationsPerAccount <= limits.maxAllocations, 'allocations.maxAllocationsPerAccount')
  requireLimit(limits.maxWaitersPerAllocation <= limits.maxWaiters, 'allocations.maxWaitersPerAllocation')
  return limits
}

function applicationLimits(value: unknown, limits: CommandOperationLimits, serviceRunMs: number): NonNullable<ManagedServiceConfig['application']> {
  const path = 'commands.services.application'
  const row = object(value, ['maxRequests', 'maxRequestsPerAccount', 'maxRequestsPerService', 'transport'], path)
  const maxRequests = integer(row, 'maxRequests', path)
  const maxRequestsPerAccount = integer(row, 'maxRequestsPerAccount', path, maxRequests)
  const maxRequestsPerService = integer(row, 'maxRequestsPerService', path, maxRequestsPerAccount)
  const raw = object(row['transport'], applicationTransportKeys, `${path}.transport`)
  const transport = Object.freeze({
    readBufferBytes: integer(raw, 'readBufferBytes', `${path}.transport`),
    prefetchBytes: integer(raw, 'prefetchBytes', `${path}.transport`),
    maxWireBytes: integer(raw, 'maxWireBytes', `${path}.transport`),
    maxRequestHeaderBytes: integer(raw, 'maxRequestHeaderBytes', `${path}.transport`),
    maxPathBytes: integer(raw, 'maxPathBytes', `${path}.transport`),
    timeoutMs: integer(raw, 'timeoutMs', `${path}.transport`, Math.min(limits.maxLifetimeMs, serviceRunMs)),
    maxBufferPoolBytes: integer(raw, 'maxBufferPoolBytes', `${path}.transport`) })
  requireLimit(transport.readBufferBytes <= transport.prefetchBytes, `${path}.transport.prefetchBytes`)
  requireLimit(transport.readBufferBytes <= transport.maxWireBytes, `${path}.transport.maxWireBytes`)
  return Object.freeze({ maxRequests, maxRequestsPerAccount, maxRequestsPerService, transport })
}

function serviceLimits(value: unknown, limits: CommandOperationLimits): ManagedServiceConfig {
  const hasApplication = value !== null && typeof value === 'object' && Object.hasOwn(value, 'application')
  const path = 'commands.services'
  const row = object(value, ['profile', 'maxOutputBytes', 'graceMs', ...(hasApplication ? ['application'] : [])], path)
  const raw = object(row['profile'], serviceProfileKeys, `${path}.profile`)
  const kind = raw['kind'], port = raw['port']
  requireLimit(kind === 'python-http-v1', `${path}.profile.kind`)
  requireLimit(port === 8000, `${path}.profile.port`)
  const maxOutputBytes = integer(row, 'maxOutputBytes', path, limits.maxTailBytes)
  const graceMs = integer(row, 'graceMs', path, limits.maxLifetimeMs)
  const profile = Object.freeze({ kind, port,
    startWaitMs: integer(raw, 'startWaitMs', `${path}.profile`, limits.maxLifetimeMs),
    runMs: integer(raw, 'runMs', `${path}.profile`),
    stopWaitMs: integer(raw, 'stopWaitMs', `${path}.profile`, limits.maxLifetimeMs),
    maxLogReadBytes: integer(raw, 'maxLogReadBytes', `${path}.profile`),
    maxReplyBytes: integer(raw, 'maxReplyBytes', `${path}.profile`),
    maxScriptBytes: integer(raw, 'maxScriptBytes', `${path}.profile`, limits.maxArgvBytes),
    maxArgs: integer(raw, 'maxArgs', `${path}.profile`, limits.maxArgvEntries),
    maxArgBytes: integer(raw, 'maxArgBytes', `${path}.profile`, limits.maxArgvBytes),
    maxArgsBytes: integer(raw, 'maxArgsBytes', `${path}.profile`, limits.maxArgvBytes) })
  requireLimit(profile.runMs === SLICE_LIMITS.serviceRunMs, `${path}.profile.runMs`)
  requireLimit(limits.maxLifetimeMs >= SLICE_LIMITS.prepareMs + SLICE_LIMITS.serviceRunMs + SLICE_LIMITS.stopMs,
    'commands.commandLimits.maxLifetimeMs')
  // UTF-8 replacement can expand each retained raw byte to three bytes. JSON control escapes can use six.
  requireLimit(profile.maxLogReadBytes >= 3 * maxOutputBytes, `${path}.profile.maxLogReadBytes`)
  requireLimit(profile.maxLogReadBytes <= profile.maxReplyBytes, `${path}.profile.maxReplyBytes`)
  const handle = 'x'.repeat(64)
  const status = { serviceId: handle, processSubmitted: false, httpReady: false, direct: 'pending', range: 'pending',
    exitCode: null, signal: 'SIGVTALRM', uncertain: true }
  // SIGVTALRM is a longest signal in the original trusted Linux mapping; null is longer than its0..255 exit codes.
  const replyBytes = (action: string, observation: object): number =>
    Buffer.byteLength(JSON.stringify({ action, serviceHandle: handle, observation }))
  const minimumReply = Math.max(replyBytes('start', { phase: 'process-submitted', ...status }),
    replyBytes('status', status), replyBytes('stop', { confirmed: false, processSubmitted: false }),
    replyBytes('log', { text: '', nextOffset: limits.maxObservedBytes, lossy: false }) + 6 * maxOutputBytes)
  requireLimit(profile.maxReplyBytes >= minimumReply, `${path}.profile.maxReplyBytes`)
  // Presence records a bounded policy only. Root's reviewed registration/factory/HTTP gates still decide availability.
  const application = hasApplication ? applicationLimits(row['application'], limits, profile.runMs) : undefined
  return Object.freeze({ profile, maxOutputBytes, graceMs, ...(application === undefined ? {} : { application }) })
}

function commandLimits(value: unknown): ManagedNativeCommandConfig {
  // Select the exact key list without reading a possible services accessor or inherited property.
  const hasServices = value !== null && typeof value === 'object' && Object.hasOwn(value, 'services')
  const row = object(value, ['allowedTools', 'maxScopes', 'commandLimits', ...(hasServices ? ['services'] : [])], 'commands')
  const tools = row['allowedTools']
  const expectedTools = hasServices ? ['bash', 'dev_service'] : ['bash']
  if (!Array.isArray(tools) || Object.getPrototypeOf(tools) !== Array.prototype
    || tools.length !== expectedTools.length || Reflect.ownKeys(tools).length !== expectedTools.length + 1) refuse('commands.allowedTools')
  for (const [index, tool] of expectedTools.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(tools, String(index))
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || descriptor.value !== tool) refuse('commands.allowedTools')
  }
  const raw = object(row['commandLimits'], commandKeys, 'commands.commandLimits'), path = 'commands.commandLimits'
  const limits: CommandOperationLimits = Object.freeze({
    maxArgvBytes: integer(raw, 'maxArgvBytes', path, 4096), maxArgvEntries: integer(raw, 'maxArgvEntries', path, 16, 5),
    maxPathBytes: integer(raw, 'maxPathBytes', path, 512), maxStdinBytes: integer(raw, 'maxStdinBytes', path, 4096),
    maxTailBytes: integer(raw, 'maxTailBytes', path, SLICE_LIMITS.tailBytesPerStream),
    maxObservedBytes: integer(raw, 'maxObservedBytes', path, SLICE_LIMITS.observedStopThresholdPerStream),
    pollIntervalMs: integer(raw, 'pollIntervalMs', path, SLICE_LIMITS.preparedLeaseMs),
    maxWaiters: integer(raw, 'maxWaiters', path), maxLifetimeMs: integer(raw, 'maxLifetimeMs', path, SLICE_LIMITS.residentMs),
    stopWaitMs: integer(raw, 'stopWaitMs', path, SLICE_LIMITS.stopMs),
  })
  requireLimit(limits.maxTailBytes <= limits.maxObservedBytes, `${path}.maxObservedBytes`)
  requireLimit(limits.pollIntervalMs <= limits.maxLifetimeMs, `${path}.pollIntervalMs`)
  // Include pending preparation, user run and stop observation; leave one handshake and one seal attempt for the runtime.
  const pollWindow = Math.min(limits.maxLifetimeMs, SLICE_LIMITS.prepareMs + SLICE_LIMITS.runMs) + limits.stopWaitMs
  const attempts = 2 + SLICE_LIMITS.lifetimeOperations * (3 + Math.ceil(pollWindow / limits.pollIntervalMs))
  requireLimit(attempts <= CARRIER_LIMITS.attempts, `${path}.pollIntervalMs`)
  // This is the sole services resolve point. Absence produces no service policy or dev_service consumer.
  const services = hasServices ? serviceLimits(row['services'], limits) : undefined
  return Object.freeze({ allowedTools: Object.freeze(expectedTools), maxScopes: integer(row, 'maxScopes', 'commands'),
    commandLimits: limits, ...(services === undefined ? {} : { services }) })
}

function shellLimits(value: unknown, commands: CommandOperationLimits): NativeExecutionConfig {
  const hasPolicy = value !== null && typeof value === 'object' && Object.hasOwn(value, 'enforceSessionFilePolicy')
  const row = object(value, [...shellKeys, ...(hasPolicy ? ['enforceSessionFilePolicy'] : [])], 'shell'), path = row['bashPath']
  if (hasPolicy && typeof row['enforceSessionFilePolicy'] !== 'boolean') refuse('shell.enforceSessionFilePolicy')
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || path.startsWith('//') || path.endsWith('/')
    || posix.normalize(path) !== path || /[\u0000-\u001f\u007f]/u.test(path)
    || Buffer.from(path).toString('utf8') !== path || Buffer.byteLength(path) > 512) refuse('shell.bashPath')
  const limits: NativeExecutionConfig = Object.freeze({ bashPath: path,
    ...(hasPolicy ? { enforceSessionFilePolicy: row['enforceSessionFilePolicy'] as boolean } : {}),
    timeoutMs: integer(row, 'timeoutMs', 'shell', commands.maxLifetimeMs),
    maxTimeoutMs: integer(row, 'maxTimeoutMs', 'shell', commands.maxLifetimeMs),
    maxOutputBytes: integer(row, 'maxOutputBytes', 'shell', commands.maxTailBytes),
    graceMs: integer(row, 'graceMs', 'shell', SLICE_LIMITS.runMs) })
  requireLimit(limits.timeoutMs <= limits.maxTimeoutMs, 'shell.timeoutMs')
  requireLimit(limits.maxTimeoutMs <= commands.maxLifetimeMs, 'shell.maxTimeoutMs')
  requireLimit(limits.graceMs <= commands.maxLifetimeMs, 'shell.graceMs')
  const minimumArgv = [path, '--noprofile', '--norc', '-c', ''].reduce((bytes, argument) => bytes + Buffer.byteLength(argument) + 1, 0)
  requireLimit(minimumArgv <= commands.maxArgvBytes, 'commands.commandLimits.maxArgvBytes')
  return limits
}

/**
 * Parse one complete JSON object without defaults, I/O, SDK credentials or deployment authority.
 * @param value Complete decoded managed JSON; Root separately validates its outer session-collect mode.
 * @returns Independent frozen coordinator settings, with no mode or deployment capability added.
 * The runtime has four lifetime operations and one active range per signed role; this object provides no execution authority.
 * Shell's deadline includes allocation/preparation waiting and fits the local command lifetime.
 * The independent remote user-run limit belongs to the pinned profile; a larger Shell deadline cannot enlarge it.
 * Polling reserves the frozen carrier's request allowance. Counts and byte budgets remain independent admission caps;
 * one largest native command must fit, and actual commands still undergo the complete encoded-frame check.
 * The 64KiB observation threshold is a stop trigger, not an exact emitted-output cap or a full S4 qualification.
 */
export function parseManagedCoordinatorConfig(value: unknown): ManagedCoordinatorConfig {
  const row = object(value, rootKeys, 'configuration')
  const store = storeLimits(row['store']), allocations = allocationLimits(row['allocations'], store)
  const commands = commandLimits(row['commands']), shell = shellLimits(row['shell'], commands.commandLimits)
  const config: ManagedCoordinatorConfig = Object.freeze({
    maxBoundAccounts: integer(row, 'maxBoundAccounts', 'configuration'),
    maxActiveCommands: integer(row, 'maxActiveCommands', 'configuration'),
    maxActiveCommandsPerAccount: integer(row, 'maxActiveCommandsPerAccount', 'configuration'),
    maxResidentCommands: integer(row, 'maxResidentCommands', 'configuration'),
    maxResidentCommandsPerAccount: integer(row, 'maxResidentCommandsPerAccount', 'configuration'),
    maxResidentBytes: integer(row, 'maxResidentBytes', 'configuration'),
    maxResidentBytesPerAccount: integer(row, 'maxResidentBytesPerAccount', 'configuration'),
    maxStopObservers: integer(row, 'maxStopObservers', 'configuration'), stopWaitBudgetMs: integer(row, 'stopWaitBudgetMs', 'configuration'),
    recoveryPageSize: integer(row, 'recoveryPageSize', 'configuration'), allocations, store, commands, shell })
  requireLimit(config.maxActiveCommandsPerAccount <= config.maxActiveCommands, 'configuration.maxActiveCommandsPerAccount')
  requireLimit(config.maxResidentCommandsPerAccount <= config.maxResidentCommands, 'configuration.maxResidentCommandsPerAccount')
  requireLimit(config.maxResidentBytesPerAccount <= config.maxResidentBytes, 'configuration.maxResidentBytesPerAccount')
  requireLimit(config.maxActiveCommands <= config.maxResidentCommands, 'configuration.maxActiveCommands')
  requireLimit(config.maxActiveCommandsPerAccount <= config.maxResidentCommandsPerAccount, 'configuration.maxActiveCommandsPerAccount')
  requireLimit(config.recoveryPageSize <= store.maxRows, 'configuration.recoveryPageSize')
  requireLimit(config.recoveryPageSize * (store.maxRowBytes + 1) + 2 <= store.maxResultBytes, 'store.maxResultBytes')
  const command = commands.commandLimits
  const largestReservation = 8 * (2 * command.maxTailBytes + command.maxStdinBytes + command.maxPathBytes + command.maxArgvBytes)
    + 8192 + command.maxWaiters * 256
  requireLimit(Number.isSafeInteger(largestReservation) && largestReservation <= config.maxResidentBytesPerAccount,
    'configuration.maxResidentBytesPerAccount')
  return config
}
