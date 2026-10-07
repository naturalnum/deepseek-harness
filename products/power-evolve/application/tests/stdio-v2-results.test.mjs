/** Serialized SQLite/client substitute for result SQL and rollback; no PG, Runner, Kube or user process runs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { StdioResultServiceV2 } from '../lib/platform/stdio-v2-results.js'
import { stdioDispatchV2, stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionLeaseV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 8192,
  maxToolBytes: 4096, maxResultBytes: 8192, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const maxReplyBytes = 32768, sha = (domain, value) => stdioSha256V2(domain, value, budget)
const clone = value => structuredClone(value), uuid = randomUUID
const rawCatalog = [{ name: 'literal_echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  _meta: { '10': 'ten', '2': 'two', original: '保留\0😀' }, extension: { values: [true, null, 3] } }]
const jsonFields = new Set(['task', 'stdio_task', 'configuration', 'prepared', 'approval_binding', 'permit', 'executor_owner',
  'dispatch', 'observation', 'stop_evidence', 'result', 'raw_catalog', 'image_expectation'])
const boolFields = new Set(['enabled', 'passwordChangeRequired', 'cancel_requested'])
const dateFields = new Set(['deletedAt', 'deleted_at', 'lease_until', 'expires_at', 'issued_at', 'now'])

function fixture(t, phase = 'discover', continuationService) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  let now = Date.parse('2026-10-07T12:00:00.000Z'), tail = Promise.resolve(), expireAtWrite = null, failAtWrite = null, loseCommit = false
  const queries = [], mutations = [], encode = value => value instanceof Date ? value.toISOString()
    : value === null ? null : typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value
  db.function('clock_timestamp', () => new Date(now).toISOString())
  db.exec(`CREATE TABLE pe_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,enabled INTEGER,
    account_revision INTEGER,credential_version INTEGER,password_change_required INTEGER,deleted_at TEXT);
    CREATE TABLE pe_sessions(id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT);
    CREATE TABLE pe_stdio_v2_connections(id TEXT PRIMARY KEY,user_id TEXT,revision INTEGER,enabled INTEGER,current_catalog_id TEXT,deleted_at TEXT,updated_at TEXT);
    CREATE TABLE pe_stdio_v2_configurations(connection_id TEXT,user_id TEXT,revision INTEGER,configuration TEXT,config_digest TEXT);
    CREATE TABLE pe_stdio_v2_actions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,connection_id TEXT,config_revision INTEGER,
      config_digest TEXT,phase TEXT,execution_target TEXT,execution_id TEXT,task TEXT,task_digest TEXT,state TEXT,cancel_requested INTEGER,
      request_id TEXT,operation_id TEXT,root_operation_id TEXT,call_id TEXT,continuation_request_id TEXT,
      lease_owner TEXT,lease_epoch INTEGER,lease_until TEXT,updated_at TEXT);
    CREATE TABLE pe_cloud_executions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,execution_kind TEXT,execution_target TEXT,
      task_version INTEGER,stdio_action_id TEXT,stdio_phase TEXT,stdio_task TEXT,request_digest TEXT,origin_kind TEXT,operation_id TEXT,
      call_id TEXT,continuation_request_id TEXT,command TEXT,cwd TEXT,state TEXT,cancel_requested INTEGER,sandbox_name TEXT,pod_uid TEXT,
      runner_instance_id TEXT,lease_owner TEXT,lease_until TEXT,updated_at TEXT);
    CREATE TABLE pe_stdio_v2_preparations(action_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,phase TEXT,execution_target TEXT,
      execution_id TEXT,task_digest TEXT,prepared TEXT,prepared_digest TEXT,approval_binding TEXT,fingerprint TEXT,approval_epoch INTEGER,expires_at TEXT);
    CREATE TABLE pe_stdio_v2_decisions(action_id TEXT PRIMARY KEY,user_id TEXT,fingerprint TEXT,decision TEXT);
    CREATE TABLE pe_stdio_v2_start_permits(action_id TEXT PRIMARY KEY,permit_id TEXT,authorization_request_id TEXT,execution_id TEXT,
      task_digest TEXT,prepared_digest TEXT,fingerprint TEXT,decision TEXT,executor_owner TEXT,permit TEXT,issued_at TEXT,expires_at TEXT);
    CREATE TABLE pe_stdio_v2_dispatches(action_id TEXT PRIMARY KEY,dispatch TEXT,dispatch_digest TEXT);
    CREATE TABLE pe_stdio_v2_observations(id TEXT PRIMARY KEY,action_id TEXT,worker_id TEXT,lease_epoch INTEGER,
      observation TEXT,observation_digest TEXT,stop_evidence TEXT,UNIQUE(action_id,observation_digest));
    CREATE TABLE pe_stdio_v2_results(action_id TEXT PRIMARY KEY,result TEXT,result_digest TEXT,observation TEXT,stop_evidence TEXT);
    CREATE TABLE pe_stdio_v2_catalogs(id TEXT PRIMARY KEY,user_id TEXT,connection_id TEXT,config_revision INTEGER,config_digest TEXT,
      action_id TEXT UNIQUE,session_id TEXT,phase TEXT,raw_catalog TEXT,image_expectation TEXT,catalog_digest TEXT);`)
  function run(sql, values = []) {
    queries.push(sql)
    if (/^(INSERT|UPDATE)/u.test(sql)) {
      assert(sql.includes('lease.lease_owner=$2') && sql.includes('lease.lease_epoch=$3') && sql.includes('lease.lease_until>clock_timestamp()'))
      mutations.push(sql)
      if (expireAtWrite && sql.includes(expireAtWrite)) { now += 120000; expireAtWrite = null }
      if (failAtWrite && sql.includes(failAtWrite)) { failAtWrite = null; throw new Error('synthetic_write_failure') }
    }
    const translated = sql.replace(/=ANY\(\$1::uuid\[\]\)/gu, ' IN (SELECT value FROM json_each($1))')
      .replace(/ FOR (?:NO KEY UPDATE|UPDATE|SHARE)/gu, '')
    const bind = Object.fromEntries(values.map((value, index) => [String(index + 1), encode(value)]))
    const before = db.prepare('SELECT total_changes() AS n').get().n
    const rows = db.prepare(translated).all(bind).map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field,
      value === null ? null : jsonFields.has(field) ? JSON.parse(value) : boolFields.has(field) ? Boolean(value)
      : dateFields.has(field) ? new Date(value) : field === 'lease_epoch' ? String(value) : value])))
    if (sql === 'COMMIT' && loseCommit) { loseCommit = false; throw new Error('synthetic_commit_reply_lost') }
    return { rows, rowCount: rows.length || db.prepare('SELECT total_changes() AS n').get().n - before }
  }
  let connections = 0
  const pool = { async connect() {
    connections++; const previous = tail; let release
    tail = new Promise(resolve => { release = resolve }); await previous
    return Object.assign(new EventEmitter(), { query: async (sql, values) => run(sql, values), release() { release() } })
  } }
  const put = (table, fields) => db.prepare(`INSERT INTO ${table}(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(() => '?').join(',')})`)
    .run(...Object.values(fields).map(encode))
  const userId = uuid(), sessionId = uuid(), workspaceId = uuid(), connectionId = uuid(), actionId = uuid(), executionId = uuid()
  const workerId = uuid(), runnerInstanceId = uuid(), podUid = uuid(), config = { name: 'Synthetic', invocation: { program: 'python3', argv: ['synthetic.py'], cwd: '.' } }
  const configDigest = sha('configuration', config), imageReference = `registry.example/runner@sha256:${'a'.repeat(64)}`
  const image = { kind: 'cloud', platform: { os: 'linux', architecture: 'arm64' }, imageReference, runtimeImageId: 'containerd://original' }
  const pin = { kind: 'cloud', deploymentId: uuid(), protocolVersion: 2, platform: image.platform, imageReference,
    configImageId: `sha256:${'b'.repeat(64)}`, runtimeImageIds: [image.runtimeImageId] }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: 1,
    target: { spaceId: uuid(), rootRelativePath: 'synthetic' }, home: { kind: 'user', userId } }
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId, userId, sessionId, connectionId,
    configRevision: 1, configDigest, phase, expectedDeploymentPin: pin, scopeBinding: scope, invocation: config.invocation, limits,
    ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId: uuid() } }
      : { origin: { kind: 'operation', operationId: uuid(), rootOperationId: uuid(), callKey: 'synthetic-call' },
        selection: { catalogId: uuid(), catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog,
          catalogImageExpectation: image, rawName: rawCatalog[0].name, rawDescriptor: rawCatalog[0], arguments: { text: 'raw\0text' } } }) })
  const taskDigest = sha('task', task), executionRef = { kind: 'cloud', executionId }
  const capture = { kind: 'cloud', podUid, podName: 'synthetic-sandbox', namespace: 'synthetic', nodeName: 'synthetic-node', runnerInstanceId,
    containerId: 'containerd://exact', restartCount: 0, mountGeneration: '7', workspaceMount: { claimName: 'owned', subPath: 'workspace/synthetic', mountPath: '/workspace', readOnly: false },
    homeMount: { claimName: 'owned', subPath: 'home/synthetic', mountPath: '/home/agent', readOnly: false } }
  const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId, executionRef, taskDigest, scopeBinding: scope,
    expectedDeploymentPin: pin, actualExecutorImage: image, capture, specDigest: sha('spec', { original: 'synthetic-full-spec' }),
    fullScopeDigest: sha('scope', { scopeBinding: scope, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }) })
  const preparedDigest = sha('prepared', prepared), fingerprint = 'c'.repeat(64)
  const approval = { actionId, taskDigest, preparedDigest, approvalEpoch: 1, expiresAt: new Date(now + 5000).toISOString() }
  const permit = { ...approval, approvalFingerprint: fingerprint, permitId: uuid(), authorizationRequestId: uuid(), executionRef,
    executorOwner: { kind: 'cloud', runnerInstanceId }, issuedAt: new Date(now - 1000).toISOString() }
  const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest, executionRef, preparedDigest, permit }), dispatchDigest = sha('dispatch', dispatch)
  const continuation = phase === 'call' ? uuid() : null
  put('pe_users', { id: userId, username: 'synthetic', display_name: 'Synthetic', role: 'USER', enabled: true,
    account_revision: 1, credential_version: 1, password_change_required: false, deleted_at: null })
  put('pe_sessions', { id: sessionId, user_id: userId, workspace_id: workspaceId })
  put('pe_stdio_v2_connections', { id: connectionId, user_id: userId, revision: 1, enabled: false, current_catalog_id: null, deleted_at: null })
  put('pe_stdio_v2_configurations', { connection_id: connectionId, user_id: userId, revision: 1, configuration: config, config_digest: configDigest })
  const origin = { request_id: phase === 'discover' ? task.origin.requestId : null, operation_id: phase === 'call' ? task.origin.operationId : null,
    root_operation_id: phase === 'call' ? task.origin.rootOperationId : null, call_id: phase === 'call' ? task.origin.callKey : null, continuation_request_id: continuation }
  put('pe_stdio_v2_actions', { id: actionId, user_id: userId, session_id: sessionId, connection_id: connectionId, config_revision: 1,
    config_digest: configDigest, phase, execution_target: 'cloud', execution_id: executionId, task, task_digest: taskDigest,
    state: 'dispatch-intent', cancel_requested: false, ...origin, lease_owner: workerId, lease_epoch: 3, lease_until: new Date(now + 60000) })
  put('pe_cloud_executions', { id: executionId, user_id: userId, session_id: sessionId, execution_kind: 'stdio_v2', execution_target: 'cloud',
    task_version: 2, stdio_action_id: actionId, stdio_phase: phase, stdio_task: task, request_digest: taskDigest,
    origin_kind: phase === 'discover' ? 'stdio_discovery' : 'operation', operation_id: origin.operation_id, call_id: origin.call_id,
    continuation_request_id: continuation, command: null, cwd: null, state: 'starting', cancel_requested: false,
    sandbox_name: capture.podName, pod_uid: podUid, runner_instance_id: runnerInstanceId, lease_owner: workerId, lease_until: new Date(now + 60000) })
  put('pe_stdio_v2_preparations', { action_id: actionId, user_id: userId, session_id: sessionId, phase, execution_target: 'cloud', execution_id: executionId,
    task_digest: taskDigest, prepared, prepared_digest: preparedDigest, approval_binding: approval, fingerprint, approval_epoch: 1, expires_at: new Date(approval.expiresAt) })
  put('pe_stdio_v2_decisions', { action_id: actionId, user_id: userId, fingerprint, decision: 'once' })
  put('pe_stdio_v2_start_permits', { action_id: actionId, permit_id: permit.permitId, authorization_request_id: permit.authorizationRequestId,
    execution_id: executionId, task_digest: taskDigest, prepared_digest: preparedDigest, fingerprint, decision: 'once', executor_owner: permit.executorOwner,
    permit, issued_at: new Date(permit.issuedAt), expires_at: new Date(permit.expiresAt) })
  put('pe_stdio_v2_dispatches', { action_id: actionId, dispatch, dispatch_digest: dispatchDigest })
  const facts = { programStartAttempted: true, toolsCallAttempted: phase === 'call', effectMayHaveOccurred: true,
    childPid: 12345, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
    protocolBytes: 200, protocolMessages: 4, stderrBytes: 0, stderr: '' }
  const outcome = { state: 'completed', phase, catalog: clone(rawCatalog), pages: [{ tools: clone(rawCatalog), extension: 'page\0raw' }],
    initializeResult: { protocolVersion: 'synthetic', _meta: { raw: 'init\0raw' } }, facts,
    ...(phase === 'call' ? { result: { content: [{ type: 'text', text: 'raw\0result' }], isError: false, extension: { full: true } } } : {}) }
  const view = { formatVersion: 2, instanceId: runnerInstanceId, actionId, executionRef, taskDigest, dispatchDigest,
    state: 'completed', writerStopConfirmed: true, outcome }
  const stopEvidence = { formatVersion: 2, kind: 'cloud_uid_quiet', actionId, executionRef, taskDigest, dispatchDigest, preparedDigest,
    fullScopeDigest: prepared.fullScopeDigest, podUid, runnerInstanceId, mountGeneration: capture.mountGeneration, observedAt: new Date(now).toISOString() }
  const lease = stdioActionLeaseV2.parse({ actionId, workerId, leaseEpoch: 3 }), service = new StdioResultServiceV2(pool,
    { limits, maxReplyBytes, ...(continuationService ? { continuation: continuationService } : {}) })
  const get = table => db.prepare(`SELECT * FROM ${table}`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value !== null && jsonFields.has(key) ? JSON.parse(value) : value])))
  const change = (table, key, value) => db.prepare(`UPDATE ${table} SET ${key}=?`).run(encode(value))
  return { db, service, pool, lease, view, stopEvidence, task, prepared, dispatch, queries, mutations, get, change,
    record: (observation = { view, stopEvidence }) => service.record(lease, observation),
    setNow(value) { now = value }, expireWrite(value) { expireAtWrite = value }, failWrite(value) { failAtWrite = value },
    loseCommit() { loseCommit = true }, get connections() { return connections } }
}

test('terminal independent UID proof atomically stores full original JSON, retires execution and mints one disabled catalog', async t => {
  const f = fixture(t), result = await f.record()
  assert.equal(result.finalized, true); assert.equal(result.state, 'succeeded'); assert(result.catalogId)
  const stored = f.get('pe_stdio_v2_results')[0], observed = f.get('pe_stdio_v2_observations')[0]
  assert.deepEqual(stored.result, f.view.outcome); assert.equal(stored.result_digest, sha('result', f.view.outcome))
  assert.deepEqual(stored.observation, f.view); assert.deepEqual(stored.stop_evidence, f.stopEvidence)
  assert.equal(observed.observation_digest, sha('observation', { view: f.view, stopEvidence: f.stopEvidence }))
  assert.deepEqual(f.get('pe_stdio_v2_catalogs')[0].raw_catalog, rawCatalog)
  assert.equal(f.get('pe_stdio_v2_connections')[0].current_catalog_id, result.catalogId)
  assert.equal(f.get('pe_stdio_v2_connections')[0].enabled, 0)
  assert.equal(f.get('pe_cloud_executions')[0].lease_owner, null)
  assert.equal(f.get('pe_stdio_v2_actions')[0].lease_owner, f.lease.workerId)
  assert.equal(f.connections, 1)
  const locks = f.queries.filter(sql => /FOR (?:NO KEY UPDATE|UPDATE)/u.test(sql))
  assert.deepEqual(locks.map(sql => ['pe_users', 'pe_sessions', 'pe_stdio_v2_connections', 'pe_stdio_v2_actions', 'pe_cloud_executions'].find(table => sql.includes(`FROM ${table}`))),
    ['pe_users', 'pe_sessions', 'pe_stdio_v2_connections', 'pe_stdio_v2_actions', 'pe_cloud_executions'])
  assert(!f.queries.some(sql => sql.includes('pe_operations')))
})

test('running, unknown, and terminal without independent proof remain observations with reserved writers', async t => {
  for (const [kind, expectedAction, expectedExecution] of [['running', 'running', 'running'], ['unknown', 'blocked', 'uncertain'], ['completed', 'stopping', 'cancelling']]) {
    const f = fixture(t), view = clone(f.view); view.state = kind; view.writerStopConfirmed = kind === 'completed'
    if (kind === 'running') delete view.outcome
    if (kind === 'unknown') view.outcome = { state: 'failed', errorCode: 'stdio_v2_cleanup_unconfirmed', facts: clone(view.outcome.facts) }
    const observation = { view, stopEvidence: kind === 'unknown' ? f.stopEvidence : null }
    const result = await f.record(observation)
    assert.equal(result.state, expectedAction); assert.equal(result.finalized, false)
    assert.equal(f.get('pe_cloud_executions')[0].state, expectedExecution)
    assert.equal(f.get('pe_cloud_executions')[0].lease_owner, f.lease.workerId)
    assert.equal(f.get('pe_stdio_v2_results').length, 0); assert.equal(f.get('pe_stdio_v2_catalogs').length, 0)
    const count = f.mutations.length; await f.record(observation)
    assert.equal(f.get('pe_stdio_v2_observations').length, 1)
    assert(f.mutations.slice(count).every(sql => !sql.startsWith('INSERT')))
  }
})

test('terminal null-to-proof upgrade appends full proof; later timestamp-only retry retains first records', async t => {
  const f = fixture(t)
  await f.record({ view: f.view, stopEvidence: null }); assert.equal(f.get('pe_stdio_v2_results').length, 0)
  const result = await f.record(); assert.equal(f.get('pe_stdio_v2_observations').length, 2)
  const before = f.get('pe_stdio_v2_results'), mutationCount = f.mutations.length
  f.stopEvidence.observedAt = '2026-10-07T12:00:01.000Z'
  assert.deepEqual(await f.record(), result)
  assert.deepEqual(f.get('pe_stdio_v2_results'), before); assert.equal(f.get('pe_stdio_v2_observations').length, 2)
  assert.equal(f.mutations.length, mutationCount)
})

test('disabled/deleted account, changed or deleted configuration and requested cancellation can save terminal results without catalog', async t => {
  for (const [table, key, value] of [['pe_users', 'enabled', false], ['pe_users', 'deleted_at', new Date('2026-10-07')],
    ['pe_stdio_v2_connections', 'revision', 2], ['pe_stdio_v2_connections', 'deleted_at', new Date('2026-10-07')],
    ['pe_stdio_v2_actions', 'cancel_requested', true], ['pe_cloud_executions', 'cancel_requested', true]]) {
    const f = fixture(t); f.change(table, key, value); const result = await f.record()
    assert.equal(result.finalized, true); assert.equal(result.catalogId, null)
    assert.equal(f.get('pe_stdio_v2_results').length, 1); assert.equal(f.get('pe_stdio_v2_catalogs').length, 0)
    assert.equal(f.get('pe_cloud_executions')[0].lease_owner, null)
  }
})

test('call passes the original client and live action lease after result and terminal writes, including duplicate final results', async t => {
  let calls = 0
  const call = fixture(t, 'call', { async enqueueLeased(client, lease) {
    calls++; assert.deepEqual(lease, call.lease)
    assert.equal((await client.query('SELECT state FROM pe_stdio_v2_actions')).rows[0].state, 'succeeded')
    assert.equal((await client.query('SELECT state,lease_owner FROM pe_cloud_executions')).rows[0].state, 'succeeded')
    assert.equal((await client.query('SELECT lease_owner FROM pe_cloud_executions')).rows[0].lease_owner, null)
    assert.equal((await client.query('SELECT result FROM pe_stdio_v2_results')).rows[0].result.result.isError, true)
    return { disposition: calls === 1 ? 'queued' : 'original', operationId: uuid() }
  } }); call.view.outcome.result.isError = true
  assert.equal((await call.record()).state, 'succeeded')
  assert.deepEqual(call.get('pe_stdio_v2_results')[0].result, call.view.outcome)
  assert.equal(call.get('pe_stdio_v2_catalogs').length, 0)
  await call.record(); assert.equal(calls, 2); assert.equal(call.connections, 2)
})

test('call without continuation cannot commit a final result, while unknown observations retain the writer', async t => {
  const call = fixture(t, 'call')
  await assert.rejects(call.record(), { code: 'stdio_v2_continuation_unavailable' })
  assert.equal(call.get('pe_stdio_v2_results').length, 0); assert.equal(call.get('pe_stdio_v2_observations').length, 0)
  assert.equal(call.get('pe_stdio_v2_actions')[0].state, 'dispatch-intent')
  assert.equal(call.get('pe_cloud_executions')[0].lease_owner, call.lease.workerId)
  const view = clone(call.view); view.state = 'unknown'; view.writerStopConfirmed = false
  view.outcome = { state: 'failed', errorCode: 'stdio_v2_cleanup_unconfirmed', facts: clone(view.outcome.facts) }
  assert.equal((await call.record({ view, stopEvidence: call.stopEvidence })).finalized, false)
  assert.equal(call.get('pe_stdio_v2_results').length, 0)
})

test('failed and cancelled discovery outcomes retain their own facts without continuation', async t => {
  for (const state of ['failed', 'cancelled']) {
    const f = fixture(t); f.view.state = state
    f.view.outcome = { state: 'failed', errorCode: 'aborted', facts: { ...f.view.outcome.facts, signal: 'SIGTERM', exitCode: null } }
    assert.equal((await f.record()).state, state)
    assert.deepEqual(f.get('pe_stdio_v2_results')[0].result, f.view.outcome)
  }
})

test('forged view, complete stop proof and immutable originals reject without writing any observation or result', async t => {
  for (const change of [f => { f.view.instanceId = uuid() }, f => { f.view.executionRef.executionId = uuid() },
    f => { f.view.taskDigest = '1'.repeat(64) }, f => { f.view.dispatchDigest = '1'.repeat(64) },
    f => { f.stopEvidence.podUid = uuid() }, f => { f.stopEvidence.runnerInstanceId = uuid() },
    f => { f.stopEvidence.mountGeneration = '99' }, f => { f.stopEvidence.fullScopeDigest = '1'.repeat(64) },
    f => { f.stopEvidence.preparedDigest = '1'.repeat(64) }, f => { f.stopEvidence.actionId = uuid() },
    f => { f.change('pe_cloud_executions', 'execution_kind', 'legacy_command') },
    f => { f.change('pe_cloud_executions', 'pod_uid', uuid()) },
    f => { f.change('pe_sessions', 'workspace_id', uuid()) },
    f => { f.change('pe_stdio_v2_actions', 'task_digest', '1'.repeat(64)) },
    f => { f.change('pe_stdio_v2_dispatches', 'dispatch_digest', '1'.repeat(64)) },
    f => { const prepared = clone(f.prepared); prepared.capture.homeMount.subPath = 'different'; f.change('pe_stdio_v2_preparations', 'prepared', prepared) },
    f => { const dispatch = clone(f.dispatch); dispatch.permit.authorizationRequestId = uuid(); f.change('pe_stdio_v2_dispatches', 'dispatch', dispatch); f.change('pe_stdio_v2_dispatches', 'dispatch_digest', sha('dispatch', dispatch)) },
  ]) {
    const f = fixture(t); change(f); await assert.rejects(f.record())
    assert.equal(f.get('pe_stdio_v2_observations').length, 0); assert.equal(f.get('pe_stdio_v2_results').length, 0)
    assert.equal(f.get('pe_cloud_executions')[0].lease_owner, f.lease.workerId)
  }
})

test('stale owner, epoch, expiry and clock expiry at every mutation roll back atomically and preserve writer', async t => {
  for (const [field, value] of [['workerId', uuid()], ['leaseEpoch', 4]]) {
    const f = fixture(t); f.lease[field] = value; await assert.rejects(f.record(), error => error.code === 'stdio_v2_lease_lost')
    assert.equal(f.get('pe_stdio_v2_observations').length, 0)
  }
  const expired = fixture(t); expired.change('pe_stdio_v2_actions', 'lease_until', new Date('2026-10-07T11:59:59.000Z'))
  await assert.rejects(expired.record(), error => error.code === 'stdio_v2_lease_lost')
  assert.equal(expired.get('pe_stdio_v2_observations').length, 0)
  const finalExpired = fixture(t); await finalExpired.record(); const original = finalExpired.get('pe_stdio_v2_results')
  finalExpired.setNow(Date.parse('2026-10-07T12:02:00.000Z'))
  await assert.rejects(finalExpired.record(), error => error.code === 'stdio_v2_lease_lost')
  assert.deepEqual(finalExpired.get('pe_stdio_v2_results'), original)
  for (const step of ['pe_stdio_v2_observations', 'pe_stdio_v2_results', 'pe_stdio_v2_catalogs',
    'UPDATE pe_stdio_v2_connections', 'UPDATE pe_cloud_executions', 'UPDATE pe_stdio_v2_actions']) {
    const f = fixture(t); f.expireWrite(step)
    await assert.rejects(f.record(), error => error.code === 'stdio_v2_lease_lost')
    assert.equal(f.get('pe_stdio_v2_observations').length, 0); assert.equal(f.get('pe_stdio_v2_results').length, 0)
    assert.equal(f.get('pe_cloud_executions')[0].state, 'starting'); assert.equal(f.get('pe_cloud_executions')[0].lease_owner, f.lease.workerId)
  }
})

test('whole input budgets reject without truncation or transaction; stored terminal conflicts never overwrite first original', async t => {
  const huge = fixture(t); huge.view.outcome.initializeResult.extra = 'x'.repeat(limits.maxInputBytes)
  const largerReply = new StdioResultServiceV2(huge.pool, { limits, maxReplyBytes: limits.maxInputBytes * 2 })
  await assert.rejects(largerReply.record(huge.lease, { view: huge.view, stopEvidence: huge.stopEvidence }))
  assert.equal(huge.connections, 0)
  const f = fixture(t); await f.record(); const original = f.get('pe_stdio_v2_results')
  f.view.outcome.initializeResult.extension = 'changed-after-first-final'
  await assert.rejects(f.record(), error => error.code === 'stdio_v2_result_conflict')
  assert.deepEqual(f.get('pe_stdio_v2_results'), original)
  const broken = fixture(t); await broken.record(); broken.change('pe_stdio_v2_results', 'result_digest', '1'.repeat(64))
  await assert.rejects(broken.record(), error => error.code === 'stdio_v2_result_conflict')
  const brokenCatalog = fixture(t); await brokenCatalog.record(); brokenCatalog.change('pe_stdio_v2_catalogs', 'catalog_digest', '1'.repeat(64))
  await assert.rejects(brokenCatalog.record(), error => error.code === 'stdio_v2_result_conflict')
})

test('late SQL failure rolls back all writes; commit reply loss recovers original first result and once catalog without replay', async t => {
  const failed = fixture(t); failed.failWrite('UPDATE pe_stdio_v2_actions')
  await assert.rejects(failed.record(), /synthetic_write_failure/u)
  assert.equal(failed.get('pe_stdio_v2_observations').length, 0); assert.equal(failed.get('pe_stdio_v2_results').length, 0)
  const lost = fixture(t); lost.loseCommit(); await assert.rejects(lost.record(), /synthetic_commit_reply_lost/u)
  const original = lost.get('pe_stdio_v2_results'), catalogs = lost.get('pe_stdio_v2_catalogs')
  const mutationCount = lost.mutations.length, result = await lost.record()
  assert.equal(result.finalized, true); assert.equal(result.catalogId, catalogs[0].id)
  assert.deepEqual(lost.get('pe_stdio_v2_results'), original); assert.deepEqual(lost.get('pe_stdio_v2_catalogs'), catalogs)
  assert.equal(lost.mutations.length, mutationCount)
})
