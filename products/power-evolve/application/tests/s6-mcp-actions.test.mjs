/** Real PG state-machine evidence; directories and remote results are explicit deterministic fixtures. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { McpActionStore } from '../lib/platform/mcp-actions.js'
import { mcpCatalogTools, mcpCatalogDigest } from '../lib/platform/mcp-catalog.js'
import { TaskStore } from '../lib/platform/tasks.js'
import * as migrations from '../lib/platform/schema.js'

const testClients = new WeakMap()
const databaseUrl = (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
const taskLimits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 16, maxActivePerUser: 2,
  remoteMcpAdmission: { maxTools: 8, maxSnapshotBytes: 131072, maxToolBytes: 32768, maxDescriptionBytes: 4096 } }
const limits = { maxArgumentBytes: 8192, maxResultBytes: 32768, maxCallsPerChain: 2,
  maxPendingPerUser: 8, chainLifetimeMs: 60000, approvalLifetimeMs: 60000, leaseMs: 10000, listLimit: 50 }
const tools = ['first', 'second'].map(name => ({ name, inputSchema: { type: 'object', properties: {
  text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true },
  outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 20 } }, required: ['text'] } }))
const result = { content: [{ type: 'text', text: 'exact\0结果' }], structuredContent: { text: 'exact\0结果' } }

async function fixture(t, overrides = {}) {
  const name = `pe_mcp_actions_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  t.after(async () => {
    for (const client of testClients.get(pool) ?? []) { await client.query('ROLLBACK'); client.release() }
    await pool?.end(); if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end() })
  await admin.query(`CREATE DATABASE "${name}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${name}`
  pool = new Pool({ connectionString: url.href, max: 5 })
  testClients.set(pool, new Set())
  await pool.query(migrations.schema); await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (let version = 2; version <= 22; version++) await pool.query(migrations[`schemaV${version}`])
  await initializeDatabase(pool); await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 24)
  const users = ['alice', 'bob'].map(username => identity.parse({ username, userId: randomUUID() }))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,64,true)',
      [user.userId, 'fixture'])
  }
  const [alice, bob] = users, connectionId = randomUUID(), catalogId = randomUUID()
  const catalog = mcpCatalogTools(connectionId, tools), catalogDigest = mcpCatalogDigest(tools)
  await transaction(pool, async client => {
    await client.query(`INSERT INTO pe_mcp_remote_connections(id,user_id,server_name,revision,configuration_revision,enabled)
      VALUES($1,$2,$3,1,1,true)`, [connectionId, alice.userId, connectionId])
    await client.query(`INSERT INTO pe_mcp_configuration_versions(connection_id,user_id,configuration_revision,configuration)
      VALUES($1,$2,1,$3)`, [connectionId, alice.userId, { displayName: 'Fixture', serverUrl: 'https://example.org/mcp',
      enabled: true, authentication: 'none', headerNames: [] }])
    await client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
      VALUES($1,$2,$3,1,$4,$5)`, [catalogId, alice.userId, connectionId, catalogDigest, JSON.stringify(catalog)])
    await client.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1', [connectionId, catalogId])
  })
  const tasks = new TaskStore(pool, taskLimits), key = randomBytes(32).toString('base64url')
  const store = new McpActionStore(tasks, key, { ...limits, ...overrides })
  const { sessionId } = await tasks.create(alice, randomUUID())
  await tasks.accept(alice, sessionId, randomUUID(), 'Use two tools to finish the task')
  const grant = await tasks.claim(randomUUID())
  const input = (index = 0, callKey = randomUUID()) => ({ callKey, toolName: catalog[index].publicName, arguments: { text: 'a\0b' } })
  const approve = async (action, decision = 'once') => store.decide(alice, action.actionId, action.fingerprint, decision)
  const permissionId = async action => (await pool.query('SELECT permission_id FROM pe_mcp_actions WHERE id=$1', [action.actionId])).rows[0].permission_id
  return { pool, tasks, store, key, alice, bob, sessionId, grant, input, approve, permissionId, catalog,
    catalogDigest, connectionId, catalogId }
}

test('V23 persists owner-scoped exact proposals, refuses changed retries and requires approval despite annotations', async t => {
  const f = await fixture(t), request = f.input()
  const first = await f.store.propose(f.grant.token, request)
  assert.equal(first.state, 'pending')
  assert.deepEqual(await f.store.propose(f.grant.token, request), first)
  await assert.rejects(f.store.propose(f.grant.token, { ...request, arguments: { text: 'changed' } }), { code: 'request_id_conflict' })
  await assert.rejects(f.store.propose(f.grant.token, { ...request, toolName: 'mcp__foreign__tool' }), { code: 'mcp_tool_not_in_operation' })
  await assert.rejects(f.store.propose(f.grant.token, { ...f.input(), arguments: { text: 3 } }), { code: 'mcp_arguments_invalid' })
  await assert.rejects(f.store.propose(f.grant.token, { ...request, arguments: { text: 3 } }), { code: 'request_id_conflict' })
  assert.equal(await f.store.claim(randomUUID()), null)
  await assert.rejects(f.store.status(f.bob, first.actionId), { status: 404 })
  await assert.rejects(f.store.decide(f.bob, first.actionId, first.fingerprint, 'once'), { status: 404 })
  await assert.rejects(f.store.decide(f.alice, first.actionId, '0'.repeat(64), 'once'), { code: 'mcp_action_changed' })
  assert.equal((await f.approve(first)).state, 'approved')
  await assert.rejects(f.approve(first, 'persistent'), { code: 'mcp_action_already_decided' })
  const lease = await f.store.claim(randomUUID())
  assert.deepEqual((await f.store.preparation(lease)).arguments, request.arguments)
  assert.equal(await f.store.authorizeDispatch(lease, '0'.repeat(64)), false)
  assert.equal((await f.store.propose(f.grant.token, request)).errorCode, 'mcp_catalog_changed')
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_mcp_actions')).rows[0].n, 1)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n, 0)
})

test('two successful tools continue one frozen request; NUL survives PG and a continuation cannot reset its call budget', async t => {
  const f = await fixture(t), first = await f.store.propose(f.grant.token, f.input())
  await f.approve(first)
  let lease = await f.store.claim(randomUUID())
  assert.equal(await f.store.authorizeDispatch(lease, f.catalogDigest), true)
  assert.equal(await f.store.authorizeDispatch(lease, f.catalogDigest), false)
  await f.store.finish(lease, { result })
  await assert.rejects(f.store.finish(lease, { result }), { code: 'mcp_action_lease_lost' })
  assert.deepEqual((await f.store.status(f.alice, first.actionId)).result, result)
  await f.tasks.finish(f.grant.token, 'completed', null)
  const secondGrant = await f.tasks.claim(randomUUID())
  assert.equal(secondGrant.source, 'remote_mcp_result')
  assert.equal(secondGrant.sourceMcpActionId, first.actionId)
  assert.deepEqual(secondGrant.remoteMcpTools, f.grant.remoteMcpTools)
  assert.equal(JSON.parse(secondGrant.text).result.structuredContent.text, 'exact\0结果')
  const second = await f.store.propose(secondGrant.token, f.input(1))
  await f.approve(second); lease = await f.store.claim(randomUUID())
  assert.equal(await f.store.authorizeDispatch(lease, f.catalogDigest), true)
  await f.store.finish(lease, { result })
  await f.tasks.finish(secondGrant.token, 'completed', null)
  const final = await f.tasks.claim(randomUUID())
  await assert.rejects(f.store.propose(final.token, f.input()), { code: 'mcp_chain_call_limit' })
  const chain = (await f.pool.query('SELECT * FROM pe_mcp_action_chains')).rows
  assert.equal(chain.length, 1); assert.equal(chain[0].calls, 2)
  assert.equal(chain[0].root_operation_id, f.grant.operationId)
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='remote_mcp_result'")).rows[0].n, 2)
})

test('committed intent survives worker loss as uncertain; stale completion and a new call key cannot replay it', async t => {
  const f = await fixture(t), request = f.input(), action = await f.store.propose(f.grant.token, request)
  await f.approve(action)
  const lease = await f.store.claim(randomUUID())
  await f.store.authorizeDispatch(lease, f.catalogDigest)
  await f.pool.query("UPDATE pe_mcp_actions SET lease_until=now()-interval '1 second' WHERE id=$1", [action.actionId])
  const restarted = new McpActionStore(f.tasks, f.key, limits)
  assert.equal(await restarted.claim(randomUUID()), null)
  assert.equal((await restarted.status(f.alice, action.actionId)).state, 'uncertain')
  await assert.rejects(restarted.finish(lease, { result }), { code: 'mcp_action_lease_lost' })
  assert.equal((await restarted.propose(f.grant.token, request)).state, 'uncertain')
  await assert.rejects(restarted.propose(f.grant.token, f.input()), { code: 'mcp_chain_stopped' })
  await f.tasks.finish(f.grant.token, 'completed', null)
  const next = await f.tasks.claim(randomUUID())
  await assert.rejects(restarted.propose(next.token, f.input(1)), { code: 'mcp_chain_stopped' })
  assert.equal((await f.pool.query('SELECT count(dispatch_id)::integer AS n FROM pe_mcp_actions')).rows[0].n, 1)
})

test('session permission authorizes its exact tool only, and revocation fences the next intent', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action, 'session')
  const permission = await f.permissionId(action)
  await assert.rejects(f.store.revoke(f.bob, permission), { status: 404 })
  let lease = await f.store.claim(randomUUID())
  await f.store.authorizeDispatch(lease, f.catalogDigest); await f.store.finish(lease, { result })
  await f.tasks.finish(f.grant.token, 'completed', null)
  const continuation = await f.tasks.claim(randomUUID())
  const automatic = await f.store.propose(continuation.token, f.input())
  assert.equal(automatic.state, 'approved')
  lease = await f.store.claim(randomUUID()); await f.store.revoke(f.alice, permission)
  assert.equal(await f.store.authorizeDispatch(lease, f.catalogDigest), false)
  assert.equal((await f.store.status(f.alice, automatic.actionId)).errorCode, 'mcp_permission_revoked')
})

for (const mode of ['session', 'persistent']) test(`${mode} permission has explicit cross-session scope`, async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action, mode)
  const other = await f.tasks.create(f.alice, randomUUID())
  await f.tasks.accept(f.alice, other.sessionId, randomUUID(), 'Separate original request')
  const otherGrant = await f.tasks.claim(randomUUID())
  assert.equal(otherGrant.sessionId, other.sessionId)
  const next = await f.store.propose(otherGrant.token, f.input())
  assert.equal(next.state, mode === 'session' ? 'pending' : 'approved')
  const differentTool = await f.store.propose(otherGrant.token, f.input(1))
  assert.equal(differentTool.state, 'pending')
})

test('pre-intent recovery advances the epoch; cancellation after intent is terminal uncertainty', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action)
  const old = await f.store.claim(randomUUID())
  await f.pool.query("UPDATE pe_mcp_actions SET lease_until=now()-interval '1 second' WHERE id=$1", [action.actionId])
  const lease = await f.store.claim(randomUUID())
  assert.equal(lease.epoch, old.epoch + 1)
  await assert.rejects(f.store.authorizeDispatch(old, f.catalogDigest), { code: 'mcp_action_lease_lost' })
  await f.store.authorizeDispatch(lease, f.catalogDigest)
  assert.equal((await f.store.cancel(f.alice, action.actionId)).state, 'uncertain')
  assert.equal((await f.store.cancel(f.alice, action.actionId)).state, 'uncertain')
  await assert.rejects(f.store.renew(lease), { code: 'mcp_action_lease_lost' })
  assert.equal(await f.store.claim(randomUUID()), null)
})

test('disablement prevents fresh permits, but identical requests keep their receipts', async t => {
  const f = await fixture(t), request = f.input(), action = await f.store.propose(f.grant.token, request)
  await f.approve(action)
  const lease = await f.store.claim(randomUUID())
  await f.pool.query('UPDATE pe_mcp_remote_connections SET enabled=false,revision=revision+1 WHERE id=$1', [f.connectionId])
  assert.equal(await f.store.authorizeDispatch(lease, f.catalogDigest), false)
  assert.equal((await f.store.propose(f.grant.token, request)).errorCode, 'mcp_connection_revoked')
})

test('explicit rejection persists one follow-up without a dispatch', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  assert.equal((await f.approve(action, 'reject')).state, 'rejected')
  assert.equal((await f.approve(action, 'reject')).state, 'rejected')
  assert.equal((await f.pool.query('SELECT count(dispatch_id)::integer AS n FROM pe_mcp_actions')).rows[0].n, 0)
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='remote_mcp_result'")).rows[0].n, 1)
})

test('expired pending approval remains expired across restart and cannot issue a permission', async t => {
  const f = await fixture(t), request = f.input(), action = await f.store.propose(f.grant.token, request)
  await f.pool.query("UPDATE pe_mcp_actions SET expires_at=now()-interval '1 second' WHERE id=$1", [action.actionId])
  const restarted = new McpActionStore(f.tasks, f.key, limits)
  assert.equal(await restarted.claim(randomUUID()), null)
  assert.equal((await restarted.propose(f.grant.token, request)).state, 'expired')
  await assert.rejects(f.approve(action, 'persistent'), { code: 'mcp_action_already_decided' })
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_mcp_permissions')).rows[0].n, 0)
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='remote_mcp_result'")).rows[0].n, 1)
})

for (const [title, reply, errorCode] of [
  ['remote tool error', { content: [{ type: 'text', text: 'fixture failure' }], isError: true }, 'mcp_tool_error'],
  ['invalid structured result', { content: [], structuredContent: { text: 4 } }, 'mcp_result_schema_invalid'],
  ['structured result below advertised minimum', { content: [], structuredContent: { text: '' } }, 'mcp_result_schema_invalid'],
  ['structured result above advertised maximum', { content: [], structuredContent: { text: 'x'.repeat(21) } }, 'mcp_result_schema_invalid'],
]) test(`${title} keeps the original data, stops automatic calls, and never becomes a retry`, async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action)
  const lease = await f.store.claim(randomUUID())
  await f.store.authorizeDispatch(lease, f.catalogDigest)
  assert.equal((await f.store.finish(lease, { result: reply })).errorCode, errorCode)
  const status = await f.store.status(f.alice, action.actionId)
  assert.equal(status.state, 'failed'); assert.deepEqual(status.result, reply)
  await assert.rejects(f.store.propose(f.grant.token, f.input(1)), { code: 'mcp_chain_stopped' })
})

test('user cancellation of the originating operation fences a previously approved call', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action)
  const lease = await f.store.claim(randomUUID())
  await f.tasks.cancel(f.alice, f.sessionId)
  await f.tasks.finish(f.grant.token, 'completed', null)
  assert.equal((await f.pool.query('SELECT error_code FROM pe_operations WHERE id=$1', [f.grant.operationId])).rows[0].error_code, null)
  assert.equal(await f.store.authorizeDispatch(lease, f.catalogDigest), false)
  assert.equal((await f.store.status(f.alice, action.actionId)).errorCode, 'mcp_operation_cancelled')
  assert.equal((await f.pool.query('SELECT count(dispatch_id)::integer AS n FROM pe_mcp_actions')).rows[0].n, 0)
})

async function blocker(_t, pool) {
  const client = await pool.connect()
  await client.query('BEGIN')
  testClients.get(pool).add(client)
  return { client, release: async () => { await client.query('COMMIT'); testClients.get(pool).delete(client); client.release() }, pid: (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id }
}

async function waitForBlocked(pool, pid) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const found = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])
    if (found.rowCount) return
    await delay(10)
  }
  assert.fail('Expected a real PG lock wait')
}

test('a connection lock wait cannot extend an expired worker dispatch lease', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action)
  const lease = await f.store.claim(randomUUID())
  await f.pool.query("UPDATE pe_mcp_actions SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [action.actionId])
  const locked = await blocker(t, f.pool)
  await locked.client.query('SELECT id FROM pe_mcp_remote_connections WHERE id=$1 FOR UPDATE', [f.connectionId])
  const denied = assert.rejects(f.store.authorizeDispatch(lease, f.catalogDigest), { code: 'mcp_action_lease_lost' })
  await waitForBlocked(f.pool, locked.pid)
  await locked.client.query('SELECT pg_sleep(0.6)')
  await locked.release()
  await denied
  assert.equal((await f.pool.query('SELECT dispatch_id FROM pe_mcp_actions WHERE id=$1', [action.actionId])).rows[0].dispatch_id, null)
})

test('owner serialization admits connection foreign-key writes and avoids a user/connection deadlock', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action)
  const lease = await f.store.claim(randomUUID()), locked = await blocker(t, f.pool)
  await locked.client.query("SET LOCAL lock_timeout='1500ms'")
  await locked.client.query('SELECT id FROM pe_mcp_remote_connections WHERE id=$1 FOR UPDATE', [f.connectionId])
  const permitted = f.store.authorizeDispatch(lease, f.catalogDigest)
  await waitForBlocked(f.pool, locked.pid)
  await locked.client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
    VALUES($1,$2,$3,1,$4,'[]')`, [randomUUID(), f.alice.userId, f.connectionId, 'd'.repeat(64)])
  await locked.release()
  assert.equal(await permitted, true)
})

test('cancellation queued on the owner lock commits before a later dispatch check', async t => {
  const f = await fixture(t), action = await f.store.propose(f.grant.token, f.input())
  await f.approve(action)
  const lease = await f.store.claim(randomUUID()), locked = await blocker(t, f.pool)
  await locked.client.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.alice.userId])
  const cancelled = f.tasks.cancel(f.alice, f.sessionId)
  await waitForBlocked(f.pool, locked.pid)
  const permitted = f.store.authorizeDispatch(lease, f.catalogDigest)
  await locked.release()
  await cancelled
  assert.equal(await permitted, false)
  assert.equal((await f.store.status(f.alice, action.actionId)).errorCode, 'mcp_operation_cancelled')
})

test('a sibling lost after intent stops an already-preparing action before the recovery poll runs', async t => {
  const f = await fixture(t), first = await f.store.propose(f.grant.token, f.input()),
    second = await f.store.propose(f.grant.token, f.input(1))
  await f.approve(first); await f.approve(second)
  const a = await f.store.claim(randomUUID()), b = await f.store.claim(randomUUID())
  await f.store.authorizeDispatch(a, f.catalogDigest)
  await f.pool.query("UPDATE pe_mcp_actions SET lease_until=now()-interval '1 second' WHERE id=$1", [a.actionId])
  assert.equal(await f.store.authorizeDispatch(b, f.catalogDigest), false)
  assert.equal((await f.store.status(f.alice, a.actionId)).state, 'uncertain')
  assert.equal((await f.store.status(f.alice, b.actionId)).state, 'failed')
  assert.equal((await f.pool.query('SELECT count(dispatch_id)::integer AS n FROM pe_mcp_actions')).rows[0].n, 1)
})

test('a sibling intent expiring during a connection lock wait also prevents a new permit', async t => {
  const f = await fixture(t), first = await f.store.propose(f.grant.token, f.input()),
    second = await f.store.propose(f.grant.token, f.input(1))
  await f.approve(first); await f.approve(second)
  const a = await f.store.claim(randomUUID()), b = await f.store.claim(randomUUID())
  await f.store.authorizeDispatch(a, f.catalogDigest)
  await f.pool.query("UPDATE pe_mcp_actions SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [a.actionId])
  const locked = await blocker(t, f.pool)
  await locked.client.query('SELECT id FROM pe_mcp_remote_connections WHERE id=$1 FOR UPDATE', [f.connectionId])
  const denied = assert.rejects(f.store.authorizeDispatch(b, f.catalogDigest), { code: 'mcp_action_lease_lost' })
  await waitForBlocked(f.pool, locked.pid)
  await locked.client.query('SELECT pg_sleep(0.6)')
  await locked.release(); await denied
  assert.equal((await f.pool.query('SELECT count(dispatch_id)::integer AS n FROM pe_mcp_actions')).rows[0].n, 1)
})
