/** Real PostgreSQL transaction helpers; no continuation ledger, Host generation or Profile is exercised. */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, test } from 'vitest'
import { operationId, requestId, type Grant } from '../src/contracts.ts'
import { nativePromptContent } from '../src/native-attachment-contracts.ts'
import { nativeWriterAcquire, nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { transaction } from '../src/platform/database.ts'
import { NativeAttachments } from '../src/platform/native-attachments.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const writerLimits = { leaseMs: 20_000 }
const freshToken = () => randomBytes(32).toString('base64url')

function required(value: Grant | null): Grant {
  if (!value) throw new Error('Expected an owned accepted operation')
  return value
}

async function prepare(f: Fixture) {
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'original input', f.alice.token)
  const worker = nativeWriterWorkerId.parse(randomUUID()), grant = required(await tasks.claim(worker))
  const writer = new NativeSessionWriter(tasks, writerLimits)
  const acquire = nativeWriterAcquire.parse({ sessionId: session.sessionId, workerId: worker, token: freshToken() })
  const lease = await writer.acquire(grant.token, acquire)
  return { tasks, session, grant, writer, acquire, identity: nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch }) }
}

test('writer transaction authorization survives operation settlement without renewing either lease or changing history', () =>
  cloudFixture(async (f) => {
    const p = await prepare(f)
    await p.tasks.finish(p.grant.token, 'completed', null)
    const before = (await f.pool.query('SELECT * FROM pe_native_writers')).rows
    await transaction(f.pool, async (client) => {
      expect(await p.writer.requireInTransaction(client, p.identity)).toMatchObject({
        userId: f.alice.user.userId, sessionId: p.session.sessionId, workerId: p.identity.workerId, epoch: p.identity.epoch,
      })
      await p.writer.assertLiveInTransaction(client, p.identity)
    })
    expect((await f.pool.query('SELECT * FROM pe_native_writers')).rows).toEqual(before)
    expect((await f.pool.query('SELECT grant_digest,lease_until,event_count FROM pe_sessions WHERE id=$1',
      [p.session.sessionId])).rows).toEqual([{ grant_digest: null, lease_until: null, event_count: 0 }])
    await expect(transaction(f.pool, client => p.tasks.restoreGrantInTransaction(client,
      p.grant.operationId, p.grant.token, p.grant.epoch))).rejects.toMatchObject({ code: 'lease_lost' })
  }))

for (const field of ['worker', 'token', 'epoch'] as const) {
  test(`writer transaction authorization refuses a different valid ${field} identity`, () => cloudFixture(async (f) => {
    const p = await prepare(f)
    const identity = nativeWriterIdentity.parse({ ...p.identity,
      ...(field === 'worker' ? { workerId: randomUUID() } : field === 'token' ? { token: freshToken() } : { epoch: p.identity.epoch + 1 }),
    })
    await expect(transaction(f.pool, client => p.writer.requireInTransaction(client, identity)))
      .rejects.toMatchObject({ code: 'native_writer_lost' })
  }))
}

for (const replaced of [false, true]) {
  test(`writer transaction authorization refuses ${replaced ? 'a replaced identity' : 'a released tombstone'}`, () =>
    cloudFixture(async (f) => {
      const p = await prepare(f)
      await p.writer.release(p.identity)
      if (replaced) await p.writer.acquire(p.grant.token, { ...p.acquire, token: freshToken() })
      await expect(transaction(f.pool, client => p.writer.requireInTransaction(client, p.identity)))
        .rejects.toMatchObject({ code: 'native_writer_lost' })
    }))
}

test('writer final transaction check rejects PG expiry and rolls back preceding work in the same transaction', () =>
  cloudFixture(async (f) => {
    const p = await prepare(f)
    const before = (await f.pool.query('SELECT * FROM pe_native_writers')).rows
    await expect(transaction(f.pool, async (client) => {
      await p.writer.requireInTransaction(client, p.identity)
      // Diagnostic expiry makes the final clock check fail without changing the exact identity.
      await client.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
        [p.session.sessionId])
      await client.query("UPDATE pe_operations SET error_code='diagnostic_uncommitted' WHERE id=$1", [p.grant.operationId])
      await p.writer.assertLiveInTransaction(client, p.identity)
    })).rejects.toMatchObject({ code: 'native_writer_lost' })
    expect((await f.pool.query('SELECT * FROM pe_native_writers')).rows).toEqual(before)
    expect((await f.pool.query('SELECT error_code FROM pe_operations WHERE id=$1', [p.grant.operationId])).rows)
      .toEqual([{ error_code: null }])
  }))

test('writer transaction authorization checks the PG clock after a genuine Session lock wait', () => cloudFixture(async (f) => {
  const p = await prepare(f)
  await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
    [p.session.sessionId])
  const blocker = await f.pool.connect()
  const waiter = new Pool({ connectionString: f.pool.options.connectionString, max: 1 })
  let pending: Promise<unknown> | undefined
  try {
    const pid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    if (pid === undefined) throw new Error('Expected owned PostgreSQL waiter')
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', [p.session.sessionId])
    const writer = new NativeSessionWriter(new TaskStore(waiter, limits), writerLimits)
    pending = transaction(waiter, client => writer.requireInTransaction(client, p.identity))
      .then(() => ({ accepted: true }), (error: unknown) => ({ error }))
    await expect.poll(async () => (await f.pool.query<{ blocked: boolean }>(
      "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=$1", [pid]))
      .rows[0]?.blocked, { timeout: 5000, interval: 20 }).toBe(true)
    await expect.poll(async () => (await blocker.query<{ expired: boolean }>(
      'SELECT expires_at<=clock_timestamp() AS expired FROM pe_native_writers WHERE session_id=$1', [p.session.sessionId]))
      .rows[0]?.expired, { timeout: 5000, interval: 20 }).toBe(true)
    await blocker.query('COMMIT')
    expect(await pending).toMatchObject({ error: { code: 'native_writer_lost' } })
  } finally {
    await blocker.query('ROLLBACK')
    await pending
    blocker.release()
    await waiter.end()
  }
}))

test('grant restoration keeps accepted settings and ordered original file content after account settings change', () =>
  cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files, { root: join(f.root, 'attachments'),
      maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 })
    await uploads.init()
    async function* bytes() { yield Buffer.from('original file') }
    const file = await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes(), 'original.txt', new AbortController().signal)
    const request = requestId.parse(randomUUID())
    await tasks.accept(f.alice.user, session.sessionId, request, 'original ordered text', f.alice.token, { kind: 'cloud' },
      nativePromptContent.parse([{ type: 'text', text: 'original ordered text' }, { type: 'file', receiptId: file.receiptId }]))
    await f.pool.query('UPDATE pe_users SET settings=$2 WHERE id=$1',
      [f.alice.user.userId, { model: 'later-model', maxTokens: 2000, revision: 2 }])
    const grant = required(await tasks.claim(randomUUID()))
    const before = (await f.pool.query('SELECT * FROM pe_attempts')).rows
    const restored = await transaction(f.pool, client => new TaskStore(f.pool, limits).restoreGrantInTransaction(client,
      grant.operationId, grant.token, grant.epoch))
    expect(restored).toEqual(grant)
    expect(restored.settings).toEqual({ model: 'trial-model', maxTokens: 1000, revision: 1 })
    expect(restored.nativeContent).toEqual([{ type: 'text', text: 'original ordered text' }, { type: 'file', attachment: file.file }])
    expect(restored.attachments).toEqual([file.file])
    expect((await f.pool.query('SELECT * FROM pe_attempts')).rows).toEqual(before)
    expect((await f.pool.query('SELECT request_id FROM pe_native_file_receipts WHERE id=$1', [file.receiptId])).rows)
      .toEqual([{ request_id: request }])
  }))

test('grant restoration refuses mismatched operation, epoch, bearer and ended attempt', () => cloudFixture(async (f) => {
  const p = await prepare(f)
  for (const input of [
    { operationId: operationId.parse(randomUUID()), token: p.grant.token, epoch: p.grant.epoch },
    { operationId: p.grant.operationId, token: p.grant.token, epoch: p.grant.epoch + 1 },
    { operationId: p.grant.operationId, token: freshToken(), epoch: p.grant.epoch },
  ]) {
    await expect(transaction(f.pool, client => p.tasks.restoreGrantInTransaction(client,
      input.operationId, input.token, input.epoch))).rejects.toMatchObject({ code: 'lease_lost' })
  }
  await f.pool.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND epoch=$2',
    [p.grant.operationId, p.grant.epoch])
  await expect(transaction(f.pool, client => p.tasks.restoreGrantInTransaction(client,
    p.grant.operationId, p.grant.token, p.grant.epoch))).rejects.toMatchObject({ code: 'lease_lost' })
}))

test('grant restoration rejects a lease expiring during a real attachment-table read wait', () => cloudFixture(async (f) => {
  const p = await prepare(f)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1", [p.session.sessionId])
  const blocker = await f.pool.connect(), waiter = new Pool({ connectionString: f.pool.options.connectionString, max: 1 })
  let pending: Promise<unknown> | undefined
  try {
    const pid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    if (pid === undefined) throw new Error('Expected owned PostgreSQL waiter')
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE pe_native_file_receipts IN ACCESS EXCLUSIVE MODE')
    pending = transaction(waiter, client => new TaskStore(waiter, limits).restoreGrantInTransaction(client,
      p.grant.operationId, p.grant.token, p.grant.epoch)).then(() => ({ accepted: true }), (error: unknown) => ({ error }))
    await expect.poll(async () => (await f.pool.query<{ blocked: boolean }>(
      "SELECT wait_event_type='Lock' AND strpos(query,'SELECT DISTINCT file')>0 AS blocked FROM pg_stat_activity WHERE pid=$1", [pid]))
      .rows[0]?.blocked, { timeout: 5000, interval: 20 }).toBe(true)
    await expect.poll(async () => (await blocker.query<{ expired: boolean }>(
      'SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1', [p.session.sessionId]))
      .rows[0]?.expired, { timeout: 5000, interval: 20 }).toBe(true)
    await blocker.query('COMMIT')
    expect(await pending).toMatchObject({ error: { code: 'lease_lost' } })
  } finally {
    await blocker.query('ROLLBACK')
    await pending
    blocker.release()
    await waiter.end()
  }
}))
