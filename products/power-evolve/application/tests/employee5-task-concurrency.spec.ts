/** Real PostgreSQL lock waits, account revocation and current-writer fencing. */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { digest } from '../src/platform/identity.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 1_048_576, maxHistoryEvents: 100,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const seed = [{ seq: 0, time: 1, type: 'session/end-seed', data: {} }]
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

function observe<T>(work: Promise<T>): Promise<Outcome<T>> {
  return work.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
}

async function blockedOperation<T>(pool: Pool, lock: { sql: string; values: string[]; query: string },
  work: (waiter: Pool) => Promise<T>, whileBlocked: (blocker: PoolClient) => Promise<void>): Promise<Outcome<T>> {
  // One real backend per waiting operation makes pg_blocking_pids identify the exact production transaction.
  const waiter = new Pool({ connectionString: pool.options.connectionString, max: 1, idleTimeoutMillis: 0 })
  const blocker = await pool.connect()
  let pending: Promise<Outcome<T>> | undefined
  try {
    const waiterPid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    if (waiterPid === undefined || blockerPid === undefined) throw new Error('Expected real PostgreSQL backend identities')
    expect(waiterPid).not.toBe(blockerPid)
    await blocker.query('BEGIN')
    await blocker.query(lock.sql, lock.values)
    pending = observe(work(waiter))
    await expect.poll(async () => {
      const result = await pool.query<{ waiting: boolean }>(`SELECT wait_event_type='Lock'
        AND $2=ANY(pg_blocking_pids(pid)) AND strpos(query,$3)>0 AS waiting
        FROM pg_stat_activity WHERE pid=$1`, [waiterPid, blockerPid, lock.query])
      return result.rows[0]?.waiting
    }, { timeout: 10_000, interval: 10 }).toBe(true)
    await whileBlocked(blocker)
    await blocker.query('COMMIT')
    return await pending
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    if (pending) await pending
    await waiter.end()
  }
}

for (const operation of ['renew', 'append'] as const) {
  test(`${operation} rejects an unchanged Session tuple whose lease expires during a real lock wait`, () =>
    cloudFixture(async ({ pool, alice }) => {
      const tasks = new TaskStore(pool, limits)
      const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'lock-wait input', alice.token)
      const grant = await tasks.claim(randomUUID())
      if (!grant) throw new Error('Expected accepted operation')
      const original = (await pool.query<{ lease_until: Date }>(`UPDATE pe_sessions
        SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING lease_until`, [session.sessionId])).rows[0]?.lease_until
      const outcome = await blockedOperation<unknown>(pool,
        { sql: 'SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', values: [session.sessionId], query: 'FOR UPDATE OF s' },
        waiter => operation === 'renew' ? new TaskStore(waiter, limits).renew(grant.token)
          : new EventStore(new TaskStore(waiter, limits), limits).append(grant.token, seed),
        async (blocker) => {
          await expect.poll(async () => (await blocker.query<{ expired: boolean }>(
            'SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0]?.expired,
          { timeout: 10_000, interval: 10 }).toBe(true)
        })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('Expired grant was accepted')
      expect(outcome.error).toMatchObject({ status: 409, code: 'lease_lost' })
      expect((await pool.query('SELECT lease_until,event_count,event_bytes FROM pe_sessions WHERE id=$1', [session.sessionId])).rows)
        .toEqual([{ lease_until: original, event_count: 0, event_bytes: '0' }])
      expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events')).rows[0]?.count).toBe(0)
    }))
}

test('claim starts its full lease after a Session lock wait exceeds the configured lease', () =>
  cloudFixture(async ({ pool, alice }) => {
    const short = { ...limits, leaseMs: 1_000 }, tasks = new TaskStore(pool, short)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'claim-wait input', alice.token)
    let releaseEpoch = ''
    const outcome = await blockedOperation(pool,
      { sql: 'SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', values: [session.sessionId], query: 'FOR UPDATE OF s,o' },
      waiter => new TaskStore(waiter, short).claim(randomUUID()), async (blocker) => {
        const start = (await blocker.query<{ time: string }>('SELECT extract(epoch FROM clock_timestamp())::text AS time')).rows[0]?.time
        if (start === undefined) throw new Error('Expected PostgreSQL clock observation')
        await expect.poll(async () => (await blocker.query<{ elapsed: boolean }>(
          'SELECT extract(epoch FROM clock_timestamp()) >= $1::numeric+$2::numeric/1000 AS elapsed', [start, short.leaseMs])).rows[0]?.elapsed,
        { timeout: 10_000, interval: 10 }).toBe(true)
        const released = (await blocker.query<{ time: string }>('SELECT extract(epoch FROM clock_timestamp())::text AS time')).rows[0]?.time
        if (released === undefined) throw new Error('Expected PostgreSQL release observation')
        releaseEpoch = released
      })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.value) throw new Error('Expected a fresh claim')
    const persisted = await pool.query<{ after_release: boolean }>(`SELECT extract(epoch FROM lease_until)
      >= $2::numeric+$3::numeric/1000 AS after_release FROM pe_sessions WHERE id=$1`, [session.sessionId, releaseEpoch, short.leaseMs])
    expect(persisted.rows[0]?.after_release).toBe(true)
    expect((await pool.query('SELECT epoch,ended_at FROM pe_attempts WHERE operation_id=$1', [outcome.value.operationId])).rows)
      .toEqual([{ epoch: 1, ended_at: null }])
  }))

for (const mutation of ['credential-version', 'disabled'] as const) {
  test(`accept rechecks ${mutation} after waiting for the account row lock`, () =>
    cloudFixture(async ({ pool, alice }) => {
      const tasks = new TaskStore(pool, limits)
      const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      const outcome = await blockedOperation(pool,
        { sql: 'SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', values: [alice.user.userId], query: 'FOR NO KEY UPDATE' },
        waiter => new TaskStore(waiter, limits).accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'revoked input', alice.token),
        async (blocker) => {
          await blocker.query(mutation === 'credential-version'
            ? 'UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1'
            : 'UPDATE pe_users SET enabled=false WHERE id=$1', [alice.user.userId])
        })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('Revoked browser request was accepted')
      expect(outcome.error).toMatchObject({ status: 401, code: mutation === 'disabled' ? 'account_disabled' : 'account_unauthorized' })
      expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations')).rows[0]?.count).toBe(0)
      expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_prompt_inputs')).rows[0]?.count).toBe(0)
    }))
}

test('accept refuses a bearer that expires while its unchanged credential tuple is locked', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const hashed = digest(alice.token)
    await pool.query("UPDATE pe_credentials SET expires_at=clock_timestamp()+interval '2 seconds' WHERE digest=$1", [hashed])
    const outcome = await blockedOperation(pool,
      { sql: 'SELECT digest FROM pe_credentials WHERE digest=$1 FOR UPDATE', values: [hashed], query: 'FOR SHARE' },
      waiter => new TaskStore(waiter, limits).accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'expired bearer input', alice.token),
      async (blocker) => {
        await expect.poll(async () => (await blocker.query<{ expired: boolean }>(
          'SELECT expires_at<=clock_timestamp() AS expired FROM pe_credentials WHERE digest=$1', [hashed])).rows[0]?.expired,
        { timeout: 10_000, interval: 10 }).toBe(true)
      })
    const operations = (await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations')).rows[0]?.count
    const inputs = (await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_prompt_inputs')).rows[0]?.count
    expect({ allowed: outcome.ok, operations, inputs }).toEqual({ allowed: false, operations: 0, inputs: 0 })
    if (outcome.ok) throw new Error('Expired browser credential admitted a new operation')
    expect(outcome.error).toMatchObject({ status: 401, code: 'account_unauthorized' })
  }))

test('credential rotation keeps an accepted grant usable while account disablement fences its writes', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'accepted before rotation', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected accepted operation')
    await pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [alice.user.userId])
    await expect(tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'new browser work', alice.token))
      .rejects.toMatchObject({ status: 401, code: 'account_unauthorized' })
    expect(await tasks.renew(grant.token)).toEqual({ cancelRequested: false })
    expect(await events.append(grant.token, seed)).toEqual({ eventCount: 1 })
    await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.user.userId])
    await expect(tasks.renew(grant.token)).rejects.toMatchObject({ status: 401, code: 'account_disabled' })
    await expect(events.append(grant.token, seed)).rejects.toMatchObject({ status: 401, code: 'account_disabled' })
    expect((await pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0]?.event_count).toBe(1)
  }))

test('only the replacement epoch may append, renew and finish after the original writer loses its lease', () =>
  cloudFixture(async ({ pool, alice }) => {
    const firstHost = new TaskStore(pool, limits), secondHost = new TaskStore(pool, limits)
    const events = new EventStore(firstHost, limits)
    const session = await firstHost.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const request = requestId.parse(randomUUID())
    await firstHost.accept(alice.user, session.sessionId, request, 'recover the accepted input', alice.token)
    const workerA = randomUUID(), workerB = randomUUID()
    const original = await firstHost.claim(workerA)
    if (!original) throw new Error('Expected original claim')
    await events.append(original.token, seed)
    await pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [session.sessionId])
    const replacement = await secondHost.claim(workerB)
    if (!replacement) throw new Error('Expected replacement claim')
    expect(replacement).toMatchObject({ sessionId: session.sessionId, operationId: original.operationId,
      requestId: request, epoch: original.epoch + 1 })
    expect(replacement.token).not.toBe(original.token)
    await expect(firstHost.renew(original.token)).rejects.toMatchObject({ code: 'lease_lost' })
    await expect(events.append(original.token, seed)).rejects.toMatchObject({ code: 'lease_lost' })
    await expect(firstHost.finish(original.token, 'completed', null)).rejects.toMatchObject({ code: 'lease_lost' })
    expect(await new EventStore(secondHost, limits).runtimeSnapshot(replacement.token)).toMatchObject({ eventCount: 1, events: seed })
    expect(await new EventStore(secondHost, limits).append(replacement.token, seed)).toEqual({ eventCount: 1 })
    await secondHost.finish(replacement.token, 'completed', null)
    expect((await pool.query('SELECT state,attempts FROM pe_operations WHERE id=$1', [original.operationId])).rows)
      .toEqual([{ state: 'completed', attempts: 2 }])
    expect((await pool.query('SELECT epoch,worker_id,ended_at IS NOT NULL AS ended FROM pe_attempts ORDER BY epoch')).rows)
      .toEqual([{ epoch: 1, worker_id: workerA, ended: false }, { epoch: 2, worker_id: workerB, ended: true }])
    await expect(new EventStore(secondHost, limits).runtimeSnapshot(replacement.token)).rejects.toMatchObject({ code: 'lease_lost' })
  }))
