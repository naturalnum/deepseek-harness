/** Transactional PG checkpoints of the upstream Session model, inbox and title folds. */
import type { PoolClient } from 'pg'
import { modelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionProjectionBaseline } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { parseEvents } from '../session-records.ts'

const cursor = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value === -1 ? -1 : SessionSeq(value))
const state = z.object({ version: z.literal(1), asOfSeq: cursor,
  modelSelection: modelSelectionProjection.stateSchema,
  inbox: inboxProjectionDefinition.stateSchema,
  title: titleProjectionDefinition.stateSchema }).strict()
type State = z.infer<typeof state>
const encodedState = z.object({ version: z.literal(2), asOfSeq: cursor, stateJson: z.string() }).strict()

function checkpoint(raw: unknown): State {
  const encoded = encodedState.safeParse(raw)
  if (!encoded.success) return state.parse(raw)
  const decoded = state.parse(JSON.parse(encoded.data.stateJson))
  if (decoded.asOfSeq !== encoded.data.asOfSeq) throw new PlatformError(503, 'native_projection_gap')
  return decoded
}

function empty(): State {
  return { version: 1, asOfSeq: -1, modelSelection: modelSelectionProjection.init(),
    inbox: inboxProjectionDefinition.init(), title: titleProjectionDefinition.init() }
}

function advance(prior: State, events: readonly SessionEvent[]): State {
  let value = prior
  for (const event of events) {
    if (event.seq !== value.asOfSeq + 1) throw new PlatformError(503, 'native_projection_gap')
    value = { version: 1, asOfSeq: event.seq,
      modelSelection: modelSelectionProjection.apply(value.modelSelection, event),
      inbox: inboxProjectionDefinition.apply(value.inbox, event),
      title: titleProjectionDefinition.apply(value.title, event) }
  }
  return value
}

/** Project a stored checkpoint without opening or activating a Session.
 * @param raw Private PG checkpoint, or absence for a new Session.
 * @param eventCount Committed native event count at the same database cut.
 * @returns Standard native values at the exact watermark; missing or stale history rejects.
 */
export function nativeProjectionView(raw: unknown, eventCount: number): SessionProjectionBaseline {
  const value = raw === null || raw === undefined ? empty() : checkpoint(raw)
  if (value.asOfSeq !== eventCount - 1) throw new PlatformError(503, 'native_projection_gap')
  return { asOfSeq: value.asOfSeq, values: z.record(z.string(), z.json()).parse({
    modelSelection: modelSelectionProjection.wire.viewSchema.parse(modelSelectionProjection.wire.view(value.modelSelection)),
    inbox: inboxProjectionDefinition.wire.viewSchema.parse(inboxProjectionDefinition.wire.view(value.inbox)),
    title: titleProjectionDefinition.wire.viewSchema.parse(titleProjectionDefinition.wire.view(value.title)),
  }) }
}

/** Checkpoint the same event prefix inside the writer's transaction and Session lock.
 * @param client Exclusive PG transaction already authorized for the owner and Session.
 * @param userId Platform-derived owner identity.
 * @param header Validated native Session header.
 * @param eventCount Event count before this append.
 * @param events Newly appended contiguous events; replayed records are omitted.
 */
export async function checkpointNativeProjections(client: PoolClient, userId: string,
  header: SessionHeader, eventCount: number, events: readonly SessionEvent[]): Promise<void> {
  const namespace = `session-projections:${header.id}`
  const stored = await client.query<{ value: unknown }>(
    'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2 FOR UPDATE', [userId, namespace])
  let prior = stored.rows[0] === undefined ? empty() : checkpoint(stored.rows[0].value)
  if (prior.asOfSeq > eventCount - 1) throw new PlatformError(503, 'native_projection_gap')
  if (prior.asOfSeq < eventCount - 1) {
    const suffix = await client.query<{ event: unknown }>(
      'SELECT event FROM pe_events WHERE session_id=$1 AND seq>$2 AND seq<$3 ORDER BY seq', [header.id, prior.asOfSeq, eventCount])
    prior = advance(prior, parseEvents(header, suffix.rows.map(row => row.event)))
  }
  if (prior.asOfSeq !== eventCount - 1) throw new PlatformError(503, 'native_projection_gap')
  const next = advance(prior, events)
  await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)
    ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`,
  // JSON text inside jsonb retains strings PostgreSQL cannot represent directly, including NUL and lone surrogates.
  [userId, namespace, encodedState.parse({ version: 2, asOfSeq: next.asOfSeq, stateJson: JSON.stringify(state.parse(next)) })])
}
