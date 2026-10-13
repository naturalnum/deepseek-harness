/** Office deployment and Pod adapter tests use explicit API responses, separate from real node isolation probes. */
import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { accountUserId } from '@power-evolve/contracts/account'
import { officePreviewJobSchema } from '@power-evolve/contracts/office-preview'
import { loadOfficePreviewConfig } from '../src/platform/office-preview-config.ts'
import { OfficePreviewPods, type OfficePreviewPodConfig } from '../src/platform/office-preview-pod.ts'
import type { KubernetesClient } from '../src/platform/kubernetes.ts'

const pod: OfficePreviewPodConfig = {
  namespace: 'owned-office', runtimeClassName: 'pe-office-offline',
  image: `registry.example/office@sha256:${'a'.repeat(64)}`, volumeClaimName: 'office-cache', volumeSubPath: 'jobs',
  kubernetesTimeoutMs: 5000, terminationGraceSeconds: 5, cpuMilliCores: 1000, memoryMiB: 2048, temporaryMiB: 256,
}
const limits = { inputBytes: 16_777_216, outputBytes: 8_388_608, timeoutMs: 20_000,
  archiveEntries: 1000, uncompressedBytes: 67_108_864, fontLoadedBytes: 134_217_728,
  pages: 100, fontFiles: 100, fontFileBytes: 134_217_728, fontResolutionEntries: 1000, imageResolution: 150 }
const deployment = { ...pod, localRoot: '/owned/office/jobs', fontPolicyDigest: 'b'.repeat(64), limits,
  maxConcurrentParsers: 2, maxRetainedJobsPerUser: 32, leaseMs: 30_000, jobDeadlineMs: 60_000, pollMs: 1000 }

function adapter() {
  const call = vi.fn<KubernetesClient['call']>().mockResolvedValue(undefined)
  const kube = { call, resourcePath: (namespace: string, kind: string, name?: string) =>
    `/api/v1/namespaces/${namespace}/${kind}${name ? `/${name}` : ''}` }
  const pods = new OfficePreviewPods(kube, pod)
  const job = officePreviewJobSchema.parse({ protocolVersion: 1, jobId: randomUUID(), nonce: randomUUID(),
    generation: 'c'.repeat(64), sourceSha256: 'd'.repeat(64), sourceBytes: 10, extension: 'docx', limits })
  const intent = pods.intent(job, accountUserId.parse(randomUUID()))
  return { pods, call, intent }
}

test('enabled Office deployment requires an explicit offline runtime and retains operator settings', async () => {
  const read = async () => JSON.stringify(deployment)
  expect(await loadOfficePreviewConfig('/owned/config/office.json', 'in-cluster', ['/owned/workspaces'], read)).toEqual(deployment)
  const { runtimeClassName: omitted, ...prior } = deployment
  expect(omitted).toBe('pe-office-offline')
  await expect(loadOfficePreviewConfig('/owned/config/office.json', 'in-cluster', ['/owned/workspaces'],
    async () => JSON.stringify(prior))).rejects.toThrow('Invalid Office preview platform configuration')
  await expect(loadOfficePreviewConfig('/owned/config/office.json', 'in-cluster', ['/owned/workspaces'],
    async () => JSON.stringify({ ...deployment, runtimeClassName: 'invalid/runtime' }))).rejects.toThrow()
})

test('a submitted parser intent fixes its offline runtime, image and private mounts', async () => {
  const { pods, call, intent } = adapter()
  expect(intent.template.spec.runtimeClassName).toBe(pod.runtimeClassName)
  expect(intent.template.spec.containers[0].image).toBe(pod.image)
  expect(intent.template.spec.containers[0].volumeMounts).toEqual([
    { name: 'preview', mountPath: '/input', subPath: `jobs/${intent.job.jobId}/input`, readOnly: true },
    { name: 'preview', mountPath: '/output', subPath: `jobs/${intent.job.jobId}/output`, readOnly: false },
    { name: 'temporary', mountPath: '/tmp', readOnly: false },
  ])
  await expect(pods.submit(intent)).rejects.toMatchObject({ code: 'office_render_unavailable' })
  expect(call).not.toHaveBeenCalled()
  const submitted = { ...intent, submittedAt: new Date().toISOString() }
  await pods.submit(submitted)
  expect(call).toHaveBeenCalledExactlyOnceWith('POST', '/api/v1/namespaces/owned-office/pods',
    submitted.template, pod.kubernetesTimeoutMs)
  const retained = structuredClone(submitted)
  delete retained.template.spec.runtimeClassName
  await expect(pods.submit(retained)).rejects.toMatchObject({ code: 'office_render_unavailable' })
  expect(call).toHaveBeenCalledTimes(1)
})

for (const actualRuntime of [undefined, 'different-runtime']) {
  test(`Pod observation refuses ${actualRuntime ?? 'missing'} runtime selection`, async () => {
    const { pods, call, intent } = adapter()
    const resource = { ...structuredClone(intent.template), metadata: { ...intent.template.metadata,
      uid: randomUUID(), resourceVersion: '1', generation: 1 } }
    if (actualRuntime === undefined) delete resource.spec.runtimeClassName
    else resource.spec.runtimeClassName = actualRuntime
    call.mockResolvedValue(resource)
    await expect(pods.observe(intent)).rejects.toMatchObject({ code: 'office_render_unavailable' })
  })
}
