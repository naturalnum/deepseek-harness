/** Deployment parsing rejects unsafe placement and inconsistent budgets before service initialization. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadOfficePreviewConfig } from '../src/platform/office-preview-config.ts'

const settings = {
  namespace: 'pe-office-preview', image: `example.invalid/parser@sha256:${'a'.repeat(64)}`,
  volumeClaimName: 'preview-data', volumeSubPath: 'office-previews', localRoot: '/srv/storage/office-previews',
  fontPolicyDigest: 'b'.repeat(64), limits: { inputBytes: 2097152, outputBytes: 8388608, timeoutMs: 120000,
    archiveEntries: 10000, uncompressedBytes: 134217728, fontLoadedBytes: 268435456, pages: 1000,
    fontFiles: 10000, fontFileBytes: 134217728, fontResolutionEntries: 100000, imageResolution: 300 },
  maxConcurrentParsers: 1, maxRetainedJobsPerUser: 100, leaseMs: 60000, jobDeadlineMs: 180000, pollMs: 500,
  kubernetesTimeoutMs: 10000, terminationGraceSeconds: 10, cpuMilliCores: 1000, memoryMiB: 3072, temporaryMiB: 512,
}
const protectedRoots = ['/srv/storage/workspaces', '/srv/storage/artifacts', '/srv/storage/homes', '/srv/storage/skill-packages']
const load = (value: object, roots = protectedRoots) => loadOfficePreviewConfig('/private/preview.json', '/private/kubeconfig', roots,
  async () => JSON.stringify(value))

test('disabled previews read no configuration; paired references are required', async () => {
  assert.equal(await loadOfficePreviewConfig('', '', protectedRoots, async () => { throw new Error('unexpected read') }), null)
  await assert.rejects(loadOfficePreviewConfig('/private/preview.json', '', protectedRoots), /Invalid Office preview platform configuration/u)
  await assert.rejects(loadOfficePreviewConfig('', '/private/kubeconfig', protectedRoots), /Invalid Office preview platform configuration/u)
})

test('valid parser settings retain every explicit limit and placement value', async () => {
  assert.deepEqual(await load(settings), settings)
  assert.deepEqual(await loadOfficePreviewConfig('/private/preview.json', 'in-cluster', protectedRoots,
    async () => JSON.stringify(settings)), settings)
})

test('placement cannot use mutable images, unsafe subpaths or overlapping protected roots', async () => {
  for (const replacement of [{ image: 'example.invalid/parser:latest' }, { volumeSubPath: '../workspaces' },
    { volumeSubPath: '/office-previews' }, { localRoot: '/srv/storage/workspaces' },
    { localRoot: '/srv/storage/workspaces/preview' }, { localRoot: '/srv/storage' },
    { namespace: 'Invalid Namespace' }, { localRoot: '/srv/storage/../office-previews' }]) {
    await assert.rejects(load({ ...settings, ...replacement }), /Invalid Office preview platform configuration/u)
  }
})

test('bounded timers, parser limits and unknown settings fail with redacted diagnostics', async () => {
  for (const replacement of [{ pollMs: 60000 }, { leaseMs: 10000 }, { jobDeadlineMs: 1000 },
    { pollMs: 2147483648 }, { cpuMilliCores: 0 }, { arbitraryCommand: 'private-value' },
    { limits: { ...settings.limits, outputBytes: 8388609 } }]) {
    await assert.rejects(load({ ...settings, ...replacement }), { message: 'Invalid Office preview platform configuration' })
  }
  await assert.rejects(loadOfficePreviewConfig('/private/preview.json', '/private/kubeconfig', protectedRoots,
    async () => { throw new Error('private-value') }), { message: 'Invalid Office preview platform configuration' })
})
