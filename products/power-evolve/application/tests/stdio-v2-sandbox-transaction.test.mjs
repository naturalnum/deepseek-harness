/** Caller-transaction capture with bounded SQL/Kubernetes substitutes; no PostgreSQL, cluster or program runs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SandboxManager, MountSlotBlocked } from '../lib/platform/sandbox.js'

const clone = value => structuredClone(value)
const repeated = digit => digit.repeat(64)
const options = { timeout: 5000 }

function fixture(legacy = false) {
  const userId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID(), instanceId = randomUUID(), podUid = randomUUID()
  const binding = { workspaceId, spaceId: randomUUID(), rootKey: randomUUID(), rootRelativePath: 'project/data', generation: 7 }
  const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
    maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
    maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
    maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
  const imageReference = `registry.example/runner@sha256:${repeated('a')}`, imageId = `docker-pullable://${imageReference}`
  const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference, configImageId: `sha256:${repeated('b')}`, runtimeImageIds: [imageId] }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: 7,
    target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
  const account = { userId, username: 'synthetic', displayName: 'Synthetic', role: 'USER', enabled: true, revision: 1,
    credentialVersion: 1, passwordChangeRequired: false, deletedAt: null }
  const workspace = { binding_generation: '7', binding_state: 'ready', recovery_request_id: null }
  const slot = { user_id: userId, session_id: sessionId, workspace_id: workspaceId, generation: '11', state: 'ready',
    pod_uid: podUid, runner_instance_id: instanceId, stop_pod_uid: null, stop_evidence: null, binding_snapshot: clone(binding) }
  const instance = { state: 'ready', pod_uid: podUid, runner_instance_id: instanceId, binding_snapshot: clone(binding) }
  const stored = { workspace_id: workspaceId, space_id: binding.spaceId, root_key: binding.rootKey,
    root_relative_path: binding.rootRelativePath, binding_generation: '7' }
  const flags = { recovery: false, cleanup: false }, sql = [], poolCalls = [], kubeCalls = [], resources = new Map(), bindingClients = []
  const result = rows => ({ rows: clone(rows), rowCount: rows.length })
  const query = async (source, text, args = []) => {
    sql.push({ source, text, args: clone(args) })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) { assert(legacy, 'Caller capture must not start/end a nested transaction'); return result([]) }
    if (text.includes('FROM pe_users WHERE id=ANY')) {
      assert.deepEqual(args, [[userId]]); assert.match(text, /FOR NO KEY UPDATE/u); return result([account])
    }
    if (text.startsWith('SELECT binding_generation,binding_state')) {
      assert.deepEqual(args, [workspaceId, userId]); assert.match(text, /FOR UPDATE/u); return result([workspace])
    }
    if (text.startsWith('SELECT id FROM pe_workspaces')) {
      assert.deepEqual(args, [userId]); return result(flags.recovery ? [{ id: workspaceId }] : [])
    }
    if (text.startsWith('SELECT request_id FROM pe_cloud_execution_resolutions')) {
      assert.deepEqual(args, [userId, null]); return result(flags.cleanup ? [{ request_id: randomUUID() }] : [])
    }
    if (text.startsWith('SELECT * FROM pe_mount_slots')) { assert.deepEqual(args, [userId]); return result([slot]) }
    if (text.includes('FROM pe_workspaces w JOIN pe_workspace_bindings')) {
      assert.deepEqual(args, [workspaceId, userId]); return result([stored])
    }
    if (text.startsWith('SELECT state,pod_uid,runner_instance_id,binding_snapshot FROM pe_sandbox_instances')) {
      assert.deepEqual(args, [sessionId, userId]); return result([instance])
    }
    if (text.startsWith('UPDATE pe_mount_slots SET state=') || text.startsWith('UPDATE pe_sandbox_instances SET state=')) {
      assert(legacy, 'Caller-client failure must preserve the writer for rollback and subsequent quarantine')
      if (text.includes('pe_mount_slots')) slot.state = 'unknown'
      else instance.state = 'unknown'
      return result([])
    }
    throw new Error(`Unexpected synthetic SQL: ${text}`)
  }
  const client = { query: (text, args) => query('caller', text, args), on() {}, removeListener() {}, release() {} }
  const pool = {
    async query(text, args) {
      poolCalls.push('query'); assert(legacy, 'Caller capture must never use pool.query'); return query('pool', text, args)
    },
    async connect() { poolCalls.push('connect'); assert(legacy, 'Caller capture must never borrow a second client'); return client },
  }
  const files = { async bindingForId(owner, workspaceIdInput, suppliedClient) {
    assert.equal(owner, userId); assert.equal(workspaceIdInput, workspaceId); assert.equal(suppliedClient, client)
    bindingClients.push(suppliedClient); return clone(binding)
  } }
  const health = { ready: true, instanceId }
  const kube = {
    resourcePath: (namespace, kind, name) => `/api/v1/namespaces/${namespace}/${kind}/${name}`,
    proxyPath: (namespace, name, path) => `/api/v1/namespaces/${namespace}/services/${name}/proxy${path}`,
    async call(method, path) {
      kubeCalls.push({ method, path }); assert.equal(method, 'GET', 'Capture performs only resource and health observations')
      if (kube.beforeRead) await kube.beforeRead(path)
      if (path.endsWith('/proxy/health')) return clone(health)
      assert(resources.has(path), `Unexpected synthetic Kube observation: ${path}`); return clone(resources.get(path))
    },
  }
  const config = { namespace: 'stdio-transaction', image: imageReference, localRoot: '/unused', nodeRoot: '', volumeClaimName: 'owned-posix',
    readyTimeoutMs: 100, fileScan: { maxEntries: 100, maxHashBytes: 1024, timeoutMs: 100, maxSnapshotBytes: 1024, maxFiles: 10 } }
  const manager = new SandboxManager(kube, files, pool, 'synthetic-key', config), name = manager.name(userId), parentUid = randomUUID()
  const labels = { 'app.kubernetes.io/name': 'power-evolve-sandbox', 'app.kubernetes.io/instance': name,
    'powerevolve.dev/session': sessionId, 'powerevolve.dev/user': userId, 'powerevolve.dev/generation': '11' }
  const spec = { nodeName: 'node-1', automountServiceAccountToken: false, runtimeClassName: 'gvisor', serviceAccountName: 'power-evolve-runner',
    containers: [{ name: 'runner', image: imageReference, volumeMounts: [
      { name: 'workspace', mountPath: '/workspace', subPath: `workspaces/${binding.rootKey}/project/data` },
      { name: 'home', mountPath: '/home/agent', subPath: `homes/${userId}` },
      { name: 'skill-packages', mountPath: '/opt/power-evolve/skills', subPath: `skill-packages/${userId}`, readOnly: true },
      { name: 'token', mountPath: '/run/power-evolve', readOnly: true }, { name: 'scratch', mountPath: '/tmp' },
    ] }], volumes: [
      ...['workspace', 'home', 'skill-packages'].map(name => ({ name, persistentVolumeClaim: { claimName: 'owned-posix' } })),
      { name: 'token', secret: { secretName: name, defaultMode: 256, items: [{ key: 'token', path: 'runner-token', mode: 256 }] } },
      { name: 'scratch', emptyDir: {} },
    ], original: { raw: 'retained\0extension' } }
  const parent = { metadata: { name, namespace: config.namespace, uid: parentUid, labels: clone(labels) }, spec: { podTemplate: { spec: clone(spec) } } }
  const pod = { metadata: { name, namespace: config.namespace, uid: podUid, labels: clone(labels),
    finalizers: ['powerevolve.dev/retain-stop-observation'], ownerReferences: [{ uid: parentUid }] }, spec,
    status: { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 3,
      imageID: imageId, containerID: `containerd://${repeated('c')}`, state: { running: {} } }] } }
  const node = { metadata: { name: 'node-1' }, status: { nodeInfo: { operatingSystem: 'linux', architecture: 'arm64' } } }
  resources.set(kube.resourcePath(config.namespace, 'sandboxes', name), parent)
  resources.set(kube.resourcePath(config.namespace, 'pods', name), pod); resources.set('/api/v1/nodes/node-1', node)
  const ready = { name, podUid, runnerInstanceId: instanceId, token: 'synthetic-token', restartCount: 0,
    generation: '11', sessionId, userId, binding }
  return { capture: () => manager.captureStdioV2(ready, scope, pin, limits, legacy ? undefined : client), manager,
    account, workspace, slot, instance, stored, binding, flags, health, pod, parent, node, kube, ready, scope, pin, limits,
    client, poolCalls, sql, kubeCalls, bindingClients }
}

const refused = code => error => error instanceof MountSlotBlocked && error.code === code && !error.retryable
const assertNoPoolOrWrites = f => {
  assert.deepEqual(f.poolCalls, [])
  assert(f.sql.every(call => call.source === 'caller' && call.text.startsWith('SELECT')))
}

test('caller-client capture reuses its transaction for all authority/binding/slot/instance facts and still observes health/node/spec', options, async () => {
  const f = fixture(), before = clone({ slot: f.slot, instance: f.instance, spec: f.pod.spec })
  const result = await f.capture()
  assertNoPoolOrWrites(f); assert.deepEqual({ slot: f.slot, instance: f.instance, spec: f.pod.spec }, before)
  assert.equal(f.bindingClients.length, 2); assert(f.bindingClients.every(client => client === f.client))
  assert.equal(f.sql.filter(call => call.text.includes('FROM pe_users')).length, 2)
  assert.equal(f.sql.filter(call => call.text.startsWith('SELECT binding_generation')).length, 2)
  assert.equal(f.sql.filter(call => call.text.includes('FROM pe_workspace_bindings')).length, 0)
  assert.equal(f.sql.filter(call => call.text.includes('JOIN pe_workspace_bindings')).length, 2)
  assert.equal(f.sql.filter(call => call.text.startsWith('SELECT * FROM pe_mount_slots') && call.text.includes('FOR UPDATE')).length, 2)
  assert.equal(f.sql.filter(call => call.text.includes('FROM pe_sandbox_instances')).length, 2)
  assert.equal(f.kubeCalls.filter(call => call.path.endsWith('/proxy/health')).length, 2)
  assert.deepEqual(f.kubeCalls.filter(call => call.path.startsWith('/api/v1/nodes/')), [{ method: 'GET', path: '/api/v1/nodes/node-1' }])
  assert.deepEqual(result.spec, before.spec); assert.equal(result.capture.restartCount, 3)
  assert.equal(result.actualExecutorImage.runtimeImageId, f.pin.runtimeImageIds[0])
})

test('caller authority/Workspace/slot/instance failures reject without nested quarantine or writer mutation', options, async t => {
  for (const [name, change, expected] of [
    ['disabled owner', f => { f.account.enabled = false }, error => error.code === 'account_disabled'],
    ['Workspace recovery fence', f => { f.flags.recovery = true }, refused('mount_workspace_recovering')],
    ['resolution owns cleanup', f => { f.flags.cleanup = true }, error => error.code === 'execution_resolution_owns_cleanup'],
    ['Workspace not ready', f => { f.workspace.binding_state = 'blocked' }, refused('mount_binding_not_ready')],
    ['Workspace generation', f => { f.workspace.binding_generation = '8' }, refused('mount_binding_generation_changed')],
    ['slot Session', f => { f.slot.session_id = randomUUID() }, refused('mount_slot_changed')],
    ['stored binding', f => { f.stored.root_key = randomUUID() }, refused('mount_instance_changed')],
    ['instance identity', f => { f.instance.runner_instance_id = randomUUID() }, refused('mount_instance_changed')],
    ['instance binding', f => { f.instance.binding_snapshot.generation++ }, refused('mount_instance_changed')],
    ['runner health identity', f => { f.health.instanceId = randomUUID() }, refused('mount_instance_changed')],
    ['runner not ready', f => { f.health.ready = false }, refused('mount_instance_changed')],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f); const before = clone({ slot: f.slot, instance: f.instance })
    await assert.rejects(f.capture(), expected)
    assertNoPoolOrWrites(f); assert.deepEqual({ slot: f.slot, instance: f.instance }, before)
  })
})

test('caller capture retains five-mount/finalizer/owner fences rather than replacing admission with a PG-only check', options, async t => {
  for (const [name, change] of [
    ['Workspace mount', f => { f.pod.spec.containers[0].volumeMounts[0].subPath = 'workspaces/foreign' }],
    ['Home mount', f => { f.pod.spec.containers[0].volumeMounts[1].subPath = 'homes/foreign' }],
    ['Skill readonly mount', f => { f.pod.spec.containers[0].volumeMounts[2].readOnly = false }],
    ['Token readonly mount', f => { f.pod.spec.containers[0].volumeMounts[3].readOnly = false }],
    ['Scratch mount', f => { f.pod.spec.containers[0].volumeMounts[4].mountPath = '/different' }],
    ['Parent template', f => { f.parent.spec.podTemplate.spec.volumes[0].persistentVolumeClaim.claimName = 'foreign' }],
    ['Finalizer', f => { f.pod.metadata.finalizers = [] }],
    ['Pod owner', f => { f.pod.metadata.ownerReferences[0].uid = randomUUID() }],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f)
    await assert.rejects(f.capture(), refused('mount_instance_changed'))
    assertNoPoolOrWrites(f); assert.equal(f.slot.state, 'ready'); assert.equal(f.instance.state, 'ready')
  })
})

test('fresh caller recheck after Node observation refuses changed writer; Node and image facts remain mandatory', options, async t => {
  for (const [name, change, code] of [
    ['slot changed during observation', f => { f.kube.beforeRead = path => { if (path.startsWith('/api/v1/nodes/')) f.slot.generation = '12' } }, 'mount_slot_changed'],
    ['health changed during observation', f => { f.kube.beforeRead = path => { if (path.startsWith('/api/v1/nodes/')) f.health.instanceId = randomUUID() } }, 'mount_instance_changed'],
    ['Node OS missing', f => { delete f.node.status.nodeInfo.operatingSystem }, 'mount_stdio_capture_invalid'],
    ['different architecture', f => { f.node.status.nodeInfo.architecture = 'amd64' }, 'mount_stdio_capture_invalid'],
    ['image prefix changed', f => { f.pod.status.containerStatuses[0].imageID = f.pin.configImageId }, 'mount_stdio_capture_invalid'],
    ['spec image changed', f => { f.pod.spec.containers[0].image = 'different:tag' }, 'mount_stdio_capture_invalid'],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f)
    await assert.rejects(f.capture(), refused(code)); assertNoPoolOrWrites(f)
    assert.equal(f.slot.state, 'ready'); assert.equal(f.instance.state, 'ready')
  })
})

test('without a client the existing admission transaction and quarantine on instance loss remain intact', options, async () => {
  const ready = fixture(true)
  await ready.capture(); assert.equal(ready.poolCalls.filter(call => call === 'connect').length, 2)
  assert.equal(ready.sql.filter(call => call.text === 'BEGIN').length, 2)
  assert.equal(ready.sql.filter(call => call.text === 'COMMIT').length, 2)
  const changed = fixture(true), identity = { pod_uid: changed.slot.pod_uid, runner_instance_id: changed.slot.runner_instance_id }
  changed.health.instanceId = randomUUID()
  await assert.rejects(changed.capture(), refused('mount_instance_changed'))
  assert.equal(changed.poolCalls.filter(call => call === 'connect').length, 1)
  assert.equal(changed.slot.state, 'unknown'); assert.equal(changed.instance.state, 'unknown')
  assert.deepEqual({ pod_uid: changed.slot.pod_uid, runner_instance_id: changed.slot.runner_instance_id }, identity)
  assert.equal(changed.sql.filter(call => call.text.startsWith('UPDATE')).length, 2)
  assert(changed.kubeCalls.every(call => call.method === 'GET'))
})
