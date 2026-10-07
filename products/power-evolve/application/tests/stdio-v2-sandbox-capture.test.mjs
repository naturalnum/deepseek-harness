/** Capture-only regression: deterministic admission/Kubernetes observations, no PG, cluster or program. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SandboxManager, MountSlotBlocked } from '../lib/platform/sandbox.js'

const clone = value => structuredClone(value)
const hash = digit => digit.repeat(64)
const options = { timeout: 5000 }
function fixture(pvc = true) {
  const userId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID()
  const binding = { workspaceId, spaceId: randomUUID(), rootKey: randomUUID(), rootRelativePath: 'project/data', generation: 7 }
  const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0,
    killGraceMs: 1000, maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072,
    maxProtocolMessages: 100, maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20,
    maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
  const platform = { os: 'linux', architecture: 'arm64' }
  const imageReference = `registry.example/runner@sha256:${hash('a')}`
  const imageId = `docker-pullable://${imageReference}`
  const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform,
    imageReference, configImageId: `sha256:${hash('b')}`, runtimeImageIds: [imageId] }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: binding.generation,
    target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
  const calls = [], resources = new Map()
  const kube = {
    resourcePath: (namespace, kind, name) => `/api/v1/namespaces/${namespace}/${kind}/${name}`,
    async call(method, path) {
      calls.push({ method, path })
      assert.equal(method, 'GET', 'capture must never mutate Kubernetes or call a program endpoint')
      if (kube.beforeRead) await kube.beforeRead(path)
      const value = resources.get(path)
      if (!value) throw new Error('fixture unavailable')
      return clone(value)
    },
  }
  const config = { namespace: 'stdio-capture', image: imageReference, localRoot: '/unused', nodeRoot: pvc ? '' : '/unused',
    ...(pvc ? { volumeClaimName: 'owned-posix' } : {}), readyTimeoutMs: 100,
    fileScan: { maxEntries: 100, maxHashBytes: 1024, timeoutMs: 100, maxSnapshotBytes: 1024, maxFiles: 10 } }
  const manager = new SandboxManager(kube, {}, { query() { throw new Error('unexpected new PG call') } }, 'fixture-key', config)
  // Substitute the existing account/PG admission fence; this test does not claim to exercise its locks.
  let guards = 0
  manager.assertDispatchAllowed = async writer => {
    guards++
    assert.deepEqual(writer, ready)
    if (manager.guard) await manager.guard(guards)
  }
  const name = manager.name(userId), parentUid = randomUUID(), podUid = randomUUID()
  const labels = manager.labels(sessionId, userId, name, '11')
  const volume = (name, source) => pvc ? { name, persistentVolumeClaim: { claimName: 'owned-posix' } }
    : { name, hostPath: { path: '/unused/' + source, type: 'Directory' } }
  const spec = { nodeName: 'node-1', automountServiceAccountToken: false, runtimeClassName: 'gvisor',
    ...(pvc ? { serviceAccountName: 'power-evolve-runner' } : {}),
    containers: [{ name: 'runner', image: imageReference, volumeMounts: [
      { name: 'workspace', mountPath: '/workspace', ...(pvc ? { subPath: `workspaces/${binding.rootKey}/${binding.rootRelativePath}` }
        : { subPath: binding.rootRelativePath }) },
      { name: 'home', mountPath: '/home/agent', ...(pvc ? { subPath: `homes/${userId}` } : {}) },
      { name: 'skill-packages', mountPath: '/opt/power-evolve/skills', readOnly: true,
        ...(pvc ? { subPath: `skill-packages/${userId}` } : {}) },
      { name: 'token', mountPath: '/run/power-evolve', readOnly: true }, { name: 'scratch', mountPath: '/tmp' },
    ] }],
    volumes: [volume('workspace', `workspaces/${binding.rootKey}`), volume('home', `homes/${userId}`),
      volume('skill-packages', `skill-packages/${userId}`),
      { name: 'token', secret: { secretName: name, defaultMode: 256,
        items: [{ key: 'token', path: 'runner-token', mode: 256 }] } }, { name: 'scratch', emptyDir: {} }],
    _originalExtension: { literal: 'a\0b', numericKeys: { 2: 'two', 10: 'ten' } },
  }
  const parent = { metadata: { name, namespace: config.namespace, uid: parentUid, labels }, spec: { podTemplate: { spec: clone(spec) } } }
  const pod = { metadata: { name, namespace: config.namespace, uid: podUid, labels: clone(labels),
    finalizers: ['powerevolve.dev/retain-stop-observation'], ownerReferences: [{ uid: parentUid }] }, spec,
    status: { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 3,
      imageID: imageId, containerID: `containerd://${hash('c')}`, state: { running: { startedAt: '2026-10-07T10:00:00Z' } } }] } }
  const node = { metadata: { name: 'node-1', uid: randomUUID() },
    status: { nodeInfo: { operatingSystem: 'linux', architecture: 'arm64' } } }
  const parentPath = kube.resourcePath(config.namespace, 'sandboxes', name), podPath = kube.resourcePath(config.namespace, 'pods', name)
  resources.set(parentPath, parent); resources.set(podPath, pod); resources.set('/api/v1/nodes/node-1', node)
  const ready = { name, podUid, runnerInstanceId: randomUUID(), token: 'synthetic-token', restartCount: 0,
    generation: '11', sessionId, userId, binding }
  const capture = (overrides = {}) => manager.captureStdioV2(overrides.ready ?? ready, overrides.scope ?? scope,
    overrides.pin ?? pin, overrides.limits ?? limits)
  return { capture, manager, kube, config, ready, pin, scope, limits, pod, parent, node, calls, resources,
    parentPath, podPath, guards: () => guards }
}
const refused = code => error => error instanceof MountSlotBlocked && error.code === code && error.retryable === false

test('captures complete unchanged PVC spec, exact runtime prefix and actual restart facts without Kube mutation', options, async () => {
  const f = fixture(), before = clone(f.pod.spec)
  const result = await f.capture()
  assert.deepEqual(result.spec, before)
  assert.equal(result.spec._originalExtension.literal, 'a\0b')
  assert.deepEqual(result.actualExecutorImage, { kind: 'cloud', platform: f.pin.platform,
    imageReference: f.pin.imageReference, runtimeImageId: f.pin.runtimeImageIds[0] })
  assert.equal(result.capture.restartCount, 3, 'old SandboxReady default zero is not an observation')
  assert.equal(result.capture.containerId, f.pod.status.containerStatuses[0].containerID)
  assert.deepEqual(result.capture.workspaceMount, { claimName: 'owned-posix',
    subPath: `workspaces/${f.ready.binding.rootKey}/project/data`, mountPath: '/workspace', readOnly: false })
  assert.deepEqual(result.capture.homeMount, { claimName: 'owned-posix', subPath: `homes/${f.ready.userId}`,
    mountPath: '/home/agent', readOnly: false })
  assert.equal(f.guards(), 2)
  assert.deepEqual(f.calls.filter(call => call.path.startsWith('/api/v1/nodes/')), [{ method: 'GET', path: '/api/v1/nodes/node-1' }])
  result.spec.containers[0].image = 'changed-returned-copy'
  assert.deepEqual(f.pod.spec, before)
})

test('scope mismatch and legacy hostPath refuse before resource reads while legacy mount validation stays intact', options, async t => {
  for (const change of [f => ({ ...f.scope, userId: randomUUID() }), f => ({ ...f.scope, workspaceId: randomUUID() }),
    f => ({ ...f.scope, bindingGeneration: 8 }), f => ({ ...f.scope, target: { ...f.scope.target, spaceId: randomUUID() } }),
    f => ({ ...f.scope, target: { ...f.scope.target, rootRelativePath: 'other' } }),
    f => ({ ...f.scope, home: { kind: 'user', userId: randomUUID() } })]) await t.test('changed logical binding', async () => {
    const f = fixture()
    await assert.rejects(f.capture({ scope: change(f) }), refused('mount_stdio_capture_invalid'))
    assert.equal(f.calls.length, 0)
  })
  const f = fixture(false)
  assert.equal(f.manager.hasSkillPackageIdentity(f.parent, f.pod, f.ready.userId, f.ready.binding), true)
  await assert.rejects(f.capture(), refused('mount_stdio_pvc_required'))
  assert.equal(f.calls.length, 0)
})

test('missing, ambiguous, stopped or changed runtime facts refuse without using status index or inferred platform', options, async t => {
  const changes = [
    f => { f.pod.status.containerStatuses = [] },
    f => { f.pod.status.containerStatuses.push(clone(f.pod.status.containerStatuses[0])) },
    f => { f.pod.status.containerStatuses[0].name = 'sidecar' },
    f => { delete f.pod.status.containerStatuses[0].containerID },
    f => { delete f.pod.status.containerStatuses[0].imageID },
    f => { delete f.pod.status.containerStatuses[0].restartCount },
    f => { f.pod.status.containerStatuses[0].restartCount = Number.MAX_SAFE_INTEGER + 1 },
    f => { f.pod.status.containerStatuses[0].ready = false },
    f => { f.pod.status.containerStatuses[0].state = { terminated: { exitCode: 0 } } },
    f => { f.pod.spec.containers.push(clone(f.pod.spec.containers[0])) },
    f => { f.pod.spec.containers[0].image = `registry.example/runner@sha256:${hash('d')}` },
    f => { f.parent.spec.podTemplate.spec.containers[0].image = 'unapproved:tag' },
    f => { f.pod.status.containerStatuses[0].imageID = f.pin.runtimeImageIds[0].replace('docker-pullable://', '') },
    f => { f.pod.status.containerStatuses[0].imageID = f.pin.configImageId },
    f => { delete f.pod.spec.nodeName },
    f => { delete f.node.status.nodeInfo.operatingSystem },
    f => { f.node.status.nodeInfo.architecture = 'amd64' },
    f => { f.node.metadata.name = 'other-node' },
  ]
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const f = fixture(); change(f)
    await assert.rejects(f.capture(), refused('mount_stdio_capture_invalid'))
  })
})

test('Workspace, Home, PVC and read-only mount observations must match the complete original binding', options, async t => {
  for (const change of [
    f => { f.pod.spec.containers[0].volumeMounts[0].subPath = 'workspaces/other' },
    f => { f.pod.spec.containers[0].volumeMounts[1].subPath = 'homes/other' },
    f => { f.pod.spec.volumes[0].persistentVolumeClaim.claimName = 'other-pvc' },
    f => { f.pod.spec.containers[0].volumeMounts[0].readOnly = true },
    f => { f.pod.spec.containers[0].volumeMounts[2].readOnly = false },
  ]) await t.test('changed physical binding', async () => {
    const f = fixture(); change(f)
    await assert.rejects(f.capture(), refused('mount_stdio_capture_invalid'))
  })
})

test('unavailable resources or denied Node read use a fixed failure, without new resource creation', options, async t => {
  for (const missing of ['parentPath', 'podPath', 'node']) await t.test(missing, async () => {
    const f = fixture(); f.resources.delete(missing === 'node' ? '/api/v1/nodes/node-1' : f[missing])
    await assert.rejects(f.capture(), refused('mount_stdio_capture_unavailable'))
  })
})

test('budget and changes during Node observation refuse; existing admission/quarantine errors remain unchanged', options, async t => {
  for (const key of ['maxInputBytes', 'maxJsonDepth', 'maxJsonNodes']) await t.test(key, async () => {
    const f = fixture()
    await assert.rejects(f.capture({ limits: { ...f.limits, [key]: 1 } }), refused('mount_stdio_capture_invalid'))
  })
  for (const change of [f => { f.pod.metadata.uid = randomUUID() },
    f => { f.pod.status.containerStatuses[0].containerID = `containerd://${hash('d')}` },
    f => { f.pod.status.containerStatuses[0].restartCount++ },
    f => { f.pod.spec._originalExtension.literal = 'changed' }]) await t.test('changed across capture', async () => {
    const f = fixture()
    f.kube.beforeRead = path => { if (path.startsWith('/api/v1/nodes/')) change(f) }
    await assert.rejects(f.capture(), refused('mount_stdio_capture_invalid'))
  })
  const f = fixture(), fenceError = new MountSlotBlocked('mount_instance_changed', false), safePgWrites = []
  f.manager.guard = () => { safePgWrites.push('original quarantine'); throw fenceError }
  await assert.rejects(f.capture(), error => error === fenceError)
  assert.deepEqual(safePgWrites, ['original quarantine'])
  assert.equal(f.calls.length, 0)
})
