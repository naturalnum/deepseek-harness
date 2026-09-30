/** Real PostgreSQL authorization and continuation for the isolated process MCP path. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { StdioMcpService } from '../lib/platform/stdio-mcp.js'
import { TaskStore } from '../lib/platform/tasks.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function eventually(check, done = value => Boolean(value)) {
  const until = Date.now() + 10_000
  let last
  while (Date.now() < until) {
    const result = await check()
    last = result
    if (done(result)) return result
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`STDIO MCP did not settle: ${JSON.stringify(last)}`)
}

class FixtureRunner {
  handles = new Map()
  posts = 0
  beforeDispatch
  async prepare(callId) {
    const prior = this.handles.get(callId)
    if (prior) return prior
    const handle = { callId, podUid: randomUUID(), instanceId: randomUUID() }
    this.handles.set(callId, handle)
    return handle
  }
  digestFor(handle, userId) { return `${handle.callId.replaceAll('-', '')}${userId.replaceAll('-', '')}` }
  async dispatchFirst(handle, userId) {
    await this.beforeDispatch?.()
    this.posts++
    return { state: 'known', status: { callId: handle.callId, instanceId: handle.instanceId,
      digest: this.digestFor(handle, userId), state: 'succeeded',
      result: { kind: 'mcp.stdio.whoami', text: `user:${userId}` } } }
  }
  async reconcile() { return { state: 'absent' } }
  async cleanup(callId) { this.handles.delete(callId) }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function reached(promise, stage) {
  let timer
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`STDIO MCP did not reach ${stage}`)), 15_000)
    })])
  } finally { clearTimeout(timer) }
}

class PausingStdioMcpService extends StdioMcpService {
  beforeIntent
  afterIntent
  async markDispatchIntent(...args) {
    await this.beforeIntent?.()
    const row = await super.markDispatchIntent(...args)
    if (row) await this.afterIntent?.()
    return row
  }
}

test('STDIO calls pin owner and revision, deduplicate, and resume the same Session',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_stdio_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let pool, created = false, stdio
    t.after(async () => {
      await stdio?.close()
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    const users = [identity.parse({ userId: randomUUID(), username: 'alice' }),
      identity.parse({ userId: randomUUID(), username: 'bob' })]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(migrations.schema)
      await client.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (const user of users) await client.query(
        'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      for (let version = 2; version <= 16; version++) await client.query(migrations[`schemaV${version}`])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30_000, maxPendingPerUser: 8,
      maxActivePerUser: 1, stdioMcpEnabled: true })
    const runner = new FixtureRunner()
    stdio = new StdioMcpService(tasks, runner, randomUUID(), 30_000, 100)
    const [alice, bob] = users
    const installId = randomUUID()
    const a = await stdio.install(alice, installId, 'My process MCP')
    const b = await stdio.install(bob, randomUUID(), 'Bob process MCP')
    assert.deepEqual(await stdio.install(alice, installId, 'My process MCP'), a)
    await assert.rejects(stdio.install(alice, installId, 'changed'),
      { status: 409, code: 'request_id_conflict' })
    assert.deepEqual((await stdio.list(bob)).items, [b])
    const session = await tasks.create(alice, randomUUID())
    const accepted = await tasks.accept(alice, session.sessionId, randomUUID(), 'Use the process MCP')
    assert.deepEqual((await pool.query('SELECT stdio_mcp_selection FROM pe_operations WHERE id=$1',
      [accepted.operationId])).rows[0].stdio_mcp_selection,
    [{ connectionId: a.connectionId, revision: 1 }])
    const grant = await tasks.claim(randomUUID())
    assert.deepEqual(grant.stdioMcpConnections, [{ connectionId: a.connectionId, revision: 1 }])
    await assert.rejects(stdio.call(grant.token, b.connectionId, 1, 'cross-user'),
      { status: 403, code: 'stdio_mcp_not_in_operation' })
    const receipt = await stdio.call(grant.token, a.connectionId, 1, 'one-tool-call')
    assert.equal(receipt.state, 'accepted')
    assert.deepEqual(await stdio.call(grant.token, a.connectionId, 1, 'one-tool-call'), receipt)
    await assert.rejects(stdio.call(grant.token, a.connectionId, 1, 'another-tool-call'),
      { status: 429, code: 'stdio_mcp_call_limit' })
    await assert.rejects(stdio.status(bob, receipt.callId),
      { status: 404, code: 'stdio_mcp_call_not_found' })
    stdio.start()
    const finished = await eventually(() => stdio.status(alice, receipt.callId),
      status => status.state === 'succeeded')
    assert.equal(finished.result, `user:${alice.userId}`)
    assert.equal(runner.posts, 1)
    const resultOperation = await pool.query(
      `SELECT o.source,o.source_stdio_mcp_call_id,o.session_id,o.input
       FROM pe_operations o WHERE o.source='stdio_mcp_result'`)
    assert.equal(resultOperation.rows.length, 1)
    assert.equal(resultOperation.rows[0].source_stdio_mcp_call_id, receipt.callId)
    assert.equal(resultOperation.rows[0].session_id, session.sessionId)
    assert.match(resultOperation.rows[0].input, new RegExp(alice.userId))
    await tasks.finish(grant.token, 'completed', null)
    const continuation = await tasks.claim(randomUUID())
    assert.equal(continuation.source, 'stdio_mcp_result')
    assert.equal(continuation.sourceStdioMcpCallId, receipt.callId)
    await tasks.finish(continuation.token, 'completed', null)
    const disabled = await stdio.toggle(alice, a.connectionId, randomUUID(), 1, false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.revision, 2)
    await tasks.accept(alice, session.sessionId, randomUUID(), 'After disable')
    const next = await tasks.claim(randomUUID())
    assert.deepEqual(next.stdioMcpConnections, [])
    await tasks.finish(next.token, 'completed', null)
    assert.deepEqual((await stdio.calls(bob)).items, [])

    await stdio.close()
    const reenabled = await stdio.toggle(alice, a.connectionId, randomUUID(), 2, true)
    assert.equal(reenabled.revision, 3)
    stdio = new StdioMcpService(tasks, runner, randomUUID(), 30_000, 100)
    await tasks.accept(alice, session.sessionId, randomUUID(), 'Recover an uncertain process call')
    const recoveryGrant = await tasks.claim(randomUUID())
    const recovering = await stdio.call(recoveryGrant.token, a.connectionId, 3, 'lost-dispatch')
    await pool.query(
      `UPDATE pe_stdio_mcp_calls SET state='dispatch-intent',pod_uid=$2,runner_instance_id=$3,
       dispatch_digest=$4 WHERE id=$1`,
      [recovering.callId, randomUUID(), randomUUID(), 'a'.repeat(64)])
    stdio.start()
    const uncertain = await eventually(() => stdio.status(alice, recovering.callId),
      status => status.state === 'uncertain')
    assert.equal(uncertain.errorCode, 'stdio_mcp_outcome_unknown')
    assert.equal(runner.posts, 1, 'reclaimed dispatch intent must not issue another POST')
    await tasks.finish(recoveryGrant.token, 'completed', null)
    const recoveryContinuation = await tasks.claim(randomUUID())
    assert.equal(recoveryContinuation.sourceStdioMcpCallId, recovering.callId)
    assert.match(recoveryContinuation.text, /结果不明/u)
    await tasks.finish(recoveryContinuation.token, 'completed', null)
  })

test('real PG fence orders connection disable with intent and the first Runner POST',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_stdio_fence_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let pool, created = false, stdio
    const resumeIntent = deferred(), resumeDispatch = deferred(), resumeBeforeIntent = deferred()
    t.after(async () => {
      resumeIntent.resolve(); resumeDispatch.resolve(); resumeBeforeIntent.resolve()
      await stdio?.close()
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    const user = identity.parse({ userId: randomUUID(), username: 'alice' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(migrations.schema)
      await client.query('INSERT INTO pe_schema(version) VALUES(1)')
      await client.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      for (let version = 2; version <= 19; version++) await client.query(migrations[`schemaV${version}`])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    await initializeDatabase(pool)
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30_000, maxPendingPerUser: 8,
      maxActivePerUser: 1, stdioMcpEnabled: true })
    const runner = new FixtureRunner()
    stdio = new PausingStdioMcpService(tasks, runner, randomUUID(), 30_000, 100)
    const connection = await stdio.install(user, randomUUID(), 'Fenced process MCP')
    const session = await tasks.create(user, randomUUID())
    const first = await tasks.accept(user, session.sessionId, randomUUID(), 'Call before disable')
    const grant = await tasks.claim(randomUUID())
    const call = await stdio.call(grant.token, connection.connectionId, 1, 'before-disable')
    const intentReached = deferred()
    stdio.afterIntent = async () => { intentReached.resolve(); await resumeIntent.promise }
    stdio.start()
    await reached(intentReached.promise, 'persisted intent')
    assert.equal((await pool.query('SELECT state FROM pe_stdio_mcp_calls WHERE id=$1',
      [call.callId])).rows[0].state, 'dispatch-intent')
    const disabled = await stdio.toggle(user, connection.connectionId, randomUUID(), 1, false)
    assert.equal(disabled.revision, 2)
    resumeIntent.resolve()
    const revoked = await eventually(() => stdio.status(user, call.callId),
      value => value.state === 'failed')
    assert.equal(revoked.errorCode, 'stdio_mcp_connection_revoked')
    assert.equal(runner.posts, 0, 'disable committed before the first POST')
    assert.equal((await pool.query('SELECT dispatch_digest FROM pe_stdio_mcp_calls WHERE id=$1',
      [call.callId])).rows[0].dispatch_digest?.length, 64)
    await tasks.finish(grant.token, 'completed', null)
    const firstContinuation = await tasks.claim(randomUUID())
    assert.equal(firstContinuation.sourceStdioMcpCallId, call.callId)
    await tasks.finish(firstContinuation.token, 'completed', null)

    const enabled = await stdio.toggle(user, connection.connectionId, randomUUID(), 2, true)
    assert.equal(enabled.revision, 3)
    stdio.afterIntent = undefined
    const dispatchReached = deferred()
    runner.beforeDispatch = async () => { dispatchReached.resolve(); await resumeDispatch.promise }
    const second = await tasks.accept(user, session.sessionId, randomUUID(), 'Call while disabling')
    const secondGrant = await tasks.claim(randomUUID())
    const secondCall = await stdio.call(secondGrant.token, connection.connectionId, 3, 'during-disable')
    await reached(dispatchReached.promise, 'first Runner POST')
    const toggle = stdio.toggle(user, connection.connectionId, randomUUID(), 3, false)
    await eventually(async () => Number((await pool.query(
      `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
       AND state='active' AND wait_event_type='Lock'
       AND query LIKE '%pe_stdio_mcp_connections%' AND query LIKE '%FOR UPDATE%'`,
    )).rows[0].count))
    assert.equal(await Promise.race([toggle.then(() => 'committed'),
      new Promise(resolve => setTimeout(() => resolve('waiting'), 150))]), 'waiting',
    'disable must wait for the fenced first POST')
    assert.equal(runner.posts, 0)
    resumeDispatch.resolve()
    const completed = await eventually(() => stdio.status(user, secondCall.callId),
      value => value.state === 'succeeded')
    assert.equal(completed.result, `user:${user.userId}`)
    assert.equal(runner.posts, 1)
    assert.equal((await toggle).revision, 4)
    await tasks.finish(secondGrant.token, 'completed', null)
    const secondContinuation = await tasks.claim(randomUUID())
    assert.equal(secondContinuation.sourceStdioMcpCallId, secondCall.callId)
    await tasks.finish(secondContinuation.token, 'completed', null)
    assert.notEqual(first.operationId, second.operationId)

    const reenabled = await stdio.toggle(user, connection.connectionId, randomUUID(), 4, true)
    assert.equal(reenabled.revision, 5)
    runner.beforeDispatch = undefined
    const beforeIntentReached = deferred()
    stdio.beforeIntent = async () => { beforeIntentReached.resolve(); await resumeBeforeIntent.promise }
    await tasks.accept(user, session.sessionId, randomUUID(), 'Disable before intent')
    const thirdGrant = await tasks.claim(randomUUID())
    const thirdCall = await stdio.call(thirdGrant.token, connection.connectionId, 5, 'no-intent')
    await reached(beforeIntentReached.promise, 'pre-intent pause')
    const disabledBeforeIntent = await stdio.toggle(user, connection.connectionId, randomUUID(), 5, false)
    assert.equal(disabledBeforeIntent.revision, 6)
    resumeBeforeIntent.resolve()
    const beforeIntentResult = await eventually(() => stdio.status(user, thirdCall.callId),
      value => value.state === 'failed')
    assert.equal(beforeIntentResult.errorCode, 'stdio_mcp_connection_revoked')
    assert.equal(runner.posts, 1)
    assert.equal((await pool.query('SELECT dispatch_digest FROM pe_stdio_mcp_calls WHERE id=$1',
      [thirdCall.callId])).rows[0].dispatch_digest, null,
    'disable committed before intent leaves no dispatch marker')
    await tasks.finish(thirdGrant.token, 'completed', null)
    const thirdContinuation = await tasks.claim(randomUUID())
    assert.equal(thirdContinuation.sourceStdioMcpCallId, thirdCall.callId)
    await tasks.finish(thirdContinuation.token, 'completed', null)
  })
