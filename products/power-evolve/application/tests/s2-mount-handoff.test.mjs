/** S2 writable Home handoff against isolated PostgreSQL and deterministic Kubernetes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSandboxFixture as fixture } from './sandbox-binding-fixture.mjs'

test('S2 new Sandboxes receive the configured file scan budgets', { timeout: 30000 }, async t => {
  const fileScan = { maxEntries: 123, maxHashBytes: 456789, timeoutMs: 750, maxSnapshotBytes: 16384, maxFiles: 7 }
  const { kube, manager, createSession, createUser } = await fixture(t, { fileScan })
  const userId = await createUser(), session = await createSession(userId)
  const sandbox = await manager.ensureReady(session.sessionId, userId, async () => {})
  const expected = {
    PE_RUNNER_SCAN_MAX_ENTRIES: '123', PE_RUNNER_SCAN_MAX_HASH_BYTES: '456789',
    PE_RUNNER_SCAN_TIMEOUT_MS: '750', PE_RUNNER_SCAN_MAX_SNAPSHOT_BYTES: '16384', PE_RUNNER_SCAN_MAX_FILES: '7',
  }
  for (const resource of [kube.resource('sandboxes', sandbox.name).spec.podTemplate, kube.resource('pods', sandbox.name)]) {
    const runner = resource.spec.containers.find(container => container.name === 'runner')
    assert.deepEqual(Object.fromEntries(runner.env.map(({ name, value }) => [name, value])), expected)
  }
})

test('S7d PVC mounts only exact user paths and refuses a changed Home subPath',
  { timeout: 30000 }, async t => {
    const { pool, kube, manager, createSession, createUser } = await fixture(t,
      { nodeRoot: '', volumeClaimName: 'pe-shared-posix' })
    const alice = await createUser(), bob = await createUser()
    const a = await createSession(alice), b = await createSession(bob)
    const first = await manager.ensureReady(a.sessionId, alice, async () => {})
    const second = await manager.ensureReady(b.sessionId, bob, async () => {})
    for (const [userId, session, sandbox] of [[alice, a, first], [bob, b, second]]) {
      const pod = kube.resource('pods', sandbox.name)
      const template = kube.resource('sandboxes', sandbox.name).spec.podTemplate.spec
      for (const spec of [template, pod.spec]) {
        assert.equal(spec.automountServiceAccountToken, false)
        assert.equal(spec.serviceAccountName, 'power-evolve-runner')
        assert.equal(spec.containers[0].imagePullPolicy, 'IfNotPresent')
        assert.equal(spec.volumes.some(volume => volume.hostPath), false)
        for (const [name, subPath] of [
          ['workspace', `workspaces/${session.workspaceId}`],
          ['home', `homes/${userId}`],
          ['skill-packages', `skill-packages/${userId}`],
        ]) {
          const volume = spec.volumes.find(volume => volume.name === name)
          const mount = spec.containers[0].volumeMounts.find(mount => mount.name === name)
          assert.equal(volume.persistentVolumeClaim.claimName, 'pe-shared-posix')
          assert.equal(mount.subPath, subPath)
          assert.equal(mount.readOnly === true, name === 'skill-packages')
        }
        assert.equal(spec.containers[0].volumeMounts.some(mount => mount.mountPath === '/data'), false)
      }
    }
    assert.notEqual(a.workspaceId, b.workspaceId)
    kube.resource('pods', first.name).spec.containers[0].volumeMounts
      .find(mount => mount.name === 'home').subPath = `homes/${bob}`
    await assert.rejects(manager.ensureReady(a.sessionId, alice, async () => {}), /mount_instance_changed/)
    assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [alice])).rows[0].state,
      'unknown')
    assert.equal(kube.resource('pods', first.name).metadata.uid, first.podUid)
  })

test('S5 Sandboxes mount only their user package tree read-only and reuse the matching Pod',
  { timeout: 30000 }, async t => {
    const { kube, manager, createSession, createUser } = await fixture(t)
    const alice = await createUser(), bob = await createUser()
    const aliceSession = await createSession(alice), bobSession = await createSession(bob)
    const first = await manager.ensureReady(aliceSession.sessionId, alice, async () => {})
    const second = await manager.ensureReady(bobSession.sessionId, bob, async () => {})
    for (const [userId, sandbox] of [[alice, first], [bob, second]]) {
      const resource = kube.resource('sandboxes', sandbox.name)
      const pod = kube.resource('pods', sandbox.name)
      for (const spec of [resource.spec.podTemplate.spec, pod.spec]) {
        const volume = spec.volumes.find(entry => entry.name === 'skill-packages')
        const mount = spec.containers.find(entry => entry.name === 'runner').volumeMounts
          .find(entry => entry.name === 'skill-packages')
        assert.equal(volume.hostPath.path.endsWith(`/skill-packages/${userId}`), true)
        assert.equal(volume.hostPath.type, 'Directory')
        assert.deepEqual(mount, { name: 'skill-packages', mountPath: '/opt/power-evolve/skills', readOnly: true })
        assert.equal(spec.volumes.some(entry => entry.name === 'skill-packages'
          && entry.hostPath.path.endsWith(`/skill-packages/${userId === alice ? bob : alice}`)), false)
      }
    }
    const count = kube.mutations.length
    assert.deepEqual(await manager.ensureReady(aliceSession.sessionId, alice, async () => {}), first)
    assert.equal(kube.mutations.length, count)
  })

test('S5 old running Pod without skill mount is quarantined rather than reused', { timeout: 30000 }, async t => {
  const { pool, kube, manager, createSession, createUser } = await fixture(t)
  const userId = await createUser(), session = await createSession(userId)
  const ready = await manager.ensureReady(session.sessionId, userId, async () => {})
  const pod = kube.resource('pods', ready.name)
  pod.spec.containers[0].volumeMounts = pod.spec.containers[0].volumeMounts
    .filter(entry => entry.name !== 'skill-packages')
  const before = kube.mutations.length
  await assert.rejects(manager.ensureReady(session.sessionId, userId, async () => {}),
    /mount_instance_changed/)
  const slot = (await pool.query('SELECT state,pod_uid FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0]
  assert.deepEqual(slot, { state: 'unknown', pod_uid: ready.podUid })
  assert.equal(kube.mutations.length, before)
  assert.equal(kube.resource('pods', ready.name).metadata.uid, ready.podUid)
})

test('S5 changed Sandbox template is quarantined before another runner call', { timeout: 30000 }, async t => {
  const { pool, kube, manager, createSession, createUser } = await fixture(t)
  const userId = await createUser(), session = await createSession(userId)
  const ready = await manager.ensureReady(session.sessionId, userId, async () => {})
  const resource = kube.resource('sandboxes', ready.name)
  resource.spec.podTemplate.spec.volumes.find(entry => entry.name === 'skill-packages').hostPath.path =
    '/outside/user-package-tree'
  await assert.rejects(manager.assertCurrent(ready), /mount_instance_changed/)
  assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0].state,
    'unknown')
})

test('S5 refuses a symlinked package mount source before Kubernetes creation', { timeout: 30000 }, async t => {
  const { pool, kube, manager, localRoot, createSession, createUser } = await fixture(t)
  const userId = await createUser(), session = await createSession(userId), next = await createSession(userId)
  await mkdir(join(localRoot, 'skill-packages'), { recursive: true })
  const packageRoot = join(localRoot, 'skill-packages', userId)
  await symlink(tmpdir(), packageRoot)
  await assert.rejects(manager.ensureReady(session.sessionId, userId, async () => {}),
    /mount_skill_package_root_unavailable/)
  assert.equal(kube.mutations.length, 0)
  assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [userId])).rowCount, 0)
  assert.equal((await pool.query('SELECT state FROM pe_sandbox_instances WHERE session_id=$1',
    [session.sessionId])).rowCount, 0)
  await rm(packageRoot)
  await mkdir(packageRoot, { mode: 0o755 })
  const ready = await manager.ensureReady(next.sessionId, userId, async () => {})
  assert.equal(ready.sessionId, next.sessionId)
})

test('S5 invalid package permissions leave no reservation before a different Session starts',
  { timeout: 30000 }, async t => {
    const { pool, kube, manager, localRoot, createSession, createUser } = await fixture(t, {}, 1)
    const userId = await createUser(), session = await createSession(userId), next = await createSession(userId)
    const packageRoot = join(localRoot, 'skill-packages', userId)
    await mkdir(packageRoot, { recursive: true, mode: 0o700 })
    await assert.rejects(manager.ensureReady(session.sessionId, userId, async () => {}),
      /mount_skill_package_root_unavailable/)
    assert.equal(kube.mutations.length, 0)
    assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [userId])).rowCount, 0)
    assert.equal((await pool.query('SELECT state FROM pe_sandbox_instances WHERE session_id=$1',
      [session.sessionId])).rowCount, 0)
    await chmod(packageRoot, 0o755)
    const ready = await manager.ensureReady(next.sessionId, userId, async () => {})
    assert.equal(ready.sessionId, next.sessionId)
})

test('S2 serial handoff retains exact stopped Pod proof and distinct Session runners', { timeout: 30000 }, async t => {
  const { pool, kube, manager, createSession, createUser } = await fixture(t)
  const userId = await createUser()
  const a = await createSession(userId), b = await createSession(userId)
  const first = await manager.ensureReady(a.sessionId, userId, async () => {})
  assert.equal(first.name, manager.name(userId))
  const otherUserId = await createUser(), other = await createSession(otherUserId)
  const independent = await manager.ensureReady(other.sessionId, otherUserId, async () => {})
  assert.notEqual(independent.name, first.name)
  assert.equal(kube.resource('pods', independent.name).metadata.uid, independent.podUid)
  const operationId = randomUUID(), executionId = randomUUID()
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'test','{}','running')`, [operationId, a.sessionId, randomUUID()])
  await pool.query(`INSERT INTO pe_cloud_executions
    (id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state)
    VALUES($1,$2,$3,$4,'call','true','','digest','queued')`, [executionId, userId, a.sessionId, operationId])
  await assert.rejects(manager.ensureReady(b.sessionId, userId, async () => {}), /mount_slot_busy/)
  assert.equal(kube.resource('pods', first.name).metadata.uid, first.podUid)
  await pool.query("UPDATE pe_cloud_executions SET state='succeeded' WHERE id=$1", [executionId])
  const second = await manager.ensureReady(b.sessionId, userId, async () => {})
  assert.equal(second.name, first.name)
  assert.notEqual(second.podUid, first.podUid)
  assert.notEqual(second.runnerInstanceId, first.runnerInstanceId)
  assert.notEqual(second.generation, first.generation)
  const prior = (await pool.query('SELECT state,stop_pod_uid,stop_evidence FROM pe_sandbox_instances WHERE session_id=$1',
    [a.sessionId])).rows[0]
  assert.equal(prior.state, 'deleted')
  assert.equal(prior.stop_pod_uid, first.podUid)
  assert.equal(prior.stop_evidence.status, 'KUBELET_STOPPED')
  assert.equal((await pool.query('SELECT state,session_id,pod_uid FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0].pod_uid,
    second.podUid)
  await assert.rejects(manager.assertCurrent(first), /mount_slot_changed/)
  const before = kube.mutations.length
  await assert.rejects(manager.createReserved({ user_id: userId, session_id: a.sessionId,
    workspace_id: a.workspaceId, generation: first.generation }, a.workspaceId, async () => {}),
  /mount_reservation_changed/)
  await assert.rejects(manager.ensureReady(a.sessionId, userId, async () => { throw new Error('old lease lost') }),
    /old lease lost/)
  assert.equal(kube.mutations.length, before)
})

test('S2 creation crash leaves durable reservation and refuses a second Session', { timeout: 30000 }, async t => {
  const { pool, kube, manager, createSession, createUser } = await fixture(t)
  const userId = await createUser()
  const a = await createSession(userId), b = await createSession(userId)
  kube.failServiceCreate = true
  await assert.rejects(manager.ensureReady(a.sessionId, userId, async () => {}), /simulated creation crash/)
  const slot = (await pool.query('SELECT state,session_id,pod_uid FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0]
  assert.deepEqual([slot.state, slot.session_id, slot.pod_uid], ['reserved', a.sessionId, null])
  const before = kube.mutations.length
  await assert.rejects(manager.ensureReady(b.sessionId, userId, async () => {}), /mount_slot_reserved/)
  assert.equal(kube.mutations.length, before)
})

test('S2 missing kubelet stop proof cannot release slot or mount second Session', { timeout: 30000 }, async t => {
  const { pool, kube, manager, createSession, createUser } = await fixture(t)
  const userId = await createUser()
  const a = await createSession(userId), b = await createSession(userId)
  const first = await manager.ensureReady(a.sessionId, userId, async () => {})
  kube.supplyStopProof = false
  await assert.rejects(manager.ensureReady(b.sessionId, userId, async () => {}), /mount_stop_unconfirmed/)
  const slot = (await pool.query('SELECT state,session_id,pod_uid,stop_evidence FROM pe_mount_slots WHERE user_id=$1',
    [userId])).rows[0]
  assert.equal(slot.state, 'stopping')
  assert.equal(slot.session_id, a.sessionId)
  assert.equal(slot.pod_uid, first.podUid)
  assert.equal(slot.stop_evidence, null)
  assert.equal(kube.resource('pods', first.name).metadata.uid, first.podUid)
  assert.equal(kube.mutations.filter(value => value.method === 'POST' && value.resource === 'sandboxes').length, 1)
})
