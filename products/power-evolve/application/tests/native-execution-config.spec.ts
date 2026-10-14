/** Scheduling requests remain independent of execution hard limits and physical confinement. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { nativeExecutionConfig } from '../src/platform/native-execution-config.ts'
import { NativeExecutionPods } from '../src/platform/native-execution-pods.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { SafePosix } from '../src/platform/safe-posix.ts'
import { nativeExecutionWorld } from '../src/native-execution/types.ts'
import { storageBinding } from '../src/platform/cloud-storage-types.ts'

const configuration = {
  broker: { kubectlExecutable: '/bin/kubectl', kubeconfigPath: '/private/kubeconfig', fsWorkerPath: '/opt/fs.mjs',
    processWorkerPath: '/opt/process.py', maxRequestBytes: 1000, maxReplyBytes: 1000, maxProcessMs: 1000,
    authorityPollMs: 100, transportGraceMs: 100 },
  pods: { namespace: 'owned-execution', runtimeClassName: 'gvisor', image: 'owned@sha256:' + 'a'.repeat(64),
    storageVolumeClaim: 'owned-storage', storageVolumePrefix: 'storage', homeVolumePrefix: 'homes', homeLocalRoot: '/homes',
    tmpVolumePrefix: 'homes', tmpLocalRoot: '/homes', cpu: '2', memory: '2Gi', pollMs: 100,
    readyTimeoutMs: 1000, stopTimeoutMs: 1000, maxPodSeconds: 600, maxRecoveryRows: 100 },
  routes: { maxLiveHandles: 10, maxOutputBytes: 1000 },
}

test('legacy and partially specified requests materialize from each corresponding hard limit', () => {
  expect(nativeExecutionConfig.parse(configuration).pods).toMatchObject({ requestCpu: '2', requestMemory: '2Gi' })
  expect(nativeExecutionConfig.parse({ ...configuration, pods: { ...configuration.pods, requestCpu: '200m' } }).pods)
    .toMatchObject({ requestCpu: '200m', requestMemory: '2Gi', cpu: '2', memory: '2Gi' })
})

test('invalid request quantities and misspelled scheduling fields reject at configuration load', () => {
  for (const pods of [
    { ...configuration.pods, requestCpu: '-200m' }, { ...configuration.pods, requestCpu: '200m;echo bad' },
    { ...configuration.pods, requestMemory: '256MiB' }, { ...configuration.pods, requestMemory: '' },
    { ...configuration.pods, requestsMemory: '256Mi' },
  ]) expect(nativeExecutionConfig.safeParse({ ...configuration, pods }).success).toBe(false)
})

for (const requests of [undefined, { requestCpu: '200m', requestMemory: '256Mi' }])
  test(`actual Pod admission uses ${requests ? 'explicit scheduling requests' : 'legacy paired resources'} without changing confinement`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pe-native-resources-')), pool = new Pool()
    const config = nativeExecutionConfig.parse({ ...configuration, pods: { ...configuration.pods, ...requests } })
    const world = nativeExecutionWorld.parse({ worldId: randomUUID(), userId: randomUUID(), sessionId: randomUUID(),
      agentId: 'owned-agent', workspaceId: randomUUID(), operationId: randomUUID(), operationEpoch: 1,
      storageGeneration: 1, permissionGeneration: 1, mode: 'read-only', workspaceRoot: '/workspace', homeRoot: '/home/agent' })
    const binding = storageBinding.parse({ spaceId: randomUUID(), rootRelativePath: '', workspaceId: world.workspaceId,
      rootKey: randomUUID(), generation: 1 })
    const kubeconfig = join(root, 'kubeconfig.json')
    await writeFile(kubeconfig, JSON.stringify({ 'current-context': 'owned',
      clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:1', 'certificate-authority-data': 'Y2E=' } }],
      contexts: [{ name: 'owned', context: { cluster: 'owned', user: 'owned' } }],
      users: [{ name: 'owned', user: { token: 'test-only' } }] }))
    try {
      const kube = await KubernetesClient.fromFile(kubeconfig), uid = randomUUID(), id = randomUUID()
      vi.spyOn(SafePosix.prototype, 'init').mockResolvedValue()
      vi.spyOn(SafePosix.prototype, 'ensureWorkspace').mockResolvedValue()
      vi.spyOn(SafePosix.prototype, 'createDirectory').mockResolvedValue()
      vi.spyOn(pool, 'query').mockReturnValue(undefined)
      let submitted: unknown
      const observation = { metadata: { name: 'pe-native-' + id, uid, resourceVersion: '1',
        finalizers: ['powerevolve.dev/native-execution-stop'], labels: {
          'powerevolve.dev/native-world': world.worldId, 'powerevolve.dev/native-process': id } },
      spec: {}, status: { phase: 'Running', containerStatuses: [{ ready: true }] } }
      vi.spyOn(kube, 'call').mockImplementation(async (method, _path, body) => {
        if (method === 'POST') submitted = body
        return observation
      })
      const { nodeName, requestCpu, requestMemory, ...podConfig } = config.pods
      const pods = new NativeExecutionPods(pool, kube, { ...podConfig, ...(requests ? { requestCpu, requestMemory } : {}),
        ...(nodeName === undefined ? {} : { nodeName }) })
      expect((await pods.create(world, binding, 'process', { argv: ['/bin/true'] }, async () => {}, id)).uid).toBe(uid)
      expect(submitted).toMatchObject({ spec: { activeDeadlineSeconds: 600, automountServiceAccountToken: false,
        runtimeClassName: 'gvisor', containers: [{ resources: {
          requests: requests ? { cpu: '200m', memory: '256Mi' } : { cpu: '2', memory: '2Gi' },
          limits: { cpu: '2', memory: '2Gi' } }, securityContext: {
          allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [{ readOnly: true }, { readOnly: true }, { readOnly: true }] }] } })
    } finally { vi.restoreAllMocks(); await pool.end(); await rm(root, { recursive: true, force: true }) }
  })
