/** Tenant-scoped cold reads for the native DSH Web Session protocol. */
import type { Pool, PoolClient } from 'pg'
import { isAppendSurfaceEvent, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionFollowFrame, SessionListValue, SessionPage, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { sessionId, type Identity, PlatformError } from '../contracts.ts'
import { headerSchema } from '../session-records.ts'
import { transaction } from './database.ts'

const MAX_LIST_SESSIONS = 1000
const MAX_PAGE_MESSAGES = 500
const READ_CHUNK = 256
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const address = z.object({ kind: z.literal('session'), sessionId }).strict()
const turnWindow = z.object({ minMessages: z.number().int().positive(), minTurns: z.number().int().positive() }).strict()
const windowRequest = z.object({
  address,
  maxMessages: z.number().int().min(1).max(MAX_PAGE_MESSAGES).optional(),
  turnWindow: turnWindow.optional(),
}).strict()
export const nativePageRequest = windowRequest.extend({
  throughSeq: z.number().int().min(-1), beforeSeq: z.number().int().nonnegative().optional(),
}).strict().superRefine(validateWindow)
export const nativeFollowRequest = windowRequest.extend({
  assistantStream: z.literal(true).optional(),
}).strict().superRefine(validateWindow)

function validateWindow(value: { maxMessages?: number | undefined; turnWindow?: { minMessages: number; minTurns: number } | undefined },
  refinement: z.RefinementCtx): void {
  if (value.turnWindow && value.turnWindow.minMessages > (value.maxMessages ?? 50)) {
    refinement.addIssue({ code: 'custom', message: 'turnWindow.minMessages exceeds maxMessages' })
  }
}

interface NativeSessionRow {
  id: string
  header: unknown
  event_count: number
  created_at: Date
  updated_at: Date
  running: boolean
}

/** The platform remains the authority for ownership and the committed event watermark. */
export class NativeSessionRead {
  constructor(private readonly pool: Pool) {}

  /** A reconnecting native client may reselect an owned, still-empty Session. */
  async adoptBlank(user: Identity, id: SessionId): Promise<{ sessionId: SessionId }> {
    const result = await this.pool.query<{ event_count: number }>(
      'SELECT event_count FROM pe_sessions WHERE id=$1 AND user_id=$2', [id, user.userId],
    )
    if (!result.rows[0]) throw new PlatformError(404, 'session_not_found')
    if (result.rows[0].event_count !== 0) throw new PlatformError(409, 'session_not_blank')
    return { sessionId: id }
  }

  async list(user: Identity): Promise<SessionListValue> {
    const result = await this.pool.query<NativeSessionRow>(
      `SELECT id,header,event_count,created_at,updated_at,COALESCE(lease_until>now(),FALSE) AS running
       FROM pe_sessions WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT $2`,
      [user.userId, MAX_LIST_SESSIONS + 1],
    )
    if (result.rows.length > MAX_LIST_SESSIONS) throw new PlatformError(413, 'native_session_list_limit')
    const items: SessionSummary[] = result.rows.map(row => {
      const header = headerSchema.parse(row.header)
      return {
        sessionId: header.id,
        updatedAt: row.updated_at.getTime(),
        agentAvailable: row.running,
        running: row.running,
        blank: row.event_count === 0,
        cwd: '/workspace',
      }
    })
    return { items }
  }

  async page(user: Identity, request: z.infer<typeof nativePageRequest>): Promise<SessionPage> {
    const parsed = nativePageRequest.parse(request)
    return transaction(this.pool, async client => {
      const row = await ownedSnapshot(client, user, parsed.address.sessionId)
      if (parsed.throughSeq >= row.event_count) throw new PlatformError(400, 'native_page_future_cursor')
      return readWindow(client, row.id, parsed)
    })
  }

  /** One stable opening frame; the Host stream then polls for later events. */
  async snapshot(user: Identity, request: z.infer<typeof nativeFollowRequest>): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
    const parsed = nativeFollowRequest.parse(request)
    return transaction(this.pool, async client => {
      const row = await ownedSnapshot(client, user, parsed.address.sessionId)
      const cursor = row.event_count - 1
      const page = await readWindow(client, row.id, { ...parsed, throughSeq: cursor })
      const header = headerSchema.parse(row.header)
      return {
        type: 'snapshot',
        header: { ...header, cwd: '/workspace' },
        cursor,
        ...page,
        projections: { asOfSeq: cursor, values: {} },
        ...(parsed.assistantStream ? { assistantStream: { revision: 0 } } : {}),
      }
    })
  }

  /** A bounded contiguous suffix, re-authorized on every polling read. */
  async after(user: Identity, sessionId: SessionId, cursor: number, limit = READ_CHUNK): Promise<readonly SessionEvent[]> {
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw new PlatformError(400, 'native_cursor_invalid')
    return transaction(this.pool, async client => {
      const row = await ownedSnapshot(client, user, sessionId)
      const result = await client.query<{ event: SessionEvent }>(
        `SELECT event FROM pe_events WHERE session_id=$1 AND seq>$2 AND seq<$3
         ORDER BY seq LIMIT $4`, [row.id, cursor, row.event_count, Math.min(limit, READ_CHUNK)],
      )
      return result.rows.map(item => item.event)
    })
  }
}

async function ownedSnapshot(client: PoolClient, user: Identity, sessionId: string): Promise<NativeSessionRow> {
  const result = await client.query<NativeSessionRow>(
    `SELECT id,header,event_count,created_at,updated_at,COALESCE(lease_until>now(),FALSE) AS running
     FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE`, [sessionId, user.userId],
  )
  const row = result.rows[0]
  if (!row) throw new PlatformError(404, 'session_not_found')
  return row
}

async function readWindow(client: PoolClient, sessionId: string, request: z.infer<typeof nativePageRequest>): Promise<SessionPage> {
  const maxMessages = request.maxMessages ?? 50
  const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1)
  if (end <= 0) return { records: [], hasMore: false }
  const reverse: SessionEvent[] = []
  let next = end
  let messages = 0
  let turns = 0
  let cut = 0
  let complete = false
  while (next > 0 && !complete) {
    const batch = await client.query<{ event: SessionEvent }>(
      `SELECT event FROM pe_events WHERE session_id=$1 AND seq<$2
       ORDER BY seq DESC LIMIT $3`, [sessionId, next, READ_CHUNK],
    )
    if (batch.rows.length === 0) throw new PlatformError(500, 'native_history_gap')
    for (const { event } of batch.rows) {
      reverse.push(event)
      next = event.seq
      if (request.turnWindow && event.type === 'turn/start') {
        turns++
        if (messages >= request.turnWindow.minMessages && turns >= request.turnWindow.minTurns) {
          cut = event.seq
          complete = true
          break
        }
      }
      if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
      messages++
      let groupStart = event.seq
      if (event.sourceEventSeqs) {
        for (const source of event.sourceEventSeqs) if (source < groupStart) groupStart = source
      }
      if (messages >= maxMessages) {
        cut = groupStart
        complete = true
        break
      }
    }
    if (next === 0) complete = true
  }
  // A replacement message can refer to earlier events. Include that entire source group.
  while (next > cut) {
    const batch = await client.query<{ event: SessionEvent }>(
      `SELECT event FROM pe_events WHERE session_id=$1 AND seq<$2 AND seq>=$3
       ORDER BY seq DESC LIMIT $4`, [sessionId, next, cut, READ_CHUNK],
    )
    if (!batch.rows.length) throw new PlatformError(500, 'native_history_gap')
    for (const { event } of batch.rows) { reverse.push(event); next = event.seq }
  }
  const events = reverse.filter(event => event.seq >= cut).reverse()
  return { records: events.map(event => ({ type: 'event', event: event as SessionPage['records'][number]['event'] })), hasMore: cut > 0 }
}
