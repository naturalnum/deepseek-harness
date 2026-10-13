/** Real Platform service and private file reads; PG rows and Kubernetes observations are explicit unit substitutes. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserId } from '@power-evolve/contracts/account'
import type { OfficePreviewGeneration, OfficePreviewJob, OfficePreviewJobId,
  OfficePreviewNonce, OfficePreviewRequestId } from '@power-evolve/contracts/office-preview'
import type { BindingWorkspaceId } from '@power-evolve/contracts/storage'
import { OfficePreviewService, type OfficePreviewConfig } from '../../application/src/platform/office-previews.ts'
import { OfficePreviewPods } from '../../application/src/platform/office-preview-pod.ts'
import type { StorageRootKey } from '../../application/src/platform/cloud-storage-types.ts'
import { transaction } from '../../application/src/platform/database.ts'
import type { KubernetesClient } from '../../application/src/platform/kubernetes.ts'

const owner = brandString<UserId>('10000000-0000-4000-8000-000000000001')
const workspace = '20000000-0000-4000-8000-000000000002'
const session = '30000000-0000-4000-8000-000000000003'
const id = '40000000-0000-4000-8000-000000000004'
const nonce = '50000000-0000-4000-8000-000000000005'
const token = 'employee1_wire_token_'.padEnd(64, 'x')
const source = Buffer.from('independent immutable Office source fixture')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}'
  return JSON.stringify(value)
}
function hash(value: unknown): string { return sha(Buffer.from(canonical(value))) }
const limits = { inputBytes: source.length, outputBytes: 1024, timeoutMs: 1000, archiveEntries: 10,
  uncompressedBytes: 2048, fontLoadedBytes: 2048, pages: 2, fontFiles: 2, fontFileBytes: 1024,
  fontResolutionEntries: 10, imageResolution: 150 }
type ConsumerPool = ConstructorParameters<typeof OfficePreviewService>[0]
type ConsumerClient = Parameters<Parameters<typeof transaction>[1]>[0]
// Resolve the consumer owner's installed public dependency; no Contracts manifest, private PG path or built product is substituted.
const pg: unknown = createRequire(new URL('../../application/package.json', import.meta.url))('pg')
const constructors = z.object({
  Pool: z.custom<new () => ConsumerPool>(value => typeof value === 'function'),
  Client: z.custom<new () => ConsumerClient>(value => typeof value === 'function'),
}).parse(pg)

async function fixture(run: (f: {
  service: OfficePreviewService
  row: Record<string, unknown>
  job: OfficePreviewJob
  result: Record<string, unknown>
  failure: Record<string, unknown>
  generation: OfficePreviewGeneration
  output: string
  sourceRead: ReturnType<typeof vi.fn>
  kubeCall: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>
  queries: string[]
  resource: Record<string, unknown>
  setResource: (value: unknown) => void
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'employee1-office-consumer-'))
  const pool = new constructors.Pool()
  try {
    const c: OfficePreviewConfig = { namespace: 'employee1-office', runtimeClassName: 'owned-offline',
      image: 'fixture.example/office@sha256:' + 'a'.repeat(64), volumeClaimName: 'owned-cache', volumeSubPath: 'jobs',
      kubernetesTimeoutMs: 1000, terminationGraceSeconds: 1, cpuMilliCores: 1000, memoryMiB: 512, temporaryMiB: 64,
      localRoot: root, fontPolicyDigest: 'b'.repeat(64), limits, maxConcurrentParsers: 1, maxRetainedJobsPerUser: 8,
      leaseMs: 10_000, jobDeadlineMs: 30_000 }
    const conversion = { protocolVersion: 1, kitVersion: '0.1.1', fontPolicyDigest: c.fontPolicyDigest, limits,
      pod: { namespace: c.namespace, runtimeClassName: c.runtimeClassName, image: c.image,
        volumeClaimName: c.volumeClaimName, volumeSubPath: c.volumeSubPath, terminationGraceSeconds: c.terminationGraceSeconds,
        cpuMilliCores: c.cpuMilliCores, memoryMiB: c.memoryMiB, temporaryMiB: c.temporaryMiB, safetyVersion: 2 } }
    const generation = brandString<OfficePreviewGeneration>(hash(conversion))
    const job: OfficePreviewJob = { protocolVersion: 1, jobId: brandString<OfficePreviewJobId>(id),
      nonce: brandString<OfficePreviewNonce>(nonce), generation,
      sourceSha256: sha(source), sourceBytes: source.length, extension: 'docx', limits }
    const request = { requestId: '60000000-0000-4000-8000-000000000006', sessionId: session,
      path: '报告.docx', priority: 'foreground', generation }
    const binding = { workspaceId: brandString<BindingWorkspaceId>(workspace), spaceId: '70000000-0000-4000-8000-000000000007',
      rootKey: brandString<StorageRootKey>('80000000-0000-4000-8000-000000000008'), rootRelativePath: 'owned-workspace', generation: 1 }
    let observed: unknown
    const kubeCall = vi.fn(async (method: string) => {
      if (method === 'GET') return observed
      if (method === 'DELETE') return undefined
      throw new Error('Unexpected Kubernetes effect: ' + method)
    })
    const kube: Pick<KubernetesClient, 'call' | 'resourcePath'> = {
      resourcePath: (namespace, kind, name) => `/api/v1/namespaces/${namespace}/${kind}/${name}`,
      // The production Pod adapter validates this unknown API payload before consuming it.
      call: async <T>(method: string): Promise<T> => await kubeCall(method) as T,
    }
    const intent = { ...new OfficePreviewPods(kube, c).intent(job, owner), submittedAt: '2026-10-09T00:00:00.000Z' }
    const identity = { name: intent.template.metadata.name, uid: '90000000-0000-4000-8000-000000000009', generation: 1,
      nodeName: 'owned-node', containerId: 'containerd://' + 'c'.repeat(64), imageId: c.image }
    const result: Record<string, unknown> = { protocolVersion: 1, jobId: id, nonce, generation, sourceSha256: sha(source),
      pdfSha256: sha(pdf), pdfBytes: pdf.length, pages: 1, missingFonts: [], backend: 'wasm' }
    const failure: Record<string, unknown> = { protocolVersion: 1, jobId: id, nonce, generation,
      sourceSha256: sha(source), errorCode: 'invalid-document' }
    const row: Record<string, unknown> = { id, user_id: owner, request_id: request.requestId, generation,
      request_digest: hash(request), request, session_id: session, workspace_id: workspace, binding_snapshot: binding,
      source_snapshot: job, converter_snapshot: conversion, state: 'succeeded', cancel_requested: false, error_code: null,
      deadline_at: new Date(Date.now() + 30_000), lease_owner: null, lease_epoch: 0, lease_until: null,
      attempts: 1, parser_slot: null, creation_intent: intent, pod_identity: identity, worker_observation: null,
      stop_evidence: { status: 'KUBELET_STOPPED', jobId: id, nonce, generation, identity, observedAt: '2026-10-09T00:01:00.000Z' },
      result, created_at: new Date(), updated_at: new Date(), completed_at: new Date() }
    const resource: Record<string, unknown> = { ...structuredClone(intent.template),
      metadata: { ...intent.template.metadata, uid: identity.uid, generation: 1, resourceVersion: '1' },
      spec: { ...intent.template.spec, nodeName: identity.nodeName },
      // A worker exit without native generation/stop observations deliberately is not a stop proof.
      status: { phase: 'Succeeded', containerStatuses: [{ name: 'parser', restartCount: 0, ready: false, started: false,
        containerID: identity.containerId, imageID: identity.imageId, state: { terminated: { exitCode: 0,
          containerID: identity.containerId, startedAt: '2026-10-09T00:00:00.000Z', finishedAt: '2026-10-09T00:00:01.000Z' } } }] } }
    observed = resource
    const queries: string[] = []
    const query = async (sql: string, values: readonly unknown[] = []) => {
      queries.push(sql)
      const answer = (rows: unknown[]) => ({ rows, rowCount: rows.length })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return answer([])
      if (sql.includes('SELECT user_id FROM pe_credentials')) return answer([{ user_id: owner }])
      if (sql.includes('SELECT digest FROM pe_credentials')) return answer([{ digest: sha(Buffer.from(token)) }])
      if (sql.includes('FROM pe_users')) return answer([{ userId: owner, username: 'employee1-fixture', displayName: 'Fixture',
        role: 'USER', enabled: true, revision: 1, credentialVersion: 1, passwordChangeRequired: false, deletedAt: null }])
      if (sql.includes('SELECT workspace_id FROM pe_sessions')) return answer([{ workspace_id: workspace }])
      if (sql.includes('SELECT id FROM pe_workspaces')) return answer([{ id: workspace }])
      if (sql.includes('AS expired')) return answer([{ expired: false }])
      if (sql.startsWith('SELECT * FROM pe_office_preview_jobs')) return answer([row])
      if (sql.includes("SET state=CASE WHEN state='queued'")) {
        row.lease_owner = values[2]; row.lease_epoch = Number(row.lease_epoch) + 1
        row.lease_until = new Date(Date.now() + 10_000); row.attempts = Number(row.attempts) + 1
      } else if (sql.includes('SET lease_until=')) row.lease_until = new Date(Date.now() + 10_000)
      else if (sql.includes('SET pod_identity=$2')) { const value: unknown = JSON.parse(z.string().parse(values[1])); row.pod_identity = value }
      else if (sql.includes('SET worker_observation=$2')) {
        const observation: unknown = JSON.parse(z.string().parse(values[1]))
        const marker: unknown = values[2] === null ? null : JSON.parse(z.string().parse(values[2]))
        row.worker_observation = observation; row.result = marker
      } else if (sql.includes("SET state='stopping'")) { row.state = 'stopping'; row.error_code = null }
      else if (sql.includes('SET lease_owner=NULL')) { row.lease_owner = null; row.lease_until = null }
      else throw new Error('Unmodelled SQL: ' + sql)
      return answer([row])
    }
    const client = new constructors.Client()
    Object.defineProperty(client, 'query', { value: query })
    Object.defineProperty(client, 'release', { value: vi.fn() })
    Object.defineProperty(pool, 'connect', { value: async () => client })
    Object.defineProperty(pool, 'query', { value: query })
    const sourceRead = vi.fn(async () => ({ path: '报告.docx', mime: 'application/octet-stream',
      data: source.toString('base64'), size: source.length, revision: sha(source) }))
    const files = { bindingForId: vi.fn(async () => binding), readInWorkspace: sourceRead }
    const output = join(root, id, 'output')
    await mkdir(join(root, id), { mode: 0o700 }); await mkdir(output, { mode: 0o700 })
    await writeFile(join(output, 'result.pdf'), pdf, { mode: 0o600, flag: 'wx' })
    const service = new OfficePreviewService(pool, files, kube, c)
    try { await run({ service, row, job, result, failure, generation, output, sourceRead, kubeCall, queries, resource,
      setResource: (value) => { observed = value } }) }
    finally { await service.stop() }
  } finally { await pool.end(); await rm(root, { recursive: true, force: true }) }
}

test('Platform content reads exact original PDF with separately bound persisted stop evidence', () => fixture(async (f) => {
  const before = structuredClone(f.row)
  const value = await f.service.content(token, { jobId: f.job.jobId, generation: f.generation })
  expect(Buffer.from(value.data, 'base64')).toEqual(pdf)
  expect(value).toMatchObject({ absolutePath: '/workspace/报告.docx', version: sha(source), pdfSha256: sha(pdf), eof: true, offset: 0 })
  expect(f.sourceRead).toHaveBeenCalledTimes(2)
  expect(f.row).toEqual(before)
  expect(f.kubeCall).not.toHaveBeenCalled()
  expect(f.queries.some(sql => /^(?:UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false)
}))

for (const [field, value] of [['jobId', randomUUID()], ['nonce', randomUUID()], ['generation', 'd'.repeat(64)],
  ['sourceSha256', 'd'.repeat(64)], ['backend', 'native'], ['pdfBytes', 8_388_609]] as const) {
  test('Platform rejects retained result ' + field + ' substitution without reads or effects', () => fixture(async (f) => {
    f.row.result = { ...f.result, [field]: value }
    const before = structuredClone(f.row)
    await expect(f.service.content(token, { jobId: f.job.jobId, generation: f.generation }))
      .rejects.toMatchObject({ code: 'office_render_unavailable' })
    expect(f.row).toEqual(before)
    expect(f.sourceRead).not.toHaveBeenCalled()
    expect(f.kubeCall).not.toHaveBeenCalled()
  }))
}

for (const [name, change] of [
  ['missing independent stop', null],
  ['marker used as stop', { protocolVersion: 1, jobId: id, nonce, sourceSha256: sha(source), errorCode: 'failed' }],
  ['wrong nonce stop', { status: 'KUBELET_STOPPED', jobId: id, nonce: randomUUID(), observedAt: '2026-10-09T00:01:00.000Z' }],
] as const) {
  test('Platform refuses ' + name + ' even with a valid result and PDF', () => fixture(async (f) => {
    f.row.stop_evidence = change === null ? null : { ...change, generation: f.generation, identity: f.row.pod_identity }
    await expect(f.service.content(token, { jobId: f.job.jobId, generation: f.generation }))
      .rejects.toMatchObject({ code: 'office_render_unavailable' })
    expect(f.sourceRead).not.toHaveBeenCalled()
    expect(f.kubeCall).not.toHaveBeenCalled()
  }))
}

for (const [name, bytes] of [['fake signature', Buffer.from('NOT-PDF\n%%EOF\n')],
  ['missing PDF EOF', Buffer.from('%PDF-1.4\ntruncated')], ['changed digest', Buffer.from('%PDF-1.4\nchanged\n%%EOF\n')]] as const) {
  test('Platform refuses physical ' + name + ' without returning content or mutating facts', () => fixture(async (f) => {
    await writeFile(join(f.output, 'result.pdf'), bytes)
    if (name !== 'changed digest') f.row.result = { ...f.result, pdfBytes: bytes.length, pdfSha256: sha(bytes) }
    const before = structuredClone(f.row)
    await expect(f.service.content(token, { jobId: f.job.jobId, generation: f.generation }))
      .rejects.toMatchObject({ code: 'office_render_invalid-output' })
    expect(f.row).toEqual(before)
    expect(await readFile(join(f.output, 'result.pdf'))).toEqual(bytes)
    expect(f.kubeCall).not.toHaveBeenCalled()
  }))
}

for (const kind of ['result', 'failure'] as const) {
  for (const field of ['jobId', 'nonce', 'generation', 'sourceSha256'] as const) {
    test('actual tick refuses wire ' + kind + ' marker with wrong ' + field, () => fixture(async (f) => {
      f.row.state = 'running'; f.row.stop_evidence = null; f.row.result = null; f.row.parser_slot = 0; f.row.completed_at = null
      const marker = kind === 'result' ? f.result : f.failure
      await writeFile(join(f.output, kind === 'result' ? 'result.json' : 'failure.json'),
        JSON.stringify({ ...marker, [field]: field === 'jobId' || field === 'nonce' ? randomUUID() : 'd'.repeat(64) }), { mode: 0o600 })
      await f.service.tick()
      expect(f.row).toMatchObject({ state: 'stopping', result: null, stop_evidence: null,
        worker_observation: { errorCode: 'invalid-output', failure: null } })
      await expect(f.service.content(token, { jobId: f.job.jobId, generation: f.generation }))
        .rejects.toMatchObject({ code: 'office_render_unavailable' })
      expect(f.kubeCall.mock.calls.map(([method]) => method)).toEqual(['GET', 'DELETE', 'GET'])
      expect(f.sourceRead).not.toHaveBeenCalled()
    }))
  }
}

test('Platform rejects a retained job one byte over its chosen input budget before any source or Pod effect', () => fixture(async (f) => {
  f.row.source_snapshot = { ...f.job, sourceBytes: source.length + 1 }
  await expect(f.service.status(token, { jobId: f.job.jobId, generation: f.generation }))
    .rejects.toMatchObject({ code: 'office_render_unavailable' })
  expect(f.sourceRead).not.toHaveBeenCalled(); expect(f.kubeCall).not.toHaveBeenCalled()
}))

for (const [name, wire] of [
  ['extra prepare selector', { requestId: 'request', sessionId: session, path: '报告.docx', priority: 'foreground', podId: id }],
  ['noninteger generation', { jobId: id, generation: 1 }],
  ['invalid job ID', { jobId: 'wrong', generation: 'a'.repeat(64) }],
  ['mixed cancel selectors', { jobId: id, requestId: 'request', generation: 'a'.repeat(64) }],
  ['extra cancel authority', { jobId: id, generation: 'a'.repeat(64), stopProof: true }],
] as const) {
  test('Platform public request consumer rejects ' + name + ' before database access', () => fixture(async (f) => {
    const method = name === 'extra prepare selector' ? 'prepare' : name.startsWith('mixed') || name.startsWith('extra cancel')
      ? 'cancel' : 'status'
    const input = name === 'extra prepare selector' ? { ...wire, generation: f.generation } : wire
    const result: unknown = Reflect.apply(f.service[method], f.service, [token, input])
    await expect(Promise.resolve(result)).rejects.toThrow()
    expect(f.queries).toEqual([])
    expect(f.sourceRead).not.toHaveBeenCalled(); expect(f.kubeCall).not.toHaveBeenCalled()
  }))
}

test('both public cancellation selectors retain the independent existing terminal result', () => fixture(async (f) => {
  const before = structuredClone(f.row)
  const byJob = await f.service.cancel(token, { jobId: f.job.jobId, generation: f.generation })
  const byKey = await f.service.cancel(token, { requestId: brandString<OfficePreviewRequestId>('60000000-0000-4000-8000-000000000006'),
    generation: f.generation })
  expect(byJob).toEqual({ jobId: f.job.jobId, generation: f.generation, state: 'succeeded', errorCode: null })
  expect(byKey).toEqual(byJob); expect(f.row).toEqual(before)
  expect(f.queries.some(sql => /^(?:UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false)
  expect(f.kubeCall).not.toHaveBeenCalled()
}))

for (const kind of ['result', 'failure'] as const) {
  test('valid ' + kind + ' marker plus worker exit does not establish stop or publish content', () => fixture(async (f) => {
    f.row.state = 'running'; f.row.stop_evidence = null; f.row.result = null; f.row.parser_slot = 0; f.row.completed_at = null
    await writeFile(join(f.output, kind === 'result' ? 'result.json' : 'failure.json'),
      JSON.stringify(kind === 'result' ? f.result : f.failure), { mode: 0o600 })
    await f.service.tick()
    expect(f.row).toMatchObject({ state: 'stopping', stop_evidence: null, parser_slot: 0, completed_at: null })
    expect(f.row.result).toEqual(kind === 'result' ? f.result : null)
    expect(f.row.worker_observation).toMatchObject({ errorCode: kind === 'result' ? null : 'invalid-document' })
    await expect(f.service.content(token, { jobId: f.job.jobId, generation: f.generation }))
      .rejects.toMatchObject({ code: 'office_render_unavailable' })
    expect(f.kubeCall.mock.calls.map(([method]) => method)).toEqual(['GET', 'DELETE', 'GET'])
    expect(f.queries.some(sql => sql.includes('SET stop_evidence=') || sql.includes('completed_at=clock_timestamp()'))).toBe(false)
  }))
}
