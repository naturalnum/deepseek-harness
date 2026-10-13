/** Coherent temporary presentation reads inside the caller's tenant-authorized PostgreSQL transaction. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SessionFollowFrame,
  SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { parseEvents } from '../session-records.ts'
import { nativeAssistantBaseline, nativeAssistantBytes, nativeAssistantEntry, parseNativeAssistantBatch,
  readNativeAssistantState, validateNativeAssistantLimits, type NativeAssistantEntry, type NativeAssistantLimits,
  type NativeAssistantState } from '../native-assistant-records.ts'

const index = z.number().int().nonnegative().refine(value => !Object.is(value, -0))
const integerText = z.string().regex(/^(0|[1-9]\d*)$/u).transform(Number).pipe(index)
const wireEvent = z.object({ type: z.string(), seq: index, time: z.number().int().nonnegative(), data: z.json(),
  ignorable: z.literal(true).optional(), sourceEventSeqs: z.json().optional(), surfaceOp: z.json().optional() }).catchall(z.json())
  .transform(({ ignorable, sourceEventSeqs, surfaceOp, ...value }): SessionWireEvent => ({ ...value,
    ...(ignorable === undefined ? {} : { ignorable }), ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    ...(surfaceOp === undefined ? {} : { surfaceOp }) }))

/** Private generation cursor carried only by the authorized Host follower. */
export const nativeAssistantPosition = z.object({ epoch: index.min(1).max(2_147_483_647), publisherId: z.uuid(), ordinal: index }).strict()
/** Parsed private generation cursor; ordinal zero precedes the first publication. */
export type NativeAssistantPosition = z.infer<typeof nativeAssistantPosition>

/** Session row already authorized and held FOR SHARE by the caller on this connection. */
export interface NativeAssistantReadRow {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  readonly eventCount: number
  readonly leaseEpoch: number
}

/** Independent serialized response and canonical-read limits, supplied by deployment. */
export interface NativeAssistantReadLimits {
  readonly maxOpeningBytes: number
  readonly maxBaselineChunks: number
  readonly maxPacketItems: number
  readonly maxPacketBytes: number
  readonly maxCanonicalBytes: number
}

/** Opening presentation for the caller's same-cut native history window. */
export interface NativeAssistantOpening {
  readonly baseline: SessionAssistantStreamBaseline
  readonly position: NativeAssistantPosition | null
}

/** Ordered continuation, or normal generation retirement followed by an official new opening. */
export type NativeAssistantContinuation = { readonly kind: 'reopen' } | {
  readonly kind: 'next'
  readonly position: NativeAssistantPosition | null
  readonly cursor: number
  readonly frames: readonly Exclude<SessionFollowFrame, { type: 'snapshot' }>[]
}

interface Cache {
  readonly state: NativeAssistantState
  readonly entries: readonly NativeAssistantEntry[]
}

const cacheRow = z.object({ epoch: index.min(1), publisher_id: z.uuid(), last_ordinal: integerText,
  state_json: z.string(), last_batch_id: z.uuid().nullable(), last_batch_json: z.string().nullable() }).strict()

function invalid(code: string): never { throw new PlatformError(503, code) }

function decode<T>(operation: () => T): T {
  try { return operation() }
  catch (_invalidPersistedPresentation) { return invalid('native_assistant_cache_invalid') }
}

/** Reads bounded presentation and canonical references; never authenticates, starts a transaction or accepts a grant. */
export class NativeAssistantRead {
  constructor(private readonly presentation: NativeAssistantLimits, private readonly limits: NativeAssistantReadLimits) {
    validateNativeAssistantLimits(presentation)
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Native assistant read limits must be positive safe integers')
    }
    if (limits.maxOpeningBytes < 512
      || limits.maxPacketBytes < Math.max(presentation.maxItemBytes, presentation.maxEventBytes) + 512
      || limits.maxCanonicalBytes < presentation.maxEventBytes) {
      throw new Error('Native assistant read limits cannot contain a supported complete presentation or event')
    }
  }

  /** Read presentation at the caller's locked canonical watermark.
   * @param client Caller transaction with tenant authorization and Session FOR SHARE already held.
   * @param row Validated native Session header, watermark and epoch from that locked row.
   * @returns Full official baseline and its private position; the outer opening envelope remains caller-owned.
   */
  async open(client: PoolClient, row: NativeAssistantReadRow): Promise<NativeAssistantOpening> {
    const cache = await this.cache(client, row)
    const attempt = cache?.state.activeAttempt
    if (attempt?.settlement !== undefined) {
      const events = await this.canonical(client, row, [attempt.settlement.seq])
      const event = events.get(attempt.settlement.seq) as SessionWireEvent
      if (event.type !== attempt.settlement.eventType) invalid('native_assistant_settlement_invalid')
      const data = decode(() => z.object({ turn: index, step: index, stream: z.array(z.json()),
        interrupted: z.boolean().optional() }).loose().parse(event.data))
      if (data.turn !== attempt.turn || data.step !== attempt.step || !isDeepStrictEqual(data.stream, attempt.stream)
        || (data.interrupted === true) !== attempt.settlement.interrupted) invalid('native_assistant_settlement_invalid')
    }
    const live = cache !== undefined && await this.live(client, row, cache.state)
    const opening: NativeAssistantOpening = live ? { baseline: nativeAssistantBaseline(cache.state, this.presentation),
      position: this.position(cache.state) } : { baseline: { revision: 0 }, position: null }
    if (nativeAssistantBytes(opening) > this.limits.maxOpeningBytes) invalid('native_assistant_read_budget')
    return opening
  }

  /** Read a bounded original ordinal suffix, preserving event/frame interleaving and native seq continuity.
   * @param client Same caller transaction and Session lock used to obtain row.
   * @param row Current authorized native watermark and epoch.
   * @param position Previous helper position; null denotes a generation with no live presentation.
   * @param cursor Previously emitted canonical native seq, or minus one before the log.
   * @param limit Requested item count, clamped to the deployment packet count.
   * @returns Ordered native frames or reopen for expired, replaced or evicted presentation; corruption rejects with 503.
   */
  async after(client: PoolClient, row: NativeAssistantReadRow, position: NativeAssistantPosition | null,
    cursor: number, limit: number): Promise<NativeAssistantContinuation> {
    if (!Number.isSafeInteger(cursor) || cursor < -1 || Object.is(cursor, -0)
      || !Number.isSafeInteger(limit) || limit < 1) throw new PlatformError(400, 'native_assistant_position_invalid')
    if (cursor >= row.eventCount) invalid('native_assistant_future_cursor')
    const count = Math.min(limit, this.limits.maxPacketItems)
    const cache = await this.cache(client, row)
    let live = false
    if (cache !== undefined) live = await this.live(client, row, cache.state)
    if (position === null) {
      if (live) return { kind: 'reopen' }
      const sequences = Array.from({ length: Math.min(count, row.eventCount - cursor - 1) }, (_, index) => cursor + index + 1)
      const events = await this.canonical(client, row, sequences)
      let result: Extract<NativeAssistantContinuation, { kind: 'next' }> = { kind: 'next', position: null, cursor, frames: [] }
      for (const seq of sequences) {
        const event = events.get(seq) as SessionWireEvent
        const next = { ...result, cursor: seq, frames: [...result.frames, { type: 'event' as const, event }] }
        if (nativeAssistantBytes(next) > this.limits.maxPacketBytes) break
        result = next
      }
      return result
    }
    if (position.epoch > row.leaseEpoch) invalid('native_assistant_future_epoch')
    if (cache === undefined || cache.state.epoch !== position.epoch || cache.state.publisherId !== position.publisherId) return { kind: 'reopen' }
    if (position.ordinal > cache.state.lastOrdinal) invalid('native_assistant_future_ordinal')
    if (!live) return { kind: 'reopen' }
    const first = cache.entries[0]
    if (first !== undefined && position.ordinal < first.ordinal - 1) return { kind: 'reopen' }
    const selected = cache.entries.filter(entry => entry.ordinal > position.ordinal).slice(0, count)
    if (selected.length === 0 && cursor !== cache.state.cursor) invalid('native_assistant_history_gap')
    const sequences = selected.flatMap(entry => entry.item.type === 'event' ? [entry.item.seq] : [])
    const events = await this.canonical(client, row, sequences)
    let result: Extract<NativeAssistantContinuation, { kind: 'next' }> = { kind: 'next', position, cursor, frames: [] }
    for (const entry of selected) {
      let frames = result.frames
      let nextCursor = result.cursor
      if (entry.item.type === 'event') {
        const event = events.get(entry.item.seq) as SessionWireEvent
        if (event.type !== entry.item.eventType) invalid('native_assistant_history_gap')
        if (event.seq > nextCursor + 1) invalid('native_assistant_history_gap')
        if (event.seq === nextCursor + 1) { nextCursor = event.seq; frames = [...frames, { type: 'event', event }] }
      } else {
        const frame = wireFrame(entry.item.frame)
        if ((frame.type === 'start' && frame.startedAfterSeq !== nextCursor)
          || (frame.type === 'end' && frame.outcome.kind === 'committed' && frame.outcome.seq > nextCursor)) {
          invalid('native_assistant_frame_order')
        }
        frames = [...frames, { type: 'assistant-stream', frame }]
      }
      const next = { kind: 'next' as const, position: { ...position, ordinal: entry.ordinal }, cursor: nextCursor, frames }
      if (nativeAssistantBytes(next) > this.limits.maxPacketBytes) break
      result = next
    }
    if (!await this.live(client, row, cache.state)) return { kind: 'reopen' }
    return result
  }

  private position(state: NativeAssistantState): NativeAssistantPosition {
    return { epoch: state.epoch, publisherId: state.publisherId, ordinal: state.lastOrdinal }
  }

  private async live(client: PoolClient, row: NativeAssistantReadRow, state: NativeAssistantState): Promise<boolean> {
    const result = await client.query<{ live: boolean }>(`SELECT EXISTS(SELECT 1 FROM pe_native_presentations p
      JOIN pe_sessions s ON s.id=p.session_id WHERE s.id=$1 AND s.lease_epoch=$2 AND s.event_count=$3
      AND p.epoch=$2 AND p.publisher_id=$4 AND p.last_ordinal=$5 AND p.expires_at>clock_timestamp()
      AND s.lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM pe_operations o WHERE o.session_id=s.id AND o.state='running')) AS live`,
    [row.sessionId, row.leaseEpoch, row.eventCount, state.publisherId, state.lastOrdinal])
    return decode(() => z.object({ live: z.boolean() }).strict().parse(result.rows[0])).live
  }

  private async cache(client: PoolClient, row: NativeAssistantReadRow): Promise<Cache | undefined> {
    const result = await client.query(`SELECT epoch,publisher_id,last_ordinal::text,state_json,last_batch_id,last_batch_json
      FROM pe_native_presentations WHERE session_id=$1 FOR SHARE`, [row.sessionId])
    const raw: unknown = result.rows[0]
    if (raw === undefined) return undefined
    const record = decode(() => cacheRow.parse(raw))
    if (Buffer.byteLength(record.state_json) > this.presentation.maxActiveBytes + 512) invalid('native_assistant_read_budget')
    const stateValue = decode(() => z.json().parse(JSON.parse(record.state_json)))
    const count = decode(() => z.object({ activeAttempt: z.object({ nextIndex: index }).loose().optional() }).loose().parse(stateValue))
    if (count.activeAttempt !== undefined && count.activeAttempt.nextIndex > this.limits.maxBaselineChunks) {
      invalid('native_assistant_read_budget')
    }
    const state = decode(() => readNativeAssistantState(stateValue, this.presentation))
    if (state.epoch !== record.epoch || state.publisherId !== record.publisher_id || state.lastOrdinal !== record.last_ordinal
      || state.epoch > row.leaseEpoch || state.cursor > row.eventCount - 1
      || (state.epoch === row.leaseEpoch && state.cursor !== row.eventCount - 1)) invalid('native_assistant_cache_invalid')
    if (record.last_batch_json !== null && Buffer.byteLength(record.last_batch_json) > this.presentation.maxBatchBytes) {
      invalid('native_assistant_read_budget')
    }
    const batchJson = record.last_batch_json
    const receipt = batchJson === null ? undefined : decode(() =>
      parseNativeAssistantBatch(z.json().parse(JSON.parse(batchJson)), this.presentation))
    if (receipt === undefined) {
      if (record.last_batch_id !== null || state.lastOrdinal !== 0) invalid('native_assistant_receipt_invalid')
    } else if (receipt.batchId !== record.last_batch_id || receipt.epoch !== state.epoch || receipt.publisherId !== state.publisherId
      || receipt.firstOrdinal + receipt.items.length - 1 !== state.lastOrdinal) invalid('native_assistant_receipt_invalid')
    const sizes = await client.query<{ ordinal: string; item_bytes: number; actual_bytes: number }>(`SELECT ordinal::text,item_bytes,
      octet_length(item_json) AS actual_bytes FROM pe_native_presentation_entries e WHERE session_id=$1 ORDER BY e.ordinal LIMIT $2`,
    [row.sessionId, this.presentation.maxRingItems + 1])
    if (sizes.rows.length > this.presentation.maxRingItems || sizes.rows.some(item => item.item_bytes !== item.actual_bytes
      || item.item_bytes > this.presentation.maxItemBytes)
      || sizes.rows.reduce((sum, item) => sum + item.actual_bytes, 0) > this.presentation.maxRingBytes) invalid('native_assistant_read_budget')
    const ring = await client.query<{ ordinal: string; item_json: string }>(
      'SELECT ordinal::text,item_json FROM pe_native_presentation_entries e WHERE session_id=$1 ORDER BY e.ordinal', [row.sessionId])
    const entries = ring.rows.map((item) => {
      const ordinal = decode(() => integerText.parse(item.ordinal))
      const entry = decode(() => nativeAssistantEntry.parse(JSON.parse(item.item_json)))
      if (entry.ordinal !== ordinal || ordinal > state.lastOrdinal) invalid('native_assistant_ring_invalid')
      return entry
    })
    if ((state.lastOrdinal === 0 && entries.length !== 0)
      || (state.lastOrdinal > 0 && entries.at(-1)?.ordinal !== state.lastOrdinal)) invalid('native_assistant_ring_invalid')
    let previousOrdinal: number | undefined
    let previousRevision: number | undefined
    for (const entry of entries) {
      if (previousOrdinal !== undefined && entry.ordinal !== previousOrdinal + 1) invalid('native_assistant_ring_invalid')
      previousOrdinal = entry.ordinal
      if (entry.item.type === 'assistant-stream') {
        const frame = entry.item.frame
        if (frame.revision > state.revision || (previousRevision !== undefined && frame.revision !== previousRevision + 1)) {
          invalid('native_assistant_ring_invalid')
        }
        previousRevision = frame.revision
      } else if (entry.item.seq > state.cursor) invalid('native_assistant_ring_invalid')
      const original = receipt?.items[entry.ordinal - receipt.firstOrdinal]
      if (original !== undefined) {
        let actual: unknown = entry.item
        if (entry.item.type === 'event') actual = { type: 'event', event: { seq: entry.item.seq, type: entry.item.eventType } }
        else if (entry.item.frame.type === 'start') {
          const { startedAfterSeq: _derivedCursor, ...frame } = entry.item.frame
          actual = { type: 'assistant-stream', frame }
        }
        const expected = original.type === 'event' ? { type: 'event', event: { seq: original.event.seq, type: original.event.type } } : original
        if (!isDeepStrictEqual(actual, expected)) invalid('native_assistant_receipt_invalid')
      }
    }
    if (previousRevision !== undefined && previousRevision !== state.revision) invalid('native_assistant_ring_invalid')
    return { state, entries }
  }

  private async canonical(client: PoolClient, row: NativeAssistantReadRow,
    sequences: readonly number[]): Promise<Map<number, SessionWireEvent>> {
    const unique = [...new Set(sequences)]
    if (unique.length === 0) return new Map()
    const sizes = await client.query<{ seq: number; bytes: number }>(`SELECT seq,octet_length(event::text) AS bytes
      FROM pe_events WHERE session_id=$1 AND seq=ANY($2::integer[]) ORDER BY seq`, [row.sessionId, unique])
    if (sizes.rows.length !== unique.length || sizes.rows.some(item => item.seq >= row.eventCount)) invalid('native_assistant_history_gap')
    if (sizes.rows.some(item => item.bytes > this.presentation.maxEventBytes)
      || sizes.rows.reduce((sum, item) => sum + item.bytes, 0) > this.limits.maxCanonicalBytes) invalid('native_assistant_read_budget')
    const result = await client.query<{ seq: number; event_json: string }>(
      'SELECT seq,event::text AS event_json FROM pe_events WHERE session_id=$1 AND seq=ANY($2::integer[]) ORDER BY seq', [row.sessionId, unique])
    // Session FOR SHARE excludes the canonical writer; preflight requires every requested seq.
    return new Map(result.rows.map((item): [number, SessionWireEvent] => {
      const original = decode(() => z.json().parse(JSON.parse(item.event_json)))
      decode(() => parseEvents(row.header, [original]))
      const event = decode(() => wireEvent.parse(original))
      if (event.seq !== item.seq) invalid('native_assistant_history_gap')
      return [item.seq, event]
    }))
  }
}

function wireFrame(frame: Extract<NativeAssistantEntry['item'], { type: 'assistant-stream' }>['frame']): SessionAssistantStreamFrame {
  const attemptId = brandString<LlmAttemptId>(frame.attemptId)
  if (frame.type === 'start') return { ...frame, attemptId,
    startedAfterSeq: frame.startedAfterSeq === -1 ? -1 : SessionSeq(frame.startedAfterSeq) }
  return { ...frame, attemptId }
}
