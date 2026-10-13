/** Real PostgreSQL writer occupancy, exact retries and post-lock clock fencing. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { ACCOUNT_ERROR_CODES } from '../src/account-contracts.ts'
import { requestId } from '../src/contracts.ts'
import { nativeWriterAcquire, nativeWriterEpoch, nativeWriterIdentity, nativeWriterLease, nativeWriterReleased,
  nativeWriterToken, nativeWriterWorkerId, type NativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { digest } from '../src/platform/identity.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const writerLimits = { leaseMs: 20_000 }
const token = () => randomBytes(32).toString('base64url')

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned writer fixture returned no row')
  return row
}

async function prepare(f: Fixture) {
  // Before Root registers schema4, diagnostic runs explicitly install the proposed SQL only in this owned database.
  const ddlFile = process.env.PE_WRITER_TEST_DDL_FILE
  if (ddlFile) {
    const present = first((await f.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.pe_native_writers') IS NOT NULL AS present")).rows).present
    if (present) throw new Error('Diagnostic writer SQL cannot overlay an initialized table')
    await f.pool.query(await readFile(ddlFile, 'utf8'))
  }
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'owned writer', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID())
  const grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Owned writer operation was not claimed')
  const writer = new NativeSessionWriter(tasks, writerLimits)
  const request = nativeWriterAcquire.parse({ sessionId: created.sessionId, workerId, token: token() })
  return { tasks, created, grant, writer, request }
}

async function writerCase(run: (f: Fixture, n: Prepared) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => { await run(f, await prepare(f)) })
}

async function acquire(n: Prepared): Promise<NativeWriterIdentity> {
  const lease = await n.writer.acquire(n.grant.token, n.request)
  return nativeWriterIdentity.parse({ ...n.request, epoch: lease.epoch })
}

async function state(f: Fixture, sessionId: string) {
  const writer = await f.pool.query<Record<string, unknown>>(`SELECT session_id,worker_id,epoch,token_digest,expires_at FROM pe_native_writers
    WHERE session_id=$1`, [sessionId])
  const session = await f.pool.query<Record<string, unknown>>(
    'SELECT event_count,lease_epoch,grant_digest,lease_until FROM pe_sessions WHERE id=$1', [sessionId])
  return { writer: writer.rows, session: session.rows }
}

async function waitBlocked(f: Fixture, fragment: string): Promise<void> {
  await expect.poll(async () => first((await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
    WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS blocked`, [`%${fragment}%`])).rows).blocked,
  { timeout: 2000, interval: 20 }).toBe(true)
}

async function clockExpired(client: PoolClient, table: 'pe_sessions' | 'pe_native_writers', id: string): Promise<void> {
  const key = table === 'pe_sessions' ? 'id' : 'session_id'
  const expiry = table === 'pe_sessions' ? 'lease_until' : 'expires_at'
  await expect.poll(async () => first((await client.query<{ expired: boolean }>(
    `SELECT ${expiry}<=clock_timestamp() AS expired FROM ${table} WHERE ${key}=$1`, [id])).rows).expired,
  { timeout: 2000, interval: 20 }).toBe(true)
}

async function whileLocked(f: Fixture, hold: (client: PoolClient) => Promise<unknown>, action: () => Promise<unknown>,
  fragment: string, beforeUnlock: (client: PoolClient) => Promise<unknown>, commit = true) {
  const lock = await f.pool.connect()
  let pending: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await hold(lock)
    pending = action()
    const settled = pending.then(result => ({ ok: true, result }), (error: unknown) => ({ ok: false, result: error }))
    await waitBlocked(f, fragment)
    await beforeUnlock(lock)
    await lock.query(commit ? 'COMMIT' : 'ROLLBACK')
    return await settled
  } finally {
    await lock.query('ROLLBACK')
    await pending?.catch((_failure: unknown) => undefined)
    lock.release()
  }
}

test('wire records reject noncanonical tokens and extra fields and preserve exact branded writer identity', () => {
  const worker = randomUUID(), sessionId = randomUUID(), secret = token()
  expect(nativeWriterToken.parse(secret)).toBe(secret)
  expect(nativeWriterWorkerId.parse(worker.toUpperCase())).toBe(worker)
  const body = { sessionId, workerId: worker, token: secret }
  expect(nativeWriterAcquire.parse(body)).toEqual(body)
  const identity = { ...body, epoch: 1 }
  expect(nativeWriterIdentity.parse(identity)).toEqual(identity)
  expect(nativeWriterLease.parse({ sessionId, workerId: worker, epoch: 1, expiresAt: 0 })).toEqual({
    sessionId, workerId: worker, epoch: 1, expiresAt: 0 })
  expect(nativeWriterReleased.parse({ sessionId, workerId: worker, epoch: 1, released: true }).released).toBe(true)
  for (const invalid of ['', secret.slice(1), secret + '=', secret + 'A', 'A'.repeat(42) + 'B', '/'.repeat(43), '+'.repeat(43)]) {
    expect(nativeWriterToken.safeParse(invalid).success).toBe(false)
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(nativeWriterEpoch.safeParse(invalid).success).toBe(false)
  }
  expect(nativeWriterEpoch.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  expect(nativeWriterAcquire.safeParse({ ...body, epoch: 1 }).success).toBe(false)
  expect(nativeWriterIdentity.safeParse({ ...identity, execution: true }).success).toBe(false)
  expect(nativeWriterLease.safeParse({ ...identity, expiresAt: 1 }).success).toBe(false)
})

test('first acquisition stores only a digest and leaves operation grant and native history untouched', () => writerCase(async (f, n) => {
  const before = await state(f, n.created.sessionId)
  const lease = await n.writer.acquire(n.grant.token, n.request)
  expect(lease).toMatchObject({ sessionId: n.created.sessionId, workerId: n.request.workerId, epoch: 1 })
  expect(lease).not.toHaveProperty('token')
  const after = await state(f, n.created.sessionId)
  expect(after.session).toEqual(before.session)
  expect(after.writer).toHaveLength(1)
  expect(first(after.writer)).toMatchObject({ worker_id: n.request.workerId, epoch: '1', token_digest: digest(n.request.token) })
  const clock = first((await f.pool.query<{ live: boolean; bounded: boolean }>(`SELECT expires_at>clock_timestamp() AS live,
    expires_at<=clock_timestamp()+interval '20 seconds' AS bounded FROM pe_native_writers WHERE session_id=$1`, [n.created.sessionId])).rows)
  expect(clock).toEqual({ live: true, bounded: true })
}))

test('same exact acquire response can be recovered without regenerating a token or extending expiry', () => writerCase(async (f, n) => {
  const firstLease = await n.writer.acquire(n.grant.token, n.request)
  const before = await state(f, n.created.sessionId)
  expect(await n.writer.acquire(n.grant.token, n.request)).toEqual(firstLease)
  expect(await state(f, n.created.sessionId)).toEqual(before)
}))

test('concurrent exact acquire retries commit one epoch and one reconstructable receipt', () => writerCase(async (f, n) => {
  const other = new NativeSessionWriter(new TaskStore(f.pool, taskLimits), writerLimits)
  const results = await Promise.all([n.writer.acquire(n.grant.token, n.request), other.acquire(n.grant.token, n.request)])
  expect(results[0]).toEqual(results[1])
  expect(first((await state(f, n.created.sessionId)).writer).epoch).toBe('1')
}))

test('concurrent different tokens on two service instances admit one writer and reject the competing identity', () => writerCase(async (f, n) => {
  const other = new NativeSessionWriter(new TaskStore(f.pool, taskLimits), writerLimits)
  const requests = [n.request, nativeWriterAcquire.parse({ ...n.request, token: token() })]
  const results = await Promise.allSettled([n.writer.acquire(n.grant.token, first(requests)), other.acquire(n.grant.token, requests[1])])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  const failure = results.find(r => r.status === 'rejected')
  expect(failure).toMatchObject({ reason: { status: 409, code: 'native_writer_busy' } })
  const row = first((await state(f, n.created.sessionId)).writer)
  expect(row.epoch).toBe('1')
  expect(requests.map(r => digest(r.token))).toContain(row.token_digest)
}))

test('an unexpired different worker cannot be replaced by the currently authorized operation worker', () => writerCase(async (f, n) => {
  const priorWorker = randomUUID(), priorToken = token()
  await f.pool.query('INSERT INTO pe_native_writers VALUES($1,$2,7,$3,clock_timestamp()+interval \'20 seconds\')',
    [n.created.sessionId, priorWorker, digest(priorToken)])
  const before = await state(f, n.created.sessionId)
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ status: 409, code: 'native_writer_busy' })
  expect(await state(f, n.created.sessionId)).toEqual(before)
}))

test('worker and Session identity cannot be chosen independently of the operation grant', () => writerCase(async (f, n) => {
  for (const body of [{ ...n.request, workerId: randomUUID() }, { ...n.request, sessionId: randomUUID() }]) {
    await expect(n.writer.acquire(n.grant.token, body)).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  }
  await f.pool.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND epoch=$2',
    [n.grant.operationId, n.grant.epoch])
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  expect((await state(f, n.created.sessionId)).writer).toEqual([])
}))

test('the current digest cannot be rebound to a different worker after its expiry', () => writerCase(async (f, n) => {
  await f.pool.query('INSERT INTO pe_native_writers VALUES($1,$2,7,$3,clock_timestamp()-interval \'1 second\')',
    [n.created.sessionId, randomUUID(), digest(n.request.token)])
  const before = await state(f, n.created.sessionId)
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ status: 409, code: 'native_writer_lost' })
  expect(await state(f, n.created.sessionId)).toEqual(before)
}))

test('invalid requests and deployment durations fail without changing PostgreSQL writer state', () => writerCase(async (f, n) => {
  for (const input of [null, { ...n.request, token: 'A'.repeat(42) + 'B' }, { ...n.request, extra: true }]) {
    await expect(n.writer.acquire(n.grant.token, input)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(n.writer.renew(input)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(n.writer.release(input)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  }
  for (const leaseMs of [0, -1, 1.1, NaN, Infinity, 300_001]) expect(() => new NativeSessionWriter(n.tasks, { leaseMs })).toThrow()
  expect(() => new NativeSessionWriter(n.tasks, { leaseMs: 1 })).not.toThrow()
  expect(() => new NativeSessionWriter(n.tasks, { leaseMs: 300_000 })).not.toThrow()
  expect((await state(f, n.created.sessionId)).writer).toEqual([])
}))

test('unknown operation grants do not create writer rows', () => writerCase(async (f, n) => {
  await expect(n.writer.acquire(token(), n.request)).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  expect((await state(f, n.created.sessionId)).writer).toEqual([])
}))

test('expiry requires a fresh token and advances writer epoch without changing the operation epoch', () => writerCase(async (f, n) => {
  const old = await acquire(n)
  await f.pool.query('UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval \'1 second\' WHERE session_id=$1', [old.sessionId])
  const before = await state(f, old.sessionId)
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ status: 409, code: 'native_writer_lost' })
  await expect(n.writer.renew(old)).rejects.toMatchObject({ status: 409, code: 'native_writer_lost' })
  await expect(n.writer.release(old)).rejects.toMatchObject({ status: 409, code: 'native_writer_lost' })
  expect(await state(f, old.sessionId)).toEqual(before)
  const next = { ...n.request, token: token() }
  expect(await n.writer.acquire(n.grant.token, next)).toMatchObject({ epoch: 2 })
  expect((await state(f, old.sessionId)).session).toEqual(before.session)
  await expect(n.writer.renew(old)).rejects.toMatchObject({ code: 'native_writer_lost' })
  await expect(n.writer.release(old)).rejects.toMatchObject({ code: 'native_writer_lost' })
}))

test('exact release retains a tombstone and repeats only until the next acquisition', () => writerCase(async (f, n) => {
  const old = await acquire(n), before = await state(f, n.created.sessionId)
  const receipt = await n.writer.release(old)
  expect(receipt).toEqual({ sessionId: old.sessionId, workerId: old.workerId, epoch: 1, released: true })
  const released = await state(f, old.sessionId)
  expect(first(released.writer)).toMatchObject({ epoch: '1', worker_id: old.workerId, token_digest: digest(old.token), expires_at: null })
  expect(released.session).toEqual(before.session)
  expect(await n.writer.release(old)).toEqual(receipt)
  expect(await state(f, old.sessionId)).toEqual(released)
  await expect(n.writer.renew(old)).rejects.toMatchObject({ code: 'native_writer_lost' })
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ code: 'native_writer_lost' })
  const next = await n.writer.acquire(n.grant.token, { ...n.request, token: token() })
  expect(next.epoch).toBe(2)
  const replaced = await state(f, old.sessionId)
  await expect(n.writer.release(old)).rejects.toMatchObject({ code: 'native_writer_lost' })
  expect(await state(f, old.sessionId)).toEqual(replaced)
}))

test('concurrent exact releases both succeed and cannot reset the persistent epoch', () => writerCase(async (f, n) => {
  const owned = await acquire(n), other = new NativeSessionWriter(n.tasks, writerLimits)
  const results = await Promise.all([n.writer.release(owned), other.release(owned)])
  expect(results[0]).toEqual(results[1])
  expect(first((await state(f, owned.sessionId)).writer)).toMatchObject({ epoch: '1', expires_at: null })
}))

test('writer maintenance survives genuine operation settlement while preserving the completed operation and native events', () => writerCase(async (f, n) => {
  const owned = await acquire(n)
  await n.tasks.finish(n.grant.token, 'completed', null)
  const before = await state(f, owned.sessionId)
  await f.pool.query('UPDATE pe_native_writers SET expires_at=clock_timestamp()+interval \'5 seconds\' WHERE session_id=$1', [owned.sessionId])
  const lease = await n.writer.renew(owned)
  expect(lease.epoch).toBe(owned.epoch)
  const clock = first((await f.pool.query<{ remaining: number }>(
    'SELECT extract(epoch FROM expires_at-clock_timestamp())::double precision AS remaining FROM pe_native_writers WHERE session_id=$1',
    [owned.sessionId])).rows)
  expect(clock.remaining).toBeGreaterThan(18)
  expect((await state(f, owned.sessionId)).session).toEqual(before.session)
  expect(first((await f.pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE id=$1', [n.grant.operationId])).rows).state)
    .toBe('completed')
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ code: 'lease_lost' })
  expect(await n.writer.release(owned)).toMatchObject({ released: true })
}))

test('browser credential revocation does not turn writer occupancy into browser or execution authority', () => writerCase(async (f, n) => {
  const owned = await acquire(n)
  await f.identities.logout(f.alice.token)
  await expect(f.identities.authenticate(f.alice.token)).rejects.toMatchObject({ status: 401 })
  expect(await n.writer.renew(owned)).toMatchObject({ epoch: 1 })
  expect(await n.writer.release(owned)).toMatchObject({ released: true })
}))

for (const method of ['renew', 'release'] as const) {
  test(`${method} rejects wrong session, worker, epoch and token without changing the current writer`, () => writerCase(async (f, n) => {
    const owned = await acquire(n), before = await state(f, owned.sessionId)
    for (const wrong of [{ ...owned, sessionId: randomUUID() }, { ...owned, workerId: randomUUID() },
      { ...owned, epoch: 2 }, { ...owned, token: token() }]) {
      await expect(n.writer[method](wrong)).rejects.toMatchObject({ status: 409, code: 'native_writer_lost' })
    }
    expect(await state(f, owned.sessionId)).toEqual(before)
  }))
  for (const status of ['disabled', 'deleted'] as const) {
    test(`${method} rejects a currently ${status} account even for the exact writer bearer`, () => writerCase(async (f, n) => {
      const owned = await acquire(n)
      await f.pool.query(status === 'disabled' ? 'UPDATE pe_users SET enabled=false WHERE id=$1'
        : 'UPDATE pe_users SET enabled=false,deleted_at=clock_timestamp() WHERE id=$1', [f.alice.user.userId])
      const before = await state(f, owned.sessionId)
      await expect(n.writer[method](owned)).rejects.toMatchObject({ status: 401, code: ACCOUNT_ERROR_CODES[status] })
      expect(await state(f, owned.sessionId)).toEqual(before)
    }))
  }
  for (const target of ['account', 'Session', 'writer', 'writer update'] as const) {
    test(`${method} checks the PG clock after a genuine ${target} lock wait`, () => writerCase(async (f, n) => {
      const owned = await acquire(n)
      await f.pool.query('UPDATE pe_native_writers SET expires_at=clock_timestamp()+interval \'1 second\' WHERE session_id=$1', [owned.sessionId])
      const before = await state(f, owned.sessionId)
      const hold = (client: PoolClient) => target === 'account'
        ? client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [f.alice.user.userId])
        : target === 'Session' ? client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE', [owned.sessionId])
          : target === 'writer' ? client.query('SELECT session_id FROM pe_native_writers WHERE session_id=$1 FOR UPDATE', [owned.sessionId])
            : client.query('LOCK TABLE pe_native_writers IN SHARE MODE')
      const marker = target === 'account' ? 'FROM pe_users' : target === 'Session' ? 'SELECT id FROM pe_sessions'
        : target === 'writer' ? 'epoch::double precision AS epoch' : 'UPDATE pe_native_writers'
      const result = await whileLocked(f, hold, () => n.writer[method](owned), marker,
        client => clockExpired(client, 'pe_native_writers', owned.sessionId))
      expect(result).toMatchObject({ ok: false, result: { status: 409, code: 'native_writer_lost' } })
      expect(await state(f, owned.sessionId)).toEqual(before)
    }))
  }
}

for (const method of ['acquire', 'renew', 'release'] as const) {
  test(`${method} denies account disable committed during the account lock wait`, () => writerCase(async (f, n) => {
    const owned = method === 'acquire' ? undefined : await acquire(n)
    const before = await state(f, n.created.sessionId)
    const result = await whileLocked(f, client => client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [f.alice.user.userId]),
      () => method === 'acquire' ? n.writer.acquire(n.grant.token, n.request) : n.writer[method](owned), 'FROM pe_users',
      client => client.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId]))
    expect(result).toMatchObject({ ok: false, result: { status: 401, code: ACCOUNT_ERROR_CODES.disabled } })
    expect(await state(f, n.created.sessionId)).toEqual(before)
  }))
}

for (const target of ['Session', 'writer', 'writer insert'] as const) {
  test(`acquire rechecks its operation grant after a genuine ${target} lock wait and rolls back any staged writer`, () => writerCase(async (f, n) => {
    if (target === 'writer') await f.pool.query('INSERT INTO pe_native_writers VALUES($1,$2,9,$3,clock_timestamp()-interval \'1 second\')',
      [n.created.sessionId, randomUUID(), digest(token())])
    await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()+interval \'1 second\' WHERE id=$1', [n.created.sessionId])
    const before = await state(f, n.created.sessionId)
    const hold = (client: PoolClient) => target === 'Session'
      ? client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE', [n.created.sessionId])
      : target === 'writer' ? client.query('SELECT session_id FROM pe_native_writers WHERE session_id=$1 FOR UPDATE', [n.created.sessionId])
        : client.query('LOCK TABLE pe_native_writers IN SHARE MODE')
    const marker = target === 'Session' ? 'FROM pe_sessions s JOIN pe_operations' : target === 'writer'
      ? 'epoch::double precision AS epoch' : 'INSERT INTO pe_native_writers'
    const result = await whileLocked(f, hold, () => n.writer.acquire(n.grant.token, n.request), marker,
      client => clockExpired(client, 'pe_sessions', n.created.sessionId))
    expect(result).toMatchObject({ ok: false, result: { status: 409, code: 'lease_lost' } })
    expect(await state(f, n.created.sessionId)).toEqual(before)
  }))
}

test('expired different owner is replaced with a greater writer epoch and old maintenance cannot affect the new owner', () => writerCase(async (f, n) => {
  const previous = nativeWriterIdentity.parse({ ...n.request, workerId: randomUUID(), token: token(), epoch: 17 })
  await f.pool.query('INSERT INTO pe_native_writers VALUES($1,$2,$3,$4,clock_timestamp()-interval \'1 second\')',
    [previous.sessionId, previous.workerId, previous.epoch, digest(previous.token)])
  expect(await n.writer.acquire(n.grant.token, n.request)).toMatchObject({ workerId: n.request.workerId, epoch: 18 })
  const before = await state(f, previous.sessionId)
  await expect(n.writer.renew(previous)).rejects.toMatchObject({ code: 'native_writer_lost' })
  await expect(n.writer.release(previous)).rejects.toMatchObject({ code: 'native_writer_lost' })
  expect(await state(f, previous.sessionId)).toEqual(before)
}))

test('epoch exhaustion refuses acquisition without resetting the persisted tombstone', () => writerCase(async (f, n) => {
  await f.pool.query('INSERT INTO pe_native_writers VALUES($1,$2,$3,$4,NULL)',
    [n.created.sessionId, randomUUID(), Number.MAX_SAFE_INTEGER, digest(token())])
  const before = await state(f, n.created.sessionId)
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ status: 503, code: 'native_writer_epoch' })
  expect(await state(f, n.created.sessionId)).toEqual(before)
}))

test('a token digest already bound to another Session is rejected without altering either writer', () => writerCase(async (f, n) => {
  const other = await n.tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
  await f.pool.query('INSERT INTO pe_native_writers VALUES($1,$2,1,$3,clock_timestamp()+interval \'20 seconds\')',
    [other.sessionId, randomUUID(), digest(n.request.token)])
  const before = await state(f, other.sessionId)
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ status: 409, code: 'native_writer_token_conflict' })
  expect(await state(f, other.sessionId)).toEqual(before)
  expect((await state(f, n.created.sessionId)).writer).toEqual([])
}))

test('a uniqueness wait ending after grant expiry rolls back the eventual successful insert', () => writerCase(async (f, n) => {
  const other = await n.tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()+interval \'1 second\' WHERE id=$1', [n.created.sessionId])
  const before = await state(f, n.created.sessionId)
  const result = await whileLocked(f, client => client.query('INSERT INTO pe_native_writers VALUES($1,$2,1,$3,clock_timestamp()+interval \'20 seconds\')',
    [other.sessionId, randomUUID(), digest(n.request.token)]), () => n.writer.acquire(n.grant.token, n.request), 'INSERT INTO pe_native_writers',
  client => clockExpired(client, 'pe_sessions', n.created.sessionId), false)
  expect(result).toMatchObject({ ok: false, result: { code: 'lease_lost' } })
  expect(await state(f, n.created.sessionId)).toEqual(before)
  expect((await state(f, other.sessionId)).writer).toEqual([])
}))

test('unrelated PostgreSQL write failures remain failures and roll back occupancy', () => writerCase(async (f, n) => {
  await f.pool.query('ALTER TABLE pe_native_writers ADD CONSTRAINT owned_failure CHECK (epoch>10)')
  await expect(n.writer.acquire(n.grant.token, n.request)).rejects.toMatchObject({ code: '23514' })
  expect((await state(f, n.created.sessionId)).writer).toEqual([])
}))

test('Session deletion during the account lock wait invalidates an otherwise exact writer identity', () => writerCase(async (f, n) => {
  const owned = await acquire(n)
  const result = await whileLocked(f, client => client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [f.alice.user.userId]),
    () => n.writer.renew(owned), 'FROM pe_users', async (client) => {
      await client.query('DELETE FROM pe_attempts WHERE operation_id=$1', [n.grant.operationId])
      await client.query('DELETE FROM pe_operations WHERE session_id=$1', [owned.sessionId])
      await client.query('DELETE FROM pe_native_prompt_inputs WHERE session_id=$1', [owned.sessionId])
      await client.query('DELETE FROM pe_events WHERE session_id=$1', [owned.sessionId])
      await client.query('DELETE FROM pe_sessions WHERE id=$1', [owned.sessionId])
    })
  expect(result).toMatchObject({ ok: false, result: { code: 'native_writer_lost' } })
  expect(await state(f, owned.sessionId)).toEqual({ writer: [], session: [] })
}))

for (const change of ['delete', 'epoch', 'worker', 'digest'] as const) {
  test(`writer ${change} committed during its row lock wait cannot pass an earlier identity hint`, () => writerCase(async (f, n) => {
    const owned = await acquire(n)
    const sql = change === 'delete' ? 'DELETE FROM pe_native_writers WHERE session_id=$1'
      : change === 'epoch' ? 'UPDATE pe_native_writers SET epoch=epoch+1 WHERE session_id=$1'
        : change === 'worker' ? 'UPDATE pe_native_writers SET worker_id=$2 WHERE session_id=$1'
          : 'UPDATE pe_native_writers SET token_digest=$2 WHERE session_id=$1'
    const args = change === 'worker' ? [owned.sessionId, randomUUID()] : change === 'digest'
      ? [owned.sessionId, digest(token())] : [owned.sessionId]
    const result = await whileLocked(f, client => client.query('SELECT session_id FROM pe_native_writers WHERE session_id=$1 FOR UPDATE',
      [owned.sessionId]), () => n.writer.renew(owned), 'epoch::double precision AS epoch', client => client.query(sql, args))
    expect(result).toMatchObject({ ok: false, result: { code: 'native_writer_lost' } })
    const rows = (await state(f, owned.sessionId)).writer
    if (change === 'delete') expect(rows).toEqual([])
    else expect(first(rows).epoch).toBe(change === 'epoch' ? '2' : '1')
  }))
}
