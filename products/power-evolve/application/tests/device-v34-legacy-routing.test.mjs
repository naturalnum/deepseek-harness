/** Legacy consumers execute SQL against isolated in-memory SQLite; this is not PG migration or locking evidence. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { DeviceService } from '../src/platform/devices.ts'
import { captureDeviceResolutionSnapshot } from '../src/platform/device-execution-resolution-types.ts'

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const jsonFields = new Set(['settings', 'skill_selection', 'execution_target', 'remote_mcp_selection',
  'dispatch_request', 'container_receipt', 'result', 'stop_observation', 'request', 'receipt', 'snapshot'])
const boolFields = new Set(['enabled', 'passwordChangeRequired', 'cancel_requested', 'continuation_queued'])
const dateFields = new Set(['created_at', 'start_authorized_at', 'revoked_at', 'directory_revoked_at', 'deletedAt'])
const timestamp = '2026-10-07T00:00:00.000Z'
const result = { state: 'succeeded', exitCode: 0, stdout: 'unchanged\0正文😀', stderr: '',
  stdoutTruncated: false, stderrTruncated: false, timedOut: false }
const activeStates = ['queued', 'running', 'cancelling', 'uncertain']

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const queries = []
  db.function('now', () => timestamp); db.function('clock_timestamp', () => timestamp)
  db.function('pg_notify', (_channel, _payload) => null)
  // Only columns used by these consumers are modelled; Root owns and tests the actual V34 DDL.
  db.exec(`CREATE TABLE pe_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,enabled INTEGER,
    account_revision INTEGER,credential_version INTEGER,password_change_required INTEGER,deleted_at TEXT);
    CREATE TABLE pe_credentials(digest TEXT PRIMARY KEY,user_id TEXT,audience TEXT,credential_version INTEGER,expires_at TEXT);
    CREATE TABLE pe_devices(id TEXT PRIMARY KEY,user_id TEXT,instance_id TEXT,revoked_at TEXT,token_digest TEXT,last_seen_at TEXT,name TEXT);
    CREATE TABLE pe_device_directories(id TEXT PRIMARY KEY,device_id TEXT,user_id TEXT,revoked_at TEXT,label TEXT);
    CREATE TABLE pe_sessions(id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE pe_operations(id TEXT PRIMARY KEY,session_id TEXT,request_id TEXT,input TEXT,settings TEXT,skill_selection TEXT,
      execution_target TEXT,remote_mcp_selection TEXT,mcp_root_operation_id TEXT,source TEXT,source_desktop_execution_id TEXT,state TEXT,
      UNIQUE(session_id,request_id));
    CREATE TABLE pe_cloud_executions(id TEXT PRIMARY KEY,session_id TEXT,execution_kind TEXT,state TEXT);
    CREATE TABLE pe_desktop_executions(id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,operation_id TEXT,device_id TEXT,directory_id TEXT,
      call_id TEXT,command TEXT,cwd TEXT,request_digest TEXT,state TEXT,cancel_requested INTEGER DEFAULT 0,
      device_instance_id TEXT,result TEXT,error_code TEXT,continuation_request_id TEXT,created_at TEXT DEFAULT '${timestamp}',updated_at TEXT,
      dispatch_request TEXT,dispatch_id TEXT,dispatch_process_id TEXT,container_receipt TEXT,start_authorized_at TEXT,
      stop_request_id TEXT,stop_record_digest TEXT,stop_observation TEXT,continuation_queued INTEGER DEFAULT 0,
      execution_kind TEXT,origin_kind TEXT,task_version INTEGER,stdio_phase TEXT,stdio_task TEXT,stdio_action_id TEXT);
    CREATE TABLE pe_device_claim_closures(id TEXT PRIMARY KEY,request_id TEXT,user_id TEXT,session_id TEXT,execution_id TEXT,
      device_id TEXT,request_digest TEXT,request TEXT,receipt TEXT,continuation_request_id TEXT);
    CREATE TABLE pe_device_execution_resolutions(id TEXT PRIMARY KEY,request_id TEXT,user_id TEXT,session_id TEXT,execution_id TEXT,
      request_digest TEXT,fingerprint TEXT,snapshot TEXT,note TEXT,state TEXT,final_execution_state TEXT,
      continuation_request_id TEXT,continuation_queued INTEGER);`)
  function execute(sql, values = []) {
    queries.push(sql)
    const translated = sql.replace(/=ANY\((\$\d+)::uuid\[\]\)/gu, ' IN (SELECT value FROM json_each($1))')
      .replace(/::uuid/gu, '').replace(/ FOR (?:NO KEY UPDATE|UPDATE|SHARE)(?: OF \w+)?/gu, '')
    const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1),
      value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? Number(value)
      : Array.isArray(value) ? JSON.stringify(value) : value]))
    const before = db.prepare('SELECT total_changes() AS n').get().n
    const rows = db.prepare(translated).all(bindings).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value === null ? null : jsonFields.has(key) ? JSON.parse(value)
      : boolFields.has(key) ? Boolean(value) : dateFields.has(key) ? new Date(value) : value])))
    return { rows, rowCount: rows.length || db.prepare('SELECT total_changes() AS n').get().n - before }
  }
  const client = Object.assign(new EventEmitter(), { query: async (sql, values) => execute(sql, values), release() {} })
  const pool = { query: client.query, connect: async () => client }
  const user = { userId: randomUUID(), username: 'synthetic-owner' }, deviceId = randomUUID(), directoryId = randomUUID()
  const instanceId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID(), token = 'synthetic-device-token'
  const approvalToken = 's'.repeat(48)
  const target = { kind: 'desktop', deviceId, directoryId }
  function insert(table, fields) {
    const keys = Object.keys(fields)
    db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
      .run(...Object.values(fields).map(value => value === null ? null : typeof value === 'object' ? JSON.stringify(value)
        : typeof value === 'boolean' ? Number(value) : value))
  }
  insert('pe_users', { id: user.userId, username: user.username, display_name: 'Synthetic owner', role: 'USER', enabled: true,
    account_revision: 1, credential_version: 1, password_change_required: false, deleted_at: null })
  insert('pe_credentials', { digest: hash(approvalToken), user_id: user.userId, audience: 'approval', credential_version: 1,
    expires_at: '2099-01-01T00:00:00.000Z' })
  insert('pe_devices', { id: deviceId, user_id: user.userId, instance_id: instanceId, revoked_at: null, token_digest: hash(token), name: 'Synthetic device' })
  insert('pe_device_directories', { id: directoryId, device_id: deviceId, user_id: user.userId, revoked_at: null, label: 'Synthetic directory' })
  insert('pe_sessions', { id: sessionId, user_id: user.userId })
  insert('pe_operations', { id: operationId, session_id: sessionId, request_id: randomUUID(), input: 'Synthetic input', settings: {},
    skill_selection: [], execution_target: target, remote_mcp_selection: [], source: 'user', state: 'completed' })
  const grant = { id: sessionId, user_id: user.userId, operation_id: operationId, execution_target: target }
  const service = new DeviceService({ pool, authorized: async () => grant }, 1234, {})
  function add(kind = 'legacy_command', overrides = {}) {
    const request = { command: 'printf synthetic', cwd: '.', timeoutMs: 1234, deviceId, directoryId }
    const discovery = kind === 'stdio_v2' && overrides.origin_kind !== 'operation'
    const row = { id: randomUUID(), user_id: user.userId, session_id: sessionId, operation_id: discovery ? null : operationId,
      device_id: deviceId, directory_id: directoryId, call_id: discovery ? null : randomUUID(),
      command: kind === 'legacy_command' ? request.command : null, cwd: kind === 'legacy_command' ? request.cwd : null,
      request_digest: hash(request), state: 'queued', cancel_requested: false, device_instance_id: instanceId,
      result: null, error_code: null, continuation_request_id: discovery ? null : randomUUID(),
      dispatch_request: kind === 'legacy_command' ? request : null, dispatch_id: null, dispatch_process_id: null,
      container_receipt: null, start_authorized_at: null, stop_request_id: null, stop_record_digest: null,
      stop_observation: null, continuation_queued: false, execution_kind: kind,
      origin_kind: discovery ? 'stdio_discovery' : 'operation', task_version: kind === 'legacy_command' ? null : 2,
      stdio_phase: kind === 'legacy_command' ? null : discovery ? 'discover' : 'call',
      stdio_task: kind === 'legacy_command' ? null : { formatVersion: 2, fixture: true },
      stdio_action_id: kind === 'legacy_command' ? null : randomUUID(), ...overrides }
    insert('pe_desktop_executions', row)
    return row.id
  }
  const row = id => execute('SELECT * FROM pe_desktop_executions WHERE id=$1', [id]).rows[0]
  const continuations = id => db.prepare('SELECT count(*) AS n FROM pe_operations WHERE source_desktop_execution_id=?').get(id).n
  function registeredInput(claim) {
    return { instanceId, executionId: claim.executionId, processId: claim.processId, dispatchId: claim.dispatchId,
      receipt: { containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), owner: { deviceId, enrollmentId: instanceId,
        executionId: claim.executionId, creationId: claim.dispatchId, requestDigest: claim.digest } } }
  }
  function finishInput(registration, output = result) {
    const { receipt, ...dispatch } = registration
    return { ...dispatch, requestId: randomUUID(),
      observation: { receipt, Running: false, ExitCode: output.exitCode ?? 0, Status: 'exited',
        StartedAt: timestamp, FinishedAt: '2026-10-07T00:00:01.000Z' }, result: output }
  }
  return { db, queries, execute, insert, add, row, continuations, service, user, token, instanceId,
    deviceId, directoryId, sessionId, operationId, grant, approvalToken, registeredInput, finishInput }
}

test('legacy jobs and owner/resolution lists exclude both generic discovery and operation-origin calls', async t => {
  const f = fixture(t), legacy = f.add(), discovery = f.add('stdio_v2'), call = f.add('stdio_v2', { origin_kind: 'operation' })
  const jobs = await f.service.jobs(f.token, f.instanceId)
  assert.deepEqual(jobs.jobs.map(row => row.executionId), [legacy])
  assert.deepEqual((await f.service.executions(f.user)).items.map(row => row.executionId), [legacy])
  assert.deepEqual((await f.service.listResolutions(f.user, {})).items.map(row => row.executionId), [legacy])
  assert.equal(f.row(discovery).state, 'queued'); assert.equal(f.row(call).state, 'queued')
})

test('all legacy Device protocol entries refuse generic rows without capture, stop or continuation mutation', async t => {
  for (const origin_kind of ['stdio_discovery', 'operation']) {
    const f = fixture(t), id = f.add('stdio_v2', { origin_kind }), before = f.row(id), processId = randomUUID()
    const registration = f.registeredInput({ executionId: id, processId, dispatchId: randomUUID(), digest: before.request_digest })
    const inputs = [
      [() => f.service.claim(f.token, f.instanceId, id, processId), 'desktop_execution_unavailable'],
      [() => f.service.register(f.token, registration), 'execution_not_found'],
      [() => f.service.registered(f.token, registration), 'execution_not_found'],
      [() => f.service.finish(f.token, f.finishInput(registration)), 'execution_not_found'],
      [() => f.service.closeUnstartedClaim(f.token, { instanceId: f.instanceId, executionId: id, processId,
        directoryId: f.directoryId, digest: before.request_digest, requestId: randomUUID() }), 'execution_not_found'],
      [() => f.service.material(f.token, { executionId: id, instanceId: f.instanceId, processId,
        dispatchId: registration.dispatchId, digest: before.request_digest, skillId: randomUUID() }), 'execution_not_found'],
      [() => f.service.cancel(f.user, id), 'execution_not_found'],
      [() => f.service.inspectResolution(f.user, id), 'execution_not_found'],
      [() => f.service.resolveUncertain(f.user, { requestId: randomUUID(), executionId: id, target: 'desktop',
        fingerprint: '0'.repeat(64), note: '' }, f.approvalToken), 'execution_not_found'],
    ]
    for (const [invoke, code] of inputs) await assert.rejects(invoke(), { code })
    assert.deepEqual(f.row(id), before); assert.equal(f.continuations(id), 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_device_claim_closures').get().n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_device_execution_resolutions').get().n, 0)
  }
})

test('device and directory revocation retain every active generic writer state and account marker', async t => {
  for (const directory of [false, true]) {
    const f = fixture(t), legacyQueued = f.add(), legacyRunning = f.add('legacy_command', { state: 'running' })
    const generics = activeStates.flatMap(state => [null, 'account_disabled'].map(error_code =>
      f.add('stdio_v2', { state, error_code, origin_kind: 'operation' })))
    const discovery = f.add('stdio_v2'), terminal = f.add('stdio_v2', { state: 'succeeded' })
    const before = new Map([...generics, discovery, terminal].map(id => [id, f.row(id)]))
    await (directory ? f.service.revokeDirectory(f.user, f.directoryId) : f.service.revoke(f.user, f.deviceId))
    assert.equal(f.row(legacyQueued).state, 'cancelled'); assert.equal(f.continuations(legacyQueued), 1)
    assert.equal(f.row(legacyRunning).state, 'uncertain'); assert.equal(f.continuations(legacyRunning), 0)
    for (const id of [...generics, discovery]) {
      assert.deepEqual(f.row(id), { ...before.get(id), cancel_requested: true, updated_at: timestamp,
        error_code: before.get(id).error_code === 'account_disabled' ? 'account_disabled'
          : directory ? 'directory_revoked_stop_unconfirmed' : 'device_revoked_stop_unconfirmed' })
      assert.equal(f.continuations(id), 0)
    }
    assert.deepEqual(f.row(terminal), before.get(terminal))
  }
})

test('generic discovery/call remains globally busy, including other Session writers in the same directory', async t => {
  for (const otherSession of [false, true]) {
    for (const origin_kind of ['stdio_discovery', 'operation']) {
      const f = fixture(t), id = f.add('stdio_v2', { origin_kind, ...(otherSession ? { session_id: randomUUID() } : {}) })
      await assert.rejects(f.service.propose('fixture-grant', 'new-call', 'printf next', '.'),
        { code: otherSession ? 'desktop_directory_busy' : 'execution_busy' })
      assert.equal(f.row(id).state, 'queued'); assert.equal(f.continuations(id), 0)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM pe_desktop_executions').get().n, 1)
    }
  }
})

test('legacy insertion explicitly selects operation/legacy, freezes the unchanged digest and retains identical retries', async t => {
  const f = fixture(t), receipt = await f.service.propose('fixture-grant', 'new-call', 'printf synthetic', '.')
  const row = f.row(receipt.executionId)
  assert.equal(row.execution_kind, 'legacy_command'); assert.equal(row.origin_kind, 'operation')
  for (const field of ['task_version', 'stdio_phase', 'stdio_task', 'stdio_action_id']) assert.equal(row[field], null)
  assert.equal(row.request_digest, hash(row.dispatch_request))
  assert.deepEqual(await f.service.propose('fixture-grant', 'new-call', 'printf synthetic', '.'), receipt)
  await assert.rejects(f.service.propose('fixture-grant', 'new-call', 'printf changed', '.'), { code: 'request_id_conflict' })
  await assert.rejects(f.service.propose('fixture-grant', 'new-other-call', 'printf next', '/workspace'), { code: 'invalid_cwd' })
})

test('legacy claim/register/finish and response-loss retries preserve identity, NUL output and exactly one continuation', async t => {
  const f = fixture(t), id = f.add(), processId = randomUUID(), claim = await f.service.claim(f.token, f.instanceId, id, processId)
  assert.deepEqual(await f.service.claim(f.token, f.instanceId, id, processId), claim)
  await assert.rejects(f.service.claim(f.token, f.instanceId, id, randomUUID()), { code: 'device_process_changed' })
  const registration = f.registeredInput(claim)
  assert.equal((await f.service.register(f.token, registration)).canStart, true)
  assert.equal((await f.service.register(f.token, registration)).canStart, false)
  assert.equal((await f.service.registered(f.token, registration)).canStart, false)
  const stop = f.finishInput(registration), finished = await f.service.finish(f.token, stop)
  assert.equal(finished.state, 'succeeded'); assert.deepEqual(f.row(id).result, result)
  assert.equal(f.continuations(id), 1); assert.deepEqual(await f.service.finish(f.token, stop), finished)
  assert.equal(f.continuations(id), 1)
})

test('legacy no-start closure retains the original digest and immutable retry, while late claim stays closed', async t => {
  const f = fixture(t), id = f.add(), before = f.row(id)
  const input = { instanceId: f.instanceId, executionId: id, processId: randomUUID(), directoryId: f.directoryId,
    digest: before.request_digest, requestId: randomUUID() }
  const closed = await f.service.closeUnstartedClaim(f.token, input)
  assert.equal(closed.kind, 'unstarted_claim_closed'); assert.equal(closed.startNeverAuthorized, true)
  assert.equal(closed.dispatchId, null); assert.equal(f.row(id).request_digest, before.request_digest)
  assert.deepEqual(await f.service.closeUnstartedClaim(f.token, input), closed)
  assert.equal(f.continuations(id), 1)
  await assert.rejects(f.service.claim(f.token, f.instanceId, id, input.processId), { code: 'device_claim_closed' })
})

test('legacy independent unknown closure keeps its frozen snapshot hash, stops once and accepts unchanged finish retry', async t => {
  const f = fixture(t), id = f.add(), claim = await f.service.claim(f.token, f.instanceId, id, randomUUID())
  const registration = f.registeredInput(claim); await f.service.register(f.token, registration)
  const stop = f.finishInput(registration, { ...result, state: 'uncertain', exitCode: null })
  await f.service.finish(f.token, stop)
  const before = f.row(id), inspected = await f.service.inspectResolution(f.user, id)
  assert.equal(inspected.fingerprint, hash(captureDeviceResolutionSnapshot(before)))
  const input = { requestId: randomUUID(), executionId: id, target: 'desktop', fingerprint: inspected.fingerprint, note: 'Synthetic closure' }
  const closed = await f.service.resolveUncertain(f.user, input, f.approvalToken)
  assert.equal(closed.finalState, 'closed_unknown'); assert.equal(f.continuations(id), 1)
  assert.deepEqual(await f.service.resolveUncertain(f.user, input, f.approvalToken), closed)
  assert.deepEqual((await f.service.resolutionStatus(f.user, input.requestId)).receipt, closed)
  assert.equal((await f.service.finish(f.token, stop)).state, 'closed_unknown')
  assert.equal(f.continuations(id), 1); assert.deepEqual(f.row(id).result, before.result)
})

test('snapshot and continuation entry points reject missing/nonlegacy discrimination rather than infer a command', async t => {
  const f = fixture(t), id = f.add(), legacy = f.row(id)
  for (const execution_kind of [undefined, 'stdio_v2']) {
    const row = { ...legacy, execution_kind }
    assert.throws(() => captureDeviceResolutionSnapshot(row), { code: 'device_resolution_identity_changed' })
    await assert.rejects(f.service.continue({ query: async () => assert.fail('Nonlegacy continuation queried storage') }, row),
      { code: 'desktop_execution_unavailable' })
  }
})

test('old resolution receipt lookup cannot project a generic execution even when a request record exists', async t => {
  const f = fixture(t), id = f.add('stdio_v2', { origin_kind: 'operation' }), requestId = randomUUID()
  f.insert('pe_device_execution_resolutions', { id: randomUUID(), request_id: requestId, execution_id: id,
    user_id: f.user.userId, session_id: f.sessionId, snapshot: { fixture: 'not a legacy snapshot' } })
  assert.deepEqual(await f.service.resolutionStatus(f.user, requestId), { receipt: null })
  await assert.rejects(f.service.resolveUncertain(f.user, { requestId, executionId: id, target: 'desktop',
    fingerprint: '0'.repeat(64), note: '' }, f.approvalToken), { code: 'execution_not_found' })
  assert.equal(f.row(id).state, 'queued'); assert.equal(f.continuations(id), 0)
})

test('legacy continuation reconciliation retains one original child rather than insert or infer a replacement', async t => {
  const f = fixture(t), id = f.add(), claim = await f.service.claim(f.token, f.instanceId, id, randomUUID())
  const registration = f.registeredInput(claim); await f.service.register(f.token, registration)
  await f.service.finish(f.token, f.finishInput(registration))
  const original = f.execute('SELECT * FROM pe_operations WHERE source_desktop_execution_id=$1', [id]).rows[0]
  assert.equal(await f.service.continue({ query: async (sql, values) => f.execute(sql, values) }, f.row(id)), true)
  assert.equal(f.continuations(id), 1)
  assert.deepEqual(f.execute('SELECT * FROM pe_operations WHERE source_desktop_execution_id=$1', [id]).rows[0], original)
})

test('disabled accounts retain cancellation polling without granting directories or reviving legacy continuation', async t => {
  const f = fixture(t), legacy = f.add(), generic = f.add('stdio_v2', { error_code: 'account_disabled', cancel_requested: true })
  f.db.exec('UPDATE pe_users SET enabled=0')
  const jobs = await f.service.jobs(f.token, f.instanceId)
  assert.deepEqual(jobs.directories, []); assert.deepEqual(jobs.jobs.map(row => row.executionId), [legacy])
  await f.service.revokeDirectory(f.user, f.directoryId)
  assert.equal(f.continuations(legacy), 0); assert.equal(f.continuations(generic), 0)
  assert.equal(f.row(generic).state, 'queued'); assert.equal(f.row(generic).error_code, 'account_disabled')
})
