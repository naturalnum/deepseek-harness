import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relativeWorkspacePath, WorkspaceDownloadError, WorkspaceFileDownloadClient } from '../src/client/workspace-file-download.ts'

test('download reads the selected native Workspace file with the authenticated product API', async () => {
  let request: Request | undefined
  const client = new WorkspaceFileDownloadClient(async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    const body = await request.clone().json() as { request: { path: string } }
    return Response.json({ path: body.request.path, revision: 'a'.repeat(64),
      size: 4, data: Buffer.from([0, 1, 255, 10]).toString('base64') })
  })
  const result = await client.read('/workspace/uploads/probe.bin', new AbortController().signal)
  assert.equal(request?.url, 'http://localhost/api/powerEvolve/fileRead')
  assert.equal(request?.credentials, 'same-origin')
  assert.equal((await request?.json() as { request: { path: string } }).request.path, 'uploads/probe.bin')
  assert.equal(result.name, 'probe.bin')
  assert.equal(result.revision, 'a'.repeat(64))
  assert.deepEqual(result.bytes, new Uint8Array([0, 1, 255, 10]))
})

test('download rejects paths outside the Workspace and mismatched server data', async () => {
  for (const path of ['/private/other.txt', '/workspace/../other.txt', '/workspace/a//b']) {
    assert.throws(() => relativeWorkspacePath(path))
  }
  const client = new WorkspaceFileDownloadClient(async () => Response.json({ path: 'other.txt', size: 1, data: 'eA==' }))
  await assert.rejects(client.read('/workspace/my.txt', new AbortController().signal))
  const denied = new WorkspaceFileDownloadClient(async () => new Response(null, { status: 403 }))
  await assert.rejects(denied.read('/workspace/my.txt', new AbortController().signal),
    (error: unknown) => error instanceof WorkspaceDownloadError && error.status === 403)
})
