/** Real Cordis lifecycle with only protected-publication and metadata seams; no PG, SDK or product receipt. */
import { Context } from '@deepseek-ai/cordis'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountRecoveryRuntime, OwnerRecoveryExpectation } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BootstrapFailure } from '../src/bootstrap/bootstrap.ts'
import { ExecutionStateError } from '../src/errors.ts'
import type { ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import { mountRootRecovery } from '../src/root-recovery.ts'
import { AllocationStoreError, PostgresAllocationStore } from '../src/allocation-store.ts'
import type { SandboxAllocation } from '../src/allocation-types.ts'
import type { AccountOwner } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { RootRecoveryWitness, recoveryIntentDigest, PROVIDER_CREATE_REFUSAL_CODE,
  PROVIDER_EXECUTION_REJECTION_CODE } from '../src/bootstrap/recovery-witness.ts'

const seam = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/bootstrap/recovery-reference.ts', async original => ({
  ...await original<typeof import('../src/bootstrap/recovery-reference.ts')>(), openRootRecoveryReference: seam.open,
}))
const config: ManagedCoordinatorConfig = {
  maxBoundAccounts: 2, maxActiveCommands: 4, maxActiveCommandsPerAccount: 2,
  maxResidentCommands: 8, maxResidentCommandsPerAccount: 4, maxResidentBytes: 524288, maxResidentBytesPerAccount: 262144,
  maxStopObservers: 4, stopWaitBudgetMs: 10000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'fixture', provider: 'fixture', createBudgetMs: 30000,
    maxAllocations: 4, maxAllocationsPerAccount: 2, maxWaiters: 8, maxWaitersPerAllocation: 4 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 32768,
    maxRows: 8, maxCapabilities: 5, maxPendingQueries: 4, maxMutationResponsibilities: 8, maxRetainedBytes: 1048576 },
  commands: { allowedTools: ['bash'], maxScopes: 4, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16,
    maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
    pollIntervalMs: 1000, maxWaiters: 4, maxLifetimeMs: 12000, stopWaitMs: 2000 } },
  shell: { bashPath: '/bin/bash', timeoutMs: 3000, maxTimeoutMs: 5000, maxOutputBytes: 4096, graceMs: 1000 },
}
const reference = { publication: { path: '/fixture/not-read.json', sha256: 'a'.repeat(64) }, maxBytes: 32768, maxAgeMs: 30000 }

function fixture(ready: Promise<undefined> = Promise.resolve(undefined)) {
  const root = new Context(), ctx = root.plugin({ apply() {} }).ctx
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const query = vi.fn(() => Promise.reject(new Error('No fixture SQL may be submitted')))
  const unused = vi.fn(() => { throw new Error('No owner recovery may be submitted') })
  const recovery: AccountRecoveryRuntime = { whenReady: () => ready, registerVerifier: vi.fn(() => () => {}),
    migrate: unused, locateInstance: unused, recoverAccount: unused, inspectAccount: unused,
    closeInstance: unused, inspectInstance: unused }
  vi.spyOn(runtime, 'recovery', 'get').mockReturnValue(recovery)
  const register = vi.spyOn(runtime, 'registerDrainParticipant')
  vi.spyOn(runtime, 'controlDatabase').mockReturnValue({ query, wasNotSubmitted: () => false })
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(async () => { await root.fiber.dispose(); vi.restoreAllMocks() })
  return { ctx, runtime, query, recovery, register, unused }
}

it.each(['wire-unknown', 'command-unknown'] as const)('retains actual %s publication cleanup through participant withdrawal', async (code) => {
  const f = fixture(), held = { originalLease: true }, failure = new BootstrapFailure(code, held)
  seam.open.mockImplementation(() => { throw failure })
  await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).rejects.toBe(failure)
  const participant = f.register.mock.calls[0]?.[0]
  expect(participant).toBeDefined()
  await expect(participant?.closeRoot?.()).rejects.toBe(failure)
  expect(f.query).not.toHaveBeenCalled()
  expect(f.unused).not.toHaveBeenCalled()
})

it('settles a known publication refusal without inventing SQL or unresolved work', async () => {
  const f = fixture(), failure = new ExecutionStateError('cloud/invalid-config', 'Fixture protection refused')
  seam.open.mockImplementation(() => { throw failure })
  await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).rejects.toBe(failure)
  await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).resolves.toBeUndefined()
  expect(f.query).not.toHaveBeenCalled()
})

it('does not start late recovery after Cordis disposal while original runtime startup is pending', async () => {
  const ready = Promise.withResolvers<undefined>(), f = fixture(ready.promise)
  seam.open.mockReset()
  const actual = mountRootRecovery(f.ctx, f.runtime, config, reference)
  await f.ctx.fiber.dispose()
  ready.resolve(undefined)
  await expect(actual).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(f.register).not.toHaveBeenCalled()
  expect(seam.open).not.toHaveBeenCalled()
  expect(f.query).not.toHaveBeenCalled()
})

const target = { accountId: 'target-account', oldInstanceId: 'old-instance', epoch: '21', operatorRef: 'admin:42' }
const byTarget = { ...reference, target }

function targetFixture(options?: { readonly otherAccount?: boolean; readonly oldProcessAlive?: boolean }) {
  const f = fixture(), now = Date.parse('2026-10-22T02:15:00.000Z')
  const { accountId, oldInstanceId, epoch } = target
  const owner = { accountId, epoch, ownerInstanceId: oldInstanceId, phase: 'quarantined',
    recipeVersion: 'fixture', updatedAt: new Date(now - 1000).toISOString(), heartbeatAt: new Date(now - 1000).toISOString() } as AccountOwner
  const other = { accountId: 'other-account', epoch: '22', allocations: [] }
  const value = { schema: 'pe-local-controlled-recovery-v1', verifierId: 'local-original-process-and-provider-v1',
    auditRef: 'test:audit', verifiedAt: new Date(now).toISOString(), oldInstanceId, databaseRole: 'test-role',
    writersVerifiedAt: new Date(now - 1).toISOString(), processEvidenceRef: 'test:process', writersEvidenceRef: 'test:writers',
    oldProcess: { pid: 3456, startTicks: '7890', bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' },
    accounts: [{ accountId, epoch, allocations: [] }, ...(options?.otherAccount === true ? [other] : [])] }
  const close = vi.fn()
  seam.open.mockImplementation(() => ({
    witness: new RootRecoveryWitness({ value: () => value, assertCurrent() {} },
      { maxBytes: 32768, maxAccounts: 2, maxAllocations: 8, maxFieldBytes: 256, maxAgeMs: 30000 },
      i => ({ bootId: i.bootId, pidNamespace: i.pidNamespace, original: options?.oldProcessAlive === true ? 'alive' : 'absent' }),
      () => now),
    close,
  }))
  const migrate = vi.spyOn(PostgresAllocationStore.prototype, 'migrate').mockResolvedValue(undefined)
  const row = vi.spyOn(f.runtime, 'locateAccount').mockResolvedValue(owner)
  const scopes = vi.spyOn(f.recovery, 'registerVerifier')
  const postimage = { ...owner, ownerInstanceId: null, phase: 'unowned' } as const
  f.recovery.migrate = vi.fn(async () => {})
  f.recovery.inspectAccount = vi.fn(async () => ({
    audit: undefined, current: postimage, matchesPostimage: false, responsibilityRetained: false,
  }))
  const verify = (expected: OwnerRecoveryExpectation) => {
    const verifier = scopes.mock.calls[0]?.[1]
    if (verifier === undefined) throw new Error('Original runtime verifier missing')
    return verifier.verify(expected)
  }
  f.recovery.recoverAccount = vi.fn(async (participant, expected) => {
    const proof = await verify(expected)
    const audit = { proof, postimage }
    vi.mocked(f.recovery.inspectAccount).mockResolvedValue({
      audit, current: postimage, matchesPostimage: true, responsibilityRetained: false,
    })
    expect(participant).toBe(f.register.mock.calls[0]?.[0])
    return audit
  })
  vi.spyOn(f.ctx.logger, 'info').mockImplementation(() => {})
  return { ...f, close, migrate, postimage, row, verify }
}

it('recovers and audits exactly one quarantined account through its original maintenance verifier', async () => {
  const f = targetFixture()
  await expect(mountRootRecovery(f.ctx, f.runtime, config, byTarget)).resolves.toBeUndefined()
  expect(f.row.mock.calls).toEqual([[target.accountId]])
  expect(f.recovery.recoverAccount).toHaveBeenCalledWith(f.register.mock.calls[0]?.[0], {
    accountId: target.accountId, oldInstanceId: target.oldInstanceId, epoch: target.epoch,
    auditRef: expect.stringMatching(/^recovery:[a-f0-9]{64}$/),
  })
  await expect(vi.mocked(f.recovery.recoverAccount).mock.results[0]?.value).resolves.toMatchObject({
    proof: { operatorRef: target.operatorRef }, postimage: { accountId: target.accountId, epoch: target.epoch, phase: 'unowned' },
  })
  expect(f.unused).not.toHaveBeenCalled()
  expect(f.query).not.toHaveBeenCalled()
  await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).resolves.toBeUndefined()
  expect(f.close).toHaveBeenCalledOnce()
})

it.each([
  { label: 'a second account in the witness', otherAccount: true, code: 'cloud/stop-unconfirmed' },
  { label: 'the exact old process still alive', oldProcessAlive: true, code: 'cloud/execution-unavailable' },
  { label: 'a different selected epoch', differentEpoch: true, code: 'cloud/stop-unconfirmed' },
])('refuses $label before migration or recovery', async (entry) => {
  const f = targetFixture(entry)
  const input = entry.differentEpoch === true ? { ...byTarget, target: { ...target, epoch: '22' } } : byTarget
  await expect(mountRootRecovery(f.ctx, f.runtime, config, input)).rejects.toMatchObject({ code: entry.code })
  expect(f.migrate).not.toHaveBeenCalled()
  expect(f.recovery.migrate).not.toHaveBeenCalled()
  expect(f.row).not.toHaveBeenCalled()
  expect(f.recovery.recoverAccount).not.toHaveBeenCalled()
})

it('does not count an already unowned generation without a recovery audit', async () => {
  const f = targetFixture()
  f.row.mockResolvedValue(f.postimage)
  await expect(mountRootRecovery(f.ctx, f.runtime, config, byTarget)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.recovery.recoverAccount).not.toHaveBeenCalled()
  expect(f.unused).not.toHaveBeenCalled()
})

it('refuses a matching unowned postimage audited under a different operator', async () => {
  const f = targetFixture()
  f.row.mockResolvedValue(f.postimage)
  vi.mocked(f.recovery.inspectAccount).mockImplementation(async (_participant, expected) => ({
    audit: { proof: { ...await f.verify(expected), operatorRef: 'admin:other' }, postimage: f.postimage },
    current: f.postimage, matchesPostimage: true, responsibilityRetained: false,
  }))
  await expect(mountRootRecovery(f.ctx, f.runtime, config, byTarget)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.recovery.recoverAccount).not.toHaveBeenCalled()
})

it('preserves a submitted unknown owner write through original maintenance shutdown', async () => {
  const f = targetFixture()
  const failure = new ExecutionStateError('cloud/stop-unconfirmed', 'Fixture writer result unknown')
  vi.mocked(f.recovery.recoverAccount).mockRejectedValue(failure)
  vi.mocked(f.recovery.inspectAccount).mockResolvedValue({
    audit: undefined, current: undefined, matchesPostimage: false, responsibilityRetained: true,
  })
  await expect(mountRootRecovery(f.ctx, f.runtime, config, byTarget)).rejects.toBe(failure)
  await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.recovery.recoverAccount).toHaveBeenCalledOnce()
  expect(f.close).not.toHaveBeenCalled()
  expect(f.unused).not.toHaveBeenCalled()
})

it.each((['fixed-ttl-bounds', 'host-bind-bounds', 'docker-systempaths-security-option-v1'] as const).flatMap(refusalCode =>
  (['creating', 'failed', 'unknown'] as const).map(initial => ({ refusalCode, initial, targeted: false }))).concat(
  (['creating', 'failed'] as const).map(initial => ({ refusalCode: 'fixed-ttl-bounds' as const, initial, targeted: true }))))
('audits verified $refusalCode $initial metadata through the original maintenance participant (targeted=$targeted)', async ({ refusalCode, initial, targeted }) => {
  const f = fixture(), now = Date.parse('2026-10-22T02:15:00.000Z')
  const registeredVerifier = vi.spyOn(f.recovery, 'registerVerifier')
  f.recovery.migrate = vi.fn(); f.recovery.locateInstance = vi.fn(); f.recovery.recoverAccount = vi.fn()
  f.recovery.inspectAccount = vi.fn(); f.recovery.closeInstance = vi.fn(); f.recovery.inspectInstance = vi.fn()
  const rejected = refusalCode === 'docker-systempaths-security-option-v1'
  const terminalCode = rejected ? PROVIDER_EXECUTION_REJECTION_CODE : PROVIDER_CREATE_REFUSAL_CODE
  const refs = rejected ? [1, 2, 3, 4, 5].map(n => 'sha256:' + String(n).repeat(64))
    : ['test:refusal', 'test:completed', 'test:not-started', 'test:late-loss']
  const intent = { allocationId: 'refused-allocation', accountId: 'refused-account', epoch: '21', sessionId: 'session',
    workspaceId: 'workspace', environmentVersion: 'env', provider: 'opensandbox', projectMountVersion: 'mount',
    requestedAt: '2026-10-22T02:08:13.139Z', createDeadlineAt: '2026-10-22T02:08:43.139Z' } as SandboxAllocation
  let current: SandboxAllocation = { ...intent, state: initial === 'failed' ? 'failed' : 'creating', sandboxId: null, runtimeIdentity: null,
    executionProtocolVersion: null, executionCapabilities: [], lastActivityAt: intent.requestedAt,
    lastCheckedAt: intent.requestedAt, failureCode: initial === 'failed' ? terminalCode : null }
  const item = rejected ? { createOutcome: 'provider-rejected-before-execution-resource', sandboxId: null,
    intent, intentDigest: recoveryIntentDigest(intent), rejectionCode: refusalCode,
    providerRequestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', requestBindingEvidenceRef: refs[0],
    preExecutionRejectionEvidenceRef: refs[1], completedRequestEvidenceRef: refs[2],
    auxiliarySettlementEvidenceRef: refs[3], lateStartsRevokedEvidenceRef: refs[4] }
    : { createOutcome: 'rejected-before-provider-create', sandboxId: null, intent, intentDigest: recoveryIntentDigest(intent),
      refusalCode, knownRefusalEvidenceRef: 'test:refusal', completedRequestEvidenceRef: 'test:completed',
      providerCreateNotStartedEvidenceRef: 'test:not-started', lateStartsRevokedEvidenceRef: 'test:late-loss' }
  // Publication intent has exactly the original ten immutable fields.
  const originalIntent = Object.fromEntries(['allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId', 'environmentVersion',
    'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt'].map(k => [k, Reflect.get(intent, k)]))
  const value = { schema: rejected ? 'pe-local-controlled-recovery-v4' : 'pe-local-controlled-recovery-v2',
    verifierId: 'local-original-process-and-provider-v1',
    auditRef: 'test:audit', verifiedAt: new Date(now).toISOString(), oldInstanceId: 'old-instance', databaseRole: 'test-role',
    writersVerifiedAt: new Date(now - 1).toISOString(), processEvidenceRef: 'test:process', writersEvidenceRef: 'test:writers',
    oldProcess: { pid: 3456, startTicks: '7890', bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' },
    accounts: [{ accountId: intent.accountId, epoch: intent.epoch, allocations: [{ ...item, intent: originalIntent }] }] }
  const witness = new RootRecoveryWitness({ value: () => value, assertCurrent() {} },
    { maxBytes: 32768, maxAccounts: 2, maxAllocations: 8, maxFieldBytes: 256, maxAgeMs: 30000 },
    i => ({ bootId: i.bootId, pidNamespace: i.pidNamespace, original: 'absent' }), () => now)
  expect(witness.verifyAllocation(current)).toMatchObject(rejected ? { rejectionCode: refusalCode } : { refusalCode })
  const close = vi.fn(); seam.open.mockReturnValue({ witness, close })
  vi.spyOn(PostgresAllocationStore.prototype, 'migrate').mockResolvedValue(undefined)
  vi.spyOn(PostgresAllocationStore.prototype, 'get').mockImplementation(async () => current)
  vi.spyOn(PostgresAllocationStore.prototype, 'listNonterminal').mockImplementation(async () => ({ allocations: current.state === 'creating' ? [current] : [], nextCursor: null }))
  let retained = false
  vi.spyOn(PostgresAllocationStore.prototype, 'inspect').mockImplementation(() => ({ pendingQueries: 0, mutationResponsibilities: Number(retained), unknownMutations: Number(retained), retainedBytes: 0 }))
  vi.spyOn(PostgresAllocationStore.prototype, 'reconcileCommitted').mockRejectedValue(new AllocationStoreError('unknown'))
  const failed = vi.spyOn(PostgresAllocationStore.prototype, 'failNotCreated').mockImplementation(async (_expected, code) => {
    if (initial === 'unknown') { retained = true; throw new AllocationStoreError('unknown') }
    current = { ...current, state: 'failed', failureCode: code }; return current
  })
  const release = vi.spyOn(PostgresAllocationStore.prototype, 'releaseStopped')
  const owner = { accountId: intent.accountId, epoch: intent.epoch, ownerInstanceId: 'old-instance', phase: 'quarantined',
    recipeVersion: 'fixture', heartbeatAt: intent.requestedAt, updatedAt: intent.requestedAt } as AccountOwner
  vi.spyOn(f.runtime, 'locateAccount').mockResolvedValue(owner)
  vi.spyOn(f.recovery, 'migrate').mockResolvedValue(undefined)
  vi.spyOn(f.recovery, 'locateInstance').mockResolvedValue({ instanceId: owner.ownerInstanceId!, phase: 'registered', heartbeatAt: intent.requestedAt,
    internalAddress: 'http://fixture', recipeVersion: 'fixture' })
  const inspectAccount = vi.spyOn(f.recovery, 'inspectAccount').mockResolvedValue({
    audit: undefined, current: undefined, matchesPostimage: true, responsibilityRetained: false,
  })
  const audit = vi.spyOn(f.recovery, 'recoverAccount').mockImplementation(async (_participant, expected) => {
    const verifier = registeredVerifier.mock.calls[0]?.[1]
    if (verifier === undefined) throw new Error('Original runtime verifier missing')
    const proof = await verifier.verify(expected)
    expect(proof.allocations).toEqual([{ allocationId: intent.allocationId,
      evidenceRefs: refs }])
    const postimage = { ...owner, ownerInstanceId: null, phase: 'unowned' } as const
    const result = { proof, postimage }
    if (targeted) inspectAccount.mockResolvedValue({
      audit: result, current: postimage, matchesPostimage: true, responsibilityRetained: false,
    })
    return result
  })
  vi.spyOn(f.recovery, 'closeInstance').mockImplementation(async (_participant, expected) => ({ instanceId: expected.oldInstanceId, auditRef: expected.auditRef, alreadyClosed: false }))
  vi.spyOn(f.recovery, 'inspectInstance').mockResolvedValue({ audited: true, closed: true, retainedOwners: false, responsibilityRetained: false })
  vi.spyOn(f.ctx.logger, 'info').mockImplementation(() => {})
  const selected = targeted ? { ...reference, target: { ...target, accountId: intent.accountId } } : reference
  if (targeted && initial === 'creating') {
    await expect(mountRootRecovery(f.ctx, f.runtime, config, selected)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(failed).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(f.recovery.closeInstance).not.toHaveBeenCalled()
    return
  }
  if (initial === 'unknown') {
    await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).rejects.toMatchObject({ code: 'store-unknown' })
    await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(failed).toHaveBeenCalledOnce(); expect(audit).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); return
  }
  await expect(mountRootRecovery(f.ctx, f.runtime, config, selected)).resolves.toBeUndefined()
  expect(failed).toHaveBeenCalledTimes(initial === 'creating' ? 1 : 0)
  expect(release).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledOnce(); expect(current.sandboxId).toBeNull()
  await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled()
  expect(f.recovery.closeInstance).toHaveBeenCalledTimes(targeted ? 0 : 1)
})
