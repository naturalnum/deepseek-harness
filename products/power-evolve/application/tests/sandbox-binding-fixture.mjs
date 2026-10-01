/** Owned PostgreSQL and deterministic Kubernetes fixtures for Sandbox binding and lifecycle regressions. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { initializeDatabase } from '../lib/platform/database.js'
import { CURRENT_SCHEMA_VERSION } from '../lib/platform/schema.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { SandboxManager } from '../lib/platform/sandbox.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

export class FakeKubernetes {
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
        value.metadata.deletionTimestamp = '2026-09-29T00:00:00Z'
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
      if (body.metadata.uid !== undefined && body.metadata.uid !== value.metadata.uid) throw new KubernetesError(409, 'UID changed')
      if (body.metadata.resourceVersion !== value.metadata.resourceVersion) throw new KubernetesError(409, 'version changed')
      value.metadata.finalizers = body.metadata.finalizers
      value.metadata.resourceVersion = String(Number(value.metadata.resourceVersion) + 1)
      if (value.metadata.deletionTimestamp && !value.metadata.finalizers.length) {
        this.resources.delete(key)
        this.resources.delete(`sandboxes/${name}`)
      }
      return structuredClone(value)
    }
    throw new Error(`Unexpected Kubernetes ${method} ${path}`)
  }
}

export async function createSandboxFixture(t, sandboxConfig = {}, poolMax = 10) {
  const admin = new Pool({ connectionString: databaseUrl })
  const name = `pe_s2_${randomBytes(10).toString('hex')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(databaseUrl); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href, max: poolMax })
  t.after(async () => {
    try { await pool.end() }
    finally { try { await admin.query(`DROP DATABASE "${name}"`) } finally { await admin.end() } }
  })
  await initializeDatabase(pool)
  const version = Number((await pool.query('SELECT version FROM pe_schema')).rows[0].version)
  assert.equal(version, CURRENT_SCHEMA_VERSION)
  const kube = new FakeKubernetes()
  const localRoot = await mkdtemp(join(tmpdir(), 'pe-s2-handoff-'))
  t.after(() => rm(localRoot, { recursive: true, force: true }))
  const files = {
    async bindingForId(userId, workspaceId, client = pool) {
      const found = await client.query(`SELECT w.id,w.binding_generation,w.binding_state,b.space_id,b.root_relative_path,s.root_key
        FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id AND b.user_id=w.user_id
        JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=b.user_id WHERE w.id=$1 AND w.user_id=$2`, [workspaceId,userId])
      const row = found.rows[0]
      if (!row || row.binding_state !== 'ready') throw new Error('mount_binding_not_ready')
      return { workspaceId: row.id, spaceId: row.space_id, rootKey: row.root_key,
        rootRelativePath: row.root_relative_path, generation: Number(row.binding_generation) }
    },
    async workspaceForId(userId, workspaceId) {
      const binding = await this.bindingForId(userId,workspaceId)
      const path = join(localRoot,'workspaces',binding.rootKey,binding.rootRelativePath)
      await mkdir(path,{recursive:true})
      return { id: workspaceId, path }
    },
  }
  const manager = new SandboxManager(kube, files, pool, 'test-key',
    { namespace: 's2-test', image: 'runner:test', localRoot, nodeRoot: localRoot,
      fileScan: { maxEntries: 4096, maxHashBytes: 33554432, timeoutMs: 5000, maxSnapshotBytes: 1048576, maxFiles: 100 },
      readyTimeoutMs: 600, ...sandboxConfig })
  manager.home = async () => ({ local: '/tmp', node: '/tmp' })
  const createSession = async (userId, target = {}) => {
    const workspaceId = randomUUID(), sessionId = randomUUID()
    await pool.query(`INSERT INTO pe_workspaces(id,user_id,is_default)
      SELECT $1,$2,NOT EXISTS (SELECT 1 FROM pe_workspaces WHERE user_id=$2)`, [workspaceId, userId])
    const spaceId = target.spaceId ?? workspaceId, rootKey = target.rootKey ?? spaceId
    await pool.query(`INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state)
      VALUES($1,$2,$3,'Fixture',false,'ready') ON CONFLICT(id) DO NOTHING`,[spaceId,userId,rootKey])
    await pool.query(`INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path)
      VALUES($1,$2,$3,$4)`,[workspaceId,userId,spaceId,target.rootRelativePath ?? ''])
    await pool.query("UPDATE pe_workspaces SET binding_state='ready',binding_generation=$2 WHERE id=$1",[workspaceId,target.generation ?? 1])
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
  return { pool, kube, manager, files, managerOptions: manager.config, localRoot, createSession, createUser }
}
