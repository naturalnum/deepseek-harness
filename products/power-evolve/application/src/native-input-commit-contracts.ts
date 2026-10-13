/** Strict transaction requests; operation bearers remain separate service parameters. */
import { z } from 'zod'
import { nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputQueueCommand, nativeInputStepCommand,
  inputCommandReceipt, inputCohort, inputClaim, eventSeq } from './native-input-ledger-contracts.ts'
import { acceptedInputAudit, admittedInputMessage } from './native-input-ledger-contracts.ts'
import { operationId, requestId } from './contracts.ts'
import { nativeWriterIdentity } from './native-writer-contracts.ts'
import { nativeAssistantBatch } from './native-assistant-records.ts'
import { nativeExecutionFrame } from './native-execution-frame-contracts.ts'

/** Retained publisher generation and batch identity, with items derived from canonical events. */
export const nativeInputPresentation = nativeAssistantBatch.pick({ epoch: true, publisherId: true, batchId: true, firstOrdinal: true })
const batch = { version: z.literal(1), writer: nativeWriterIdentity, expectedEventCount: eventSeq,
  events: z.array(z.json()), presentation: nativeInputPresentation }

/** Accepted operation admission; bootstrap preparation is derived from the authenticated operation. */
export const nativeInputAcceptedCommit = z.object({ ...batch, command: nativeInputAdmissionCommand, prepareFrame: z.boolean() }).strict()
/** Complete native initial or continuing claim, including an empty continuing event batch. */
export const nativeInputClaimCommit = z.object({ ...batch, command: nativeInputClaimCommand }).strict()
/** Browser queue command planned by the Host's protected native capture. */
export const nativeInputQueueCommit = z.object({ ...batch, command: nativeInputQueueCommand }).strict()
/** Ordinary publication watermark captured after the Host flushes actual step/start. */
export const nativeInputPublicationSeal = z.object({ publisherId: z.uuid(),
  lastOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), eventCount: eventSeq,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
/** Bind only an already stored and ordinarily published native step. */
export const nativeInputStepCommit = z.object({ version: z.literal(1), writer: nativeWriterIdentity,
  command: nativeInputStepCommand, seal: nativeInputPublicationSeal }).strict()
/** Bounded original accepted inputs read by the current independent Session Writer. */
export const nativeInputPendingRequest = z.object({ version: z.literal(1), writer: nativeWriterIdentity,
  limit: eventSeq.min(1) }).strict()
/** Original metadata and native messages; queued selections never become the current operation's authority. */
export const nativeInputPendingResponse = z.object({ items: z.array(z.object({ originOperationId: operationId,
  requestId, acceptedInputAudit, message: admittedInputMessage }).strict()), more: z.boolean() }).strict()
/** Read one actual current execution frame without preparing or issuing another operation. */
export const nativeInputFrameRequest = z.object({ version: z.literal(1), writer: nativeWriterIdentity }).strict()
/** Tokenless presentation acknowledgement from the actual publisher store. */
export const nativeInputPresentationReceipt = nativeInputPublicationSeal.extend({ epoch: nativeAssistantBatch.shape.epoch }).strict()
/** Strict tokenless transaction results, with complete cohorts returned for step binding. */
export const nativeInputCommitReceipt = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('admission'), input: inputCommandReceipt,
    presentation: nativeInputPresentationReceipt, frame: nativeExecutionFrame.nullable() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('claim'), input: inputCommandReceipt,
    presentation: nativeInputPresentationReceipt }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('queue'), input: inputCommandReceipt,
    presentation: nativeInputPresentationReceipt }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('step'), cohort: inputCohort, claims: z.array(inputClaim),
    presentation: nativeInputPresentationReceipt }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'step') {
    if (value.cohort.stepStartSeq === null || value.cohort.claimCount !== value.claims.length
      || value.claims.some(claim => claim.cohortId !== value.cohort.cohortId)) {
      context.addIssue({ code: 'custom', message: 'Step result must retain its complete bound cohort' })
    }
  } else if (value.input.eventCount !== value.presentation.eventCount
    || (value.kind === 'admission' && value.input.kind !== 'admission')
    || (value.kind === 'claim' && value.input.kind !== 'claim')
    || (value.kind === 'queue' && !['edit', 'remove', 'retarget'].includes(value.input.kind))) {
    context.addIssue({ code: 'custom', message: 'Input and presentation receipts must acknowledge the same commit' })
  }
})

/** Validated accepted operation wire request, before PG header event decoding. */
export type NativeInputAcceptedCommit = z.infer<typeof nativeInputAcceptedCommit>
/** Validated complete claim wire request. */
export type NativeInputClaimCommit = z.infer<typeof nativeInputClaimCommit>
/** Validated browser queue wire request. */
export type NativeInputQueueCommit = z.infer<typeof nativeInputQueueCommit>
/** Validated ordinary step publication request. */
export type NativeInputStepCommit = z.infer<typeof nativeInputStepCommit>
/** Tokenless committed transaction response. */
export type NativeInputCommitReceipt = z.infer<typeof nativeInputCommitReceipt>
