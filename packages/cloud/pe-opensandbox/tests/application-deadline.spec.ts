/** Original adapter deadline admission only; the existing HTTP import is replaced before any possible wire call. */
import { afterEach, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createSelectedServerHttp, type PreviewHttpOwner } from '../src/application-http.ts'

vi.mock('node:http', () => ({ request: vi.fn(() => { throw new Error('HTTP wire is not authorized by these tests') }) }))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(httpRequest).mockClear() })
const policy = { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes: 1024, maxRequestHeaderBytes: 4096,
  maxPathBytes: 2048, timeoutMs: 1000, maxBufferPoolBytes: 8192 }
const bounds = { maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 4, maxHeaderCount: 8, maxHeaderBytes: 512 }
const request = { method: 'GET', resourcePath: '/', headers: [] } as const

it('refuses an already expired resident projection before retention and before any HTTP wire', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100)
  const retain = vi.fn<PreviewHttpOwner['retainRequest']>(() => { throw new Error('No expired request may be retained') })
  const transport = createSelectedServerHttp({ lifecycleBaseUrl: 'http://127.0.0.1:4477/v1', apiKey: 'component-only',
    limits: policy, assertCurrent() {} }, { sandboxId: 'deadline-component', port: 8000, deadlineAtMs: 100, assertCurrent() {} },
  { retainRequest: retain })
  await expect(transport.withResponse(request, bounds, new AbortController().signal, async () => {}))
    .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(retain).not.toHaveBeenCalled(); expect(httpRequest).not.toHaveBeenCalled()
})

it.each(['controller', 'resident'] as const)(
  'deducts retention callback time from the same HTTP timer instead of extending the %s deadline', async (variant) => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let actualTerminal: Promise<void> | undefined
    const retain = vi.fn<PreviewHttpOwner['retainRequest']>((input) => {
      actualTerminal = input.settled
      expect(input.charge.timeoutMs).toBe(variant === 'resident' ? 10 : 1000)
      now = 111
      return { timeoutMs: 10, assertCurrent() {} }
    })
    const transport = createSelectedServerHttp({ lifecycleBaseUrl: 'http://127.0.0.1:4477/v1', apiKey: 'component-only',
      limits: policy, assertCurrent() {} }, { sandboxId: 'deadline-component', port: 8000,
      deadlineAtMs: variant === 'resident' ? 110 : 10000, assertCurrent() {} }, { retainRequest: retain })
    await expect(transport.withResponse(request, bounds, new AbortController().signal, async () => {}))
      .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(retain).toHaveBeenCalledTimes(1); expect(httpRequest).not.toHaveBeenCalled()
    expect(actualTerminal).toBeDefined(); await actualTerminal
  })
