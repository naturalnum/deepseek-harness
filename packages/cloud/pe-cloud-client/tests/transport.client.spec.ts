/** Native envelope reuse, captured binding, and observable carrier shutdown. */
import { Context } from '@deepseek-ai/cordis'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle, ConnectionWebSocket, RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { BoundTransport, type BoundTransportInput } from '../src/client/transport.ts'
import { ClientFailure } from '../src/client/errors.ts'
import { BootstrapAttempt } from '../src/client/bootstrap.ts'

class Socket implements ConnectionWebSocket {
  private readonly listeners = new Map<object, () => void>()
  readyState = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 2 })
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'close') this.listeners.set(listener, () => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = (_event, listener) => {
    this.listeners.delete(listener)
  }
  finish(): void {
    this.readyState = 3
    for (const listener of [...this.listeners.values()]) listener()
  }
}

function input(fetch: RpcFetch, overrides: Partial<BoundTransportInput> = {}): BoundTransportInput {
  return {
    baseUrl: 'https://example.test/app/',
    expectation: { accountId: 'a', connectionGeneration: 'a-generation' },
    fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    fetch,
    createWebSocket: () => new Socket(),
    limits: { maxPendingFetches: 2, maxSockets: 2, maxErrorResponseBytes: 256, closeTimeoutMs: 100 },
    ...overrides,
  }
}

function identityChecks(fetch: RpcFetch, timeout = 50) {
  const attempts: BootstrapAttempt<void>[] = []
  const revalidate = vi.fn((signal: AbortSignal) => {
    const attempt = new BootstrapAttempt({
      baseUrl: 'https://example.test/app/', fetch,
      config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: timeout, maxBootstrapResponseBytes: 64 },
      decode: () => {},
    }, signal)
    attempts.push(attempt)
    return attempt
  })
  return { attempts, revalidate }
}

describe('captured native carrier', () => {
  it.each(['same identity', 'network failure', 'HTTP 503', 'oversized response'])('keeps captured identity after a WS recheck with %s', async (outcome) => {
    const socket = new Socket(), send = vi.fn(async () => new Response('native'))
    const checks = identityChecks(vi.fn(async () => {
      if (outcome === 'network failure') throw new TypeError('network unavailable')
      if (outcome === 'HTTP 503') return new Response(null, { status: 503 })
      return outcome === 'oversized response' ? new Response('x'.repeat(65)) : Response.json({})
    }))
    const transport = new BoundTransport(input(send, { createWebSocket: () => socket, revalidate: checks.revalidate }))
    transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux')
    socket.finish()
    expect(checks.revalidate).toHaveBeenCalledOnce()
    await checks.attempts[0]!.settled
    expect(transport.getSnapshot()).toMatchObject({ phase: 'open', reason: undefined })
    expect(transport.navigationUrl('api/export')).toContain('peAccount=a&peGeneration=a-generation')
    expect(send).not.toHaveBeenCalled()
    expect(await (await transport.hooks.fetch!('api/x', {})).text()).toBe('native')
    expect(send).toHaveBeenCalledOnce()
    await transport.close()
    expect(checks.revalidate).toHaveBeenCalledOnce()
  })

  it('holds the single recheck slot after timeout until late headers and cancellation actually settle', async () => {
    vi.useFakeTimers()
    const late = Promise.withResolvers<Response>(), cancelled = vi.fn()
    const fetcher = vi.fn<RpcFetch>().mockReturnValueOnce(late.promise).mockResolvedValue(Response.json({}))
    const checks = identityChecks(fetcher)
    const transport = new BoundTransport(input(async () => new Response(), { revalidate: checks.revalidate }))
    const disconnect = (): void => {
      const socket = transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux') as Socket
      socket.finish()
    }
    try {
      disconnect()
      disconnect()
      expect(checks.revalidate).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(50)
      expect(checks.attempts[0]!.getSnapshot()).toMatchObject({ settled: false, cleanup: 'pending' })
      disconnect()
      expect(checks.revalidate).toHaveBeenCalledOnce()
      expect(transport.getSnapshot().phase).toBe('open')
      late.resolve(new Response(new ReadableStream({ cancel: cancelled })))
      await checks.attempts[0]!.settled
      await vi.advanceTimersByTimeAsync(0)
      expect(cancelled).toHaveBeenCalledOnce()
      disconnect()
      expect(checks.revalidate).toHaveBeenCalledTimes(2)
      await checks.attempts[1]!.settled
      await transport.close()
    } finally {
      late.resolve(new Response())
      await transport.close()
      vi.useRealTimers()
    }
  })

  it.each([false, true])('aborts a WS recheck and joins actual late body cancellation (reject=%s)', async (reject) => {
    const late = Promise.withResolvers<Response>(), cancel = Promise.withResolvers<undefined>()
    const cancelling = Promise.withResolvers<undefined>()
    const checks = identityChecks(() => late.promise, 1000)
    const settings = input(async () => new Response(), { revalidate: checks.revalidate })
    settings.limits.closeTimeoutMs = 1000
    const transport = new BoundTransport(settings)
    const socket = transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux') as Socket
    socket.finish()
    const closing = transport.close(), complete = vi.fn()
    void closing.then(complete, complete)
    const outcome = reject ? expect(closing).rejects.toMatchObject({ code: 'close-unconfirmed' }) : closing
    await expect(checks.attempts[0]!.result).rejects.toMatchObject({ code: 'closed' })
    expect(checks.attempts[0]!.getSnapshot().settled).toBe(false)
    late.resolve(new Response(new ReadableStream({ cancel() { cancelling.resolve(undefined); return cancel.promise } })))
    await cancelling.promise
    expect(complete).not.toHaveBeenCalled()
    if (reject) cancel.reject(new Error('actual cancellation rejected'))
    else cancel.resolve(undefined)
    await outcome
    expect(checks.attempts[0]!.getSnapshot()).toMatchObject({ settled: true, cleanup: reject ? 'unconfirmed' : 'confirmed' })
    expect(transport.getSnapshot().phase).toBe(reject ? 'unconfirmed' : 'closed')
    expect(checks.revalidate).toHaveBeenCalledOnce()
  })

  it('keeps recheck cleanup pending after the close deadline until its real carrier settles', async () => {
    vi.useFakeTimers()
    const late = Promise.withResolvers<Response>()
    const checks = identityChecks(() => late.promise, 1000)
    const transport = new BoundTransport(input(async () => new Response(), { revalidate: checks.revalidate }))
    const socket = transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux') as Socket
    socket.finish()
    const closing = transport.close(), rejected = expect(closing).rejects.toMatchObject({ code: 'close-unconfirmed' })
    try {
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(transport.getSnapshot().phase).toBe('unconfirmed')
      expect(checks.attempts[0]!.getSnapshot().settled).toBe(false)
      late.resolve(new Response())
      await checks.attempts[0]!.settled
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.getSnapshot().phase).toBe('closed')
      expect(transport.close()).toBe(closing)
    } finally { late.resolve(new Response()); vi.useRealTimers() }
  })

  it('uses the real native Connection envelope and keeps A binding after caller inputs change', async () => {
    const requests: Array<{ url: string; headers: Headers; envelope: Record<string, unknown> }> = []
    const expectation = { accountId: 'a', connectionGeneration: 'a-generation' }
    const settings = input(async (url, init) => {
      if (typeof init.body !== 'string') throw new TypeError('native RPC fixture requires a JSON string body')
      const envelope = JSON.parse(init.body) as Record<string, unknown>
      requests.push({ url: String(url), headers: new Headers(init.headers), envelope })
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: 'accepted' } })
    }, { expectation })
    const transport = new BoundTransport(settings)
    expectation.accountId = 'b'
    expectation.connectionGeneration = 'b-generation'
    settings.fields.accountHeader = 'x-replaced'
    const ctx = new Context()
    installConnection(ctx, { transport: transport.hooks, interactions: 'none' })
    try {
      const connection = ctx.get('connection') as ConnectionHandle
      expect(await connection.rpc.call('/api', 'session/prompt', { sessionId: 'same-name', content: 'hello' })).toEqual({ ok: true, value: 'accepted' })
      expect(requests).toHaveLength(1)
      const sent = requests[0]!
      expect(sent.url).toBe('https://example.test/app/api/session/prompt')
      expect(sent.headers.get('x-pe-account')).toBe('a')
      expect(sent.headers.get('x-pe-generation')).toBe('a-generation')
      expect(sent.headers.has('x-replaced')).toBe(false)
      expect(sent.envelope).toMatchObject({ type: 'client-request', method: 'session/prompt', payload: { sessionId: 'same-name', content: 'hello' } })
      expect(Object.keys(sent.envelope).sort()).toEqual(['method', 'payload', 'rpcId', 'type'])
    } finally {
      await transport.close()
      await ctx.fiber.dispose()
    }
  })

  it('binds native WS and final navigation independently without overwriting old expectations', async () => {
    const socket = new Socket()
    const factory = vi.fn(() => socket)
    const fetcher = vi.fn(async () => new Response('ok'))
    const transport = new BoundTransport(input(fetcher, { createWebSocket: factory }))
    const returned = transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux')
    expect(returned).toBe(socket)
    expect(factory).toHaveBeenCalledWith('wss://example.test/app/api/remote.mux?peAccount=a&peGeneration=a-generation')
    expect(transport.navigationUrl('api/export?sessionId=s')).toBe('https://example.test/app/api/export?sessionId=s&peAccount=a&peGeneration=a-generation')
    expect(() => transport.navigationUrl('api/export?peAccount=b')).toThrow(ClientFailure)
    expect(() => transport.navigationUrl('api/export?peAccount=a&peAccount=a')).toThrow(ClientFailure)
    expect(() => transport.hooks.fetch!('https://other.test/app/api/x', {})).toThrow(ClientFailure)
    expect(() => transport.hooks.fetch!('api/x', { headers: { 'x-pe-generation': 'old' } })).toThrow(ClientFailure)
    expect(fetcher).not.toHaveBeenCalled()
    const closing = transport.close()
    expect(transport.getSnapshot()).toMatchObject({ phase: 'closing', sockets: 1 })
    expect(() => transport.navigationUrl('api/export')).toThrow(ClientFailure)
    socket.finish()
    await closing
    expect(transport.getSnapshot()).toMatchObject({ phase: 'closed', sockets: 0 })
  })

  it('does not publish a response that arrives after its binding closes', async () => {
    const response = Promise.withResolvers<Response>()
    const cancel = vi.fn()
    const fetcher = vi.fn(() => response.promise)
    const transport = new BoundTransport(input(fetcher))
    const pending = transport.hooks.fetch!('api/x', {})
    const rejected = expect(pending).rejects.toMatchObject({ code: 'closed' })
    const closing = transport.close()
    expect(() => transport.hooks.fetch!('api/x', {})).toThrow(ClientFailure)
    response.resolve(new Response(new ReadableStream({ cancel })))
    await rejected
    await closing
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(transport.getSnapshot()).toMatchObject({ phase: 'closed', pendingFetches: 0 })
  })

  it('stops on stale-generation while preserving other 409 bodies for native consumers', async () => {
    const busy = JSON.stringify({ code: 'cloud/config-busy', retry: 'after-status-check' })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(busy, { status: 409, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ code: 'cloud/stale-generation' }, { status: 409 }))
    const transport = new BoundTransport(input(fetcher))
    const first = await transport.hooks.fetch!('api/config', {})
    expect(first.status).toBe(409)
    expect(await first.text()).toBe(busy)
    expect(transport.getSnapshot().phase).toBe('open')
    await expect(transport.hooks.fetch!('api/x', {})).rejects.toMatchObject({ code: 'stale-generation' })
    await transport.close()
    expect(() => transport.hooks.fetch!('api/x', {})).toThrow(ClientFailure)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects excess pending fetches before contacting the carrier', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn(() => pending.promise)
    const settings = input(fetcher)
    settings.limits.maxPendingFetches = 1
    const transport = new BoundTransport(settings)
    const one = transport.hooks.fetch!('api/x', {})
    expect(() => transport.hooks.fetch!('api/x', {})).toThrow(ClientFailure)
    expect(fetcher).toHaveBeenCalledTimes(1)
    pending.resolve(new Response('ok'))
    await one
    await transport.close()
  })

  it('invalidates A on 401 while an independent B carrier continues', async () => {
    const fetchA = vi.fn(async () => new Response('expired', { status: 401 }))
    const fetchB = vi.fn(async () => new Response('b remains available'))
    const a = new BoundTransport(input(fetchA))
    const b = new BoundTransport(input(fetchB, { expectation: { accountId: 'b', connectionGeneration: 'b-generation' } }))
    await expect(a.hooks.fetch!('api/x', {})).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(() => a.hooks.fetch!('api/x', {})).toThrow(ClientFailure)
    expect(await (await b.hooks.fetch!('api/x', {})).text()).toBe('b remains available')
    expect(fetchA).toHaveBeenCalledTimes(1)
    expect(b.getSnapshot().phase).toBe('open')
    await Promise.all([a.close(), b.close()])
  })

  it('confirms a 401 fetch body already errored by the exact shared abort without calling source cancellation', async () => {
    const cancel = vi.fn()
    const transport = new BoundTransport(input(async (_url, init) => {
      const signal = init.signal
      if (signal == null) throw new Error('Captured fetch signal absent')
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { signal.addEventListener('abort', () => { controller.error(signal.reason) }, { once: true }) },
        cancel,
      }), { status: 401 })
    }))
    await expect(transport.hooks.fetch!('api/x', {})).rejects.toMatchObject({ code: 'unauthenticated' })
    await transport.close()
    expect(cancel).not.toHaveBeenCalled()
    expect(transport.getSnapshot()).toMatchObject({ phase: 'closed', reason: 'unauthenticated', pendingFetches: 0 })
  })

  it('retains a real source cancellation failure even when it equals the shared abort reason', async () => {
    const transport = new BoundTransport(input(async (_url, init) => {
      const signal = init.signal
      if (signal == null) throw new Error('Captured fetch signal absent')
      return new Response(new ReadableStream<Uint8Array>({ cancel() { throw signal.reason } }), { status: 401 })
    }))
    await expect(transport.hooks.fetch!('api/x', {})).rejects.toMatchObject({ code: 'close-unconfirmed' })
    await expect(transport.close()).rejects.toMatchObject({ code: 'close-unconfirmed' })
    expect(transport.getSnapshot()).toMatchObject({ phase: 'unconfirmed', pendingFetches: 0 })
  })

  it('does not turn a rejected body stop into confirmed carrier cleanup', async () => {
    const late = Promise.withResolvers<Response>()
    const transport = new BoundTransport(input(() => late.promise))
    const pending = transport.hooks.fetch!('api/x', {})
    const requestRejected = expect(pending).rejects.toMatchObject({ code: 'close-unconfirmed' })
    const closed = transport.close()
    const closeRejected = expect(closed).rejects.toMatchObject({ code: 'close-unconfirmed' })
    late.resolve(new Response(new ReadableStream({ cancel() { throw new Error('cancel rejected') } })))
    await requestRejected
    await closeRejected
    expect(transport.getSnapshot().phase).toBe('unconfirmed')
  })

  it('bounds native socket creation before a second factory call', async () => {
    const socket = new Socket()
    const factory = vi.fn(() => socket)
    const settings = input(async () => new Response(), { createWebSocket: factory })
    settings.limits.maxSockets = 1
    const transport = new BoundTransport(settings)
    transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux')
    expect(() => transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux')).toThrow(ClientFailure)
    expect(factory).toHaveBeenCalledTimes(1)
    const closing = transport.close()
    socket.finish()
    await closing
  })

  it('keeps missing socket stop acknowledgement unconfirmed after the deadline', async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const transport = new BoundTransport(input(async () => new Response(), { createWebSocket: () => socket }))
    try {
      transport.hooks.createWebSocket!('wss://example.test/app/api/remote.mux')
      const closed = transport.close()
      const rejected = expect(closed).rejects.toMatchObject({ code: 'close-unconfirmed' })
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(transport.getSnapshot()).toMatchObject({ phase: 'unconfirmed', sockets: 1 })
      socket.finish()
      await vi.waitFor(() => { expect(transport.getSnapshot().phase).toBe('closed') })
      expect(transport.close()).toBe(closed)
    } finally {
      socket.finish()
      vi.useRealTimers()
    }
  })
})
