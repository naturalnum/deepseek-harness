/** Strict JSON records and bounded native history used by the input ledger. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PlatformError } from './contracts.ts'
import { inputOrigin, inputRevision, inputClaim, inputCohort, inputCommandReceipt, admittedInputMessage,
  eventSeq, type InputOrigin, type InputRevision, type InputClaim, type InputCohort, type InputCommandReceipt,
  type NativeInputFrozenSnapshot, type NativeInputLedgerLimits } from './native-input-ledger-contracts.ts'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { headerSchema, parseEvents } from './session-records.ts'
import type { PoolClient } from 'pg'
import type { SessionId, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

type Json = z.infer<ReturnType<typeof z.json>>

/** Order already validated JSON object keys without changing values or array order.
 * @param value Complete JSON value whose wire or durable parser has already accepted it.
 * @returns The same JSON values with object keys in canonical code-unit order.
 */
export function orderNativeInputJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(orderNativeInputJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, orderNativeInputJson(child)]))
}

/** Hash all exact JSON values with stable object-key order and unchanged arrays.
 * @param value Foreign or durable JSON metadata; unsupported or lossy JSON values refuse.
 * @returns SHA-256 of UTF-8 canonical JSON; no metadata is dropped or merged.
 */
export function nativeInputRecordDigest(value: unknown): string {
  const parsed = z.json().safeParse(value)
  if (!parsed.success) throw new PlatformError(503, 'native_input_json_corrupt')
  return createHash('sha256').update(JSON.stringify(orderNativeInputJson(parsed.data))).digest('hex')
}

/** Use the ledger JSON algorithm for the complete original tokenless frame snapshot.
 * @param snapshot Strictly decoded original frozen Grant metadata, with image references retained.
 * @returns The same canonical SHA-256 used at frame creation and after PG jsonb reads.
 */
export function ledgerFrozenSnapshotDigest(snapshot: NativeInputFrozenSnapshot): string {
  return nativeInputRecordDigest(snapshot)
}

function corrupt(): never { throw new PlatformError(503, 'native_input_ledger_corrupt') }

/** Decode an immutable origin and recompute all original admission metadata.
 * @param value Durable JSON/column aliases loaded under the Session lock.
 * @returns Accurate logical origin; missing fields or a digest mismatch refuse.
 */
export function readInputOrigin(value: unknown): InputOrigin {
  const result = inputOrigin.safeParse(value)
  const raw = z.object({ acceptedAudit: z.json() }).safeParse(value)
  if (!result.success || !raw.success || nativeInputRecordDigest(raw.data.acceptedAudit) !== result.data.acceptedSnapshotDigest
    || nativeInputRecordDigest(result.data.acceptedAudit) !== result.data.acceptedSnapshotDigest) corrupt()
  return result.data
}

/** Decode an immutable revision without accepting a caller's claimed digest.
 * @param value Durable revision fields.
 * @returns Accurate complete message and native insertion coordinate.
 */
export function readInputRevision(value: unknown): InputRevision {
  const result = inputRevision.safeParse(value)
  const raw = z.object({ message: z.json() }).safeParse(value)
  if (!result.success || !raw.success || nativeInputRecordDigest(raw.data.message) !== result.data.inputDigest
    || nativeInputRecordDigest(result.data.message) !== result.data.inputDigest) corrupt()
  return result.data
}

/** Decode one permanent input consumption fact.
 * @param value Durable claim fields, later checked against its actual revision/cohort/native event.
 * @returns Strict logical consumption coordinates.
 */
export function readInputClaim(value: unknown): InputClaim {
  const result = inputClaim.safeParse(value)
  if (!result.success) corrupt()
  return result.data
}

/** Decode one complete claim proposal, which may precede any step.
 * @param value Durable cohort fields.
 * @returns Strict original cohort metadata.
 */
export function readInputCohort(value: unknown): InputCohort {
  const result = inputCohort.safeParse(value)
  if (!result.success) corrupt()
  return result.data
}

/** Decode a historical tokenless result with its command/result pairing checked.
 * @param value Durable command receipt JSON.
 * @returns Strict original result; it carries no operation capability.
 */
export function readInputReceipt(value: unknown): InputCommandReceipt {
  const result = inputCommandReceipt.safeParse(value)
  if (!result.success) corrupt()
  const receipt = result.data
  const expected = receipt.kind === 'claim' ? 'claimed' : receipt.kind === 'remove' ? 'removed' : 'pending'
  if (receipt.result.kind !== expected || (receipt.kind === 'claim' && receipt.actor.kind !== 'writer')
    || receipt.committedSpliceSeqs.some((seq, index) => {
      const prior = receipt.committedSpliceSeqs[index - 1]
      return seq >= receipt.eventCount || (prior !== undefined && prior >= seq)
    })) corrupt()
  return receipt
}

/** One complete durable input removal; canceled queue changes never enter this list. */
export interface NativeInputHistoryClaim {
  readonly message: UserMessage
  readonly seq: number
  readonly itemOrdinal: number
  readonly target: 'next-step' | 'next-turn'
  readonly turnStartSeq: number
  readonly turn: number
}
/** Official projection and open native boundaries at a single PG watermark. */
export interface NativeInputHistory {
  readonly header: ReturnType<typeof headerSchema.parse>
  readonly eventCount: number
  readonly events: readonly SessionEvent[]
  readonly inbox: ReturnType<typeof inboxProjectionDefinition.init>
  readonly claims: readonly NativeInputHistoryClaim[]
  readonly turn: { readonly seq: number; readonly turn: number } | null
  readonly step: { readonly seq: number; readonly turn: number; readonly step: number } | null
}

/** Fold the official native projection, retaining precise pre-removal messages and actual open boundaries.
 * @param header Strict original native metadata.
 * @param events Complete maintained native event vocabulary.
 * @returns Exact projected pending inputs and irreversible consumption evidence.
 */
export function foldInputHistory(header: NativeInputHistory['header'], events: readonly SessionEvent[]): NativeInputHistory {
  let inbox = inboxProjectionDefinition.init()
  let turn: NativeInputHistory['turn'] = null
  let step: NativeInputHistory['step'] = null
  const claims: NativeInputHistoryClaim[] = []
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) corrupt()
    if (event.type === 'turn/start') {
      if (turn !== null || step !== null) corrupt()
      turn = { seq: event.seq, turn: event.data.turn }
    } else if (event.type === 'step/start') {
      if (turn?.turn !== event.data.turn || step !== null) corrupt()
      step = { seq: event.seq, turn: event.data.turn, step: event.data.step }
    } else if (event.type === 'step/end') {
      if (step?.turn !== event.data.turn || step.step !== event.data.step) corrupt()
      step = null
    } else if (event.type === 'turn/end') {
      if (turn?.turn !== event.data.turn || step !== null) corrupt()
      turn = null
    } else if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) {
        if (!admittedInputMessage.safeParse(message).success) throw new PlatformError(409, 'native_input_source_unsupported')
      }
      const removed = inbox[event.data.target].slice(event.data.start, event.data.start + (event.data.removedCount ?? 0))
      try { inbox = inboxProjectionDefinition.apply(inbox, event) }
      catch (_invalidSplice) { corrupt() }
      if (event.data.outcome !== 'canceled' && removed.length > 0) {
        if (turn === null || event.data.inserted.length > 0) corrupt()
        for (const [itemOrdinal, message] of removed.entries()) {
          if (claims.some(prior => prior.message.id === message.id)) throw new PlatformError(409, 'native_input_already_consumed')
          claims.push({ message, seq: event.seq, itemOrdinal, target: event.data.target, turnStartSeq: turn.seq, turn: turn.turn })
        }
      }
    }
  }
  return { header, eventCount: events.length, events, inbox, claims, turn, step }
}

/** Read a bounded complete native prefix before using the official projection.
 * @param client Caller transaction already locking the actual Session.
 * @param sessionId Currently authenticated native Session.
 * @param limits Explicit storage and history limits.
 * @returns One validated PG watermark; gaps, excess bytes or unknown required events refuse.
 */
export async function readInputHistory(client: PoolClient, sessionId: SessionId,
  limits: Pick<NativeInputLedgerLimits, 'maxHistoryEvents' | 'maxHistoryBytes'>): Promise<NativeInputHistory> {
  const result = await client.query<Record<string, unknown>>(`SELECT header,event_count AS "eventCount",
    event_bytes::text AS "eventBytes" FROM pe_sessions WHERE id=$1`, [sessionId])
  const stored = z.object({ header: headerSchema, eventCount: eventSeq,
    eventBytes: z.string().regex(/^\d+$/u).transform(Number) }).safeParse(result.rows[0])
  if (!stored.success || stored.data.header.id !== sessionId) corrupt()
  const value = stored.data
  if (value.eventCount > limits.maxHistoryEvents || value.eventBytes > limits.maxHistoryBytes) {
    throw new PlatformError(413, 'native_input_history_budget')
  }
  const rows = await client.query<{ seq: number; event: unknown }>(
    'SELECT seq,event FROM pe_events WHERE session_id=$1 ORDER BY seq LIMIT $2', [sessionId, limits.maxHistoryEvents + 1])
  if (rows.rows.length !== value.eventCount || rows.rows.some((row, index) => row.seq !== index)) corrupt()
  if (rows.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.event)), 0) > limits.maxHistoryBytes) {
    throw new PlatformError(413, 'native_input_history_budget')
  }
  let events: readonly SessionEvent[]
  try { events = parseEvents(value.header, rows.rows.map(row => row.event)) }
  catch (_invalidNativeHistory) { corrupt() }
  return foldInputHistory(value.header, events)
}
