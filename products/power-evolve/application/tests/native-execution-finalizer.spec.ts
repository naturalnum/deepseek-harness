/** Formal PG and verified TLS Kubernetes cleanup CAS preserve original stop facts and foreign finalizers. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { requestId } from '../src/contracts.ts'
import { nativeExecutionWorld } from '../src/native-execution/types.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { NativeExecutionPods } from '../src/platform/native-execution-pods.ts'
import { kubernetesPodStopStatus } from '../src/platform/pod-stop-status.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const own = 'powerevolve.dev/native-execution-stop', foreign = 'other.example/owned-stop'
const patchSchema = z.object({ metadata: z.object({ uid: z.string(), resourceVersion: z.string(), finalizers: z.array(z.string()) }) })
type Patch = z.infer<typeof patchSchema>
function observation(worldId: string, processId: string) {
  const image = 'owned@sha256:' + 'a'.repeat(64), id = 'containerd://' + 'b'.repeat(64)
  return { metadata: { name: 'owned-original', uid: 'owned-original-uid', resourceVersion: '1', generation: 2,
    labels: { 'powerevolve.dev/native-world': worldId, 'powerevolve.dev/native-process': processId },
    finalizers: [own, foreign], deletionTimestamp: '2026-10-15T00:00:00Z' },
  spec: { nodeName: 'owned-node', restartPolicy: 'Never', containers: [{ name: 'payload', image }], volumes: [] },
  status: { phase: 'Failed', observedGeneration: 2, conditions: [{ type: 'PodReadyToStartContainers', status: 'False',
    observedGeneration: 2, lastTransitionTime: '2026-10-15T00:00:02Z' }],
  containerStatuses: [{ name: 'payload', ready: false, started: false, restartCount: 0, lastState: {}, containerID: id, imageID: image,
    state: { terminated: { containerID: id, exitCode: 143, startedAt: '2026-10-14T23:59:50Z', finishedAt: '2026-10-15T00:00:01Z' } } }] } }
}
type Pod = ReturnType<typeof observation>
type Behavior = { absent?: boolean
  state?: 'running'
  budgetMs?: number
  patch?: (body: Patch, pod: Pod, attempt: number) => { status: number; value: unknown } | undefined }

async function fixture(behavior: Behavior, run: (data: {
  stop: () => Promise<void>
  row: () => Promise<{ state: string; stop_evidence: unknown; first_stop_cause: string }>
  original: Pod
  proof: object
  patches: Patch[]
}) => Promise<void>) {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 4 })
    const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'Owned cleanup fixture', f.alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Missing original operation')
    const session = (await f.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]
    if (!session) throw new Error('Missing original workspace')
    const world = nativeExecutionWorld.parse({ worldId: randomUUID(), userId: f.alice.user.userId, sessionId: created.sessionId,
      agentId: randomUUID(), operationId: grant.operationId, operationEpoch: grant.epoch, workspaceId: session.workspace_id,
      storageGeneration: 1, permissionGeneration: 1, mode: 'workspace-write', workspaceRoot: '/workspace', homeRoot: '/home/agent' })
    await f.pool.query(`INSERT INTO pe_native_execution_worlds(id,user_id,session_id,agent_id,operation_id,operation_epoch,
      grant_digest,workspace_id,storage_generation,permission_generation,mode,binding_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,'owned-original',$7,1,1,'workspace-write','{}')`,
    [world.worldId, world.userId, world.sessionId, world.agentId, world.operationId, world.operationEpoch, world.workspaceId])
    const processId = randomUUID(), original = observation(world.worldId, processId)
    expect(kubernetesPodStopStatus(original)).toBe('KUBELET_STOPPED')
    const proof = { status: 'KUBELET_STOPPED', processId, worldId: world.worldId, podUid: original.metadata.uid,
      storageGeneration: 1, permissionGeneration: 1, observedAt: '2026-10-15T00:00:03Z', observation: original }
    await f.pool.query(`INSERT INTO pe_native_execution_processes(id,world_id,kind,namespace,pod_name,pod_uid,state,
      request_digest,first_stop_cause,stop_evidence) VALUES($1,$2,'process','owned-cas',$3,$4,$5,'owned-request','completed',$6)`,
    [processId, world.worldId, original.metadata.name, original.metadata.uid, behavior.state ?? 'stopped', behavior.state ? null : proof])
    const root = await mkdtemp(join(tmpdir(), 'pe-original-cas-')), sockets = new Set<Duplex>(), errors: unknown[] = [], patches: Patch[] = []
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem'), token = join(root, 'token')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 })
    await writeFile(token, 'owned-cas-fixture', { mode: 0o600 })
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }), current = structuredClone(original)
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
    server.on('request', (request, response) => {
      void (async () => {
        expect(request.headers.authorization).toBe('Bearer owned-cas-fixture')
        if (request.method === 'GET') { response.statusCode = behavior.absent ? 404 : 200
          response.end(JSON.stringify(behavior.absent ? { reason: 'NotFound' } : current)); return }
        expect(request.method).toBe('PATCH')
        expect(request.headers['content-type']).toBe('application/merge-patch+json')
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const body = patchSchema.parse(JSON.parse(Buffer.concat(chunks).toString())); patches.push(body)
        const action = behavior.patch?.(body, current, patches.length)
        if (action) { response.statusCode = action.status; response.end(JSON.stringify(action.value)); return }
        current.metadata.finalizers = body.metadata.finalizers
        current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1)
        response.end(JSON.stringify(current))
      })().catch((error: unknown) => { errors.push(error); response.statusCode = 500; response.end('{}') })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing TLS listener')
      const kube = await KubernetesClient.fromServiceAccount('https://127.0.0.1:' + String(address.port), cert, token)
      const pods = new NativeExecutionPods(f.pool, kube, { namespace: 'owned-cas', runtimeClassName: 'gvisor', image: 'unused',
        storageVolumeClaim: 'owned', storageVolumePrefix: 'storage', homeVolumePrefix: 'homes', homeLocalRoot: f.root,
        tmpVolumePrefix: 'tmp', tmpLocalRoot: f.root, cpu: '1', memory: '128Mi', pollMs: 5, readyTimeoutMs: 1000,
        stopTimeoutMs: behavior.budgetMs ?? 1000, maxPodSeconds: 120 })
      const row = async () => { const value = (await f.pool.query<{ state: string; stop_evidence: unknown; first_stop_cause: string }>(
        'SELECT state,stop_evidence,first_stop_cause FROM pe_native_execution_processes WHERE id=$1', [processId])).rows[0]
      if (!value) throw new Error('Missing durable original'); return value }
      await run({ stop: () => pods.stop({ id: processId, name: original.metadata.name, uid: original.metadata.uid, world }, 'dispose'),
        row, original, proof, patches })
      if (errors.length) throw new AggregateError(errors, 'Controlled TLS handler failed')
    } finally {
      const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      await Promise.all([...sockets].map(async (socket) => { const close = socket.closed ? Promise.resolve() : once(socket, 'close')
        socket.destroy(); await close }))
      await closed; await rm(root, { recursive: true, force: true })
    }
  })
}

test('409 retries only original cleanup with fresh CAS and preserves foreign finalizer and original PG proof', () => fixture({
  patch: (_body, pod, attempt) => { if (attempt !== 1) return undefined
    pod.metadata.resourceVersion = '2'; return { status: 409, value: { reason: 'Conflict' } } },
}, async ({ stop, row, proof, patches }) => {
  await stop(); expect(patches.map(p => p.metadata.resourceVersion)).toEqual(['1', '2'])
  expect(patches.every(p => p.metadata.finalizers.length === 1 && p.metadata.finalizers[0] === foreign)).toBe(true)
  expect(await row()).toEqual({ state: 'stopped', stop_evidence: { ...proof, resourceReleased: true }, first_stop_cause: 'completed' })
}))

for (const status of [401, 403]) test(`${status} cleanup denial retains original unreleased proof without retry`, () => fixture({
  patch: () => ({ status, value: { reason: 'Forbidden' } }),
}, async ({ stop, row, proof, patches }) => {
  await expect(stop()).rejects.toMatchObject({ status }); expect(patches).toHaveLength(1)
  expect((await row()).stop_evidence).toEqual(proof)
}))

for (const changed of ['uid', 'spec', 'stop'] as const) test(`409 fresh ${changed} change cannot release original proof`, () => fixture({
  patch: (_body, pod) => { pod.metadata.resourceVersion = '2'
    if (changed === 'uid') pod.metadata.uid = 'replacement'
    if (changed === 'spec') pod.spec.containers[0]!.image = 'replacement'
    if (changed === 'stop') pod.status.conditions[0]!.status = 'True'
    return { status: 409, value: { reason: 'Conflict' } } },
}, async ({ stop, row, proof, patches }) => {
  const message = { uid: 'native_payload_identity_changed', spec: 'native_payload_stopped_identity_changed',
    stop: 'native_payload_stop_facts_changed' }[changed]
  await expect(stop()).rejects.toMatchObject({ message }); expect(patches).toHaveLength(1)
  expect((await row()).stop_evidence).toEqual(proof)
}))

for (const malformed of ['null', 'uid', 'own', 'foreign'] as const) test(`2xx ${malformed} ACK cannot mark original range released`, () => fixture({
  patch: (_body, pod) => { const ack = structuredClone(pod)
    if (malformed === 'uid') ack.metadata.uid = 'replacement'
    if (malformed === 'foreign') ack.metadata.finalizers = []
    return { status: 200, value: malformed === 'null' ? null : ack } },
}, async ({ stop, row, proof, patches }) => {
  await expect(stop()).rejects.toBeInstanceOf(Error); expect(patches).toHaveLength(1)
  expect((await row()).stop_evidence).toEqual(proof)
}))

test('repeated 409 cannot reset original stop deadline', () => fixture({ budgetMs: 200,
  patch: (_body, pod) => { pod.metadata.resourceVersion = String(Number(pod.metadata.resourceVersion) + 1)
    return { status: 409, value: { reason: 'Conflict' } } },
}, async ({ stop, row, proof, patches }) => {
  const began = Date.now(); await expect(stop()).rejects.toBeInstanceOf(Error)
  expect(Date.now() - began).toBeLessThan(1000); expect(patches.length).toBeGreaterThan(1)
  expect((await row()).stop_evidence).toEqual(proof)
}))

test('post-proof original 404 is release while pre-proof missing remains uncertain', async () => {
  await fixture({ absent: true }, async ({ stop, row, proof, patches }) => {
    await stop(); expect(patches).toHaveLength(0); expect((await row()).stop_evidence).toEqual({ ...proof, resourceReleased: true })
  })
  await fixture({ absent: true, state: 'running' }, async ({ stop, row, patches }) => {
    await expect(stop()).rejects.toMatchObject({ message: 'native_payload_stop_evidence_missing' })
    expect(patches).toHaveLength(0); expect((await row()).stop_evidence).toBeNull()
  })
})
