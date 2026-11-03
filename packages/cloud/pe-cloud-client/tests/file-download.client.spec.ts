// @vitest-environment jsdom
import { expect, it, vi, afterEach } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { CloudFileDownload } from '../src/client/file-download.ts'
afterEach(() => { vi.restoreAllMocks() })
function fixture(response = new Response(null, { headers: { 'content-length': '1073741824' } })) {
  const fetch = vi.fn<import('@deepseek-ai/dsh-client-file-upload/types').FileUploadFetch>(async () => response)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const signal = new AbortController().signal
  const input = { sessionId: SessionId('s'), resourceAddress: sessionFileAddress(SessionId('s'), '/workspace/报告.bin'),
    fetch, signal, maxFileBytes: 2 ** 40, navigationUrl: (path: string) => `https://example.test/${path}&epoch=9` }
  return { input, fetch, click, owner: new CloudFileDownload(input) }
}
it('hands a GiB attachment to the browser after HEAD without reading its content', async () => {
  const f = fixture()
  expect(await f.owner.save()).toEqual({ kind: 'started' })
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(f.fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
  expect(f.click).toHaveBeenCalledOnce()
  expect(document.querySelector('a')).toBeNull()
  await f.owner.dispose()
})
it('does not initiate a browser save for failed or oversized preflight', async () => {
  for (const response of [new Response(null, { status: 403 }), new Response(null, { headers: { 'content-length': String(2 ** 42) } })]) {
    const f = fixture(response)
    expect((await f.owner.save()).kind).toBe('failed')
    expect(f.click).not.toHaveBeenCalled()
    await f.owner.dispose(); vi.restoreAllMocks()
  }
})
it('cancels the bounded preflight and joins it before disposal returns', async () => {
  const f = fixture()
  f.input.fetch = vi.fn((_path, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
  }))
  const owner = new CloudFileDownload(f.input)
  const result = owner.save()
  expect(await owner.save()).toEqual({ kind: 'busy' })
  await owner.cancel()
  expect(await result).toEqual({ kind: 'cancelled' })
  expect(f.click).not.toHaveBeenCalled()
})
