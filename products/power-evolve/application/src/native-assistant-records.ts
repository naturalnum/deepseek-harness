/** Private ordered publication records; presentation remains separate from canonical native Session events. */
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssistantStreamAccumulator, expandAssistantStream, type AssistantStreamRecord, type LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { PlatformError } from './contracts.ts'

const json = z.json()
const index = z.number().int().nonnegative().refine(value => !Object.is(value, -0))
const cursor = z.union([z.literal(-1), index])
const epoch = index.min(1).max(2_147_483_647)
const attemptId = z.string().min(1).max(256)
const position = { turn: index, step: index }
const settlement = z.object({ eventType: z.enum(['assistant/message', 'assistant/attempt']), seq: index,
  interrupted: z.boolean() }).strict()
const chunkFrame = z.object({ type: z.literal('chunk'), attemptId, revision: index.min(1), index,
  time: z.number().int(), chunk: json }).strict()
const endFrame = z.object({ type: z.literal('end'), attemptId, revision: index.min(1), index,
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('committed'), eventType: z.enum(['assistant/message', 'assistant/attempt']), seq: index }).strict(),
    z.object({ kind: z.literal('abandoned') }).strict(),
  ]) }).strict()
const frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), attemptId, revision: index.min(1), ...position }).strict(),
  chunkFrame, endFrame,
])
const event = z.object({ seq: index, time: z.number().int().nonnegative(), type: z.string().min(1), data: json }).catchall(json)
const item = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event }).strict(),
  z.object({ type: z.literal('assistant-stream'), frame }).strict(),
])
const active = z.object({ attemptId, startedAfterSeq: cursor, ...position, nextIndex: index, stream: z.array(json),
  settlement: settlement.optional() }).strict()
const stateSchema = z.object({ version: z.literal(1), epoch, publisherId: z.uuid(), lastOrdinal: index,
  cursor, revision: index, activeAttempt: active.optional(), awaitingStepEnd: z.object(position).strict().optional() }).strict()

/** Deployment-owned byte, count and presentation lifetime limits. */
export interface NativeAssistantLimits {
  readonly maxBatchItems: number
  readonly maxBatchBytes: number
  readonly maxItemBytes: number
  readonly maxActiveBytes: number
  readonly maxRingItems: number
  readonly maxRingBytes: number
  readonly ttlMs: number
  readonly maxEventBytes: number
}

/** Original publisher identity and ordered items; empty batches are authenticated heartbeats. */
export const nativeAssistantBatch = z.object({ version: z.literal(1), epoch, publisherId: z.uuid(), batchId: z.uuid(),
  firstOrdinal: index.min(1), items: z.array(item) }).strict()
/** Browser frames and event references retained in the temporary ordered ring. */
export const nativeAssistantEntry = z.object({ ordinal: index.min(1), item: z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), seq: index, eventType: z.string().min(1) }).strict(),
  z.object({ type: z.literal('assistant-stream'), frame: z.discriminatedUnion('type', [
    z.object({ type: z.literal('start'), attemptId, revision: index.min(1), startedAfterSeq: cursor, ...position }).strict(),
    chunkFrame, endFrame,
  ]) }).strict(),
]) }).strict()
/** Validated private state persisted as versioned JSON text. */
export type NativeAssistantState = z.infer<typeof stateSchema>
/** Validated publication batch without any grant token. */
export type NativeAssistantBatch = z.infer<typeof nativeAssistantBatch>
/** Validated temporary ring entry; event payloads remain in canonical PG storage. */
export type NativeAssistantEntry = z.infer<typeof nativeAssistantEntry>

function refuse(code: string): never { throw new PlatformError(409, code) }

/** Measure complete JSON serialization before admitting or storing a private record.
 * @param value Record to serialize without altering its contents.
 * @returns UTF-8 byte count; invalid JSON serialization is refused.
 */
export function nativeAssistantBytes(value: unknown): number {
  try {
    const text = z.string().parse(JSON.stringify(value))
    return Buffer.byteLength(text)
  } catch (_invalidJson) { throw new PlatformError(400, 'native_assistant_invalid') }
}

/** Validate independent deployment limits and preserve the existing native single-event capacity.
 * @param limits Required deployment limits.
 * @returns The same validated limit values.
 */
export function validateNativeAssistantLimits(limits: NativeAssistantLimits): NativeAssistantLimits {
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Native presentation limits must be positive safe integers')
  }
  if (limits.maxItemBytes < limits.maxEventBytes + 512 || limits.maxBatchBytes < limits.maxEventBytes + 1024) {
    throw new Error('Native presentation limits cannot contain a supported native event and its envelope')
  }
  return limits
}

/** Parse the bounded private request before allocating a presentation generation.
 * @param input Original JSON request body.
 * @param limits Deployment-owned batch and item limits.
 * @returns Strict original publication records, retaining Unicode and native event fields.
 */
export function parseNativeAssistantBatch(input: unknown, limits: NativeAssistantLimits): NativeAssistantBatch {
  if (nativeAssistantBytes(input) > limits.maxBatchBytes) throw new PlatformError(413, 'native_assistant_budget')
  const parsed = nativeAssistantBatch.parse(input)
  if (parsed.items.length > limits.maxBatchItems || parsed.items.some(value => nativeAssistantBytes(value) > limits.maxItemBytes)) {
    throw new PlatformError(413, 'native_assistant_budget')
  }
  if (!Number.isSafeInteger(parsed.firstOrdinal + parsed.items.length)) refuse('native_assistant_ordinal')
  return parsed
}

function expand(stream: readonly z.infer<typeof json>[]) {
  // This concrete assertion exists only at the official validating public entry point.
  return expandAssistantStream(stream as AssistantStreamRecord[])
}

function accumulator(attempt: z.infer<typeof active>): AssistantStreamAccumulator {
  const chunks = expand(attempt.stream)
  if (chunks.length !== attempt.nextIndex) refuse('native_assistant_index')
  const value = new AssistantStreamAccumulator()
  for (const chunk of chunks) value.push(chunk)
  return value
}

/** Initialize an authenticated Agent generation before any frame has been published.
 * @param leaseEpoch Server-derived current grant epoch.
 * @param publisherId Unique publisher bound to the original Agent object.
 * @param durableCursor Current committed native prefix cursor.
 * @returns Genuine empty version-one state with no synthetic native event or terminal frame.
 */
export function createNativeAssistantState(leaseEpoch: number, publisherId: string, durableCursor: number): NativeAssistantState {
  return stateSchema.parse({ version: 1, epoch: leaseEpoch, publisherId, lastOrdinal: 0, cursor: durableCursor, revision: 0 })
}

/** Decode complete persisted JSON text and validate its compact attempt through public LLM readers.
 * @param input Parsed versioned state, or the original stored JSON text.
 * @param limits Maximum complete opening presentation size.
 * @returns Valid state; corrupt, discontinuous or oversized state is refused.
 */
export function readNativeAssistantState(input: unknown, limits: NativeAssistantLimits): NativeAssistantState {
  const decoded: unknown = typeof input === 'string' ? JSON.parse(input) : input
  const value = stateSchema.parse(decoded)
  if (value.revision > value.lastOrdinal || (value.activeAttempt !== undefined && value.awaitingStepEnd !== undefined)) {
    refuse('native_assistant_state')
  }
  if (value.activeAttempt !== undefined) {
    accumulator(value.activeAttempt)
    if (value.revision < value.activeAttempt.nextIndex + 1 || value.activeAttempt.startedAfterSeq > value.cursor
      || (value.activeAttempt.settlement !== undefined && (value.activeAttempt.settlement.seq <= value.activeAttempt.startedAfterSeq
        || value.activeAttempt.settlement.seq > value.cursor))) refuse('native_assistant_state')
  }
  nativeAssistantBaseline(value, limits)
  return value
}

/** Materialize the full official opening presentation without truncating a compact prefix.
 * @param state Coherent validated generation state.
 * @param limits Complete baseline byte limit.
 * @returns Exact revision and recoverable active attempt; a committed pending settlement is already durable.
 */
export function nativeAssistantBaseline(state: NativeAssistantState, limits: NativeAssistantLimits): SessionAssistantStreamBaseline {
  const attempt = state.activeAttempt
  const baseline: SessionAssistantStreamBaseline = { revision: state.revision,
    ...(attempt === undefined || attempt.settlement !== undefined ? {} : { activeAttempt: {
      attemptId: brandString<LlmAttemptId>(attempt.attemptId),
      startedAfterSeq: attempt.startedAfterSeq === -1 ? -1 : SessionSeq(attempt.startedAfterSeq),
      turn: attempt.turn, step: attempt.step, nextIndex: attempt.nextIndex, stream: attempt.stream,
    } }) }
  // Pending terminal state also retains the full prefix until its real end frame is checked.
  if (nativeAssistantBytes({ revision: state.revision, activeAttempt: attempt }) > limits.maxActiveBytes) {
    throw new PlatformError(413, 'native_assistant_budget')
  }
  return baseline
}

/** Fold one original ordered item before staging its canonical append in the same transaction.
 * @param prior Coherent state preceding this ordinal.
 * @param value Original event or Agent presentation frame.
 * @param ordinal Exact next private position allocated from the validated batch and state.
 * @param limits Complete presentation and ring-item byte limits.
 * @returns Detached next state and a frame or canonical event reference, never a new SessionEvent.
 */
export function foldNativeAssistantItem(prior: NativeAssistantState, value: NativeAssistantBatch['items'][number],
  ordinal: number, limits: NativeAssistantLimits): { state: NativeAssistantState; entry: NativeAssistantEntry } {
  const state = structuredClone(prior)
  state.lastOrdinal = ordinal
  let entry: NativeAssistantEntry
  if (value.type === 'event') {
    const record = value.event
    if (record.seq > state.cursor + 1) refuse('native_assistant_event_gap')
    if (record.seq === state.cursor + 1) {
      state.cursor = record.seq
      foldEvent(state, record)
    }
    entry = { ordinal, item: { type: 'event', seq: record.seq, eventType: record.type } }
  } else {
    const source = value.frame
    if (source.revision !== state.revision + 1) refuse('native_assistant_revision')
    state.revision = source.revision
    const wire = foldFrame(state, source)
    entry = nativeAssistantEntry.parse({ ordinal, item: { type: 'assistant-stream', frame: wire } })
  }
  nativeAssistantBaseline(state, limits)
  if (nativeAssistantBytes(entry) > limits.maxItemBytes || nativeAssistantBytes(entry) > limits.maxRingBytes) {
    throw new PlatformError(413, 'native_assistant_budget')
  }
  return { state, entry }
}

function foldEvent(state: NativeAssistantState, record: z.infer<typeof event>): void {
  if (record.type === 'step/end') {
    const data = z.object(position).loose().parse(record.data)
    if (state.activeAttempt !== undefined && data.turn === state.activeAttempt.turn && data.step === state.activeAttempt.step) {
      refuse('native_assistant_order')
    }
    if (state.awaitingStepEnd?.turn === data.turn && state.awaitingStepEnd.step === data.step) delete state.awaitingStepEnd
    return
  }
  const attempt = state.activeAttempt
  if (attempt === undefined || (record.type !== 'assistant/message' && record.type !== 'assistant/attempt')) return
  const data = z.object({ ...position, stream: z.array(json), interrupted: z.boolean().optional() }).loose().parse(record.data)
  if (data.turn !== attempt.turn || data.step !== attempt.step) return
  if (attempt.settlement !== undefined) refuse('native_assistant_settlement')
  expand(data.stream)
  if (!isDeepStrictEqual(data.stream, attempt.stream)) refuse('native_assistant_settlement')
  attempt.settlement = { eventType: record.type, seq: record.seq, interrupted: data.interrupted === true }
}

function foldFrame(state: NativeAssistantState, source: z.infer<typeof frame>): SessionAssistantStreamFrame {
  if (source.type === 'start') {
    if (state.activeAttempt !== undefined || state.awaitingStepEnd !== undefined) refuse('native_assistant_attempt')
    state.activeAttempt = { attemptId: source.attemptId, startedAfterSeq: state.cursor, turn: source.turn,
      step: source.step, nextIndex: 0, stream: [] }
    return { ...source, attemptId: brandString<LlmAttemptId>(source.attemptId),
      startedAfterSeq: state.cursor === -1 ? -1 : SessionSeq(state.cursor) }
  }
  const attempt = state.activeAttempt
  if (attempt === undefined || attempt.attemptId !== source.attemptId || attempt.nextIndex !== source.index) {
    refuse('native_assistant_attempt')
  }
  if (source.type === 'chunk') {
    if (attempt.settlement !== undefined) refuse('native_assistant_order')
    const stream = accumulator(attempt)
    for (const chunk of expand([{ type: 'chunk', time: source.time, chunk: source.chunk }])) stream.push(chunk)
    attempt.stream = z.array(json).parse(stream.snapshot())
    attempt.nextIndex++
  } else {
    const committed = attempt.settlement
    if (source.outcome.kind === 'abandoned') {
      if (committed !== undefined) refuse('native_assistant_settlement')
    } else {
      if (committed === undefined || source.outcome.seq !== committed.seq || source.outcome.eventType !== committed.eventType) {
        refuse('native_assistant_settlement')
      }
      if (committed.eventType === 'assistant/message' && !committed.interrupted) {
        state.awaitingStepEnd = { turn: attempt.turn, step: attempt.step }
      }
    }
    delete state.activeAttempt
  }
  return { ...source, attemptId: brandString<LlmAttemptId>(source.attemptId) }
}
