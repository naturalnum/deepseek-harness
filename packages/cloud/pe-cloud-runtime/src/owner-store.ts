/** PostgreSQL-only owner CAS; account assembly, ready publication, and recovery remain separate. */
import { AccountRuntimeError } from './errors.ts'
import { OwnerPgNotSubmittedError } from './owner-pg-errors.ts'
import { accountOwnerMigrationSql } from './migrations/account-owners.ts'
import { ownerEpoch, readOwnerRow } from './owner-row.ts'
import { beginOwnerDrainSql, claimOwnerSql, finishOwnerDrainSql, heartbeatOwnerSql, locateOwnerSql, quarantineOwnerSql } from './owner-sql.ts'
import { RuntimeConfigSchema } from './schema.ts'
import type { AccountId, AccountOwner, OwnerEpoch, RuntimeConfig } from './types.ts'
import type { OwnerClaim, OwnerDrainEvidence, OwnerExpectation, OwnerPgExecutor, OwnerStoreIdentity } from './owner-types.ts'

interface PendingClaim { readonly expectedEpoch: OwnerClaim['expectedEpoch']; readonly recipeVersion: string; readonly actual: Promise<AccountOwner> }
interface MutationResponsibility { readonly epoch: OwnerEpoch; state: 'pending' | 'unknown' }

/** Parameterized owner storage; bounded per-account responsibility survives unknown mutation outcomes. */
export class PostgresOwnerStore {
  private readonly claims = new Map<AccountId, PendingClaim>()
  private readonly responsibilities = new Map<AccountId, MutationResponsibility>()
  private readonly config: RuntimeConfig
  private migration: Promise<void> | undefined
  private migrated = false

  /**
   * Bind a real root-owned database driver and server-generated instance identity.
   * @param executor Real PostgreSQL query adapter with finite driver budgets; no in-memory fallback.
   * @param identity This process's immutable server-generated InstanceId.
   * @param config maxConcurrentMounts bounds claims; maxMountedAccounts bounds pending/unknown account responsibilities.
   */
  constructor(private readonly executor: OwnerPgExecutor, private readonly identity: OwnerStoreIdentity, config: RuntimeConfig) {
    this.config = RuntimeConfigSchema(config)
  }

  /**
   * Apply and validate the package's atomic owner migration, serialized by a PG transaction lock.
   * A failed attempt leaves owner operations closed and may be explicitly retried.
   * @returns Completion after PostgreSQL accepted the migration; no account becomes ready.
   */
  migrate(): Promise<void> {
    this.migration ??= this.applyMigration().catch((cause: unknown) => {
      this.migration = undefined
      throw new AccountRuntimeError('cloud/account-unavailable', 'Owner migration did not complete; owner admission remains closed', { cause })
    })
    return this.migration
  }

  /**
   * Read persisted ownership without creating or reclaiming an account.
   * @param accountId Trusted authenticated account identity.
   * @returns Current metadata or undefined when the row is absent.
   */
  async locate(accountId: AccountId): Promise<AccountOwner | undefined> {
    this.assertMigrated()
    const rows = await this.query(locateOwnerSql, [accountId], false)
    return this.decode(rows)
  }

  /**
   * Atomically claim only a missing, unowned, or same-instance parked account, incrementing epoch.
   * Concurrent identical local claims share the actual DB Promise. This does not merge or start a graph;
   * the future account factory must retain its shared promise through mount completion. Caller cancellation
   * must only stop that caller's wait, never this shared operation.
   * @param input Null expectedEpoch for a missing row; exact prior epoch otherwise, plus approved recipe.
   * @returns Metadata in mounting; no ready publication or native work is performed.
   * @throws AccountRuntimeError on a CAS mismatch, conflicting in-flight input, capacity, or unknown DB result.
   */
  claim(input: OwnerClaim): Promise<AccountOwner> {
    this.assertAccountWritable(input.accountId)
    if (input.expectedEpoch !== null) {
      ownerEpoch(input.expectedEpoch)
      if (input.expectedEpoch === '9223372036854775807') {
        throw new AccountRuntimeError('cloud/capacity', 'Owner epoch space is exhausted')
      }
    }
    if (input.recipeVersion.length === 0) throw new AccountRuntimeError('cloud/invalid-config', 'Owner claim requires an approved recipe version')
    const pending = this.claims.get(input.accountId)
    if (pending !== undefined) {
      if (pending.expectedEpoch !== input.expectedEpoch || pending.recipeVersion !== input.recipeVersion) {
        throw new AccountRuntimeError('cloud/config-conflict', 'Concurrent owner claim inputs conflict')
      }
      return pending.actual
    }
    if (this.claims.size >= this.config.maxConcurrentMounts) {
      throw new AccountRuntimeError('cloud/capacity', 'Concurrent owner claim capacity is exhausted')
    }
    const attemptedEpoch = ownerEpoch(input.expectedEpoch === null ? '1' : (BigInt(input.expectedEpoch) + 1n).toString())
    const actual = this.mutate(claimOwnerSql, [input.accountId, this.identity.instanceId, input.recipeVersion, input.expectedEpoch], {
      accountId: input.accountId, epoch: attemptedEpoch,
    })
    this.claims.set(input.accountId, { expectedEpoch: input.expectedEpoch, recipeVersion: input.recipeVersion, actual })
    void actual.then(() => { this.claims.delete(input.accountId) }, () => { this.claims.delete(input.accountId) })
    return actual
  }

  /**
   * Refresh observation of this exact generation; a heartbeat never authorizes takeover.
   * @param expected Exact current account and epoch owned by this store's instance.
   * @returns Updated metadata with unchanged phase, epoch, recipe, and owner.
   */
  heartbeat(expected: OwnerExpectation): Promise<AccountOwner> {
    return this.mutate(heartbeatOwnerSql, this.expectedValues(expected), expected)
  }

  /**
   * CAS known mounting cleanup or a ready graph into draining, without publishing ready or performing teardown.
   * Unknown setup remains quarantined and cannot enter this normal cleanup path.
   * @param expected Exact current account and epoch.
   * @returns Draining metadata, or rejects without changing any other phase or stale row.
   */
  beginDrain(expected: OwnerExpectation): Promise<AccountOwner> {
    return this.mutate(beginOwnerDrainSql, this.expectedValues(expected), expected)
  }

  /**
   * Persist quarantine while retaining owner and epoch; no normal method clears it.
   * @param expected Exact current account and epoch.
   * @returns Quarantined metadata for the same owner.
   */
  quarantine(expected: OwnerExpectation): Promise<AccountOwner> {
    return this.mutate(quarantineOwnerSql, this.expectedValues(expected), expected)
  }

  /**
   * CAS a fully drained graph to unowned, retaining its epoch row for the next increment.
   * Incomplete matching evidence quarantines the exact owned generation instead. Recovery/unquarantine
   * is deliberately absent until the trusted verifier and persistent allocation coverage are available.
   * @param expected Exact current owner generation.
   * @param evidence Actual teardown evidence from runtime and its mandatory providers, never browser JSON.
   * @returns Unowned metadata only after all required evidence and the draining CAS succeed.
   */
  release(expected: OwnerExpectation, evidence: OwnerDrainEvidence): Promise<AccountOwner> {
    return this.finishDrain(expected, evidence, 'unowned')
  }

  /**
   * Retain instance ownership after fully confirmed teardown; reassembly must claim a new epoch.
   * @param expected Exact current owner generation.
   * @param evidence Actual complete teardown results.
   * @returns Parked metadata, not a live or reusable graph.
   */
  park(expected: OwnerExpectation, evidence: OwnerDrainEvidence): Promise<AccountOwner> {
    return this.finishDrain(expected, evidence, 'parked')
  }

  private async applyMigration(): Promise<void> {
    await this.executor.query(accountOwnerMigrationSql, [])
    this.migrated = true
  }

  private expectedValues(expected: OwnerExpectation): readonly string[] {
    ownerEpoch(expected.epoch)
    return [expected.accountId, this.identity.instanceId, expected.epoch]
  }

  private async finishDrain(expected: OwnerExpectation, evidence: OwnerDrainEvidence, target: 'unowned' | 'parked'): Promise<AccountOwner> {
    this.assertAccountWritable(expected.accountId)
    if (evidence.accountId !== expected.accountId || evidence.epoch !== expected.epoch
      || evidence.configSaves.accountId !== expected.accountId || evidence.configSaves.epoch !== expected.epoch
      || evidence.participants.some(receipt => receipt.accountId !== expected.accountId || receipt.epoch !== expected.epoch)) {
      throw new AccountRuntimeError('cloud/stale-generation', 'Teardown evidence does not belong to this generation')
    }
    const participants = new Set(evidence.participants.map(receipt => receipt.participant))
    const clean = evidence.nativeIdle && evidence.persistenceFlushed && evidence.contextDisposed && evidence.disposalErrors.length === 0
      && evidence.configSaves.status === 'confirmed' && evidence.configSaves.pendingOperationIds.length === 0 && evidence.configSaves.failures.length === 0
      && evidence.participants.length === 2 && participants.has('files') && participants.has('execution')
      && evidence.participants.every(receipt => receipt.status === 'confirmed')
    if (!clean) {
      await this.quarantine(expected)
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Teardown is incomplete; owner remains quarantined')
    }
    return this.mutate(finishOwnerDrainSql, [...this.expectedValues(expected), target], expected)
  }

  private async mutate(sql: string, values: readonly (string | null)[], expected: OwnerExpectation): Promise<AccountOwner> {
    this.assertAccountWritable(expected.accountId)
    if (this.responsibilities.has(expected.accountId)) {
      throw new AccountRuntimeError('cloud/config-busy', 'An owner write for this account is still pending')
    }
    if (this.responsibilities.size >= this.config.maxMountedAccounts) {
      throw new AccountRuntimeError('cloud/capacity', 'Owner observation capacity is exhausted; unresolved records are retained')
    }
    const responsibility: MutationResponsibility = { epoch: expected.epoch, state: 'pending' }
    this.responsibilities.set(expected.accountId, responsibility)
    let owner: AccountOwner | undefined
    try { owner = this.decode(await this.query(sql, values, true)) }
    catch (error) {
      if (error instanceof OwnerPgNotSubmittedError) this.responsibilities.delete(expected.accountId)
      else responsibility.state = 'unknown'
      throw error
    }
    this.responsibilities.delete(expected.accountId)
    if (owner === undefined) throw new AccountRuntimeError('cloud/stale-generation', 'Owner CAS did not match; inspect current ownership before retrying')
    return owner
  }

  private async query(sql: string, values: readonly (string | null)[], mutation: boolean): Promise<readonly unknown[]> {
    try { return (await this.executor.query(sql, values)).rows }
    catch (cause) {
      if (cause instanceof OwnerPgNotSubmittedError) throw cause
      throw new AccountRuntimeError('cloud/account-unavailable', mutation
        ? 'Owner write outcome is unknown; writes for this account remain closed'
        : 'Owner lookup failed; do not infer an unowned account', { cause })
    }
  }

  private decode(rows: readonly unknown[]): AccountOwner | undefined {
    if (rows.length === 0) return undefined
    if (rows.length !== 1) throw new AccountRuntimeError('cloud/account-unavailable', 'Owner query returned ambiguous metadata')
    return readOwnerRow(rows[0])
  }

  private assertMigrated(): void {
    if (!this.migrated) throw new AccountRuntimeError('cloud/account-unavailable', 'Owner migration must complete before database operations')
  }

  private assertAccountWritable(accountId: AccountId): void {
    this.assertMigrated()
    const responsibility = this.responsibilities.get(accountId)
    if (responsibility?.state === 'unknown') {
      throw new AccountRuntimeError('cloud/account-quarantined', `Owner write for epoch ${responsibility.epoch} is unresolved; this account remains closed`)
    }
  }
}
