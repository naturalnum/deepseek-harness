/** Original protected-publication and kernel observers are simulated; these cases cannot release an owner or allocation. */
import { describe, expect, it } from 'vitest'
import { parseRecoveryWitness, RootRecoveryWitness, type RecoveryProcessIdentity, type RecoveryWitnessLimits } from '../src/bootstrap/recovery-witness.ts'
import type { SandboxAllocation } from '../src/allocation-types.ts'

const now = Date.parse('2026-10-22T00:00:00.000Z')
const limits: RecoveryWitnessLimits = { maxBytes: 16384, maxAccounts: 2, maxAllocations: 4, maxFieldBytes: 512, maxAgeMs: 60000 }
function fixture() {
  return { schema: 'pe-local-controlled-recovery-v1', verifierId: 'local-original-process-and-provider-v1',
    auditRef: 'synthetic-recovery-audit', verifiedAt: new Date(now).toISOString(), oldInstanceId: 'old-instance',
    databaseRole: 'synthetic-control', writersVerifiedAt: new Date(now - 1).toISOString(),
    oldProcess: { pid: 3456, startTicks: '7890', bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pidNamespace: 'pid:[1234]' },
    processEvidenceRef: 'sha256:synthetic-process-proof', writersEvidenceRef: 'sha256:synthetic-writer-proof',
    accounts: [{ accountId: 'account-a', epoch: '20', allocations: [{
      intent: { allocationId: 'original-allocation', accountId: 'account-a', sessionId: 'original-session',
        workspaceId: 'original-workspace', epoch: '20', environmentVersion: 'original-environment', provider: 'original-provider',
        projectMountVersion: 'original-mount', requestedAt: new Date(now - 1000).toISOString(), createDeadlineAt: new Date(now - 500).toISOString() },
      sandboxId: 'accepted-original-sandbox', acceptedCreateEvidenceRef: 'sha256:synthetic-accepted-create',
      physicalStopEvidenceRef: 'sha256:synthetic-physical-stop', lateStartsRevokedEvidenceRef: 'sha256:synthetic-late-start-revocation',
    }] }] }
}
function absent(identity: RecoveryProcessIdentity) {
  return { bootId: identity.bootId, pidNamespace: identity.pidNamespace, original: 'absent' as const }
}
function row(): SandboxAllocation {
  const facts = parseRecoveryWitness(fixture(), limits), item = facts.accounts[0]?.allocations[0]
  if (item === undefined) throw new Error('Synthetic original allocation missing')
  return { ...item.intent, state: 'creating', sandboxId: null, lastActivityAt: item.intent.requestedAt,
    lastCheckedAt: item.intent.requestedAt, runtimeIdentity: null, executionProtocolVersion: null,
    executionCapabilities: [], failureCode: null }
}
function witness(value = fixture(), observe = absent, clock = now) {
  return new RootRecoveryWitness({ value: () => value, assertCurrent() {} }, limits, observe, () => clock)
}

describe('selected local recovery witness', () => {
  it('binds creating/null sandbox metadata to the independently witnessed accepted original creation', () => {
    const verified = witness().verifyAllocation(row())
    expect(verified.sandboxId).toBe('accepted-original-sandbox')
    expect(verified.acceptedCreateEvidenceRef).toBe('sha256:synthetic-accepted-create')
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.intent)).toBe(true)
  })

  it('rejects a still-live exact old process before any recovery work', () => {
    expect(() => new RootRecoveryWitness({ value: fixture, assertCurrent() {} }, limits,
      identity => ({ ...absent(identity), original: 'alive' }), () => now)).toThrow(/Trusted recovery evidence/)
  })

  it('rejects an absent PID observed in a different boot or PID namespace', () => {
    for (const replace of [{ bootId: 'another-boot' }, { pidNamespace: 'pid:[5678]' }]) {
      expect(() => new RootRecoveryWitness({ value: fixture, assertCurrent() {} }, limits,
        identity => ({ ...absent(identity), ...replace }), () => now)).toThrow(/Trusted recovery evidence/)
    }
  })

  it('requires current publication and a nonfuture, unexpired verifier receipt', () => {
    const value = fixture()
    expect(() => witness(value, absent, now - 1)).toThrow(/Trusted recovery evidence/)
    expect(() => witness(value, absent, now + limits.maxAgeMs + 1)).toThrow(/Trusted recovery evidence/)
    let current = true
    const selected = new RootRecoveryWitness({ value: () => value, assertCurrent() { if (!current) throw new Error('Publication revoked') } },
      limits, absent, () => now)
    current = false
    expect(() => selected.verifyAllocation(row())).toThrow('Publication revoked')
  })

  it('cannot use a physical-stop reference without accepted-create and permanent-late-start evidence', () => {
    for (const key of ['acceptedCreateEvidenceRef', 'physicalStopEvidenceRef', 'lateStartsRevokedEvidenceRef'] as const) {
      const value = fixture(), item = value.accounts[0]?.allocations[0]
      if (item === undefined) throw new Error('Synthetic witness missing')
      item[key] = ''
      expect(() => witness(value)).toThrow(/Trusted recovery evidence/)
    }
  })

  it('rejects a different immutable intent or nonnull sandbox selection', () => {
    const selected = witness(), original = row()
    for (const changed of [{ environmentVersion: 'different-environment' }, { projectMountVersion: 'different-mount' },
      { sandboxId: 'different-sandbox' }, { epoch: '21' as SandboxAllocation['epoch'] }]) {
      expect(() => selected.verifyAllocation({ ...original, ...changed })).toThrow(/Trusted recovery evidence/)
    }
  })

  it('rejects duplicate allocation coverage and an allocation belonging to a different account', () => {
    const duplicate = fixture(), account = duplicate.accounts[0], item = account?.allocations[0]
    if (item === undefined || account === undefined) throw new Error('Synthetic witness missing')
    account.allocations.push(structuredClone(item))
    expect(() => witness(duplicate)).toThrow(/Trusted recovery evidence/)
    const wrong = fixture(), wrongItem = wrong.accounts[0]?.allocations[0]
    if (wrongItem === undefined) throw new Error('Synthetic witness missing')
    wrongItem.intent.accountId = 'account-b'
    expect(() => witness(wrong)).toThrow(/Trusted recovery evidence/)
  })

  it('enforces complete receipt byte/account/allocation limits before retaining facts', () => {
    expect(() => parseRecoveryWitness(fixture(), { ...limits, maxBytes: 64 })).toThrow(/Trusted recovery evidence/)
    const value = fixture(), second = structuredClone(value.accounts[0])
    if (second === undefined) throw new Error('Synthetic account missing')
    second.accountId = 'account-b'; second.allocations = []
    value.accounts.push(second)
    expect(() => parseRecoveryWitness(value, { ...limits, maxAccounts: 1 })).toThrow(/Trusted recovery evidence/)
    expect(() => parseRecoveryWitness(undefined, limits)).toThrow(/Trusted recovery evidence/)
    expect(() => parseRecoveryWitness({ ...fixture(), verifierId: 'browser-boolean' }, limits)).toThrow(/Trusted recovery evidence/)
  })
})
