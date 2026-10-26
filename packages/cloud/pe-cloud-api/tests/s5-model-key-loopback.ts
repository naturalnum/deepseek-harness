/** Bounded loopback stand-in; the shipping native adapter owns the complete model client and SSE parsing. */
import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { textEvents } from '../../../llm/llm-deepseek/tests/mock-server.ts'

const LIMITS = Object.freeze({ connections: 4, requests: 8, requestBytes: 16_384, totalBodyBytes: 98_304,
  headerBytes: 4096, responseBytes: 4096, timeoutMs: 5000 })

export interface ModelRequestObservation {
  readonly auth: string
  readonly bytes: number
  readonly path: string
  readonly bodyCanaryFree: boolean
}

/** Keys stay only in synthetic memory; evidence stores labels rather than header values. */
export async function modelKeyLoopback(keys: Readonly<Record<string, string>>) {
  const records: ModelRequestObservation[] = [], sockets = new Set<Socket>(), closed: Promise<void>[] = []
  let requests = 0, totalBodyBytes = 0, peakConnections = 0, connections = 0, connectionsClosed = 0
  let rejected = 0, activeHandlers = 0, peakHandlers = 0
  let hold: { received: ReturnType<typeof Promise.withResolvers<undefined>>
    gate: ReturnType<typeof Promise.withResolvers<undefined>> } | undefined
  const gates = new Set<ReturnType<typeof Promise.withResolvers<undefined>>>()
  const handlers = new Set<Promise<void>>()
  const wire = textEvents.map(event => 'data: ' + event + '\n\n').join('')
  if (Buffer.byteLength(wire) > LIMITS.responseBytes) throw new Error('Native SSE sample exceeds the response budget')
  const respond = (response: ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(wire)
  }
  const server = createServer({ maxHeaderSize: LIMITS.headerBytes }, (request, response) => {
    const work = (async () => {
      if (++requests > LIMITS.requests || request.method !== 'POST' || request.url !== '/v1/messages') {
        rejected++
        response.writeHead(400).end('fixture request rejected')
        return
      }
      activeHandlers++
      peakHandlers = Math.max(peakHandlers, activeHandlers)
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of request as AsyncIterable<Buffer>) {
          bytes += chunk.byteLength
          totalBodyBytes += chunk.byteLength
          if (bytes > LIMITS.requestBytes || totalBodyBytes > LIMITS.totalBodyBytes) {
            rejected++
            request.destroy()
            return
          }
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks).toString('utf8')
        const auth = Object.entries(keys).find(([_label, key]) => request.headers['x-api-key'] === key)?.[0] ?? 'unexpected'
        records.push({ auth, bytes, path: request.url, bodyCanaryFree: Object.values(keys).every(key => !body.includes(key)) })
        const pending = hold
        hold = undefined
        if (pending !== undefined) {
          pending.received.resolve(undefined)
          await pending.gate.promise
          gates.delete(pending.gate)
        }
        if (!response.destroyed) respond(response)
      } finally { activeHandlers-- }
    })()
    handlers.add(work)
    void work.catch((_error: unknown) => {
      rejected++
      response.destroy()
    }).finally(() => { handlers.delete(work) })
  })
  server.maxConnections = LIMITS.connections
  server.maxRequestsPerSocket = LIMITS.requests
  server.headersTimeout = LIMITS.timeoutMs
  server.requestTimeout = LIMITS.timeoutMs
  server.keepAliveTimeout = 200
  server.setTimeout(LIMITS.timeoutMs, (socket) => { socket.destroy() })
  server.on('connection', (socket) => {
    if (++connections > LIMITS.requests) { rejected++; socket.destroy(); return }
    sockets.add(socket)
    peakConnections = Math.max(peakConnections, sockets.size)
    closed.push(new Promise<void>((resolve) => {
      socket.once('close', () => { sockets.delete(socket); connectionsClosed++; resolve() })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1', backlog: LIMITS.connections }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback listener has no address')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    records,
    holdNext() {
      if (hold !== undefined || gates.size !== 0) throw new Error('Only one bounded response may be held')
      const next = { received: Promise.withResolvers<undefined>(), gate: Promise.withResolvers<undefined>() }
      hold = next
      gates.add(next.gate)
      return { received: next.received.promise, release: () => { next.gate.resolve(undefined) } }
    },
    async close() {
      for (const gate of gates) gate.resolve(undefined)
      gates.clear()
      const ended = new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
      server.closeAllConnections()
      await ended
      await Promise.all(closed)
      await Promise.allSettled([...handlers])
      return { listening: server.listening, addressCleared: server.address() === null,
        openSockets: sockets.size, activeHandlers, pendingGates: gates.size, connections, connectionsClosed,
        requests, totalBodyBytes, peakConnections, peakHandlers, rejected, limits: LIMITS,
        allRequestsWithinBudget: records.every(row => row.bytes <= LIMITS.requestBytes),
        allBodiesCanaryFree: records.every(row => row.bodyCanaryFree) }
    },
  }
}
