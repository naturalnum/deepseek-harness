/** Caller-owned SQLite transactions exercise durable call delivery; no PG, executor, model or user files run. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { stdioDispatchV2, stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionLeaseV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'
import { StdioCallContinuationV2 } from '../lib/platform/stdio-v2-continuations.js'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 8192,
  maxToolBytes: 4096, maxResultBytes: 8192, maxStderrBytes: 4096 }
const admission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 131072, maxDescriptionBytes: 8192 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const maxReplyBytes = 32768, sha = (domain, value) => stdioSha256V2(domain, value, budget)
const clone = value => structuredClone(value), uuid = randomUUID
const copies = ['settings', 'skill_selection', 'mcp_selection', 'stdio_mcp_selection', 'ssh_selection',
  'remote_mcp_selection', 'stdio_v2_selection', 'execution_target']
const jsonFields = new Set([...copies, 'task', 'stdio_task', 'prepared', 'dispatch', 'result', 'observation', 'stop_evidence', 'receipt'])
const boolFields = new Set(['enabled', 'passwordChangeRequired', 'cancel_requested', 'continuation_queued'])
const dateFields = new Set(['deletedAt', 'deleted_at', 'lease_until', 'mcp_chain_cancelled_at', 'stopped_at', 'expires_at', 'now'])

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  let now = Date.parse('2026-10-08T00:00:00.000Z'), expireAt = null, failAt = null, notifications = 0
  const queries = [], mutations = []
  const encode = value => value instanceof Date ? value.toISOString() : value === null ? null
    : typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value
  const decode = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value === null ? null : key === 'execution_target' && ['cloud', 'desktop'].includes(value) ? value
      : jsonFields.has(key) ? JSON.parse(value) : boolFields.has(key) ? Boolean(value)
      : dateFields.has(key) ? new Date(value) : value]))
  db.function('clock_timestamp', () => new Date(now).toISOString())
  db.exec(`CREATE TABLE pe_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,enabled INTEGER,
      account_revision INTEGER,credential_version INTEGER,password_change_required INTEGER,deleted_at TEXT);
    CREATE TABLE pe_sessions(id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT);
    CREATE TABLE pe_stdio_v2_connections(id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE pe_stdio_v2_actions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,connection_id TEXT,config_revision INTEGER,
      config_digest TEXT,phase TEXT,execution_target TEXT,execution_id TEXT,task TEXT,task_digest TEXT,state TEXT,cancel_requested INTEGER,
      request_id TEXT,operation_id TEXT,root_operation_id TEXT,call_id TEXT,continuation_request_id TEXT,
      continuation_queued INTEGER DEFAULT 0,lease_owner TEXT,lease_epoch INTEGER,lease_until TEXT,updated_at TEXT);
    CREATE TABLE pe_cloud_executions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,execution_kind TEXT,execution_target TEXT,
      task_version INTEGER,stdio_action_id TEXT,stdio_phase TEXT,stdio_task TEXT,request_digest TEXT,origin_kind TEXT,operation_id TEXT,
      call_id TEXT,continuation_request_id TEXT,command TEXT,cwd TEXT,state TEXT,cancel_requested INTEGER,sandbox_name TEXT,pod_uid TEXT,
      runner_instance_id TEXT,lease_owner TEXT,lease_until TEXT);
    CREATE TABLE pe_stdio_v2_preparations(action_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,phase TEXT,execution_target TEXT,
      execution_id TEXT,task_digest TEXT,prepared TEXT,prepared_digest TEXT);
    CREATE TABLE pe_stdio_v2_dispatches(action_id TEXT PRIMARY KEY,dispatch TEXT,dispatch_digest TEXT);
    CREATE TABLE pe_stdio_v2_start_permits(action_id TEXT PRIMARY KEY);
    CREATE TABLE pe_stdio_v2_results(action_id TEXT PRIMARY KEY,result TEXT,result_digest TEXT,observation TEXT,stop_evidence TEXT);
    CREATE TABLE pe_stdio_v2_no_start_closures(action_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,phase TEXT,execution_target TEXT,
      execution_id TEXT,task_digest TEXT,prepared_digest TEXT,worker_id TEXT,lease_epoch INTEGER,receipt TEXT,receipt_digest TEXT);
    CREATE TABLE pe_operations(id TEXT PRIMARY KEY,session_id TEXT,request_id TEXT,input TEXT,settings TEXT,
      skill_selection TEXT,mcp_selection TEXT,stdio_mcp_selection TEXT,ssh_selection TEXT,remote_mcp_selection TEXT,
      stdio_v2_selection TEXT,execution_target TEXT,mcp_root_operation_id TEXT,mcp_chain_cancelled_at TEXT,source TEXT,
      source_action_id TEXT,source_execution_id TEXT,source_desktop_execution_id TEXT,source_stdio_mcp_call_id TEXT,
      source_ssh_execute_action_id TEXT,source_mcp_action_id TEXT,source_stdio_v2_action_id TEXT,
      source_stdio_v2_no_start_action_id TEXT,source_stdio_v2_phase TEXT,state TEXT,UNIQUE(session_id,request_id));
    CREATE TABLE pe_mcp_action_chains(root_operation_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,calls INTEGER,max_calls INTEGER,
      expires_at TEXT,stopped_at TEXT,error_code TEXT);`)
  const put = (table, values) => db.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`)
    .run(...Object.values(values).map(encode))
  const client = { async query(sql, values = []) {
    queries.push(sql)
    if (/^(INSERT|UPDATE)/u.test(sql)) {
      assert(sql.includes('lease.lease_owner=$2') && sql.includes('lease.lease_epoch=$3') && sql.includes('lease.lease_until>clock_timestamp()'))
      mutations.push(sql)
      if (expireAt && sql.includes(expireAt)) { now += 120000; expireAt = null }
      if (failAt && sql.includes(failAt)) { failAt = null; throw new Error('synthetic_write_failure') }
    }
    if (sql.startsWith('SELECT pg_notify')) { notifications++; return { rows: [], rowCount: 1 } }
    const translated = sql.replace(/=ANY\(\$1::uuid\[\]\)/gu, ' IN (SELECT value FROM json_each($1))')
      .replace(/ FOR (?:NO KEY UPDATE|UPDATE|SHARE)/gu, '')
    const bind = Object.fromEntries(values.map((value, index) => [String(index + 1), encode(value)]))
    const before = db.prepare('SELECT total_changes() AS n').get().n
    const rows = db.prepare(translated).all(bind).map(decode)
    return { rows, rowCount: rows.length || db.prepare('SELECT total_changes() AS n').get().n - before }
  } }
  const userId = uuid(), sessionId = uuid(), workspaceId = uuid(), connectionId = uuid(), actionId = uuid(), executionId = uuid()
  const operationId = uuid(), workerId = uuid(), runnerInstanceId = uuid(), podUid = uuid(), continuation = uuid()
  const rawCatalog = [{ name: 'echo', description: 'Original\0描述', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false },
    _meta: { '10': 'ten', '2': 'two', raw: '保持\0😀' }, extension: { original: [false, null, 1] } }]
  if (options.rawMeta) rawCatalog[0]._meta = clone(options.rawMeta)
  const configuration = { name: 'Synthetic', invocation: { program: 'python3', argv: ['synthetic.py', 'literal ; $(never run)'], cwd: '.' } }
  const imageReference = `registry.example/runner@sha256:${'a'.repeat(64)}`
  const image = { kind: 'cloud', platform: { os: 'linux', architecture: 'arm64' }, imageReference, runtimeImageId: 'containerd://original' }
  const pin = { kind: 'cloud', deploymentId: uuid(), protocolVersion: 2, platform: image.platform, imageReference,
    configImageId: `sha256:${'b'.repeat(64)}`, runtimeImageIds: [image.runtimeImageId] }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: 1,
    target: { spaceId: uuid(), rootRelativePath: 'synthetic' }, home: { kind: 'user', userId } }
  const groupInput = { formatVersion: 2, connectionId, configRevision: 1, configDigest: sha('configuration', configuration),
    configuration, limits, scopeBinding: scope, expectedDeploymentPin: pin, catalogId: uuid(),
    catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog, catalogImageExpectation: image }
  const groups = compileStdioOperationToolsV2([groupInput], limits, admission, [])
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId, userId, sessionId, connectionId,
    configRevision: 1, configDigest: groupInput.configDigest, phase: 'call', expectedDeploymentPin: pin, scopeBinding: scope,
    invocation: configuration.invocation, limits, origin: { kind: 'operation', operationId, rootOperationId: operationId, callKey: 'original-call' },
    selection: { catalogId: groupInput.catalogId, catalogDigest: groupInput.catalogDigest, rawCatalog,
      catalogImageExpectation: image, rawName: rawCatalog[0].name, rawDescriptor: rawCatalog[0], arguments: { text: '原始\0args' } } })
  const taskDigest = sha('task', task), executionRef = { kind: 'cloud', executionId }
  const capture = { kind: 'cloud', podUid, podName: 'synthetic-sandbox', namespace: 'synthetic', nodeName: 'synthetic-node', runnerInstanceId,
    containerId: 'containerd://exact', restartCount: 0, mountGeneration: '7', workspaceMount: { claimName: 'owned', subPath: 'workspace/synthetic', mountPath: '/workspace', readOnly: false },
    homeMount: { claimName: 'owned', subPath: 'home/synthetic', mountPath: '/home/agent', readOnly: false } }
  const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId, executionRef, taskDigest, scopeBinding: scope,
    expectedDeploymentPin: pin, actualExecutorImage: image, capture, specDigest: sha('spec', { original: 'full-synthetic-spec' }),
    fullScopeDigest: sha('scope', { scopeBinding: scope, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }) })
  const preparedDigest = sha('prepared', prepared)
  const permit = { actionId, taskDigest, preparedDigest, approvalEpoch: 1, expiresAt: new Date(now + 5000).toISOString(),
    approvalFingerprint: 'c'.repeat(64), permitId: uuid(), authorizationRequestId: uuid(), executionRef,
    executorOwner: { kind: 'cloud', runnerInstanceId }, issuedAt: new Date(now - 1000).toISOString() }
  const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest, executionRef, preparedDigest, permit })
  const dispatchDigest = sha('dispatch', dispatch)
  put('pe_users', { id: userId, username: 'synthetic', display_name: 'Synthetic', role: 'USER', enabled: true,
    account_revision: 1, credential_version: 1, password_change_required: false, deleted_at: null })
  put('pe_sessions', { id: sessionId, user_id: userId, workspace_id: workspaceId })
  put('pe_stdio_v2_connections', { id: connectionId, user_id: userId })
  put('pe_stdio_v2_actions', { id: actionId, user_id: userId, session_id: sessionId, connection_id: connectionId,
    config_revision: 1, config_digest: task.configDigest, phase: 'call', execution_target: 'cloud', execution_id: executionId,
    task, task_digest: taskDigest, state: 'succeeded', cancel_requested: false, request_id: null, operation_id: operationId,
    root_operation_id: operationId, call_id: task.origin.callKey, continuation_request_id: continuation,
    continuation_queued: false, lease_owner: workerId, lease_epoch: 3, lease_until: new Date(now + 60000) })
  put('pe_cloud_executions', { id: executionId, user_id: userId, session_id: sessionId, execution_kind: 'stdio_v2', execution_target: 'cloud',
    task_version: 2, stdio_action_id: actionId, stdio_phase: 'call', stdio_task: task, request_digest: taskDigest, origin_kind: 'operation',
    operation_id: operationId, call_id: task.origin.callKey, continuation_request_id: continuation, command: null, cwd: null,
    state: 'succeeded', cancel_requested: false, sandbox_name: capture.podName, pod_uid: podUid, runner_instance_id: runnerInstanceId,
    lease_owner: null, lease_until: null })
  put('pe_stdio_v2_preparations', { action_id: actionId, user_id: userId, session_id: sessionId, phase: 'call', execution_target: 'cloud',
    execution_id: executionId, task_digest: taskDigest, prepared, prepared_digest: preparedDigest })
  put('pe_stdio_v2_dispatches', { action_id: actionId, dispatch, dispatch_digest: dispatchDigest })
  put('pe_stdio_v2_start_permits', { action_id: actionId })
  const facts = { programStartAttempted: true, toolsCallAttempted: true, effectMayHaveOccurred: true,
    childPid: 12345, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
    protocolBytes: 200, protocolMessages: 4, stderrBytes: 0, stderr: '' }
  const outcome = { state: 'completed', phase: 'call', catalog: clone(rawCatalog), pages: [{ tools: clone(rawCatalog), extra: 'page\0raw' }],
    initializeResult: { protocolVersion: 'synthetic', _meta: { raw: 'init\0raw' } }, facts,
    result: { content: [{ type: 'text', text: 'result\0😀' }], structuredContent: { accepted: true }, isError: false, extension: { full: true } } }
  const view = { formatVersion: 2, instanceId: runnerInstanceId, actionId, executionRef, taskDigest, dispatchDigest,
    state: 'completed', writerStopConfirmed: true, outcome }
  const proof = { formatVersion: 2, kind: 'cloud_uid_quiet', actionId, executionRef, taskDigest, dispatchDigest, preparedDigest,
    fullScopeDigest: prepared.fullScopeDigest, podUid, runnerInstanceId, mountGeneration: capture.mountGeneration, observedAt: new Date(now).toISOString() }
  put('pe_stdio_v2_results', { action_id: actionId, result: outcome, result_digest: sha('result', outcome), observation: view, stop_evidence: proof })
  const columns = { settings: { model: 'synthetic', maxTokens: 1000, revision: 7 },
    skill_selection: [{ skillId: uuid(), name: 'Synthetic', description: 'Frozen', digest: '1'.repeat(64), revision: 2,
      kind: 'package', version: '1.0.0', packageDigest: '2'.repeat(64), manifestDigest: '3'.repeat(64) }],
    mcp_selection: [{ connectionId: uuid(), revision: 2 }], stdio_mcp_selection: [{ connectionId: uuid(), revision: 3 }],
    ssh_selection: [{ connectionId: uuid(), revision: 2, credentialRevision: 4, displayName: 'Synthetic SSH', host: 'localhost', port: 22, username: 'fixture' }],
    remote_mcp_selection: [{ formatVersion: 1, connectionId: uuid(), connectionRevision: 1, configurationRevision: 2,
      credentialRevision: null, catalogId: uuid(), toolId: uuid(), descriptorDigest: '4'.repeat(64),
      raw: { name: 'remote_echo', inputSchema: { type: 'object' } },
      model: { name: 'remote_echo', description: 'Frozen remote', parameters: { type: 'object' } }, modelDigest: '5'.repeat(64) }],
    stdio_v2_selection: groups, execution_target: { kind: 'cloud' } }
  put('pe_operations', { id: operationId, session_id: sessionId, request_id: uuid(), input: 'Synthetic original user input',
    ...columns, mcp_root_operation_id: null, mcp_chain_cancelled_at: null, source: 'user', state: 'completed' })
  put('pe_mcp_action_chains', { root_operation_id: operationId, user_id: userId, session_id: sessionId,
    calls: 1, max_calls: 4, expires_at: new Date(now + 100000), stopped_at: null, error_code: null })
  const lease = stdioActionLeaseV2.parse({ actionId, workerId, leaseEpoch: 3 })
  const service = new StdioCallContinuationV2({ limits, maxReplyBytes, admission, ...options })
  const get = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(decode)
  const change = (table, field, value, id = null) => db.prepare(`UPDATE ${table} SET ${field}=?${id ? ' WHERE id=?' : ''}`)
    .run(...(id ? [encode(value), id] : [encode(value)]))
  const stored = () => Object.fromEntries(['pe_operations', 'pe_stdio_v2_actions', 'pe_mcp_action_chains', 'pe_stdio_v2_results',
    'pe_stdio_v2_no_start_closures', 'pe_cloud_executions'].map(table => [table, get(table)]))
  const enqueue = async () => {
    db.exec('BEGIN')
    try { const reply = await service.enqueueLeased(client, lease); db.exec('COMMIT'); return reply }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function saveResult() {
    change('pe_stdio_v2_results', 'result', view.outcome); change('pe_stdio_v2_results', 'result_digest', sha('result', view.outcome))
    change('pe_stdio_v2_results', 'observation', view)
    const terminal = view.state === 'completed' ? 'succeeded' : view.state === 'cancelled' ? 'cancelled' : 'failed'
    change('pe_stdio_v2_actions', 'state', terminal); change('pe_cloud_executions', 'state', terminal)
  }
  function noStart(kind = 'unallocated') {
    for (const table of ['pe_stdio_v2_results', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_start_permits']) db.exec(`DELETE FROM ${table}`)
    const bindingSnapshot = { workspaceId, spaceId: scope.target.spaceId, rootKey: uuid(),
      rootRelativePath: scope.target.rootRelativePath, generation: scope.bindingGeneration }
    const resource = kind === 'unallocated' ? { kind } : kind === 'ready_retained' ? { kind, name: capture.podName,
      podUid, runnerInstanceId, mountGeneration: capture.mountGeneration, bindingSnapshot }
      : { kind, name: capture.podName, mountGeneration: capture.mountGeneration, bindingSnapshot,
        stopEvidence: { status: 'KUBELET_STOPPED', podUid, sandboxUid: uuid(), generation: capture.mountGeneration,
          sessionId, runnerInstanceId: null, bindingSnapshot, observedAt: new Date(now).toISOString() } }
    if (kind !== 'ready_retained') {
      db.exec('DELETE FROM pe_stdio_v2_preparations')
      for (const key of ['sandbox_name', 'pod_uid', 'runner_instance_id']) change('pe_cloud_executions', key, null)
    }
    for (const table of ['pe_stdio_v2_actions', 'pe_cloud_executions']) {
      change(table, 'state', 'cancelled'); change(table, 'cancel_requested', true)
    }
    const receipt = { formatVersion: 2, kind: 'unstarted_closed', actionId, executionRef, taskDigest,
      preparedDigest: kind === 'ready_retained' ? preparedDigest : null, userId, sessionId, phase: 'call',
      state: 'cancelled', startNeverAuthorized: true, resource }
    put('pe_stdio_v2_no_start_closures', { action_id: actionId, user_id: userId, session_id: sessionId, phase: 'call', execution_target: 'cloud',
      execution_id: executionId, task_digest: taskDigest, prepared_digest: receipt.preparedDigest,
      worker_id: workerId, lease_epoch: 3, receipt, receipt_digest: sha('no_start', receipt) })
    return receipt
  }
  return { db, client, service, lease, actionId, operationId, sessionId, executionId, continuation, columns, task, prepared,
    dispatch, proof, view, get, change, put, stored, enqueue, saveResult, noStart, queries, mutations,
    setNow(value) { now = value }, expireWrite(value) { expireAt = value }, failWrite(value) { failAt = value },
    get notifications() { return notifications } }
}
const code = expected => error => error.code === expected

test('one actual result queues original settings, six nonempty selections and target; retry preserves the first input and notification', async t => {
  const f = fixture(t), originals = f.get('pe_stdio_v2_results'), first = await f.enqueue()
  assert.equal(first.disposition, 'queued'); assert(first.operationId)
  const queued = f.get('pe_operations')[1], body = JSON.parse(queued.input)
  assert.deepEqual(body.outcome, f.view.outcome); assert.equal(body.state, 'completed'); assert.equal(body.writerStopConfirmed, true)
  assert.equal(body.chainStopped, false); assert.equal(body.errorCode, null)
  for (const key of copies) assert.deepEqual(queued[key], f.columns[key])
  assert.equal(queued.source, 'stdio_v2_result'); assert.equal(queued.source_stdio_v2_action_id, f.actionId)
  assert.equal(queued.source_stdio_v2_no_start_action_id, null); assert.equal(queued.source_stdio_v2_phase, 'call')
  assert.equal(queued.request_id, f.continuation); assert.equal(queued.mcp_root_operation_id, f.operationId)
  assert.equal(f.get('pe_stdio_v2_actions')[0].continuation_queued, true); assert.equal(f.notifications, 1)
  assert.deepEqual(f.get('pe_stdio_v2_results'), originals)
  f.change('pe_operations', 'mcp_chain_cancelled_at', new Date('2026-10-08'), f.operationId)
  f.change('pe_mcp_action_chains', 'stopped_at', new Date('2026-10-08')); f.change('pe_mcp_action_chains', 'error_code', 'mcp_operation_cancelled')
  f.change('pe_users', 'enabled', false)
  assert.deepEqual(await f.enqueue(), { disposition: 'original', operationId: first.operationId })
  assert.deepEqual(f.get('pe_operations')[1], queued); assert.equal(f.notifications, 1)
  assert(!f.queries.some(sql => /^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)), 'only the caller owns the transaction')
  assert.equal(f.get('pe_cloud_executions')[0].lease_owner, null, 'terminal execution lease is not used as authority')
})

test('completed SDK isError and invalid structured output preserve raw success while stopping this automatic chain once', async t => {
  for (const [mutate, expected] of [
    [f => { f.view.outcome.result.isError = true }, 'stdio_v2_tool_error'],
    [f => { f.view.outcome.result.structuredContent.accepted = 'invalid' }, 'stdio_v2_result_schema_invalid'],
    [f => { delete f.view.outcome.result.content }, 'stdio_v2_result_schema_invalid'],
  ]) {
    const f = fixture(t); mutate(f); f.saveResult(); const before = f.get('pe_stdio_v2_results')
    await f.enqueue(); const body = JSON.parse(f.get('pe_operations')[1].input)
    assert.equal(body.state, 'completed'); assert.equal(body.outcome.state, 'completed'); assert.equal(body.chainStopped, true)
    assert.equal(body.errorCode, expected); assert.match(body.instruction, /do not repeat/u)
    assert.deepEqual(f.get('pe_stdio_v2_results'), before); assert.equal(f.get('pe_stdio_v2_actions')[0].state, 'succeeded')
    assert.equal(f.get('pe_mcp_action_chains')[0].error_code, expected); assert(f.get('pe_mcp_action_chains')[0].stopped_at)
    assert.equal((await f.enqueue()).disposition, 'original'); assert.equal(f.notifications, 1)
  }
})

test('local failed and cancelled calls report actual facts once; cancellation flags alone do not suppress delivery', async t => {
  for (const state of ['failed', 'cancelled']) {
    const f = fixture(t); f.view.state = state
    f.view.outcome = { state: 'failed', errorCode: 'stdio_v2_aborted', facts: { ...f.view.outcome.facts, signal: 'SIGTERM', exitCode: null } }
    f.saveResult(); f.change('pe_stdio_v2_actions', 'cancel_requested', true); f.change('pe_cloud_executions', 'cancel_requested', true)
    assert.equal((await f.enqueue()).disposition, 'queued')
    const body = JSON.parse(f.get('pe_operations')[1].input)
    assert.equal(body.state, state); assert.equal(body.chainStopped, true); assert.deepEqual(body.outcome, f.view.outcome)
    assert.equal(body.outcome.facts.effectMayHaveOccurred, true)
  }
})

test('formal call no-start uses its own source and retains every complete resource receipt in PG', async t => {
  for (const kind of ['unallocated', 'ready_retained', 'creation_stopped']) {
    const f = fixture(t), receipt = f.noStart(kind), before = f.get('pe_stdio_v2_no_start_closures')
    assert.equal((await f.enqueue()).disposition, 'queued')
    const queued = f.get('pe_operations')[1], body = JSON.parse(queued.input)
    assert.equal(queued.source, 'stdio_v2_no_start'); assert.equal(queued.source_stdio_v2_no_start_action_id, f.actionId)
    assert.equal(queued.source_stdio_v2_action_id, null); assert.equal(queued.source_stdio_v2_phase, 'call')
    assert.equal(body.startNeverAuthorized, true); assert.equal(body.state, 'cancelled'); assert.equal(body.resourceDisposition, kind)
    assert(!Object.hasOwn(body, 'outcome')); assert(!Object.hasOwn(body, 'writerStopConfirmed'))
    if (kind !== 'unallocated') assert(!queued.input.includes(receipt.resource.bindingSnapshot.rootKey))
    assert.equal(f.get('pe_stdio_v2_results').length, 0); assert.deepEqual(f.get('pe_stdio_v2_no_start_closures'), before)
    assert.deepEqual(before[0].receipt, receipt); assert.equal((await f.enqueue()).disposition, 'original'); assert.equal(f.notifications, 1)
  }
})

test('permanent root cancellation and inactive account suppress new operations while preserving actual results and local stop facts', async t => {
  for (const mutate of [f => f.change('pe_operations', 'mcp_chain_cancelled_at', new Date('2026-10-08')),
    f => f.change('pe_users', 'enabled', false), f => f.change('pe_users', 'deleted_at', new Date('2026-10-08'))]) {
    const f = fixture(t); mutate(f); const before = f.stored()
    assert.deepEqual(await f.enqueue(), { disposition: 'suppressed', operationId: null })
    assert.deepEqual(f.stored(), before); assert.equal(f.notifications, 0); assert.equal(f.mutations.length, 0)
  }
  const f = fixture(t); f.noStart(); f.change('pe_operations', 'mcp_chain_cancelled_at', new Date('2026-10-08'))
  assert.equal((await f.enqueue()).disposition, 'suppressed'); assert.equal(f.get('pe_operations').length, 1)
})

test('a stopped or expired chain still receives one accurate final report without changing the immutable success input', async t => {
  const f = fixture(t); f.change('pe_mcp_action_chains', 'stopped_at', new Date('2026-10-07'))
  f.change('pe_mcp_action_chains', 'expires_at', new Date('2026-10-07')); f.change('pe_mcp_action_chains', 'error_code', 'stdio_v2_chain_expired')
  assert.equal((await f.enqueue()).disposition, 'queued')
  const body = JSON.parse(f.get('pe_operations')[1].input)
  assert.equal(body.chainStopped, false, 'the tag describes this result, not the live root status')
  assert.match(body.instruction, /remaining original root budget/u)
  assert.equal(f.get('pe_mcp_action_chains')[0].error_code, 'stdio_v2_chain_expired')
})

test('all conflicting existing request fields reject atomically, even after root cancellation', async t => {
  const changes = [['input', 'changed input'], ['source', 'platform_action'], ['source_stdio_v2_action_id', uuid()],
    ['source_stdio_v2_no_start_action_id', uuid()], ['source_stdio_v2_phase', 'discover'], ['mcp_root_operation_id', uuid()],
    ['settings', { model: 'changed', maxTokens: 1000, revision: 1 }], ['skill_selection', []], ['mcp_selection', []],
    ['stdio_mcp_selection', []], ['ssh_selection', []], ['remote_mcp_selection', []], ['stdio_v2_selection', []],
    ['execution_target', { kind: 'desktop', deviceId: uuid(), directoryId: uuid() }]]
  for (const [field, value] of changes) {
    const f = fixture(t), first = await f.enqueue(); f.change('pe_operations', field, value, first.operationId)
    f.change('pe_operations', 'mcp_chain_cancelled_at', new Date('2026-10-08'), f.operationId)
    const before = f.stored(); await assert.rejects(f.enqueue(), code('stdio_v2_continuation_request_conflict'))
    assert.deepEqual(f.stored(), before); assert.equal(f.notifications, 1)
  }
})

test('duplicate replies with a lost continuation flag repair only that flag, without rewriting or notifying', async t => {
  const f = fixture(t), first = await f.enqueue(); const queued = f.get('pe_operations')[1]
  f.change('pe_stdio_v2_actions', 'continuation_queued', false)
  assert.deepEqual(await f.enqueue(), { disposition: 'original', operationId: first.operationId })
  assert.deepEqual(f.get('pe_operations')[1], queued); assert.equal(f.notifications, 1)
  const broken = fixture(t); broken.change('pe_stdio_v2_actions', 'continuation_queued', true)
  await assert.rejects(broken.enqueue(), code('stdio_v2_continuation_request_conflict')); assert.equal(broken.get('pe_operations').length, 1)
})

test('unknown, unproved, changed result/capture/task/catalog and wrong original identities never queue', async t => {
  const changes = [
    f => { f.change('pe_stdio_v2_results', 'stop_evidence', null) },
    f => { f.view.state = 'unknown'; f.view.writerStopConfirmed = false; f.saveResult() },
    f => { f.view.state = 'running'; delete f.view.outcome; f.change('pe_stdio_v2_results', 'observation', f.view) },
    f => f.change('pe_stdio_v2_results', 'result_digest', '0'.repeat(64)),
    f => { f.view.instanceId = uuid(); f.saveResult() },
    f => { f.proof.fullScopeDigest = '0'.repeat(64); f.change('pe_stdio_v2_results', 'stop_evidence', f.proof) },
    f => { f.prepared.capture.mountGeneration = '8'; f.change('pe_stdio_v2_preparations', 'prepared', f.prepared); f.change('pe_stdio_v2_preparations', 'prepared_digest', sha('prepared', f.prepared)) },
    f => { f.dispatch.task.selection.arguments.text = 'changed'; f.change('pe_stdio_v2_dispatches', 'dispatch', f.dispatch); f.change('pe_stdio_v2_dispatches', 'dispatch_digest', sha('dispatch', f.dispatch)) },
    f => f.change('pe_stdio_v2_actions', 'task_digest', '0'.repeat(64)),
    f => f.change('pe_cloud_executions', 'request_digest', '0'.repeat(64)),
    f => f.change('pe_cloud_executions', 'operation_id', uuid()),
    f => f.change('pe_sessions', 'workspace_id', uuid()),
    f => f.change('pe_mcp_action_chains', 'user_id', uuid()),
    f => f.change('pe_operations', 'mcp_root_operation_id', uuid()),
    f => { f.db.exec('DELETE FROM pe_stdio_v2_results') },
  ]
  for (const mutate of changes) {
    const f = fixture(t); mutate(f); const before = f.stored(); await assert.rejects(f.enqueue())
    assert.deepEqual(f.stored(), before); assert.equal(f.notifications, 0); assert.equal(f.get('pe_operations').length, 1)
  }
})

test('complete frozen group digests, model maps and ownership cannot be changed on readback', async t => {
  for (const mutate of [g => { g.configDigest = '0'.repeat(64) }, g => { g.catalogDigest = '0'.repeat(64) },
    g => { g.tools[0].modelDigest = '0'.repeat(64) }, g => { g.tools[0].model.description = 'changed' },
    g => { g.tools[0].model.parameters = { type: 'object' } }, g => { g.tools[0].model.name = 'changed' },
    g => { g.scopeBinding.userId = uuid(); g.scopeBinding.home.userId = g.scopeBinding.userId }]) {
    const f = fixture(t), groups = clone(f.columns.stdio_v2_selection); mutate(groups[0]); f.change('pe_operations', 'stdio_v2_selection', groups)
    const before = f.stored(); await assert.rejects(f.enqueue()); assert.deepEqual(f.stored(), before); assert.equal(f.notifications, 0)
  }
})

test('ordinary own __proto__ metadata and raw result extensions survive PG readback and the complete continuation', async t => {
  const rawMeta = JSON.parse('{"__proto__":{"retained":"raw metadata\\u0000"},"ordinary":true}')
  const f = fixture(t, { rawMeta })
  f.view.outcome.result.extension = JSON.parse('{"__proto__":{"retained":"raw result\\u0000"},"ordinary":true}')
  f.saveResult(); const before = f.get('pe_stdio_v2_results'); await f.enqueue()
  const op = f.get('pe_operations')[1], body = JSON.parse(op.input)
  assert.deepEqual(op.stdio_v2_selection[0].rawCatalog[0]._meta, rawMeta)
  assert(Object.hasOwn(op.stdio_v2_selection[0].rawCatalog[0]._meta, '__proto__'))
  assert.deepEqual(body.outcome.catalog[0]._meta, rawMeta)
  assert(Object.hasOwn(body.outcome.result.extension, '__proto__'))
  assert.deepEqual(body.outcome.result.extension, f.view.outcome.result.extension)
  assert.deepEqual(f.get('pe_stdio_v2_results'), before)
})

test('no-start proof conflicts, changed receipts, start permits and private resource mismatches reject without a fake result', async t => {
  for (const mutate of [
    f => f.change('pe_stdio_v2_no_start_closures', 'receipt_digest', '0'.repeat(64)),
    f => f.change('pe_stdio_v2_no_start_closures', 'worker_id', uuid()),
    f => f.change('pe_stdio_v2_no_start_closures', 'prepared_digest', '0'.repeat(64)),
    f => f.put('pe_stdio_v2_start_permits', { action_id: f.actionId }),
    f => f.change('pe_cloud_executions', 'cancel_requested', false),
    f => f.change('pe_cloud_executions', 'pod_uid', uuid()),
  ]) {
    const f = fixture(t); f.noStart('ready_retained'); mutate(f); const before = f.stored()
    await assert.rejects(f.enqueue()); assert.deepEqual(f.stored(), before); assert.equal(f.get('pe_stdio_v2_results').length, 0)
  }
})

test('expiry at each mutation and a write failure roll back insertion, stop flags and continuation flag together', async t => {
  for (const step of ['UPDATE pe_mcp_action_chains', 'INSERT INTO pe_operations', 'UPDATE pe_stdio_v2_actions']) {
    const f = fixture(t); f.view.outcome.result.isError = true; f.saveResult(); const before = f.stored()
    f.expireWrite(step); await assert.rejects(f.enqueue(), code('stdio_v2_lease_lost')); assert.deepEqual(f.stored(), before)
    assert.equal(f.notifications, 0)
  }
  const f = fixture(t); f.view.outcome.result.isError = true; f.saveResult(); const before = f.stored()
  f.failWrite('UPDATE pe_stdio_v2_actions'); await assert.rejects(f.enqueue()); assert.deepEqual(f.stored(), before)
  const stale = fixture(t); stale.change('pe_stdio_v2_actions', 'lease_owner', uuid())
  await assert.rejects(stale.enqueue(), code('stdio_v2_lease_lost')); assert.equal(stale.mutations.length, 0)
})

test('complete result input escaping and whole snapshot limits reject instead of dropping or truncating fields', async t => {
  const probe = fixture(t); probe.view.outcome.result.content[0].text = '\0'.repeat(1000); probe.saveResult(); await probe.enqueue()
  const maxInputBytes = Buffer.byteLength(probe.get('pe_operations')[1].input) + 1
  assert(Buffer.byteLength(JSON.stringify(probe.get('pe_operations')[1].input)) > maxInputBytes)
  const smallLimits = { ...limits, maxInputBytes, maxResultBytes: 8192 }, f = fixture(t, { limits: smallLimits })
  const task = clone(f.task); task.limits = smallLimits; const taskDigest = stdioSha256V2('task', task, { ...budget, maxBytes: maxInputBytes })
  f.change('pe_stdio_v2_actions', 'task', task); f.change('pe_stdio_v2_actions', 'task_digest', taskDigest)
  f.change('pe_cloud_executions', 'stdio_task', task); f.change('pe_cloud_executions', 'request_digest', taskDigest)
  const groups = clone(f.columns.stdio_v2_selection); groups[0].limits = smallLimits
  f.change('pe_operations', 'stdio_v2_selection', groups)
  const p = clone(f.prepared); p.taskDigest = taskDigest; const pd = sha('prepared', p)
  f.change('pe_stdio_v2_preparations', 'prepared', p); f.change('pe_stdio_v2_preparations', 'prepared_digest', pd)
  f.change('pe_stdio_v2_preparations', 'task_digest', taskDigest)
  const d = clone(f.dispatch); d.task = task; d.taskDigest = taskDigest; d.preparedDigest = pd
  d.permit.taskDigest = taskDigest; d.permit.preparedDigest = pd; const dd = sha('dispatch', d)
  f.change('pe_stdio_v2_dispatches', 'dispatch', d); f.change('pe_stdio_v2_dispatches', 'dispatch_digest', dd)
  f.view.taskDigest = taskDigest; f.view.dispatchDigest = dd; f.view.outcome.result.content[0].text = '\0'.repeat(1000)
  f.saveResult(); f.proof.taskDigest = taskDigest; f.proof.dispatchDigest = dd; f.proof.preparedDigest = pd
  f.change('pe_stdio_v2_results', 'stop_evidence', f.proof)
  const before = f.stored(); await assert.rejects(f.enqueue(), code('stdio_v2_continuation_input_limit'))
  assert.deepEqual(f.stored(), before); assert.equal(f.notifications, 0)
  const capped = fixture(t, { admission: { ...admission, maxSnapshotBytes: 1000 } })
  await assert.rejects(capped.enqueue(), code('stdio_v2_continuation_record_invalid')); assert.equal(capped.mutations.length, 0)
})
