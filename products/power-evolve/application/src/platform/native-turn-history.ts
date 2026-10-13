/** Bounded native inbox/turn accounting used by continuation transactions. */
import type { PoolClient } from 'pg'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'

/** Explicit bounds for the native prefix read under the caller's Session lock. */
export interface NativeTurnHistoryLimits { readonly maxHistoryEvents: number; readonly maxHistoryBytes: number }
/** Original inbox input removed by the native driver inside its exact turn. */
export interface NativeTurnClaim {
  readonly message: UserMessage
  readonly turn: number
  readonly turnStartSeq: number
  readonly claimSeq: number
}
/** Authoritative committed inbox state and consumption identities. */
export interface NativeTurnHistory {
  readonly events: readonly SessionEvent[]
  readonly eventCount: number
  readonly queueRevision: number
  readonly nextTurn: readonly UserMessage[]
  readonly nextStep: readonly UserMessage[]
  readonly claims: readonly NativeTurnClaim[]
}

const storedSession = z.object({ header: headerSchema, eventCount: z.number().int().nonnegative(),
  eventBytes: z.string().regex(/^\d+$/u).transform(Number) })

/** Read and fold the exact native prefix while the caller owns account/Session/Writer locks.
 * @param client Existing exclusive transaction connection.
 * @param sessionId Authorized Session identity.
 * @param limits Deployment-owned bounds, checked before loading native events.
 * @returns Current inbox lists and precise consumed message/turn associations.
 */
export async function readNativeTurnHistory(client: PoolClient, sessionId: SessionId,
  limits: NativeTurnHistoryLimits): Promise<NativeTurnHistory> {
  const stored = await client.query<Record<string, unknown>>(`SELECT header,event_count AS "eventCount",
    event_bytes::text AS "eventBytes" FROM pe_sessions WHERE id=$1`, [sessionId])
  const value = storedSession.parse(stored.rows[0])
  if (value.header.id !== sessionId || value.eventCount > limits.maxHistoryEvents
    || value.eventBytes > limits.maxHistoryBytes) throw new PlatformError(413, 'native_turn_history_budget')
  const result = await client.query<{ seq: number; event: unknown }>(
    'SELECT seq,event FROM pe_events WHERE session_id=$1 ORDER BY seq LIMIT $2', [sessionId, limits.maxHistoryEvents + 1])
  if (result.rows.length !== value.eventCount || result.rows.some((row, index) => row.seq !== index)) {
    throw new PlatformError(503, 'native_turn_history_gap')
  }
  const events = parseEvents(value.header, result.rows.map(row => row.event))
  if (events.some((event, index) => event.seq !== index)) throw new PlatformError(503, 'native_turn_history_gap')
  if (events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) > limits.maxHistoryBytes) {
    throw new PlatformError(413, 'native_turn_history_budget')
  }
  let inbox = inboxProjectionDefinition.init()
  let start: SessionEvent<'turn/start'> | undefined
  let queueRevision = -1
  const claims: NativeTurnClaim[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (start !== undefined) throw new PlatformError(503, 'native_turn_history_unbalanced')
      start = event
    } else if (event.type === 'turn/end') {
      if (start?.data.turn !== event.data.turn) throw new PlatformError(503, 'native_turn_history_unbalanced')
      start = undefined
    } else if (event.type === 'agent/inbox/spliced') {
      const removed = inbox[event.data.target].slice(event.data.start, event.data.start + (event.data.removedCount ?? 0))
      inbox = inboxProjectionDefinition.apply(inbox, event)
      queueRevision = event.seq
      if (event.data.outcome !== 'canceled' && removed.length > 0) {
        if (start === undefined || event.data.inserted.length > 0) throw new PlatformError(503, 'native_turn_claim_invalid')
        for (const message of removed) {
          if (claims.some(prior => prior.message.id === message.id)) throw new PlatformError(409, 'native_turn_input_replayed')
          claims.push({ message, turn: start.data.turn, turnStartSeq: start.seq, claimSeq: event.seq })
        }
      }
    }
  }
  return { events, eventCount: value.eventCount, queueRevision,
    nextTurn: inbox['next-turn'], nextStep: inbox['next-step'], claims }
}

/** Select one closed consumed turn rather than the latest ending in a Session suffix.
 * @param history Authoritative native prefix.
 * @param messageId Message pinned by the prepared operation frame.
 * @returns Exact native claim, accounting end and resulting operation settlement.
 */
export function closedNativeTurn(history: NativeTurnHistory, messageId: MessageId) {
  const claimed = history.claims.find(item => item.message.id === messageId)
  if (!claimed) throw new PlatformError(409, 'native_turn_not_claimed')
  if (history.claims.filter(item => item.turnStartSeq === claimed.turnStartSeq).length !== 1) {
    throw new PlatformError(409, 'native_turn_cohort_unsupported')
  }
  const end = history.events.find(event => event.type === 'turn/end' && event.seq > claimed.turnStartSeq
    && event.data.turn === claimed.turn)
  if (end?.type !== 'turn/end') throw new PlatformError(409, 'native_turn_not_closed')
  const consumed = foldConsumedWork(history.events.slice(claimed.turnStartSeq, end.seq + 1))
  if (consumed.end?.seq !== end.seq) throw new PlatformError(409, 'native_turn_unaccounted')
  return { claimed, end, outcome: end.data.reason.kind === 'completed' ? 'completed' as const : 'failed' as const,
    errorCode: end.data.reason.kind === 'completed' ? null : `turn_${end.data.reason.kind}` }
}
