/** Run with an explicit PE_TEST_DATABASE_URL; the shared fixture owns a fresh database, never the QA database. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SandboxManager } from '../lib/platform/sandbox.js'

const createSandboxFixture = process.env.PE_TEST_DATABASE_URL
  ? (await import('./sandbox-binding-fixture.mjs')).createSandboxFixture : null
const options = { timeout: 30000, skip: !createSandboxFixture }

async function pending(t, disconnectFinalizer = false) {
  const f = await createSandboxFixture(t, { readyTimeoutMs: 100, nodeRoot: '', volumeClaimName: 'owned-posix' })
  const userId = await f.createUser(), { sessionId, workspaceId } = await f.createSession(userId)
  const call = f.kube.call.bind(f.kube), name = f.manager.name(userId)
  let failPatch = disconnectFinalizer
  f.kube.call = async (method, path, ...args) => {
    if (method === 'PATCH' && failPatch) {
      failPatch = false
      throw new Error('finalizer response disconnected')
    }
    const value = await call(method, path, ...args)
    if (method === 'POST' && path.endsWith('/sandboxes')) {
      f.kube.resource('sandboxes', name).status.conditions[0].status = 'False'
      f.kube.resource('pods', name).status = { phase: 'Pending',
        containerStatuses: [{ name: 'runner', ready: false, restartCount: 0,
          state: { waiting: { reason: 'ImagePullBackOff' } } }] }
    }
    return value
  }
  await assert.rejects(f.manager.ensureReady(sessionId, userId, async () => {}),
    disconnectFinalizer ? /finalizer response disconnected/ : /mount_creation_unconfirmed/)
  const pod = f.kube.resource('pods', name)
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0]
  const instance = (await f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])).rows[0]
  assert.equal(slot.state, 'reserved')
  assert.equal(instance.state, 'creating')
  assert.equal(slot.pod_uid, null)
  assert.equal(slot.runner_instance_id, null)
  assert.equal(instance.pod_uid, pod.metadata.uid)
  assert.equal(instance.runner_instance_id, null)
  assert.equal(pod.metadata.finalizers.includes('powerevolve.dev/retain-stop-observation'), !disconnectFinalizer)
  return { ...f, userId, sessionId, workspaceId, name, slot, instance, pod }
}

test('PostgreSQL creation timeout resumes one original writer after a manager restart', options, async t => {
  const f = await pending(t), before = f.kube.mutations.length
  f.kube.resource('sandboxes', f.name).status.conditions[0].status = 'True'
  f.pod.status = { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] }
  const replacement = new SandboxManager(f.kube, f.files, f.pool, 'test-key', f.managerOptions)
  const ready = await replacement.ensureReady(f.sessionId, f.userId, async () => {})
  assert.equal(ready.podUid, f.instance.pod_uid)
  assert.equal(ready.generation, f.slot.generation)
  assert.deepEqual(ready.binding, f.slot.binding_snapshot)
  assert.equal(f.kube.mutations.length, before)
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  const instance = (await f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [f.sessionId])).rows[0]
  assert.equal(slot.state, 'ready')
  assert.equal(instance.state, 'ready')
  assert.equal(slot.pod_uid, ready.podUid)
  assert.equal(instance.pod_uid, ready.podUid)
  assert.equal(slot.runner_instance_id, ready.runnerInstanceId)
  assert.equal(instance.runner_instance_id, ready.runnerInstanceId)
  assert.equal(slot.generation, f.slot.generation)
  assert.equal(slot.stop_evidence, null)
  assert.equal(instance.stop_evidence, null)
})

test('PostgreSQL reservation keeps its old UID and no stop evidence when the original Pod disappears', options, async t => {
  const f = await pending(t), before = f.kube.mutations.length
  f.kube.resources.delete('pods/' + f.name)
  await assert.rejects(f.manager.ensureReady(f.sessionId, f.userId, async () => {}), /mount_pod_identity_changed/)
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  assert.equal(slot.state, 'reserved')
  assert.equal(slot.pod_uid, f.slot.pod_uid)
  assert.equal(slot.generation, f.slot.generation)
  assert.equal(slot.stop_evidence, null)
  const instance = (await f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [f.sessionId])).rows[0]
  assert.equal(instance.state, 'creating')
  assert.equal(instance.pod_uid, f.instance.pod_uid)
  assert.equal(instance.stop_evidence, null)
  assert.equal(f.kube.mutations.length, before)
})

test('PostgreSQL capture commits before a disconnected finalizer write and resumes the exact Pending UID', options, async t => {
  const f = await pending(t, true), before = f.kube.mutations.length
  assert.equal(f.slot.pod_uid, null, 'reserved slot must retain its CHECK-compliant null UID')
  assert.equal(f.instance.pod_uid, f.pod.metadata.uid)
  const captured = f.instance.pod_uid
  f.kube.resource('sandboxes', f.name).status.conditions[0].status = 'True'
  f.pod.status = { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] }
  const replacement = new SandboxManager(f.kube, f.files, f.pool, 'test-key', f.managerOptions)
  const ready = await replacement.ensureReady(f.sessionId, f.userId, async () => {})
  assert.equal(ready.podUid, captured)
  assert.equal(ready.generation, f.slot.generation)
  assert.deepEqual(ready.binding, f.slot.binding_snapshot)
  assert.deepEqual(f.kube.mutations.slice(before).map(value => [value.method, value.resource]), [['PATCH', 'pods']])
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  assert.equal(slot.state, 'ready')
  assert.equal(slot.pod_uid, captured)
  assert.equal(slot.stop_evidence, null)
})

test('PostgreSQL observation refuses a replaced Pod after the creating UID was captured', options, async t => {
  const f = await pending(t), before = f.kube.mutations.length
  f.pod.metadata.uid = randomUUID()
  await assert.rejects(f.manager.ensureReady(f.sessionId, f.userId, async () => {}), /mount_pod_identity_changed/)
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  const instance = (await f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [f.sessionId])).rows[0]
  assert.equal(slot.state, 'reserved')
  assert.equal(slot.pod_uid, null)
  assert.equal(instance.pod_uid, f.instance.pod_uid)
  assert.equal(slot.stop_evidence, null)
  assert.equal(instance.stop_evidence, null)
  assert.equal(f.kube.mutations.length, before)
})
