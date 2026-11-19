/** PostgreSQL storage for app-owned deletion receipts, using the original Root metadata executor. */
import { AllocationReceiptError } from './allocation-receipt-outbox.ts'
import type { AllocationDeletionReceipt, AllocationReceiptStorage, PersistedDeletionReceipt } from './allocation-receipt-outbox.ts'
import type { AllocationQuery, AllocationScope } from './allocation-types.ts'
import { allocationReceiptMigrationSql } from './migrations/allocation-receipts.ts'

const receiptCapacity = 128
const table = 'public.pe_sandbox_deletion_receipts_v1'
const join = `a.allocation_id = r.allocation_id AND a.account_id = r.account_id
  AND a.session_id = r.session_id AND a.workspace_id = r.workspace_id AND a.epoch = r.epoch
  AND a.sandbox_id = r.sandbox_id AND a.state = 'released'`
const scope = 'r.allocation_id = $1 AND r.account_id = $2 AND r.session_id = $3 AND r.workspace_id = $4 AND r.epoch = $5::bigint'
const scopeFields = `'allocationId', r.allocation_id, 'accountId', r.account_id,
  'sessionId', r.session_id, 'workspaceId', r.workspace_id, 'epoch', r.epoch::text`

const releaseSql = `SELECT public.pe_release_sandbox_deletion_receipt_v1(
  $1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10
) AS status`
const readSql = `SELECT CASE WHEN a.allocation_id IS NOT NULL THEN jsonb_build_object('state', a.state,
  'ack', CASE WHEN r.pending_slot IS NULL THEN 'acknowledged' ELSE 'pending' END,
  'receipt', jsonb_build_object(${scopeFields}, 'sandboxId', r.sandbox_id, 'containerId', r.container_id,
    'providerGeneration', r.provider_generation, 'policyDigest', r.policy_digest, 'receiptDigest', r.receipt_digest)
  ) END AS evidence FROM ${table} AS r LEFT JOIN public.pe_sandbox_allocations AS a ON ${join} WHERE ${scope}`
const pendingSql = `SELECT CASE WHEN a.allocation_id IS NOT NULL THEN jsonb_build_object(${scopeFields}) END AS scope
  FROM ${table} AS r LEFT JOIN public.pe_sandbox_allocations AS a ON ${join}
  WHERE r.pending_slot IS NOT NULL ORDER BY r.pending_slot LIMIT ${receiptCapacity + 1}`
const markSql = `UPDATE ${table} AS r SET pending_slot = NULL
  FROM public.pe_sandbox_allocations AS a
  WHERE ${join} AND ${scope} AND r.sandbox_id = $6 AND r.container_id = $7
    AND r.provider_generation = $8 AND r.policy_digest = $9 AND r.receipt_digest = $10
    AND current_setting('fsync') = 'on' AND current_setting('synchronous_commit') IN ('on', 'remote_apply')
  RETURNING true AS acknowledged`

function scopeValues(key: AllocationScope): readonly string[] {
  return [key.allocationId, key.accountId, key.sessionId, key.workspaceId, key.epoch]
}

function receiptValues(receipt: AllocationDeletionReceipt): readonly string[] {
  return [...scopeValues(receipt), receipt.sandboxId, receipt.containerId, receipt.providerGeneration,
    receipt.policyDigest, receipt.receiptDigest]
}

function field(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new AllocationReceiptError('invalid-evidence')
  return (row as Record<string, unknown>)[key]
}

function one(rows: readonly unknown[]): unknown {
  if (rows.length !== 1) throw new AllocationReceiptError('invalid-evidence')
  return rows[0]
}

/** Durable v1 receipt adapter for a Root configuration that reserves 128 pending slots. */
export class PostgresAllocationReceiptStorage implements AllocationReceiptStorage {
  private migration?: Promise<void>

  /** @param driver - original one-statement Root metadata adapter, settling after the actual connection closes. */
  constructor(private readonly driver: AllocationQuery) {}

  /**
   * Validate the adjacent schema after the original allocation migration has passed.
   * @returns the same migration promise until this adapter instance is replaced.
   */
  migrate(): Promise<void> {
    return this.migration ??= this.driver.query(allocationReceiptMigrationSql, []).then(({ rows }) => {
      if (rows.length !== 0) throw new AllocationReceiptError('invalid-evidence')
    })
  }

  async release(receipt: AllocationDeletionReceipt, capacity: number): Promise<'recorded' | 'conflict' | 'capacity'> {
    if (capacity !== receiptCapacity) throw new AllocationReceiptError('capacity')
    const status = field(one(await this.query(releaseSql, receiptValues(receipt))), 'status')
    if (status !== 'recorded' && status !== 'conflict' && status !== 'capacity') {
      throw new AllocationReceiptError('invalid-evidence')
    }
    return status
  }

  async read(key: AllocationScope): Promise<PersistedDeletionReceipt | undefined> {
    const rows = await this.query(readSql, scopeValues(key))
    if (rows.length === 0) return undefined
    const evidence = field(one(rows), 'evidence')
    if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
      throw new AllocationReceiptError('invalid-evidence')
    }
    // The coordinating outbox validates each returned field and its exact binding before use.
    return evidence as PersistedDeletionReceipt
  }

  async pending(limit: number): Promise<readonly AllocationScope[]> {
    if (limit !== receiptCapacity) throw new AllocationReceiptError('capacity')
    const rows = await this.query(pendingSql, [])
    if (rows.length > limit) throw new AllocationReceiptError('capacity')
    // The coordinating outbox validates each returned key before performing a separate exact read.
    return rows.map(row => field(row, 'scope') as AllocationScope)
  }

  async markAcknowledged(receipt: AllocationDeletionReceipt): Promise<void> {
    if (field(one(await this.query(markSql, receiptValues(receipt))), 'acknowledged') !== true) {
      throw new AllocationReceiptError('ack-unconfirmed')
    }
  }

  private async query(sql: string, values: readonly string[]): Promise<readonly unknown[]> {
    if (this.migration === undefined) throw new AllocationReceiptError('unavailable')
    await this.migration
    return (await this.driver.query(sql, values)).rows
  }
}
