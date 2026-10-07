/** Cloud Prepared adapter with recording PG rows and a capture substitute; no PG, Kube, file or user program runs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { StdioCloudPreparationV2 } from '../lib/platform/stdio-v2-cloud-capture.js'
import { MountSlotBlocked } from '../lib/platform/sandbox.js'
import { stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const clone = value => structuredClone(value)
const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const refused = error => error.code === 'stdio_v2_capture_changed' && error.status === 409

function fixture(phase = 'discover') {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID(), actionId = randomUUID()
  const binding = { workspaceId, spaceId: randomUUID(), rootKey: randomUUID(), rootRelativePath: 'accepted-project', generation: 7 }
  const imageReference = `registry.example/runner@sha256:${'a'.repeat(64)}`, runtimeImageId = `containerd://${'b'.repeat(64)}`
  const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference, configImageId: `sha256:${'c'.repeat(64)}`, runtimeImageIds: [runtimeImageId, `containerd://${'d'.repeat(64)}`] }
  const image = { kind: 'cloud', platform: clone(pin.platform), imageReference, runtimeImageId }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: 7,
    target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
  const raw = [{ name: 'literal_tool', inputSchema: { type: 'object', properties: { field: { type: 'string' } } },
    _meta: { original: 'retained\0😀', '10': 'ten', '2': 'two' }, extension: { enabled: true } }]
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId, userId, sessionId, connectionId: randomUUID(),
    configRevision: 3, configDigest: 'e'.repeat(64), scopeBinding: scope, expectedDeploymentPin: pin,
    invocation: { program: 'python3', argv: ['-m', 'literal_process'], cwd: '.' }, limits, phase,
    ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId: randomUUID() } }
      : { origin: { kind: 'operation', operationId: randomUUID(), rootOperationId: randomUUID(), callKey: 'literal-call-key' },
        selection: { catalogId: randomUUID(), catalogDigest: stdioCatalogFingerprintV2(raw, limits), rawCatalog: raw,
          catalogImageExpectation: image, rawName: raw[0].name, rawDescriptor: raw[0], arguments: { '10': 'ten', '2': 'two', raw: 'value\0kept' } } }) })
  const ref = { kind: 'cloud', executionId: randomUUID() }, sandboxName = `pe-sb-${userId.replaceAll('-', '')}`
  const podUid = randomUUID(), runnerInstanceId = randomUUID()
  const execution = { id: ref.executionId, user_id: userId, session_id: sessionId, execution_kind: 'stdio_v2', execution_target: 'cloud',
    origin_kind: phase === 'discover' ? 'stdio_discovery' : 'operation', task_version: 2, stdio_phase: phase, stdio_action_id: actionId,
    stdio_task: clone(task), request_digest: sha('task', task), operation_id: phase === 'call' ? task.origin.operationId : null,
    call_id: phase === 'call' ? task.origin.callKey : null, command: null, cwd: null,
    continuation_request_id: phase === 'call' ? randomUUID() : null, state: 'queued', cancel_requested: false,
    sandbox_name: sandboxName, pod_uid: podUid, runner_instance_id: runnerInstanceId, internal_observation: 'synthetic-private-not-returned' }
  const session = { id: sessionId, user_id: userId, workspace_id: workspaceId }
  const slot = { user_id: userId, session_id: sessionId, workspace_id: workspaceId, generation: '13', state: 'ready',
    pod_uid: podUid, runner_instance_id: runnerInstanceId, binding_snapshot: clone(binding), stop_evidence: null }
  const instance = { session_id: sessionId, user_id: userId, name: sandboxName, state: 'ready', pod_uid: podUid,
    runner_instance_id: runnerInstanceId, binding_snapshot: clone(binding), internal_observation: 'synthetic-private-not-returned' }
  const observed = { actualExecutorImage: image,
    capture: { kind: 'cloud', podUid, podName: sandboxName, namespace: 'synthetic', nodeName: 'synthetic-node', runnerInstanceId,
      containerId: `containerd://${'f'.repeat(64)}`, restartCount: 2, mountGeneration: '13',
      workspaceMount: { claimName: 'owned-pvc', subPath: `workspaces/${binding.rootKey}/accepted-project`, mountPath: '/workspace', readOnly: false },
      homeMount: { claimName: 'owned-pvc', subPath: `homes/${userId}`, mountPath: '/home/agent', readOnly: false } },
    spec: { containers: [{ name: 'runner', image: imageReference }], raw: { '10': 'ten', '2': 'two', extension: 'unprojected\0spec' } } }
  const privateReady = { name: sandboxName, podUid, runnerInstanceId, generation: '13', sessionId, userId, binding: clone(binding),
    token: 'synthetic-manager-generated-private-token', restartCount: 0 }
  const rows = { execution, session, slot, instance }, queries = [], captures = [], observations = []
  const client = { async query(sql, args) {
    queries.push({ sql, args: clone(args) }); assert(sql.startsWith('SELECT'), 'Adapter must not mutate accepted records or release writer')
    let row
    if (sql.includes('FROM pe_cloud_executions')) { assert.deepEqual(args, [ref.executionId, userId, sessionId]); row = rows.execution }
    else if (sql.includes('FROM pe_sessions')) { assert.deepEqual(args, [sessionId, userId]); row = rows.session }
    else if (sql.includes('FROM pe_mount_slots')) { assert.deepEqual(args, [userId]); row = rows.slot }
    else if (sql.includes('FROM pe_sandbox_instances')) { assert.deepEqual(args, [sessionId, userId]); row = rows.instance }
    else throw new Error(`Unexpected synthetic SQL: ${sql}`)
    return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 }
  }, connect() { throw new Error('No second client is available') }, release() { throw new Error('Caller owns transaction and release') } }
  const sandboxes = { async observeReady(originalSession, originalOwner, originalPod, originalRunner, suppliedClient) {
    assert.deepEqual([originalSession, originalOwner, originalPod, originalRunner], [sessionId, userId, podUid, runnerInstanceId])
    assert.equal(suppliedClient, client); observations.push({ sessionId, userId, podUid, runnerInstanceId })
    if (sandboxes.failObservation) throw sandboxes.failObservation
    return clone(privateReady)
  }, async captureStdioV2(writer, selectedScope, selectedPin, selectedLimits, suppliedClient) {
    assert.equal(suppliedClient, client); assert.deepEqual(selectedScope, task.scopeBinding); assert.deepEqual(selectedPin, task.expectedDeploymentPin)
    assert.deepEqual(selectedLimits, task.limits); assert.equal(writer.token, privateReady.token)
    assert.deepEqual(writer, privateReady)
    captures.push(clone(writer)); if (sandboxes.fail) throw sandboxes.fail
    return clone(observed)
  }, ensureReady() { throw new Error('No provisioning') } }
  const adapter = new StdioCloudPreparationV2(sandboxes)
  return { adapter, capture: () => adapter.capture(client, task, ref), rows, queries, captures, observations, sandboxes, task, ref, observed, client, privateReady }
}

test('discovery Prepared uses original transaction/IDs and whole-domain task/spec/full-scope digests without private token or writes', async () => {
  const f = fixture(), before = clone(f.rows), result = await f.capture()
  assert.deepEqual(f.rows, before); assert.equal(f.queries.length, 4); assert.equal(f.observations.length, 1); assert.equal(f.captures.length, 1)
  assert.deepEqual(stdioPreparedV2.parse(result), result)
  assert.equal(result.taskDigest, sha('task', f.task)); assert.equal(result.specDigest, sha('spec', f.observed.spec))
  assert.equal(result.fullScopeDigest, sha('scope', { scopeBinding: f.task.scopeBinding,
    workspaceMount: f.observed.capture.workspaceMount, homeMount: f.observed.capture.homeMount }))
  assert.deepEqual(result.executionRef, f.ref); assert.equal(result.actionId, f.task.actionId)
  assert.equal(result.capture.restartCount, 2); assert.equal(result.capture.podUid, f.rows.execution.pod_uid)
  assert(!JSON.stringify(result).includes('synthetic-private-not-returned')); assert(!('spec' in result)); assert(!('token' in result))
  assert(!JSON.stringify(result).includes(f.privateReady.token))
  result.capture.workspaceMount.subPath = 'caller-changed-copy'; assert.equal(f.observed.capture.workspaceMount.subPath.includes('accepted-project'), true)
  f.observed.spec.raw.extension = 'another complete raw spec field'
  const changed = await f.capture()
  assert.notEqual(changed.specDigest, result.specDigest); assert.equal(changed.taskDigest, result.taskDigest)
})

test('call Prepared retains complete raw task and catalog image; other approved runtime image is rejected for this original selection', async () => {
  const f = fixture('call'), result = await f.capture()
  assert.equal(result.taskDigest, sha('task', f.task)); assert.equal(f.task.selection.arguments.raw, 'value\0kept')
  assert.deepEqual(result.actualExecutorImage, f.task.selection.catalogImageExpectation)
  f.observed.actualExecutorImage.runtimeImageId = f.task.expectedDeploymentPin.runtimeImageIds[1]
  await assert.rejects(f.capture(), refused)
  assert(f.queries.every(call => call.sql.startsWith('SELECT'))); assert.equal(f.rows.execution.state, 'queued')
})

test('missing/forged original execution facts and altered complete raw tasks refuse before invoking capture', async t => {
  for (const [name, alter] of [
    ['execution absent', f => { f.rows.execution = null }],
    ['legacy command', f => { f.rows.execution.execution_kind = 'legacy_command' }],
    ['foreign ID', f => { f.rows.execution.id = randomUUID() }],
    ['foreign owner', f => { f.rows.execution.user_id = randomUUID() }],
    ['foreign Session', f => { f.rows.execution.session_id = randomUUID() }],
    ['wrong action', f => { f.rows.execution.stdio_action_id = randomUUID() }],
    ['wrong phase', f => { f.rows.execution.stdio_phase = 'call' }],
    ['different target', f => { f.rows.execution.execution_target = 'desktop' }],
    ['wrong origin', f => { f.rows.execution.origin_kind = 'operation' }],
    ['wrong protocol version', f => { f.rows.execution.task_version = 1 }],
    ['cancel requested', f => { f.rows.execution.cancel_requested = true }],
    ['already running', f => { f.rows.execution.state = 'running' }],
    ['missing captured name', f => { f.rows.execution.sandbox_name = null }],
    ['empty captured name', f => { f.rows.execution.sandbox_name = '' }],
    ['missing Pod', f => { f.rows.execution.pod_uid = null }],
    ['missing runner', f => { f.rows.execution.runner_instance_id = null }],
    ['foreign operation on discovery', f => { f.rows.execution.operation_id = randomUUID() }],
    ['legacy command payload', f => { f.rows.execution.command = 'printf impossible' }],
    ['legacy cwd payload', f => { f.rows.execution.cwd = '.' }],
    ['discovery continuation', f => { f.rows.execution.continuation_request_id = randomUUID() }],
    ['wrong task digest', f => { f.rows.execution.request_digest = '1'.repeat(64) }],
    ['changed original invocation', f => { f.rows.execution.stdio_task.invocation.argv.push('changed') }],
    ['unexpected task field', f => { f.rows.execution.stdio_task.extra = 'cannot be dropped' }],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f); const before = clone(f.rows)
    await assert.rejects(f.capture(), refused); assert.equal(f.observations.length, 0); assert.equal(f.captures.length, 0); assert.deepEqual(f.rows, before)
  })
  const f = fixture('call'); f.rows.execution.stdio_task.selection.arguments.raw = 'raw changed'
  await assert.rejects(f.capture(), refused); assert.equal(f.captures.length, 0)
})

test('Session/ready mount and instance observations must identify the same original owner/Pod/runner/binding', async t => {
  for (const [name, alter] of [
    ['Session absent', f => { f.rows.session = null }],
    ['Session owner', f => { f.rows.session.user_id = randomUUID() }],
    ['Session Workspace', f => { f.rows.session.workspace_id = randomUUID() }],
    ['slot absent', f => { f.rows.slot = null }],
    ['slot not ready', f => { f.rows.slot.state = 'unknown' }],
    ['slot Session', f => { f.rows.slot.session_id = randomUUID() }],
    ['slot owner', f => { f.rows.slot.user_id = randomUUID() }],
    ['slot Workspace', f => { f.rows.slot.workspace_id = randomUUID() }],
    ['slot Pod', f => { f.rows.slot.pod_uid = randomUUID() }],
    ['slot runner', f => { f.rows.slot.runner_instance_id = randomUUID() }],
    ['invalid mount generation', f => { f.rows.slot.generation = '013' }],
    ['missing slot binding', f => { f.rows.slot.binding_snapshot = null }],
    ['binding generation', f => { f.rows.slot.binding_snapshot.generation++ }],
    ['binding target', f => { f.rows.slot.binding_snapshot.rootRelativePath = 'different-project' }],
    ['instance absent', f => { f.rows.instance = null }],
    ['instance not ready', f => { f.rows.instance.state = 'creating' }],
    ['instance owner', f => { f.rows.instance.user_id = randomUUID() }],
    ['instance Session', f => { f.rows.instance.session_id = randomUUID() }],
    ['instance name', f => { f.rows.instance.name = 'other' }],
    ['instance Pod', f => { f.rows.instance.pod_uid = randomUUID() }],
    ['instance runner', f => { f.rows.instance.runner_instance_id = randomUUID() }],
    ['instance snapshot', f => { f.rows.instance.binding_snapshot.rootKey = randomUUID() }],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f); const before = clone(f.rows)
    await assert.rejects(f.capture(), refused); assert.equal(f.observations.length, 0); assert.equal(f.captures.length, 0); assert.deepEqual(f.rows, before)
  })
})

test('the Manager-owned private Ready must still match all original identity/generation/binding facts before capture', async t => {
  for (const [name, alter] of [
    ['private name', f => { f.privateReady.name = 'other' }],
    ['private Pod', f => { f.privateReady.podUid = randomUUID() }],
    ['private runner', f => { f.privateReady.runnerInstanceId = randomUUID() }],
    ['private generation', f => { f.privateReady.generation = '14' }],
    ['private owner', f => { f.privateReady.userId = randomUUID() }],
    ['private Session', f => { f.privateReady.sessionId = randomUUID() }],
    ['private binding', f => { f.privateReady.binding.rootKey = randomUUID() }],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f); const before = clone(f.rows)
    await assert.rejects(f.capture(), refused); assert.equal(f.observations.length, 1); assert.equal(f.captures.length, 0)
    assert.deepEqual(f.rows, before)
  })
  const f = fixture(), failure = new MountSlotBlocked('mount_instance_changed', false)
  f.sandboxes.failObservation = failure
  await assert.rejects(f.capture(), error => error === failure); assert.equal(f.captures.length, 0)
  assert.equal(f.rows.slot.state, 'ready'); assert.equal(f.rows.execution.state, 'queued')
})

test('captured identity, DTO private fields, pin and whole-spec budgets are checked without fabricating results or quarantine', async t => {
  for (const [name, alter] of [
    ['captured Pod', f => { f.observed.capture.podUid = randomUUID() }],
    ['captured Pod name', f => { f.observed.capture.podName = 'different' }],
    ['captured runner', f => { f.observed.capture.runnerInstanceId = randomUUID() }],
    ['captured generation', f => { f.observed.capture.mountGeneration = '14' }],
    ['unexpected capture secret', f => { f.observed.capture.token = 'synthetic-not-a-real-token' }],
    ['other image', f => { f.observed.actualExecutorImage.runtimeImageId = 'unapproved-runtime-image' }],
    ['oversized original spec', f => { f.observed.spec.raw.extension = 'x'.repeat(limits.maxInputBytes) }],
    ['oversized complete Prepared', f => { f.observed.capture.containerId = 'x'.repeat(limits.maxInputBytes) }],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f); const before = clone(f.rows)
    await assert.rejects(f.capture()); assert.equal(f.captures.length, 1); assert.deepEqual(f.rows, before)
  })
  const f = fixture(), failure = new MountSlotBlocked('mount_instance_changed', false)
  f.sandboxes.fail = failure
  await assert.rejects(f.capture(), error => error === failure); assert.equal(f.rows.slot.state, 'ready')
  assert.equal(f.rows.execution.state, 'queued'); assert(f.queries.every(call => call.sql.startsWith('SELECT')))
})

test('original starting state is allowed; unsupported execution target and over-budget full task refuse without reading PG', async () => {
  const starting = fixture(); starting.rows.execution.state = 'starting'; await starting.capture()
  const wrongRef = fixture(); wrongRef.ref.kind = 'desktop'
  await assert.rejects(wrongRef.capture(), refused); assert.equal(wrongRef.queries.length, 0)
  const oversized = fixture('call'); oversized.task.selection.arguments.extra = 'x'.repeat(limits.maxInputBytes)
  await assert.rejects(oversized.capture()); assert.equal(oversized.queries.length, 0)
})
