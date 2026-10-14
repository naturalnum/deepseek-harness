/** Actual HTTP upgrade carriers retain initial bytes and close all owned transports. */
import { createServer, type Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test } from 'vitest'
import { proxyRuntimeUpgrade } from '../src/runtime-upgrade-proxy.ts'

async function listener(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener address')
  return new URL(`http://127.0.0.1:${address.port}`)
}

async function close(server: Server, sockets: Set<Socket>) {
  const closing = server.listening
    ? new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() })) : Promise.resolve()
  await Promise.all([...sockets].map(async (socket) => {
    const closed = socket.closed ? Promise.resolve() : once(socket, 'close')
    socket.destroy(); await closed
  }))
  await closing
}

function track(server: Server) {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  return sockets
}

const handshake = 'GET /native/api/remote.mux HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
  + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
  + 'Authorization: Bearer client-value\r\nCookie: private-client-cookie\r\n'
  + 'X-Power-Evolve-Runner-Token: client-value\r\n\r\n'

test('raw 101 proxy preserves both initial byte buffers and replaces client credentials', async () => {
  const upstream = createServer(), downstream = createServer()
  const upstreamSockets = track(upstream), downstreamSockets = track(downstream)
  const received = Promise.withResolvers<Buffer>(), served = Promise.withResolvers<undefined>()
  const upstreamClosed = Promise.withResolvers<undefined>()
  let serving: Promise<void> | undefined, client: Socket | undefined
  upstream.on('upgrade', (request, socket, head) => {
    socket.once('close', () => { upstreamClosed.resolve(undefined) })
    socket.once('end', () => { socket.end() })
    expect(request.headers.authorization).toBe('Bearer platform-value')
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers['x-power-evolve-runner-token']).toBe('owned-process-value')
    expect(request.headers.origin).toBe('https://trial.example')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\nupstream-head:')
    if (head.length) socket.write(head)
    socket.on('data', (data) => { socket.write(data) })
  })
  try {
    const target = await listener(upstream)
    downstream.on('upgrade', (request, socket, head) => {
      serving = proxyRuntimeUpgrade(request, socket, head, target, {
        headers: { authorization: 'Bearer platform-value', 'x-power-evolve-runner-token': 'owned-process-value',
          origin: 'https://trial.example' },
      }, 2000)
      void serving.then(() => { served.resolve(undefined) }, served.reject)
    })
    const destination = await listener(downstream)
    client = createConnection({ host: destination.hostname, port: Number(destination.port) })
    let response = Buffer.alloc(0)
    client.on('data', (data) => {
      response = Buffer.concat([response, data])
      if (response.includes(Buffer.from('upstream-head:downstream-head'))) received.resolve(response)
    })
    await once(client, 'connect')
    client.write(handshake + 'downstream-head')
    expect((await received.promise).toString()).toContain('HTTP/1.1 101 Switching Protocols')
    const exited = once(client, 'close'); client.destroy(); await exited
    await served.promise
    await upstreamClosed.promise
    expect([...upstreamSockets].every(socket => socket.closed)).toBe(true)
    expect([...downstreamSockets].every(socket => socket.closed)).toBe(true)
  } finally {
    client?.destroy()
    try { await serving }
    finally { await Promise.all([close(upstream, upstreamSockets), close(downstream, downstreamSockets)]) }
  }
})

test('failed handshake settles only after its downstream transport closes', async () => {
  const upstream = createServer((_request, response) => { response.writeHead(403); response.write('denied') })
  const downstream = createServer(), upstreamSockets = track(upstream), downstreamSockets = track(downstream)
  const served = Promise.withResolvers<undefined>()
  let serving: Promise<void> | undefined, client: Socket | undefined
  try {
    const target = await listener(upstream)
    downstream.on('upgrade', (request, socket, head) => {
      serving = proxyRuntimeUpgrade(request, socket, head, target, {}, 2000).then(
        () => { throw new Error('Upgrade unexpectedly accepted') }, (error: unknown) => {
          expect(error).toMatchObject({ message: 'Native runtime upgrade refused (403)' })
          expect(socket.closed).toBe(true)
        })
      void serving.then(() => { served.resolve(undefined) }, served.reject)
    })
    const destination = await listener(downstream)
    client = createConnection({ host: destination.hostname, port: Number(destination.port) })
    client.on('error', () => {})
    await once(client, 'connect')
    const exited = once(client, 'close'); client.write(handshake)
    await served.promise; await exited
  } finally {
    client?.destroy()
    try { await serving }
    finally { await Promise.all([close(upstream, upstreamSockets), close(downstream, downstreamSockets)]) }
  }
})

class DeferredCloseTransport extends PassThrough {
  closing = Promise.withResolvers<undefined>()
  release = Promise.withResolvers<undefined>()

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.closing.resolve(undefined)
    void this.release.promise.then(() => { callback(error) })
  }
}

test('refusal waits for an asynchronously destroyed downstream before rejecting', async () => {
  const upstream = createServer((_request, response) => { response.writeHead(403); response.end('denied') })
  const downstream = createServer(), upstreamSockets = track(upstream), downstreamSockets = track(downstream)
  const transport = new DeferredCloseTransport(), started = Promise.withResolvers<undefined>()
  let serving: Promise<void> | undefined, client: Socket | undefined, settled = false
  try {
    const target = await listener(upstream)
    downstream.on('upgrade', (request, socket, head) => {
      socket.destroy()
      serving = proxyRuntimeUpgrade(request, transport, head, target, {}, 2000).then(
        () => { throw new Error('Upgrade unexpectedly accepted') }, (error: unknown) => {
          settled = true
          expect(error).toMatchObject({ message: 'Native runtime upgrade refused (403)' })
          expect(transport.closed).toBe(true)
        })
      void serving.catch(() => {})
      started.resolve(undefined)
    })
    const destination = await listener(downstream)
    client = createConnection({ host: destination.hostname, port: Number(destination.port) })
    client.on('error', () => {})
    await once(client, 'connect'); client.write(handshake)
    await started.promise
    await transport.closing.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    transport.release.resolve(undefined)
    await serving
    expect(settled).toBe(true)
  } finally {
    transport.release.resolve(undefined); transport.destroy(); client?.destroy()
    try { await serving }
    finally { await Promise.all([close(upstream, upstreamSockets), close(downstream, downstreamSockets)]) }
  }
})
