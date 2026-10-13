/** Historical consumption and current storage authority remain separate during native restart reconciliation. */
import { z } from 'zod'
import { grant } from './contracts.ts'
import { nativeExecutionFrame } from './native-execution-frame-contracts.ts'
import { ledgerFrozenSnapshotDigest } from './native-input-ledger-records.ts'

/** No old bearer is returned; this current Grant cannot execute without a current claimed frame and bound step. */
export const nativeConsumedInputRecovery = z.object({ version: z.literal(1), kind: z.literal('claimed'),
  frame: nativeExecutionFrame, grant }).strict().superRefine((value, context) => {
  const frame = value.frame, { token: _token, ...frozen } = value.grant
  if (frame.phase !== 'claimed' || frame.sessionId !== frozen.sessionId || frame.operationId !== frozen.operationId
    || frame.requestId !== frozen.requestId || frame.operationEpoch >= frozen.epoch
    || frame.frozenSnapshotDigest !== ledgerFrozenSnapshotDigest({ ...frozen, epoch: frame.operationEpoch })) {
    context.addIssue({ code: 'custom', message: 'Recovery must preserve original claimed ownership with a later storage-only Grant' })
  }
})

/** Exact original consumption and independently issued current storage metadata. */
export type NativeConsumedInputRecovery = z.infer<typeof nativeConsumedInputRecovery>
