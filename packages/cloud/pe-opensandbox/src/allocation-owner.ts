/** Root-only actual allocation work; durable metadata never authorizes a repeated provider create. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { AllocationCreateIntent, AllocationId, SandboxAllocation } from './allocation-types.ts'
import { AllocationQueryNotSubmittedError, type PostgresAllocationStore } from './allocation-store.ts'
import type { ExecutionCapability } from './types.ts'
import { ExecutionStateError } from './errors.ts'

/** The backend adapter returns only after the original provider create has actually settled. */
export interface CreatedSandbox {
  readonly sandboxId: string
}

/** Original authenticated handshake, bound by the adapter to this exact created sandbox. */
export interface PreparedSandbox extends CreatedSandbox {
  readonly runtimeIdentity: string
  readonly protocolVersion: string
  readonly capabilities: readonly ExecutionCapability[]
}

/** Root constructs this adapter from fixed deployment inputs; account graphs never receive it. */
export interface AllocationBackend<Mount> {
  create(intent: AllocationCreateIntent, mount: Mount): Promise<CreatedSandbox>
  prepare(created: CreatedSandbox, mount: Mount, deadlineAtMs: number): Promise<PreparedSandbox>
  /** Fence starts and join real managed work, provider destruction and all adapter I/O before fulfilling. */
  stop(created: CreatedSandbox, prepared: PreparedSandbox | undefined): Promise<void>
}

/** Existing files-owner grant reservation; release is not a compute stop or environment reset. */
export interface AllocationMount<Mount> {
  readonly value: Mount
  readonly projectMountVersion: string
  assertCurrent(): void
  release(): void
}

/** Original native selection and files callback, constructed by the Root-issued account port only. */
export interface NativeAllocationRequest<Mount> {
  readonly binding: AccountBinding
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  /** Account/Session/project authority independent of any one turn, consumer or cancelled waiter. */
  assertCurrent(): void
  prepareMount(): Promise<AllocationMount<Mount>>
}

interface AllocationWork<Mount> {
  readonly request: NativeAllocationRequest<Mount>
  readonly key: string
  readonly id: AllocationId
  readonly actual: Promise<PreparedSandbox>
  mount?: AllocationMount<Mount>
  intent?: AllocationCreateIntent
  row?: SandboxAllocation
  created?: CreatedSandbox
  prepared?: PreparedSandbox
  beginSubmitted: boolean
  intentInserted: boolean
  createSubmitted: boolean
  deadlineAtMs?: number
  backendStopped: boolean
  stopFailure?: unknown
  settlement?: { readonly ok: true; readonly value: PreparedSandbox } | { readonly ok: false; readonly cause: unknown }
  readonly waiters: Set<PreparationWaiter>
  stopping: boolean
  stop?: Promise<void> | undefined
  reconcile?: Promise<void> | undefined
  released: boolean
}

interface PreparationWaiter {
  settle(value: NonNullable<AllocationWork<never>['settlement']>): void
}

/** Explicit finite allocation capacities; queued command/process budgets belong to the execution owner. */
export interface AllocationOwnerConfig {
  readonly environmentVersion: string
  readonly provider: string
  readonly createBudgetMs: number
  readonly maxAllocations: number
  readonly maxAllocationsPerAccount: number
  readonly maxWaiters: number
  readonly maxWaitersPerAllocation: number
}

/**
 * Coalesce the entire create/handshake/persistence chain for one actual account Session/epoch.
 * Observer cancellation never settles the underlying chain or releases its reservation. Failed or
 * unknown work remains retained until actual backend stop and the original terminal SQL both settle.
 */
export class SessionAllocationOwner<Mount> {
  private readonly work = new Map<string, AllocationWork<Mount>>()
  private readonly admission = { open: true }
  private readonly waiting = { count: 0 }

  /**
   * @param store Original Root-borrowed bounded allocation store, already migrated.
   * @param backend Fixed verified lifecycle and process adapter.
   * @param config Required capacities and immutable image/environment recipe identity.
   */
  constructor(
    private readonly store: Pick<PostgresAllocationStore, 'begin' | 'transition' | 'failNotCreated' | 'releaseStopped' | 'reconcileCommitted'>,
    private readonly backend: AllocationBackend<Mount>,
    private readonly config: AllocationOwnerConfig,
  ) {
    for (const value of [config.createBudgetMs, config.maxAllocations, config.maxAllocationsPerAccount,
      config.maxWaiters, config.maxWaitersPerAllocation]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Allocation limits must be positive safe integers.')
    }
    if (config.maxAllocationsPerAccount > config.maxAllocations
      || config.maxWaitersPerAllocation > config.maxWaiters
      || !config.environmentVersion || !config.provider) throw new RangeError('Allocation recipe or capacity is invalid.')
  }

  /**
   * Prepare or reuse the same original live allocation without allowing a cancelled waiter to restart it.
   * @param request Stable account/Session/project selection; the calling port separately checks its consumer scope.
   * @param signal This waiter's cancellation only; actual create/late-resource ownership stays with Root.
   * @returns Authenticated ready runtime after the durable ready transition.
   */
  async prepare(request: NativeAllocationRequest<Mount>, signal?: AbortSignal): Promise<PreparedSandbox> {
    request.assertCurrent()
    request.binding.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    if (!this.admission.open) this.unavailable()
    const key = this.key(request)
    let work = this.work.get(key)
    if (work === undefined) {
      if (this.waiting.count >= this.config.maxWaiters) {
        throw new ExecutionStateError('cloud/capacity', 'Allocation preparation waiter capacity is exhausted.')
      }
      if (this.work.size >= this.config.maxAllocations
        || [...this.work.values()].filter(value => value.request.binding.accountId === request.binding.accountId).length
          >= this.config.maxAllocationsPerAccount) {
        throw new ExecutionStateError('cloud/capacity', 'Session allocation capacity is exhausted.')
      }
      const deferred = Promise.withResolvers<PreparedSandbox>()
      work = { request, key, id: brandString<AllocationId>(randomUUID()), actual: deferred.promise,
        beginSubmitted: false, intentInserted: false, createSubmitted: false, backendStopped: false, waiters: new Set(),
        stopping: false, released: false }
      this.work.set(key, work)
      // Root reserves and installs the work before any callback, SQL, SDK or filesystem side effect.
      void this.create(work).then(deferred.resolve, deferred.reject)
      const owned = work
      void work.actual.then((value) => { this.settle(owned, { ok: true, value }) },
        (cause: unknown) => { this.settle(owned, { ok: false, cause }) })
    } else if (work.request.binding !== request.binding || work.request.workspaceId !== request.workspaceId) {
      this.stale()
    }
    if (work.stopping || work.released) this.unavailable()
    const ready = await this.observe(work, signal)
    request.assertCurrent()
    request.binding.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    this.assertReusable(work)
    work.mount?.assertCurrent()
    return ready
  }

  /**
   * Close this Session's admission and retain the same actual stop, including late create completion.
   * @param request The original native selection; disposal does not require business-current admission.
   * @returns Actual adapter destruction and terminal metadata settlement, or retained uncertainty.
   */
  stop(request: NativeAllocationRequest<Mount>): Promise<void> {
    const work = this.work.get(this.key(request))
    if (work === undefined) return Promise.resolve()
    if (work.request.binding !== request.binding || work.request.workspaceId !== request.workspaceId) this.stale()
    return this.stopWork(work)
  }

  /**
   * Finish only metadata for a range whose original backend stop already fulfilled.
   * @param request Original native selection; user admission may already be revoked.
   * @returns Terminal SQL and reservation settlement after exact committed-postimage reconciliation.
   * Provider creation or deletion is never resubmitted by this method.
   */
  reconcileStoppedMetadata(request: NativeAllocationRequest<Mount>): Promise<void> {
    const work = this.work.get(this.key(request))
    if (work === undefined || work.request.binding !== request.binding
      || work.request.workspaceId !== request.workspaceId) this.stale()
    return work.reconcile ??= this.finishReconcile(work).finally(() => { work.reconcile = undefined })
  }

  /**
   * Reconcile a lost intent response only when this owner never called backend create.
   * @param request Original native selection, including a generation already being drained.
   * @returns A terminal no-create row after the exact captured creating postimage is confirmed.
   * Missing rows or a submitted provider create remain unresolved; no create is retried.
   */
  reconcileUnstartedMetadata(request: NativeAllocationRequest<Mount>): Promise<void> {
    const work = this.work.get(this.key(request))
    if (work === undefined || work.request.binding !== request.binding
      || work.request.workspaceId !== request.workspaceId) this.stale()
    if (work.createSubmitted) this.unavailable()
    work.stopping = true
    return work.reconcile ??= this.finishUnstartedReconcile(work).finally(() => { work.reconcile = undefined })
  }

  private async finishUnstartedReconcile(work: AllocationWork<Mount>): Promise<void> {
    await this.stopWork(work).catch(() => { /* Join the original actual work before inspecting its intent. */ })
    if (work.released) return
    if (work.createSubmitted || work.intent === undefined) this.unavailable()
    if (work.row === undefined) {
      const row = await this.store.reconcileCommitted(work.intent)
      if (row.state !== 'creating') this.unavailable()
      work.row = row
      work.intentInserted = true
    } else {
      if (!work.intentInserted) this.unavailable()
      if (!(work.stopFailure instanceof AllocationQueryNotSubmittedError)) {
        const row = await this.store.reconcileCommitted(work.row)
        if (row.state !== 'failed') this.unavailable()
        work.row = row
      }
    }
    work.stop = undefined
    work.stopFailure = undefined
    await this.stopWork(work)
  }

  private async finishReconcile(work: AllocationWork<Mount>): Promise<void> {
    await work.stop?.catch(() => { /* Reconciliation inspects only the settled original stop. */ })
    if (!work.backendStopped || work.row === undefined || work.stopFailure === undefined) this.unavailable()
    if (!(work.stopFailure instanceof AllocationQueryNotSubmittedError)) {
      work.row = await this.store.reconcileCommitted(work.row)
    }
    work.stop = undefined
    work.stopFailure = undefined
    await this.stopWork(work)
  }

  /**
   * Fence all new work, then join every retained original allocation before Root database withdrawal.
   * @returns All actual stops; rejection retains failed work and its capacity for reconciliation.
   */
  async close(): Promise<void> {
    this.admission.open = false
    const results = await Promise.allSettled([...this.work.values()].map(work => this.stopWork(work)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  /**
   * Snapshot retained allocation, stopping and waiter counts without reconciling resources.
   * @returns Counts only; no native identifiers, mounts, credentials or backend authority.
   */
  inspect(): Readonly<{ allocations: number; stopping: number; waiters: number }> {
    return Object.freeze({ allocations: this.work.size, stopping: [...this.work.values()].filter(work => work.stopping).length,
      waiters: this.waiting.count })
  }

  private async create(work: AllocationWork<Mount>): Promise<PreparedSandbox> {
    const mount = await work.request.prepareMount()
    work.mount = mount
    this.checkStart(work)
    mount.assertCurrent()
    const now = Date.now()
    work.deadlineAtMs = now + this.config.createBudgetMs
    const intent: AllocationCreateIntent = Object.freeze({ allocationId: work.id,
      accountId: work.request.binding.accountId, epoch: work.request.binding.epoch,
      sessionId: work.request.sessionId, workspaceId: work.request.workspaceId,
      environmentVersion: this.config.environmentVersion, provider: this.config.provider,
      projectMountVersion: mount.projectMountVersion,
      requestedAt: new Date(now).toISOString(), createDeadlineAt: new Date(work.deadlineAtMs).toISOString() })
    work.intent = intent
    work.beginSubmitted = true
    let begin: ReturnType<PostgresAllocationStore['begin']>
    try { begin = this.store.begin(intent) }
    catch (cause) { work.beginSubmitted = false; throw cause }
    let begun: Awaited<typeof begin>
    try { begun = await begin }
    catch (cause) {
      if (cause instanceof AllocationQueryNotSubmittedError) work.beginSubmitted = false
      throw cause
    }
    work.row = begun.allocation
    work.intentInserted = begun.inserted
    if (!begun.inserted) this.unavailable()
    this.checkStart(work)
    mount.assertCurrent()
    work.createSubmitted = true
    work.created = await this.backend.create(intent, mount.value)
    this.checkStart(work)
    mount.assertCurrent()
    const prepared = await this.backend.prepare(work.created, mount.value, work.deadlineAtMs)
    work.prepared = prepared
    if (prepared.sandboxId !== work.created.sandboxId) this.stale()
    this.checkStart(work)
    mount.assertCurrent()
    work.row = await this.store.transition(work.row, { to: 'ready', sandboxId: prepared.sandboxId,
      runtimeIdentity: prepared.runtimeIdentity, executionProtocolVersion: prepared.protocolVersion,
      executionCapabilities: prepared.capabilities })
    this.checkStart(work)
    mount.assertCurrent()
    return prepared
  }

  private stopWork(work: AllocationWork<Mount>): Promise<void> {
    work.stopping = true
    return work.stop ??= this.finishStop(work).catch((cause: unknown) => { work.stopFailure = cause; throw cause })
  }

  private async finishStop(work: AllocationWork<Mount>): Promise<void> {
    await work.actual.catch(() => { /* Stop still owns the original metadata and late physical resource. */ })
    const row = work.row
    if (work.created !== undefined) {
      if (!work.backendStopped) {
        await this.backend.stop(work.created, work.prepared)
        work.backendStopped = true
      }
      if (row === undefined) this.unavailable()
      if (row.state !== 'released') {
        const stopping = row.state === 'stopping' ? row
          : await this.store.transition(row, { to: 'stopping', sandboxId: work.created.sandboxId })
        work.row = stopping
        work.row = await this.store.releaseStopped(stopping)
      }
    } else if (row !== undefined) {
      // No created reply cannot distinguish a never-submitted create from an unknown provider outcome.
      // Only the pre-submission case can be established locally; all others remain retained.
      if (!work.intentInserted || work.createSubmitted || !['creating', 'failed'].includes(row.state)) this.unavailable()
      if (row.state === 'creating') work.row = await this.store.failNotCreated(row, 'cancelled-before-provider-create')
    } else if (work.beginSubmitted) {
      this.unavailable()
    }
    work.mount?.release()
    work.released = true
    if (this.work.get(work.key) === work) this.work.delete(work.key)
  }

  private checkStart(work: AllocationWork<Mount>): void {
    if (!this.admission.open || work.stopping) this.unavailable()
    if (work.deadlineAtMs !== undefined && Date.now() >= work.deadlineAtMs) {
      work.stopping = true
      throw new ExecutionStateError('cloud/account-unavailable', 'Session allocation preparation exceeded its infrastructure deadline; late work remains owned.')
    }
    work.request.assertCurrent()
    work.request.binding.lifetime.throwIfAborted()
  }

  private assertReusable(work: AllocationWork<Mount>): void {
    if (!this.admission.open || work.stopping || work.released) this.unavailable()
  }

  private key(request: NativeAllocationRequest<Mount>): string {
    return JSON.stringify([request.binding.accountId, request.binding.epoch, request.sessionId])
  }

  private observe(work: AllocationWork<Mount>, signal?: AbortSignal): Promise<PreparedSandbox> {
    signal?.throwIfAborted()
    if (work.settlement !== undefined) {
      if (work.settlement.ok) return Promise.resolve(work.settlement.value)
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the actual provider or native ownership failure.
      return Promise.reject(work.settlement.cause)
    }
    if (this.waiting.count >= this.config.maxWaiters || work.waiters.size >= this.config.maxWaitersPerAllocation) {
      throw new ExecutionStateError('cloud/capacity', 'Allocation preparation waiter capacity is exhausted.')
    }
    return new Promise<PreparedSandbox>((resolve, reject) => {
      const detach = (): boolean => {
        if (!work.waiters.delete(waiter)) return false
        this.waiting.count--
        signal?.removeEventListener('abort', aborted)
        return true
      }
      const aborted = (): void => {
        if (!detach()) return
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Native cancellation preserves the caller's original reason.
        reject(signal?.reason)
      }
      const waiter: PreparationWaiter = { settle(value) {
        if (!detach()) return
        if (value.ok) resolve(value.value)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the actual provider or native ownership failure.
        else reject(value.cause)
      } }
      work.waiters.add(waiter)
      this.waiting.count++
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  private settle(work: AllocationWork<Mount>, value: NonNullable<AllocationWork<Mount>['settlement']>): void {
    work.settlement = value
    for (const waiter of work.waiters) waiter.settle(value)
  }

  private unavailable(): never {
    throw new ExecutionStateError('cloud/account-unavailable', 'Session allocation work is closed or unresolved; the original resource remains retained.')
  }

  private stale(): never {
    throw new ExecutionStateError('cloud/stale-generation', 'Session allocation selection changed.')
  }
}
