/** Exact version-two turn continuation intents and tokenless cohort receipts. */
import { z } from 'zod'
import { grant, operationId, sessionId } from './contracts.ts'
import { nativeExecutionFrame } from './native-execution-frame-contracts.ts'
import { acceptedInputAudit, eventSeq, inputCohortId, inputRevisionNumber, nativeInputFrameExpected,
  originInputId, recordDigest } from './native-input-ledger-contracts.ts'
import { nativeOperationEpoch, nativeQueueRevision, nativeTransitionId, nativeTurnMessageId } from './native-turn-contracts.ts'
import { nativeWriterEpoch, nativeWriterIdentity, nativeWriterToken } from './native-writer-contracts.ts'

const nextInput = z.object({ originInputId, operationId, messageId: nativeTurnMessageId,
  inputRevision: inputRevisionNumber, inputDigest: recordDigest, target: z.enum(['next-turn', 'next-step']) }).strict()
const source = z.object({ frame: nativeInputFrameExpected, turn: eventSeq.min(1), turnStartSeq: eventSeq,
  turnEndSeq: eventSeq, cohortIds: z.array(inputCohortId).min(1), claimedOriginInputIds: z.array(originInputId).min(1) }).strict()

/** Exact current publisher watermark shared by continuation and historical reconciliation. */
export const nativeTurnSealV2 = z.object({ publisherId: z.uuid(), lastOrdinal: eventSeq,
  revision: eventSeq, eventCount: eventSeq }).strict()
const transition = z.object({ version: z.literal(2),
  writer: nativeWriterIdentity, transitionId: nativeTransitionId, candidateToken: nativeWriterToken,
  expectedEventCount: eventSeq, expectedQueueRevision: nativeQueueRevision, expectedNext: nextInput.nullable(),
  from: source.extend({ operationToken: nativeWriterToken }).strict(),
  seal: nativeTurnSealV2,
}).strict()

/** Retain the entire intent and candidate token; reconciliation binds current storage separately from original consumption. */
export const nativeTurnTransitionV2 = z.discriminatedUnion('kind', [
  transition.extend({ kind: z.literal('advance') }).strict(),
  transition.extend({ kind: z.literal('reconcile'), storageOperationEpoch: nativeOperationEpoch }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'reconcile' && value.storageOperationEpoch <= value.from.frame.operationEpoch) {
    context.addIssue({ code: 'custom', message: 'Historical consumption requires a separately issued later storage epoch' })
  }
})

/** Complete original accepted metadata, with runtime fields frozen once and no bearer. */
export const nativeContinuationSavedGrantV2 = acceptedInputAudit.safeExtend({ epoch: nativeOperationEpoch,
  text: grant.shape.text, executionEnabled: grant.shape.executionEnabled.unwrap(), skills: grant.shape.skills.unwrap() })

/** Permanent cohort identities remain recorded when assembly fails before any step or user/message. */
export const nativeTurnReceiptV2 = z.object({ version: z.literal(2), sessionId, writerEpoch: nativeWriterEpoch,
  transitionId: nativeTransitionId, eventCount: eventSeq, queueRevision: nativeQueueRevision, from: source,
  settled: z.array(z.object({ originInputId, operationId, outcome: z.enum(['completed', 'failed']),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).nullable() }).strict()).min(1),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('prepared'), frame: nativeExecutionFrame,
      grant: nativeContinuationSavedGrantV2, expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
    z.object({ kind: z.literal('parked'), reason: z.enum(['empty', 'capacity']) }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if (new Set(value.from.cohortIds).size !== value.from.cohortIds.length
    || new Set(value.settled.map(item => item.operationId)).size !== value.settled.length
    || value.settled.length !== value.from.claimedOriginInputIds.length
    || value.settled.some((item, index) => item.originInputId !== value.from.claimedOriginInputIds[index])) {
    context.addIssue({ code: 'custom', message: 'Settlement must retain the exact complete ordered set of consumed origins' })
  }
  if (value.result.kind === 'prepared' && (value.result.frame.phase !== 'prepared'
    || value.result.frame.operationId !== value.result.grant.operationId
    || value.result.frame.operationEpoch !== value.result.grant.epoch
    || value.result.frame.sessionId !== value.sessionId || value.result.frame.writerEpoch !== value.writerEpoch
    || value.result.frame.preparedEventCount !== value.eventCount
    || value.from.claimedOriginInputIds.includes(value.result.frame.candidateOriginInputId))) {
    context.addIssue({ code: 'custom', message: 'A successor receipt must retain its exact prepared frame and original grant' })
  }
})

/** Historical receipts never restore an expired bearer or mint a second successor. */
export const nativeTurnResponseV2 = z.object({ receipt: nativeTurnReceiptV2, replayed: z.boolean(),
  current: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('live'), frame: nativeExecutionFrame, grant }).strict(),
    z.object({ kind: z.literal('expired') }).strict(), z.object({ kind: z.literal('parked') }).strict(),
  ]),
}).strict()

/** Strict retained version-two transition request. */
export type NativeTurnTransitionV2 = z.infer<typeof nativeTurnTransitionV2>
/** Durable version-two result with no operation or Writer bearer. */
export type NativeTurnReceiptV2 = z.infer<typeof nativeTurnReceiptV2>
/** Exact historical result and independently checked current authority. */
export type NativeTurnResponseV2 = z.infer<typeof nativeTurnResponseV2>
