/** PostgreSQL-only owner CAS; account assembly, ready publication, and recovery remain separate. */
import { AccountRuntimeError } from './errors.ts'
import { OwnerPgNotSubmittedError } from './owner-pg-errors.ts'
import { accountOwnerMigrationSql } from './migrations/account-owners.ts'
import { ownerEpoch, readOwnerRow } from './owner-row.ts'
import { beginOwnerDrainSql, claimOwnerSql, finishOwnerDrainSql, heartbeatOwnerSql, locateOwnerSql, quarantineOwnerSql, readyOwnerSql } from './owner-sql.ts'
import { recoveryAuditMigrationSql } from './migrations/recovery-audit.ts'
import { beginOwnerReconfigurationSql, finishOwnerReconfigurationSql } from './owner-sql.ts'
import { bindRecoveryAuthority, readRecoveryAudit, readRecoveryProof } from './owner-recovery.ts'
import { inspectRecoverySql, recoverReleasedSql, closeRecoveredInstanceSql, inspectRecoveredInstanceSql } from './owner-sql.ts'
import { RuntimeConfigSchema } from './schema.ts'
import type { AccountId, AccountOwner, OwnerEpoch, RuntimeConfig } from './types.ts'
import type { OwnerClaim, OwnerDrainEvidence, OwnerExpectation, OwnerPgExecutor, OwnerStoreIdentity,
  OwnerRecoveryAuthority, OwnerRecoveryExpectation, OwnerRecoveryObservation, OwnerRecoveryAudit,
  RecoveredInstanceExpectation, RecoveredInstanceObservation, RecoveredInstanceCloseResult } from './owner-types.ts'

interface PendingClaim { readonly expectedEpoch: OwnerClaim['expectedEpoch']; readonly recipeVersion: string; readonly actual: Promise<AccountOwner> }
interface MutationResponsibility { readonly epoch: OwnerEpoch; state: 'pending' | 'unknown' }

/** Parameterized owner storage; bounded per-account responsibility survives unknown mutation outcomes. */
export class PostgresOwnerStore {
  private readonly claims = new Map<AccountId, PendingClaim>()
  private readonly responsibilities = new Map<AccountId, MutationResponsibility>()
  private readonly config: RuntimeConfig
  private migration: Promise<void> | undefined
  private migrated = false
  private recoveryMigrated = false
  private recoveryMigration: Promise<void> | undefined
  private readonly recovery: OwnerRecoveryAuthority | undefined

  /**
   * Bind a real root-owned database driver and server-generated instance identity.
   * @param executor Real PostgreSQL query adapter with finite driver budgets; no in-memory fallback.
   * @param identity This process's immutable server-generated InstanceId.
   * @param recovery Optional constructor-only trusted verifier; omission keeps recovery closed.
   * @param config maxConcurrentMounts bounds claims; maxMountedAccounts bounds pending/unknown account responsibilities.
   */
  constructor(
    private readonly executor: OwnerPgExecutor, private readonly identity: OwnerStoreIdentity, config: RuntimeConfig,
    recovery?: OwnerRecoveryAuthority,
  ) {
    this.config = RuntimeConfigSchema(config)
    this.recovery = recovery === undefined ? undefined : bindRecoveryAuthority(identity, recovery)
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
   * Commit mounting metadata after the private factory has verified its actual graph and providers.
   * This CAS does not perform that audit, publish AccountUse, or authorize a caller-supplied ready flag.
   * A rejected submitted write retains the same unknown-result responsibility as other mutations.
   * @param expected Exact account and epoch owned by this store's process instance.
   * @param recipeVersion Approved recipe already verified by the factory for this mounting graph.
   * @returns Ready metadata only when phase, instance, epoch and recipe still match.
   */
  ready(expected: OwnerExpectation, recipeVersion: string): Promise<AccountOwner> {
    if (recipeVersion.length === 0) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Owner readiness requires an approved recipe version')
    }
    return this.mutate(readyOwnerSql, [...this.expectedValues(expected), recipeVersion], expected)
  }

  /** Enter a factory-owned local update after its zero-write idle check.
   * @param expected Original ready account/instance/epoch.
   * @returns Same owned generation in reconfiguring; unknown writes retain this store's responsibility.
   */
  beginReconfiguration(expected: OwnerExpectation): Promise<AccountOwner> {
    return this.mutate(beginOwnerReconfigurationSql, this.expectedValues(expected), expected)
  }

  /** Republish the same generation only after the factory's actual native re-audit.
   * @param expected Original account/instance/epoch in reconfiguring.
   * @param recipeVersion Unchanged approved recipe.
   * @returns Same generation in ready; this CAS never performs the native audit.
   */
  finishReconfiguration(expected: OwnerExpectation, recipeVersion: string): Promise<AccountOwner> {
    if (!recipeVersion) throw new AccountRuntimeError('cloud/invalid-config', 'Owner readiness requires an approved recipe version')
    return this.mutate(finishOwnerReconfigurationSql, [...this.expectedValues(expected), recipeVersion], expected)
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
   * Incomplete matching evidence quarantines the exact owned generation instead.
   * Normal teardown never substitutes for trusted crash recovery or its persistent allocation checks.
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

  /** Install only the protected recovery audit/function after owner and execution allocation migrations.
   * @returns Actual DDL settlement; does not run recovery or open Root/account admission.
   */
  migrateRecovery(): Promise<void> {
    this.assertMigrated()
    if (this.recovery === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'No trusted recovery verifier is selected')
    this.recoveryMigration ??= this.executor.query(recoveryAuditMigrationSql, []).then(() => {
      this.recoveryMigrated = true
    }).catch((cause: unknown) => {
      this.recoveryMigration = undefined
      throw new AccountRuntimeError('cloud/account-unavailable', 'Recovery audit migration did not complete; recovery remains closed', { cause })
    })
    return this.recoveryMigration
  }

  /** Read exact immutable audit/postimage and the current owner in one snapshot; never retry or clear unknown writes.
   * @param input Trusted exact old owner/epoch/audit identity.
   * @returns Historical commit evidence, current metadata and whether that exact postimage still matches.
   */
  async inspectRecovery(input: OwnerRecoveryExpectation): Promise<OwnerRecoveryObservation> {
    const authority = this.requireRecovery(), expected = this.recoveryExpected(input)
    const rows = await this.query(inspectRecoverySql, [expected.auditRef, expected.accountId], false)
    if (rows.length !== 1 || rows[0] === null || typeof rows[0] !== 'object') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Recovery audit lookup returned ambiguous metadata')
    }
    const value: unknown = Reflect.get(rows[0], 'recovery'), currentValue: unknown = Reflect.get(rows[0], 'owner')
    const matches: unknown = Reflect.get(rows[0], 'matches')
    if (typeof matches !== 'boolean') throw new AccountRuntimeError('cloud/account-unavailable', 'Recovery postimage comparison is not trusted')
    const audit = value === null ? undefined : readRecoveryAudit(value, expected, authority)
    const current = currentValue === null ? undefined : readOwnerRow({ owner: currentValue })
    if (current !== undefined && current.accountId !== expected.accountId) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Recovery lookup returned a different account')
    }
    return Object.freeze({ audit, current, matchesPostimage: matches && audit !== undefined && current !== undefined
      && current.accountId === audit.postimage.accountId && current.epoch === audit.postimage.epoch
      && current.phase === 'unowned' && current.ownerInstanceId === null && current.updatedAt === audit.postimage.updatedAt,
    responsibilityRetained: this.responsibilities.has(expected.accountId) })
  }

  /** Recover an exact dead old owner only through the selected read-only verifier and atomic guarded SQL.
   * @param input Trusted old identity and stable audit reference; proof is obtained internally, never from request JSON.
   * @returns Immutable committed historical postimage. Duplicate successful references skip verifier and mutation.
   * Unknown driver/decoder outcomes retain the existing account write responsibility; inspectRecovery is read-only.
   */
  async recoverReleased(input: OwnerRecoveryExpectation): Promise<OwnerRecoveryAudit> {
    const authority = this.requireRecovery(), expected = this.recoveryExpected(input)
    this.assertAccountWritable(expected.accountId)
    if (this.responsibilities.has(expected.accountId)) {
      throw new AccountRuntimeError('cloud/config-busy', 'An owner write for this account is still pending')
    }
    if (this.responsibilities.size >= this.config.maxMountedAccounts) {
      throw new AccountRuntimeError('cloud/capacity', 'Owner observation capacity is exhausted; unresolved records are retained')
    }
    const responsibility: MutationResponsibility = { epoch: expected.epoch, state: 'pending' }
    this.responsibilities.set(expected.accountId, responsibility)
    let unknown = false
    try {
      const prior = await this.inspectRecovery(expected)
      if (prior.audit !== undefined) return prior.audit
      const proof = readRecoveryProof(await authority.verify(expected), expected, authority, true)
      unknown = true
      const rows = await this.query(recoverReleasedSql, [expected.accountId, expected.oldInstanceId, expected.epoch,
        expected.auditRef, JSON.stringify(proof), String(authority.limits.maxAllocations), String(authority.limits.maxAuditRows),
        String(authority.limits.maxProofAgeMs)], true)
      if (rows.length === 0) {
        unknown = false
        throw new AccountRuntimeError('cloud/stale-generation', 'Recovery CAS or allocation/audit guard refused; inspect exact state before continuing')
      }
      if (rows.length !== 1 || rows[0] === null || typeof rows[0] !== 'object') {
        throw new AccountRuntimeError('cloud/account-unavailable', 'Recovery write returned ambiguous metadata')
      }
      const audit = readRecoveryAudit(Reflect.get(rows[0], 'recovery'), expected, authority)
      unknown = false
      return audit
    } catch (error) {
      if (unknown && !(error instanceof OwnerPgNotSubmittedError)) responsibility.state = 'unknown'
      throw error
    } finally {
      if (responsibility.state !== 'unknown') this.responsibilities.delete(expected.accountId)
    }
  }

  /** Read exact old registration closure/audit and every retained old owner without changing responsibility.
   * @param input Exact old registration and committed account-audit anchor.
   * @returns Actual closure postimage and retained-owner observations, never process-death authority.
   */
  async inspectRecoveredInstance(input: RecoveredInstanceExpectation): Promise<RecoveredInstanceObservation> {
    this.requireRecovery()
    const expected = this.recoveredInstanceExpected(input)
    const rows = await this.query(inspectRecoveredInstanceSql, [expected.accountId, expected.oldInstanceId, expected.epoch,
      expected.auditRef, expected.internalAddress, expected.recipeVersion], false)
    if (rows.length !== 1 || rows[0] === null || typeof rows[0] !== 'object') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Recovered instance lookup is ambiguous')
    }
    const audited: unknown = Reflect.get(rows[0], 'audited'), closed: unknown = Reflect.get(rows[0], 'closed')
    const retained: unknown = Reflect.get(rows[0], 'retained')
    if (typeof audited !== 'boolean' || typeof closed !== 'boolean' || typeof retained !== 'boolean') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Recovered instance lookup is not trusted')
    }
    return Object.freeze({ audited, closed, retainedOwners: retained,
      responsibilityRetained: this.responsibilities.has(expected.accountId) })
  }

  /** Close only an exact recovered old registration; never close this process or substitute normal clean receipts.
   * @param input Original old registration plus its exact committed recovery audit/owner generation.
   * @returns Confirmed exact closure; duplicate closure skips verification and SQL.
   * Submitted unknown outcomes stay in the same bounded owner responsibility map, anchored by account/epoch.
   */
  async closeRecoveredInstance(input: RecoveredInstanceExpectation): Promise<RecoveredInstanceCloseResult> {
    const authority = this.requireRecovery(), expected = this.recoveredInstanceExpected(input)
    this.assertAccountWritable(expected.accountId)
    if (this.responsibilities.has(expected.accountId)) {
      throw new AccountRuntimeError('cloud/config-busy', 'An owner write for this account is still pending')
    }
    if (this.responsibilities.size >= this.config.maxMountedAccounts) {
      throw new AccountRuntimeError('cloud/capacity', 'Owner observation capacity is exhausted; unresolved records are retained')
    }
    const responsibility: MutationResponsibility = { epoch: expected.epoch, state: 'pending' }
    this.responsibilities.set(expected.accountId, responsibility)
    let unknown = false
    try {
      const audit = await this.inspectRecovery(expected), prior = await this.inspectRecoveredInstance(expected)
      if (audit.audit === undefined || !prior.audited || prior.retainedOwners) {
        throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Instance closure requires its exact audit and every old owner released')
      }
      if (prior.closed) return Object.freeze({ instanceId: expected.oldInstanceId, auditRef: expected.auditRef, alreadyClosed: true })
      if (!audit.matchesPostimage) throw new AccountRuntimeError('cloud/stale-generation', 'The audited owner postimage no longer matches')
      const anchor = this.recoveryExpected(expected)
      const proof = readRecoveryProof(await authority.verify(anchor), anchor, authority, true)
      unknown = true
      const rows = await this.query(closeRecoveredInstanceSql, [expected.accountId, expected.oldInstanceId, expected.epoch,
        expected.auditRef, expected.internalAddress, expected.recipeVersion, JSON.stringify(proof),
        String(authority.limits.maxProofAgeMs)], true)
      if (rows.length === 0) {
        unknown = false
        throw new AccountRuntimeError('cloud/stale-generation', 'Recovered instance CAS or writer/owner guard refused')
      }
      if (rows.length !== 1 || rows[0] === null || typeof rows[0] !== 'object'
        || Reflect.get(rows[0], 'closed_instance') !== expected.oldInstanceId) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'Recovered instance closure returned ambiguous metadata')
      }
      unknown = false
      return Object.freeze({ instanceId: expected.oldInstanceId, auditRef: expected.auditRef, alreadyClosed: false })
    } catch (error) {
      if (unknown && !(error instanceof OwnerPgNotSubmittedError)) responsibility.state = 'unknown'
      throw error
    } finally {
      if (responsibility.state !== 'unknown') this.responsibilities.delete(expected.accountId)
    }
  }

  private recoveredInstanceExpected(input: RecoveredInstanceExpectation): Readonly<RecoveredInstanceExpectation> {
    const expected = this.recoveryExpected(input), maximum = this.recovery?.limits.maxReferenceBytes ?? 0
    if ([input.internalAddress, input.recipeVersion].some(value => value.length === 0 || Buffer.byteLength(value) > maximum)) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Recovered instance registration fields must be bounded and exact')
    }
    return Object.freeze({ ...expected, internalAddress: input.internalAddress, recipeVersion: input.recipeVersion })
  }

  private requireRecovery(): OwnerRecoveryAuthority {
    this.assertMigrated()
    if (!this.recoveryMigrated || this.recovery === undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Trusted recovery audit and verifier are not installed')
    }
    return this.recovery
  }

  private recoveryExpected(input: OwnerRecoveryExpectation): Readonly<OwnerRecoveryExpectation> {
    ownerEpoch(input.epoch)
    const maximum = this.recovery?.limits.maxReferenceBytes ?? 0
    if (input.oldInstanceId === this.identity.instanceId
      || [input.accountId, input.oldInstanceId, input.auditRef].some(value => value.length === 0 || Buffer.byteLength(value) > maximum)) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Recovery requires bounded exact identities of a different dead process')
    }
    return Object.freeze({ accountId: input.accountId, oldInstanceId: input.oldInstanceId, epoch: input.epoch, auditRef: input.auditRef })
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
