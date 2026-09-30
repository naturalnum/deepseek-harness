/** Multi-worker admission and user-fair scheduling against real PostgreSQL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { initializeDatabase } from '../lib/platform/database.js'
import { TaskFixtureStore as TaskStore } from './task-credential-fixture.mjs'
import { writeLine } from '../lib/http.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('event output waits for socket drain and aborts on disconnect', async () => {
  const response = new EventEmitter()
  const written = []
  response.write = value => { written.push(value); return written.length > 1 }
  const controller = new AbortController()
  const stream = (async () => {
    await writeLine(response, { seq: 1 }, controller.signal)
    await writeLine(response, { seq: 2 }, controller.signal)
  })()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(written.length, 1, 'a slow client must stop production of the next item')
  response.emit('drain')
  await stream
  assert.equal(written.length, 2)

  const disconnected = new EventEmitter()
  disconnected.write = () => false
  const cancelled = new AbortController()
  const pending = writeLine(disconnected, { seq: 3 }, cancelled.signal)
  cancelled.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('two workers fence sessions and rotate eligible users', { timeout: 30000 }, async t => {
  const database = `pe_test_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  const pool = new Pool({ connectionString: url.href, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end() })
  await initializeDatabase(pool)
  const [alice, bob] = [randomUUID(), randomUUID()]
  await pool.query(`INSERT INTO pe_users(id,username,password_hash,settings) VALUES
    ($1,'alice','unused','{}'),($2,'bob','unused','{}')`, [alice, bob])
  const workspaceIds = new Map([[alice, randomUUID()], [bob, randomUUID()]])
  for (const [userId, workspaceId] of workspaceIds) await pool.query(
    `INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)`,
    [workspaceId, userId])
  const operations = []
  for (const [userId, tag, seconds] of [[alice, 'a1', 1], [alice, 'a2', 2], [bob, 'b1', 3]]) {
    const sessionId = randomUUID(), operationId = randomUUID()
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [sessionId, userId, workspaceIds.get(userId), randomUUID(), {}])
    await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,created_at)
      VALUES($1,$2,$3,$4,$5,'queued',now()+$6::double precision*interval '1 second')`,
    [operationId, sessionId, randomUUID(), tag, { model: 'test', maxTokens: 32, revision: 1 }, seconds])
    operations.push({ tag, operationId })
  }
  const first = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
  const second = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
  const a1 = await first.claim(randomUUID())
  assert.equal(a1?.text, 'a1')
  await first.finish(a1.token, 'completed', null)
  // a2 entered before b1, but Bob has not yet received a turn.
  const b1 = await second.claim(randomUUID())
  assert.equal(b1?.text, 'b1')
  const a2 = await first.claim(randomUUID())
  assert.equal(a2?.text, 'a2')
  assert.equal(await second.claim(randomUUID()), null, 'one active task per user')
  const result = await pool.query('SELECT count(*) FROM pe_attempts WHERE operation_id=$1', [operations[0].operationId])
  assert.equal(result.rows[0].count, '1')
  await first.finish(a2.token, 'completed', null)
  await second.finish(b1.token, 'completed', null)
  assert.equal(await second.claim(randomUUID()), null)
})
