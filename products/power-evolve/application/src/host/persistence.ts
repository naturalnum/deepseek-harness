/** Native Session persistence over the platform's fenced PostgreSQL event API. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, type SessionPersistenceRevision, SessionAlreadyOwnedError,
  SessionHandleClosedError, SessionReadOnlyError,
  type SessionHandle, type SessionAccess, type SessionHandleReadResult,
  type SessionHandleReadOptions, type SessionHandleAppendOptions, type SessionHandleFlushOptions, type SessionPersistenceOpenOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type RuntimeScope from './scope.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { PlatformError, type Grant } from '../contracts.ts'
import { NativeAssistantPublisher, type NativePublicationSeal } from './native-assistant-publisher.ts'
import { nativeAssistantBatch } from '../native-assistant-records.ts'

const snapshot = z.object({ header: headerSchema, events: z.array(z.json()), eventCount: z.number().int() })

class PlatformHandle implements SessionHandle {
  readonly inheritedEventCount: SessionLogOffset
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined
  private retired = false

  constructor(
    private readonly runtime: RuntimeScope, readonly header: SessionHeader,
    readonly access: SessionAccess, private events: SessionEvent[], private readonly released: () => void,
    private readonly publisher: NativeAssistantPublisher | undefined,
    private readonly capturedGrant: Grant,
  ) {
    const marker = events.findLast(event => event.type === 'session/end-seed' && event.data.inherited === true)
    if (header.isSeeded !== (marker !== undefined)) throw new Error('Stored Session seed metadata disagrees with its marker')
    this.inheritedEventCount = SessionLogOffset(marker?.seq ?? 0)
  }

  get id(): SessionId { return this.header.id }
  private assertOpen(): void { if (this.closed || this.closing) throw new SessionHandleClosedError(this.id, 'access') }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid event slice')
    const captured = structuredClone(this.events.slice(offset, offset + length))
    await this.chain
    if (this.access === 'read') {
      this.runtime.assertGrant(this.capturedGrant)
      const stored = await this.runtime.call('/runtime/snapshot', this.capturedGrant.token, {}, options?.signal)
      this.runtime.assertGrant(this.capturedGrant)
      const value = snapshot.parse(stored)
      if (value.header.id !== this.id || value.eventCount < this.events.length) throw new Error('Stored Session changed identity or shrank')
      this.events = parseEvents(value.header, value.events)
    }
    options?.signal?.throwIfAborted()
    return { eventState: 'detached', events: this.access === 'write' ? captured
      : structuredClone(this.events.slice(offset, offset + length)) }
  }

  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    const batch = structuredClone(events)
    let publication: Promise<void>
    try {
      if (!this.publisher) throw new PlatformError(409, 'native_publication_missing')
      // Stage synchronously at the Session event observation point; a later
      // assistant frame must not overtake an event waiting on its receipt.
      publication = this.publisher.append(batch)
      this.events.push(...batch)
    } catch (error: unknown) {
      publication = Promise.reject(error instanceof Error ? error : new Error('Native publication staging failed', { cause: error }))
    }
    void publication.catch((_retainedWriteFailure: unknown) => { /* The ordered durability barrier reports it. */ })
    this.chain = this.chain.then(async () => { await publication })
    // The durability barrier retains and reports failure; observer delivery is synchronous.
    void this.chain.catch((_retainedWriteFailure: unknown) => { /* Reported by flush and close. */ })
    return this.chain
  }

  /** Adopt a committed external suffix under this exact handle, while staged native observers retain their barriers. */
  synchronizeCommitted(expectedEventCount: number, events: readonly SessionEvent[]): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, 'append')
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    if (this.events.length !== expectedEventCount) throw new PlatformError(409, 'native_persistence_input_prefix')
    const suffix = parseEvents(this.header, events)
    if (suffix.some((event, index) => event.seq !== expectedEventCount + index)) {
      throw new PlatformError(409, 'native_persistence_input_suffix')
    }
    this.events.push(...suffix)
  }

  /** Retire this exact publisher after the Platform has consumed its seal and transferred the operation. */
  retire(seal: NativePublicationSeal): void {
    this.assertOpen()
    if (!this.publisher) throw new PlatformError(409, 'native_publication_missing')
    this.publisher.retire(seal)
    this.retired = true
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    options?.signal?.throwIfAborted()
    await this.chain
    await this.publisher?.flush()
  }
  /** Release local ownership after draining, while retaining any append failure for the caller. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const errors: Error[] = []
      const retain = (error: unknown): void => { errors.push(error instanceof Error ? error : new Error('Writer close failed', { cause: error })) }
      try {
        try { await this.chain }
        catch (error) { retain(error) }
        try { await this.publisher?.close() }
        catch (error) { retain(error) }
        if (this.publisher && !this.retired) {
          try {
            await this.runtime.call('/runtime/native-assistant/release', this.capturedGrant.token,
              { publisherId: this.publisher.publisherId })
          } catch (error) { retain(error) }
        }
        if (this.publisher && errors.length === 0) this.runtime.confirmNativeIntents(this.capturedGrant)
      } finally {
        this.closed = true
        this.released()
      }
      const first = errors[0]
      if (first) throw first
    })()
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close() }
}

/** Only the leased operation may open a native Session in this host. */
export default class PlatformPersistence extends SessionPersistence {
  static inject = ['powerEvolveRuntime']
  private readonly writers = new Map<SessionId, PlatformHandle>()
  private readonly handles = new Set<PlatformHandle>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.on('session/event', (session, event) => {
      const writer = this.writers.get(session.id)
      if (writer) void writer.append([event]).catch(() => {
        // The awaited session/flush barrier propagates this retained failure.
      })
    })
    ctx.on('session/flush', (session) => {
      const writer = this.writers.get(session.id)
      if (!writer) throw new PlatformError(403, 'session_not_leased')
      return writer.flush()
    })
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Platform persistence shutdown failed')
    })
  }

  create(_header: SessionHeader): Promise<SessionHandle> {
    return Promise.reject(new Error('Create sessions through the authenticated platform API'))
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    const runtime = this.ctx.powerEvolveRuntime
    const captured = runtime.require(id)
    const value = snapshot.parse(await runtime.call('/runtime/snapshot', captured.token, {}, options?.signal))
    options?.signal?.throwIfAborted()
    runtime.assertGrant(captured)
    if (value.header.id !== id) throw new Error('Platform returned another Session')
    let publisher: NativeAssistantPublisher | undefined
    let releasePublication: (() => void) | undefined
    if (access === 'write') {
      const config = runtime.config
      publisher = new NativeAssistantPublisher(captured, value.eventCount, {
        maxQueueItems: config.nativePublicationMaxQueueItems, maxQueueBytes: config.nativePublicationMaxQueueBytes,
        maxBatchItems: config.nativePublicationMaxBatchItems, maxBatchBytes: config.nativePublicationMaxBatchBytes,
        maxItemBytes: config.nativePublicationMaxItemBytes,
      }, (token, input) => runtime.commitNativeMutation(token,
        { family: 'publication', request: nativeAssistantBatch.parse(input) }))
    }
    const handle = new PlatformHandle(runtime, value.header, access, parseEvents(value.header, value.events), () => {
      this.handles.delete(handle)
      if (this.writers.get(id) === handle) this.writers.delete(id)
      releasePublication?.()
    }, publisher, captured)
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    if (publisher) releasePublication = runtime.registerPublication(captured, publisher,
      (expectedEventCount, events) => { handle.synchronizeCommitted(expectedEventCount, events) },
      (seal) => { handle.retire(seal) })
    this.handles.add(handle)
    if (access === 'write') this.writers.set(id, handle)
    return handle
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map(handle => handle.flush()))
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Session flush failed')
  }
  async stat(id: SessionId) {
    const value = snapshot.parse(await this.ctx.powerEvolveRuntime.call('/runtime/snapshot', this.ctx.powerEvolveRuntime.require(id).token, {}))
    return { header: value.header, revision: brandString<SessionPersistenceRevision>(String(value.eventCount)),
      eventCount: value.eventCount }
  }
  async list() { return Promise.all([...this.ctx.powerEvolveRuntime.grants.keys()].map(id => this.stat(id))) }
}
