/** Optional waiting adapter over the original command reservation and release owner. */
import { ExecutionStateError } from './errors.ts'

type State = 'waiting' | 'admitted' | 'cancelled' | 'expired' | 'refused' | 'uncertain'
type Failure = Readonly<{ state: 'refused' | 'uncertain'; cause: unknown }>
type Outcome<T> = Readonly<{ state: 'admitted'; command: T } | { state: 'cancelled' | 'expired' }> | Failure

/** The account and Session capability issued by the original owner for one live generation. */
export interface CommandWaitOwner {
  readonly accountId: string
  readonly sessionId: string
  readonly lifetime: AbortSignal
  assertCurrent(): void
}

/** The producer's registered job and its wait and retirement notifications. */
export interface CommandWaitJob {
  readonly id: string
  readonly owner: CommandWaitOwner
  readonly untilRetired: Promise<void>
  waiting(value: boolean): void
}

/**
 * Bind the queue ticket to the existing producer's identity, wait projection and cancellation.
 * @param queue Queue owned by the command coordinator.
 * @param job Existing job and its account and Session identity.
 * @param signal The producer's cancellation signal.
 * @param attempt Synchronous reservation of the original command slot.
 * @returns The command started by the original reservation after admission.
 */
export async function waitForOwnedCommand<T>(
  queue: CommandWaitQueue<T>, job: CommandWaitJob, signal: AbortSignal, attempt: Attempt<T>,
): Promise<T> {
  const submission = queue.submit(job.owner, job.id, attempt, signal)
  if (submission.kind === 'refused') {
    throw new ExecutionStateError(submission.reason === 'capacity' ? 'cloud/capacity' : 'cloud/stale-generation',
      'The original execution wait is unavailable.')
  }
  const ticket = submission.ticket
  void job.untilRetired.then(() => ticket.done.then(() => { ticket.retire() }))
  if (ticket.waiting()) job.waiting(true)
  try {
    const outcome = await ticket.done
    switch (outcome.state) {
      case 'admitted': return outcome.command
      case 'refused': case 'uncertain': throw outcome.cause
      case 'expired': throw new ExecutionStateError('cloud/capacity', 'The wait for an execution slot expired.')
      case 'cancelled':
        signal.throwIfAborted()
        job.owner.lifetime.throwIfAborted()
        throw new ExecutionStateError('cloud/stale-generation', 'The original execution wait was cancelled.')
    }
  } finally { job.waiting(false) }
}

/** Busy means a definite, waitable refusal before acquiring any resources or starting work. */
export type CommandAdmission<T> = Readonly<
  { kind: 'busy' } | {
    kind: 'reserved'
    /** Install and start the original command once. A throw may mean the work entered the original owner. */
    start(): T
    /** Release the exact unused reservation synchronously, before any start or external I/O. */
    releaseUnstarted(): void
  }
>

type Attempt<T> = () => CommandAdmission<T>

interface Ticket<T> {
  readonly done: Promise<Outcome<T>>
  waiting(): boolean
  /** The original registry retires a terminal key after its retry and observation window closes. */
  retire(): boolean
}

type Submit<T> = Readonly<
  { kind: 'tracked'; ticket: Ticket<T> } | { kind: 'refused'; reason: 'closed' | 'capacity' | 'scope-conflict' }
>

interface Entry<T> {
  readonly key: string
  readonly owner: CommandWaitOwner
  readonly signal: AbortSignal
  readonly deadlineAt: number
  readonly ticket: Ticket<T>
  readonly settle: (outcome: Outcome<T>) => void
  readonly cancel: () => void
  attempt: Attempt<T> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  state: State
  settled: boolean
}

/** Pending and retained record limits and the admission deadline in milliseconds. */
export interface CommandWaitLimits {
  readonly maxWaiting: number
  readonly maxWaitingPerAccount: number
  readonly maxRecords: number
  readonly timeoutMs: number
}

const keyPart = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Keep only pending work and bounded retry records. The original owner arbitrates physical admission. */
export class CommandWaitQueue<T> {
  private readonly records = new Map<string, Entry<T>>()
  private readonly waiting = new Map<string, Entry<T>>()
  private open = true
  private draining = false
  private drainAgain = false

  constructor(private readonly limits: CommandWaitLimits) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Command wait limits must be positive safe integers.')
    }
    if (limits.maxWaitingPerAccount > limits.maxWaiting || limits.maxWaiting > limits.maxRecords
      || limits.timeoutMs > 2_147_483_647) throw new RangeError('Command wait limits exceed global or timer bounds.')
  }

  /**
   * Enqueue validated work for an already issued job key. Duplicate requests join the first record.
   * @param owner Original account/Session capability, never request-supplied identity.
   * @param jobKey Stable, registry-issued job key.
   * @param attempt Original synchronous, all-or-nothing reservation. A throw here must precede all admission side effects.
   * @param signal Original job cancellation, independent of response or browser observation.
   * @returns Trackable ticket, or an immediate refusal with no queue entry.
   */
  submit(owner: CommandWaitOwner, jobKey: string, attempt: Attempt<T>, signal?: AbortSignal): Submit<T> {
    const key = this.key(owner, jobKey)
    const existing = this.records.get(key)
    if (existing !== undefined) {
      return existing.owner === owner ? { kind: 'tracked', ticket: existing.ticket } : { kind: 'refused', reason: 'scope-conflict' }
    }
    if (!this.open) return { kind: 'refused', reason: 'closed' }
    const pendingForAccount = [...this.waiting.values()].filter(entry => entry.owner.accountId === owner.accountId).length
    if (this.records.size >= this.limits.maxRecords || this.waiting.size >= this.limits.maxWaiting
      || pendingForAccount >= this.limits.maxWaitingPerAccount) return { kind: 'refused', reason: 'capacity' }
    const lifetime = signal === undefined ? owner.lifetime : AbortSignal.any([owner.lifetime, signal])
    const completion = Promise.withResolvers<Outcome<T>>()
    const ticket: Ticket<T> = Object.freeze({ done: completion.promise, waiting: () => entry.state === 'waiting', retire: () => {
      if (this.records.get(key) !== entry || !entry.settled) return false
      this.records.delete(key)
      return true
    } })
    const entry: Entry<T> = { key, owner, signal: lifetime, deadlineAt: performance.now() + this.limits.timeoutMs,
      settle: completion.resolve, cancel: () => { this.finish(entry, { state: 'cancelled' }) },
      ticket, state: 'waiting', settled: false, attempt, timer: undefined }
    this.records.set(key, entry)
    this.waiting.set(key, entry)
    entry.timer = setTimeout(() => this.finish(entry, { state: 'expired' }), this.limits.timeoutMs)
    lifetime.addEventListener('abort', entry.cancel, { once: true })
    if (lifetime.aborted) entry.cancel()
    else this.drain()
    return { kind: 'tracked', ticket }
  }

  /**
   * Read the state for the same still-authorized account, Session and generation.
   * @param owner Current account and Session capability.
   * @param jobKey Stable key issued by the job registry.
   * @returns The recorded state, or undefined for an unmatched key.
   */
  state(owner: CommandWaitOwner, jobKey: string): State | undefined {
    return this.find(owner, jobKey)?.state
  }

  /**
   * Cancel a waiting job. The original job owner handles cancellation after admission.
   * @param owner Current account and Session capability.
   * @param jobKey Stable key issued by the job registry.
   * @returns The resulting state, or undefined for an unmatched key.
   */
  cancel(owner: CommandWaitOwner, jobKey: string): State | undefined {
    const entry = this.find(owner, jobKey)
    entry?.cancel()
    return entry?.state
  }

  /** The original capacity owner calls this after confirmed release, never from an observer's completion. */
  capacityReleased(): void { this.drain() }

  /** Fence new admission and stop waiters. Original owners retain admitted and uncertain work. */
  close(): void {
    this.open = false
    for (const entry of this.waiting.values()) entry.cancel()
  }

  private key(owner: CommandWaitOwner, jobKey: string): string {
    owner.assertCurrent()
    owner.lifetime.throwIfAborted()
    if (![owner.accountId, owner.sessionId, jobKey].every(part => keyPart.test(part))) {
      throw new RangeError('Invalid account, Session or job key for command waiting.')
    }
    return JSON.stringify([owner.accountId, jobKey])
  }

  private find(owner: CommandWaitOwner, jobKey: string): Entry<T> | undefined {
    const entry = this.records.get(this.key(owner, jobKey))
    return entry?.owner === owner ? entry : undefined
  }

  private finish(entry: Entry<T>, outcome: Outcome<T>): void {
    if (entry.state !== 'waiting') return
    this.leaveWaiting(entry)
    this.resolve(entry, outcome)
  }

  private leaveWaiting(entry: Entry<T>): void {
    this.waiting.delete(entry.key)
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.attempt = undefined
    entry.signal.removeEventListener('abort', entry.cancel)
  }

  private resolve(entry: Entry<T>, outcome: Outcome<T>): void {
    entry.state = outcome.state
    entry.settled = true
    entry.settle(outcome)
  }

  private valid(entry: Entry<T>): boolean {
    if (entry.state !== 'waiting') return false
    if (entry.signal.aborted) entry.cancel()
    else if (performance.now() >= entry.deadlineAt) this.finish(entry, { state: 'expired' })
    else {
      try { entry.owner.assertCurrent() }
      catch (cause) { this.finish(entry, { state: 'refused', cause }) }
    }
    return entry.state === 'waiting'
  }

  private advance(entry: Entry<T>): void {
    const attempt = entry.attempt
    if (attempt === undefined || !this.valid(entry)) return
    let reservation: CommandAdmission<T>
    try { reservation = attempt() }
    catch (cause) { this.finish(entry, { state: 'refused', cause }); return }
    if (reservation.kind === 'busy') return
    if (!this.valid(entry)) { reservation.releaseUnstarted(); return }

    // Once handed off, cancellation belongs to the original job; it must never revoke this reservation.
    entry.state = 'admitted'
    this.leaveWaiting(entry)
    try { this.resolve(entry, { state: 'admitted', command: reservation.start() }) }
    catch (cause) { this.resolve(entry, { state: 'uncertain', cause }) }
  }

  private drain(): void {
    if (!this.open) return
    if (this.draining) { this.drainAgain = true; return }
    this.draining = true
    try {
      do {
        this.drainAgain = false
        for (const entry of [...this.waiting.values()]) this.advance(entry)
      } while (this.open && this.drainAgain)
    } finally { this.draining = false }
  }
}
