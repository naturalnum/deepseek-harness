/** Native envelope reuse, captured binding, and observable carrier shutdown. */
import { Context } from '@deepseek-ai/cordis'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle, ConnectionWebSocket, RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { BoundTransport, type BoundTransportInput } from '../src/client/transport.ts'
import { ClientFailure } from '../src/client/errors.ts'

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

describe('captured native carrier', () => {
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
