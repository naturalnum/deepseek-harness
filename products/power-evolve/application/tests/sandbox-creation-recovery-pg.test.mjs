/** Run with an explicit PE_TEST_DATABASE_URL; the shared fixture owns a fresh database, never the QA database. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { ExecutionService } from '../lib/platform/executions.js'
import { transaction } from '../lib/platform/database.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { FileService } from '../lib/platform/files.js'

const createSandboxFixture = process.env.PE_TEST_DATABASE_URL
  ? (await import('./sandbox-binding-fixture.mjs')).createSandboxFixture : null
const options = { timeout: 30000, skip: !createSandboxFixture }

async function pending(t, disconnectFinalizer = false, throughExecution = false) {
  const f = await createSandboxFixture(t, { readyTimeoutMs: 100, nodeRoot: '', volumeClaimName: 'owned-posix' })
  const userId = await f.createUser(), { sessionId, workspaceId } = await f.createSession(userId)
  const call = f.kube.call.bind(f.kube), name = f.manager.name(userId)
  let failPatch = disconnectFinalizer
  let initialSandbox = true
  let runnerPosts = 0
  f.kube.call = async (method, path, ...args) => {
    if (method === 'POST' && path.includes('/proxy/')) runnerPosts++
    if (method === 'PATCH' && failPatch) {
      failPatch = false
      throw new Error('finalizer response disconnected')
    }
    const value = await call(method, path, ...args)
    if (method === 'POST' && path.endsWith('/sandboxes') && initialSandbox) {
      initialSandbox = false
      f.kube.resource('sandboxes', name).status.conditions[0].status = 'False'
      f.kube.resource('pods', name).status = { phase: 'Pending',
        containerStatuses: [{ name: 'runner', ready: false, restartCount: 0,
          state: { waiting: { reason: 'ImagePullBackOff' } } }] }
    }
    return value
  }
  let service, executionId
  if (throughExecution) {
    service = executionService(f)
    const operationId = randomUUID()
    executionId = randomUUID()
    await f.pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
      VALUES($1,$2,$3,'Synthetic creation cancellation','{}','completed')`, [operationId, sessionId, randomUUID()])
    await f.pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state)
      VALUES($1,$2,$3,$4,'creation-call','must-not-dispatch','','fixture','queued')`, [executionId, userId, sessionId, operationId])
    await service.processLeased(await service.claim())
    const execution = (await f.pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [executionId])).rows[0]
    assert.equal(execution.state, 'uncertain')
    assert.equal(execution.error_code, 'mount_creation_unconfirmed')
    assert.deepEqual([execution.sandbox_name, execution.pod_uid, execution.runner_instance_id], [null, null, null])
  } else {
    await assert.rejects(f.manager.ensureReady(sessionId, userId, async () => {}),
      disconnectFinalizer ? /finalizer response disconnected/ : /mount_creation_unconfirmed/)
  }
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
  return { ...f, userId, sessionId, workspaceId, name, slot, instance, pod, service, executionId,
    runnerPosts: () => runnerPosts }
}

function executionService(f, manager = f.manager) {
  return new ExecutionService({ pool: f.pool }, manager,
    { service: { async verify() { throw new Error('Creation cleanup must not scan Runner files') } }, timeoutMs: 1000 },
    2, 5, 1000, 1000, 5000)
}

async function state(f) {
  const [slot, instance, execution] = await Promise.all([
    f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId]),
    f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [f.sessionId]),
    f.pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [f.executionId]),
  ])
  return { slot: slot.rows[0], instance: instance.rows[0], execution: execution.rows[0] }
}

async function processNext(f, service = f.service) {
  await delay(10)
  const row = await service.claim()
  assert.equal(row?.id, f.executionId, 'the original execution remains claimable for creation cleanup')
  await service.processLeased(row)
}

function restarting(f) {
  const manager = new SandboxManager(f.kube, f.files, f.pool, 'test-key', f.managerOptions)
  manager.home = f.manager.home
  return { manager, service: executionService(f, manager) }
}

function stopControl(f, { unscheduled = false, disconnectPatch = false } = {}) {
  f.kube.supplyStopProof = false
  if (unscheduled) delete f.pod.spec.nodeName
  const control = { confirmed: false, disconnectPatch, proofObserved: 0, parentDeletes: 0 }
  const call = f.kube.call.bind(f.kube)
  f.kube.call = async (method, path, body, ...args) => {
    if (method === 'DELETE' && path.endsWith('/sandboxes/' + f.name)) {
      assert.equal(body.propagationPolicy, 'Background')
      assert.equal(body.preconditions.uid, f.kube.resource('sandboxes', f.name).metadata.uid)
      control.parentDeletes++
    }
    const removing = method === 'PATCH' && path.endsWith('/pods/' + f.name)
      && !body.metadata.finalizers.includes('powerevolve.dev/retain-stop-observation')
    if (removing) {
      const current = await state(f)
      assert.equal(current.slot.state, 'reserved')
      assert.equal(current.instance.state, 'deleting')
      assert.equal(current.slot.stop_pod_uid, f.instance.pod_uid)
      assert.equal(current.instance.stop_pod_uid, f.instance.pod_uid)
      assert.deepEqual(current.slot.stop_evidence, current.instance.stop_evidence)
      assert.equal(current.slot.stop_evidence.status, unscheduled ? 'UNSCHEDULED_DELETING' : 'KUBELET_STOPPED')
      assert.equal(current.slot.stop_evidence.runnerInstanceId, null)
      assert.deepEqual(current.slot.stop_evidence.bindingSnapshot, f.slot.binding_snapshot)
      assert.equal(body.metadata.uid, f.instance.pod_uid)
      control.proofObserved++
    }
    const result = await call(method, path, body, ...args)
    const pod = f.kube.resource('pods', f.name)
    if (pod?.metadata.deletionTimestamp && control.confirmed) {
      pod.status = { phase: 'Failed', conditions: unscheduled ? []
        : [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: pod.metadata.generation }],
      containerStatuses: [{ name: 'runner', ready: false, restartCount: 0,
        state: { waiting: { reason: 'ImagePullBackOff' } } }] }
    }
    if (removing && control.disconnectPatch) {
      control.disconnectPatch = false
      throw new Error('finalizer removal response disconnected after application')
    }
    return result
  }
  return control
}

async function assertReserved(f, deleting = true) {
  const current = await state(f)
  assert.equal(current.slot.state, 'reserved')
  assert.deepEqual([current.slot.pod_uid, current.slot.runner_instance_id], [null, null])
  assert.equal(current.slot.generation, f.slot.generation)
  assert.deepEqual(current.slot.binding_snapshot, f.slot.binding_snapshot)
  assert.equal(current.instance.state, deleting ? 'deleting' : 'creating')
  assert.equal(current.instance.pod_uid, f.instance.pod_uid)
  assert.equal(current.instance.runner_instance_id, null)
  assert.equal(current.execution.state, 'uncertain')
  assert.equal(f.runnerPosts(), 0)
  return current
}

async function wrongProof(f, changed) {
  const evidence = { status: 'KUBELET_STOPPED', podUid: f.instance.pod_uid, generation: f.slot.generation,
    sandboxUid: f.kube.resource('sandboxes', f.name).metadata.uid, sessionId: f.sessionId,
    runnerInstanceId: null, bindingSnapshot: f.slot.binding_snapshot, ...changed }
  await f.pool.query('UPDATE pe_mount_slots SET stop_pod_uid=$2,stop_evidence=$3::jsonb WHERE user_id=$1',
    [f.userId, f.instance.pod_uid, JSON.stringify(evidence)])
  await f.pool.query('UPDATE pe_sandbox_instances SET stop_pod_uid=$2,stop_evidence=$3::jsonb WHERE session_id=$1',
    [f.sessionId, f.instance.pod_uid, JSON.stringify(evidence)])
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

test('creating cancellation and account revocation retain their lease reconciliation until the original Pod stops', options, async t => {
  for (const revoke of [false, true]) await t.test(revoke ? 'account revoked' : 'owner cancelled', async t => {
    const f = await pending(t, false, true), control = stopControl(f)
    if (revoke) {
      await transaction(f.pool, async client => {
        await lockAccountAuthorities(client, [f.userId], 'update')
        await client.query('UPDATE pe_users SET enabled=false,account_revision=account_revision+1 WHERE id=$1', [f.userId])
        await revokeAccountExecutions(client, f.userId)
      })
      const files = new FileService(f.pool, join(f.localRoot, 'workspaces'))
      await files.init()
      await assert.rejects(transaction(f.pool, client => files.bindingForId(f.userId, f.workspaceId, client)), { code: 'account_disabled' })
      f.files = files
      f.manager = new SandboxManager(f.kube, files, f.pool, 'test-key', f.managerOptions)
      f.service = executionService(f)
    } else await f.service.cancel({ userId: f.userId }, f.executionId)
    await processNext(f)
    const blocked = await assertReserved(f)
    assert.equal(blocked.execution.cancel_requested, true)
    assert.equal(blocked.slot.stop_evidence, null)
    assert.equal(blocked.instance.stop_evidence, null)
    const other = await f.createSession(f.userId)
    const mutations = f.kube.mutations.length
    await assert.rejects(f.manager.ensureReady(other.sessionId, f.userId, async () => {}),
      revoke ? { code: 'account_disabled' } : /mount_slot_reserved/)
    assert.equal(f.kube.mutations.length, mutations)
    control.confirmed = true
    await processNext(f, restarting(f).service)
    const finished = await state(f)
    assert.equal(finished.execution.state, 'cancelled')
    assert.equal(finished.slot.state, 'free')
    assert.equal(finished.instance.state, 'deleted')
    assert.equal(control.parentDeletes, 1, 'a deleting parent is never recreated or deleted again')
    assert.equal(f.runnerPosts(), 0)
    const continuations = await f.pool.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1", [f.executionId])
    assert.equal(continuations.rows[0].n, revoke ? 0 : 1)
    if (revoke) {
      assert.equal(finished.execution.error_code, 'account_disabled')
      await f.pool.query('UPDATE pe_users SET enabled=true WHERE id=$1', [f.userId])
      assert.equal(await restarting(f).service.claim(), null)
      assert.equal(f.runnerPosts(), 0)
    }
  })
})

test('a restarted worker resumes creating cleanup before proof and after a disconnected finalizer removal', options, async t => {
  for (const disconnectPatch of [false, true]) await t.test(disconnectPatch ? 'proof committed and PATCH applied' : 'stop not yet observed', async t => {
    const f = await pending(t, false, true), control = stopControl(f, { disconnectPatch })
    await f.service.cancel({ userId: f.userId }, f.executionId)
    control.confirmed = disconnectPatch
    await processNext(f)
    const blocked = await assertReserved(f)
    assert.equal(Boolean(blocked.slot.stop_evidence), disconnectPatch)
    assert.equal(Boolean(f.kube.resource('pods', f.name)), !disconnectPatch)
    control.confirmed = true
    const fresh = restarting(f)
    await processNext(f, fresh.service)
    const finished = await state(f)
    assert.equal(finished.slot.state, 'free')
    assert.equal(finished.instance.state, 'deleted')
    assert.equal(finished.execution.state, 'cancelled')
    assert.equal(finished.slot.generation, f.slot.generation)
    assert.deepEqual(finished.instance.binding_snapshot, f.instance.binding_snapshot)
    assert.equal(f.runnerPosts(), 0)
    assert.equal(f.kube.mutations.filter(m => m.method === 'POST' && m.resource === 'sandboxes').length, 1)
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_operations WHERE source_execution_id=$1', [f.executionId])).rows[0].n, 1)
  })
})

test('native creation stop evidence precedes free and a different Session acquires the next generation', options, async t => {
  for (const unscheduled of [false, true]) await t.test(unscheduled ? 'never scheduled' : 'assigned but image never started', async t => {
    const f = await pending(t, false, true), control = stopControl(f, { unscheduled })
    await f.service.cancel({ userId: f.userId }, f.executionId)
    control.confirmed = true
    await processNext(f)
    const finished = await state(f)
    assert.equal(control.proofObserved, 1)
    assert.equal(finished.execution.state, 'cancelled')
    assert.equal(finished.slot.state, 'free')
    assert.equal(finished.instance.state, 'deleted')
    assert.deepEqual([finished.instance.pod_uid, finished.instance.runner_instance_id], [null, null])
    assert.equal(finished.instance.stop_pod_uid, f.instance.pod_uid)
    assert.equal(finished.instance.stop_evidence.status, unscheduled ? 'UNSCHEDULED_DELETING' : 'KUBELET_STOPPED')
    assert.equal(finished.slot.generation, f.slot.generation)
    const next = await f.createSession(f.userId, { spaceId: f.slot.binding_snapshot.spaceId,
      rootKey: f.slot.binding_snapshot.rootKey, rootRelativePath: f.slot.binding_snapshot.rootRelativePath })
    const ready = await f.manager.ensureReady(next.sessionId, f.userId, async () => {})
    assert.equal(BigInt(ready.generation), BigInt(f.slot.generation) + 1n)
    assert.notEqual(ready.podUid, f.instance.pod_uid)
    assert.ok(ready.runnerInstanceId)
    assert.equal(ready.binding.rootKey, f.slot.binding_snapshot.rootKey)
    assert.equal(f.kube.mutations.filter(m => m.method === 'POST' && m.resource === 'sandboxes').length, 2)
    assert.equal(f.runnerPosts(), 0)
    assert.equal((await state(f)).execution.state, 'cancelled')
  })
})

test('creating cleanup refuses missing identity, replacement resources, invalid proof and stale leases', options, async t => {
  const cases = [
    ['Pod missing', f => f.kube.resources.delete('pods/' + f.name)],
    ['Pod replaced', f => { f.pod.metadata.uid = randomUUID() }],
    ['parent replaced', f => { f.kube.resource('sandboxes', f.name).metadata.uid = randomUUID() }],
    ['unknown parent finalizer', f => { f.kube.resource('sandboxes', f.name).metadata.finalizers = ['foreign/retain'] }],
    ['parent missing before intent', f => f.kube.resources.delete('sandboxes/' + f.name)],
    ['Service missing before proof', f => f.kube.resources.delete('services/' + f.name)],
    ['Secret missing before proof', f => f.kube.resources.delete('secrets/' + f.name)],
    ['UID not captured', f => f.pool.query('UPDATE pe_sandbox_instances SET pod_uid=NULL WHERE session_id=$1', [f.sessionId])],
    ['binding changed', f => f.pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [f.workspaceId])],
    ['proof generation wrong', f => wrongProof(f, { generation: String(BigInt(f.slot.generation) + 1n) })],
    ['proof UID wrong', f => wrongProof(f, { podUid: randomUUID() })],
    ['proof binding wrong', f => wrongProof(f, { bindingSnapshot: { ...f.slot.binding_snapshot, rootRelativePath: 'foreign' } })],
    ['proof Runner identity fabricated', f => wrongProof(f, { runnerInstanceId: randomUUID() })],
  ]
  for (const [label, change] of cases) await t.test(label, async t => {
    const f = await pending(t, false, true), control = stopControl(f)
    control.confirmed = true
    await f.service.cancel({ userId: f.userId }, f.executionId)
    await change(f)
    const before = f.kube.mutations.length
    await processNext(f)
    const current = await state(f)
    assert.equal(current.slot.state, 'reserved')
    assert.notEqual(current.instance.state, 'deleted')
    assert.equal(current.slot.generation, f.slot.generation)
    assert.deepEqual(current.slot.binding_snapshot, f.slot.binding_snapshot)
    assert.equal(current.execution.state, 'uncertain')
    assert.equal(current.execution.cancel_requested, true)
    assert.equal(current.execution.runner_instance_id, null)
    assert.equal(f.runnerPosts(), 0)
    assert.equal(f.kube.mutations.length, before, 'identity failures cannot mutate any resource')
    const next = await f.createSession(f.userId)
    await assert.rejects(f.manager.ensureReady(next.sessionId, f.userId, async () => {}), /mount_/)
  })
  await t.test('old worker lease lost', async t => {
    const f = await pending(t, false, true), control = stopControl(f)
    await f.service.cancel({ userId: f.userId }, f.executionId)
    await delay(10)
    const row = await f.service.claim(), before = f.kube.mutations.length
    await f.pool.query('UPDATE pe_cloud_executions SET lease_owner=$2 WHERE id=$1', [f.executionId, randomUUID()])
    control.confirmed = true
    await f.service.process(row, async () => {})
    await assertReserved(f, false)
    assert.equal(f.kube.mutations.length, before)
  })
  await t.test('only deletionTimestamp and Failed phase', async t => {
    const f = await pending(t, false, true)
    stopControl(f)
    await f.service.cancel({ userId: f.userId }, f.executionId)
    await processNext(f)
    f.pod.status.phase = 'Failed'
    await processNext(f, restarting(f).service)
    const current = await assertReserved(f)
    assert.equal(current.slot.stop_evidence, null)
    assert.ok(f.pod.metadata.finalizers.includes('powerevolve.dev/retain-stop-observation'))
    assert.equal(f.kube.mutations.filter(m => m.method === 'PATCH' && !m.body.metadata.finalizers.length).length, 0)
  })
})

test('late Ready observation cannot revive a deleting creation or overwrite a new generation', options, async t => {
  for (const finishCleanup of [false, true]) await t.test(finishCleanup ? 'after free and next generation' : 'while deleting', async t => {
    const f = await pending(t, false, true), control = stopControl(f)
    f.kube.resource('sandboxes', f.name).status.conditions[0].status = 'True'
    f.pod.status = { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] }
    let release, entered, healthSeen = false, paused = false
    const barrier = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { entered = resolve })
    const call = f.kube.call.bind(f.kube)
    f.kube.call = async (method, path, ...args) => {
      const result = await call(method, path, ...args)
      if (path.endsWith('/health')) healthSeen = true
      if (!paused && healthSeen && method === 'GET' && path.endsWith('/pods/' + f.name)) {
        paused = true
        entered()
        await barrier
      }
      return result
    }
    const old = f.manager.ensureReady(f.sessionId, f.userId, async () => {}).then(() => null, error => error)
    try {
      await Promise.race([reached, delay(2000).then(() => { throw new Error('late Ready barrier not reached') })])
      await f.service.cancel({ userId: f.userId }, f.executionId)
      control.confirmed = finishCleanup
      await processNext(f)
      let ready
      if (finishCleanup) {
        const next = await f.createSession(f.userId)
        ready = await f.manager.ensureReady(next.sessionId, f.userId, async () => {})
      } else await assertReserved(f)
      const mutations = f.kube.mutations.length
      release()
      assert.match(String(await old), /mount_/)
      const current = await state(f)
      assert.equal(current.instance.state, finishCleanup ? 'deleted' : 'deleting')
      if (ready) {
        assert.equal(current.slot.pod_uid, ready.podUid)
        assert.equal(current.slot.generation, ready.generation)
      }
      assert.equal(f.kube.mutations.length, mutations)
      assert.deepEqual([current.execution.sandbox_name, current.execution.pod_uid, current.execution.runner_instance_id], [null, null, null])
      assert.equal(f.runnerPosts(), 0)
    } finally { release(); await old }
  })
})

test('an uncancelled uncertain creation retains its original writer and can still dispatch once', options, async t => {
  const f = await pending(t, false, true), before = f.kube.mutations.length
  await restarting(f).manager.recycleIdle(0)
  const current = await assertReserved(f, false)
  assert.equal(current.execution.cancel_requested, false)
  assert.equal(current.slot.stop_evidence, null)
  assert.equal(f.kube.mutations.length, before)
  f.kube.resource('sandboxes', f.name).status.conditions[0].status = 'True'
  f.pod.status = { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] }
  const call = f.kube.call.bind(f.kube)
  let posts = 0
  f.kube.call = async (method, path, body, ...args) => {
    if (method === 'POST' && path.includes('/proxy/') && path.endsWith('/executions')) {
      posts++
      return { id: body.id, instanceId: body.instanceId, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        state: 'succeeded', exitCode: 0, stdout: 'one first dispatch', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, timedOut: false }
    }
    return call(method, path, body, ...args)
  }
  await processNext(f, restarting(f).service)
  const finished = await state(f)
  assert.equal(finished.execution.state, 'succeeded')
  assert.equal(finished.slot.state, 'ready')
  assert.equal(finished.slot.pod_uid, f.instance.pod_uid)
  assert.equal(finished.slot.generation, f.slot.generation)
  assert.equal(finished.slot.stop_evidence, null)
  assert.equal(posts, 1)
})
