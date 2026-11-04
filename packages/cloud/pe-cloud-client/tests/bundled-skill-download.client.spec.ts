// @vitest-environment jsdom
/** Bounded account-bound binary consumer; a browser handoff is not a filesystem persistence receipt. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { prepareBundledSkillDownload } from '../src/client/bundled-skill-download.ts'

const data = Uint8Array.from({ length: 635241 }, (_, i) => i % 251)
const hash = createHash('sha256').update(data).digest('hex')
const selector = { skillId: '00000000-0000-0000-0000-000000000001', contentVersion: 'a'.repeat(64) }
const headers = { 'content-type': 'application/zip', 'content-length': String(data.length), 'x-content-sha256': hash }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture(body: Uint8Array = data, responseHeaders = headers) {
  const create = vi.fn(() => 'blob:release'), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  const clicked: string[] = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href) })
  const fetch = vi.fn<FileUploadFetch>(async (_path, init) => new Response(init.method === 'HEAD' ? null : body.slice().buffer, { headers: responseHeaders }))
  const signal = new AbortController().signal, assertCurrent = vi.fn()
  const navigationUrl = vi.fn((path: string) => `http://localhost/${path}&peAccount=a&peGeneration=generation`)
  return { create, revoke, click, clicked, fetch, signal, assertCurrent, navigationUrl,
    input: { fetch, navigationUrl, signal, assertCurrent, maxArchiveBytes: data.length, timeoutMs: 30000 } }
}
it('rechecks the exact immutable metadata before handing off the original authenticated attachment navigation', async () => {
  const f = fixture(), download = await prepareBundledSkillDownload(f.input, selector, f.signal)
  expect(download).toBeTypeOf('function')
  await download?.(f.signal)
  expect(f.fetch.mock.calls.map(call => call[1].method)).toEqual(['HEAD', 'HEAD'])
  expect(f.fetch.mock.calls[0]?.[0]).toContain('api/skills/release-archive?skillId=')
  expect(f.create).not.toHaveBeenCalled(); expect(f.revoke).not.toHaveBeenCalled(); expect(f.click).toHaveBeenCalledTimes(1)
  expect(f.clicked).toEqual([`http://localhost/api/skills/release-archive?skillId=${selector.skillId}&contentVersion=${selector.contentVersion}&peAccount=a&peGeneration=generation`])
  expect(document.querySelector('a[download]')).toBeNull()
})
it.each(['too-large', 'missing-hash', 'refused'] as const)('withholds the callback for %s preflight', async (kind) => {
  const f = fixture()
  f.fetch.mockResolvedValueOnce(kind === 'refused' ? new Response(null, { status: 403 }) : new Response(null, { headers: {
    ...headers, ...kind === 'too-large' ? { 'content-length': String(data.length + 1) } : { 'x-content-sha256': '' },
  } }))
  expect(await prepareBundledSkillDownload(f.input, selector, f.signal)).toBeUndefined()
  expect(f.create).not.toHaveBeenCalled()
})
it.each(['refused', 'changed-length', 'changed-hash'] as const)('rejects %s metadata before attachment navigation', async (kind) => {
  const f = fixture(), download = await prepareBundledSkillDownload(f.input, selector, f.signal)
  f.fetch.mockResolvedValueOnce(kind === 'refused' ? new Response(null, { status: 403 }) : new Response(null, { headers: {
    ...headers, ...kind === 'changed-length' ? { 'content-length': String(data.length - 1) } : { 'x-content-sha256': '0'.repeat(64) },
  } }))
  await expect(download?.(f.signal)).rejects.toThrow()
  expect(f.create).not.toHaveBeenCalled(); expect(f.click).not.toHaveBeenCalled(); expect(f.navigationUrl).not.toHaveBeenCalled()
})
it('rechecks original lifetime after the awaited preflight and after URL capture', async () => {
  const f = fixture(), download = await prepareBundledSkillDownload(f.input, selector, f.signal)
  f.navigationUrl.mockImplementation(() => {
    f.assertCurrent.mockImplementation(() => { throw Error('Original page withdrawn') })
    return 'http://localhost/api/skills/release-archive'
  })
  await expect(download?.(f.signal)).rejects.toThrow('Original page withdrawn')
  expect(f.click).not.toHaveBeenCalled()
})
it('refuses a retired original page before the second HEAD and never navigates', async () => {
  const f = fixture(), download = await prepareBundledSkillDownload(f.input, selector, f.signal)
  f.assertCurrent.mockImplementation(() => { throw Error('Original page withdrawn') })
  await expect(download?.(f.signal)).rejects.toThrow()
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled()
})


it('contains a binary preflight network failure without losing already-read skill metadata', async () => {
  const f = fixture()
  f.fetch.mockRejectedValueOnce(new Error('Binary response unavailable'))
  expect(await prepareBundledSkillDownload(f.input, selector, f.signal)).toBeUndefined()
  expect(f.create).not.toHaveBeenCalled()
})
it('does not hide original scope withdrawal as a merely unavailable download', async () => {
  const f = fixture()
  f.fetch.mockImplementationOnce(async () => {
    f.assertCurrent.mockImplementation(() => { throw Error('Original page withdrawn') })
    throw Error('Cancelled original request')
  })
  await expect(prepareBundledSkillDownload(f.input, selector, f.signal)).rejects.toThrow('Original page withdrawn')
})
