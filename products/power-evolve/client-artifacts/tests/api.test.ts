import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ArtifactHttpClient, ArtifactHttpError, artifactDownloadUrl, relativeArtifactSource } from '../src/client/api.ts'

const sessionId = '598f346b-178c-4ef3-80ef-3a68f4cb4888'
const workspaceId = '00e83ada-10dc-4f7d-b6bb-22dd6db754d7'
const artifactId = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
const requestId = '9281f7b6-3c97-4269-b688-6aae25d49b7e'
const artifact = { artifactId, workspaceId, sessionId, sourcePath: 'out/report.txt', filename: 'report.txt',
  mime: 'text/plain', sizeBytes: 5, sha256: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00Z' }
const executionId = 'de2f8f25-1115-40a0-819e-d45af386eea8'
const facts = { sessionId, workspaceId, items: [{ executionId, callId: 'native-call', state: 'succeeded',
  status: 'complete', files: [{ path: 'out/report.txt', sizeBytes: 5, sha256: artifact.sha256 }], reasons: [] }] }

test('explicit publish carries the selected native file and stable request ID', async () => {
  let request: Request | undefined
  const client = new ArtifactHttpClient(async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    return Response.json(artifact)
  })
  assert.deepEqual(await client.publish(sessionId, '/workspace/out/report.txt', requestId), artifact)
  assert.equal(request?.url, 'http://localhost/api/powerEvolve/artifactsPublish')
  assert.equal(request?.credentials, 'same-origin')
  assert.deepEqual(await request?.json(), { request: { requestId, sessionId, path: 'out/report.txt' } })
})

test('invalid paths and mismatched publish responses cannot be accepted', async () => {
  let calls = 0
  const client = new ArtifactHttpClient(async () => { calls++; return Response.json({ ...artifact, sourcePath: 'other.txt' }) })
  for (const path of ['/other/report.txt', '/workspace/../report.txt', '/workspace/out//report.txt']) {
    assert.throws(() => relativeArtifactSource(path))
    await assert.rejects(client.publish(sessionId, path, requestId))
  }
  assert.equal(calls, 0)
  await assert.rejects(client.publish(sessionId, '/workspace/out/report.txt', requestId))
})

test('catalog, bounded preview, and authenticated download use scoped routes', async () => {
  const requests: Request[] = []
  const client = new ArtifactHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init)
    requests.push(request)
    if (request.url.endsWith('artifactsList')) return Response.json({ items: [artifact], nextCursor: null })
    return Response.json({ artifactId, mime: 'text/plain', sizeBytes: 5, text: 'hello', truncated: false })
  })
  assert.deepEqual(await client.list({ workspaceId }), { items: [artifact], nextCursor: null })
  assert.deepEqual(await requests[0]?.json(), { request: { workspaceId, limit: 30 } })
  assert.equal((await client.preview(artifactId)).text, 'hello')
  assert.deepEqual(await requests[1]?.json(), { request: { artifactId } })
  assert.equal(artifactDownloadUrl(artifactId), `/api/powerEvolve/artifacts/${artifactId}/content`)
  assert.throws(() => artifactDownloadUrl('../other'))
})

test('catalog and publication reject noncanonical immutable document metadata', async () => {
  for (const changes of [{ artifactId: artifactId.toUpperCase() }, ...['../report.pdf', 'a/b.pdf', 'a\\b.pdf',
    '.', '..', '', 'report\0.pdf', 'report\n.pdf', 'x'.repeat(256)].map(filename => ({ filename }))]) {
    const client = new ArtifactHttpClient(async input => Response.json(String(input).endsWith('artifactsList')
      ? { items: [{ ...artifact, ...changes }], nextCursor: null } : { ...artifact, ...changes }))
    await assert.rejects(client.list({ sessionId }))
    await assert.rejects(client.publish(sessionId, '/workspace/out/report.txt', requestId))
  }
  const literal = { ...artifact, filename: '报告 #1%20?.pdf' }
  const client = new ArtifactHttpClient(async () => Response.json({ items: [literal], nextCursor: null }))
  assert.equal((await client.list({ sessionId })).items[0]?.filename, literal.filename)
})

test('execution queries use shared DTOs and accept exactly the selected identities', async () => {
  let body: unknown
  const client = new ArtifactHttpClient(async (input, init) => {
    assert.equal(input, '/api/powerEvolve/executionFiles')
    assert.equal(init?.redirect, 'error')
    body = JSON.parse(String(init?.body))
    return Response.json(facts)
  })
  assert.deepEqual(await client.executionFiles(sessionId, [executionId], new AbortController().signal), facts)
  assert.deepEqual(body, { request: { sessionId, executionIds: [executionId] } })
  for (const ids of [[], ['invalid'], [executionId, executionId], Array(21).fill(executionId)]) {
    await assert.rejects(client.executionFiles(sessionId, ids, new AbortController().signal))
  }
})

test('execution replies cannot add identities, switch Session, or expose unavailable files', async () => {
  for (const body of [
    { ...facts, sessionId: workspaceId }, { ...facts, items: [] },
    { ...facts, items: [{ ...facts.items[0], executionId: artifactId }] },
    { ...facts, items: [{ ...facts.items[0], status: 'unavailable', reasons: ['verification_failed'] }] },
    { ...facts, items: [{ ...facts.items[0], files: [{ ...facts.items[0]!.files[0], path: '../escape' }] }] },
  ]) {
    const client = new ArtifactHttpClient(async () => Response.json(body))
    await assert.rejects(client.executionFiles(sessionId, [executionId], new AbortController().signal))
  }
})

test('execution body reads are bounded and cancellation rejects a late reply', async () => {
  const oversized = new ArtifactHttpClient(async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)))
  await assert.rejects(oversized.executionFiles(sessionId, [executionId], new AbortController().signal), /byte limit/u)
  const controller = new AbortController()
  const pending = Promise.withResolvers<Response>()
  const client = new ArtifactHttpClient(async () => pending.promise)
  const reading = client.executionFiles(sessionId, [executionId], controller.signal)
  controller.abort()
  pending.resolve(Response.json(facts))
  await assert.rejects(reading)
})

test('conditional publication carries the verified digest and preserves source-changed failures', async () => {
  let body: unknown
  const client = new ArtifactHttpClient(async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json(artifact)
  })
  await client.publish(sessionId, '/workspace/out/report.txt', requestId, undefined, artifact.sha256)
  assert.deepEqual(body, { request: { requestId, sessionId, path: 'out/report.txt', expectedRevision: artifact.sha256 } })
  const changed = new ArtifactHttpClient(async () => Response.json({ error: 'artifact_source_changed' }, { status: 409 }))
  await assert.rejects(changed.publish(sessionId, '/workspace/out/report.txt', requestId, undefined, artifact.sha256),
    (error: unknown) => error instanceof ArtifactHttpError && error.status === 409 && error.code === 'artifact_source_changed')
  const mismatch = new ArtifactHttpClient(async () => Response.json({ ...artifact, sha256: 'b'.repeat(64) }))
  await assert.rejects(mismatch.publish(sessionId, '/workspace/out/report.txt', requestId, undefined, artifact.sha256))
})
