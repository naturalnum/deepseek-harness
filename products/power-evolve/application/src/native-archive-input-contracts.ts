/** Retained archival sibling cancellation requests and immutable tokenless publication acknowledgements. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { nativeExecutionFrame } from './native-execution-frame-contracts.ts'
import { nativeWriterIdentity } from './native-writer-contracts.ts'
import { nativeSessionStopId } from './native-session-stop-contracts.ts'
import { eventSeq, inputCommandReceipt, nativeInputRemovalCommand } from './native-input-ledger-contracts.ts'
import { nativeInputPresentation, nativeInputPublicationSeal, nativeInputPresentationReceipt } from './native-input-commit-contracts.ts'
import { nativeInputRecordDigest } from './native-input-ledger-records.ts'

const originalFrame = z.union([nativeExecutionFrame.options[0], nativeExecutionFrame.options[1]])
  .refine(value => nativeExecutionFrame.safeParse(value).success, { message: 'Original frame must retain its native owner proof' })

/** One real pending sibling, original frame and current storage publication; the operation bearer stays a service parameter. */
export const nativeArchiveInputCancelCommit = z.object({ version: z.literal(1), stopId: nativeSessionStopId,
  writer: nativeWriterIdentity, frame: originalFrame, command: nativeInputRemovalCommand, expectedEventCount: eventSeq,
  events: z.array(z.json()).length(1), presentation: nativeInputPresentation, seal: nativeInputPublicationSeal,
}).strict().superRefine((value, context) => {
  if (value.writer.sessionId !== value.frame.sessionId || value.command.payload.sessionId !== value.frame.sessionId
    || value.writer.epoch < value.frame.writerEpoch || value.presentation.epoch < value.frame.operationEpoch
    || (value.frame.phase === 'prepared' && (value.writer.epoch !== value.frame.writerEpoch
      || value.presentation.epoch !== value.frame.operationEpoch))
    || value.seal.publisherId !== value.presentation.publisherId || value.seal.eventCount !== value.expectedEventCount
    || value.expectedEventCount < value.frame.preparedEventCount || value.presentation.firstOrdinal !== value.seal.lastOrdinal + 1) {
    context.addIssue({ code: 'custom', message: 'Archival cancellation must retain its original frame and current publication prefix' })
  }
})

/** Original stop identity and real publisher acknowledgement survive exact replay after all source leases end. */
export const nativeArchiveInputCancelReceipt = z.object({ version: z.literal(1), kind: z.literal('archive-input-cancel'),
  stopId: nativeSessionStopId, input: inputCommandReceipt, presentation: nativeInputPresentationReceipt,
}).strict().superRefine((value, context) => {
  const result = value.input.result
  if (result.kind !== 'removed' || result.archive === undefined || result.archive.stopId !== value.stopId
    || !isDeepStrictEqual(result.archive.presentation, value.presentation)) {
    context.addIssue({ code: 'custom', message: 'Archival acknowledgement must retain its immutable original stop and publication' })
  }
})

/** Complete original archival cancellation intent retained across uncertain transport replies. */
export type NativeArchiveInputCancelCommit = z.infer<typeof nativeArchiveInputCancelCommit>
/** Historical tokenless acknowledgement; this grants no operation, Writer or execution authority. */
export type NativeArchiveInputCancelReceipt = z.infer<typeof nativeArchiveInputCancelReceipt>

/** Bind the complete original archival request and operation digest without storing either bearer.
 * @param operationToken Original Platform-issued storage token retained unchanged across uncertain replies.
 * @param request Strict original stop, Writer, frame, command, canonical removal and publication counters.
 * @returns Canonical full-intent digest shared by immutable receipts and Host acknowledgement verification.
 */
export function nativeArchiveInputCancelIntentDigest(operationToken: string, request: NativeArchiveInputCancelCommit): string {
  return nativeInputRecordDigest({ purpose: 'archive', request,
    operationDigest: createHash('sha256').update(operationToken).digest('hex') })
}
