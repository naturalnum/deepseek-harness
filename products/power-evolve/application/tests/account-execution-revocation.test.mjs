/** Account execution cancellation against isolated PG; provider substitutes never start services. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { IdentityService } from '../lib/platform/identity.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'
import { taskCredential, clearTaskCredential } from './task-credential-fixture.mjs'
import * as migrations from '../lib/platform/schema.js'
import { McpConnectionService } from '../lib/platform/mcp-connections.js'
import { seedV21Session, seedV22Mcp } from './legacy-mcp-backup-fixture.mjs'
import { DeviceService } from '../lib/platform/devices.js'
import { identity } from '../lib/contracts.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { ExecutionService } from '../lib/platform/executions.js'
import { StdioMcpService } from '../lib/platform/stdio-mcp.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'

const limits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 16,
  maxActivePerUser: 1, executionEnabled: true, stdioMcpEnabled: true }
const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(
  process.env.PE_PRIVATE_DIR ?? '/Users/jingchao/.config/power-evolve/shared-host-s3-account-v25-qa', 'database-url'), 'utf8')).trim()

async function fixture(t, historicalVersion) {
  const database = `pe_account_exec_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  const held = new Set()
  t.after(async () => {
    for (const client of held) { await client.query('ROLLBACK'); client.release() }
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 5 })
  if (historicalVersion) {
    await pool.query(migrations.schema); await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
    for (let version = 2; version <= historicalVersion; version++) await pool.query(migrations[`schemaV${version}`])
  } else await initializeDatabase(pool)
  const users = ['alice', 'bob'].map(username => identity.parse({ username, userId: randomUUID() }))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,$2,$2,64)',
      [user.userId, 'fixture'])
  }
  const tasks = new TaskStore(pool, limits)
  const operation = async (user, target = { kind: 'cloud' }) => {
    const token = await taskCredential(pool, user)
    const { sessionId } = await tasks.create(user, randomUUID(), token)
    const receipt = await tasks.accept(user, sessionId, randomUUID(), 'Synthetic execution fixture', token, target)
    return { sessionId, operationId: receipt.operationId }
  }
  const revoke = user => transaction(pool, async client => {
    await lockAccountAuthorities(client, [user.userId], 'update')
    await client.query('UPDATE pe_users SET enabled=false,account_revision=account_revision+1,credential_version=credential_version+1 WHERE id=$1', [user.userId])
    await client.query('DELETE FROM pe_credentials WHERE user_id=$1', [user.userId])
    clearTaskCredential(pool, user)
    return revokeAccountExecutions(client, user.userId)
  })
  const enable = user => transaction(pool, async client => {
    await lockAccountAuthorities(client, [user.userId], 'update')
    await client.query('UPDATE pe_users SET enabled=true,account_revision=account_revision+1 WHERE id=$1', [user.userId])
    clearTaskCredential(pool, user)
  })
  return { pool, tasks, alice: users[0], bob: users[1], operation, revoke, enable, held }
}

test('disablement atomically ends every old input and attempt, fences grants and leaves another owner alone', async t => {
  const f = await fixture(t), first = await f.operation(f.alice)
  const grant = await f.tasks.claim(randomUUID())
  await f.operation(f.alice)
  const bob = await f.operation(f.bob)
  await assert.rejects(transaction(f.pool, async client => {
    await lockAccountAuthorities(client, [f.alice.userId], 'update')
    await revokeAccountExecutions(client, f.alice.userId)
    throw new Error('Synthetic rollback')
  }), /Synthetic rollback/u)
  await transaction(f.pool, client => f.tasks.authorized(client, grant.token))
  const changed = await f.revoke(f.alice)
  assert.equal(changed.sessions, 1); assert.equal(changed.operations, 2); assert.equal(changed.attempts, 1)
  await assert.rejects(transaction(f.pool, client => f.tasks.authorized(client, grant.token)), { code: 'lease_lost' })
  const old = await f.pool.query(`SELECT o.state,o.error_code,a.ended_at FROM pe_operations o
    LEFT JOIN pe_attempts a ON a.operation_id=o.id WHERE o.id=$1`, [first.operationId])
  assert.equal(old.rows[0].state, 'failed'); assert.equal(old.rows[0].error_code, 'account_disabled')
  assert.ok(old.rows[0].ended_at)
  const next = await f.tasks.claim(randomUUID())
  assert.equal(next.operationId, bob.operationId)
  assert.equal(await f.tasks.claim(randomUUID()), null)
  assert.deepEqual(await f.revoke(f.alice), { sessions: 0, operations: 0, attempts: 0, approvals: 0, executions: 0 })
})

class StdioFixture {
  posts = 0
  cleaned = []
  async prepare(callId) { return { callId, podUid: randomUUID(), instanceId: randomUUID() } }
  digestFor(handle, userId) { return handle.callId.replaceAll('-', '') + userId.replaceAll('-', '') }
  async dispatchFirst() { this.posts++; throw new Error('Unexpected synthetic dispatch') }
  async reconcile() { return { state: 'absent' } }
  async cleanup(callId) { this.cleaned.push(callId) }
}

test('STDIO disablement blocks a ready call before its only POST', async t => {
  const f = await fixture(t), runner = new StdioFixture()
  const stdio = new StdioMcpService(f.tasks, runner, randomUUID(), 30000, 100)
  const connection = await stdio.install(f.alice, randomUUID(), 'Synthetic process')
  await f.operation(f.alice)
  const grant = await f.tasks.claim(randomUUID())
  const call = await stdio.call(grant.token, connection.connectionId, 1, 'call')
  let row = await stdio.claim()
  const lease = { id: row.id, epoch: row.lease_epoch }
  row = await stdio.change(lease, 'preparing')
  const handle = await runner.prepare(row.id)
  row = await stdio.change(lease, 'ready', ',pod_uid=$5,runner_instance_id=$6', [handle.podUid, handle.instanceId])
  await f.revoke(f.alice)
  assert.equal(await stdio.markDispatchIntent(lease, row, runner.digestFor(handle, f.alice.userId)), null)
  await stdio.work(row)
  assert.equal(runner.posts, 0); assert.deepEqual(runner.cleaned, [call.callId])
  assert.equal((await stdio.status(f.alice, call.callId)).state, 'failed')
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='stdio_mcp_result'")).rows[0].n, 0)
})

test('cloud revocation preserves actual output, suppresses continuation and never replays an uncertain command', async t => {
  const f = await fixture(t), task = await f.operation(f.alice)
  const grant = await f.tasks.claim(randomUUID())
  const sandbox = { name: 'synthetic-sandbox', podUid: randomUUID(), runnerInstanceId: randomUUID(), token: 'fixture' }
  const sandboxes = { posts: 0, async assertCurrent() {}, async runner(_name, _token, method) {
    if (method === 'POST') this.posts++
    throw new KubernetesError(404, 'Synthetic missing execution')
  } }
  const executions = new ExecutionService(f.tasks, sandboxes,
    { service: { async verify() { throw new Error('Revocation fixture does not scan files') } }, timeoutMs: 1000 },
    1, 100, 1000, 1000)
  const receipt = await executions.propose(grant.token, 'cloud-call', 'synthetic-command', '/workspace')
  const row = await executions.claim()
  await f.revoke(f.alice)
  await f.enable(f.alice)
  const result = { exitCode: 0, stdout: 'actual synthetic output', stderr: '', stdoutTruncated: false,
    stderrTruncated: false, timedOut: false }
  await executions.settle(row, 'succeeded', result, null)
  const stored = (await f.pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows[0]
  assert.equal(stored.state, 'succeeded'); assert.deepEqual(stored.result, result)
  assert.equal(stored.error_code, 'account_disabled')
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='sandbox_result'")).rows[0].n, 0)
  assert.equal((await f.pool.query('SELECT state FROM pe_operations WHERE id=$1', [task.operationId])).rows[0].state, 'failed')
  await f.operation(f.alice)
  const newGrant = await f.tasks.claim(randomUUID())
  const unknown = await executions.propose(newGrant.token, 'uncertain-call', 'synthetic-unknown-command', '/workspace')
  const unknownRow = await executions.claim()
  await f.pool.query("UPDATE pe_cloud_executions SET state='uncertain' WHERE id=$1", [unknown.executionId])
  await executions.observe({ ...unknownRow, state: 'uncertain' }, sandbox, false, async () => {})
  const reconciled = (await f.pool.query('SELECT state,error_code FROM pe_cloud_executions WHERE id=$1', [unknown.executionId])).rows[0]
  assert.deepEqual(reconciled, { state: 'uncertain', error_code: 'runner_execution_missing' })
  assert.equal(sandboxes.posts, 0)
})

test('password rotation rejects stale browser admission while the accepted execution grant remains usable', async t => {
  const f = await fixture(t), task = await f.operation(f.alice)
  const browser = await taskCredential(f.pool, f.alice), grant = await f.tasks.claim(randomUUID())
  await transaction(f.pool, async client => {
    await lockAccountAuthorities(client, [f.alice.userId], 'update')
    await client.query(`UPDATE pe_users SET credential_version=credential_version+1,
      password_change_required=true WHERE id=$1`, [f.alice.userId])
  })
  await assert.rejects(f.tasks.accept(f.alice, task.sessionId, randomUUID(), 'stale browser', browser), { status: 401 })
  const identities = new IdentityService(f.pool, 3600000)
  await assert.rejects(identities.authenticate(browser), { code: 'unauthorized' })
  await assert.rejects(identities.exchange(browser), { code: 'unauthorized' })
  await assert.rejects(identities.login(f.alice.username, 'synthetic-task-fixture-password'), { status: 403 })
  const restricted = await identities.login(f.alice.username, 'synthetic-task-fixture-password', 'account')
  assert.equal((await identities.authenticate(restricted.token, 'account')).userId, f.alice.userId)
  await transaction(f.pool, client => f.tasks.authorized(client, grant.token))
  await f.tasks.finish(grant.token, 'completed', null)
  assert.equal((await f.pool.query('SELECT state FROM pe_operations WHERE id=$1', [task.operationId])).rows[0].state, 'completed')
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations')).rows[0].n, 1)
})

test('Desktop cancellation remains visible to its enrolled worker and late output cannot resume after re-enable', async t => {
  const f = await fixture(t), devices = new DeviceService(f.tasks, 1000, {})
  const browser = await taskCredential(f.pool, f.alice)
  const pairing = await devices.pair(f.alice, browser), instance = randomUUID()
  const device = await devices.enroll(pairing.code, 'Synthetic desktop', instance)
  const directory = await devices.directory(device.token, 'Synthetic directory')
  await f.operation(f.alice, { kind: 'desktop', deviceId: device.deviceId, directoryId: directory.directoryId })
  const grant = await f.tasks.claim(randomUUID())
  const receipt = await devices.propose(grant.token, 'desktop-call', 'synthetic-command', '.')
  await devices.claim(device.token, instance, receipt.executionId)
  await f.revoke(f.alice)
  const pending = await devices.jobs(device.token, instance)
  assert.equal(pending.jobs[0].cancelRequested, true)
  assert.equal(pending.jobs[0].state, 'cancelling')
  await assert.rejects(devices.claim(device.token, instance, receipt.executionId), { status: 401 })
  await f.enable(f.alice)
  await assert.rejects(devices.claim(device.token, instance, receipt.executionId), { code: 'desktop_execution_unavailable' })
  const result = { state: 'succeeded', exitCode: 0, stdout: 'observed desktop output', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false }
  const finished = await devices.finish(device.token, instance, receipt.executionId, result)
  assert.equal(finished.state, 'uncertain'); assert.deepEqual(finished.result, result)
  assert.equal(finished.errorCode, 'account_disabled')
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='desktop_result'")).rows[0].n, 0)
})

async function waitUntilBlocked(pool, pid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]
    if (row?.wait_event_type === 'Lock') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected admission to wait on account authority lock')
}

test('credential rotation and input acceptance serialize on the same account row', async t => {
  const f = await fixture(t), { sessionId } = await f.operation(f.alice)
  const token = await taskCredential(f.pool, f.alice)
  const blocker = await f.pool.connect(), accepter = await f.pool.connect()
  f.held.add(blocker); f.held.add(accepter)
  await blocker.query('BEGIN')
  await lockAccountAuthorities(blocker, [f.alice.userId], 'update')
  await blocker.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.alice.userId])
  // Pin admission to one observed PG connection, without changing production SQL.
  const pinned = new TaskStore({ connect: async () => ({ query: (...args) => accepter.query(...args), on: (...args) => accepter.on(...args),
    removeListener: (...args) => accepter.removeListener(...args), release() {} }) }, limits)
  const pid = (await accepter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const acceptance = pinned.accept(f.alice, sessionId, randomUUID(), 'blocked stale input', token)
  const outcome = acceptance.then(value => ({ value }), error => ({ error }))
  await waitUntilBlocked(f.pool, pid)
  await blocker.query('COMMIT')
  assert.equal((await outcome).error.status, 401)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations')).rows[0].n, 1)
})

test('STDIO original result after account re-enable remains stored without resuming the old Agent', async t => {
  const f = await fixture(t), runner = new StdioFixture()
  const stdio = new StdioMcpService(f.tasks, runner, randomUUID(), 30000, 100)
  const connection = await stdio.install(f.alice, randomUUID(), 'Synthetic process')
  await f.operation(f.alice)
  const grant = await f.tasks.claim(randomUUID())
  const call = await stdio.call(grant.token, connection.connectionId, 1, 'late-call')
  let row = await stdio.claim()
  const lease = { id: row.id, epoch: row.lease_epoch }
  row = await stdio.change(lease, 'preparing')
  const handle = await runner.prepare(row.id)
  row = await stdio.change(lease, 'ready', ',pod_uid=$5,runner_instance_id=$6', [handle.podUid, handle.instanceId])
  row = await stdio.markDispatchIntent(lease, row, runner.digestFor(handle, f.alice.userId))
  await f.revoke(f.alice)
  await f.enable(f.alice)
  await stdio.observe(lease, row, { state: 'known', status: { callId: row.id, instanceId: row.runner_instance_id,
    digest: row.dispatch_digest, state: 'succeeded', result: { kind: 'mcp.stdio.whoami', text: `user:${f.alice.userId}` } } })
  const result = await stdio.status(f.alice, call.callId)
  assert.equal(result.state, 'succeeded'); assert.equal(result.result, `user:${f.alice.userId}`)
  assert.equal(result.errorCode, 'account_disabled')
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='stdio_mcp_result'")).rows[0].n, 0)
  assert.equal(await f.tasks.claim(randomUUID()), null)
  assert.equal(runner.posts, 0)
})

test('historical V21 Session and V22 encrypted MCP fixture remain readable after the V25 migration', async t => {
  const f = await fixture(t, 21)
  const session = await seedV21Session(f.pool, f.alice)
  const original = (await f.pool.query('SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0].header
  assert.equal((await f.pool.query('SELECT version FROM pe_schema')).rows[0].version, 21)
  await f.pool.query(migrations.schemaV22)
  const key = randomBytes(32).toString('base64url'), secret = 'synthetic-historical-secret'
  const seeded = await seedV22Mcp(f.pool, f.alice, session.sessionId, key, secret,
    [{ name: 'historical', inputSchema: { type: 'object' } }])
  assert.equal((await f.pool.query('SELECT version FROM pe_schema')).rows[0].version, 22)
  await initializeDatabase(f.pool)
  assert.deepEqual((await f.pool.query('SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0].header, original)
  const options = { maxConnections: 8, maxPendingTickets: 8, maxActiveChecks: 8, maxDrafts: 8, maxDraftsPerHour: 8,
    maxTools: 8, maxCatalogBytes: 65536, maxToolBytes: 16384, ticketLifetimeMs: 300000,
    checkLifetimeMs: 60000, draftLifetimeMs: 120000, retentionMs: 3600000, checkLeaseMs: 30000,
    async assertEndpoint() {} }
  const connections = new McpConnectionService(f.pool, key, options)
  const snapshot = await transaction(f.pool, client => connections.runtimeSnapshot(client, f.alice,
    { connectionId: seeded.connectionId, revision: 1, configurationRevision: 1, credentialRevision: 1, catalogId: seeded.catalogId }))
  assert.equal(snapshot.headers.Authorization, `Bearer ${secret}`)
  assert.equal((await connections.getCatalog(f.alice, seeded.catalogId)).tools.length, 1)
})
