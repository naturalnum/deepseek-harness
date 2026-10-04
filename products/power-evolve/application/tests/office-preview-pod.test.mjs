/** Explicit Kubernetes API substitutes; native termination shapes do not claim a real kubelet observation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { OfficePreviewPods } from '../lib/platform/office-preview-pod.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'

const config = { namespace: 'office-test', image: `test.invalid/parser@sha256:${'a'.repeat(64)}`,
  volumeClaimName: 'private-output', volumeSubPath: 'office-previews', kubernetesTimeoutMs: 1000,
  terminationGraceSeconds: 2, cpuMilliCores: 1000, memoryMiB: 3072, temporaryMiB: 512 }
const job = () => ({ protocolVersion: 1, jobId: randomUUID(), nonce: randomUUID(), generation: 'c'.repeat(64),
  sourceSha256: 'd'.repeat(64), sourceBytes: 100, extension: 'docx', limits: { inputBytes: 2097152, outputBytes: 8388608,
    timeoutMs: 120000, archiveEntries: 10000, uncompressedBytes: 134217728, fontLoadedBytes: 268435456,
    pages: 1000, fontFiles: 10000, fontFileBytes: 134217728, fontResolutionEntries: 100000, imageResolution: 200 } })
function fixture() {
  let raw = null
  const calls = [], kube = { resourcePath: (namespace, resource, name) => `/${namespace}/${resource}${name ? `/${name}` : ''}`,
    async call(method, path, body) {
      calls.push({ method, path, body: structuredClone(body) })
      if (method === 'GET') { if (!raw) throw new KubernetesError(404, 'fixture missing'); return structuredClone(raw) }
      return null
    } }
  const pods = new OfficePreviewPods(kube, config), intent = pods.intent(job(), randomUUID())
  const source = structuredClone(intent.template)
  Object.assign(source.metadata, { uid: randomUUID(), resourceVersion: '1', generation: 1 })
  return { pods, intent, source, calls, set: value => { raw = value } }
}

test('fixed template mounts only exact source/output and bounded tmp, with no SA credentials or PVC-wide permission changes', () => {
  const f = fixture(), { spec } = f.intent.template
  assert.equal(spec.automountServiceAccountToken, false); assert.equal(spec.restartPolicy, 'Never')
  assert.equal(spec.securityContext.runAsUser, 1000); assert.equal(spec.securityContext.runAsGroup, 1000)
  assert.equal(spec.securityContext.fsGroup, undefined); assert.equal(spec.securityContext.fsGroupChangePolicy, undefined)
  assert.deepEqual(spec.containers[0].resources.limits, { cpu: '1', memory: '3Gi' })
  assert.equal(spec.volumes[1].emptyDir.sizeLimit, '512Mi')
  assert.deepEqual(spec.containers[0].env, [{ name: 'HOME', value: '/tmp' }, { name: 'TMPDIR', value: '/tmp' }])
  assert.deepEqual(spec.containers[0].volumeMounts.map(m => [m.mountPath, m.readOnly, m.subPath]), [
    ['/input', true, `office-previews/${f.intent.job.jobId}/input`],
    ['/output', false, `office-previews/${f.intent.job.jobId}/output`], ['/tmp', false, undefined] ])
  assert.equal(spec.containers[0].command, undefined); assert.equal(spec.containers[0].args, undefined)
  assert.equal(f.intent.template.metadata.annotations['powerevolve.dev/preview-generation'], f.intent.job.generation)
})

test('POST requires a persisted submission permit and preserves the exact template', async () => {
  const f = fixture()
  await assert.rejects(f.pods.submit(f.intent), { code: 'office_render_unavailable' })
  assert.equal(f.calls.length, 0)
  await f.pods.submit({ ...f.intent, submittedAt: '2026-10-05T00:00:00Z' })
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body, f.intent.template)
})

test('unsafe actual mounts, environment, privilege, entrypoint and replacement identity reject before mutation', async () => {
  const changes = [
    p => { p.spec.volumes.push({ name: 'host', hostPath: { path: '/' } }) },
    p => { p.spec.containers[0].volumeMounts[0].readOnly = false },
    p => { p.spec.containers[0].volumeMounts[1].subPathExpr = 'other' },
    p => { p.spec.containers[0].env.push({ name: 'TOKEN', value: 'synthetic' }) },
    p => { p.spec.containers[0].command = ['other'] },
    p => { p.spec.containers[0].securityContext.capabilities.add = ['SYS_ADMIN'] },
    p => { p.spec.securityContext.fsGroup = 1000 },
    p => { p.spec.containers[0].image = `test.invalid/parser@sha256:${'b'.repeat(64)}` },
    p => { p.metadata.labels['powerevolve.dev/preview-nonce'] = randomUUID() },
  ]
  for (const change of changes) {
    const f = fixture(); change(f.source); f.set(f.source)
    await assert.rejects(f.pods.observe(f.intent), { code: 'office_render_unavailable' })
    assert.equal(f.calls.every(c => c.method === 'GET'), true)
  }
  const f = fixture(); f.set(f.source)
  const original = await f.pods.observe(f.intent)
  f.source.metadata.uid = randomUUID(); f.set(f.source)
  await assert.rejects(f.pods.observe(f.intent, original.identity), { code: 'office_render_unavailable' })
})

test('404 is not proof; an unscheduled retained deletion produces proof before exact finalizer release', async () => {
  const f = fixture()
  assert.equal(await f.pods.observe(f.intent), null)
  f.set(f.source)
  assert.equal((await f.pods.observe(f.intent)).stopProof, null)
  f.source.metadata.deletionTimestamp = '2026-10-05T00:00:00Z'
  f.source.metadata.finalizers.push('example.invalid/foreign')
  f.set(f.source)
  const observed = await f.pods.observe(f.intent)
  assert.equal(observed.stopProof.status, 'UNSCHEDULED_DELETING')
  await assert.rejects(f.pods.release(f.intent, observed, { ...observed.stopProof, nonce: randomUUID() }), { code: 'office_render_unavailable' })
  await f.pods.release(f.intent, observed, observed.stopProof)
  const patch = f.calls.find(c => c.method === 'PATCH')
  assert.equal(patch.body.metadata.uid, f.source.metadata.uid)
  assert.equal(patch.body.metadata.resourceVersion, '1')
  assert.deepEqual(patch.body.metadata.finalizers, ['example.invalid/foreign'])
})
