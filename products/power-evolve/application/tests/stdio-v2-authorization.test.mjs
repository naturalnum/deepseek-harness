/** Synthetic SQLite/serialized transaction substitute; these tests do not establish PG locks or executor capture. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioApprovalFingerprintV2, stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 131072, maxMessageBytes: 16384, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 16384, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const key = new Uint8Array(32).fill(17), uuid = randomUUID
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const tokenDigest = token => createHash('sha256').update(token).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const rawCatalog = [{ name: 'read_note', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  annotations: { readOnlyHint: true }, _meta: { complete: '保留\0😀' } },
{ name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { destructiveHint: true }, extension: { order: [3, 1] } }]
const jsonColumns = new Set(['task', 'stdio_task', 'configuration', 'prepared', 'approval_binding', 'executor_owner',
  'permit', 'dispatch', 'raw_catalog', 'image_expectation', 'result'])
const booleans = new Set(['enabled', 'passwordChangeRequired', 'cancel_requested'])
const dates = new Set(['deletedAt', 'deleted_at', 'expires_at', 'issued_at', 'mcp_chain_cancelled_at', 'stopped_at', 'now'])
const mutableTables = ['pe_stdio_v2_actions', 'pe_stdio_v2_preparations', 'pe_stdio_v2_decisions',
  'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_cloud_executions', 'pe_desktop_executions']

function fixture(t, { kind = 'cloud', phase = 'discover' } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  let now = Date.parse('2026-10-07T00:00:00.000Z'), tail = Promise.resolve(), captureHook = null
  let commitLoss = false, failDispatch = false, captureUnavailable = false
  const queries = [], captures = []
  db.function('clock_timestamp', () => new Date(now).toISOString())
  db.exec(`CREATE TABLE pe_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,enabled INTEGER,
    account_revision INTEGER,credential_version INTEGER,password_change_required INTEGER,deleted_at TEXT);
    CREATE TABLE pe_credentials(digest TEXT PRIMARY KEY,user_id TEXT,audience TEXT,credential_version INTEGER,expires_at TEXT);
    CREATE TABLE pe_sessions(id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT);
    CREATE TABLE pe_operations(id TEXT PRIMARY KEY,session_id TEXT,mcp_root_operation_id TEXT,source TEXT,error_code TEXT,mcp_chain_cancelled_at TEXT);
    CREATE TABLE pe_mcp_action_chains(root_operation_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,calls INTEGER,max_calls INTEGER,stopped_at TEXT,expires_at TEXT);
    CREATE TABLE pe_stdio_v2_connections(id TEXT PRIMARY KEY,user_id TEXT,revision INTEGER,enabled INTEGER,current_catalog_id TEXT,deleted_at TEXT);
    CREATE TABLE pe_stdio_v2_configurations(connection_id TEXT,user_id TEXT,revision INTEGER,configuration TEXT,config_digest TEXT,
      PRIMARY KEY(connection_id,revision));
    CREATE TABLE pe_stdio_v2_actions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,connection_id TEXT,
      config_revision INTEGER,config_digest TEXT,phase TEXT,execution_target TEXT,execution_id TEXT UNIQUE,
      task TEXT,task_digest TEXT,state TEXT,cancel_requested INTEGER,request_id TEXT,operation_id TEXT,root_operation_id TEXT,
      call_id TEXT,continuation_request_id TEXT,updated_at TEXT);
    CREATE TABLE pe_stdio_v2_preparations(action_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,phase TEXT,
      execution_target TEXT,execution_id TEXT UNIQUE,task_digest TEXT,prepared TEXT,prepared_digest TEXT,
      approval_binding TEXT,fingerprint TEXT,approval_epoch INTEGER,expires_at TEXT);
    CREATE TABLE pe_stdio_v2_decisions(action_id TEXT PRIMARY KEY,user_id TEXT,fingerprint TEXT,decision TEXT);
    CREATE TABLE pe_stdio_v2_start_permits(action_id TEXT PRIMARY KEY,permit_id TEXT UNIQUE,authorization_request_id TEXT,
      execution_id TEXT UNIQUE,task_digest TEXT,prepared_digest TEXT,fingerprint TEXT,decision TEXT,
      executor_owner TEXT,permit TEXT,issued_at TEXT,expires_at TEXT);
    CREATE TABLE pe_stdio_v2_dispatches(action_id TEXT PRIMARY KEY,dispatch TEXT,dispatch_digest TEXT);
    CREATE TABLE pe_stdio_v2_results(action_id TEXT PRIMARY KEY,result TEXT,result_digest TEXT);
    CREATE TABLE pe_stdio_v2_catalogs(id TEXT PRIMARY KEY,user_id TEXT,connection_id TEXT,config_revision INTEGER,
      config_digest TEXT,action_id TEXT,raw_catalog TEXT,image_expectation TEXT,catalog_digest TEXT);`)
  for (const table of ['pe_cloud_executions', 'pe_desktop_executions']) db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,
    user_id TEXT,session_id TEXT,execution_kind TEXT,execution_target TEXT,origin_kind TEXT,task_version INTEGER,
    stdio_phase TEXT,stdio_action_id TEXT,stdio_task TEXT,request_digest TEXT,operation_id TEXT,call_id TEXT,command TEXT,cwd TEXT,
    continuation_request_id TEXT,state TEXT,cancel_requested INTEGER
    ${table === 'pe_desktop_executions' ? ',device_id TEXT,directory_id TEXT,device_instance_id TEXT' : ''});`)
  function execute(sql, values = []) {
    queries.push(sql)
    if (failDispatch && sql.startsWith('INSERT INTO pe_stdio_v2_dispatches')) throw new Error('synthetic_dispatch_failure')
    const translated = sql.replace(/=ANY\((\$\d+)::uuid\[\]\)/gu, ' IN (SELECT value FROM json_each($1))')
      .replace(/ FOR (?:NO KEY UPDATE|UPDATE|SHARE)(?: OF [\w,]+)?/gu, '')
    const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), value instanceof Date ? value.toISOString()
      : typeof value === 'boolean' ? Number(value) : Array.isArray(value) ? JSON.stringify(value) : value]))
    const before = db.prepare('SELECT total_changes() AS n').get().n
    const rows = db.prepare(translated).all(bindings).map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field,
      value === null ? null : jsonColumns.has(field) ? JSON.parse(value) : booleans.has(field) ? Boolean(value)
      : dates.has(field) ? new Date(value) : value])))
    if (sql === 'COMMIT' && commitLoss) { commitLoss = false; throw new Error('synthetic_commit_reply_lost') }
    return { rows, rowCount: rows.length || db.prepare('SELECT total_changes() AS n').get().n - before }
  }
  const pool = { async connect() {
    const prior = tail; let release
    tail = new Promise(resolve => { release = resolve }); await prior
    return Object.assign(new EventEmitter(), { query: async (sql, values) => execute(sql, values), release() { release() } })
  } }
  const encode = value => value === null ? null : typeof value === 'object' ? JSON.stringify(value)
    : typeof value === 'boolean' ? Number(value) : value
  function insert(table, fields) {
    db.prepare(`INSERT INTO ${table}(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(() => '?').join(',')})`)
      .run(...Object.values(fields).map(encode))
  }
  function change(table, column, value, idColumn = 'id', id = actionId) {
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${idColumn}=?`).run(encode(value), id)
  }
  const userId = uuid(), otherUserId = uuid(), sessionId = uuid(), workspaceId = uuid(), connectionId = uuid(), actionId = uuid()
  const executionId = uuid(), deviceId = uuid(), directoryId = uuid(), enrollmentId = uuid(), processId = uuid(), dispatchId = uuid()
  const token = 'a'.repeat(48), agentToken = 'b'.repeat(48), otherToken = 'c'.repeat(48), runnerInstanceId = uuid()
  for (const [id, username] of [[userId, 'synthetic-owner'], [otherUserId, 'synthetic-other']]) insert('pe_users', {
    id, username, display_name: username, role: 'USER', enabled: true, account_revision: 1, credential_version: 1,
    password_change_required: false, deleted_at: null })
  for (const [value, id, audience] of [[token, userId, 'approval'], [agentToken, userId, 'agent'], [otherToken, otherUserId, 'approval']]) {
    insert('pe_credentials', { digest: tokenDigest(value), user_id: id, audience, credential_version: 1,
      expires_at: '2099-01-01T00:00:00.000Z' })
  }
  insert('pe_sessions', { id: sessionId, user_id: userId, workspace_id: workspaceId })
  const configuration = { name: 'Synthetic two tools', invocation: { program: '/usr/bin/node', argv: ['server.mjs', '--label', '😀'], cwd: '.' } }
  const configDigest = sha('configuration', configuration), catalogId = uuid()
  const pin = kind === 'cloud'
    ? { kind, deploymentId: uuid(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
      imageReference: `synthetic.example/runner@sha256:${'1'.repeat(64)}`, configImageId: `sha256:${'2'.repeat(64)}`,
      runtimeImageIds: [`containerd://${'3'.repeat(64)}`] }
    : { kind, deploymentId: uuid(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' }, configImageId: `sha256:${'2'.repeat(64)}` }
  const image = kind === 'cloud' ? { kind, platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
    : { kind, platform: pin.platform, configImageId: pin.configImageId }
  const scopeBinding = kind === 'cloud' ? { kind, userId, workspaceId, bindingGeneration: 1,
    target: { spaceId: uuid(), rootRelativePath: 'synthetic' }, home: { kind: 'user', userId } }
    : { kind, userId, deviceId, directoryId, enrollmentId, home: { kind: 'enrollment', enrollmentId } }
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId, userId, sessionId, connectionId,
    configRevision: 1, configDigest, scopeBinding, expectedDeploymentPin: pin, invocation: configuration.invocation, limits, phase,
    origin: phase === 'discover' ? { kind: 'stdio_discovery', requestId: uuid() }
      : { kind: 'operation', operationId: uuid(), rootOperationId: uuid(), callKey: 'synthetic-call' },
    ...(phase === 'call' ? { selection: { catalogId, catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits),
      rawCatalog: clone(rawCatalog), catalogImageExpectation: image, rawName: 'write_note', rawDescriptor: clone(rawCatalog[1]),
      arguments: { text: '保留\0😀', path: 'nested/note.txt', extension: { untouched: [false, null] } } } } : {}) })
  const taskDigest = sha('task', task), executionRef = { kind, executionId }, continuationId = phase === 'call' ? uuid() : null
  insert('pe_stdio_v2_connections', { id: connectionId, user_id: userId, revision: 1, enabled: phase === 'call',
    current_catalog_id: phase === 'call' ? catalogId : null, deleted_at: null })
  insert('pe_stdio_v2_configurations', { connection_id: connectionId, user_id: userId, revision: 1, configuration, config_digest: configDigest })
  insert('pe_stdio_v2_actions', { id: actionId, user_id: userId, session_id: sessionId, connection_id: connectionId,
    config_revision: 1, config_digest: configDigest, phase, execution_target: kind, execution_id: executionId, task, task_digest: taskDigest,
    state: 'queued', cancel_requested: false, request_id: phase === 'discover' ? task.origin.requestId : null,
    operation_id: phase === 'call' ? task.origin.operationId : null, root_operation_id: phase === 'call' ? task.origin.rootOperationId : null,
    call_id: phase === 'call' ? task.origin.callKey : null, continuation_request_id: continuationId })
  const table = kind === 'cloud' ? 'pe_cloud_executions' : 'pe_desktop_executions'
  insert(table, { id: executionId, user_id: userId, session_id: sessionId, execution_kind: 'stdio_v2', execution_target: kind,
    origin_kind: task.origin.kind, task_version: 2, stdio_phase: phase, stdio_action_id: actionId, stdio_task: task, request_digest: taskDigest,
    operation_id: phase === 'call' ? task.origin.operationId : null, call_id: phase === 'call' ? task.origin.callKey : null,
    command: null, cwd: null, continuation_request_id: continuationId, state: 'queued', cancel_requested: false,
    ...(kind === 'desktop' ? { device_id: deviceId, directory_id: directoryId, device_instance_id: enrollmentId } : {}) })
  const discoveryId = uuid()
  if (phase === 'call') {
    insert('pe_operations', { id: task.origin.rootOperationId, session_id: sessionId, source: 'user' })
    insert('pe_operations', { id: task.origin.operationId, session_id: sessionId, mcp_root_operation_id: task.origin.rootOperationId })
    insert('pe_mcp_action_chains', { root_operation_id: task.origin.rootOperationId, user_id: userId, session_id: sessionId,
      calls: 1, max_calls: 4, expires_at: new Date(now + 60000).toISOString() })
    // A successful catalog's immutable producer/result is admitted before this call action.
    insert('pe_stdio_v2_actions', { id: discoveryId, state: 'succeeded', execution_id: uuid() })
    const result = { tools: clone(rawCatalog) }
    insert('pe_stdio_v2_results', { action_id: discoveryId, result, result_digest: sha('result', result) })
    insert('pe_stdio_v2_catalogs', { id: catalogId, user_id: userId, connection_id: connectionId, config_revision: 1,
      config_digest: configDigest, action_id: discoveryId, raw_catalog: clone(rawCatalog), image_expectation: image,
      catalog_digest: task.selection.catalogDigest })
  }
  const capture = kind === 'cloud' ? { kind, podUid: uuid(), podName: 'synthetic-pod', namespace: 'synthetic', nodeName: 'synthetic-node',
    runnerInstanceId, containerId: 'containerd://synthetic-container', restartCount: 0, mountGeneration: '1',
    workspaceMount: { claimName: 'synthetic-claim', subPath: 'workspace', mountPath: '/workspace', readOnly: false },
    homeMount: { claimName: 'synthetic-claim', subPath: 'home', mountPath: '/home/agent', readOnly: false } }
    : { kind, receipt: { containerId: '4'.repeat(64), imageId: pin.configImageId,
      owner: { deviceId, enrollmentId, executionId, creationId: dispatchId, requestDigest: taskDigest } }, processId, directoryId,
      workspaceMount: { source: '/synthetic/private/workspace', destination: '/workspace', readOnly: false },
      homeMount: { source: '/synthetic/private/home', destination: '/home/agent', readOnly: false }, actualContainerId: '4'.repeat(64) }
  const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId, executionRef, taskDigest, scopeBinding,
    fullScopeDigest: sha('scope', { scopeBinding, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }),
    expectedDeploymentPin: pin, actualExecutorImage: image, capture, specDigest: sha('spec', { capture, image }) })
  const owner = kind === 'cloud' ? { kind, runnerInstanceId } : { kind, enrollmentId, processId, dispatchId }
  const options = { limits, approvalKey: key, approvalLifetimeMs: 5000, capture: async (client, selected, ref) => {
    captures.push({ task: clone(selected), ref: clone(ref), client })
    if (captureUnavailable) throw new Error('synthetic_capture_unavailable')
    if (captureHook) await captureHook()
    return clone(prepared)
  } }
  const service = new StdioAuthorizationServiceV2(pool, options)
  const snapshot = () => JSON.stringify(mutableTables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
  async function rejectsWithoutWrites(operation, pattern) {
    const before = snapshot(); await assert.rejects(operation, pattern); assert.equal(snapshot(), before)
  }
  async function approve() { const p = await service.prepare(actionId); await service.decide(token, { actionId, fingerprint: p.fingerprint, decision: 'once' }); return p }
  return { db, pool, service, options, task, taskDigest, prepared, owner, actionId, executionId, executionRef, table, userId,
    sessionId, connectionId, catalogId, discoveryId, token, agentToken, otherToken, captures, queries, insert, change, snapshot,
    approve, rejectsWithoutWrites, advance(ms) { now += ms }, setCaptureHook(fn) { captureHook = fn },
    loseCommitReply() { commitLoss = true }, failDispatch() { failDispatch = true }, captureUnavailable() { captureUnavailable = true } }
}

test('configuration refuses missing private capture, invalid key and invalid lifetime before accessing the pool', () => {
  const pool = { connect() { assert.fail('constructor connected') } }, capture = async () => assert.fail('constructor captured')
  for (const options of [{ limits, approvalKey: key, approvalLifetimeMs: 1 },
    { limits, approvalKey: new Uint8Array(31), approvalLifetimeMs: 1, capture },
    { limits, approvalKey: key, approvalLifetimeMs: 0, capture },
    { limits, approvalKey: key, approvalLifetimeMs: 2_147_483_648, capture }]) {
    assert.throws(() => new StdioAuthorizationServiceV2(pool, options), /options_invalid/u)
  }
})

for (const kind of ['cloud', 'desktop']) test(`${kind}: first preparation freezes complete private capture and approval epoch without renewing`, async t => {
  const f = fixture(t, { kind }), p = await f.service.prepare(f.actionId)
  assert.deepEqual(p.prepared, f.prepared); assert.equal(p.approvalEpoch, 1)
  assert.equal(p.preparedDigest, sha('prepared', f.prepared)); assert.equal(p.expiresAt, '2026-10-07T00:00:05.000Z')
  assert.equal(p.fingerprint, stdioApprovalFingerprintV2(key, { actionId: f.actionId, taskDigest: f.taskDigest,
    preparedDigest: p.preparedDigest, approvalEpoch: 1, expiresAt: p.expiresAt }, budget))
  f.advance(9000); const repeated = await f.service.prepare(f.actionId)
  assert.deepEqual(repeated, p); assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_preparations').get().n, 1)
  assert.deepEqual(f.captures[0].task, f.task); assert.deepEqual(f.captures[0].ref, f.executionRef)
  const locks = f.queries.filter(sql => /FOR (?:NO KEY UPDATE|UPDATE)/u.test(sql))
  assert.deepEqual(locks.slice(0, 5).map(sql => /FROM (\w+)/u.exec(sql)[1]),
    ['pe_users', 'pe_sessions', 'pe_stdio_v2_connections', 'pe_stdio_v2_actions', f.table])
})

test('approval view omits physical capture and only current approval audience can inspect/decide', async t => {
  const f = fixture(t, { kind: 'desktop' }), p = await f.service.prepare(f.actionId)
  const view = await f.service.inspect(f.token, f.actionId)
  assert.deepEqual(view.task, f.task); assert.equal(view.decision, null)
  assert.equal(JSON.stringify(view).includes('/synthetic/private'), false); assert.equal(Object.hasOwn(view, 'prepared'), false)
  for (const token of [f.agentToken, f.otherToken]) {
    await f.rejectsWithoutWrites(() => f.service.inspect(token, f.actionId), /unauthorized|not_found/u)
    await f.rejectsWithoutWrites(() => f.service.decide(token, { actionId: f.actionId, fingerprint: p.fingerprint, decision: 'once' }), /unauthorized|not_found/u)
  }
  f.change('pe_users', 'credential_version', 2, 'id', f.userId)
  await f.rejectsWithoutWrites(() => f.service.decide(f.token, { actionId: f.actionId, fingerprint: p.fingerprint, decision: 'once' }), /unauthorized/u)
})

test('once and reject decisions are immutable and a rejection never creates a permit/dispatch/result', async t => {
  const f = fixture(t), p = await f.service.prepare(f.actionId), request = { actionId: f.actionId, fingerprint: p.fingerprint, decision: 'reject' }
  assert.equal((await f.service.decide(f.token, request)).state, 'rejected')
  assert.equal((await f.service.decide(f.token, request)).decision, 'reject')
  await f.rejectsWithoutWrites(() => f.service.decide(f.token, { ...request, decision: 'once' }), /decision_conflict/u)
  await f.rejectsWithoutWrites(() => f.service.authorize(f.actionId, uuid(), f.owner), /not_startable/u)
  assert.equal(f.db.prepare('SELECT cancel_requested FROM pe_stdio_v2_actions WHERE id=?').get(f.actionId).cancel_requested, 1)
  for (const table of ['pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_results']) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
  }
})

test('database clock expiry rejects approval and fresh authority without changing original preparations', async t => {
  const f = fixture(t), p = await f.service.prepare(f.actionId)
  f.advance(5000)
  assert.equal((await f.service.inspect(f.token, f.actionId)).expired, true)
  await f.rejectsWithoutWrites(() => f.service.decide(f.token, { actionId: f.actionId, fingerprint: p.fingerprint, decision: 'once' }), /expired/u)
  const g = fixture(t); await g.approve(); g.advance(5000)
  await g.rejectsWithoutWrites(() => g.service.authorize(g.actionId, uuid(), g.owner), /expired/u)
})

for (const kind of ['cloud', 'desktop']) test(`${kind}: unique permit and whole dispatch commit before sole true reply; every retry returns original false`, async t => {
  const f = fixture(t, { kind, phase: 'call' }); await f.approve()
  const requestId = uuid(), first = await f.service.authorize(f.actionId, requestId, f.owner)
  assert.equal(first.grantOnce, true); assert.equal(f.queries.at(-1), 'COMMIT')
  const stored = JSON.parse(f.db.prepare('SELECT dispatch FROM pe_stdio_v2_dispatches').get().dispatch)
  assert.deepEqual(stored.task, f.task); assert.deepEqual(stored.task.selection.arguments, f.task.selection.arguments)
  assert.deepEqual(stored.permit, first.permit); assert.equal(f.db.prepare('SELECT state FROM pe_stdio_v2_actions WHERE id=?').get(f.actionId).state, 'dispatch-intent')
  for (const repeatId of [requestId, uuid()]) {
    const repeated = await f.service.authorize(f.actionId, repeatId, f.owner)
    assert.equal(repeated.grantOnce, false); assert.deepEqual(repeated.permit, first.permit)
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_start_permits').get().n, 1)
  assert.equal(f.captures.length, 2)
})

test('serialized synthetic callers receive exactly one true response and share original permit', async t => {
  const f = fixture(t); await f.approve()
  const replies = await Promise.all([f.service.authorize(f.actionId, uuid(), f.owner), f.service.authorize(f.actionId, uuid(), f.owner)])
  assert.equal(replies.filter(reply => reply.grantOnce).length, 1)
  assert.deepEqual(replies[0].permit, replies[1].permit)
})

test('commit response loss never returns true and subsequent original-owner query reconciles false', async t => {
  const f = fixture(t); await f.approve(); f.loseCommitReply()
  await assert.rejects(() => f.service.authorize(f.actionId, uuid(), f.owner), /commit_reply_lost/u)
  const query = await f.service.authorize(f.actionId, uuid(), f.owner)
  assert.equal(query.grantOnce, false); assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_dispatches').get().n, 1)
})

test('dispatch write failure rolls back permit and intent; no caller receives authority', async t => {
  const f = fixture(t); await f.approve(); f.failDispatch()
  await f.rejectsWithoutWrites(() => f.service.authorize(f.actionId, uuid(), f.owner), /dispatch_failure/u)
  assert.equal(f.queries.at(-1), 'ROLLBACK')
})

for (const kind of ['cloud', 'desktop']) test(`${kind}: cold owner denied before and after grant; revoked/expired original receipt remains false without recapture`, async t => {
  const f = fixture(t, { kind }); await f.approve()
  const wrong = kind === 'cloud' ? { ...f.owner, runnerInstanceId: uuid() } : { ...f.owner, processId: uuid() }
  await f.rejectsWithoutWrites(() => f.service.authorize(f.actionId, uuid(), wrong), /owner_changed/u)
  const first = await f.service.authorize(f.actionId, uuid(), f.owner)
  f.captureUnavailable(); f.advance(6000)
  f.change('pe_users', 'enabled', false, 'id', f.userId)
  f.change('pe_stdio_v2_connections', 'revision', 2, 'id', f.connectionId)
  f.change('pe_stdio_v2_connections', 'deleted_at', '2026-10-07T00:00:01.000Z', 'id', f.connectionId)
  f.change('pe_stdio_v2_actions', 'cancel_requested', true)
  await f.rejectsWithoutWrites(() => f.service.authorize(f.actionId, uuid(), wrong), /owner_changed/u)
  assert.deepEqual(await f.service.authorize(f.actionId, uuid(), f.owner), { grantOnce: false, permit: first.permit })
  assert.equal(f.captures.length, 2)
})

test('new authority rejects disabled account and captures expiration during the fresh observation', async t => {
  const f = fixture(t); await f.approve(); f.change('pe_users', 'enabled', false, 'id', f.userId)
  await f.rejectsWithoutWrites(() => f.service.authorize(f.actionId, uuid(), f.owner), /account_disabled/u)
  const g = fixture(t); await g.approve(); g.setCaptureHook(() => g.advance(5000))
  await g.rejectsWithoutWrites(() => g.service.authorize(g.actionId, uuid(), g.owner), /expired/u)
})

test('private capture failure and changed whole capture/scope reject without changing state', async t => {
  const f = fixture(t); f.captureUnavailable()
  await f.rejectsWithoutWrites(() => f.service.prepare(f.actionId), /capture_unavailable/u)
  const g = fixture(t); await g.approve(); g.prepared.capture.restartCount = 1
  await g.rejectsWithoutWrites(() => g.service.authorize(g.actionId, uuid(), g.owner), /capture_changed/u)
  const h = fixture(t, { kind: 'desktop' }); await h.approve(); h.prepared.capture.homeMount.source += '-changed'
  h.prepared.fullScopeDigest = sha('scope', { scopeBinding: h.prepared.scopeBinding,
    workspaceMount: h.prepared.capture.workspaceMount, homeMount: h.prepared.capture.homeMount })
  h.prepared.specDigest = sha('spec', { capture: h.prepared.capture, image: h.prepared.actualExecutorImage })
  await h.rejectsWithoutWrites(() => h.service.authorize(h.actionId, uuid(), h.owner), /capture_changed/u)
})

test('initial full scope digest must cover both real mounts and a missing prior preparation is not repaired', async t => {
  const f = fixture(t, { kind: 'desktop' }); f.prepared.fullScopeDigest = sha('scope', f.prepared.scopeBinding)
  await f.rejectsWithoutWrites(() => f.service.prepare(f.actionId), /capture_changed/u)
  const g = fixture(t); g.change('pe_stdio_v2_actions', 'state', 'pending')
  await g.rejectsWithoutWrites(() => g.service.prepare(g.actionId), /preparation_missing/u)
})

test('complete accepted task/configuration/execution digest and origin fields are all checked', async t => {
  const mutations = [f => f.change('pe_stdio_v2_actions', 'task', { ...f.task, invocation: { ...f.task.invocation, argv: ['changed'] } }),
    f => f.change(f.table, 'stdio_task', { ...f.task, scopeBinding: { ...f.task.scopeBinding, bindingGeneration: 2 } }, 'id', f.executionId),
    f => f.change(f.table, 'execution_kind', 'legacy_command', 'id', f.executionId),
    f => f.change(f.table, 'origin_kind', 'operation', 'id', f.executionId),
    f => f.change(f.table, 'continuation_request_id', uuid(), 'id', f.executionId),
    f => f.change('pe_sessions', 'workspace_id', uuid(), 'id', f.sessionId),
    f => f.change('pe_stdio_v2_configurations', 'configuration', { name: 'changed label', invocation: f.task.invocation }, 'connection_id', f.connectionId)]
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f)
    await f.rejectsWithoutWrites(() => f.service.prepare(f.actionId), /changed|Invalid|invalid/u)
  }
  const desktop = fixture(t, { kind: 'desktop' }); desktop.change(desktop.table, 'device_instance_id', uuid(), 'id', desktop.executionId)
  await desktop.rejectsWithoutWrites(() => desktop.service.prepare(desktop.actionId), /scope_changed/u)
})

test('configuration revision/delete/cancel changes block decisions and starts while retaining records', async t => {
  for (const mutate of [f => f.change('pe_stdio_v2_connections', 'revision', 2, 'id', f.connectionId),
    f => f.change('pe_stdio_v2_connections', 'deleted_at', '2026-10-07T00:00:01.000Z', 'id', f.connectionId),
    f => f.change('pe_stdio_v2_actions', 'cancel_requested', true),
    f => f.change(f.table, 'cancel_requested', true, 'id', f.executionId)]) {
    const f = fixture(t), p = await f.service.prepare(f.actionId); mutate(f)
    await f.rejectsWithoutWrites(() => f.service.decide(f.token, { actionId: f.actionId, fingerprint: p.fingerprint, decision: 'once' }), /stale|not_startable/u)
    const g = fixture(t); await g.approve(); mutate(g)
    await g.rejectsWithoutWrites(() => g.service.authorize(g.actionId, uuid(), g.owner), /stale|not_startable/u)
  }
})

test('call requires enabled current successful same-owner full catalog and immutable result digest', async t => {
  for (const mutate of [f => f.change('pe_stdio_v2_connections', 'enabled', false, 'id', f.connectionId),
    f => f.change('pe_stdio_v2_connections', 'current_catalog_id', uuid(), 'id', f.connectionId),
    f => f.change('pe_stdio_v2_actions', 'state', 'failed', 'id', f.discoveryId),
    f => f.change('pe_stdio_v2_catalogs', 'user_id', uuid(), 'id', f.catalogId),
    f => { const changed = clone(rawCatalog); changed[1].extension.order.reverse(); f.change('pe_stdio_v2_catalogs', 'raw_catalog', changed, 'id', f.catalogId) },
    f => f.change('pe_stdio_v2_results', 'result', { tools: [] }, 'action_id', f.discoveryId)]) {
    const f = fixture(t, { phase: 'call' }); mutate(f)
    await f.rejectsWithoutWrites(() => f.service.prepare(f.actionId), /catalog|Invalid|invalid/u)
  }
})

test('persisted preparation binding/HMAC and replay dispatch/permit cannot be partially replaced', async t => {
  const f = fixture(t), p = await f.service.prepare(f.actionId)
  await f.rejectsWithoutWrites(() => f.service.decide(f.token, { actionId: f.actionId, fingerprint: '0'.repeat(64), decision: 'once' }), /fingerprint_changed/u)
  f.change('pe_stdio_v2_preparations', 'fingerprint', '0'.repeat(64), 'action_id')
  await f.rejectsWithoutWrites(() => f.service.inspect(f.token, f.actionId), /preparation_changed/u)
  assert.notEqual(p.fingerprint, '0'.repeat(64))
  for (const mutate of [g => g.change('pe_stdio_v2_start_permits', 'executor_owner', { ...g.owner, runnerInstanceId: uuid() }, 'action_id'),
    g => g.change('pe_stdio_v2_dispatches', 'dispatch_digest', '0'.repeat(64), 'action_id'),
    g => g.change('pe_stdio_v2_preparations', 'approval_binding', { actionId: g.actionId, taskDigest: g.taskDigest,
      preparedDigest: sha('prepared', g.prepared), approvalEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z' }, 'action_id')]) {
    const g = fixture(t); await g.approve(); await g.service.authorize(g.actionId, uuid(), g.owner); mutate(g)
    await g.rejectsWithoutWrites(() => g.service.authorize(g.actionId, uuid(), g.owner), /changed/u)
  }
})

test('approval writes stay in decision/action rows and never manufacture execution/result/cleanup', async t => {
  const f = fixture(t), p = await f.service.prepare(f.actionId); f.queries.length = 0
  await f.service.decide(f.token, { actionId: f.actionId, fingerprint: p.fingerprint, decision: 'once' })
  assert.deepEqual(f.queries.filter(sql => /^INSERT|^UPDATE|^DELETE/u.test(sql)).map(sql => /(?:INTO|UPDATE) (\w+)/u.exec(sql)[1]),
    ['pe_stdio_v2_decisions', 'pe_stdio_v2_actions'])
  assert.equal(f.db.prepare(`SELECT state FROM ${f.table} WHERE id=?`).get(f.executionId).state, 'queued')
})
