/** Real Cordis lifecycle with only protected-publication and metadata seams; no PG, SDK or product receipt. */
import { Context } from '@deepseek-ai/cordis'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountRecoveryRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BootstrapFailure } from '../src/bootstrap/bootstrap.ts'
import { ExecutionStateError } from '../src/errors.ts'
import type { ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import { mountRootRecovery } from '../src/root-recovery.ts'
import { AllocationStoreError, PostgresAllocationStore } from '../src/allocation-store.ts'
import type { SandboxAllocation } from '../src/allocation-types.ts'
import type { AccountOwner } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { RootRecoveryWitness, recoveryIntentDigest, PROVIDER_CREATE_REFUSAL_CODE } from '../src/bootstrap/recovery-witness.ts'

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


it.each(['creating', 'failed', 'unknown'] as const)('audits verified refused %s metadata through the original maintenance participant', async (initial) => {
  const f = fixture(), now = Date.parse('2026-10-22T02:15:00.000Z')
  const registeredVerifier = vi.spyOn(f.recovery, 'registerVerifier')
  f.recovery.migrate = vi.fn(); f.recovery.locateInstance = vi.fn(); f.recovery.recoverAccount = vi.fn()
  f.recovery.inspectAccount = vi.fn(); f.recovery.closeInstance = vi.fn(); f.recovery.inspectInstance = vi.fn()
  const intent = { allocationId: 'refused-allocation', accountId: 'refused-account', epoch: '21', sessionId: 'session',
    workspaceId: 'workspace', environmentVersion: 'env', provider: 'opensandbox', projectMountVersion: 'mount',
    requestedAt: '2026-10-22T02:08:13.139Z', createDeadlineAt: '2026-10-22T02:08:43.139Z' } as SandboxAllocation
  let current: SandboxAllocation = { ...intent, state: initial === 'failed' ? 'failed' : 'creating', sandboxId: null, runtimeIdentity: null,
    executionProtocolVersion: null, executionCapabilities: [], lastActivityAt: intent.requestedAt,
    lastCheckedAt: intent.requestedAt, failureCode: initial === 'failed' ? PROVIDER_CREATE_REFUSAL_CODE : null }
  const item = { createOutcome: 'rejected-before-provider-create', sandboxId: null, intent, intentDigest: recoveryIntentDigest(intent),
    refusalCode: 'fixed-ttl-bounds', knownRefusalEvidenceRef: 'test:refusal', completedRequestEvidenceRef: 'test:completed',
    providerCreateNotStartedEvidenceRef: 'test:not-started', lateStartsRevokedEvidenceRef: 'test:late-loss' }
  // Publication intent has exactly the original ten immutable fields.
  const originalIntent = Object.fromEntries(['allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId', 'environmentVersion',
    'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt'].map(k => [k, Reflect.get(intent, k)]))
  const value = { schema: 'pe-local-controlled-recovery-v2', verifierId: 'local-original-process-and-provider-v1',
    auditRef: 'test:audit', verifiedAt: new Date(now).toISOString(), oldInstanceId: 'old-instance', databaseRole: 'test-role',
    writersVerifiedAt: new Date(now - 1).toISOString(), processEvidenceRef: 'test:process', writersEvidenceRef: 'test:writers',
    oldProcess: { pid: 3456, startTicks: '7890', bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' },
    accounts: [{ accountId: intent.accountId, epoch: intent.epoch, allocations: [{ ...item, intent: originalIntent }] }] }
  const witness = new RootRecoveryWitness({ value: () => value, assertCurrent() {} },
    { maxBytes: 32768, maxAccounts: 2, maxAllocations: 8, maxFieldBytes: 256, maxAgeMs: 30000 },
    i => ({ bootId: i.bootId, pidNamespace: i.pidNamespace, original: 'absent' }), () => now)
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
  const audit = vi.spyOn(f.recovery, 'recoverAccount').mockImplementation(async (_participant, expected) => {
    const verifier = registeredVerifier.mock.calls[0]?.[1]
    if (verifier === undefined) throw new Error('Original runtime verifier missing')
    const proof = await verifier.verify(expected)
    expect(proof.allocations).toEqual([{ allocationId: intent.allocationId,
      evidenceRefs: ['test:refusal', 'test:completed', 'test:not-started', 'test:late-loss'] }])
    return { proof, postimage: { ...owner, ownerInstanceId: null, phase: 'unowned' } }
  })
  vi.spyOn(f.recovery, 'inspectAccount').mockResolvedValue({ audit: undefined, current: undefined, matchesPostimage: true, responsibilityRetained: false })
  vi.spyOn(f.recovery, 'closeInstance').mockImplementation(async (_participant, expected) => ({ instanceId: expected.oldInstanceId, auditRef: expected.auditRef, alreadyClosed: false }))
  vi.spyOn(f.recovery, 'inspectInstance').mockResolvedValue({ audited: true, closed: true, retainedOwners: false, responsibilityRetained: false })
  vi.spyOn(f.ctx.logger, 'info').mockImplementation(() => {})
  if (initial === 'unknown') {
    await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).rejects.toMatchObject({ code: 'store-unknown' })
    await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(failed).toHaveBeenCalledOnce(); expect(audit).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); return
  }
  await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).resolves.toBeUndefined()
  expect(failed).toHaveBeenCalledTimes(initial === 'creating' ? 1 : 0)
  expect(release).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledOnce(); expect(current.sandboxId).toBeNull()
  await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled()
})
