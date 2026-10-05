/** Real disposable PG/POSIX Artifact admissions; Kubernetes and PDF output are explicit substitutes, not parser/kubelet evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OfficePreviewService } from '../lib/platform/office-previews.js'
import { artifactDocumentPathFor } from '../../contracts/lib/artifact-document.js'
import { previewFixture, successOutput, sha } from './office-preview-fixture.mjs'
import { taskCredential, disableFixtureAccount } from './task-credential-fixture.mjs'

const options = { timeout: 30000 }
async function artifactRequest(f, name = f.sourcePath) {
  if (name !== f.sourcePath) await writeFile(join(f.root, f.workspaceId, name), f.source)
  const record = await f.artifacts.publish(f.user, randomUUID(), f.sessionId, name)
  const { path: _workspacePath, ...common } = f.request
  return { record, request: { ...common, source: { kind: 'artifact', artifactId: record.artifactId,
    filename: record.filename, sha256: record.sha256 } } }
}
const immutablePath = (f, record) => join(f.localRoot, 'artifacts', f.userId, `${record.artifactId}.bin`)

test('Artifact admission and delivery freeze actual immutable bytes without Workspace or storage-binding reads, including a one-connection pool', options, async t => {
  const f = await previewFixture(t, {}, 1), { record, request } = await artifactRequest(f)
  await writeFile(join(f.root, f.workspaceId, f.sourcePath), 'modified'); await unlink(join(f.root, f.workspaceId, f.sourcePath))
  await f.pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [f.workspaceId])
  for (const method of ['bindingForId', 'readInWorkspace']) f.files[method] = async () => assert.fail('Artifact preview read mutable Workspace source')
  const job = await f.service.prepare(f.token, request), admitted = await f.state(job.jobId)
  assert.deepEqual(admitted.request, request)
  assert.deepEqual(admitted.binding_snapshot, { kind: 'artifact', workspaceId: f.workspaceId, artifactId: record.artifactId,
    filename: record.filename, sha256: record.sha256, sizeBytes: record.sizeBytes })
  assert.equal(admitted.source_snapshot.sourceSha256, sha(f.source))
  assert.deepEqual(await readFile(join(f.config.localRoot, job.jobId, 'input/source.docx')), f.source)
  await f.service.tick(); const { pdf } = await successOutput(f, job); await f.service.tick()
  const view = await f.service.content(f.token, f.ref(job))
  assert.equal(view.absolutePath, artifactDocumentPathFor(record.artifactId, record.filename))
  assert.equal(view.version, record.sha256); assert.deepEqual(Buffer.from(view.data, 'base64'), pdf)
  assert.equal((await f.state(job.jobId)).stop_evidence.status, 'KUBELET_STOPPED')
  assert.equal((await f.state(job.jobId)).parser_slot, null)
})

test('one owner request key fixes Artifact identity, literal filename, digest and source kind', options, async t => {
  const f = await previewFixture(t), { request } = await artifactRequest(f), job = await f.service.prepare(f.token, request)
  assert.deepEqual(await f.service.prepare(f.token, request), job)
  const other = await artifactRequest(f, 'other.pptx')
  for (const changed of [{ ...request, source: other.request.source },
    { ...request, source: { ...request.source, filename: 'other.docx' } },
    { ...request, source: { ...request.source, sha256: '0'.repeat(64) } }, f.request]) {
    await assert.rejects(f.service.prepare(f.token, changed), { status: 409, code: 'request_id_conflict' })
  }
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_office_preview_jobs')).rows[0].n, 1)
})

test('wrong Artifact name, expected digest, owner or original Session cannot admit a parser', options, async t => {
  const f = await previewFixture(t), { request } = await artifactRequest(f), other = await f.createSession(f.userId)
  const bobId = await f.createUser(), bobToken = await taskCredential(f.pool, { userId: bobId }), bobSession = await f.createSession(bobId)
  for (const changed of [{ ...request, source: { ...request.source, filename: 'wrong.docx' } },
    { ...request, sessionId: other.sessionId }]) {
    await assert.rejects(f.service.prepare(f.token, changed), { status: 404, code: 'artifact_not_found' })
  }
  await assert.rejects(f.service.prepare(f.token, { ...request, source: { ...request.source, sha256: '0'.repeat(64) } }),
    { status: 409, code: 'office_render_source-changed' })
  await assert.rejects(f.service.prepare(bobToken, request), { code: 'session_not_found' })
  await assert.rejects(f.service.prepare(bobToken, { ...request, sessionId: bobSession.sessionId }), { code: 'artifact_not_found' })
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_office_preview_jobs')).rows[0].n, 0)
  assert.equal(f.kube.mutations.length, 0)
})

test('damaged immutable Artifact bytes reject initial admission, queued dispatch and completed content independently', options, async t => {
  const f = await previewFixture(t), { record, request } = await artifactRequest(f), file = immutablePath(f, record)
  const damaged = Buffer.from(f.source); damaged[0] ^= 1
  await chmod(file, 0o600); await writeFile(file, damaged)
  await assert.rejects(f.service.prepare(f.token, request), { code: 'artifact_unavailable' })
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_office_preview_jobs')).rows[0].n, 0)
  await writeFile(file, f.source)
  const job = await f.service.prepare(f.token, request)
  await writeFile(file, damaged)
  await assert.rejects(f.service.tick(), { code: 'artifact_unavailable' })
  assert.equal((await f.state(job.jobId)).creation_intent, null); assert.equal(f.kube.mutations.length, 0)
  await writeFile(file, f.source); await f.service.tick(); await successOutput(f, job); await f.service.tick()
  await writeFile(file, damaged)
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'artifact_unavailable' })
  assert.equal((await f.state(job.jobId)).state, 'succeeded')
  assert.equal(f.kube.mutations.filter(call => call.method === 'POST').length, 1)
})

test('early cancellation stays permanent for Artifact admission and disabled owners clean queued or original running parsers', options, async t => {
  await t.test('cancel precedes prepare', async t => {
    const f = await previewFixture(t), { request } = await artifactRequest(f)
    const cancelled = await f.service.cancel(f.token, { requestId: request.requestId, generation: request.generation })
    assert.deepEqual(await f.service.prepare(f.token, request), cancelled)
    await f.service.tick(); assert.equal(f.kube.mutations.length, 0)
    assert.equal((await f.state(cancelled.jobId)).binding_snapshot, null)
  })
  for (const running of [false, true]) await t.test(running ? 'running revoked' : 'queued revoked', async t => {
    const f = await previewFixture(t), { request } = await artifactRequest(f), job = await f.service.prepare(f.token, request)
    if (running) await f.service.tick()
    const uid = running ? f.kube.pod.metadata.uid : null
    await disableFixtureAccount(f.pool, f.user); await f.service.tick()
    const row = await f.state(job.jobId)
    assert.equal(row.state, 'cancelled'); assert.equal(row.parser_slot, null)
    if (running) { assert.equal(row.stop_evidence.identity.uid, uid); assert.equal(f.kube.pod, null) }
    else { assert.equal(row.creation_intent, null); assert.equal(f.kube.mutations.length, 0) }
    await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'account_unauthorized' })
  })
})

test('preserved V32 Workspace request and binding rows are still read and stopped after service reconstruction', options, async t => {
  const f = await previewFixture(t), job = await f.accept(), original = await f.state(job.jobId)
  assert.deepEqual(original.request, f.request); assert.equal('kind' in original.binding_snapshot, false)
  const successor = new OfficePreviewService(f.pool, f.files, f.kube, f.config, f.artifacts)
  t.after(() => successor.stop())
  await successor.tick(); const identity = (await f.state(job.jobId)).pod_identity
  await successor.cancel(f.token, f.ref(job)); await successor.tick()
  const ended = await f.state(job.jobId)
  assert.equal(ended.state, 'cancelled'); assert.equal(ended.parser_slot, null)
  assert.equal(ended.stop_evidence.identity.uid, identity.uid)
  assert.deepEqual(ended.request, original.request); assert.equal(ended.request_digest, original.request_digest)
  assert.deepEqual(ended.binding_snapshot, original.binding_snapshot)
  assert.equal(f.kube.mutations.filter(call => call.method === 'POST').length, 1)
})
