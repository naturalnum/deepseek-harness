/** Driver-result tests only; these do not execute PostgreSQL locks, allocation predicates or physical verifiers. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { OwnerPgNotSubmittedError } from '../src/owner-pg-errors.ts'
import { claimOwnerSql, inspectRecoverySql, recoverReleasedSql, closeRecoveredInstanceSql, inspectRecoveredInstanceSql } from '../src/owner-sql.ts'
import type { OwnerPgExecutor, OwnerRecoveryAuthority, OwnerRecoveryExpectation, OwnerRecoveryProof, RecoveryAuditRef } from '../src/owner-types.ts'
import { account, epoch, instance, limits, row } from './owner-fixture.ts'

const replacement = brandString<typeof instance>('replacement-instance')
const expected: OwnerRecoveryExpectation = Object.freeze({ accountId: account, oldInstanceId: instance, epoch,
  auditRef: brandString<RecoveryAuditRef>('recovery-audit-one') })
const recoveryLimits = { maxAllocations: 4, maxEvidenceRefs: 4, maxReferenceBytes: 256,
  maxProofBytes: 8192, maxAuditRows: 8, maxProofAgeMs: 30_000 }

function proof(): OwnerRecoveryProof {
  const at = new Date(Date.now() - 10).toISOString()
  return { ...expected, verifierId: 'local-original-process-and-provider-v1', verifiedAt: at, writersVerifiedAt: at, databaseRole: 'recovery_fixture_role',
    oldProcessEvidenceRef: 'protected:process-dead', writerLossEvidenceRef: 'protected:old-writers-ended',
    lateCreateFenceEvidenceRef: 'protected:create-permanently-disabled', lateSpawnFenceEvidenceRef: 'protected:spawn-permanently-disabled',
    evidenceRefs: ['protected:root-publication'], allocations: [{ allocationId: 'allocation-one', evidenceRefs: ['protected:destroyed'] }] }
}

function rawOwner(phase: 'quarantined' | 'unowned' | 'mounting', value = epoch): unknown {
  return Reflect.get(row(phase, value) as object, 'owner')
}

async function fixture(change: (value: OwnerRecoveryProof) => unknown = value => value) {
  let audit: unknown = null, current = rawOwner('quarantined'), calls = 0, writes = 0, mode = 'success'
  let instanceClosed = false, retained = false, closeWrites = 0
  const queries: string[] = []
  const executor: OwnerPgExecutor = { query: async (sql, values) => {
    queries.push(sql)
    if (sql === inspectRecoverySql) return { rows: [{ recovery: audit, owner: current,
      matches: audit !== null && JSON.stringify(Reflect.get(audit as object, 'postimage')) === JSON.stringify(current) }] }
    if (sql === inspectRecoveredInstanceSql) return { rows: [{ audited: audit !== null, closed: instanceClosed, retained }] }
    if (sql === closeRecoveredInstanceSql) {
      closeWrites++
      if (mode === 'zero') return { rows: [] }
      if (mode === 'unknown-before') throw new Error('Synthetic closure reply loss')
      instanceClosed = true
      if (mode === 'unknown-after') throw new Error('Synthetic closure reply loss after commit')
      return { rows: [{ closed_instance: instance }] }
    }
    if (sql === recoverReleasedSql) {
      writes++
      if (mode === 'not-submitted') throw new OwnerPgNotSubmittedError('cloud/capacity', 'Synthetic driver admission refused')
      if (mode === 'zero') return { rows: [] }
      if (mode === 'unknown-before') throw new Error('Synthetic transport loss before observing commit')
      const submitted: unknown = JSON.parse(values[4] ?? 'null')
      current = rawOwner('unowned')
      audit = { proof: submitted, postimage: current }
      if (mode === 'unknown-after') throw new Error('Synthetic reply loss after commit')
      if (mode === 'corrupt') return { rows: [{ recovery: { proof: submitted, postimage: {} } }] }
      return { rows: [{ recovery: audit }] }
    }
    if (sql === claimOwnerSql) {
      current = rawOwner('mounting', brandString<typeof epoch>('2'))
      return { rows: [{ owner: current }] }
    }
    return { rows: [] }
  } }
  const authority: OwnerRecoveryAuthority = { instanceId: replacement, verifierId: 'local-original-process-and-provider-v1', limits: recoveryLimits,
    verify: async (actual) => {
      expect(actual).toEqual(expected); expect(Object.isFrozen(actual)).toBe(true)
      calls++
      return change(proof()) as OwnerRecoveryProof
    } }
  const store = new PostgresOwnerStore(executor, { instanceId: replacement }, limits, authority)
  await store.migrate(); await store.migrateRecovery()
  return { store, queries, mode: (value: string) => { mode = value }, calls: () => calls, writes: () => writes,
    changeCurrent: () => { current = rawOwner('mounting', brandString<typeof epoch>('2')) },
    retainOtherOwner: () => { retained = true }, closeWrites: () => closeWrites }
}

it('requires a selected instance-owned allowed verifier and explicit audit migration', async () => {
  const executor: OwnerPgExecutor = { query: async () => ({ rows: [] }) }
  const store = new PostgresOwnerStore(executor, { instanceId: replacement }, limits)
  await store.migrate()
  expect(() => store.migrateRecovery()).toThrow('verifier')
  await expect(store.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const authority: OwnerRecoveryAuthority = { instanceId: instance, verifierId: 'local-original-process-and-provider-v1', limits: recoveryLimits,
    verify: async () => proof() }
  expect(() => new PostgresOwnerStore(executor, { instanceId: replacement }, limits, authority)).toThrow('evidence')
})

it('preserves the old epoch, skips successful duplicate verification/writes and increments only on ordinary next claim', async () => {
  const f = await fixture()
  const first = await f.store.recoverReleased(expected)
  expect(first.postimage).toMatchObject({ accountId: account, epoch: '1', phase: 'unowned', ownerInstanceId: null })
  expect(await f.store.recoverReleased(expected)).toEqual(first)
  expect(f.calls()).toBe(1); expect(f.writes()).toBe(1)
  await expect(f.store.inspectRecovery(expected)).resolves.toMatchObject({ matchesPostimage: true, responsibilityRetained: false })
  expect(await f.store.claim({ accountId: account, expectedEpoch: epoch, recipeVersion: 'next' }))
    .toMatchObject({ epoch: '2', phase: 'mounting' })
  const observation = await f.store.inspectRecovery(expected)
  expect(observation.audit?.postimage.epoch).toBe('1')
  expect(observation.current?.epoch).toBe('2')
  expect(observation.matchesPostimage).toBe(false)
  expect(await f.store.recoverReleased(expected)).toEqual(first)
  expect(f.calls()).toBe(1); expect(f.writes()).toBe(1)
})

const invalid: readonly [string, (value: OwnerRecoveryProof) => unknown][] = [
  ['missing proof', () => undefined], ['browser booleans', () => ({ oldProcessDead: true, allocationsStopped: true })],
  ['wrong account', value => ({ ...value, accountId: 'other' })], ['wrong old instance', value => ({ ...value, oldInstanceId: replacement })],
  ['wrong epoch', value => ({ ...value, epoch: '2' })], ['wrong audit', value => ({ ...value, auditRef: 'other' })],
  ['wrong verifier', value => ({ ...value, verifierId: 'unreviewed' })],
  ['stale verification', value => ({ ...value, verifiedAt: '2020-01-01T00:00:00.000Z', writersVerifiedAt: '2020-01-01T00:00:00.000Z' })],
  ['future writer cutoff', value => ({ ...value, writersVerifiedAt: new Date(Date.now() + 60_000).toISOString() })],
  ['missing writer proof', value => ({ ...value, writerLossEvidenceRef: '' })],
  ['missing database role', value => ({ ...value, databaseRole: '' })],
  ['missing late create fence', value => ({ ...value, lateCreateFenceEvidenceRef: false })],
  ['missing late spawn fence', value => ({ ...value, lateSpawnFenceEvidenceRef: '' })],
  ['missing allocation evidence', value => ({ ...value, allocations: [{ allocationId: 'allocation-one', evidenceRefs: [] }] })],
  ['duplicate allocation', value => ({ ...value, allocations: [...value.allocations, ...value.allocations] })],
  ['excess allocations', value => ({ ...value, allocations: Array.from({ length: 5 }, (_, index) => ({
    allocationId: String(index), evidenceRefs: ['protected:destroyed'] })) })],
]
it.each(invalid)('rejects %s before any recovery mutation', async (_label, change) => {
  const f = await fixture(change)
  await expect(f.store.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.writes()).toBe(0)
  expect((await f.store.inspectRecovery(expected)).responsibilityRetained).toBe(false)
})

it('treats a known zero-row SQL guard/CAS refusal as zero write rather than unknown (driver fixture)', async () => {
  const f = await fixture(); f.mode('zero')
  await expect(f.store.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(f.calls()).toBe(1); expect(f.writes()).toBe(1)
  expect((await f.store.inspectRecovery(expected)).responsibilityRetained).toBe(false)
})

it.each(['unknown-before', 'unknown-after', 'corrupt'])('retains %s responsibility and reconciles only by exact read-only audit/postimage', async (mode) => {
  const f = await fixture(); f.mode(mode)
  await expect(f.store.recoverReleased(expected)).rejects.toBeInstanceOf(Error)
  await expect(f.store.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
  const observation = await f.store.inspectRecovery(expected)
  expect(observation.responsibilityRetained).toBe(true)
  expect(observation.audit !== undefined).toBe(mode !== 'unknown-before')
  expect(observation.matchesPostimage).toBe(mode !== 'unknown-before')
  expect(f.calls()).toBe(1); expect(f.writes()).toBe(1)
  expect(() => f.store.claim({ accountId: account, expectedEpoch: epoch, recipeVersion: 'next' })).toThrow('unresolved')
})

it('clears only a proven not-submitted refusal and never automatically retries it', async () => {
  const f = await fixture(); f.mode('not-submitted')
  await expect(f.store.recoverReleased(expected)).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
  expect((await f.store.inspectRecovery(expected)).responsibilityRetained).toBe(false)
  expect(f.writes()).toBe(1)
  f.mode('success')
  await expect(f.store.recoverReleased(expected)).resolves.toMatchObject({ postimage: { phase: 'unowned' } })
  expect(f.writes()).toBe(2)
})

const closeExpected = Object.freeze({ ...expected, internalAddress: 'fixture-old:1234', recipeVersion: 'recipe-test' })

it('closes only the independently audited old instance and skips successful duplicate closure', async () => {
  const f = await fixture()
  await f.store.recoverReleased(expected)
  await expect(f.store.closeRecoveredInstance(closeExpected)).resolves.toEqual({
    instanceId: instance, auditRef: expected.auditRef, alreadyClosed: false })
  await expect(f.store.closeRecoveredInstance(closeExpected)).resolves.toMatchObject({ alreadyClosed: true })
  expect(f.closeWrites()).toBe(1)
  expect(f.calls()).toBe(2)
  expect(await f.store.inspectRecoveredInstance(closeExpected)).toMatchObject({
    closed: true, audited: true, retainedOwners: false, responsibilityRetained: false })
})

it('rejects instance closure with no exact audit or any other retained old account before verifier/write', async () => {
  const f = await fixture()
  await expect(f.store.closeRecoveredInstance(closeExpected)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.calls()).toBe(0)
  await f.store.recoverReleased(expected)
  f.retainOtherOwner()
  await expect(f.store.closeRecoveredInstance(closeExpected)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.closeWrites()).toBe(0)
  expect(f.calls()).toBe(1)
})

it('retains unknown instance-closure responsibility and offers exact read-only postimage reconciliation', async () => {
  const f = await fixture()
  await f.store.recoverReleased(expected)
  f.mode('unknown-after')
  await expect(f.store.closeRecoveredInstance(closeExpected)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(await f.store.inspectRecoveredInstance(closeExpected)).toMatchObject({ closed: true, responsibilityRetained: true })
  await expect(f.store.closeRecoveredInstance(closeExpected)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
  expect(f.closeWrites()).toBe(1)
})
