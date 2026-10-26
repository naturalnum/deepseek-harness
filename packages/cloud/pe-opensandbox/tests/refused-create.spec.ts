/** Scripted original store and protected witness only; no HTTP, PG, SDK or provider operation. */
import { describe, expect, it } from 'vitest'
import { RootRecoveryWitness, parseRecoveryWitness, recoveryIntentDigest,
  PROVIDER_CREATE_REFUSAL_CODE, KNOWN_PROVIDER_REFUSAL } from '../src/bootstrap/recovery-witness.ts'
import { reconcileOldAllocationEpoch, type AllocationRecoverySnapshot, type AllocationRecoveryEvidence,
  type AllocationRefusalEvidence } from '../src/allocation-recovery.ts'
import { PostgresAllocationStore } from '../src/allocation-store.ts'
import { allocationMigrationSql } from '../src/migrations/allocations.ts'
import type { AllocationQuery, SandboxAllocation } from '../src/allocation-types.ts'

const at = '2026-10-22T02:08:13.139Z', now = Date.parse('2026-10-22T02:15:00.000Z')
const limits = { maxBytes: 16384, maxAccounts: 2, maxAllocations: 4, maxFieldBytes: 256, maxAgeMs: 60000 }
const bounds = { pageSize: 2, maxRows: 4, maxSnapshotBytes: 32768, maxProofBytes: 16384, maxReferenceBytes: 256 }
function row(changes: Partial<SandboxAllocation> = {}): SandboxAllocation {
  return { allocationId: 'test-allocation', accountId: 'test-account', epoch: '21', sessionId: 'test-session',
    workspaceId: 'test-workspace', environmentVersion: 'env-v1', provider: 'opensandbox', projectMountVersion: 'mount-v1',
    requestedAt: at, createDeadlineAt: '2026-10-22T02:08:43.139Z', state: 'creating', sandboxId: null,
    lastActivityAt: at, lastCheckedAt: at, runtimeIdentity: null, executionProtocolVersion: null,
    executionCapabilities: [], failureCode: null, ...changes } as SandboxAllocation
}
describe.each([KNOWN_PROVIDER_REFUSAL, 'host-bind-bounds'] as const)('explicit completed provider refusal %s', (refusalCode) => {
  function refused() {
    const { allocationId, accountId, epoch, sessionId, workspaceId, environmentVersion, provider,
      projectMountVersion, requestedAt, createDeadlineAt } = row()
    const intent = { allocationId, accountId, epoch, sessionId, workspaceId, environmentVersion, provider,
      projectMountVersion, requestedAt, createDeadlineAt }
    return { createOutcome: 'rejected-before-provider-create' as const, sandboxId: null, intent, intentDigest: recoveryIntentDigest(intent),
      refusalCode, knownRefusalEvidenceRef: `test:qualified-${refusalCode}-refusal`,
      completedRequestEvidenceRef: 'test:original-terminal-request', providerCreateNotStartedEvidenceRef: 'test:before-provider-dispatch',
      lateStartsRevokedEvidenceRef: 'test:permanent-no-late-start' }
  }
  function publication() {
    return { schema: 'pe-local-controlled-recovery-v2', verifierId: 'local-original-process-and-provider-v1', auditRef: 'test:audit',
      verifiedAt: new Date(now).toISOString(), oldInstanceId: 'test-instance', databaseRole: 'test-role',
      writersVerifiedAt: new Date(now - 1).toISOString(), oldProcess: { pid: 3456, startTicks: '7890',
        bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' },
      processEvidenceRef: 'test:process-absent', writersEvidenceRef: 'test:writer-loss',
      accounts: [{ accountId: row().accountId, epoch: row().epoch, allocations: [refused()] }] }
  }
  function witness(value: unknown = publication()) {
    return new RootRecoveryWitness({ value: () => value, assertCurrent() {} }, limits,
      i => ({ bootId: i.bootId, pidNamespace: i.pidNamespace, original: 'absent' }), () => now)
  }
  function proof(snapshot: AllocationRecoverySnapshot): AllocationRecoveryEvidence {
    return { scope: snapshot.scope, snapshotDigest: snapshot.digest, oldProcessExitRef: 'test:process',
      oldWriterWithdrawalRef: 'test:writers', permanentLateCreateSpawnLossRef: 'test:late-loss',
      allocations: snapshot.allocations.map(x => ({ allocationId: x.row.allocationId, rowDigest: x.digest,
        intentDigest: x.intentDigest, createOutcome: 'rejected-before-provider-create', sandboxId: null, refusalCode,
        refusalRef: `test:qualified-${refusalCode}-refusal`, completedRequestRef: 'test:original-terminal-request',
        providerCreateNotStartedRef: 'test:before-provider-dispatch', permanentLateCreateSpawnLossRef: 'test:permanent-no-late-start' })) }
  }
  async function store(initial = row(), fault?: 'committed' | 'uncommitted' | 'read-loss' | 'drift') {
    let actual = structuredClone(initial), submitted = false
    const writes: string[] = []
    const query: AllocationQuery = { async query(sql, values) {
      if (sql === allocationMigrationSql) return { rows: [] }
      if (sql.startsWith('UPDATE')) {
        writes.push(String(values[6])); submitted = true
        if (actual.state !== values[5]) return { rows: [] }
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


  it('requires the exact old process to be absent even for an otherwise complete qualified refusal', () => {
    expect(() => new RootRecoveryWitness({ value: publication, assertCurrent() {} }, limits,
      i => ({ bootId: i.bootId, pidNamespace: i.pidNamespace, original: 'alive' }), () => now))
      .toThrow(/Trusted recovery evidence/)
  })
  it.each(['oldProcessExitRef', 'oldWriterWithdrawalRef', 'permanentLateCreateSpawnLossRef'] as const)
  ('requires complete old process/writer/late-start %s before CAS', async (key) => {
    const f = await store()
    await expect(f.recover(p => ({ ...p, [key]: '' }))).rejects.toMatchObject({ code: 'proof' })
    expect(f.writes).toEqual([])
  })
  it('requires complete allocation coverage and exact immutable intent before a refusal CAS', async () => {
    const missing = await store()
    await expect(missing.recover(p => ({ ...p, allocations: [] }))).rejects.toMatchObject({ code: 'proof' })
    expect(missing.writes).toEqual([])
    const wrong = await store()
    await expect(wrong.recover(p => ({ ...p, allocations: p.allocations.map(x => ({ ...x, intentDigest: 'changed' })) })))
      .rejects.toMatchObject({ code: 'proof' })
    expect(wrong.writes).toEqual([])
  })
  it('normalizes strict v2 refused evidence without inventing a sandbox or destruction', () => {
    const selected = witness().verifyAllocation(row())
    expect(selected.createOutcome).toBe('rejected-before-provider-create')
    expect(selected).toMatchObject({ refusalCode })
    expect(selected.sandboxId).toBeNull(); expect(selected).not.toHaveProperty('physicalStopEvidenceRef')
    expect(Object.isFrozen(selected)).toBe(true)
    expect(witness().verifyAllocation(row({ state: 'failed', failureCode: PROVIDER_CREATE_REFUSAL_CODE }))).toEqual(selected)
  })
  it.each(['sandboxId', 'acceptedCreateEvidenceRef', 'physicalStopEvidenceRef'])('rejects mixed physical-create field %s', (key) => {
    const p = publication(); Object.assign(p.accounts[0]!.allocations[0]!, { [key]: 'invented' })
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each(['createOutcome', 'sandboxId', 'intentDigest', 'refusalCode', 'knownRefusalEvidenceRef', 'completedRequestEvidenceRef',
    'providerCreateNotStartedEvidenceRef', 'lateStartsRevokedEvidenceRef'])('rejects missing required %s', (key) => {
    const p = publication(); Reflect.deleteProperty(p.accounts[0]!.allocations[0]!, key)
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it.each(['http-500', 'timeout', 'empty-provider-list', 'unsettled-or-unknown', 'host-bind-bounds-extra', 'Host-Bind-Bounds', 'deletion-completion/host-bind-bounds'])('rejects %s as a known no-create outcome', (code) => {
    const p = publication(); Object.assign(p.accounts[0]!.allocations[0]!, { refusalCode: code })
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
  })
  it('rejects a refusal smuggled into v1 or a changed immutable intent', () => {
    const p = publication(); p.schema = 'pe-local-controlled-recovery-v1'
    expect(() => witness(p)).toThrow(/Trusted recovery evidence/)
    expect(() => witness().verifyAllocation(row({ projectMountVersion: 'different' }))).toThrow(/Trusted recovery evidence/)
    const bad = publication(); bad.accounts[0]!.allocations[0]!.intentDigest = 'a'.repeat(64)
    expect(() => parseRecoveryWitness(bad, limits)).toThrow(/Trusted recovery evidence/)
  })
  it.each([
    { sandboxId: 'non-null' }, { state: 'ready' }, { state: 'uncertain' }, { state: 'stopping' }, { state: 'released' },
    { state: 'failed', failureCode: 'some-other-code' }, { failureCode: PROVIDER_CREATE_REFUSAL_CODE },
    { runtimeIdentity: 'prepared' }, { executionProtocolVersion: 'prepared-v1' }, { executionCapabilities: ['argv-collect'] },
  ] as Partial<SandboxAllocation>[])('rejects incompatible durable state %#', (changed) => {
    expect(() => witness().verifyAllocation(row(changed))).toThrow(/Trusted recovery evidence/)
  })
  it('writes only original failNotCreated CAS and retains the exact refusal audit', async () => {
    const f = await store(); const report = await f.recover()
    expect(f.writes).toEqual(['failed']); expect(f.get()).toMatchObject({ state: 'failed', sandboxId: null, failureCode: PROVIDER_CREATE_REFUSAL_CODE })
    expect(report.coverage[0]).toMatchObject({ createOutcome: 'rejected-before-provider-create', intentDigest: recoveryIntentDigest(row()), refusalCode })
    expect(report.coverage[0]?.sandboxId).toBeNull(); expect(report.evidenceRefs).toContain('test:before-provider-dispatch')
    expect(f.owner.inspect().mutationResponsibilities).toBe(0)
  })
  it.each(['refusalRef', 'completedRequestRef', 'providerCreateNotStartedRef', 'permanentLateCreateSpawnLossRef'])('requires trusted %s before CAS', async (key) => {
    const f = await store(); await expect(f.recover(p => ({ ...p, allocations: p.allocations.map(x => ({ ...x, [key]: '' })) }))).rejects.toMatchObject({ code: 'proof' })
    expect(f.writes).toEqual([])
  })
  it.each(['ready', 'uncertain', 'stopping'] as const)('rejects no-create attestation over %s without CAS', async (state) => {
    const f = await store(row({ state, ...(state === 'ready' ? { sandboxId: 'existing', runtimeIdentity: 'existing-runtime', executionProtocolVersion: 'exec-v1', executionCapabilities: ['argv-collect'] } : {}) })); await expect(f.recover()).rejects.toMatchObject({ code: 'proof' }); expect(f.writes).toEqual([])
  })
  it('rejects a nonnull sandbox and HTTP500/empty-list-only proof before CAS', async () => {
    const f = await store(row({ sandboxId: 'non-null' })); await expect(f.recover()).rejects.toMatchObject({ code: 'proof' }); expect(f.writes).toEqual([])
    for (const value of ['http-500', 'timeout', 'empty-provider-list', 'unsettled-or-unknown', 'host-bind-bounds-extra']) {
      const clean = await store(); await expect(clean.recover(p => ({ ...p, allocations: p.allocations.map(x => ({ ...x, refusalCode: value } as AllocationRefusalEvidence)) }))).rejects.toMatchObject({ code: 'proof' });expect(clean.writes).toEqual([])
    }
  })
  it('reconciles the original committed failed postimage by read without replay', async () => {
    const f = await store(row(), 'committed'); const report = await f.recover()
    expect(report.reconciledUnknownWrites).toBe(1); expect(f.writes).toEqual(['failed']); expect(f.owner.inspect().unknownMutations).toBe(0)
  })
  it.each(['uncommitted', 'read-loss'] as const)('retains %s reply-loss responsibility and never resubmits', async (fault) => {
    const f = await store(row(), fault); await expect(f.recover()).rejects.toMatchObject({ code: 'store-unknown' })
    expect(f.owner.inspect().unknownMutations).toBe(1); await expect(f.recover()).rejects.toMatchObject({ code: 'store-unknown' }); expect(f.writes).toEqual(['failed'])
  })
  it('rejects immutable postimage drift after a failed CAS', async () => {
    const f = await store(row(), 'drift'); await expect(f.recover()).rejects.toMatchObject({ code: 'snapshot-changed' }); expect(f.writes).toEqual(['failed'])
  })
})
