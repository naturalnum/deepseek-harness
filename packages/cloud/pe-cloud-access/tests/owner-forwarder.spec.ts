/** Real ephemeral loopback HTTP/WS carriers; no DSH graph, PG or deployment identity evidence. */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest, type ServerOptions as HttpsServerOptions } from 'node:https'
import { connect, createServer as netServer, type Server as NetServer, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { TLSSocket } from 'node:tls'
import { appendFileSync } from 'node:fs'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it } from 'vitest'
import { OwnerForwarder } from '../src/owner-forwarder.ts'
import type { ForwardInput, ForwardLimits, ForwardTransfer, ForwardTlsIdentity } from '../src/forward-types.ts'
import { identityFixture } from './identity-fixture.ts'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { encodeOwnerHop, readOwnerHop, OWNER_HOP_HEADER, type OwnerHop } from '../src/owner-hop.ts'
import { AuthAccessError } from '../src/auth-error.ts'

const limits: ForwardLimits = { maxTargets: 2, maxTargetBytes: 512, maxPathBytes: 2048, maxConcurrent: 2, maxQueued: 2,
  maxConnections: 8, maxHeaderPairs: 40, maxHeaderBytes: 8192, maxHeadBytes: 4096, maxChunkBytes: 4096,
  maxBufferedBytes: 131072, maxPendingBytes: 16 * 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024,
  maxTunnelBytes: 4 * 1024 * 1024, queueTimeoutMs: 1000, connectTimeoutMs: 500, operationTimeoutMs: 2500, closeTimeoutMs: 300 }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function listen(server: Server | NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing ephemeral loopback listener')
  return address.port
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: {
    limits?: Partial<ForwardLimits>
    before?: (input: ForwardInput, transport: OwnerForwarder) => ForwardInput
    assertCurrent?: () => void
    origin?: string
    tls?: HttpsServerOptions
    identity?: ForwardTlsIdentity
  } = {}) {
  const selected = { ...limits, ...options.limits }
  const upSockets = new Set<Socket>(), frontSockets = new Set<Socket>(), clients = new Set<Socket>()
  const controllers: AbortController[] = [], transfers: ForwardTransfer[] = []
  const serverOptions = { maxHeaderSize: selected.maxHeaderBytes, highWaterMark: selected.maxChunkBytes }
  const upstream = options.tls === undefined ? createServer(serverOptions, handler)
    : createHttpsServer({ ...options.tls, ...serverOptions }, handler)
  upstream.maxConnections = selected.maxConnections
  upstream.maxHeadersCount = selected.maxHeaderPairs + 1
  upstream.on('connection', (socket: Socket) => {
    upSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { upSockets.delete(socket) })
  })
  const upstreamPort = await listen(upstream)
  const transport = new OwnerForwarder(selected, [{ id: 'reviewed-owner', origin: options.origin ?? `${options.tls === undefined ? 'http' : 'https'}://127.0.0.1:${upstreamPort}`,
    ...(options.identity === undefined ? {} : { tlsIdentity: options.identity }) }])
  const accept = (input: Omit<ForwardInput, 'target' | 'lifetime'>): void => {
    const controller = new AbortController(); controllers.push(controller)
    const complete = { ...input, target: transport.target('reviewed-owner'),
      lifetime: { signal: controller.signal, assertCurrent: options.assertCurrent ?? (() => {}) } } as ForwardInput
    try { transfers.push(transport.forward(options.before?.(complete, transport) ?? complete)) }
    catch (_error) {
      if (complete.kind === 'http') { complete.response.writeHead(503, { connection: 'close' }); complete.response.end('refused') }
      else complete.socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
  }
  const front = createServer({ maxHeaderSize: selected.maxHeaderBytes, highWaterMark: selected.maxChunkBytes }, (request, response) => {
    accept({ kind: 'http', request, response } as Omit<ForwardInput, 'target' | 'lifetime'>)
  })
  front.maxConnections = selected.maxConnections
  front.maxHeadersCount = selected.maxHeaderPairs + 1
  front.on('upgrade', (request, socket, head) => { accept({ kind: 'upgrade', request, socket, head } as Omit<ForwardInput, 'target' | 'lifetime'>) })
  front.on('checkContinue', (_request, response) => { response.writeHead(417, { connection: 'close' }); response.end() })
  front.on('connection', (socket) => { frontSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { frontSockets.delete(socket) }) })
  const port = await listen(front)
  cleanups.push(async () => {
    for (const controller of controllers) controller.abort()
    const closed = transport.close()
    const fixtureSockets = [...clients, ...frontSockets, ...upSockets]
    const actualCloses = fixtureSockets.map(socket => new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) }))
    for (const socket of fixtureSockets) socket.destroy()
    await Promise.all(actualCloses)
    await closed
    await transport.whenClosed()
    await Promise.all(transfers.map(transfer => transfer.settled))
    await Promise.all([front, upstream].map(server => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })))
    expect(frontSockets.size).toBe(0); expect(upSockets.size).toBe(0)
    expect(transport.observe()).toMatchObject({ active: 0, queued: 0, retained: 0, reservedConnections: 0, reservedBytes: 0 })
  })
  const call = (path = '/opaque', headers: string[] = ['Host', 'public.example.test'], body = Buffer.alloc(0), pauseMs = 0) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: body.length ? 'POST' : 'GET', headers, agent: false })
    request.on('socket', (socket) => { clients.add(socket); socket.once('close', () => { clients.delete(socket) }) })
    const result = new Promise<{ status: number; headers: string[]; body: Buffer }>((resolve, reject) => {
      request.once('error', reject)
      request.once('response', (response) => {
        const chunks: Buffer[] = []
        response.on('error', reject)
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.rawHeaders, body: Buffer.concat(chunks) }) })
        if (pauseMs) { response.pause(); setTimeout(() => { response.resume() }, pauseMs) }
      })
    })
    void result.catch((_error: unknown) => {})
    request.end(body)
    return { request, result }
  }
  return { upstream, upstreamPort, front, port, transport, transfers, controllers, call, frontSockets, upSockets, clients }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Owned loopback condition timed out')
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

it('preserves binary entity bytes and raw end-to-end duplicate headers without selecting a target from Host', async () => {
  let received: { path: string | undefined; headers: string[]; body: Buffer } | undefined
  const f = await fixture((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      received = { path: request.url, headers: request.rawHeaders, body: Buffer.concat(chunks) }
      response.writeHead(201, ['Content-Type', 'application/octet-stream', 'Set-Cookie', 'one=a; HttpOnly', 'Set-Cookie', 'two=b',
        'Connection', 'close, x-up-hop', 'X-Up-Hop', 'remove', 'X-Up-End', 'keep'])
      response.end(received.body)
    })
  })
  const body = Buffer.from([0, 255, 8, 32, 128, 13, 10])
  const result = await f.call('/opaque?q=%2f', ['Host', 'client-selected.invalid', 'Origin', 'https://public.example.test',
    'Cookie', 'login=original', 'X-End', 'first', 'X-End', 'second', 'Connection', 'close, x-hop', 'X-Hop', 'remove'], body).result
  expect(result.status).toBe(201); expect(result.body).toEqual(body)
  expect(received?.path).toBe('/opaque?q=%2f'); expect(received?.body).toEqual(body)
  expect(received?.headers).toEqual(expect.arrayContaining(['Host', 'client-selected.invalid', 'Origin', 'https://public.example.test', 'Cookie', 'login=original']))
  expect(received?.headers.filter(value => value === 'X-End')).toHaveLength(2)
  expect(received?.headers).not.toContain('X-Hop'); expect(result.headers).not.toContain('X-Up-Hop')
  expect(result.headers.filter(value => value.toLowerCase() === 'set-cookie')).toHaveLength(2)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed', upstreamMayHaveReceived: true, upstreamStatus: 201 })
})

it('streams a slow multi-megabyte response through bounded serial writes rather than accumulating its body', async () => {
  const body = Buffer.alloc(2 * 1024 * 1024, 0x81)
  const f = await fixture((_request, response) => { response.writeHead(200, { 'content-length': body.length }); response.end(body) })
  const result = await f.call('/slow', ['Host', 'public.example.test'], Buffer.alloc(0), 60).result
  expect(createHash('sha256').update(result.body).digest('hex')).toBe(createHash('sha256').update(body).digest('hex'))
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed' })
})

it('forwards terminal error/redirect responses without issuing a second request', async () => {
  let calls = 0
  const f = await fixture((_request, response) => { calls++; response.writeHead(307, { location: 'http://not-selected.invalid/path' }); response.end('original') })
  const result = await f.call().result
  expect(result.status).toBe(307); expect(result.body.toString()).toBe('original'); expect(calls).toBe(1)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed', upstreamStatus: 307 })
})

it('joins actual cancellation when the client disconnects during a live upstream body', async () => {
  const entered = Promise.withResolvers<undefined>()
  const f = await fixture((_request, response) => { response.writeHead(200); response.write('prefix'); entered.resolve(undefined) })
  const call = f.call(); await entered.promise; call.request.destroy()
  await expect(call.result).rejects.toBeDefined()
  await waitFor(() => f.transfers.length === 1)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', upstreamMayHaveReceived: true })
})

it('does not report a truncated upstream HTTP body as completed', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-length': 100 }); response.write('short')
    setTimeout(() => { response.socket?.destroy() }, 10)
  })
  await expect(f.call().result).rejects.toBeDefined()
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed' })
})

it('bounds queue/connection reservations and closes an aborted queued carrier without contacting upstream', async () => {
  let calls = 0
  const f = await fixture(() => { calls++ }, { limits: { maxConcurrent: 1, maxQueued: 1, maxConnections: 4 } })
  const first = f.call(); await waitFor(() => calls === 1)
  const second = f.call(); await waitFor(() => f.transfers.length === 2)
  expect(f.transport.observe()).toMatchObject({ active: 1, queued: 1, retained: 2, reservedConnections: 4 })
  const third = await f.call().result; expect(third.status).toBe(503)
  f.controllers[1]!.abort(); await expect(second.result).rejects.toBeDefined()
  expect(await f.transfers[1]!.settled).toMatchObject({ status: 'failed', upstreamMayHaveReceived: false })
  expect(calls).toBe(1)
  f.controllers[0]!.abort(); await expect(first.result).rejects.toBeDefined()
  await f.transfers[0]!.settled
})

it('publishes close ownership before a synchronous lifetime callback reenters close', async () => {
  let calls = 0
  const f = await fixture(() => { calls++ }, { assertCurrent: () => { void f.transport.close() } })
  await expect(f.call().result).rejects.toBeDefined()
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', upstreamMayHaveReceived: false })
  const closing = f.transport.close(); expect(f.transport.close()).toBe(closing)
  expect(await closing).toEqual({ status: 'confirmed' }); expect(calls).toBe(0)
})

it('retains a real socket and capacity after close observation times out until its actual descriptor closes', async () => {
  let restore = (): void => {}, held: Socket | undefined
  const f = await fixture(() => {}, { limits: { closeTimeoutMs: 30 }, before: (input) => {
    const socket = input.request.socket, original = socket.destroy.bind(socket)
    held = socket; socket.destroy = function () { return this }
    restore = () => { socket.destroy = original; original() }
    return input
  } })
  try {
    const call = f.call(); await waitFor(() => f.transfers.length === 1 && f.upSockets.size === 1)
    const closing = f.transport.close()
    expect(await closing).toEqual({ status: 'unknown' })
    expect(await f.transfers[0]!.result).toMatchObject({ status: 'unknown' })
    expect(held?.destroyed).toBe(false); expect(f.transport.observe().retained).toBe(1)
    restore(); await expect(call.result).rejects.toBeDefined()
    expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed' })
    await f.transport.whenClosed(); expect(f.transport.observe().retained).toBe(0)
    expect(f.transport.close()).toBe(closing); expect(await closing).toEqual({ status: 'unknown' })
  } finally { restore() }
})

it('forwards a real WebSocket handshake and binary messages in both directions then settles its close', async () => {
  const f = await fixture((_request, response) => { response.end('not an upgrade') })
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: limits.maxTunnelBytes })
  f.upstream.on('upgrade', (request, socket, head) => {
    server.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on('error', () => {})
      websocket.on('message', (bytes, binary) => { websocket.send(bytes, { binary }) })
    })
  })
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/native`, { headers: { Host: 'public.example.test', Origin: 'https://public.example.test', Cookie: 'original=login' }, perMessageDeflate: false })
  client.on('error', () => {})
  cleanups.push(async () => {
    client.terminate()
    for (const peer of server.clients) peer.terminate()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  await once(client, 'open')
  const message = once(client, 'message'), body = Buffer.from([0, 255, 127, 8])
  client.send(body)
  expect((await message)[0]).toEqual(body)
  client.close(); await once(client, 'close')
  const outcome = await f.transfers[0]!.settled
  expect(outcome.failure?.stack).toBeUndefined()
  expect(outcome).toMatchObject({ status: 'completed', upstreamStatus: 101 })
})

it('returns a non-101 upgrade rejection as HTTP and never creates a byte tunnel', async () => {
  const f = await fixture((_request, response) => { response.writeHead(403); response.end('refused upstream') })
  f.upstream.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 16\r\nConnection: close\r\n\r\nrefused upstream') })
  const client = httpRequest({ host: '127.0.0.1', port: f.port, path: '/native', headers: { Host: 'public.example.test', Connection: 'Upgrade', Upgrade: 'websocket' }, agent: false })
  const result = new Promise<number>((resolve, reject) => { client.on('error', reject); client.on('response', (response) => { response.resume(); response.on('end', () => { resolve(response.statusCode ?? 0) }) }) })
  client.end(); expect(await result).toBe(403)
  const outcome = await f.transfers[0]!.settled
  expect(outcome.failure?.stack).toBeUndefined()
  expect(outcome).toMatchObject({ status: 'completed', upstreamStatus: 403 })
})


function rawClient(f: Awaited<ReturnType<typeof fixture>>): Socket {
  const socket = connect({ host: '127.0.0.1', port: f.port, allowHalfOpen: true })
  f.clients.add(socket); socket.on('error', () => {}); socket.once('close', () => { f.clients.delete(socket) })
  return socket
}
const upgradeRequest = Buffer.from('GET /opaque HTTP/1.1\r\nHost: public.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
const upgradeAccept = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')

it('preserves both upgrade heads and a delayed reply after the original client TCP half-close', async () => {
  const f = await fixture((_request, response) => { response.end() })
  const clientHead = Buffer.from([0, 255, 1, 2]), clientTail = Buffer.from([4, 0, 127])
  const ownerHead = Buffer.from([128, 0, 9]), ownerTail = Buffer.from([8, 255, 0, 6])
  const ownerBytes = Promise.withResolvers<Buffer>()
  f.upstream.on('upgrade', (_request, socket, head) => {
    const chunks: Buffer[] = [head]
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    socket.on('end', () => { ownerBytes.resolve(Buffer.concat(chunks)); socket.end(ownerTail) })
    socket.write(Buffer.concat([upgradeAccept, ownerHead]))
  })
  const client = rawClient(f), chunks: Buffer[] = []
  let ended = false
  client.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    if (!ended && Buffer.concat(chunks).includes(ownerHead)) { ended = true; client.end(clientTail) }
  })
  const closed = once(client, 'close')
  client.write(Buffer.concat([upgradeRequest, clientHead])); await closed
  const received = Buffer.concat(chunks), separator = received.indexOf('\r\n\r\n')
  expect(separator).toBeGreaterThan(0)
  expect(received.subarray(separator + 4)).toEqual(Buffer.concat([ownerHead, ownerTail]))
  expect(await ownerBytes.promise).toEqual(Buffer.concat([clientHead, clientTail]))
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed', upstreamStatus: 101 })
})

it('expires queued and running work without replaying a request or releasing retained capacity early', async () => {
  let calls = 0
  const f = await fixture(() => { calls++ }, { limits: { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 30, operationTimeoutMs: 100 } })
  const running = f.call(); await waitFor(() => calls === 1)
  const queued = f.call(); await waitFor(() => f.transfers.length === 2)
  expect(await f.transfers[1]!.settled).toMatchObject({ status: 'failed', failure: { code: 'timeout' }, upstreamMayHaveReceived: false })
  await expect(queued.result).rejects.toBeDefined()
  expect(f.transport.observe()).toMatchObject({ retained: 1, active: 1, queued: 0 })
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', failure: { code: 'timeout' }, upstreamMayHaveReceived: true })
  await expect(running.result).rejects.toBeDefined(); expect(calls).toBe(1)
})

it('enforces body and upstream header-pair limits on original loopback responses', async () => {
  for (const mode of ['body', 'headers'] as const) {
    const f = await fixture((_request, response) => {
      if (mode === 'body') response.end(Buffer.alloc(129, 255))
      else { response.writeHead(200, ['X-One', 'a', 'X-Two', 'b', 'X-Three', 'c', 'X-Four', 'd', 'Connection', 'close']); response.end() }
    }, { limits: mode === 'body' ? { maxBodyBytes: 128 } : { maxHeaderPairs: 4 } })
    await expect(f.call().result).rejects.toBeDefined()
    expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', failure: { code: 'capacity' }, upstreamMayHaveReceived: true })
  }
})

it('refuses protected hop nominations and an oversized incoming upgrade head before any upstream contact', async () => {
  let calls = 0
  const f = await fixture(() => { calls++ }, { limits: { maxHeadBytes: 16 } })
  expect((await f.call('/opaque', ['Host', 'public.example.test', 'Cookie', 'original=1', 'Connection', 'close, cookie']).result).status).toBe(503)
  const client = rawClient(f), chunks: Buffer[] = []
  client.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  client.on('end', () => { client.end() })
  const closed = once(client, 'close'); client.write(Buffer.concat([upgradeRequest, Buffer.alloc(32)])); await closed
  expect(Buffer.concat(chunks).toString()).toContain('503 Service Unavailable')
  expect(f.transfers).toHaveLength(0); expect(calls).toBe(0)
})

it('fails closed for an oversized upstream upgrade head and an exhausted tunnel byte budget', async () => {
  for (const mode of ['head', 'tunnel'] as const) {
    const f = await fixture((_request, response) => { response.end() }, { limits: { maxHeadBytes: 16, maxTunnelBytes: 8 } })
    f.upstream.on('upgrade', (_request, socket) => {
      socket.write(mode === 'head' ? Buffer.concat([upgradeAccept, Buffer.alloc(32)]) : upgradeAccept)
      if (mode === 'tunnel') setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.alloc(9)) }, 10)
    })
    const client = rawClient(f); client.resume(); const closed = once(client, 'close'); client.write(upgradeRequest)
    await waitFor(() => f.transfers.length === 1)
    expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', failure: { code: mode === 'head' ? 'protocol' : 'capacity' } })
    client.destroy(); await closed
  }
})

it('rejects an unsolicited upstream upgrade on an ordinary HTTP request', async () => {
  const f = await fixture((_request, response) => { response.writeHead(101, { Connection: 'Upgrade', Upgrade: 'websocket' }); response.flushHeaders() })
  await expect(f.call().result).rejects.toBeDefined()
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', failure: { code: 'protocol' } })
})


it('expires the connect budget on an actual loopback TCP connection stalled before TLS secureConnect', async () => {
  const sockets = new Set<Socket>()
  let connections = 0, hello = Buffer.alloc(0)
  const stalled = netServer((socket) => {
    connections++; sockets.add(socket); socket.on('error', () => {})
    socket.once('data', (chunk: Buffer) => { hello = Buffer.from(chunk); socket.pause() })
    socket.once('close', () => { sockets.delete(socket) })
  })
  const port = await listen(stalled)
  cleanups.push(async () => {
    const closed = [...sockets].map(socket => new Promise<void>((resolve) => { socket.once('close', () => { resolve() }); socket.destroy() }))
    await Promise.all(closed)
    await new Promise<void>((resolve) => { stalled.close(() => { resolve() }) })
    expect(sockets.size).toBe(0)
  })
  const f = await fixture(() => {}, { origin: `https://127.0.0.1:${port}`, limits: { connectTimeoutMs: 40, operationTimeoutMs: 1000 } })
  await expect(f.call().result).rejects.toBeDefined()
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', failure: { code: 'timeout' }, upstreamMayHaveReceived: true })
  expect(connections).toBe(1); expect(hello.length).toBeGreaterThanOrEqual(5)
  expect(hello.length).toBeGreaterThanOrEqual(5 + hello.readUInt16BE(3))
  expect(hello.includes(Buffer.from('public.example.test'))).toBe(false)
})

it('settles an original upgraded transport as failed after an actual upstream TCP reset', async () => {
  const f = await fixture((_request, response) => { response.end() })
  f.upstream.on('upgrade', (_request, socket) => {
    socket.write(upgradeAccept)
    setTimeout(() => { for (const owned of f.upSockets) owned.resetAndDestroy() }, 10)
  })
  const client = rawClient(f); client.resume(); const closed = once(client, 'close'); client.write(upgradeRequest)
  await waitFor(() => f.transfers.length === 1)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', upstreamStatus: 101 })
  client.destroy(); await closed
})


it('counts rebuilt hop headers in tiny exact header-pair admission budgets', async () => {
  let calls = 0
  const f = await fixture((_request, response) => {
    calls++; response.sendDate = false; response.writeHead(200, ['Content-Length', '0', 'Connection', 'close']); response.end()
  }, { limits: { maxHeaderPairs: 2 } })
  expect((await f.call().result).status).toBe(200)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed' })
  const client = rawClient(f), chunks: Buffer[] = []
  client.on('data', (chunk: Buffer) => { chunks.push(chunk) }); client.on('end', () => { client.end() })
  const closed = once(client, 'close'); client.write('GET /opaque HTTP/1.1\r\nHost: public.example.test\r\nX-End: keep\r\n\r\n'); await closed
  expect(Buffer.concat(chunks).toString()).toContain('503 Service Unavailable')
  expect(calls).toBe(1); expect(f.transfers).toHaveLength(1)
})

async function rawExchange(f: Awaited<ReturnType<typeof fixture>>, bytes: Buffer | string): Promise<Buffer> {
  const client = rawClient(f), chunks: Buffer[] = []
  client.on('data', (chunk: Buffer) => { chunks.push(chunk) }); client.on('end', () => { client.end() })
  const closed = once(client, 'close'); client.write(bytes); await closed
  return Buffer.concat(chunks)
}

for (const kind of ['http', 'upgrade'] as const) for (const count of [2100, 3100]) {
  it(`captures ${kind} response headers beyond Node defaults and rejects excess pairs (${count})`, async () => {
    const pads = Array.from({ length: count }, (_, index) => ['X-Pad-' + String(index), 'a']).flat()
    const headers = kind === 'http'
      ? ['X-Remove-Me', 'hop', ...pads, 'Content-Length', '0', 'Connection', 'close, x-remove-me']
      : ['Connection', 'Upgrade', 'Upgrade', 'websocket', 'X-Remove-Me', 'hop', ...pads, 'Connection', 'upgrade, x-remove-me']
    let calls = 0
    const f = await fixture((_request, response) => {
      calls++; response.sendDate = false; response.writeHead(200, headers); response.end()
    }, { limits: { maxHeaderPairs: 3000, maxHeaderBytes: 131072 } })
    f.upstream.on('upgrade', (_request, socket) => {
      calls++
      let head = 'HTTP/1.1 101 Switching Protocols\r\n'
      for (let index = 0; index < headers.length; index += 2) head += `${headers[index]}: ${headers[index + 1]}\r\n`
      socket.end(Buffer.concat([Buffer.from(head + '\r\n', 'latin1'), Buffer.from([128, 0, 255])]))
    })
    const bytes = await rawExchange(f, kind === 'upgrade' ? upgradeRequest
      : 'GET /opaque HTTP/1.1\r\nHost: public.example.test\r\nConnection: close\r\n\r\n')
    const outcome = await f.transfers[0]!.settled
    expect(calls).toBe(1)
    if (count > 3000) {
      expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'capacity' } }); expect(bytes.length).toBe(0)
    } else {
      expect(outcome).toMatchObject({ status: 'completed', upstreamStatus: kind === 'upgrade' ? 101 : 200 })
      const separator = bytes.indexOf('\r\n\r\n'), head = bytes.subarray(0, separator).toString('latin1')
      expect(head.match(/\r\nX-Pad-/gu)).toHaveLength(count); expect(head).not.toContain('X-Remove-Me:')
      if (kind === 'upgrade') expect(bytes.subarray(separator + 4)).toEqual(Buffer.from([128, 0, 255]))
    }
  })
}

for (const count of [2100, 3100]) {
  it(`uses the incoming Server capture contract to preserve or refuse ${count} request headers`, async () => {
    let received: string[] | undefined
    const f = await fixture((request, response) => {
      received = request.rawHeaders; response.sendDate = false; response.writeHead(200, ['Content-Length', '0']); response.end()
    }, { limits: { maxHeaderPairs: 3000, maxHeaderBytes: 131072 } })
    const pads = Array.from({ length: count }, (_, index) => `X-Pad-${index}: a\r\n`).join('')
    const bytes = await rawExchange(f, 'GET /opaque HTTP/1.1\r\nHost: public.example.test\r\nX-Remove-Me: hop\r\n'
      + pads + 'Connection: close, x-remove-me\r\n\r\n')
    if (count > 3000) {
      expect(bytes.toString()).toContain('503 Service Unavailable'); expect(received).toBeUndefined(); expect(f.transfers).toHaveLength(0)
    } else {
      expect(received?.filter(value => value.startsWith('X-Pad-'))).toHaveLength(count); expect(received).not.toContain('X-Remove-Me')
      expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed' })
    }
  })
}

it('refuses header pair budgets that overflow the Node parser sentinel count', () => {
  expect(() => new OwnerForwarder({ ...limits, maxHeaderPairs: 0x3fff_ffff }, [{ id: 'fixed', origin: 'http://127.0.0.1' }])).toThrow()
})

function identityRecord(evidence: object): void {
  const path = process.env['OWNER_IDENTITY_EVIDENCE_PATH']
  if (path !== undefined) appendFileSync(path, JSON.stringify(evidence) + '\n')
}

it('authenticates the actual mTLS peer before HTTP and upgrade bytes with fixed SNI and copied material', async () => {
  const pki = identityFixture(), body = Buffer.from([0, 255, 127, 9])
  let calls = 0, decryptedBytes = 0
  const peers: { authorized: boolean; pin: string; servername: string | false | null }[] = []
  const f = await fixture((request, response) => {
    calls++; expect(request.headers.host).toBe('public-attacker.invalid')
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { response.end(Buffer.concat(chunks)) })
  }, { tls: pki.server, identity: pki.identity, limits: { maxTlsIdentityBytes: 65536 } })
  f.upstream.on('secureConnection', (socket: TLSSocket) => {
    peers.push({ authorized: socket.authorized, pin: socket.getPeerCertificate().fingerprint256.replaceAll(':', '').toLowerCase(), servername: socket.servername })
    socket.on('data', (chunk: Buffer) => { decryptedBytes += chunk.length })
  })
  const upgradeBytes = Promise.withResolvers<Buffer>()
  f.upstream.on('upgrade', (_request, socket, head) => {
    calls++; const chunks: Buffer[] = [head]
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    socket.on('end', () => { upgradeBytes.resolve(Buffer.concat(chunks)); socket.end(body) })
    socket.resume(); socket.write(upgradeAccept)
  })
  // The caller's buffers can change after construction without changing either later connection's identity.
  pki.identity.ca.fill(0); pki.identity.cert.fill(0); pki.identity.key.fill(0)
  expect(JSON.stringify(f.transport.target('reviewed-owner'))).toBe('{"id":"reviewed-owner"}')
  expect((await f.call('/identity', ['Host', 'public-attacker.invalid'], body).result).body).toEqual(body)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed', upstreamMayHaveReceived: true })
  const client = rawClient(f), chunks: Buffer[] = []
  client.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    if (!client.writableEnded && Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) client.end()
  })
  const closed = once(client, 'close'); client.write(Buffer.concat([upgradeRequest, body])); await closed
  const received = Buffer.concat(chunks), split = received.indexOf('\r\n\r\n')
  expect(received.subarray(split + 4)).toEqual(body)
  expect(await upgradeBytes.promise).toEqual(body)
  expect(await f.transfers[1]!.settled).toMatchObject({ status: 'completed', upstreamStatus: 101 })
  expect(peers).toHaveLength(2)
  for (const peer of peers) expect(peer).toEqual({ authorized: true, pin: pki.clientPin, servername: 'owner.test' })
  expect(decryptedBytes).toBeGreaterThan(0); expect(calls).toBe(2)
  identityRecord({ case: 'valid-http-and-upgrade', actualClientPeers: peers, calls, decryptedBytes,
    outcomes: await Promise.all(f.transfers.map(transfer => transfer.settled)), copiedMaterial: true })
})

it('refuses wrong CA hostname and pin before any owner HTTP bytes or handler call', async () => {
  const pki = identityFixture()
  for (const mismatch of ['ca', 'hostname', 'pin'] as const) {
    let calls = 0, decryptedBytes = 0
    const identity = { ...pki.identity, ...(mismatch === 'ca' ? { ca: pki.wrongCa }
      : mismatch === 'hostname' ? { servername: 'wrong-owner.test' } : { serverCertificateSha256: '00'.repeat(32) }) }
    const f = await fixture((_request, response) => { calls++; response.end('must not run') },
      { tls: pki.server, identity, limits: { maxTlsIdentityBytes: 65536 } })
    f.upstream.on('tlsClientError', () => {})
    f.upstream.on('secureConnection', (socket: TLSSocket) => { socket.on('data', (chunk: Buffer) => { decryptedBytes += chunk.length }) })
    f.upstream.on('upgrade', (_request, socket) => { calls++; socket.destroy() })
    await expect(f.call('/private', ['Host', 'owner.test'], Buffer.from('sensitive-body')).result).rejects.toBeDefined()
    const result = await f.transfers[0]!.settled
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'identity' }, upstreamMayHaveReceived: false })
    expect(calls).toBe(0); expect(decryptedBytes).toBe(0)
    expect(String(result.failure)).toBe('Error: Owner transport did not complete.')
    expect(result.failure?.cause).toBeUndefined()
    if (mismatch === 'pin') {
      const client = rawClient(f); client.resume(); client.on('end', () => { client.end() })
      const closed = once(client, 'close'); client.write(upgradeRequest); await closed
      expect(await f.transfers[1]!.settled).toMatchObject({ status: 'failed', failure: { code: 'identity' }, upstreamMayHaveReceived: false })
      expect(calls).toBe(0); expect(decryptedBytes).toBe(0)
    }
    expect(f.transport.observe()).toMatchObject({ retained: 0, reservedConnections: 0, reservedBytes: 0 })
    identityRecord({ case: mismatch, calls, decryptedBytes, result, actualSettlement: f.transport.observe() })
  }
})

it('keeps authentication cancellation reserved until original carriers actually close', async () => {
  const pki = identityFixture(), sockets = new Set<Socket>()
  const hello = Promise.withResolvers<Buffer>()
  const stalled = netServer((socket) => {
    sockets.add(socket); socket.on('error', () => {})
    socket.once('close', () => { sockets.delete(socket) })
    socket.once('data', (chunk: Buffer) => { hello.resolve(Buffer.from(chunk)); socket.pause() })
  })
  const port = await listen(stalled)
  cleanups.push(async () => {
    const closing = [...sockets].map(socket => new Promise<void>((resolve) => { socket.once('close', () => { resolve() }); socket.destroy() }))
    await Promise.all(closing)
    await new Promise<void>((resolve) => { stalled.close(() => { resolve() }) })
  })
  const f = await fixture(() => { throw new Error('Unused HTTP owner') }, { origin: `https://127.0.0.1:${port}`, identity: pki.identity,
    limits: { maxTlsIdentityBytes: 65536, connectTimeoutMs: 2000 } })
  let frontClosed = false, settled = false, settledBeforeClose = false
  f.front.on('connection', (socket) => { socket.once('close', () => { frontClosed = true }) })
  const call = f.call('/never-send', ['Host', 'untrusted-public.invalid'], Buffer.from('never-send-body'))
  const tlsHello = await hello.promise
  expect(tlsHello.includes(Buffer.from('never-send'))).toBe(false)
  expect(tlsHello.includes(Buffer.from('untrusted-public.invalid'))).toBe(false)
  expect(tlsHello.includes(Buffer.from('owner.test'))).toBe(true)
  void f.transfers[0]!.settled.then(() => { settledBeforeClose = !frontClosed; settled = true })
  f.controllers[0]!.abort()
  expect(f.transport.observe()).toMatchObject({ retained: 1, reservedConnections: 2 })
  expect(settled).toBe(false)
  const close = f.transport.close()
  await expect(call.result).rejects.toBeDefined()
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'failed', failure: { code: 'cancelled' }, upstreamMayHaveReceived: false })
  expect(await close).toEqual({ status: 'confirmed' }); await f.transport.whenClosed()
  expect(frontClosed).toBe(true)
  expect(settledBeforeClose).toBe(false)
  expect(f.transport.observe()).toMatchObject({ retained: 0, reservedConnections: 0, reservedBytes: 0 })
  identityRecord({ case: 'cancel-during-identity', frontClosed, settled, result: await f.transfers[0]!.settled, final: f.transport.observe() })
})

it('bounds all copied TLS material and refuses identity on plaintext targets', () => {
  const pki = identityFixture()
  const target = { id: 'fixed-owner', origin: 'https://127.0.0.1:1', tlsIdentity: pki.identity }
  const identityBytes = pki.identity.ca.byteLength + pki.identity.cert.byteLength + pki.identity.key.byteLength + 64 + Buffer.byteLength('owner.test')
  expect(() => new OwnerForwarder(limits, [target])).toThrow('Owner transport did not complete.')
  expect(() => new OwnerForwarder({ ...limits, maxTlsIdentityBytes: identityBytes - 1 }, [target])).toThrow()
  const selected = { ...limits, maxTlsIdentityBytes: identityBytes }
  expect(() => new OwnerForwarder(selected, [target, { ...target, id: 'second-owner' }])).toThrow()
  expect(() => new OwnerForwarder(selected, [{ ...target, origin: 'http://127.0.0.1:1' }])).toThrow()
  expect(() => new OwnerForwarder(selected, [target])).not.toThrow()
})

const ownerRequestId = brandString<Branded<'pe-request-id'>>('wire-owner-request')
const ownerExpectation: OwnerHop = { accountId: brandString<OwnerHop['accountId']>('account-one'),
  recipientInstanceId: brandString<OwnerHop['recipientInstanceId']>('fixed-recipient'),
  epoch: brandString<OwnerHop['epoch']>('17'), recipeVersion: 'fixture-v1' }

it('reads the copied Root hop helper only from actual authorized pinned TLS peers', async () => {
  const pki = identityFixture(), pins = new Set([pki.clientPin]), marker = encodeOwnerHop(ownerExpectation, 1024, ownerRequestId)
  const observations: object[] = []
  const f = await fixture((request, response) => {
    const raw = request.rawHeaders, snapshot = [...raw], socket = request.socket
    let status = 200, decoded: OwnerHop | undefined, entered = false
    try { decoded = readOwnerHop(request, pins, 1024, ownerRequestId); entered = true }
    catch (error) { status = error instanceof AuthAccessError ? error.status : 500 }
    expect(request.rawHeaders).toBe(raw); expect(request.rawHeaders).toEqual(snapshot)
    expect(request.readableFlowing).toBeNull()
    const trustedTls = socket instanceof TLSSocket && socket.authorized
    const certificate = socket instanceof TLSSocket ? socket.getPeerCertificate() : undefined
    const pin = certificate !== undefined && Buffer.isBuffer(certificate.raw) ? createHash('sha256').update(certificate.raw).digest('hex') : undefined
    observations.push({ path: request.url, status, trustedTls, actualPinMatched: pin !== undefined && pins.has(pin), entered,
      markerPairs: raw.filter(name => name.toLowerCase() === OWNER_HOP_HEADER).length, originalUnconsumed: true, decoded })
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(decoded ?? null))
  }, { tls: { ...pki.server, rejectUnauthorized: false }, identity: pki.identity, limits: { maxTlsIdentityBytes: 65536 } })
  const call = (path: string, credentials: { cert: Uint8Array; key: Uint8Array } | undefined, extra: string[]) => {
    const request = httpsRequest({ host: '127.0.0.1', port: f.upstreamPort, servername: 'owner.test', ca: Buffer.from(pki.identity.ca),
      rejectUnauthorized: true, agent: false, path, headers: ['Host', 'public.invalid', 'Connection', 'close', ...extra],
      ...(credentials === undefined ? {} : { cert: Buffer.from(credentials.cert), key: Buffer.from(credentials.key) }) })
    request.on('socket', (socket) => { f.clients.add(socket); socket.once('close', () => { f.clients.delete(socket) }) })
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      request.on('error', reject); request.on('response', (response) => {
        const chunks: Buffer[] = []; response.on('error', reject); response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }) })
      })
    })
    request.end(); return result
  }
  expect(await call('/anonymous-public', undefined, [])).toEqual({ status: 200, body: 'null' })
  expect((await call('/anonymous-forgery', undefined, [OWNER_HOP_HEADER, marker])).status).toBe(403)
  expect((await call('/foreign-pin', pki.otherClient, [OWNER_HOP_HEADER, marker])).status).toBe(403)
  expect(JSON.parse((await call('/trusted-hop', pki.identity, [OWNER_HOP_HEADER, marker])).body)).toEqual(ownerExpectation)
  expect((await call('/duplicate', pki.identity, [OWNER_HOP_HEADER, marker, OWNER_HOP_HEADER, marker])).status).toBe(403)
  expect((await call('/nominated', pki.identity, [OWNER_HOP_HEADER, marker, 'Connection', `close, ${OWNER_HOP_HEADER}`])).status).toBe(403)
  expect((await call('/trusted-missing', pki.identity, [])).status).toBe(403)
  expect(observations).toMatchObject([
    { trustedTls: false, entered: true }, { trustedTls: false, entered: false },
    { trustedTls: true, actualPinMatched: false, entered: false },
    { trustedTls: true, actualPinMatched: true, entered: true },
    { markerPairs: 2, entered: false }, { entered: false }, { entered: false },
  ])
  identityRecord({ case: 'root-hop-actual-tls', observations })
})

it('appends bounded Root headers on the authenticated transport without mutating the incoming request', async () => {
  const pki = identityFixture(), marker = encodeOwnerHop(ownerExpectation, 1024, ownerRequestId)
  let original: IncomingMessage | undefined, rawSnapshot: string[] = [], ownerCalls = 0
  const f = await fixture((request, response) => {
    ownerCalls++
    expect(request.headers['x-binding']).toBe('original-binding')
    let hop: OwnerHop | undefined
    try { hop = readOwnerHop(request, new Set([pki.clientPin]), 1024, ownerRequestId) }
    catch (_error) { response.writeHead(403); response.end('refused hop'); return }
    expect(hop).toEqual(ownerExpectation); response.end(JSON.stringify(hop))
  }, { tls: pki.server, identity: pki.identity, limits: { maxTlsIdentityBytes: 65536, maxHeaderPairs: 4 }, before: (input) => {
    original = input.request; rawSnapshot = [...input.request.rawHeaders]
    return { ...input, trustedRequestHeaders: [OWNER_HOP_HEADER, marker] }
  } })
  const result = await f.call('/root-generated', ['Host', 'public.invalid', 'X-Binding', 'original-binding']).result
  expect(result.status).toBe(200); expect(JSON.parse(result.body.toString())).toEqual(ownerExpectation)
  expect(await f.transfers[0]!.settled).toMatchObject({ status: 'completed' })
  expect(original?.rawHeaders).toEqual(rawSnapshot)
  expect(original?.rawHeaders.map(name => name.toLowerCase())).not.toContain(OWNER_HOP_HEADER)
  expect(original?.headers[OWNER_HOP_HEADER]).toBeUndefined()
  expect(ownerCalls).toBe(1)
  identityRecord({ case: 'root-generated-header', ownerCalls, originalRawUnchanged: true, exactHeaderPairBudget: 4 })
})

it('refuses appended binding overrides nominations duplicates and complete emitted header over-budget before owner contact', async () => {
  const pki = identityFixture(), marker = encodeOwnerHop(ownerExpectation, 1024, ownerRequestId)
  let ownerCalls = 0, extra = [OWNER_HOP_HEADER, marker]
  const f = await fixture((_request, response) => { ownerCalls++; response.end('must not run') },
    { tls: pki.server, identity: pki.identity, limits: { maxTlsIdentityBytes: 65536 },
      before: input => ({ ...input, trustedRequestHeaders: extra }) })
  for (const [name, value] of [['Host', 'replace'], ['Origin', 'replace'], ['Cookie', 'replace'], ['X-Binding', 'replace']] as const) {
    extra = [name, value]
    expect((await f.call('/override', ['Host', 'public.invalid', 'X-Binding', 'original']).result).status).toBe(503)
  }
  extra = [OWNER_HOP_HEADER, marker, OWNER_HOP_HEADER, marker]
  expect((await f.call().result).status).toBe(503)
  extra = [OWNER_HOP_HEADER, marker]
  expect((await f.call('/nomination', ['Host', 'public.invalid', 'Connection', `close, ${OWNER_HOP_HEADER}`]).result).status).toBe(503)
  expect((await f.call('/incoming-marker', ['Host', 'public.invalid', OWNER_HOP_HEADER, marker]).result).status).toBe(503)
  extra = [OWNER_HOP_HEADER, 'x'.repeat(limits.maxHeaderBytes)]
  expect((await f.call().result).status).toBe(503)
  expect(ownerCalls).toBe(0); expect(f.transfers).toHaveLength(0)
  const tiny = await fixture((_request, response) => { ownerCalls++; response.end() },
    { tls: pki.server, identity: pki.identity, limits: { maxTlsIdentityBytes: 65536, maxHeaderPairs: 3 },
      before: input => ({ ...input, trustedRequestHeaders: [OWNER_HOP_HEADER, marker] }) })
  expect((await tiny.call('/tiny', ['Host', 'public.invalid', 'X-Binding', 'original']).result).status).toBe(503)
  const plain = await fixture((_request, response) => { ownerCalls++; response.end() },
    { before: input => ({ ...input, trustedRequestHeaders: [OWNER_HOP_HEADER, marker] }) })
  expect((await plain.call().result).status).toBe(503)
  expect(ownerCalls).toBe(0)
  identityRecord({ case: 'trusted-header-refusals', ownerCalls, admittedTransfers: f.transfers.length,
    tinyPairBudget: 3, exactPositivePairBudget: 4, unauthenticatedTargetRefused: true })
})

it('notifies upgrade acceptance once after the original 101 write while retaining the tunnel and joining callback failure', async () => {
  for (const mode of ['accepted', 'rejected', 'callback-throws'] as const) {
    let notifications = 0, settled = false
    const notified = Promise.withResolvers<undefined>()
    const f = await fixture((_request, response) => { response.end() }, { before: input => input.kind !== 'upgrade' ? input : {
      ...input, onUpgradeAccepted: () => {
        notifications++
        expect(input.socket.writable).toBe(true)
        expect(f.transport.observe()).toMatchObject({ retained: 1, reservedConnections: 2 })
        notified.resolve(undefined)
        if (mode === 'callback-throws') throw new Error('Original ingress notification failed')
      },
    } })
    f.upstream.on('upgrade', (_request, socket) => {
      if (mode === 'rejected') { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
      socket.on('end', () => { socket.end('owner-tail') }); socket.resume(); socket.write(upgradeAccept)
    })
    const client = rawClient(f), chunks: Buffer[] = [], receivedHeaders = Promise.withResolvers<undefined>()
    client.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) receivedHeaders.resolve(undefined)
    })
    client.on('end', () => { client.end() })
    const closed = once(client, 'close'); client.write(upgradeRequest)
    await receivedHeaders.promise
    void f.transfers[0]!.settled.then(() => { settled = true })
    if (mode === 'accepted') {
      await notified.promise
      expect(Buffer.concat(chunks).toString()).toContain('101 Switching Protocols')
      expect(settled).toBe(false)
      expect(f.transport.observe()).toMatchObject({ retained: 1, reservedConnections: 2 })
      client.end()
    }
    await closed
    const outcome = await f.transfers[0]!.settled
    expect(notifications).toBe(mode === 'rejected' ? 0 : 1)
    expect(outcome.status).toBe(mode === 'callback-throws' ? 'failed' : 'completed')
    expect(f.transport.observe()).toMatchObject({ retained: 0, reservedConnections: 0, reservedBytes: 0 })
    identityRecord({ case: 'upgrade-notification', mode, notifications, outcome, actual: f.transport.observe() })
  }
})
