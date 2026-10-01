/** Browser download wire boundaries; no services or database are substituted. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { FILE_DOWNLOAD_CONTENT_PATH, FILE_DOWNLOAD_MAX_FILES, FILE_DOWNLOAD_MAX_URL_BYTES,
  fileDownloadContentRequest, fileDownloadPath, fileDownloadPrepareRequest, fileDownloadUrl,
  fileDownloadView } from '../../contracts/src/file-download.ts'

const sessionId = randomUUID()
const revision = 'a'.repeat(64)
const request = { sessionId, paths: ['报告/结果 #1%.txt', 'left/same.bin'], revision }
const view = { sessionId, workspaceId: randomUUID(), revision, downloadUrl: fileDownloadUrl(fileDownloadContentRequest.parse(request)),
  fileName: 'workspace-files.zip', contentType: 'application/zip', fileCount: 2, sourceBytes: 4, totalBytes: 260 }

test('canonical selections retain Chinese, spaces, punctuation, astral names and nested basenames', () => {
  const paths = ['报告/结果 #1%.txt', 'left/same.bin', 'right/same.bin', '😀.txt', "a&b='x'.txt"]
  assert.deepEqual(fileDownloadPrepareRequest.parse({ sessionId, paths }), { sessionId, paths })
  assert.equal(fileDownloadPath.parse('é.txt'), 'é.txt')
})

test('paths reject traversal, absolute roots, ambiguous separators, controls and noncanonical Unicode', () => {
  for (const path of ['', '/', '/workspace/a', '../a', 'a/../b', './a', 'a/./b', 'a//b', 'a/', '\\server\\a',
    'a\\b', 'C:a', 'c:/a', 'a\0b', 'a\nb', 'a\rb', 'a\tb', 'a\x7fb', 'e\u0301.txt', '\ud800.txt', '\udfff.txt',
    'a'.repeat(101), Array.from({ length: 17 }, () => 'a').join('/'), Array.from({ length: 6 }, () => 'a'.repeat(90)).join('/')]) {
    assert.equal(fileDownloadPath.safeParse(path).success, false, `Unsafe path of length ${path.length}`)
  }
  assert.equal(fileDownloadPath.safeParse(Array.from({ length: 16 }, () => 'a').join('/')).success, true)
  assert.equal(fileDownloadPath.safeParse('a'.repeat(100)).success, true)
})

test('preparation has only Session and a nonempty ordered unique selection within the protocol count', () => {
  for (const paths of [[], ['a', 'a'], Array.from({ length: FILE_DOWNLOAD_MAX_FILES + 1 }, (_, i) => `f-${i}`)]) {
    assert.equal(fileDownloadPrepareRequest.safeParse({ sessionId, paths }).success, false)
  }
  assert.equal(fileDownloadPrepareRequest.safeParse({ sessionId, paths: Array.from({ length: FILE_DOWNLOAD_MAX_FILES }, (_, i) => `f-${i}`) }).success, true)
  for (const extra of [{ userId: randomUUID() }, { workspaceId: randomUUID() }, { root: '/private' }, { token: 'credential' }, { revision }]) {
    assert.equal(fileDownloadPrepareRequest.safeParse({ sessionId, paths: ['a'], ...extra }).success, false)
  }
})

test('content revisions are lowercase SHA256 metadata and cannot smuggle request authority', () => {
  assert.deepEqual(fileDownloadContentRequest.parse(request), request)
  for (const changed of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    assert.equal(fileDownloadContentRequest.safeParse({ ...request, revision: changed }).success, false)
  }
  assert.equal(fileDownloadContentRequest.safeParse({ ...request, token: 'credential' }).success, false)
  assert.equal(fileDownloadContentRequest.safeParse({ ...request, workspaceId: randomUUID() }).success, false)
})

test('one URL round-trips the exact ordered selection and carries no credential or filesystem root', () => {
  const url = fileDownloadUrl(fileDownloadContentRequest.parse(request))
  const parsed = new URL(url, 'https://host.example.test')
  assert.equal(parsed.pathname, FILE_DOWNLOAD_CONTENT_PATH)
  assert.deepEqual([...parsed.searchParams.keys()], ['sessionId', 'paths', 'revision'])
  assert.equal(parsed.searchParams.get('sessionId'), sessionId)
  assert.equal(parsed.searchParams.get('revision'), revision)
  assert.deepEqual(JSON.parse(parsed.searchParams.get('paths')!), request.paths)
  assert.equal(parsed.hash, '')
  assert.equal(parsed.username, '')
  assert.equal(parsed.password, '')
  assert.ok(Buffer.byteLength(url) <= FILE_DOWNLOAD_MAX_URL_BYTES)
  assert.notEqual(fileDownloadUrl(fileDownloadContentRequest.parse({ ...request, paths: [...request.paths].reverse() })), url)
})

test('encoded URL limit admits its exact wire boundary and rejects the next canonical selection', () => {
  const base = { sessionId, revision, paths: [] as string[] }
  const prefix = Array.from({ length: 53 }, (_, i) => `${String(i).padStart(2, '0')}-${'a'.repeat(97)}`)
  let paths: string[] | undefined
  for (let size = 1; size <= 100; size++) {
    const candidate = [...prefix, 'z'.repeat(size)]
    const encoded = `${FILE_DOWNLOAD_CONTENT_PATH}?${new URLSearchParams({ sessionId, paths: JSON.stringify(candidate), revision })}`
    if (Buffer.byteLength(encoded) === FILE_DOWNLOAD_MAX_URL_BYTES) { paths = candidate; break }
  }
  assert.ok(paths, 'Fixture must reach the exact 6000-byte URL ceiling')
  assert.equal(Buffer.byteLength(fileDownloadUrl(fileDownloadContentRequest.parse({ ...base, paths }))), FILE_DOWNLOAD_MAX_URL_BYTES)
  assert.throws(() => fileDownloadUrl(fileDownloadContentRequest.parse({ ...base, paths: [...paths!.slice(0, -1), `${paths!.at(-1)}a`] })), RangeError)
  const unicode = fileDownloadContentRequest.parse({ sessionId, revision,
    paths: Array.from({ length: 8 }, (_, i) => `${i}-${'界'.repeat(98)}`) })
  assert.throws(() => fileDownloadUrl(unicode), RangeError)
})

test('prepared view accepts only its exact same-origin URL, matching metadata and safe attachment name', () => {
  assert.deepEqual(fileDownloadView.parse(view), view)
  const singleRequest = { ...request, paths: ['报告/结果 #1%.txt'] }
  const single = { ...view, downloadUrl: fileDownloadUrl(fileDownloadContentRequest.parse(singleRequest)),
    fileName: '结果 #1%.txt', fileCount: 1, contentType: 'application/octet-stream', totalBytes: 4 }
  assert.equal(fileDownloadView.safeParse(single).success, true)
  for (const downloadUrl of [
    `https://outside.example${view.downloadUrl}`, `//outside.example${view.downloadUrl}`,
    `https://user:password@outside.example${view.downloadUrl}`, `/elsewhere?${view.downloadUrl.split('?')[1]}`,
    `${view.downloadUrl}&token=credential`, `${view.downloadUrl}&sessionId=${sessionId}`,
    `${view.downloadUrl}#fragment`, view.downloadUrl.replace(sessionId, randomUUID()),
    view.downloadUrl.replace(revision, 'b'.repeat(64)), `${FILE_DOWNLOAD_CONTENT_PATH}?sessionId=${sessionId}&paths=null&revision=${revision}`,
  ]) assert.equal(fileDownloadView.safeParse({ ...view, downloadUrl }).success, false)
  for (const changed of [{ fileCount: 1 }, { fileName: '../result.zip' }, { fileName: 'result\r\nInjected.zip' },
    { contentType: 'application/octet-stream' }, { token: 'credential' }, { fileName: 'unexpected.zip' }]) {
    assert.equal(fileDownloadView.safeParse({ ...view, ...changed }).success, false)
  }
})

test('view byte counts exclude negative, fractional, unbounded and inconsistent raw-byte lengths', () => {
  for (const changed of [{ sourceBytes: -1 }, { totalBytes: -1 }, { totalBytes: 1.5 }, { fileCount: 0 },
    { fileCount: 101 }, { sourceBytes: 201 * 1024 * 1024 }, { totalBytes: 202 * 1024 * 1024 }]) {
    assert.equal(fileDownloadView.safeParse({ ...view, ...changed }).success, false)
  }
  const single = { ...view, downloadUrl: fileDownloadUrl(fileDownloadContentRequest.parse({ ...request, paths: ['a'] })),
    fileName: 'a', fileCount: 1, contentType: 'application/octet-stream' }
  assert.equal(fileDownloadView.safeParse(single).success, false)
})
