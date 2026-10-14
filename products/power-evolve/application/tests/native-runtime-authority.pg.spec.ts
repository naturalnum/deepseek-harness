/** Actual PG verifies independent process audiences, generation takeover and owner-filtered claims. */
import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
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
    await authority.authenticateInTransaction(client, issued.token, { userId: issued.userId, runtimeId: issued.runtimeId }, 'update')
  } }
  const claimed = await tasks.claim(issued.runtimeId, owner)
  expect(claimed).toMatchObject({ sessionId: own.sessionId, userId: alice.user.userId })
  expect(await tasks.claim(issued.runtimeId, owner)).toBeNull()
  const rows = await pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE session_id=$1', [foreign.sessionId])
  expect(rows.rows).toEqual([{ state: 'queued' }])
  await authority.revoke(issued.credentialId)
  await expect(tasks.claim(issued.runtimeId, owner)).rejects.toMatchObject({ status: 401 })
}))


test('two concurrent owned claims serialize account ownership and retain available work', () => cloudFixture(async ({ pool, alice }) => {
  const authority = new NativeRuntimeAuthority(pool), tasks = new TaskStore(pool, { ...limits, maxActivePerUser: 2 })
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const own = []
  for (const text of ['first', 'second']) {
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), text, alice.token)
    own.push(session.sessionId)
  }
  const admitted = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let entered = 0, authenticated = 0, secondPid = 0
  const owner = { userId: issued.userId, authenticate: async (client: Parameters<NativeRuntimeAuthority['authenticateInTransaction']>[0]) => {
    const position = ++entered
    if (position === 2) secondPid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
    await authority.authenticateInTransaction(client, issued.token, { userId: issued.userId, runtimeId: issued.runtimeId }, 'update')
    authenticated++
    if (position === 1) { admitted.resolve(undefined); await release.promise }
  } }
  const first = tasks.claim(issued.runtimeId, owner)
  await admitted.promise
  const second = tasks.claim(issued.runtimeId, owner)
  try {
    await vi.waitFor(async () => {
      expect(secondPid).toBeGreaterThan(0)
      const active = await pool.query<{ wait_event_type: string }>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [secondPid])
      expect(active.rows[0]?.wait_event_type).toBe('Lock')
      expect(authenticated).toBe(1)
    })
  } finally { release.resolve(undefined) }
  const results = await Promise.all([first, second])
  expect(results.map(value => value?.sessionId).sort()).toEqual(own.sort())
}))
