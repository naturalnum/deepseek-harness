/** Retained prepared cancellation requests and tokenless atomic retirement acknowledgements. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { nativeExecutionFrame } from './native-execution-frame-contracts.ts'
import { nativeWriterIdentity } from './native-writer-contracts.ts'
import { eventSeq, inputCommandReceipt, nativeInputRemovalCommand, nativePreparedCancellationRetirement } from './native-input-ledger-contracts.ts'
import { nativeInputPresentation, nativeInputPublicationSeal, nativeInputPresentationReceipt } from './native-input-commit-contracts.ts'
import { nativeInputRecordDigest } from './native-input-ledger-records.ts'


/** Exact original candidate, Writer, canonical removal and publisher counters; operation bearer stays a service parameter. */
export const nativePreparedCancelCommit = z.object({ version: z.literal(1), writer: nativeWriterIdentity,
  frame: nativeExecutionFrame.options[0], command: nativeInputRemovalCommand, expectedEventCount: eventSeq,
  events: z.array(z.json()).length(1), presentation: nativeInputPresentation, seal: nativeInputPublicationSeal,
}).strict().superRefine((value, context) => {
  if (value.writer.sessionId !== value.frame.sessionId || value.writer.epoch !== value.frame.writerEpoch
    || value.command.payload.sessionId !== value.frame.sessionId || value.command.payload.itemId !== value.frame.messageId
    || value.presentation.epoch !== value.frame.operationEpoch || value.seal.publisherId !== value.presentation.publisherId
    || value.seal.eventCount !== value.expectedEventCount || value.expectedEventCount < value.frame.preparedEventCount
    || value.presentation.firstOrdinal !== value.seal.lastOrdinal + 1) {
    context.addIssue({ code: 'custom', message: 'Prepared cancellation must retain its exact candidate and publication prefix' })
  }
})

/** The original real publisher acknowledgement and terminal frame survive receipt replay after all leases end. */
export const nativePreparedCancelReceipt = z.object({ version: z.literal(1), kind: z.literal('prepared-cancel'),
  input: inputCommandReceipt, presentation: nativeInputPresentationReceipt,
  frame: nativePreparedCancellationRetirement.shape.frame,
}).strict().superRefine((value, context) => {
  const result = value.input.result
  if (result.kind !== 'removed' || result.retirement === undefined
    || !isDeepStrictEqual(result.retirement.presentation, value.presentation)
    || !isDeepStrictEqual(result.retirement.frame, value.frame)) {
    context.addIssue({ code: 'custom', message: 'Cancellation acknowledgement must be the immutable original retirement receipt' })
  }
})

/** Validated complete original cancellation intent, retained unchanged across uncertain replies. */
export type NativePreparedCancelCommit = z.infer<typeof nativePreparedCancelCommit>
/** Tokenless historical acknowledgement; this never issues operation or Writer authority. */
export type NativePreparedCancelReceipt = z.infer<typeof nativePreparedCancelReceipt>

/** Hash the complete original purpose-specific request and operation bearer digest without retaining either bearer.
 * @param operationToken Exact original Platform-issued operation token, unchanged across uncertain replies.
 * @param request Strict original cancellation request with its retained Writer, nonce, frame and publisher counters.
 * @returns Canonical full-intent digest shared by the Platform receipt and Host acknowledgement verification.
 */
export function nativePreparedCancelIntentDigest(operationToken: string, request: NativePreparedCancelCommit): string {
  return nativeInputRecordDigest({ purpose: 'prepared-user-cancel', request,
    operationDigest: createHash('sha256').update(operationToken).digest('hex') })
}
