/** Current storage authority can recover unconsumed input without reconstructing a historical bearer. */
import { z } from 'zod'
import { grant } from './contracts.ts'
import { nativeExecutionFrame } from './native-execution-frame-contracts.ts'
import { ledgerFrozenSnapshotDigest } from './native-input-ledger-records.ts'

/** A prepared result retains accepted capabilities under the separately issued current operation bearer. */
export const nativePreparedInputRecovery = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('fresh') }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('prepared'), frame: nativeExecutionFrame, grant }).strict(),
]).superRefine((value, context) => {
  if (value.kind !== 'prepared') return
  const { token: _token, ...frozen } = value.grant
  const frame = value.frame
  if (frame.phase !== 'prepared' || frame.sessionId !== value.grant.sessionId
    || frame.operationId !== value.grant.operationId || frame.operationEpoch !== value.grant.epoch
    || frame.requestId !== value.grant.requestId || frame.frozenSnapshotDigest !== ledgerFrozenSnapshotDigest(frozen)) {
    context.addIssue({ code: 'custom', message: 'Recovery must return an exact unclaimed frame and current frozen Grant' })
  }
})

/** Fresh admission or exact unconsumed recovery; neither result is an execution authorization. */
export type NativePreparedInputRecovery = z.infer<typeof nativePreparedInputRecovery>
