/** Original canonical event suffix validation before private journal preparation. */
import { PlatformError } from '../contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import type { NativeInputLedgerLimits } from '../native-input-ledger-contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'

/** Decode the exact proposed suffix under its real persisted Session header and deployment budgets.
 * @param header Actual authorized Session header read under the owned Session lock.
 * @param input Complete original native event array, without synthesized or reordered metadata.
 * @param expectedEventCount Original prefix retained in the wire body.
 * @param limits Purpose-specific input provider's explicit event and history budgets.
 * @param maxBatchItems Purpose-specific presentation provider's explicit event count budget.
 */
export function validateNativeRetainedEvents(header: unknown, input: unknown, expectedEventCount: number,
  limits: Pick<NativeInputLedgerLimits, 'maxEventBytes' | 'maxHistoryEvents'>, maxBatchItems: number): void {
  const events = parseEvents(headerSchema.parse(header), input)
  if (events.length > maxBatchItems || expectedEventCount + events.length > limits.maxHistoryEvents
    || events.some(event => Buffer.byteLength(JSON.stringify(event)) > limits.maxEventBytes)) {
    throw new PlatformError(413, 'native_input_command_budget')
  }
  if (nativeInputRecordDigest(events) !== nativeInputRecordDigest(input)
    || events.some((event, index) => event.seq !== expectedEventCount + index)) {
    throw new PlatformError(409, 'native_input_batch_conflict')
  }
}
