/** Real PG, task grants and safe POSIX files; Runner responses are deterministic fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { ExecutionService } from '../lib/platform/executions.js'
import { ExecutionFileFactsService } from '../lib/platform/execution-file-facts.js'
import { FileService } from '../lib/platform/files.js'
import { TaskFixtureStore } from './task-credential-fixture.mjs'
import { identity, PlatformError } from '../lib/contracts.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s2-batch-files-qa')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const digest = value => createHash('sha256').update(value).digest('hex')

async function fixture(t) {
  const database = `pe_execution_files_${randomBytes(8).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-execution-files-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool
  t.after(async () => {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 6 })
  await initializeDatabase(pool)
  const user = identity.parse({ userId: randomUUID(), username: 'alice' })
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
  await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,$2,$2,64)', [user.userId, 'fixture'])
  const tasks = new TaskFixtureStore(pool, { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 1 })
  const { sessionId } = await tasks.create(user, randomUUID())
  await tasks.accept(user, sessionId, randomUUID(), 'Synthetic Runner observation')
  const grant = await tasks.claim(randomUUID())
  assert(grant)
  const files = new FileService(pool, join(root, 'workspaces')); await files.init()
  await files.put(user, randomUUID(), 'result.txt', null, Buffer.from('verified output').toString('base64'))
  const facts = new ExecutionFileFactsService(pool, files)
  const sandbox = { name: 'fixture', podUid: randomUUID(), runnerInstanceId: randomUUID(), token: 'fixture' }
  let observation, posts = 0
  const runner = { async assertCurrent() {}, async runner(_name, _token, method) {
    if (method === 'POST') posts++
    return observation
  } }
  const service = new ExecutionService(tasks, runner, { service: facts, timeoutMs: 1000 }, 1, 100, 1000, 1000)
  const receipt = await service.propose(grant.token, 'call-output', 'synthetic-command', '')
  const row = await service.claim()
  assert(row)
  observation = { id: row.id, instanceId: sandbox.runnerInstanceId, state: 'succeeded',
    digest: digest(JSON.stringify({ id: row.id, command: row.command, cwd: row.cwd, timeoutMs: 1000,
      instanceId: sandbox.runnerInstanceId })), exitCode: 0, stdout: 'done', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false,
    fileChanges: { status: 'complete', files: [{ path: 'result.txt', sizeBytes: 15,
      sha256: digest('verified output') }], reasons: [] } }
  const assertLease = async () => {
    const current = await pool.query('SELECT id FROM pe_cloud_executions WHERE id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()',
      [row.id, row.lease_owner])
    if (!current.rowCount) throw new Error('fixture_lease_lost')
  }
  return { pool, files, facts, user, sessionId, service, receipt, row, sandbox, runner, observation, assertLease,
    observe: () => service.observe(row, sandbox, false, assertLease), posts: () => posts }
}

test('terminal execution, verified versions and one continuation commit together without redispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await f.observe()
  const stored = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'succeeded')
  assert.deepEqual(stored.result.verifiedFiles, f.observation.fileChanges)
  const read = await f.facts.read(f.user, { sessionId: f.sessionId, executionIds: [f.row.id] })
  assert.equal(read.items[0].callId, 'call-output')
  assert.equal(read.items[0].files[0].sha256, digest('verified output'))
  await assert.rejects(f.observe(), /fixture_lease_lost/u)
  await f.service.settle(f.row, 'succeeded', { unexpected: true }, null)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1', [f.row.id])).rows[0].n, 1)
  assert.deepEqual((await f.pool.query('SELECT result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0].result, stored.result)
  assert.equal(f.posts(), 0)
})

test('malformed file observations do not discard an authenticated terminal command result', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  f.observation.fileChanges.files[0].path = '../private'
  await f.observe()
  const { result, state } = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(state, 'succeeded'); assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'done')
  assert.deepEqual(result.verifiedFiles, { status: 'unavailable', files: [], reasons: ['verification_failed'] })
  assert.equal(f.posts(), 0)
})

test('a stopped account preserves terminal output while withholding files and continuation', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.user.userId])
  await f.pool.query("UPDATE pe_cloud_executions SET error_code='account_disabled' WHERE id=$1", [f.row.id])
  await f.observe()
  const stored = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'succeeded'); assert.equal(stored.result.stdout, 'done')
  assert.deepEqual(stored.result.verifiedFiles, { status: 'unavailable', files: [], reasons: ['execution_unavailable'] })
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1', [f.row.id])).rows[0].n, 0)
})

test('lost execution ownership after verification prevents a stale result commit', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const verify = f.facts.verify.bind(f.facts)
  f.facts.verify = async (...args) => {
    const result = await verify(...args)
    await f.pool.query('UPDATE pe_cloud_executions SET lease_owner=$2 WHERE id=$1', [f.row.id, randomUUID()])
    return result
  }
  await assert.rejects(f.observe(), /fixture_lease_lost/u)
  const stored = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'starting'); assert.equal(stored.result, null)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1', [f.row.id])).rows[0].n, 0)
})

test('verification timeout awaits cleanup and retains the terminal command result', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  let stopped = false
  f.service.fileVerification.timeoutMs = 50
  // The verifier substitutes a blocked read; its cancellation handshake is awaited before settlement.
  f.facts.verify = async (_userId, _sessionId, _observation, signal) => {
    try {
      signal.throwIfAborted()
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } finally { stopped = true }
  }
  await f.observe()
  assert.equal(stopped, true)
  const stored = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'succeeded'); assert.equal(stored.result.stdout, 'done')
  assert.deepEqual(stored.result.verifiedFiles, { status: 'unavailable', files: [], reasons: ['verification_failed'] })
})

test('cancellation responses from a different execution remain uncertain and cannot supply file facts', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  f.runner.runner = async (_name, _token, method) => method === 'GET'
    ? { ...f.observation, state: 'running' }
    : { ...f.observation, id: randomUUID(), state: 'cancelled' }
  await f.service.observe(f.row, f.sandbox, true, f.assertLease)
  const stored = (await f.pool.query('SELECT state,result,error_code FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'uncertain'); assert.equal(stored.result, null)
  assert.equal(stored.error_code, 'runner_identity_mismatch')
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1', [f.row.id])).rows[0].n, 0)
})

test('an unavailable verifier does not discard an already authenticated terminal result', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  f.facts.verify = async () => { throw new PlatformError(503, 'execution_file_facts_unavailable') }
  await f.observe()
  const stored = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'succeeded'); assert.equal(stored.result.exitCode, 0)
  assert.equal(stored.result.stdout, 'done')
  assert.deepEqual(stored.result.verifiedFiles, { status: 'unavailable', files: [], reasons: ['verification_failed'] })
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1', [f.row.id])).rows[0].n, 1)
})
