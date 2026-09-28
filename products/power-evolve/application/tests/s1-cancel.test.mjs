/** Durable Session cancellation and lease fencing against real PostgreSQL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { TaskStore } from '../lib/platform/tasks.js'
import { EventStore } from '../lib/platform/events.js'
import { initializeDatabase } from '../lib/platform/database.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))

async function eventually(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25) }
  throw new Error(`Timed out: ${label}`)
}

test('cancel owns one Session, survives grant replacement, and permits the next input', { timeout: 30000 }, async t => {
  const database = `pe_test_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  const pool = new Pool({ connectionString: url.href, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end() })
  await initializeDatabase(pool)
  const users = [{ userId: randomUUID(), username: 'alice' }, { userId: randomUUID(), username: 'bob' }]
  for (const user of users) await pool.query(
    'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'unused', {}])
  const [alice, bob] = users
  const config = { model: 'fixture', maxTokens: 64, revision: 1 }
  const tasks = new TaskStore(pool, { leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
  const events = new EventStore(tasks, { maxHistoryBytes: 1024 * 1024, maxHistoryEvents: 100,
    maxEventBytes: 64 * 1024 })
  const { sessionId } = await tasks.create(alice, randomUUID())

  assert.deepEqual(await tasks.cancel(alice, sessionId), { accepted: true }, 'no active turn is a no-op')
  await assert.rejects(tasks.cancel(bob, sessionId), /session_not_found/)
  const queuedRequest = randomUUID()
  const queued = await tasks.accept(alice, sessionId, queuedRequest, 'queued', config)
  assert.equal(queued.state, 'queued')
  assert.deepEqual(await tasks.cancel(alice, sessionId), { accepted: true })
  assert.deepEqual(await tasks.cancel(alice, sessionId), { accepted: true }, 'repeating a settled cancellation is a no-op')
  assert.equal((await tasks.accept(alice, sessionId, queuedRequest, 'queued', config)).state, 'failed')
  assert.equal((await pool.query('SELECT state,error_code,attempts FROM pe_operations WHERE id=$1',
    [queued.operationId])).rows[0].error_code, 'turn_user')
  assert.equal(await tasks.claim(randomUUID()), null, 'a cancelled queued input never starts')

  const running = await tasks.accept(alice, sessionId, randomUUID(), 'running', config)
  const old = await tasks.claim(randomUUID())
  assert.equal(old.operationId, running.operationId)
  await assert.rejects(tasks.cancel(bob, sessionId), /session_not_found/)
  assert.deepEqual(await tasks.cancel(alice, sessionId), { accepted: true })
  assert.deepEqual(await tasks.cancel(alice, sessionId), { accepted: true })
  assert.deepEqual(await tasks.renew(old.token), { cancelRequested: true })
  assert.equal((await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1',
    [running.operationId])).rows[0].error_code, 'cancel_requested')

  await pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1", [sessionId])
  const replacement = await tasks.claim(randomUUID())
  assert.equal(replacement.operationId, running.operationId)
  assert.equal(replacement.epoch, old.epoch + 1)
  await assert.rejects(tasks.renew(old.token), /lease_lost/)
  await assert.rejects(events.append(old.token, []), /lease_lost/)
  await assert.rejects(tasks.finish(old.token, 'completed', null), /lease_lost/)
  assert.deepEqual(await tasks.renew(replacement.token), { cancelRequested: true })
  await tasks.finish(replacement.token, 'completed', null)
  assert.deepEqual((await pool.query('SELECT state,error_code,attempts FROM pe_operations WHERE id=$1',
    [running.operationId])).rows[0], { state: 'completed', error_code: null, attempts: 2 },
  'a native turn that completed before cancellation was observed remains completed')

  const stopped = await tasks.accept(alice, sessionId, randomUUID(), 'stop me', config)
  const stoppedGrant = await tasks.claim(randomUUID())
  assert.equal(stoppedGrant.operationId, stopped.operationId)
  await tasks.cancel(alice, sessionId)
  await tasks.finish(stoppedGrant.token, 'failed', 'turn_aborted')
  assert.deepEqual((await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1',
    [stopped.operationId])).rows[0], { state: 'failed', error_code: 'turn_user' })

  const limited = await tasks.accept(alice, sessionId, randomUUID(), 'too long', config)
  const limitedGrant = await tasks.claim(randomUUID())
  await tasks.cancel(alice, sessionId)
  await tasks.finish(limitedGrant.token, 'failed', 'turn_max-tokens')
  assert.deepEqual((await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1',
    [limited.operationId])).rows[0], { state: 'failed', error_code: 'turn_max-tokens' })

  const next = await tasks.accept(alice, sessionId, randomUUID(), 'after stop', config)
  const nextGrant = await tasks.claim(randomUUID())
  assert.equal(nextGrant.operationId, next.operationId)
  assert.deepEqual(await tasks.renew(nextGrant.token), { cancelRequested: false })
  await tasks.finish(nextGrant.token, 'completed', null)
  assert.equal((await pool.query('SELECT state FROM pe_operations WHERE id=$1', [next.operationId])).rows[0].state,
    'completed')
})

test('cancel and finish serialize without losing a completed or cancelled turn', { timeout: 30000 }, async t => {
  const database = `pe_test_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  const pool = new Pool({ connectionString: url.href, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end() })
  await initializeDatabase(pool)
  const alice = { userId: randomUUID(), username: 'alice' }
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [alice.userId, alice.username, 'unused', {}])
  const tasks = new TaskStore(pool, { leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
  const { sessionId } = await tasks.create(alice, randomUUID())
  const accepted = await tasks.accept(alice, sessionId, randomUUID(), 'race',
    { model: 'fixture', maxTokens: 64, revision: 1 })
  const grant = await tasks.claim(randomUUID())
  await Promise.all([tasks.cancel(alice, sessionId), tasks.finish(grant.token, 'completed', null)])
  const row = (await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1',
    [accepted.operationId])).rows[0]
  assert.deepEqual(row, { state: 'completed', error_code: null })
  assert.deepEqual(await tasks.cancel(alice, sessionId), { accepted: true })
  assert.equal((await pool.query('SELECT grant_digest FROM pe_sessions WHERE id=$1', [sessionId])).rows[0].grant_digest, null)
})

test('native stop crosses hosts and leaves the Session usable', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-s1-cancel-'))
  const database = `pe_test_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool, model, platform, hostA, hostB, created = false
  const children = new Set()
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000)
    try { await exited } finally { clearTimeout(deadline); children.delete(child) }
  }
  t.after(async () => {
    for (const child of children) await stop(child)
    if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) }
    await pool?.end()
    if (created) {
      await eventually(async () => Number((await admin.query(
        'SELECT count(*) FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].count) === 0,
      'connections closed')
      await admin.query(`DROP DATABASE "${database}"`)
    }
    await admin.end()
    await rm(temporary, { recursive: true, force: true })
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 5 })
  const users = ['alice', 'bob'].map(username => ({ username,
    password: randomBytes(20).toString('base64url'),
    settings: { model: 'fixture', maxTokens: 64, revision: 1 } }))
  const workerToken = randomBytes(32).toString('base64url')
  const providerKey = randomBytes(32).toString('base64url')
  const connectorKey = randomBytes(32).toString('base64url')
  for (const [name, value] of Object.entries({ 'database-url': url.href, 'worker-token': workerToken,
    'model-key': providerKey, 'connector-key': connectorKey, 'users.json': JSON.stringify(users) })) {
    await writeFile(join(temporary, name), value, { mode: 0o600 })
  }
  const started = Promise.withResolvers()
  const modelPrompts = []
  model = createServer(async (request, response) => {
    try {
      assert.equal(request.headers['x-api-key'], providerKey)
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString())
      const prompt = body.messages.at(-1).content.filter(part => part.type === 'text').map(part => part.text).join('')
      modelPrompts.push(prompt)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: randomUUID(), model: body.model,
        usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' } })}\n\n`)
      if (prompt === 'HOLD') {
        started.resolve()
        await once(response, 'close')
        return
      }
      for (const event of [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `reply:${prompt}` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end()
    } catch (_closedOrInvalidRequest) { response.destroy() }
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1/messages`

  async function start(name, instance, platformUrl = '') {
    const home = join(temporary, instance), profile = join(home, 'profiles', `power-evolve-${instance}`)
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
      dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
    const bundle = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'),
      { schema: manifestSchema })
    const rows = bundle[0].insert
    const readyFile = join(home, 'ready.json')
    const update = (id, fields) => ({ id, config: { ...rows.find(row => row.id === id).config, ...fields } })
    const patch = [update('web-server', { port: 0 })]
    if (name === 'platform') patch.push(update('power-evolve-platform', {
      databaseUrlFile: join(temporary, 'database-url'), workerTokenFile: join(temporary, 'worker-token'),
      modelKeyFile: join(temporary, 'model-key'), connectorKeyFile: join(temporary, 'connector-key'),
      seedUsersFile: join(temporary, 'users.json'), readyFile, modelUrl, connectorUrl: modelUrl,
      leaseMs: 3000, loginAttemptsPerWindow: 100, maxPendingPerUser: 8,
      workspaceRoot: join(temporary, 'workspaces'), sandboxKubeconfigFile: '', sandboxKeyFile: '',
      sandboxNamespace: '', sandboxImage: '', sandboxLocalRoot: '', sandboxNodeRoot: '',
    }))
    else patch.push(update('power-evolve-runtime', { platformUrl,
      workerTokenFile: join(temporary, 'worker-token') }),
    update('power-evolve-host', { platformOrigin: platformUrl, readyFile, renewMs: 100,
      operationTimeoutMs: 20000, pollMs: 50 }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const log = openSync(join(temporary, `${instance}.log`), 'a', 0o600)
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', `power-evolve-${instance}`],
      { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME,
        DSH_HOME: home, PE_PRIVATE_DIR: temporary }, stdio: ['ignore', log, log] })
    closeSync(log); children.add(child)
    const ready = await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${instance} exited before ready: ${await readFile(join(temporary, `${instance}.log`), 'utf8')}`)
      }
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    }, `${instance} ready`)
    assert.equal((await fetch(`${ready.url}/health`)).status, 200)
    return { process: child, url: ready.url }
  }
  platform = await start('platform', 'platform')
  hostA = await start('host', 'host-a', platform.url)
  const tokens = []
  for (const user of users) {
    const response = await fetch(`${platform.url}/identity/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password }) })
    assert.equal(response.status, 200)
    tokens.push((await response.json()).token)
  }
  const native = async (host, user, method, args, rpcId = randomUUID()) => {
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(`${host.url}/native/api/${method}`, { method: 'POST',
        headers: { authorization: `Bearer ${tokens[user]}`, host: '127.0.0.1:18880',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, value => {
        const chunks = []
        value.on('data', chunk => chunks.push(chunk))
        value.on('end', () => resolve({ status: value.statusCode, body: Buffer.concat(chunks).toString() }))
      })
      request.on('error', reject)
      request.end(body)
    })
    assert.equal(response.status, 200)
    const envelope = JSON.parse(response.body)
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.rpcId, rpcId)
    return envelope.result
  }

  const createdSession = await native(hostA, 0, 'session/create', { request: {} })
  assert.equal(createdSession.ok, true)
  const sessionId = createdSession.value.sessionId
  const holdId = randomUUID()
  assert.equal((await native(hostA, 0, 'session/prompt', { request: {
    sessionId, requestId: holdId, mode: 'queue', content: [{ type: 'text', text: 'HOLD' }],
  } })).value.accepted, true)
  await started.promise
  hostB = await start('host', 'host-b', platform.url)
  const denied = await native(hostB, 1, 'session/cancel', { request: { sessionId } })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'session/not-found')
  for (let i = 0; i < 2; i++) {
    const stopped = await native(hostB, 0, 'session/cancel', { request: { sessionId } })
    assert.deepEqual(stopped, { ok: true, value: { accepted: true } })
  }
  await eventually(async () => {
    const result = await pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1 AND request_id=$2',
      [sessionId, holdId])
    return result.rows[0]?.state === 'failed' && result.rows[0].error_code === 'turn_user'
  }, 'cross-host stop settles the running turn')
  const cancelledEvents = await pool.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [sessionId])
  assert(cancelledEvents.rows.some(row => row.event.type === 'turn/end'
    && row.event.data.reason.kind === 'aborted'),
  JSON.stringify(cancelledEvents.rows.map(row => [row.event.type, row.event.data?.reason])))
  const nextId = randomUUID()
  assert.equal((await native(hostB, 0, 'session/prompt', { request: {
    sessionId, requestId: nextId, mode: 'queue', content: [{ type: 'text', text: 'AFTER' }],
  } })).value.accepted, true)
  await eventually(async () => {
    const result = await pool.query('SELECT state FROM pe_operations WHERE session_id=$1 AND request_id=$2',
      [sessionId, nextId])
    return result.rows[0]?.state === 'completed'
  }, 'post-cancel conversation')
  const snapshot = await native(hostB, 0, 'session/list', { _request: {} })
  assert.equal(snapshot.ok, true)
  assert(snapshot.value.items.some(item => item.sessionId === sessionId))
  assert.deepEqual(await native(hostB, 0, 'session/cancel', { request: { sessionId } }),
    { ok: true, value: { accepted: true } })

  await stop(hostA.process); await stop(hostB.process)
  const unstartedId = randomUUID()
  const pending = await fetch(`${platform.url}/sessions/prompt`, { method: 'POST', headers: {
    authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ sessionId, requestId: unstartedId, text: 'NEVER_RUN' }) })
  assert.equal(pending.status, 200)
  const claimed = await fetch(`${platform.url}/runtime/claim`, { method: 'POST', headers: {
    authorization: `Bearer ${workerToken}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ workerId: randomUUID() }) })
  assert.equal(claimed.status, 200)
  assert.equal((await claimed.json()).requestId, unstartedId)
  const cancelPending = await fetch(`${platform.url}/sessions/cancel`, { method: 'POST', headers: {
    authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ sessionId }) })
  assert.equal(cancelPending.status, 200)
  await pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1", [sessionId])
  const replacement = await start('host', 'host-replacement', platform.url)
  await eventually(async () => {
    const result = await pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1 AND request_id=$2',
      [sessionId, unstartedId])
    return result.rows[0]?.state === 'failed' && result.rows[0].error_code === 'turn_user'
  }, 'replacement settles cancelled input before model start')
  assert(!modelPrompts.includes('NEVER_RUN'))
  const recoveredId = randomUUID()
  assert.equal((await native(replacement, 0, 'session/prompt', { request: {
    sessionId, requestId: recoveredId, mode: 'queue', content: [{ type: 'text', text: 'RECOVERED' }],
  } })).value.accepted, true)
  await eventually(async () => {
    const result = await pool.query('SELECT state FROM pe_operations WHERE session_id=$1 AND request_id=$2',
      [sessionId, recoveredId])
    return result.rows[0]?.state === 'completed'
  }, 'continuation after cancelled grant replacement')
})
