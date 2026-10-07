/** Serialized recording PoolClient/SQLite substitute; no actual PG locks, Kube, Runner or private configuration. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { StdioCloudWorkerStoreV2 } from '../lib/platform/stdio-v2-worker-store.js'
import { StdioActionLeaseServiceV2 } from '../lib/platform/stdio-v2-leases.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { parseStdioNoStartReceiptV2 } from '../lib/platform/stdio-v2-no-start.js'
import { stdioActionLeaseV2 } from '@power-evolve/contracts/stdio-runtime'
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
  'permit', 'dispatch', 'raw_catalog', 'image_expectation', 'result', 'binding_snapshot', 'stop_evidence', 'receipt'])
const booleans = new Set(['enabled', 'passwordChangeRequired', 'cancel_requested'])
const dates = new Set(['deletedAt', 'deleted_at', 'expires_at', 'issued_at', 'lease_until', 'now', 'closed_at', 'mcp_chain_cancelled_at', 'stopped_at'])
const mutableTables = ['pe_stdio_v2_actions', 'pe_stdio_v2_preparations', 'pe_stdio_v2_decisions',
  'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_cloud_executions', 'pe_desktop_executions',
  'pe_stdio_v2_no_start_closures', 'pe_mount_slots', 'pe_sandbox_instances']

function fixture(t, { kind = 'cloud', phase = 'discover' } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  let now = Date.parse('2026-10-07T00:00:00.000Z'), tail = Promise.resolve(), captureHook = null
  let commitLoss = false, failDispatch = false, captureUnavailable = false, failAt = null, expireAt = null
  const queries = [], captures = []
  db.function('clock_timestamp', () => new Date(now).toISOString())
  db.function('lease_after', ms => new Date(now + ms).toISOString())
  db.exec(`CREATE TABLE pe_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,enabled INTEGER,
    account_revision INTEGER,credential_version INTEGER,password_change_required INTEGER,deleted_at TEXT,last_claim_at TEXT);
    CREATE TABLE pe_credentials(digest TEXT PRIMARY KEY,user_id TEXT,audience TEXT,credential_version INTEGER,expires_at TEXT);
    CREATE TABLE pe_sessions(id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT);
    CREATE TABLE pe_operations(id TEXT PRIMARY KEY,session_id TEXT,source TEXT,mcp_root_operation_id TEXT,error_code TEXT,mcp_chain_cancelled_at TEXT);
    CREATE TABLE pe_mcp_action_chains(root_operation_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,calls INTEGER,max_calls INTEGER,stopped_at TEXT,expires_at TEXT);
    CREATE TABLE pe_stdio_v2_connections(id TEXT PRIMARY KEY,user_id TEXT,revision INTEGER,enabled INTEGER,current_catalog_id TEXT,deleted_at TEXT);
    CREATE TABLE pe_stdio_v2_configurations(connection_id TEXT,user_id TEXT,revision INTEGER,configuration TEXT,config_digest TEXT,
      PRIMARY KEY(connection_id,revision));
    CREATE TABLE pe_stdio_v2_actions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,connection_id TEXT,
      config_revision INTEGER,config_digest TEXT,phase TEXT,execution_target TEXT,execution_id TEXT UNIQUE,
      task TEXT,task_digest TEXT,state TEXT,cancel_requested INTEGER,request_id TEXT,operation_id TEXT,root_operation_id TEXT,
      call_id TEXT,continuation_request_id TEXT,lease_owner TEXT,lease_epoch INTEGER DEFAULT 0,lease_until TEXT,created_at TEXT,updated_at TEXT,error_code TEXT);
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
      config_digest TEXT,action_id TEXT,raw_catalog TEXT,image_expectation TEXT,catalog_digest TEXT);
    CREATE TABLE pe_stdio_v2_no_start_closures(action_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,phase TEXT,
      execution_target TEXT,execution_id TEXT UNIQUE,task_digest TEXT,prepared_digest TEXT,worker_id TEXT,
      lease_epoch INTEGER,receipt TEXT,receipt_digest TEXT,closed_at TEXT DEFAULT (clock_timestamp()));`)
  for (const table of ['pe_cloud_executions', 'pe_desktop_executions']) db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,
    user_id TEXT,session_id TEXT,execution_kind TEXT,execution_target TEXT,origin_kind TEXT,task_version INTEGER,
    stdio_phase TEXT,stdio_action_id TEXT,stdio_task TEXT,request_digest TEXT,operation_id TEXT,call_id TEXT,command TEXT,cwd TEXT,
    continuation_request_id TEXT,state TEXT,cancel_requested INTEGER,lease_owner TEXT,lease_until TEXT,updated_at TEXT,error_code TEXT,sandbox_name TEXT,pod_uid TEXT,runner_instance_id TEXT
    ${table === 'pe_desktop_executions' ? ',device_id TEXT,directory_id TEXT,device_instance_id TEXT' : ''});`)
  function execute(sql, values = []) {
    queries.push(sql)
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (expireAt && sql.startsWith(expireAt)) { expireAt = null; now += 120000 }
    if (failAt && sql.startsWith(failAt)) { failAt = null; throw new Error('synthetic_write_failure') }
    if (failDispatch && sql.startsWith('INSERT INTO pe_stdio_v2_dispatches')) throw new Error('synthetic_dispatch_failure')
    const translated = sql.replace(/=ANY\((\$\d+)::(?:uuid|text)\[\]\)/gu, ' IN (SELECT value FROM json_each($1))')
      .replace(/ FOR (?:NO KEY UPDATE|UPDATE|SHARE)(?: OF o,r,c)?/gu, '')
      .replace(/::integer/gu, '')
      .replace(/clock_timestamp\(\)\+\$(\d+)::double precision\*interval '1 millisecond'/gu, (_all, n) => `lease_after($${n})`)
    const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), value instanceof Date ? value.toISOString()
      : typeof value === 'boolean' ? Number(value) : Array.isArray(value) ? JSON.stringify(value) : value]))
    const before = db.prepare('SELECT total_changes() AS n').get().n
    const rows = db.prepare(translated).all(bindings).map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field,
      value === null ? null : jsonColumns.has(field) ? JSON.parse(value) : booleans.has(field) ? Boolean(value)
      : dates.has(field) ? new Date(value) : ['lease_epoch', 'generation'].includes(field) ? String(value) : value])))
    if (sql === 'COMMIT' && commitLoss) { commitLoss = false; throw new Error('synthetic_commit_reply_lost') }
    return { rows, rowCount: rows.length || db.prepare('SELECT total_changes() AS n').get().n - before }
  }
  const pool = { async connect() {
    const prior = tail; let release
    tail = new Promise(resolve => { release = resolve }); await prior
    const client = Object.assign(new EventEmitter(), { released: false, query: async (sql, values) => execute(sql, values),
      release() { client.released = true; release() } })
    return client
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
    insert('pe_operations', { id: task.origin.rootOperationId, session_id: sessionId, source: 'user', mcp_root_operation_id: null,
      error_code: null, mcp_chain_cancelled_at: null })
    insert('pe_operations', { id: task.origin.operationId, session_id: sessionId, source: 'mcp_result', mcp_root_operation_id: task.origin.rootOperationId,
      error_code: null, mcp_chain_cancelled_at: null })
    insert('pe_mcp_action_chains', { root_operation_id: task.origin.rootOperationId, user_id: userId, session_id: sessionId,
      calls: 2, max_calls: 3, stopped_at: null, expires_at: new Date(now + 60000).toISOString() })
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
  const storeOptions = { limits, leaseMs: 5000, maxActive: 2, maxCandidates: 4 }
  const store = new StdioCloudWorkerStoreV2(pool, storeOptions), leases = new StdioActionLeaseServiceV2(pool, { leaseMs: 5000 })
  const workerId = uuid()
  const binding = { workspaceId, spaceId: scopeBinding.target?.spaceId ?? uuid(), rootRelativePath: scopeBinding.target?.rootRelativePath ?? 'synthetic', rootKey: uuid(), generation: 1 }
  const ready = { name: capture.podName ?? 'synthetic-pod', podUid: capture.podUid ?? uuid(), runnerInstanceId, token: 'synthetic-private-token', restartCount: 0, generation: '1', sessionId, userId, binding }
  db.exec(`CREATE TABLE pe_mount_slots(user_id TEXT PRIMARY KEY,session_id TEXT,workspace_id TEXT,generation INTEGER,state TEXT,pod_uid TEXT,runner_instance_id TEXT,binding_snapshot TEXT,stop_pod_uid TEXT,stop_evidence TEXT);
    CREATE TABLE pe_sandbox_instances(session_id TEXT PRIMARY KEY,user_id TEXT,name TEXT,state TEXT,pod_uid TEXT,runner_instance_id TEXT,binding_snapshot TEXT,stop_pod_uid TEXT,stop_evidence TEXT);
    CREATE TABLE pe_workspaces(id TEXT PRIMARY KEY,user_id TEXT,binding_generation INTEGER);
    CREATE TABLE pe_workspace_bindings(workspace_id TEXT PRIMARY KEY,user_id TEXT,space_id TEXT,root_relative_path TEXT);
    CREATE TABLE pe_storage_spaces(id TEXT PRIMARY KEY,user_id TEXT,root_key TEXT);
    CREATE TABLE pe_cloud_execution_resolutions(execution_id TEXT);`)
  insert('pe_mount_slots', { user_id: userId, session_id: sessionId, workspace_id: workspaceId, generation: 1, state: 'ready', pod_uid: ready.podUid, runner_instance_id: runnerInstanceId, binding_snapshot: binding })
  insert('pe_sandbox_instances', { session_id: sessionId, user_id: userId, name: ready.name, state: 'ready', pod_uid: ready.podUid, runner_instance_id: runnerInstanceId, binding_snapshot: binding })
  insert('pe_workspaces', { id: workspaceId, user_id: userId, binding_generation: binding.generation })
  insert('pe_workspace_bindings', { workspace_id: workspaceId, user_id: userId, space_id: binding.spaceId, root_relative_path: binding.rootRelativePath })
  insert('pe_storage_spaces', { id: binding.spaceId, user_id: userId, root_key: binding.rootKey })
  change('pe_stdio_v2_actions', 'created_at', new Date(now).toISOString()); change('pe_stdio_v2_actions', 'updated_at', new Date(now).toISOString())
  const snapshot = () => JSON.stringify(mutableTables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
  async function rejectsWithoutWrites(operation, pattern) {
    const before = snapshot(); await assert.rejects(operation, pattern); assert.equal(snapshot(), before)
  }
  async function approve() { const p = await service.prepare(actionId); await service.decide(token, { actionId, fingerprint: p.fingerprint, decision: 'once' }); return p }
  return { db, pool, service, options, store, storeOptions, leases, workerId, ready, binding, task, taskDigest, prepared, owner, actionId, executionId, executionRef, table, userId,
    sessionId, connectionId, catalogId, discoveryId, token, agentToken, otherToken, captures, queries, insert, change, snapshot,
    approve, rejectsWithoutWrites, advance(ms) { now += ms }, setCaptureHook(fn) { captureHook = fn },
    loseCommitReply() { commitLoss = true }, failDispatch() { failDispatch = true }, captureUnavailable() { captureUnavailable = true }, failAt(sql) { failAt = sql }, expireAt(sql) { expireAt = sql } }
}

async function attached(f) {
  const lease = await f.store.claimNext(f.workerId)
  assert(lease)
  await f.store.beginPreparation(lease)
  await f.store.attach(lease, f.ready)
  return lease
}
async function permitted(f, lease) {
  const prepared = await f.service.prepareLeased(lease)
  await f.service.decide(f.token, { actionId: f.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
  const authorization = await f.service.authorizeLeased(lease, uuid(), f.owner)
  assert.equal(authorization.grantOnce, true)
  return authorization
}
function candidate(f, timestamp = '2026-10-06T00:00:00.000Z', sameOwner = false) {
  const userId = sameOwner ? f.userId : uuid(), sessionId = uuid(), workspaceId = uuid(), connectionId = uuid(), actionId = uuid(), executionId = uuid()
  const task = clone(f.task)
  Object.assign(task, { userId, sessionId, connectionId, actionId, origin: { kind: 'stdio_discovery', requestId: uuid() } })
  Object.assign(task.scopeBinding, { userId, workspaceId, home: { kind: 'user', userId } })
  const rows = [['pe_users', 'id', f.userId], ['pe_sessions', 'id', f.sessionId],
    ['pe_stdio_v2_connections', 'id', f.connectionId], ['pe_stdio_v2_configurations', 'connection_id', f.connectionId],
    ['pe_stdio_v2_actions', 'id', f.actionId], ['pe_cloud_executions', 'id', f.executionId]]
  for (const [table, column, id] of rows) {
    if (sameOwner && table === 'pe_users') continue
    const row = { ...f.db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).get(id) }
    for (const name of Object.keys(row)) if (jsonColumns.has(name) && row[name] !== null) row[name] = JSON.parse(row[name])
    if (table === 'pe_users') row.id = userId
    else {
      Object.assign(row, { user_id: userId })
      if (table === 'pe_sessions') Object.assign(row, { id: sessionId, workspace_id: workspaceId })
      if (table === 'pe_stdio_v2_connections') Object.assign(row, { id: connectionId, current_catalog_id: null, enabled: false })
      if (table === 'pe_stdio_v2_configurations') row.connection_id = connectionId
      if (table === 'pe_stdio_v2_actions') Object.assign(row, { id: actionId, session_id: sessionId, connection_id: connectionId,
        execution_id: executionId, task, task_digest: sha('task', task), state: 'queued', cancel_requested: false,
        request_id: task.origin.requestId, lease_owner: null, lease_epoch: 0, lease_until: null, created_at: timestamp, updated_at: timestamp })
      if (table === 'pe_cloud_executions') Object.assign(row, { id: executionId, session_id: sessionId, stdio_action_id: actionId,
        stdio_task: task, request_digest: sha('task', task), state: 'queued', cancel_requested: false,
        lease_owner: null, lease_until: null, sandbox_name: null, pod_uid: null, runner_instance_id: null })
    }
    f.insert(table, row)
  }
  return { actionId, executionId, task }
}

test('invalid trusted worker budgets reject before obtaining a pool client', () => {
  const pool = { connect() { assert.fail('constructor connected') } }
  for (const overrides of [{ leaseMs: 0 }, { maxActive: 0 }, { maxCandidates: 0 }, { leaseMs: 2_147_483_648 }]) {
    assert.throws(() => new StdioCloudWorkerStoreV2(pool, { limits, leaseMs: 5000, maxActive: 2, maxCandidates: 4, ...overrides }), /options_invalid/u)
  }
})

test('same original lease mirrors execution; preparation, attach, approval and private capture preserve full task and release before returned HTTP use', async t => {
  const f = fixture(t, { phase: 'call' }), lease = await attached(f)
  const initial = await f.store.snapshot(lease)
  assert.deepEqual(initial.task, f.task); assert.equal(initial.taskDigest, f.taskDigest)
  assert.equal(initial.state, 'preparing'); assert.equal(initial.cancelRequested, false)
  assert.deepEqual(initial.writer, { name: f.ready.name, podUid: f.ready.podUid, runnerInstanceId: f.ready.runnerInstanceId })
  assert.equal(JSON.stringify(initial).includes(f.ready.token), false); assert.equal(initial.prepared, null); assert.equal(initial.dispatch, null)
  const first = await permitted(f, lease), after = await f.store.snapshot(lease)
  assert.deepEqual(after.dispatch.task.selection.arguments, f.task.selection.arguments)
  assert.deepEqual(after.dispatch.permit, first.permit); assert.equal(after.state, 'dispatch-intent')
  let capturedClient
  const observed = await f.store.capture(lease, 'dispatch', async client => {
    capturedClient = client
    assert.equal(typeof client.query, 'function')
    await client.query('SELECT clock_timestamp() AS now')
    assert.notEqual(f.queries.at(-1), 'COMMIT')
    return f.ready
  })
  assert.deepEqual(observed, f.ready); assert.equal(f.queries.at(-1), 'COMMIT'); assert.equal(capturedClient.released, true)
  f.advance(1000); await f.store.renew(lease)
  const a = f.db.prepare('SELECT lease_owner,lease_until,lease_epoch FROM pe_stdio_v2_actions WHERE id=?').get(f.actionId)
  const e = f.db.prepare('SELECT lease_owner,lease_until FROM pe_cloud_executions WHERE id=?').get(f.executionId)
  assert.equal(a.lease_epoch, lease.leaseEpoch); assert.equal(a.lease_owner, e.lease_owner); assert.equal(a.lease_until, e.lease_until)
  const tables = f.queries.filter(sql => /FOR (?:NO KEY UPDATE|UPDATE)/u.test(sql)).slice(0, 5).map(sql => /FROM (\w+)/u.exec(sql)[1])
  assert.deepEqual(tables, ['pe_users', 'pe_sessions', 'pe_stdio_v2_connections', 'pe_stdio_v2_actions', 'pe_cloud_executions'])
  initial.task.selection.arguments.text = 'local output mutation'
  assert.deepEqual((await f.store.snapshot(lease)).task, f.task)
})

test('serialized replica claims share Cloud legacy plus generic live capacity and rotate after lease release without losing writers', async t => {
  const f = fixture(t), other = candidate(f), store = new StdioCloudWorkerStoreV2(f.pool, { ...f.storeOptions, maxActive: 1 })
  const owners = [uuid(), uuid()]
  const results = await Promise.all(owners.map(id => store.claimNext(id)))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(results.find(Boolean).actionId, other.actionId)
  f.advance(1); await store.release(results.find(Boolean))
  const next = await store.claimNext(owners[1]); assert.equal(next.actionId, f.actionId)
  const own = await store.snapshot(next); assert.equal(own.writer, null)
  await store.release(next)
  const legacyId = uuid()
  f.insert('pe_cloud_executions', { id: legacyId, execution_kind: 'legacy_command', state: 'queued', lease_owner: uuid(), lease_until: '2099-01-01T00:00:00.000Z' })
  const before = f.queries.length
  assert.equal(await store.claimNext(uuid()), null)
  assert.equal(f.queries.slice(before).some(sql => sql.startsWith('SELECT a.id')), false)
  f.change('pe_cloud_executions', 'lease_until', '2000-01-01T00:00:00.000Z', 'id', legacyId)
  assert(await store.claimNext(uuid()))
})

test('bounded candidate scans preserve corrupt tasks, release their owner locks by savepoint and can reach the next eligible owner', async t => {
  const f = fixture(t), bad = candidate(f), good = candidate(f, '2026-10-06T01:00:00.000Z')
  f.change('pe_stdio_v2_actions', 'task_digest', '0'.repeat(64), 'id', bad.actionId)
  const bounded = new StdioCloudWorkerStoreV2(f.pool, { ...f.storeOptions, maxCandidates: 1 })
  const before = f.snapshot()
  assert.equal(await bounded.claimNext(f.workerId), null); assert.equal(f.snapshot(), before)
  const lease = await f.store.claimNext(f.workerId); assert.equal(lease.actionId, good.actionId)
  assert(f.queries.includes('ROLLBACK TO SAVEPOINT stdio_cloud_candidate'))
  assert.equal(f.db.prepare('SELECT lease_owner FROM pe_stdio_v2_actions WHERE id=?').get(bad.actionId).lease_owner, null)
})

test('durable owner rotation admits Bob after one Alice claim despite older Alice backlog across service instances', async t => {
  const f = fixture(t)
  f.change('pe_stdio_v2_actions', 'created_at', '2026-10-04T00:00:00.000Z')
  const backlog = candidate(f, '2026-10-05T00:00:00.000Z', true), bob = candidate(f, '2026-10-06T00:00:00.000Z')
  const replica = new StdioCloudWorkerStoreV2(f.pool, f.storeOptions)
  assert.equal((await f.store.claimNext(uuid())).actionId, f.actionId)
  assert.equal((await replica.claimNext(uuid())).actionId, bob.actionId)
  assert.equal(await f.store.claimNext(uuid()), null)
  assert.equal(f.db.prepare('SELECT lease_owner FROM pe_stdio_v2_actions WHERE id=?').get(backlog.actionId).lease_owner, null)
  assert.equal(f.db.prepare('SELECT last_claim_at FROM pe_users WHERE id=?').get(f.userId).last_claim_at, '2026-10-07T00:00:00.000Z')
})

test('pending independent approval releases its worker lease without hot claims until expiration or cancellation', async t => {
  const f = fixture(t), lease = await attached(f)
  await f.service.prepareLeased(lease); await f.store.release(lease)
  assert.equal(await f.store.claimNext(uuid()), null)
  f.advance(4999); assert.equal(await f.store.claimNext(uuid()), null)
  f.advance(1); const expired = await f.store.claimNext(uuid())
  assert(expired); assert.equal((await f.store.snapshot(expired)).cancelRequested, true)
})

test('pending calls are claimed immediately on original root cancellation, chain stop or expiry before approval expires', async t => {
  for (const [reason, mutate] of [
    ['root-cancelled', f => f.change('pe_operations', 'mcp_chain_cancelled_at', '2026-10-07T00:00:00.000Z', 'id', f.task.origin.rootOperationId)],
    ['chain-stopped', f => f.change('pe_mcp_action_chains', 'stopped_at', '2026-10-07T00:00:00.000Z', 'root_operation_id', f.task.origin.rootOperationId)],
    ['chain-expired', f => f.change('pe_mcp_action_chains', 'expires_at', '2026-10-07T00:00:00.000Z', 'root_operation_id', f.task.origin.rootOperationId)],
    ['operation-cancelled', f => f.change('pe_operations', 'error_code', 'cancel_requested', 'id', f.task.origin.operationId)],
  ]) await t.test(reason, async () => {
    const f = fixture(t, { phase: 'call' }), held = await attached(f)
    await f.service.prepareLeased(held); await f.store.release(held)
    assert.equal(await f.store.claimNext(uuid()), null)
    mutate(f)
    const originalChain = f.db.prepare('SELECT * FROM pe_mcp_action_chains').get()
    const lease = await f.store.claimNext(uuid()); assert(lease)
    const snapshot = await f.store.snapshot(lease)
    assert.equal(snapshot.cancelRequested, true); assert.equal(snapshot.prepared.expiresAt, '2026-10-07T00:00:05.000Z')
    await f.rejectsWithoutWrites(() => f.store.beginPreparation(lease), /not_startable/u)
    for (const mode of ['acquire', 'mutation']) await f.rejectsWithoutWrites(() => provisioning(f, lease, mode), /not_startable/u)
    assert.deepEqual(f.db.prepare('SELECT * FROM pe_mcp_action_chains').get(), originalChain, 'the child never renews its original root budget')
  })
})

test('root cancellation after committed dispatch preserves exact original writer observation and rejects fresh dispatch capture', async t => {
  const f = fixture(t, { phase: 'call' }), lease = await attached(f)
  await permitted(f, lease)
  const before = await f.store.snapshot(lease)
  f.change('pe_operations', 'mcp_chain_cancelled_at', '2026-10-07T00:00:00.000Z', 'id', f.task.origin.rootOperationId)
  const cancelled = await f.store.snapshot(lease)
  assert.equal(cancelled.cancelRequested, true); assert.deepEqual(cancelled.dispatch, before.dispatch); assert.deepEqual(cancelled.writer, before.writer)
  await f.rejectsWithoutWrites(() => f.store.capture(lease, 'dispatch', async () => { assert.fail('new dispatch observation ran') }), /not_startable/u)
  assert.deepEqual(await f.store.capture(lease, 'observe', async () => f.ready), f.ready)
  assert.deepEqual((await f.store.snapshot(lease)).writer, before.writer)
})

test('only the actual user root with no parent authorizes a call; missing, foreign and child-as-root records refuse without writes', async t => {
  for (const mutate of [
    f => f.db.prepare('DELETE FROM pe_operations WHERE id=?').run(f.task.origin.rootOperationId),
    f => f.change('pe_operations', 'source', 'mcp_result', 'id', f.task.origin.rootOperationId),
    f => f.change('pe_operations', 'mcp_root_operation_id', uuid(), 'id', f.task.origin.rootOperationId),
    f => f.change('pe_mcp_action_chains', 'user_id', uuid(), 'root_operation_id', f.task.origin.rootOperationId),
  ]) {
    const f = fixture(t, { phase: 'call' }), lease = await attached(f); mutate(f)
    await f.rejectsWithoutWrites(() => f.store.snapshot(lease), /origin_changed/u)
    await f.rejectsWithoutWrites(() => f.store.beginPreparation(lease), /origin_changed/u)
  }
})

test('cancelled, rejected, expired and revoked configuration work remains claimable and defers with dual cancellation flags without retiring resources', async t => {
  for (const mutate of [f => f.change('pe_stdio_v2_actions', 'state', 'rejected'), f => f.change('pe_stdio_v2_actions', 'state', 'expired'),
    f => f.change('pe_stdio_v2_actions', 'cancel_requested', true), f => f.change('pe_users', 'enabled', false, 'id', f.userId),
    f => f.change('pe_users', 'deleted_at', '2026-10-07T00:00:00.000Z', 'id', f.userId),
    f => f.change('pe_stdio_v2_connections', 'revision', 2, 'id', f.connectionId),
    f => f.change('pe_stdio_v2_connections', 'deleted_at', '2026-10-07T00:00:00.000Z', 'id', f.connectionId)]) {
    const f = fixture(t); mutate(f)
    const lease = await f.store.claimNext(f.workerId); assert(lease)
    assert.equal((await f.store.snapshot(lease)).cancelRequested, true)
    await f.rejectsWithoutWrites(() => f.store.beginPreparation(lease), /not_startable/u)
    await f.store.defer(lease, 'stdio_v2_cancel_requested')
    const a = f.db.prepare('SELECT * FROM pe_stdio_v2_actions WHERE id=?').get(f.actionId)
    const e = f.db.prepare('SELECT * FROM pe_cloud_executions WHERE id=?').get(f.executionId)
    assert.equal(a.state, 'blocked'); assert.equal(e.state, 'uncertain'); assert.equal(a.cancel_requested, 1); assert.equal(e.cancel_requested, 1)
    assert.equal(a.lease_owner, f.workerId); assert.equal(e.lease_owner, f.workerId)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_results').get().n, 0)
  }
  const f = fixture(t), lease = await attached(f); await f.service.prepareLeased(lease)
  f.advance(5000); const newLease = await f.store.claimNext(uuid())
  assert.equal((await f.store.snapshot(newLease)).cancelRequested, true)
  await f.store.defer(newLease, 'stdio_v2_cancel_requested')
  assert.deepEqual((await f.store.snapshot(newLease)).writer, { name: f.ready.name, podUid: f.ready.podUid, runnerInstanceId: f.ready.runnerInstanceId })
})

test('attach refuses changed owned binding, writer or mount generation and never changes an existing Prepared', async t => {
  for (const mutate of [ready => { ready.userId = uuid() }, ready => { ready.sessionId = uuid() },
    ready => { ready.podUid = uuid() }, ready => { ready.runnerInstanceId = uuid() }, ready => { ready.generation = '2' },
    ready => { ready.binding.rootKey = uuid() }, ready => { ready.binding.rootRelativePath = 'foreign' }]) {
    const f = fixture(t), lease = await attached(f), ready = clone(f.ready); mutate(ready)
    await f.rejectsWithoutWrites(() => f.store.attach(lease, ready), /writer_changed|Invalid/u)
  }
  const f = fixture(t), lease = await attached(f), p = await f.service.prepareLeased(lease), before = f.snapshot()
  await f.store.attach(lease, f.ready); assert.equal(f.snapshot(), before)
  assert.deepEqual((await f.store.snapshot(lease)).prepared, p)
  await f.rejectsWithoutWrites(() => f.store.beginPreparation(lease), /not_startable/u)
})

test('ready creation observed after cancellation or revocation is attached for cleanup without gaining start authority', async t => {
  for (const mutate of [f => f.change('pe_stdio_v2_actions', 'cancel_requested', true),
    f => f.change('pe_users', 'enabled', false, 'id', f.userId),
    f => f.change('pe_stdio_v2_connections', 'revision', 2, 'id', f.connectionId),
    f => f.change('pe_stdio_v2_connections', 'deleted_at', '2026-10-07T00:00:00.000Z', 'id', f.connectionId)]) {
    const f = fixture(t), lease = await f.store.claimNext(f.workerId)
    await f.store.beginPreparation(lease); mutate(f)
    await f.store.attach(lease, f.ready)
    const snapshot = await f.store.snapshot(lease)
    assert.equal(snapshot.cancelRequested, true)
    assert.deepEqual(snapshot.writer, { name: f.ready.name, podUid: f.ready.podUid, runnerInstanceId: f.ready.runnerInstanceId })
    await f.rejectsWithoutWrites(() => f.service.prepareLeased(lease), /not_startable|stale|disabled/u)
    await f.store.defer(lease, 'stdio_v2_cancel_requested')
    assert.equal(f.db.prepare('SELECT cancel_requested FROM pe_cloud_executions WHERE id=?').get(f.executionId).cancel_requested, 1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_start_permits').get().n, 0)
  }
})

test('temporary preparation failure recovers the same no-permit task with or without its original captured writer', async t => {
  for (const withWriter of [false, true]) {
    const f = fixture(t), lease = await f.store.claimNext(f.workerId)
    await f.store.beginPreparation(lease)
    if (withWriter) await f.store.attach(lease, f.ready)
    const original = await f.store.snapshot(lease)
    await f.store.defer(lease, 'synthetic_capture_unavailable'); await f.store.release(lease)
    const successor = await f.store.claimNext(uuid())
    await f.store.beginPreparation(successor)
    const recovered = await f.store.snapshot(successor)
    assert.equal(recovered.state, 'preparing'); assert.deepEqual(recovered.task, original.task); assert.deepEqual(recovered.writer, original.writer)
    assert.equal(f.db.prepare('SELECT state FROM pe_cloud_executions WHERE id=?').get(f.executionId).state, 'starting')
    if (withWriter) assert.deepEqual((await f.service.prepareLeased(successor)).prepared, f.prepared)
  }
})

test('unknown deferral and release preserve captured writer and immutable dispatch; takeover never reissues true', async t => {
  const f = fixture(t), lease = await attached(f), first = await permitted(f, lease)
  await f.store.defer(lease, 'synthetic_runner_unavailable')
  const blocked = await f.store.snapshot(lease); assert.equal(blocked.state, 'blocked'); assert.equal(blocked.cancelRequested, false)
  f.advance(1); await f.store.release(lease)
  const successor = await f.store.claimNext(uuid()); assert.equal(successor.leaseEpoch, lease.leaseEpoch + 1)
  assert.deepEqual((await f.store.snapshot(successor)).dispatch, blocked.dispatch)
  const repeated = await f.service.authorizeLeased(successor, uuid(), f.owner)
  assert.equal(repeated.grantOnce, false); assert.deepEqual(repeated.permit, first.permit)
  await f.rejectsWithoutWrites(() => f.store.release(lease), /lease_lost/u)
  await f.rejectsWithoutWrites(() => f.store.beginPreparation(successor), /not_startable/u)
  f.change('pe_users', 'enabled', false, 'id', f.userId)
  await f.rejectsWithoutWrites(() => f.store.capture(successor, 'dispatch', async () => assert.fail('revoked dispatch callback')), /not_startable/u)
  assert.deepEqual(await f.store.capture(successor, 'observe', async () => f.ready), f.ready)
})

test('every lifecycle method rejects changed original task/config or missing dispatch without discarding leases or writers', async t => {
  for (const mutate of [f => f.change('pe_stdio_v2_actions', 'task_digest', '0'.repeat(64)),
    f => f.change('pe_cloud_executions', 'request_digest', '0'.repeat(64), 'id', f.executionId),
    f => f.change('pe_stdio_v2_configurations', 'config_digest', '0'.repeat(64), 'connection_id', f.connectionId),
    f => f.change('pe_cloud_executions', 'pod_uid', null, 'id', f.executionId),
    f => f.change('pe_stdio_v2_dispatches', 'dispatch_digest', '0'.repeat(64), 'action_id'),
    f => f.db.prepare('DELETE FROM pe_stdio_v2_dispatches WHERE action_id=?').run(f.actionId),
    f => f.change('pe_stdio_v2_preparations', 'prepared_digest', '0'.repeat(64), 'action_id')]) {
    const f = fixture(t), lease = await attached(f); await permitted(f, lease); mutate(f)
    for (const operation of [() => f.store.snapshot(lease), () => f.store.renew(lease), () => f.store.release(lease),
      () => f.store.defer(lease, 'synthetic_failure'), () => f.store.beginPreparation(lease), () => f.store.attach(lease, f.ready),
      () => f.store.capture(lease, 'observe', async () => assert.fail('corrupt callback'))]) {
      await f.rejectsWithoutWrites(operation, /changed|missing|Invalid|invalid/u)
    }
  }
})

test('lease clock loss or failed mirror rolls back preparation, attach, renewal and dual deferral atomically', async t => {
  for (const [method, trigger] of [['beginPreparation', 'UPDATE pe_cloud_executions'], ['attach', 'UPDATE pe_cloud_executions'],
    ['renew', 'UPDATE pe_cloud_executions'], ['defer', 'UPDATE pe_cloud_executions'], ['release', 'UPDATE pe_stdio_v2_actions']]) {
    const f = fixture(t), lease = await f.store.claimNext(f.workerId)
    if (method !== 'beginPreparation') await f.store.beginPreparation(lease)
    f.expireAt(trigger)
    await f.rejectsWithoutWrites(() => method === 'attach' ? f.store.attach(lease, f.ready)
      : method === 'defer' ? f.store.defer(lease, 'stdio_v2_cancel_requested') : f.store[method](lease), /lease_lost/u)
  }
  const f = fixture(t), before = f.snapshot(); f.failAt('UPDATE pe_cloud_executions')
  await assert.rejects(() => f.store.claimNext(f.workerId), /synthetic_write_failure/u); assert.equal(f.snapshot(), before)
  const g = fixture(t), lease = await attached(g); g.setCaptureHook(() => g.advance(5001))
  await g.rejectsWithoutWrites(() => g.service.prepareLeased(lease), /lease_lost/u)
  const h = fixture(t), held = await attached(h); await permitted(h, held)
  await h.rejectsWithoutWrites(() => h.store.capture(held, 'observe', async () => { h.advance(5001); return h.ready }), /lease_lost/u)
})

test('leased authorization checks capture and each durable write, while existing API and immutable permit retain false-only replay', async t => {
  const f = fixture(t), lease = await attached(f)
  const bad = stdioActionLeaseV2.parse({ ...lease, workerId: uuid() })
  await f.rejectsWithoutWrites(() => f.service.prepareLeased(bad), /lease_lost/u); assert.equal(f.captures.length, 0)
  await f.service.prepareLeased(lease)
  const p = await f.store.snapshot(lease)
  await f.service.decide(f.token, { actionId: f.actionId, fingerprint: p.prepared.fingerprint, decision: 'once' })
  await f.rejectsWithoutWrites(() => f.service.authorizeLeased(bad, uuid(), f.owner), /lease_lost/u)
  for (const trigger of ['INSERT INTO pe_stdio_v2_start_permits', 'INSERT INTO pe_stdio_v2_dispatches', 'UPDATE pe_stdio_v2_actions']) {
    const g = fixture(t), held = await attached(g), q = await g.service.prepareLeased(held)
    await g.service.decide(g.token, { actionId: g.actionId, fingerprint: q.fingerprint, decision: 'once' })
    g.expireAt(trigger)
    await g.rejectsWithoutWrites(() => g.service.authorizeLeased(held, uuid(), g.owner), /lease_lost/u)
  }
  for (const trigger of ['INSERT INTO pe_stdio_v2_preparations', 'UPDATE pe_stdio_v2_actions']) {
    const g = fixture(t), held = await attached(g); g.expireAt(trigger)
    await g.rejectsWithoutWrites(() => g.service.prepareLeased(held), /lease_lost/u)
  }
  const first = await f.service.authorizeLeased(lease, uuid(), f.owner)
  assert.equal(first.grantOnce, true)
  assert.equal((await f.service.authorize(f.actionId, uuid(), f.owner)).grantOnce, false)
  assert.equal((await f.service.authorizeLeased(lease, uuid(), f.owner)).grantOnce, false)
  f.advance(5001)
  await f.rejectsWithoutWrites(() => f.service.authorizeLeased(lease, uuid(), f.owner), /lease_lost/u)
})

test('explicit lease service mirrors original Cloud expiry and retains rejected creation reconciliation', async t => {
  const f = fixture(t); f.change('pe_stdio_v2_actions', 'state', 'rejected')
  const first = await f.leases.claim(f.actionId, f.workerId); assert(first)
  assert.deepEqual(await f.leases.claim(f.actionId, f.workerId), first)
  assert.equal(await f.leases.claim(f.actionId, uuid()), null)
  f.advance(1); assert.deepEqual(await f.leases.renew(first), first)
  const a = f.db.prepare('SELECT lease_owner,lease_until FROM pe_stdio_v2_actions WHERE id=?').get(f.actionId)
  const e = f.db.prepare('SELECT lease_owner,lease_until FROM pe_cloud_executions WHERE id=?').get(f.executionId)
  assert.deepEqual(a, e)
  f.advance(5000); await f.rejectsWithoutWrites(() => f.leases.renew(first), /lease_lost/u)
  const second = await f.leases.claim(f.actionId, uuid()); assert.equal(second.leaseEpoch, first.leaseEpoch + 1)
})

async function provisioning(f, lease, mode, { sessionId = f.sessionId, userId = f.userId } = {}) {
  const client = await f.pool.connect(), connect = f.pool.connect
  f.pool.connect = () => assert.fail('supplied-client provision reconnected the pool')
  f.pool.query = () => assert.fail('supplied-client provision queried the pool')
  try {
    await client.query('BEGIN')
    await f.store.assertProvisioning(client, lease, sessionId, userId, mode)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK'); throw error
  } finally { f.pool.connect = connect; client.release() }
}
function unallocate(f) {
  f.db.prepare('DELETE FROM pe_sandbox_instances WHERE session_id=?').run(f.sessionId)
  f.db.prepare('DELETE FROM pe_mount_slots WHERE user_id=?').run(f.userId)
}
function stoppedCreation(f) {
  const proof = { status: 'KUBELET_STOPPED', podUid: f.ready.podUid, sandboxUid: uuid(), generation: '1',
    sessionId: f.sessionId, runnerInstanceId: null, bindingSnapshot: f.binding, observedAt: '2026-10-07T00:00:00.000Z' }
  f.change('pe_mount_slots', 'state', 'free', 'user_id', f.userId)
  for (const key of ['session_id', 'workspace_id', 'pod_uid', 'runner_instance_id']) f.change('pe_mount_slots', key, null, 'user_id', f.userId)
  f.change('pe_sandbox_instances', 'state', 'deleted', 'session_id', f.sessionId)
  for (const key of ['pod_uid', 'runner_instance_id']) f.change('pe_sandbox_instances', key, null, 'session_id', f.sessionId)
  for (const [table, key, id] of [['pe_mount_slots', 'user_id', f.userId], ['pe_sandbox_instances', 'session_id', f.sessionId]]) {
    f.change(table, 'stop_pod_uid', proof.podUid, key, id); f.change(table, 'stop_evidence', proof, key, id)
  }
  return proof
}
function assertNoRuntimeResult(f) {
  for (const table of ['pe_stdio_v2_results', 'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_catalogs']) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
  }
}

test('provision fences reuse only the supplied client, reject stale original grants, and retain cancelled creation identity in record mode', async t => {
  const f = fixture(t), lease = await f.store.claimNext(f.workerId)
  await f.store.beginPreparation(lease)
  for (const mode of ['acquire', 'mutation', 'record']) await provisioning(f, lease, mode)
  const original = f.snapshot()
  for (const fields of [{ sessionId: uuid() }, { userId: uuid() }]) {
    await f.rejectsWithoutWrites(() => provisioning(f, lease, 'record', fields), /original_changed/u)
  }
  await f.rejectsWithoutWrites(() => provisioning(f, { ...lease, leaseEpoch: lease.leaseEpoch + 1 }, 'record'), /lease_lost/u)
  assert.equal(f.snapshot(), original)
  f.change('pe_cloud_executions', 'lease_owner', uuid(), 'id', f.executionId)
  await f.rejectsWithoutWrites(() => provisioning(f, lease, 'record'), /lease_lost/u)
  f.change('pe_cloud_executions', 'lease_owner', lease.workerId, 'id', f.executionId)
  f.change('pe_users', 'enabled', false, 'id', f.userId)
  for (const mode of ['acquire', 'mutation']) await f.rejectsWithoutWrites(() => provisioning(f, lease, mode), /not_startable/u)
  await provisioning(f, lease, 'record')
  for (const state of ['rejected', 'expired']) {
    f.change('pe_stdio_v2_actions', 'state', state); await provisioning(f, lease, 'record')
  }
  f.change('pe_stdio_v2_actions', 'state', 'cancelled')
  await f.rejectsWithoutWrites(() => provisioning(f, lease, 'record'), /not_startable/u)
})

test('queued cancelled discovery closes without allocated original resources, preserves foreign slots, and creates only a no-start receipt', async t => {
  for (const foreign of [false, true]) {
    const f = fixture(t), lease = await f.store.claimNext(f.workerId)
    if (foreign) {
      f.db.prepare('DELETE FROM pe_sandbox_instances WHERE session_id=?').run(f.sessionId)
      f.change('pe_mount_slots', 'session_id', uuid(), 'user_id', f.userId)
    } else unallocate(f)
    f.change('pe_stdio_v2_actions', 'cancel_requested', true)
    const beforeSlot = f.db.prepare('SELECT * FROM pe_mount_slots').all(), originalTask = clone(f.task)
    assert.equal(await f.store.readNoStart(f.actionId), null)
    const receipt = await f.store.closeUnstarted(lease)
    assert.equal(receipt.kind, 'unstarted_closed'); assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.startNeverAuthorized, true)
    assert.equal(receipt.taskDigest, f.taskDigest); assert.deepEqual(receipt.executionRef, f.executionRef)
    assert.deepEqual(receipt.resource, { kind: 'unallocated' }); assert.equal(receipt.preparedDigest, null)
    assert.deepEqual(f.db.prepare('SELECT * FROM pe_mount_slots').all(), beforeSlot)
    for (const table of ['pe_stdio_v2_actions', 'pe_cloud_executions']) {
      const row = f.db.prepare(`SELECT state,cancel_requested FROM ${table} WHERE id=?`).get(table === 'pe_cloud_executions' ? f.executionId : f.actionId)
      assert.deepEqual({ ...row }, { state: 'cancelled', cancel_requested: 1 })
    }
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT task FROM pe_stdio_v2_actions WHERE id=?').get(f.actionId).task), originalTask)
    assertNoRuntimeResult(f)
    assert.deepEqual(await f.store.closeUnstarted(lease), receipt)
    await f.rejectsWithoutWrites(() => provisioning(f, lease, 'record'), /not_startable/u)
    await f.store.release(lease)
    assert.deepEqual(await f.store.readNoStart(f.actionId), receipt)
    await f.rejectsWithoutWrites(() => f.store.closeUnstarted(lease), /lease_lost/u)
  }
})

test('cancelled discovery may retain an exact ready resource and first capture its DB identity without changing the slot or prior approval', async t => {
  for (const withPrepared of [false, true]) {
    const f = fixture(t), lease = withPrepared ? await attached(f) : await f.store.claimNext(f.workerId)
    const prepared = withPrepared ? await f.service.prepareLeased(lease) : null
    f.change('pe_users', 'enabled', false, 'id', f.userId)
    const slot = f.db.prepare('SELECT * FROM pe_mount_slots').get(), instance = f.db.prepare('SELECT * FROM pe_sandbox_instances').get()
    const receipt = await f.store.closeUnstarted(lease)
    assert.deepEqual(receipt.resource, { kind: 'ready_retained', name: f.ready.name, podUid: f.ready.podUid,
      runnerInstanceId: f.ready.runnerInstanceId, mountGeneration: '1', bindingSnapshot: f.binding })
    assert.equal(receipt.preparedDigest, prepared?.preparedDigest ?? null)
    assert.deepEqual(f.db.prepare('SELECT * FROM pe_mount_slots').get(), slot)
    assert.deepEqual(f.db.prepare('SELECT * FROM pe_sandbox_instances').get(), instance)
    assert.deepEqual((await f.store.snapshot(lease)).writer, { name: f.ready.name, podUid: f.ready.podUid, runnerInstanceId: f.ready.runnerInstanceId })
    assert.equal(JSON.stringify(receipt).includes('synthetic-private-token'), false)
    assertNoRuntimeResult(f)
    await f.rejectsWithoutWrites(() => f.store.beginPreparation(lease), /not_startable/u)
    await f.rejectsWithoutWrites(() => f.service.prepareLeased(lease), /disabled|not_startable/u)
    // Later slot recycling cannot change the first immutable historical receipt.
    f.change('pe_mount_slots', 'generation', 9, 'user_id', f.userId)
    f.change('pe_mount_slots', 'session_id', uuid(), 'user_id', f.userId)
    f.db.prepare('DELETE FROM pe_sandbox_instances WHERE session_id=?').run(f.sessionId)
    f.db.prepare('DELETE FROM pe_workspace_bindings').run()
    assert.deepEqual(await f.store.closeUnstarted(lease), receipt)
    assert.deepEqual(await f.store.readNoStart(f.actionId), receipt)
  }
})

test('creation closure requires existing free/deleted dual proof, preserving full original UID and binding rather than using missing resources', async t => {
  const f = fixture(t), lease = await f.store.claimNext(f.workerId)
  await f.store.beginPreparation(lease); await f.store.defer(lease, 'stdio_v2_cancel_requested')
  const proof = stoppedCreation(f), resources = JSON.stringify([f.db.prepare('SELECT * FROM pe_mount_slots').all(), f.db.prepare('SELECT * FROM pe_sandbox_instances').all()])
  const receipt = await f.store.closeUnstarted(lease)
  assert.deepEqual(receipt.resource, { kind: 'creation_stopped', name: f.ready.name, mountGeneration: '1', bindingSnapshot: f.binding, stopEvidence: proof })
  assert.equal(JSON.stringify([f.db.prepare('SELECT * FROM pe_mount_slots').all(), f.db.prepare('SELECT * FROM pe_sandbox_instances').all()]), resources)
  assertNoRuntimeResult(f)
  assert.deepEqual(await f.store.readNoStart(f.actionId), receipt)
  for (const mutation of [g => g.change('pe_mount_slots', 'state', 'reserved', 'user_id', g.userId),
    g => g.change('pe_sandbox_instances', 'state', 'deleting', 'session_id', g.sessionId),
    g => g.change('pe_sandbox_instances', 'stop_evidence', null, 'session_id', g.sessionId),
    g => g.change('pe_sandbox_instances', 'stop_pod_uid', uuid(), 'session_id', g.sessionId),
    g => g.change('pe_mount_slots', 'generation', 2, 'user_id', g.userId),
    g => g.change('pe_sandbox_instances', 'stop_evidence', { ...stoppedCreation(g), sandboxUid: uuid() }, 'session_id', g.sessionId),
    g => g.change('pe_sandbox_instances', 'stop_evidence', { ...stoppedCreation(g), status: 'UNKNOWN' }, 'session_id', g.sessionId)]) {
    const g = fixture(t), held = await g.store.claimNext(g.workerId)
    await g.store.defer(held, 'stdio_v2_cancel_requested'); stoppedCreation(g); mutation(g)
    await g.rejectsWithoutWrites(() => g.store.closeUnstarted(held), /no_start_resources_unavailable/u)
  }
})

test('unknown creation, foreign binding, mismatched original ready writer, calls and existing permits cannot become no-start results', async t => {
  for (const mutation of [f => f.change('pe_mount_slots', 'state', 'unknown', 'user_id', f.userId),
    f => f.change('pe_mount_slots', 'pod_uid', uuid(), 'user_id', f.userId),
    f => f.change('pe_sandbox_instances', 'binding_snapshot', { ...f.binding, rootKey: uuid() }, 'session_id', f.sessionId),
    f => f.change('pe_workspace_bindings', 'space_id', uuid(), 'workspace_id', f.binding.workspaceId),
    f => f.change('pe_workspaces', 'binding_generation', 2, 'id', f.binding.workspaceId)]) {
    const f = fixture(t), lease = await attached(f); await f.store.defer(lease, 'stdio_v2_cancel_requested'); mutation(f)
    await f.rejectsWithoutWrites(() => f.store.closeUnstarted(lease), /no_start_resources_unavailable/u)
  }
  const call = fixture(t, { phase: 'call' }), held = await call.store.claimNext(call.workerId)
  await call.store.defer(held, 'stdio_v2_cancel_requested')
  await call.rejectsWithoutWrites(() => call.store.closeUnstarted(held), /no_start_call_unavailable/u)
  const p = fixture(t), permittedLease = await attached(p); await permitted(p, permittedLease)
  await p.store.defer(permittedLease, 'stdio_v2_cancel_requested')
  await p.rejectsWithoutWrites(() => p.store.closeUnstarted(permittedLease), /start_already_authorized/u)
  await p.rejectsWithoutWrites(() => provisioning(p, permittedLease, 'record'), /start_already_authorized/u)
})

test('no-start writes are clock fenced and atomic; lost commit reply uses immutable readback without replaying preparation', async t => {
  for (const trigger of ['INSERT INTO pe_stdio_v2_no_start_closures', 'UPDATE pe_stdio_v2_actions SET state=\'cancelled\'',
    'UPDATE pe_cloud_executions SET state=\'cancelled\'']) {
    const f = fixture(t), lease = await f.store.claimNext(f.workerId); unallocate(f)
    f.change('pe_stdio_v2_actions', 'cancel_requested', true); f.expireAt(trigger)
    await f.rejectsWithoutWrites(() => f.store.closeUnstarted(lease), /lease_lost/u)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_no_start_closures').get().n, 0)
  }
  const f = fixture(t), lease = await f.store.claimNext(f.workerId); unallocate(f)
  f.change('pe_stdio_v2_actions', 'cancel_requested', true); f.loseCommitReply()
  await assert.rejects(() => f.store.closeUnstarted(lease), /commit_reply_lost/u)
  f.advance(5001)
  const receipt = await f.store.readNoStart(f.actionId)
  assert.equal(receipt.state, 'cancelled'); assert.equal(f.captures.length, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_stdio_v2_no_start_closures').get().n, 1)
  const row = f.db.prepare('SELECT receipt_digest FROM pe_stdio_v2_no_start_closures').get()
  assert.equal(row.receipt_digest, sha('no_start', receipt))
  await f.rejectsWithoutWrites(() => f.store.closeUnstarted(lease), /lease_lost/u)
  assert.throws(() => parseStdioNoStartReceiptV2(receipt, { ...limits, maxInputBytes: 256 }),
    error => error.name === 'ZodError' && error.issues.some(issue => issue.code === 'custom' && issue.path.length === 0))
  for (const mutation of [g => g.change('pe_stdio_v2_no_start_closures', 'task_digest', '0'.repeat(64), 'action_id'),
    g => g.change('pe_stdio_v2_no_start_closures', 'user_id', uuid(), 'action_id'),
    g => g.change('pe_stdio_v2_no_start_closures', 'receipt_digest', '0'.repeat(64), 'action_id'),
    g => g.change('pe_cloud_executions', 'cancel_requested', false, 'id', g.executionId),
    g => g.change('pe_stdio_v2_actions', 'state', 'blocked'),
    g => g.insert('pe_stdio_v2_results', { action_id: g.actionId, result: {}, result_digest: sha('result', {}) })]) {
    const g = fixture(t), held = await g.store.claimNext(g.workerId); unallocate(g)
    g.change('pe_stdio_v2_actions', 'cancel_requested', true); await g.store.closeUnstarted(held); mutation(g)
    await g.rejectsWithoutWrites(() => g.store.readNoStart(g.actionId), /receipt_changed|start_already_authorized/u)
  }
})
