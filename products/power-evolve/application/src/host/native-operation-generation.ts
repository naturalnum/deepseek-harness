/** Session-owned write publication and operation lifetimes; Coordinator and Platform admission remain external. */
import { isDeepStrictEqual } from 'node:util'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PlatformError, type Grant } from '../contracts.ts'
import { nativeTurnFrame, nativeTurnResponse, nativeTurnTransition,
  type NativeTurnFrame, type NativeTurnReceipt, type NativeTurnResponse, type NativeTurnTransition } from '../native-turn-contracts.ts'
import type { NativeWriterIdentity } from '../native-writer-contracts.ts'
import { NativeAssistantPublisher, type NativePublicationLimits } from './native-assistant-publisher.ts'
import type { HostNativeWriterClient } from './native-writer-client.ts'

/** Validated publication coordinates required by the atomic transition, including the durable native prefix. */
export type NativePublicationSeal = Extract<NativeTurnTransition, { kind: 'advance' }>['seal'] & { readonly eventCount: number }

/** A real publisher retains its last transport reply; successful close also verifies that reply's exact counters. */
export class NativeOperationPublication {
  readonly publisher: NativeAssistantPublisher
  private last: NativePublicationSeal | undefined
  private sealing: Promise<NativePublicationSeal> | undefined

  /**
   * @param grant Exact operation object owning this publication.
   * @param eventCount Committed prefix at installation.
   * @param limits Validated deployment publication limits.
   * @param call Bounded transport returning the parsed publication receipt; no token is retained in the seal.
   */
  constructor(grant: Grant, eventCount: number, limits: NativePublicationLimits,
    call: (token: string, input: unknown) => Promise<NativePublicationSeal & { readonly epoch: number }>) {
    this.publisher = new NativeAssistantPublisher(grant, eventCount, limits, async (token, input) => {
      const reply = await call(token, input)
      this.last = { publisherId: reply.publisherId, lastOrdinal: reply.lastOrdinal,
        eventCount: reply.eventCount, revision: reply.revision }
      return reply
    })
  }

  /** Close locally and obtain a verified seal; an empty generation first establishes its authenticated PG presentation.
   * @returns One shared drain result; no native-assistant release or writer release is sent.
   */
  seal(): Promise<NativePublicationSeal> {
    return this.sealing ??= (async () => {
      this.publisher.heartbeat()
      await this.publisher.close()
      if (this.last === undefined) throw new PlatformError(502, 'native_publication_missing_receipt')
      return { ...this.last }
    })()
  }
}

/** Operation resources must exclude Agent.whenIdle, AgentHandle.dispose and Agent-scope disposal. */
export interface NativeGenerationResources {
  readonly publication: NativeOperationPublication
  readonly flushPersistence: () => Promise<void>
}

function identity(frame: NativeTurnFrame) {
  const { operationId, operationEpoch, writerEpoch, requestId, messageId, inputRevision } = frame
  return { operationId, operationEpoch, writerEpoch, requestId, messageId, inputRevision }
}

/** One immutable grant identity with mutable, authoritative native consumption state and owned effects. */
export class NativeOperationGeneration {
  readonly signal: AbortSignal
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly disposers: Array<() => void | Promise<void>> = []
  private state: NativeTurnFrame
  private sealed = false
  private sealing: Promise<NativePublicationSeal> | undefined

  /**
   * @param grant Exact current operation object; callers must not mutate it.
   * @param frame Authoritative native preparation or consumption state.
   * @param resources Operation publication and Session persistence barrier.
   * @param owns Exact object comparison against the Session's current generation.
   */
  constructor(readonly grant: Grant, frame: NativeTurnFrame, readonly resources: NativeGenerationResources,
    private readonly owns: () => boolean) {
    this.state = structuredClone(frame)
    this.signal = this.abort.signal
    if (frame.operationId !== grant.operationId || frame.operationEpoch !== grant.epoch
      || frame.requestId !== grant.requestId || !resources.publication.publisher.owns(grant)) {
      throw new PlatformError(409, 'native_generation_identity')
    }
  }

  /** @returns The latest native state; its message identity is never reconstructed or reinserted. */
  get frame(): NativeTurnFrame { return structuredClone(this.state) }

  /** Refuse a stale, sealed, unclaimed or already-ended operation before model or external effects. */
  assertExecution(): void {
    this.assertCurrent()
    if (this.sealed || this.state.phase !== 'claimed' || this.state.claim.turnEndSeq !== null) {
      throw new PlatformError(409, 'native_generation_not_executable')
    }
    this.signal.throwIfAborted()
  }

  /** Capture before awaiting; callers must check again before each additional external effect.
   * @param job One admitted operation callback, using only this generation's signal and grant.
   * @returns Its result only while this exact generation remains executable; sealing awaits its completion.
   */
  async execute<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertExecution()
    return this.track(job, () => { this.assertExecution() })
  }

  /** Keep a model stream admitted until iteration and upstream cleanup complete; consumers must close abandoned iterators.
   * @param source External stream using only this captured generation's signal and grant.
   * @returns Original values with an execution check before each yield; sealing drains the entire iterator lifetime.
   */
  async *stream<T>(source: (signal: AbortSignal) => AsyncIterable<T>): AsyncGenerator<T, void, unknown> {
    this.assertExecution()
    const done = Promise.withResolvers<void>()
    this.pending.add(done.promise)
    try {
      for await (const value of source(this.signal)) {
        this.assertExecution()
        yield value
      }
      this.assertExecution()
    } finally { this.pending.delete(done.promise); done.resolve() }
  }

  /** Renew or observe this exact operation without granting prepared input model/tool execution.
   * @param job Bounded operation maintenance, cancelled and drained during sealing.
   * @returns Its result after rechecking this generation; writer renewal uses the separate Session owner.
   */
  async maintain<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertMaintenance()
    return this.track(job, () => { this.assertMaintenance() })
  }

  private async track<T>(job: (signal: AbortSignal) => Promise<T>, check: () => void): Promise<T> {
    const done = Promise.withResolvers<void>()
    this.pending.add(done.promise)
    try {
      const result = await job(this.signal)
      check()
      return result
    } finally { this.pending.delete(done.promise); done.resolve() }
  }

  /** Own operation registrations and timers; disposers must not await this generation's execute or the Agent driver.
   * @param dispose Removes only this generation's contributions and drains its separately owned tasks.
   */
  own(dispose: () => void | Promise<void>): void {
    this.assertCurrent()
    if (this.sealed) throw new PlatformError(409, 'native_generation_sealed')
    this.disposers.push(dispose)
  }

  /** Apply a fresh Platform inspection without granting a prepared or consumed message another execution.
   * @param input Parsed at the response boundary; consumption identity and claim coordinates remain immutable.
   */
  reconcile(input: unknown): void {
    this.assertCurrent()
    if (this.sealed) throw new PlatformError(409, 'native_generation_sealed')
    const next = nativeTurnFrame.parse(input), previous = this.state
    if (!isDeepStrictEqual(identity(next), identity(previous))
      || previous.phase !== 'prepared' && next.phase === 'prepared'
      || (previous.phase === 'settled' || previous.phase === 'retired') && !isDeepStrictEqual(previous, next)
      || previous.phase === 'claimed' && next.phase === 'retired') {
      throw new PlatformError(409, 'native_generation_consumption')
    }
    if (previous.phase === 'claimed' && (next.phase === 'claimed' || next.phase === 'settled')) {
      const { turnEndSeq: previousEnd, ...priorClaim } = previous.claim
      const { turnEndSeq: nextEnd, ...nextClaim } = next.claim
      if (!isDeepStrictEqual(priorClaim, nextClaim) || previousEnd !== null && previousEnd !== nextEnd) {
        throw new PlatformError(409, 'native_generation_consumption')
      }
    }
    this.state = next
  }

  /** Abort only this operation; the Session owner decides whether to cancel the current Agent driver.
   * @param error Retained timeout, lease or publication failure.
   */
  abortOperation(error: unknown): void { this.abort.abort(error) }

  /** Stop admission, drain callbacks and effects, flush persistence, then close A's publisher.
   * @returns Shared seal or retained failure; safe inside before-turn because it never waits on the Agent driver.
   */
  seal(): Promise<NativePublicationSeal> {
    if (this.sealing) return this.sealing
    this.assertCurrent()
    this.sealed = true
    this.abort.abort(new PlatformError(409, 'native_generation_sealed'))
    return this.sealing = (async () => {
      await Promise.all(this.pending)
      const disposed = await Promise.allSettled(this.disposers.map(async (dispose) => { await dispose() }))
      this.disposers.length = 0
      const failed = disposed.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      await this.resources.flushPersistence()
      return this.resources.publication.seal()
    })()
  }

  /** Keep already-admitted native output in A until its publisher closes; this never authorizes a new external call. */
  assertPublication(): void { this.assertCurrent(); this.resources.publication.publisher.assertOpen() }

  private assertCurrent(): void {
    if (!this.owns()) throw new PlatformError(409, 'native_generation_lost')
  }

  private assertMaintenance(): void {
    this.assertCurrent()
    if (this.sealed) throw new PlatformError(409, 'native_generation_sealed')
    this.signal.throwIfAborted()
  }
}

/** Stable writer-facing slot; replacement requires the exact previous generation and occurs only after a PG receipt. */
export class NativeGenerationWriteSlot {
  private current: NativeOperationGeneration | undefined

  /** Stage native events synchronously under the captured generation, including prepared claim records.
   * @param expected Generation captured when the original event was observed.
   * @param events Canonical detached events in observation order.
   * @returns Receipt barrier from the exact current publisher.
   */
  append(expected: NativeOperationGeneration, events: readonly SessionEvent[]): Promise<void> {
    this.assertOwner(expected)
    expected.assertPublication()
    return expected.resources.publication.publisher.append(events)
  }

  /** Stage an original frame without changing its operation token.
   * @param expected Generation captured by the frame listener.
   * @param frame Original public Agent stream frame.
   */
  frame(expected: NativeOperationGeneration, frame: AssistantStreamFrame): void {
    this.assertOwner(expected); expected.assertPublication()
    expected.resources.publication.publisher.frame(frame)
  }

  /** @returns The current publisher's durability barrier, or completion when healthily parked. */
  async flush(): Promise<void> { await this.current?.resources.publication.publisher.flush() }

  /** Publish the successor synchronously; callers hold the Session's installation reservation.
   * @param expected Exactly the previous generation, or undefined at admission/activation.
   * @param next Receipt-authorized successor, or undefined when parked/expired.
   */
  replace(expected: NativeOperationGeneration | undefined, next: NativeOperationGeneration | undefined): void {
    if (this.current !== expected) throw new PlatformError(409, 'native_generation_write_owner')
    this.current = next
  }

  private assertOwner(expected: NativeOperationGeneration): void {
    if (this.current !== expected) throw new PlatformError(409, 'native_generation_write_owner')
  }
}

/** Synchronous registry publication must compare the exact previous owner and must not partially mutate then throw. */
export interface NativeGenerationInstaller {
  /** Prepare an unstarted publisher and existing write-handle barrier; register operation effects after publication. */
  readonly resources: (grant: Grant, eventCount: number) => NativeGenerationResources
  readonly publish: (previous: NativeOperationGeneration | undefined, next: NativeOperationGeneration | undefined) => void
  readonly cancel: (expected: NativeOperationGeneration, error: unknown) => void
  readonly transition: (intent: NativeTurnTransition) => Promise<unknown>
}

/** Result.current governs installation; a historical prepared result alone never restores execution. */
export type NativeGenerationCommit = {
  readonly kind: 'installed'
  readonly generation: NativeOperationGeneration
  readonly response: NativeTurnResponse
} | { readonly kind: 'parked' | 'expired' | 'reconcile'; readonly response: NativeTurnResponse }

interface PendingTransition {
  readonly expected: NativeOperationGeneration | undefined
  readonly intent: NativeTurnTransition
  receipt: NativeTurnReceipt | undefined
  work: Promise<NativeGenerationCommit> | undefined
}

function source(intent: NativeTurnTransition) {
  if (intent.from.kind === 'parked') return intent.from
  const { operationToken: _token, ...value } = intent.from
  return value
}

/** Owns Session publication and a retained transition request; it neither claims inbox input nor owns the Agent driver. */
export class NativeSessionGenerations {
  readonly writes = new NativeGenerationWriteSlot()
  private current: NativeOperationGeneration | undefined
  private pending: PendingTransition | undefined
  private last: { readonly intent: NativeTurnTransition; readonly result: NativeGenerationCommit } | undefined
  private closed = false
  private closing: Promise<void> | undefined

  /**
   * @param writer Independent retained writer identity, not the originating operation's token.
   * @param writerClient Root's existing renew/release transport; acquisition occurs before constructing this owner.
   * @param installer Product adapters; publish is synchronous and all asynchronous preparation precedes it.
   */
  constructor(readonly writer: NativeWriterIdentity, private readonly writerClient: Pick<HostNativeWriterClient, 'renew' | 'release'>,
    private readonly installer: NativeGenerationInstaller) {}

  /** @returns Exact live generation, or undefined while parked/expired; a sealed A stays visible until receipt installation. */
  get generation(): NativeOperationGeneration | undefined { return this.current }

  /** @returns Tokenless receipt retained after a committed response whose local installation failed. */
  get retainedReceipt(): NativeTurnReceipt | undefined { return this.pending?.receipt && structuredClone(this.pending.receipt) }

  /** Install initial authority only after writer acquisition and Platform native preparation.
   * @param grant Exact current operation object in RuntimeScope.
   * @param frame Authoritative preparation/consumption state, never inferred from missing user/message.
   * @param eventCount Initial committed native event prefix.
   * @returns Generation whose prepared state permits publication but refuses execution.
   */
  installInitial(grant: Grant, frame: NativeTurnFrame, eventCount: number): NativeOperationGeneration {
    this.assertOpen()
    if (this.current || this.pending || this.last) throw new PlatformError(409, 'native_generation_already_started')
    const next = this.create(grant, frame, eventCount)
    this.installer.publish(undefined, next)
    this.writes.replace(undefined, next); this.current = next
    return next
  }

  /** Cancel only the current exact generation; stale callbacks cannot affect its successor.
   * @param expected Captured generation from renew, timeout or publication failure.
   * @param error The original failure, passed only to its current owner.
   * @returns Whether the current operation was cancelled.
   */
  cancelIfCurrent(expected: NativeOperationGeneration, error: unknown): boolean {
    if (this.closed || this.current !== expected || expected.signal.aborted) return false
    expected.abortOperation(error)
    this.installer.cancel(expected, error)
    return true
  }

  /** Writer renewal remains available while parked and never refreshes an operation.
   * @param signal Session writer lifetime, independent of any operation signal.
   * @returns Root transport's tokenless lease receipt.
   */
  renewWriter(signal?: AbortSignal) {
    this.assertOpen()
    return this.writerClient.renew(this.writer, signal)
  }

  /** Send/replay one retained request after sealing; installation failure replays Platform current before publishing again.
   * @param expected Current A, or undefined for activation from a committed parked receipt.
   * @param input Complete intent built from A's seal and native history; token and transition identity persist across retry.
   * @returns Installed prepared generation, parked/expired status, or claimed reconciliation; never reinserts input.
   */
  commitTransition(expected: NativeOperationGeneration | undefined, input: NativeTurnTransition): Promise<NativeGenerationCommit> {
    this.assertOpen()
    const intent = nativeTurnTransition.parse(input)
    if (this.last?.intent.transitionId === intent.transitionId) {
      if (!isDeepStrictEqual(this.last.intent, intent)) throw new PlatformError(409, 'native_generation_transition_conflict')
      return Promise.resolve(this.last.result)
    }
    if (this.pending) {
      if (this.pending.expected !== expected || !isDeepStrictEqual(this.pending.intent, intent)) {
        throw new PlatformError(409, 'native_generation_transition_conflict')
      }
    } else {
      if (this.current !== expected || !isDeepStrictEqual(intent.writer, this.writer)
        || intent.kind === 'activate' && (expected !== undefined || this.last?.result.kind !== 'parked'
          || intent.from.transitionId !== this.last.intent.transitionId)
        || intent.kind !== 'activate' && (expected === undefined || intent.from.operationId !== expected.grant.operationId
          || intent.from.operationEpoch !== expected.grant.epoch || intent.from.operationToken !== expected.grant.token)) {
        throw new PlatformError(409, 'native_generation_transition_owner')
      }
      this.pending = { expected, intent, receipt: undefined, work: undefined }
    }
    const pending = this.pending
    if (!pending.work) {
      pending.work = this.commit(pending)
      void pending.work.then(() => { pending.work = undefined }, () => { pending.work = undefined })
    }
    return pending.work
  }

  private async commit(pending: PendingTransition): Promise<NativeGenerationCommit> {
    const { expected, intent } = pending
    if (expected) {
      const seal = await expected.seal()
      if (seal.eventCount !== intent.expectedEventCount || intent.kind === 'advance'
        && !isDeepStrictEqual(intent.seal, { publisherId: seal.publisherId, lastOrdinal: seal.lastOrdinal, revision: seal.revision })) {
        this.pending = undefined
        throw new PlatformError(409, 'native_generation_seal')
      }
    }
    const response = nativeTurnResponse.parse(await this.installer.transition(intent))
    this.validateReceipt(intent, response)
    pending.receipt = response.receipt
    this.assertOpen()
    // An immutable receipt does not contain B's later native prefix or its existing publisher identity.
    if (response.current.kind === 'live' && response.current.frame.phase === 'claimed') return { kind: 'reconcile', response }
    const next = response.current.kind === 'live'
      ? this.create(response.current.grant, response.current.frame, response.receipt.eventCount) : undefined
    this.installer.publish(expected, next)
    this.writes.replace(expected, next); this.current = next
    const result: NativeGenerationCommit = next ? { kind: 'installed', generation: next, response }
      : { kind: response.current.kind === 'parked' ? 'parked' : 'expired', response }
    this.last = { intent, result }; this.pending = undefined
    return result
  }

  private validateReceipt(intent: NativeTurnTransition, response: NativeTurnResponse): void {
    const receipt = response.receipt
    if (receipt.sessionId !== this.writer.sessionId || receipt.writerEpoch !== this.writer.epoch
      || receipt.transitionId !== intent.transitionId || receipt.eventCount !== intent.expectedEventCount
      || receipt.queueRevision !== intent.expectedQueueRevision || !isDeepStrictEqual(receipt.from, source(intent))) {
      throw new PlatformError(502, 'native_generation_receipt')
    }
    if (response.current.kind === 'live') {
      const { token, ...saved } = response.current.grant
      if (receipt.result.kind !== 'prepared' || intent.expectedNext === null
        || !isDeepStrictEqual({ operationId: receipt.result.frame.operationId, messageId: receipt.result.frame.messageId,
          inputRevision: receipt.result.frame.inputRevision }, intent.expectedNext)
        || intent.from.kind !== 'parked' && receipt.result.frame.operationEpoch <= intent.from.operationEpoch
        || token !== intent.candidateToken
        || !isDeepStrictEqual(saved, receipt.result.grant)
        || !isDeepStrictEqual(identity(response.current.frame), receipt.result.frame)) {
        throw new PlatformError(502, 'native_generation_receipt')
      }
    } else if (response.current.kind === 'parked' && receipt.result.kind !== 'parked') {
      throw new PlatformError(502, 'native_generation_receipt')
    }
  }

  private create(grant: Grant, frame: NativeTurnFrame, eventCount: number): NativeOperationGeneration {
    if (grant.sessionId !== this.writer.sessionId || frame.writerEpoch !== this.writer.epoch) {
      throw new PlatformError(409, 'native_generation_writer')
    }
    const next: NativeOperationGeneration = new NativeOperationGeneration(grant, frame,
      this.installer.resources(grant, eventCount), () => this.current === next)
    next.resources.publication.publisher.onFailure((error) => { this.cancelIfCurrent(next, error) })
    return next
  }

  private assertOpen(): void { if (this.closed) throw new PlatformError(409, 'native_generation_closed') }

  /** Close outside the Agent hook; waits for any uncertain transition request before releasing independent writer occupancy.
   * @param signal Session shutdown lifetime for Root's bounded release request.
   * @returns Completion after draining and releasing; an unresolved transition refuses release and remains retryable.
   */
  close(signal?: AbortSignal): Promise<void> {
    if (this.closing) return this.closing
    const work = (async () => {
      const transition = this.pending?.work
      if (transition) await Promise.allSettled([transition])
      if (this.pending) throw new PlatformError(409, 'native_generation_unreconciled')
      this.closed = true
      if (this.current) await this.current.seal()
      await this.writerClient.release(this.writer, signal)
    })()
    this.closing = work
    void work.catch(() => { this.closing = undefined })
    return work
  }
}
