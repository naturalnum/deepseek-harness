/** One Session notification pump retries native wake after driver convergence without modifying inbox input. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PlatformError } from '../contracts.ts'
import { nativeQueueRevision } from '../native-turn-contracts.ts'

/** Deployment-owned retry budget; an exhausted revision remains pending for Coordinator reconciliation. */
export interface NativePendingWakeLimits {
  readonly retryDelayMs: number
  readonly maxAttempts: number
}

function cancellable<T>(work: Promise<T>, signal: AbortSignal, cancellation: Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(cancellation) }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) abort()
  })
}

interface RevisionWaiter {
  readonly after: number
  readonly resolve: (revision: number) => void
  readonly reject: (error: unknown) => void
}

/** Session lifetime is independent of operation generations; alive must become false before Agent disposal. */
export class NativePendingWake {
  private readonly cancellation = new PlatformError(409, 'native_wake_closed')
  private readonly abort = new AbortController()
  private readonly waiters = new Set<RevisionWaiter>()
  private revision = -1
  private acknowledged = -1
  private work: Promise<void> | undefined
  private lastFailure: unknown

  /**
   * @param agent Public native wake and idle observation; neither method is called by the hook itself.
   * @param alive Session owner's disposed guard, checked before and after each driver wait.
   * @param limits Validated retry budget and delay, explicitly provided by product configuration.
   */
  constructor(private readonly agent: Pick<Agent, 'whenIdle' | 'wakePending'>,
    private readonly alive: () => boolean, private readonly limits: NativePendingWakeLimits) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Native wake limits must be positive safe integers')
    }
  }

  /** @returns Latest notification revision; wake alone never acknowledges it. */
  get pendingRevision(): number { return this.revision }

  /** @returns Last driver/pump failure or exhausted retry budget; successful acknowledgement clears it. */
  get failure(): unknown { return this.abort.signal.aborted ? undefined : this.lastFailure }

  /** Retain a wire-derived queue revision and directly notify a waiting before-turn hook.
   * @param input Committed queue revision; repeats can restart an exhausted bounded pump.
   */
  notify(input: unknown): void {
    const revision = nativeQueueRevision.parse(input)
    if (this.abort.signal.aborted) return
    this.revision = Math.max(this.revision, revision)
    for (const waiter of this.waiters) if (this.revision > waiter.after) waiter.resolve(this.revision)
    this.kick()
  }

  /** Acknowledge only after successful generation installation for that revision.
   * @param input Installed committed queue revision; a future, unobserved revision is refused.
   */
  acknowledge(input: unknown): void {
    const revision = nativeQueueRevision.parse(input)
    if (revision > this.revision) throw new PlatformError(409, 'native_wake_unobserved_revision')
    this.acknowledged = Math.max(this.acknowledged, revision)
    this.lastFailure = undefined
  }

  /** Wait directly on notifications inside before-turn; never await whenSettled or Agent.whenIdle there.
   * @param after Last queue revision already inspected by this hook.
   * @param signal Exact current driver/preparation lifetime.
   * @returns Next observed revision; closing or caller cancellation rejects without reinserting input.
   */
  waitForChange(after: number, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    this.abort.signal.throwIfAborted()
    if (this.revision > after) return Promise.resolve(this.revision)
    const result = Promise.withResolvers<number>()
    const cleanup = () => { this.waiters.delete(waiter); signal.removeEventListener('abort', cancel) }
    const waiter: RevisionWaiter = { after,
      resolve: (revision) => { cleanup(); result.resolve(revision) },
      reject: (error) => { cleanup(); result.reject(error) } }
    const cancel = () => { waiter.reject(signal.reason) }
    this.waiters.add(waiter)
    signal.addEventListener('abort', cancel, { once: true })
    return result.promise
  }

  /** Observe this bounded pump from outside the Agent hook.
   * @returns Completion after wake/driver waits or cancellation; pending revision can remain unacknowledged.
   */
  async whenSettled(): Promise<void> { await this.work }

  private kick(): void {
    if (this.work || this.revision <= this.acknowledged || !this.alive()) return
    const work = Promise.resolve().then(() => this.pump()).catch((error: unknown) => {
      this.lastFailure = error
    })
    this.work = work
    void work.then(() => { this.work = undefined })
  }

  private async idle(): Promise<void> { await cancellable(this.agent.whenIdle(), this.abort.signal, this.cancellation) }

  private async pump(): Promise<void> {
    for (let attempt = 0; attempt < this.limits.maxAttempts; attempt++) {
      this.abort.signal.throwIfAborted()
      if (!this.alive() || this.revision <= this.acknowledged) return
      await this.idle()
      if (!this.alive() || this.revision <= this.acknowledged) return
      this.agent.wakePending()
      await this.idle()
      if (!this.alive() || this.revision <= this.acknowledged) return
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(this.cancellation) }
        const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', cancel); resolve() }, this.limits.retryDelayMs)
        this.abort.signal.addEventListener('abort', cancel, { once: true })
      })
    }
    this.lastFailure = new PlatformError(409, 'native_wake_retry_limit')
  }

  /** Stop notifications and only this pump's waits; does not dispose, cancel or restart the Agent.
   * @returns Completion after the owned pump settles, even when an unrelated Agent driver is still running.
   */
  async close(): Promise<void> {
    this.abort.abort(this.cancellation)
    for (const waiter of this.waiters) waiter.reject(this.abort.signal.reason)
    await this.work
  }
}
