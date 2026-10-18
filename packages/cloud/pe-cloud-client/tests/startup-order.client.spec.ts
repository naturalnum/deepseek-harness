/** Native carrier capture order and old-page requests with controlled identity inputs. */
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle, ConnectionWebSocket, RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import {
  assertExpectedAccount, assertExpectedGeneration, parseRequestExpectation, RequestBindingError,
} from '@deepseek-ai/dsh-pe-cloud-access/schema'
import type { AuthenticatedPrincipal, RequestBindingFailure } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundTransport } from '../src/client/transport.ts'

class Socket implements ConnectionWebSocket {
  private readonly listeners = new Map<object, () => void>()
  url: string | undefined
  readyState = 1
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    for (const listener of [...this.listeners.values()]) listener()
  })
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'close') this.listeners.set(listener, () => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = (_event, listener) => {
    this.listeners.delete(listener)
  }
}

const fields = {
  accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation',
  accountQuery: 'peAccount', generationQuery: 'peGeneration',
}
const idA = 'a' as AuthenticatedPrincipal['accountId']
const idB = 'b' as AuthenticatedPrincipal['accountId']
const genA = 'a-generation' as Parameters<typeof assertExpectedGeneration>[1]
const genB = 'b-generation' as Parameters<typeof assertExpectedGeneration>[1]
const requestId = 'ordering-fixture' as RequestBindingFailure['requestId']

function carrier(accountId: string, connectionGeneration: string, fetch: RpcFetch, socket?: Socket): BoundTransport {
  return new BoundTransport({
    baseUrl: 'https://example.test/app/', expectation: { accountId, connectionGeneration }, fields, fetch,
    createWebSocket: (url) => {
      const opened = socket ?? new Socket()
      opened.url = url
      return opened
    },
    limits: { maxPendingFetches: 4, maxSockets: 2, maxErrorResponseBytes: 512, closeTimeoutMs: 100 },
  })
}

function connection(): { ctx: Context; handle: ConnectionHandle } {
  const ctx = new Context()
  applyConnection(ctx)
  return { ctx, handle: ctx.get('connection') as ConnectionHandle }
}

function accepted(init: RequestInit): Response {
  if (typeof init.body !== 'string') throw new TypeError('native RPC fixture requires a JSON string body')
  const envelope = JSON.parse(init.body) as Record<string, unknown>
  return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: 'accepted' } })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('native connection startup ordering', () => {
  it('captures preinstalled hooks before the first native HTTP and WS operation', async () => {
    const seen: Headers[] = []
    const socket = new Socket()
    const transport = carrier(idA, genA, async (_url, init) => {
      seen.push(new Headers(init.headers))
      return accepted(init)
    }, socket)
    const sockets = vi.fn(transport.hooks.createWebSocket)
    vi.stubGlobal('__DSH_TRANSPORT__', { ...transport.hooks, createWebSocket: sockets })
    const native = connection()
    try {
      expect(await native.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })).toEqual({ ok: true, value: 'accepted' })
      native.handle.openWebSocket('/api/remote.mux')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.get(fields.accountHeader)).toBe(idA)
      expect(seen[0]!.get(fields.generationHeader)).toBe(genA)
      // The factory receives the native URL, then the captured carrier adds its access query.
      expect(sockets).toHaveBeenCalledWith('wss://example.test/app/api/remote.mux')
      expect(socket.url).toBe('wss://example.test/app/api/remote.mux?peAccount=a&peGeneration=a-generation')
      expect(transport.navigationUrl('api/session.export')).toContain('peAccount=a&peGeneration=a-generation')
    } finally {
      await transport.close()
      await native.ctx.fiber.dispose()
    }
  })

  it('reproduces unbound requests when hooks are installed after native Connection apply', async () => {
    const seen: Headers[] = []
    const rawUrls: string[] = []
    const rawSockets: Socket[] = []
    const lateFetch = vi.fn(async (_url: string | URL, init: RequestInit) => accepted(init))
    const late = carrier(idA, genA, lateFetch)
    vi.stubGlobal('__DSH_TRANSPORT__', undefined)
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' })
    vi.stubGlobal('fetch', async (_url: string | URL, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return accepted(init)
    })
    vi.stubGlobal('WebSocket', class extends Socket {
      constructor(url: string) {
        super()
        rawUrls.push(url)
        rawSockets.push(this)
      }
    })
    const native = connection()
    try {
      await native.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })
      native.handle.openWebSocket('/api/remote.mux')
      vi.stubGlobal('__DSH_TRANSPORT__', late.hooks)
      await native.handle.rpc.call('/api', 'session/cancel', { sessionId: 'same-name' })
      native.handle.openWebSocket('/api/remote.mux')
      expect(seen).toHaveLength(2)
      expect(seen.every(headers => !headers.has(fields.accountHeader) && !headers.has(fields.generationHeader))).toBe(true)
      expect(rawUrls).toEqual(['wss://example.test/app/api/remote.mux', 'wss://example.test/app/api/remote.mux'])
      expect(lateFetch).not.toHaveBeenCalled()
    } finally {
      for (const socket of rawSockets) socket.close()
      await late.close()
      await native.ctx.fiber.dispose()
    }
  })

  it('does not retarget an A Connection after the page hook object is replaced with B', async () => {
    const observed: string[] = []
    const fetch: RpcFetch = async (_url, init) => {
      observed.push(new Headers(init.headers).get(fields.accountHeader)!)
      return accepted(init)
    }
    const socketA = new Socket()
    const socketB = new Socket()
    const a = carrier(idA, genA, fetch, socketA)
    const b = carrier(idB, genB, fetch, socketB)
    vi.stubGlobal('__DSH_TRANSPORT__', a.hooks)
    const nativeA = connection()
    vi.stubGlobal('__DSH_TRANSPORT__', b.hooks)
    const nativeB = connection()
    try {
      await nativeA.handle.rpc.call('/api', 'session/cancel', { sessionId: 'same-name' })
      await nativeB.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })
      nativeA.handle.openWebSocket('/api/remote.mux')
      nativeB.handle.openWebSocket('/api/remote.mux')
      expect(observed).toEqual([idA, idB])
      expect(socketA.url).toContain('peAccount=a&peGeneration=a-generation')
      expect(socketB.url).toContain('peAccount=b&peGeneration=b-generation')
    } finally {
      await Promise.all([a.close(), b.close()])
      await Promise.all([nativeA.ctx.fiber.dispose(), nativeB.ctx.fiber.dispose()])
    }
  })

  it('shows why disposing a Context alone does not revoke a retained low-level RPC handle', async () => {
    const fetch = vi.fn(async (_url: string | URL, init: RequestInit) => accepted(init))
    const transport = carrier(idA, genA, fetch)
    vi.stubGlobal('__DSH_TRANSPORT__', transport.hooks)
    const native = connection()
    await native.ctx.fiber.dispose()
    try {
      expect(await native.handle.rpc.call('/api', 'session/cancel', { sessionId: 'same-name' })).toMatchObject({ ok: true })
      expect(fetch).toHaveBeenCalledTimes(1)
      await transport.close()
      await expect(native.handle.rpc.call('/api', 'session/cancel', { sessionId: 'same-name' })).rejects.toMatchObject({ code: 'closed' })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await transport.close()
    }
  })

  it('reproduces mixed HTTP/WS bindings if the installed hook object is mutated in place', async () => {
    const seen: string[] = []
    const fetch: RpcFetch = async (_url, init) => {
      seen.push(new Headers(init.headers).get(fields.accountHeader)!)
      return accepted(init)
    }
    const socketB = new Socket()
    const a = carrier(idA, genA, fetch)
    const b = carrier(idB, genB, fetch, socketB)
    expect(Object.isFrozen(a.hooks)).toBe(true)
    // A mutable copy demonstrates native capture semantics; production must retain the frozen object.
    const installed = { ...a.hooks }
    vi.stubGlobal('__DSH_TRANSPORT__', installed)
    const native = connection()
    try {
      installed.fetch = b.hooks.fetch!
      installed.createWebSocket = b.hooks.createWebSocket!
      await native.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })
      native.handle.openWebSocket('/api/remote.mux')
      expect(seen).toEqual([idA])
      expect(socketB.url).toContain('peAccount=b&peGeneration=b-generation')
    } finally {
      await Promise.all([a.close(), b.close()])
      await native.ctx.fiber.dispose()
    }
  })
})

describe('old-page operation ordering', () => {
  it.each([
    { label: 'another authenticated account', nextPrincipal: idB, nextGeneration: genB },
    { label: 'the same account with a new generation', nextPrincipal: idA, nextGeneration: genB },
  ])('rejects the old request without notification when the guard sees $label', async ({ nextPrincipal, nextGeneration }) => {
    // The fixture uses existing access guards, not an auth database, HTTP router or dispatch preflight.
    let principal = idA
    let generation = genA
    const delegated: string[] = []
    const fetch: RpcFetch = async (_url, init) => {
      const headers = new Headers(init.headers)
      const values = (name: string): string[] => headers.has(name) ? [headers.get(name)!] : []
      const expected = parseRequestExpectation({
        accountIds: values(fields.accountHeader), connectionGenerations: values(fields.generationHeader),
      }, requestId)
      try {
        assertExpectedAccount(expected, principal, requestId)
        assertExpectedGeneration(expected, generation, requestId)
      } catch (error) {
        if (!(error instanceof RequestBindingError)) throw error
        return Response.json(error.toJSON(), { status: error.status })
      }
      delegated.push(principal)
      return accepted(init)
    }
    const a = carrier(idA, genA, fetch)
    const b = carrier(nextPrincipal, nextGeneration, fetch)
    vi.stubGlobal('__DSH_TRANSPORT__', a.hooks)
    const nativeA = connection()
    vi.stubGlobal('__DSH_TRANSPORT__', b.hooks)
    const nativeB = connection()
    try {
      principal = nextPrincipal
      generation = nextGeneration
      await expect(nativeA.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })).rejects.toMatchObject({ code: 'stale-generation' })
      expect(delegated).toEqual([])
      expect(await nativeB.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })).toMatchObject({ ok: true })
      expect(delegated).toEqual([nextPrincipal])
    } finally {
      await Promise.all([a.close(), b.close()])
      await Promise.all([nativeA.ctx.fiber.dispose(), nativeB.ctx.fiber.dispose()])
    }
  })

  it('revokes old HTTP, new WS and reconnect attempts synchronously before a late response settles', async () => {
    const late = Promise.withResolvers<Response>()
    const aSocket = new Socket()
    const aFetch = vi.fn(() => late.promise)
    const a = carrier(idA, genA, aFetch, aSocket)
    const b = carrier(idB, genB, async (_url, init) => accepted(init))
    vi.stubGlobal('__DSH_TRANSPORT__', a.hooks)
    const nativeA = connection()
    vi.stubGlobal('__DSH_TRANSPORT__', b.hooks)
    const nativeB = connection()
    try {
      nativeA.handle.openWebSocket('/api/remote.mux')
      const pending = nativeA.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'closed' })
      const closing = a.close()
      await expect(nativeA.handle.rpc.call('/api', 'session/cancel', { sessionId: 'same-name' })).rejects.toMatchObject({ code: 'closed' })
      expect(() => nativeA.handle.openWebSocket('/api/remote.mux')).toThrow()
      expect(aSocket.close).toHaveBeenCalledTimes(1)
      expect(a.getSnapshot()).toMatchObject({ phase: 'closing', pendingFetches: 1, sockets: 0 })
      expect(await nativeB.handle.rpc.call('/api', 'session/prompt', { sessionId: 'same-name' })).toMatchObject({ ok: true })
      late.resolve(new Response('old account response'))
      await rejected
      await closing
      expect(aFetch).toHaveBeenCalledTimes(1)
      expect(a.getSnapshot()).toMatchObject({ phase: 'closed', pendingFetches: 0 })
    } finally {
      late.resolve(new Response('teardown'))
      await Promise.all([a.close(), b.close()])
      await Promise.all([nativeA.ctx.fiber.dispose(), nativeB.ctx.fiber.dispose()])
    }
  })
})
