import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileDownloadPrepareRequest, fileDownloadUrl } from '@power-evolve/contracts/file-download'
import { DownloadError, downloadPaths, WorkspaceDownloadClient } from '../src/client/download-client.ts'
import { createDownloadSelectionStore } from '../src/client/download-selection.ts'

const sessionId = '598f346b-178c-4ef3-80ef-3a68f4cb4888'
const otherSession = '7668a96c-43cd-4b9b-8bdb-a0e743802af7'
const workspaceId = 'b2cda611-5cf4-49f4-8606-7b8a66701e11'
const revision = 'a'.repeat(64)
const paths = ['/workspace/中文/read me.txt', '/workspace/other/read me.txt']

function view(selected: readonly string[] = paths, id = sessionId) {
  const request = downloadPaths(id, selected)
  return { sessionId: id, workspaceId, revision, downloadUrl: fileDownloadUrl({ ...request, revision }),
    fileCount: selected.length, fileName: selected.length === 1 ? request.paths[0]!.split('/').at(-1)! : 'workspace-files.zip',
    sourceBytes: 4, totalBytes: selected.length === 1 ? 4 : 300,
    contentType: selected.length === 1 ? 'application/octet-stream' : 'application/zip' }
}

test('prepare uses the shared RPC envelope with canonical ordered paths and same-origin credentials', async () => {
  let captured: { url: string; init: RequestInit | undefined } | undefined
  const controller = new AbortController()
  const client = new WorkspaceDownloadClient(async (input, init) => {
    captured = { url: String(input), init }
    return Response.json(view())
  })
  assert.deepEqual(await client.prepare(sessionId, paths, controller.signal), view())
  assert.equal(captured?.url, '/api/powerEvolve/filesDownloadPrepare')
  assert.equal(captured?.init?.method, 'POST')
  assert.equal(captured?.init?.credentials, 'same-origin')
  assert.equal(captured?.init?.redirect, 'error')
  assert.equal(captured?.init?.signal, controller.signal)
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), { request: { sessionId,
    paths: ['中文/read me.txt', 'other/read me.txt'] } })
  const original = new WorkspaceDownloadClient(async () => Response.json(view([paths[0]!])) )
  assert.equal((await original.prepare(sessionId, [paths[0]!], controller.signal)).fileName, 'read me.txt')
})

test('selection rejects unsafe paths, duplicate entries, invalid identities, count and UTF-8 URL overflow before fetch', async () => {
  for (const selected of [[], Array.from({ length: 101 }, (_, index) => `/workspace/file${index}`),
    ['/private/a'], ['/workspace/'], ['/workspace/../a'], ['/workspace/a//b'], ['/workspace/C:/a'],
    ['/workspace/a\\b'], ['/workspace/a\0b'], ['/workspace/e\u0301.txt'], ['/workspace/\ud800'],
    ['/workspace/' + 'a'.repeat(101)], [paths[0]!, paths[0]!],
    Array.from({ length: 20 }, (_, index) => `/workspace/${index}${'中'.repeat(99)}`)]) {
    let called = false
    const client = new WorkspaceDownloadClient(async () => { called = true; return Response.json(view()) })
    await assert.rejects(client.prepare(sessionId, selected, new AbortController().signal), DownloadError)
    assert.equal(called, false)
  }
  assert.throws(() => downloadPaths('', paths), DownloadError)
  assert.throws(() => downloadPaths('global-current-session', paths), DownloadError)
})

test('client rejects valid metadata that belongs to a different viewed Session or selection', async () => {
  for (const metadata of [view(paths, otherSession), view(['/workspace/replaced.bin', paths[1]!]), view([paths[0]!])]) {
    const client = new WorkspaceDownloadClient(async () => Response.json(metadata))
    await assert.rejects(client.prepare(sessionId, paths, new AbortController().signal), DownloadError)
  }
})

test('client rejects malformed or redirected metadata without creating a browser target', async () => {
  for (const change of [
    { downloadUrl: 'https://other.invalid/download' }, { downloadUrl: '//other.invalid/download' },
    { downloadUrl: 'javascript:alert(1)' }, { downloadUrl: view().downloadUrl + '&token=secret' },
    { downloadUrl: view().downloadUrl + '#hash' }, { revision: 'b'.repeat(64) },
    { fileCount: 3 }, { contentType: 'text/html' }, { fileName: '../escaped.zip' },
    { fileName: 'different.zip' }, { sourceBytes: -1 }, { totalBytes: 0 }, { workspaceId: 'invalid' },
    { unexpected: true },
  ]) {
    const client = new WorkspaceDownloadClient(async () => Response.json({ ...view(), ...change }))
    await assert.rejects(client.prepare(sessionId, paths, new AbortController().signal), DownloadError)
  }
  for (const body of ['{', 'null', ' '.repeat(16 * 1024 + 1)]) {
    const client = new WorkspaceDownloadClient(async () => new Response(body))
    await assert.rejects(client.prepare(sessionId, paths, new AbortController().signal), DownloadError)
  }
})

test('preparation maps server refusal statuses to recoverable UI failures', async () => {
  for (const [status, reason] of [[400, 'failed'], [401, 'denied'], [403, 'denied'], [404, 'missing'],
    [409, 'changed'], [413, 'limit'], [414, 'limit'], [429, 'busy'], [503, 'busy'], [504, 'timeout'], [502, 'failed']] as const) {
    const client = new WorkspaceDownloadClient(async () => new Response(null, { status }))
    await assert.rejects(client.prepare(sessionId, paths, new AbortController().signal),
      (error: unknown) => error instanceof DownloadError && error.reason === reason)
  }
})

test('cancellation before fetch and while reading a preparation body ends without a view', async () => {
  let calls = 0
  const client = new WorkspaceDownloadClient(async () => { calls++; return Response.json(view()) })
  const before = new AbortController()
  before.abort()
  await assert.rejects(client.prepare(sessionId, paths, before.signal))
  assert.equal(calls, 0)
  let canceled = false
  const started = Promise.withResolvers<void>()
  const during = new AbortController()
  const pending = new WorkspaceDownloadClient(async () => new Response(new ReadableStream({
    pull() { started.resolve() }, cancel() { canceled = true },
  })))
  const result = pending.prepare(sessionId, paths, during.signal)
  await started.promise
  during.abort()
  await assert.rejects(result)
  assert.equal(canceled, true)
})

test('selections retain order and distinguish viewed Session, tab and root without persisting data', () => {
  const store = createDownloadSelectionStore().create()
  const { actions } = store
  actions.toggle(sessionId, 'first', '/workspace', paths[0]!)
  actions.toggle(sessionId, 'first', '/workspace', paths[1]!)
  actions.toggle(sessionId, 'second', '/workspace', '/workspace/image.bin')
  assert.deepEqual(store.getSnapshot().byTab.first?.paths, paths)
  actions.resetRoot(sessionId, 'first', '/workspace')
  assert.deepEqual(store.getSnapshot().byTab.first?.paths, paths)
  actions.toggle(sessionId, 'first', '/workspace', paths[0]!)
  assert.deepEqual(store.getSnapshot().byTab.first?.paths, [paths[1]!])
  actions.toggle(otherSession, 'first', '/workspace', '/workspace/other.bin')
  assert.equal(store.getSnapshot().byTab.first?.sessionId, otherSession)
  assert.deepEqual(store.getSnapshot().byTab.first?.paths, ['/workspace/other.bin'])
  actions.resetRoot(otherSession, 'first', '/workspace/sub')
  assert.equal(store.getSnapshot().byTab.first, undefined)
  assert.equal(store.getSnapshot().byTab.second?.paths.length, 1)
  actions.forget('second')
  assert.deepEqual(store.getSnapshot().byTab, {})
})

test('an overlong addition preserves the previous selection and existing entries can still be removed', () => {
  const store = createDownloadSelectionStore().create()
  const accepted: string[] = []
  for (let index = 0; index < 100; index++) {
    const path = `/workspace/${index}${'中'.repeat(99)}`
    try { fileDownloadPrepareRequest.parse(downloadPaths(sessionId, [...accepted, path])); accepted.push(path) }
    catch (_error) { /* The first wire limit leaves the preceding valid selection intact. */ }
    store.actions.toggle(sessionId, 'first', '/workspace', path)
  }
  assert.ok(accepted.length > 0 && accepted.length < 100)
  assert.deepEqual(store.getSnapshot().byTab.first?.paths, accepted)
  store.actions.toggle(sessionId, 'first', '/workspace', accepted[0]!)
  assert.deepEqual(store.getSnapshot().byTab.first?.paths, accepted.slice(1))
})
