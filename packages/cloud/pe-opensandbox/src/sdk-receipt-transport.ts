/** Private ACK operation on the original bounded lifecycle connection. */
import { Buffer } from 'node:buffer'
import type { AllocationDeletionReceipt, AllocationReceiptTransport } from './allocation-receipt-outbox.ts'
import type { AllocationCreateIntent, AllocationScope } from './allocation-types.ts'
import { SdkLifecycleFailure, type SdkLifecycleConfig } from './lifecycle-types.ts'
import type { BoundedLifecycleConnection, WireBudget } from './sdk-transport.ts'

/** Retained original operation, selected using Root's durable allocation and provider ownership. */
export interface SdkReceiptOperation {
  readonly intent: AllocationCreateIntent
  readonly receipt: AllocationDeletionReceipt
  readonly budget: WireBudget
  /** Recheck the original exact provider generation and Root shutdown/admission responsibility. */
  assertCurrent(): void
}

/** Same Root lifecycle owner that retains and drains all actual SDK control work. */
export interface SdkReceiptOperationOwner {
  /**
   * Retain one admitted ACK from exact durable readback through complete response validation.
   * @param scope Complete original allocation key from the application outbox's durable record.
   * @param run Work bound to the owner's selected original provider and existing finite budget.
   * @returns The actual operation, included in the original close path even if an observer stops waiting.
   */
  withOriginalReceipt<T>(scope: AllocationScope, run: (selected: SdkReceiptOperation) => Promise<T>): Promise<T>
}

const scopeKeys = ['allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId'] as const
const receiptKeys = [...scopeKeys, 'sandboxId', 'containerId', 'providerGeneration', 'policyDigest', 'receiptDigest'] as const
const digestKeys = ['containerId', 'providerGeneration', 'policyDigest', 'receiptDigest'] as const
const sdkAckBodyLimit = 65536

function sameReceipt(value: unknown, expected: AllocationDeletionReceipt): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).length === receiptKeys.length
    && receiptKeys.every(key => Object.hasOwn(row, key) && row[key] === expected[key])
}

/**
 * Bind ACK to the original versioned SDK connection and its real close/transport owner.
 * @param connection Original protected lifecycle connection, shared with the allocation owner.
 * @param limits The original configuration's request and field budgets.
 * @param owner Root-only retained operation and exact original allocation lookup, including after restart.
 * @returns ACK transport for the application's durable receipt outbox.
 */
export function createSdkReceiptTransport(connection: BoundedLifecycleConnection,
  limits: Pick<SdkLifecycleConfig, 'maxRequestBytes' | 'maxFieldBytes'>,
  owner: SdkReceiptOperationOwner): AllocationReceiptTransport {
  const { apiKey } = connection, base = connection.getBaseUrl()
  const { maxRequestBytes, maxFieldBytes } = limits
  if (!apiKey || !new URL(base).pathname.endsWith('/v1')) throw new SdkLifecycleFailure('sdk/selection')
  if (![maxRequestBytes, maxFieldBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) {
    throw new SdkLifecycleFailure('sdk/bounds')
  }
  const field = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && value.length <= Math.min(4096, maxFieldBytes) && !/[^\x20-\x7e]/u.test(value)
  const requestLimit = Math.min(maxRequestBytes, sdkAckBodyLimit)

  return Object.freeze({
    async acknowledge(receipt: AllocationDeletionReceipt) {
      const requested = Object.freeze({ ...receipt })
      if (Object.keys(requested).length !== receiptKeys.length || !receiptKeys.every(key => field(requested[key]))
        || !digestKeys.every(key => requested[key].length === 64 && !/[^0-9a-f]/u.test(requested[key]))
        || requested.sandboxId.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(requested.sandboxId)) {
        throw new SdkLifecycleFailure('sdk/selection')
      }
      const { allocationId, accountId, epoch, sessionId, workspaceId } = requested
      const scope = Object.freeze({ allocationId, accountId, epoch, sessionId, workspaceId })
      return owner.withOriginalReceipt(scope, async (selected) => {
        const { intent, receipt: retained, budget } = selected
        if (!sameReceipt(retained, requested) || !scopeKeys.every(key => intent[key] === scope[key])) {
          throw new SdkLifecycleFailure('sdk/selection')
        }
        const scopeVector = [...scopeKeys.map(key => scope[key]), intent.environmentVersion, intent.provider,
          intent.projectMountVersion, intent.requestedAt, intent.createDeadlineAt]
        if (!scopeVector.every(field)) throw new SdkLifecycleFailure('sdk/bounds')
        const body = JSON.stringify({ scope: scopeVector, receipt: requested })
        const size = Buffer.byteLength(body)
        if (size > requestLimit) throw new SdkLifecycleFailure('sdk/bounds')
        const path = `/sandboxes/${encodeURIComponent(requested.sandboxId)}/deletion-receipt/ack`
        const headers = { 'OPEN-SANDBOX-API-KEY': apiKey, 'Content-Type': 'application/json', 'Content-Length': String(size) }
        selected.assertCurrent()
        const response = await connection.run(budget, 'POST', path, 200, () =>
          connection.fetch(`${base}${path}`, { method: 'POST', headers, body, redirect: 'error' }))
        if (response.status !== 200 || response.headers.get('content-type') !== 'application/json') {
          throw new SdkLifecycleFailure('sdk/stop-unknown')
        }
        const returned: unknown = await response.json().catch(() => { throw new SdkLifecycleFailure('sdk/stop-unknown') })
        if (!sameReceipt(returned, requested)) throw new SdkLifecycleFailure('sdk/stop-unknown')
        selected.assertCurrent()
        if (Date.now() >= budget.deadlineAtMs) throw new SdkLifecycleFailure('sdk/bounds')
        return requested
      })
    },
  })
}
