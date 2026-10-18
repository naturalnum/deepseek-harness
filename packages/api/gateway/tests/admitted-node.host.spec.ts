/** External carriers retain native HTTP envelopes, Peer identity and stream cleanup. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway, { type NodeStreamTransport, type NodeStreamTransportOptions } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, type RemoteStreamServerMessage } from '../src/stream-protocol.ts'
import OperatorConnectFixture from './operator-connect-fixture.ts'

interface Host {
  readonly ctx: Context
  readonly root: string
  readonly server: Server
  readonly origin: string
  readonly peer: Connection.PeerScope
  readonly transport: NodeStreamTransport
  readonly fixture: OperatorConnectFixture
  expectedCloseFailure?: Error
}

const hosts: Host[] = []
const clients: WebSocket[] = []
class AdmissionRefusal extends Error {}

afterEach(async () => {
  for (const host of hosts) host.fixture.streamCleanup.resolve(undefined)
  for (const client of clients.splice(0)) client.terminate()
  for (const host of hosts.splice(0)) {
    const closed = await Promise.allSettled([host.transport.close()])
    await host.ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => {
      host.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
      host.server.closeAllConnections()
    })
    await rm(host.root, { recursive: true, force: true })
    const result = closed[0]
    if (result.status === 'rejected') expect(result.reason).toBe(host.expectedCloseFailure)
  }
})

describe('externally admitted native carriers through Loader composition', () => {
  it('rechecks admission after a delayed real HTTP body and before the native RPC handler', async () => {
    const entered = Promise.withResolvers<undefined>()
    const dispatches: Connection.ConnectionDispatch[] = []
    let allowed = true
    const refusal = new AdmissionRefusal('fixture admission ended')
    const host = await boot(() => {}, (dispatch) => {
      dispatches.push(dispatch)
      if (!allowed) throw refusal
    }, () => { entered.resolve(undefined) })
    const body = JSON.stringify({ type: 'client-request', rpcId: 'late', method: 'fixture/identity', payload: { args: { label: 'late' } } })
    const pending = Promise.withResolvers<{ status: number | undefined; text: string }>()
    const request = httpRequest(`${host.origin}/api/fixture/identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, (response) => {
      void (async () => {
        response.setEncoding('utf8')
        let text = ''
        for await (const chunk of response) {
          const part: unknown = chunk
          if (typeof part !== 'string') throw new Error('fixture response was not decoded text')
          text += part
        }
        pending.resolve({ status: response.statusCode, text })
      })().catch(pending.reject)
    })
    request.on('error', pending.reject)
    const half = Math.floor(body.length / 2)
    request.write(body.slice(0, half))
    try {
      await entered.promise
      expect(dispatches).toEqual([])
      expect(host.fixture.calls.size).toBe(0)
      allowed = false
      request.end(body.slice(half))
      expect(await pending.promise).toEqual({ status: 409, text: 'fixture admission ended' })
      expect(dispatches).toEqual([{ kind: 'rpc', endpoint: 'fixture/identity' }])
      expect(host.fixture.calls.size).toBe(0)
    } finally { request.destroy(); await Promise.allSettled([pending.promise]) }
  })

  it('guards the actual exact Fetch target instead of accepting its shadowed RPC name', async () => {
    const dispatches: Connection.ConnectionDispatch[] = []
    const host = await boot(() => {}, (dispatch) => {
      dispatches.push(dispatch)
      if (dispatch.kind === 'fetch') throw new AdmissionRefusal('fixture Fetch not admitted')
    })
    const fetched = vi.fn(async () => new Response('must not run'))
    const dispose = host.ctx.connection.fetch.register({
      path: '/api/fixture/identity', methods: ['POST'], requestBody: 'buffered', fetch: fetched,
    })
    const request = () => fetch(`${host.origin}/api/fixture/identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'shadow', method: 'fixture/identity', payload: { args: { label: 'actual' } } }),
    })
    try {
      const denied = await request()
      expect(denied.status).toBe(409)
      expect(await denied.text()).toBe('fixture Fetch not admitted')
      expect(fetched).not.toHaveBeenCalled()
      expect(host.fixture.calls.size).toBe(0)
      await dispose()
      const allowed = await request()
      expect(await allowed.json()).toMatchObject({ result: { ok: true, value: { peerId: host.peer.id } } })
      expect(dispatches).toEqual([
        { kind: 'fetch', method: 'POST', pathname: '/api/fixture/identity' },
        { kind: 'rpc', endpoint: 'fixture/identity' },
      ])
    } finally { await dispose() }
  })

  it('validates the native envelope before invoking final admission', async () => {
    const guard = vi.fn()
    const host = await boot(() => {}, guard)
    const response = await fetch(`${host.origin}/api/fixture/identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'mismatch', method: 'fixture/hold', payload: { args: {} } }),
    })
    expect(await response.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/bad-request' } } })
    expect(guard).not.toHaveBeenCalled()
    expect(host.fixture.calls.size).toBe(0)
  })

  it('shares a fixed Peer across HTTP and WS, rechecks each stream and preserves native envelopes and body limits', async () => {
    let allowed = true
    const checks: string[] = []
    const host = await boot((endpoint) => {
      checks.push(endpoint)
      if (!allowed) throw new Error('external admission closed')
    })
    expect(host.ctx.get('webServer')).toBeUndefined()
    const rpc = (endpoint: string, method = endpoint, payload: object = { args: { label: 'http' } }) => fetch(`${host.origin}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'external-http', method, payload }),
    })
    const response = await rpc('fixture/identity')
    expect(await response.json()).toMatchObject({
      type: 'server-response', rpcId: 'external-http', result: { ok: true, value: { peerId: host.peer.id } },
    })
    expect(host.ctx.operatorConnectFixture.calls.get('http')?.peer).toBe(host.peer)
    const mismatch = await rpc('fixture/identity', 'fixture/hold')
    expect(await mismatch.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/bad-request' } } })
    const oversized = await rpc('fixture/identity', 'fixture/identity', { args: { label: 'x'.repeat(2048) } })
    expect(oversized.status).toBe(413)
    await oversized.text()
    expect(host.ctx.operatorConnectFixture.calls.size).toBe(1)

    const { socket, frames } = await connect(host)
    open(socket, 'first', 'fixture/follow', 'first')
    await vi.waitFor(() => { expect(frames).toContainEqual({ type: 'item', streamId: 'first', value: 'first:ready' }) })
    expect(host.ctx.operatorConnectFixture.calls.get('first')?.peer).toBe(host.peer)
    allowed = false
    open(socket, 'refused', 'fixture/follow', 'refused')
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'error' && frame.streamId === 'refused')).toBe(true) })
    expect(host.ctx.operatorConnectFixture.calls.has('refused')).toBe(false)
    expect(checks).toEqual(['fixture/follow', 'fixture/follow'])
    allowed = true
    open(socket, 'later', 'fixture/follow', 'later')
    await vi.waitFor(() => { expect(host.ctx.operatorConnectFixture.calls.has('later')).toBe(true) })
    expect(checks).toHaveLength(3)
    socket.send(JSON.stringify({ type: 'cancel', streamId: 'first' }))
    await vi.waitFor(() => { expect(host.ctx.operatorConnectFixture.calls.get('first')?.finished).toBe(true) })
    expect(host.ctx.operatorConnectFixture.calls.get('later')?.finished).toBe(false)
    const closed = once(socket, 'close')
    await host.peer.dispose()
    await closed
    await vi.waitFor(() => { expect(host.ctx.operatorConnectFixture.calls.get('later')?.finished).toBe(true) })
  })

  it('keeps close pending through iterator cleanup and withdraws the transport effect', async () => {
    const host = await boot(() => {})
    const fixture = host.fixture
    fixture.delayStreamCleanup = true
    const { socket, frames } = await connect(host)
    open(socket, 'slow', 'fixture/follow', 'slow')
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'item')).toBe(true) })
    const closed = once(socket, 'close')
    const stopping = host.transport.close()
    expect(host.transport.close()).toBe(stopping)
    let settled = false
    void stopping.then(() => { settled = true })
    await closed
    await vi.waitFor(() => { expect(fixture.calls.get('slow')?.signal.aborted).toBe(true) })
    expect(settled).toBe(false)
    expect(fixture.calls.get('slow')?.finished).toBe(false)
    fixture.streamCleanup.resolve(undefined)
    await stopping
    expect(fixture.calls.get('slow')?.finished).toBe(true)
    await vi.waitFor(() => {
      expect(host.ctx.fiber.getEffects().some(effect => effect.label === 'api-gateway: admitted Node stream transport')).toBe(false)
    })
    await host.ctx.fiber.dispose()
    await expect(host.transport.close()).resolves.toBeUndefined()
  })

  it('closes a transport with its calling plugin while keeping the Gateway available', async () => {
    const host = await boot(() => {})
    const owned = Promise.withResolvers<NodeStreamTransport>()
    const owner = await host.ctx.plugin((ctx) => {
      owned.resolve(gateway(ctx).createNodeStreamTransport(host.peer, () => {}))
    })
    const transport = await owned.promise
    await owner.dispose()
    await expect(transport.close()).resolves.toBeUndefined()
    const replacement = gateway(host.ctx).createNodeStreamTransport(host.peer, () => {})
    await replacement.close()
    expect(host.ctx.get('typertGateway')).toBeDefined()
  })
})

describe('externally owned native WS resources', () => {
  it('refuses capacity before business dispatch and holds the admitted slot through actual cleanup', async () => {
    const owner = streamOwner(1)
    const guard = vi.fn()
    const host = await boot(guard, undefined, undefined, owner.options)
    host.fixture.delayStreamCleanup = true
    const { socket, frames } = await connect(host)
    open(socket, 'held', 'fixture/follow', 'held')
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'item')).toBe(true) })
    const closed = once(socket, 'close')
    open(socket, 'refused', 'fixture/follow', 'refused')
    await closed
    expect(owner.acquire).toHaveBeenCalledTimes(2)
    expect(guard).toHaveBeenCalledOnce()
    expect(host.fixture.calls.has('refused')).toBe(false)
    expect(frames.some(frame => frame.streamId === 'refused')).toBe(false)
    expect(owner.held()).toBe(1)
    expect(owner.settlements).toEqual([])
    host.fixture.streamCleanup.resolve(undefined)
    await vi.waitFor(() => { expect(owner.held()).toBe(0) })
    expect(owner.settlements).toEqual(['confirmed'])
  })

  it('enforces ws maxPayload before a fragmented oversized open reaches resource admission', async () => {
    const owner = streamOwner(1)
    const guard = vi.fn()
    const host = await boot(guard, undefined, undefined, { ...owner.options, maxFrameBytes: 128 })
    const { socket } = await connect(host)
    const closed = once(socket, 'close')
    const message = JSON.stringify({ type: 'open', streamId: 'large', endpoint: 'fixture/follow', payload: { args: { label: 'x'.repeat(256) } } })
    socket.send(message.slice(0, 100), { fin: false })
    socket.send(message.slice(100), { fin: true })
    expect((await closed)[0]).toBe(1009)
    expect(owner.acquire).not.toHaveBeenCalled()
    expect(guard).not.toHaveBeenCalled()
    expect(host.fixture.calls.size).toBe(0)
  })

  it('confirms business refusal and normal cancellation once, with cancellation retaining pending cleanup', async () => {
    const owner = streamOwner(1)
    let allowed = false
    const host = await boot(() => { if (!allowed) throw new Error('Business refusal.') }, undefined, undefined, owner.options)
    const { socket, frames } = await connect(host)
    open(socket, 'business', 'fixture/follow', 'business')
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'error')).toBe(true) })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(owner.settlements).toEqual(['confirmed'])
    expect(owner.held()).toBe(0)
    expect(host.fixture.calls.size).toBe(0)
    allowed = true
    host.fixture.delayStreamCleanup = true
    open(socket, 'cancel', 'fixture/follow', 'cancel')
    await vi.waitFor(() => { expect(host.fixture.calls.has('cancel')).toBe(true) })
    socket.send(JSON.stringify({ type: 'cancel', streamId: 'cancel' }))
    await vi.waitFor(() => { expect(host.fixture.calls.get('cancel')?.signal.aborted).toBe(true) })
    expect(owner.held()).toBe(1)
    expect(owner.settlements).toHaveLength(1)
    host.fixture.streamCleanup.resolve(undefined)
    await vi.waitFor(() => { expect(owner.settlements).toEqual(['confirmed', 'confirmed']) })
    expect(owner.held()).toBe(0)
  })

  it('reports unknown for a real Gateway pending next finally failure that a subsequent return cannot expose', async () => {
    const owner = streamOwner(1)
    const host = await boot(() => {}, undefined, undefined, owner.options)
    const reading = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('Underlying pending next cleanup failed.')
    host.expectedCloseFailure = failure
    vi.spyOn(host.fixture, 'follow').mockImplementation(async function *(_label, signal) {
      try { yield 'ready'; reading.resolve(undefined); await waitForCancellation(signal) }
      finally { await release.promise; throw failure }
    })
    const { socket } = await connect(host)
    open(socket, 'failure', 'fixture/follow', 'failure')
    await reading.promise
    socket.send(JSON.stringify({ type: 'cancel', streamId: 'failure' }))
    try {
      expect(owner.held()).toBe(1)
      expect(owner.settlements).toEqual([])
      release.resolve(undefined)
      await vi.waitFor(() => { expect(owner.settlements).toEqual(['unknown']) })
      expect(owner.held()).toBe(1)
      const stopping = host.transport.close()
      expect(host.transport.close()).toBe(stopping)
      await expect(stopping).rejects.toBe(failure)
      expect(owner.settlements).toHaveLength(1)
    } finally { release.resolve(undefined) }
  })

  it('still returns the underlying downlink when actual decoder return cleanup fails', async () => {
    const owner = streamOwner(1)
    const host = await boot(() => {}, undefined, undefined, owner.options)
    const failure = new Error('Actual decoder return failed.')
    host.expectedCloseFailure = failure
    const returned = vi.fn()
    vi.spyOn(host.fixture, 'follow').mockImplementation(function (this: OperatorConnectFixture, _label, signal) {
      const invocation = this.ctx.invocation
      if (invocation === undefined) throw new Error('Missing actual Gateway invocation.')
      const decoder = invocation.uplink()[Symbol.asyncIterator]()
      if (decoder.return === undefined) throw new Error('Missing actual decoder return.')
      const actual = decoder.return.bind(decoder)
      vi.spyOn(decoder, 'return').mockImplementation(async () => { await actual(); throw failure })
      let first = true
      return { [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (first) { first = false; return { done: false, value: 'ready' } }
          await waitForCancellation(signal)
          return { done: true, value: undefined }
        },
        return: async () => { returned(); return { done: true, value: undefined } },
      }) }
    })
    const { socket, frames } = await connect(host)
    open(socket, 'decoder', 'fixture/follow', 'decoder')
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'item')).toBe(true) })
    socket.send(JSON.stringify({ type: 'cancel', streamId: 'decoder' }))
    await vi.waitFor(() => { expect(owner.settlements).toEqual(['unknown']) })
    expect(returned).toHaveBeenCalledOnce()
    expect(owner.held()).toBe(1)
    await expect(host.transport.close()).rejects.toBe(failure)
  })

  it('joins an actual uplink read lost to interruption before reporting its late cleanup rejection', async () => {
    const host = await boot(() => {})
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('Actual uplink pending read cleanup failed.')
    vi.spyOn(host.fixture, 'follow').mockImplementation(async function *(this: OperatorConnectFixture) {
      const invocation = this.ctx.invocation
      if (invocation === undefined) throw new Error('Missing actual Gateway invocation.')
      for await (const value of invocation.uplink()) yield String(value)
    })
    const cancel = new AbortController()
    const source = await gateway(host.ctx).stream({
      namespace: 'fixture', method: 'follow', args: { label: 'uplink' }, peer: host.peer, signal: cancel.signal,
      uplink: (async function *(): AsyncIterable<unknown> {
        try { entered.resolve(undefined); await release.promise } finally { throw failure }
      })(),
    })
    const iterator = source[Symbol.asyncIterator]()
    const next = iterator.next()
    const rejected = expect(next).rejects.toMatchObject({ cause: failure })
    try {
      await entered.promise
      cancel.abort()
      let settled = false
      void next.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      release.resolve(undefined)
      await rejected
      await iterator.return?.()
    } finally { release.resolve(undefined); await Promise.allSettled([next]) }
  })
})

function streamOwner(limit: number) {
  let held = 0
  const settlements: Array<'confirmed' | 'unknown'> = []
  const acquire = vi.fn((_endpoint: string) => {
    if (held >= limit) throw new Error('Native stream resource limit reached.')
    held++
    return (status: 'confirmed' | 'unknown'): void => {
      settlements.push(status)
      if (status === 'confirmed') held--
    }
  })
  return { held: () => held, settlements, acquire, options: { maxFrameBytes: 1_024, acquireStream: acquire } }
}

function waitForCancellation(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function boot(
  beforeOpen: (endpoint: string) => void,
  beforeDispatch?: Connection.ConnectionDispatchGuard,
  incomingBody?: () => void,
  options?: NodeStreamTransportOptions,
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admitted-node-'))
  const configPath = join(root, 'cordis.yml')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const rows = [
    { name: 'credentials', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: 'connection' }, { name: 'typert' }, { name: 'remote-access' }, { name: 'gateway' }, { name: 'fixture' },
  ]
  await writeFile(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  let server: Server | undefined
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, credentials: LocalCredentials, connection: Connection,
      typert: TypertRegistry, 'remote-access': RemoteAccess, gateway: TypertGateway, fixture: OperatorConnectFixture,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const connection = ctx.connection
    if (!(connection instanceof Connection.HostConnectionService)) throw new Error('native Host Connection is unavailable')
    const peer = connection.createPeer({ principal: { kind: 'owner' } })
    const transport = gateway(ctx).createNodeStreamTransport(peer, beforeOpen, options)
    server = createServer((request, response) => {
      if (incomingBody !== undefined) request.once('data', incomingBody)
      void connection.handleNodeRequest(request, response, peer, 1024, beforeDispatch).catch((error: unknown) => {
        if (error instanceof AdmissionRefusal) {
          response.writeHead(409)
          response.end(error.message)
        } else response.destroy(error instanceof Error ? error : undefined)
      })
    })
    server.on('upgrade', (request, socket, head) => { transport.handleUpgrade(request, socket, head) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('external carrier has no TCP address')
    const host = { ctx, root, server, origin: `http://127.0.0.1:${address.port}`, peer, transport, fixture: ctx.operatorConnectFixture }
    hosts.push(host)
    return host
  } catch (error) {
    await ctx.fiber.dispose()
    server?.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function connect(host: Host): Promise<{ socket: WebSocket; frames: RemoteStreamServerMessage[] }> {
  const socket = new WebSocket(host.origin.replace('http:', 'ws:') + '/api/remote.mux')
  clients.push(socket)
  const frames: RemoteStreamServerMessage[] = []
  socket.on('message', (data) => {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')
    frames.push(parseRemoteStreamServerMessage(text))
  })
  await once(socket, 'open')
  return { socket, frames }
}

function open(socket: WebSocket, streamId: string, endpoint: string, label: string): void {
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: { label } } }))
}

function gateway(ctx: Context): TypertGateway {
  const service = ctx.get('typertGateway')
  if (!(service instanceof TypertGateway)) throw new Error('native Host Gateway is unavailable')
  return service
}
