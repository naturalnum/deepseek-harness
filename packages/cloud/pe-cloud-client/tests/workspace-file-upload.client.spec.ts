/** Browser File APIs, bounded hashing, original transport and exact workspace publication receipts. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { uploadWorkspaceFile, type WorkspaceFileUploadInput } from '../src/client/workspace-file-upload.ts'

afterEach(() => { vi.restoreAllMocks() })

function fixture(file = new File(['abc'], 'name.txt')) {
  const lifetime = new AbortController(), caller = new AbortController()
  let value: object | undefined
  const fetch = vi.fn<FileUploadFetch>(async (_url, init) => Response.json(value ?? {
    ok: true, value: { kind: 'workspace-upload', path: './folder/name.txt',
      sha256: new Headers(init.headers).get('x-content-sha256'), bytes: file.size, outcome: 'published' },
  }))
  const input: WorkspaceFileUploadInput = { file, name: 'name.txt', directory: './folder', sessionId: SessionId('session'),
    fetch, signal: caller.signal, lifetime: lifetime.signal, maxFileBytes: 64 * 1024 * 1024,
    maxMetadataBytes: 4096, readChunkBytes: 64 * 1024 }
  return { input, fetch, lifetime, caller, reply: (next: object) => { value = next } }
}

it.each([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
])('hashes the standard SHA256 vector %j through slices', async (text, sha256) => {
  const f = fixture(new File([text], 'name.txt'))
  const whole = vi.spyOn(f.input.file, 'arrayBuffer').mockRejectedValue(new Error('whole-file read forbidden'))
  const value = await uploadWorkspaceFile({ ...f.input, directory: '.', readChunkBytes: 7,
    fetch: async (url, init) => {
      expect(new URL(String(url), 'https://fixture/').searchParams.get('directory')).toBe('.')
      expect(new Headers(init.headers).get('x-content-sha256')).toBe(sha256)
      return Response.json({ ok: true, value: { kind: 'workspace-upload', path: './name.txt', sha256,
        bytes: f.input.file.size, outcome: 'reused' } })
    } })
  expect(value).toEqual({ kind: 'workspace-upload', path: './name.txt', sha256, bytes: f.input.file.size, outcome: 'reused' })
  expect(whole).not.toHaveBeenCalled()
})

it('hashes an actual 64MiB File with bounded reads and sends the same Blob on the original account fetch', async () => {
  const part = Uint8Array.from({ length: 1024 * 1024 }, (_byte, i) => i % 251)
  const oracle = createHash('sha256')
  for (let i = 0; i < 64; i++) oracle.update(part)
  const file = new File(Array.from({ length: 64 }, () => part), 'large.bin')
  const f = fixture(file), spans: number[] = []
  const whole = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('whole-file read forbidden'))
  const slice = file.slice.bind(file)
  vi.spyOn(file, 'slice').mockImplementation((start = 0, end = file.size) => {
    spans.push(end - start)
    return slice(start, end)
  })
  const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unbound fetch forbidden'))
  const result = await uploadWorkspaceFile(f.input)
  expect(result.sha256).toBe(oracle.digest('hex'))
  expect(result.bytes).toBe(64 * 1024 * 1024)
  expect(spans).toHaveLength(1024)
  expect(Math.max(...spans)).toBe(f.input.readChunkBytes)
  expect(spans.reduce((sum, bytes) => sum + bytes, 0)).toBe(file.size)
  expect(whole).not.toHaveBeenCalled()
  expect(globalFetch).not.toHaveBeenCalled()
  expect(f.fetch).toHaveBeenCalledOnce()
  const [address, request] = f.fetch.mock.calls[0]!
  const url = new URL(String(address), 'https://fixture/')
  expect(url.pathname).toBe('/api/workspace-files/upload')
  expect(Object.fromEntries(url.searchParams)).toEqual({ sessionId: 'session', name: 'name.txt', directory: './folder' })
  expect(request.method).toBe('POST')
  expect(request.body).toBe(file)
  expect(new Headers(request.headers).get('content-type')).toBe('application/octet-stream')
  expect(new Headers(request.headers).get('content-length')).toBeNull()
  expect(new Headers(request.headers).get('x-content-sha256')).toBe(result.sha256)
}, 15000)

it.each(['caller', 'lifetime'] as const)('joins the current bounded hash read before reporting %s cancellation', async (owner) => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), read = Promise.withResolvers<ArrayBuffer>()
  const slice = f.input.file.slice.bind(f.input.file)
  vi.spyOn(f.input.file, 'slice').mockImplementation((start, end) => {
    const part = slice(start, end)
    vi.spyOn(part, 'arrayBuffer').mockImplementation(() => { entered.resolve(undefined); return read.promise })
    return part
  })
  const operation = uploadWorkspaceFile(f.input)
  const observed = Promise.allSettled([operation])
  let settled = false
  void observed.then(() => { settled = true })
  await entered.promise
  const reason = new Error('hash owner ended')
  f[owner].abort(reason)
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.fetch).not.toHaveBeenCalled()
  read.resolve(new Uint8Array([97, 98, 99]).buffer)
  expect((await observed)[0]).toEqual({ status: 'rejected', reason })
})

it.each(['caller', 'lifetime'] as const)('passes %s cancellation to the original in-flight HTTP request', async (owner) => {
  const f = fixture(), entered = Promise.withResolvers<undefined>()
  const request: FileUploadFetch = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init.signal
    if (signal == null) throw new Error('missing upload signal')
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    entered.resolve(undefined)
  })
  const operation = uploadWorkspaceFile({ ...f.input, fetch: request })
  const observed = Promise.allSettled([operation])
  await entered.promise
  const reason = new Error('http owner ended')
  f[owner].abort(reason)
  await expect(operation).rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown', cause: reason })
  await observed
})

it('cancels an oversized metadata body instead of accepting a partial receipt', async () => {
  const f = fixture(), cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4097)) }, cancel })
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => new Response(body) }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown', cause: { code: 'response-too-large' } })
  expect(cancel).toHaveBeenCalledOnce()
})

it('bounds the complete multibyte metadata response at its exact UTF8 size', async () => {
  const f = fixture()
  const value = { ok: true, value: { kind: 'workspace-upload', path: './folder/name.txt',
    sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3, outcome: 'published' }, note: '中文' }
  const maxMetadataBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  const fetch: FileUploadFetch = async () => Response.json(value)
  expect((await uploadWorkspaceFile({ ...f.input, fetch, maxMetadataBytes })).path).toBe('./folder/name.txt')
  await expect(uploadWorkspaceFile({ ...f.input, fetch, maxMetadataBytes: maxMetadataBytes - 1 }))
    .rejects.toMatchObject({ cause: { code: 'response-too-large' } })
})

it('joins response-body cancellation after the HTTP headers have arrived', async () => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
  const body = new ReadableStream<Uint8Array>({
    pull() { entered.resolve(undefined) }, cancel: () => released.promise,
  }, { highWaterMark: 0 })
  const operation = uploadWorkspaceFile({ ...f.input, fetch: async () => new Response(body) })
  const observed = Promise.allSettled([operation])
  let settled = false
  void observed.then(() => { settled = true })
  await entered.promise
  f.lifetime.abort(new Error('page ended during receipt'))
  await Promise.resolve()
  expect(settled).toBe(false)
  released.resolve(undefined)
  await expect(operation).rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown' })
  await observed
})

it('cancels a response delivered after its page was revoked before reading metadata', async () => {
  const f = fixture(), cancel = vi.fn()
  const reason = new Error('page ended before metadata read')
  const body = new ReadableStream<Uint8Array>({ cancel })
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => {
    f.lifetime.abort(reason)
    return new Response(body)
  } })).rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown', cause: reason })
  expect(cancel).toHaveBeenCalledWith(reason)
})

it.each([
  { kind: 'attachment' }, { path: '../other' }, { path: '/folder/name.txt' }, { path: 'folder/../name.txt' },
  { path: 'folder\\name.txt' }, { path: 'folder/other.txt' }, { path: 'other/name.txt' },
  { path: 'folder/\u0000name.txt' }, { path: 'folder/.pe/name.txt' },
  { sha256: '0'.repeat(64) }, { bytes: 2 }, { bytes: '3' }, { outcome: 'unknown' },
])('rejects mismatched or unsafe publication receipt %j', async (change) => {
  const f = fixture()
  f.reply({ ok: true, value: { kind: 'workspace-upload', path: './folder/name.txt',
    sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3, outcome: 'published', ...change } })
  await expect(uploadWorkspaceFile(f.input)).rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown' })
})

it.each([
  ['report.txt', 'report_1.txt'], ['report.txt', 'report_2.txt'],
  ['archive.tar.gz', 'archive.tar_1.gz'], ['archive.tar.gz', 'archive.tar_2.gz'],
  ['.env', '.env_1'], ['.env', '.env_2'], ['.env.local', '.env_1.local'],
  ['report_1.txt', 'report_1_1.txt'], ['report_1.txt', 'report_1_2.txt'],
  ['report', 'report_1'], ['a[b].txt', 'a[b]_1.txt'], ['报告.txt', '报告_2.txt'],
  ['report.txt', 'report_18446744073709551615.txt'],
])('retains the actual Native collision path for %s → %s', async (name, published) => {
  const f = fixture()
  f.reply({ ok: true, value: { kind: 'workspace-upload', path: `./folder/${published}`,
    sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3, outcome: 'published' } })
  const receipt = await uploadWorkspaceFile({ ...f.input, name })
  expect(receipt.path).toBe(`./folder/${published}`)
  expect(receipt).not.toHaveProperty('receiptId')
  expect(receipt).not.toHaveProperty('file')
})

it('accepts the Native collision path at the selected workspace root', async () => {
  const f = fixture()
  f.reply({ ok: true, value: { kind: 'workspace-upload', path: './name_2.txt',
    sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3, outcome: 'published' } })
  expect((await uploadWorkspaceFile({ ...f.input, directory: '.' })).path).toBe('./name_2.txt')
})

it.each([
  ['report.txt', './folder/report_0.txt'], ['report.txt', './folder/report_01.txt'],
  ['report.txt', './folder/report_-1.txt'], ['report.txt', './folder/report_+1.txt'],
  ['report.txt', './folder/report_1.0.txt'], ['report.txt', './folder/report_1a.txt'],
  ['report.txt', './folder/report_1_2.txt'], ['report.txt', './folder/report_.txt'],
  ['report.txt', './folder/report_18446744073709551616.txt'], ['report.txt', './folder/report_999999999999999999999.txt'],
  ['report.txt', './folder/report_1.txt.extra'], ['report.txt', './folder/report.txt_1'],
  ['archive.tar.gz', './folder/archive_1.tar.gz'], ['.env', './folder/_1.env'],
  ['.env.local', './folder/.env.local_1'], ['report_1.txt', './folder/report_2.txt'],
  ['report.txt', './other/report_1.txt'], ['report.txt', './folder/nested/report_1.txt'],
  ['report.txt', './folder/../folder/report_1.txt'], ['report.txt', './folder/report_1.txt/extra'],
  ['中'.repeat(84) + '.t', `./folder/${'中'.repeat(84)}_1.t`],
])('rejects names outside the Native collision rule for %s → %s', async (name, path) => {
  const f = fixture()
  f.reply({ ok: true, value: { kind: 'workspace-upload', path,
    sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3, outcome: 'published' } })
  await expect(uploadWorkspaceFile({ ...f.input, name }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown' })
})

it('keeps an otherwise valid collision receipt unconfirmed when its page is cancelled during metadata delivery', async () => {
  const f = fixture(), reason = new Error('page cancelled with collision receipt')
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, value: { kind: 'workspace-upload',
    path: './folder/name_1.txt', sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3, outcome: 'published' } }))
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    controller.enqueue(bytes)
    f.lifetime.abort(reason)
  } }, { highWaterMark: 0 })
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => new Response(body) }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown', cause: reason })
})

it.each([null, {}, { ok: false }, { ok: true }, { ok: true, value: null }, { ok: true, value: [] }])
('rejects an incomplete receipt %j', async (value) => {
  const f = fixture()
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => Response.json(value) }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown' })
})

it('distinguishes the exact no-publication refusal from an HTTP status without that receipt', async () => {
  const f = fixture()
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => Response.json({ ok: false,
    error: { code: 'workspace/upload-rejected', outcome: 'not-published' } }, { status: 413 }) }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'not-published' })
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => Response.json({ error: 'private server detail' }, { status: 413 }) }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown', message: 'upload-unconfirmed' })
})

it.each(['invalid json', '\u00ff'])('rejects malformed receipt bytes %j', async (value) => {
  const f = fixture()
  await expect(uploadWorkspaceFile({ ...f.input, fetch: async () => new Response(value === '\u00ff' ? new Uint8Array([255]) : value) }))
    .rejects.toMatchObject({ code: 'upload-unconfirmed', outcome: 'unknown' })
})

it.each(['../bad', '/bad', 'a\\b', 'a/b', '.', '.pe', 'bad\u0000'])('rejects unsafe leaf %j before reading or fetching', async (name) => {
  const f = fixture(), read = vi.spyOn(f.input.file, 'slice')
  await expect(uploadWorkspaceFile({ ...f.input, name })).rejects.toMatchObject({ code: 'invalid-path', outcome: 'not-published' })
  expect(read).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['../bad', '/bad', 'a//b', 'a/../b', 'a/./b', 'a\\b', '.pe'])('rejects unsafe directory %j before fetching', async (directory) => {
  const f = fixture()
  await expect(uploadWorkspaceFile({ ...f.input, directory })).rejects.toMatchObject({ code: 'invalid-path', outcome: 'not-published' })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('rejects an oversized file and an already ended page before reading or fetching', async () => {
  const f = fixture(), read = vi.spyOn(f.input.file, 'slice')
  await expect(uploadWorkspaceFile({ ...f.input, maxFileBytes: 2, readChunkBytes: 1 }))
    .rejects.toMatchObject({ code: 'upload-too-large', outcome: 'not-published' })
  const reason = new Error('page ended')
  f.lifetime.abort(reason)
  await expect(uploadWorkspaceFile(f.input)).rejects.toBe(reason)
  expect(read).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each([
  { readChunkBytes: 0 }, { readChunkBytes: Infinity }, { readChunkBytes: 2 ** 40 },
  { maxFileBytes: -1 }, { maxMetadataBytes: 0 }, { maxMetadataBytes: 0.5 },
])('rejects invalid explicit limits %j before fetching', async (limits) => {
  const f = fixture()
  await expect(uploadWorkspaceFile({ ...f.input, ...limits })).rejects.toBeInstanceOf(RangeError)
  expect(f.fetch).not.toHaveBeenCalled()
})
