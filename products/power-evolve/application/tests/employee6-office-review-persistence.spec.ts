/** Retained Office generations through the actual service with owned, in-memory PG and Kubernetes observations. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { accountUserId } from '@power-evolve/contracts/account'
import { officePreviewJobSchema, officePreviewSourcePrepareRequest, officePreviewJobView, officePreviewErrorCode } from '@power-evolve/contracts/office-preview'
import { OfficePreviewService, type OfficePreviewConfig } from '../src/platform/office-previews.ts'
import { OfficePreviewPods, officePreviewPodIntent } from '../src/platform/office-preview-pod.ts'
import { loadOfficePreviewConfig } from '../src/platform/office-preview-config.ts'
import { KubernetesError, type KubernetesClient } from '../src/platform/kubernetes.ts'

const limits = { inputBytes: 16_777_216, outputBytes: 8_388_608, timeoutMs: 20_000,
  archiveEntries: 1000, uncompressedBytes: 67_108_864, fontLoadedBytes: 134_217_728,
  pages: 100, fontFiles: 100, fontFileBytes: 134_217_728, fontResolutionEntries: 1000, imageResolution: 150 }
const owner = accountUserId.parse(randomUUID()), workspace = randomUUID(), session = randomUUID()
const token = 'e'.repeat(64)
const bytes = Buffer.from('owned Office input')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}'
  return JSON.stringify(value)
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
const sourceDigest = createHash('sha256').update(bytes).digest('hex')
function config(localRoot: string, runtimeClassName = 'office-reviewed-a'): OfficePreviewConfig {
  return { namespace: 'owned-office', runtimeClassName,
    image: `registry.example/office@sha256:${'a'.repeat(64)}`, volumeClaimName: 'office-cache', volumeSubPath: 'jobs',
    kubernetesTimeoutMs: 5000, terminationGraceSeconds: 5, cpuMilliCores: 1000, memoryMiB: 2048, temporaryMiB: 256,
    localRoot, fontPolicyDigest: 'b'.repeat(64), limits, maxConcurrentParsers: 2, maxRetainedJobsPerUser: 32,
    leaseMs: 30_000, jobDeadlineMs: 60_000 }
}
function conversion(c: OfficePreviewConfig, safetyVersion: 1 | 2, runtimeClassName?: string) {
  return { protocolVersion: 1, kitVersion: '0.1.1', fontPolicyDigest: c.fontPolicyDigest, limits: c.limits,
    pod: { namespace: c.namespace, image: c.image, volumeClaimName: c.volumeClaimName, volumeSubPath: c.volumeSubPath,
      terminationGraceSeconds: c.terminationGraceSeconds, cpuMilliCores: c.cpuMilliCores,
      memoryMiB: c.memoryMiB, temporaryMiB: c.temporaryMiB, safetyVersion,
      ...(runtimeClassName === undefined ? {} : { runtimeClassName }) } }
}
const binding = { spaceId: randomUUID(), rootRelativePath: 'owned-workspace', workspaceId: workspace,
  rootKey: randomUUID(), generation: 1 }
const noInfrastructure = { call: vi.fn<KubernetesClient['call']>(), resourcePath: (namespace: string, kind: string, name?: string) =>
  `/api/v1/namespaces/${namespace}/${kind}${name ? '/' + name : ''}` }

type State = 'queued' | 'creating' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'blocked'
function retained(c: OfficePreviewConfig, state: State, safetyVersion: 1 | 2, runtimeClassName?: string) {
  const snapshot = conversion(c, safetyVersion, runtimeClassName), generation = hash(snapshot), id = randomUUID()
  const request = officePreviewSourcePrepareRequest.parse({ requestId: randomUUID(), sessionId: session,
    path: 'report.docx', priority: 'foreground', generation })
  const job = officePreviewJobSchema.parse({ protocolVersion: 1, jobId: id, nonce: randomUUID(), generation,
    sourceSha256: sourceDigest, sourceBytes: bytes.length, extension: 'docx', limits })
  const fresh = new OfficePreviewPods(noInfrastructure, c).intent(job, owner)
  const selected = structuredClone(fresh)
  if (runtimeClassName === undefined) delete selected.template.spec.runtimeClassName
  else selected.template.spec.runtimeClassName = runtimeClassName
  selected.templateDigest = hash(selected.template)
  const intent = officePreviewPodIntent.parse(selected)
  const identity = { name: intent.template.metadata.name, uid: randomUUID(), generation: 2,
    nodeName: 'owned-node', containerId: 'containerd://' + 'c'.repeat(64), imageId: c.image }
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(state)
  const result = { protocolVersion: 1, jobId: id, nonce: job.nonce, generation, sourceSha256: sourceDigest,
    pdfSha256: 'd'.repeat(64), pdfBytes: 128, pages: 1, missingFonts: [], backend: 'wasm' }
  return { id: job.jobId, user_id: owner, request_id: request.requestId, generation: job.generation, request_digest: hash(request), request,
    session_id: session, workspace_id: workspace, binding_snapshot: binding, source_snapshot: job, converter_snapshot: snapshot,
    state, cancel_requested: state === 'cancelled', error_code: state === 'failed' ? 'failed' : state === 'blocked' ? 'unavailable' : null,
    deadline_at: new Date(Date.now() + 60_000), lease_owner: null, lease_epoch: 0, lease_until: null,
    attempts: 0, parser_slot: terminal || state === 'queued' ? null : 0,
    creation_intent: state === 'queued' ? null : terminal ? { ...intent, submittedAt: '2026-10-09T00:00:00.000Z' } : intent,
    pod_identity: terminal ? identity : null, worker_observation: null,
    stop_evidence: terminal ? { status: 'KUBELET_STOPPED', jobId: id, nonce: job.nonce, generation,
      identity, observedAt: '2026-10-09T00:01:00.000Z' } : null,
    result: state === 'succeeded' ? result : null,
    created_at: new Date(), updated_at: new Date(), completed_at: terminal ? new Date() : null }
}
type Retained = Omit<ReturnType<typeof retained>, 'lease_owner' | 'lease_until'> & {
  lease_owner: string | null
  lease_until: Date | null
}

/** Query responses model durable rows; no database connections or production resources are opened. */
async function fixture(run: (f: {
  service: OfficePreviewService
  row: () => Retained | null
  set: (row: Retained | null) => void
  c: OfficePreviewConfig
  query: ReturnType<typeof vi.fn>
  kube: typeof noInfrastructure
  files: { bindingForId: ReturnType<typeof vi.fn>; readInWorkspace: ReturnType<typeof vi.fn> }
}) => Promise<void>, runtimeClassName = 'office-reviewed-a'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'employee6-office-review-'))
  try {
    const c = config(root, runtimeClassName), pool = new Pool()
    try {
      const client = Object.assign(new Client(), { release: vi.fn() })
      let row: Retained | null = null
      const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        const answer = (rows: unknown[]) => ({ rows, rowCount: rows.length })
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return answer([])
        if (sql.includes('SELECT user_id FROM pe_credentials')) return answer([{ user_id: owner }])
        if (sql.includes('FROM pe_users')) return answer([{ userId: owner, username: 'owned-user', displayName: 'Owned User',
          role: 'USER', enabled: true, revision: 1, credentialVersion: 1, passwordChangeRequired: false, deletedAt: null }])
        if (sql.includes('SELECT digest FROM pe_credentials')) return answer([{ digest: 'f'.repeat(64) }])
        if (sql.includes('SELECT workspace_id FROM pe_sessions')) return answer([{ workspace_id: workspace }])
        if (sql.includes('SELECT id FROM pe_workspaces')) return answer([{ id: workspace }])
        if (sql === 'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1') {
          expect(values).toEqual([owner])
          return answer([{ id: workspace, title: 'Owned Workspace', is_default: true }])
        }
        if (sql.startsWith('SELECT value FROM pe_native_preferences')) {
          expect(values[0]).toBe(owner)
          if (sql.includes("namespace='workspace-layout'")) return answer([])
          expect(values[1]).toBe('session-archive-stop:' + session)
          return answer([])
        }
        if (sql === 'SELECT id,workspace_id FROM pe_sessions WHERE user_id=$1') {
          expect(values).toEqual([owner])
          return answer([{ id: session, workspace_id: workspace }])
        }
        if (sql.includes('SELECT pg_advisory_xact_lock')) return answer([])
        if (sql.includes('AS expired')) return answer([{ expired: false }])
        if (sql.includes('SELECT count(*)')) return answer([{ n: row ? 1 : 0 }])
        if (sql.includes('SELECT slot FROM generate_series')) return answer([{ slot: 0 }])
        if (sql.startsWith('SELECT * FROM pe_office_preview_jobs')) {
          if (sql.includes('ORDER BY updated_at')) {
            return answer(row && ['queued', 'creating', 'running', 'stopping', 'blocked'].includes(row.state) ? [row] : [])
          }
          return answer(row ? [row] : [])
        }
        if (sql.startsWith('INSERT INTO pe_office_preview_jobs')) {
          const request = officePreviewSourcePrepareRequest.parse(JSON.parse(String(values[5])))
          const source = officePreviewJobSchema.parse(JSON.parse(String(values[9])))
          row = { ...retained(c, 'queued', 2, c.runtimeClassName), id: source.jobId, request_id: request.requestId,
            generation: source.generation, request_digest: String(values[4]), request, source_snapshot: source,
            converter_snapshot: JSON.parse(String(values[10])) as Retained['converter_snapshot'] }
          return answer([row])
        }
        if (!row) throw new Error('Unexpected SQL without a retained row: ' + sql)
        if (sql.includes('SET state=$2,cancel_requested=$3,error_code=$4')) {
          row = { ...row, state: officePreviewJobView.shape.state.parse(values[1]), cancel_requested: values[2] === true,
            error_code: officePreviewErrorCode.nullable().parse(values[3]), completed_at: new Date() }
          return answer([])
        }
        if (sql.includes("SET state=CASE WHEN state='queued'")) {
          row = { ...row, state: row.state === 'queued' ? 'creating' : row.state,
            lease_owner: typeof values[2] === 'string' ? values[2] : null, lease_epoch: row.lease_epoch + 1,
            lease_until: new Date(Date.now() + c.leaseMs), attempts: row.attempts + 1,
            parser_slot: typeof values[4] === 'number' ? values[4] : null,
            creation_intent: officePreviewPodIntent.parse(JSON.parse(String(values[5]))) }
          return answer([row])
        }
        if (sql.includes('SET lease_until=')) {
          row = { ...row, lease_until: new Date(Date.now() + c.leaseMs) }; return answer([row])
        }
        if (sql.includes('SET state=$2,error_code=$3,stop_evidence=$4')) {
          row = { ...row, state: officePreviewJobView.shape.state.parse(values[1]),
            error_code: officePreviewErrorCode.nullable().parse(values[2]), stop_evidence: JSON.parse(String(values[3])) as Retained['stop_evidence'],
            parser_slot: null, lease_owner: null, lease_until: null, completed_at: new Date() }
          return answer([])
        }
        if (sql.includes('SET creation_intent=$2')) {
          row = { ...row, creation_intent: officePreviewPodIntent.parse(JSON.parse(String(values[1]))) }
          return answer([row])
        }
        if (sql.includes('SET pod_identity=$2')) {
          row = { ...row, pod_identity: JSON.parse(String(values[1])) as Retained['pod_identity'], state: row.state === 'creating' ? 'running' : row.state }
          return answer([row])
        }
        if (sql.includes("SET state='stopping'")) {
          row = { ...row, state: 'stopping', error_code: null }; return answer([row])
        }
        if (sql.includes('SET stop_evidence=$2')) {
          row = { ...row, stop_evidence: JSON.parse(String(values[1])) as Retained['stop_evidence'] }; return answer([row])
        }
        if (sql.includes('SET state=$2,error_code=$3,parser_slot=NULL')) {
          row = { ...row, state: officePreviewJobView.shape.state.parse(values[1]),
            error_code: officePreviewErrorCode.nullable().parse(values[2]), parser_slot: null,
            lease_owner: null, lease_until: null, completed_at: new Date() }; return answer([])
        }
        if (sql.includes("SET state='blocked',error_code='unavailable'")) {
          row = { ...row, state: 'blocked', error_code: 'unavailable' }; return answer([])
        }
        if (sql.includes('SET lease_owner=NULL,lease_until=NULL')) {
          row = { ...row, lease_owner: null, lease_until: null }; return answer([])
        }
        throw new Error('Unexpected SQL: ' + sql)
      })
      Object.defineProperty(pool, 'connect', { value: async () => client })
      Object.defineProperty(pool, 'query', { value: query })
      Object.defineProperty(client, 'query', { value: query })
      const kube = { call: vi.fn<KubernetesClient['call']>().mockRejectedValue(new KubernetesError(404, 'owned missing Pod')),
        resourcePath: noInfrastructure.resourcePath }
      const files = { bindingForId: vi.fn().mockResolvedValue(binding), readInWorkspace: vi.fn().mockResolvedValue({
        data: bytes.toString('base64'), revision: sourceDigest, size: bytes.length }) }
      const serviceKube: Pick<KubernetesClient, 'call' | 'resourcePath'> = { resourcePath: kube.resourcePath,
        // Vitest erases the generic result; service observation validates these fixture responses as unknown.
        call: async <T>(...args: Parameters<KubernetesClient['call']>): Promise<T> => await kube.call(...args) as T,
      }
      const service = new OfficePreviewService(pool, files, serviceKube, c)
      try { await run({ service, row: () => row, set: (value) => { row = value }, c, query, kube, files }) }
      finally { await service.stop() }
    } finally { await pool.end() }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
  test('legacy safety1 ' + state + ' retains its original terminal facts without parser creation', async () => {
    await fixture(async (f) => {
      const row = retained(f.c, state, 1); f.set(row)
      const before = structuredClone(row)
      const ref = { jobId: row.id, generation: row.generation }
      expect(await f.service.status(token, ref)).toEqual({ ...ref, state, errorCode: row.error_code })
      expect(await f.service.cancel(token, ref)).toEqual({ ...ref, state, errorCode: row.error_code })
      expect(await f.service.prepare(token, row.request)).toEqual({ ...ref, state, errorCode: row.error_code })
      await f.service.tick()
      expect(f.row()).toEqual(before)
      expect(f.kube.call).not.toHaveBeenCalled()
      expect(f.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE pe_office_preview_jobs'))).toBe(false)
      expect(f.files.readInWorkspace).not.toHaveBeenCalled()
      await expect(f.service.content(token, ref)).rejects.toMatchObject({ status: 409, code: 'office_render_unavailable' })
    })
  })
}

test('old queued generation fails without generating or submitting a replacement intent', async () => {
  await fixture(async (f) => {
    f.set(retained(f.c, 'queued', 1))
    await f.service.tick()
    expect(f.row()).toMatchObject({ state: 'failed', error_code: 'unavailable', creation_intent: null, parser_slot: null })
    expect(f.kube.call).not.toHaveBeenCalled()
    expect(f.files.readInWorkspace).not.toHaveBeenCalled()
  })
})

test('an old unsubmitted intent can retire but can never POST under the new runtime', async () => {
  await fixture(async (f) => {
    const row = retained(f.c, 'creating', 1); f.set(row)
    await f.service.tick()
    expect(f.row()).toMatchObject({ state: 'failed', error_code: 'unavailable', parser_slot: null,
      stop_evidence: { status: 'NOT_SUBMITTED', intentDigest: row.creation_intent?.templateDigest } })
    expect(f.kube.call.mock.calls.map(([method]) => method)).toEqual(['GET'])
  })
})

test('a submitted legacy intent missing its Pod retains a blocked slot without retry or false stop proof', async () => {
  await fixture(async (f) => {
    const row = retained(f.c, 'creating', 1)
    if (!row.creation_intent) throw new Error('Expected original intent')
    row.creation_intent.submittedAt = '2026-10-09T00:00:00.000Z'
    f.set(row)
    await f.service.tick()
    expect(f.row()).toMatchObject({ state: 'blocked', error_code: 'unavailable', parser_slot: 0, stop_evidence: null })
    expect(f.kube.call.mock.calls.map(([method]) => method)).toEqual(['GET'])
  })
})

for (const variant of [{ safety: 1, runtime: 'office-reviewed-a' }, { safety: 2, runtime: undefined }] as const) {
  test(`retained converter rejects safety/runtime mismatch ${variant.safety}`, async () => {
    await fixture(async (f) => {
      const row = retained(f.c, 'queued', variant.safety, variant.runtime); f.set(row)
      await expect(f.service.status(token, { jobId: row.id, generation: row.generation }))
        .rejects.toMatchObject({ code: 'office_render_unavailable' })
      expect(f.kube.call).not.toHaveBeenCalled()
    })
  })
}

test('new generations include runtime selection and accept corresponding retained snapshots', async () => {
  await fixture(async (f) => {
    const expected = hash(conversion(f.c, 2, f.c.runtimeClassName))
    expect(await f.service.generation(token)).toEqual({ generation: expected })
    const old = retained(f.c, 'queued', 1)
    expect(expected).not.toBe(old.generation)
    const current = retained(f.c, 'queued', 2, f.c.runtimeClassName); f.set(current)
    expect(await f.service.status(token, { jobId: current.id, generation: current.generation })).toMatchObject({ state: 'queued' })
    expect(current.converter_snapshot.pod).toMatchObject({ safetyVersion: 2, runtimeClassName: f.c.runtimeClassName })
    const pods = new OfficePreviewPods(f.kube, f.c)
    const intent = pods.intent(current.source_snapshot, owner)
    expect(intent.template.spec.runtimeClassName).toBe(f.c.runtimeClassName)
    expect(officePreviewPodIntent.parse(intent)).toEqual(intent)
    expect(current.generation).toBe(expected)
  })
  await fixture(async (f) => {
    expect((await f.service.generation(token)).generation).toBe(hash(conversion(f.c, 2, f.c.runtimeClassName)))
  }, 'office-reviewed-b')
})

test('fresh prepare persists safety2 and submits only its matching original runtime intent', async () => {
  await fixture(async (f) => {
    const generation = (await f.service.generation(token)).generation
    const request = officePreviewSourcePrepareRequest.parse({ requestId: randomUUID(), sessionId: session,
      path: 'report.docx', priority: 'foreground', generation })
    const accepted = await f.service.prepare(token, request)
    const row = f.row()
    if (!row) throw new Error('Expected actual service admission')
    expect(row.converter_snapshot.pod).toMatchObject({ safetyVersion: 2, runtimeClassName: f.c.runtimeClassName })
    expect(row.source_snapshot.generation).toBe(generation)
    expect(accepted).toMatchObject({ state: 'queued', generation, jobId: row.id })
    const intended = new OfficePreviewPods(f.kube, f.c).intent(row.source_snapshot, owner)
    const pod = { ...structuredClone(intended.template), metadata: { ...intended.template.metadata,
      uid: randomUUID(), resourceVersion: '1', generation: 1 } }
    f.kube.call.mockRejectedValueOnce(new KubernetesError(404, 'owned initial absence'))
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(pod)
    await f.service.tick()
    expect(f.kube.call.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST', 'GET'])
    expect(f.kube.call.mock.calls[1]?.[2]).toEqual(intended.template)
    expect(f.row()).toMatchObject({ state: 'running', generation, converter_snapshot: row.converter_snapshot,
      creation_intent: { templateDigest: intended.templateDigest, template: { spec: { runtimeClassName: f.c.runtimeClassName } } } })
    expect(f.row()?.creation_intent?.submittedAt).not.toBeNull()
  })
})

test('a persisted new intent must match its converter runtime before any observation', async () => {
  await fixture(async (f) => {
    const row = retained(f.c, 'creating', 2, f.c.runtimeClassName)
    if (!row.creation_intent) throw new Error('Expected retained intent')
    row.creation_intent.template.spec.runtimeClassName = 'different-runtime'
    row.creation_intent.templateDigest = hash(row.creation_intent.template)
    f.set(row)
    await expect(f.service.status(token, { jobId: row.id, generation: row.generation }))
      .rejects.toMatchObject({ code: 'office_render_unavailable' })
    expect(f.kube.call).not.toHaveBeenCalled()
  })
})

test('observation of an original runtime survives operator replacement solely for exact cleanup', async () => {
  await fixture(async (f) => {
    const original = retained(f.c, 'creating', 2, 'office-reviewed-old')
    const intent = original.creation_intent
    if (!intent) throw new Error('Expected original intent')
    const pod = { ...structuredClone(intent.template), metadata: { ...intent.template.metadata,
      uid: randomUUID(), resourceVersion: '1', generation: 1 } }
    f.kube.call.mockResolvedValue(pod)
    const pods = new OfficePreviewPods(f.kube, f.c)
    expect((await pods.observe(intent))?.identity.uid).toBe(pod.metadata.uid)
    await expect(pods.submit({ ...intent, submittedAt: new Date().toISOString() }))
      .rejects.toMatchObject({ code: 'office_render_unavailable' })
    expect(f.kube.call.mock.calls.map(([method]) => method)).toEqual(['GET'])
  })
})

test('a created prior runtime retires the exact UID without resubmitting or replacing its frozen generation', async () => {
  await fixture(async (f) => {
    const row = retained(f.c, 'creating', 2, 'office-reviewed-old')
    if (!row.creation_intent) throw new Error('Expected original intent')
    row.creation_intent.submittedAt = '2026-10-09T00:00:00.000Z'
    f.set(row)
    const originalGeneration = row.generation, originalDigest = row.creation_intent.templateDigest
    const uid = randomUUID()
    const pod = { ...structuredClone(row.creation_intent.template), metadata: { ...row.creation_intent.template.metadata,
      uid, resourceVersion: '1', generation: 1 } }
    const deleting = { ...pod, metadata: { ...pod.metadata, generation: 2, resourceVersion: '2',
      deletionTimestamp: '2026-10-09T00:01:00.000Z' } }
    f.kube.call.mockResolvedValueOnce(pod).mockResolvedValueOnce(undefined).mockResolvedValueOnce(deleting)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new KubernetesError(404, 'owned deleted Pod'))
    await f.service.tick()
    expect(f.kube.call.mock.calls.map(([method]) => method)).toEqual(['GET', 'DELETE', 'GET', 'PATCH', 'GET'])
    expect(f.kube.call.mock.calls[1]?.[2]).toMatchObject({ preconditions: { uid } })
    expect(f.kube.call.mock.calls[3]?.[2]).toMatchObject({ metadata: { uid, resourceVersion: '2', finalizers: [] } })
    expect(f.row()).toMatchObject({ generation: originalGeneration, state: 'failed', error_code: 'unavailable', parser_slot: null,
      creation_intent: { templateDigest: originalDigest }, stop_evidence: { status: 'UNSCHEDULED_DELETING', identity: { uid } } })
  })
})

test('enabled native configuration rejects empty runtime before opening service resources', async () => {
  const c = config('/owned/office/review'), read = vi.fn(async () => JSON.stringify({ ...c, pollMs: 1000, runtimeClassName: '' }))
  await expect(loadOfficePreviewConfig('/owned/config/office.json', 'in-cluster', ['/owned/workspaces'], read))
    .rejects.toThrow('Invalid Office preview platform configuration')
  expect(read).toHaveBeenCalledTimes(1)
  const disabledRead = vi.fn(async () => 'unused')
  expect(await loadOfficePreviewConfig('', '', [], disabledRead)).toBeNull()
  expect(disabledRead).not.toHaveBeenCalled()
})
