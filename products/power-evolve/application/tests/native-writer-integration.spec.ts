/** Formal schema-backed claim fencing; independent module instances, not Host processes or Profiles. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { requestId, type Grant } from '../src/contracts.ts'
import { nativeWriterAcquire, nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { EventStore } from '../src/platform/events.ts'
import { digest } from '../src/platform/identity.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 100,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]

function claimed(value: Grant | null): Grant {
  if (!value) throw new Error('Expected the owned accepted operation')
  return value
}

async function queued(f: Fixture) {
  const tasks = new TaskStore(f.pool, limits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'turn A', f.alice.token)
  const worker = nativeWriterWorkerId.parse(randomUUID())
  const grant = claimed(await tasks.claim(worker))
  const writer = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const request = nativeWriterAcquire.parse({ sessionId: created.sessionId, workerId: worker,
    token: randomBytes(32).toString('base64url') })
  const lease = await writer.acquire(grant.token, request)
  const identity = nativeWriterIdentity.parse({ ...request, epoch: lease.epoch })
  const nextRequest = requestId.parse(randomUUID())
  await tasks.accept(f.alice.user, created.sessionId, nextRequest, 'turn B', f.alice.token)
  await tasks.finish(grant.token, 'completed', null)
  return { tasks, created, worker, grant, writer, identity, nextRequest }
}

async function executionState(f: Fixture, sessionId: string) {
  const operations = await f.pool.query<Record<string, unknown>>(`SELECT id,request_id,state,attempts,input
    FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id`, [sessionId])
  const session = await f.pool.query<Record<string, unknown>>(`SELECT grant_digest,lease_epoch,lease_until,event_count,event_bytes
    FROM pe_sessions WHERE id=$1`, [sessionId])
  const events = await f.pool.query<Record<string, unknown>>('SELECT seq,event::text FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [sessionId])
  return { operations: operations.rows, session: session.rows, events: events.rows }
}

test('settled operation occupancy blocks both claim instances until exact release without consuming pending input', () =>
  cloudFixture(async (f) => {
    const n = await queued(f), other = new TaskStore(f.pool, limits)
    const before = await executionState(f, n.created.sessionId)
    expect(await n.tasks.claim(n.worker)).toBeNull()
    const nextWorker = nativeWriterWorkerId.parse(randomUUID())
    expect(await other.claim(nextWorker)).toBeNull()
    expect(await executionState(f, n.created.sessionId)).toEqual(before)
    expect(await n.writer.renew(n.identity)).toMatchObject({ epoch: n.identity.epoch })
    expect(await executionState(f, n.created.sessionId)).toEqual(before)
    await n.writer.release(n.identity)
    const next = claimed(await other.claim(nextWorker))
    expect(next).toMatchObject({ sessionId: n.created.sessionId, requestId: n.nextRequest, text: 'turn B',
      epoch: n.grant.epoch + 1, nativeContent: [{ type: 'text', text: 'turn B' }] })
    const fresh = await n.writer.acquire(next.token, { sessionId: n.created.sessionId, workerId: nextWorker,
      token: randomBytes(32).toString('base64url') })
    expect(fresh.epoch).toBe(n.identity.epoch + 1)
    await expect(n.writer.release(n.identity)).rejects.toMatchObject({ code: 'native_writer_lost' })
    await expect(n.writer.renew(n.identity)).rejects.toMatchObject({ code: 'native_writer_lost' })
    await expect(n.tasks.renew(n.grant.token)).rejects.toMatchObject({ code: 'lease_lost' })
    await expect(new EventStore(other, limits).append(n.grant.token, [])).rejects.toMatchObject({ code: 'lease_lost' })
    expect((await executionState(f, n.created.sessionId)).events).toEqual(before.events)
  }))

test('PG-expired occupancy permits one competing claim and a new monotone writer identity', () =>
  cloudFixture(async (f) => {
    const n = await queued(f), other = new TaskStore(f.pool, limits)
    await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
      [n.created.sessionId])
    const leftWorker = nativeWriterWorkerId.parse(randomUUID()), rightWorker = nativeWriterWorkerId.parse(randomUUID())
    const results = await Promise.all([
      n.tasks.claim(leftWorker).then(grant => ({ worker: leftWorker, grant })),
      other.claim(rightWorker).then(grant => ({ worker: rightWorker, grant })),
    ])
    expect(results.filter(result => result.grant !== null)).toHaveLength(1)
    const winner = results.find(result => result.grant !== null)
    if (!winner?.grant) throw new Error('Expected exactly one owned claim')
    expect(winner.grant).toMatchObject({ requestId: n.nextRequest, text: 'turn B', epoch: n.grant.epoch + 1 })
    const lease = await n.writer.acquire(winner.grant.token, { sessionId: n.created.sessionId, workerId: winner.worker,
      token: randomBytes(32).toString('base64url') })
    expect(lease.epoch).toBe(n.identity.epoch + 1)
    await expect(n.writer.renew(n.identity)).rejects.toMatchObject({ code: 'native_writer_lost' })
    expect((await f.pool.query<{ attempts: number }>(
      'SELECT attempts FROM pe_operations WHERE session_id=$1 AND request_id=$2', [n.created.sessionId, n.nextRequest])).rows)
      .toEqual([{ attempts: 1 }])
  }))

test('writer occupancy alone does not consume account execution capacity or hide another eligible Session', () =>
  cloudFixture(async (f) => {
    const n = await queued(f)
    const other = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const request = requestId.parse(randomUUID())
    await n.tasks.accept(f.alice.user, other.sessionId, request, 'independent Session', f.alice.token)
    const grant = claimed(await n.tasks.claim(randomUUID()))
    expect(grant).toMatchObject({ sessionId: other.sessionId, requestId: request, text: 'independent Session' })
    expect((await f.pool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM pe_operations WHERE session_id=$1 AND request_id=$2', [n.created.sessionId, n.nextRequest])).rows)
      .toEqual([{ state: 'queued', attempts: 0 }])
    expect(await n.writer.renew(n.identity)).toMatchObject({ epoch: n.identity.epoch })
  }))

test('claim checks writer occupancy in a new PG snapshot after a genuine Session lock wait', () =>
  cloudFixture(async (f) => {
    const n = await queued(f)
    await n.writer.release(n.identity)
    const before = await executionState(f, n.created.sessionId)
    const lock = await f.pool.connect()
    let pending: Promise<Grant | null> | undefined
    try {
      await lock.query('BEGIN')
      await lock.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE', [n.created.sessionId])
      pending = n.tasks.claim(randomUUID())
      await expect.poll(async () => (await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS blocked`,
      ['%FOR UPDATE OF s,o%'])).rows[0]?.blocked, { timeout: 2000, interval: 20 }).toBe(true)
      // Diagnostic SQL commits a fresh occupancy while the claim query holds an older statement snapshot.
      // Ordinary writer APIs also take the account lock; this case does not claim concurrent Host acquisition.
      await lock.query(`UPDATE pe_native_writers SET worker_id=$2,epoch=epoch+1,token_digest=$3,
        expires_at=clock_timestamp()+interval '20 seconds' WHERE session_id=$1`,
      [n.created.sessionId, randomUUID(), digest(randomBytes(32).toString('base64url'))])
      await lock.query('COMMIT')
      expect(await pending).toBeNull()
      expect(await executionState(f, n.created.sessionId)).toEqual(before)
    } finally {
      await lock.query('ROLLBACK')
      await pending?.catch((_failure: unknown) => undefined)
      lock.release()
    }
  }))
