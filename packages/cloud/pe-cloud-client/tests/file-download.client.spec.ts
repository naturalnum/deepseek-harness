// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { CloudFileDownload, type CloudFileDownloadInput, type CloudFileReadBytes } from '../src/client/file-download.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const id = SessionId('download-session')
const owners: CloudFileDownload[] = []
function surface() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:owned-download')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const clicked: Array<{ href: string; name: string }> = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, name: this.download })
  })
  return { createObjectURL, revokeObjectURL, clicked }
}
function complete(data = new Uint8Array([0, 255, 7])): Awaited<ReturnType<CloudFileReadBytes>> {
  return { ok: true, value: { absolutePath: '/native/name.html', version: 'native-version', data,
    offset: 0, eof: true, bytes: data.byteLength } }
}
const completeRange: CloudFileReadBytes = async (_session, _path, options) => {
  const offset = options?.range?.offset ?? 0
  const data = offset === 0 ? new Uint8Array([0, 255, 7]) : new Uint8Array()
  return { ok: true, value: { absolutePath: '/native/name.html', version: 'native-version', data,
    offset, eof: true, bytes: 3 } }
}
function owner(overrides: Partial<CloudFileDownloadInput> = {}) {
  const page = new AbortController()
  const readBytes = vi.fn<CloudFileReadBytes>(completeRange)
  const input: CloudFileDownloadInput = { sessionId: id, resourceAddress: sessionFileAddress(id, 'folder/name.html'),
    signal: page.signal, readBytes, maxFileBytes: 16, ...overrides }
  const download = new CloudFileDownload(input)
  owners.push(download)
  return { download, page, readBytes }
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map(download => download.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('requests authorized native byte ranges with the captured Session and unmodified path, and saves only an octet-stream Blob', async () => {
  const browser = surface(), f = owner()
  expect(await f.download.save()).toEqual({ kind: 'started' })
  expect(f.readBytes).toHaveBeenCalledWith(id, 'folder/name.html', { range: { offset: 0, length: 16 } }, expect.any(AbortSignal))
  const blob = browser.createObjectURL.mock.calls[0]?.[0]
  expect(blob?.type).toBe('application/octet-stream')
  expect(blob?.size).toBe(3)
  if (blob === undefined) throw new Error('Download Blob not created')
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('Download Blob was not binary'))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('Download Blob read failed')) }
    reader.readAsArrayBuffer(blob)
  })
  expect([...new Uint8Array(bytes)]).toEqual([0, 255, 7])
  expect(browser.clicked).toEqual([{ href: 'blob:owned-download', name: 'name.html' }])
  expect(document.querySelector('a')).toBeNull()
  expect(document.querySelector('iframe')).toBeNull()
  expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:owned-download')
})

it('downloads a 100KiB result in bounded ranges while preserving its Session, identity and version', async () => {
  const browser = surface(), source = Uint8Array.from({ length: 102_672 }, (_, i) => i % 251)
  const readBytes = vi.fn<CloudFileReadBytes>(async (_session, _path, options) => {
    const range = options?.range
    if (range?.offset === undefined || range.length === undefined) throw new Error('expected explicit range')
    const data = source.slice(range.offset, range.offset + range.length)
    return { ok: true, value: { absolutePath: '/native/name.html', version: 'v1', bytes: source.length,
      offset: range.offset, data, eof: range.offset + data.length === source.length } }
  })
  const f = owner({ maxFileBytes: 128 * 1024, readBytes })
  expect(await f.download.save()).toEqual({ kind: 'started' })
  expect(readBytes.mock.calls.map(call => call[2]?.range?.offset)).toEqual([0, 32768, 65536, 98304, 102672])
  expect(readBytes.mock.calls.every(call => call[0] === id && call[1] === 'folder/name.html'
    && (call[2]?.range?.length ?? 0) <= 32768)).toBe(true)
  const blob = browser.createObjectURL.mock.calls[0]?.[0]
  expect(blob?.size).toBe(source.length)
  if (blob === undefined) throw new Error('Download Blob not created')
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('not binary'))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.readAsArrayBuffer(blob)
  })
  expect(new Uint8Array(bytes)).toEqual(source)
})

it('never saves bytes collected across changing file versions', async () => {
  const browser = surface()
  const readBytes = vi.fn<CloudFileReadBytes>()
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v1', bytes: 4,
      offset: 0, data: new Uint8Array([1, 2]), eof: false } })
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v2', bytes: 4,
      offset: 2, data: new Uint8Array([3, 4]), eof: true } })
  const f = owner({ readBytes })
  expect(await f.download.save()).toEqual({ kind: 'failed', reason: 'incomplete' })
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})

it('does not save when the source changes after the last data window', async () => {
  const browser = surface()
  const readBytes = vi.fn<CloudFileReadBytes>()
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v1', bytes: 4,
      offset: 0, data: new Uint8Array([1, 2]), eof: false } })
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v1', bytes: 4,
      offset: 2, data: new Uint8Array([3, 4]), eof: true } })
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v2', bytes: 4,
      offset: 4, data: new Uint8Array(), eof: true } })
  const f = owner({ readBytes })
  expect(await f.download.save()).toEqual({ kind: 'failed', reason: 'incomplete' })
  expect(readBytes).toHaveBeenCalledTimes(3)
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})

it.each([{ values: [] }, { values: [7] }])('rechecks the final version even for a single-window file with bytes $values', async ({ values }) => {
  const browser = surface()
  const readBytes = vi.fn<CloudFileReadBytes>()
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v1', bytes: values.length,
      offset: 0, data: new Uint8Array(values), eof: true } })
    .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/native/name', version: 'v2', bytes: values.length,
      offset: values.length, data: new Uint8Array(), eof: true } })
  const f = owner({ readBytes })
  expect(await f.download.save()).toEqual({ kind: 'failed', reason: 'incomplete' })
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})

it.each([
  'https://private.example/download', 'file:///private/name',
  'dsh-resource://file/absolute/private/name', sessionFileAddress('another-session', 'name'),
  'dsh-resource://file/session/download-session/%XY', sessionFileAddress(id, ''),
])('rejects an unscoped, foreign or malformed resource without any RPC: %s', async (resourceAddress) => {
  const browser = surface(), f = owner({ resourceAddress })
  expect(await f.download.save()).toEqual({ kind: 'failed', reason: 'invalid-resource' })
  expect(f.readBytes).not.toHaveBeenCalled()
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})

it('refuses unsafe deployment caps before making an owner', () => {
  surface()
  const f = owner()
  for (const maxFileBytes of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new CloudFileDownload({ sessionId: id, resourceAddress: sessionFileAddress(id, 'name'),
      signal: f.page.signal, readBytes: f.readBytes, maxFileBytes })).toThrow(RangeError)
  }
})

it('does not save an oversized or incomplete native result', async () => {
  const browser = surface()
  const cases: Array<{ result: Awaited<ReturnType<CloudFileReadBytes>>; reason: string }> = [
    { result: complete(new Uint8Array(17)), reason: 'too-large' },
    { result: { ok: true, value: { absolutePath: '/native/name', version: 'v', offset: 0, eof: true, bytes: 17, data: new Uint8Array(1) } }, reason: 'too-large' },
    { result: { ok: true, value: { absolutePath: '/native/name', version: 'v', offset: 1, eof: true, data: new Uint8Array(1) } }, reason: 'incomplete' },
    { result: { ok: true, value: { absolutePath: '/native/name', version: 'v', offset: 0, eof: false, data: new Uint8Array(1) } }, reason: 'incomplete' },
  ]
  for (const item of cases) {
    const f = owner({ readBytes: vi.fn<CloudFileReadBytes>().mockResolvedValue(item.result) })
    expect(await f.download.save()).toEqual({ kind: 'failed', reason: item.reason })
  }
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})

it('keeps the single read owned through cancellation and joins its late result without saving it', async () => {
  const browser = surface()
  let finish!: (result: Awaited<ReturnType<CloudFileReadBytes>>) => void
  const readBytes = vi.fn<CloudFileReadBytes>(() => new Promise((resolve) => { finish = resolve }))
  const f = owner({ readBytes })
  const task = f.download.save()
  expect(await f.download.save()).toEqual({ kind: 'busy' })
  const cleanup = f.download.dispose()
  let joined = false
  void cleanup.then(() => { joined = true })
  await Promise.resolve()
  expect(joined).toBe(false)
  expect(readBytes.mock.calls[0]?.[3]?.aborted).toBe(true)
  finish(complete())
  expect(await task).toEqual({ kind: 'cancelled' })
  await cleanup
  expect(joined).toBe(true)
  expect(browser.createObjectURL).not.toHaveBeenCalled()
  expect(await f.download.save()).toEqual({ kind: 'cancelled' })
  expect(readBytes).toHaveBeenCalledOnce()
})

it.each(['resolve', 'reject'] as const)('does not save when cancelled during final verification and the read later %ss', async (outcome) => {
  const browser = surface()
  let finish!: () => void
  const readBytes = vi.fn<CloudFileReadBytes>().mockResolvedValueOnce(complete())
    .mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => {
        if (outcome === 'resolve') resolve({ ok: true, value: {
          absolutePath: '/native/name.html', version: 'native-version', offset: 3, eof: true, bytes: 3, data: new Uint8Array(),
        } })
        else reject(new Error('late read failure'))
      }
    }))
  const f = owner({ readBytes })
  const task = f.download.save()
  await vi.waitFor(() => { expect(readBytes).toHaveBeenCalledTimes(2) })
  const cleanup = f.download.cancel()
  finish()
  expect(await task).toEqual({ kind: 'cancelled' })
  await cleanup
  expect(browser.createObjectURL).not.toHaveBeenCalled()
  expect(browser.clicked).toEqual([])
})

it('releases a URL when the original page closes during Blob creation, without clicking a late save', async () => {
  const browser = surface(), f = owner()
  browser.createObjectURL.mockImplementation(() => { f.page.abort(); return 'blob:late-owned' })
  expect(await f.download.save()).toEqual({ kind: 'cancelled' })
  await f.download.dispose()
  expect(browser.clicked).toEqual([])
  expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:late-owned')
})

it('preserves native failure as its cause and does not automatically retry', async () => {
  const browser = surface()
  const denied = new RemoteError('gateway/bad-request', '/private/path', {})
  const readBytes = vi.fn<CloudFileReadBytes>().mockResolvedValue({ ok: false, error: denied })
  const f = owner({ readBytes })
  const result = await f.download.save()
  expect(result).toEqual({ kind: 'failed', reason: 'native', cause: denied })
  expect(readBytes).toHaveBeenCalledOnce()
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})

it('releases its URL and removes the anchor even if browser initiation fails', async () => {
  const browser = surface(), f = owner()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('browser save unavailable') })
  expect(await f.download.save()).toMatchObject({ kind: 'failed', reason: 'browser' })
  expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:owned-download')
  expect(document.querySelector('a')).toBeNull()
})

it('shares cancellation settlement and permits another explicit read only after the cancelled one settles', async () => {
  const browser = surface()
  let finish!: (result: Awaited<ReturnType<CloudFileReadBytes>>) => void
  const readBytes = vi.fn<CloudFileReadBytes>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    .mockImplementation(completeRange)
  const f = owner({ readBytes })
  const first = f.download.save()
  const cancelled = f.download.cancel()
  expect(f.download.cancel()).toBe(cancelled)
  expect(await f.download.save()).toEqual({ kind: 'busy' })
  finish(complete())
  expect(await first).toEqual({ kind: 'cancelled' })
  await cancelled
  expect(await f.download.save()).toEqual({ kind: 'started' })
  expect(readBytes).toHaveBeenCalledTimes(3)
  expect(browser.clicked).toHaveLength(1)
})

it('keeps the native full-file-cap error while selecting the localized too-large presentation', async () => {
  const browser = surface()
  const error = new RemoteError('workspace-file/too-large', 'native cap', { path: 'name', limit: 16 })
  const f = owner({ readBytes: vi.fn<CloudFileReadBytes>().mockResolvedValue({ ok: false, error }) })
  expect(await f.download.save()).toEqual({ kind: 'failed', reason: 'too-large', cause: error })
  expect(browser.createObjectURL).not.toHaveBeenCalled()
})
