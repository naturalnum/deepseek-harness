/** Scripted driver checks for the fixed Root receipt SQL call surface. */
import { expect, it, vi } from 'vitest'
import { PostgresAllocationReceiptStorage } from '../src/allocation-receipt-postgres.ts'
import type { AllocationDeletionReceipt } from '../src/allocation-receipt-outbox.ts'
import type { AllocationScope } from '../src/allocation-types.ts'

const scope: AllocationScope = {
  allocationId: 'allocation-1' as AllocationScope['allocationId'],
  accountId: 'account-1' as AllocationScope['accountId'],
  sessionId: 'session-1' as AllocationScope['sessionId'],
  workspaceId: 'workspace-1' as AllocationScope['workspaceId'],
  epoch: '42' as AllocationScope['epoch'],
}
const receipt: AllocationDeletionReceipt = {
  ...scope, sandboxId: 'sandbox-1', containerId: 'a'.repeat(64), providerGeneration: 'b'.repeat(64),
  policyDigest: 'c'.repeat(64), receiptDigest: 'd'.repeat(64),
}

it('shares one migration, checks the fixed slot count and calls one atomic release statement', async () => {
  const migrate = Promise.withResolvers<{ rows: readonly unknown[] }>()
  const query = vi.fn<(sql: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>>()
    .mockReturnValueOnce(migrate.promise).mockResolvedValueOnce({ rows: [{ status: 'recorded' }] })
  const storage = new PostgresAllocationReceiptStorage({ query })
  await expect(storage.read(scope)).rejects.toMatchObject({ code: 'unavailable' })
  expect(query).not.toHaveBeenCalled()
  expect(storage.migrate()).toBe(storage.migrate())
  await expect(storage.release(receipt, 127)).rejects.toMatchObject({ code: 'capacity' })
  const release = storage.release(receipt, 128)
  expect(query).toHaveBeenCalledOnce()
  migrate.resolve({ rows: [] })
  await expect(release).resolves.toBe('recorded')
  expect(query).toHaveBeenCalledTimes(2)
  expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('SELECT public.pe_release_sandbox_deletion_receipt_v1'),
    [scope.allocationId, scope.accountId, scope.sessionId, scope.workspaceId, scope.epoch, receipt.sandboxId,
      receipt.containerId, receipt.providerGeneration, receipt.policyDigest, receipt.receiptDigest])
})

it('rejects malformed mutation and stored receipt readback results', async () => {
  const query = vi.fn<() => Promise<{ rows: readonly unknown[] }>>()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ status: 'released-but-not-persisted' }] })
    .mockResolvedValueOnce({ rows: [{ evidence: null }] })
    .mockResolvedValueOnce({ rows: [] })
  const storage = new PostgresAllocationReceiptStorage({ query })
  await storage.migrate()
  await expect(storage.release(receipt, 128)).rejects.toMatchObject({ code: 'invalid-evidence' })
  await expect(storage.read(scope)).rejects.toMatchObject({ code: 'invalid-evidence' })
  await expect(storage.markAcknowledged(receipt)).rejects.toMatchObject({ code: 'invalid-evidence' })
})

it('bounds pending reads and submits every receipt identity field when acknowledging', async () => {
  const query = vi.fn<(sql: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>>()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: Array.from({ length: 129 }, () => ({ scope })) })
    .mockResolvedValueOnce({ rows: [{ acknowledged: true }] })
  const storage = new PostgresAllocationReceiptStorage({ query })
  await storage.migrate()
  await expect(storage.pending(128)).rejects.toMatchObject({ code: 'capacity' })
  await expect(storage.markAcknowledged(receipt)).resolves.toBeUndefined()
  expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('LIMIT 129'), [])
  expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining('r.receipt_digest = $10'),
    [scope.allocationId, scope.accountId, scope.sessionId, scope.workspaceId, scope.epoch, receipt.sandboxId,
      receipt.containerId, receipt.providerGeneration, receipt.policyDigest, receipt.receiptDigest])
})
