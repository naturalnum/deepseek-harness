/** S6 built-in Notes plugin state, authorization, and reconciliation against real PostgreSQL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { PluginService } from '../lib/platform/plugins.js'
import { ConnectorService } from '../lib/platform/connectors.js'
import { TaskStore } from '../lib/platform/tasks.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function eventually(check, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('S6 Notes plugin migrates, isolates users, fences egress, and reconciles a lost response',
  { timeout: 45_000 }, async t => {
    const database = `pe_s6_notes_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let pool, target, worker
    t.after(async () => {
      await worker?.close()
      target?.closeAllConnections()
      if (target) await new Promise(resolve => target.close(resolve))
      await pool?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
    const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(migrations.schema)
      await client.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (const user of [alice, bob]) await client.query(
        'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      for (let version = 2; version <= 12; version++) await client.query(migrations[`schemaV${version}`])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }

    await initializeDatabase(pool)
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 20)
    const plugins = new PluginService(pool)
    const expected = { id: 'notes', title: '受控便签', category: 'tools', kind: 'builtin',
      enabled: true, revision: 1, requiresApproval: true }
    assert.deepEqual(await plugins.list(alice), { items: [expected] })
    assert.deepEqual(await plugins.list(bob), { items: [expected] })
    const first = { requestId: randomUUID(), expectedRevision: 1, enabled: false }
    assert.deepEqual(await plugins.notesSetEnabled(alice, first), { ...expected, enabled: false, revision: 2 })
    assert.deepEqual(await plugins.notesSetEnabled(alice, first), { ...expected, enabled: false, revision: 2 })
    await assert.rejects(plugins.notesSetEnabled(alice, { ...first, enabled: true }),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(plugins.notesSetEnabled(alice,
      { requestId: randomUUID(), expectedRevision: 1, enabled: true }),
    { status: 409, code: 'plugin_revision_conflict' })
    assert.deepEqual(await plugins.list(bob), { items: [expected] })
    await plugins.seedUsers(['alice', 'bob'])
    await initializeDatabase(pool)
    assert.deepEqual(await new PluginService(pool).list(alice),
      { items: [{ ...expected, enabled: false, revision: 2 }] })

    const notes = new Map()
    let posts = 0, reads = 0, dropPostOnce = false
    target = createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer fixture-secret') { res.writeHead(401).end(); return }
      const route = new URL(req.url, 'http://target')
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.method === 'GET' && route.pathname === '/v1/notes') {
        reads++
        send(200, { items: [...notes.values()].filter(note => note.owner === route.searchParams.get('owner')) })
      } else if (req.method === 'GET' && route.pathname.startsWith('/v1/actions/')) {
        const found = notes.get(route.pathname.slice('/v1/actions/'.length))
        if (found) send(200, found)
        else send(404, { error: 'missing' })
      } else if (req.method === 'POST' && route.pathname === '/v1/notes') {
        let body = ''
        for await (const chunk of req) body += chunk
        const request = JSON.parse(body), actionId = req.headers['idempotency-key']
        if (!notes.has(actionId)) {
          posts++
          notes.set(actionId, { actionId, owner: request.owner, text: request.text,
            createdAt: new Date().toISOString() })
        }
        if (dropPostOnce) { dropPostOnce = false; res.destroy(); return }
        send(200, notes.get(actionId))
      } else send(404, { error: 'missing' })
    })
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
    const targetUrl = `http://127.0.0.1:${target.address().port}`
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 })
    worker = new ConnectorService(tasks, targetUrl, 'fixture-secret', 1000, 100)
    await worker.seedPermissions(['alice', 'bob'])
    const session = await tasks.create(alice, randomUUID())
    await tasks.accept(alice, session.sessionId, randomUUID(), 'notes plugin test')
    const grant = await tasks.claim(randomUUID())
    assert.equal(grant.userId, alice.userId)
    await assert.rejects(worker.notes(grant.token), { status: 403, code: 'plugin_disabled' })
    await assert.rejects(worker.prepare(grant.token, 'disabled-call', 'blocked'),
      { status: 403, code: 'plugin_disabled' })
    assert.equal(reads, 0)
    assert.equal(posts, 0)

    const enabled = await plugins.notesSetEnabled(alice,
      { requestId: randomUUID(), expectedRevision: 2, enabled: true })
    assert.equal(enabled.revision, 3)
    assert.deepEqual(await worker.notes(grant.token), { items: [] })
    assert.equal(reads, 1)
    const pending = await worker.prepare(grant.token, 'approval-then-disable', 'must not write')
    await worker.decide(alice, pending.actionId, pending.fingerprint, true)
    await plugins.notesSetEnabled(alice, { requestId: randomUUID(), expectedRevision: 3, enabled: false })
    worker.start()
    await eventually(async () => {
      const row = (await worker.list(alice)).items.find(item => item.actionId === pending.actionId)
      return row?.state === 'failed' && row.errorCode === 'plugin_disabled'
    }, 'disabled approved action')
    assert.equal(posts, 0)
    assert.deepEqual((await worker.list(bob)).items, [])

    await plugins.notesSetEnabled(alice, { requestId: randomUUID(), expectedRevision: 4, enabled: true })
    dropPostOnce = true
    const uncertain = await worker.prepare(grant.token, 'lost-response', 'write once')
    await worker.decide(alice, uncertain.actionId, uncertain.fingerprint, true)
    await eventually(async () => (await worker.list(alice)).items.some(item =>
      item.actionId === uncertain.actionId && item.state === 'uncertain'), 'uncertain remote result')
    assert.equal(posts, 1)
    await worker.close(); worker = new ConnectorService(tasks, targetUrl, 'fixture-secret', 1000, 100)
    worker.start()
    await eventually(async () => (await worker.list(alice)).items.some(item =>
      item.actionId === uncertain.actionId && item.state === 'succeeded'), 'reconciled remote result')
    assert.equal(posts, 1)
    assert.equal(notes.get(uncertain.actionId).owner, alice.userId)
    assert.deepEqual(await plugins.list(bob), { items: [expected] })
  })
