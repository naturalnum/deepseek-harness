/** Native Session title, search and exact-prefix forks over tenant-owned PostgreSQL logs. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { type SessionId, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import { modelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionSearchValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { PlatformError, type Identity, type RequestId } from '../contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { transaction } from './database.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { appendOwnedEvents, type OwnedAppendState } from './native-owned-append.ts'
import { nativeSessionRename, nativeSessionFork, nativeModelSelect } from '../native-session-contracts.ts'
import { searchNativeSessions, type NativeSessionSearchLimits } from './native-session-search.ts'
import { inheritLegacyImageBindings } from './legacy-migration-v2-image-reader.ts'
import { inheritNativeImageBindings } from './native-images.ts'

interface ForkRow extends OwnedAppendState { workspace_id: string }
/** Limits applied to native title acceptance and Session search results. */
export interface NativeSessionCommandLimits extends NativeSessionSearchLimits {
  readonly titleMaxBytes: number
}

/** Platform owns title writes, native fork lineage and authorized message-content search. */
export class NativeSessionCommands {
  constructor(private readonly pool: Pool, private readonly limits: NativeSessionCommandLimits) {}

  /** Commit one user-owned title event when no leased writer can race its sequence.
   * @param user Authenticated Session owner.
   * @param token Current browser credential rechecked under the account update lock.
   * @param request Proposed title for an owned Session.
   * @returns Normalized title and its committed native sequence; a live writer refuses the cold write.
   */
  async rename(user: Identity, token: string, request: z.infer<typeof nativeSessionRename>): Promise<{ title: string; seq: number }> {
    const title = normalizeSessionTitle(request.title, this.limits.titleMaxBytes)
    if (!title) throw new PlatformError(400, 'native_title_invalid', { sessionId: request.sessionId })
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, token, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const result = await client.query<OwnedAppendState & { leased: boolean }>(`SELECT id,header,event_count,event_bytes,
        COALESCE(lease_until>clock_timestamp(),false) AS leased FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [request.sessionId, user.userId])
      const row = result.rows[0]
      if (!row) throw new PlatformError(404, 'session_not_found')
      if (row.leased) throw new PlatformError(409, 'native_session_busy')
      const event: SessionEvent = { seq: SessionSeq(row.event_count), time: Date.now(), type: 'session/title',
        data: { title, messageSeqs: [], source: { kind: 'user' } } }
      await appendOwnedEvents(client, user.userId, row, [event], this.limits)
      return { title, seq: event.seq }
    })
  }

  /** Search the current owned user and assistant messages through the configured search provider.
   * @param user Authenticated owner.
   * @param query Literal content query.
   * @param signal Caller lifetime for database and search work.
   * @returns One bounded snippet per matching Session and an explicit remaining-result flag.
   */
  async search(user: Identity, query: string, signal?: AbortSignal): Promise<SessionSearchValue> {
    return searchNativeSessions(this.pool, user, query, this.limits, signal)
  }

  /** Fork one exact committed native prefix, retaining workspace ownership and lineage.
   * @param user Authenticated source owner.
   * @param token Current browser credential rechecked under the account update lock.
   * @param request Native source and optional inclusive event cursor.
   * @param requestId Stable transport identity for this fork operation.
   * @returns New Session identity; matching retries reuse the committed fork.
   */
  async fork(user: Identity, token: string, request: z.infer<typeof nativeSessionFork>,
    requestId: RequestId): Promise<{ sessionId: SessionId }> {
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, token, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const source = await client.query<ForkRow>(`SELECT id,header,event_count,event_bytes,workspace_id FROM pe_sessions
        WHERE id=$1 AND user_id=$2 FOR SHARE`, [request.sessionId, user.userId])
      const row = source.rows[0]
      if (!row) throw new PlatformError(404, 'session_not_found')
      const prior = await client.query<{ id: string; value: unknown }>(`SELECT s.id,p.value FROM pe_sessions s
        LEFT JOIN pe_native_preferences p ON p.user_id=s.user_id AND p.namespace='session-fork:'||s.id::text
        WHERE s.user_id=$1 AND s.create_request_id=$2`, [user.userId, requestId])
      if (prior.rows[0]) {
        const saved = nativeSessionFork.safeParse(prior.rows[0].value)
        if (!saved.success || saved.data.sessionId !== request.sessionId || saved.data.atSeq !== request.atSeq) throw new PlatformError(409, 'request_id_conflict')
        return { sessionId: brandString<SessionId>(prior.rows[0].id) }
      }
      const stored = await client.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [row.id])
      const events = parseEvents(headerSchema.parse(row.header), stored.rows.map(value => value.event))
      if (events.length !== row.event_count || events.some((event, index) => event.seq !== index)) throw new PlatformError(503, 'native_history_gap')
      let boundary = request.atSeq
      if (boundary === undefined) {
        const end = events.findLast(event => event.type === 'turn/end')
        if (end) {
          boundary = end.seq
          for (const event of events.slice(end.seq + 1)) {
            if (event.type === 'turn/start' || event.type === 'user/message' && event.surfaceOp === 'append') break
            boundary = event.seq
          }
        }
      }
      if (boundary === undefined || events[boundary]?.seq !== boundary) throw new PlatformError(409, 'native_fork_unavailable', { sessionId: request.sessionId })
      const seed = buildForkSeed(events, SessionSeq(boundary))
      const id = brandString<SessionId>(randomUUID())
      const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION,
        createdAt: Date.now(), isSeeded: true, parentSession: request.sessionId }
      await client.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header)
        VALUES($1,$2,$3,$4,$5)`, [id, user.userId, row.workspace_id, requestId, header])
      await appendOwnedEvents(client, user.userId, { id, header, event_count: 0, event_bytes: '0' }, seed, this.limits)
      const attachments = new Map<string, FileAttachmentRef>()
      for (const event of seed) {
        if (event.type !== 'user/message') continue
        for (const part of event.data.content) {
          if (part.type === 'file') attachments.set(JSON.stringify(part.attachment), part.attachment)
        }
      }
      for (const attachment of attachments.values()) {
        const original = await client.query<{ storage_session_id: string; request_id: string }>(
          `SELECT storage_session_id,request_id FROM pe_native_file_receipts WHERE user_id=$1 AND session_id=$2
            AND request_id IS NOT NULL AND file=$3::jsonb LIMIT 1`, [user.userId, request.sessionId, attachment])
        const stored = original.rows[0]
        if (stored === undefined) throw new PlatformError(503, 'native_fork_attachment_unavailable')
        await client.query(`INSERT INTO pe_native_file_receipts(id,user_id,session_id,storage_session_id,file,request_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), user.userId, id, stored.storage_session_id, attachment, stored.request_id])
      }
      await inheritLegacyImageBindings(client, user.userId, request.sessionId, id, boundary + 1, this.limits.maxHistoryBytes)
      await inheritNativeImageBindings(client, user.userId, request.sessionId, id, seed, this.limits.maxHistoryBytes)
      let modelState = modelSelectionProjection.stateSchema.parse(modelSelectionProjection.init())
      for (const event of seed) modelState = modelSelectionProjection.apply(modelState, event)
      const model = modelSelectionProjection.wire.view(modelState).next
      if (model !== null) {
        const selected = nativeModelSelect.parse({ sessionId: id, ...model,
          reasoningEffort: model.reasoningEffort ?? 'off' })
        await client.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)',
          [user.userId, `session-model:${id}`, { provider: selected.provider, model: selected.model, reasoningEffort: 'off' }])
      }
      await client.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)',
        [user.userId, `session-fork:${id}`, request])
      return { sessionId: id }
    })
  }
}
