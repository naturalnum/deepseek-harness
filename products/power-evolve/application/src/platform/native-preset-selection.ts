/** Cold native preset selection records the maintained blank-session rule through the PG append owner. */
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Pool } from 'pg'
import { z } from 'zod'
import { sessionId, type Identity, PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { appendOwnedEvents, type OwnedAppendState } from './native-owned-append.ts'
import type { EventLimits } from './events.ts'

/** Native registry resolves the requested id before the carrier submits this exact durable choice. */
export const nativePresetSelection = z.object({ sessionId, agentPreset: z.string().min(1).max(256) }).strict()

/** Select a preset on one owned blank Session after rechecking the browser and writer clocks.
 * @param pool Platform database authority.
 * @param user Authenticated Session owner.
 * @param token Original browser Agent bearer.
 * @param request Exact resolved native preset selection.
 * @param limits Actual native event budgets.
 * @returns The persisted native preset id; later turns compose the same projection.
 */
export async function selectNativePreset(pool: Pool, user: Identity, token: string,
  request: z.infer<typeof nativePresetSelection>, limits: EventLimits): Promise<string> {
  return transaction(pool, async client => {
    const actor = await requireBrowserAccount(client, token, { lock: 'update' })
    if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
    const found = await client.query<OwnedAppendState & { leased: boolean }>(`SELECT id,header,event_count,event_bytes,
      COALESCE(lease_until>clock_timestamp(),false) AS leased FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [request.sessionId, user.userId])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'session_not_found')
    if (row.leased || (await client.query('SELECT 1 FROM pe_native_writers WHERE session_id=$1 AND expires_at>clock_timestamp()', [row.id])).rowCount) {
      throw new PlatformError(409, 'native_session_busy')
    }
    if ((await client.query("SELECT 1 FROM pe_events WHERE session_id=$1 AND event->>'type'='turn/start' LIMIT 1", [row.id])).rowCount) {
      throw new PlatformError(409, 'native_preset_locked')
    }
    const event: SessionEvent = { seq: SessionSeq(row.event_count), time: Date.now(), type: 'agent-preset/selected', data: { agentPreset: request.agentPreset } }
    await appendOwnedEvents(client, user.userId, row, [event], limits)
    return request.agentPreset
  })
}
