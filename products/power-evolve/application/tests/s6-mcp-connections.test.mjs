/** Real isolated PostgreSQL exercises generic management, private secrets and immutable discovery. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { identity, PlatformError } from '../lib/contracts.js'
import { mcpLeaseOwnerId } from '../lib/mcp-contracts.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { McpConnectionService } from '../lib/platform/mcp-connections.js'
import { mcpConnectionsSchemaV22 } from '../lib/platform/mcp-connections-schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s6-mcp-dev')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const configuration = (overrides = {}) => ({ displayName: 'Fixture MCP', serverUrl: 'https://fixture.example.test/mcp',
  enabled: true, authentication: { kind: 'none' }, ...overrides })
const ownerId = () => mcpLeaseOwnerId.parse(randomUUID())
const options = {
  maxConnections: 16, maxPendingTickets: 8, maxActiveChecks: 8, maxDrafts: 32, maxDraftsPerHour: 16,
  maxTools: 8, maxCatalogBytes: 65_536, maxToolBytes: 16_384, ticketLifetimeMs: 300_000,
  checkLifetimeMs: 60_000, draftLifetimeMs: 120_000, retentionMs: 3600_000, checkLeaseMs: 30_000,
  assertEndpoint(url) {
    if (!['fixture.example.test', 'other.example.test'].includes(new URL(url).hostname))
      throw new PlatformError(403, 'mcp_destination_denied')
  },
}
const pinned = (connection, catalogId) => ({ connectionId: connection.connectionId,
  revision: connection.revision, configurationRevision: connection.configurationRevision,
  credentialRevision: connection.credentialRevision, catalogId })

async function fixture(t, overrides = {}) {
  const database = `pe_mcp_management_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 8 })
  await initializeDatabase(pool)
  const version = (await pool.query('SELECT version FROM pe_schema')).rows[0].version
  if (version < 22) await pool.query(mcpConnectionsSchemaV22)
  const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
  const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
  const sessions = new Map()
  for (const user of [alice, bob]) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    const workspaceId = randomUUID(), sessionId = randomUUID(); sessions.set(user.userId, sessionId)
    await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspaceId, user.userId])
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [sessionId, user.userId, workspaceId, randomUUID(), {}])
  }
  const key = randomBytes(32).toString('base64url')
  const service = new McpConnectionService(pool, key, { ...options, ...overrides })
  const discover = async (user, connection, tools = []) => {
    const check = await service.startCheck(user, { requestId: randomUUID(), sessionId: sessions.get(user.userId),
      connectionId: connection.connectionId, baseRevision: connection.revision })
    const lease = await service.claimCheck(ownerId()); assert.equal(lease.checkId, check.checkId)
    const snapshot = await service.checkSnapshot(lease)
    const result = await service.finishCheck(lease, { tools })
    return { ...result, snapshot }
  }
  return { pool, alice, bob, sessions, key, service, discover }
}

test('metadata CRUD isolates multiple connections, serializes CAS, preserves legacy and durable replay', async t => {
  const { pool, alice, bob, sessions, key, service } = await fixture(t)
  const legacyId = randomUUID()
  await pool.query('INSERT INTO pe_mcp_connections(id,user_id,install_request_id,name) VALUES($1,$2,$3,$4)',
    [legacyId, alice.userId, randomUUID(), 'legacy whoami'])
  assert.deepEqual(await service.list(alice), { items: [] })
  const request = { requestId: randomUUID(), configuration: configuration() }
  const first = await service.create(alice, request)
  const second = await service.create(alice, { requestId: randomUUID(), configuration: configuration({ displayName: 'Second' }) })
  const bobFirst = await service.create(bob, { requestId: randomUUID(), configuration: configuration() })
  await service.create(bob, { requestId: randomUUID(), configuration: configuration({ displayName: 'Bob second' }) })
  assert.notEqual(first.serverName, second.serverName)
  assert.notEqual(first.serverName, bobFirst.serverName)
  assert.equal((await service.list(alice)).items.length, 2)
  assert.equal((await service.list(bob)).items.length, 2)
  assert.deepEqual(await service.create(alice, request), first)
  assert.deepEqual((await service.receipt(alice, request.requestId)).result, { kind: 'connection', item: first })
  assert.deepEqual(await service.receipt(bob, request.requestId), { result: null })
  await assert.rejects(service.create(alice, { ...request, configuration: configuration({ displayName: 'changed' }) }),
    { status: 409, code: 'request_id_conflict' })
  await assert.rejects(service.get(bob, first.connectionId), { status: 404, code: 'mcp_connection_not_found' })
  for (const method of ['toggle', 'remove']) await assert.rejects(service[method](bob, {
    requestId: randomUUID(), connectionId: first.connectionId, baseRevision: 1,
    ...(method === 'toggle' ? { enabled: false } : {}),
  }), { status: 404, code: 'mcp_connection_not_found' })
  await assert.rejects(service.create({ userId: randomUUID() }, request), { status: 401, code: 'unauthorized' })
  await assert.rejects(service.create(alice, { requestId: randomUUID(), configuration: configuration({
    serverUrl: 'https://denied.example.test/mcp' }) }), { status: 403, code: 'mcp_destination_denied' })
  const update = { requestId: randomUUID(), connectionId: first.connectionId, baseRevision: 1,
    configuration: configuration({ displayName: 'Updated' }) }
  const updated = await service.update(alice, update)
  assert.equal(updated.revision, 2); assert.equal(updated.configurationRevision, 2)
  assert.equal(updated.serverName, first.serverName)
  const competing = await Promise.allSettled([true, false].map(enabled => service.toggle(alice, {
    requestId: randomUUID(), connectionId: first.connectionId, baseRevision: 2, enabled })))
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'revision_conflict')
  assert.deepEqual(await service.update(alice, update), updated)
  assert.deepEqual(await service.create(alice, request), first)
  const current = await service.get(alice, first.connectionId)
  assert.equal(current.configurationRevision, 2)
  const checkInput = { requestId: randomUUID(), sessionId: sessions.get(alice.userId),
    connectionId: current.connectionId, baseRevision: current.revision }
  const check = await service.startCheck(alice, checkInput)
  const remove = { requestId: randomUUID(), connectionId: first.connectionId, baseRevision: current.revision }
  const deleted = await service.remove(alice, remove)
  assert(deleted.deletedAt); assert.equal(deleted.enabled, false)
  assert.deepEqual(await service.remove(alice, remove), deleted)
  await assert.rejects(service.get(alice, first.connectionId), { status: 404, code: 'mcp_connection_not_found' })
  assert.equal((await service.list(alice)).items.length, 1)
  assert.deepEqual(await service.create(alice, request), first)
  assert.deepEqual(await service.startCheck(alice, checkInput), check)
  await assert.rejects(service.startCheck(alice, { ...checkInput, baseRevision: current.revision + 1 }),
    { code: 'request_id_conflict' })
  const denied = new McpConnectionService(pool, key, { ...options,
    assertEndpoint() { throw new PlatformError(403, 'mcp_destination_denied') } })
  assert.deepEqual(await denied.create(alice, request), first)
  assert.deepEqual(await denied.update(alice, update), updated)
  assert.deepEqual(await denied.startCheck(alice, checkInput), check)
  const stored = (await pool.query('SELECT * FROM pe_mcp_connections WHERE id=$1', [legacyId])).rows[0]
  assert.equal(stored.name, 'legacy whoami'); assert.equal(stored.revision, 1); assert.equal(stored.enabled, true)
  await assert.rejects(pool.query('UPDATE pe_mcp_configuration_versions SET configuration=$1 WHERE connection_id=$2',
    [{ changed: true }, first.connectionId]), /immutable/)
  assert.deepEqual(await new McpConnectionService(pool, key, options).list(alice), await service.list(alice))
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_sandbox_instances')).rows[0].n, 0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations')).rows[0].n, 0)
})

test('one-use tickets bind metadata and secret replay while retain/replace/remove never expose values', async t => {
  const { pool, alice, bob, key, service, discover } = await fixture(t)
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, bearerToken: 'test-only-first-token' }))
  const input = { purpose: 'create', requestId: randomUUID(), sizeBytes: bytes.length,
    configuration: configuration({ authentication: { kind: 'bearer', action: 'replace' } }) }
  await assert.rejects(service.create(alice, { requestId: randomUUID(), configuration: input.configuration }),
    { code: 'mcp_ticket_required' })
  const ticket = await service.issueTicket(alice, input, 'https://platform.example.test')
  assert.equal(ticket.state, 'pending'); assert.equal(ticket.requestId, input.requestId)
  assert.equal(ticket.uploadUrl, 'https://platform.example.test/mcp/connections/upload')
  assert.equal(JSON.stringify(ticket).includes('test-only-first-token'), false)
  await assert.rejects(service.upload(ticket.ticket, Readable.from([Buffer.alloc(bytes.length + 1)])),
    { status: 413, code: 'mcp_credential_too_large' })
  await assert.rejects(service.upload(ticket.ticket, Readable.from([bytes.subarray(1)])), { code: 'mcp_credential_mismatch' })
  const result = await service.upload(ticket.ticket, Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]))
  const item = result.item; assert.equal(result.kind, 'connection'); assert.equal(item.secretConfigured, true)
  assert.equal(JSON.stringify(result).includes('test-only-first-token'), false)
  await assert.rejects(service.upload(ticket.ticket, Readable.from([bytes])), { status: 401, code: 'invalid_mcp_ticket' })
  assert.deepEqual((await service.receipt(alice, input.requestId)).result, result)
  assert.equal((await service.receipt(bob, input.requestId)).result, null)
  const replay = await service.issueTicket(alice, input, 'https://platform.example.test')
  assert.notEqual(replay.ticket, ticket.ticket)
  assert.deepEqual(await service.upload(replay.ticket, Readable.from([bytes])), result)
  const mismatchTicket = await service.issueTicket(alice, input, 'https://platform.example.test')
  const otherBytes = Buffer.from(bytes.toString().replace('first', 'other'))
  await assert.rejects(service.upload(mismatchTicket.ticket, Readable.from([otherBytes])), { code: 'mcp_credential_conflict' })
  await assert.rejects(service.issueTicket(alice, { ...input, configuration: configuration() }, 'https://platform.example.test'),
    { code: 'request_id_conflict' })
  const retained = await service.update(alice, { requestId: randomUUID(), connectionId: item.connectionId, baseRevision: 1,
    configuration: configuration({ serverUrl: 'https://other.example.test/mcp', authentication: { kind: 'bearer', action: 'retain' } }) })
  assert.equal(retained.credentialRevision, 2)
  const discovered = await discover(alice, retained)
  assert.deepEqual(discovered.snapshot.headers, { Authorization: 'Bearer test-only-first-token' })
  const opaque = await pool.query('SELECT sealed FROM pe_mcp_credential_versions WHERE connection_id=$1 ORDER BY configuration_revision',
    [item.connectionId])
  assert.equal(opaque.rows.length, 2)
  assert.notDeepEqual(opaque.rows[0].sealed, opaque.rows[1].sealed)
  assert(opaque.rows.every(row => !row.sealed.includes(Buffer.from('test-only-first-token'))))
  const cleared = await service.update(alice, { requestId: randomUUID(), connectionId: item.connectionId, baseRevision: 2,
    configuration: configuration({ enabled: false, authentication: { kind: 'bearer', action: 'clear' } }) })
  assert.equal(cleared.credentialRevision, null); assert.equal(cleared.secretConfigured, false)
  await assert.rejects(service.toggle(alice, { requestId: randomUUID(), connectionId: item.connectionId,
    baseRevision: 3, enabled: true }), { code: 'mcp_credential_required' })
  const headerBytes = Buffer.from(JSON.stringify({ formatVersion: 1,
    headers: [{ name: 'X-Key', value: 'old-key' }, { name: 'X-Keep', value: 'kept' }, { name: 'X-Remove', value: 'removed' }] }))
  const headerInput = { ...input, requestId: randomUUID(), sizeBytes: headerBytes.length,
    configuration: configuration({ authentication: { kind: 'headers', headers: [
      { name: 'X-Key', action: 'replace' }, { name: 'X-Keep', action: 'replace' }, { name: 'X-Remove', action: 'replace' }] } }) }
  const headers = (await service.upload((await service.issueTicket(alice, headerInput, 'https://platform.example.test')).ticket,
    Readable.from([headerBytes]))).item
  const replaceBytes = Buffer.from(JSON.stringify({ formatVersion: 1, headers: [{ name: 'X-Key', value: 'new-key' }] }))
  const changed = (await service.upload((await service.issueTicket(alice, { purpose: 'update', requestId: randomUUID(),
    connectionId: headers.connectionId, baseRevision: 1, sizeBytes: replaceBytes.length,
    configuration: configuration({ authentication: { kind: 'headers', headers: [
      { name: 'x-keep', action: 'retain' }, { name: 'X-Key', action: 'replace' }] } }) }, 'https://platform.example.test')).ticket,
  Readable.from([replaceBytes]))).item
  assert.deepEqual(changed.headerNames, ['x-keep', 'x-key'])
  const headerCheck = await discover(alice, changed)
  assert.deepEqual(headerCheck.snapshot.headers, { 'x-keep': 'kept', 'x-key': 'new-key' })
  const badKey = new McpConnectionService(pool, randomBytes(32).toString('base64url'), options)
  const check = await service.startCheck(alice, { requestId: randomUUID(), sessionId: headerCheck.sessionId,
    connectionId: changed.connectionId, baseRevision: changed.revision })
  const lease = await service.claimCheck(ownerId()); assert.equal(lease.checkId, check.checkId)
  await assert.rejects(badKey.checkSnapshot(lease), { code: 'mcp_credential_unavailable' })
  await service.cancelCheck(alice, check.checkId)
  const metadata = await pool.query('SELECT input FROM pe_mcp_credential_tickets')
  assert.equal(JSON.stringify(metadata.rows).includes('test-only-first-token'), false)
  assert.equal(JSON.stringify(metadata.rows).includes('new-key'), false)
  await assert.rejects(pool.query('DELETE FROM pe_mcp_credential_versions WHERE connection_id=$1', [item.connectionId]), /immutable/)
  const currentRequest = (await pool.query('SELECT metadata_digest,secret_digest,result FROM pe_mcp_management_requests WHERE request_id=$1',
    [input.requestId])).rows[0]
  assert.match(currentRequest.secret_digest, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(currentRequest).includes('test-only-first-token'), false)
})

test('drafts are independent immutable discovery snapshots; ownership, cancellation and lease recovery are fenced', async t => {
  const { pool, alice, bob, sessions, service } = await fixture(t)
  const draftRequest = { requestId: randomUUID(), sessionId: sessions.get(alice.userId), configuration: configuration() }
  await assert.rejects(service.startDraftCheck(alice, { ...draftRequest, sessionId: sessions.get(bob.userId) }),
    { code: 'session_not_found' })
  const check = await service.startDraftCheck(alice, draftRequest)
  assert(check.draftId); assert.equal(check.connectionId, null)
  assert.deepEqual(await service.startDraftCheck(alice, draftRequest), check)
  assert.deepEqual(await service.list(alice), { items: [] })
  await assert.rejects(service.check(bob, check.checkId), { code: 'mcp_check_not_found' })
  await assert.rejects(service.cancelCheck(bob, check.checkId), { code: 'mcp_check_not_found' })
  const lease = await service.claimCheck(ownerId())
  assert.equal(lease.checkId, check.checkId)
  assert.equal((await service.checkSnapshot(lease)).resourceId, check.draftId)
  const tool = { name: 'draft_lookup', inputSchema: { type: 'object', additionalProperties: false },
    description: 'keep\u0000NUL', icons: [{ src: 'https://example.test/icon.png' }], future: { nested: ['\u0000'] } }
  const result = await service.finishCheck(lease, { tools: [tool] })
  const catalog = await service.getCatalog(alice, result.catalogId)
  assert.deepEqual(catalog.tools[0].raw, tool)
  assert.equal(catalog.draftId, check.draftId)
  await assert.rejects(service.getCatalog(bob, result.catalogId), { code: 'mcp_catalog_not_found' })
  assert.deepEqual(await transaction(pool, client => service.admissionCatalogs(client, alice)), [])
  await assert.rejects(pool.query('UPDATE pe_mcp_drafts SET configuration=$1 WHERE id=$2', [{ changed: true }, check.draftId]), /immutable/)
  const next = await service.startDraftCheck(alice, { ...draftRequest, requestId: randomUUID() })
  const oldLease = await service.claimCheck(ownerId())
  const cancelled = await service.cancelCheck(alice, next.checkId)
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.cancelRequested, true)
  assert.deepEqual(await service.cancelCheck(alice, next.checkId), cancelled)
  for (const invoke of [() => service.renewCheck(oldLease), () => service.checkSnapshot(oldLease),
    () => service.finishCheck(oldLease, { tools: [] })]) await assert.rejects(invoke(), { code: 'mcp_check_lease_lost' })
  const recovering = await service.startDraftCheck(alice, { ...draftRequest, requestId: randomUUID() })
  const previous = await service.claimCheck(ownerId())
  await pool.query('UPDATE pe_mcp_checks SET lease_until=now()-interval \'1 second\' WHERE id=$1', [recovering.checkId])
  const reclaimed = await service.claimCheck(ownerId())
  assert.equal(reclaimed.checkId, recovering.checkId); assert.equal(reclaimed.epoch, previous.epoch + 1)
  await assert.rejects(service.finishCheck(previous, { tools: [] }), { code: 'mcp_check_lease_lost' })
  await service.renewCheck(reclaimed)
  const completed = await service.finishCheck(reclaimed, { errorCode: 'mcp_schema_unsupported' })
  assert.equal(completed.state, 'failed'); assert.equal(completed.catalogId, null)
  const expiry = await service.startDraftCheck(alice, { ...draftRequest, requestId: randomUUID() })
  await pool.query('UPDATE pe_mcp_checks SET expires_at=now()-interval \'1 second\' WHERE id=$1', [expiry.checkId])
  assert.equal(await service.claimCheck(ownerId()), null)
  assert.equal((await service.check(alice, expiry.checkId)).state, 'expired')
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, bearerToken: 'draft-only-token' }))
  const ticket = await service.issueTicket(alice, { purpose: 'draft', requestId: randomUUID(),
    sessionId: sessions.get(alice.userId), sizeBytes: bytes.length,
    configuration: configuration({ authentication: { kind: 'bearer', action: 'replace' } }) }, 'https://platform.example.test')
  const secretDraft = await service.upload(ticket.ticket, Readable.from([bytes]))
  assert.equal(secretDraft.kind, 'check'); assert(secretDraft.item.draftId)
  const draftLease = await service.claimCheck(ownerId())
  assert.deepEqual((await service.checkSnapshot(draftLease)).headers, { Authorization: 'Bearer draft-only-token' })
  await service.cancelCheck(alice, secretDraft.item.checkId)
  assert.deepEqual(await service.list(alice), { items: [] })
})

test('same catalogs deduplicate, changed catalogs revoke old pins, and runtime authority locks the exact owner/version', async t => {
  const { pool, alice, bob, sessions, service, discover } = await fixture(t)
  const created = await service.create(alice, { requestId: randomUUID(), configuration: configuration() })
  const raw = { name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    icons: [{ src: 'https://example.test/icon.png' }], description: 'first\u0000descriptor' }
  const first = await discover(alice, created, [raw])
  const firstCatalog = await service.getCatalog(alice, first.catalogId)
  const replay = await discover(alice, created, [raw])
  assert.equal(replay.catalogId, first.catalogId)
  const chosen = pinned(created, first.catalogId)
  assert.equal((await transaction(pool, client => service.runtimeSnapshot(client, alice, chosen))).serverUrl, created.serverUrl)
  await assert.rejects(transaction(pool, client => service.runtimeSnapshot(client, bob, chosen)), { code: 'mcp_connection_revoked' })
  const admitted = await transaction(pool, client => service.admissionCatalogs(client, alice))
  assert.equal(admitted[0].catalog.catalogId, first.catalogId)
  assert.equal((await service.list(alice)).items[0].latestCheck.checkId, replay.checkId)
  const changed = await discover(alice, created, [{ ...raw, description: 'changed' }])
  assert.notEqual(changed.catalogId, first.catalogId)
  const changedCatalog = await service.getCatalog(alice, changed.catalogId)
  assert.equal(changedCatalog.tools[0].publicName, firstCatalog.tools[0].publicName)
  await assert.rejects(transaction(pool, client => service.runtimeSnapshot(client, alice, chosen)), { code: 'mcp_connection_revoked' })
  assert.deepEqual(await service.getCatalog(alice, first.catalogId), firstCatalog)
  const latest = pinned(created, changed.catalogId)
  const client = await pool.connect(); await client.query('BEGIN')
  try {
    await service.runtimeSnapshot(client, alice, latest)
    let settled = false
    const disable = service.toggle(alice, { requestId: randomUUID(), connectionId: created.connectionId,
      baseRevision: 1, enabled: false }).then(value => { settled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(settled, false)
    await client.query('COMMIT')
    const disabled = await disable; assert.equal(disabled.enabled, false)
  } finally { await client.query('ROLLBACK'); client.release() }
  await assert.rejects(transaction(pool, client => service.runtimeSnapshot(client, alice, latest)), { code: 'mcp_connection_revoked' })
  const enabled = await service.toggle(alice, { requestId: randomUUID(), connectionId: created.connectionId, baseRevision: 2, enabled: true })
  await assert.rejects(transaction(pool, client => service.runtimeSnapshot(client, alice, latest)), { code: 'mcp_connection_revoked' })
  const staleCheck = await service.startCheck(alice, { requestId: randomUUID(), connectionId: enabled.connectionId,
    sessionId: sessions.get(alice.userId), baseRevision: enabled.revision })
  const lease = await service.claimCheck(ownerId()); await service.checkSnapshot(lease)
  const updated = await service.update(alice, { requestId: randomUUID(), connectionId: enabled.connectionId,
    baseRevision: enabled.revision, configuration: configuration({ serverUrl: 'https://other.example.test/mcp' }) })
  await service.finishCheck(lease, { tools: [raw] })
  assert.equal((await service.get(alice, updated.connectionId)).currentCatalogId, null)
  assert.equal((await service.check(alice, staleCheck.checkId)).state, 'succeeded')
  const badCheck = await service.startCheck(alice, { requestId: randomUUID(), connectionId: updated.connectionId,
    sessionId: sessions.get(alice.userId), baseRevision: updated.revision })
  const badLease = await service.claimCheck(ownerId())
  await assert.rejects(service.finishCheck(badLease, { tools: Array(9).fill(raw) }), { code: 'mcp_catalog_limit' })
  await assert.rejects(service.finishCheck(badLease, { tools: [{ ...raw, description: 'x'.repeat(16_384) }] }), { code: 'mcp_catalog_limit' })
  await assert.rejects(service.finishCheck(badLease, { tools: [raw, raw] }), { code: 'mcp_tool_duplicate' })
  await service.finishCheck(badLease, { errorCode: 'mcp_catalog_limit' })
  assert.equal((await service.check(alice, badCheck.checkId)).state, 'failed')
  const queue = () => service.startCheck(alice, { requestId: randomUUID(), connectionId: updated.connectionId,
    sessionId: sessions.get(alice.userId), baseRevision: updated.revision })
  const olderFailure = await queue(), newerSuccess = await queue()
  const olderFailureLease = await service.claimCheck(ownerId()), newerSuccessLease = await service.claimCheck(ownerId())
  assert.equal(olderFailureLease.checkId, olderFailure.checkId); assert.equal(newerSuccessLease.checkId, newerSuccess.checkId)
  const published = await service.finishCheck(newerSuccessLease, { tools: [raw] })
  await service.finishCheck(olderFailureLease, { errorCode: 'mcp_schema_unsupported' })
  assert.equal((await service.get(alice, updated.connectionId)).currentCatalogId, published.catalogId)
  const olderSuccess = await queue(), newerFailure = await queue()
  const olderSuccessLease = await service.claimCheck(ownerId()), newerFailureLease = await service.claimCheck(ownerId())
  assert.equal(olderSuccessLease.checkId, olderSuccess.checkId); assert.equal(newerFailureLease.checkId, newerFailure.checkId)
  await service.finishCheck(newerFailureLease, { errorCode: 'mcp_task_execution_unsupported' })
  assert.equal((await service.get(alice, updated.connectionId)).currentCatalogId, null)
  await assert.rejects(transaction(pool, client => service.runtimeSnapshot(client, alice, pinned(updated, published.catalogId))),
    { code: 'mcp_connection_revoked' })
  await service.finishCheck(olderSuccessLease, { tools: [raw] })
  assert.equal((await service.get(alice, updated.connectionId)).currentCatalogId, null)
  assert.deepEqual(await transaction(pool, client => service.admissionCatalogs(client, alice)), [])
  assert((await service.getCatalog(alice, published.catalogId)).tools.length)
})

test('deployment limits serialize quotas and expire/clean independent drafts without creating execution state', async t => {
  const { pool, alice, sessions, key, service } = await fixture(t, { maxConnections: 1, maxPendingTickets: 1,
    maxActiveChecks: 1, maxDrafts: 1, maxDraftsPerHour: 1, ticketLifetimeMs: 100,
    checkLifetimeMs: 200, draftLifetimeMs: 300, checkLeaseMs: 100, retentionMs: 5 })
  assert.throws(() => new McpConnectionService(pool, key, { assertEndpoint: options.assertEndpoint }), /options/)
  assert.throws(() => new McpConnectionService(pool, key, { ...options, maxToolBytes: 0 }), /options/)
  const creations = await Promise.allSettled([1, 2].map(() => service.create(alice,
    { requestId: randomUUID(), configuration: configuration() })))
  assert.equal(creations.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(creations.find(value => value.status === 'rejected').reason.code, 'mcp_connection_limit')
  const drafts = await Promise.allSettled([1, 2].map(() => service.startDraftCheck(alice,
    { requestId: randomUUID(), sessionId: sessions.get(alice.userId), configuration: configuration() })))
  assert.equal(drafts.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(drafts.find(value => value.status === 'rejected').reason.code, 'mcp_check_limit')
  const bytes = Buffer.from('{"formatVersion":1}')
  const ticket = await service.issueTicket(alice, { purpose: 'create', requestId: randomUUID(), sizeBytes: bytes.length,
    configuration: configuration() }, 'https://platform.example.test')
  await assert.rejects(service.issueTicket(alice, { purpose: 'create', requestId: randomUUID(), sizeBytes: bytes.length,
    configuration: configuration() }, 'https://platform.example.test'), { code: 'mcp_ticket_limit' })
  await new Promise(resolve => setTimeout(resolve, 350))
  await assert.rejects(service.upload(ticket.ticket, Readable.from([bytes])), { code: 'invalid_mcp_ticket' })
  assert.equal(await service.claimCheck(ownerId()), null)
  assert.deepEqual(await service.pruneChecks(alice), { checks: 1, drafts: 1 })
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mcp_drafts')).rows[0].n, 0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations')).rows[0].n, 0)
})
