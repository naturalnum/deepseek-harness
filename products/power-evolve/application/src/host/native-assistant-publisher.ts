/** Bounded ordered Host publication under one captured execution grant. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { PlatformError, type Grant } from '../contracts.ts'
import { nativeAssistantBytes } from '../native-assistant-records.ts'

type Item = { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'assistant-stream'; readonly frame: AssistantStreamFrame }
type Call = (token: string, input: unknown) => Promise<unknown>
const receipt = z.object({ publisherId: z.uuid(), epoch: z.number().int().positive(),
  lastOrdinal: z.number().int().nonnegative(), eventCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative() }).strict()

/** Limits include the in-flight batch as well as records waiting behind it. */
export interface NativePublicationLimits {
  readonly maxQueueItems: number
  readonly maxQueueBytes: number
  readonly maxBatchItems: number
  readonly maxBatchBytes: number
  readonly maxItemBytes: number
}

/** One finite budget observation captured before the original publisher failure. */
export interface NativePublicationBudgetDiagnostic {
  readonly site: 'enqueue' | 'drain'
  readonly reason: 'item_bytes' | 'queue_items' | 'queue_bytes' | 'envelope_bytes'
  readonly kind: 'event' | 'start' | 'chunk' | 'end'
  readonly itemBytes: number
  readonly bufferedItems: number
  readonly bufferedBytes: number
  readonly queueLength: number
  readonly pumping: boolean
  readonly inputReservation: boolean
  readonly maxItemBytes: number
  readonly maxQueueItems: number
  readonly maxQueueBytes: number
  readonly maxBatchBytes: number
  readonly singleWireBytes?: number
}

/** Exact ordered prefix reserved for one canonical input transaction. */
export interface NativeInputPublicationPosition {
  readonly publisherId: string
  readonly epoch: number
  readonly firstOrdinal: number
  readonly revision: number
}

/** Quiescent presentation watermark required when advancing the original native turn. */
export interface NativePublicationSeal {
  readonly publisherId: string
  readonly lastOrdinal: number
  readonly eventCount: number
  readonly revision: number
}

/** One writer serializes native events and process-local frames without model-token buffering elsewhere. */
export class NativeAssistantPublisher {
  readonly publisherId = randomUUID()
  private readonly queue: Array<{ item: Item; bytes: number }> = []
  private readonly failures = new Set<(error: unknown, diagnostic?: NativePublicationBudgetDiagnostic) => void>()
  private bufferedItems = 0
  private bufferedBytes = 0
  private lastOrdinal = 0
  private eventCount: number
  private revision = 0
  private heartbeatPending = false
  private pumping: Promise<void> | undefined
  private hasFailed = false
  private failure: unknown
  private closed = false
  private closing: Promise<void> | undefined
  private inputReservation: { cut: number; done: Promise<void> } | undefined
  private progress: PromiseWithResolvers<void> | undefined
  private budgetDiagnostic: NativePublicationBudgetDiagnostic | undefined
  private failed(): boolean { return this.hasFailed }

  constructor(private readonly grant: Grant, initialEventCount: number,
    private readonly limits: NativePublicationLimits, private readonly call: Call) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Native publication limits must be positive safe integers')
    }
    if (!Number.isSafeInteger(initialEventCount) || initialEventCount < 0) throw new Error('Invalid publication event count')
    this.eventCount = initialEventCount
  }

  /** Check the exact operation object captured when this writer opened.
   * @param grant Candidate current operation, never a replacement selected by Session identity alone.
   * @returns Whether the writer belongs to that original operation and epoch.
   */
  owns(grant: Grant): boolean { return this.grant === grant }

  /** Stage detached canonical events in their original observation order.
   * @param events Original native records; the model durability barrier awaits their receipt.
   * @returns A barrier for all work currently published or staged by this writer.
   */
  append(events: readonly SessionEvent[]): Promise<void> {
    for (const event of events) this.enqueue({ type: 'event', event })
    return this.flush()
  }

  /** Stage one original Agent frame before later canonical events can overtake it.
   * @param frame Frame from the exact unpublished Agent's owned listener.
   */
  frame(frame: AssistantStreamFrame): void { this.enqueue({ type: 'assistant-stream', frame }) }

  /** Keep an idle presentation alive without delaying the scheduler's lease renewal. */
  heartbeat(): void {
    if (this.closed || this.closing) return
    this.assertOpen()
    this.heartbeatPending = true
    this.kick()
  }

  /** Own a failure notification until its Agent scope is disposed.
   * @param listener Cancellation of the original Agent; the first publication failure remains authoritative.
   * @returns A disposer removing only this registration.
   */
  onFailure(listener: (error: unknown, diagnostic?: NativePublicationBudgetDiagnostic) => void): () => void {
    this.failures.add(listener)
    if (this.failed()) listener(this.failure, this.budgetDiagnostic)
    return () => { this.failures.delete(listener) }
  }

  /** Reject a failed or closing writer before publishing an Agent or accepting more work. */
  assertOpen(): void {
    if (this.failed()) throw this.failure
    if (this.closed || this.closing) throw new PlatformError(409, 'native_publication_closed')
  }

  /** Await staged writes while retaining the exact first failure.
   * @returns Completion only after every staged item and requested heartbeat has a validated receipt.
   */
  async flush(): Promise<void> {
    if (this.failed()) throw this.failure
    this.kick()
    while (this.pumping || this.inputReservation) {
      await (this.pumping ?? this.inputReservation?.done)
      this.kick()
    }
    if (this.failed()) throw this.failure
  }

  /** Wait for bounded item and byte capacity, or all staged items at a stream tail.
   * Heartbeat-only work does not consume capacity. Cancellation stops this waiter;
   * the publisher still owns its original mutation and input reservation cleanup.
   * @param signal Original model consumer lifetime.
   * @param drainItems Whether every staged item must be acknowledged before returning.
   * @returns Capacity or item-tail completion under the unchanged publication limits.
   */
  async backpressure(signal?: AbortSignal, drainItems = false): Promise<void> {
    const itemHigh = Math.min(this.limits.maxBatchItems, this.limits.maxQueueItems)
    const byteHigh = this.limits.maxQueueBytes - Math.min(this.limits.maxItemBytes, this.limits.maxQueueBytes)
    for (;;) {
      this.assertOpen()
      signal?.throwIfAborted()
      const pressured = drainItems ? this.bufferedItems > 0
        : this.bufferedItems >= itemHigh || (this.bufferedItems > 0 && this.bufferedBytes >= byteHigh)
      if (!this.inputReservation && !pressured) return
      const progress = (this.progress ??= Promise.withResolvers<void>()).promise
      this.kick()
      if (signal === undefined) { await progress; continue }
      const cancelled = Promise.withResolvers<void>()
      const abort = (): void => { cancelled.resolve() }
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) cancelled.resolve()
        await Promise.race([progress, cancelled.promise])
      } finally { signal.removeEventListener('abort', abort) }
    }
  }

  /** Capture the acknowledged watermark after draining; the caller must protect its native turn boundary.
   * @returns Exact existing publisher counters; this neither closes admission nor grants execution.
   */
  async seal(): Promise<NativePublicationSeal> {
    await this.flush()
    this.assertOpen()
    return { publisherId: this.publisherId, lastOrdinal: this.lastOrdinal,
      eventCount: this.eventCount, revision: this.revision }
  }

  /** Retire a drained generation after its exact seal was consumed by a proved Platform turn transition.
   * @param seal Original acknowledged watermark retained across transition reconciliation.
   */
  retire(seal: NativePublicationSeal): void {
    this.assertOpen()
    if (seal.publisherId !== this.publisherId || seal.lastOrdinal !== this.lastOrdinal
      || seal.eventCount !== this.eventCount || seal.revision !== this.revision || this.pumping
      || this.inputReservation || this.queue.length > 0 || this.heartbeatPending) {
      throw new PlatformError(409, 'native_publication_retirement')
    }
    this.closed = true
    this.notifyProgress()
  }

  /** Drain the original grant before releasing writer ownership.
   * @returns Shared close completion; failure does not become successful disposal.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      try {
        if (this.inputReservation) await this.inputReservation.done
        this.kick()
        while (this.pumping) {
          try { await this.pumping }
          catch (error) { this.fail(error) }
        }
        if (this.failed()) throw this.failure
      } finally { this.closed = true; this.notifyProgress() }
    })()
    this.notifyProgress()
    return this.closing
  }

  /** Reserve the current publication prefix while canonical input and its ledger commit together.
   * An unstaged input refused by the Platform's archive or cancelled-attempt check releases its reservation
   * without changing publication counters. Staged claims and ambiguous failures still stop this publisher.
   * @param expectedEventCount Protected native prefix immediately before this input batch.
   * @param events Complete canonical batch, already staged only for an actual native claim.
   * @param staged Whether synchronous Session observers have staged this exact complete suffix.
   * @param commit Atomic Platform commit and local mirror cleanup; ambiguous failure stops this publisher.
   * @returns Caller result after an exact ordered receipt advances both event and presentation cursors.
   */
  async commitInput<T>(expectedEventCount: number, events: readonly SessionEvent[], staged: boolean,
    commit: (position: NativeInputPublicationPosition) =>
    Promise<{ receipt: unknown; value: T }>): Promise<T> {
    this.assertOpen()
    if (this.inputReservation) throw new PlatformError(409, 'native_publication_input_owned')
    try {
      if (staged) {
        const suffix = this.queue.slice(-events.length)
        if (events.length === 0 || suffix.length !== events.length
          || suffix.some((queued, index) => queued.item.type !== 'event'
            || !isDeepStrictEqual(queued.item.event, events[index]))) {
          throw new PlatformError(409, 'native_publication_input_suffix')
        }
        this.queue.splice(-events.length)
        this.bufferedItems -= suffix.length
        this.bufferedBytes -= suffix.reduce((sum, queued) => sum + queued.bytes, 0)
      }
    } catch (error) { this.fail(error); throw this.failure }
    const done = Promise.withResolvers<void>()
    const reservation = { cut: this.lastOrdinal + this.bufferedItems, done: done.promise }
    this.inputReservation = reservation
    try {
      this.kick()
      while (this.pumping) await this.pumping
      if (this.failed()) throw this.failure
      if (this.eventCount !== expectedEventCount) throw new PlatformError(409, 'native_publication_input_prefix')
      const result = await commit({ publisherId: this.publisherId, epoch: this.grant.epoch,
        firstOrdinal: this.lastOrdinal + 1, revision: this.revision })
      if (this.failed()) throw this.failure
      const next = receipt.parse(result.receipt)
      if (next.publisherId !== this.publisherId || next.epoch !== this.grant.epoch
        || next.lastOrdinal !== this.lastOrdinal + events.length || next.revision !== this.revision
        || next.eventCount !== expectedEventCount + events.length) {
        throw new PlatformError(502, 'native_publication_receipt')
      }
      this.lastOrdinal = next.lastOrdinal
      this.eventCount = next.eventCount
      return result.value
    } catch (error) {
      if (!staged && error instanceof PlatformError && error.status === 409
        && ['native_session_archived', 'native_input_attempt_conflict'].includes(error.code)) {
        this.assertOpen()
        throw error
      }
      this.fail(error)
      throw this.failure
    }
    finally {
      this.inputReservation = undefined
      done.resolve()
      this.notifyProgress()
      this.kick()
    }
  }

  private enqueue(source: Item): void {
    this.assertOpen()
    try {
      const item = structuredClone(source), bytes = nativeAssistantBytes(item)
      if (bytes > this.limits.maxItemBytes || this.bufferedItems + 1 > this.limits.maxQueueItems
        || this.bufferedBytes + bytes > this.limits.maxQueueBytes) {
        const reason = bytes > this.limits.maxItemBytes ? 'item_bytes'
          : this.bufferedItems + 1 > this.limits.maxQueueItems ? 'queue_items' : 'queue_bytes'
        this.captureBudget('enqueue', reason, item.type === 'event' ? 'event' : item.frame.type, bytes)
        throw new PlatformError(413, 'native_publication_budget')
      }
      // A single complete wire envelope must fit even when the next ordinal grows in width.
      const singleWireBytes = nativeAssistantBytes(this.batch([item], Number.MAX_SAFE_INTEGER))
      if (singleWireBytes > this.limits.maxBatchBytes) {
        this.captureBudget('enqueue', 'envelope_bytes', item.type === 'event' ? 'event' : item.frame.type, bytes, singleWireBytes)
        throw new PlatformError(413, 'native_publication_budget')
      }
      this.queue.push({ item, bytes })
      this.bufferedItems++
      this.bufferedBytes += bytes
      this.kick()
    } catch (error) { this.fail(error); throw error }
  }

  private batch(items: readonly Item[], firstOrdinal: number) {
    return { version: 1, epoch: this.grant.epoch, publisherId: this.publisherId,
      batchId: randomUUID(), firstOrdinal, items }
  }

  private kick(): void {
    if (this.pumping || this.failed() || (!this.queue.length && !this.heartbeatPending)) return
    if (this.inputReservation && this.lastOrdinal >= this.inputReservation.cut) return
    const work = Promise.resolve().then(() => this.drain()).catch((error: unknown) => { this.fail(error); throw error })
    this.pumping = work
    void work.then(() => { this.pumping = undefined; this.kick() }, () => { this.pumping = undefined })
  }

  private async drain(): Promise<void> {
    while (this.queue.length || this.heartbeatPending) {
      if (this.failed()) throw this.failure
      const remaining = this.inputReservation ? this.inputReservation.cut - this.lastOrdinal : this.limits.maxBatchItems
      if (remaining <= 0) return
      const batch = this.batch([], this.lastOrdinal + 1)
      const selected: Array<{ item: Item; bytes: number }> = []
      let oversized: Pick<NativePublicationBudgetDiagnostic, 'kind' | 'itemBytes' | 'singleWireBytes'> | undefined
      for (const next of this.queue.slice(0, Math.min(this.limits.maxBatchItems, remaining))) {
        const items = [...selected.map(value => value.item), next.item]
        const singleWireBytes = nativeAssistantBytes({ ...batch, items })
        if (singleWireBytes > this.limits.maxBatchBytes) {
          oversized = { kind: next.item.type === 'event' ? 'event' : next.item.frame.type,
            itemBytes: next.bytes, singleWireBytes }
          break
        }
        selected.push(next)
      }
      if (this.queue.length && !selected.length) {
        if (oversized) this.captureBudget('drain', 'envelope_bytes', oversized.kind, oversized.itemBytes, oversized.singleWireBytes)
        throw new PlatformError(413, 'native_publication_budget')
      }
      this.queue.splice(0, selected.length)
      const input = { ...batch, items: selected.map(value => value.item) }
      this.heartbeatPending = false
      const next = receipt.parse(await this.call(this.grant.token, input))
      if (this.failed()) throw this.failure
      const ordinal = this.lastOrdinal + selected.length
      let eventCount = this.eventCount, revision = this.revision
      for (const { item } of selected) {
        if (item.type === 'event') eventCount = Math.max(eventCount, item.event.seq + 1)
        else revision = item.frame.revision
      }
      if (!Number.isSafeInteger(ordinal) || next.publisherId !== this.publisherId || next.epoch !== this.grant.epoch
        || next.lastOrdinal !== ordinal || next.eventCount !== eventCount || next.revision !== revision) {
        throw new PlatformError(502, 'native_publication_receipt')
      }
      this.lastOrdinal = ordinal
      this.eventCount = eventCount
      this.revision = revision
      this.bufferedItems -= selected.length
      this.bufferedBytes -= selected.reduce((sum, value) => sum + value.bytes, 0)
      this.notifyProgress()
    }
  }

  /** Wake current capacity waiters after the existing owner changes their predicate. */
  private notifyProgress(): void {
    const progress = this.progress
    this.progress = undefined
    progress?.resolve()
  }

  /** Retain only already measured numbers and fixed labels from the original failing guard. */
  private captureBudget(site: NativePublicationBudgetDiagnostic['site'], reason: NativePublicationBudgetDiagnostic['reason'],
    kind: NativePublicationBudgetDiagnostic['kind'], itemBytes: number, singleWireBytes?: number): void {
    this.budgetDiagnostic ??= { site, reason, kind, itemBytes, bufferedItems: this.bufferedItems,
      bufferedBytes: this.bufferedBytes, queueLength: this.queue.length, pumping: this.pumping !== undefined,
      inputReservation: this.inputReservation !== undefined, maxItemBytes: this.limits.maxItemBytes,
      maxQueueItems: this.limits.maxQueueItems, maxQueueBytes: this.limits.maxQueueBytes, maxBatchBytes: this.limits.maxBatchBytes,
      ...singleWireBytes === undefined ? {} : { singleWireBytes } }
  }

  private fail(error: unknown): void {
    if (this.failed()) return
    this.hasFailed = true
    this.failure = error
    this.queue.length = 0
    this.heartbeatPending = false
    this.notifyProgress()
    for (const listener of this.failures) {
      try { listener(error, this.budgetDiagnostic) }
      catch (_cancellationFailure) { /* Flush and close report the original publication failure. */ }
    }
  }
}
