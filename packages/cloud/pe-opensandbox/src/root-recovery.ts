/** The existing Root Loader's closed maintenance owner; it exposes neither account graphs nor SDK execution. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountId, AccountRecoveryRuntime, AccountRuntimeService, InstanceId, OwnerRecoveryExpectation,
  OwnerRecoveryProof, ParticipantReceipt, RecoveryAuditRef } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { SandboxCoordinator } from './coordinator.ts'
import type { AccountExecutionPort } from './account-port.ts'
import { allocationDatabase } from './allocation-database.ts'
import { PostgresAllocationStore } from './allocation-store.ts'
import { captureOldAllocationRecoverySnapshot, reconcileOldAllocationEpoch,
  type AllocationRecoveryLimits, type AllocationRecoverySnapshot } from './allocation-recovery.ts'
import { ExecutionStateError } from './errors.ts'
import { BootstrapFailure } from './bootstrap/bootstrap.ts'
import type { ManagedCoordinatorConfig } from './managed-coordinator.ts'
import { openRootRecoveryReference, parseRootRecoveryReference,
  type RootRecoveryReference, type RootRecoverySelection } from './bootstrap/recovery-reference.ts'
import { recoveryWitnessEvidenceRefs, type RecoveryAccountWitness, type RootRecoveryWitness } from './bootstrap/recovery-witness.ts'

function unavailable(): never {
  throw new ExecutionStateError('cloud/stop-unconfirmed', 'Maintenance recovery is incomplete; ordinary account and execution admission remain closed.')
}

class MaintenanceRecoveryCoordinator extends SandboxCoordinator {
  private readonly actual = Promise.withResolvers<void>()
  private readonly attempted = new Map<AccountId, OwnerRecoveryExpectation>()
  private readonly resources: { store?: PostgresAllocationStore; selection?: RootRecoverySelection; closing?: Promise<void> } = {}
  private readonly observations: AllocationRecoveryLimits

  constructor(ctx: Context, private readonly runtime: AccountRuntimeService, private readonly recovery: AccountRecoveryRuntime,
    private readonly config: ManagedCoordinatorConfig, private readonly reference: RootRecoveryReference) {
    super(ctx)
    this.observations = Object.freeze({ pageSize: config.recoveryPageSize, maxRows: config.store.maxRows,
      maxSnapshotBytes: config.store.maxResultBytes, maxProofBytes: reference.maxBytes, maxReferenceBytes: config.store.maxFieldBytes })
    // Startup's caller reports failure; cleanup independently verifies all actual store/owner responsibilities.
    void this.actual.promise.catch((_cause: unknown) => {})
    try {
      runtime.registerDrainParticipant(this)
      this.resources.store = new PostgresAllocationStore(allocationDatabase(runtime.controlDatabase(this)), config.store)
      ctx.effect(() => () => this.closeRoot(), 'pe-opensandbox: join actual maintenance recovery')
      recovery.registerVerifier(this, { id: 'local-original-process-and-provider-v1', verify: expected => this.proof(expected) })
      void this.run().then(this.actual.resolve, this.actual.reject)
    } catch (cause) {
      this.actual.reject(cause)
      throw cause
    }
  }

  override assertReady(): void { unavailable() }
  override bindAccount(): AccountExecutionPort { return unavailable() }
  override stopEpoch(): Promise<ParticipantReceipt> {
    return Promise.reject(new ExecutionStateError('cloud/stop-unconfirmed', 'Maintenance recovery cannot supply an ordinary generation drain receipt.'))
  }

  whenRecovered(): Promise<void> { return this.actual.promise }

  closeRoot(): Promise<void> {
    return this.resources.closing ??= (async () => {
      // Known startup refusal is separate from unresolved actual work, just as in the original bootstrap stop chain.
      await this.actual.promise.catch((cause: unknown) => {
        if (cause instanceof BootstrapFailure && (cause.code === 'wire-unknown' || cause.code === 'command-unknown')) throw cause
      })
      const retained = this.resources.store?.inspect()
      if (retained !== undefined && (retained.pendingQueries !== 0 || retained.mutationResponsibilities !== 0)) unavailable()
      for (const expected of this.attempted.values()) {
        if ((await this.recovery.inspectAccount(this, expected)).responsibilityRetained) unavailable()
      }
      this.resources.selection?.close()
    })()
  }

  private get store(): PostgresAllocationStore {
    const store = this.resources.store
    return store === undefined ? unavailable() : store
  }
  private get witness(): RootRecoveryWitness {
    const selection = this.resources.selection
    return selection === undefined ? unavailable() : selection.witness
  }

  private expected(account: RecoveryAccountWitness): OwnerRecoveryExpectation {
    const facts = this.witness.facts
    const digest = createHash('sha256').update(JSON.stringify([facts.auditRef, facts.oldInstanceId, account.accountId, account.epoch])).digest('hex')
    return Object.freeze({ accountId: account.accountId, epoch: account.epoch,
      oldInstanceId: brandString<InstanceId>(facts.oldInstanceId), auditRef: brandString<RecoveryAuditRef>('recovery:' + digest) })
  }

  private async proveRows(account: RecoveryAccountWitness, terminal: boolean): Promise<void> {
    for (const item of account.allocations) {
      const row = await this.store.get(item.intent)
      if (row === undefined) unavailable()
      const selected = this.witness.verifyAllocation(row)
      if (selected.createOutcome === 'rejected-before-provider-create') {
        if (terminal && row.state !== 'failed') unavailable()
      } else if (row.state === 'failed' || terminal && row.state !== 'released') unavailable()
    }
    this.witness.assertCurrent()
  }

  private async proof(expected: Readonly<OwnerRecoveryExpectation>): Promise<OwnerRecoveryProof> {
    const witness = this.witness, facts = witness.facts
    witness.assertCurrent()
    const account = facts.accounts.find(value => value.accountId === expected.accountId && value.epoch === expected.epoch)
    if (account === undefined) return unavailable()
    const original = this.expected(account)
    if (original.auditRef !== expected.auditRef || original.oldInstanceId !== expected.oldInstanceId) unavailable()
    await this.proveRows(account, true)
    const publication = 'sha256:' + this.reference.publication.sha256
    return Object.freeze({ ...original, verifierId: facts.verifierId, verifiedAt: facts.verifiedAt,
      databaseRole: facts.databaseRole, writersVerifiedAt: facts.writersVerifiedAt,
      oldProcessEvidenceRef: facts.processEvidenceRef, writerLossEvidenceRef: facts.writersEvidenceRef,
      lateCreateFenceEvidenceRef: publication, lateSpawnFenceEvidenceRef: publication,
      evidenceRefs: Object.freeze([...new Set([publication, facts.processEvidenceRef, facts.writersEvidenceRef])]),
      allocations: Object.freeze(account.allocations.map(item => Object.freeze({ allocationId: item.intent.allocationId,
        evidenceRefs: Object.freeze([...new Set(recoveryWitnessEvidenceRefs(item))]) }))) })
  }

  private async run(): Promise<void> {
    this.resources.selection = openRootRecoveryReference(this.reference, { maxAccounts: this.config.maxBoundAccounts,
      maxAllocations: this.config.store.maxRows, maxFieldBytes: this.config.store.maxFieldBytes })
    const witness = this.witness, facts = witness.facts, snapshots = new Map<AccountId, AllocationRecoverySnapshot>()
    await this.store.migrate()
    await this.recovery.migrate(this)
    const oldInstance = await this.recovery.locateInstance(this, brandString<InstanceId>(facts.oldInstanceId))
    if (oldInstance === undefined) unavailable()
    // Complete readonly preflight of every declared old account precedes the first allocation reconciliation.
    for (const account of facts.accounts) {
      const owner = await this.runtime.locateAccount(account.accountId)
      if (owner === undefined || owner.epoch !== account.epoch
        || !(owner.ownerInstanceId === facts.oldInstanceId && ['ready', 'mounting', 'draining', 'quarantined'].includes(owner.phase)
          || owner.phase === 'unowned' && owner.ownerInstanceId === null)) unavailable()
      await this.proveRows(account, false)
      const snapshot = await captureOldAllocationRecoverySnapshot(this.store,
        { accountId: account.accountId, epoch: account.epoch }, this.observations)
      for (const entry of snapshot.allocations) witness.verifyAllocation(entry.row)
      snapshots.set(account.accountId, snapshot)
    }
    const publication = 'sha256:' + this.reference.publication.sha256
    for (const account of facts.accounts) {
      await reconcileOldAllocationEpoch(this.store, { scope: { accountId: account.accountId, epoch: account.epoch },
        limits: this.observations, verifier: { id: facts.verifierId, verify: (snapshot) => {
          witness.assertCurrent()
          if (snapshot.digest !== snapshots.get(account.accountId)?.digest) return unavailable()
          return Promise.resolve({ scope: snapshot.scope, snapshotDigest: snapshot.digest, oldProcessExitRef: facts.processEvidenceRef,
            oldWriterWithdrawalRef: facts.writersEvidenceRef, permanentLateCreateSpawnLossRef: publication,
            allocations: snapshot.allocations.map((entry) => {
              const selected = witness.verifyAllocation(entry.row)
              if (selected.createOutcome === 'rejected-before-provider-create') {
                return { allocationId: entry.row.allocationId, rowDigest: entry.digest, intentDigest: entry.intentDigest,
                  createOutcome: 'rejected-before-provider-create' as const, sandboxId: null, refusalCode: selected.refusalCode,
                  refusalRef: selected.knownRefusalEvidenceRef, completedRequestRef: selected.completedRequestEvidenceRef,
                  providerCreateNotStartedRef: selected.providerCreateNotStartedEvidenceRef,
                  permanentLateCreateSpawnLossRef: selected.lateStartsRevokedEvidenceRef }
              }
              return { allocationId: entry.row.allocationId, rowDigest: entry.digest, intentDigest: entry.intentDigest,
                sandboxId: selected.sandboxId, createOutcome: 'accepted-created-and-settled' as const,
                acceptedCreateRef: selected.acceptedCreateEvidenceRef, physicalDestructionRef: selected.physicalStopEvidenceRef,
                permanentLateCreateSpawnLossRef: selected.lateStartsRevokedEvidenceRef,
                ...(entry.row.sandboxId === null ? { independentCreateBindingRef: selected.acceptedCreateEvidenceRef } : {}) }
            }) })
        } } })
      await this.proveRows(account, true)
      const expected = this.expected(account)
      this.attempted.set(account.accountId, expected)
      await this.recovery.recoverAccount(this, expected)
      const observed = await this.recovery.inspectAccount(this, expected)
      if (!observed.matchesPostimage || observed.responsibilityRetained) unavailable()
    }
    const first = facts.accounts[0]
    if (first === undefined) return unavailable()
    const expected = { ...this.expected(first), internalAddress: oldInstance.internalAddress, recipeVersion: oldInstance.recipeVersion }
    await this.recovery.closeInstance(this, expected)
    const closed = await this.recovery.inspectInstance(this, expected)
    if (!closed.audited || !closed.closed || closed.retainedOwners || closed.responsibilityRetained) unavailable()
    witness.assertCurrent()
    this.ctx.logger.info('Controlled recovery metadata completed; ordinary account admission remains closed')
  }
}

/**
 * Run the existing Root entry's explicitly closed maintenance composition.
 * @param ctx Original Root Loader context.
 * @param runtime Original maintenance runtime; ordinary runtime configuration cannot provide recovery.
 * @param config Existing finite metadata/observation budgets; no SDK or mounts are constructed here.
 * @param reference Explicit protected verifier publication input.
 * @returns Actual reconciliation and old-instance closure; no ordinary execution or account graph opens.
 */
export async function mountRootRecovery(ctx: Context, runtime: AccountRuntimeService,
  config: ManagedCoordinatorConfig, reference: unknown): Promise<void> {
  const recovery = runtime.recovery
  if (ctx.get('peAccount') !== undefined || ctx.root.get('peAccount') !== undefined || recovery === undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'Maintenance recovery requires its original Root runtime and closed account admission.')
  }
  const selected = parseRootRecoveryReference(reference)
  await recovery.whenReady()
  if (ctx.fiber.uid === null) {
    throw new ExecutionStateError('cloud/execution-unavailable', 'Maintenance Root closed before recovery startup settled.')
  }
  const coordinator = new MaintenanceRecoveryCoordinator(ctx, runtime, recovery, config, selected)
  await coordinator.whenRecovered()
}
