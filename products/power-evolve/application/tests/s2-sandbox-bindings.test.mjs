/** Real PG binding, admission and exact stopped-writer evidence; kubelet mount behavior is a separate integration gate. */
import test from 'node:test'
import { taskCredential } from './task-credential-fixture.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { FileService } from '../lib/platform/files.js'
import { ExecutionService } from '../lib/platform/executions.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { workspaceRecoveryClaim } from '../lib/platform/workspace-binding-types.js'
import { createSandboxFixture } from './sandbox-binding-fixture.mjs'

const options = { timeout: 30000 }
const workspaceMount = spec => spec.containers[0].volumeMounts.find(value => value.name === 'workspace')
const workspaceVolume = spec => spec.volumes.find(value => value.name === 'workspace')
const specifications = (f, ready) => [f.kube.resource('sandboxes', ready.name).spec.podTemplate.spec,
  f.kube.resource('pods', ready.name).spec]
async function setup(t, config = {}, target = {}) {
  const f = await createSandboxFixture(t, config)
  const userId = await f.createUser(), session = await f.createSession(userId, target)
  return { ...f, userId, ...session }
}
async function recovery(f, stopTarget, expectedGeneration = 1) {
  const requestId = randomUUID()
  const binding = await f.files.bindingForId(f.userId, f.workspaceId)
  await f.pool.query(`INSERT INTO pe_workspace_binding_requests(user_id,request_id,workspace_id,
    space_id,root_relative_path,expected_generation,state,stop_target)
    VALUES($1,$2,$3,$4,$5,$6,'accepted',$7::jsonb)`,
  [f.userId, requestId, f.workspaceId, binding.spaceId, binding.rootRelativePath, expectedGeneration, JSON.stringify(stopTarget)])
  await f.pool.query("UPDATE pe_workspaces SET binding_state='recovering',recovery_request_id=$2 WHERE id=$1", [f.workspaceId, requestId])
  return workspaceRecoveryClaim.parse({ userId: f.userId, requestId, workspaceId: f.workspaceId, expectedGeneration, stopTarget })
}
const captured = ready => ({ kind: 'pod', mountGeneration: ready.generation, sessionId: ready.sessionId,
  podUid: ready.podUid, runnerInstanceId: ready.runnerInstanceId })
const stopped = ready => ({ kind: 'kubelet_stopped', mountGeneration: ready.generation, podUid: ready.podUid })

test('the oldest recovery-fenced stopping slot does not starve another owner idle writer', options, async t => {
  for (const state of ['recovering', 'blocked']) await t.test(state, async t => {
    const f = await setup(t), first = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
    const otherUserId = await f.createUser(), otherSession = await f.createSession(otherUserId)
    const other = await f.manager.ensureReady(otherSession.sessionId, otherUserId, async () => {})
    await recovery(f, captured(first))
    await f.pool.query('UPDATE pe_workspaces SET binding_state=$2 WHERE id=$1', [f.workspaceId, state])
    await f.pool.query("UPDATE pe_mount_slots SET state='stopping' WHERE user_id=$1", [f.userId])
    await f.pool.query("UPDATE pe_sandbox_instances SET state='deleting',last_used_at='2020-01-01' WHERE session_id=$1", [first.sessionId])
    await f.pool.query("UPDATE pe_sandbox_instances SET last_used_at='2021-01-01' WHERE session_id=$1", [other.sessionId])
    const pending = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
    const mutations = f.kube.mutations.length
    await f.manager.recycleIdle(0)
    assert.deepEqual((await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0], pending)
    assert.equal(f.kube.resource('pods', first.name).metadata.uid, first.podUid)
    const deleted = (await f.pool.query('SELECT state,stop_pod_uid FROM pe_mount_slots WHERE user_id=$1', [otherUserId])).rows[0]
    assert.equal(deleted.state, 'free')
    assert.equal(deleted.stop_pod_uid, other.podUid)
    assert.equal((await f.pool.query('SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [other.sessionId])).rows[0].state, 'deleted')
    assert(f.kube.mutations.length > mutations)
    assert(f.kube.mutations.slice(mutations).every(value => value.name === other.name))
  })
})

test('recovery owns cleanup against both a new idle recycler and one already stopping the captured writer', options, async t => {
  for (const idleStartedFirst of [false, true]) await t.test(idleStartedFirst ? 'idle stop already in progress' : 'recovery already accepted', async t => {
    const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
    const files = new FileService(f.pool, join(f.localRoot, 'workspaces'))
    await files.init()
    const recoveryManager = new SandboxManager(f.kube, files, f.pool, 'test-key', f.managerOptions)
    recoveryManager.home = f.manager.home
    const user = { userId: f.userId, username: `test-${f.userId}` }
    const request = { requestId: randomUUID(), workspaceId: f.workspaceId, spaceId: ready.binding.spaceId,
      rootRelativePath: ready.binding.rootRelativePath, expectedGeneration: 1 }
    let reached, release
    const entered = new Promise(resolve => { reached = resolve })
    const held = new Promise(resolve => { release = resolve })
    const call = f.kube.call.bind(f.kube)
    let gated = false
    f.kube.call = async (method, path, body) => {
      const result = await call(method, path, body)
      if (!gated && method === 'GET' && path.endsWith(`/sandboxes/${ready.name}`)) {
        gated = true; reached(); await held
      }
      return result
    }
    const poll = () => files.bindings.poll((claim, lease) => recoveryManager.stopForRecovery(claim, lease),
      new AbortController().signal, { ownerId: randomUUID(), leaseMs: 5000 })
    if (idleStartedFirst) {
      const idle = f.manager.recycleIdle(0).then(() => null, error => error)
      await entered
      assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].state, 'stopping')
      await files.bindings.restore(user, request, await taskCredential(f.pool, user))
      await poll()
      const mutations = f.kube.mutations.length
      release()
      assert.match((await idle)?.message ?? '', /mount_(workspace_recovering|stop_generation_changed)/u)
      assert.equal(f.kube.mutations.length, mutations)
    } else {
      await files.bindings.restore(user, request, await taskCredential(f.pool, user))
      const recovering = poll()
      await entered
      try { await f.manager.recycleIdle(0) }
      finally { release() }
      await recovering
    }
    const receipt = await files.bindings.status(user, { requestId: request.requestId })
    assert.equal(receipt.state, 'completed')
    assert.equal(receipt.bindingGeneration, 2)
    const row = (await f.pool.query('SELECT stop_target,stop_proof FROM pe_workspace_binding_requests WHERE request_id=$1', [request.requestId])).rows[0]
    assert.deepEqual(row.stop_target, captured(ready))
    assert.deepEqual(row.stop_proof, stopped(ready))
    const slot = (await f.pool.query('SELECT state,stop_pod_uid,stop_evidence,binding_snapshot FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
    assert.equal(slot.state, 'free'); assert.equal(slot.stop_pod_uid, ready.podUid)
    assert.deepEqual(slot.binding_snapshot, ready.binding)
    assert.equal(slot.stop_evidence.runnerInstanceId, ready.runnerInstanceId)
    if (!idleStartedFirst) {
      const next = await recoveryManager.ensureReady(f.sessionId, f.userId, async () => {})
      await f.manager.recycleIdle(0)
      const recycled = (await f.pool.query('SELECT state,stop_pod_uid FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
      assert.equal(recycled.state, 'free')
      assert.equal(recycled.stop_pod_uid, next.podUid)
    }
  })
})

test('actual storage recovery worker stops the captured Pod, preserves Git bytes and rebinds the same Session', options, async t => {
  const f = await setup(t)
  await f.files.workspaceForId(f.userId, f.workspaceId)
  const files = new FileService(f.pool, join(f.localRoot, 'workspaces'))
  await files.init()
  const manager = new SandboxManager(f.kube, files, f.pool, 'test-key', f.managerOptions)
  manager.home = f.manager.home
  const user = { userId: f.userId, username: `test-${f.userId}` }
  const space = (await files.bindings.spaces(user)).items.find(value => value.isDefault)
  await files.bindings.createDirectory(user, { requestId: randomUUID(), spaceId: space.spaceId, parentPath: '', name: 'existing' }, await taskCredential(f.pool, user))
  await files.bindings.createDirectory(user, { requestId: randomUUID(), spaceId: space.spaceId, parentPath: 'existing', name: '.git' }, await taskCredential(f.pool, user))
  const rootKey = (await f.pool.query('SELECT root_key FROM pe_storage_spaces WHERE id=$1', [space.spaceId])).rows[0].root_key
  const headPath = join(f.localRoot, 'workspaces', rootKey, 'existing', '.git', 'HEAD')
  await writeFile(headPath, 'ref: refs/heads/preserved\n')
  const ready = await manager.ensureReady(f.sessionId, f.userId, async () => {})
  const request = { requestId: randomUUID(), workspaceId: f.workspaceId, spaceId: space.spaceId,
    rootRelativePath: 'existing', expectedGeneration: 1 }
  const accepted = await files.bindings.restore(user, request, await taskCredential(f.pool, user))
  assert.equal(accepted.state, 'accepted')
  assert.deepEqual((await f.pool.query('SELECT stop_target FROM pe_workspace_binding_requests WHERE request_id=$1',
    [request.requestId])).rows[0].stop_target, captured(ready))
  await assert.rejects(manager.assertDispatchAllowed(ready), { code: 'mount_workspace_recovering' })
  // A short lock timeout turns accidental nested lease transactions into a failing recovery receipt.
  f.pool.on('connect', client => { void client.query("SET lock_timeout='300ms'") })
  const clients = await Promise.all(Array.from({ length: 10 }, () => f.pool.connect()))
  for (const client of clients) await client.query("SET lock_timeout='300ms'")
  clients.forEach(client => client.release())
  let callbackCalls = 0, suppliedClientCalls = 0
  const worked = await files.bindings.poll(async (claim, assertLease) => {
    callbackCalls++
    assert.deepEqual(claim.stopTarget, captured(ready))
    return manager.stopForRecovery(claim, async client => {
      if (client) suppliedClientCalls++
      await assertLease(client)
    })
  }, new AbortController().signal, { ownerId: randomUUID(), leaseMs: 5000 })
  assert.equal(worked, true)
  assert.equal(callbackCalls, 1)
  assert(suppliedClientCalls >= 4)
  const receipt = await files.bindings.status(user, { requestId: request.requestId })
  assert.equal(receipt.state, 'completed')
  assert.equal(receipt.bindingGeneration, 2)
  const binding = await files.bindingForId(f.userId, f.workspaceId)
  assert.deepEqual(binding, { workspaceId: f.workspaceId, spaceId: space.spaceId, rootKey,
    rootRelativePath: 'existing', generation: 2 })
  assert.equal((await f.pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [f.sessionId])).rows[0].workspace_id, f.workspaceId)
  assert.equal(await readFile(headPath, 'utf8'), 'ref: refs/heads/preserved\n')
  const requestRow = (await f.pool.query('SELECT stop_proof FROM pe_workspace_binding_requests WHERE request_id=$1', [request.requestId])).rows[0]
  assert.deepEqual(requestRow.stop_proof, stopped(ready))
  const slot = (await f.pool.query('SELECT state,stop_pod_uid,binding_snapshot FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  assert.equal(slot.state, 'free'); assert.equal(slot.stop_pod_uid, ready.podUid)
  assert.deepEqual(slot.binding_snapshot, ready.binding)
  assert.equal(await files.bindings.poll(async () => { throw new Error('Completed recovery must not stop again') },
    new AbortController().signal, { ownerId: randomUUID(), leaseMs: 5000 }), false)
  const next = await manager.ensureReady(f.sessionId, f.userId, async () => {})
  assert.deepEqual(next.binding, binding)
  assert.notEqual(next.podUid, ready.podUid)
  assert.notEqual(next.generation, ready.generation)
  for (const spec of specifications(f, next)) {
    assert.equal(workspaceVolume(spec).hostPath.path, join(f.localRoot, 'workspaces', rootKey))
    assert.equal(workspaceMount(spec).subPath, 'existing')
  }
})

test('hostPath pins an owned root key and delegates nested selection to subPath, freezing both binding snapshots', options, async t => {
  const rootKey = randomUUID(), spaceId = randomUUID()
  const f = await setup(t, {}, { rootKey, spaceId, rootRelativePath: '项目/report', generation: 4 })
  const ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  assert.notEqual(rootKey, f.workspaceId); assert.equal(ready.binding.generation, 4); assert.equal(ready.generation, '1')
  for (const spec of specifications(f, ready)) {
    assert.equal(workspaceVolume(spec).hostPath.path, join(f.localRoot, 'workspaces', rootKey))
    assert.equal(workspaceMount(spec).subPath, '项目/report')
    assert.equal(workspaceVolume(spec).hostPath.path.includes('report'), false)
  }
  for (const [table, key, value] of [['pe_mount_slots', 'user_id', f.userId], ['pe_sandbox_instances', 'session_id', f.sessionId]]) {
    assert.deepEqual((await f.pool.query(`SELECT binding_snapshot FROM ${table} WHERE ${key}=$1`, [value])).rows[0].binding_snapshot,
      ready.binding)
  }
  assert.deepEqual(await f.manager.ensureReady(f.sessionId, f.userId, async () => {}), ready)
})

test('PVC uses the immutable root prefix and canonical relative directory while legacy host roots omit subPath', options, async t => {
  const rootKey = randomUUID()
  const f = await setup(t, { nodeRoot: '', volumeClaimName: 'pe-private-storage' }, { rootKey, rootRelativePath: 'existing/nested' })
  const ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  for (const spec of specifications(f, ready)) {
    assert.equal(workspaceVolume(spec).persistentVolumeClaim.claimName, 'pe-private-storage')
    assert.equal(workspaceMount(spec).subPath, `workspaces/${rootKey}/existing/nested`)
    assert.equal(spec.volumes.some(value => value.hostPath), false)
  }
  const legacy = await setup(t)
  const old = await legacy.manager.ensureReady(legacy.sessionId, legacy.userId, async () => {})
  assert.equal(old.binding.rootKey, legacy.workspaceId)
  for (const spec of specifications(legacy, old)) assert.equal('subPath' in workspaceMount(spec), false)
})

test('CR and Pod mount identity reject root, relative, Home, expression, duplicate and extra-container drift in both deployments', options, async t => {
  for (const config of [{}, { nodeRoot: '', volumeClaimName: 'pe-private-storage' }]) {
    const f = await setup(t, config, { rootKey: randomUUID(), rootRelativePath: 'selected' })
    const ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
    const cases = [
      ['workspace root', spec => { if (config.volumeClaimName) workspaceVolume(spec).persistentVolumeClaim.claimName = 'other';
        else workspaceVolume(spec).hostPath.path += '/selected' }],
      ['relative directory', spec => { workspaceMount(spec).subPath = 'other' }],
      ['Home root', spec => { const volume = spec.volumes.find(value => value.name === 'home');
        if (config.volumeClaimName) spec.containers[0].volumeMounts.find(value => value.name === 'home').subPath = 'homes/other';
        else volume.hostPath.path += '/other' }],
      ['expression', spec => { workspaceMount(spec).subPathExpr = '$(untrusted)' }],
      ['duplicate mount', spec => { spec.containers[0].volumeMounts.push(structuredClone(workspaceMount(spec))) }],
      ['duplicate volume', spec => { spec.volumes.push(structuredClone(workspaceVolume(spec))) }],
      ['sidecar', spec => { spec.containers.push({ name: 'other', volumeMounts: [] }) }],
      ['host PID', spec => { spec.hostPID = true }],
    ]
    for (const spec of specifications(f, ready)) {
      const original = structuredClone(spec)
      for (const [name, mutate] of cases) {
        mutate(spec)
        assert.equal(await f.manager.matchesInstance(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), false, name)
        for (const key of Object.keys(spec)) delete spec[key]
        Object.assign(spec, structuredClone(original))
      }
    }
    assert.equal(await f.manager.matchesInstance(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), true)
  }
})

test('reserve rereads a binding changed after initial provisioning and never trusts a returned physical path', options, async t => {
  const f = await setup(t)
  const original = f.files.workspaceForId.bind(f.files)
  f.files.workspaceForId = async (...args) => {
    await original(...args)
    await f.pool.query("UPDATE pe_workspaces SET binding_generation=2 WHERE id=$1", [f.workspaceId])
    await f.pool.query("UPDATE pe_workspace_bindings SET root_relative_path='moved' WHERE workspace_id=$1", [f.workspaceId])
    return { id: f.workspaceId, path: '/ignored-physical-source' }
  }
  const ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  assert.equal(ready.binding.generation, 2)
  assert.equal(workspaceMount(specifications(f, ready)[0]).subPath, 'moved')
  assert.equal(workspaceVolume(specifications(f, ready)[0]).hostPath.path, join(f.localRoot, 'workspaces', f.workspaceId))
})

test('a generation change during creation keeps the reserved slot and refuses later Kubernetes mutations', options, async t => {
  const f = await setup(t), call = f.kube.call.bind(f.kube)
  f.kube.call = async (method, path, body) => {
    const value = await call(method, path, body)
    if (method === 'POST' && path.endsWith('/secrets')) await f.pool.query('UPDATE pe_workspaces SET binding_generation=2 WHERE id=$1', [f.workspaceId])
    return value
  }
  await assert.rejects(f.manager.ensureReady(f.sessionId, f.userId, async () => {}), /mount_reservation_changed/u)
  assert.equal(f.kube.mutations.filter(value => value.resource === 'sandboxes').length, 0)
  assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].state, 'reserved')
})

test('another recovering or blocked binding fences new reserve and dispatch while exact old observation remains available', options, async t => {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const other = await f.createSession(f.userId)
  const count = f.kube.mutations.length
  for (const state of ['recovering', 'blocked']) {
    await f.pool.query('UPDATE pe_workspaces SET binding_state=$2 WHERE id=$1', [other.workspaceId, state])
    await assert.rejects(f.manager.ensureReady(f.sessionId, f.userId, async () => {}), /mount_workspace_recovering/u)
    await assert.rejects(f.manager.assertDispatchAllowed(ready), /mount_workspace_recovering/u)
    assert.deepEqual(await f.manager.observeReady(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), ready)
  }
  assert.equal(f.kube.mutations.length, count)
})

test('slot, instance and persisted binding generation all constrain a reused or captured writer', options, async t => {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  await assert.rejects(f.manager.assertCurrent({ ...ready, binding: { ...ready.binding, rootRelativePath: 'other' } }), /mount_slot_changed/u)
  await f.pool.query('UPDATE pe_sandbox_instances SET binding_snapshot=$2::jsonb WHERE session_id=$1',
    [f.sessionId, JSON.stringify({ ...ready.binding, generation: 2 })])
  assert.equal(await f.manager.matchesInstance(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), false)
  await f.pool.query('UPDATE pe_sandbox_instances SET binding_snapshot=$2::jsonb WHERE session_id=$1', [f.sessionId, JSON.stringify(ready.binding)])
  await f.pool.query('UPDATE pe_workspaces SET binding_generation=2 WHERE id=$1', [f.workspaceId])
  assert.equal(await f.manager.matchesInstance(f.sessionId, f.userId, ready.podUid, ready.runnerInstanceId), false)
})

test('exact Pod stop is durable, does Kubernetes I/O outside PG locks and survives a worker restart after free', options, async t => {
  const f = await setup(t)
  const call = f.kube.call.bind(f.kube)
  let checked = 0
  f.kube.call = async (method, ...args) => {
    if (method !== 'GET') {
      const client = await f.pool.connect()
      try {
        await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='100ms'")
        await client.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.userId])
        await client.query('SELECT id FROM pe_workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
        await client.query('SELECT user_id FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [f.userId])
        checked++
      } finally { await client.query('ROLLBACK'); client.release() }
    }
    return call(method, ...args)
  }
  const ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const claim = await recovery(f, captured(ready))
  assert.deepEqual(await f.manager.stopForRecovery(claim, async () => {}), stopped(ready))
  assert.ok(checked >= 6)
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  assert.equal(slot.state, 'free'); assert.equal(slot.stop_pod_uid, ready.podUid)
  assert.equal(slot.stop_evidence.runnerInstanceId, ready.runnerInstanceId)
  assert.deepEqual(slot.stop_evidence.bindingSnapshot, ready.binding)
  const next = new SandboxManager(f.kube, f.files, f.pool, 'test-key', f.managerOptions)
  const count = f.kube.mutations.length
  assert.deepEqual(await next.stopForRecovery(claim, async () => {}), stopped(ready))
  assert.equal(f.kube.mutations.length, count)
  await assert.rejects(next.stopForRecovery({ ...claim, stopTarget: { ...claim.stopTarget, runnerInstanceId: randomUUID() } }, async () => {}),
    /mount_stop_proof_missing/u)
})

test('a missing old Pod without exact native proof retains the recovery fence and never releases the slot', options, async t => {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const claim = await recovery(f, captured(ready))
  f.kube.resources.delete(`pods/${ready.name}`); f.kube.resources.delete(`sandboxes/${ready.name}`)
  await assert.rejects(f.manager.stopForRecovery(claim, async () => {}), /mount_stop_proof_missing/u)
  await assert.rejects(f.manager.stopForRecovery(claim, async () => {}), /mount_stop_proof_missing/u)
  const slot = (await f.pool.query('SELECT state,stop_evidence FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  assert.equal(slot.state, 'stopping'); assert.equal(slot.stop_evidence, null)
  assert.equal((await f.pool.query('SELECT binding_state,binding_generation FROM pe_workspaces WHERE id=$1', [f.workspaceId])).rows[0].binding_state, 'recovering')
})

test('stale request, storage generation and captured writer fields reject before any infrastructure mutation', options, async t => {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const claim = await recovery(f, captured(ready)), count = f.kube.mutations.length
  for (const wrong of [{ ...claim, requestId: randomUUID() }, { ...claim, expectedGeneration: 2 },
    ...['sessionId', 'podUid', 'runnerInstanceId'].map(field => ({ ...claim, stopTarget: { ...claim.stopTarget, [field]: randomUUID() } })),
    { ...claim, stopTarget: { ...claim.stopTarget, mountGeneration: '2' } }]) {
    await assert.rejects(f.manager.stopForRecovery(wrong, async () => {}), /mount_recovery_/u)
  }
  assert.equal(f.kube.mutations.length, count)
})

test('lease loss after native stop preserves the finalizer and rejects new proof writes; a new lease resumes that exact Pod', options, async t => {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const claim = await recovery(f, captured(ready))
  let valid = true, expire = true
  const lease = async () => { if (!valid) throw new Error('fixture_lease_lost') }
  const call = f.kube.call.bind(f.kube)
  f.kube.call = async (method, path, ...args) => {
    const value = await call(method, path, ...args)
    if (expire && method === 'GET' && path.includes('/pods/') && value.metadata.deletionTimestamp) {
      valid = false; expire = false
    }
    return value
  }
  await assert.rejects(f.manager.stopForRecovery(claim, lease), /fixture_lease_lost/u)
  const slot = (await f.pool.query('SELECT state,stop_evidence FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
  assert.equal(slot.state, 'stopping'); assert.equal(slot.stop_evidence, null)
  assert.ok(f.kube.resource('pods', ready.name).metadata.finalizers.length > 0)
  valid = true
  assert.deepEqual(await f.manager.stopForRecovery(claim, lease), stopped(ready))
  assert.equal(f.kube.mutations.filter(value => value.method === 'POST' && value.resource === 'sandboxes').length, 1)
})

test('no-writer evidence requires the unchanged free generation and absence of any live instance', options, async t => {
  const f = await setup(t)
  await f.pool.query("INSERT INTO pe_mount_slots(user_id,state) VALUES($1,'free')", [f.userId])
  const claim = await recovery(f, { kind: 'no_writer', mountGeneration: '0' })
  assert.deepEqual(await f.manager.stopForRecovery(claim, async () => {}), { kind: 'no_writer', mountGeneration: '0' })
  await assert.rejects(f.manager.stopForRecovery({ ...claim, stopTarget: { kind: 'no_writer', mountGeneration: '1' } }, async () => {}),
    /mount_recovery_slot_changed/u)
  await f.pool.query("INSERT INTO pe_sandbox_instances(session_id,user_id,name,state) VALUES($1,$2,$3,'creating')",
    [f.sessionId, f.userId, f.manager.name(f.userId)])
  await assert.rejects(f.manager.stopForRecovery(claim, async () => {}), /mount_recovery_writer_present/u)
  assert.equal(f.kube.mutations.length, 0)
})

test('recovery lease checks reuse the provided user-lock transaction instead of deadlocking a second connection', options, async t => {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const claim = await recovery(f, captured(ready)), owner = randomUUID()
  await f.pool.query(`UPDATE pe_workspace_binding_requests SET lease_owner=$3,lease_epoch=1,
    lease_until=clock_timestamp()+interval '30 seconds' WHERE user_id=$1 AND request_id=$2`, [f.userId, claim.requestId, owner])
  let reused = 0
  const verify = async client => {
    await client.query("SET LOCAL lock_timeout='300ms'")
    await client.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.userId])
    const leased = await client.query(`UPDATE pe_workspace_binding_requests
      SET lease_until=clock_timestamp()+interval '30 seconds'
      WHERE user_id=$1 AND request_id=$2 AND lease_owner=$3 AND lease_epoch=1
        AND lease_until>clock_timestamp() AND state IN ('accepted','stopping') RETURNING request_id`, [f.userId, claim.requestId, owner])
    if (!leased.rowCount) throw new Error('fixture_recovery_lease_lost')
  }
  const lease = async client => {
    if (client) { reused++; await verify(client); return }
    const own = await f.pool.connect()
    try { await own.query('BEGIN'); await verify(own); await own.query('COMMIT') }
    catch (error) { await own.query('ROLLBACK'); throw error }
    finally { own.release() }
  }
  assert.deepEqual(await f.manager.stopForRecovery(claim, lease), stopped(ready))
  assert.ok(reused >= 4, 'Every stop/proof path holding the owner lock must reuse its transaction')
})

async function executionFixture(t, state, cancel = false) {
  const f = await setup(t), ready = await f.manager.ensureReady(f.sessionId, f.userId, async () => {})
  const operationId = randomUUID(), id = randomUUID()
  await f.pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'Synthetic binding observation','{}','running')`, [operationId, f.sessionId, randomUUID()])
  const service = new ExecutionService({ pool: f.pool }, f.manager,
    { service: { async verify() { throw new Error('Legacy fixture never scans') } }, timeoutMs: 1000 }, 1, 10, 1000, 1000)
  const request = { id, command: 'synthetic-command', cwd: '', timeoutMs: 1000, instanceId: ready.runnerInstanceId }
  const row = (await f.pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,
    request_digest,state,cancel_requested,sandbox_name,pod_uid,runner_instance_id,lease_owner,lease_until)
    VALUES($1,$2,$3,$4,'owned-fixture',$5,'',$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '30 seconds') RETURNING *`,
  [id, f.userId, f.sessionId, operationId, request.command, createHash('sha256').update(JSON.stringify({ command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs })).digest('hex'), state, cancel, ready.name, ready.podUid,
    ready.runnerInstanceId, service.workerId])).rows[0]
  const result = { id, instanceId: ready.runnerInstanceId, state: 'running',
    digest: createHash('sha256').update(JSON.stringify(request)).digest('hex'), exitCode: null,
    stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }
  let observe = 0, provision = 0, dispatched = 0, cancelled = 0
  const oldObserve = f.manager.observeReady.bind(f.manager), oldProvision = f.manager.ensureReady.bind(f.manager)
  f.manager.observeReady = (...args) => { observe++; return oldObserve(...args) }
  f.manager.ensureReady = (...args) => { provision++; return oldProvision(...args) }
  const call = f.kube.call.bind(f.kube)
  f.kube.call = async (method, path, ...args) => {
    if (path.includes('/proxy/') && path.includes('/executions')) {
      if (method === 'GET') {
        if (state === 'starting') throw new KubernetesError(404, 'Synthetic execution not dispatched')
        return result
      }
      if (path.endsWith('/cancel')) { cancelled++; return { ...result, state: 'cancelled', stdout: 'actual cancellation' } }
      dispatched++; return result
    }
    return call(method, path, ...args)
  }
  await f.pool.query("UPDATE pe_workspaces SET binding_state='blocked' WHERE id=$1", [f.workspaceId])
  return { ...f, service, row, counts: () => ({ observe, provision, dispatched, cancelled }) }
}

test('existing cloud observations reuse their captured Sandbox during a binding fence and never provision or dispatch', options, async t => {
  const f = await executionFixture(t, 'running')
  await f.service.process(f.row, async () => {})
  assert.deepEqual(f.counts(), { observe: 1, provision: 0, dispatched: 0, cancelled: 0 })
  const stored = (await f.pool.query('SELECT state,error_code FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.deepEqual(stored, { state: 'running', error_code: null })
})

test('old cloud cancellation uses the captured writer despite the fence and records its actual outcome', options, async t => {
  const f = await executionFixture(t, 'running', true)
  await f.service.process(f.row, async () => {})
  assert.deepEqual(f.counts(), { observe: 1, provision: 0, dispatched: 0, cancelled: 1 })
  const stored = (await f.pool.query('SELECT state,result FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'cancelled'); assert.equal(stored.result.stdout, 'actual cancellation')
})

test('an undispatched cloud command cannot turn old writer observation into a new POST while the binding is fenced', options, async t => {
  const f = await executionFixture(t, 'starting')
  await f.service.process(f.row, async () => {})
  assert.deepEqual(f.counts(), { observe: 1, provision: 0, dispatched: 0, cancelled: 0 })
  const stored = (await f.pool.query('SELECT state,result,error_code FROM pe_cloud_executions WHERE id=$1', [f.row.id])).rows[0]
  assert.equal(stored.state, 'uncertain'); assert.equal(stored.result, null); assert.equal(stored.error_code, 'mount_workspace_recovering')
})
