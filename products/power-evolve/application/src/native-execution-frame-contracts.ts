/** Version-two execution ownership; native input consumption persists independently of step entry. */
import { z } from 'zod'
import { operationId, requestId, sessionId } from './contracts.ts'
import { nativeOperationEpoch, nativeTurnMessageId } from './native-turn-contracts.ts'
import { nativeWriterEpoch } from './native-writer-contracts.ts'
import { eventSeq, inputCohortId, inputRevisionNumber, originInputId, recordDigest } from './native-input-ledger-contracts.ts'

const identity = z.object({
  version: z.literal(2), sessionId, operationId, operationEpoch: nativeOperationEpoch,
  writerEpoch: nativeWriterEpoch, requestId, messageId: nativeTurnMessageId,
  candidateOriginInputId: originInputId, frozenSnapshotDigest: recordDigest,
  preparedEventCount: eventSeq,
}).strict()

/** New-turn ownership selects its queued turn head, or the first next-step input when no turn head exists. */
export const nativeExecutionOwner = z.object({
  originInputId, inputRevision: inputRevisionNumber, inputDigest: recordDigest, cohortId: inputCohortId,
  claimSpliceSeq: eventSeq, spliceItemOrdinal: eventSeq, turnStartSeq: eventSeq, turn: eventSeq.min(1),
  target: z.enum(['next-turn', 'next-step']),
}).strict().refine(value => value.claimSpliceSeq > value.turnStartSeq && value.spliceItemOrdinal === 0,
  { message: 'A frame owner must be an actual pending-list head consumed after its turn starts' })

/** Prepared capability alone does not grant execution, and an absent step does not undo consumption. */
export const nativeExecutionFrame = z.discriminatedUnion('phase', [
  identity.extend({ phase: z.literal('prepared') }).strict(),
  identity.extend({ phase: z.literal('claimed'), owner: nativeExecutionOwner }).strict(),
  identity.extend({ phase: z.literal('settled'), owner: nativeExecutionOwner, turnEndSeq: eventSeq,
    outcome: z.enum(['completed', 'failed']), errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).nullable() }).strict(),
  identity.extend({ phase: z.literal('retired'), reason: z.enum(['preparation_failed', 'user_cancel']),
    eventCount: eventSeq, requeued: z.boolean() }).strict(),
]).superRefine((value, context) => {
  if (value.phase === 'claimed' || value.phase === 'settled') {
    if (value.owner.originInputId !== value.candidateOriginInputId
      || value.owner.claimSpliceSeq < value.preparedEventCount) {
      context.addIssue({ code: 'custom', message: 'Consumed owner must match the prepared origin and its native prefix' })
    }
    if (value.phase === 'settled' && value.turnEndSeq <= value.owner.claimSpliceSeq) {
      context.addIssue({ code: 'custom', message: 'Settlement must follow the permanent owner claim' })
    }
  }
  if (value.phase === 'retired' && (value.eventCount < value.preparedEventCount
    || (value.reason === 'user_cancel' && value.requeued))) {
    context.addIssue({ code: 'custom', message: 'Retirement must preserve its prepared prefix and explicit cancellation' })
  }
})

/** Strict durable frame; operation, attempt, Writer and original snapshot remain separately authenticated in PG. */
export type NativeExecutionFrame = z.infer<typeof nativeExecutionFrame>
/** Permanent owner binding, retained even when prompt assembly rejects before step/start or user/message. */
export type NativeExecutionOwner = z.infer<typeof nativeExecutionOwner>
