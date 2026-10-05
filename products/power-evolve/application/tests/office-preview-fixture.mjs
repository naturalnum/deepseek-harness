/** Disposable real PG, real FileService/bytes, and explicit Kubernetes API substitutes; no WASM or kubelet runs. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSandboxFixture } from './sandbox-binding-fixture.mjs'
import { taskCredential } from './task-credential-fixture.mjs'
import { FileService } from '../lib/platform/files.js'
import { OfficePreviewService } from '../lib/platform/office-previews.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const limits = { inputBytes: 2 * 1024 * 1024, outputBytes: 8 * 1024 * 1024,
  timeoutMs: 120000, archiveEntries: 10000, uncompressedBytes: 128 * 1024 * 1024,
  fontLoadedBytes: 256 * 1024 * 1024, pages: 1000, fontFiles: 10000,
  fontFileBytes: 128 * 1024 * 1024, fontResolutionEntries: 100000, imageResolution: 200 }
export const podConfig = { namespace: 'office-test', image: `test.invalid/parser@sha256:${'a'.repeat(64)}`,
  volumeClaimName: 'private-output', volumeSubPath: 'office-previews', kubernetesTimeoutMs: 1000,
  terminationGraceSeconds: 2, cpuMilliCores: 1000, memoryMiB: 3072, temporaryMiB: 512 }

export class PreviewKubernetes {
  resources = new Map()
  get pod() { return this.resources.values().next().value ?? null }
  set pod(value) { this.resources.clear(); if (value) this.resources.set(value.metadata.name, value) }
  mutations = []
  onCall = async () => {}
  supplyProof = true
  losePost = false
  losePatch = false
  deferWorkerStart = false
  resourcePath(namespace, resource, name) { return `/${namespace}/${resource}${name ? `/${name}` : ''}` }
  async call(method, path, body) {
    await this.onCall(method, path, body)
    const name = path.split('/').at(-1)
    let pod = this.resources.get(name)
    if (method === 'GET') {
      if (!pod) throw new KubernetesError(404, 'fixture missing')
      return structuredClone(pod)
    }
    this.mutations.push({ method, path, body: structuredClone(body) })
    if (method === 'POST') {
      if (this.resources.has(body.metadata.name)) throw new KubernetesError(409, 'fixture exists')
      pod = structuredClone(body)
      this.resources.set(pod.metadata.name, pod)
      Object.assign(pod.metadata, { uid: randomUUID(), resourceVersion: '1', generation: 1 })
      if (!this.deferWorkerStart) this.start(pod.metadata.name)
      if (this.losePost) { this.losePost = false; throw new Error('fixture lost POST acknowledgment') }
      return structuredClone(pod)
    }
    if (!pod) throw new KubernetesError(404, 'fixture missing')
    assert.equal(body.metadata?.uid ?? body.preconditions?.uid, pod.metadata.uid)
    if (method === 'DELETE') {
      // The first graceful deletion advances the native generation, as the real apiserver does.
      if (!pod.metadata.deletionTimestamp) pod.metadata.generation += 1
      pod.metadata.deletionTimestamp = '2026-10-05T00:01:00Z'
      if (this.supplyProof) this.terminate(pod.status.containerStatuses[0].state.terminated?.exitCode ?? 137, name)
      return null
    }
    if (method === 'PATCH') {
      assert.equal(body.metadata.resourceVersion, pod.metadata.resourceVersion)
      pod.metadata.finalizers = body.metadata.finalizers
      if (!pod.metadata.finalizers.length) this.resources.delete(name)
      if (this.losePatch) { this.losePatch = false; throw new Error('fixture lost PATCH acknowledgment') }
      return null
    }
    throw new Error('Unexpected preview fixture operation')
  }
  start(name = this.pod.metadata.name) {
    const pod = this.resources.get(name)
    pod.spec.nodeName = 'qa-node'
    pod.status = { phase: 'Running', containerStatuses: [{ name: 'parser', ready: true, restartCount: 0,
      containerID: `containerd://${'b'.repeat(64)}`, imageID: `sha256:${'a'.repeat(64)}`,
      state: { running: { startedAt: '2026-10-05T00:00:00Z' } } }] }
  }
  terminate(exitCode = 0, name = this.pod.metadata.name) {
    const pod = this.resources.get(name), worker = pod.status.containerStatuses[0]
    Object.assign(worker, { ready: false, started: false, lastState: {}, state: { terminated: { containerID: worker.containerID, exitCode,
      startedAt: '2026-10-05T00:00:00Z', finishedAt: '2026-10-05T00:00:30Z' } } })
    pod.status.phase = exitCode === 0 ? 'Succeeded' : 'Failed'
    pod.status.observedGeneration = pod.metadata.generation
    pod.status.conditions = [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: pod.metadata.generation }]
  }
}

export async function previewFixture(t, overrides = {}) {
  let service
  // Stop any admitted tick before the disposable database or source files are removed.
  t.after(() => service?.stop())
  const f = await createSandboxFixture(t, {}, 4)
  const userId = await f.createUser(), session = await f.createSession(userId)
  const user = { userId, username: `test-${userId}` }
  const root = join(f.localRoot, 'workspaces')
  await mkdir(join(root, session.workspaceId), { recursive: true, mode: 0o700 })
  const files = new FileService(f.pool, root)
  await files.init()
  const sourcePath = 'document.docx', source = Buffer.from('synthetic Office source\0😀')
  await writeFile(join(root, session.workspaceId, sourcePath), source, { mode: 0o600 })
  const kube = new PreviewKubernetes()
  const config = { ...podConfig, localRoot: join(f.localRoot, 'previews'), fontPolicyDigest: 'f'.repeat(64), limits,
    maxConcurrentParsers: 1, maxRetainedJobsPerUser: 32, leaseMs: 10000, jobDeadlineMs: 180000, ...overrides }
  service = new OfficePreviewService(f.pool, files, kube, config)
  const token = await taskCredential(f.pool, user), generation = (await service.generation(token)).generation
  const request = { requestId: randomUUID(), sessionId: session.sessionId, path: sourcePath, priority: 'foreground', generation }
  const accept = async (change = {}) => service.prepare(token, { ...request, ...change })
  const state = async id => (await f.pool.query('SELECT * FROM pe_office_preview_jobs WHERE id=$1', [id])).rows[0]
  const ref = job => ({ jobId: job.jobId, generation: job.generation })
  return { ...f, ...session, user, userId, files, root, source, sourcePath, service, token, generation, request, config, kube, accept, state, ref }
}

export async function successOutput(f, job, pdf = Buffer.from('%PDF-1.4\n% deterministic byte fixture\n%%EOF\n')) {
  const row = await f.state(job.jobId), source = row.source_snapshot
  const result = { protocolVersion: 1, jobId: job.jobId, nonce: source.nonce, generation: job.generation,
    sourceSha256: source.sourceSha256, pdfSha256: sha(pdf), pdfBytes: pdf.length, pages: 1, missingFonts: [], backend: 'wasm' }
  await writeFile(join(f.config.localRoot, job.jobId, 'output/result.pdf'), pdf, { mode: 0o600 })
  await writeFile(join(f.config.localRoot, job.jobId, 'output/result.json'), JSON.stringify(result), { mode: 0o600 })
  f.kube.terminate(0)
  return { result, pdf }
}
