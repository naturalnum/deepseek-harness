/** Root owns one authenticated agent client per original allocation, independently of account admission. */
import { randomUUID } from 'node:crypto'
import type { PreparedSandbox } from './allocation-owner.ts'
import type { AgentHandshake, AgentSelection, FencedAgentRequests, TrustedAgentLifecycle } from './lifecycle-types.ts'
import type { CommandChannel, CommandSnapshot } from './command-operation.ts'
import { ExecutionStateError } from './errors.ts'
import { createAgentDataClient, makePrepared, PROTOCOL, SLICE_LIMITS } from './agent-data/index.ts'
import type { AgentDataClient, ClientOptions, OperationSnapshot, PreparedRequest } from './agent-data/types.ts'
import { createForegroundIssuer, createRegisteredServiceIssuer, type RoleIssuer } from './agent-data/root-role-issuer.ts'
import type { NativeRegisteredService } from './native-command-account.ts'
import type { HttpTransportLimits, PreviewHttpOwner, RegisteredHttpTarget } from './application-http.ts'
import type { RegisteredApplicationService, ServicePreviewIdentity } from './types.ts'

/**
 * Root captures the protected server selection; callers can select neither a server nor credentials.
 * @param target Original registered sandbox and fixed application port.
 * @param limits Root's parsed bounded HTTP policy.
 * @param owner Original service row's request and terminal owner.
 * @returns Only bounded response consumption for that target.
 */
export type ApplicationHttpFactory = (target: RegisteredHttpTarget, limits: HttpTransportLimits,
  owner: PreviewHttpOwner) => Pick<RegisteredApplicationService, 'withResponse'>

/** Fixed Root bootstrap operations; the privileged join includes all late sends and its actual dispatcher close. */
export interface TrustedAgentBootstrap {
  bootstrap(selection: AgentSelection, signal: AbortSignal): Promise<ClientOptions>
  fence(selection: AgentSelection): {
    readonly whenJoined: Promise<void>
    assertDeploymentCurrent(): void
  }
}

interface RuntimeRecord {
  readonly selection: AgentSelection
  readonly residentDeadlineAtMs: number
  commands: number
  fenced: boolean
  preparation?: Promise<AgentHandshake>
  handshake?: AgentHandshake
  client?: AgentDataClient
  expected?: ClientOptions['expected']
  foreground?: RoleIssuer
  service?: (registration: NativeRegisteredService) => RoleIssuer
  stopping?: FencedAgentRequests
  physicalStopped: boolean
  failure?: { readonly cause: unknown }
}

// The carrier runs Linux regardless of the development machine's signal-number table.
const linuxSignals: readonly NodeJS.Signals[] = [
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1',
  'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT', 'SIGSTOP',
  'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH',
  'SIGPOLL', 'SIGPWR', 'SIGSYS',
]

function unavailable(): never {
  throw new ExecutionStateError('cloud/execution-unavailable',
    'Cloud command completion is unconfirmed. Inspect its effects before submitting another command.')
}

function snapshot(value: OperationSnapshot): CommandSnapshot {
  const code = value.direct?.returncode
  const signal = code !== undefined && code < 0 ? linuxSignals[-code - 1] : null
  if (code !== undefined && code < 0 && signal === undefined) unavailable()
  const stream = (name: 'stdout' | 'stderr') => {
    const raw = value.streams[name]
    return Object.freeze({ bytes: raw.bytes, observedBytes: raw.observedBytes, eof: raw.eof })
  }
  return Object.freeze({ prepared: value.prepared, submitted: value.submitted, commitClosed: value.commitClosed,
    rangeEmpty: value.rangeEmpty, ioClosed: value.ioClosed, physicalStopRequired: value.physicalStopRequired,
    providerFailure: value.providerFailure || value.failure !== null || value.cleanupFailure !== null,
    direct: code === undefined ? undefined : Object.freeze({ exitCode: code < 0 ? null : code, signal: signal ?? null }),
    stdout: stream('stdout'), stderr: stream('stderr') })
}

/**
 * Join privileged startup separately from ordinary data transport. Physical destruction can close
 * unavailable user ranges before ordinary local cleanup finishes; neither join is a stop receipt.
 */
export class TrustedRuntimeRegistry implements TrustedAgentLifecycle {
  private readonly records = new Map<string, RuntimeRecord>()
  private readonly ready = new WeakMap<PreparedSandbox, RuntimeRecord>()

  /**
   * @param bootstrap Original fixed-deployment privileged owner.
   * @param maxRecords Finite lifetime allocation-record capacity, including stopped records.
   * @param clientFactory Dedicated production client factory; replacement transfers exclusive ownership for component tests.
   * @param applicationFactory Root's fixed selected-server factory; absence keeps application reads unavailable.
   */
  constructor(private readonly bootstrap: TrustedAgentBootstrap, private readonly maxRecords: number,
    private readonly clientFactory: (options: ClientOptions) => AgentDataClient = createAgentDataClient,
    private readonly applicationFactory?: ApplicationHttpFactory) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new RangeError('Runtime records require a finite capacity.')
  }

  /**
   * Report configured application-factory availability without creating a transport or checking readiness.
   * @returns Whether this original registry received Root's fixed application factory; executes no HTTP.
   */
  hasApplicationProvider(): boolean { return this.applicationFactory !== undefined }

  handshake = (selection: AgentSelection, signal: AbortSignal): Promise<AgentHandshake> => {
    const record = this.record(selection)
    if (record.fenced) unavailable()
    if (record.preparation !== undefined) return record.preparation
    const deferred = Promise.withResolvers<AgentHandshake>()
    record.preparation = deferred.promise
    // Install the original promise before bootstrap can send or invoke a reentrant teardown callback.
    void this.prepare(record, signal).then(deferred.resolve, deferred.reject)
    return record.preparation
  }

  /**
   * Register only the actual SDK preparation result after its original promise has fulfilled.
   * @param prepared Original object returned by the Root-owned SDK backend, never parsed account data.
   * @returns The same object, now usable by this registry's private command acquisition.
   */
  bindPrepared(prepared: PreparedSandbox): PreparedSandbox {
    const record = [...this.records.values()].find(value => value.selection.sandboxId === prepared.sandboxId)
    if (record === undefined || record.fenced || record.handshake === undefined
      || prepared.runtimeIdentity !== record.handshake.runtimeIdentity || prepared.protocolVersion !== PROTOCOL
      || prepared.capabilities.length !== 1 || prepared.capabilities[0] !== 'argv-collect') unavailable()
    const existing = this.ready.get(prepared)
    if (existing !== undefined && existing !== record) unavailable()
    this.ready.set(prepared, record)
    return prepared
  }

  /**
   * Reserve one immutable operation reference before the first remote command mutation.
   * @param prepared Original Root allocation result previously bound by the SDK wrapper.
   * @returns One command channel; no request is sent until prepare, and mutation failures are never retried.
   * The command owner acknowledges range closure only after its original allocation stop also joins local I/O.
   */
  command(prepared: PreparedSandbox): CommandChannel {
    return this.channel(prepared, record => record.foreground ?? unavailable())
  }

  /**
   * Bind one service operation to the exact current registration and original physical allocation.
   * @param prepared Original Root preparation result already bound to this registry.
   * @param registration Original account work row's service capability; a projected identity grants no authority.
   * @returns A service-only channel whose original control reference remains usable for cleanup after revocation.
   */
  service(prepared: PreparedSandbox, registration: NativeRegisteredService): CommandChannel {
    return this.channel(prepared, (record) => {
      const issue = record.service?.(registration) ?? unavailable()
      registration.bindAllocation(record.selection.intent.allocationId)
      return issue
    })
  }

  /**
   * Project HTTP access from an already authenticated original allocation and service registration.
   * @param registration Original native work-row capability; public identities cannot replace it.
   * @param identity Original row's once-bound allocation identity.
   * @param limits Root's parsed finite HTTP policy.
   * @param owner Original service request/controller reservation hook.
   * @returns Fixed-target transport only; performs no create, prepare, resume or command mutation.
   */
  application(registration: NativeRegisteredService, identity: ServicePreviewIdentity, limits: HttpTransportLimits,
    owner: PreviewHttpOwner): Pick<RegisteredApplicationService, 'withResponse'> {
    const factory = this.applicationFactory, record = this.records.get(identity.allocationId)
    if (factory === undefined || record === undefined) unavailable()
    const assertCurrent = (): void => {
      this.assertUnfenced(record); registration.assertCurrent()
      if (record.physicalStopped || record.handshake === undefined || record.client === undefined) unavailable()
      if (performance.now() >= record.residentDeadlineAtMs) unavailable()
      const { intent, mount } = record.selection, scope = registration.scope
      if (scope.purpose !== 'service' || scope.consumerId !== 'dev_service' || scope.binding !== mount.grant.binding
        || scope.binding.accountId !== identity.accountId || scope.binding.epoch !== identity.epoch
        || scope.sessionId !== identity.sessionId || registration.registrationId !== identity.serviceId
        || intent.allocationId !== identity.allocationId || intent.accountId !== identity.accountId
        || intent.epoch !== identity.epoch || intent.sessionId !== identity.sessionId
        || scope.project.id !== intent.workspaceId || scope.project.path !== mount.grant.project.rootPath) unavailable()
      mount.assertCurrent()
    }
    assertCurrent()
    return factory(Object.freeze({ sandboxId: record.selection.sandboxId, port: 8000,
      deadlineAtMs: record.residentDeadlineAtMs, assertCurrent }), limits, owner)
  }

  private channel(prepared: PreparedSandbox, authorize: (record: RuntimeRecord) => RoleIssuer): CommandChannel {
    const record = this.ready.get(prepared), client = record?.client
    if (record === undefined || client === undefined || record.fenced || record.physicalStopped) unavailable()
    const issue = authorize(record)
    if (record.commands >= SLICE_LIMITS.lifetimeOperations) {
      throw new ExecutionStateError('cloud/capacity', 'The selected sandbox reached its finite command-record capacity.')
    }
    record.commands++
    const operationId = randomUUID()
    let request: PreparedRequest | undefined
    const selected = (): PreparedRequest => {
      if (request === undefined) unavailable()
      return request
    }
    const run = async (work: () => Promise<OperationSnapshot>): Promise<CommandSnapshot> => {
      try { return snapshot(await work()) }
      catch (cause) { record.failure ??= { cause }; return unavailable() }
    }
    return Object.freeze<CommandChannel>({
      prepare: spec => run(() => {
        if (request !== undefined || record.fenced) unavailable()
        request = issue(makePrepared(prepared.runtimeIdentity, operationId, spec))
        return client.prepare(request)
      }),
      commit: () => run(() => client.commit(selected().ref)),
      poll: () => run(() => client.poll(selected().ref)),
      stop: () => run(() => client.stop(selected().ref)),
    })
  }

  fenceRequests = (selection: AgentSelection, prepared: AgentHandshake | undefined, _signal: AbortSignal): FencedAgentRequests => {
    const record = this.record(selection)
    if (prepared !== undefined && (record.handshake === undefined
      || prepared.runtimeIdentity !== record.handshake.runtimeIdentity || prepared.sandboxId !== selection.sandboxId
      || prepared.protocolVersion !== record.handshake.protocolVersion
      || prepared.payloadSha256 !== selection.payloadSha256 || prepared.imageDigest !== selection.imageDigest
      || prepared.deploymentIdentity !== selection.deploymentIdentity)) unavailable()
    if (record.stopping !== undefined) return record.stopping
    record.fenced = true
    const privileged = this.bootstrap.fence(record.selection)
    const existingClient = record.client
    // release() synchronously closes data starts and aborts observers; it does not await remote range-empty facts.
    const released = existingClient?.release()
    const ordinary = (async () => {
      await Promise.allSettled([record.preparation ?? Promise.resolve()])
      await released
      if (existingClient !== undefined) await existingClient.whenLocallySettled()
    })()
    record.stopping = Object.freeze({ sandboxId: selection.sandboxId, deploymentIdentity: selection.deploymentIdentity,
      whenPrivilegedStartsJoined: privileged.whenJoined, whenJoined: ordinary,
      assertDeploymentCurrent: () => { privileged.assertDeploymentCurrent() } })
    return record.stopping
  }

  acknowledgePhysicalStop = (selection: AgentSelection, _prepared: AgentHandshake | undefined): undefined => {
    // Selection was checked synchronously by fenceRequests before the backend issued its one DELETE.
    const record = this.records.get(selection.intent.allocationId)
    if (record === undefined || record.stopping === undefined || record.physicalStopped
      || selection.intent !== record.selection.intent || selection.mount !== record.selection.mount
      || selection.sandboxId !== record.selection.sandboxId
      || selection.deploymentIdentity !== record.selection.deploymentIdentity) return undefined
    record.physicalStopped = true
    if (record.client !== undefined && record.expected !== undefined) {
      try { record.client.notePhysicalStop({ physicalSandboxId: selection.sandboxId,
        runtimeIdentity: record.expected.runtimeIdentity, stopAckId: randomUUID(), processesGone: true }) }
      catch (cause) { record.failure ??= { cause } }
    }
    return undefined
  }

  private async prepare(record: RuntimeRecord, signal: AbortSignal): Promise<AgentHandshake> {
    const { selection } = record
    const options = await this.bootstrap.bootstrap(selection, signal)
    signal.throwIfAborted()
    if (record.fenced) unavailable()
    const { expected } = options, { grant } = selection.mount
    const sameRoot = (fact: ClientOptions['expected']['roots']['project'], root: typeof grant.project | typeof grant.environment): boolean =>
      fact.device === root.rootDevice && fact.inode === root.rootInode
        && fact.maximumBytes === root.quota.maximumBytes && fact.maximumInodes === root.quota.maximumInodes
    if (expected.physicalSandboxId !== selection.sandboxId || expected.projectRoot !== grant.project.rootPath
      || expected.declaredImageId !== selection.imageDigest || expected.pins.agentSourceSha256 !== selection.payloadSha256
      || !sameRoot(expected.roots.project, grant.project) || !sameRoot(expected.roots.environment, grant.environment)) unavailable()
    record.expected = expected
    record.foreground = createForegroundIssuer(options.token, expected.runtimeIdentity, () => {
      this.assertUnfenced(record)
      if (record.physicalStopped) unavailable()
    })
    record.service = registration => createRegisteredServiceIssuer(options.token, expected.runtimeIdentity,
      registration, (current) => {
        this.assertUnfenced(record)
        if (record.physicalStopped) unavailable()
        current.assertCurrent()
        const scope = current.scope, intent = record.selection.intent
        if (scope.purpose !== 'service' || scope.consumerId !== 'dev_service'
          || scope.binding !== grant.binding || scope.binding.accountId !== intent.accountId
          || scope.binding.epoch !== intent.epoch || scope.sessionId !== intent.sessionId
          || scope.project.id !== intent.workspaceId || scope.project.path !== grant.project.rootPath) unavailable()
        record.selection.mount.assertCurrent()
        return current.registrationId
      })
    record.client = this.clientFactory(options)
    const facts = await record.client.handshake({ signal })
    signal.throwIfAborted()
    this.assertUnfenced(record)
    if (facts.sealed || !facts.newOperationsAccepted || facts.physicalStopRequired
      || facts.recordCount !== 0 || facts.activeRangeCount !== 0) unavailable()
    record.handshake = Object.freeze({ sandboxId: selection.sandboxId, runtimeIdentity: facts.runtimeIdentity,
      protocolVersion: facts.protocolVersion, capabilities: Object.freeze(['argv-collect'] as const),
      payloadSha256: selection.payloadSha256, imageDigest: selection.imageDigest, deploymentIdentity: selection.deploymentIdentity })
    return record.handshake
  }

  private record(selection: AgentSelection): RuntimeRecord {
    const existing = this.records.get(selection.intent.allocationId)
    if (existing !== undefined) {
      const original = existing.selection
      if (selection.intent !== original.intent || selection.mount !== original.mount || selection.sandboxId !== original.sandboxId
        || selection.deploymentIdentity !== original.deploymentIdentity || selection.payloadSha256 !== original.payloadSha256
        || selection.imageDigest !== original.imageDigest) unavailable()
      return existing
    }
    if (this.records.size >= this.maxRecords) throw new ExecutionStateError('cloud/capacity', 'Trusted runtime record capacity is exhausted.')
    // This original Root record precedes fresh bootstrap and Manager construction; elapsed bootstrap consumes the projection.
    const record: RuntimeRecord = { selection, residentDeadlineAtMs: performance.now() + SLICE_LIMITS.residentMs,
      commands: 0, fenced: false, physicalStopped: false }
    this.records.set(selection.intent.allocationId, record)
    return record
  }

  private assertUnfenced(record: RuntimeRecord): void { if (record.fenced) unavailable() }
}
