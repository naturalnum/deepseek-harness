/** Real fetch results, bounded bytes, and late bootstrap settlement. */
import { describe, expect, it, vi } from 'vitest'
import { BootstrapAttempt } from '../src/client/bootstrap.ts'
import { ClientFailure } from '../src/client/errors.ts'

const config = { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 50, maxBootstrapResponseBytes: 64 }

describe('bootstrap request ownership', () => {
  it('contacts the relative same-origin endpoint and delegates decoding without defining a DTO', async () => {
    const fetcher = vi.fn(async () => Response.json({ external: 'owner-decoded' }))
    const decode = vi.fn((value: unknown) => value)
    const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: fetcher, decode }, new AbortController().signal)
    expect(await attempt.result).toEqual({ external: 'owner-decoded' })
    await attempt.settled
    expect(fetcher).toHaveBeenCalledWith(new URL('https://example.test/app/cloud/bootstrap'), expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' }))
    expect(decode).toHaveBeenCalledTimes(1)
    expect(attempt.getSnapshot()).toEqual({ phase: 'decoded', settled: true, cleanup: 'confirmed' })
    attempt.cancel()
    expect(attempt.getSnapshot()).toEqual({ phase: 'decoded', settled: true, cleanup: 'confirmed' })
  })

  it('never decodes bytes returned after a timed-out carrier eventually completes', async () => {
    vi.useFakeTimers()
    const response = Promise.withResolvers<Response>()
    const decode = vi.fn()
    const cancel = vi.fn()
    try {
      const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: () => response.promise, decode }, new AbortController().signal)
      const rejected = expect(attempt.result).rejects.toMatchObject({ code: 'bootstrap-timeout' })
      await vi.advanceTimersByTimeAsync(50)
      await rejected
      expect(attempt.getSnapshot()).toEqual({ phase: 'failed', settled: false, cleanup: 'pending' })
      response.resolve(new Response(new ReadableStream({ cancel })))
      await attempt.settled
      expect(attempt.getSnapshot()).toEqual({ phase: 'failed', settled: true, cleanup: 'confirmed' })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(decode).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized and malformed bootstrap data before the owner decoder', async () => {
    const decode = vi.fn()
    for (const body of ['x'.repeat(65), 'not-json']) {
      const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: async () => new Response(body), decode }, new AbortController().signal)
      await expect(attempt.result).rejects.toBeInstanceOf(ClientFailure)
      await attempt.settled
      expect(attempt.getSnapshot()).toEqual({ phase: 'failed', settled: true, cleanup: 'confirmed' })
    }
    expect(decode).not.toHaveBeenCalled()
  })

  it('wraps a non-Error page abort reason with its original cause while cancelling the read', async () => {
    const abort = new AbortController()
    const reason = { pageEnded: true }
    const reading = Promise.withResolvers<undefined>()
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined) }, cancel: cancelled })
    const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: async () => new Response(body), decode: value => value }, abort.signal)
    const rejected = expect(attempt.result).rejects.toMatchObject({ name: 'ClientFailure', code: 'closed', cause: reason })
    await reading.promise
    abort.abort(reason)
    await rejected
    await attempt.settled
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(attempt.getSnapshot()).toEqual({ phase: 'cancelled', settled: true, cleanup: 'confirmed' })
  })

  it('preserves an existing Error identity when the page was already aborted', async () => {
    const abort = new AbortController()
    const reason = new Error('page ended')
    abort.abort(reason)
    const fetcher = vi.fn(async () => Response.json({ ignored: true }))
    const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: fetcher, decode: value => value }, abort.signal)
    await expect(attempt.result).rejects.toBe(reason)
    await attempt.settled
    expect(fetcher).not.toHaveBeenCalled()
    expect(attempt.getSnapshot()).toEqual({ phase: 'cancelled', settled: true, cleanup: 'confirmed' })
  })

  it('retains a non-Error reason as cause when bootstrap is aborted before fetch', async () => {
    const abort = new AbortController()
    const reason = { pageEnded: true }
    abort.abort(reason)
    const fetcher = vi.fn(async () => Response.json({ ignored: true }))
    const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: fetcher, decode: value => value }, abort.signal)
    await expect(attempt.result).rejects.toMatchObject({ name: 'ClientFailure', code: 'closed', cause: reason })
    await attempt.settled
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retains a non-Error decoder failure as cause without reporting cancellation', async () => {
    const reason = { ownerDecoderRejected: true }
    const attempt = new BootstrapAttempt({
      baseUrl: 'https://example.test/app/', config, fetch: async () => Response.json({ ownerInput: true }),
      decode: () => { throw reason },
    }, new AbortController().signal)
    await expect(attempt.result).rejects.toMatchObject({ name: 'ClientFailure', code: 'bootstrap-rejected', cause: reason })
    await attempt.settled
    expect(attempt.getSnapshot()).toEqual({ phase: 'failed', settled: true, cleanup: 'confirmed' })
  })

  it.each([401, 503])('does not decode a rejected HTTP %s or retry it', async (status) => {
    const fetcher = vi.fn(async () => new Response('unavailable', { status }))
    const decode = vi.fn()
    const attempt = new BootstrapAttempt({ baseUrl: 'https://example.test/app/', config, fetch: fetcher, decode }, new AbortController().signal)
    await expect(attempt.result).rejects.toMatchObject({ code: status === 401 ? 'unauthenticated' : 'bootstrap-rejected' })
    await attempt.settled
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(decode).not.toHaveBeenCalled()
  })

  it('keeps failed body cancellation distinct from a settled bootstrap promise', async () => {
    const attempt = new BootstrapAttempt({
      baseUrl: 'https://example.test/app/', config,
      fetch: async () => new Response(new ReadableStream({ cancel() { throw new Error('cancel rejected') } }), { status: 401 }),
      decode: value => value,
    }, new AbortController().signal)
    await expect(attempt.result).rejects.toMatchObject({ code: 'close-unconfirmed' })
    await attempt.settled
    expect(attempt.getSnapshot()).toEqual({ phase: 'failed', settled: true, cleanup: 'unconfirmed' })
  })
})
