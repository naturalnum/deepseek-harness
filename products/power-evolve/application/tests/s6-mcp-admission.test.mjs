/** Real PG and HTTP proxy checks; tool catalogs and the model response are deterministic fixtures. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { proxyModel } from '../lib/platform/model.js'
import { mcpCatalogTools, mcpCatalogDigest } from '../lib/platform/mcp-catalog.js'
import { TaskStore } from '../lib/platform/tasks.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const limits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 16, maxActivePerUser: 2,
  remoteMcpAdmission: { maxTools: 8, maxSnapshotBytes: 131072, maxToolBytes: 32768, maxDescriptionBytes: 4096 } }

async function fixture(t) {
  const database = `pe_mcp_admit_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 8 })
  await pool.query(migrations.schema)
  await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (let version = 2; version <= 21; version++) await pool.query(migrations[`schemaV${version}`])
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
  const users = ['alice', 'bob'].map(username => identity.parse({ username, userId: randomUUID() }))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,64,true)',
      [user.userId, 'fixture'])
  }
  return { pool, users, tasks: new TaskStore(pool, limits) }
}

function rawTool(name, description = 'A fixture tool\0including preserved JSON data') {
  return { name, description, inputSchema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { count: { type: 'integer', minimum: 1, maximum: 100 } },
    required: ['count'], additionalProperties: false }, icons: [{ src: 'https://example.org/icon.svg' }] }
}

async function connection(pool, user, rawTools, withCatalog = true) {
  const connectionId = randomUUID(), catalogId = randomUUID()
  const tools = mcpCatalogTools(connectionId, rawTools)
  await transaction(pool, async client => {
    await client.query(`INSERT INTO pe_mcp_remote_connections(id,user_id,server_name,revision,configuration_revision,enabled)
      VALUES($1,$2,$3,1,1,true)`, [connectionId, user.userId, connectionId])
    await client.query(`INSERT INTO pe_mcp_configuration_versions(connection_id,user_id,configuration_revision,configuration)
      VALUES($1,$2,1,$3)`, [connectionId, user.userId, { displayName: 'Fixture', serverUrl: 'https://example.org/mcp',
      enabled: true, authentication: { kind: 'none' } }])
    if (withCatalog) {
      await client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
        VALUES($1,$2,$3,1,$4,$5)`, [catalogId, user.userId, connectionId, mcpCatalogDigest(rawTools), JSON.stringify(tools)])
      await client.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1', [connectionId, catalogId])
    }
  })
  return { connectionId, catalogId, tools }
}

async function startServer(t, handler) {
  const server = createServer(handler)
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

test('V22 admission pins owner catalogs across retries, changes and task-store restart; model proxy uses PG definitions',
  { timeout: 30000 }, async t => {
    const { pool, users: [alice, bob], tasks } = await fixture(t)
    const aliceFirst = await connection(pool, alice, [rawTool('sum'), rawTool('lookup')])
    await connection(pool, alice, [rawTool('sum')])
    await connection(pool, alice, [])
    await connection(pool, alice, [], false)
    const bobConnection = await connection(pool, bob, [rawTool('sum')])
    const bobTool = bobConnection.tools[0]
    const session = await tasks.create(alice, randomUUID())
    const requestId = randomUUID()
    const accepted = await tasks.accept(alice, session.sessionId, requestId, 'Use my tools')
    const before = (await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [accepted.operationId]))
      .rows[0].remote_mcp_selection
    assert.equal(before.length, 3)
    assert.equal(new Set(before.map(tool => tool.model.name)).size, 3)
    assert.ok(before.every(tool => tool.model.name !== bobTool.publicName))
    assert.ok(before.every(tool => tool.raw.description.includes('\0')))
    assert.ok(before.every(tool => !('headers' in tool) && !('serverUrl' in tool)))
    assert.ok(before.every(tool => tool.model.parameters.$schema === 'https://json-schema.org/draft/2020-12/schema'))
    assert.ok(before.every(tool => tool.model.parameters.properties.count.minimum === 1
      && tool.model.parameters.properties.count.maximum === 100))
    assert.deepEqual(before[0].raw.icons, [{ src: 'https://example.org/icon.svg' }])
    await assert.rejects(tasks.accept(bob, session.sessionId, randomUUID(), 'Cross-owner'),
      { status: 404, code: 'session_not_found' })
    await assert.rejects(tasks.accept(alice, session.sessionId, requestId, 'Changed'),
      { status: 409, code: 'request_id_conflict' })

    const changedCatalog = randomUUID()
    await pool.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
      VALUES($1,$2,$3,1,$4,$5)`, [changedCatalog, alice.userId, aliceFirst.connectionId, 'c'.repeat(64),
      JSON.stringify(mcpCatalogTools(aliceFirst.connectionId, [rawTool('replacement')]))])
    await pool.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1',
      [aliceFirst.connectionId, changedCatalog])
    assert.deepEqual(await tasks.accept(alice, session.sessionId, requestId, 'Use my tools'), accepted)
    const restored = new TaskStore(pool, limits)
    const grant = await restored.claim(randomUUID())
    assert.equal(grant.operationId, accepted.operationId)
    assert.deepEqual(grant.remoteMcpTools, before)

    const upstreamRequests = []
    const upstream = await startServer(t, async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      upstreamRequests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_stop\ndata: {}\n\n')
    })
    const proxy = await startServer(t, (req, res) => {
      proxyModel(restored, { url: upstream, apiKey: 'fixture-only', timeoutMs: 1000,
        maxRequestBytes: 262144, maxResponseBytes: 8192 }, req, res).catch(error => {
        res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.code ?? 'test_failure' }))
      })
    })
    const declarations = before.map(tool => ({ name: tool.model.name,
      description: tool.model.description, input_schema: tool.model.parameters }))
    const call = tools => fetch(proxy, { method: 'POST', headers: { authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({ model: 'fixture', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'fixture' }], tools }) })
    const okay = await call(declarations)
    assert.equal(okay.status, 200); await okay.text()
    assert.equal(upstreamRequests.length, 1)
    assert.deepEqual(upstreamRequests[0].tools, declarations)
    for (const changed of [
      { ...declarations[0], name: bobTool.publicName },
      { ...declarations[0], description: 'forged' },
      { ...declarations[0], input_schema: { type: 'object' } },
    ]) {
      const denied = await call([changed]); assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { error: 'model_tool_not_authorized' })
    }
    assert.equal(upstreamRequests.length, 1)
    for (const table of ['pe_cloud_executions', 'pe_sandbox_instances']) {
      assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0)
    }
    await restored.finish(grant.token, 'completed', null)
    const revoked = await call(declarations); assert.equal(revoked.status, 409); await revoked.text()
    assert.equal(upstreamRequests.length, 1)
    const next = await tasks.accept(alice, session.sessionId, randomUUID(), 'Use the new catalog')
    const updated = (await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [next.operationId]))
      .rows[0].remote_mcp_selection
    assert.equal(updated.length, 2)
    assert.ok(updated.some(tool => tool.catalogId === changedCatalog))
    assert.ok(updated.every(tool => tool.catalogId !== aliceFirst.catalogId))
    assert.deepEqual((await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [accepted.operationId]))
      .rows[0].remote_mcp_selection, before)
  })

test('whole-selection budgets roll back admission, and disabled/deleted connections cannot enter new inputs',
  { timeout: 30000 }, async t => {
    const { pool, users: [alice], tasks } = await fixture(t)
    const first = await connection(pool, alice, [rawTool('one')])
    const second = await connection(pool, alice, [rawTool('two')])
    const session = await tasks.create(alice, randomUUID())
    const constrained = new TaskStore(pool, { ...limits, remoteMcpAdmission: { ...limits.remoteMcpAdmission, maxTools: 1 } })
    const requestId = randomUUID()
    await assert.rejects(constrained.accept(alice, session.sessionId, requestId, 'Too many'),
      { status: 429, code: 'mcp_operation_tool_limit' })
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM pe_operations')).rows[0].count, 0)
    await pool.query('UPDATE pe_mcp_remote_connections SET enabled=false,revision=revision+1 WHERE id=$1', [first.connectionId])
    const accepted = await constrained.accept(alice, session.sessionId, requestId, 'Too many')
    const saved = (await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [accepted.operationId]))
      .rows[0].remote_mcp_selection
    assert.deepEqual(saved.map(tool => tool.connectionId), [second.connectionId])
    await pool.query('UPDATE pe_mcp_remote_connections SET deleted_at=now(),revision=revision+1 WHERE id=$1', [second.connectionId])
    const afterDelete = await tasks.accept(alice, session.sessionId, randomUUID(), 'No remote tools')
    assert.deepEqual((await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [afterDelete.operationId]))
      .rows[0].remote_mcp_selection, [])
    await assert.rejects(pool.query("UPDATE pe_mcp_catalog_versions SET tools='[]' WHERE id=$1", [first.catalogId]),
      /MCP snapshots are immutable/u)
  })
