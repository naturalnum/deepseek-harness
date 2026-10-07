/** Recording SQL/transaction substitutes exercise built management code; no PostgreSQL or executor runs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { StdioConnectionServiceV2 } from '../lib/platform/stdio-v2-connections.js'
import { stdioSha256V2, stdioCatalogFingerprintV2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const management = { maxNameBytes: 80, pageItems: 2, maxConnections: 4 }
const jsonLimits = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const clone = value => structuredClone(value)
const hash = token => createHash('sha256').update(token).digest('hex')
const key = (owner, id) => `${owner}/${id}`
const configuration = (name = 'Literal process') => ({ name, invocation: { program: 'python3', argv: ['-m', 'server', 'literal ; $(not executed)'], cwd: '.' } })
const active = ['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping', 'blocked']
const terminal = ['succeeded', 'failed', 'cancelled', 'rejected', 'expired']

function fixture(options = {}) {
  let db = { connections: new Map(), configurations: new Map(), requests: new Map(), catalogs: new Map(), actions: new Map(), results: new Map() }
  const calls = [], accounts = new Map(), credentials = new Map()
  const owner = randomUUID(), other = randomUUID(), token = 'synthetic_agent_bearer_'.padEnd(48, 'a'), foreign = 'synthetic_foreign_bearer_'.padEnd(48, 'b')
  for (const [id, bearer] of [[owner, token], [other, foreign]]) {
    accounts.set(id, { userId: id, username: `synthetic-${id}`, displayName: 'Synthetic', role: 'USER', enabled: true,
      revision: 1, credentialVersion: 1, passwordChangeRequired: false, deletedAt: null })
    credentials.set(hash(bearer), { user_id: id, audience: 'agent', credential_version: 1, expires: Date.now() + 60000 })
  }
  let snapshot, accountLocked = false, credentialLocked = false, revokeAfterHint = false
  const result = rows => ({ rows: clone(rows), rowCount: rows.length })
  const projection = row => {
    const config = db.configurations.get(key(row.id, row.revision)), catalog = db.catalogs.get(row.current_catalog_id)
    const matching = catalog && catalog.user_id === row.user_id && catalog.connection_id === row.id
      && catalog.config_revision === row.revision && catalog.config_digest === config?.config_digest
    return { ...row, configuration: config?.configuration, config_digest: config?.config_digest,
      catalog_digest: matching ? catalog.catalog_digest : null }
  }
  const query = async (sql, args = []) => {
    calls.push({ sql, args: clone(args) })
    if (sql === 'BEGIN') { snapshot = clone(db); accountLocked = false; credentialLocked = false; return result([]) }
    if (sql === 'ROLLBACK') { db = snapshot; return result([]) }
    if (sql === 'COMMIT') { snapshot = undefined; return result([]) }
    if (sql.startsWith('SELECT user_id FROM pe_credentials')) {
      const credential = credentials.get(args[0])
      const rows = credential?.audience === args[1] && credential.expires > Date.now() ? [{ user_id: credential.user_id }] : []
      if (revokeAfterHint) credentials.delete(args[0])
      return result(rows)
    }
    if (sql.includes('FROM pe_users WHERE id=ANY')) {
      assert.match(sql, /FOR NO KEY UPDATE/u); accountLocked = true
      return result(args[0].flatMap(id => accounts.has(id) ? [accounts.get(id)] : []))
    }
    if (sql.startsWith('SELECT digest FROM pe_credentials')) {
      assert(accountLocked); assert.match(sql, /FOR SHARE/u)
      const c = credentials.get(args[0])
      credentialLocked = !!c && c.user_id === args[1] && c.audience === args[2]
        && c.credential_version === args[3] && c.expires > Date.now()
      return result(credentialLocked ? [{ digest: args[0] }] : [])
    }
    assert(accountLocked && credentialLocked, 'Every resource query follows locked account and credential recheck')
    assert(!sql.includes('jsonb'), 'Raw records stay PG json')
    if (sql.includes('FROM pe_stdio_v2_management_requests')) {
      assert.match(sql, /user_id=\$1 AND request_id=\$2/u)
      const row = db.requests.get(key(args[0], args[1])); return result(row ? [row] : [])
    }
    if (sql.startsWith('SELECT count(*)')) {
      return result([{ full: [...db.connections.values()].filter(row => row.user_id === args[0] && !row.deleted_at).length >= args[1] }])
    }
    if (sql.startsWith('INSERT INTO pe_stdio_v2_connections')) {
      assert(!db.connections.has(args[0])); db.connections.set(args[0], { id: args[0], user_id: args[1], revision: 1, enabled: false,
        current_catalog_id: null, deleted_at: null, created_at: new Date('2026-10-07T00:00:00Z'), updated_at: new Date('2026-10-07T00:00:00Z') })
      return result([])
    }
    if (sql.startsWith('INSERT INTO pe_stdio_v2_configurations')) {
      assert.match(sql, /\$4::json/u); assert.equal(typeof args[3], 'string'); const id = key(args[0], args[2])
      assert(!db.configurations.has(id), 'Configuration generations cannot be replaced')
      db.configurations.set(id, { user_id: args[1], configuration: JSON.parse(args[3]), config_digest: args[4] }); return result([])
    }
    if (sql.startsWith('INSERT INTO pe_stdio_v2_management_requests')) {
      assert.match(sql, /\$4::json,\$5,\$6::json/u); const id = key(args[0], args[1])
      assert(!db.requests.has(id), 'Management request and receipt are inserted once together')
      db.requests.set(id, { purpose: args[2], request: JSON.parse(args[3]), request_digest: args[4], receipt: JSON.parse(args[5]) }); return result([])
    }
    if (sql.startsWith('SELECT c.id')) {
      if (sql.includes('FOR UPDATE OF c')) {
        assert.match(sql, /c.id=\$1 AND c.user_id=\$2 AND c.deleted_at IS NULL/u)
        const row = db.connections.get(args[0]); return result(row?.user_id === args[1] && !row.deleted_at ? [projection(row)] : [])
      }
      assert.match(sql, /c.user_id=\$1 AND c.deleted_at IS NULL/u); assert.match(sql, /ORDER BY c.id LIMIT \$3::bigint\+1/u)
      return result([...db.connections.values()].filter(row => row.user_id === args[0] && !row.deleted_at && (!args[1] || row.id > args[1]))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, args[2] + 1).map(projection))
    }
    if (sql.startsWith('UPDATE pe_stdio_v2_connections')) {
      assert.match(sql, /WHERE id=\$1 AND user_id=\$2/u)
      const row = db.connections.get(args[0]); assert.equal(row.user_id, args[1])
      if (sql.includes('revision=$3')) { row.revision = args[2]; row.enabled = false; row.current_catalog_id = null }
      else if (sql.includes('deleted_at=clock_timestamp()')) { row.deleted_at = new Date(); row.enabled = false; row.current_catalog_id = null }
      else row.enabled = args[2]
      row.updated_at = new Date('2026-10-07T00:01:00Z'); return result([])
    }
    if (sql.startsWith('UPDATE pe_stdio_v2_actions')) {
      assert.match(sql, /user_id=\$1 AND connection_id=\$2/u)
      assert.match(sql, /NOT \$3::boolean OR phase='call'/u)
      const states = sql.match(/state IN \(([^)]+)\)/u)[1].match(/[a-z-]+/gu)
      for (const action of db.actions.values()) if (action.user_id === args[0] && action.connection_id === args[1]
        && states.includes(action.state) && (!args[2] || action.phase === 'call')) action.cancel_requested = true
      return result([])
    }
    if (sql.startsWith('SELECT k.raw_catalog')) {
      assert.match(sql, /a.state='succeeded' AND NOT a.cancel_requested/u)
      assert.match(sql, /a.user_id=k.user_id/u); assert.match(sql, /a.config_digest=k.config_digest/u)
      const k = db.catalogs.get(args[0]), action = db.actions.get(k?.action_id), r = db.results.get(k?.action_id)
      const matching = k && k.user_id === args[1] && k.connection_id === args[2] && k.config_revision === args[3] && k.config_digest === args[4]
        && action?.user_id === k.user_id && action.connection_id === k.connection_id && action.config_revision === k.config_revision
        && action.config_digest === k.config_digest && action.session_id === k.session_id && action.phase === 'discover'
        && k.phase === 'discover' && action.state === 'succeeded' && !action.cancel_requested && r
      return result(matching ? [{ ...k, ...r }] : [])
    }
    throw new Error(`Unexpected synthetic SQL: ${sql}`)
  }
  const pool = { connect: async () => ({ query, on() {}, removeListener() {}, release() {} }) }
  const service = new StdioConnectionServiceV2(pool, options.limits ?? limits, { ...management, ...options.management })
  const create = async (name) => service.create(token, { requestId: randomUUID(), configuration: configuration(name) })
  const publish = (connectionId) => {
    const row = db.connections.get(connectionId), config = db.configurations.get(key(connectionId, row.revision))
    const action = { id: randomUUID(), user_id: owner, connection_id: connectionId, config_revision: row.revision,
      config_digest: config.config_digest, session_id: randomUUID(), phase: 'discover', state: 'succeeded', cancel_requested: false }
    const raw = [{ name: 'literal_echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      _meta: { text: 'raw\0extension', '10': 'ten', '2': 'two' }, extension: { preserved: true } }]
    const catalog = { id: randomUUID(), user_id: owner, connection_id: connectionId, config_revision: row.revision,
      config_digest: config.config_digest, action_id: action.id, session_id: action.session_id, phase: 'discover', raw_catalog: raw,
      image_expectation: { kind: 'desktop', platform: { os: 'linux', architecture: 'arm64' }, configImageId: `sha256:${'a'.repeat(64)}` },
      catalog_digest: stdioCatalogFingerprintV2(raw, limits) }
    const storedResult = { raw: { complete: 'retained\0result' } }
    db.actions.set(action.id, action); db.results.set(action.id, { result: storedResult, result_digest: stdioSha256V2('result', storedResult, jsonLimits) })
    db.catalogs.set(catalog.id, catalog); row.current_catalog_id = catalog.id
    return { catalog, action, result: db.results.get(action.id) }
  }
  return { service, create, publish, token, foreign, owner, other, calls, accounts, credentials,
    get db() { return db }, revokeAfterHint() { revokeAfterHint = true } }
}

test('creation saves complete literal configuration/request as json; exact retries preserve the immutable original receipt', async () => {
  const f = fixture(), input = { requestId: randomUUID(), configuration: configuration() }
  const receipt = await f.service.create(f.token, input)
  assert.deepEqual(receipt, { requestId: input.requestId, purpose: 'create', connectionId: receipt.connectionId, revision: 1, enabled: false, deleted: false })
  const saved = f.db.requests.get(key(f.owner, input.requestId))
  assert.deepEqual(saved.request, input); assert.equal(saved.request_digest, stdioSha256V2('management', { purpose: 'create', input }, jsonLimits))
  assert.deepEqual(f.db.configurations.get(key(receipt.connectionId, 1)).configuration, input.configuration)
  assert.equal(f.db.connections.get(receipt.connectionId).current_catalog_id, null)
  assert.deepEqual(await f.service.create(f.token, clone(input)), receipt)
  await assert.rejects(f.service.create(f.token, { ...input, configuration: configuration('changed') }), { code: 'stdio_v2_request_conflict' })
  await assert.rejects(f.service.toggle(f.token, { requestId: input.requestId, connectionId: receipt.connectionId, expectedRevision: 1, enabled: false }),
    { code: 'stdio_v2_request_conflict' })
  assert.equal(f.db.connections.size, 1); assert.equal(f.db.requests.size, 1)
  input.configuration.invocation.argv[0] = 'later mutation'; receipt.enabled = true
  assert.equal(saved.request.configuration.invocation.argv[0], '-m'); assert.equal(saved.receipt.enabled, false)
})

test('update and deletion preserve revisions/receipts and all writers; exact retry precedes stale or deleted resource checks', async () => {
  const f = fixture(), original = { requestId: randomUUID(), configuration: configuration() }, created = await f.service.create(f.token, original)
  const before = clone(f.db.configurations.get(key(created.connectionId, 1)))
  for (const phase of ['discover', 'call']) for (const state of [...active, ...terminal]) {
    const id = randomUUID(); f.db.actions.set(id, { id, user_id: f.owner, connection_id: created.connectionId, phase, state,
      cancel_requested: false, lease_owner: randomUUID(), lease_until: new Date('2027-01-01T00:00:00Z'), result: null, stop_evidence: null })
  }
  const otherAction = { id: randomUUID(), user_id: f.other, connection_id: created.connectionId, phase: 'call', state: 'running', cancel_requested: false }
  f.db.actions.set(otherAction.id, otherAction)
  const writers = clone([...f.db.actions.values()])
  const input = { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 1, configuration: configuration('revision two') }
  const updated = await f.service.update(f.token, input)
  assert.equal(updated.revision, 2); assert.equal(updated.enabled, false)
  assert.deepEqual(f.db.configurations.get(key(created.connectionId, 1)), before); assert.equal(f.db.configurations.size, 2)
  for (const originalAction of writers) {
    const action = f.db.actions.get(originalAction.id), expected = clone(originalAction)
    if (action.user_id === f.owner && active.includes(action.state)) expected.cancel_requested = true
    assert.deepEqual(action, expected)
  }
  assert.deepEqual(await f.service.update(f.token, input), updated)
  await assert.rejects(f.service.update(f.token, { ...input, requestId: randomUUID() }), { code: 'stdio_v2_revision_conflict' })
  for (const action of f.db.actions.values()) action.cancel_requested = false
  const beforeDelete = clone([...f.db.actions.values()])
  const remove = { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 2 }
  const deleted = await f.service.remove(f.token, remove)
  assert.equal(deleted.revision, 2); assert.equal(deleted.deleted, true)
  for (const originalAction of beforeDelete) {
    const expected = clone(originalAction)
    if (expected.user_id === f.owner && active.includes(expected.state)) expected.cancel_requested = true
    assert.deepEqual(f.db.actions.get(expected.id), expected)
  }
  assert.deepEqual(await f.service.remove(f.token, remove), deleted)
  assert.deepEqual(await f.service.update(f.token, input), updated)
  assert.deepEqual(await f.service.create(f.token, original), created)
  assert.equal((await f.service.list(f.token, {})).items.length, 0)
  await assert.rejects(f.service.toggle(f.token, { ...remove, requestId: randomUUID(), enabled: false }), { code: 'stdio_v2_connection_not_found' })
  assert.equal(f.db.configurations.size, 2); assert.equal(f.db.results.size, 0)
  assert(f.calls.filter(call => call.sql.startsWith('UPDATE pe_stdio_v2_actions')).every(call => !/SET[^\n]*(?:state|lease_owner|result|stop_evidence)=/u.test(call.sql)))
})

test('enable requires current owned successful discovery and full raw catalog/result digests; disable cancels calls only', async t => {
  const f = fixture(), created = await f.create()
  const toggle = () => f.service.toggle(f.token, { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 1, enabled: true })
  await assert.rejects(toggle(), { code: 'stdio_v2_catalog_required' })
  const published = f.publish(created.connectionId), frozen = clone(published)
  for (const [name, alter, code] of [
    ['non-success action', p => { p.action.state = 'failed' }, 'stdio_v2_catalog_required'],
    ['foreign action owner', p => { p.action.user_id = f.other }, 'stdio_v2_catalog_required'],
    ['wrong revision', p => { p.action.config_revision++ }, 'stdio_v2_catalog_required'],
    ['no immutable result', p => { f.db.results.delete(p.action.id) }, 'stdio_v2_catalog_required'],
    ['changed raw extension', p => { p.catalog.raw_catalog[0]._meta.text = 'changed' }, 'stdio_v2_record_invalid'],
    ['missing image fields', p => { delete p.catalog.image_expectation.configImageId }, 'stdio_v2_record_invalid'],
    ['changed raw result', p => { p.result.result.raw.complete = 'changed' }, 'stdio_v2_record_invalid'],
    ['malformed result digest', p => { p.result.result_digest = 'invalid' }, 'stdio_v2_record_invalid'],
  ]) await t.test(name, async () => {
    const p = clone(frozen); f.db.catalogs.set(p.catalog.id, p.catalog); f.db.actions.set(p.action.id, p.action); f.db.results.set(p.action.id, p.result)
    alter(p); await assert.rejects(toggle(), { code }); assert.equal(f.db.connections.get(created.connectionId).enabled, false)
  })
  f.db.catalogs.set(frozen.catalog.id, frozen.catalog); f.db.actions.set(frozen.action.id, frozen.action); f.db.results.set(frozen.action.id, frozen.result)
  const enabled = await toggle(); assert.equal(enabled.enabled, true); assert.equal(enabled.revision, 1)
  const catalogBefore = clone(frozen.catalog), resultBefore = clone(frozen.result), ids = []
  for (const phase of ['call', 'discover']) {
    const id = randomUUID(); ids.push(id); f.db.actions.set(id, { id, user_id: f.owner, connection_id: created.connectionId,
      phase, state: 'running', cancel_requested: false, lease_owner: randomUUID(), lease_until: new Date('2027-01-01T00:00:00Z') })
  }
  const disabled = await f.service.toggle(f.token, { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 1, enabled: false })
  assert.equal(disabled.revision, 1); assert.equal(disabled.enabled, false)
  assert.equal(f.db.actions.get(ids[0]).cancel_requested, true); assert.equal(f.db.actions.get(ids[1]).cancel_requested, false)
  assert(f.db.actions.get(ids[0]).lease_owner); assert(f.db.actions.get(ids[1]).lease_owner)
  assert.equal(f.db.connections.get(created.connectionId).current_catalog_id, frozen.catalog.id)
  assert.deepEqual(f.db.catalogs.get(frozen.catalog.id), catalogBefore); assert.deepEqual(f.db.results.get(frozen.action.id), resultBefore)
  await toggle()
  const updated = await f.service.update(f.token, { requestId: randomUUID(), connectionId: created.connectionId,
    expectedRevision: 1, configuration: configuration('new invocation') })
  assert.equal(updated.enabled, false); assert.equal(updated.revision, 2)
  assert.equal(f.db.connections.get(created.connectionId).current_catalog_id, null)
  assert.equal(f.db.actions.get(ids[1]).cancel_requested, true)
  assert.deepEqual(f.db.catalogs.get(frozen.catalog.id), catalogBefore); assert.deepEqual(f.db.results.get(frozen.action.id), resultBefore)
  await assert.rejects(f.service.toggle(f.token, { requestId: randomUUID(), connectionId: created.connectionId,
    expectedRevision: 2, enabled: true }), { code: 'stdio_v2_catalog_required' })
})

test('owner capacity and stable UUID pages exclude tombstones/foreign rows; current configuration corruption refuses the page', async () => {
  const f = fixture({ management: { maxConnections: 3 } }), receipts = []
  for (const name of ['one', 'two', 'three']) receipts.push(await f.create(name))
  await assert.rejects(f.create('four'), { code: 'stdio_v2_connection_limit' })
  await f.service.create(f.foreign, { requestId: randomUUID(), configuration: configuration('foreign') })
  const first = await f.service.list(f.token, {}), second = await f.service.list(f.token, { after: first.next })
  const expected = receipts.map(row => row.connectionId).sort()
  assert.deepEqual(first.items.map(row => row.connectionId), expected.slice(0, 2)); assert.equal(first.next, expected[1])
  assert.deepEqual(second.items.map(row => row.connectionId), expected.slice(2)); assert.equal(second.next, null)
  await f.service.remove(f.token, { requestId: randomUUID(), connectionId: expected[0], expectedRevision: 1 })
  await f.create('replacement'); assert.equal((await f.service.list(f.token, {})).items.length, 2)
  f.db.configurations.get(key(expected[1], 1)).configuration.invocation.argv.push('tampered')
  await assert.rejects(f.service.list(f.token, {}), { code: 'stdio_v2_record_invalid' })
  assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT c.id') && !call.sql.includes('FOR UPDATE')).at(-1).args[2], 2)
})

test('receipt lookup validates complete check binding/digest and never creates a check; corrupt replay fails closed', async () => {
  const f = fixture(), created = await f.create(), requestId = randomUUID()
  const input = { requestId, connectionId: created.connectionId, expectedRevision: 1, sessionId: randomUUID(), target: { kind: 'cloud' } }
  const receipt = { requestId, purpose: 'check', connectionId: created.connectionId, revision: 1, actionId: randomUUID(),
    executionRef: { kind: 'cloud', executionId: randomUUID() } }
  const row = { purpose: 'check', request: input, request_digest: stdioSha256V2('management', { purpose: 'check', input }, jsonLimits), receipt }
  f.db.requests.set(key(f.owner, requestId), row)
  assert.deepEqual(await f.service.receipt(f.token, { requestId }), receipt)
  await assert.rejects(f.service.receipt(f.foreign, { requestId }), { code: 'stdio_v2_request_not_found' })
  await assert.rejects(f.service.receipt(f.token, { requestId: randomUUID() }), { code: 'stdio_v2_request_not_found' })
  f.db.requests.get(key(f.owner, requestId)).receipt.executionRef.kind = 'desktop'
  await assert.rejects(f.service.receipt(f.token, { requestId }), { code: 'stdio_v2_record_invalid' })
  f.db.requests.set(key(f.owner, requestId), clone(row))
  f.db.requests.get(key(f.owner, requestId)).request.target = { kind: 'desktop', deviceId: randomUUID(), directoryId: randomUUID() }
  await assert.rejects(f.service.receipt(f.token, { requestId }), { code: 'stdio_v2_record_invalid' })
  assert.equal(f.db.actions.size, 0)
  const creation = f.db.requests.get(key(f.owner, created.requestId)); creation.receipt.revision = 2
  await assert.rejects(f.service.create(f.token, creation.request), { code: 'stdio_v2_record_invalid' })
})

test('every method rechecks agent authority before resource queries; changed account/version/expiry/revocation is denied', async t => {
  for (const [name, invalidate] of [
    ['disabled', f => { f.accounts.get(f.owner).enabled = false }],
    ['deleted', f => { f.accounts.get(f.owner).deletedAt = new Date() }],
    ['password change required', f => { f.accounts.get(f.owner).passwordChangeRequired = true }],
    ['wrong audience', f => { f.credentials.get(hash(f.token)).audience = 'approval' }],
    ['expired', f => { f.credentials.get(hash(f.token)).expires = 0 }],
    ['rotated version', f => { f.accounts.get(f.owner).credentialVersion++ }],
    ['revoked after initial hint', f => f.revokeAfterHint()],
  ]) await t.test(name, async () => {
    const f = fixture(), created = await f.create(), start = f.calls.length
    invalidate(f)
    for (const method of [
      () => f.service.create(f.token, { requestId: randomUUID(), configuration: configuration() }),
      () => f.service.update(f.token, { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 1, configuration: configuration() }),
      () => f.service.toggle(f.token, { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 1, enabled: false }),
      () => f.service.remove(f.token, { requestId: randomUUID(), connectionId: created.connectionId, expectedRevision: 1 }),
      () => f.service.list(f.token, {}), () => f.service.receipt(f.token, { requestId: created.requestId }),
    ]) await assert.rejects(method, error => error.status === 401 || error.status === 403)
    assert(!f.calls.slice(start).some(call => call.sql.includes('pe_stdio_v2_')))
    assert.equal(f.db.connections.size, 1)
  })
})

test('foreign/unknown connections share refusal, invalid or over-budget new requests roll back before persistence', async () => {
  const f = fixture(), created = await f.create()
  for (const connectionId of [created.connectionId, randomUUID()]) {
    await assert.rejects(f.service.remove(f.foreign, { requestId: randomUUID(), connectionId, expectedRevision: 1 }), { code: 'stdio_v2_connection_not_found' })
  }
  const before = clone(f.db)
  for (const config of [{ ...configuration(), name: 'x'.repeat(81) },
    { ...configuration(), invocation: { ...configuration().invocation, argv: ['bad\0argument'] } },
    { ...configuration(), invocation: { ...configuration().invocation, cwd: '/workspace' } },
    { ...configuration(), invocation: { ...configuration().invocation, argv: ['x'.repeat(65536)] } }]) {
    await assert.rejects(f.service.create(f.token, { requestId: randomUUID(), configuration: config }))
  }
  assert.deepEqual(f.db, before)
  const small = fixture({ limits: { ...limits, maxInputBytes: 240 } })
  await assert.rejects(small.create('fits request but not full domain envelope'), { name: 'RangeError' })
  assert.equal(small.db.connections.size, 0)
})
