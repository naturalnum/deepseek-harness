/** Tenant-scoped cold reads for the native DSH Web Session protocol. */
import type { Pool, PoolClient } from 'pg'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { isAppendSurfaceEvent, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionFollowFrame, SessionListValue, SessionPage, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { sessionId, type Identity, PlatformError } from '../contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { transaction } from './database.ts'
import { nativeProjectionView } from './native-projections.ts'
import { nativeAssistantBytes } from '../native-assistant-records.ts'
import type { NativeAssistantRead, NativeAssistantPosition, NativeAssistantContinuation } from './native-assistant-read.ts'

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
  lease_epoch: number
  created_at: Date
  updated_at: Date
  running: boolean
  projection_state: unknown
}

/** Private Host opening retains the generation cursor outside the official Client frame. */
export interface NativeSessionOpening {
  readonly snapshot: Extract<SessionFollowFrame, { type: 'snapshot' }>
  readonly position: NativeAssistantPosition | null
}

/** The platform remains the authority for ownership and the committed event watermark. */
export class NativeSessionRead {
  /**
   * @param pool Platform-owned PG connection pool.
   * @param imageLimits Boot-constant public image intake limits from the same Platform configuration as SDK admission.
   */
  constructor(private readonly pool: Pool, private readonly imageLimits?: ImageAttachmentLimits) {}

  private projections(row: NativeSessionRow) {
    const baseline = nativeProjectionView(row.projection_state, row.event_count)
    return this.imageLimits === undefined ? baseline : { ...baseline,
      values: z.record(z.string(), z.json()).parse({ ...baseline.values, imageLimits: this.imageLimits }) }
  }

  /** A reconnecting native client may reselect an owned, still-empty Session. */
  async adoptBlank(user: Identity, id: SessionId): Promise<{ sessionId: SessionId }> {
    return transaction(this.pool, async (client) => {
      const row = await ownedSnapshot(client, user, id)
      if (await hasTurn(client, row)) throw new PlatformError(409, 'session_not_blank')
      return { sessionId: id }
    })
  }

  async list(user: Identity): Promise<SessionListValue> {
    const result = await this.pool.query<NativeSessionRow>(
      `SELECT s.id,s.header,s.event_count,s.lease_epoch,s.created_at,s.updated_at,COALESCE(s.lease_until>now(),FALSE) AS running,
        p.value AS projection_state FROM pe_sessions s LEFT JOIN pe_native_preferences p
          ON p.user_id=s.user_id AND p.namespace='session-projections:'||s.id::text
       WHERE s.user_id=$1 ORDER BY s.updated_at DESC,s.id LIMIT $2`,
      [user.userId, MAX_LIST_SESSIONS + 1],
    )
    if (result.rows.length > MAX_LIST_SESSIONS) throw new PlatformError(413, 'native_session_list_limit')
    const items: SessionSummary[] = []
    for (const row of result.rows) {
      const header = headerSchema.parse(row.header)
      items.push({
        sessionId: header.id,
        updatedAt: row.updated_at.getTime(),
        agentAvailable: row.running,
        running: row.running,
        blank: !await hasTurn(this.pool, row),
        ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
        cwd: '/workspace',
        projections: { kind: 'sequenced', ...this.projections(row) },
      })
    }
    return { items }
  }

  async page(user: Identity, request: z.infer<typeof nativePageRequest>): Promise<SessionPage> {
    const parsed = nativePageRequest.parse(request)
    return transaction(this.pool, async (client) => {
      const row = await ownedSnapshot(client, user, parsed.address.sessionId)
      if (parsed.throughSeq >= row.event_count) throw new PlatformError(400, 'native_page_future_cursor')
      return readWindow(client, row, parsed)
    })
  }

  /** One stable opening frame; the Host stream then polls for later events. */
  async snapshot(user: Identity, request: z.infer<typeof nativeFollowRequest>): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
    const parsed = nativeFollowRequest.parse(request)
    return transaction(this.pool, async (client) => {
      const row = await ownedSnapshot(client, user, parsed.address.sessionId)
      const cursor = row.event_count - 1
      const page = await readWindow(client, row, { ...parsed, throughSeq: cursor })
      const header = headerSchema.parse(row.header)
      return {
        type: 'snapshot',
        header: { ...header, cwd: '/workspace' },
        cursor,
        ...page,
        projections: this.projections(row),
        ...(parsed.assistantStream ? { assistantStream: { revision: 0 } } : {}),
      }
    })
  }

  /** A bounded contiguous suffix, re-authorized on every polling read. */
  async after(user: Identity, sessionId: SessionId, cursor: number, limit = READ_CHUNK): Promise<readonly SessionEvent[]> {
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw new PlatformError(400, 'native_cursor_invalid')
    return transaction(this.pool, async (client) => {
      const row = await ownedSnapshot(client, user, sessionId)
      const start = cursor + 1
      const end = Math.min(row.event_count, start + Math.min(limit, READ_CHUNK))
      if (start >= end) return []
      return readEvents(client, row, start, end, false)
    })
  }

  /** Open one official history and assistant baseline at the same tenant-authorized PG cut.
   * @param user Browser-authenticated Session owner.
   * @param request Opted-in native Session follow request.
   * @param presentation Deployment-configured temporary presentation reader.
   * @param maxOpeningBytes Complete private response budget, including history and projection metadata.
   * @returns Official opening frame and a private cursor used only by its Host follower.
   */
  async opening(user: Identity, request: z.infer<typeof nativeFollowRequest>, presentation: NativeAssistantRead,
    maxOpeningBytes: number): Promise<NativeSessionOpening> {
    const parsed = nativeFollowRequest.parse(request)
    if (parsed.assistantStream !== true) throw new PlatformError(400, 'native_assistant_required')
    return transaction(this.pool, async (client) => {
      const row = await ownedSnapshot(client, user, parsed.address.sessionId)
      const cursor = row.event_count - 1
      const header = headerSchema.parse(row.header)
      const page = await readWindow(client, row, { ...parsed, throughSeq: cursor })
      const opening = await presentation.open(client, { sessionId: parsed.address.sessionId,
        header, eventCount: row.event_count, leaseEpoch: row.lease_epoch })
      const value: NativeSessionOpening = { snapshot: { type: 'snapshot', header: { ...header, cwd: '/workspace' },
        cursor, ...page, projections: this.projections(row),
        assistantStream: opening.baseline }, position: opening.position }
      if (nativeAssistantBytes(value) > maxOpeningBytes) throw new PlatformError(413, 'native_assistant_opening_budget')
      return value
    })
  }

  /** Read original event/frame order while keeping the same Session ownership and PG watermark.
   * @param user Browser-authenticated Session owner, rechecked for each poll.
   * @param sessionId Exact receiving native Session.
   * @param cursor Last canonical seq emitted to this follow generation.
   * @param position Private presentation generation cursor from its opening or previous response.
   * @param presentation Deployment-configured reader; it never opens a separate transaction.
   * @returns Ordered bounded frames, or normal generation retirement requiring a new opening.
   */
  async presentationAfter(user: Identity, sessionId: SessionId, cursor: number,
    position: NativeAssistantPosition | null, presentation: NativeAssistantRead): Promise<NativeAssistantContinuation> {
    return transaction(this.pool, async (client) => {
      const row = await ownedSnapshot(client, user, sessionId)
      return presentation.after(client, { sessionId, header: headerSchema.parse(row.header),
        eventCount: row.event_count, leaseEpoch: row.lease_epoch }, position, cursor, READ_CHUNK)
    })
  }
}

async function ownedSnapshot(client: PoolClient, user: Identity, sessionId: string): Promise<NativeSessionRow> {
  const result = await client.query<NativeSessionRow>(
    `SELECT id,header,event_count,lease_epoch,created_at,updated_at,COALESCE(lease_until>now(),FALSE) AS running
     FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE`, [sessionId, user.userId],
  )
  const row = result.rows[0]
  if (!row) throw new PlatformError(404, 'session_not_found')
  const checkpoint = await client.query<{ value: unknown }>(
    'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
    [user.userId, `session-projections:${row.id}`])
  return { ...row, projection_state: checkpoint.rows[0]?.value }
}

async function hasTurn(client: Pool | PoolClient, row: NativeSessionRow): Promise<boolean> {
  for (let start = 0; start < row.event_count; start += READ_CHUNK) {
    const events = await readEvents(client, row, start, Math.min(row.event_count, start + READ_CHUNK), false)
    if (events.some(event => event.type === 'turn/start')) return true
  }
  return false
}

async function readEvents(client: Pool | PoolClient, row: NativeSessionRow, start: number, end: number,
  reverse: boolean): Promise<SessionEvent[]> {
  const result = await client.query<{ seq: number; event: unknown }>(
    `SELECT seq,event FROM pe_events WHERE session_id=$1 AND seq>=$2 AND seq<$3
     ORDER BY seq ${reverse ? 'DESC' : 'ASC'}`, [row.id, start, end],
  )
  if (result.rows.length !== end - start) throw new PlatformError(500, 'native_history_gap')
  let events: SessionEvent[]
  try { events = parseEvents(headerSchema.parse(row.header), result.rows.map(item => item.event)) }
  catch (_invalidStoredRecord) { throw new PlatformError(500, 'native_history_invalid') }
  for (const [index, item] of result.rows.entries()) {
    const expected = reverse ? end - 1 - index : start + index
    if (item.seq !== expected || events[index]?.seq !== expected) throw new PlatformError(500, 'native_history_gap')
  }
  return events
}

async function readWindow(client: PoolClient, row: NativeSessionRow, request: z.infer<typeof nativePageRequest>): Promise<SessionPage> {
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
    const batch = await readEvents(client, row, Math.max(0, next - READ_CHUNK), next, true)
    for (const event of batch) {
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
    const batch = await readEvents(client, row, Math.max(cut, next - READ_CHUNK), next, true)
    for (const event of batch) { reverse.push(event); next = event.seq }
  }
  const events = reverse.filter(event => event.seq >= cut).reverse()
  return { records: events.map(event => ({ type: 'event', event: event as SessionPage['records'][number]['event'] })), hasMore: cut > 0 }
}
