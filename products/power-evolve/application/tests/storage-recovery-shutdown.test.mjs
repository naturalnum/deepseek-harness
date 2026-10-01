/** Real PG and Sandbox recovery; Kubernetes replies come from the existing deterministic fixture. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { FileService } from '../lib/platform/files.js'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { createSandboxFixture } from './sandbox-binding-fixture.mjs'

const options = { timeout: 30000 }
const worker = () => ({ ownerId: randomUUID(), leaseMs: 5000 })
const liveSignal = () => new AbortController().signal
const pending = f => f.pool.query('SELECT * FROM pe_workspace_binding_requests WHERE request_id=$1', [f.request.requestId])
const captured = ready => ({ kind: 'pod', mountGeneration: ready.generation, sessionId: ready.sessionId,
  podUid: ready.podUid, runnerInstanceId: ready.runnerInstanceId })
const stopped = ready => ({ kind: 'kubelet_stopped', mountGeneration: ready.generation, podUid: ready.podUid })

async function setup(t) {
  const f = await createSandboxFixture(t), userId = await f.createUser(), session = await f.createSession(userId)
  await f.files.workspaceForId(userId, session.workspaceId)
  const filesA = new FileService(f.pool, join(f.localRoot, 'workspaces'))
  const filesB = new FileService(f.pool, join(f.localRoot, 'workspaces'))
  await filesA.init(); await filesB.init()
  const managerA = new SandboxManager(f.kube, filesA, f.pool, 'test-key', f.managerOptions)
  const managerB = new SandboxManager(f.kube, filesB, f.pool, 'test-key', f.managerOptions)
  managerA.home = f.manager.home; managerB.home = f.manager.home
  const user = { userId, username: `test-${userId}` }
  const space = (await filesA.bindings.spaces(user)).items.find(item => item.isDefault)
  await filesA.bindings.createDirectory(user, { requestId: randomUUID(), spaceId: space.spaceId, parentPath: '', name: 'target' })
  const rootKey = (await f.pool.query('SELECT root_key FROM pe_storage_spaces WHERE id=$1', [space.spaceId])).rows[0].root_key
  const target = join(f.localRoot, 'workspaces', rootKey, 'target', 'marker.txt')
  await writeFile(target, 'preserved target bytes')
  const ready = await managerA.ensureReady(session.sessionId, userId, async () => {})
  const sandboxUid = f.kube.resource('sandboxes', ready.name).metadata.uid
  const creations = f.kube.mutations.filter(item => item.method === 'POST').length
  const request = { requestId: randomUUID(), workspaceId: session.workspaceId, spaceId: space.spaceId,
    rootRelativePath: 'target', expectedGeneration: 1 }
  assert.equal((await filesA.bindings.restore(user, request)).state, 'accepted')
  return { ...f, ...session, user, request, ready, sandboxUid, filesA, filesB, managerA, managerB, rootKey, target, creations }
}

async function completedOnce(f) {
  const row = (await pending(f)).rows[0]
  assert.equal(row.state, 'completed'); assert.equal(row.lease_epoch, '2')
  assert.equal(row.lease_owner, null); assert.equal(row.lease_until, null); assert.equal(row.error_code, null)
  assert.deepEqual(row.stop_target, captured(f.ready)); assert.deepEqual(row.stop_proof, stopped(f.ready))
  assert.equal(row.result.bindingGeneration, 2)
  const workspace = (await f.pool.query('SELECT binding_generation,binding_state,recovery_request_id FROM pe_workspaces WHERE id=$1',
    [f.workspaceId])).rows[0]
  assert.deepEqual(workspace, { binding_generation: '2', binding_state: 'ready', recovery_request_id: null })
  assert.equal((await f.pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [f.sessionId])).rows[0].workspace_id, f.workspaceId)
  const binding = await f.filesB.bindingForId(f.user.userId, f.workspaceId)
  assert.deepEqual(binding, { workspaceId: f.workspaceId, spaceId: f.request.spaceId, rootKey: f.rootKey,
    rootRelativePath: 'target', generation: 2 })
  assert.equal(await readFile(f.target, 'utf8'), 'preserved target bytes')
  const slot = (await f.pool.query('SELECT state,stop_pod_uid FROM pe_mount_slots WHERE user_id=$1', [f.user.userId])).rows[0]
  assert.deepEqual(slot, { state: 'free', stop_pod_uid: f.ready.podUid })
  assert.equal(f.kube.resource('pods', f.ready.name), undefined)
  assert.equal(f.kube.mutations.filter(item => item.method === 'POST').length, f.creations)
  const podStops = f.kube.mutations.filter(item => item.method === 'DELETE' && item.resource === 'sandboxes')
  assert(podStops.length > 0)
  assert(podStops.every(item => item.body.preconditions.uid === f.sandboxUid))
  assert.equal(await f.filesB.bindings.poll(async () => { throw new Error('Completed request must not stop twice') },
    liveSignal(), worker()), false)
  return row
}

for (const stage of ['before writer stop', 'after durable stop proof']) {
  test(`shutdown ${stage} hands the original request to another owner`, options, async t => {
    const f = await setup(t), shutdown = new AbortController()
    let staleLease, proofSeen = false, callbacksB = 0
    const originalProbe = f.filesA.safe.probeDirectory
    if (stage === 'after durable stop proof') {
      f.filesA.safe.probeDirectory = async (...args) => {
        const present = await originalProbe.apply(f.filesA.safe, args)
        if (args[0].rootRelativePath === 'target') {
          // Abort while the final transaction awaits actual POSIX work, after proof committed separately.
          assert.deepEqual((await pending(f)).rows[0].stop_proof, stopped(f.ready))
          proofSeen = true; shutdown.abort()
        }
        return present
      }
    }
    try {
      assert.equal(await f.filesA.bindings.poll((claim, lease) => {
        staleLease = lease
        assert.deepEqual(claim.stopTarget, captured(f.ready))
        if (stage === 'before writer stop') shutdown.abort()
        return f.managerA.stopForRecovery(claim, lease)
      }, shutdown.signal, worker()), true)
    } finally { f.filesA.safe.probeDirectory = originalProbe }
    const interrupted = (await pending(f)).rows[0]
    const fenced = (await f.pool.query('SELECT binding_generation,binding_state,recovery_request_id FROM pe_workspaces WHERE id=$1',
      [f.workspaceId])).rows[0]
    const worked = await f.filesB.bindings.poll((claim, lease) => {
      callbacksB++
      assert.deepEqual(claim.stopTarget, captured(f.ready))
      return f.managerB.stopForRecovery(claim, lease)
    }, liveSignal(), worker())
    assert.equal(worked, true, `Worker B cannot claim A's ${interrupted.state} recovery`)
    assert.deepEqual(fenced, { binding_generation: '1', binding_state: 'recovering', recovery_request_id: f.request.requestId })
    assert.equal(interrupted.state, 'stopping'); assert.equal(interrupted.lease_owner, null)
    assert.equal(interrupted.lease_until, null); assert.equal(interrupted.error_code, null)
    assert.deepEqual(interrupted.stop_target, captured(f.ready))
    assert.deepEqual(interrupted.stop_proof, stage === 'before writer stop' ? null : stopped(f.ready))
    assert.equal(proofSeen, stage === 'after durable stop proof')
    assert.equal(callbacksB, stage === 'before writer stop' ? 1 : 0)
    await assert.rejects(staleLease(), { name: 'AbortError' })
    await completedOnce(f)
  })
}

test('a late aborted owner cannot replace the result committed by its successor', options, async t => {
  const f = await setup(t), shutdown = new AbortController()
  let enter, release, staleLease
  const entered = new Promise(resolve => { enter = resolve }), delayed = new Promise(resolve => { release = resolve })
  const first = f.filesA.bindings.poll(async (_claim, lease) => {
    staleLease = lease; shutdown.abort(); enter()
    await delayed
    return stopped(f.ready)
  }, shutdown.signal, worker())
  await entered
  try {
    // The callback ignores cancellation; expiration lets B take over before A returns its late proof.
    await f.pool.query("UPDATE pe_workspace_binding_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE request_id=$1",
      [f.request.requestId])
    assert.equal(await f.filesB.bindings.poll((claim, lease) => f.managerB.stopForRecovery(claim, lease), liveSignal(), worker()), true)
    const before = await completedOnce(f)
    release(); await first
    await assert.rejects(staleLease(), { name: 'AbortError' })
    assert.deepEqual((await pending(f)).rows[0], before)
    await completedOnce(f)
  } finally { release(); await first }
})

test('a non-shutdown stop failure keeps the request blocked for reconciliation', options, async t => {
  const f = await setup(t), original = f.kube.call.bind(f.kube)
  f.kube.call = async (method, path, ...args) => {
    if (method === 'DELETE' && path.includes('/sandboxes/')) throw new Error('Controlled infrastructure failure')
    return original(method, path, ...args)
  }
  assert.equal(await f.filesA.bindings.poll((claim, lease) => f.managerA.stopForRecovery(claim, lease), liveSignal(), worker()), true)
  const row = (await pending(f)).rows[0]
  assert.equal(row.state, 'blocked'); assert.equal(row.error_code, 'workspace_stop_unconfirmed')
  assert.equal(row.lease_owner, null); assert.equal(row.lease_until, null)
  assert.deepEqual(row.stop_target, captured(f.ready)); assert.equal(row.stop_proof, null)
  const workspace = (await f.pool.query('SELECT binding_generation,binding_state FROM pe_workspaces WHERE id=$1', [f.workspaceId])).rows[0]
  assert.deepEqual(workspace, { binding_generation: '1', binding_state: 'blocked' })
  assert.equal(await f.filesB.bindings.poll((claim, lease) => f.managerB.stopForRecovery(claim, lease), liveSignal(), worker()), false)
  assert.equal(f.kube.resource('pods', f.ready.name).metadata.uid, f.ready.podUid)
  assert.equal(f.kube.mutations.filter(item => item.method === 'POST').length, f.creations)
})
