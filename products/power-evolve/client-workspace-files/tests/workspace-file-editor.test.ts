import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkspaceFileDownloadClient } from '../src/client/workspace-file-download.ts'
import { WorkspaceFileEditError, WorkspaceFileEditorClient } from '../src/client/workspace-file-editor.ts'

const oldRevision = 'a'.repeat(64)
const nextRevision = 'b'.repeat(64)
const sessionId = '598f346b-178c-4ef3-80ef-3a68f4cb4888'
const otherSessionId = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'

test('text editor reads UTF-8 and submits a conditional file mutation', async () => {
  const source = Buffer.from('old text\n')
  const read = new WorkspaceFileDownloadClient(async () => Response.json({
    path: 'notes/sample.txt', revision: oldRevision, size: source.length, data: source.toString('base64'),
  }))
  let request: Request | undefined
  const editor = new WorkspaceFileEditorClient(read, async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    return Response.json({ path: 'notes/sample.txt', revision: nextRevision })
  })
  const file = await editor.open(sessionId, '/workspace/notes/sample.txt', new AbortController().signal)
  assert.equal(file.text, 'old text\n')
  assert.equal(file.revision, oldRevision)
  assert.equal(file.sessionId, sessionId)
  const revision = await editor.save(sessionId, file, 'new text\n', '715cffec-5cb4-4378-99b2-c828b27c661b', new AbortController().signal)
  assert.equal(revision, nextRevision)
  assert.equal(request?.url, 'http://localhost/api/powerEvolve/filesPut')
  assert.equal(request?.credentials, 'same-origin')
  const body = await request?.json() as { request: { sessionId: string; requestId: string; path: string; baseRevision: string; data: string } }
  assert.equal(body.request.sessionId, sessionId)
  assert.equal(body.request.requestId, '715cffec-5cb4-4378-99b2-c828b27c661b')
  assert.equal(body.request.path, 'notes/sample.txt')
  assert.equal(body.request.baseRevision, oldRevision)
  assert.equal(Buffer.from(body.request.data, 'base64').toString(), 'new text\n')
})

test('binary input and stale revision fail without silently overwriting', async () => {
  const bytes = Buffer.from([0, 255])
  const read = new WorkspaceFileDownloadClient(async () => Response.json({
    path: 'binary.dat', revision: oldRevision, size: bytes.length, data: bytes.toString('base64'),
  }))
  const editor = new WorkspaceFileEditorClient(read, async () => new Response(null, { status: 409 }))
  await assert.rejects(editor.open(sessionId, '/workspace/binary.dat', new AbortController().signal),
    (error: unknown) => error instanceof WorkspaceFileEditError && error.reason === 'binary')
  await assert.rejects(editor.save(sessionId, { sessionId, absolutePath: '/workspace/notes/sample.txt', revision: oldRevision, text: 'old' },
    'new', '6b70ff59-489e-4f7e-8f1f-df587e294dc1', new AbortController().signal),
  (error: unknown) => error instanceof WorkspaceFileEditError && error.reason === 'conflict')
})

test('an opened file cannot be saved under another Session', async () => {
  let calls = 0
  const editor = new WorkspaceFileEditorClient(undefined, async () => { calls++; return Response.json({}) })
  await assert.rejects(editor.save(otherSessionId,
    { sessionId, absolutePath: '/workspace/notes/sample.txt', revision: oldRevision, text: 'old' },
    'new', '6b70ff59-489e-4f7e-8f1f-df587e294dc1', new AbortController().signal),
  (error: unknown) => error instanceof WorkspaceFileEditError && error.reason === 'denied')
  assert.equal(calls, 0)
})
