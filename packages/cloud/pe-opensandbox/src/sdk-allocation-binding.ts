/** Original live Docker identity for a Root-owned, already validated create. */
import { Buffer } from 'node:buffer'
import type { OriginalDeletionBinding } from './allocation-receipt-outbox.ts'
import type { AllocationCreateIntent } from './allocation-types.ts'
import { SdkLifecycleFailure, type SdkLifecycleConfig } from './lifecycle-types.ts'
import type { BoundedLifecycleConnection, WireBudget } from './sdk-transport.ts'

/** Trusted Root selection retained from the original prepare, before write admission. */
export interface SdkAllocationBindingSelection {
  readonly intent: AllocationCreateIntent
  readonly sandboxId: string
  readonly providerGeneration: string
  readonly policyDigest: string
  readonly budget: WireBudget
  /** Check the protected deployment authority and original create responsibility. */
  assertCurrent(): void
}

const scopeKeys = ['allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId'] as const
const sha = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && !/[^0-9a-f]/u.test(value)

/**
 * Obtain the original live CID from the selected authenticated SDK, before ready is durable or exposed.
 * @param connection The lifecycle owner's single retained bounded SDK control connection.
 * @param limits The original preparation request and field limits.
 * @param selected The original validated create and provider pins, unavailable when not established.
 * @returns An exact binding proven by the selected SDK's own Docker observation, without granting writes.
 */
export async function readSdkAllocationBinding(connection: BoundedLifecycleConnection,
  limits: Pick<SdkLifecycleConfig, 'maxRequestBytes' | 'maxFieldBytes'>,
  selected: SdkAllocationBindingSelection | undefined): Promise<OriginalDeletionBinding> {
  if (selected === undefined) throw new SdkLifecycleFailure('sdk/ready-unconfirmed')
  const { intent, sandboxId, providerGeneration, policyDigest, budget } = selected
  const { apiKey } = connection, base = connection.getBaseUrl()
  if (!apiKey || !new URL(base).pathname.endsWith('/v1') || sandboxId.length !== 36
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(sandboxId)
    || !sha(providerGeneration) || !sha(policyDigest)) throw new SdkLifecycleFailure('sdk/selection')
  const { maxRequestBytes, maxFieldBytes } = limits
  if (![maxRequestBytes, maxFieldBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) {
    throw new SdkLifecycleFailure('sdk/bounds')
  }
  const { allocationId, accountId, epoch, sessionId, workspaceId } = intent
  const original = Object.freeze({ allocationId, accountId, epoch, sessionId, workspaceId, sandboxId, providerGeneration, policyDigest })
  const scope = [...scopeKeys.map(key => original[key]), intent.environmentVersion, intent.provider, intent.projectMountVersion,
    intent.requestedAt, intent.createDeadlineAt]
  if (![...scope, ...Object.values(original)].every(value => typeof value === 'string' && value.length > 0
    && value.length <= Math.min(4096, maxFieldBytes) && !/[^\x20-\x7e]/u.test(value))) throw new SdkLifecycleFailure('sdk/bounds')
  const body = JSON.stringify({ scope, providerGeneration, policyDigest })
  const size = Buffer.byteLength(body)
  if (size > Math.min(maxRequestBytes, 65536)) throw new SdkLifecycleFailure('sdk/bounds')
  const path = `/sandboxes/${encodeURIComponent(sandboxId)}/deletion-receipt/binding`
  const headers = { 'OPEN-SANDBOX-API-KEY': apiKey, 'Content-Type': 'application/json', 'Content-Length': String(size) }
  selected.assertCurrent()
  const response = await connection.run(budget, 'POST', path, 200, () =>
    connection.fetch(`${base}${path}`, { method: 'POST', headers, body, redirect: 'error' }))
  if (response.status !== 200 || response.headers.get('content-type') !== 'application/json') {
    throw new SdkLifecycleFailure('sdk/ready-unconfirmed')
  }
  const raw: unknown = await response.json().catch(() => { throw new SdkLifecycleFailure('sdk/ready-unconfirmed') })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SdkLifecycleFailure('sdk/ready-unconfirmed')
  const row = raw as Record<string, unknown>, containerId = row['containerId'], expected = Object.entries(original)
  if (Object.keys(row).length !== expected.length + 1
    || !expected.every(([key, value]) => Object.hasOwn(row, key) && row[key] === value) || !sha(containerId)) {
    throw new SdkLifecycleFailure('sdk/ready-unconfirmed')
  }
  selected.assertCurrent()
  if (Date.now() >= budget.deadlineAtMs) throw new SdkLifecycleFailure('sdk/bounds')
  return Object.freeze({ ...original, containerId })
}
