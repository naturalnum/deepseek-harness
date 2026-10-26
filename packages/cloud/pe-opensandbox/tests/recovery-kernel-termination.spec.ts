/** Synthetic protected receipts/kernel observations; these tests grant no actual recovery authority. */
import { Context } from '@deepseek-ai/cordis'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountOwner, AccountRecoveryRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PostgresAllocationStore } from '../src/allocation-store.ts'
import type { SandboxAllocation } from '../src/allocation-types.ts'
import type { ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import { mountRootRecovery } from '../src/root-recovery.ts'
import { parseRecoveryWitness, RootRecoveryWitness, type RecoveryKernelIdentity } from '../src/bootstrap/recovery-witness.ts'

const seam = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/bootstrap/recovery-reference.ts', async original => ({
  ...await original<typeof import('../src/bootstrap/recovery-reference.ts')>(), openRootRecoveryReference: seam.open,
}))
const now = Date.parse('2026-10-22T12:00:00.000Z')
const at = (offset: number) => new Date(now + offset).toISOString()
const proof = (hex: string) => 'sha256:' + hex.repeat(64)
const limits = { maxBytes: 16384, maxAccounts: 2, maxAllocations: 4, maxFieldBytes: 512, maxAgeMs: 60000 }
const oldProcess = { pid: 3456, startTicks: '7890', bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' }
const newKernel = { bootId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', pidNamespace: 'pid:[5678]' }
function publication() {
  const deployment = { deploymentId: 'synthetic-original-deployment', containerId: '1'.repeat(64),
    volumeName: 'synthetic-original-volume', controlIdentity: 'synthetic-original-pg-control', imageDigest: proof('2') }
  const snapshot = (offset: number, hex: string, kernel: RecoveryKernelIdentity) => ({
    kernel: { bootId: kernel.bootId, pidNamespace: kernel.pidNamespace }, observedAt: at(offset), uid: 2000,
    uidProcessCount: 0, databaseConnectionCount: 0, allocationCount: 0, evidenceRef: proof(hex) })
  return { schema: 'pe-local-controlled-recovery-v3', verifierId: 'local-original-process-and-provider-v1',
    auditRef: 'synthetic-kernel-recovery', verifiedAt: at(0), oldInstanceId: 'old-instance', databaseRole: 'synthetic-control',
    writersVerifiedAt: at(-2000), oldProcess: { ...oldProcess }, processEvidenceRef: proof('b'), writersEvidenceRef: proof('8'),
    accounts: [{ accountId: 'account-a', epoch: '25', allocations: [] }],
    kernelTermination: { kind: 'local-prestopped-zero-work-v1', previousDeployment: { ...deployment },
      currentDeployment: { ...deployment }, lineageEvidenceRef: proof('5'), newKernel: { ...newKernel },
      kernelTerminatedAt: at(-3000), kernelTerminationEvidenceRef: proof('3'),
      processTerminationEvidenceRef: proof('b'), executionDomainEvidenceRef: proof('9'), ledgerBeforeProviderEvidenceRef: proof('a'),
      applicationExit: { exitCode: 0, observedAt: at(-5000), evidenceRef: proof('6') },
      quiescence: { beforeTermination: snapshot(-4000, '7', oldProcess), current: snapshot(-2000, '8', newKernel) } } }
}
function selected(value = publication(), observeKernel: () => RecoveryKernelIdentity = () => ({ ...newKernel }), clock = now) {
  return new RootRecoveryWitness({ value: () => value, assertCurrent() {} }, limits,
    () => { throw new Error('The new kernel cannot inspect an old-domain PID') }, () => clock, observeKernel)
}

function unexpectedAllocation(): SandboxAllocation {
  const raw = { ...publication(), schema: 'pe-local-controlled-recovery-v1', accounts: [{ accountId: 'account-a', epoch: '25',
    allocations: [{ intent: { allocationId: 'unexpected-old-allocation', accountId: 'account-a', sessionId: 'old-session',
      workspaceId: 'old-workspace', epoch: '25', environmentVersion: 'old-environment', provider: 'original-provider',
      projectMountVersion: 'original-mount', requestedAt: at(-10000), createDeadlineAt: at(-9000) }, sandboxId: 'old-sandbox',
    acceptedCreateEvidenceRef: 'synthetic:accepted', physicalStopEvidenceRef: 'synthetic:stopped',
    lateStartsRevokedEvidenceRef: 'synthetic:revoked' }] }] }
  const { kernelTermination: _removed, ...legacy } = raw
  const intent = parseRecoveryWitness(legacy, limits).accounts[0]?.allocations[0]?.intent
  if (intent === undefined) throw new Error('Missing synthetic original intent')
  return { ...intent, state: 'creating', sandboxId: null, lastActivityAt: intent.requestedAt, lastCheckedAt: intent.requestedAt,
    runtimeIdentity: null, executionProtocolVersion: null, executionCapabilities: [], failureCode: null }
}

describe('explicit pre-stopped zero-work local kernel termination', () => {
  it('retains the exact old identity and independently rechecks only the selected new kernel on every use', () => {
    const value = publication(), observe = vi.fn(() => ({ ...newKernel })), witness = selected(value, observe)
    expect(witness.facts.oldProcess).toEqual(oldProcess)
    expect(witness.facts.accounts[0]?.allocations).toEqual([])
    witness.assertCurrent()
    expect(observe).toHaveBeenCalledTimes(2)
    expect(Object.isFrozen(witness.facts)).toBe(true)
    if (witness.facts.schema !== 'pe-local-controlled-recovery-v3') throw new Error('Expected v3')
    expect(Object.isFrozen(witness.facts.kernelTermination.quiescence.current)).toBe(true)
  })

  it('rejects a different or unavailable current boot/namespace without using old PID absence', () => {
    for (const changed of [{ ...newKernel, bootId: oldProcess.bootId }, { ...newKernel, pidNamespace: oldProcess.pidNamespace }]) {
      expect(() => selected(publication(), () => changed)).toThrow(/Trusted recovery evidence/)
    }
    const original = new Error('Kernel unreadable')
    expect(() => selected(publication(), () => { throw original })).toThrow(original)
    const current = { ...newKernel }, witness = selected(publication(), () => current)
    current.pidNamespace = 'pid:[9999]'
    expect(() => { witness.assertCurrent() }).toThrow(/Trusted recovery evidence/)
  })

  it('keeps v1/v2 cross-boot refusal and rejects a restart flag or unselected v3 facts', () => {
    for (const schema of ['pe-local-controlled-recovery-v1', 'pe-local-controlled-recovery-v2']) {
      const { kernelTermination: _removed, ...value } = { ...publication(), schema }
      expect(() => new RootRecoveryWitness({ value: () => value, assertCurrent() {} }, limits,
        () => ({ ...newKernel, original: 'absent' }), () => now)).toThrow(/Trusted recovery evidence/)
      expect(() => parseRecoveryWitness({ ...value, kernelTermination: publication().kernelTermination }, limits))
        .toThrow(/Trusted recovery evidence/)
      expect(() => parseRecoveryWitness({ ...value, oldKernelTerminated: true }, limits)).toThrow(/Trusted recovery evidence/)
    }
    const { kernelTermination: _removed, ...incomplete } = publication()
    expect(() => parseRecoveryWitness(incomplete, limits)).toThrow(/Trusted recovery evidence/)
  })

  it('requires identical original deployment/container/volume/control/image bindings', () => {
    for (const key of ['deploymentId', 'containerId', 'volumeName', 'controlIdentity', 'imageDigest'] as const) {
      const value = publication()
      value.kernelTermination.currentDeployment[key] = key === 'containerId' ? '9'.repeat(64) : key === 'imageDigest' ? proof('9') : 'another-binding'
      expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
    }
    const value = publication()
    value.kernelTermination.newKernel = { bootId: oldProcess.bootId, pidNamespace: oldProcess.pidNamespace }
    expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
  })

  it('requires one historical and one current complete zero-work snapshot bound to their exact kernel domains', () => {
    for (const snapshot of ['beforeTermination', 'current'] as const) {
      for (const field of ['uid', 'uidProcessCount', 'databaseConnectionCount', 'allocationCount'] as const) {
        const value = publication()
        value.kernelTermination.quiescence[snapshot][field] = 1
        expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
      }
      const value = publication()
      Reflect.deleteProperty(value.kernelTermination.quiescence[snapshot], 'evidenceRef')
      expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
    }
    const wrongDomain = publication()
    wrongDomain.kernelTermination.quiescence.current.kernel = { bootId: oldProcess.bootId, pidNamespace: oldProcess.pidNamespace }
    expect(() => selected(wrongDomain)).toThrow(/Trusted recovery evidence/)
    const value = publication()
    value.kernelTermination.quiescence.current.evidenceRef = value.kernelTermination.quiescence.beforeTermination.evidenceRef
    expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
  })

  it('rejects missing, malformed, rebound or additional evidence fields', () => {
    for (const key of ['lineageEvidenceRef', 'kernelTerminationEvidenceRef', 'processTerminationEvidenceRef', 'executionDomainEvidenceRef',
      'ledgerBeforeProviderEvidenceRef'] as const) {
      const value = publication(); value.kernelTermination[key] = 'operator-says-stopped'
      expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
    }
    for (const field of ['processEvidenceRef', 'writersEvidenceRef'] as const) {
      const value = publication(); value[field] = proof('9')
      expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
    }
    const value = publication(); value.kernelTermination.applicationExit.exitCode = 1
    expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
    expect(() => parseRecoveryWitness({ ...publication(), trustedRestart: true }, limits)).toThrow(/Trusted recovery evidence/)
    expect(() => parseRecoveryWitness({ ...publication(),
      kernelTermination: { ...publication().kernelTermination, trusted: true } }, limits)).toThrow(/Trusted recovery evidence/)
    expect(() => parseRecoveryWitness(publication(), { ...limits, maxBytes: 128 })).toThrow(/Trusted recovery evidence/)
  })

  it('rejects unordered exit/snapshots/termination, missing snapshots and nonempty or multiple account coverage', () => {
    const changes = [
      (v: ReturnType<typeof publication>) => { v.kernelTermination.applicationExit.observedAt = at(-2500) },
      (v: ReturnType<typeof publication>) => { v.kernelTermination.quiescence.beforeTermination.observedAt = at(-3000) },
      (v: ReturnType<typeof publication>) => { v.kernelTermination.quiescence.current.observedAt = at(-4000) },
      (v: ReturnType<typeof publication>) => { v.kernelTermination.kernelTerminatedAt = at(1) },
      (v: ReturnType<typeof publication>) => { v.writersVerifiedAt = at(-3000) },
      (v: ReturnType<typeof publication>) => { Reflect.deleteProperty(v.kernelTermination.quiescence, 'current') },
      (v: ReturnType<typeof publication>) => { v.accounts.push({ accountId: 'account-b', epoch: '25', allocations: [] }) },
    ]
    for (const change of changes) {
      const value = publication(); change(value); expect(() => selected(value)).toThrow(/Trusted recovery evidence/)
    }
    const value = publication()
    expect(() => parseRecoveryWitness({ ...value, accounts: [{ ...value.accounts[0], allocations: [{}] }] }, limits))
      .toThrow(/Trusted recovery evidence/)
  })

  it('keeps age limits and retained publication revocation authoritative after construction', () => {
    expect(() => selected(publication(), () => newKernel, now - 1)).toThrow(/Trusted recovery evidence/)
    expect(() => selected(publication(), () => newKernel, now + limits.maxAgeMs + 1)).toThrow(/Trusted recovery evidence/)
    expect(() => selected(publication(), () => newKernel, now + limits.maxAgeMs - 1000)).toThrow(/Trusted recovery evidence/)
    let current = true
    const witness = new RootRecoveryWitness({ value: publication, assertCurrent() { if (!current) throw new Error('Publication revoked') } },
      limits, () => { throw new Error('No old PID read') }, () => now, () => newKernel)
    current = false
    expect(() => { witness.assertCurrent() }).toThrow('Publication revoked')
  })
})

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

it.each([false, true])('retains original maintenance SQL coverage and owner/instance sequence; unexpected allocation=%s', async (unexpected) => {
  const root = new Context(), ctx = root.plugin({ apply() {} }).ctx
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const query = vi.fn(() => Promise.reject(new Error('No actual SQL in synthetic recovery')))
  const unused = () => vi.fn(() => { throw new Error('Unexpected synthetic recovery call') })
  const recovery: AccountRecoveryRuntime = { whenReady: () => Promise.resolve(), registerVerifier: vi.fn(() => () => {}),
    migrate: unused(), locateInstance: unused(), recoverAccount: unused(), inspectAccount: unused(),
    closeInstance: unused(), inspectInstance: unused() }
  vi.spyOn(runtime, 'recovery', 'get').mockReturnValue(recovery)
  vi.spyOn(runtime, 'controlDatabase').mockReturnValue({ query, wasNotSubmitted: () => false })
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
  const register = vi.spyOn(recovery, 'registerVerifier')
  const close = vi.fn(); seam.open.mockReturnValue({ witness: selected(), close })
  onTestFinished(async () => { await root.fiber.dispose(); vi.restoreAllMocks() })
  const original = unexpectedAllocation()
  const owner: AccountOwner = { accountId: original.accountId, epoch: original.epoch,
    ownerInstanceId: 'old-instance' as AccountOwner['ownerInstanceId'], phase: 'quarantined', recipeVersion: 'fixture',
    heartbeatAt: at(-5000), updatedAt: at(-5000) }
  vi.spyOn(runtime, 'locateAccount').mockResolvedValue(owner)
  vi.spyOn(recovery, 'migrate').mockResolvedValue(undefined)
  vi.spyOn(recovery, 'locateInstance').mockResolvedValue({ instanceId: owner.ownerInstanceId!, phase: 'registered',
    heartbeatAt: at(-5000), internalAddress: 'http://fixture', recipeVersion: 'fixture' })
  const list = vi.spyOn(PostgresAllocationStore.prototype, 'listNonterminal').mockResolvedValue({
    allocations: unexpected ? [original] : [], nextCursor: null })
  vi.spyOn(PostgresAllocationStore.prototype, 'migrate').mockResolvedValue(undefined)
  const release = vi.spyOn(PostgresAllocationStore.prototype, 'releaseStopped')
  const refuse = vi.spyOn(PostgresAllocationStore.prototype, 'failNotCreated')
  const audit = vi.spyOn(recovery, 'recoverAccount').mockImplementation(async (_participant, expected) => {
    const verifier = register.mock.calls[0]?.[1]
    if (verifier === undefined) throw new Error('Original recovery verifier missing')
    const verified = await verifier.verify(expected)
    expect(verified.allocations).toEqual([])
    expect(verified.oldInstanceId).toBe('old-instance'); expect(verified.epoch).toBe('25')
    expect(verified.oldProcessEvidenceRef).toBe(proof('b')); expect(verified.writerLossEvidenceRef).toBe(proof('8'))
    return { proof: verified, postimage: { ...owner, ownerInstanceId: null, phase: 'unowned' } }
  })
  vi.spyOn(recovery, 'inspectAccount').mockResolvedValue({ audit: undefined, current: undefined, matchesPostimage: true, responsibilityRetained: false })
  const closeInstance = vi.spyOn(recovery, 'closeInstance').mockImplementation(async (_participant, expected) => ({
    instanceId: expected.oldInstanceId, auditRef: expected.auditRef, alreadyClosed: false }))
  vi.spyOn(recovery, 'inspectInstance').mockResolvedValue({ audited: true, closed: true, retainedOwners: false, responsibilityRetained: false })
  const reference = { publication: { path: '/synthetic/never-read.json', sha256: 'a'.repeat(64) }, maxBytes: 16384, maxAgeMs: 60000 }
  if (unexpected) {
    await expect(mountRootRecovery(ctx, runtime, config, reference)).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
    expect(audit).not.toHaveBeenCalled(); expect(closeInstance).not.toHaveBeenCalled()
  } else {
    await expect(mountRootRecovery(ctx, runtime, config, reference)).resolves.toBeUndefined()
    expect(audit).toHaveBeenCalledOnce(); expect(closeInstance).toHaveBeenCalledOnce()
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(closeInstance.mock.invocationCallOrder[0]!)
  }
  expect(list).toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(refuse).not.toHaveBeenCalled()
  expect(query).not.toHaveBeenCalled()
})
