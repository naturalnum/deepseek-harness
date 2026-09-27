/** Native Session persistence over the platform's fenced PostgreSQL event API. */
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, SessionPersistenceRevision, SessionAlreadyOwnedError,
  SessionHandleClosedError, SessionReadOnlyError,
  type SessionHandle, type SessionAccess, type SessionHandleReadResult,
  type SessionHandleReadOptions, type SessionHandleAppendOptions, type SessionHandleFlushOptions, type SessionPersistenceOpenOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type RuntimeScope from './scope.ts'
import { headerSchema, parseEvents } from '../session-records.ts'

const snapshot = z.object({ header: headerSchema, events: z.array(z.json()), eventCount: z.number().int() })

class PlatformHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined

  constructor(
    private readonly runtime: RuntimeScope, readonly header: SessionHeader,
    readonly access: SessionAccess, private events: SessionEvent[], private readonly released: () => void,
  ) {}

  get id(): SessionId { return this.header.id }
  private assertOpen(): void { if (this.closed || this.closing) throw new SessionHandleClosedError(this.id, 'access') }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid event slice')
    await this.chain
    if (this.access === 'read') {
      const value = snapshot.parse(await this.runtime.call('/runtime/snapshot', this.runtime.require(this.id).token, {}))
      if (value.header.id !== this.id || value.eventCount < this.events.length) throw new Error('Stored Session changed identity or shrank')
      this.events = parseEvents(value.header, value.events)
    }
    options?.signal?.throwIfAborted()
    return { eventState: 'detached', events: structuredClone(this.events.slice(offset, offset + length)) }
  }

  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    const batch = structuredClone(events)
    const token = this.runtime.require(this.id).token
    this.chain = this.chain.then(async () => {
      await this.runtime.call('/runtime/append', token, { events: batch })
      this.events.push(...batch)
    })
    // The durability barrier retains and reports failure; observer delivery is synchronous.
    void this.chain.catch((_retainedWriteFailure) => { /* Reported by flush and close. */ })
    return this.chain
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    options?.signal?.throwIfAborted()
    await this.chain
  }
  close(): Promise<void> {
    return this.closing ??= this.chain.finally(() => { this.closed = true; this.released() })
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
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush())
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
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
    const value = snapshot.parse(await runtime.call('/runtime/snapshot', runtime.require(id).token, {}))
    options?.signal?.throwIfAborted()
    if (value.header.id !== id) throw new Error('Platform returned another Session')
    const handle = new PlatformHandle(runtime, value.header, access, parseEvents(value.header, value.events), () => {
      this.handles.delete(handle)
      if (this.writers.get(id) === handle) this.writers.delete(id)
    })
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.handles.add(handle)
    if (access === 'write') this.writers.set(id, handle)
    return handle
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map(handle => handle.flush()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Session flush failed')
  }
  async stat(id: SessionId) {
    const value = snapshot.parse(await this.ctx.powerEvolveRuntime.call('/runtime/snapshot', this.ctx.powerEvolveRuntime.require(id).token, {}))
    return { header: value.header, revision: SessionPersistenceRevision(String(value.eventCount)), eventCount: value.eventCount }
  }
  async list() { return Promise.all([...this.ctx.powerEvolveRuntime.grants.keys()].map(id => this.stat(id))) }
}
