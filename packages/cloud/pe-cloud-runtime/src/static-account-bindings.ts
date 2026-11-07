/** Durable assignment of authentic account IDs to immutable, preallocated storage slots. */
import type { AccountId, RootMetadataDatabase } from './types.ts'
import { AccountRuntimeError } from './errors.ts'

/** Sanitized Root-owned inventory; paths and filesystem facts remain with Files. */
export interface StaticAccountInventory {
  readonly sha256: string
  readonly maxAccounts: number
  readonly slots: readonly Readonly<{ slotId: string; templateId: string }>[]
}
/** Immutable account-to-slot identity, independent of resource preparation state. */
export interface StaticAccountAssignment {
  readonly accountId: AccountId
  readonly slotId: string
  readonly revision: string
}
/** Root-only synchronous resolver installed into the original Files owner. */
export interface StaticAccountAssignmentResolver {
  lookup(accountId: AccountId): StaticAccountAssignment | undefined
  list(): readonly StaticAccountAssignment[]
  assertCurrent(assignment: StaticAccountAssignment): void
}
/** Access budgets retained by the same management transaction while actual resources prepare. */
export interface AccountAdministrationBudgets {
  readonly idleTransactionTimeoutMs: number
  readonly authStatementTimeoutMs: number
  readonly authConnectionTimeoutMs: number
  readonly authOperationTimeoutMs: number
}

/** Compute the minimum retained transaction budget before any administrator route opens.
 * @param accountWaitTimeoutMs Original factory observation bound.
 * @param queryBounds Original metadata executor queue and statement bounds.
 * @param slotCount Finite physical inventory size; zero denotes the legacy path.
 * @param budgets Actual authentication pool/operation budgets.
 * @returns Milliseconds covering all bounded slot attempts, actual mount and final provider calls.
 */
export function accountAdministrationTransactionBudget(accountWaitTimeoutMs: number,
  queryBounds: Readonly<{ queueTimeoutMs: number; statementTimeoutMs: number }>, slotCount: number,
  budgets: AccountAdministrationBudgets): number {
  const maximumQueries = slotCount === 0 ? 0 : 2 * slotCount + 10
  const required = accountWaitTimeoutMs + maximumQueries * (queryBounds.queueTimeoutMs + queryBounds.statementTimeoutMs)
    + budgets.authOperationTimeoutMs + 2 * (budgets.authConnectionTimeoutMs + budgets.authStatementTimeoutMs)
  if (!Number.isSafeInteger(required) || budgets.idleTransactionTimeoutMs < required) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Account administration transaction timeout is shorter than resource preparation bounds')
  }
  return required
}

/** Resource progress never substitutes for the native factory's actual ready/drain checks. */
export type AccountResourcePhase = 'reserved' | 'preparing' | 'ready' | 'disabled' | 'failed' | 'stop-unknown'
/** Durable resource status; workflow revision changes do not revoke the unchanged storage identity. */
export interface AccountResourceRecord {
  readonly assignment: StaticAccountAssignment
  readonly phase: AccountResourcePhase
  readonly revision: string
  readonly operationId: string
}

const phases: readonly AccountResourcePhase[] = ['reserved', 'preparing', 'ready', 'disabled', 'failed', 'stop-unknown']
function unavailable(): never { throw new AccountRuntimeError('cloud/account-unavailable', 'The static account assignment is unavailable.') }
function field(row: object, name: string): string {
  const value: unknown = Reflect.get(row, name)
  return typeof value === 'string' && value.length > 0 ? value : unavailable()
}

/** One Root's bounded cache over the existing runtime metadata database, never an authentication database. */
export class StaticAccountBindings {
  private readonly records = new Map<AccountId, AccountResourceRecord>()
  private accepting = true
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly database: RootMetadataDatabase, readonly inventory: StaticAccountInventory,
    private readonly current: () => void) {}

  /** Create the owned metadata table and verify all retained rows against the immutable inventory.
   * @returns Actual migration and bounded cache loading settlement.
   */
  async initialize(): Promise<void> {
    this.check()
    await this.query(`CREATE TABLE IF NOT EXISTS pe_account_static_bindings (
      account_id text PRIMARY KEY,
      inventory_sha256 text NOT NULL CHECK (inventory_sha256 ~ '^[a-f0-9]{64}$'),
      slot_id text NOT NULL UNIQUE,
      binding_revision bigint NOT NULL DEFAULT 1 CHECK (binding_revision > 0),
      workflow_revision bigint NOT NULL DEFAULT 1 CHECK (workflow_revision > 0),
      phase text NOT NULL CHECK (phase IN ('reserved','preparing','ready','disabled','failed','stop-unknown')),
      operation_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`, [])
    await this.refreshAll()
  }

  /** Refresh the finite inventory occupancy from the authoritative metadata rows.
   * @returns Original mapping objects remain stable while workflow status is refreshed.
   */
  async refreshAll(): Promise<void> {
    this.check()
    const result = await this.query(`SELECT account_id, inventory_sha256, slot_id, binding_revision::text,
      workflow_revision::text, phase, operation_id FROM pe_account_static_bindings LIMIT $1::integer`,
    [String(this.inventory.maxAccounts + 1)])
    if (result.rows.length > this.inventory.maxAccounts) unavailable()
    const slots = new Set<string>(), accounts = new Set<AccountId>()
    for (const raw of result.rows) {
      const record = this.publish(raw)
      if (slots.has(record.assignment.slotId)) unavailable()
      slots.add(record.assignment.slotId); accounts.add(record.assignment.accountId)
    }
    if ([...this.records.keys()].some(id => !accounts.has(id))) unavailable()
  }

  /** Current original mapping, carrying no file lease or login authority.
   * @param accountId Original authentic account identity.
   * @returns Its retained mapping or absence.
   */
  lookup(accountId: AccountId): StaticAccountAssignment | undefined { this.check(); return this.records.get(accountId)?.assignment }

  /** Read the current status from the last bounded authoritative refresh.
   * @param accountId Authentic account identity.
   * @returns Existing assignment/status or absence.
   */
  status(accountId: AccountId): AccountResourceRecord | undefined { this.check(); return this.records.get(accountId) }

  /** Current finite mapping list used by Files' Root-owned cold-proof verification.
   * @returns Original mapping objects from this exact registry.
   */
  list(): readonly StaticAccountAssignment[] { this.check(); return Object.freeze([...this.records.values()].map(row => row.assignment)) }

  /** Require the original immutable binding object and its unchanged slot identity.
   * @param assignment Original mapping captured by Files.
   */
  assertCurrent(assignment: StaticAccountAssignment): void {
    this.check()
    if (this.records.get(assignment.accountId)?.assignment !== assignment) unavailable()
  }

  /** Reload the exact account's durable status without replacing an unchanged mapping object.
   * @param accountId Authentic account, never a browser-selected actor.
   * @returns Confirmed resource record or absence.
   */
  async refresh(accountId: AccountId): Promise<AccountResourceRecord | undefined> {
    this.check()
    const result = await this.query(`SELECT account_id, inventory_sha256, slot_id, binding_revision::text,
      workflow_revision::text, phase, operation_id FROM pe_account_static_bindings WHERE account_id = $1`, [accountId])
    if (result.rows.length > 1) unavailable()
    if (result.rows[0] === undefined) {
      if (this.records.has(accountId)) unavailable()
      return undefined
    }
    return this.publish(result.rows[0])
  }

  /** Reserve one real free slot of a declared template. Failed preparations retain their assigned slot.
   * @param accountId Newly created authentic user, kept banned until actual readiness.
   * @param templateId Sanitized template selected from the immutable inventory.
   * @param operationId Original management idempotency identifier.
   * @returns Persistent assignment, idempotent for that same account.
   */
  async reserve(accountId: AccountId, templateId: string, operationId: string): Promise<AccountResourceRecord> {
    const existing = await this.refresh(accountId)
    if (existing !== undefined) return existing
    const candidates = this.inventory.slots.filter(slot => slot.templateId === templateId)
    if (candidates.length === 0) throw new AccountRuntimeError('cloud/capacity', 'No prepared storage template is available.')
    const slots = JSON.stringify(candidates.map(slot => slot.slotId))
    // Each statement owns its transaction and connection through the original bounded executor.
    // Unique constraints reject competing snapshots; a new bounded attempt observes the committed winner.
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      await this.query(`WITH held AS MATERIALIZED (SELECT pg_advisory_xact_lock(1346715981, 2)),
        candidate AS MATERIALIZED (
          SELECT value AS slot_id FROM held, jsonb_array_elements_text($2::jsonb)
          WHERE NOT EXISTS (SELECT 1 FROM pe_account_static_bindings WHERE slot_id = value)
          ORDER BY value LIMIT 1
        )
        INSERT INTO pe_account_static_bindings(account_id, inventory_sha256, slot_id, phase, operation_id)
        SELECT $1, $3, slot_id, 'reserved', $4 FROM candidate
        WHERE (SELECT count(*) FROM pe_account_static_bindings) < $5::integer
        ON CONFLICT DO NOTHING`, [accountId, slots, this.inventory.sha256, operationId, String(this.inventory.maxAccounts)])
      const record = await this.refresh(accountId)
      if (record !== undefined) return record
    }
    throw new AccountRuntimeError('cloud/capacity', 'All prepared account storage slots are assigned.')
  }

  /** Seed only explicit authentic deployment assignments, refusing changes to an existing binding.
   * @param accountId Trusted initial account identity.
   * @param slotId Trusted exact inventory slot, not a browser input.
   * @returns Original persistent assignment.
   */
  async seed(accountId: AccountId, slotId: string): Promise<AccountResourceRecord> {
    this.check()
    if (!this.inventory.slots.some(slot => slot.slotId === slotId)) unavailable()
    await this.query(`INSERT INTO pe_account_static_bindings(account_id, inventory_sha256, slot_id, phase, operation_id)
      VALUES ($1, $2, $3, 'reserved', 'deployment-seed') ON CONFLICT(account_id) DO NOTHING`, [accountId, this.inventory.sha256, slotId])
    const record = await this.refresh(accountId)
    if (record === undefined || record.assignment.slotId !== slotId) unavailable()
    return record
  }

  /** Commit an observed resource transition with a workflow CAS, preserving the unchanged binding revision.
   * @param original Original exact status read before the owned operation.
   * @param phase Actual resulting resource status.
   * @param operationId Original owning operation identifier.
   * @returns Updated durable status or a conflict without overwriting another operation.
   */
  async transition(original: AccountResourceRecord, phase: AccountResourcePhase, operationId: string): Promise<AccountResourceRecord> {
    this.assertCurrent(original.assignment)
    const result = await this.query(`UPDATE pe_account_static_bindings SET phase = $3,
      workflow_revision = workflow_revision + 1, operation_id = $4, updated_at = clock_timestamp()
      WHERE account_id = $1 AND workflow_revision = $2::bigint
      RETURNING account_id, inventory_sha256, slot_id, binding_revision::text, workflow_revision::text, phase, operation_id`,
    [original.assignment.accountId, original.revision, phase, operationId])
    if (result.rows.length !== 1) throw new AccountRuntimeError('cloud/stale-generation', 'Account resource status changed during the operation.')
    return this.publish(result.rows[0])
  }

  /** Withdraw the resolver after native drains, and join actual metadata operations before database closure.
   * @returns Actual metadata quiescence; assigned persistent storage is preserved.
   */
  async close(): Promise<void> { this.accepting = false; await Promise.allSettled([...this.pending]) }

  private check(): void { this.current(); if (!this.accepting) unavailable() }
  private query(text: string, values: readonly (string | null)[]) {
    this.check()
    const actual = this.database.query(text, values)
    this.pending.add(actual)
    void actual.finally(() => { this.pending.delete(actual) }).catch(() => {})
    return actual
  }
  private publish(raw: unknown): AccountResourceRecord {
    this.check()
    if (raw === null || typeof raw !== 'object') return unavailable()
    const accountId = field(raw, 'account_id') as AccountId, slotId = field(raw, 'slot_id')
    const bindingRevision = field(raw, 'binding_revision'), revision = field(raw, 'workflow_revision'), phase = field(raw, 'phase')
    if (field(raw, 'inventory_sha256') !== this.inventory.sha256 || !this.inventory.slots.some(slot => slot.slotId === slotId)
      || !/^[1-9]\d{0,18}$/.test(bindingRevision) || !/^[1-9]\d{0,18}$/.test(revision)
      || !phases.includes(phase as AccountResourcePhase)) unavailable()
    const old = this.records.get(accountId)
    if (old === undefined && this.records.size >= this.inventory.maxAccounts) unavailable()
    if (old !== undefined && (old.assignment.slotId !== slotId || old.assignment.revision !== bindingRevision)) unavailable()
    const assignment = old?.assignment ?? Object.freeze({ accountId, slotId, revision: bindingRevision })
    const record = Object.freeze({ assignment, phase: phase as AccountResourcePhase, revision, operationId: field(raw, 'operation_id') })
    this.records.set(accountId, record)
    return record
  }
}
