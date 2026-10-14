/** Native Session persistence over the platform's fenced PostgreSQL event API. */
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
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
import { randomBytes } from 'node:crypto'
import { grant as grantSchema } from '../contracts.ts'
import { HostNativeWriterClient } from './native-writer-client.ts'
import type { HostNativeWriterLease } from './native-writer-client.ts'
import { setTimeout as delay } from 'node:timers/promises'

const snapshot = z.object({ header: headerSchema, events: z.array(z.json()), eventCount: z.number().int() })

class PlatformHandle implements SessionHandle {
  readonly inheritedEventCount: SessionLogOffset
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined
  private retired = false

  constructor(
    private readonly runtime: RuntimeScope, readonly header: SessionHeader,
    readonly access: SessionAccess, private events: SessionEvent[], private readonly released: (failure: Error | undefined) => void | Promise<void>,
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
    const batch: SessionEvent[] = []
    for (const event of structuredClone(events)) {
      if (event.seq < this.events.length) {
        if (!isDeepStrictEqual(this.events[event.seq], event)) throw new PlatformError(409, 'native_persistence_prefix_conflict')
        continue
      }
      if (event.seq !== this.events.length + batch.length) throw new PlatformError(409, 'native_persistence_prefix_gap')
      batch.push(event)
    }
    if (batch.length === 0) return this.chain
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
        try { await this.released(errors[0]) } catch (error) { retain(error) }
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
  private readonly ownerFiber: Fiber
  private closing = false
  private readonly pending = new Set<Promise<SessionHandle>>()
  private shutdownPromise: Promise<void> | undefined
  private readonly teardownFailures: unknown[] = []
  private readonly writers = new Map<SessionId, PlatformHandle>()
  private readonly handles = new Set<PlatformHandle>()
  private readonly children = new Map<SessionId, { grant: Grant; writer: HostNativeWriterLease; stop: AbortController; renewal: Promise<void>;
    outcome: 'completed' | 'failed'; errorCode: string | null }>()

  constructor(ctx: Context) {
    super(ctx)
    this.ownerFiber = ctx.fiber
    ctx.on('session/event', (session, event) => {
      const child = this.children.get(session.id)
      if (child && event.type === 'turn/end') {
        child.outcome = event.data.reason.kind === 'completed' ? 'completed' : 'failed'
        child.errorCode = child.outcome === 'completed' ? null : `turn_${event.data.reason.kind.replaceAll('-', '_')}`
      }
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
    ctx.effect(() => () => this.shutdown())
  }

  /** Drain all accepted native acquisitions before closing handles and retain the original cleanup result.
   * @returns One cached strict result for callers; Cordis teardown also invokes it but only logs a rejection.
   */
  shutdown(): Promise<void> {
    this.closing = true
    return this.shutdownPromise ??= (async () => {
      await Promise.allSettled(this.pending)
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const errors = [...this.teardownFailures, ...results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])]
      if (errors.length) throw new AggregateError(errors, 'Platform persistence shutdown failed')
    })()
  }

  private isClosing(): boolean {
    return this.closing || this.ownerFiber.state === FiberState.UNLOADING || this.ownerFiber.state === FiberState.DISPOSED
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    if (this.isClosing()) return Promise.reject(new PlatformError(409, 'native_persistence_closing'))
    return this.track(this.createOwned(header))
  }

  private track(work: Promise<SessionHandle>): Promise<SessionHandle> {
    this.pending.add(work)
    void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }

  private async createOwned(header: SessionHeader): Promise<SessionHandle> {
    const runtime = this.ctx.powerEvolveRuntime
    if (runtime.config.runtimeUserId === '' || header.parentSession === undefined || header.origin !== 'subagent') {
      throw new Error('Create sessions through the authenticated platform API')
    }
    const parent = runtime.require(header.parentSession)
    const child = grantSchema.parse(await runtime.call('/runtime/subagents/create', parent.token, { header }))
    runtime.assertGrant(parent)
    if (child.userId !== parent.userId || child.sessionId !== header.id) throw new PlatformError(502, 'native_subagent_identity')
    runtime.grants.set(child.sessionId, child)
    const writers = new HostNativeWriterClient(runtime)
    let writer: HostNativeWriterLease | undefined
    try {
      writer = await writers.acquire(child, randomBytes(32).toString('base64url'))
      if (this.isClosing()) throw new PlatformError(409, 'native_persistence_closing')
      const capturedWriter = writer
      const stop = new AbortController()
      const renewal = (async () => {
        while (!stop.signal.aborted) {
          try { await delay(runtime.config.nativeSubagentRenewMs, undefined, { signal: stop.signal }) }
          catch (error) { if (stop.signal.aborted) return; throw error }
          if (stop.signal.aborted) return
          const renewed = z.object({ cancelRequested: z.boolean() }).parse(await runtime.call('/runtime/renew', child.token, {}, stop.signal))
          if (renewed.cancelRequested) {
            this.ctx.get('agents')?.get(child.sessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
          }
          runtime.heartbeatPublication(child)
          await writers.renew(capturedWriter.identity, stop.signal)
        }
      })().catch((error: unknown) => {
        if (!stop.signal.aborted) {
          stop.abort(error)
          this.ctx.get('agents')?.get(child.sessionId)?.cancel({ kind: 'disposed' }, { keepInbox: true })
        }
      })
      this.children.set(child.sessionId, { grant: child, writer, stop, renewal, outcome: 'failed', errorCode: 'native_subagent_incomplete' })
      return await this.open(child.sessionId, 'write')
    } catch (error) {
      const childOwner = this.children.get(child.sessionId)
      this.children.delete(child.sessionId)
      childOwner?.stop.abort()
      await childOwner?.renewal
      let cleanupFailure: unknown
      if (writer) {
        try { await runtime.call('/runtime/cleanup', child.token, { operationId: child.operationId, epoch: child.epoch,
          writer: writer.identity, errorCode: 'native_subagent_setup_failed' }) }
        catch (failure) { cleanupFailure = failure }
      }
      runtime.grants.delete(child.sessionId)
      if (cleanupFailure !== undefined) {
        const failed = new AggregateError([error, cleanupFailure], 'Native subagent setup cleanup failed')
        this.teardownFailures.push(failed)
        this.closing = true
        throw failed
      }
      throw error
    }
  }

  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    if (this.isClosing()) return Promise.reject(new PlatformError(409, 'native_persistence_closing'))
    return this.track(this.openOwned(id, access, options))
  }

  private async openOwned(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    const runtime = this.ctx.powerEvolveRuntime
    const captured = runtime.require(id)
    const value = snapshot.parse(await runtime.call('/runtime/snapshot', captured.token, {}, options?.signal))
    options?.signal?.throwIfAborted()
    runtime.assertGrant(captured)
    if (value.header.id !== id) throw new Error('Platform returned another Session')
    if (this.isClosing()) throw new PlatformError(409, 'native_persistence_closing')
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
    const handle = new PlatformHandle(runtime, value.header, access, parseEvents(value.header, value.events), async (failure) => {
      this.handles.delete(handle)
      if (this.writers.get(id) === handle) this.writers.delete(id)
      releasePublication?.()
      const child = this.children.get(id)
      if (access === 'write' && child?.grant === captured) {
        this.children.delete(id)
        child.stop.abort()
        await child.renewal
        try {
          try {
            await new HostNativeWriterClient(runtime).release(child.writer.identity)
            await runtime.call('/runtime/finish', child.grant.token, { outcome: failure === undefined ? child.outcome : 'failed',
              errorCode: failure === undefined ? child.errorCode : 'native_subagent_publication_failed' })
          } catch (error) {
            await runtime.call('/runtime/cleanup', child.grant.token, { operationId: child.grant.operationId, epoch: child.grant.epoch,
              writer: child.writer.identity, errorCode: 'native_subagent_closed' })
            if (failure === undefined) throw error
          }
        } finally { if (runtime.grants.get(id) === child.grant) runtime.grants.delete(id) }
      }
    }, publisher, captured)
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    if (publisher) releasePublication = runtime.registerPublication(captured, publisher,
      (expectedEventCount, events) => { handle.synchronizeCommitted(expectedEventCount, events) },
      (seal) => { handle.retire(seal) })
    this.handles.add(handle)
    if (access === 'write') this.writers.set(id, handle)
    return handle
  }

  /** Commit explicit setup events through the already acquired native write handle before Agent publication.
   * @param id Exact unpublished Session being resumed under its current operation and Writer.
   * @param events Newly returned append events, in native sequence order; no historical Session scan is performed.
   * @returns Completion after the original Publisher acknowledgement; the factory's later exact-prefix append is idempotent.
   */
  async flushUnpublished(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const handle = this.writers.get(id)
    if (!handle) throw new PlatformError(403, 'session_not_leased')
    this.ctx.powerEvolveRuntime.assertGrant(this.ctx.powerEvolveRuntime.require(id))
    await handle.append(events)
    await handle.flush()
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
