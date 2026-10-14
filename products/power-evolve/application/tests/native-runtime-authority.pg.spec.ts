/** Actual PG verifies independent process audiences, generation takeover and owner-filtered claims. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { requestId } from '../src/contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('runtime credentials remain separate from browser credentials and bind their account, instance and generation', () => cloudFixture(async ({ pool, alice, bob, identities }) => {
  const authority = new NativeRuntimeAuthority(pool)
  const a = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const b = await authority.issue({ userId: bob.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  expect(await authority.authenticate(a.token)).toMatchObject({ userId: alice.user.userId, runtimeId: a.runtimeId, generation: 1 })
  await expect(authority.authenticate(alice.token)).rejects.toMatchObject({ status: 401 })
  await expect(identities.authenticate(a.token)).rejects.toMatchObject({ status: 401 })
  await expect(authority.authenticate(a.token, { userId: bob.user.userId, runtimeId: a.runtimeId })).rejects.toMatchObject({ status: 401 })
  const replacement = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 2, lifetimeMs: 60_000 })
  await expect(authority.authenticate(a.token)).rejects.toMatchObject({ status: 401 })
  expect(await new NativeRuntimeAuthority(pool).authenticate(replacement.token)).toMatchObject({ generation: 2 })
  expect(await authority.authenticate(b.token)).toMatchObject({ userId: bob.user.userId })
  await authority.revoke(replacement.credentialId)
  await expect(authority.authenticate(replacement.token)).rejects.toMatchObject({ status: 401 })
}))

test('owned claims cannot lease another account even when it has older queued work', () => cloudFixture(async ({ pool, alice, bob }) => {
  const authority = new NativeRuntimeAuthority(pool), tasks = new TaskStore(pool, limits)
  const foreign = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
  await tasks.accept(bob.user, foreign.sessionId, requestId.parse(randomUUID()), 'foreign first', bob.token)
  const own = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await tasks.accept(alice.user, own.sessionId, requestId.parse(randomUUID()), 'own second', alice.token)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const owner = { userId: issued.userId, authenticate: async (client: Parameters<NativeRuntimeAuthority['authenticateInTransaction']>[0]) => {
    await authority.authenticateInTransaction(client, issued.token, { userId: issued.userId, runtimeId: issued.runtimeId })
  } }
  const claimed = await tasks.claim(issued.runtimeId, owner)
  expect(claimed).toMatchObject({ sessionId: own.sessionId, userId: alice.user.userId })
  expect(await tasks.claim(issued.runtimeId, owner)).toBeNull()
  const rows = await pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE session_id=$1', [foreign.sessionId])
  expect(rows.rows).toEqual([{ state: 'queued' }])
  await authority.revoke(issued.credentialId)
  await expect(tasks.claim(issued.runtimeId, owner)).rejects.toMatchObject({ status: 401 })
}))
