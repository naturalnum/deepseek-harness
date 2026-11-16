/** Actual selected-server HTTP methods/body over owned sockets; no installed SDK or browser acceptance. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { createSelectedServerHttp, type HttpRequestCharge } from '../src/application-http.ts'
import type { ApplicationHttpRequest, ApplicationReadResponse } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const transport = { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes: 1024,
  maxRequestHeaderBytes: 4096, maxPathBytes: 2048, timeoutMs: 2000, maxBufferPoolBytes: 8192 }
const limits = { maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 8, maxHeaderCount: 32, maxHeaderBytes: 1024 }

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>(), closed = new Set<Promise<void>>()
  const server = createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    const done = Promise.withResolvers<undefined>()
    closed.add(done.promise)
    socket.on('error', (_error: Error) => { /* Socket close remains the terminal observation. */ })
    socket.once('close', () => { sockets.delete(socket); closed.delete(done.promise); done.resolve(undefined) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No owned listener')
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    await Promise.all([...closed])
    expect(sockets.size).toBe(0)
  })
  const charges: HttpRequestCharge[] = [], terminals: Promise<void>[] = []
  const retainRequest = vi.fn((input: { charge: HttpRequestCharge; settled: Promise<void> }) => {
    charges.push(input.charge); terminals.push(input.settled)
    return { timeoutMs: input.charge.timeoutMs, assertCurrent() {} }
  })
  const service = createSelectedServerHttp({ lifecycleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'owned-method-fixture-only', limits: transport, assertCurrent() {} },
  { sandboxId: 'owned-method-service', port: 8000, deadlineAtMs: performance.now() + 10000, assertCurrent() {} },
  { retainRequest })
  return { service, charges, terminals, retainRequest }
}

async function read(response: ApplicationReadResponse): Promise<string> {
  const chunks: Uint8Array[] = []
  for (;;) {
    const chunk = await response.read(limits.maxChunkBytes)
    if (chunk === null) break
    chunks.push(chunk)
  }
  await response.close()
  return Buffer.concat(chunks).toString()
}

it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('forwards bounded %s body and query to the original fixed service', async (method) => {
  const seen: string[] = []
  const f = await fixture((req, res) => {
    expect(req.method).toBe(method)
    expect(req.url).toBe('/v1/sandboxes/owned-method-service/proxy/8000/api/counter?x=1&x=2')
    expect(req.headers['open-sandbox-api-key']).toBe('owned-method-fixture-only')
    expect(req.headers.cookie).toBeUndefined()
    expect(req.headers.authorization).toBeUndefined()
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers['content-length']).toBe('6')
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { seen.push(chunk) })
    req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(method + ':' + seen.join('')) })
  })
  const backing = new Uint8Array(32)
  backing.set(Buffer.from('update'))
  const body = backing.subarray(0, 6)
  let value = ''
  await f.service.withResponse({ method, resourcePath: '/api/counter?x=1&x=2', body,
    headers: [['content-type', 'application/json']] }, limits, new AbortController().signal, async (response) => {
    expect(response.status).toBe(201)
    value = await read(response)
  })
  await Promise.all(f.terminals)
  expect(value).toBe(method + ':update')
  expect(f.charges).toHaveLength(1)
  expect(f.charges[0]?.retainedPayloadBytes).toBe(limits.maxBodyBytes + 1 + limits.maxChunkBytes
    + 2 * transport.prefetchBytes + 4 * transport.readBufferBytes
    + 8 * (transport.maxRequestHeaderBytes + limits.maxHeaderBytes) + 2 * Buffer.poolSize + 2 * backing.byteLength)
  expect(f.charges[0]?.headerEntries).toBe(limits.maxHeaderCount + 1 + 5)
})

it('refuses unsupported HEAD, GET bodies, credentials and oversized backing storage before retaining or sending', async () => {
  const handler = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('unexpected') })
  const f = await fixture(handler)
  const requests: ApplicationHttpRequest[] = [
    { method: 'HEAD', resourcePath: '/', headers: [] },
    { method: 'GET', resourcePath: '/', headers: [], body: new Uint8Array(0) },
    { method: 'POST', resourcePath: '/', headers: [['cookie', 'not-forwarded']] },
    { method: 'POST', resourcePath: '/', headers: [['authorization', 'not-forwarded']] },
    { method: 'POST', resourcePath: '/', headers: [], body: new Uint8Array(transport.maxWireBytes + 1).subarray(0, 1) },
  ]
  for (const request of requests) {
    await expect(f.service.withResponse(request, limits, new AbortController().signal, async () => {})).rejects.toThrow()
  }
  expect(f.retainRequest).not.toHaveBeenCalled()
  expect(handler).not.toHaveBeenCalled()
})
