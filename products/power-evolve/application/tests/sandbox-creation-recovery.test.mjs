/** Creation observation with deterministic transaction rows and Kubernetes; no PG, secrets or sockets. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'

const clone = value => structuredClone(value)
const result = row => ({ rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 })

function fixture() {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID()
  const binding = { workspaceId, spaceId: randomUUID(), rootKey: randomUUID(), rootRelativePath: 'project', generation: 1 }
  const name = 'pe-sb-' + userId.replaceAll('-', '')
  const slot = { user_id: userId, session_id: sessionId, workspace_id: workspaceId, generation: '3',
    state: 'reserved', pod_uid: null, runner_instance_id: null, binding_snapshot: clone(binding),
    stop_pod_uid: null, stop_evidence: null }
  const instance = { session_id: sessionId, user_id: userId, name, state: 'creating', pod_uid: null,
    runner_instance_id: null, binding_snapshot: clone(binding), stop_pod_uid: null, stop_evidence: null }
  const state = { slot, instance, bindingState: 'ready' }
  let saved
  const query = async (sql, args = []) => {
    if (sql === 'BEGIN') { saved = clone(state); return result() }
    if (sql === 'COMMIT') return result()
    if (sql === 'ROLLBACK') { Object.assign(state, saved); return result() }
    if (sql.startsWith('SELECT s.workspace_id')) return result({ workspace_id: workspaceId })
    if (sql.startsWith('INSERT INTO pe_mount_slots')) return result()
    if (sql.startsWith('SELECT * FROM pe_mount_slots')) return result(state.slot)
    if (sql.startsWith('SELECT state,user_id,name,pod_uid')) return result(state.instance)
    if (sql.startsWith('UPDATE pe_sandbox_instances SET pod_uid=')) {
      if (state.instance.state !== 'creating' || state.instance.pod_uid !== null) return result()
      state.instance.pod_uid = args[1]
      return result({ session_id: sessionId })
    }
    if (sql.includes("UPDATE pe_sandbox_instances SET state='ready'")) {
      if (state.instance.state !== 'creating' || state.instance.pod_uid !== args[1]) return result()
      Object.assign(state.instance, { state: 'ready', pod_uid: args[1], runner_instance_id: args[2] })
      return result({ session_id: sessionId })
    }
    if (sql.includes("UPDATE pe_mount_slots SET state='ready'")) {
      Object.assign(state.slot, { state: 'ready', pod_uid: args[1], runner_instance_id: args[2] })
      return result(state.slot)
    }
    throw new Error('Unexpected fixture SQL: ' + sql)
  }
  const pool = { query, connect: async () => ({ query, on() {}, removeListener() {}, release() {} }) }
  const resources = new Map(), calls = []
  const runnerInstanceId = randomUUID()
  const kube = {
    resourcePath: (namespace, kind, resourceName) => '/' + namespace + '/' + kind + (resourceName ? '/' + resourceName : ''),
    proxyPath: (namespace, resourceName, path) => '/' + namespace + '/proxy/' + resourceName + path,
    async call(method, path, body) {
      calls.push({ method, path, body: clone(body) })
      const [, , kind, resourceName] = path.split('/')
      if (kind === 'proxy') {
        assert.equal(method, 'GET')
        assert(path.endsWith('/health'))
        return { ready: true, instanceId: runnerInstanceId }
      }
      if (method === 'GET') {
        if (!resources.has(kind + '/' + resourceName)) throw new KubernetesError(404, 'missing fixture resource')
        return clone(resources.get(kind + '/' + resourceName))
      }
      if (method === 'POST') {
        if (kind === 'services' && kube.failServiceCreate) throw new Error('fixture creation disconnected')
        const value = clone(body), id = value.metadata.name
        value.metadata.uid = randomUUID(); value.metadata.resourceVersion = '1'
        if (kind === 'secrets') value.data = { token: Buffer.from(body.stringData.token).toString('base64') }
        if (kind === 'sandboxes') {
          value.status = { conditions: [{ type: 'Ready', status: 'False' }] }
          resources.set('pods/' + id, { metadata: { name: id, uid: randomUUID(), resourceVersion: '1',
            labels: clone(value.metadata.labels), ownerReferences: [{ uid: value.metadata.uid }], finalizers: [] },
          spec: clone(value.spec.podTemplate.spec),
          status: { phase: 'Pending', containerStatuses: [{ name: 'runner', ready: false, restartCount: 0,
            state: { waiting: { reason: 'ImagePullBackOff' } } }] } })
        }
        resources.set(kind + '/' + id, value)
        return clone(value)
      }
      if (method === 'PATCH' && kind === 'pods') {
        const pod = resources.get(kind + '/' + resourceName)
        if (!pod || body.metadata.resourceVersion !== pod.metadata.resourceVersion) throw new KubernetesError(409, 'changed')
        pod.metadata.finalizers = clone(body.metadata.finalizers); pod.metadata.resourceVersion = '2'
        return clone(pod)
      }
      throw new Error('Unexpected Kubernetes mutation')
    },
  }
  const config = { namespace: 'creation-test', image: 'registry/runner@sha256:' + 'a'.repeat(64),
    localRoot: '/unused', nodeRoot: '', volumeClaimName: 'owned-posix', readyTimeoutMs: 100,
    fileScan: { maxEntries: 4096, maxHashBytes: 33554432, timeoutMs: 5000, maxSnapshotBytes: 1048576, maxFiles: 100 } }
  const files = { workspaceForId: async () => ({ id: workspaceId }) }
  const manager = () => {
    const value = new SandboxManager(kube, files, pool, 'fixture-key', config)
    // This test owns transaction rows, not PostgreSQL account/workspace locking.
    value.lockUser = async () => {}
    value.readyBinding = async () => {
      if (state.bindingState !== 'ready') throw new Error('mount_workspace_recovering')
      return clone(binding)
    }
    return value
  }
  const resource = kind => resources.get(kind + '/' + name)
  const markReady = () => {
    resource('sandboxes').status.conditions[0].status = 'True'
    resource('pods').status = { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] }
  }
  const pending = async () => {
    await assert.rejects(manager().createReserved(clone(state.slot), clone(binding), async () => {}), /mount_creation_unconfirmed/)
    assert.equal(state.slot.state, 'reserved')
    assert.equal(state.instance.state, 'creating')
  }
  return { userId, sessionId, workspaceId, binding, name, state, calls, resources, kube, manager, resource, markReady, pending }
}

test('image pull timeout retains the original Pod and a replacement manager only observes that reservation', async () => {
  const f = fixture()
  await f.pending()
  const uid = f.resource('pods').metadata.uid
  assert.equal(f.state.slot.pod_uid, null, 'reserved mount slot must satisfy its PostgreSQL CHECK')
  assert.equal(f.state.slot.runner_instance_id, null)
  assert.equal(f.state.instance.pod_uid, uid)
  assert.equal(f.state.instance.runner_instance_id, null)
  assert(f.resource('pods').metadata.finalizers.includes('powerevolve.dev/retain-stop-observation'))
  const captured = clone(f.state.slot), before = f.calls.length
  f.markReady()
  const ready = await f.manager().ensureReady(f.sessionId, f.userId, async () => {})
  assert.equal(ready.podUid, uid)
  assert.equal(ready.generation, captured.generation)
  assert.deepEqual(ready.binding, captured.binding_snapshot)
  assert.equal(f.state.slot.state, 'ready')
  assert.equal(f.state.instance.state, 'ready')
  assert.equal(f.state.slot.pod_uid, ready.podUid)
  assert.equal(f.state.instance.pod_uid, ready.podUid)
  assert.equal(f.state.slot.runner_instance_id, ready.runnerInstanceId)
  assert.equal(f.state.instance.runner_instance_id, ready.runnerInstanceId)
  assert.equal(f.state.slot.stop_evidence, null)
  assert(f.calls.slice(before).every(call => call.method === 'GET'))
})

test('a disconnected finalizer write resumes the captured UID without reserving or creating again', async () => {
  const f = fixture(), call = f.kube.call.bind(f.kube)
  let failPatch = true
  f.kube.call = async (method, path, ...args) => {
    if (method === 'PATCH' && failPatch) throw new Error('finalizer response disconnected')
    return call(method, path, ...args)
  }
  await assert.rejects(f.manager().createReserved(clone(f.state.slot), clone(f.binding), async () => {}),
    /finalizer response disconnected/)
  const uid = f.resource('pods').metadata.uid, generation = f.state.slot.generation
  assert.equal(f.state.slot.pod_uid, null)
  assert.equal(f.state.instance.pod_uid, uid)
  assert.equal(f.resource('pods').metadata.finalizers.length, 0)
  failPatch = false
  f.markReady()
  const before = f.calls.length
  const ready = await f.manager().ensureReady(f.sessionId, f.userId, async () => {})
  assert.equal(ready.podUid, uid)
  assert.equal(ready.generation, generation)
  assert.equal(f.calls.slice(before).filter(call => call.method === 'PATCH').length, 1)
  assert(f.calls.slice(before).every(call => ['GET', 'PATCH'].includes(call.method)))
})

test('legacy reserved rows without a captured UID only adopt the already existing owned Pod', async () => {
  const f = fixture()
  await f.pending()
  const uid = f.resource('pods').metadata.uid, generation = f.state.slot.generation
  f.state.instance.pod_uid = null
  f.markReady()
  const before = f.calls.length
  const ready = await f.manager().ensureReady(f.sessionId, f.userId, async () => {})
  assert.equal(ready.podUid, uid)
  assert.equal(ready.generation, generation)
  assert.equal(f.state.slot.pod_uid, uid)
  assert(f.calls.slice(before).every(call => call.method === 'GET'))
})

test('missing original resources remain reserved and are never recreated or treated as stopped', async () => {
  const f = fixture()
  await f.pending()
  const captured = clone(f.state.slot)
  for (const kind of ['secrets', 'services', 'sandboxes', 'pods']) {
    const prior = clone(f.resource(kind)), before = f.calls.length
    f.resources.delete(kind + '/' + f.name)
    await assert.rejects(f.manager().ensureReady(f.sessionId, f.userId, async () => {}),
      /mount_(?:secrets|services|sandboxes)_creation_missing|mount_pod_identity_changed/)
    assert.deepEqual(f.state.slot, captured)
    assert(f.calls.slice(before).every(call => call.method === 'GET'))
    f.resources.set(kind + '/' + f.name, prior)
  }
})

test('original token, selectors, templates, Pod UID, owner and mounts must remain unchanged', async () => {
  const f = fixture()
  await f.pending()
  f.markReady()
  for (const [kind, change] of [
    ['secrets', value => { value.data.token = Buffer.from('other-token').toString('base64') }],
    ['services', value => { value.spec.selector['powerevolve.dev/generation'] = '4' }],
    ['sandboxes', value => { value.spec.podTemplate.spec.containers[0].image = 'other-image' }],
    ['sandboxes', value => { value.metadata.labels['powerevolve.dev/user'] = randomUUID() }],
    ['pods', value => { value.metadata.uid = randomUUID() }],
    ['pods', value => { value.metadata.labels['powerevolve.dev/session'] = randomUUID() }],
    ['pods', value => { value.metadata.ownerReferences = [{ uid: randomUUID() }] }],
    ['pods', value => { value.metadata.deletionTimestamp = '2026-10-01T00:00:00Z' }],
    ['pods', value => { value.spec.containers[0].volumeMounts[0].subPath = 'another-workspace' }],
  ]) {
    const prior = clone(f.resource(kind)), captured = clone(f.state.slot), before = f.calls.length
    change(f.resource(kind))
    await assert.rejects(f.manager().ensureReady(f.sessionId, f.userId, async () => {}), /identity_changed/)
    assert.deepEqual(f.state.slot, captured)
    assert(f.calls.slice(before).every(call => call.method === 'GET'))
    f.resources.set(kind + '/' + f.name, prior)
  }
})

test('ownership, binding, generation and worker fences refuse recovery without clearing unknown state', async () => {
  const f = fixture()
  await f.pending()
  for (const change of [
    () => { f.state.slot.state = 'unknown' },
    () => { f.state.slot.generation = '4' },
    () => { f.state.slot.session_id = randomUUID() },
    () => { f.state.slot.workspace_id = randomUUID() },
    () => { f.state.slot.binding_snapshot.generation++ },
    () => { f.state.instance.state = 'ready' },
    () => { f.state.instance.user_id = randomUUID() },
    () => { f.state.instance.name = 'foreign-writer' },
    () => { f.state.instance.pod_uid = randomUUID() },
    () => { f.state.instance.runner_instance_id = randomUUID() },
    () => { f.state.instance.binding_snapshot.spaceId = randomUUID() },
    () => { f.state.bindingState = 'recovering' },
  ]) {
    const prior = clone(f.state), before = f.calls.length
    change()
    const changed = clone(f.state)
    await assert.rejects(f.manager().ensureReady(f.sessionId, f.userId, async () => {}), /mount_/)
    assert.deepEqual(f.state, changed)
    assert(f.calls.slice(before).every(call => call.method === 'GET'))
    Object.assign(f.state, prior)
  }
  const before = f.calls.length
  await assert.rejects(f.manager().ensureReady(f.sessionId, f.userId, async () => { throw new Error('worker lease lost') }),
    /worker lease lost/)
  assert.equal(f.calls.length, before)
})

test('generation or captured UID races after observation reject later Kubernetes mutations', async () => {
  const f = fixture()
  await f.pending()
  f.markReady()
  const call = f.kube.call.bind(f.kube), prior = clone(f.state)
  for (const change of [
    () => { f.state.slot.generation = '4' },
    () => { f.state.instance.pod_uid = randomUUID() },
  ]) {
    const before = f.calls.length
    f.kube.call = async (method, path, ...args) => {
      const value = await call(method, path, ...args)
      if (method === 'GET' && path.endsWith('/secrets/' + f.name)) change()
      return value
    }
    await assert.rejects(f.manager().ensureReady(f.sessionId, f.userId, async () => {}), /mount_reservation_changed/)
    assert.equal(f.state.slot.state, 'reserved')
    assert.equal(f.state.slot.pod_uid, null)
    assert.equal(f.state.slot.stop_evidence, null)
    assert(f.calls.slice(before).every(value => value.method === 'GET'))
    Object.assign(f.state, clone(prior))
  }
})

test('an incomplete creation before Sandbox admission is observed without filling missing resources', async () => {
  const f = fixture(), first = f.manager()
  f.kube.failServiceCreate = true
  await assert.rejects(first.createReserved(clone(f.state.slot), clone(f.binding), async () => {}), /creation disconnected/)
  assert.equal(f.state.slot.pod_uid, null)
  f.kube.failServiceCreate = false
  const before = f.calls.length
  await assert.rejects(f.manager().ensureReady(f.sessionId, f.userId, async () => {}), /mount_services_creation_missing/)
  assert.equal(f.state.slot.state, 'reserved')
  assert.equal(f.state.slot.pod_uid, null)
  assert(f.calls.slice(before).every(call => call.method === 'GET'))
})
