/** Protected v4 witness and original store CAS; no provider or database resource is created. */
import { describe, expect, it } from 'vitest'
import { RootRecoveryWitness, recoveryIntentDigest, PROVIDER_EXECUTION_REJECTION_CODE,
  isKnownProviderRefusal, recoveryWitnessEvidenceRefs } from '../src/bootstrap/recovery-witness.ts'
import { reconcileOldAllocationEpoch, type AllocationRecoverySnapshot, type AllocationRecoveryEvidence } from '../src/allocation-recovery.ts'
import { PostgresAllocationStore } from '../src/allocation-store.ts'
import { allocationMigrationSql } from '../src/migrations/allocations.ts'
import type { AllocationQuery, SandboxAllocation } from '../src/allocation-types.ts'

const at = '2026-10-22T02:08:13.139Z', now = Date.parse('2026-10-22T02:15:00.000Z')
const limits = { maxBytes: 16384, maxAccounts: 2, maxAllocations: 4, maxFieldBytes: 256, maxAgeMs: 60000 }
const bounds = { pageSize: 2, maxRows: 4, maxSnapshotBytes: 32768, maxProofBytes: 16384, maxReferenceBytes: 256 }
const ref = (n: number) => 'sha256:' + String(n).repeat(64)
function row(changes: Partial<SandboxAllocation> = {}): SandboxAllocation {
  return { allocationId: 'test-allocation', accountId: 'test-account', epoch: '21', sessionId: 'test-session',
    workspaceId: 'test-workspace', environmentVersion: 'env-v1', provider: 'opensandbox', projectMountVersion: 'mount-v1',
    requestedAt: at, createDeadlineAt: '2026-10-22T02:08:43.139Z', state: 'creating', sandboxId: null,
    lastActivityAt: at, lastCheckedAt: at, runtimeIdentity: null, executionProtocolVersion: null,
    executionCapabilities: [], failureCode: null, ...changes } as SandboxAllocation
}
function item() {
  const { allocationId, accountId, epoch, sessionId, workspaceId, environmentVersion, provider,
    projectMountVersion, requestedAt, createDeadlineAt } = row()
  const intent = { allocationId, accountId, epoch, sessionId, workspaceId, environmentVersion, provider,
    projectMountVersion, requestedAt, createDeadlineAt }
  return { createOutcome: 'provider-rejected-before-execution-resource' as const, sandboxId: null,
    intent, intentDigest: recoveryIntentDigest(intent), rejectionCode: 'docker-systempaths-security-option-v1' as const,
    providerRequestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', requestBindingEvidenceRef: ref(1),
    preExecutionRejectionEvidenceRef: ref(2), completedRequestEvidenceRef: ref(3),
    auxiliarySettlementEvidenceRef: ref(4), lateStartsRevokedEvidenceRef: ref(5) }
}
function publication() {
  return { schema: 'pe-local-controlled-recovery-v4', verifierId: 'local-original-process-and-provider-v1', auditRef: 'test:audit',
    verifiedAt: new Date(now).toISOString(), oldInstanceId: 'test-instance', databaseRole: 'test-role',
    writersVerifiedAt: new Date(now - 1).toISOString(), oldProcess: { pid: 3456, startTicks: '7890',
      bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' },
    processEvidenceRef: 'test:process-absent', writersEvidenceRef: 'test:writer-loss',
    accounts: [{ accountId: row().accountId, epoch: row().epoch, allocations: [item()] }] }
}
function witness(value: unknown = publication(), alive = false) {
  return new RootRecoveryWitness({ value: () => value, assertCurrent() {} }, limits,
    i => ({ bootId: i.bootId, pidNamespace: i.pidNamespace, original: alive ? 'alive' : 'absent' }), () => now)
}
function proof(snapshot: AllocationRecoverySnapshot): AllocationRecoveryEvidence {
  return { scope: snapshot.scope, snapshotDigest: snapshot.digest, oldProcessExitRef: 'test:process',
    oldWriterWithdrawalRef: 'test:writers', permanentLateCreateSpawnLossRef: ref(5),
    allocations: snapshot.allocations.map(x => ({ allocationId: x.row.allocationId, rowDigest: x.digest,
      intentDigest: x.intentDigest, createOutcome: 'provider-rejected-before-execution-resource', sandboxId: null,
      rejectionCode: 'docker-systempaths-security-option-v1', providerRequestId: item().providerRequestId,
      requestBindingRef: ref(1), preExecutionRejectionRef: ref(2), completedRequestRef: ref(3),
      auxiliarySettlementRef: ref(4), permanentLateCreateSpawnLossRef: ref(5) })) }
}
async function store(initial = row(), fault?: 'committed' | 'uncommitted' | 'read-loss' | 'drift') {
  let actual = structuredClone(initial), submitted = false
  const writes: string[] = []
  const query: AllocationQuery = { async query(sql, values) {
    if (sql === allocationMigrationSql) return { rows: [] }
    if (sql.startsWith('UPDATE')) {
      writes.push(String(values[6])); submitted = true
      if (fault === 'uncommitted') throw new Error('Synthetic lost reply before commit')
      actual = { ...actual, state: 'failed', failureCode: values[11]!, lastCheckedAt: '2026-10-22T02:15:01.000Z',
        ...(fault === 'drift' ? { environmentVersion: 'changed' } : {}) }
      if (fault === 'committed' || fault === 'read-loss') throw new Error('Synthetic lost reply after commit')
      return { rows: [{ allocation: actual }] }
    }
    if (sql.includes('ORDER BY allocation_id')) return { rows: ['failed', 'released'].includes(actual.state) ? [] : [{ allocation: actual }] }
    if (fault === 'read-loss' && submitted) throw new Error('Synthetic reconciliation read unavailable')
    return { rows: [{ allocation: actual }] }
  } }
  const owner = new PostgresAllocationStore(query, { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 8192,
    maxResultBytes: 32768, maxRows: 4, maxCapabilities: 5, maxPendingQueries: 4,
    maxMutationResponsibilities: 8, maxRetainedBytes: 262144 })
  await owner.migrate()
  const recover = (change = (p: AllocationRecoveryEvidence) => p) => reconcileOldAllocationEpoch(owner, {
    scope: { accountId: initial.accountId, epoch: initial.epoch }, limits: bounds,
    verifier: { id: 'test:trusted', verify: async snapshot => change(proof(snapshot)) },
  })
  return { owner, writes, get: () => actual, recover }
}

describe('submitted provider rejection before execution resources', () => {
  it('keeps the two original pre-provider refusal discriminators closed', () => {
    expect(isKnownProviderRefusal('fixed-ttl-bounds')).toBe(true)
    expect(isKnownProviderRefusal('host-bind-bounds')).toBe(true)
    expect(isKnownProviderRefusal(item().rejectionCode)).toBe(false)
  })
  it('requires explicit v4 evidence and retains five distinct references without claiming destruction', () => {
    const selected = witness().verifyAllocation(row())
    expect(selected).toEqual(item())
    expect(selected).not.toHaveProperty('physicalStopEvidenceRef')
    expect(recoveryWitnessEvidenceRefs(selected)).toEqual([ref(1), ref(2), ref(3), ref(4), ref(5)])
    expect(witness().verifyAllocation(row({ state: 'failed', failureCode: PROVIDER_EXECUTION_REJECTION_CODE }))).toEqual(selected)
    expect(() => witness(publication(), true)).toThrow(/Trusted recovery evidence/)
  })
  it.each(['v1', 'v2', 'v3'])('rejects this outcome under legacy %s without reinterpreting it', (version) => {
    const p = publication(); p.schema = 'pe-local-controlled-recovery-' + version
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each(Object.keys(item()).filter(k => k !== 'intent'))('rejects missing %s', (key) => {
    const p = publication(); Reflect.deleteProperty(p.accounts[0]!.allocations[0]!, key)
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each(['http-500', 'empty-provider-list', 'missing-sdk-handle', 'process-exit-0', 'unsettled-or-unknown', 'fixed-ttl-bounds'])
  ('rejects %s as an execution rejection classification', (code) => {
    const p = publication(); Object.assign(p.accounts[0]!.allocations[0]!, { rejectionCode: code })
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each(['acceptedCreateEvidenceRef', 'physicalStopEvidenceRef', 'providerCreateNotStartedEvidenceRef'])
  ('rejects mixed %s evidence', (key) => {
    const p = publication(); Object.assign(p.accounts[0]!.allocations[0]!, { [key]: ref(6) })
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each(['requestBindingEvidenceRef', 'preExecutionRejectionEvidenceRef', 'completedRequestEvidenceRef',
    'auxiliarySettlementEvidenceRef', 'lateStartsRevokedEvidenceRef'])('requires a SHA256 reference for %s', (key) => {
    const p = publication(); Object.assign(p.accounts[0]!.allocations[0]!, { [key]: 'http-500' })
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each([
    { sandboxId: 'non-null' }, { state: 'ready' }, { state: 'uncertain' }, { state: 'stopping' }, { state: 'released' },
    { state: 'failed', failureCode: 'provider-create-refused-before-create' }, { failureCode: PROVIDER_EXECUTION_REJECTION_CODE },
    { runtimeIdentity: 'prepared' }, { executionProtocolVersion: 'prepared-v1' }, { executionCapabilities: ['argv-collect'] },
    { projectMountVersion: 'changed' }, { provider: 'other' },
  ] as Partial<SandboxAllocation>[])('rejects incompatible durable state %#', (changed) => {
    expect(() => witness().verifyAllocation(row(changed))).toThrow(/Trusted recovery evidence/)
  })
  it('uses only original failNotCreated CAS and preserves rejection audit references', async () => {
    const f = await store(); const report = await f.recover()
    expect(f.writes).toEqual(['failed'])
    expect(f.get()).toMatchObject({ state: 'failed', sandboxId: null, failureCode: PROVIDER_EXECUTION_REJECTION_CODE })
    expect(report.coverage[0]).toMatchObject({ createOutcome: item().createOutcome, providerRequestId: item().providerRequestId })
    expect(report.evidenceRefs).toEqual(expect.arrayContaining([ref(1), ref(2), ref(3), ref(4), ref(5)]))
    expect(f.owner.inspect().mutationResponsibilities).toBe(0)
  })
  it.each(['requestBindingRef', 'preExecutionRejectionRef', 'completedRequestRef', 'auxiliarySettlementRef',
    'permanentLateCreateSpawnLossRef', 'rejectionCode', 'providerRequestId', 'rowDigest', 'intentDigest'])
  ('rejects incomplete trusted %s coverage before CAS', async (key) => {
    const f = await store()
    await expect(f.recover(p => ({ ...p, allocations: p.allocations.map(x => ({ ...x, [key]: '' })) })))
      .rejects.toMatchObject({ code: 'proof' })
    expect(f.writes).toEqual([])
  })
  it('reconciles a committed failed postimage without replay', async () => {
    const f = await store(row(), 'committed'); const report = await f.recover()
    expect(report.reconciledUnknownWrites).toBe(1); expect(f.writes).toEqual(['failed'])
    expect(f.owner.inspect().unknownMutations).toBe(0)
  })
  it.each(['ready', 'uncertain', 'stopping'] as const)('rejects a trusted rejection over %s before CAS', async (state) => {
    const f = await store(row({ state, ...(state === 'ready' ? { sandboxId: 'existing', runtimeIdentity: 'existing-runtime',
      executionProtocolVersion: 'exec-v1', executionCapabilities: ['argv-collect'] } : {}) }))
    await expect(f.recover()).rejects.toMatchObject({ code: 'proof' })
    expect(f.writes).toEqual([])
  })
  it('rejects missing coverage, a sandbox identity and an unqualified rejection before CAS', async () => {
    for (const change of [
      (p: AllocationRecoveryEvidence) => ({ ...p, allocations: [] }),
      (p: AllocationRecoveryEvidence) => ({ ...p, allocations: p.allocations.map(x => ({ ...x, sandboxId: 'present' })) }),
      (p: AllocationRecoveryEvidence) => ({ ...p, allocations: p.allocations.map(x => ({ ...x, rejectionCode: 'unsettled-or-unknown' as const })) }),
    ]) {
      const f = await store()
      await expect(f.recover(change)).rejects.toMatchObject({ code: 'proof' })
      expect(f.writes).toEqual([])
    }
  })
  it.each(['uncommitted', 'read-loss'] as const)('retains %s responsibility without resubmitting', async (fault) => {
    const f = await store(row(), fault)
    await expect(f.recover()).rejects.toMatchObject({ code: 'store-unknown' })
    expect(f.owner.inspect().unknownMutations).toBe(1)
    await expect(f.recover()).rejects.toMatchObject({ code: 'store-unknown' })
    expect(f.writes).toEqual(['failed'])
  })
  it('rejects immutable drift after CAS', async () => {
    const f = await store(row(), 'drift')
    await expect(f.recover()).rejects.toMatchObject({ code: 'snapshot-changed' })
  })
})
