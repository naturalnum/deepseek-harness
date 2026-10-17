/** F06 bounded submissions and actual-work ownership, instantiated and owned by runtime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { AccountBinding, AccountId, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from './errors.ts'
import { ConfigSaveLimitsSchema } from './schema.ts'
import type {
  ConfigSaveAdmission, ConfigSaveBarrier, ConfigSaveFailure, ConfigSaveKind, ConfigSaveLimits,
  ConfigSaveReceipt, ConfigSaveSnapshot,
} from './save-hooks.ts'

/** A native adapter uses this when its operation settles without a known actual outcome. */
export class ConfigSaveOutcomeUnknown extends Error {
  override readonly name: string = 'ConfigSaveOutcomeUnknown'
  constructor() { super('The native configuration save outcome is unknown.') }
}

interface Operation {
  readonly operationId: OperationId
  readonly kind: ConfigSaveKind
  readonly owner: AccountSaves
  state: 'queued' | 'running' | 'settled'
  readonly start: () => void
}

interface Execution {
  readonly operation: Operation
  active: boolean
  readonly children: Set<Promise<void>>
  failure: { readonly error: unknown } | undefined
  unknown: boolean
}

interface Waiter {
  readonly finish: (reason: 'deadline' | 'observer-cancelled' | undefined) => void
}

interface AccountControl {
  readonly limits: ConfigSaveLimits
  submit<T>(owner: AccountSaves, kind: ConfigSaveKind, submit: () => Promise<T>): Promise<T>
  assertOutsideSave(): void
}

function failure(error: unknown): ConfigSaveFailure['outcome'] {
  return error instanceof ConfigSaveOutcomeUnknown ? 'unknown' : 'failed'
}

function rememberFailure(execution: Execution, error: unknown): void {
  execution.failure ??= { error }
  execution.unknown ||= failure(error) === 'unknown'
}

function deadline(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CloudApiError('cloud/invalid-config', 'Configuration save observation requires a finite absolute deadline.')
  }
}

/**
 * One shared capacity owner borrowed by all account barriers. Runtime creates,
 * retains, and closes this object; it is not another Loader service or participant.
 */
export class ConfigSaveCoordinator {
  /** Validated, immutable deployment limits shared by all account barriers. */
  readonly limits: ConfigSaveLimits
  private readonly accounts: Map<AccountId, AccountSaves> = new Map()
  private readonly queue: Operation[] = []
  private readonly execution: AsyncLocalStorage<Execution> = new AsyncLocalStorage()
  private running: number = 0
  private tracked: number = 0
  private closed: boolean = false

  /**
   * @param input - explicit deployment limits; no capacity default is inferred.
   */
  constructor(input: ConfigSaveLimits) {
    this.limits = Object.freeze(ConfigSaveLimitsSchema({ ...input }))
  }

  /**
   * Create the sole save barrier for a live account generation within deployment limits.
   * @param binding - the runtime factory's immutable graph binding.
   * @returns the sole save barrier for this account graph.
   */
  createAccount(binding: AccountBinding): ConfigSaveBarrier {
    if (this.closed || binding.lifetime.aborted) this.unavailable()
    if (this.accounts.has(binding.accountId)) {
      throw new CloudApiError('cloud/config-busy', 'The account already owns a configuration save barrier.')
    }
    if (this.accounts.size >= this.limits.maxAccounts) this.capacity()
    const control: AccountControl = {
      limits: this.limits,
      submit: (owner, kind, submit) => this.submit(owner, kind, submit),
      assertOutsideSave: () => { this.assertOutsideSave() },
    }
    const account = new AccountSaves(control, binding)
    this.accounts.set(binding.accountId, account)
    return account
  }

  /**
   * Remove only a terminal, confirmed barrier after runtime finishes its other drain checks.
   * @param barrier - exact object issued by createAccount, not a copied receipt.
   */
  releaseAccount(barrier: ConfigSaveBarrier): void {
    const account = this.accounts.get(barrier.binding.accountId)
    if (account !== barrier) this.unavailable()
    account.assertReleasable()
    this.accounts.delete(account.binding.accountId)
  }

  /** Close only after runtime has released every actual account barrier. */
  close(): void {
    if (this.accounts.size !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save barriers still own actual work or evidence.')
    }
    this.closed = true
    this.execution.disable()
  }

  /**
   * Read current shared save capacity without exposing native configuration values.
   * @returns bounded root capacity observations, without native values.
   */
  snapshot(): { readonly accounts: number; readonly running: number; readonly queued: number; readonly tracked: number } {
    return Object.freeze({ accounts: this.accounts.size, running: this.running, queued: this.queue.length, tracked: this.tracked })
  }

  private current(): Execution | undefined { return this.execution.getStore() }

  private submit<T>(owner: AccountSaves, kind: ConfigSaveKind, submit: () => Promise<T>): Promise<T> {
    const parent = this.current()
    if (parent !== undefined) return this.join(parent, owner, submit)
    owner.assertAdmitted()
    if (this.closed || this.accounts.get(owner.binding.accountId) !== owner) this.unavailable()
    const queued = owner.running || this.running >= this.limits.maxRunning
    if (this.tracked >= this.limits.maxTrackedOperations
      || owner.tracked >= this.limits.maxTrackedOperationsPerAccount
      || (queued && (this.queue.length >= this.limits.maxQueued
        || owner.queued >= this.limits.maxQueuedPerAccount))) this.capacity()

    const result = Promise.withResolvers<T>()
    // The bounded failure table owns observation even if a request drops its Promise.
    void result.promise.catch((_error: unknown) => {})
    const operation: Operation = {
      operationId: brandString<OperationId>(randomUUID()), kind, owner, state: 'queued',
      start: () => {
        const execution: Execution = { operation, active: true, children: new Set(), failure: undefined, unknown: false }
        void this.execute(execution, submit).then(
          (value) => { this.settle(operation); result.resolve(value) },
          (error: unknown) => {
            this.settle(operation, { outcome: execution.unknown ? 'unknown' : 'failed' })
            result.reject(error)
          },
        )
      },
    }
    // Capacity and responsibility are committed before either queue can see submit.
    this.tracked++
    owner.enroll(operation)
    if (queued) this.queue.push(operation)
    else this.start(operation)
    return result.promise
  }

  private assertOutsideSave(): void {
    if (this.current() !== undefined) {
      throw new CloudApiError('cloud/config-busy', 'A configuration save cannot wait for its own submission turn.')
    }
  }

  private join<T>(parent: Execution, owner: AccountSaves, submit: () => Promise<T>): Promise<T> {
    if (!parent.active || parent.operation.owner !== owner || owner.binding.lifetime.aborted) {
      throw new CloudApiError('cloud/stale-generation', 'The native configuration continuation is no longer admitted.')
    }
    if (parent.children.size >= this.limits.maxNestedPerOperation) {
      const error = new CloudApiError('cloud/capacity', 'Configuration save continuation capacity is exhausted.')
      rememberFailure(parent, error)
      throw error
    }
    const deferred = Promise.withResolvers<T>()
    const observed: Promise<void> = deferred.promise.then(
      () => { parent.children.delete(observed) },
      (error: unknown) => {
        rememberFailure(parent, error)
        parent.children.delete(observed)
      },
    )
    parent.children.add(observed)
    try { deferred.resolve(submit()) } catch (error) { deferred.reject(error) }
    return deferred.promise
  }

  private async execute<T>(execution: Execution, submit: () => Promise<T>): Promise<T> {
    let result: { readonly value: T } | undefined
    try {
      if (execution.operation.owner.binding.lifetime.aborted) {
        throw new CloudApiError('cloud/stale-generation', 'The queued configuration generation has ended.')
      }
      const value = await this.execution.run(execution, submit)
      result = { value }
    } catch (error) {
      rememberFailure(execution, error)
    }
    while (execution.children.size !== 0) await Promise.all([...execution.children])
    execution.active = false
    if (execution.failure !== undefined) throw execution.failure.error
    if (result === undefined) throw new Error('Configuration save completed without a result.')
    return result.value
  }

  private start(operation: Operation): void {
    operation.state = 'running'
    operation.owner.start()
    this.running++
    operation.start()
  }

  private settle(operation: Operation, failed?: { readonly outcome: ConfigSaveFailure['outcome'] }): void {
    operation.state = 'settled'
    this.running--
    operation.owner.settle(operation, failed)
    if (failed === undefined) this.tracked--
    this.pump()
  }

  private pump(): void {
    while (this.running < this.limits.maxRunning) {
      const index = this.queue.findIndex(operation => !operation.owner.running)
      if (index === -1) return
      const operation = this.queue.splice(index, 1)[0]
      if (operation === undefined) throw new Error('Configuration save queue lost an admitted operation.')
      this.start(operation)
    }
  }

  private capacity(): never {
    throw new CloudApiError('cloud/capacity', 'Configuration save capacity is exhausted.')
  }

  private unavailable(): never {
    throw new CloudApiError('cloud/account-unavailable', 'Configuration save ownership is unavailable.')
  }
}

class AccountSaves implements ConfigSaveBarrier {
  private admission: ConfigSaveAdmission = 'open'
  private readonly pending: Map<OperationId, Operation> = new Map()
  private readonly failures: Map<OperationId, ConfigSaveFailure> = new Map()
  private readonly waiters: Set<Waiter> = new Set()
  running: boolean = false

  constructor(private readonly owner: AccountControl, readonly binding: AccountBinding) {}

  get tracked(): number { return this.pending.size + this.failures.size }
  get queued(): number { return [...this.pending.values()].filter(operation => operation.state === 'queued').length }

  admit<T>(kind: ConfigSaveKind, submit: () => Promise<T>): Promise<T> {
    return this.owner.submit(this, kind, submit)
  }

  admitWithApply<T>(kind: ConfigSaveKind, persist: () => Promise<T>, apply: (value: T) => Promise<void>): Promise<T> {
    return this.admit(kind, async () => {
      const value = await persist()
      await apply(value)
      return value
    })
  }

  snapshot(): ConfigSaveSnapshot {
    return Object.freeze({
      accountId: this.binding.accountId, epoch: this.binding.epoch, admission: this.admission,
      pending: Object.freeze([...this.pending.values()].map(operation =>
        Object.freeze({ operationId: operation.operationId, kind: operation.kind }))),
      failures: Object.freeze([...this.failures.values()]),
    })
  }

  pauseAccountChanges(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    this.owner.assertOutsideSave()
    deadline(deadlineAtMs)
    if (this.admission === 'open') this.admission = 'paused'
    return this.wait(deadlineAtMs, signal)
  }

  resumeAccountChanges(): void {
    this.owner.assertOutsideSave()
    if (this.admission !== 'paused' || this.pending.size !== 0 || this.failures.size !== 0 || this.binding.lifetime.aborted) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save admission cannot reopen in this graph.')
    }
    this.admission = 'open'
  }

  stopConfigSaves(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    this.owner.assertOutsideSave()
    deadline(deadlineAtMs)
    this.admission = 'stopped'
    return this.wait(deadlineAtMs, signal)
  }

  assertAdmitted(): void {
    if (this.binding.lifetime.aborted) {
      throw new CloudApiError('cloud/stale-generation', 'The account configuration generation has ended.')
    }
    if (this.admission !== 'open') {
      throw new CloudApiError('cloud/config-busy', 'Configuration save submission is paused or stopped.')
    }
  }

  assertReleasable(): void {
    if (this.admission !== 'stopped' || this.tracked !== 0 || this.waiters.size !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save responsibility has not been confirmed.')
    }
  }

  enroll(operation: Operation): void { this.pending.set(operation.operationId, operation) }
  start(): void { this.running = true }

  settle(operation: Operation, failed?: { readonly outcome: ConfigSaveFailure['outcome'] }): void {
    this.running = false
    this.pending.delete(operation.operationId)
    if (failed !== undefined) {
      const outcome = failed.outcome
      this.failures.set(operation.operationId, Object.freeze({
        operationId: operation.operationId, kind: operation.kind, outcome,
        code: outcome === 'unknown' ? 'config-save/outcome-unknown' : 'config-save/operation-failed',
      }))
    }
    if (this.pending.size === 0) for (const waiter of [...this.waiters]) waiter.finish(undefined)
  }

  private wait(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    if (this.pending.size === 0) return Promise.resolve(this.receipt())
    if (signal?.aborted === true) return Promise.resolve(this.receipt('observer-cancelled'))
    if (deadlineAtMs <= Date.now()) return Promise.resolve(this.receipt('deadline'))
    if (this.waiters.size >= this.owner.limits.maxWaitersPerAccount) {
      throw new CloudApiError('cloud/capacity', 'Configuration save observation capacity is exhausted.')
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const cancelled = (): void => { waiter.finish('observer-cancelled') }
      const waiter: Waiter = {
        finish: (reason) => {
          if (finished) return
          finished = true
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', cancelled)
          this.waiters.delete(waiter)
          resolve(this.receipt(reason))
        },
      }
      const arm = (): void => {
        const remaining = deadlineAtMs - Date.now()
        if (remaining <= 0) waiter.finish('deadline')
        else timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS))
      }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', cancelled, { once: true })
      arm()
    })
  }

  private receipt(reason?: 'deadline' | 'observer-cancelled'): ConfigSaveReceipt {
    if (this.admission === 'open') throw new Error('Configuration save receipt requires closed admission.')
    const common = {
      accountId: this.binding.accountId, epoch: this.binding.epoch, admission: this.admission,
      evidenceRefs: Object.freeze([...this.pending.keys(), ...this.failures.keys()].map(id => 'config-save/' + id)),
    }
    if (this.pending.size === 0 && this.failures.size === 0) {
      return Object.freeze({
        ...common, status: 'confirmed',
        pendingOperationIds: Object.freeze([] as const), failures: Object.freeze([] as const),
      })
    }
    return Object.freeze({
      ...common, status: 'unknown', pendingOperationIds: Object.freeze([...this.pending.keys()]),
      failures: Object.freeze([...this.failures.values()]),
      reason: reason ?? (this.failures.size !== 0 ? 'failed' : 'pending'),
    })
  }
}
