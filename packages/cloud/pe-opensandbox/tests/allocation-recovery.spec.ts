/** Scripted native-store component tests only; no PostgreSQL connection or physical backend is exercised. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AllocationStoreError, PostgresAllocationStore } from '../src/allocation-store.ts'
import { recoveryIntentDigest as allocationRecoveryIntentDigest } from '../src/bootstrap/recovery-witness.ts'
import { allocationMigrationSql } from '../src/migrations/allocations.ts'
import type { AllocationId, AllocationQuery, SandboxAllocation } from '../src/allocation-types.ts'
import {
  reconcileOldAllocationEpoch, type AllocationRecoveryEvidence, type AllocationRecoveryLimits,
  type AllocationRecoverySnapshot, type TrustedAllocationRecoveryVerifier,
} from '../src/allocation-recovery.ts'

const scope = { accountId: brandString<AccountId>('old-account'), epoch: brandString<OwnerEpoch>('20') }
const limits: AllocationRecoveryLimits = {
  pageSize: 2, maxRows: 8, maxSnapshotBytes: 32768, maxProofBytes: 16384, maxReferenceBytes: 256,
}
function allocation(id = 'allocation-1', changes: Partial<SandboxAllocation> = {}): SandboxAllocation {
  return { allocationId: brandString<AllocationId>(id), ...scope, sessionId: SessionId('session-'+id),
    workspaceId: brandString<WorkspaceId>('workspace-1'), environmentVersion: 'image-v1', provider: 'opensandbox',
    projectMountVersion: 'mount-v1', requestedAt: '2026-10-20T00:00:00.000Z', createDeadlineAt: '2026-10-20T00:01:00.000Z',
    state: 'creating', sandboxId: null, lastActivityAt: '2026-10-20T00:00:00.000Z', lastCheckedAt: '2026-10-20T00:00:00.000Z',
    runtimeIdentity: null, executionProtocolVersion: null, executionCapabilities: [], failureCode: null, ...changes }
}
function evidence(snapshot: AllocationRecoverySnapshot): AllocationRecoveryEvidence {
  return { scope: snapshot.scope, snapshotDigest: snapshot.digest, oldProcessExitRef: 'test:process-exit',
    oldWriterWithdrawalRef: 'test:writer-loss', permanentLateCreateSpawnLossRef: 'test:permanent-loss',
    allocations: snapshot.allocations.map(({ row, digest, intentDigest }) => ({
      allocationId: row.allocationId, rowDigest: digest, intentDigest,
      sandboxId: row.sandboxId ?? 'sandbox-'+row.allocationId, createOutcome: 'accepted-created-and-settled',
      acceptedCreateRef: 'test:create-settled:'+row.allocationId, physicalDestructionRef: 'test:destroyed:'+row.allocationId,
      permanentLateCreateSpawnLossRef: 'test:no-late:'+row.allocationId,
      ...(row.sandboxId === null ? { independentCreateBindingRef: 'test:independent-binding:'+row.allocationId } : {}) })) }
}
const verifier = (verify: TrustedAllocationRecoveryVerifier['verify'] = async snapshot => evidence(snapshot)): TrustedAllocationRecoveryVerifier => ({ id: 'synthetic-verifier', verify })

type Fault = 'transition-committed' | 'transition-uncommitted' | 'release-committed' | 'release-uncommitted'
async function fixture(initial = [allocation()], fault?: Fault) {
  const rows = new Map(initial.map(row => [row.allocationId, structuredClone(row)]))
  const mutations: string[] = []
  let lists = 0, gets = 0
  let onList: ((count: number) => void) | undefined
  let onGet: ((count: number) => void) | undefined
  let failed = false
  const driver: AllocationQuery = { async query(sql, values) {
    if (sql === allocationMigrationSql) return { rows: [] }
    if (sql.startsWith('UPDATE')) {
      const id = values[0] as AllocationId
      const before = rows.get(id)
      const to = values[6]
      mutations.push(String(to))
      if (before === undefined || before.state !== values[5]) return { rows: [] }
      const stage = to === 'stopping' ? 'transition' : 'release'
      if (!failed && fault === stage+'-uncommitted') { failed = true; throw new Error('synthetic lost response before commit') }
      const after: SandboxAllocation = { ...before, state: to === 'stopping' ? 'stopping' : 'released',
        sandboxId: values[7] ?? before.sandboxId, lastCheckedAt: '2026-10-20T00:02:00.000Z' }
      rows.set(id, after)
      if (!failed && fault === stage+'-committed') { failed = true; throw new Error('synthetic lost response after commit') }
      return { rows: [{ allocation: after }] }
    }
    if (sql.includes('ORDER BY allocation_id')) {
      onList?.(++lists)
      const selected = [...rows.values()].filter(row => row.accountId === values[0] && row.epoch === values[1]
        && !['released', 'failed'].includes(row.state) && (values[2] === null || row.allocationId > String(values[2])))
        .sort((a,b) => a.allocationId < b.allocationId ? -1 : 1).slice(0, Number(values[3]))
      return { rows: selected.map(allocation => ({ allocation })) }
    }
    onGet?.(++gets)
    const row = rows.get(values[0] as AllocationId)
    return { rows: row === undefined ? [] : [{ allocation: row }] }
  } }
  const store = new PostgresAllocationStore(driver, { maxFieldBytes: 256, maxInputBytes: 65536,
    maxRowBytes: 8192, maxResultBytes: 32768, maxRows: 8, maxCapabilities: 5, maxPendingQueries: 4,
    maxMutationResponsibilities: 16, maxRetainedBytes: 262144 })
  await store.migrate()
  return { store, rows, mutations, onList: (callback: (count: number) => void) => { onList = callback },
    onGet: (callback: (count: number) => void) => { onGet = callback } }
}

function recover(store: PostgresAllocationStore, selected = verifier(), bounds = limits) {
  return reconcileOldAllocationEpoch(store, { scope, limits: bounds, verifier: selected })
}

describe('old allocation metadata recovery with complete trusted coverage', () => {
  it('uses canonical immutable intent SHA independent of mutable state', async () => {
    const row=allocation()
    const immutable=allocationRecoveryIntentDigest(row)
    expect(immutable).toBe('8dc91eaa9b9ca3911915ea65949976a6fc9bcd4dd93055a2b01e3b6320dd5e26')
    expect(immutable).toBe(allocationRecoveryIntentDigest({ ...row, state: 'stopping', sandboxId: 'sandbox-1' } as SandboxAllocation))
    expect(immutable).not.toBe(allocationRecoveryIntentDigest({ ...row, projectMountVersion: 'changed' }))
  })

  it('binds a null-id accepted create, finishes an existing stopping row, and returns coverage for a separate runtime CAS', async () => {
    const f = await fixture([allocation(), allocation('allocation-2', { state: 'stopping', sandboxId: 'sandbox-2' })])
    const report = await recover(f.store, verifier(async (snapshot) => {
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.allocations[0]?.row.executionCapabilities)).toBe(true)
      return evidence(snapshot)
    }))
    expect(f.mutations).toEqual(['stopping', 'released', 'released'])
    expect(f.rows.get(brandString<AllocationId>('allocation-1'))).toMatchObject({ state: 'released', sandboxId: 'sandbox-allocation-1' })
    expect(report.coverage).toHaveLength(2)
    expect(report.evidenceRefs).toContain('test:independent-binding:allocation-1')
    expect(report.reconciledUnknownWrites).toBe(0)
    expect(f.store.inspect()).toMatchObject({ pendingQueries: 0, mutationResponsibilities: 0 })
  })

  it.each(['ready', 'uncertain'] as const)('releases a verified destroyed %s resource without changing immutable or prepared metadata', async (state) => {
    const original = allocation('allocation-1', { state, sandboxId: 'sandbox-1', runtimeIdentity: 'runtime-1',
      executionProtocolVersion: 'exec-v1', executionCapabilities: ['argv-collect'],
      failureCode: state === 'ready' ? null : 'prepare-failed' })
    const f = await fixture([original])
    await recover(f.store)
    expect(f.mutations).toEqual(['stopping', 'released'])
    expect(f.rows.get(original.allocationId)).toMatchObject({ state: 'released', sandboxId: 'sandbox-1',
      runtimeIdentity: original.runtimeIdentity, executionProtocolVersion: original.executionProtocolVersion,
      executionCapabilities: original.executionCapabilities, failureCode: original.failureCode,
      projectMountVersion: original.projectMountVersion, lastActivityAt: original.lastActivityAt })
  })

  it('retains the independent binding audit when an already-stopping null-id row needs only the original release CAS', async () => {
    const f = await fixture([allocation('allocation-1', { state: 'stopping' })])
    const report = await recover(f.store)
    expect(f.mutations).toEqual(['released'])
    expect(report.coverage[0]?.sandboxId).toBe('sandbox-allocation-1')
    expect(report.coverage[0]?.independentCreateBindingRef).toBeDefined()
  })

  it('repeats successful recovery with no metadata write or provider action while still requiring owner-loss verification', async () => {
    const f = await fixture()
    await recover(f.store)
    const verify = vi.fn(async (snapshot: AllocationRecoverySnapshot) => evidence(snapshot))
    const repeated = await recover(f.store, verifier(verify))
    expect(repeated.coverage).toEqual([])
    expect(verify).toHaveBeenCalledOnce()
    expect(f.mutations).toEqual(['stopping', 'released'])
    await expect(recover(f.store, verifier(async () => undefined))).rejects.toMatchObject({ code: 'proof' })
  })

  const invalid: [string, (proof: AllocationRecoveryEvidence) => AllocationRecoveryEvidence | undefined][] = [
    ['missing proof', () => undefined],
    ['missing old process fact', p => ({ ...p, oldProcessExitRef: '' })],
    ['missing writer loss', p => ({ ...p, oldWriterWithdrawalRef: '' })],
    ['missing permanent owner loss', p => ({ ...p, permanentLateCreateSpawnLossRef: '' })],
    ['wrong account', p => ({ ...p, scope: { ...scope, accountId: brandString<AccountId>('other') } })],
    ['wrong epoch', p => ({ ...p, scope: { ...scope, epoch: brandString<OwnerEpoch>('21') } })],
    ['wrong whole snapshot', p => ({ ...p, snapshotDigest: 'different' })],
    ['missing allocation', p => ({ ...p, allocations: [] })],
    ['extra proof field', p => Object.assign({ ...p }, { unreviewed: 'extra' })],
    ['extra allocation', p => ({ ...p, allocations: [...p.allocations, p.allocations[0]!] })],
    ['wrong immutable intent witness', p => ({ ...p, allocations: p.allocations.map(item => ({ ...item, intentDigest: 'different' })) })],
    ['wrong original row or intent', p => ({ ...p, allocations: p.allocations.map(item => ({ ...item, rowDigest: 'different' })) })],
    ['missing independent create binding', p => ({ ...p, allocations: p.allocations.map(({ independentCreateBindingRef: _binding, ...item }) => item) })],
    ['missing physical destruction', p => ({ ...p, allocations: p.allocations.map(item => ({ ...item, physicalDestructionRef: '' })) })],
    ['missing per-resource late-start loss', p => ({ ...p, allocations: p.allocations.map(item => ({ ...item, permanentLateCreateSpawnLossRef: '' })) })],
    ['missing accepted create terminal', p => ({ ...p, allocations: p.allocations.map(item => ({ ...item, acceptedCreateRef: '' })) })],
  ]
  it.each(invalid)('rejects %s before every metadata write', async (_name, change) => {
    const f = await fixture()
    await expect(recover(f.store, verifier(async snapshot => change(evidence(snapshot))))).rejects.toMatchObject({ code: 'proof' })
    expect(f.mutations).toEqual([])
  })

  it('rejects duplicate coverage despite the correct total item count', async () => {
    const f = await fixture([allocation(), allocation('allocation-2')])
    await expect(recover(f.store, verifier(async (snapshot) => {
      const p = evidence(snapshot);return { ...p, allocations: [p.allocations[0]!, p.allocations[0]!] }
    }))).rejects.toMatchObject({ code: 'proof' })
    expect(f.mutations).toEqual([])
  })

  it('rejects a create that the verifier cannot establish as accepted-created-and-settled', async () => {
    const f = await fixture()
    await expect(recover(f.store, verifier(async (snapshot) => {
      const p = evidence(snapshot)
      return { ...p, allocations: p.allocations.map(item => ({ ...item, createOutcome: 'unsettled-or-unknown' as const })) }
    }))).rejects.toMatchObject({ code: 'proof' })
    expect(f.mutations).toEqual([])
  })

  it('rejects a wrong exact sandbox identity on a durable bound row', async () => {
    const f = await fixture([allocation('allocation-1', { state: 'uncertain', sandboxId: 'exact-sandbox', failureCode: 'prepare-failed' })])
    await expect(recover(f.store, verifier(async (snapshot) => {
      const p=evidence(snapshot);return { ...p, allocations: p.allocations.map(item => ({ ...item, sandboxId: 'different-sandbox' })) }
    }))).rejects.toMatchObject({ code: 'proof' })
    expect(f.mutations).toEqual([])
  })

  it.each(['rows', 'snapshot-bytes', 'proof-bytes', 'reference-bytes'] as const)('refuses %s overflow with zero writes', async (mode) => {
    const f = await fixture([allocation(), allocation('allocation-2'), allocation('allocation-3')])
    const selected = vi.fn(async (snapshot: AllocationRecoverySnapshot) => evidence(snapshot))
    const bound = { ...limits, ...(mode === 'rows' ? { pageSize: 1, maxRows: 2 }
      : mode === 'snapshot-bytes' ? { maxSnapshotBytes: 128 }
        : mode === 'proof-bytes' ? { maxProofBytes: 128 } : { maxReferenceBytes: 2 }) }
    await expect(recover(f.store, verifier(selected), bound)).rejects.toMatchObject({ code: mode === 'reference-bytes' ? 'proof' : 'bounds' })
    expect(f.mutations).toEqual([])
    if (mode === 'rows' || mode === 'snapshot-bytes' || mode === 'reference-bytes') expect(selected).not.toHaveBeenCalled()
  })

  it('bounds the complete returned coverage and references before any write, not only the verifier input', async () => {
    const f = await fixture()
    const selected = verifier(async snapshot => evidence(snapshot))
    let proofBytes = 0
    const sizing = verifier(async (snapshot) => { const p=evidence(snapshot);proofBytes=Buffer.byteLength(JSON.stringify(p));return p })
    await expect(recover(f.store, sizing, { ...limits, maxProofBytes: 1 })).rejects.toMatchObject({ code: 'bounds' })
    await expect(recover(f.store, selected, { ...limits, maxProofBytes: proofBytes })).rejects.toMatchObject({ code: 'bounds' })
    expect(f.mutations).toEqual([])
  })

  it('rejects complete-snapshot changes after verification before writing', async () => {
    const f = await fixture()
    await expect(recover(f.store, verifier(async (snapshot) => {
      const proof=evidence(snapshot)
      f.rows.set(brandString<AllocationId>('allocation-2'), allocation('allocation-2'))
      return proof
    }))).rejects.toMatchObject({ code: 'snapshot-changed' })
    expect(f.mutations).toEqual([])
  })

  it('rejects original-state drift after witness verification with zero metadata writes', async () => {
    const f=await fixture()
    await expect(recover(f.store,verifier(async (snapshot) => {
      const proof=evidence(snapshot)
      f.rows.set(brandString<AllocationId>('allocation-1'),allocation('allocation-1',{ state:'stopping' }))
      return proof
    }))).rejects.toMatchObject({ code:'snapshot-changed' })
    expect(f.mutations).toEqual([])
  })

  it('checks every immutable intent field again through exact get before the first CAS', async () => {
    const f = await fixture()
    f.onGet((count) => { if (count===1) f.rows.set(brandString<AllocationId>('allocation-1'), allocation('allocation-1', { projectMountVersion: 'changed-mount' })) })
    await expect(recover(f.store)).rejects.toMatchObject({ code: 'snapshot-changed' })
    expect(f.mutations).toEqual([])
  })

  it('requires the repeated final full scan and rejects a newly observed old allocation', async () => {
    const f = await fixture()
    f.onList((count) => { if (count===3) f.rows.set(brandString<AllocationId>('allocation-2'), allocation('allocation-2')) })
    await expect(recover(f.store)).rejects.toMatchObject({ code: 'snapshot-changed' })
    expect(f.mutations).toEqual(['stopping', 'released'])
  })

  it.each(['transition-committed', 'release-committed'] as const)('reads the original captured %s postimage without replaying the failed write', async (fault) => {
    const f = await fixture([allocation()], fault)
    const report = await recover(f.store)
    expect(report.reconciledUnknownWrites).toBe(1)
    expect(f.mutations).toEqual(['stopping', 'released'])
    expect(f.store.inspect().unknownMutations).toBe(0)
  })

  it.each(['transition-uncommitted', 'release-uncommitted'] as const)('retains original %s uncertainty and never retries that mutation', async (fault) => {
    const f = await fixture([allocation()], fault)
    await expect(recover(f.store)).rejects.toMatchObject({ code: 'store-unknown' })
    expect(f.mutations).toEqual(fault.startsWith('transition') ? ['stopping'] : ['stopping', 'released'])
    expect(f.store.inspect().unknownMutations).toBe(1)
    await expect(recover(f.store)).rejects.toMatchObject({ code: 'store-unknown' })
    expect(f.mutations).toEqual(fault.startsWith('transition') ? ['stopping'] : ['stopping', 'released'])
  })

  it('reconciles a preexisting captured stopping postimage read-only before issuing only the distinct release CAS', async () => {
    const f=await fixture([allocation()], 'transition-committed')
    await expect(f.store.transition(allocation(),{ to:'stopping',sandboxId:'sandbox-allocation-1' })).rejects.toMatchObject({ code:'unknown' })
    const report=await recover(f.store)
    expect(report.reconciledUnknownWrites).toBe(1)
    expect(f.mutations).toEqual(['stopping','released'])
  })

  it('does not infer success from an empty nonterminal list while the original store retains a committed release uncertainty', async () => {
    const f = await fixture([allocation('allocation-1', { state: 'stopping', sandboxId: 'sandbox-1' })], 'release-committed')
    await expect(f.store.releaseStopped(allocation('allocation-1', { state: 'stopping', sandboxId: 'sandbox-1' }))).rejects.toBeInstanceOf(AllocationStoreError)
    expect((await f.store.listNonterminal(scope,null,2)).allocations).toEqual([])
    await expect(recover(f.store)).rejects.toMatchObject({ code: 'store-unknown' })
    expect(f.store.inspect().unknownMutations).toBe(1)
    expect(f.mutations).toEqual(['released'])
  })
})
