/** Private, proof-gated reconciliation of old allocation metadata; no backend authority or recovery CAS. */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { AllocationStoreError, type PostgresAllocationStore } from './allocation-store.ts'
import { recoveryIntentDigest, isProviderCreateRefusalRow, PROVIDER_CREATE_REFUSAL_CODE, isKnownProviderRefusal, type KnownProviderRefusal } from './bootstrap/recovery-witness.ts'
import type { AllocationEpochScope, AllocationId, AllocationState, SandboxAllocation } from './allocation-types.ts'

/** Original store authority; inspect preserves pending/unknown responsibilities outside the listing. */
export type AllocationRecoveryStore = Pick<PostgresAllocationStore,
  'listNonterminal' | 'get' | 'failNotCreated' | 'transition' | 'releaseStopped' | 'reconcileCommitted' | 'inspect'>

/** Explicit finite recovery observation limits, independent of the store's per-statement limits. */
export interface AllocationRecoveryLimits {
  readonly pageSize: number
  readonly maxRows: number
  readonly maxSnapshotBytes: number
  readonly maxProofBytes: number
  readonly maxReferenceBytes: number
}

/** Complete original row, including immutable intent and original state. */
export interface AllocationRecoveryEntry {
  readonly row: SandboxAllocation
  /** Original Root witness SHA256 of the ten immutable fields in its fixed array order. */
  readonly intentDigest: string
  readonly digest: string
}

/** Frozen complete old-epoch nonterminal observation; keyset enumeration alone grants no recovery authority. */
export interface AllocationRecoverySnapshot {
  readonly scope: AllocationEpochScope
  readonly allocations: readonly AllocationRecoveryEntry[]
  readonly digest: string
}

/** One exact accepted create whose physical destruction and permanent inability to start late were verified. */
export interface AllocationDestructionEvidence {
  readonly allocationId: AllocationId
  readonly rowDigest: string
  readonly intentDigest: string
  readonly sandboxId: string
  readonly createOutcome: 'accepted-created-and-settled' | 'unsettled-or-unknown'
  readonly acceptedCreateRef: string
  readonly physicalDestructionRef: string
  readonly permanentLateCreateSpawnLossRef: string
  /** Required when the durable row has no sandbox id; binds accepted create to the complete original intent. */
  readonly independentCreateBindingRef?: string
}

/** Exact completed provider refusal, attested by Root independently of any HTTP status or empty list. */
export interface AllocationRefusalEvidence {
  readonly allocationId: AllocationId
  readonly rowDigest: string
  readonly intentDigest: string
  readonly createOutcome: 'rejected-before-provider-create'
  readonly sandboxId: string | null
  readonly refusalCode: KnownProviderRefusal | 'unsettled-or-unknown'
  readonly refusalRef: string
  readonly completedRequestRef: string
  readonly providerCreateNotStartedRef: string
  readonly permanentLateCreateSpawnLossRef: string
}
type AllocationEvidence = AllocationDestructionEvidence | AllocationRefusalEvidence
type AllocationCoverage = (AllocationDestructionEvidence & { readonly createOutcome: 'accepted-created-and-settled' }) | (AllocationRefusalEvidence & { readonly refusalCode: KnownProviderRefusal; readonly sandboxId: null })

/** Trusted attestations for this whole snapshot, never a browser-supplied stopped boolean. */
export interface AllocationRecoveryEvidence {
  readonly scope: AllocationEpochScope
  readonly snapshotDigest: string
  readonly oldProcessExitRef: string
  readonly oldWriterWithdrawalRef: string
  readonly permanentLateCreateSpawnLossRef: string
  readonly allocations: readonly AllocationEvidence[]
}

/** Root chooses this capability and verifies actual process/create/physical facts outside this helper. */
export interface TrustedAllocationRecoveryVerifier {
  readonly id: string
  /**
   * Verify the entire snapshot, including old process/writer loss even when the list is empty.
   * Every item must bind the exact original intent/state and either destruction or a completed qualified no-create refusal.
   * @param snapshot - frozen complete bounded observation.
   * @returns full trusted coverage, or undefined when any fact cannot be established.
   */
  verify(snapshot: AllocationRecoverySnapshot): Promise<AllocationRecoveryEvidence | undefined>
}

/** Protected audit input for runtime's separate old-owner CAS; this report performs no owner mutation. */
export interface AllocationRecoveryReport {
  readonly scope: AllocationEpochScope
  readonly snapshotDigest: string
  readonly finalSnapshotDigest: string
  readonly verifierId: string
  readonly coverage: readonly AllocationCoverage[]
  readonly evidenceRefs: readonly string[]
  readonly reconciledUnknownWrites: number
}

/** A fixed failure always retains quarantine; prior successful CAS operations are not rolled back or replayed. */
export class AllocationRecoveryError extends Error {
  /** @param code - sanitized reason, without SQL or backend diagnostics. */
  constructor(readonly code: 'invalid-input' | 'bounds' | 'proof' | 'snapshot-changed' | 'store-unknown' | 'store-conflict') {
    super(`Old allocation recovery ${code}.`)
    this.name = 'AllocationRecoveryError'
  }
}

const nonterminal: readonly AllocationState[] = ['creating', 'ready', 'uncertain', 'stopping']
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

function rowValue(row: SandboxAllocation): readonly unknown[] {
  return [row.allocationId, row.accountId, row.sessionId, row.workspaceId, row.epoch,
    row.environmentVersion, row.provider, row.projectMountVersion, row.requestedAt, row.createDeadlineAt,
    row.state, row.sandboxId, row.lastActivityAt, row.lastCheckedAt, row.runtimeIdentity,
    row.executionProtocolVersion, row.executionCapabilities, row.failureCode]
}

function reference(value: unknown, limits: AllocationRecoveryLimits): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limits.maxReferenceBytes
    || Buffer.byteLength(value, 'utf8') > limits.maxReferenceBytes || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new AllocationRecoveryError('proof')
  }
}

/**
 * Capture a bounded readonly old-epoch snapshot without authorizing a metadata write.
 * @param store Original migrated allocation store.
 * @param scope Exact old account/epoch.
 * @param limits Explicit complete observation budgets.
 * @returns Frozen rows and their original-state digest for trusted Root preflight.
 */
export async function captureOldAllocationRecoverySnapshot(store: AllocationRecoveryStore, scope: AllocationEpochScope,
  limits: AllocationRecoveryLimits): Promise<AllocationRecoverySnapshot> {
  const entries: AllocationRecoveryEntry[] = []
  let cursor: AllocationId | null = null
  let total = bytes({ scope, allocations: [], digest: '0'.repeat(64) })
  if (total > limits.maxSnapshotBytes) throw new AllocationRecoveryError('bounds')
  do {
    const page = await store.listNonterminal(scope, cursor, limits.pageSize)
    if (page.allocations.length > limits.pageSize) throw new AllocationRecoveryError('bounds')
    for (const row of page.allocations) {
      if (row.accountId !== scope.accountId || row.epoch !== scope.epoch || !nonterminal.includes(row.state)
        || (cursor !== null && row.allocationId <= cursor)) throw new AllocationRecoveryError('snapshot-changed')
      if (entries.length >= limits.maxRows) throw new AllocationRecoveryError('bounds')
      const copied = Object.freeze({ ...row, executionCapabilities: Object.freeze([...row.executionCapabilities]) })
      const entry = Object.freeze({ row: copied, intentDigest: recoveryIntentDigest(copied), digest: digest(rowValue(copied)) })
      total += bytes(entry) + Number(entries.length > 0)
      if (total > limits.maxSnapshotBytes) throw new AllocationRecoveryError('bounds')
      entries.push(entry)
      cursor = row.allocationId
    }
    const expected = page.allocations.length === limits.pageSize ? cursor : null
    if (page.nextCursor !== expected || (page.nextCursor !== null && page.allocations.length === 0)) {
      throw new AllocationRecoveryError('snapshot-changed')
    }
    if (page.nextCursor === null) break
  } while (true)
  const allocations = Object.freeze(entries)
  return Object.freeze({ scope, allocations, digest: digest([scope.accountId, scope.epoch, allocations.map(item => item.digest)]) })
}

function exactFields(value: object, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value)
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    throw new AllocationRecoveryError('proof')
  }
}

function validateEvidence(snapshot: AllocationRecoverySnapshot, evidence: AllocationRecoveryEvidence | undefined,
  limits: AllocationRecoveryLimits): Omit<AllocationRecoveryEvidence, 'allocations'> & { readonly allocations: AllocationRecoveryReport['coverage'] } {
  if (evidence === undefined || evidence.scope.accountId !== snapshot.scope.accountId
    || evidence.scope.epoch !== snapshot.scope.epoch || evidence.snapshotDigest !== snapshot.digest
    || !Array.isArray(evidence.allocations) || evidence.allocations.length !== snapshot.allocations.length) {
    throw new AllocationRecoveryError('proof')
  }
  exactFields(evidence, ['scope', 'snapshotDigest', 'oldProcessExitRef', 'oldWriterWithdrawalRef',
    'permanentLateCreateSpawnLossRef', 'allocations'])
  exactFields(evidence.scope, ['accountId', 'epoch'])
  const frozenScope = Object.freeze({ ...snapshot.scope })
  for (const ref of [evidence.oldProcessExitRef, evidence.oldWriterWithdrawalRef, evidence.permanentLateCreateSpawnLossRef]) {
    reference(ref, limits)
  }
  const seen = new Set<AllocationId>()
  const coverage = evidence.allocations.map((item: AllocationEvidence): AllocationCoverage => {
    if (item.createOutcome === 'rejected-before-provider-create') {
      exactFields(item, ['allocationId', 'rowDigest', 'intentDigest', 'createOutcome', 'sandboxId', 'refusalCode', 'refusalRef',
        'completedRequestRef', 'providerCreateNotStartedRef', 'permanentLateCreateSpawnLossRef'])
      const entry = snapshot.allocations.find(value => value.row.allocationId === item.allocationId)
      if (entry === undefined || seen.has(item.allocationId) || item.rowDigest !== entry.digest || item.intentDigest !== entry.intentDigest
        || item.sandboxId !== null || !isKnownProviderRefusal(item.refusalCode) || !isProviderCreateRefusalRow(entry.row)) throw new AllocationRecoveryError('proof')
      for (const ref of [item.refusalRef, item.completedRequestRef,
        item.providerCreateNotStartedRef, item.permanentLateCreateSpawnLossRef]) reference(ref, limits)
      seen.add(item.allocationId)
      return Object.freeze({ ...item, sandboxId: null, refusalCode: item.refusalCode })
    }
    exactFields(item, ['allocationId', 'rowDigest', 'intentDigest', 'sandboxId', 'createOutcome', 'acceptedCreateRef',
      'physicalDestructionRef', 'permanentLateCreateSpawnLossRef'], ['independentCreateBindingRef'])
    const entry = snapshot.allocations.find(value => value.row.allocationId === item.allocationId)
    if (entry === undefined || seen.has(item.allocationId) || item.rowDigest !== entry.digest || item.intentDigest !== entry.intentDigest
      || item.createOutcome !== 'accepted-created-and-settled'
      || (entry.row.sandboxId !== null && item.sandboxId !== entry.row.sandboxId)) throw new AllocationRecoveryError('proof')
    for (const ref of [item.sandboxId, item.acceptedCreateRef, item.physicalDestructionRef, item.permanentLateCreateSpawnLossRef]) {
      reference(ref, limits)
    }
    if (entry.row.sandboxId === null || item.independentCreateBindingRef !== undefined) reference(item.independentCreateBindingRef, limits)
    seen.add(item.allocationId)
    return Object.freeze({ allocationId: item.allocationId, rowDigest: item.rowDigest,
      intentDigest: item.intentDigest, sandboxId: item.sandboxId,
      createOutcome: item.createOutcome, acceptedCreateRef: item.acceptedCreateRef,
      physicalDestructionRef: item.physicalDestructionRef, permanentLateCreateSpawnLossRef: item.permanentLateCreateSpawnLossRef,
      ...(item.independentCreateBindingRef === undefined ? {} : { independentCreateBindingRef: item.independentCreateBindingRef }) })
  })
  const copied = Object.freeze({ scope: frozenScope, snapshotDigest: evidence.snapshotDigest,
    oldProcessExitRef: evidence.oldProcessExitRef, oldWriterWithdrawalRef: evidence.oldWriterWithdrawalRef,
    permanentLateCreateSpawnLossRef: evidence.permanentLateCreateSpawnLossRef, allocations: Object.freeze(coverage) })
  if (bytes(copied) > limits.maxProofBytes) throw new AllocationRecoveryError('bounds')
  return copied
}

function assertPostimage(before: SandboxAllocation, after: SandboxAllocation, state: 'stopping' | 'released' | 'failed', sandboxId: string | null): void {
  const expected = { ...before, state, sandboxId, lastCheckedAt: after.lastCheckedAt,
    ...(state === 'failed' ? { failureCode: PROVIDER_CREATE_REFUSAL_CODE } : {}) }
  if (digest(rowValue(after)) !== digest(rowValue(expected))) throw new AllocationRecoveryError('snapshot-changed')
}

/**
 * Reconcile an old epoch's verified destroyed creates or completed fixed provider admission refusals.
 * Root must exclude old writers and concurrent recoverers, retain the actual Promise and select the trusted verifier.
 * Complete proof and a repeated whole-snapshot check precede every first write; exact reads bind every subsequent CAS.
 * Submitted unknown writes are only reconciled against the original store's captured postimage, never replayed.
 * Empty metadata still requires old process/writer/permanent-late-start evidence. Local unresolved store work blocks success.
 * @param store - original migrated store, including retained unknown-write responsibilities.
 * @param input - exact old scope, finite observation bounds and Root's trusted same-process verifier.
 * @returns immutable allocation coverage for runtime's separate recovery CAS, without issuing SDK calls or changing an epoch.
 * @throws AllocationRecoveryError on missing proof, drift, limits, conflict or unresolved outcomes.
 * Native read errors propagate; quarantine remains required.
 */
export async function reconcileOldAllocationEpoch(store: AllocationRecoveryStore, input: Readonly<{
  scope: AllocationEpochScope
  limits: AllocationRecoveryLimits
  verifier: TrustedAllocationRecoveryVerifier
}>): Promise<AllocationRecoveryReport> {
  const scope = Object.freeze({ accountId: input.scope.accountId, epoch: input.scope.epoch })
  const limits = Object.freeze({ ...input.limits })
  if (['pageSize', 'maxRows', 'maxSnapshotBytes', 'maxProofBytes', 'maxReferenceBytes'].some((name) => {
    const value = limits[name as keyof AllocationRecoveryLimits]
    return !Number.isSafeInteger(value) || value < 1
  }) || limits.pageSize > limits.maxRows
    || typeof scope.accountId !== 'string' || scope.accountId.length === 0 || !/^[1-9][0-9]{0,18}$/u.test(scope.epoch)) {
    throw new AllocationRecoveryError('invalid-input')
  }
  const verifierId = input.verifier.id
  reference(verifierId, limits)
  const verify = input.verifier.verify.bind(input.verifier)
  const snapshot = await captureOldAllocationRecoverySnapshot(store, scope, limits)
  let observed: AllocationRecoveryEvidence | undefined
  try { observed = await verify(snapshot) } catch { throw new AllocationRecoveryError('proof') }
  const proof = validateEvidence(snapshot, observed, limits)
  observed = undefined
  const refs = [proof.oldProcessExitRef, proof.oldWriterWithdrawalRef, proof.permanentLateCreateSpawnLossRef,
    ...proof.allocations.flatMap(item => item.createOutcome === 'rejected-before-provider-create'
      ? [item.refusalRef, item.completedRequestRef, item.providerCreateNotStartedRef, item.permanentLateCreateSpawnLossRef]
      : [item.acceptedCreateRef, item.physicalDestructionRef, item.permanentLateCreateSpawnLossRef,
        ...(item.independentCreateBindingRef === undefined ? [] : [item.independentCreateBindingRef])])]
  const audit = { scope, snapshotDigest: snapshot.digest, verifierId, coverage: proof.allocations,
    evidenceRefs: Object.freeze([...new Set(refs)]) }
  if (bytes({ ...audit, finalSnapshotDigest: '0'.repeat(64), reconciledUnknownWrites: snapshot.allocations.length * 3 }) > limits.maxProofBytes) {
    throw new AllocationRecoveryError('bounds')
  }
  if ((await captureOldAllocationRecoverySnapshot(store, scope, limits)).digest !== snapshot.digest) {
    throw new AllocationRecoveryError('snapshot-changed')
  }
  let reconciledUnknownWrites = 0
  const outstanding = store.inspect()
  if (outstanding.pendingQueries !== 0 || outstanding.mutationResponsibilities !== outstanding.unknownMutations) {
    throw new AllocationRecoveryError('store-unknown')
  }
  if (outstanding.unknownMutations !== 0) {
    for (const entry of snapshot.allocations) {
      let committed: SandboxAllocation
      try { committed = await store.reconcileCommitted(entry.row) }
      catch (error) {
        // A missing local record is not success: the complete inspect below must still reach zero.
        if (error instanceof AllocationStoreError && error.code === 'conflict') continue
        throw new AllocationRecoveryError('store-unknown')
      }
      if (digest(rowValue(committed)) !== entry.digest) throw new AllocationRecoveryError('snapshot-changed')
      reconciledUnknownWrites++
    }
    const after = store.inspect()
    if (after.pendingQueries !== 0 || after.mutationResponsibilities !== 0 || after.unknownMutations !== 0) {
      throw new AllocationRecoveryError('store-unknown')
    }
  }
  for (const entry of snapshot.allocations) {
    const evidence = proof.allocations.find(item => item.allocationId === entry.row.allocationId)
    if (evidence === undefined) throw new AllocationRecoveryError('proof')
    const current = await store.get(entry.row)
    if (current === undefined || digest(rowValue(current)) !== entry.digest) throw new AllocationRecoveryError('snapshot-changed')
    if (evidence.createOutcome === 'rejected-before-provider-create') {
      let failed: SandboxAllocation
      try { failed = await store.failNotCreated(current, PROVIDER_CREATE_REFUSAL_CODE) }
      catch (error) {
        if (!(error instanceof AllocationStoreError) || error.code !== 'unknown') throw new AllocationRecoveryError('store-conflict')
        try { failed = await store.reconcileCommitted(current) }
        catch { throw new AllocationRecoveryError('store-unknown') }
        reconciledUnknownWrites++
      }
      assertPostimage(current, failed, 'failed', null)
      const checked = await store.get(failed)
      if (checked === undefined || digest(rowValue(checked)) !== digest(rowValue(failed))) throw new AllocationRecoveryError('snapshot-changed')
      continue
    }
    let stopping = current
    if (current.state !== 'stopping') {
      try { stopping = await store.transition(current, { to: 'stopping', sandboxId: evidence.sandboxId }) }
      catch (error) {
        if (!(error instanceof AllocationStoreError) || error.code !== 'unknown') throw new AllocationRecoveryError('store-conflict')
        try { stopping = await store.reconcileCommitted(current) }
        catch { throw new AllocationRecoveryError('store-unknown') }
        reconciledUnknownWrites++
      }
      assertPostimage(current, stopping, 'stopping', evidence.sandboxId)
    }
    const checked = await store.get(stopping)
    if (checked === undefined || digest(rowValue(checked)) !== digest(rowValue(stopping))) throw new AllocationRecoveryError('snapshot-changed')
    let released: SandboxAllocation
    try { released = await store.releaseStopped(stopping) }
    catch (error) {
      if (!(error instanceof AllocationStoreError) || error.code !== 'unknown') throw new AllocationRecoveryError('store-conflict')
      try { released = await store.reconcileCommitted(stopping) }
      catch { throw new AllocationRecoveryError('store-unknown') }
      reconciledUnknownWrites++
    }
    assertPostimage(stopping, released, 'released', stopping.sandboxId)
  }
  const final = await captureOldAllocationRecoverySnapshot(store, scope, limits)
  const retained = store.inspect()
  if (final.allocations.length !== 0) throw new AllocationRecoveryError('snapshot-changed')
  if (retained.pendingQueries !== 0 || retained.mutationResponsibilities !== 0 || retained.unknownMutations !== 0) {
    throw new AllocationRecoveryError('store-unknown')
  }
  return Object.freeze({ ...audit, finalSnapshotDigest: final.digest, reconciledUnknownWrites })
}
