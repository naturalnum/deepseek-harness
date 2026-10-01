/** Kubernetes may keep returning a terminated Pod after our finalizer removal succeeds. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSandboxFixture } from './sandbox-binding-fixture.mjs'

for (const resume of [false, true]) test(`cleanup tolerates delayed Pod disappearance${resume ? ' after worker restart' : ''}`, { timeout: 10000 }, async t => {
  const f = await createSandboxFixture(t, { readyTimeoutMs: 2000 })
  const userId = await f.createUser(), { sessionId } = await f.createSession(userId)
  const ready = await f.manager.ensureReady(sessionId, userId, async () => {})
  const call = f.kube.call.bind(f.kube)
  let retained, observations = 0, interrupt = resume
  f.kube.call = async (method, path, body) => {
    if (method === 'GET' && path.endsWith(`/pods/${ready.name}`) && retained && observations < 3) {
      if (interrupt) { interrupt = false; throw new Error('Synthetic observer restart') }
      observations++
      return structuredClone(retained)
    }
    const result = await call(method, path, body)
    if (method === 'PATCH' && path.endsWith(`/pods/${ready.name}`)) retained = structuredClone(result)
    return result
  }
  if (resume) await assert.rejects(f.manager.recycleIdle(0), /Synthetic observer restart/u)
  await f.manager.recycleIdle(0)
  const slot = (await f.pool.query('SELECT state,stop_pod_uid,stop_evidence FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0]
  assert.equal(slot.state, 'free'); assert.equal(slot.stop_pod_uid, ready.podUid)
  assert.equal(slot.stop_evidence.status, 'KUBELET_STOPPED')
  assert.equal(observations, 3)
  assert.equal(f.kube.mutations.filter(item => item.method === 'PATCH' && item.resource === 'pods').length, 2)
})

test('a finalizer removed without durable stop proof never releases the writer', { timeout: 10000 }, async t => {
  const f = await createSandboxFixture(t)
  const userId = await f.createUser(), { sessionId } = await f.createSession(userId)
  const ready = await f.manager.ensureReady(sessionId, userId, async () => {})
  f.kube.resource('pods', ready.name).metadata.finalizers = []
  const mutations = f.kube.mutations.length
  await assert.rejects(f.manager.recycleIdle(0), { code: 'mount_stop_pod_identity_changed' })
  const slot = (await f.pool.query('SELECT state,stop_evidence FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0]
  assert.deepEqual(slot, { state: 'stopping', stop_evidence: null })
  assert.equal(f.kube.mutations.length, mutations)
})

for (const missing of ['slot proof', 'instance proof', 'current termination']) {
  test(`a retained Pod without ${missing} keeps its writer fenced`, { timeout: 10000 }, async t => {
    const f = await createSandboxFixture(t)
    const userId = await f.createUser(), { sessionId } = await f.createSession(userId)
    const ready = await f.manager.ensureReady(sessionId, userId, async () => {})
    const call = f.kube.call.bind(f.kube)
    let retained
    f.kube.call = async (method, path, body) => {
      if (method === 'GET' && path.endsWith(`/pods/${ready.name}`) && retained) return structuredClone(retained)
      const result = await call(method, path, body)
      if (method === 'PATCH' && path.endsWith(`/pods/${ready.name}`)) {
        retained = structuredClone(result)
        if (missing === 'slot proof') await f.pool.query('UPDATE pe_mount_slots SET stop_pod_uid=NULL,stop_evidence=NULL WHERE user_id=$1', [userId])
        else if (missing === 'instance proof') await f.pool.query('UPDATE pe_sandbox_instances SET stop_pod_uid=NULL,stop_evidence=NULL WHERE session_id=$1', [sessionId])
        else retained.status = { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] }
      }
      return result
    }
    await assert.rejects(f.manager.recycleIdle(0), { code: 'mount_stop_pod_identity_changed' })
    assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0].state, 'stopping')
    assert.equal((await f.pool.query('SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])).rows[0].state, 'deleting')
  })
}
