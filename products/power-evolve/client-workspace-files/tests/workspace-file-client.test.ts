import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendWorkspaceFileReference, WorkspaceFileHttpClient } from '../src/client/workspace-file-client.ts'

const sessionId = '598f346b-178c-4ef3-80ef-3a68f4cb4888'

test('upload uses the authenticated file API and cites the saved Workspace path', async () => {
  let request: Request | undefined
  const client = new WorkspaceFileHttpClient(async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    const body = await request.clone().json() as { request: { path: string } }
    return Response.json({ path: body.request.path, revision: 'saved' })
  })
  const file = new File([new Uint8Array([0, 1, 255, 10])], 'probe.bin')
  const saved = await client.upload(sessionId, file, new AbortController().signal)
  assert.match(saved.workspacePath, /^\/workspace\/uploads\/[0-9a-f-]{36}\/probe\.bin$/)
  assert.equal(saved.displayName, 'probe.bin')
  assert.equal(request?.url, 'http://localhost/api/powerEvolve/filesPut')
  assert.equal(request?.credentials, 'same-origin')
  const body = await request?.json() as { request: { sessionId: string, requestId: string, path: string, baseRevision: null, data: string } }
  assert.equal(body.request.sessionId, sessionId)
  assert.equal(body.request.path, saved.workspacePath.slice('/workspace/'.length))
  assert.equal(body.request.baseRevision, null)
  assert.match(body.request.requestId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(Buffer.from(body.request.data, 'base64'), Buffer.from([0, 1, 255, 10]))
  assert.match(appendWorkspaceFileReference('请查看', saved), /请查看[\s\S]*probe\.bin/)
})

test('invalid names and oversized files never reach the file API', async () => {
  let calls = 0
  const client = new WorkspaceFileHttpClient(async () => { calls++; return Response.json({}) })
  for (const name of ['..', 'x/y', 'x\\y']) {
    await assert.rejects(client.upload(sessionId, new File(['x'], name), new AbortController().signal))
  }
  await assert.rejects(client.upload(sessionId, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.bin'), new AbortController().signal))
  await assert.rejects(client.upload('', new File(['x'], 'valid.txt'), new AbortController().signal))
  assert.equal(calls, 0)
})
