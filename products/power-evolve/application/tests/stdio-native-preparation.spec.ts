/** Real PG native preparation and once activation with explicitly simulated Kubernetes observations. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { NativeExecutionPods } from '../src/platform/native-execution-pods.ts'
import { NativeProcessBroker } from '../src/platform/native-execution-broker.ts'
import { NativeExecutionServiceAuthority } from '../src/platform/native-execution-service-authority.ts'
import { StdioNativeCloudV2 } from '../src/platform/stdio-v2-native-cloud.ts'
import { StdioCloudWorkerStoreV2 } from '../src/platform/stdio-v2-worker-store.ts'
import { StdioAuthorizationServiceV2 } from '../src/platform/stdio-v2-authorization.ts'
import { SafePosix } from '../src/platform/safe-posix.ts'
import { transaction } from '../src/platform/database.ts'
import { stdioWorkflow, workflowLimits, workflowRequest } from './employee1-stdio-workflow-fixture.ts'

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned native preparation returned no row')
  return row
}

const metadata = z.object({ metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()),
  finalizers: z.array(z.string()) }), spec: z.record(z.string(), z.unknown()) }).loose()

for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
  test(`native ${mode} preparation binds actual mounts and activates the exact original Pod only once`, async () => {
    await stdioWorkflow(async (f) => {
      const root = await mkdtemp(join(tmpdir(), 'pe-native-prepare-'))
      const ctx = new Context()
      await ctx.plugin(LocalSubprocessRuntime)
      const key = join(root, 'native-test-kube.json')
      await writeFile(key, JSON.stringify({ 'current-context': 'owned', contexts: [{ name: 'owned', context: {
        cluster: 'owned', user: 'owned' } }], clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:1',
        'certificate-authority-data': 'dGVzdA==' } }], users: [{ name: 'owned', user: { token: 'test-only' } }] }))
      const kube = await KubernetesClient.fromFile(key)
      const stored = new Map<string, unknown>()
      const call = vi.spyOn(kube, 'call').mockImplementation(async (method, path, body) => {
        if (path.startsWith('/api/v1/nodes/')) return { metadata: { name: 'owned-node' }, status: { nodeInfo: { operatingSystem: f.deployment.platform.os, architecture: f.deployment.platform.architecture } } }
        if (method === 'POST') {
          const normalized: unknown = JSON.parse(JSON.stringify(body), (key, value: unknown) => key === 'readOnly' && value === false ? undefined : value)
          const submitted = metadata.parse(normalized), image = f.deployment.runtimeImageIds[0]
          const observed = { ...submitted, metadata: { ...submitted.metadata, uid: randomUUID(), resourceVersion: '1', generation: 1 },
            spec: { ...submitted.spec, nodeName: 'owned-node' }, status: { phase: 'Running', containerStatuses: [{
              name: 'payload', ready: true, restartCount: 0, imageID: image, containerID: 'containerd://' + 'b'.repeat(64),
              state: { running: { startedAt: '2026-10-15T00:00:00Z' } } }] } }
          stored.set(path + '/' + submitted.metadata.name, observed)
          return structuredClone(observed)
        }
        const observed = stored.get(path)
        if (!observed) throw new Error('Unowned simulated Kubernetes lookup')
        return structuredClone(observed)
      })
      const init = vi.spyOn(SafePosix.prototype, 'init').mockResolvedValue()
      const home = vi.spyOn(SafePosix.prototype, 'ensureWorkspace').mockResolvedValue()
      const directory = vi.spyOn(SafePosix.prototype, 'createDirectory').mockResolvedValue()
      const pods = new NativeExecutionPods(f.pool, kube, { namespace: 'native-test-owned', runtimeClassName: 'gvisor',
        image: f.deployment.imageReference, storageVolumeClaim: 'owned-data', storageVolumePrefix: 'workspaces',
        homeVolumePrefix: 'homes', homeLocalRoot: root, tmpVolumePrefix: 'tmp', tmpLocalRoot: root,
        pollMs: 1, readyTimeoutMs: 1000, stopTimeoutMs: 1000, maxPodSeconds: 120, cpu: '1', memory: '128Mi' })
      const native = (): StdioNativeCloudV2 => adapter
      const store = new StdioCloudWorkerStoreV2(f.pool, { limits: workflowLimits, leaseMs: 60_000, maxActive: 4, maxCandidates: 8,
        nativeResources: { ready: (client, task, value) => native().ready(client, task, value),
          noStart: (client, task) => native().noStart(client, task) } })
      const authority = new NativeExecutionServiceAuthority(f.pool, f.files.storage, store.nativeServiceLease, randomBytes(32))
      const broker = new NativeProcessBroker(authority, pods, ctx.subprocess, { kubectlExecutable: '/unused', kubeconfigPath: key,
        fsWorkerPath: '/opt/native/native-fs-worker.mjs', processWorkerPath: '/opt/native/native-process-worker.py',
        maxRequestBytes: 262_144, maxReplyBytes: 262_144, maxProcessMs: 10_000, authorityPollMs: 1000, transportGraceMs: 100 })
      const adapter = new StdioNativeCloudV2(f.pool, broker, store, 262_144)
      const authorization = new StdioAuthorizationServiceV2(f.pool, { limits: workflowLimits, approvalKey: randomBytes(32),
        approvalLifetimeMs: 60_000, capture: (client, task) => native().capture(client, task) })
      try {
        await f.pool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,0,$2)',
          [f.session.sessionId, { type: 'sandbox/mode', data: { mode } }])
        const lease = await f.claim()
        await store.beginPreparation(lease)
        const writer = await adapter.prepare(lease)
        await store.attach(lease, writer)
        const prepared = await authorization.prepareLeased(lease)
        expect(prepared.prepared.capture.workspaceMount.readOnly).toBe(mode === 'read-only')
        expect(prepared.prepared.capture.homeMount.readOnly).toBe(mode !== 'danger-full-access')
        expect((await f.pool.query('SELECT * FROM pe_mount_slots')).rowCount).toBe(0)
        expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
        expect(await adapter.prepare(lease)).toEqual(writer)
        await authorization.decide(f.approval.token, { actionId: lease.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
        await authorization.authorizeLeased(lease, workflowRequest(), { kind: 'cloud', runnerInstanceId: prepared.prepared.capture.runnerInstanceId })
        const snapshot = await store.snapshot(lease)
        const process = first((await f.pool.query<{ world_id: string; id: string }>('SELECT id,world_id FROM pe_native_execution_processes')).rows)
        const current = first((await f.pool.query<{ world: unknown }>(`SELECT jsonb_build_object('worldId',w.id,'userId',w.user_id,
          'sessionId',w.session_id,'workspaceId',w.workspace_id,'storageGeneration',w.storage_generation,
          'permissionGeneration',w.permission_generation,'mode',w.mode,'workspaceRoot','/workspace','homeRoot','/home/agent',
          'serviceId',w.service_id,'serviceEpoch',w.service_epoch,'authorityKind',w.authority_kind) AS world
          FROM pe_native_execution_worlds w WHERE id=$1`, [process.world_id])).rows)
        const { nativeExecutionServiceWorld } = await import('../src/native-execution/types.ts')
        const range = { id: process.id, name: writer.name, uid: writer.podUid, world: nativeExecutionServiceWorld.parse(current.world) }
        expect(snapshot.dispatch).not.toBeNull()
        const activate = () => pods.activate(range, { approved: snapshot.dispatch }, async () => {})
        await activate()
        await expect(activate()).rejects.toThrow('activation_already_consumed')
        await expect(f.pool.query("UPDATE pe_native_execution_processes SET activation_digest='replacement' WHERE id=$1", [process.id]))
          .rejects.toThrow('immutable')
        await transaction(f.pool, async (client) => {
          const task = (await store.snapshot(lease)).task
          await expect(native().noStart(client, task)).rejects.toThrow()
        })
        await store.release(lease)
      } finally {
        call.mockRestore(); init.mockRestore(); home.mockRestore(); directory.mockRestore()
        await broker.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
      }
    })
  })
}
