/** Real loopback Undici8 WebSocket/private-header/parser/closure checks; no container, target or remote authority. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { UndiciOwnedTransport, type WireEvents, type WireStreamEvents } from '../src/agent-data/transport.ts'
import { STREAM_LIMITS } from '../src/agent-data/role-protocol.ts'
import { encodeStreamFrame } from '../src/agent-data/stream.ts'
import { LocalRefusal } from '../src/agent-data/errors.ts'

async function server(compression = false) {
  const pending: { request: IncomingMessage; response: ServerResponse }[] = []
  const gates = new Map<number, () => void>()
  const http = createServer((request, response) => {
    pending.push({ request, response }); gates.get(pending.length)?.()
  })
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: compression, handleProtocols: protocols =>
    protocols.has(STREAM_LIMITS.version) ? STREAM_LIMITS.version : false })
  const peers: { request: IncomingMessage; socket: WebSocket }[] = []
  http.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      peers.push({ request, socket: websocket }); sockets.emit('connection', websocket, request)
    })
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Missing actual loopback address')
  const transport = new UndiciOwnedTransport(`http://127.0.0.1:${address.port}`)
  onTestFinished(async () => {
    await transport.destroy()
    for (const peer of peers) peer.socket.terminate()
    sockets.close(); http.closeAllConnections(); await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  const observed = (n: number) => pending.length >= n ? Promise.resolve() : new Promise<void>((resolve) => { gates.set(n, resolve) })
  const reply = (n: number) => {
    const row = pending[n]
    if (row === undefined) throw new Error('Missing loopback request')
    row.request.resume(); row.response.writeHead(200, { 'content-length': '2', 'content-type': 'application/json', connection: 'close' })
    row.response.end('{}')
  }
  return { transport, pending, peers, observed, reply }
}
function events() {
  const open = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>(), error = Promise.withResolvers<undefined>()
  const received: Uint8Array[] = [], next = Promise.withResolvers<undefined>()
  const callbacks: WireStreamEvents = { open: () => { open.resolve(undefined) },
    closed: () => { closed.resolve(undefined) }, error: () => { error.resolve(undefined) },
    data: (bytes) => { received.push(bytes); next.resolve(undefined) } }
  return { open: open.promise, closed: closed.promise, error: error.promise, received, next: next.promise, callbacks }
}
const privateHeaders = { 'x-pe-execution-token': '1'.repeat(64), 'x-pe-operation-id': 'test-operation',
  'x-pe-spec-hash': '2'.repeat(64), 'x-pe-range-role': 'program', 'x-pe-registration-id': '-', 'x-pe-role-signature': '3'.repeat(64) }

it.each([false, true])('keeps raw transport with compression-capable proxy=%s, private headers and actual two-sided close', async (compression) => {
  const f = await server(compression), e = events(), wire = f.transport.attach({ headers: privateHeaders }, e.callbacks)
  expect(await Promise.race([e.open.then(() => true), e.error.then(() => false)])).toBe(true)
  const peer = f.peers[0]
  expect(peer?.request.url).toBe('/stream')
  expect(peer?.request.headers).toMatchObject(privateHeaders)
  expect(peer?.request.headers['sec-websocket-extensions']).toBeUndefined()
  expect(peer?.socket.extensions).toBe('')
  expect(peer?.socket.protocol).toBe(STREAM_LIMITS.version)
  const incoming = Promise.withResolvers<Buffer>()
  peer?.socket.once('message', (bytes, binary) => {
    expect(binary).toBe(true)
    if (!Buffer.isBuffer(bytes)) throw new Error('Expected the server binary Buffer representation.')
    incoming.resolve(bytes)
  })
  const frame = encodeStreamFrame({ kind: 1, channel: 4, sequence: 0, payload: Buffer.from([0, 255, 128, 65]) })
  await wire.send(frame)
  expect(await incoming.promise).toEqual(Buffer.from(frame))
  peer?.socket.send(frame); await e.next
  expect(e.received).toHaveLength(1)
  expect(Buffer.from(e.received[0] ?? [])).toEqual(Buffer.from(frame))
  wire.close(); await e.closed; await f.transport.close()
})
it.each(['oversized', 'text'] as const)('rejects %s messages without exposing their payload and joins the actual socket', async (bad) => {
  const f = await server(), e = events()
  f.transport.attach({ headers: privateHeaders }, e.callbacks); await e.open
  f.peers[0]?.socket.send(bad === 'oversized' ? Buffer.alloc(4109) : 'secret-bearing-invalid-text')
  await e.error; await e.closed
  expect(e.received).toHaveLength(0)
  await f.transport.destroy()
})
it('retains two upgraded sockets while only two HTTP peers run, and destroy actually closes all four', async () => {
  const f = await server(), first = events(), second = events()
  f.transport.attach({ headers: privateHeaders }, first.callbacks); await first.open
  f.transport.attach({ headers: privateHeaders }, second.callbacks); await second.open
  expect(() => f.transport.attach({ headers: privateHeaders }, events().callbacks)).toThrow(LocalRefusal)
  const done = Array.from({ length: 3 }, () => {
    const result = Promise.withResolvers<undefined>()
    const callbacks: WireEvents = { start() {}, headers() {}, data() {},
      end: () => { result.resolve(undefined) }, error: () => { result.resolve(undefined) } }
    f.transport.dispatch({ route: '/poll', headers: { 'content-length': '0', connection: 'close' }, body: new Uint8Array() }, callbacks)
    return result.promise
  })
  await f.observed(2)
  expect(f.pending).toHaveLength(2)
  f.reply(0); f.reply(1)
  await f.observed(3); f.reply(2); await Promise.all(done)
  await f.transport.destroy()
  await Promise.all([first.closed, second.closed])
})
