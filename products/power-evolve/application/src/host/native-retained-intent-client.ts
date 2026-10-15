/** Host transport for Platform-owned retained requests; historical receipts never install an operation Grant. */
import { PlatformError } from '../contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { nativeWriterWorkerId, type NativeWriterWorkerId } from '../native-writer-contracts.ts'
import { NATIVE_RETAINED_ROUTES, nativeRetainedPrepare, nativeRetainedPrepared, nativeRetainedExecute,
  nativeRetainedExecutionResult, nativeRetainedReceipt, nativeRetainedReconcile, nativeRetainedReconciled,
  nativeRetainedResolve, nativeRetainedResolved, type NativeRetainedIntentId,
  type NativeRetainedMutation, type NativeRetainedReceipt, type NativeRetainedExecutionResult, type NativeRetainedReconcileScope,
} from '../native-retained-intent-contracts.ts'

/** Bounded operation transport; the original bearer is kept separate from the mutation body. */
export type NativeRetainedOperationTransport = (path: string, token: string, input: unknown,
  signal?: AbortSignal) => Promise<unknown>
/** Worker-authenticated maintenance transport, without stored operation, Writer or provider credentials. */
export type NativeRetainedMaintenanceTransport = (path: string, input: unknown,
  signal?: AbortSignal) => Promise<unknown>

/** Exact original execution reply and its immutable acknowledgement, retained until the consumer synchronizes locally. */
export interface NativeRetainedDispatch {
  readonly intentId: NativeRetainedIntentId
  readonly result: NativeRetainedExecutionResult
  readonly receipt: NativeRetainedReceipt
}

/** Shared-Platform journal client; no local file or in-memory map is treated as durable recovery state. */
export class NativeRetainedIntentClient {
  private readonly workerId: NativeWriterWorkerId

  /**
   * @param workerId Actual deployment Host identity used for operation attempts.
   * @param operation Bounded configured Platform transport using the original operation bearer.
   * @param maintenance Same Platform endpoint using only the worker credential.
   */
  constructor(workerId: string, private readonly operation: NativeRetainedOperationTransport,
    private readonly maintenance: NativeRetainedMaintenanceTransport) {
    this.workerId = nativeWriterWorkerId.parse(workerId)
  }

  /** Persist the whole original request before dispatching it; a missing prepare ACK prevents mutation.
   * Retries must pass the unchanged original body and bearer. A new client can reconcile the shared record.
   * @param operationToken Exact original operation bearer, never inferred from a saved receipt.
   * @param mutation Complete original wire request, including original nonce, events, counters and credentials.
   * @param signal Original caller lifetime, including configured transport timeout.
   * @returns Actual provider reply and tokenless acknowledgement; the caller must validate and synchronize before resolve.
   */
  async commit(operationToken: string, mutation: NativeRetainedMutation,
    signal?: AbortSignal): Promise<NativeRetainedDispatch> {
    const input = nativeRetainedPrepare.parse({ version: 1, workerId: this.workerId, mutation })
    const prepared = nativeRetainedPrepared.parse(await this.operation(NATIVE_RETAINED_ROUTES.prepare,
      operationToken, input, signal))
    if (prepared.family !== mutation.family) throw new PlatformError(502, 'native_retained_prepare_receipt')
    if (prepared.state === 'abandoned') throw new PlatformError(409, 'native_retained_intent_abandoned')
    const execute = nativeRetainedExecute.parse({ version: 1, workerId: this.workerId, intentId: prepared.intentId })
    const result = nativeRetainedExecutionResult.parse(await this.operation(NATIVE_RETAINED_ROUTES.execute,
      operationToken, execute, signal))
    if (result.family !== mutation.family) throw new PlatformError(502, 'native_retained_execution_receipt')
    const receipt = nativeRetainedReceipt.parse(result.family === 'turn-transition'
      ? { family: result.family, result: result.result.receipt } : result)
    return { intentId: prepared.intentId, result, receipt }
  }

  /** Read shared original outcomes before independent claims, without replaying models or external actions.
   * @param limit Explicit bounded number of original records to examine in one maintenance request.
   * @param signal Host maintenance lifetime.
   * @param scope Original attempt to drain during cleanup; Platform verifies its owner and worker before scanning.
   * @returns Tokenless historical outcomes; live old tuples remain blocked and are never replaced by inferred authority.
   */
  async reconcile(limit: number, signal?: AbortSignal, scope?: NativeRetainedReconcileScope) {
    const input = nativeRetainedReconcile.parse({ version: 1, workerId: this.workerId, limit, ...scope ? { scope } : {} })
    const result = nativeRetainedReconciled.parse(await this.maintenance(NATIVE_RETAINED_ROUTES.reconcile, input, signal))
    if (result.items.length > input.limit || (result.more && result.items.length === 0)
      || scope !== undefined && result.items.some(item => item.sessionId !== scope.sessionId
        || item.operationId !== scope.operationId || item.operationEpoch !== scope.operationEpoch || item.workerId !== this.workerId)
      || new Set(result.items.map(item => item.intentId)).size !== result.items.length) {
      throw new PlatformError(502, 'native_retained_reconciliation_receipt')
    }
    return result
  }

  /** Clear only sealed credentials after the caller validates the exact receipt and synchronizes committed local facts.
   * A failed response leaves the permanent acknowledgement intact and permits the unchanged resolution retry.
   * @param intentId Original Platform-assigned complete intent identity.
   * @param receipt Exact validated tokenless acknowledgement, never a warm live Grant.
   * @param signal Consumer cleanup lifetime; failure must not cause the native mutation to be sent with a new identity.
   * @returns Exact resolution acknowledgement; native facts and the permanent receipt remain unchanged.
   */
  async resolve(intentId: NativeRetainedIntentId, receipt: NativeRetainedReceipt, signal?: AbortSignal) {
    const receiptDigest = nativeInputRecordDigest(nativeRetainedReceipt.parse(receipt))
    const input = nativeRetainedResolve.parse({ version: 1, workerId: this.workerId, intentId, receiptDigest })
    const result = nativeRetainedResolved.parse(await this.maintenance(NATIVE_RETAINED_ROUTES.resolve, input, signal))
    if (result.intentId !== intentId || result.receiptDigest !== receiptDigest) {
      throw new PlatformError(502, 'native_retained_resolution_receipt')
    }
    return result
  }
}
