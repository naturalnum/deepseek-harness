/** PG-backed native Session log with append deduplication and lease fencing. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError, type Identity } from '../contracts.ts'
import { parseEvents, headerSchema } from '../session-records.ts'
import { transaction } from './database.ts'
import { checkpointNativeProjections } from './native-projections.ts'
import type { TaskStore } from './tasks.ts'

/** The storage budget bounds both persisted logs and later in-memory restoration. */
export interface EventLimits {
  readonly maxHistoryBytes: number
  readonly maxHistoryEvents: number
  readonly maxEventBytes: number
}

/** Owns Session event bytes; TaskStore owns the accompanying resource and lease rows. */
export class EventStore {
  constructor(private readonly tasks: TaskStore, private readonly limits: EventLimits) {}

  /** Read the assigned Session's complete bounded native log. */
  async runtimeSnapshot(token: string): Promise<unknown> {
    return transaction(this.tasks.pool, async (client) => {
      const row = await this.tasks.authorized(client, token)
      const events = await client.query<{ event: SessionEvent }>(
        'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [row.id],
      )
      return { header: row.header, events: events.rows.map(record => record.event), eventCount: row.event_count }
    })
  }

  /** Append atomically; a retried prefix must match the already committed events exactly. */
  async append(token: string, input: unknown): Promise<{ eventCount: number }> {
    return transaction(this.tasks.pool, async (client) => {
      const row = await this.tasks.authorized(client, token)
      return this.appendInTransaction(client, row, input)
    })
  }

  /** Append canonical events within the caller's existing account and Session locks.
   * @param client Transaction connection; the caller owns commit or rollback.
   * @param row Session authorized by TaskStore on this connection; counters advance with each accepted batch.
   * @param input Foreign event records validated against the native Session vocabulary.
   * @returns Staged event count; publication awaits the caller's commit and final grant fence.
   */
  async appendInTransaction(client: PoolClient, row: Awaited<ReturnType<TaskStore['authorized']>>,
    input: unknown): Promise<{ eventCount: number }> {
    const header = headerSchema.parse(row.header)
    const events = parseEvents(header, input)
    let next = row.event_count
    let bytes = Number(row.event_bytes)
    const appended: SessionEvent[] = []
    for (const event of events) {
      if (event.seq < next) {
        const prior = await client.query<{ event: SessionEvent }>(
          'SELECT event FROM pe_events WHERE session_id=$1 AND seq=$2', [row.id, event.seq],
        )
        if (!isDeepStrictEqual(prior.rows[0]?.event, event)) throw new PlatformError(409, 'event_conflict')
        continue
      }
      if (event.seq !== next) throw new PlatformError(409, 'event_gap')
      const length = Buffer.byteLength(JSON.stringify(event))
      if (length > this.limits.maxEventBytes || bytes + length > this.limits.maxHistoryBytes
        || next >= this.limits.maxHistoryEvents) throw new PlatformError(413, 'history_limit')
      await client.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,$2,$3)', [row.id, next, event])
      appended.push(event)
      next++
      bytes += length
    }
    await client.query('UPDATE pe_sessions SET event_count=$2,event_bytes=$3,updated_at=now() WHERE id=$1', [row.id, next, bytes])
    await checkpointNativeProjections(client, row.user_id, header, row.event_count, appended)
    row.event_count = next
    row.event_bytes = String(bytes)
    return { eventCount: next }
  }

  /** Read an authorized, bounded page at one committed event watermark. */
  async page(user: Identity, sessionId: SessionId, after: number, limit: number): Promise<unknown> {
    return transaction(this.tasks.pool, async (client) => {
      const row = await this.tasks.owned(client, user, sessionId)
      const events = await client.query<{ event: SessionEvent }>(
        'SELECT event FROM pe_events WHERE session_id=$1 AND seq>$2 AND seq<$3 ORDER BY seq LIMIT $4',
        [sessionId, after, row.event_count, limit],
      )
      const operations = await client.query(
        'SELECT id AS "operationId",state,error_code AS "errorCode" FROM pe_operations WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30',
        [sessionId],
      )
      return { header: row.header, events: events.rows.map(record => record.event),
        watermark: row.event_count - 1, operations: operations.rows }
    })
  }
}
