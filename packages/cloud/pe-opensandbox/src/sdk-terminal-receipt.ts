/** Positive provider terminal evidence on the original private SDK connection. */
import { Buffer } from 'node:buffer'
import type { AllocationDeletionReceipt, OriginalDeletionBinding } from './allocation-receipt-outbox.ts'
import type { AllocationCreateIntent } from './allocation-types.ts'
import { SdkLifecycleFailure, type SdkLifecycleConfig } from './lifecycle-types.ts'
import type { BoundedLifecycleConnection, WireBudget } from './sdk-transport.ts'

/** Retained by the original lifecycle owner after fencing and joining the original writer. */
export interface SdkTerminalReceiptSelection {
  readonly intent: AllocationCreateIntent
  readonly binding: OriginalDeletionBinding
  readonly budget: WireBudget
  /** Exact independently retained receipt digest when replay already has one. */
  readonly receiptDigest?: string
  /** Verify that Root still owns this exact selected provider generation and operation. */
  assertCurrent(): void
}

const scopeFields = ['allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId'] as const
const bindingFields = [...scopeFields, 'sandboxId', 'containerId', 'providerGeneration', 'policyDigest'] as const
const receiptBodyLimit = 65536
const sha256 = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && !/[^0-9a-f]/u.test(value)

/**
 * Fetch exact original completed evidence from a receipt-capable SDK.
 * @param connection Original bounded control connection, retained by the lifecycle owner.
 * @param limits The same original control request and field limits.
 * @param selected Original creation and provider binding from trusted pre-deletion evidence, unavailable when unknown.
 * @returns Positive authenticated evidence of the exact original, with the provider's persisted record digest.
 */
export async function readSdkTerminalReceipt(connection: BoundedLifecycleConnection,
  limits: Pick<SdkLifecycleConfig, 'maxRequestBytes' | 'maxFieldBytes'>,
  selected: SdkTerminalReceiptSelection | undefined): Promise<AllocationDeletionReceipt> {
  if (selected === undefined) throw new SdkLifecycleFailure('sdk/stop-unknown')
  const { binding, budget, intent, receiptDigest } = selected
  const { apiKey } = connection, base = connection.getBaseUrl()
  if (!apiKey || !new URL(base).pathname.endsWith('/v1') || !scopeFields.every(field => binding[field] === intent[field])) {
    throw new SdkLifecycleFailure('sdk/selection')
  }
  const { maxRequestBytes, maxFieldBytes } = limits
  if (![maxRequestBytes, maxFieldBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) {
    throw new SdkLifecycleFailure('sdk/bounds')
  }
  const { allocationId, accountId, epoch, sessionId, workspaceId, sandboxId, containerId, providerGeneration, policyDigest } = binding
  const original = Object.freeze({ allocationId, accountId, epoch, sessionId, workspaceId,
    sandboxId, containerId, providerGeneration, policyDigest })
  const scope = [...scopeFields.map(field => original[field]), intent.environmentVersion, intent.provider,
    intent.projectMountVersion, intent.requestedAt, intent.createDeadlineAt]
  if (![...scope, ...Object.values(original)].every(value => typeof value === 'string' && value.length > 0
    && value.length <= Math.min(4096, maxFieldBytes) && !/[^\x20-\x7e]/u.test(value))) {
    throw new SdkLifecycleFailure('sdk/bounds')
  }
  if (sandboxId.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(sandboxId)
    || ![containerId, providerGeneration, policyDigest].every(sha256)
    || (receiptDigest !== undefined && !sha256(receiptDigest))) {
    throw new SdkLifecycleFailure('sdk/selection')
  }
  const expected = { sandboxId, containerId, providerGeneration, policyDigest, ...(receiptDigest === undefined ? {} : { receiptDigest }) }
  const body = JSON.stringify({ scope, expected })
  const bytes = Buffer.byteLength(body)
  if (bytes > Math.min(receiptBodyLimit, maxRequestBytes)) throw new SdkLifecycleFailure('sdk/bounds')
  const path = `/sandboxes/${encodeURIComponent(sandboxId)}/deletion-receipt`
  const headers = { 'OPEN-SANDBOX-API-KEY': apiKey, 'Content-Type': 'application/json', 'Content-Length': String(bytes) }
  selected.assertCurrent()
  const response = await connection.run(budget, 'POST', path, 200, () =>
    connection.fetch(`${base}${path}`, { method: 'POST', headers, body, redirect: 'error' }))
  if (response.status !== 200 || response.headers.get('content-type') !== 'application/json') {
    throw new SdkLifecycleFailure('sdk/stop-unknown')
  }
  const inbound: unknown = await response.json().catch(() => { throw new SdkLifecycleFailure('sdk/stop-unknown') })
  if (typeof inbound !== 'object' || inbound === null || Array.isArray(inbound)) throw new SdkLifecycleFailure('sdk/stop-unknown')
  const row = inbound as Record<string, unknown>, digest = row['receiptDigest']
  if (Object.keys(row).length !== bindingFields.length + 1
    || !bindingFields.every(field => Object.hasOwn(row, field) && row[field] === original[field])
    || !sha256(digest) || (receiptDigest !== undefined && digest !== receiptDigest)) {
    throw new SdkLifecycleFailure('sdk/stop-unknown')
  }
  selected.assertCurrent()
  if (Date.now() >= budget.deadlineAtMs) throw new SdkLifecycleFailure('sdk/bounds')
  return Object.freeze({ ...original, receiptDigest: digest })
}
