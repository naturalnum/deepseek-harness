/** One account's original work rows; Root retains allocation, physical stop and global reservations. */
import { randomUUID } from 'node:crypto'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { guardianEncodedBudget, guardianWorkingCopiesBudget } from './agent-data/encoded-budget.ts'
import { assertInstalledExecutionBinding } from './account-port.ts'
import type { AllocationId } from './allocation-types.ts'
import type { NativeAccountExecutionAuthority } from './coordinator.ts'
import { PreviewHttpError, type HttpRequestCharge, type PreviewHttpOwner } from './application-http.ts'
import { ManagedCommandOperation, type CommandChannel, type CommandOperationLimits } from './command-operation.ts'
import { ExecutionStateError } from './errors.ts'
import { NativeExecutionCalls, type RetainedNativeService } from './native-calls.ts'
import type { NativeExecutionProviderPort } from './native-providers.ts'
import type { ExecutionScope } from './scopes.ts'
import type { DevelopmentServiceId, RegisteredApplicationService, ServicePreviewIdentity } from './types.ts'
import type { DevServiceProfile, OriginalDevServiceHooks, OriginalDevServiceWork, ResolvedServiceStart } from './dev-service-consumer.ts'
import { projectServiceRange } from './service-projection.ts'

/** Independent Root reservations; output remains charged after the active range ends. */
export interface NativeCommandReservation {
  releaseActive(): void
  releaseResident(): void
}

/** Original registered capability passed only to Root's service allocation/issuer bridge. */
export interface NativeRegisteredService {
  readonly scope: ExecutionScope<Workspace>
  readonly registrationId: DevelopmentServiceId
  assertCurrent(): void
  /**
   * Bind only the allocation selected by the original trusted runtime after its scope checks.
   * @param allocationId Original allocation id; repeating it is idempotent, replacing it is refused.
   */
  bindAllocation(allocationId: AllocationId): void
  /** Serialized identity only; this return value never substitutes for this capability. */
  projectIdentity(allocationId: AllocationId): ServicePreviewIdentity
}

/** Root callbacks preserve the original allocation and reservation owners. */
export interface NativeCommandRoot {
  /** Service is absent for ordinary commands; service channels must use this exact registered capability. */
  acquire(scope: ExecutionScope<Workspace>, signal: AbortSignal, service?: NativeRegisteredService): Promise<CommandChannel>
  unknown(scope: ExecutionScope<Workspace>, operation: ManagedCommandOperation, cause: unknown): void
  reserve(scope: ExecutionScope<Workspace>, spec: SubprocessSpawnSpec): NativeCommandReservation
  /** Join original physical allocations and transport without waiting for the command whenEmpty latches. */
  close(): Promise<void>
}

/** Required reviewed service values and original session Python resolver; no local profile defaults. */
export interface NativeServiceAccountConfig {
  readonly profile: DevServiceProfile
  /** Original controller lifetime and stop limits; maxLifetimeMs is independent of profile.runMs and Root transport budgets. */
  readonly operationLimits: CommandOperationLimits
  /** Original Root request/byte callbacks. Omission refuses application reads without allocating anything. */
  readonly application?: {
    readonly maxRequestsPerService: number
    reserve(scope: ExecutionScope<Workspace>, charge: HttpRequestCharge): { release(): void }
    transport(registration: NativeRegisteredService, identity: ServicePreviewIdentity,
      owner: PreviewHttpOwner): Pick<RegisteredApplicationService, 'withResponse'>
  }
  assertQualified(profile: DevServiceProfile): void
  serviceSpec(scope: ExecutionScope<Workspace>, profile: DevServiceProfile, start: ResolvedServiceStart): SubprocessSpawnSpec
}

/** Fixed native consumers and existing finite Root budgets. */
export interface NativeCommandAccountLimits {
  readonly allowedTools: readonly string[]
  readonly maxScopes: number
  readonly commandLimits: CommandOperationLimits
  /** Trusted original files count bound; no copy membership or public command field. */
  readonly maxSkillCopiesPerOperation?: number
  readonly services?: NativeServiceAccountConfig
}

interface ServiceApplicationRequest {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly joined: Promise<void>
}
interface ServiceRow {
  readonly lease: RetainedNativeService<Workspace>
  readonly id: DevelopmentServiceId
  readonly profile: DevServiceProfile
  readonly fingerprint: string
  readonly registration: NativeRegisteredService
  readonly submitted: ReturnType<typeof Promise.withResolvers<void>>
  readonly work: OriginalDevServiceWork<Workspace>
  readonly requests: Set<ServiceApplicationRequest>
  readonly empty: ReturnType<typeof Promise.withResolvers<void>>
  requestsClosed: boolean
  retireRequested: boolean
  allocationId?: AllocationId
  submittedConfirmed: boolean
  detachStart(): void
  startFailure?: { readonly cause: unknown }
  projection?: ReturnType<typeof projectServiceRange>
}
interface CommandRecord {
  readonly scope: ExecutionScope<Workspace>
  readonly role: 'foreground' | 'service'
  readonly reservation: NativeCommandReservation
  operation?: ManagedCommandOperation
  service?: ServiceRow
  activeReleased: boolean
  retired: boolean
  unknownReported: boolean
  privateFailure?: { readonly cause: unknown }
}
type RecordKey = ManagedCommandOperation | RetainedNativeService<Workspace>
interface ActiveRoles { foreground?: CommandRecord; service?: CommandRecord }

/** Preparing leases and bound operations occupy the same original records container. */
export class NativeCommandAccount implements NativeExecutionProviderPort, OriginalDevServiceHooks<Workspace> {
  /** Account-owned invocation scopes; releasing one does not retire its retained command or service record. */
  readonly calls: NativeExecutionCalls<Workspace>
  private readonly records = new Map<RecordKey, CommandRecord>()
  private readonly active = new Map<SessionId, ActiveRoles>()
  private readonly state: { open: boolean; closing?: Promise<void> } = { open: true }
  private readonly limits: CommandOperationLimits

  constructor(private readonly ctx: Context, private readonly binding: AccountBinding,
    private readonly authority: NativeAccountExecutionAuthority, private readonly config: NativeCommandAccountLimits,
    private readonly root: NativeCommandRoot) {
    assertInstalledExecutionBinding(ctx, binding, ctx.root)
    for (const limits of [config.commandLimits, ...(config.services === undefined ? [] : [config.services.operationLimits])]) {
      for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
        throw new ExecutionStateError('cloud/invalid-config', 'Execution limits must be finite positive integers.')
      }
    }
    this.limits = Object.freeze({ ...config.commandLimits })
    const application = config.services?.application
    if (application !== undefined && (!Number.isSafeInteger(application.maxRequestsPerService)
      || application.maxRequestsPerService < 1 || application.maxRequestsPerService > 2147483647)) {
      throw new ExecutionStateError('cloud/invalid-config', 'Application request capacity must be a finite positive integer.')
    }
    this.calls = new NativeExecutionCalls(ctx, { binding, maxScopes: config.maxScopes,
      allowedTools: Object.freeze([...config.allowedTools]), getAgent: authority.getAgent,
      projectForAgent: authority.projectForAgent, assertCurrent: (scope) => { this.assertScope(scope) },
      released: (scope) => { this.releaseScope(scope) } })
  }

  /**
   * Observe original invocation, process-range and service-request settlement without business admission.
   * @returns True only while open, with no invocation or unfinished range/request; completed output stays charged.
   */
  isIdle(): boolean {
    if (!this.state.open || this.state.closing !== undefined || this.binding.lifetime.aborted
      || this.ctx.fiber.state !== FiberState.ACTIVE || this.ctx.get('peAccount') !== this.binding
      || !this.calls.isIdle() || this.active.size !== 0) return false
    for (const record of this.records.values()) {
      if (record.scope.binding !== this.binding || !record.activeReleased || record.unknownReported
        || record.privateFailure !== undefined || record.service !== undefined && record.service.requests.size !== 0) return false
    }
    return true
  }

  /**
   * Confirm that only this never-submitted foreground acquisition is active in the Session.
   * @param scope Original current foreground scope whose acquire callback has not returned a channel.
   */
  assertContinuation(scope: ExecutionScope<Workspace>): void {
    this.calls.assertCurrent(scope)
    const current = this.active.get(scope.sessionId)?.foreground
    if (!this.state.open || scope.purpose !== 'command' || current?.scope !== scope
      || current.operation === undefined || !current.operation.isAwaitingChannel() || current.unknownReported) throw this.failure()
    for (const row of this.records.values()) {
      if (row === current || row.scope.sessionId !== scope.sessionId) continue
      if (!row.activeReleased || row.unknownReported || (row.service?.requests.size ?? 0) !== 0) {
        throw new ExecutionStateError('cloud/capacity', 'Session compute cannot retire while another range or application request remains active.')
      }
    }
  }

  /**
   * Revoke completed old handles after original physical stop, terminal metadata and mount release.
   * @param scope The same original foreground acquisition that has not yet obtained its new channel.
   */
  retireCompletedSession(scope: ExecutionScope<Workspace>): void {
    this.assertContinuation(scope)
    const current = this.active.get(scope.sessionId)?.foreground
    for (const row of [...this.records.values()]) {
      if (row === current || row.scope.sessionId !== scope.sessionId) continue
      if (row.operation !== undefined) row.operation.release()
      else this.retireUnstarted(row)
    }
  }

  assertCurrent(caller: Context): void { this.capture(caller) }
  projectRoot(caller: Context): string { return this.capture(caller).scope.project.path }

  /**
   * Borrow one submitted original service without allocating or using the current tool invocation.
   * @param selection Exact Session and original registered service id in this account generation.
   * @param signal Original request cancellation, retained even when withResponse adds another observer.
   * @param deadlineAtMs Original absolute request deadline; no transport call can extend it.
   * @param consume Borrow callback, allowed at most one response; callback return revokes late use and joins actual I/O.
   * @returns Callback and actual I/O settlement; rejected terminal cleanup keeps its original row and capacity unknown.
   */
  async withApplicationService(selection: { sessionId: SessionId; serviceId: DevelopmentServiceId }, signal: AbortSignal,
    deadlineAtMs: number, consume: (service: RegisteredApplicationService) => Promise<void>): Promise<void> {
    const application = this.config.services?.application
    if (application === undefined) throw new PreviewHttpError('cloud/account-unavailable')
    const { sessionId, serviceId } = selection
    const record = this.active.get(sessionId)?.service, service = record?.service
    if (record === undefined || service === undefined || service.id !== serviceId) throw this.failure()
    const observedAtMs = performance.now(), ingressDeadlineAtMs = observedAtMs + (deadlineAtMs - Date.now())
    const remainingMs = (): number => Math.min(Math.floor(ingressDeadlineAtMs - performance.now()),
      record.operation?.remainingExecutionMs(service.profile.runMs) ?? 0)
    const current = (): void => {
      signal.throwIfAborted()
      if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now() || remainingMs() < 1) {
        throw new PreviewHttpError('cloud/account-unavailable')
      }
      this.assertRegistered(record); service.registration.assertCurrent()
      if (service.requestsClosed || !service.submittedConfirmed || service.allocationId === undefined
        || this.active.get(sessionId)?.service !== record) throw this.failure()
    }
    current()
    const allocationId = service.allocationId
    if (allocationId === undefined) throw this.failure()
    const identity = service.registration.projectIdentity(allocationId)
    let open = true, used = false, retentionAttempted = false
    let retained: ServiceApplicationRequest | undefined, actual: Promise<void> | undefined
    const assertBorrow = (): void => { if (!open) throw this.failure(); current() }
    const owner: PreviewHttpOwner = { retainRequest: (input) => {
      if (retentionAttempted) throw new PreviewHttpError('cloud/capacity')
      retentionAttempted = true
      assertBorrow(); input.controller.signal.throwIfAborted()
      if (service.requests.size >= application.maxRequestsPerService) throw new PreviewHttpError('cloud/capacity')
      const reservation = application.reserve(record.scope, input.charge)
      let timeoutMs: number
      try {
        // reserve can synchronously revoke/stop this row or admit another read; no wire exists at this point.
        assertBorrow(); input.controller.signal.throwIfAborted()
        if (service.requests.size >= application.maxRequestsPerService) throw new PreviewHttpError('cloud/capacity')
        timeoutMs = Math.min(input.charge.timeoutMs, deadlineAtMs - Date.now(), remainingMs())
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new PreviewHttpError('cloud/account-unavailable')
      } catch (cause) { reservation.release(); throw cause }
      const joined = Promise.withResolvers<void>()
      void joined.promise.catch((_cause: unknown) => { /* Rejected actual cleanup remains on the original finite request set. */ })
      const request: ServiceApplicationRequest = { controller: input.controller, settled: input.settled, joined: joined.promise }
      retained = request; service.requests.add(request)
      const abort = (): void => { input.controller.abort(signal.aborted ? signal.reason : record.scope.lifetime.reason) }
      const detach = (): void => {
        signal.removeEventListener('abort', abort); record.scope.lifetime.removeEventListener('abort', abort)
      }
      const unknown = (cause: unknown): void => {
        detach(); this.closeApplicationRequests(record, cause)
        joined.reject(new PreviewHttpError('cloud/stop-unconfirmed', cause)); this.reportUnknown(record, cause)
      }
      void input.settled.then(() => {
        detach()
        try { reservation.release() }
        catch (cause) { unknown(cause); return }
        service.requests.delete(request)
        joined.resolve()
        if (service.retireRequested) this.retire(record)
      }, unknown)
      signal.addEventListener('abort', abort, { once: true })
      record.scope.lifetime.addEventListener('abort', abort, { once: true })
      if (signal.aborted || record.scope.lifetime.aborted) abort()
      return { timeoutMs, assertCurrent: () => {
        assertBorrow(); input.controller.signal.throwIfAborted()
        if (!service.requests.has(request)) throw this.failure()
      } }
    } }
    const capability = Object.freeze<RegisteredApplicationService>({ scope: identity, port: service.profile.port,
      lifetime: record.scope.lifetime, assertCurrent: assertBorrow,
      withResponse: (request, limits, responseSignal, read) => {
        if (used || !open) return Promise.reject(this.failure())
        used = true
        actual = (async () => {
          assertBorrow()
          const transport = application.transport(service.registration, identity, owner)
          assertBorrow()
          await transport.withResponse(request, limits, AbortSignal.any([signal, record.scope.lifetime, responseSignal]), read)
        })()
        void actual.catch((_cause: unknown) => { /* The original borrow joins this same I/O even if its callback does not await it. */ })
        return actual
      } })
    let failure: { cause: unknown } | undefined
    try { await consume(capability); assertBorrow() }
    catch (cause) { failure = { cause } }
    finally {
      open = false
      if (retained !== undefined && service.requests.has(retained)) retained.controller.abort(failure?.cause ?? this.failure())
      if (actual !== undefined) {
        try { await actual }
        catch (cause) { failure ??= { cause } }
      }
      if (retained !== undefined) {
        try { await retained.joined }
        catch (cause) { failure = { cause } }
      }
    }
    if (failure !== undefined) throw failure.cause
  }

  assertQualified(profile: DevServiceProfile): void {
    const service = this.config.services
    if (service === undefined || service.profile !== profile) {
      throw new ExecutionStateError('cloud/execution-unavailable', 'Development services are unavailable under this execution policy.')
    }
    service.assertQualified(profile)
  }

  serviceSpec(scope: ExecutionScope<Workspace>, profile: DevServiceProfile, start: ResolvedServiceStart): SubprocessSpawnSpec {
    this.assertQualified(profile); this.assertServiceScope(scope)
    const service = this.config.services
    if (service === undefined) throw this.failure()
    const spec = service.serviceSpec(scope, profile, start)
    this.validateInput(scope, spec)
    if (spec.signal !== scope.lifetime) throw new ExecutionStateError('cloud/invalid-config', 'The service lifetime is invalid.')
    return spec
  }

  prepareStart(lease: RetainedNativeService<Workspace>, profile: DevServiceProfile, signal: AbortSignal, spec: SubprocessSpawnSpec): void {
    this.assertQualified(profile); this.assertServiceScope(lease.scope); signal.throwIfAborted()
    if (lease.session !== lease.scope.agent.session || this.findLease(lease) !== undefined) throw this.failure()
    this.requireSlot(lease.scope, 'service'); this.validateInput(lease.scope, spec)
    if (spec.signal !== lease.scope.lifetime) throw new ExecutionStateError('cloud/invalid-config', 'The service lifetime is invalid.')
    const reservation = this.root.reserve(lease.scope, spec)
    let record: CommandRecord | undefined
    try {
      this.calls.assertCurrent(lease.scope); signal.throwIfAborted()
      const row: CommandRecord = { scope: lease.scope, role: 'service', reservation,
        activeReleased: false, retired: false, unknownReported: false }
      record = row
      const id = brandString<DevelopmentServiceId>(randomUUID()), submitted = Promise.withResolvers<void>()
      void submitted.promise.catch(() => { /* Original startup failure remains available to its native caller. */ })
      const registration: NativeRegisteredService = Object.freeze({ scope: lease.scope, registrationId: id,
        assertCurrent: () => {
          this.assertRegistered(row)
          if (row.activeReleased || row.unknownReported || row.service?.requestsClosed || row.service?.startFailure !== undefined
            || row.operation?.stopReason() !== undefined) throw this.failure()
        },
        bindAllocation: (allocationId: AllocationId): void => {
          registration.assertCurrent()
          const service = row.service
          if (service === undefined || service.allocationId !== undefined && service.allocationId !== allocationId) throw this.failure()
          service.allocationId ??= allocationId
        },
        projectIdentity: (allocationId: AllocationId): ServicePreviewIdentity => Object.freeze({
          accountId: this.binding.accountId, epoch: this.binding.epoch, sessionId: lease.scope.sessionId, allocationId, serviceId: id }) })
      const work: OriginalDevServiceWork<Workspace> = Object.freeze({ handle: id, lease,
        assertCurrent: () => { this.assertRegistered(row) }, status: () => this.serviceStatus(row),
        previewIdentity: () => {
          this.assertRegistered(row)
          const allocationId = row.service?.allocationId
          return allocationId === undefined ? undefined : registration.projectIdentity(allocationId)
        },
        log: (stream: 'stdout' | 'stderr', offset: number) => this.serviceLog(row, stream, offset),
        observeStart: (startSignal: AbortSignal) => this.observeServiceStart(row, startSignal),
        stop: (stopSignal: AbortSignal) => this.stopService(row, stopSignal) })
      const abort = (): void => {
        this.cancelStart(row, signal.reason)
      }
      row.service = { lease, id, profile, fingerprint: this.fingerprint(spec), registration, submitted, work,
        requests: new Set(), empty: Promise.withResolvers<void>(), requestsClosed: false, retireRequested: false,
        submittedConfirmed: false, detachStart: () => { signal.removeEventListener('abort', abort) } }
      this.records.set(lease, row); this.claimSlot(row)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    } catch (cause) {
      if (record === undefined || record.service === undefined) { reservation.releaseActive(); reservation.releaseResident() }
      else this.retireUnstarted(record)
      throw cause
    }
  }

  attachOriginal(lease: RetainedNativeService<Workspace>, process: SubprocessHandle,
    profile: DevServiceProfile): OriginalDevServiceWork<Workspace> {
    this.assertQualified(profile)
    const record = this.findLease(lease)
    if (record?.operation?.handle !== process || record.service === undefined) throw this.failure()
    this.assertRegistered(record)
    return record.service.work
  }

  resolve(scope: ExecutionScope<Workspace>, handle?: string): OriginalDevServiceWork<Workspace> {
    this.calls.assertCurrent(scope)
    if (scope.purpose !== 'consumer' || scope.consumerId !== 'dev_service') throw this.failure()
    let found: CommandRecord | undefined
    for (const row of this.records.values()) {
      const service = row.service
      if (service === undefined || row.retired || row.scope.binding !== scope.binding || row.scope.agent !== scope.agent
        || row.scope.project !== scope.project || row.scope.sessionId !== scope.sessionId
        || service.lease.session !== scope.agent.session) continue
      if (handle !== undefined && service.id !== handle) continue
      if (found !== undefined) throw new ExecutionStateError('cloud/execution-unavailable', 'More than one registered service matches; specify its handle.')
      found = row
    }
    if (found?.service === undefined) throw new ExecutionStateError('cloud/execution-unavailable', 'The service is unavailable in this Session.')
    this.assertRegistered(found)
    return found.service.work
  }

  retainFailedStart(lease: RetainedNativeService<Workspace>, process: SubprocessHandle | undefined, cause: unknown): void {
    const record = this.findLease(lease)
    if (record === undefined) { lease.release(); return }
    const service = record.service
    if (service !== undefined && !service.submittedConfirmed) {
      service.startFailure ??= { cause }; service.submitted.reject(service.startFailure.cause)
    }
    if (record.operation === undefined) { this.retireUnstarted(record); return }
    if (process !== undefined && process !== record.operation.handle) this.reportUnknown(record, this.failure())
    record.operation.requestStop(cause)
    record.operation.release()
    record.operation.cancelUnstarted(cause)
  }

  create(caller: Context, spec: SubprocessSpawnSpec): ManagedCommandOperation {
    const { scope, signal } = this.capture(caller)
    signal.throwIfAborted(); spec.signal?.throwIfAborted(); this.validateInput(scope, spec)
    if (scope.purpose === 'service') {
      const record = [...this.records.values()].find(row => row.scope === scope && row.role === 'service')
      if (record?.service === undefined || record.operation !== undefined || record.retired) throw this.failure()
      this.assertQualified(record.service.profile)
      if (record.service.fingerprint !== this.fingerprint(spec) || spec.signal !== scope.lifetime) throw this.failure()
      try {
        const serviceConfig = this.config.services
        if (serviceConfig === undefined) throw this.failure()
        const operation = this.makeOperation(record, spec, serviceConfig.operationLimits)
        record.operation = operation
        this.records.delete(record.service.lease); this.records.set(operation, record)
        record.service.projection = projectServiceRange(operation.handle,
          { whenEmpty: record.service.empty.promise, requestStop: () => {
            this.closeApplicationRequests(record, this.failure()); operation.requestStop(new Error('Service stop requested.'))
          } },
          { maxLogReadBytes: record.service.profile.maxLogReadBytes, assertCurrent: () => { this.assertRegistered(record) } })
        this.watchEmpty(record, operation)
        return operation
      } catch (cause) {
        if (record.operation === undefined) this.retireUnstarted(record)
        else { record.operation.release(); record.operation.cancelUnstarted(cause) }
        throw cause
      }
    }
    if (scope.purpose !== 'command') throw this.failure()
    this.requireSlot(scope, 'foreground')
    const input: SubprocessSpawnSpec = { ...spec,
      signal: spec.signal === undefined || spec.signal === signal ? signal : AbortSignal.any([signal, spec.signal]) }
    let record: CommandRecord | undefined, reservation: NativeCommandReservation | undefined
    // Constructor validation still precedes ordinary Root reservation, as on the original command path.
    const operation = new ManagedCommandOperation(input, this.limits, {
      lifetime: scope.lifetime, assertCurrent: () => { this.calls.assertCurrent(scope) },
      acquire: async (cancelled) => {
        cancelled.throwIfAborted(); this.calls.assertCurrent(scope)
        if (record === undefined) throw this.failure()
        return this.protectChannel(record, await this.root.acquire(scope, cancelled))
      }, unknown: (cause) => { if (record !== undefined) this.reportUnknown(record, cause) },
      retired: () => {
        if (record !== undefined) this.retire(record)
        else { reservation?.releaseActive(); reservation?.releaseResident() }
      } })
    try {
      reservation = this.root.reserve(scope, input); this.calls.assertCurrent(scope)
      record = { scope, role: 'foreground', operation, reservation, activeReleased: false, retired: false, unknownReported: false }
      this.records.set(operation, record); this.claimSlot(record); this.watchEmpty(record, operation)
      return operation
    } catch (cause) { operation.release(); operation.begin(); throw cause }
  }

  assertOperationCurrent(caller: Context, operation: ManagedCommandOperation): void {
    assertInstalledExecutionBinding(caller, this.binding, this.ctx.root)
    const record = this.records.get(operation)
    if (record === undefined) throw this.failure()
    this.calls.assertCurrent(record.scope)
  }
  providerFailed(operation: ManagedCommandOperation, cause: unknown): void {
    const record = this.records.get(operation)
    if (record === undefined) return
    operation.requestStop(this.failure()); this.reportUnknown(record, cause)
  }
  closeProvider(): Promise<void> {
    if (this.state.closing !== undefined) return this.state.closing
    this.state.open = false
    const closing = Promise.withResolvers<undefined>(); this.state.closing = closing.promise
    const owned = [...this.records.values()]; this.calls.close()
    for (const row of owned) {
      this.closeApplicationRequests(row, this.failure())
      if (row.operation === undefined) this.retireUnstarted(row)
      else { row.operation.release(); row.operation.cancelUnstarted(this.failure()) }
    }
    void this.closeOwned(owned).then(() => { closing.resolve(undefined) }, (cause: unknown) => { closing.reject(cause) })
    return this.state.closing
  }

  private makeOperation(record: CommandRecord, input: SubprocessSpawnSpec, limits: CommandOperationLimits): ManagedCommandOperation {
    return new ManagedCommandOperation(input, limits, { lifetime: record.scope.lifetime,
      assertCurrent: () => { this.calls.assertCurrent(record.scope) },
      acquire: async (cancelled) => {
        cancelled.throwIfAborted(); this.calls.assertCurrent(record.scope)
        const registration = record.service?.registration
        registration?.assertCurrent()
        const channel = registration === undefined ? await this.root.acquire(record.scope, cancelled)
          : await this.root.acquire(record.scope, cancelled, registration)
        return this.protectChannel(record, channel)
      }, onSubmitted: () => {
        const service = record.service
        if (service === undefined || service.submittedConfirmed) return
        service.submittedConfirmed = true; service.detachStart()
        if (service.startFailure === undefined) service.submitted.resolve()
      }, unknown: (cause) => { this.reportUnknown(record, cause) }, retired: () => { this.retire(record) } })
  }
  private watchEmpty(record: CommandRecord, operation: ManagedCommandOperation): void {
    void operation.whenEmpty.then(async () => {
      const service = record.service
      if (service !== undefined) {
        this.closeApplicationRequests(record, this.failure())
        await this.joinApplicationRequests(record)
        service.empty.resolve()
      }
      this.releaseActive(record)
      if (service !== undefined && !service.submittedConfirmed) {
        service.startFailure ??= { cause: this.failure() }; service.submitted.reject(service.startFailure.cause)
      }
    }).catch((cause: unknown) => { this.reportUnknown(record, cause) })
  }
  private serviceStatus(record: CommandRecord): { [key: string]: ToolExecutionSuccess['value'] } {
    this.assertRegistered(record)
    const service = record.service
    if (service === undefined) throw this.failure()
    return { serviceId: service.id, processSubmitted: service.submittedConfirmed, httpReady: false,
      ...(service.projection?.status() ?? { direct: 'pending', range: 'pending' }),
      ...(record.unknownReported ? { uncertain: true } : {}) }
  }
  private cancelStart(record: CommandRecord, cause: unknown): void {
    const service = record.service
    if (service === undefined || service.submittedConfirmed || record.retired) return
    service.startFailure ??= { cause }; service.submitted.reject(service.startFailure.cause)
    if (record.operation === undefined) this.retireUnstarted(record)
    else record.operation.requestStop(service.startFailure.cause)
  }
  private async observeServiceStart(record: CommandRecord, signal: AbortSignal): Promise<ToolExecutionSuccess['value']> {
    const service = record.service
    if (service === undefined) throw this.failure()
    const abort = (): void => { this.cancelStart(record, signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      await service.submitted.promise
      return { phase: 'process-submitted', httpReady: false, ...this.serviceStatus(record) }
    } finally { signal.removeEventListener('abort', abort) }
  }
  private serviceLog(record: CommandRecord, stream: 'stdout' | 'stderr', offset: number): ToolExecutionSuccess['value'] {
    this.assertRegistered(record)
    const projection = record.service?.projection
    if (projection === undefined) throw new ExecutionStateError('cloud/execution-unavailable', 'The service has not produced readable logs.')
    const value = projection.log(stream, offset)
    return { text: value.text, nextOffset: value.nextOffset, lossy: value.lossy }
  }
  private async stopService(record: CommandRecord, signal: AbortSignal): Promise<ToolExecutionSuccess['value']> {
    this.assertRegistered(record)
    this.closeApplicationRequests(record, this.failure())
    if (record.operation === undefined) { this.retireUnstarted(record); return { confirmed: true, processSubmitted: false } }
    const projection = record.service?.projection
    if (projection === undefined) throw this.failure()
    return { confirmed: await projection.stop(signal) }
  }
  private findLease(lease: RetainedNativeService<Workspace>): CommandRecord | undefined {
    return [...this.records.values()].find(row => row.service?.lease === lease)
  }
  private assertRegistered(record: CommandRecord): void {
    if (record.retired || record.service === undefined
      || this.records.get(record.operation ?? record.service.lease) !== record) throw this.failure()
    this.calls.assertCurrent(record.scope)
    if (record.service.lease.session !== record.scope.agent.session) throw this.failure()
  }
  private assertServiceScope(scope: ExecutionScope<Workspace>): void {
    this.calls.assertCurrent(scope)
    if (scope.purpose !== 'service' || scope.consumerId !== 'dev_service') throw this.failure()
  }
  private requireSlot(scope: ExecutionScope<Workspace>, role: 'foreground' | 'service'): void {
    const roles = this.active.get(scope.sessionId)
    if (roles?.foreground?.unknownReported || roles?.service?.unknownReported) throw this.failure()
    if (roles?.[role] !== undefined) {
      throw new ExecutionStateError('cloud/capacity', role === 'service' ? 'This Session already has an active development service.' : 'This Session already owns an active command range.')
    }
  }
  private claimSlot(record: CommandRecord): void {
    const roles = this.active.get(record.scope.sessionId) ?? {}
    roles[record.role] = record; this.active.set(record.scope.sessionId, roles)
  }
  private releaseActive(record: CommandRecord): void {
    if (record.activeReleased) return
    record.activeReleased = true
    const roles = this.active.get(record.scope.sessionId)
    if (roles?.[record.role] === record) {
      if (record.role === 'foreground') delete roles.foreground
      else delete roles.service
      if (roles.foreground === undefined && roles.service === undefined) this.active.delete(record.scope.sessionId)
    }
    record.reservation.releaseActive()
  }
  private retireUnstarted(record: CommandRecord): void {
    if (record.operation !== undefined || record.retired) return
    this.retire(record)
  }
  private retire(record: CommandRecord): void {
    if (record.retired) return
    const service = record.service
    if (service !== undefined) {
      service.retireRequested = true
      this.closeApplicationRequests(record, this.failure())
      if (service.requests.size > 0) return
    }
    record.retired = true
    if (record.operation !== undefined) this.records.delete(record.operation)
    else if (service !== undefined) this.records.delete(service.lease)
    this.releaseActive(record); record.reservation.releaseResident()
    if (service !== undefined) {
      service.detachStart(); service.submitted.reject(service.startFailure?.cause ?? this.failure()); service.lease.release()
    }
  }
  private async closeOwned(owned: readonly CommandRecord[]): Promise<void> {
    let physicalFailure: { cause: unknown } | undefined
    try { await this.root.close() }
    catch (cause) {
      for (const row of owned) if (row.operation !== undefined) this.reportUnknown(row, cause)
      physicalFailure = { cause }
    }
    if (physicalFailure === undefined) {
      for (const row of owned) row.operation?.acknowledgePhysicalStop()
      await Promise.all(owned.flatMap(row => row.operation === undefined ? [] : [row.operation.whenEmpty]))
    }
    const joined = await Promise.allSettled(owned.map(row => this.joinApplicationRequests(row)))
    for (const outcome of joined) if (outcome.status === 'rejected') throw outcome.reason
    if (physicalFailure !== undefined) throw this.failure()
  }
  private closeApplicationRequests(record: CommandRecord, cause: unknown): void {
    const service = record.service
    if (service === undefined) return
    service.requestsClosed = true
    for (const request of service.requests) request.controller.abort(cause)
  }
  private async joinApplicationRequests(record: CommandRecord): Promise<void> {
    if (record.service === undefined) return
    const joined = await Promise.allSettled([...record.service.requests].map(request => request.joined))
    for (const outcome of joined) if (outcome.status === 'rejected') throw outcome.reason
  }
  private capture(caller: Context) { if (!this.state.open) throw this.failure(); return this.calls.capture(caller) }
  private assertScope(scope: ExecutionScope<Workspace>): void {
    if (!this.state.open) throw this.failure()
    this.authority.assertBusinessCurrent(); assertInstalledExecutionBinding(scope.agent.ctx, this.binding, this.ctx.root)
    if (scope.binding !== this.binding || this.authority.projectForAgent(scope.agent) !== scope.project
      || this.authority.projectForSession(scope.agent.session) !== scope.project
      || !scope.project.sessionIds.includes(scope.sessionId)) throw this.failure()
  }
  private releaseScope(scope: ExecutionScope<Workspace>): void {
    for (const row of [...this.records.values()]) if (row.scope === scope) {
      this.closeApplicationRequests(row, this.failure())
      if (row.operation === undefined) this.retireUnstarted(row)
      else { row.operation.release(); row.operation.cancelUnstarted(this.failure()) }
    }
  }
  private validateInput(scope: ExecutionScope<Workspace>, spec: SubprocessSpawnSpec): void {
    const project = scope.project.path, stdin = spec.stdio.stdin
    if (spec.cwd !== project && !spec.cwd.startsWith(project + '/')) throw this.failure()
    if (stdin === 'pipe') throw new ExecutionStateError('cloud/execution-unavailable', 'Closed or batch input is required.')
    const value = { argv: spec.argv, cwd: spec.cwd,
      stdin: stdin === 'ignore' ? { mode: 'ignore' as const } : { mode: 'batch' as const, base64: Buffer.from(stdin.data).toString('base64') } }
    if (this.config.maxSkillCopiesPerOperation === undefined) guardianEncodedBudget(project, value)
    else guardianWorkingCopiesBudget(project, value, this.config.maxSkillCopiesPerOperation)
  }
  private fingerprint(spec: SubprocessSpawnSpec): string {
    return JSON.stringify({ argv: spec.argv, cwd: spec.cwd, stdio: spec.stdio, graceMs: spec.graceMs, env: spec.env })
  }
  private protectChannel(record: CommandRecord, channel: CommandChannel): CommandChannel {
    const observe = async <T>(request: () => Promise<T>): Promise<T> => {
      try { return await request() }
      catch (cause) { record.privateFailure ??= { cause }; throw this.failure() }
    }
    return { ...(channel.release === undefined ? {} : { release: () => channel.release?.() }),
      prepare: spec => observe(() => channel.prepare(spec)), commit: () => observe(() => channel.commit()),
      poll: () => observe(() => channel.poll()), stop: () => observe(() => channel.stop()) }
  }
  private reportUnknown(record: CommandRecord, cause: unknown): void {
    if (record.unknownReported || record.operation === undefined) return
    record.unknownReported = true
    const service = record.service
    if (service !== undefined && !service.submittedConfirmed) {
      service.startFailure ??= { cause: this.failure() }; service.submitted.reject(service.startFailure.cause)
    }
    this.root.unknown(record.scope, record.operation, record.privateFailure === undefined ? cause : record.privateFailure.cause)
  }
  private failure(): ExecutionStateError {
    return new ExecutionStateError('cloud/execution-unavailable', 'Execution is unavailable; cleanup remains pending until confirmed.')
  }
}
