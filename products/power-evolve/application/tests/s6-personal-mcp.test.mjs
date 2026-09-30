/** Real PostgreSQL and Streamable HTTP MCP coverage for the fixed read-only preset. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { PersonalMcpService } from '../lib/platform/mcp.js'
import { TaskStore } from '../lib/platform/tasks.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function eventually(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await check()
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('S6 personal MCP snapshots one fixed whoami tool and revokes per user',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_mcp_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    const directory = await mkdtemp(join(tmpdir(), 'pe-s6-mcp-'))
    let pool, child, created = false
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await eventually(() => child.exitCode !== null || child.signalCode !== null, 'fixture termination', 5000)
      }
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    })
    const token = randomBytes(32).toString('base64url')
    const tokenFile = join(directory, 'mcp-token')
    const readyFile = join(directory, 'mcp-ready.json')
    await writeFile(tokenFile, token, { mode: 0o600 })
    child = spawn(process.execPath, ['products/power-evolve/application/scripts/personal-mcp-fixture.mjs'], {
      cwd: new URL('../../../..', import.meta.url),
      env: { ...process.env, PE_MCP_PORT: '0', PE_MCP_TOKEN_FILE: tokenFile, PE_READY_FILE: readyFile },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let fixtureError = ''
    child.stderr.on('data', chunk => { fixtureError += String(chunk).slice(0, 1000) })
    const fixture = await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`MCP fixture exited: ${fixtureError}`)
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }, 'MCP fixture readiness')
    assert.equal(fixture.pid, child.pid)
    const health = await fetch(`${fixture.url}/health`).then(response => response.json())
    assert.deepEqual(health, { ready: true, service: 'mcp-fixture', instanceId: fixture.instanceId })
    assert.equal((await fetch(`${fixture.url}/mcp`)).status, 401)

    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
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
      for (let version = 2; version <= 13; version++) await client.query(migrations[`schemaV${version}`])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    await initializeDatabase(pool)
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 20)

    assert.throws(() => new PersonalMcpService(new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30_000,
      maxPendingPerUser: 8, maxActivePerUser: 1 }), 'http://example.com/mcp', token, 5000))
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30_000, maxPendingPerUser: 8,
      maxActivePerUser: 1, mcpEnabled: true })
    const mcp = new PersonalMcpService(tasks, `${fixture.url}/mcp`, token, 5000)
    const empty = await mcp.list(alice)
    assert.equal(empty.available, true)
    assert.deepEqual(empty.items, [])
    const requestId = randomUUID()
    const aliceConnection = await mcp.install(alice, requestId, 'Alice MCP')
    assert.equal(aliceConnection.enabled, true)
    assert.equal(aliceConnection.revision, 1)
    assert.equal(aliceConnection.toolName, 'mcp__personal__whoami')
    assert.deepEqual(await mcp.install(alice, requestId, 'Alice MCP'), aliceConnection)
    await assert.rejects(mcp.install(alice, requestId, 'changed'), { status: 409, code: 'request_id_conflict' })
    await assert.rejects(mcp.install(alice, randomUUID(), 'second'), { status: 409, code: 'mcp_already_installed' })
    const bobConnection = await mcp.install(bob, randomUUID(), 'Bob MCP')
    assert.deepEqual((await mcp.list(bob)).items, [bobConnection])
    assert.deepEqual((await mcp.list(alice)).items, [aliceConnection])
    await assert.rejects(mcp.check(bob, aliceConnection.connectionId),
      { status: 404, code: 'mcp_connection_not_found' })
    assert.deepEqual(await mcp.check(alice, aliceConnection.connectionId),
      { toolName: 'mcp__personal__whoami', result: `user:${alice.userId}` })
    assert.deepEqual(await mcp.check(bob, bobConnection.connectionId),
      { toolName: 'mcp__personal__whoami', result: `user:${bob.userId}` })

    const session = await tasks.create(alice, randomUUID())
    const accepted = await tasks.accept(alice, session.sessionId, randomUUID(), 'MCP whoami')
    assert.deepEqual((await pool.query('SELECT mcp_selection FROM pe_operations WHERE id=$1',
      [accepted.operationId])).rows[0].mcp_selection,
    [{ connectionId: aliceConnection.connectionId, revision: 1 }])
    const grant = await tasks.claim(randomUUID())
    assert.deepEqual(grant.mcpConnections, [{ connectionId: aliceConnection.connectionId, revision: 1 }])
    assert.deepEqual(await mcp.call(grant.token, aliceConnection.connectionId, 1),
      { toolName: 'mcp__personal__whoami', result: `user:${alice.userId}` })
    await assert.rejects(mcp.call(grant.token, bobConnection.connectionId, 1),
      { status: 403, code: 'mcp_not_in_operation' })

    const toggleId = randomUUID()
    const disabled = await mcp.toggle(alice, aliceConnection.connectionId, toggleId, 1, false)
    assert.equal(disabled.revision, 2)
    assert.equal(disabled.enabled, false)
    assert.deepEqual(await mcp.install(alice, requestId, 'Alice MCP'), aliceConnection,
      'install replay returns the original revision after later state changes')
    assert.deepEqual(await mcp.toggle(alice, aliceConnection.connectionId, toggleId, 1, false), disabled)
    await assert.rejects(mcp.toggle(alice, aliceConnection.connectionId, toggleId, 1, true),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(mcp.toggle(alice, aliceConnection.connectionId, randomUUID(), 1, true),
      { status: 409, code: 'revision_conflict' })
    await assert.rejects(mcp.call(grant.token, aliceConnection.connectionId, 1),
      { status: 403, code: 'mcp_connection_revoked' })
    await assert.rejects(mcp.check(alice, aliceConnection.connectionId),
      { status: 404, code: 'mcp_connection_not_found' })
    assert.deepEqual((await mcp.list(bob)).items, [bobConnection])
    const reenabled = await mcp.toggle(alice, aliceConnection.connectionId, randomUUID(), 2, true)
    assert.equal(reenabled.revision, 3)
    await assert.rejects(mcp.call(grant.token, aliceConnection.connectionId, 1),
      { status: 403, code: 'mcp_connection_revoked' }, 'old Operation cannot reacquire a newer revision')
    await tasks.finish(grant.token, 'completed', null)
    const next = await tasks.accept(alice, session.sessionId, randomUUID(), 'MCP after re-enable')
    assert.deepEqual((await pool.query('SELECT mcp_selection FROM pe_operations WHERE id=$1',
      [next.operationId])).rows[0].mcp_selection,
    [{ connectionId: aliceConnection.connectionId, revision: 3 }])
    const renewedGrant = await tasks.claim(randomUUID())
    assert.deepEqual(await mcp.call(renewedGrant.token, aliceConnection.connectionId, 3),
      { toolName: 'mcp__personal__whoami', result: `user:${alice.userId}` })
    await tasks.finish(renewedGrant.token, 'completed', null)
    await initializeDatabase(pool)
    assert.deepEqual((await new PersonalMcpService(tasks, `${fixture.url}/mcp`, token, 5000).list(alice)).items,
      [reenabled])
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n, 0)
  })
