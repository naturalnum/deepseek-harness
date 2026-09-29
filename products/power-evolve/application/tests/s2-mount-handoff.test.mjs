/** S2 writable Home handoff against isolated PostgreSQL and deterministic Kubernetes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { initializeDatabase } from '../lib/platform/database.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { SandboxManager } from '../lib/platform/sandbox.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

class FakeKubernetes {
  resources = new Map()
  mutations = []
  instances = new Map()
  supplyStopProof = true
  failServiceCreate = false
  resourcePath(namespace, resource, name) { return `/${namespace}/${resource}${name ? `/${name}` : ''}` }
  proxyPath(namespace, service, path) { return `/${namespace}/proxy/${service}${path}` }
  resource(resource, name) { return this.resources.get(`${resource}/${name}`) }
  async call(method, path, body) {
    const segments = path.split('/').filter(Boolean)
    if (segments[1] === 'proxy') {
      const name = segments[2]
      if (method !== 'GET' || segments[3] !== 'health' || !this.resource('sandboxes', name)) {
        throw new KubernetesError(404, 'runner missing')
      }
      return { ready: true, instanceId: this.instances.get(name) }
    }
    const [, resource, name] = segments
    const key = `${resource}/${name}`
    if (method === 'GET') {
      const value = this.resources.get(key)
      if (!value) throw new KubernetesError(404, 'missing')
      return structuredClone(value)
    }
    this.mutations.push({ method, resource, name, body })
    if (method === 'POST') {
      if (resource === 'services' && this.failServiceCreate) throw new Error('simulated creation crash')
      const id = body.metadata.name
      const value = structuredClone(body)
      value.metadata.uid = randomUUID()
      value.metadata.resourceVersion = '1'
      if (resource === 'secrets') value.data = { token: Buffer.from(body.stringData.token).toString('base64') }
      if (resource === 'sandboxes') {
        value.status = { conditions: [{ type: 'Ready', status: 'True' }] }
        this.instances.set(id, randomUUID())
        const pod = { metadata: { name: id, uid: randomUUID(), resourceVersion: '1', generation: 1,
          labels: structuredClone(body.metadata.labels), ownerReferences: [{ uid: value.metadata.uid }], finalizers: [] },
        spec: { ...structuredClone(body.spec.podTemplate.spec), nodeName: 'test-node' },
        status: { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] } }
        this.resources.set(`pods/${id}`, pod)
      }
      this.resources.set(`${resource}/${id}`, value)
      return structuredClone(value)
    }
    const value = this.resources.get(key)
    if (!value) throw new KubernetesError(404, 'missing')
    if (method === 'DELETE') {
      if (body?.preconditions?.uid !== value.metadata.uid) throw new KubernetesError(409, 'UID changed')
      if (resource === 'sandboxes') {
        const pod = this.resource('pods', name)
        if (pod) {
          pod.metadata.deletionTimestamp = '2026-09-29T00:00:00Z'
          if (this.supplyStopProof) {
            const containerID = `containerd://${'a'.repeat(64)}`
            pod.status = { phase: 'Failed', conditions: [
              { type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
            containerStatuses: [{ name: 'runner', ready: false, restartCount: 0, containerID,
              state: { terminated: { containerID, exitCode: 0,
                startedAt: '2026-09-28T23:59:00Z', finishedAt: '2026-09-29T00:00:01Z' } } }] }
          }
        }
      } else this.resources.delete(key)
      return null
    }
    if (method === 'PATCH' && resource === 'pods') {
      if (body.metadata.resourceVersion !== value.metadata.resourceVersion) throw new KubernetesError(409, 'version changed')
      value.metadata.finalizers = body.metadata.finalizers
      value.metadata.resourceVersion = '2'
      if (value.metadata.deletionTimestamp && !value.metadata.finalizers.length) {
        this.resources.delete(key)
        this.resources.delete(`sandboxes/${name}`)
      }
      return structuredClone(value)
    }
    throw new Error(`Unexpected Kubernetes ${method} ${path}`)
  }
}

async function fixture(t) {
  const admin = new Pool({ connectionString: databaseUrl })
  const name = `pe_s2_${randomBytes(10).toString('hex')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(databaseUrl); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href })
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE "${name}"`); await admin.end() })
  await initializeDatabase(pool)
  const version = Number((await pool.query('SELECT version FROM pe_schema')).rows[0].version)
  if (version === 8) {
    await pool.query(`ALTER TABLE pe_workspaces DROP CONSTRAINT pe_workspaces_user_id_key;
      ALTER TABLE pe_sessions ADD COLUMN workspace_id uuid REFERENCES pe_workspaces(id);
      ALTER TABLE pe_sandbox_instances DROP CONSTRAINT pe_sandbox_instances_name_key;
      CREATE UNIQUE INDEX pe_sandbox_instances_active_name ON pe_sandbox_instances(name) WHERE state <> 'deleted';
      CREATE TABLE pe_mount_slots (user_id uuid PRIMARY KEY REFERENCES pe_users(id),
        session_id uuid REFERENCES pe_sessions(id), workspace_id uuid REFERENCES pe_workspaces(id),
        generation bigint NOT NULL DEFAULT 0, state text NOT NULL CHECK
          (state IN ('free','reserved','ready','stopping','unknown')),
        pod_uid uuid, runner_instance_id uuid, stop_pod_uid uuid, stop_evidence jsonb,
        updated_at timestamptz NOT NULL DEFAULT now());`)
  } else assert.ok([11, 12, 13, 14, 15, 16, 17, 18, 19].includes(version))
  const kube = new FakeKubernetes()
  const localRoot = await mkdtemp(join(tmpdir(), 'pe-s2-handoff-'))
  t.after(() => rm(localRoot, { recursive: true, force: true }))
  const files = { async workspaceForId(userId, workspaceId) {
    const found = await pool.query('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2', [workspaceId, userId])
    if (!found.rowCount) throw new Error('workspace missing')
    return { id: workspaceId, path: join(localRoot, 'workspaces', workspaceId) }
  } }
  const manager = new SandboxManager(kube, files, pool, 'test-key',
    { namespace: 's2-test', image: 'runner:test', localRoot, nodeRoot: localRoot, readyTimeoutMs: 600 })
  manager.home = async () => ({ local: '/tmp', node: '/tmp' })
  const createSession = async userId => {
    const workspaceId = randomUUID(), sessionId = randomUUID()
    await pool.query(`INSERT INTO pe_workspaces(id,user_id,is_default)
      SELECT $1,$2,NOT EXISTS (SELECT 1 FROM pe_workspaces WHERE user_id=$2)`, [workspaceId, userId])
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [sessionId, userId, workspaceId, randomUUID(), '{}'])
    return { sessionId, workspaceId }
  }
  const createUser = async () => {
    const userId = randomUUID()
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [userId, `test-${userId}`, 'irrelevant', '{}'])
    return userId
  }
  return { pool, kube, manager, localRoot, createSession, createUser }
}

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
  const { kube, manager, localRoot, createSession, createUser } = await fixture(t)
  const userId = await createUser(), session = await createSession(userId)
  await mkdir(join(localRoot, 'skill-packages'), { recursive: true })
  await symlink(tmpdir(), join(localRoot, 'skill-packages', userId))
  await assert.rejects(manager.ensureReady(session.sessionId, userId, async () => {}),
    /mount_skill_package_root_unavailable/)
  assert.equal(kube.mutations.length, 0)
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
