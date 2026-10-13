/** Current SandboxManager against owned PG and a synthetic HTTPS controller; no Pod or physical stop is qualified. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { requestId } from '../src/contracts.ts'
import { transaction } from '../src/platform/database.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { SandboxManager, type SandboxConfig, type SandboxReady } from '../src/platform/sandbox.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
export type SandboxUnitCase = 'ready' | 'refusal' | 'owned_conflict' | 'foreign_conflict' | 'interrupted_provision' | 'missing_stop_proof'
export type SandboxUnitJob = SandboxUnitCase | 'listener_init_failure'
interface ProtocolResource {
  apiVersion?: string
  kind?: string
  type?: string | undefined
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
    uid: string
    resourceVersion: string
    generation: number
    finalizers?: string[]
    ownerReferences?: Array<{ uid: string }>
    deletionTimestamp?: string
  }
  spec?: Record<string, unknown> | undefined
  data?: Record<string, string>
  stringData?: Record<string, string> | undefined
  status?: unknown
}
interface WriterRow {
  state: string
  session_id: string | null
  user_id: string
  workspace_id?: string
  generation?: string
  name?: string
  pod_uid: string | null
  runner_instance_id: string | null
  binding_snapshot: unknown
  stop_pod_uid: string | null
  stop_evidence: unknown
}
const postedResource = z.object({ apiVersion: z.string(), kind: z.string(),
  metadata: z.object({ name: z.string(), namespace: z.string(), labels: z.record(z.string(), z.string()) }),
  spec: z.record(z.string(), z.unknown()).optional(), type: z.string().optional(),
  stringData: z.record(z.string(), z.string()).optional() })
const podTemplate = z.object({ spec: z.record(z.string(), z.unknown()) })
const deleteOptions = z.object({ preconditions: z.object({ uid: z.string() }) }).loose()
const patchOptions = z.object({ metadata: z.object({ uid: z.string(), resourceVersion: z.string(), finalizers: z.array(z.string()) }) })
function first<T>(rows: T[]): T { const row = rows[0]; assert.ok(row); return row }
function stopEvidence(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Record<string, unknown>
}

function readyIdentity(value: SandboxReady) {
  const { token, ...identity } = value
  assert.equal(typeof token, 'string'); assert.ok(token.length > 0)
  return identity
}

const finalizer = 'powerevolve.dev/retain-stop-observation'
const limits = { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 2, executionEnabled: true }
const stdioV2: NonNullable<SandboxConfig['stdioV2']> = { maxReplyBytes: 65_536,
  limits: { runtimeMs: 30_000, requestMs: 15_000, stdinGraceMs: 0, terminateGraceMs: 100, killGraceMs: 1000,
    maxInputBytes: 65_536, maxMessageBytes: 8192, maxProtocolBytes: 131_072, maxProtocolMessages: 100,
    maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16_384,
    maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 } }

/** Explicit synthetic protocol observations, never an old producer or a physical Kubernetes fixture. */
async function protocolFixture(f: Fixture,
  initialization?: { afterListen: (port: number) => Promise<void>; onClosed: () => void }, stdio = false) {
  const tlsRoot = process.env.PE_SANDBOX_TEST_TLS_DIRECTORY
  assert.ok(tlsRoot, 'An owned disposable test TLS asset directory is required')
  const namespace = `owned-unit-${randomUUID().slice(0, 8)}`
  const resources = new Map<string, ProtocolResource>(), runners = new Map<string, string>()
  const trace: Array<{ method: string | undefined; kind?: string; name?: string; status?: number; failure?: string }> = []
  const bearer = randomUUID()
  let version = 0, onRelease: () => Promise<void> = async () => {}
  let onGet: (kind: string, name: string) => Promise<void> = async () => {}
  const conflicts = new Map<string, string | null>()
  let deletionResolve: (() => void) | undefined
  const deletionStarted = new Promise<void>((resolve) => { deletionResolve = resolve })
  const server = createServer({ key: await readFile(join(tlsRoot, 'key.pem')), cert: await readFile(join(tlsRoot, 'cert.pem')) }, (request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${bearer}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const bytes: unknown = chunk
        assert.ok(Buffer.isBuffer(bytes))
        chunks.push(bytes)
      }
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      const parts = (request.url ?? '').split('/'), namespaceIndex = parts.indexOf('namespaces') + 1
      const kind = parts[namespaceIndex + 1], name = decodeURIComponent(parts[namespaceIndex + 2] ?? '')
      assert.equal(parts[namespaceIndex], namespace); assert.ok(kind)
      if (request.method === 'GET') await onGet(kind, name)
      const key = `${kind}/${name}`, existing = resources.get(key)
      let status = 200
      let result: unknown
      if (kind === 'services' && name.startsWith('http:') && parts[namespaceIndex + 3] === 'proxy' && parts[namespaceIndex + 4] === 'health') {
        const serviceName = name.slice(5, -5), secret = resources.get(`secrets/${serviceName}`)
        assert.ok(secret?.data?.token)
        assert.equal(request.headers['x-power-evolve-runner-token'], Buffer.from(secret.data.token, 'base64').toString('utf8'))
        result = { ready: true, instanceId: runners.get(serviceName) }
      } else if (request.method === 'GET') {
        if (!existing) { status = 404; result = { message: 'Owned protocol resource absent' } }
        else result = existing
      } else if (request.method === 'POST') {
        assert.equal(name, '')
        assert.ok(['secrets', 'services', 'sandboxes'].includes(kind))
        const parsed = postedResource.parse(body)
        const value: ProtocolResource = { ...parsed, metadata: { ...parsed.metadata, uid: randomUUID(),
          resourceVersion: String(++version), generation: 1 } }
        const resourceName = value.metadata.name
        const conflict = conflicts.has(kind), foreignOwner = conflicts.get(kind)
        if (foreignOwner) value.metadata.labels['powerevolve.dev/user'] = foreignOwner
        assert.equal(resources.has(`${kind}/${resourceName}`), false)
        if (kind === 'secrets') {
          value.data = Object.fromEntries(Object.entries(value.stringData ?? {}).map(([field, text]) => [field, Buffer.from(text).toString('base64')]))
          delete value.stringData
        }
        if (kind === 'sandboxes') {
          value.status = { conditions: [{ type: 'Ready', status: 'True' }] }
          // Echo the real service's submitted podTemplate. The fixture does not reconstruct its security/mount algorithm.
          resources.set(`pods/${resourceName}`, { apiVersion: 'v1', kind: 'Pod',
            metadata: { name: resourceName, namespace, labels: structuredClone(value.metadata.labels), uid: randomUUID(),
              resourceVersion: String(++version), generation: 1, finalizers: [], ownerReferences: [{ uid: value.metadata.uid }] },
            spec: { ...structuredClone(podTemplate.parse(value.spec?.podTemplate).spec), nodeName: 'owned-protocol-node' },
            status: { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0 }] } })
          runners.set(resourceName, randomUUID())
        }
        resources.set(`${kind}/${resourceName}`, value)
        conflicts.delete(kind)
        status = conflict ? 409 : 201
        result = conflict ? { kind: 'Status', reason: 'AlreadyExists', message: 'Owned protocol create conflict' } : value
      } else if (request.method === 'DELETE') {
        assert.ok(existing)
        assert.equal(deleteOptions.parse(body).preconditions.uid, existing.metadata.uid)
        if (kind === 'sandboxes') {
          existing.metadata.deletionTimestamp = new Date().toISOString()
          const pod = resources.get(`pods/${name}`); assert.ok(pod)
          pod.metadata.deletionTimestamp = existing.metadata.deletionTimestamp
          assert.ok(deletionResolve); deletionResolve()
        } else {
          assert.ok(['services', 'secrets'].includes(kind))
          resources.delete(key)
        }
        result = { kind: 'Status', status: 'Success' }
      } else if (request.method === 'PATCH') {
        assert.equal(kind, 'pods'); assert.ok(existing)
        const patch = patchOptions.parse(body)
        assert.equal(patch.metadata.uid, existing.metadata.uid)
        assert.equal(patch.metadata.resourceVersion, existing.metadata.resourceVersion)
        if ((existing.metadata.finalizers ?? []).includes(finalizer) && !patch.metadata.finalizers.includes(finalizer)) {
          await onRelease()
          resources.delete(key); resources.delete(`sandboxes/${name}`)
        } else {
          existing.metadata.finalizers = patch.metadata.finalizers
          existing.metadata.resourceVersion = String(++version)
        }
        result = existing
      } else throw new Error('Unexpected owned protocol request')
      trace.push({ method: request.method, kind, name, status })
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    })().catch(() => {
      trace.push({ method: request.method, failure: 'Owned protocol assertion failed' })
      response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: 'Owned protocol assertion failed' }))
    })
  })
  const close = async (): Promise<void> => {
    if (server.listening) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    }
    initialization?.onClosed()
  }
  let returned = false
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    await initialization?.afterListen(address.port)
    const kubeconfig = join(f.root, 'owned-protocol-kubeconfig.json')
    await writeFile(kubeconfig, JSON.stringify({ 'current-context': 'owned-unit',
      clusters: [{ name: 'owned-unit', cluster: { server: `https://127.0.0.1:${address.port}`,
        'certificate-authority-data': (await readFile(join(tlsRoot, 'cert.pem'))).toString('base64') } }],
      contexts: [{ name: 'owned-unit', context: { cluster: 'owned-unit', user: 'owned-unit' } }],
      users: [{ name: 'owned-unit', user: { token: bearer } }] }), { mode: 0o600 })
    const kube = await KubernetesClient.fromFile(kubeconfig), key = randomUUID()
    const config: SandboxConfig = {
      namespace, image: 'fixture.invalid/unit-runner', localRoot: f.root, nodeRoot: stdio ? '' : f.root,
      ...(stdio ? { volumeClaimName: 'owned-stdio-claim' } : {}), readyTimeoutMs: 5000, maxExecutions: 2,
    }
    const manager = new SandboxManager(kube, f.files, f.pool, key, { ...config, ...(stdio ? { stdioV2 } : {}) })
    returned = true
    return { manager, resources, trace, deletionStarted,
      withoutStdio() { return new SandboxManager(kube, f.files, f.pool, key, config) },
      conflict(kind: 'secrets' | 'services' | 'sandboxes', foreignOwner: string | null = null) { conflicts.set(kind, foreignOwner) },
      onGet(callback: (kind: string, name: string) => Promise<void>) { onGet = callback },
      onRelease(callback: () => Promise<void>) { onRelease = callback },
      stopped(name: string) {
        const pod = resources.get(`pods/${name}`); assert.ok(pod?.metadata.deletionTimestamp)
        const finishedAt = new Date().toISOString(), containerID = `containerd://${'a'.repeat(64)}`
        pod.status = { phase: 'Succeeded', conditions: [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
          containerStatuses: [{ name: 'runner', ready: false, restartCount: 0, containerID, lastState: {},
            state: { terminated: { exitCode: 0, containerID, startedAt: '2026-01-01T00:00:00Z', finishedAt } } }] }
      },
      close,
    }
  } finally { if (!returned) await close() }
}

/** Capture paired original service rows without changing authority or inventing a stop receipt. */
async function writerRows(f: Fixture) {
  return { slots: (await f.pool.query<WriterRow>('SELECT * FROM pe_mount_slots ORDER BY user_id')).rows,
    instances: (await f.pool.query<WriterRow>('SELECT * FROM pe_sandbox_instances ORDER BY session_id')).rows }
}

/** Select the original runner object at the synthetic HTTPS observation boundary. */
function protocolRunner(spec: unknown): Record<string, unknown> {
  assert.ok(spec !== null && typeof spec === 'object' && !Array.isArray(spec) && 'containers' in spec)
  assert.ok(Array.isArray(spec.containers) && spec.containers.length === 1)
  const runner: unknown = spec.containers[0]
  assert.ok(runner !== null && typeof runner === 'object' && !Array.isArray(runner))
  return runner as Record<string, unknown>
}

/** Reject altered wire environments without quarantining or replacing the original writer. */
async function assertStdioEnvironment(p: Awaited<ReturnType<typeof protocolFixture>>,
  f: Fixture, ready: SandboxReady): Promise<void> {
  const pod = p.resources.get(`pods/${ready.name}`), sandbox = p.resources.get(`sandboxes/${ready.name}`)
  assert.ok(pod && sandbox)
  const template: unknown = sandbox.spec?.podTemplate
  assert.ok(template !== null && typeof template === 'object' && !Array.isArray(template) && 'spec' in template)
  const expected = [{ name: 'PE_RUNNER_MAX_EXECUTIONS', value: '2' },
    { name: 'PE_RUNNER_STDIO_V2_CONFIG_FILE', value: '/run/power-evolve/stdio-v2-config.json' }]
  const observer = p.withoutStdio()
  const observe = (manager: SandboxManager, mode: 'dispatch' | 'observe') => transaction(f.pool, client =>
    manager.observeReady(ready.sessionId, ready.userId, ready.podUid, ready.runnerInstanceId, client, mode))
  const dispatched = await observe(p.manager, 'dispatch'), observed = await observe(observer, 'observe')
  assert.deepEqual(readyIdentity(dispatched), readyIdentity(ready))
  assert.deepEqual(readyIdentity(observed), readyIdentity(ready))
  assert.ok(dispatched.token === ready.token && observed.token === ready.token)
  const retained = await writerRows(f), before = p.trace.length
  await assert.rejects(observe(observer, 'dispatch'), { code: 'mount_instance_changed' })
  assert.deepEqual(await writerRows(f), retained)
  for (const runner of [protocolRunner(pod.spec), protocolRunner(template.spec)]) {
    const original = runner.env
    assert.deepEqual(original, expected)
    try {
      for (const changed of [expected.slice(0, 1), [...expected, { name: 'PE_FOREIGN_CONTROL', value: 'foreign' }]]) {
        runner.env = structuredClone(changed)
        await assert.rejects(observe(p.manager, 'dispatch'), { code: 'mount_instance_changed' })
        await assert.rejects(observe(observer, 'observe'), { code: 'mount_instance_changed' })
        assert.deepEqual(await writerRows(f), retained)
      }
    } finally { runner.env = original }
  }
  assert.ok(p.trace.slice(before).every(item => item.method === 'GET'))
  assert.deepEqual(readyIdentity(await observe(observer, 'observe')), readyIdentity(ready))
  await p.manager.assertDispatchAllowed(ready)
}

export async function readyFlow(): Promise<void> { await cloudFixture(async (f) => {
  const p = await protocolFixture(f, undefined, true)
  try {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const ready = await p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {})
    const rows = await writerRows(f)
    assert.equal(rows.slots.length, 1); assert.equal(rows.instances.length, 1)
    for (const row of [first(rows.slots), first(rows.instances)]) {
      assert.equal(row.state, 'ready'); assert.equal(row.session_id, session.sessionId)
      assert.equal(row.pod_uid, ready.podUid); assert.equal(row.runner_instance_id, ready.runnerInstanceId)
      assert.deepEqual(row.binding_snapshot, ready.binding)
    }
    const posted = p.trace.filter(item => item.method === 'POST').length
    assert.equal(posted, 3)
    const reused = await p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {})
    assert.deepEqual(readyIdentity(reused), readyIdentity(ready)); assert.ok(reused.token === ready.token)
    assert.equal(p.trace.filter(item => item.method === 'POST').length, posted)
    const observed = await p.manager.observeReady(session.sessionId, f.alice.user.userId, ready.podUid, ready.runnerInstanceId)
    assert.deepEqual(readyIdentity(observed), readyIdentity(ready)); assert.ok(observed.token === ready.token)
    await p.manager.assertDispatchAllowed(ready)
    await assertStdioEnvironment(p, f, ready)
    const home = join(f.root, 'homes', f.alice.user.userId), homeStat = await lstat(home)
    assert.equal(homeStat.uid, 1000); assert.equal(homeStat.gid, 1000)
    const homeFile = join(home, 'retained.txt')
    await writeFile(homeFile, 'Owned home survives service recycling', { mode: 0o600 })
    let releaseChecked = false, completed = false
    p.onRelease(async () => {
      const state = await writerRows(f)
      const mount = first(state.slots), instance = first(state.instances)
      assert.equal(mount.state, 'stopping'); assert.equal(instance.state, 'deleting')
      assert.equal(mount.workspace_id, ready.binding.workspaceId); assert.equal(mount.generation, ready.generation)
      assert.equal(instance.name, ready.name)
      const sandbox = p.resources.get(`sandboxes/${ready.name}`); assert.ok(sandbox)
      for (const row of [mount, instance]) {
        assert.equal(row.user_id, ready.userId); assert.equal(row.session_id, ready.sessionId)
        assert.equal(row.pod_uid, ready.podUid); assert.equal(row.runner_instance_id, ready.runnerInstanceId)
        assert.deepEqual(row.binding_snapshot, ready.binding); assert.equal(row.stop_pod_uid, ready.podUid)
        const evidence = stopEvidence(row.stop_evidence)
        assert.equal(evidence.status, 'KUBELET_STOPPED'); assert.equal(evidence.podUid, ready.podUid)
        assert.equal(evidence.sandboxUid, sandbox.metadata.uid); assert.equal(evidence.generation, ready.generation)
        assert.equal(evidence.sessionId, ready.sessionId); assert.equal(evidence.runnerInstanceId, ready.runnerInstanceId)
        assert.deepEqual(evidence.bindingSnapshot, ready.binding)
        assert.equal(typeof evidence.observedAt, 'string')
      }
      assert.deepEqual(mount.stop_evidence, instance.stop_evidence)
      releaseChecked = true
    })
    const recycling = p.manager.recycleIdle(0).then(() => { completed = true })
    try {
      await Promise.race([p.deletionStarted, recycling.then(() => { throw new Error('Recycling returned before protocol deletion') })])
      const held = await writerRows(f)
      assert.equal(first(held.slots).state, 'stopping'); assert.equal(first(held.instances).state, 'deleting')
      assert.equal(first(held.slots).stop_evidence, null); assert.equal(first(held.instances).stop_evidence, null)
      assert.equal(completed, false)
      const deletingPod = p.resources.get(`pods/${ready.name}`); assert.ok(deletingPod)
      assert.ok(deletingPod.metadata.finalizers?.includes(finalizer))
      p.stopped(ready.name)
    } finally { await recycling }
    assert.equal(releaseChecked, true); assert.equal(p.resources.size, 0)
    const released = await writerRows(f)
    assert.equal(first(released.slots).state, 'free'); assert.equal(first(released.instances).state, 'deleted')
    for (const row of [first(released.slots), first(released.instances)]) {
      assert.equal(row.pod_uid, null); assert.equal(row.runner_instance_id, null)
      assert.equal(stopEvidence(row.stop_evidence).sessionId, session.sessionId)
      assert.equal(stopEvidence(row.stop_evidence).runnerInstanceId, ready.runnerInstanceId)
      assert.deepEqual(stopEvidence(row.stop_evidence).bindingSnapshot, ready.binding)
    }
    const next = await p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {})
    assert.equal(BigInt(next.generation), BigInt(ready.generation) + 1n)
    assert.notEqual(next.podUid, ready.podUid); assert.notEqual(next.runnerInstanceId, ready.runnerInstanceId)
    assert.deepEqual(next.binding, ready.binding)
    assert.equal(await readFile(homeFile, 'utf8'), 'Owned home survives service recycling')
    assert.equal(p.trace.some(item => item.failure), false)
  } finally { await p.close() }
}) }

export async function refusalFlow(): Promise<void> { await cloudFixture(async (f) => {
  const p = await protocolFixture(f)
  try {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'Owned grant fence probe', f.alice.token)
    const grant = await tasks.claim(randomUUID()); assert.ok(grant)
    const initial = await writerRows(f)
    await assert.rejects(p.manager.ensureReady(session.sessionId, f.bob.user.userId, async () => {}), { code: 'mount_session_workspace_missing' })
    assert.deepEqual(await writerRows(f), initial); assert.equal(p.trace.length, 0)
    const modes: string[] = []
    const fence = async (client: PoolClient, mode: string) => { modes.push(mode); await tasks.authorized(client, grant.token) }
    const lease = async () => { await transaction(f.pool, client => tasks.authorized(client, grant.token)) }
    const ready = await p.manager.ensureReady(session.sessionId, f.alice.user.userId, lease, fence)
    for (const mode of ['acquire', 'mutation', 'record']) assert.ok(modes.includes(mode))
    await tasks.finish(grant.token, 'completed', null)
    const retained = await writerRows(f), before = p.trace.length
    await assert.rejects(p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {}, fence), { code: 'lease_lost' })
    assert.deepEqual(await writerRows(f), retained); assert.equal(p.trace.length, before)
    const changedPod = p.resources.get(`pods/${ready.name}`); assert.ok(changedPod)
    changedPod.metadata.uid = randomUUID()
    const beforeIdentity = p.trace.length
    await assert.rejects(p.manager.assertCurrent(ready), { code: 'mount_instance_changed' })
    const changed = await writerRows(f)
    assert.equal(first(changed.slots).state, 'unknown'); assert.equal(first(changed.instances).state, 'unknown')
    assert.equal(first(changed.slots).stop_evidence, null); assert.equal(first(changed.instances).stop_evidence, null)
    assert.ok(p.trace.slice(beforeIdentity).every(item => item.method === 'GET'))
    assert.equal(p.resources.size, 4); assert.equal(p.trace.some(item => item.failure), false)
  } finally { await p.close() }
}) }

/** A competing controller POST is accepted only after its submitted identity and spec are observed again. */
export async function ownedConflictFlow(): Promise<void> { await cloudFixture(async (f) => {
  const p = await protocolFixture(f, undefined, true)
  try {
    for (const kind of ['secrets', 'services', 'sandboxes'] as const) p.conflict(kind)
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const ready = await p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {})
    const rows = await writerRows(f)
    for (const row of [first(rows.slots), first(rows.instances)]) {
      assert.equal(row.state, 'ready'); assert.equal(row.session_id, ready.sessionId)
      assert.equal(row.pod_uid, ready.podUid); assert.equal(row.runner_instance_id, ready.runnerInstanceId)
      assert.deepEqual(row.binding_snapshot, ready.binding)
    }
    for (const kind of ['secrets', 'services', 'sandboxes']) {
      assert.equal(p.trace.filter(item => item.kind === kind && item.method === 'POST' && item.status === 409).length, 1)
      assert.ok(p.trace.some(item => item.kind === kind && item.method === 'GET' && item.status === 200))
    }
    assert.equal(p.trace.filter(item => item.method === 'POST').length, 3)
    assert.equal(p.resources.size, 4); assert.equal(p.trace.some(item => item.failure), false)
  } finally { await p.close() }
}) }

/** A foreign competing Service keeps the original reservation and cannot authorize later creation. */
export async function foreignConflictFlow(): Promise<void> { await cloudFixture(async (f) => {
  const p = await protocolFixture(f, undefined, true)
  try {
    p.conflict('services', f.bob.user.userId)
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await assert.rejects(p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {}), { status: 409 })
    const rows = await writerRows(f), slot = first(rows.slots), instance = first(rows.instances)
    assert.equal(slot.state, 'reserved'); assert.equal(instance.state, 'creating')
    for (const row of [slot, instance]) {
      assert.equal(row.session_id, session.sessionId); assert.equal(row.pod_uid, null)
      assert.equal(row.runner_instance_id, null); assert.equal(row.stop_evidence, null)
    }
    const service = p.resources.get(`services/${p.manager.name(f.alice.user.userId)}`); assert.ok(service)
    assert.equal(service.metadata.labels['powerevolve.dev/user'], f.bob.user.userId)
    assert.equal(p.resources.size, 2)
    assert.equal(p.trace.filter(item => item.method === 'POST' && item.kind === 'sandboxes').length, 0)
    assert.equal(p.trace.filter(item => item.method === 'DELETE' || item.method === 'PATCH').length, 0)
    const before = p.trace.length
    await assert.rejects(p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {}),
      { code: 'mount_services_identity_changed' })
    assert.deepEqual(await writerRows(f), rows)
    assert.ok(p.trace.slice(before).every(item => item.method === 'GET'))
    assert.equal(p.trace.some(item => item.failure), false)
  } finally { await p.close() }
}) }

/** Revocation after the committed Secret prevents writes; a new grant cannot recreate an observed missing resource. */
export async function interruptedProvisionFlow(): Promise<void> { await cloudFixture(async (f) => {
  const p = await protocolFixture(f, undefined, true)
  try {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'Owned partial provisioning', f.alice.token)
    const grant = await tasks.claim(randomUUID()); assert.ok(grant)
    let revoked = false
    p.onGet(async (kind, name) => {
      if (kind === 'services' && !name.startsWith('http:') && !revoked) {
        assert.equal(p.resources.size, 1)
        assert.ok(p.resources.has(`secrets/${p.manager.name(f.alice.user.userId)}`))
        await tasks.finish(grant.token, 'completed', null)
        revoked = true
      }
    })
    const lease = async () => { await transaction(f.pool, client => tasks.authorized(client, grant.token)) }
    const fence = async (client: PoolClient) => { await tasks.authorized(client, grant.token) }
    await assert.rejects(p.manager.ensureReady(session.sessionId, f.alice.user.userId, lease, fence), { code: 'lease_lost' })
    assert.equal(revoked, true)
    const retained = await writerRows(f)
    assert.equal(first(retained.slots).state, 'reserved'); assert.equal(first(retained.instances).state, 'creating')
    for (const row of [first(retained.slots), first(retained.instances)]) {
      assert.equal(row.pod_uid, null); assert.equal(row.runner_instance_id, null); assert.equal(row.stop_evidence, null)
    }
    assert.equal(p.trace.filter(item => item.method === 'POST').length, 1)
    assert.equal(p.resources.size, 1)
    await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'Owned observe-only retry', f.alice.token)
    const next = await tasks.claim(randomUUID()); assert.ok(next)
    const nextLease = async () => { await transaction(f.pool, client => tasks.authorized(client, next.token)) }
    const nextFence = async (client: PoolClient) => { await tasks.authorized(client, next.token) }
    const before = p.trace.length
    await assert.rejects(p.manager.ensureReady(session.sessionId, f.alice.user.userId, nextLease, nextFence),
      { code: 'mount_services_creation_missing' })
    assert.deepEqual(await writerRows(f), retained)
    assert.ok(p.trace.slice(before).every(item => item.method === 'GET'))
    assert.equal(p.resources.size, 1); assert.equal(p.trace.some(item => item.failure), false)
  } finally { await p.close() }
}) }

/** A missing original Pod is not stop evidence and cannot free the writer for another Session. */
export async function missingStopProofFlow(): Promise<void> { await cloudFixture(async (f) => {
  const p = await protocolFixture(f, undefined, true)
  try {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const ready = await p.manager.ensureReady(session.sessionId, f.alice.user.userId, async () => {})
    assert.equal(p.resources.delete(`pods/${ready.name}`), true)
    const before = p.trace.length
    await assert.rejects(p.manager.recycleIdle(0), { code: 'mount_stop_proof_missing' })
    const retained = await writerRows(f)
    assert.equal(first(retained.slots).state, 'stopping'); assert.equal(first(retained.instances).state, 'deleting')
    assert.equal(first(retained.slots).generation, ready.generation)
    for (const row of [first(retained.slots), first(retained.instances)]) {
      assert.equal(row.session_id, ready.sessionId); assert.equal(row.pod_uid, ready.podUid)
      assert.equal(row.runner_instance_id, ready.runnerInstanceId); assert.deepEqual(row.binding_snapshot, ready.binding)
      assert.equal(row.stop_pod_uid, null); assert.equal(row.stop_evidence, null)
    }
    const next = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await assert.rejects(p.manager.ensureReady(next.sessionId, f.alice.user.userId, async () => {}), { code: 'mount_stop_proof_missing' })
    assert.deepEqual(await writerRows(f), retained)
    assert.ok(p.trace.slice(before).every(item => item.method === 'GET'))
    assert.equal(p.resources.size, 3); assert.equal(p.trace.some(item => item.failure), false)
  } finally { await p.close() }
}) }

/** Finite initialization failure control: the listener must close while this process is still alive, before PG disposal. */
export async function listenerInitializationFailureControl(): Promise<void> {
  const witness = { listened: false, listenerClosedBeforeDatabaseDispose: false, portRefusedAfterClose: false,
    expectedInitializationFailure: false }
  let port = 0
  const sentinel = new Error('Owned listener initialization control')
  await assert.rejects(cloudFixture(async (f) => {
    try {
      await protocolFixture(f, { afterListen: async (value) => {
        port = value; witness.listened = true
        throw sentinel
      }, onClosed: () => { witness.listenerClosedBeforeDatabaseDispose = true } })
    } catch (error) {
      assert.equal(error, sentinel)
      witness.expectedInitializationFailure = true
      assert.equal(witness.listenerClosedBeforeDatabaseDispose, true)
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1')
        socket.once('connect', () => { socket.destroy(); reject(new Error('Owned listener remained open')) })
        socket.once('error', (error) => {
          socket.destroy()
          if ('code' in error && error.code === 'ECONNREFUSED') { witness.portRefusedAfterClose = true; resolve() }
          else reject(error)
        })
      })
      throw error
    }
  }), error => error === sentinel)
  assert.deepEqual(witness, { listened: true, listenerClosedBeforeDatabaseDispose: true,
    portRefusedAfterClose: true, expectedInitializationFailure: true })
  const receipt = process.env.PE_SANDBOX_UNIT_CONTROL_RECEIPT_FILE
  assert.ok(receipt)
  await writeFile(receipt, JSON.stringify({ ...witness, originalFailure: { name: sentinel.name, message: sentinel.message, stack: sentinel.stack } }, null, 2) + '\n', { mode: 0o600 })
}
