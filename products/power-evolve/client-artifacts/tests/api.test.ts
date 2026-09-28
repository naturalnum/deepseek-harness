import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ArtifactHttpClient, artifactDownloadUrl, relativeArtifactSource } from '../src/client/api.ts'

const sessionId = '598f346b-178c-4ef3-80ef-3a68f4cb4888'
const workspaceId = '00e83ada-10dc-4f7d-b6bb-22dd6db754d7'
const artifactId = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
const requestId = '9281f7b6-3c97-4269-b688-6aae25d49b7e'
const artifact = { artifactId, workspaceId, sessionId, sourcePath: 'out/report.txt', filename: 'report.txt',
  mime: 'text/plain', sizeBytes: 5, sha256: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00Z' }

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
