/** A selected operational verifier's protected publication; ordinary deployment input never supplies recovery facts. */
import { createHash } from 'node:crypto'
import { constants, openSync, readSync, closeSync, readlinkSync } from 'node:fs'
import type { AllocationCreateIntent, SandboxAllocation } from '../allocation-types.ts'
import { ExecutionStateError } from '../errors.ts'

/** Original readonly publication retained by the Root Loader effect until recovery actually settles. */
export interface RecoveryPublication {
  /** @returns Decoded original protected bytes, without granting recovery authority. */
  value(): unknown
  /** Recheck the retained protected publication and deny revoked or changed files. */
  assertCurrent(): void
}

/** Deployment-selected finite limits; omission of a publication keeps recovery closed. */
export interface RecoveryWitnessLimits {
  readonly maxBytes: number
  readonly maxAccounts: number
  readonly maxAllocations: number
  readonly maxFieldBytes: number
  readonly maxAgeMs: number
}

/** Exact old local process domain; legacy receipts require independent absence in this same domain. */
export interface RecoveryProcessIdentity {
  readonly pid: number
  readonly startTicks: string
  readonly bootId: string
  readonly pidNamespace: string
}

/** The kernel observation is independent of the selected operator publication. */
export interface RecoveryProcessObservation {
  readonly bootId: string
  readonly pidNamespace: string
  readonly original: 'absent' | 'alive'
}

/** Published evidence for one accepted creation which has permanently stopped. */
export interface RecoveryCreatedAllocationWitness {
  readonly createOutcome: 'accepted-created-and-settled'
  readonly intent: AllocationCreateIntent
  readonly sandboxId: string
  readonly acceptedCreateEvidenceRef: string
  readonly physicalStopEvidenceRef: string
  readonly lateStartsRevokedEvidenceRef: string
}

/** Fixed terminal metadata code; a provider outcome still requires complete protected refusal evidence. */
export const PROVIDER_CREATE_REFUSAL_CODE = 'provider-create-refused-before-create'
/** Original qualified TTL refusal, retained unchanged for existing verifier callers. */
export const KNOWN_PROVIDER_REFUSAL = 'fixed-ttl-bounds'

/** Closed backend admission refusals eligible for independently verified pre-provider non-creation. */
export type KnownProviderRefusal = typeof KNOWN_PROVIDER_REFUSAL | 'host-bind-bounds'

/**
 * Recognize only the selected completed pre-provider admission rules; a code alone is not evidence.
 * @param value Decoded protected-publication or trusted-verifier refusal code.
 * @returns Whether the value is one of the two exact qualified refusal discriminators.
 */
export function isKnownProviderRefusal(value: unknown): value is KnownProviderRefusal {
  return value === KNOWN_PROVIDER_REFUSAL || value === 'host-bind-bounds'
}

/** Completed provider admission refusal; this branch contains no physical sandbox or destruction claim. */
export interface RecoveryRefusedAllocationWitness {
  readonly createOutcome: 'rejected-before-provider-create'
  readonly sandboxId: null
  readonly intent: AllocationCreateIntent
  readonly intentDigest: string
  readonly refusalCode: KnownProviderRefusal
  readonly knownRefusalEvidenceRef: string
  readonly completedRequestEvidenceRef: string
  readonly providerCreateNotStartedEvidenceRef: string
  readonly lateStartsRevokedEvidenceRef: string
}
/** Explicit destruction or non-creation evidence for one original allocation intent. */
export type RecoveryAllocationWitness = RecoveryCreatedAllocationWitness | RecoveryRefusedAllocationWitness

/**
 * Check metadata eligible for a trusted no-create finding; this check alone grants no authority.
 * @param row Original durable allocation row.
 * @returns Whether preparation is absent and the row is creating or the exact already-failed postimage.
 */
export function isProviderCreateRefusalRow(row: SandboxAllocation): boolean {
  return row.sandboxId === null && row.runtimeIdentity === null && row.executionProtocolVersion === null
    && row.executionCapabilities.length === 0
    && (row.state === 'creating' && row.failureCode === null
      || row.state === 'failed' && row.failureCode === PROVIDER_CREATE_REFUSAL_CODE)
}

/**
 * Preserve destruction or non-creation facts in the original runtime audit.
 * @param item Already verified protected allocation evidence.
 * @returns References for the selected outcome without fabricating physical destruction.
 */
export function recoveryWitnessEvidenceRefs(item: RecoveryAllocationWitness): readonly string[] {
  return item.createOutcome === 'accepted-created-and-settled'
    ? [item.acceptedCreateEvidenceRef, item.physicalStopEvidenceRef, item.lateStartsRevokedEvidenceRef]
    : [item.knownRefusalEvidenceRef, item.completedRequestEvidenceRef,
      item.providerCreateNotStartedEvidenceRef, item.lateStartsRevokedEvidenceRef]
}

/** All declared old allocations for one account, including rows already reconciled to terminal metadata. */
export interface RecoveryAccountWitness {
  readonly accountId: AllocationCreateIntent['accountId']
  readonly epoch: AllocationCreateIntent['epoch']
  readonly allocations: readonly RecoveryAllocationWitness[]
}

/** Current Linux domain, independently observed without interpreting an old PID after kernel replacement. */
export interface RecoveryKernelIdentity {
  readonly bootId: string
  readonly pidNamespace: string
}

/** Root-verified continuity of this exact deployment, original container, data volume and control backing. */
export interface RecoveryDeploymentIdentity {
  readonly deploymentId: string
  readonly containerId: string
  readonly volumeName: string
  readonly controlIdentity: string
  readonly imageDigest: string
}

/** Complete domain-bound zero-work observation; Root verifies the referenced full writer/SQL coverage. */
export interface RecoveryZeroWorkSnapshot {
  readonly kernel: RecoveryKernelIdentity
  readonly observedAt: string
  readonly uid: 2000
  readonly uidProcessCount: 0
  readonly databaseConnectionCount: 0
  readonly allocationCount: 0
  readonly evidenceRef: string
}

/** Only a pre-stopped, zero-work original local deployment qualifies for the kernel-termination branch. */
export interface RecoveryKernelTermination {
  readonly kind: 'local-prestopped-zero-work-v1'
  readonly previousDeployment: RecoveryDeploymentIdentity
  readonly currentDeployment: RecoveryDeploymentIdentity
  readonly lineageEvidenceRef: string
  readonly newKernel: RecoveryKernelIdentity
  readonly kernelTerminatedAt: string
  readonly kernelTerminationEvidenceRef: string
  readonly processTerminationEvidenceRef: string
  readonly executionDomainEvidenceRef: string
  readonly ledgerBeforeProviderEvidenceRef: string
  readonly applicationExit: Readonly<{ exitCode: 0; observedAt: string; evidenceRef: string }>
  readonly quiescence: Readonly<{ beforeTermination: RecoveryZeroWorkSnapshot; current: RecoveryZeroWorkSnapshot }>
}

interface RecoveryWitnessFacts {
  readonly verifierId: 'local-original-process-and-provider-v1'
  readonly auditRef: string
  readonly verifiedAt: string
  readonly oldInstanceId: string
  readonly databaseRole: string
  readonly writersVerifiedAt: string
  readonly oldProcess: RecoveryProcessIdentity
  readonly processEvidenceRef: string
  readonly writersEvidenceRef: string
  readonly accounts: readonly RecoveryAccountWitness[]
}

/** Closed protected receipt; v3 requires complete explicit local termination facts, never a restart flag. */
export type RecoveryWitness = RecoveryWitnessFacts & (
  | Readonly<{ schema: 'pe-local-controlled-recovery-v1' | 'pe-local-controlled-recovery-v2' }>
  | Readonly<{ schema: 'pe-local-controlled-recovery-v3'; kernelTermination: RecoveryKernelTermination }>
)

const intentFields = ['allocationId', 'accountId', 'sessionId', 'workspaceId', 'epoch', 'environmentVersion',
  'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt'] as const

function refused(): never {
  throw new ExecutionStateError('cloud/execution-unavailable', 'Trusted recovery evidence is unavailable, incomplete or stale.')
}
function need(value: boolean): asserts value { if (!value) refused() }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value))
  need(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)))
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): string {
  need(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value))
  return value
}
function timestamp(value: unknown): string {
  const result = text(value, 24)
  need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result)
    && Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result)
  return result
}
function epoch(value: unknown): AllocationCreateIntent['epoch'] {
  const result = text(value, 19)
  need(/^[1-9]\d{0,18}$/.test(result) && BigInt(result) <= 9223372036854775807n)
  return result as AllocationCreateIntent['epoch']
}
function intent(value: unknown, maximum: number): AllocationCreateIntent {
  const row = object(value, intentFields)
  const result: AllocationCreateIntent = Object.freeze({
    allocationId: text(row.allocationId, maximum) as AllocationCreateIntent['allocationId'],
    accountId: text(row.accountId, maximum) as AllocationCreateIntent['accountId'],
    sessionId: text(row.sessionId, maximum) as AllocationCreateIntent['sessionId'],
    workspaceId: text(row.workspaceId, maximum) as AllocationCreateIntent['workspaceId'],
    epoch: epoch(row.epoch), environmentVersion: text(row.environmentVersion, maximum),
    provider: text(row.provider, maximum), projectMountVersion: text(row.projectMountVersion, maximum),
    requestedAt: timestamp(row.requestedAt), createDeadlineAt: timestamp(row.createDeadlineAt),
  })
  need(result.requestedAt <= result.createDeadlineAt)
  return result
}

function kernelIdentity(value: unknown): RecoveryKernelIdentity {
  const row = object(value, ['bootId', 'pidNamespace'])
  const bootId = text(row.bootId, 36), pidNamespace = text(row.pidNamespace, 32)
  need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId) && /^pid:\[[1-9]\d{0,19}\]$/.test(pidNamespace))
  return Object.freeze({ bootId, pidNamespace })
}
function evidenceRef(value: unknown, maximum: number): string {
  const result = text(value, maximum)
  need(/^sha256:[a-f0-9]{64}$/.test(result))
  return result
}
const deploymentFields = ['deploymentId', 'containerId', 'volumeName', 'controlIdentity', 'imageDigest'] as const
function deploymentIdentity(value: unknown, maximum: number): RecoveryDeploymentIdentity {
  const row = object(value, deploymentFields)
  const deploymentId = text(row.deploymentId, maximum), containerId = text(row.containerId, maximum)
  const volumeName = text(row.volumeName, maximum), controlIdentity = text(row.controlIdentity, maximum)
  const imageDigest = evidenceRef(row.imageDigest, maximum)
  need(/^[a-f0-9]{64}$/.test(containerId) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volumeName))
  return Object.freeze({ deploymentId, containerId, volumeName, controlIdentity, imageDigest })
}
function zeroWorkSnapshot(value: unknown, maximum: number, expected: RecoveryKernelIdentity): RecoveryZeroWorkSnapshot {
  const row = object(value, ['kernel', 'observedAt', 'uid', 'uidProcessCount', 'databaseConnectionCount', 'allocationCount', 'evidenceRef'])
  const kernel = kernelIdentity(row.kernel)
  need(kernel.bootId === expected.bootId && kernel.pidNamespace === expected.pidNamespace)
  need(row.uid === 2000 && row.uidProcessCount === 0 && row.databaseConnectionCount === 0 && row.allocationCount === 0)
  return Object.freeze({ kernel, observedAt: timestamp(row.observedAt), uid: 2000, uidProcessCount: 0,
    databaseConnectionCount: 0, allocationCount: 0, evidenceRef: evidenceRef(row.evidenceRef, maximum) })
}
function terminatedKernel(value: unknown, maximum: number, original: RecoveryProcessIdentity,
  verifiedAt: string, writersVerifiedAt: string): RecoveryKernelTermination {
  const row = object(value, ['kind', 'previousDeployment', 'currentDeployment', 'lineageEvidenceRef', 'newKernel',
    'kernelTerminatedAt', 'kernelTerminationEvidenceRef', 'processTerminationEvidenceRef', 'executionDomainEvidenceRef',
    'ledgerBeforeProviderEvidenceRef', 'applicationExit', 'quiescence'])
  need(row.kind === 'local-prestopped-zero-work-v1')
  const previousDeployment = deploymentIdentity(row.previousDeployment, maximum)
  const currentDeployment = deploymentIdentity(row.currentDeployment, maximum)
  need(deploymentFields.every(field => previousDeployment[field] === currentDeployment[field]))
  const newKernel = kernelIdentity(row.newKernel), kernelTerminatedAt = timestamp(row.kernelTerminatedAt)
  need(newKernel.bootId !== original.bootId && newKernel.pidNamespace !== original.pidNamespace)
  const exit = object(row.applicationExit, ['exitCode', 'observedAt', 'evidenceRef'])
  need(exit.exitCode === 0)
  const applicationExit = Object.freeze({ exitCode: 0 as const, observedAt: timestamp(exit.observedAt),
    evidenceRef: evidenceRef(exit.evidenceRef, maximum) })
  const quiet = object(row.quiescence, ['beforeTermination', 'current'])
  const beforeTermination = zeroWorkSnapshot(quiet.beforeTermination, maximum, original)
  const current = zeroWorkSnapshot(quiet.current, maximum, newKernel)
  need(applicationExit.observedAt <= beforeTermination.observedAt && beforeTermination.observedAt < kernelTerminatedAt
    && kernelTerminatedAt <= current.observedAt && current.observedAt <= verifiedAt && writersVerifiedAt === current.observedAt
    && beforeTermination.evidenceRef !== current.evidenceRef)
  return Object.freeze({ kind: 'local-prestopped-zero-work-v1', previousDeployment, currentDeployment,
    lineageEvidenceRef: evidenceRef(row.lineageEvidenceRef, maximum), newKernel, kernelTerminatedAt,
    kernelTerminationEvidenceRef: evidenceRef(row.kernelTerminationEvidenceRef, maximum),
    processTerminationEvidenceRef: evidenceRef(row.processTerminationEvidenceRef, maximum),
    executionDomainEvidenceRef: evidenceRef(row.executionDomainEvidenceRef, maximum),
    ledgerBeforeProviderEvidenceRef: evidenceRef(row.ledgerBeforeProviderEvidenceRef, maximum), applicationExit,
    quiescence: Object.freeze({ beforeTermination, current }) })
}

/**
 * Hash immutable creation identity independently of terminal metadata.
 * @param value Original durable creation fields.
 * @returns Canonical SHA256 used to bind the complete original creation intent.
 */
export function recoveryIntentDigest(value: AllocationCreateIntent): string {
  return createHash('sha256').update(JSON.stringify(intentFields.map(field => value[field]))).digest('hex')
}

/**
 * Parse a bounded protected receipt before any recovery store operation.
 * @param value Decoded original publication bytes.
 * @param limits Explicit deployment capacities.
 * @returns Frozen local verifier facts, still requiring current publication and independent kernel checks.
 */
export function parseRecoveryWitness(value: unknown, limits: RecoveryWitnessLimits): RecoveryWitness {
  for (const limit of Object.values(limits)) need(Number.isSafeInteger(limit) && limit > 0 && limit <= 2147483647)
  const kernelTerminated = value !== null && typeof value === 'object' && 'schema' in value
    && value.schema === 'pe-local-controlled-recovery-v3'
  const row = object(value, ['schema', 'verifierId', 'auditRef', 'verifiedAt', 'oldInstanceId', 'databaseRole',
    'writersVerifiedAt', 'oldProcess', 'processEvidenceRef', 'writersEvidenceRef', 'accounts',
    ...(kernelTerminated ? ['kernelTermination'] : [])])
  need(limits.maxBytes <= 131072 && limits.maxFieldBytes <= 4096
    && Buffer.byteLength(JSON.stringify(row)) <= limits.maxBytes)
  need((row.schema === 'pe-local-controlled-recovery-v1' || row.schema === 'pe-local-controlled-recovery-v2'
    || row.schema === 'pe-local-controlled-recovery-v3')
    && row.verifierId === 'local-original-process-and-provider-v1')
  const process = object(row.oldProcess, ['pid', 'startTicks', 'bootId', 'pidNamespace'])
  need(typeof process.pid === 'number' && Number.isSafeInteger(process.pid) && process.pid > 1 && process.pid <= 2147483647)
  const startTicks = text(process.startTicks, 20), bootId = text(process.bootId, 36), pidNamespace = text(process.pidNamespace, 32)
  need(/^[1-9]\d{0,19}$/.test(startTicks) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)
    && /^pid:\[[1-9]\d{0,19}\]$/.test(pidNamespace))
  need(Array.isArray(row.accounts) && row.accounts.length > 0 && row.accounts.length <= limits.maxAccounts
    && (!kernelTerminated || row.accounts.length === 1))
  const accountIds = new Set<string>(), allocationIds = new Set<string>()
  const accounts = row.accounts.map((item: unknown): RecoveryAccountWitness => {
    const account = object(item, ['accountId', 'epoch', 'allocations']), accountId = text(account.accountId, limits.maxFieldBytes)
    need(!accountIds.has(accountId)); accountIds.add(accountId)
    const oldEpoch = epoch(account.epoch)
    need(Array.isArray(account.allocations) && account.allocations.length <= limits.maxAllocations
      && (!kernelTerminated || account.allocations.length === 0))
    const allocations = account.allocations.map((raw: unknown): RecoveryAllocationWitness => {
      const candidate = raw as Record<string, unknown> | null
      const refusedCreate = row.schema === 'pe-local-controlled-recovery-v2'
        && candidate?.createOutcome === 'rejected-before-provider-create'
      const fields = refusedCreate
        ? ['createOutcome', 'sandboxId', 'intent', 'intentDigest', 'refusalCode', 'knownRefusalEvidenceRef', 'completedRequestEvidenceRef',
          'providerCreateNotStartedEvidenceRef', 'lateStartsRevokedEvidenceRef']
        : ['intent', 'sandboxId', 'acceptedCreateEvidenceRef', 'physicalStopEvidenceRef', 'lateStartsRevokedEvidenceRef',
          ...(row.schema === 'pe-local-controlled-recovery-v2' ? ['createOutcome'] : [])]
      const allocation = object(raw, fields)
      const original = intent(allocation.intent, limits.maxFieldBytes)
      need(original.accountId === accountId && original.epoch === oldEpoch && !allocationIds.has(original.allocationId))
      allocationIds.add(original.allocationId)
      need(allocationIds.size <= limits.maxAllocations)
      if (refusedCreate) {
        need(allocation.sandboxId === null && allocation.intentDigest === recoveryIntentDigest(original)
          && isKnownProviderRefusal(allocation.refusalCode))
        return Object.freeze({ createOutcome: 'rejected-before-provider-create', sandboxId: null, intent: original,
          intentDigest: recoveryIntentDigest(original), refusalCode: allocation.refusalCode,
          knownRefusalEvidenceRef: text(allocation.knownRefusalEvidenceRef, limits.maxFieldBytes),
          completedRequestEvidenceRef: text(allocation.completedRequestEvidenceRef, limits.maxFieldBytes),
          providerCreateNotStartedEvidenceRef: text(allocation.providerCreateNotStartedEvidenceRef, limits.maxFieldBytes),
          lateStartsRevokedEvidenceRef: text(allocation.lateStartsRevokedEvidenceRef, limits.maxFieldBytes) })
      }
      need(row.schema === 'pe-local-controlled-recovery-v1' || allocation.createOutcome === 'accepted-created-and-settled')
      return Object.freeze({ createOutcome: 'accepted-created-and-settled', intent: original,
        sandboxId: text(allocation.sandboxId, limits.maxFieldBytes),
        acceptedCreateEvidenceRef: text(allocation.acceptedCreateEvidenceRef, limits.maxFieldBytes),
        physicalStopEvidenceRef: text(allocation.physicalStopEvidenceRef, limits.maxFieldBytes),
        lateStartsRevokedEvidenceRef: text(allocation.lateStartsRevokedEvidenceRef, limits.maxFieldBytes) })
    })
    return Object.freeze({ accountId: accountId as RecoveryAccountWitness['accountId'], epoch: oldEpoch, allocations: Object.freeze(allocations) })
  })
  const verifiedAt = timestamp(row.verifiedAt), writersVerifiedAt = timestamp(row.writersVerifiedAt)
  need(writersVerifiedAt <= verifiedAt)
  const facts = Object.freeze({ verifierId: row.verifierId, auditRef: text(row.auditRef, limits.maxFieldBytes),
    verifiedAt, oldInstanceId: text(row.oldInstanceId, limits.maxFieldBytes), databaseRole: text(row.databaseRole, limits.maxFieldBytes),
    writersVerifiedAt, oldProcess: Object.freeze({ pid: process.pid, startTicks, bootId, pidNamespace }),
    processEvidenceRef: text(row.processEvidenceRef, limits.maxFieldBytes),
    writersEvidenceRef: text(row.writersEvidenceRef, limits.maxFieldBytes), accounts: Object.freeze(accounts) })
  if (row.schema === 'pe-local-controlled-recovery-v3') {
    const kernelTermination = terminatedKernel(row.kernelTermination, limits.maxFieldBytes, facts.oldProcess, verifiedAt, writersVerifiedAt)
    need(facts.processEvidenceRef === kernelTermination.processTerminationEvidenceRef
      && facts.writersEvidenceRef === kernelTermination.quiescence.current.evidenceRef)
    return Object.freeze({ ...facts, schema: row.schema, kernelTermination })
  }
  return Object.freeze({ ...facts, schema: row.schema })
}

function proc(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size)
      if (count === 0) break
      size += count
    }
    need(size <= maximum)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } finally { closeSync(fd) }
}

/**
 * Read only the current kernel domain; this does not infer host continuity or death of an old process.
 * @returns Current Linux boot/PID namespace, or a rejection for unavailable kernel facts.
 */
export function observeRecoveryKernel(): RecoveryKernelIdentity {
  need(process.platform === 'linux')
  return kernelIdentity({ bootId: proc('/proc/sys/kernel/random/boot_id', 64).trim(), pidNamespace: readlinkSync('/proc/self/ns/pid') })
}

/**
 * Observe the exact old process in the current Linux process domain.
 * @param identity Originally captured PID/start and domain.
 * @returns Kernel facts; unreadable or malformed proc data rejects rather than implying death.
 */
export function observeRecoveryProcess(identity: RecoveryProcessIdentity): RecoveryProcessObservation {
  need(process.platform === 'linux')
  const bootId = proc('/proc/sys/kernel/random/boot_id', 64).trim(), pidNamespace = readlinkSync('/proc/self/ns/pid')
  let stat: string
  try { stat = proc(`/proc/${identity.pid}/stat`, 65536) }
  catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ESRCH')) {
      return { bootId, pidNamespace, original: 'absent' }
    }
    throw cause
  }
  const end = stat.lastIndexOf(') ')
  need(stat.startsWith(`${identity.pid} (`) && end > 0)
  const fields = stat.slice(end + 2).trim().split(/\s+/), startTicks = fields[19]
  need(startTicks !== undefined && /^[1-9]\d{0,19}$/.test(startTicks))
  return { bootId, pidNamespace, original: startTicks === identity.startTicks ? 'alive' : 'absent' }
}

/** Selected Root verifier capability; receipt data alone is never handed to an ordinary account or RPC. */
export class RootRecoveryWitness {
  /** Immutable bounded verifier facts; every use still rechecks the original publication and kernel domain. */
  readonly facts: RecoveryWitness
  /**
   * @param publication Original protected readonly lease selected by the Root Loader.
   * @param limits Explicit deployment capacities and maximum receipt age.
   * @param observe Independent kernel observer; omission uses actual Linux proc and namespace data.
   * @param now Current clock; omission uses the system clock.
   * @param observeKernel Independent current-domain observer for the explicitly selected v3 receipt.
   */
  constructor(private readonly publication: RecoveryPublication, private readonly limits: RecoveryWitnessLimits,
    private readonly observe = observeRecoveryProcess, private readonly now: () => number = Date.now,
    private readonly observeKernel = observeRecoveryKernel) {
    this.limits = Object.freeze({ ...limits })
    publication.assertCurrent()
    this.facts = parseRecoveryWitness(publication.value(), limits)
    this.assertCurrent()
  }

  /** Recheck protected publication, age and the selected same-domain absence or explicit local kernel-termination proof. */
  assertCurrent(): void {
    this.publication.assertCurrent()
    const age = this.now() - Date.parse(this.facts.verifiedAt)
    if (this.facts.schema === 'pe-local-controlled-recovery-v3') {
      const current = this.observeKernel(), expected = this.facts.kernelTermination.newKernel
      const snapshotAge = this.now() - Date.parse(this.facts.kernelTermination.quiescence.current.observedAt)
      need(Number.isSafeInteger(age) && age >= 0 && age <= this.limits.maxAgeMs
        && Number.isSafeInteger(snapshotAge) && snapshotAge >= 0 && snapshotAge <= this.limits.maxAgeMs
        && current.bootId === expected.bootId && current.pidNamespace === expected.pidNamespace)
      return
    }
    const observation = this.observe(this.facts.oldProcess)
    need(Number.isSafeInteger(age) && age >= 0 && age <= this.limits.maxAgeMs
      && observation.bootId === this.facts.oldProcess.bootId && observation.pidNamespace === this.facts.oldProcess.pidNamespace
      && observation.original === 'absent')
  }

  /**
   * Bind one durable row to verified accepted/destruction facts or a completed pre-provider refusal.
   * @param allocation Exact store row; refused creates require null identity and the precise creating/failed metadata.
   * @returns Original protected per-allocation facts; other or changed intents reject without store writes.
   */
  verifyAllocation(allocation: SandboxAllocation): RecoveryAllocationWitness {
    this.assertCurrent()
    const account = this.facts.accounts.find(value => value.accountId === allocation.accountId && value.epoch === allocation.epoch)
    const selected = account?.allocations.find(value => value.intent.allocationId === allocation.allocationId)
    need(selected !== undefined && recoveryIntentDigest(selected.intent) === recoveryIntentDigest(allocation)
      && (selected.createOutcome === 'rejected-before-provider-create' ? isProviderCreateRefusalRow(allocation)
        : allocation.sandboxId === null || allocation.sandboxId === selected.sandboxId))
    return selected
  }
}
