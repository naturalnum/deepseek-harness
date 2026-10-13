/** Native turn preparation, exact transition intents and tokenless durable receipts. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { grant, operationId, requestId, sessionId } from './contracts.ts'
import { nativeWriterEpoch, nativeWriterIdentity, nativeWriterToken } from './native-writer-contracts.ts'

/** Stable identity of one Host-retained transition intent. */
export type NativeTransitionId = Branded<'PowerEvolveNativeTransitionId'>
/** Canonical transition identity, unchanged after an uncertain response. */
export const nativeTransitionId = z.uuid().transform(value => brandString<NativeTransitionId>(value.toLowerCase()))
/** Product-generated native message identity; distinct from its durable request identity. */
export const nativeTurnMessageId = z.uuid().transform(value => brandString<MessageId>(value.toLowerCase()))
/** Exactly representable operation attempt epoch. */
export const nativeOperationEpoch = z.number().int().min(1).max(2_147_483_647)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const turn = count.min(1)
const seq = count
/** Last committed inbox splice sequence; minus one denotes an empty inbox history. */
export const nativeQueueRevision = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)

const frameIdentity = z.object({ operationId, operationEpoch: nativeOperationEpoch,
  writerEpoch: nativeWriterEpoch, requestId, messageId: nativeTurnMessageId, inputRevision: z.literal(1) }).strict()
const claim = z.object({ turn, turnStartSeq: seq, claimSeq: seq, turnEndSeq: seq.nullable() }).strict()
const preparedFrame = frameIdentity.extend({ phase: z.literal('prepared') }).strict()
const claimedFrame = frameIdentity.extend({ phase: z.literal('claimed'), claim }).strict()
/** One operation is prepared before its input is claimed; consumption is derived from native events. */
export const nativeTurnFrame = z.discriminatedUnion('phase', [
  preparedFrame,
  claimedFrame,
  frameIdentity.extend({ phase: z.literal('settled'), claim: claim.extend({ turnEndSeq: seq }).strict(),
    outcome: z.enum(['completed', 'failed']), errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).nullable() }).strict(),
  frameIdentity.extend({ phase: z.literal('retired'), reason: z.enum(['preparation_failed', 'user_cancel']),
    eventCount: count, requeued: z.boolean() }).strict(),
])
/** Bind an already issued operation to its exact Writer before native input delivery. */
export const nativeTurnPrepare = z.object({ writer: nativeWriterIdentity,
  operationToken: nativeWriterToken, messageId: nativeTurnMessageId }).strict()

const next = z.object({ operationId, messageId: nativeTurnMessageId, inputRevision: z.literal(1) }).strict()
const common = { writer: nativeWriterIdentity, transitionId: nativeTransitionId,
  candidateToken: nativeWriterToken, expectedEventCount: count, expectedQueueRevision: nativeQueueRevision,
  expectedNext: next.nullable() }
const sourceTurn = z.object({ kind: z.literal('turn'), operationId, operationEpoch: nativeOperationEpoch,
  operationToken: nativeWriterToken, turn, turnStartSeq: seq, turnEndSeq: seq,
  claimedMessageIds: z.array(nativeTurnMessageId).length(1) }).strict()
const sourceParked = z.object({ kind: z.literal('parked'), transitionId: nativeTransitionId }).strict()
const sourcePrepared = z.object({ kind: z.literal('prepared'), operationId,
  operationEpoch: nativeOperationEpoch, operationToken: nativeWriterToken }).strict()
/** Close one durable consumed turn, or activate the unique successor of a parked receipt. */
export const nativeTurnTransition = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('advance'), from: sourceTurn,
    seal: z.object({ publisherId: z.uuid(), lastOrdinal: count, revision: count }).strict() }).strict(),
  z.object({ ...common, kind: z.literal('activate'), from: sourceParked }).strict(),
  z.object({ ...common, kind: z.literal('park'), from: sourcePrepared, expectedNext: z.null(),
    reason: z.enum(['preparation_failed', 'user_cancel']) }).strict(),
])

/** Frozen grant metadata persisted without any original operation bearer. */
export const nativeTurnSavedGrant = z.object(grant.shape).omit({ token: true }).strict()
/** Immutable committed result; replay does not claim another operation or extend a lease. */
export const nativeTurnReceipt = z.object({ version: z.literal(1), sessionId,
  writerEpoch: nativeWriterEpoch, transitionId: nativeTransitionId,
  eventCount: count, queueRevision: nativeQueueRevision,
  from: z.discriminatedUnion('kind', [sourceTurn.omit({ operationToken: true }), sourceParked,
    sourcePrepared.omit({ operationToken: true })]),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('prepared'), frame: frameIdentity,
      grant: nativeTurnSavedGrant, expiresAt: count }).strict(),
    z.object({ kind: z.literal('parked'), reason: z.enum(['empty', 'capacity', 'preparation_failed', 'user_cancel']),
      unclaimed: z.object({ operationId, messageId: nativeTurnMessageId,
        action: z.enum(['retain', 'remove']) }).strict().optional() }).strict(),
  ]) }).strict()
/** Receipt plus current consumption/lease status; an expired result carries no bearer. */
export const nativeTurnResponse = z.object({ receipt: nativeTurnReceipt, replayed: z.boolean(),
  current: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('live'), frame: z.discriminatedUnion('phase', [preparedFrame, claimedFrame]), grant }).strict(),
    z.object({ kind: z.literal('expired') }).strict(),
    z.object({ kind: z.literal('parked') }).strict(),
  ]) }).strict()

/** Validated preparation request. */
export type NativeTurnPrepare = z.infer<typeof nativeTurnPrepare>
/** Validated advance or activation intent. */
export type NativeTurnTransition = z.infer<typeof nativeTurnTransition>
/** Immutable result stored in PostgreSQL without a bearer. */
export type NativeTurnReceipt = z.infer<typeof nativeTurnReceipt>
/** Current native consumption state of one attempt. */
export type NativeTurnFrame = z.infer<typeof nativeTurnFrame>
/** Transition response with a bearer only for a still-live original result. */
export type NativeTurnResponse = z.infer<typeof nativeTurnResponse>
