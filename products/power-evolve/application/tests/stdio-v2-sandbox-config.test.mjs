/** Actual Sandbox construction/capture/transport over bounded recording PG and Kubernetes substitutes; no resources or program. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SandboxManager, MountSlotBlocked } from '../lib/platform/sandbox.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { StdioCloudRunTransportV2 } from '../lib/platform/stdio-v2-cloud-runtime.js'
import { stdioTaskSchemasV2, stdioPreparedV2, stdioDispatchV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const clone = value => structuredClone(value)
const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const enabled = () => ({ limits: clone(limits), maxReplyBytes: 32768 })
const bounds = { timeout: 5000 }
const refused = code => error => error instanceof MountSlotBlocked && error.code === code && !error.retryable

function fixture(stdioV2) {
  if (arguments.length === 0) stdioV2 = enabled()
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID(), runnerInstanceId = randomUUID()
  const binding = { workspaceId, spaceId: randomUUID(), rootKey: randomUUID(), rootRelativePath: 'owned/project', generation: 1 }
  const name = 'pe-sb-' + userId.replaceAll('-', ''), namespace = 'stdio-config-test'
  const slot = { user_id: userId, session_id: sessionId, workspace_id: workspaceId, generation: '3', state: 'reserved',
    pod_uid: null, runner_instance_id: null, binding_snapshot: clone(binding), stop_pod_uid: null, stop_evidence: null }
  const instance = { user_id: userId, session_id: sessionId, name, state: 'creating', pod_uid: null,
    runner_instance_id: null, binding_snapshot: clone(binding) }
  const result = value => ({ rows: value ? [clone(value)] : [], rowCount: value ? 1 : 0 })
  const sql = [], calls = [], resources = new Map()
  const query = async (text, args = []) => {
    sql.push({ text, args: clone(args) })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return result()
    if (text.startsWith('SELECT * FROM pe_mount_slots')) return result(slot)
    if (text.includes('FROM pe_sandbox_instances')) return result(instance)
    if (text.includes('FROM pe_workspaces w JOIN pe_workspace_bindings')) return result({ workspace_id: workspaceId,
      space_id: binding.spaceId, root_key: binding.rootKey, root_relative_path: binding.rootRelativePath, binding_generation: '1' })
    if (text.startsWith('UPDATE pe_sandbox_instances SET pod_uid=')) {
      assert.equal(instance.pod_uid, null); instance.pod_uid = args[1]; return result({ session_id: sessionId })
    }
    if (text.includes("UPDATE pe_sandbox_instances SET state='ready'")) {
      assert.equal(instance.pod_uid, args[1]); Object.assign(instance, { state: 'ready', runner_instance_id: args[2] })
      return result({ session_id: sessionId })
    }
    if (text.includes("UPDATE pe_mount_slots SET state='ready'")) {
      Object.assign(slot, { state: 'ready', pod_uid: args[1], runner_instance_id: args[2] }); return result(slot)
    }
    throw new Error('Unowned fixture SQL: ' + text)
  }
  const client = { query, on() {}, removeListener() {}, release() {} }, pool = { query, connect: async () => client }
  const config = { namespace, image: `registry.example/runner@sha256:${'a'.repeat(64)}`, localRoot: '/unused', nodeRoot: '',
    volumeClaimName: 'owned-posix', readyTimeoutMs: 100,
    fileScan: { maxEntries: 4096, maxHashBytes: 33554432, timeoutMs: 5000, maxSnapshotBytes: 1048576, maxFiles: 100 },
    ...(stdioV2 === undefined ? {} : { stdioV2 }) }
  const imageId = 'docker-pullable://' + config.image
  const kube = {
    resourcePath: (ns, kind, resourceName) => '/' + ns + '/' + kind + (resourceName ? '/' + resourceName : ''),
    proxyPath: (ns, resourceName, path) => '/' + ns + '/proxy/' + resourceName + path,
    async call(method, path, body, timeout, token, maxBytes) {
      calls.push({ method, path, body: clone(body), timeout, token, maxBytes })
      if (kube.beforeRead && method === 'GET') kube.beforeRead(path)
      if (path.startsWith('/api/v1/nodes/')) return { metadata: { name: 'node-1' },
        status: { nodeInfo: { operatingSystem: 'linux', architecture: 'arm64' } } }
      const [, , kind, key] = path.split('/')
      if (kind === 'proxy') {
        assert.equal(token, factory().token(name, sessionId, slot.generation))
        if (path.endsWith('/health')) { assert.equal(method, 'GET'); return { ready: true, instanceId: runnerInstanceId } }
        assert(path.endsWith('/cancel')); assert.equal(method, 'POST'); return clone(kube.cancelReply)
      }
      if (method === 'GET') {
        if (!resources.has(kind + '/' + key)) throw new KubernetesError(404, 'missing synthetic resource')
        return clone(resources.get(kind + '/' + key))
      }
      if (method === 'POST') {
        const value = clone(body); value.metadata.uid = randomUUID(); value.metadata.resourceVersion = '1'
        if (kind === 'secrets') value.data = Object.fromEntries(Object.entries(body.stringData).map(([key, text]) => [key, Buffer.from(text).toString('base64')]))
        if (kind === 'sandboxes') {
          value.status = { conditions: [{ type: 'Ready', status: 'True' }] }
          resources.set('pods/' + name, { metadata: { name, namespace, uid: randomUUID(), resourceVersion: '1',
            labels: clone(value.metadata.labels), ownerReferences: [{ uid: value.metadata.uid }], finalizers: [] },
            spec: { ...clone(value.spec.podTemplate.spec), nodeName: 'node-1' }, status: { phase: 'Running', containerStatuses: [
              { name: 'runner', ready: true, restartCount: 0, imageID: imageId, containerID: `containerd://${'c'.repeat(64)}`, state: { running: {} } },
            ] } })
        }
        resources.set(kind + '/' + name, value); return clone(value)
      }
      if (method === 'PATCH' && kind === 'pods') {
        const pod = resources.get(kind + '/' + key); assert.equal(pod.metadata.resourceVersion, body.metadata.resourceVersion)
        pod.metadata.finalizers = clone(body.metadata.finalizers); pod.metadata.resourceVersion = '2'; return clone(pod)
      }
      assert.fail('Unexpected synthetic Kube operation')
    },
  }
  const factory = (value = config) => {
    const manager = new SandboxManager(kube, {}, pool, 'synthetic-private-key', value)
    // Substitute account/Workspace authority rows, while actual reserved, identity, spec and ready-record code remains exercised.
    manager.lockUser = async () => {}; manager.readyBinding = async () => clone(binding)
    manager.lockWorkspace = async () => ({ binding_state: 'ready', binding_generation: '1', recovery_request_id: null })
    manager.assertDispatchBinding = async () => {}
    return manager
  }
  let ready
  const manager = factory()
  const create = async () => { ready = await manager.createReserved(clone(slot), clone(binding), async () => {}); return ready }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: 1,
    target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
  const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference: config.image, configImageId: `sha256:${'b'.repeat(64)}`, runtimeImageIds: [imageId] }
  const capture = (selected = manager, mode = 'dispatch', budgets = limits) =>
    selected.captureStdioV2(ready, scope, pin, budgets, client, mode)
  const resource = kind => resources.get(kind + '/' + name)
  return { manager, factory, config, create, capture, resource, resources, userId, sessionId, binding, scope, pin, slot, instance, client, sql, calls, kube }
}

test('optional deployment configuration validates and detaches the strict Runner-only projection before any resource call', bounds, () => {
  for (const change of [value => { value.approvalKey = 'must-not-project' }, value => { value.limits.privateKey = 'must-not-project' },
    value => { value.maxReplyBytes = 0 }, value => { value.maxReplyBytes = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.limits.requestMs = 0 }]) {
    const value = enabled(); change(value); assert.throws(() => fixture(value))
  }
  const f = fixture()
  assert.throws(() => f.factory({ ...f.config, volumeClaimName: undefined, nodeRoot: '/unused' }), /mount_stdio_pvc_required/u)
  assert.equal(f.calls.length, 0)
})

test('actual creation preserves five mounts, root-only token/config files and the disabled legacy spec', bounds, async () => {
  const off = fixture(undefined); await off.create()
  const oldSpec = clone(off.resource('sandboxes').spec.podTemplate.spec)
  assert.deepEqual(Object.keys(off.resource('secrets').stringData), ['token'])
  assert.equal(oldSpec.containers[0].env.length, 5)
  assert.deepEqual(oldSpec.volumes[3].secret.items, [{ key: 'token', path: 'runner-token', mode: 0o400 }])
  assert.equal(oldSpec.containers[0].env.some(entry => entry.name === 'PE_RUNNER_STDIO_V2_CONFIG_FILE'), false)
  const f = fixture(), original = clone(f.config.stdioV2); f.config.stdioV2.limits.maxTools++; f.config.stdioV2.maxReplyBytes++
  const ready = await f.create(), spec = f.resource('sandboxes').spec.podTemplate.spec
  const secret = f.resource('secrets'), projected = JSON.parse(secret.stringData['stdio-v2-config'])
  assert.deepEqual(projected, original, 'deployment budgets are detached before asynchronous creation')
  assert.deepEqual(Object.keys(projected), ['limits', 'maxReplyBytes']); assert.deepEqual(Object.keys(secret.stringData), ['token', 'stdio-v2-config'])
  assert.equal(spec.volumes.length, 5); assert.equal(spec.containers[0].volumeMounts.length, 5)
  assert.deepEqual(spec.volumes[3].secret.items, [{ key: 'token', path: 'runner-token', mode: 0o400 },
    { key: 'stdio-v2-config', path: 'stdio-v2-config.json', mode: 0o400 }])
  assert.equal(spec.volumes[3].secret.defaultMode, 0o400)
  assert.deepEqual(spec.containers[0].volumeMounts[3], { name: 'token', mountPath: '/run/power-evolve', readOnly: true })
  assert.deepEqual(spec.containers[0].env.at(-1), { name: 'PE_RUNNER_STDIO_V2_CONFIG_FILE', value: '/run/power-evolve/stdio-v2-config.json' })
  assert.equal(spec.containers[0].securityContext.runAsUser, 0); assert.equal(spec.containers[0].securityContext.runAsGroup, 0)
  assert.deepEqual((await f.capture()).spec, f.resource('pods').spec)
  assert.equal(ready.podUid, f.slot.pod_uid); assert.equal(ready.runnerInstanceId, f.instance.runner_instance_id)
  // Compare entire non-STDIO construction after substituting only the two independent fixtures' logical owner/root identities.
  const enabledWithoutAdditions = clone(spec)
  enabledWithoutAdditions.containers[0].env.pop(); enabledWithoutAdditions.volumes[3].secret.items.pop()
  const normalized = JSON.parse(JSON.stringify(enabledWithoutAdditions).replaceAll(f.userId, off.userId)
    .replaceAll(f.binding.rootKey, off.binding.rootKey).replaceAll(f.manager.name(f.userId), off.manager.name(off.userId)))
  assert.deepEqual(normalized, oldSpec)
})

test('enabled capture rejects full task-limit changes, extra config/secret/items, wrong file paths and altered env on either original spec', bounds, async t => {
  const changes = [
    f => { f.resource('secrets').data.extra = Buffer.from('unapproved').toString('base64') },
    f => { const data = enabled(); data.maxReplyBytes++; f.resource('secrets').data['stdio-v2-config'] = Buffer.from(JSON.stringify(data)).toString('base64') },
    f => { f.resource('secrets').metadata.labels['powerevolve.dev/session'] = randomUUID() },
    f => { f.resource('secrets').type = 'kubernetes.io/service-account-token' },
    f => { f.resource('pods').spec.volumes[3].secret.items.push({ key: 'extra', path: 'extra', mode: 0o400 }) },
    f => { f.resource('pods').spec.volumes[3].secret.items[1].path = '../config.json' },
    f => { f.resource('pods').spec.volumes[3].secret.items[1].mode = 0o444 },
    f => { f.resource('pods').spec.containers[0].volumeMounts[3].readOnly = false },
    f => { f.resource('pods').spec.containers[0].env.at(-1).value = '/tmp/config.json' },
    f => { f.resource('sandboxes').spec.podTemplate.spec.containers[0].env.push({ name: 'PRIVATE_KEY', value: 'unapproved' }) },
    f => { f.resource('pods').spec.containers[0].envFrom = [{ secretRef: { name: 'unapproved' } }] },
    f => { f.resource('pods').spec.securityContext.fsGroup = 1000 },
    f => { f.resource('pods').spec.containers[0].securityContext.runAsUser = 1000 },
  ]
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const f = fixture(); await f.create(); change(f); const before = f.calls.length
    await assert.rejects(f.capture(), error => error instanceof MountSlotBlocked)
    assert(f.calls.slice(before).every(call => call.method === 'GET'))
    assert.equal(f.slot.state, 'ready'); assert.equal(f.instance.state, 'ready')
  })
  const f = fixture(); await f.create(); const before = f.calls.length
  await assert.rejects(f.capture(f.manager, 'dispatch', { ...limits, maxTools: limits.maxTools + 1 }), refused('mount_stdio_capture_invalid'))
  assert.equal(f.calls.length, before)
  f.kube.beforeRead = path => { if (path.startsWith('/api/v1/nodes/')) f.resource('secrets').data['stdio-v2-config'] = Buffer.from('{}').toString('base64') }
  await assert.rejects(f.capture(), error => error instanceof MountSlotBlocked)
})

test('existing owned Secret is never overwritten or accepted through a concurrent-create conflict with different deployment config', bounds, async t => {
  for (const conflict of [false, true]) await t.test(String(conflict), async () => {
    const f = fixture(), value = { metadata: { name: f.manager.name(f.userId), namespace: f.config.namespace,
      uid: randomUUID(), labels: f.manager.labels(f.sessionId, f.userId, f.manager.name(f.userId), '3') }, type: 'Opaque',
      data: { token: Buffer.from(f.manager.token(f.manager.name(f.userId), f.sessionId, '3')).toString('base64'),
        'stdio-v2-config': Buffer.from(JSON.stringify({ ...enabled(), maxReplyBytes: 1 })).toString('base64') } }
    const call = f.kube.call.bind(f.kube)
    if (conflict) f.kube.call = async (method, path, body, ...rest) => {
      if (method === 'POST' && path.endsWith('/secrets')) {
        f.calls.push({ method, path, body: clone(body) })
        f.resources.set('secrets/' + value.metadata.name, clone(value))
        throw new KubernetesError(409, 'synthetic conflict')
      }
      return call(method, path, body, ...rest)
    }
    else f.resources.set('secrets/' + value.metadata.name, clone(value))
    await assert.rejects(f.create(), conflict ? error => error instanceof KubernetesError && error.status === 409 : refused('mount_secrets_identity_changed'))
    assert.equal(f.slot.state, 'reserved'); assert.equal(f.instance.state, 'creating')
    assert.equal(f.calls.some(call => call.method === 'POST' && /services|sandboxes/u.test(call.path)), false)
  })
})

test('enabling STDIO cannot adopt a legitimate old ready Pod as its enabled execution environment', bounds, async () => {
  const f = fixture(undefined), ready = await f.create(), manager = f.factory({ ...f.config, stdioV2: enabled() })
  const before = f.calls.length
  await assert.rejects(f.capture(manager), error => error instanceof MountSlotBlocked)
  assert.deepEqual(await manager.observeReady(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId, f.client, 'observe'), ready)
  assert.equal(await manager.matchesInstance(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), true)
  assert(f.calls.slice(before).every(call => call.method === 'GET'))
  assert.equal(f.slot.state, 'ready'); assert.equal(f.instance.state, 'ready')
})

test('deployment changes or disablement refuse new dispatch but retain original observation and bounded cancel transport', bounds, async t => {
  for (const stdioV2 of [{ ...enabled(), limits: { ...limits, maxTools: 99 }, maxReplyBytes: 65536 }, undefined]) await t.test(stdioV2 ? 'changed' : 'disabled', async () => {
    const f = fixture(); const ready = await f.create(), originalCapture = await f.capture()
    const newer = { ...f.config, stdioV2 }, manager = f.factory(newer)
    const before = f.calls.length
    await assert.rejects(f.capture(manager), error => error instanceof MountSlotBlocked)
    const original = await manager.observeReady(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId, f.client, 'observe')
    assert.deepEqual(original, ready)
    assert.deepEqual(await f.capture(manager, 'observe'), originalCapture)
    assert.equal(await manager.matchesInstance(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), true)
    const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
    const sha = (domain, value) => stdioSha256V2(domain, value, budget)
    const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId: randomUUID(), userId: f.userId,
      sessionId: f.sessionId, connectionId: randomUUID(), configRevision: 1, configDigest: 'd'.repeat(64), scopeBinding: f.scope,
      expectedDeploymentPin: f.pin, invocation: { program: 'never-executed', argv: [], cwd: '.' }, limits,
      phase: 'discover', origin: { kind: 'stdio_discovery', requestId: randomUUID() } })
    const executionRef = { kind: 'cloud', executionId: randomUUID() }
    const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: sha('task', task),
      scopeBinding: f.scope, expectedDeploymentPin: f.pin, actualExecutorImage: originalCapture.actualExecutorImage,
      capture: originalCapture.capture, specDigest: sha('spec', originalCapture.spec), fullScopeDigest: sha('scope', {
        scopeBinding: f.scope, workspaceMount: originalCapture.capture.workspaceMount, homeMount: originalCapture.capture.homeMount }) })
    const permit = { actionId: task.actionId, executionRef, taskDigest: prepared.taskDigest, preparedDigest: sha('prepared', prepared),
      approvalEpoch: 1, approvalFingerprint: 'e'.repeat(64), executorOwner: { kind: 'cloud', runnerInstanceId: ready.runnerInstanceId },
      permitId: randomUUID(), authorizationRequestId: randomUUID(), issuedAt: new Date(Date.now() - 2000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString() }
    const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest: prepared.taskDigest,
      executionRef, preparedDigest: permit.preparedDigest, permit })
    f.kube.cancelReply = { formatVersion: 2, instanceId: ready.runnerInstanceId, actionId: task.actionId, executionRef,
      taskDigest: prepared.taskDigest, dispatchDigest: sha('dispatch', dispatch), state: 'running', writerStopConfirmed: false }
    const transport = new StdioCloudRunTransportV2(manager, { limits, maxReplyBytes: 32768, requestTimeoutMs: 1000, maxTrackedActions: 1 })
    const observation = await transport.cancelDetached(dispatch, prepared, async (mode, operation) => {
      assert.equal(mode, 'observe'); return operation(f.client)
    })
    assert.equal(observation.view.state, 'running'); assert.equal(observation.stopEvidence, null, 'a cancel request is not a stop proof')
    const later = f.calls.slice(before), requests = later.filter(call => call.method === 'POST')
    assert.deepEqual(requests.map(call => call.path), [`/${f.config.namespace}/proxy/${ready.name}/stdio/v2/executions/${executionRef.executionId}/cancel`])
    assert(later.every(call => call.method === 'GET' || call === requests[0]))
    assert.equal(f.slot.state, 'ready'); assert.equal(f.instance.state, 'ready')
  })
})
