/** Private Root AllocationBackend; server observations never grant mounts, replay create or replace actual joins. */
import { parentFacts } from './skill-wire.ts'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createDefaultAdapterFactory, type AdapterFactory, type CreateSandboxRequest, type SandboxInfo } from '@alibaba-group/opensandbox'
import type { AllocationBackend, CreatedSandbox, PreparedSandbox } from './allocation-owner.ts'
import type { AllocationCreateIntent } from './allocation-types.ts'
import { BoundedLifecycleConnection, type WireBudget } from './sdk-transport.ts'
import { PrivateSemanticAudit, type SemanticSpan } from './semantic-audit.ts'
import { SdkLifecycleFailure, type AgentHandshake, type AgentSelection, type OriginalResourceObservation,
  type OwnedSdkTransport, type SdkLifecycleConfig, type TrustedAgentLifecycle, type VerifiedExecutionMount } from './lifecycle-types.ts'

interface AllocationRecord {
  readonly intent: AllocationCreateIntent
  readonly mount: VerifiedExecutionMount
  readonly labels: Record<string, string>
  readonly actual: Promise<CreatedSandbox>
  readonly observations: Set<Promise<OriginalResourceObservation>>
  created?: CreatedSandbox
  preparation?: Promise<PreparedSandbox>
  prepared?: AgentHandshake
  phase: 'active' | 'stopping' | 'stopped' | 'stop-unknown'
  stopActual?: Promise<void>
}

type CloseResult = { readonly ok: true } | { readonly ok: false; readonly cause: unknown }

const labelHash = (value: string): string => `h${createHash('sha256').update(value).digest('base64url')}h`
const check = (ok: boolean, code: ConstructorParameters<typeof SdkLifecycleFailure>[0]): void => {
  if (!ok) throw new SdkLifecycleFailure(code)
}

/** Implements only Root's private lifecycle; it exports neither an execution client nor account-facing service. */
export class SdkAllocationBackend implements AllocationBackend<VerifiedExecutionMount> {
  private readonly audit = new PrivateSemanticAudit()
  private readonly config: SdkLifecycleConfig
  private readonly connection: BoundedLifecycleConnection
  private readonly sandboxes: ReturnType<AdapterFactory['createLifecycleStack']>['sandboxes']
  private readonly records = new Map<string, AllocationRecord>()
  private readonly retiredIntents = new WeakSet<AllocationCreateIntent>()
  private readonly handles = new WeakMap<CreatedSandbox, AllocationRecord>()
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly recipe: string
  private admission = true
  private closing: Promise<void> | undefined
  private closeResult: CloseResult | undefined
  private readonly closeObservers = new Set<(value: CloseResult) => void>()

  /** @param config Explicit Root-selected deployment and bounds. @param agent Original Root private client callbacks.
   * @param transport Dedicated owned transport; Root calls createOwnedSdkTransport with finite limits.
   */
  constructor(config: SdkLifecycleConfig, private readonly agent: TrustedAgentLifecycle, transport: OwnedSdkTransport) {
    const { cpuCores, entrypoint } = config
    for (const value of [config.memoryMiB, config.ttlSeconds, config.requestTimeoutMs, config.stopBudgetMs,
      config.readyPollIntervalMs, config.maxReadyPolls, config.pageSize, config.maxPages, config.maxItems,
      config.maxRecords, config.maxInflightOperations, config.maxRequestBytes, config.maxResponseBytes,
      config.maxOperationBytes, config.maxFieldBytes]) check(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'sdk/bounds')
    check(Number.isFinite(cpuCores) && cpuCores > 0 && entrypoint.length > 0 && config.pageSize <= 200
      && config.maxItems >= config.pageSize && config.maxOperationBytes >= config.maxResponseBytes
      && config.maxInflightOperations >= config.maxRecords && config.apiKey.length > 0
      && /(?:@sha256:|^sha256:)[a-f0-9]{64}$/.test(config.imageDigest) && /^[a-f0-9]{64}$/.test(config.payloadSha256), 'sdk/bounds')
    this.config = Object.freeze({ ...config, entrypoint: Object.freeze([...entrypoint]) })
    this.checkFields([config.lifecycleBaseUrl, config.apiKey, config.deploymentIdentity, config.environmentVersion,
      config.provider, config.imageDigest, ...entrypoint])
    this.recipe = labelHash(JSON.stringify([config.imageDigest, config.payloadSha256, entrypoint, config.platform,
      cpuCores, config.memoryMiB, config.ttlSeconds, 'bootstrap.execd.isolation=enable']))
    this.connection = new BoundedLifecycleConnection(this.config, transport)
    this.sandboxes = createDefaultAdapterFactory().createLifecycleStack({ connectionConfig: this.connection,
      lifecycleBaseUrl: this.config.lifecycleBaseUrl }).sandboxes
  }

  /** Single actual create; repeated calls with the original inputs observe the same sticky promise, including unknown.
   * @param intent Original durable Root intent already inserted before this call. @param mount Original reserved grant/exports.
   * @returns Only the original fully settled successful create handle; timeout/404/invalid replies remain unknown.
   */
  create(intent: AllocationCreateIntent, mount: VerifiedExecutionMount): Promise<CreatedSandbox> {
    this.assertAdmission()
    check(!this.retiredIntents.has(intent), 'sdk/closed')
    const existing = this.records.get(intent.allocationId)
    if (existing !== undefined) {
      check(existing.intent === intent && existing.mount === mount, 'sdk/selection')
      return existing.actual
    }
    check(this.records.size < this.config.maxRecords && this.inflight.size < this.config.maxInflightOperations, 'sdk/capacity')
    this.assertMount(intent, mount)
    const budget = this.budget(Date.parse(intent.createDeadlineAt))
    const labels = this.labels(intent), deferred = Promise.withResolvers<CreatedSandbox>()
    const record: AllocationRecord = { intent, mount, labels, actual: deferred.promise, observations: new Set(), phase: 'active' }
    this.records.set(intent.allocationId, record)
    void this.audit.watch(this.audit.begin('sdk-create', { intent }), record.actual,
      () => ({ intent, sandboxId: record.created?.sandboxId }))
    const actual = this.own(async () => {
      try {
        const request = this.request(record)
        const created = await this.connection.run(budget, 'POST', '/sandboxes', 202, () => this.sandboxes.createSandbox(request))
        this.checkFields([created.id])
        check(created.status.state === 'Running' && created.expiresAt instanceof Date && Number.isFinite(created.expiresAt.getTime())
          && this.matchesLabels(created.metadata, labels), 'sdk/create-unknown')
        const handle = Object.freeze({ sandboxId: created.id })
        record.created = handle; this.handles.set(handle, record)
        return handle
      } catch (cause) { throw new SdkLifecycleFailure('sdk/create-unknown', cause) }
    })
    void actual.then(deferred.resolve, deferred.reject)
    return record.actual
  }

  /** @param created Original returned handle. @param mount Same original mount wrapper.
   * @param deadlineAtMs Original Root deadline; no per-observer extension. @returns Original bounded readiness and authenticated handshake.
   */
  prepare(created: CreatedSandbox, mount: VerifiedExecutionMount, deadlineAtMs: number): Promise<PreparedSandbox> {
    this.assertAdmission()
    const record = this.record(created)
    check(record.mount === mount && record.phase === 'active', 'sdk/selection')
    if (record.preparation !== undefined) return record.preparation
    this.assertMount(record.intent, mount)
    const budget = this.budget(Math.min(deadlineAtMs, Date.parse(record.intent.createDeadlineAt)))
    let span: SemanticSpan | undefined
    const actual = this.own(async () => {
      span = this.audit.begin('sdk-prepare', { intent: record.intent, sandboxId: created.sandboxId })
      await record.actual
      let ready = false
      for (let poll = 0; poll < this.config.maxReadyPolls; poll++) {
        this.assertPreparing(record, budget)
        const info = await this.connection.run(budget, 'GET', this.path(created.sandboxId), 200, () => this.sandboxes.getSandbox(created.sandboxId))
        check(info.id === created.sandboxId, 'sdk/selection')
        this.checkInfo(info, record.intent)
        if (info.status.state === 'Running') { ready = true; break }
        check(['Creating', 'Pending', 'Resuming'].includes(info.status.state), 'sdk/ready-unconfirmed')
        await delay(Math.min(this.config.readyPollIntervalMs, Math.max(0, budget.deadlineAtMs - Date.now())))
      }
      check(ready, 'sdk/ready-unconfirmed'); this.assertPreparing(record, budget)
      const prepared = await this.agent.handshake(this.selection(record), this.control(budget.deadlineAtMs))
      this.assertPreparing(record, budget)
      this.checkFields([prepared.runtimeIdentity, prepared.protocolVersion])
      check(prepared.sandboxId === created.sandboxId && prepared.payloadSha256 === this.config.payloadSha256
        && prepared.imageDigest === this.config.imageDigest && prepared.deploymentIdentity === this.config.deploymentIdentity, 'sdk/selection')
      check(prepared.capabilities.length <= 5 && new Set(prepared.capabilities).size === prepared.capabilities.length
        && prepared.capabilities.every(value => ['argv-collect', 'pipes', 'control', 'inherit', 'terminal'].includes(value)), 'sdk/selection')
      record.prepared = Object.freeze({ sandboxId: prepared.sandboxId, runtimeIdentity: prepared.runtimeIdentity,
        protocolVersion: prepared.protocolVersion, capabilities: Object.freeze([...prepared.capabilities]),
        payloadSha256: prepared.payloadSha256, imageDigest: prepared.imageDigest, deploymentIdentity: prepared.deploymentIdentity })
      return record.prepared
    })
    return record.preparation = this.audit.watch(span, actual,
      () => ({ intent: record.intent, sandboxId: created.sandboxId, runtimeIdentity: record.prepared?.runtimeIdentity }))
  }

  /** @param created Original known-successful create handle.
   * @param prepared Original handshake when published; omission uses retained startup state.
   * @returns Synchronous fence, selected authenticated204/ack, then actual local/preparation/observation settlement.
   * Rejection retains responsibility, with no automatic DELETE replay or fabricated handshake.
   */
  stop(created: CreatedSandbox, prepared: PreparedSandbox | undefined): Promise<void> {
    const record = this.record(created)
    check(prepared === undefined || prepared === record.prepared, 'sdk/selection')
    return this.stopRecord(record)
  }

  /**
   * Reclaim one stopped record only at the coordinator's original allocation-released boundary.
   * @param prepared Exact SDK result retained by the original allocation owner.
   * @param retireRuntime Synchronous Root registry retirement; any refusal retains this SDK record.
   */
  retireStopped(prepared: PreparedSandbox, retireRuntime: (selection: AgentSelection) => void): void {
    const record = [...this.records.values()].find(value => value.prepared === prepared)
    if (record === undefined) throw new SdkLifecycleFailure('sdk/selection')
    check(record.phase === 'stopped' && record.stopActual !== undefined
      && record.observations.size === 0, 'sdk/selection')
    retireRuntime(this.selection(record))
    this.retiredIntents.add(record.intent)
    this.records.delete(record.intent.allocationId)
  }

  /** Scope-filtered bounded pages; no state filter, global-account search, adoption or repeated create.
   * @param intent Original Root recovery intent.
   * @param deadlineAtMs Finite observation deadline.
   * @returns Unknown even for an empty complete scan or unique match.
   */
  findOriginal(intent: AllocationCreateIntent, deadlineAtMs: number): Promise<OriginalResourceObservation> {
    this.assertAdmission()
    const budget = this.budget(deadlineAtMs), metadata = this.labels(intent)
    const record = this.records.get(intent.allocationId)
    check(record === undefined || ((record.phase === 'active' || record.phase === 'stop-unknown')
      && this.matchesLabels(metadata, record.labels)), 'sdk/closed')
    const actual = this.own<OriginalResourceObservation>(async () => {
      const candidates = new Map<string, Readonly<{ sandboxId: string; state: string }>>()
      for (let page = 1; page <= this.config.maxPages; page++) {
        const response = await this.connection.run(budget, 'GET', '/sandboxes', 200,
          () => this.sandboxes.listSandboxes({ metadata, page, pageSize: this.config.pageSize }))
        check(response.items.length <= this.config.pageSize, 'sdk/bounds')
        for (const info of response.items) {
          this.checkInfo(info, intent)
          check(!candidates.has(info.id) && candidates.size < this.config.maxItems, 'sdk/bounds')
          candidates.set(info.id, Object.freeze({ sandboxId: info.id, state: info.status.state }))
        }
        const pagination = response.pagination
        check(pagination !== undefined && pagination.page === page && pagination.pageSize === this.config.pageSize
          && typeof pagination.hasNextPage === 'boolean' && Number.isSafeInteger(pagination.totalItems)
          && pagination.totalItems >= candidates.size && pagination.totalItems <= this.config.maxItems
          && Number.isSafeInteger(pagination.totalPages) && pagination.totalPages >= 0 && pagination.totalPages <= this.config.maxPages, 'sdk/bounds')
        if (pagination?.hasNextPage === false) return Object.freeze({ kind: 'unknown', pages: page,
          candidates: Object.freeze([...candidates.values()]), scanComplete: true })
      }
      throw new SdkLifecycleFailure('sdk/bounds')
    })
    if (record !== undefined) {
      record.observations.add(actual)
      void actual.then(() => record.observations.delete(actual), () => record.observations.delete(actual))
    }
    return actual
  }

  /** Fence module admission, join retained real operations/stops, then actual dispatcher close.
   * @param deadlineAtMs Finite observer deadline.
   * @param signal Optional observer-only cancellation; omitted means deadline only.
   * @returns Success only after all actual settlement.
   * Timeout/cancellation rejects without dropping the retained close promise or reporting clean.
   */
  closeRoot(deadlineAtMs: number, signal?: AbortSignal): Promise<void> {
    void this.closeRootActual()
    return this.observeClose(deadlineAtMs, signal)
  }

  /**
   * Fence and join the original actual shutdown independently of any caller's observation deadline.
   * @returns The same real stops, local joins and dispatcher closure; actual failure remains sticky.
   */
  closeRootActual(): Promise<void> {
    this.admission = false
    if (this.closing === undefined) {
      this.audit.point('sdk-root-fence', { fenced: true })
      const deferred = Promise.withResolvers<void>()
      this.closing = deferred.promise
      void this.audit.watch(this.audit.begin('sdk-root-close', { fenced: true }), this.closing)
      void this.closing.then(() => { this.settleClose({ ok: true }) }, (cause: unknown) => { this.settleClose({ ok: false, cause }) })
      void this.finishClose().then(deferred.resolve, deferred.reject)
    }
    return this.closing
  }

  private async finishClose(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.records.values()].map(async (record) => {
      await record.actual
      await this.stopRecord(record)
    }))
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
    let closeFailure: unknown
    try { await this.connection.closeTransport() } catch (cause) { closeFailure = cause }
    const failed = outcomes.find(value => value.status === 'rejected')
    if (failed?.status === 'rejected' || closeFailure !== undefined) throw new SdkLifecycleFailure('sdk/close-unconfirmed', failed?.status === 'rejected' ? failed.reason : closeFailure)
  }

  private stopRecord(record: AllocationRecord): Promise<void> {
    if (record.stopActual !== undefined) return record.stopActual
    record.phase = 'stopping'
    const span = this.audit.begin('sdk-stop', { intent: record.intent, sandboxId: record.created?.sandboxId })
    return record.stopActual = this.audit.watch(span, this.own(async () => {
      try {
        await record.actual
        const budget = this.budget(Date.now() + this.config.stopBudgetMs)
        const selection = this.selection(record)
        const fenced = this.agent.fenceRequests(selection, record.prepared, this.control(budget.deadlineAtMs))
        // Observe immediately, but physical destruction must not await an unavailable local dispatcher release.
        const settled = Promise.allSettled([
          fenced.whenJoined, fenced.whenPrivilegedStartsJoined, record.preparation ?? Promise.resolve(),
        ] as const)
        let physicalFailure: { readonly cause: unknown } | undefined
        try {
          check(fenced.sandboxId === selection.sandboxId
            && fenced.deploymentIdentity === this.config.deploymentIdentity, 'sdk/stop-unknown')
          await fenced.whenPrivilegedStartsJoined
          fenced.assertDeploymentCurrent()
          const created = record.created
          if (created === undefined) throw new SdkLifecycleFailure('sdk/stop-unknown')
          await this.connection.run(budget, 'DELETE', this.path(created.sandboxId), 204, () => this.sandboxes.deleteSandbox(created.sandboxId))
          fenced.assertDeploymentCurrent()
          this.agent.acknowledgePhysicalStop(selection, record.prepared)
        } catch (cause) { physicalFailure = { cause } }
        const [joined] = await settled
        while (record.observations.size) await Promise.allSettled([...record.observations])
        if (physicalFailure !== undefined) throw physicalFailure.cause
        if (joined.status === 'rejected') throw joined.reason
        record.phase = 'stopped'
      } catch (cause) { record.phase = 'stop-unknown'; throw new SdkLifecycleFailure('sdk/stop-unknown', cause) }
    }, true), () => ({ intent: record.intent, sandboxId: record.created?.sandboxId,
      runtimeIdentity: record.prepared?.runtimeIdentity }))
  }

  private selection(record: AllocationRecord): AgentSelection {
    if (record.created === undefined) throw new SdkLifecycleFailure('sdk/selection')
    return Object.freeze({ intent: record.intent, sandboxId: record.created.sandboxId, mount: record.mount,
      payloadSha256: this.config.payloadSha256, imageDigest: this.config.imageDigest, deploymentIdentity: this.config.deploymentIdentity })
  }

  private request(record: AllocationRecord): CreateSandboxRequest {
    this.assertMount(record.intent, record.mount)
    const { grant, exports } = record.mount
    const request: CreateSandboxRequest = { image: { uri: this.config.imageDigest }, entrypoint: [...this.config.entrypoint],
      platform: { os: 'linux', arch: this.config.platform }, timeout: this.config.ttlSeconds, secureAccess: false,
      resourceLimits: { cpu: String(this.config.cpuCores), memory: `${this.config.memoryMiB}Mi` }, env: {},
      metadata: { ...record.labels }, extensions: { 'bootstrap.execd.isolation': 'enable' }, volumes: [
        { name: 'project', host: { path: exports.project }, mountPath: grant.project.rootPath, readOnly: false },
        { name: 'protected-project-pe', host: { path: exports.protectedProject }, mountPath: `${grant.project.rootPath}/.pe`, readOnly: true },
        ...(exports.skills === undefined ? [] : [{ name: 'project-skill-copies', host: { path: exports.skills }, mountPath: `${grant.project.rootPath}/.pe/skills`, readOnly: false }]),
        { name: 'session-environment', host: { path: exports.environment }, mountPath: grant.environment.targetPath, readOnly: false },
      ] }
    check(Buffer.byteLength(JSON.stringify(request)) <= this.config.maxRequestBytes, 'sdk/bounds')
    return request
  }

  private assertMount(intent: AllocationCreateIntent, mount: VerifiedExecutionMount): void {
    mount.assertCurrent()
    const { grant } = mount
    check(intent.accountId === grant.binding.accountId && intent.epoch === grant.binding.epoch
      && intent.sessionId === grant.sessionId && intent.workspaceId === grant.workspaceId
      && intent.projectMountVersion === grant.project.mountVersion && intent.environmentVersion === grant.environment.environmentVersion
      && intent.environmentVersion === this.config.environmentVersion && intent.provider === this.config.provider, 'sdk/selection')
    check((mount.skills === undefined) === (mount.exports.skills === undefined), 'sdk/selection')
    if (mount.skills !== undefined) {
      const parent = mount.skills.grant
      parentFacts(parent, mount.skills.maxCopies)
      check(parent.binding === grant.binding && parent.workspaceId === grant.workspaceId
        && parent.project.rootPath === grant.project.rootPath && parent.project.rootDevice === grant.project.rootDevice
        && parent.project.rootInode === grant.project.rootInode && parent.project.rootMountId === grant.project.rootMountId
        && mount.exports.skills === `${mount.exports.protectedProject}/skills`, 'sdk/selection')
    }
    if (mount.exports.skills !== undefined) this.checkFields([mount.exports.skills])
    this.checkFields([grant.project.rootPath, mount.exports.project, mount.exports.protectedProject, mount.exports.environment])
  }

  private labels(intent: AllocationCreateIntent): Record<string, string> {
    const scope = [intent.allocationId, intent.accountId, intent.epoch, intent.sessionId, intent.workspaceId,
      intent.environmentVersion, intent.provider, intent.projectMountVersion, intent.requestedAt, intent.createDeadlineAt]
    this.checkFields(scope)
    check(intent.environmentVersion === this.config.environmentVersion && intent.provider === this.config.provider, 'sdk/selection')
    return { 'pe-allocation': labelHash(intent.allocationId), 'pe-scope': labelHash(JSON.stringify(scope)), 'pe-recipe': this.recipe }
  }

  private checkInfo(info: SandboxInfo, intent: AllocationCreateIntent): void {
    this.checkFields([info.id, info.status.state])
    // This server displays a tag/short image id here; the fixed Root deployment selects the image digest.
    check(this.matchesLabels(info.metadata, this.labels(intent)) && info.allocation === undefined
      && info.snapshotId === undefined && info.expiresAt instanceof Date
      && Number.isFinite(info.expiresAt.getTime()) && JSON.stringify(info.entrypoint) === JSON.stringify(this.config.entrypoint), 'sdk/selection')
  }

  private matchesLabels(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
    return actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value)
  }

  private assertPreparing(record: AllocationRecord, budget: WireBudget): void {
    this.assertAdmission(); check(record.phase === 'active' && Date.now() < budget.deadlineAtMs, 'sdk/ready-unconfirmed')
    this.assertMount(record.intent, record.mount)
  }

  private record(created: CreatedSandbox): AllocationRecord {
    const record = this.handles.get(created)
    if (record === undefined || record.created !== created) throw new SdkLifecycleFailure('sdk/selection')
    return record
  }

  private assertAdmission(): void { check(this.admission, 'sdk/closed') }
  private budget(deadlineAtMs: number): WireBudget { check(Number.isSafeInteger(deadlineAtMs) && deadlineAtMs > Date.now(), 'sdk/bounds'); return { deadlineAtMs, bytes: 0 } }
  private control(deadlineAtMs: number): AbortSignal { const ms = deadlineAtMs - Date.now(); check(ms > 0 && ms <= 2147483647, 'sdk/bounds'); return AbortSignal.timeout(ms) }
  private path(id: string): string { return `/sandboxes/${encodeURIComponent(id)}` }
  private checkFields(values: readonly string[]): void { check(values.every(value => value.length > 0 && Buffer.byteLength(value) <= this.config.maxFieldBytes && !value.includes('\0')), 'sdk/bounds') }

  private own<T>(run: () => Promise<T>, teardown = false): Promise<T> {
    // One retained stop per bounded record has reserved admission beyond normal read/create capacity.
    if (!teardown) check(this.inflight.size < this.config.maxInflightOperations, 'sdk/capacity')
    const deferred = Promise.withResolvers<T>()
    this.inflight.add(deferred.promise)
    void run().then(deferred.resolve, deferred.reject)
    void deferred.promise.then(() => this.inflight.delete(deferred.promise), () => this.inflight.delete(deferred.promise))
    return deferred.promise
  }

  private settleClose(value: CloseResult): void {
    this.closeResult = value
    for (const observer of this.closeObservers) observer(value)
  }

  private observeClose(deadlineAtMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const ms = deadlineAtMs - Date.now()
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647 || signal?.aborted) { reject(new SdkLifecycleFailure('sdk/close-unconfirmed')); return }
      const result = this.closeResult
      if (result !== undefined) {
        if (result.ok) resolve()
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the original retained close failure.
        else reject(result.cause)
        return
      }
      if (this.closeObservers.size >= this.config.maxInflightOperations) { reject(new SdkLifecycleFailure('sdk/capacity')); return }
      const done = (): boolean => {
        if (!this.closeObservers.delete(observer)) return false
        clearTimeout(timer); signal?.removeEventListener('abort', aborted); return true
      }
      const aborted = (): void => { done(); reject(new SdkLifecycleFailure('sdk/close-unconfirmed', signal?.reason)) }
      const observer = (value: CloseResult): void => {
        if (!done()) return
        if (value.ok) resolve()
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the original retained close failure.
        else reject(value.cause)
      }
      const timer = setTimeout(aborted, ms)
      this.closeObservers.add(observer)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }
}
