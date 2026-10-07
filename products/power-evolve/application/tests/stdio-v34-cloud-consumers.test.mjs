/** V34 consumer routing with bounded SQL rows and admission/stop substitutes; no PG or executor. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ExecutionService } from '../lib/platform/executions.js'
import { CloudExecutionResolutionService } from '../lib/platform/cloud-execution-resolution.js'
import { capturedRunnerRequest, cloudRequestDigest } from '../lib/platform/cloud-execution-resolution-types.js'
import { ExecutionFileFactsService } from '../lib/platform/execution-file-facts.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { SandboxManager } from '../lib/platform/sandbox.js'

const clone = value => structuredClone(value)
const result = rows => ({ rows: clone(rows), rowCount: rows.length })
const active = ['queued', 'starting', 'running', 'cancelling', 'uncertain']
const legacyRows = (sql, rows) => /(?:\b|\.)execution_kind='legacy_command'/u.test(sql)
  ? rows.filter(row => row.execution_kind === 'legacy_command') : rows

function sqlPool(handler, userId) {
  const calls = []
  const query = async (sql, args = []) => {
    calls.push({ sql, args: clone(args) })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory_xact_lock')
      || sql.startsWith('SELECT pg_notify')) return result([])
    if (sql.includes('FROM pe_users WHERE id=ANY')) return result(args[0].map(id => ({ userId: id,
      username: 'synthetic', displayName: 'Synthetic', role: 'USER', enabled: true, revision: 1,
      credentialVersion: 1, passwordChangeRequired: false, deletedAt: null })))
    return handler(sql, args)
  }
  return { calls, query, connect: async () => ({ query, on() {}, removeListener() {}, release() {} }), userId }
}

function cloudFixture() {
  const userId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID(), workspaceId = randomUUID()
  const user = { userId, username: 'synthetic' }, rows = [], continuations = new Map(), resolutions = []
  const makeRow = (kind = 'legacy_command', state = 'queued') => {
    const id = randomUUID(), instanceId = randomUUID()
    return { execution_kind: kind, id, user_id: userId, session_id: sessionId, operation_id: operationId,
      call_id: `call-${id}`, command: 'printf synthetic', cwd: '',
      request_digest: cloudRequestDigest({ command: 'printf synthetic', cwd: '', timeoutMs: 2000 }), state,
      cancel_requested: false, result: null, error_code: null, sandbox_name: 'synthetic-writer',
      pod_uid: randomUUID(), runner_instance_id: instanceId, dispatch_request: null, lease_owner: null, lease_until: null,
      continuation_request_id: randomUUID(), created_at: new Date(), attempts: 0 }
  }
  const generic = phase => ({ ...makeRow('stdio_v2'), origin_kind: phase === 'discover' ? 'stdio_discovery' : 'operation',
    stdio_phase: phase, task_version: 2, stdio_action_id: randomUUID(), stdio_task: { raw: 'kept\0opaque' },
    command: null, cwd: null, ...(phase === 'discover' ? { operation_id: null, call_id: null, continuation_request_id: null } : {}) })
  let genericDesktop = false
  const pool = sqlPool((sql, args) => {
    const eligible = legacyRows(sql, rows)
    if (sql.startsWith('SELECT count(*)::integer AS count')) {
      const states = /state IN \(([^)]+)\)/u.exec(sql)[1].match(/[a-z]+/gu)
      return result([{ count: eligible.filter(row => row.lease_owner && row.lease_until > new Date()
        && states.includes(row.state)).length }])
    }
    if (sql.includes('UNION ALL SELECT id FROM pe_desktop_executions')) {
      return result(rows.filter(row => row.session_id === args[0] && active.includes(row.state))
        .concat(genericDesktop ? [{ id: randomUUID() }] : []))
    }
    if (sql.startsWith('SELECT state FROM pe_sandbox_instances')) return result([])
    if (sql.startsWith('INSERT INTO pe_cloud_executions')) {
      assert.match(sql, /request_digest,execution_kind,state/u)
      assert.match(sql, /,'legacy_command','queued'/u)
      const row = { ...makeRow(), id: args[0], user_id: args[1], session_id: args[2], operation_id: args[3],
        call_id: args[4], command: args[5], cwd: args[6], request_digest: args[7] }
      rows.push(row); return result([row])
    }
    if (sql.startsWith('SELECT * FROM pe_cloud_executions')) {
      if (sql.includes('operation_id=$1')) return result(eligible.filter(row => row.operation_id === args[0] && row.call_id === args[1]))
      if (sql.includes('id=$1 AND user_id=$2')) return result(eligible.filter(row => row.id === args[0] && row.user_id === args[1]))
      if (sql.includes('ORDER BY created_at DESC')) return result(eligible.filter(row => row.user_id === args[0]))
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return result(eligible.filter(row => active.includes(row.state) && !row.lease_owner).slice(0, 1))
    }
    if (sql.startsWith('UPDATE pe_cloud_executions SET state=CASE')) {
      const row = eligible.find(row => row.id === args[0]); if (!row) return result([])
      if (row.state === 'queued') row.state = 'starting'
      row.lease_owner = args[1]; row.lease_until = new Date(Date.now() + args[2]); row.attempts++; return result([row])
    }
    if (sql.startsWith('UPDATE pe_cloud_executions SET cancel_requested')) {
      const row = eligible.find(row => row.id === args[0]); if (!row) return result([])
      row.cancel_requested = true; return result([row])
    }
    if (sql.startsWith('SELECT id FROM pe_cloud_executions')) {
      if (sql.includes('continuation_request_id=$7')) return result(eligible.filter(row =>
        [row.id, row.user_id, row.session_id, row.operation_id, row.call_id, row.request_digest, row.continuation_request_id]
          .every((value, i) => value === args[i])))
      return result(eligible.filter(row => row.id === args[0] && row.lease_owner === args[1]))
    }
    if (sql.startsWith('SELECT s.workspace_id')) return result([{ workspace_id: workspaceId }])
    if (sql.startsWith('SELECT execution_kind,id,call_id,state,result')) {
      return result(eligible.filter(row => row.user_id === args[0] && row.session_id === args[1] && args[2].includes(row.id)))
    }
    if (sql.startsWith('SELECT * FROM pe_cloud_execution_resolutions')) return result([])
    if (sql.startsWith('SELECT r.* FROM pe_cloud_execution_resolutions')) {
      return result(resolutions.filter(resolution => eligible.some(row => row.id === resolution.execution_id)).slice(0, 1))
    }
    if (sql.startsWith('SELECT r.id FROM pe_cloud_execution_resolutions')) {
      return result(resolutions.filter(resolution => resolution.id === args[0]
        && eligible.some(row => row.id === resolution.execution_id)))
    }
    if (sql.startsWith('INSERT INTO pe_operations')) {
      if (continuations.has(args[1])) return result([])
      continuations.set(args[1], { input: args[2], executionId: args[3], operationId: args[4] }); return result([{ id: args[0] }])
    }
    throw new Error(`Unexpected synthetic SQL: ${sql}`)
  }, userId)
  const programs = [], sandboxes = new Proxy({}, { get(_target, property) {
    return async () => { programs.push(property); throw new Error('No synthetic test may create or call an executor') }
  } })
  const service = new ExecutionService({ pool, authorized: async () => ({ id: sessionId, user_id: userId,
    operation_id: operationId, execution_target: { kind: 'cloud' } }) }, sandboxes,
  { service: { verify: async () => { throw new Error('No synthetic filesystem verification') } }, timeoutMs: 1000 },
  1, 10, 1000, 2000, 5000)
  const resolution = new CloudExecutionResolutionService(pool, sandboxes,
    (client, row) => service.enqueueContinuation(client, row), 2000, 5000, 10)
  return { user, userId, sessionId, operationId, workspaceId, rows, continuations, resolutions, programs,
    pool, service, resolution, makeRow, generic, setDesktopBusy: () => { genericDesktop = true } }
}

test('legacy request/receipt digests survive retries; new INSERT explicitly chooses legacy and generic writers stay busy', async t => {
  const f = cloudFixture(), legacy = f.makeRow()
  f.rows.push(legacy)
  const receipt = await f.service.propose('synthetic-grant', legacy.call_id, legacy.command, legacy.cwd)
  assert.deepEqual(await f.service.propose('synthetic-grant', legacy.call_id, legacy.command, legacy.cwd), receipt)
  await assert.rejects(f.service.propose('synthetic-grant', legacy.call_id, 'different', legacy.cwd), { code: 'request_id_conflict' })
  assert.equal(f.pool.calls.filter(call => call.sql.startsWith('INSERT INTO pe_cloud_executions')).length, 0)
  f.rows.length = 0
  const added = await f.service.propose('synthetic-grant', 'new-call', 'printf synthetic', '')
  assert.equal(f.rows[0].execution_kind, 'legacy_command'); assert.equal(added.executionId, f.rows[0].id)
  assert.equal(f.rows[0].request_digest, legacy.request_digest)
  for (const phase of ['discover', 'call']) await t.test(phase, async () => {
    f.rows.splice(0, f.rows.length, f.generic(phase))
    await assert.rejects(f.service.propose('synthetic-grant', 'new-call', 'printf synthetic', ''), { code: 'execution_busy' })
  })
  f.rows.length = 0; f.setDesktopBusy()
  await assert.rejects(f.service.propose('synthetic-grant', 'new-call', 'printf synthetic', ''), { code: 'execution_busy' })
  assert.deepEqual(f.programs, [])
})

test('old lists/cancel/resolution/file facts exclude both generic origins while preserving legacy receipts', async () => {
  const f = cloudFixture(), legacy = f.makeRow('legacy_command', 'succeeded'), generic = f.generic('call'), discovery = f.generic('discover')
  legacy.result = { stdout: 'legacy\0output' }
  generic.state = 'succeeded'; generic.result = { verifiedFiles: { status: 'complete', files: [], reasons: [] } }
  f.rows.push(discovery, generic, legacy)
  assert.deepEqual((await f.service.list(f.user)).items.map(row => row.executionId), [legacy.id])
  assert.deepEqual((await f.resolution.list(f.user, {})).items.map(row => row.executionId), [legacy.id])
  const facts = new ExecutionFileFactsService(f.pool, {})
  assert.equal((await facts.read(f.user, { sessionId: f.sessionId, executionIds: [legacy.id] })).items[0].callId, legacy.call_id)
  for (const row of [generic, discovery]) {
    const before = clone(row)
    await assert.rejects(f.service.cancel(f.user, row.id), { code: 'execution_not_found' })
    await assert.rejects(f.resolution.inspect(f.user, row.id), { code: 'execution_not_found' })
    await assert.rejects(facts.read(f.user, { sessionId: f.sessionId, executionIds: [legacy.id, row.id] }), { code: 'execution_not_found' })
    assert.deepEqual(row, before)
  }
  legacy.state = 'queued'
  const cancelled = await f.service.cancel(f.user, legacy.id)
  assert.equal(cancelled.state, 'queued'); assert.equal(legacy.cancel_requested, true)
  assert.deepEqual(f.programs, [])
})

test('claim skips generic queued rows but counts a generic live lease; cold protocol and resolution refuse generic', async () => {
  const f = cloudFixture(), legacy = f.makeRow(), generic = f.generic('call')
  f.rows.push(f.generic('discover'), generic, legacy)
  assert.equal((await f.service.claim()).id, legacy.id)
  legacy.lease_owner = null; legacy.state = 'queued'; generic.lease_owner = randomUUID(); generic.state = 'queued'
  generic.lease_until = new Date(Date.now() + 60000)
  assert.equal(await f.service.claim(), null)
  generic.state = 'running'; assert.equal(await f.service.claim(), null)
  generic.lease_until = new Date(0); assert.equal((await f.service.claim()).id, legacy.id)
  const claims = f.pool.calls.filter(call => call.sql.includes('count(*)::integer AS count'))
  assert(claims.every(call => !call.sql.includes('execution_kind=')))
  const leasedGeneric = { ...generic, lease_owner: f.service.workerId }
  f.rows.splice(0, f.rows.length, leasedGeneric)
  await f.service.processLeased(clone(leasedGeneric))
  const resolution = { id: randomUUID(), execution_id: leasedGeneric.id }
  f.resolutions.push(resolution)
  assert.equal(await f.resolution.poll(new AbortController().signal), false)
  await assert.rejects(f.resolution.lease(f.pool, resolution, new AbortController().signal),
    error => error instanceof Error && error.constructor.name === 'ResolutionLeaseLost')
  assert.deepEqual(f.programs, [])
})

test('captured command fallback requires explicit legacy kind and preserves old exact JSON and timeout checks', () => {
  const f = cloudFixture(), row = f.makeRow()
  const request = { id: row.id, command: row.command, cwd: row.cwd, timeoutMs: 2000, instanceId: row.runner_instance_id }
  assert.deepEqual(capturedRunnerRequest(row, 2000), request)
  assert.equal(capturedRunnerRequest(row, 3000), null)
  row.dispatch_request = request
  assert.deepEqual(capturedRunnerRequest(row, 3000), request)
  const before = JSON.stringify(row)
  for (const execution_kind of ['stdio_v2', undefined]) {
    assert.equal(capturedRunnerRequest({ ...row, execution_kind }, 2000), null)
  }
  assert.equal(JSON.stringify(row), before)
})

test('continuation verifies durable legacy identity, remains once-only and retains closed-unknown wording', async () => {
  const f = cloudFixture(), legacy = f.makeRow('legacy_command', 'closed_unknown'), generic = f.generic('call')
  f.rows.push(legacy, generic)
  assert.equal(await f.service.enqueueContinuation(f.pool, generic), false)
  assert.equal(await f.service.enqueueContinuation(f.pool, { ...generic, execution_kind: 'legacy_command' }), false)
  for (const change of [{ request_digest: 'b'.repeat(64) }, { operation_id: randomUUID() },
    { continuation_request_id: randomUUID() }, { user_id: randomUUID() }, { call_id: 'different' }]) {
    assert.equal(await f.service.enqueueContinuation(f.pool, { ...legacy, ...change }), false)
  }
  assert.equal(f.continuations.size, 0)
  assert.equal(await f.service.enqueueContinuation(f.pool, legacy), true)
  assert.equal(await f.service.enqueueContinuation(f.pool, legacy), true)
  assert.equal(f.continuations.size, 1)
  const stored = f.continuations.get(legacy.continuation_request_id)
  const expected = await readFile(new URL('./expected/cloud-execution-closed-unknown.txt', import.meta.url), 'utf8')
  assert.equal(stored.input.replace(legacy.id, '<execution-id>'), expected.trimEnd())
  assert.equal(stored.operationId, legacy.operation_id)
  const firstAccountLock = f.pool.calls.findIndex(call => call.sql.includes('FROM pe_users WHERE id=ANY'))
  const firstExecutionLock = f.pool.calls.findIndex(call => call.sql.includes('continuation_request_id=$7'))
  assert(firstAccountLock < firstExecutionLock)
})

test('account disablement cancels generic authority without terminalizing its writer or changing preparation identity', async () => {
  const userId = randomUUID(), otherId = randomUUID(), rows = [], mount = { state: 'ready' }
  for (const table of ['pe_cloud_executions', 'pe_desktop_executions']) {
    const states = table === 'pe_cloud_executions' ? active : active.filter(state => state !== 'starting')
    for (const kind of ['legacy_command', 'stdio_v2']) for (const state of states) rows.push({ table,
      execution_kind: kind, id: randomUUID(), user_id: userId, state, cancel_requested: false, error_code: null,
      lease_owner: randomUUID(), pod_uid: randomUUID(), dispatch_request: { raw: 'immutable\0' }, stdio_task: { raw: 'kept\0' } })
  }
  rows.push({ ...clone(rows[0]), id: randomUUID(), user_id: otherId })
  const original = clone(rows)
  const client = sqlPool((sql, args) => {
    if (sql.startsWith('UPDATE pe_cloud_executions') || sql.startsWith('UPDATE pe_desktop_executions')) {
      const table = sql.startsWith('UPDATE pe_cloud_executions') ? 'pe_cloud_executions' : 'pe_desktop_executions'
      const changed = rows.filter(row => row.table === table && row.user_id === args[0] && active.includes(row.state)
        && (!row.cancel_requested || row.error_code !== 'account_disabled'))
      const queuedOnlyLegacy = sql.includes("execution_kind='legacy_command' AND state='queued'")
      const runningOnlyLegacy = sql.includes("execution_kind='legacy_command' AND state='running'")
      for (const row of changed) {
        if (row.state === 'queued' && (!queuedOnlyLegacy || row.execution_kind === 'legacy_command')) row.state = 'cancelled'
        else if (table === 'pe_desktop_executions' && row.state === 'running'
          && (!runningOnlyLegacy || row.execution_kind === 'legacy_command')) row.state = 'cancelling'
        row.cancel_requested = true; row.error_code = 'account_disabled'
      }
      return result(changed)
    }
    if (sql.startsWith('UPDATE pe_mount_slots')) {
      const states = /e.state IN \(([^)]+)\)/u.exec(sql)[1].match(/[a-z]+/gu)
      if (!rows.some(row => row.table === 'pe_cloud_executions' && row.user_id === args[0] && states.includes(row.state))) {
        mount.state = 'stopping'
      }
      return result([])
    }
    return result([]) // Other account work is absent in this bounded execution-only fixture.
  }, userId)
  const changed = await revokeAccountExecutions(client, userId)
  assert.equal(changed.executions, original.length - 1)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], before = original[i]
    if (row.user_id !== userId) { assert.deepEqual(row, before); continue }
    assert.equal(row.cancel_requested, true); assert.equal(row.error_code, 'account_disabled')
    if (row.execution_kind === 'stdio_v2') assert.equal(row.state, before.state)
    else assert.equal(row.state, before.state === 'queued' ? 'cancelled'
      : row.table === 'pe_desktop_executions' && before.state === 'running' ? 'cancelling' : before.state)
    for (const key of ['lease_owner', 'pod_uid', 'dispatch_request', 'stdio_task']) assert.deepEqual(row[key], before[key])
  }
  assert.equal(mount.state, 'ready', 'queued generic writer remains visible to mount cleanup')
  assert.equal((await revokeAccountExecutions(client, userId)).executions, 0)
  const soleQueued = original.find(row => row.table === 'pe_cloud_executions'
    && row.execution_kind === 'stdio_v2' && row.state === 'queued')
  rows.splice(0, rows.length, clone(soleQueued)); mount.state = 'ready'
  assert.equal((await revokeAccountExecutions(client, userId)).executions, 1)
  assert.equal(rows[0].state, 'queued'); assert.equal(mount.state, 'ready')
  rows[0].execution_kind = 'legacy_command'; rows[0].cancel_requested = false; rows[0].error_code = null
  assert.equal((await revokeAccountExecutions(client, userId)).executions, 1)
  assert.equal(rows[0].state, 'cancelled'); assert.equal(mount.state, 'stopping')
})

test('disabled uncertain legacy may recycle after its old fence; generic writer keeps the same mount busy', async () => {
  for (const kind of ['legacy_command', 'stdio_v2']) {
    const userId = randomUUID(), sessionId = randomUUID(), stops = []
    const slot = { user_id: userId, session_id: sessionId, workspace_id: randomUUID(), generation: '1',
      state: 'ready', pod_uid: randomUUID(), runner_instance_id: randomUUID() }
    const pool = sqlPool((sql) => {
      if (sql.startsWith('SELECT m.user_id')) return result([{ user_id: userId }])
      if (sql.startsWith('SELECT workspace_id FROM pe_mount_slots')) return result([{ workspace_id: slot.workspace_id }])
      if (sql.startsWith('SELECT request_id FROM pe_cloud_execution_resolutions')) return result([])
      if (sql.startsWith('SELECT * FROM pe_mount_slots')) return result([slot])
      if (sql.startsWith('SELECT id FROM pe_cloud_executions')) {
        const ignoreOnlyLegacy = sql.includes("execution_kind='legacy_command' AND state='uncertain'")
        return result(ignoreOnlyLegacy && kind === 'stdio_v2' ? [{ id: randomUUID() }] : [])
      }
      if (sql.startsWith('UPDATE pe_sandbox_instances')) return result([{ session_id: sessionId }])
      if (sql.startsWith('UPDATE pe_mount_slots')) { slot.state = 'stopping'; return result([]) }
      throw new Error(`Unexpected cleanup SQL: ${sql}`)
    }, userId)
    const manager = new SandboxManager({}, {}, pool, 'synthetic-key', { namespace: 'synthetic',
      image: 'registry/fixture@sha256:' + 'a'.repeat(64), localRoot: '/unused', nodeRoot: '',
      volumeClaimName: 'owned-pvc', readyTimeoutMs: 100,
      fileScan: { maxEntries: 4096, maxHashBytes: 33554432, timeoutMs: 5000, maxSnapshotBytes: 1048576, maxFiles: 100 } })
    // This fixture supplies already-held authority/workspace locks and records cleanup intent, not kubelet proof.
    manager.lockUser = async () => {}; manager.lockWorkspace = async () => {}
    manager.recoveryOwnsCleanup = async () => false
    manager.stopAndRelease = async selected => { stops.push(selected) }
    await manager.recycleIdle(1000)
    assert.equal(stops.length, kind === 'legacy_command' ? 1 : 0)
    assert.equal(slot.state, kind === 'legacy_command' ? 'stopping' : 'ready')
  }
})
