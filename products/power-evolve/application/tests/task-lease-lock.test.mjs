/** Real PG lock waits must not revive expired grants or consume a newly claimed lease. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import test from 'node:test'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { EventStore } from '../lib/platform/events.js'
import { taskCredential } from './task-credential-fixture.mjs'

const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(
  process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1'), 'database-url'), 'utf8')).trim()
const limits = { maxEventBytes: 524288, leaseMs: 5000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const eventLimits = { maxHistoryBytes: 1048576, maxHistoryEvents: 100, maxEventBytes: 65536 }

async function fixture(t, leaseMs = limits.leaseMs) {
  const database = `pe_lease_lock_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 }), held = new Set()
  let pool, created = false
  t.after(async () => {
    for (const client of held) { await client.query('ROLLBACK'); client.release() }
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 5 })
  await initializeDatabase(pool)
  const user = identity.parse({ userId: randomUUID(), username: 'lease-fixture' })
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
  await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,$2,$2,64)', [user.userId, 'fixture'])
  const tasks = new TaskStore(pool, { ...limits, leaseMs }), token = await taskCredential(pool, user)
  const { sessionId } = await tasks.create(user, randomUUID(), token)
  await tasks.accept(user, sessionId, randomUUID(), 'Synthetic lease fixture', token)
  const connect = async () => { const client = await pool.connect(); held.add(client); return client }
  return { pool, tasks, sessionId, connect, leaseMs }
}

/** Retain a real exclusive PG client so the test can identify the blocked transaction. */
function pinnedTasks(client, leaseMs = limits.leaseMs) {
  const pool = { connect: async () => ({
    query: (...args) => client.query(...args), on: (...args) => client.on(...args),
    removeListener: (...args) => client.removeListener(...args), release() {},
  }) }
  return new TaskStore(pool, { ...limits, leaseMs })
}

async function sessionLockWait(pool, pid, blockerPid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const row = (await pool.query(`SELECT wait_event_type,query,$2=ANY(pg_blocking_pids(pid)) AS blocked
      FROM pg_stat_activity WHERE pid=$1`, [pid, blockerPid])).rows[0]
    if (row?.wait_event_type === 'Lock' && row.blocked && row.query.includes('pe_sessions')
      && row.query.includes('FOR UPDATE')) return
    await new Promise(done => setTimeout(done, 10))
  }
  throw new Error('Expected the real operation to wait on the Session row lock')
}

async function expireWhileBlocked(f, action) {
  const grant = await f.tasks.claim(randomUUID())
  const blocker = await f.connect(), waiter = await f.connect()
  const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const waiterPid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const original = (await f.pool.query(`UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '200 milliseconds'
    WHERE id=$1 RETURNING lease_until`, [f.sessionId])).rows[0].lease_until
  await blocker.query('BEGIN')
  const locked = (await blocker.query('SELECT id,lease_until>clock_timestamp() AS live FROM pe_sessions WHERE id=$1 FOR SHARE',
    [f.sessionId])).rows[0]
  assert.equal(locked.live, true)
  // The blocker never updates this tuple, so PG cannot rescue a pre-lock clock check through tuple re-evaluation.
  const outcome = action(pinnedTasks(waiter), grant.token).then(value => ({ value }), error => ({ error }))
  await sessionLockWait(f.pool, waiterPid, blockerPid)
  await blocker.query('SELECT pg_sleep(0.4)')
  assert.equal((await blocker.query('SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1',
    [f.sessionId])).rows[0].expired, true)
  await blocker.query('COMMIT')
  return { outcome: await outcome, original }
}

for (const operation of ['renew', 'append']) test(`${operation} refuses a grant that expires while waiting for the Session lock`, async t => {
  const f = await fixture(t)
  const { outcome, original } = await expireWhileBlocked(f, (tasks, token) => operation === 'renew'
    ? tasks.renew(token)
    : new EventStore(tasks, eventLimits).append(token, [{ seq: 0, time: 1, type: 'session/end-seed', data: {} }]))
  assert.equal(outcome.error?.code, 'lease_lost', `Observed ${JSON.stringify(outcome.value)} after grant expiry`)
  assert.equal(outcome.error.status, 409)
  const stored = (await f.pool.query('SELECT lease_until,event_count,event_bytes FROM pe_sessions WHERE id=$1', [f.sessionId])).rows[0]
  assert.deepEqual(stored.lease_until, original)
  assert.equal(stored.event_count, 0); assert.equal(Number(stored.event_bytes), 0)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_events WHERE session_id=$1', [f.sessionId])).rows[0].n, 0)
})

test('claim grants a fresh full lease after a Session lock wait longer than the configured lease', async t => {
  const f = await fixture(t, 1000), blocker = await f.connect(), waiter = await f.connect()
  const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const waiterPid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  await blocker.query('BEGIN')
  await blocker.query('SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', [f.sessionId])
  const outcome = pinnedTasks(waiter, f.leaseMs).claim(randomUUID()).then(value => ({ value }), error => ({ error }))
  await sessionLockWait(f.pool, waiterPid, blockerPid)
  await blocker.query('SELECT pg_sleep(1.2)')
  await blocker.query('COMMIT')
  const observed = await outcome
  assert.equal(observed.error, undefined); assert.ok(observed.value)
  const remaining = (await f.pool.query(`SELECT extract(epoch FROM (lease_until-clock_timestamp()))*1000 AS remaining
    FROM pe_sessions WHERE id=$1`, [f.sessionId])).rows[0].remaining
  assert.ok(Number(remaining) > 500, `Claim returned only ${remaining} ms of its ${f.leaseMs} ms lease`)
  assert.ok(Number(remaining) <= f.leaseMs)
})

class SlowAuthorizationTasks extends TaskStore {
  async authorized(client, token) {
    const row = await super.authorized(client, token)
    await client.query('SELECT pg_sleep(0.4)')
    return row
  }
}

test('renew checks the deadline again at its final update after an initially valid authorization', async t => {
  const f = await fixture(t), grant = await f.tasks.claim(randomUUID())
  const original = (await f.pool.query(`UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '200 milliseconds'
    WHERE id=$1 RETURNING lease_until`, [f.sessionId])).rows[0].lease_until
  const tasks = new SlowAuthorizationTasks(f.pool, limits)
  await assert.rejects(tasks.renew(grant.token), { status: 409, code: 'lease_lost' })
  assert.deepEqual((await f.pool.query('SELECT lease_until FROM pe_sessions WHERE id=$1', [f.sessionId])).rows[0].lease_until, original)
})
