/** Real PG, native Agent lifecycle and product persistence; only the model adapter and API transport are fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentLoop from '../../../../packages/core/agent-loop/lib/index.js'
import { identity, PlatformError } from '../lib/contracts.js'
import PlatformPersistence from '../lib/host/persistence.js'
import * as platformModel from '../lib/host/model.js'
import { Scheduler } from '../lib/host/scheduler.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { EventStore } from '../lib/platform/events.js'
import { taskCredential } from './task-credential-fixture.mjs'

// Explicit opt-in prevents fallback to any live product configuration or QA database.
const databaseUrl = process.env.PE_TEST_DATABASE_URL
const options = { skip: !databaseUrl, timeout: 30_000 }

async function fixture(t, mode = 'normal', cleanupError) {
  const parsed = new URL(databaseUrl)
  assert.ok(!/^pe_(report_workflow|formal_restored)/u.test(parsed.pathname.slice(1)), 'Refuse a live QA database')
  const database = `pe_host_settlement_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: parsed.href, max: 1, connectionTimeoutMillis: 5000 })
  let pool, root, ctx, scheduler, modelServer, created = false
  t.after(async () => {
    try { await scheduler?.close() }
    finally {
      try { await root?.fiber.dispose() }
      finally {
        if (modelServer) {
          modelServer.closeAllConnections()
          await new Promise(resolve => modelServer.close(resolve))
        }
        await pool?.end()
        try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
        finally { await admin.end() }
      }
    }
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  parsed.pathname = `/${database}`
  pool = new Pool({ connectionString: parsed.href, max: 5, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 6000 })
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database)
  await initializeDatabase(pool)
  const user = identity.parse({ userId: randomUUID(), username: 'settlement-fixture' })
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'synthetic-only', { model: 'deepseek-flash', maxTokens: 64, revision: 1 }])
  await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,$2,$2,64)', [user.userId, 'deepseek-flash'])
  const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30000,
    maxPendingPerUser: 8, maxActivePerUser: 1 })
  const credential = await taskCredential(pool, user)
  const { sessionId } = await tasks.create(user, randomUUID(), credential)
  await tasks.accept(user, sessionId, randomUUID(), 'Synthetic settlement fixture', credential)
  const grant = await tasks.claim(randomUUID())
  const quota = mode === 'quota' || mode === 'wrapped-quota' || mode === 'ambiguous'
  const events = new EventStore(tasks, { maxHistoryBytes: quota ? 16384 : 131072,
    maxHistoryEvents: 1000, maxEventBytes: 524288 })
  const observed = { paths: [], finish: [], dispose: 0, closeFailures: 0, modelCalls: 0, firstError: undefined }
  const grants = new Map()
  let replacement, injected = false
  modelServer = createServer(async (request, response) => {
    for await (const _chunk of request) { /* The fixture never records request content or credentials. */ }
    observed.modelCalls++
    const text = quota ? 'x'.repeat(20000) : 'done'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-flash',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  await new Promise((resolve, reject) => {
    modelServer.once('error', reject)
    modelServer.listen(0, '127.0.0.1', resolve)
  })
  const platformUrl = `http://127.0.0.1:${modelServer.address().port}`
  class Runtime extends Service {
    workerId = randomUUID()
    grants = grants
    config = { platformUrl }
    constructor(context) { super(context, 'powerEvolveRuntime') }
    require(id) {
      const selected = this.grants.get(id)
      if (!selected) throw new PlatformError(403, 'session_not_leased')
      return selected
    }
    async call(path, token, body) {
      observed.paths.push(path)
      if (path === '/runtime/renew') return tasks.renew(token)
      if (path === '/runtime/snapshot') return events.runtimeSnapshot(token)
      if (path === '/runtime/finish') {
        observed.finish.push(body)
        return tasks.finish(token, body.outcome, body.errorCode)
      }
      if (path === '/runtime/append') {
        const assistant = body.events.some(event => event.type === 'assistant/message')
        if (!injected && assistant && mode === 'replaced-lease') {
          injected = true
          await pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 second\' WHERE id=$1', [sessionId])
          replacement = await tasks.claim(randomUUID())
          this.grants.set(sessionId, replacement)
        }
        if (assistant && (mode === 'conflict' || mode === 'unknown')) {
          observed.firstError ??= mode === 'conflict' ? new PlatformError(409, 'event_conflict') : new Error('synthetic private detail')
          throw observed.firstError
        }
        try { return await events.append(token, body.events) }
        catch (error) {
          observed.firstError ??= error
          if (mode === 'wrapped-quota') throw new AggregateError([new Error('synthetic wrapper', { cause: error })])
          if (mode === 'ambiguous') throw new AggregateError([error, new PlatformError(409, 'event_conflict')])
          throw error
        }
      }
      throw new Error('Unexpected fixture API route')
    }
  }
  root = new Context()
  await root.plugin(Runtime)
  await root.plugin(LlmRuntime)
  await root.plugin(SessionStore)
  await root.plugin(SessionProjectionRegistry)
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(AgentRegistry)
  await root.plugin(SkillRegistry)
  await root.plugin(PlatformPersistence)
  await root.plugin(platformModel, { streamIdleTimeoutMs: 120000 })
  await root.plugin(AgentLoop, { agents: [] })
  await root.inject(['powerEvolveRuntime', 'sessions', 'sessionPersistence', 'llm', 'agents', 'agentLoop'], selected => { ctx = selected })
  const resume = ctx.agents.resume.bind(ctx.agents)
  ctx.agents.resume = async input => {
    const handle = await resume(input)
    return { agent: handle.agent, async dispose() {
      observed.dispose++
      try { await handle.dispose() }
      catch (error) {
        observed.closeFailures++
        throw cleanupError ?? error
      }
    } }
  }
  scheduler = new Scheduler(ctx, { platformOrigin: 'http://127.0.0.1:18881', concurrency: 1,
    pollMs: 500, renewMs: 8000, operationTimeoutMs: 150000 })
  const operation = async () => (await pool.query('SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [grant.operationId])).rows[0]
  const lease = async () => (await pool.query('SELECT lease_epoch,lease_until,grant_digest FROM pe_sessions WHERE id=$1', [sessionId])).rows[0]
  return { ctx, scheduler, grant, sessionId, tasks, pool, observed, operation, lease,
    replacement: () => replacement }
}

async function released(f) {
  assert.equal(f.ctx.powerEvolveRuntime.grants.size, 0)
  assert.equal(f.scheduler.handles.size, 0)
  assert.equal(f.ctx.sessions.get(f.sessionId), undefined)
  assert.deepEqual(await f.tasks.claim(randomUUID()), null, 'Settled work must not become a recovery attempt')
  const row = await f.lease()
  assert.equal(row.lease_until, null)
  assert.equal(row.grant_digest, null)
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM pe_attempts WHERE operation_id=$1 AND ended_at IS NULL',
    [f.grant.operationId])).rows[0].count, 0)
}

for (const mode of ['quota', 'wrapped-quota']) test(`${mode}: real capped append and native close failure still settle once`, options, async t => {
  const f = await fixture(t, mode)
  await assert.rejects(f.scheduler.run(f.grant), error => mode === 'quota'
    ? error === f.observed.firstError : error instanceof AggregateError)
  assert.equal(f.observed.firstError.code, 'history_limit')
  assert.equal(f.observed.firstError.status, 413)
  assert.deepEqual(f.observed.finish, [{ outcome: 'failed', errorCode: 'history_limit' }])
  assert.equal(f.observed.modelCalls, 1)
  assert.equal(f.observed.dispose, 1)
  assert.equal(f.observed.closeFailures, 1)
  assert.deepEqual(await f.operation(), { state: 'failed', error_code: 'history_limit', attempts: 1 })
  await released(f)
})

test('secondary disposal failure does not replace the first quota failure', options, async t => {
  const f = await fixture(t, 'quota', new PlatformError(503, 'cleanup_unavailable'))
  await assert.rejects(f.scheduler.run(f.grant), error => error === f.observed.firstError)
  assert.deepEqual(f.observed.finish, [{ outcome: 'failed', errorCode: 'history_limit' }])
  assert.equal(f.observed.closeFailures, 1)
  await released(f)
})

for (const [mode, code] of [['conflict', 'event_conflict'], ['unknown', 'runtime_error'], ['ambiguous', 'runtime_error']]) {
  test(`${mode}: persistence failure cannot be completed or expose an arbitrary message as code`, options, async t => {
    const f = await fixture(t, mode)
    await assert.rejects(f.scheduler.run(f.grant))
    assert.deepEqual(f.observed.finish, [{ outcome: 'failed', errorCode: code }])
    assert.deepEqual(await f.operation(), { state: 'failed', error_code: code, attempts: 1 })
    assert.equal(f.observed.dispose, 1)
    await released(f)
  })
}

test('a replaced grant cannot settle or erase the replacement grant during cleanup', options, async t => {
  const f = await fixture(t, 'replaced-lease')
  await assert.rejects(f.scheduler.run(f.grant), { code: 'lease_lost' })
  assert.deepEqual(f.observed.finish, [{ outcome: 'failed', errorCode: 'lease_lost' }])
  assert.equal(f.ctx.powerEvolveRuntime.grants.get(f.sessionId), f.replacement())
  assert.deepEqual(await f.operation(), { state: 'running', error_code: null, attempts: 2 })
  assert.deepEqual(await f.tasks.renew(f.replacement().token), { cancelRequested: false })
  await assert.rejects(f.tasks.finish(f.grant.token, 'completed', null), { code: 'lease_lost' })
  await f.tasks.finish(f.replacement().token, 'failed', 'fixture_cleanup')
  f.ctx.powerEvolveRuntime.grants.delete(f.sessionId)
  assert.equal(f.scheduler.handles.size, 0)
})

test('normal native work still flushes, closes and settles completed once', options, async t => {
  const f = await fixture(t)
  await f.scheduler.run(f.grant)
  assert.equal(f.observed.modelCalls, 1)
  assert.equal(f.observed.dispose, 1)
  assert.equal(f.observed.closeFailures, 0)
  assert.deepEqual(f.observed.finish, [{ outcome: 'completed', errorCode: null }])
  assert.deepEqual(await f.operation(), { state: 'completed', error_code: null, attempts: 1 })
  await released(f)
})

test('a released writer rejects a durability flush instead of silently succeeding', options, async t => {
  const f = await fixture(t)
  await f.scheduler.run(f.grant)
  const session = f.ctx.sessions.prepare(f.sessionId)
  const detach = f.ctx.sessions.enter(session)
  t.after(detach)
  await assert.rejects(f.ctx.sessions.flush(session), { status: 403, code: 'session_not_leased' })
  detach()
  assert.equal(f.observed.finish.length, 1)
  await released(f)
})
