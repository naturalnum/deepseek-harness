/** Real disposable PG and POSIX authorization with explicit Pod API substitutes; no parser or kubelet is asserted. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OfficePreviewService } from '../lib/platform/office-previews.js'
import { taskCredential, clearTaskCredential, disableFixtureAccount } from './task-credential-fixture.mjs'
import { previewFixture, successOutput, sha } from './office-preview-fixture.mjs'
const options = { timeout: 30000 }
const gate = t => {
  let entered, release
  // Registered before fixture cleanup so failed assertions cannot leave an admitted tick awaiting this barrier.
  t.after(() => release())
  return { reached: new Promise(r => { entered = r }), held: new Promise(r => { release = r }),
    enter: () => entered(), release: () => release() }
}

test('owner, Agent audience, immutable request and source snapshot survive JSONB ordering', options, async t => {
  const f = await previewFixture(t), job = await f.accept()
  assert.deepEqual(await f.accept(), job)
  assert.equal((await f.state(job.jobId)).source_snapshot.sourceSha256, sha(f.source))
  assert.equal((await lstat(join(f.config.localRoot, job.jobId, 'input'))).mode & 0o777, 0o700)
  assert.equal((await lstat(join(f.config.localRoot, job.jobId, 'input/source.docx'))).mode & 0o777, 0o400)
  await assert.rejects(f.accept({ priority: 'background' }), { code: 'request_id_conflict' })
  await assert.rejects(f.service.status(await taskCredential(f.pool, f.user, 'approval'), f.ref(job)), { code: 'account_unauthorized' })
  const bobId = await f.createUser(), bobToken = await taskCredential(f.pool, { userId: bobId })
  for (const method of ['status', 'content', 'cancel']) await assert.rejects(f.service[method](bobToken, f.ref(job)), { code: 'office_preview_not_found' })
  await assert.rejects(f.service.prepare(bobToken, f.request), { code: 'session_not_found' })
  const second = new OfficePreviewService(f.pool, f.files, f.kube, { ...f.config, localRoot: join(f.localRoot, 'unused'), leaseMs: 20000 })
  t.after(() => second.stop())
  assert.equal((await second.generation(f.token)).generation, f.generation)
  const changed = new OfficePreviewService(f.pool, f.files, f.kube, { ...f.config, fontPolicyDigest: 'e'.repeat(64) })
  t.after(() => changed.stop())
  assert.notEqual((await changed.generation(f.token)).generation, f.generation)
  await assert.rejects(changed.content(f.token, f.ref(job)), { code: 'office_render_unavailable' })
  assert.deepEqual(await readFile(join(f.config.localRoot, job.jobId, 'input/source.docx')), f.source)
})

test('cancel-before-prepare is permanent and retained placeholders consume admission budget', options, async t => {
  const f = await previewFixture(t, { maxRetainedJobsPerUser: 1 })
  const cancelled = await f.service.cancel(f.token, { requestId: f.request.requestId, generation: f.generation })
  assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(await f.accept(), cancelled)
  assert.deepEqual(await f.service.cancel(f.token, f.ref(cancelled)), cancelled)
  await assert.rejects(f.accept({ requestId: randomUUID() }), { code: 'office_render_busy' })
  await f.service.tick()
  const row = await f.state(cancelled.jobId)
  assert.equal(row.source_snapshot, null); assert.equal(row.creation_intent, null); assert.equal(row.parser_slot, null)
  assert.equal(f.kube.mutations.length, 0)
})

test('cancellation before POST permission clears only its fenced NOT_SUBMITTED reservation', options, async t => {
  const g = gate(t), f = await previewFixture(t), job = await f.accept()
  let first = true
  f.kube.onCall = async method => { if (method === 'GET' && first) { first = false; g.enter(); await g.held } }
  const running = f.service.tick(); await g.reached
  const intent = (await f.state(job.jobId)).creation_intent
  assert.equal(intent.submittedAt, null)
  await f.service.cancel(f.token, f.ref(job)); g.release(); await running
  const row = await f.state(job.jobId)
  assert.equal(row.state, 'cancelled'); assert.equal(row.stop_evidence.status, 'NOT_SUBMITTED')
  assert.equal(row.parser_slot, null); assert.equal(row.creation_intent.submittedAt, null)
  assert.equal(f.kube.mutations.length, 0)
})

test('permission is irreversible: cancellation before late POST retains slot until exact stop proof', options, async t => {
  const g = gate(t), f = await previewFixture(t), job = await f.accept()
  f.kube.supplyProof = false
  f.kube.onCall = async method => { if (method === 'POST') { g.enter(); await g.held } }
  const running = f.service.tick(); await g.reached
  const permitted = await f.state(job.jobId)
  assert.notEqual(permitted.creation_intent.submittedAt, null)
  await f.service.cancel(f.token, f.ref(job)); g.release(); await running
  let row = await f.state(job.jobId)
  assert.equal(row.state, 'stopping'); assert.equal(row.parser_slot, 0); assert.equal(row.stop_evidence, null)
  assert.equal(row.creation_intent.submittedAt, permitted.creation_intent.submittedAt)
  const waiting = await f.accept({ requestId: randomUUID() })
  await f.service.tick()
  assert.equal((await f.state(waiting.jobId)).creation_intent, null)
  assert.equal(f.kube.mutations.filter(c => c.method === 'POST').length, 1)
  f.kube.supplyProof = true; f.kube.terminate(137)
  await f.service.tick()
  row = await f.state(job.jobId)
  assert.equal(row.state, 'cancelled'); assert.equal(row.stop_evidence.status, 'KUBELET_STOPPED')
  assert.equal(row.parser_slot, null); assert.equal(f.kube.pod, null)
})

test('POST ACK loss and Platform takeover observe the original identity without dispatch replay', options, async t => {
  const f = await previewFixture(t), job = await f.accept()
  f.kube.losePost = true
  await f.service.tick()
  const before = await f.state(job.jobId)
  assert.equal(before.state, 'creating'); assert.equal(before.parser_slot, 0)
  const successor = new OfficePreviewService(f.pool, f.files, f.kube, f.config)
  t.after(() => successor.stop())
  await successor.tick()
  const captured = await f.state(job.jobId)
  assert.equal(captured.state, 'running'); assert.equal(captured.lease_epoch, before.lease_epoch + 1)
  assert.equal(captured.pod_identity.uid, f.kube.pod.metadata.uid)
  assert.equal(captured.creation_intent.submittedAt, before.creation_intent.submittedAt)
  assert.equal(f.kube.mutations.filter(c => c.method === 'POST').length, 1)
  await successor.cancel(f.token, f.ref(job)); await successor.tick()
  assert.equal((await f.state(job.jobId)).state, 'cancelled')
})

test('old epoch cannot grant POST after takeover; the successor can finalize the original unsubmitted intent', options, async t => {
  const g = gate(t), f = await previewFixture(t), job = await f.accept()
  let first = true
  f.kube.onCall = async method => { if (method === 'GET' && first) { first = false; g.enter(); await g.held } }
  const old = f.service.tick(); await g.reached
  await f.pool.query("UPDATE pe_office_preview_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.jobId])
  await f.service.cancel(f.token, f.ref(job))
  const successor = new OfficePreviewService(f.pool, f.files, f.kube, f.config)
  t.after(() => successor.stop())
  await successor.tick(); g.release(); await old
  const row = await f.state(job.jobId)
  assert.equal(row.state, 'cancelled'); assert.equal(row.stop_evidence.status, 'NOT_SUBMITTED')
  assert.equal(row.lease_epoch, 2); assert.equal(f.kube.mutations.length, 0)
})

test('late POST from a previously permitted epoch keeps the slot until successor observes and stops that Pod', options, async t => {
  const g = gate(t), f = await previewFixture(t), job = await f.accept()
  f.kube.onCall = async method => { if (method === 'POST') { g.enter(); await g.held } }
  const old = f.service.tick(); await g.reached
  const permitted = await f.state(job.jobId)
  await f.pool.query("UPDATE pe_office_preview_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.jobId])
  const successor = new OfficePreviewService(f.pool, f.files, f.kube, f.config)
  t.after(() => successor.stop())
  await successor.tick()
  let row = await f.state(job.jobId)
  assert.equal(row.state, 'blocked'); assert.equal(row.parser_slot, 0); assert.equal(row.stop_evidence, null)
  g.release(); await old
  assert.equal(f.kube.mutations.filter(c => c.method === 'POST').length, 1)
  await successor.tick()
  assert.equal((await f.state(job.jobId)).state, 'running')
  await successor.cancel(f.token, f.ref(job)); await successor.tick()
  row = await f.state(job.jobId)
  assert.equal(row.state, 'cancelled'); assert.equal(row.parser_slot, null)
  assert.equal(row.creation_intent.submittedAt, permitted.creation_intent.submittedAt)
  assert.equal(row.stop_evidence.status, 'KUBELET_STOPPED')
})

test('a blocked slot0 cannot starve free slot1 or the deadlines of queued jobs when all slots are held', options, async t => {
  const f = await previewFixture(t, { maxConcurrentParsers: 2 }), first = await f.accept()
  await f.service.tick()
  f.kube.pod.metadata.uid = randomUUID(); await f.service.tick()
  assert.equal((await f.state(first.jobId)).state, 'blocked')
  const second = await f.accept({ requestId: randomUUID() })
  for (let attempt = 0; attempt < 2; attempt++) await f.service.tick()
  const running = await f.state(second.jobId)
  assert.equal(running.state, 'running'); assert.equal(running.parser_slot, 1)
  assert.equal((await f.state(first.jobId)).parser_slot, 0)
  const expired = await f.accept({ requestId: randomUUID() })
  await f.pool.query("UPDATE pe_office_preview_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.jobId])
  for (let attempt = 0; attempt < 3; attempt++) await f.service.tick()
  const terminal = await f.state(expired.jobId)
  assert.equal(terminal.state, 'failed'); assert.equal(terminal.error_code, 'timeout')
  assert.equal(terminal.creation_intent, null); assert.equal(terminal.parser_slot, null)
  assert.equal(f.kube.mutations.filter(c => c.method === 'POST').length, 2)
})

test('missing submitted Pod and UID replacement never fabricate stop facts or release capacity', options, async t => {
  for (const failure of ['missing', 'replacement']) await t.test(failure, async t => {
    const f = await previewFixture(t), job = await f.accept()
    await f.service.tick()
    const captured = (await f.state(job.jobId)).pod_identity
    if (failure === 'missing') f.kube.pod = null
    else f.kube.pod.metadata.uid = randomUUID()
    await f.service.cancel(f.token, f.ref(job)); await f.service.tick()
    const row = await f.state(job.jobId)
    assert.equal(row.state, 'blocked'); assert.equal(row.parser_slot, 0); assert.equal(row.stop_evidence, null)
    assert.deepEqual(row.pod_identity, captured)
    assert.equal(f.kube.mutations.filter(c => c.method === 'DELETE' || c.method === 'PATCH').length, 0)
  })
})

test('native stop proof commits before finalizer removal; lost finalizer ACK recovers without another Pod', options, async t => {
  const f = await previewFixture(t), job = await f.accept()
  await f.service.tick()
  const { pdf } = await successOutput(f, job)
  f.kube.onCall = async method => { if (method === 'PATCH') {
    const row = await f.state(job.jobId)
    assert.equal(row.state, 'stopping'); assert.equal(row.stop_evidence.identity.uid, f.kube.pod.metadata.uid)
    assert.equal(row.parser_slot, 0)
  } }
  f.kube.losePatch = true
  await f.service.tick()
  assert.equal((await f.state(job.jobId)).state, 'stopping')
  assert.equal((await f.state(job.jobId)).parser_slot, 0)
  await f.service.tick()
  const row = await f.state(job.jobId)
  assert.equal(row.state, 'succeeded'); assert.equal(row.parser_slot, null)
  assert.equal(row.worker_observation.exit.containerId, row.stop_evidence.identity.containerId)
  assert.equal(f.kube.mutations.filter(c => c.method === 'POST').length, 1)
  assert.deepEqual(Buffer.from((await f.service.content(f.token, f.ref(job))).data, 'base64'), pdf)
})

test('DELETE generation advances the durable identity; stale kubelet generation retains the slot until proof2 commits', options, async t => {
  const f = await previewFixture(t), job = await f.accept(); await f.service.tick()
  const original = (await f.state(job.jobId)).pod_identity
  assert.equal(original.generation, 1)
  await successOutput(f, job)
  f.kube.supplyProof = false
  await f.service.tick()
  const waiting = await f.state(job.jobId)
  assert.equal(waiting.pod_identity.generation, 2); assert.equal(waiting.pod_identity.uid, original.uid)
  assert.equal(waiting.state, 'stopping'); assert.equal(waiting.parser_slot, 0); assert.equal(waiting.stop_evidence, null)
  assert.equal(f.kube.pod.status.conditions[0].observedGeneration, 1)
  assert.equal(f.kube.mutations.filter(call => call.method === 'PATCH').length, 0)
  f.kube.onCall = async method => { if (method === 'PATCH') {
    const row = await f.state(job.jobId)
    assert.equal(row.stop_evidence.status, 'KUBELET_STOPPED'); assert.equal(row.pod_identity.generation, 2)
    assert.deepEqual(row.stop_evidence.identity, row.pod_identity); assert.equal(row.parser_slot, 0)
  } }
  f.kube.terminate(0); await f.service.tick()
  const completed = await f.state(job.jobId)
  assert.equal(completed.state, 'succeeded'); assert.equal(completed.parser_slot, null)
  assert.equal(completed.stop_evidence.identity.generation, 2); assert.equal(f.kube.pod, null)
  for (const method of ['POST', 'DELETE', 'PATCH']) assert.equal(f.kube.mutations.filter(call => call.method === method).length, 1)
})

test('creation cancellation captures the first worker identity during DELETE and releases only after current-generation stop proof', options, async t => {
  const f = await previewFixture(t), job = await f.accept()
  f.kube.deferWorkerStart = true; f.kube.supplyProof = false
  await f.service.tick()
  const original = (await f.state(job.jobId)).pod_identity
  assert.equal(original.generation, 1)
  for (const field of ['nodeName', 'containerId', 'imageId']) assert.equal(original[field], null)
  f.kube.onCall = async method => { if (method === 'DELETE') { f.kube.start(); f.kube.terminate(137) } }
  await f.service.cancel(f.token, f.ref(job)); await f.service.tick()
  const waiting = await f.state(job.jobId)
  assert.equal(waiting.state, 'stopping'); assert.equal(waiting.parser_slot, 0); assert.equal(waiting.stop_evidence, null)
  assert.equal(waiting.pod_identity.generation, 2); assert.equal(waiting.pod_identity.uid, original.uid)
  assert.equal(waiting.pod_identity.nodeName, 'qa-node')
  for (const field of ['containerId', 'imageId']) assert.notEqual(waiting.pod_identity[field], null)
  assert.equal(f.kube.pod.status.conditions[0].observedGeneration, 1)
  assert.equal(f.kube.mutations.filter(call => call.method === 'PATCH').length, 0)
  f.kube.onCall = async method => { if (method === 'PATCH') {
    const row = await f.state(job.jobId)
    assert.deepEqual(row.pod_identity, waiting.pod_identity)
    assert.deepEqual(row.stop_evidence.identity, waiting.pod_identity); assert.equal(row.parser_slot, 0)
  } }
  f.kube.terminate(137); await f.service.tick()
  const cancelled = await f.state(job.jobId)
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.parser_slot, null)
  assert.equal(cancelled.stop_evidence.status, 'KUBELET_STOPPED'); assert.equal(f.kube.pod, null)
  for (const method of ['POST', 'DELETE', 'PATCH']) assert.equal(f.kube.mutations.filter(call => call.method === method).length, 1)
})

test('a failed stop-proof transaction cannot remove the finalizer or free the parser slot', options, async t => {
  const f = await previewFixture(t), job = await f.accept(); await f.service.tick()
  await f.service.cancel(f.token, f.ref(job))
  await f.pool.query(`CREATE FUNCTION reject_preview_proof() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.stop_evidence IS NOT NULL AND OLD.stop_evidence IS NULL THEN RAISE EXCEPTION 'fixture proof persistence rejected'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER proof_failure BEFORE UPDATE ON pe_office_preview_jobs FOR EACH ROW EXECUTE FUNCTION reject_preview_proof()`)
  await f.service.tick()
  let row = await f.state(job.jobId)
  assert.equal(row.state, 'stopping'); assert.equal(row.parser_slot, 0); assert.equal(row.stop_evidence, null)
  assert.equal(f.kube.mutations.filter(c => c.method === 'PATCH').length, 0)
  assert.equal(f.kube.pod.metadata.finalizers.length, 1)
  await f.pool.query('DROP TRIGGER proof_failure ON pe_office_preview_jobs; DROP FUNCTION reject_preview_proof()')
  await f.service.tick()
  row = await f.state(job.jobId)
  assert.equal(row.state, 'cancelled'); assert.equal(row.parser_slot, null); assert.equal(f.kube.pod, null)
})

test('deadline and account revocation clean only the accepted Pod and cannot deliver output', options, async t => {
  for (const reason of ['timeout', 'revoked']) await t.test(reason, async t => {
    const f = await previewFixture(t), job = await f.accept(); await f.service.tick()
    if (reason === 'timeout') await f.pool.query("UPDATE pe_office_preview_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.jobId])
    else await disableFixtureAccount(f.pool, f.user)
    await f.service.tick()
    const row = await f.state(job.jobId)
    assert.equal(row.state, reason === 'timeout' ? 'failed' : 'cancelled')
    assert.equal(row.error_code, reason === 'timeout' ? 'timeout' : null)
    assert.equal(row.stop_evidence.status, 'KUBELET_STOPPED'); assert.equal(row.parser_slot, null)
    await assert.rejects(f.service.content(f.token, f.ref(job)))
  })
})

test('failure marker identity and output bytes are validated independently of native stop', options, async t => {
  for (const correct of [true, false]) await t.test(`failure identity ${correct}`, async t => {
    const f = await previewFixture(t), job = await f.accept(); await f.service.tick()
    const source = (await f.state(job.jobId)).source_snapshot
    await writeFile(join(f.config.localRoot, job.jobId, 'output/failure.json'), JSON.stringify({ protocolVersion: 1,
      jobId: job.jobId, nonce: correct ? source.nonce : randomUUID(), generation: job.generation,
      sourceSha256: source.sourceSha256, errorCode: 'invalid-document' }), { mode: 0o600 })
    f.kube.terminate(1); await f.service.tick()
    const row = await f.state(job.jobId)
    assert.equal(row.state, 'failed'); assert.equal(row.error_code, correct ? 'invalid-document' : 'invalid-output')
    assert.equal(row.stop_evidence.status, 'KUBELET_STOPPED'); assert.equal(row.parser_slot, null)
  })
})

test('delivery reauthorizes original source SHA/binding and rejects altered or linked PDF bytes', options, async t => {
  const f = await previewFixture(t), job = await f.accept(); await f.service.tick()
  const { pdf } = await successOutput(f, job); await f.service.tick()
  assert.equal((await f.service.content(f.token, f.ref(job))).pdfSha256, sha(pdf))
  const source = join(f.root, f.workspaceId, f.sourcePath), output = join(f.config.localRoot, job.jobId, 'output/result.pdf')
  await writeFile(source, 'changed source')
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'office_render_source-changed' })
  await writeFile(source, f.source)
  await f.pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [f.workspaceId])
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'office_render_source-changed' })
  await f.pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation-1 WHERE id=$1', [f.workspaceId])
  await writeFile(output, '%PDF-1.4\nchanged\n%%EOF')
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'office_render_invalid-output' })
  await unlink(output); await symlink(source, output)
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'office_render_unavailable' })
  await unlink(output); await writeFile(output, pdf)
  await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.userId])
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'account_unauthorized' })
})

test('discarded derived output leaves the succeeded receipt unchanged and never replays its request', options, async t => {
  const f = await previewFixture(t), job = await f.accept(); await f.service.tick()
  await successOutput(f, job); await f.service.tick()
  const before = await f.state(job.jobId), output = join(f.config.localRoot, job.jobId, 'output')
  assert.equal(before.state, 'succeeded')
  await rm(output, { recursive: true }); await mkdir(output, { mode: 0o700 })
  assert.deepEqual(await readdir(output), [])
  const mutations = structuredClone(f.kube.mutations)
  const completed = await f.service.status(f.token, f.ref(job))
  assert.equal(completed.state, 'succeeded')
  await assert.rejects(f.service.content(f.token, f.ref(job)), { code: 'office_render_invalid-output' })
  assert.deepEqual(await f.accept(), completed)
  await f.service.tick()
  assert.deepEqual(await f.state(job.jobId), before)
  assert.deepEqual(f.kube.mutations, mutations)
  assert.equal(f.kube.resources.size, 0)
})

test('a new request after cache loss reauthorizes current source and creates only its new parser', options, async t => {
  const f = await previewFixture(t), original = await f.accept(); await f.service.tick()
  await successOutput(f, original); await f.service.tick()
  const before = await f.state(original.jobId)
  await rm(join(f.config.localRoot, original.jobId, 'output'), { recursive: true })
  await mkdir(join(f.config.localRoot, original.jobId, 'output'), { mode: 0o700 })
  const request = { ...f.request, requestId: randomUUID() }
  await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.userId])
  await assert.rejects(f.service.prepare(f.token, request), { code: 'account_unauthorized' })
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_office_preview_jobs')).rows[0].n, 1)
  clearTaskCredential(f.pool, f.user)
  const token = await taskCredential(f.pool, f.user), bytes = Buffer.from('current authorized Office source')
  await writeFile(join(f.root, f.workspaceId, f.sourcePath), bytes)
  const job = await f.service.prepare(token, request), admitted = await f.state(job.jobId)
  assert.notEqual(job.jobId, original.jobId)
  assert.notEqual(admitted.source_snapshot.nonce, before.source_snapshot.nonce)
  assert.equal(admitted.source_snapshot.sourceSha256, sha(bytes))
  assert.equal(admitted.source_snapshot.sourceBytes, bytes.length)
  await f.service.tick()
  const { pdf } = await successOutput(f, job); await f.service.tick()
  assert.deepEqual(Buffer.from((await f.service.content(token, f.ref(job))).data, 'base64'), pdf)
  assert.deepEqual(await f.state(original.jobId), before)
  assert.deepEqual(f.kube.mutations.filter(call => call.method === 'POST')
    .map(call => call.body.metadata.labels['powerevolve.dev/preview-job']), [original.jobId, job.jobId])
})

test('retained receipts at the quota still reject new conversions after derived cache loss', options, async t => {
  const f = await previewFixture(t, { maxRetainedJobsPerUser: 1 }), job = await f.accept(); await f.service.tick()
  await successOutput(f, job); await f.service.tick()
  const before = await f.state(job.jobId), mutations = structuredClone(f.kube.mutations)
  await rm(join(f.config.localRoot, job.jobId, 'output'), { recursive: true })
  await mkdir(join(f.config.localRoot, job.jobId, 'output'), { mode: 0o700 })
  assert.equal((await f.accept()).state, 'succeeded')
  await assert.rejects(f.accept({ requestId: randomUUID() }), { code: 'office_render_busy', status: 429 })
  await f.service.tick()
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_office_preview_jobs')).rows[0].n, 1)
  assert.deepEqual(await f.state(job.jobId), before)
  assert.deepEqual(f.kube.mutations, mutations)
})
