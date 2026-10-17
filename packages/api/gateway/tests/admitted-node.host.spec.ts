/** External carriers retain native HTTP envelopes, Peer identity and stream cleanup. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
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
import TypertGateway, { type NodeStreamTransport } from '@deepseek-ai/dsh-api-gateway'
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
}

const hosts: Host[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  for (const host of hosts) host.fixture.streamCleanup.resolve(undefined)
  for (const client of clients.splice(0)) client.terminate()
  for (const host of hosts.splice(0)) {
    await host.transport.close()
    await host.ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => {
      host.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
      host.server.closeAllConnections()
    })
    await rm(host.root, { recursive: true, force: true })
  }
})

describe('externally admitted native carriers through Loader composition', () => {
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

async function boot(beforeOpen: (endpoint: string) => void): Promise<Host> {
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
    const transport = gateway(ctx).createNodeStreamTransport(peer, beforeOpen)
    server = createServer((request, response) => {
      void connection.handleNodeRequest(request, response, peer, 1024).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined)
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
