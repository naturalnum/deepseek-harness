/** Tenant-authorized native SQLite search over a bounded, validated PostgreSQL snapshot. */
import { setImmediate as yieldToCarrier } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import type { SessionSearchValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { type Identity, PlatformError } from '../contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import type { EventLimits } from './events.ts'

const SESSION_CHUNK = 64
const EVENT_CHUNK = 256
interface SearchRow { id: string; header: unknown; event_count: number; event_bytes: string; updated_at: string }
interface HistorySize { count: string; bytes: string; maximum: number; first: number | null; last: number | null }

/** Explicit storage, operation-work and result limits supplied by validated Platform configuration. */
export interface NativeSessionSearchLimits extends EventLimits {
  /** Maximum returned Sessions; one additional ranked candidate establishes hasMore. */
  readonly searchResultLimit: number
  /** Maximum snippet Unicode code points. */
  readonly searchSnippetChars: number
  /** Whole-operation deadline including pool acquisition and database waits. */
  readonly searchDeadlineMs: number
  /** Maximum inspected owned Sessions, including empty and nonmatching histories. */
  readonly searchMaxSessions: number
  /** Maximum actual committed events inspected across the authorized snapshot. */
  readonly searchMaxEvents: number
  /** Maximum original JSON UTF-8 bytes inspected across the authorized snapshot. */
  readonly searchMaxBytes: number
}

function unavailable(): PlatformError { return new PlatformError(503, 'native_search_unavailable') }
function budgetExceeded(): PlatformError { return new PlatformError(503, 'native_search_budget_exceeded') }
function gap(): PlatformError { return new PlatformError(500, 'native_history_gap') }
function invalidHistory(): PlatformError { return new PlatformError(500, 'native_history_invalid') }

/** One operation owns its deadline, caller cancellation and exclusively acquired connection. */
class SearchScope {
  readonly deadline: number
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private failure: PlatformError | undefined
  private closed = false
  private client: PoolClient | undefined
  private destroyed = false
  private readonly interruption = Promise.withResolvers<never>()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly onAbort = () => { this.fail(new PlatformError(499, 'native_search_cancelled')) }

  constructor(duration: number, private readonly callerSignal: AbortSignal | undefined) {
    this.deadline = performance.now() + duration
    // A CPU fold can notice expiry before the next await installs a racing waiter.
    void this.interruption.promise.catch(() => undefined)
    this.timer = setTimeout(() => { this.fail(new PlatformError(504, 'native_search_timeout')) }, duration)
    callerSignal?.addEventListener('abort', this.onAbort, { once: true })
    if (callerSignal?.aborted) this.onAbort()
  }

  check(): void {
    if (!this.failure && performance.now() >= this.deadline) this.fail(new PlatformError(504, 'native_search_timeout'))
    if (this.failure) throw this.failure
  }
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.check()
    const result = await Promise.race([pending, this.interruption.promise])
    this.check()
    return result
  }
  async acquire(pool: Pool): Promise<PoolClient> {
    this.check()
    const pending = pool.connect().then((client) => {
      if (this.closed || this.failure) {
        client.release(true)
        throw this.failure ?? unavailable()
      }
      this.client = client
      return client
    })
    return this.wait(pending)
  }
  discard(): void {
    if (this.client && !this.destroyed) {
      this.destroyed = true
      this.client.release(true)
    }
  }
  release(discard: boolean): boolean {
    if (discard) this.discard()
    const destroyed = this.destroyed
    if (this.client && !destroyed) this.client.release()
    this.client = undefined
    return destroyed
  }
  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.callerSignal?.removeEventListener('abort', this.onAbort)
  }
  private fail(error: PlatformError): void {
    if (this.closed || this.failure) return
    this.failure = error
    this.controller.abort(error)
    this.discard()
    this.interruption.reject(error)
  }
}

/** Search official canonical current messages in one authorized read-only database snapshot.
 * The official SQLite provider owns text extraction, FTS5 matching, strongest-hit ranking and snippets.
 * Whole-corpus limits bound retained histories and the private disposable in-memory derived index.
 * @param pool Platform-owned PG pool; cancelled acquisitions release any late connection.
 * @param user Authenticated owner; every candidate history originates in this owner's snapshot.
 * @param query Nonblank, NUL-free query of at most 500 UTF-16 code units.
 * @param limits Explicit per-history, whole-operation and returned-result budgets.
 * @param signal Carrier cancellation; abort and deadline fail rather than returning partial results.
 * @returns Strongest matching current message per Session, globally ranked, with exact result lookahead.
 */
export async function searchNativeSessions(pool: Pool, user: Identity, query: string,
  limits: NativeSessionSearchLimits, signal?: AbortSignal): Promise<SessionSearchValue> {
  const normalized = query.trim()
  if (!normalized || normalized.includes('\0') || normalized.length > 500) throw new PlatformError(400, 'native_search_invalid')
  if ([limits.maxEventBytes, limits.maxHistoryBytes, limits.maxHistoryEvents, limits.searchResultLimit,
    limits.searchSnippetChars, limits.searchDeadlineMs, limits.searchMaxSessions, limits.searchMaxEvents,
    limits.searchMaxBytes].some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.searchDeadlineMs > 2_147_483_647 || limits.searchResultLimit >= Number.MAX_SAFE_INTEGER) {
    throw new PlatformError(500, 'native_search_config_invalid')
  }
  const scope = new SearchScope(limits.searchDeadlineMs, signal)
  try {
    const client = await scope.acquire(pool)
    const connectionErrors: unknown[] = []
    const onError = (error: Error) => { if (connectionErrors.length === 0) connectionErrors.push(error) }
    const ended = Promise.withResolvers<void>()
    client.on('error', onError)
    client.once('end', ended.resolve)
    const read = async <R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> => {
      scope.check()
      if (connectionErrors.length > 0) throw unavailable()
      const pending = client.query<R>(text, values)
      try { return await scope.wait(pending) }
      catch (error: unknown) {
        // Destroying this exclusive connection settles its active PG query before listeners detach.
        try { scope.check() }
        catch (stopped: unknown) { await pending.catch(() => undefined); throw stopped }
        throw error
      }
    }
    const timedRead = async <R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> => {
      const remaining = Math.max(1, Math.ceil(scope.deadline - performance.now()))
      await read("SELECT set_config('statement_timeout',$1,true)", [String(remaining)])
      return read<R>(text, values)
    }
    try {
      await read('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const items = await searchSnapshot(user, normalized, limits, scope, timedRead)
      await read('COMMIT')
      return items
    } catch (error: unknown) {
      try { await read('ROLLBACK') } catch (rollbackError: unknown) { connectionErrors.push(rollbackError) }
      if (error instanceof PlatformError) throw error
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === '57014') {
        throw new PlatformError(504, 'native_search_timeout')
      }
      throw unavailable()
    } finally {
      const destroyed = scope.release(connectionErrors.length > 0)
      if (destroyed) await ended.promise
      client.removeListener('end', ended.resolve)
      client.removeListener('error', onError)
    }
  } catch (error: unknown) {
    if (error instanceof PlatformError) throw error
    throw unavailable()
  } finally { scope.close() }
}

type Reader = <R extends QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>
async function searchSnapshot(user: Identity, query: string, limits: NativeSessionSearchLimits,
  scope: SearchScope, read: Reader): Promise<SessionSearchValue> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    scope.check()
    for (const projection of currentSessionMessageProjections) ctx.sessions.registerMessageProjection(projection)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search',
      defaultLimit: limits.searchResultLimit, maxLimit: limits.searchResultLimit, snippetChars: limits.searchSnippetChars })
    scope.check()
    await loadSnapshot(ctx, user, limits, scope, read)
    const pending = ctx.sessionQuery.searchSessions({ query, limit: limits.searchResultLimit, eventFilters: [
      { kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] },
    ] }, { signal: scope.signal })
    try {
      const page = await scope.wait(pending)
      return { items: page.items.map(({ header, bestMatch }) => ({ sessionId: header.id, snippet: bestMatch.snippet })),
        hasMore: page.nextCursor !== undefined }
    } catch (error: unknown) {
      // Wait for the official service operation to settle before Context disposal closes its database.
      await pending.catch(() => undefined)
      scope.check()
      throw error
    }
  } finally { await ctx.fiber.dispose() }
}

async function loadSnapshot(ctx: Context, user: Identity, limits: NativeSessionSearchLimits,
  scope: SearchScope, read: Reader): Promise<void> {
  let cursor: SearchRow | undefined, sessions = 0, events = 0, bytes = 0
  while (true) {
    const page = await read<SearchRow>(`SELECT id,header,event_count,event_bytes::text AS event_bytes,updated_at::text AS updated_at
      FROM pe_sessions WHERE user_id=$1${cursor === undefined ? '' : `
        AND (updated_at<$3::timestamptz OR (updated_at=$3::timestamptz AND id>$4::uuid))`}
      ORDER BY updated_at DESC,id LIMIT $2`, cursor === undefined ? [user.userId, SESSION_CHUNK]
      : [user.userId, SESSION_CHUNK, cursor.updated_at, cursor.id])
    for (const row of page.rows) {
      if (++sessions > limits.searchMaxSessions) throw budgetExceeded()
      if (row.event_count < 0) throw gap()
      let header: ReturnType<typeof headerSchema.parse>
      try { header = headerSchema.parse(row.header) } catch { throw invalidHistory() }
      if (header.id !== row.id) throw invalidHistory()
      const size = (await read<HistorySize>(`SELECT count(*)::text AS count,
        COALESCE(sum(octet_length(event::text)),0)::text AS bytes,
        COALESCE(max(octet_length(event::text)),0) AS maximum,min(seq) AS first,max(seq) AS last
        FROM pe_events WHERE session_id=$1`, [row.id])).rows[0]
      if (!size || !/^\d+$/u.test(size.count) || !/^\d+$/u.test(size.bytes) || !/^\d+$/u.test(row.event_bytes)) throw gap()
      const actualEvents = BigInt(size.count), actualBytes = BigInt(size.bytes)
      if (actualEvents !== BigInt(row.event_count)
        || (row.event_count === 0 ? size.first !== null || size.last !== null
          : size.first !== 0 || size.last !== row.event_count - 1)) throw gap()
      const budgetBytes = actualBytes > BigInt(row.event_bytes) ? actualBytes : BigInt(row.event_bytes)
      if (actualEvents > BigInt(limits.maxHistoryEvents) || budgetBytes > BigInt(limits.maxHistoryBytes)
        || size.maximum > limits.maxEventBytes || events + Number(actualEvents) > limits.searchMaxEvents
        || bytes + Number(budgetBytes) > limits.searchMaxBytes) throw budgetExceeded()
      events += Number(actualEvents); bytes += Number(budgetBytes)
      const log: SessionEvent[] = []
      let measured = 0, canonicalBytes = 0n
      for (let start = 0; start < row.event_count; start += EVENT_CHUNK) {
        const stop = Math.min(row.event_count, start + EVENT_CHUNK)
        const chunk = await read<{ seq: number; event_json: string }>(
          'SELECT seq,event::text AS event_json FROM pe_events WHERE session_id=$1 AND seq>=$2 AND seq<$3 ORDER BY seq', [row.id, start, stop])
        if (chunk.rows.length !== stop - start) throw gap()
        const raw = chunk.rows.map((item) => {
          const length = Buffer.byteLength(item.event_json)
          measured += length
          if (length > limits.maxEventBytes || measured > limits.maxHistoryBytes || measured > Number(actualBytes)) throw gap()
          let value: unknown
          try { value = JSON.parse(item.event_json) } catch { throw invalidHistory() }
          const canonicalSize = Buffer.byteLength(JSON.stringify(value))
          canonicalBytes += BigInt(canonicalSize)
          if (canonicalSize > limits.maxEventBytes || canonicalBytes > BigInt(limits.maxHistoryBytes)) throw budgetExceeded()
          return value
        })
        let adopted: SessionEvent[]
        try { adopted = parseEvents(header, raw) } catch { throw invalidHistory() }
        for (const [index, event] of adopted.entries()) {
          if (chunk.rows[index]?.seq !== start + index || event.seq !== start + index) throw gap()
          log.push(event)
        }
        await scope.wait(yieldToCarrier())
      }
      if (measured !== Number(actualBytes) || canonicalBytes !== BigInt(row.event_bytes)) throw gap()
      scope.check()
      try {
        const inherited = log.findLastIndex(event => event.type === 'session/end-seed' && event.data.inherited === true)
        if (header.isSeeded ? inherited < 0 : inherited >= 0) throw invalidHistory()
        const session = ctx.sessions.prepare(header.id, { seed: log, meta: header, eventState: 'detached',
          inheritedEventCount: SessionLogOffset(header.isSeeded ? inherited : 0) })
        ctx.effect(() => ctx.sessions.enter(session))
      } catch { throw invalidHistory() }
      scope.check()
      await scope.wait(yieldToCarrier())
    }
    cursor = page.rows.at(-1)
    if (page.rows.length < SESSION_CHUNK) break
  }
  scope.check()
}
