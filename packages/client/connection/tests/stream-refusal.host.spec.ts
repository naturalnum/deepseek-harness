import { createServer, request } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { bridge } from '../src/http-bridge.ts'
import { Peer } from '../src/peer.ts'

it('delivers a complete refusal over HTTP when streamed storage stops before the request ends', async () => {
  const finished = Promise.withResolvers<undefined>()
  let pulledBytes = 0
  let originalClosed = false
  const server = createServer((incoming, response) => {
    incoming.once('close', () => { originalClosed = true })
    void bridge(incoming, response, {
      requestBodyMode: () => 'streaming',
      fetch: async (input) => {
        if (input.body === null) throw new Error('Missing streamed request')
        const reader = input.body.getReader()
        const first = await reader.read()
        pulledBytes += first.value?.byteLength ?? 0
        await reader.cancel()
        return Response.json({ ok: false, error: { code: 'FS_IO_ERROR', outcome: 'not-published' } })
      },
    }, new Peer(new Context(), { principal: { kind: 'owner' } }))
      .then(() => { finished.resolve(undefined) }, finished.reject)
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => { server.once('listening', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing HTTP address')
  const client = request({ host: '127.0.0.1', port: address.port, method: 'POST',
    path: '/api/session/uploadFileBinary', headers: {
      'content-type': 'application/octet-stream', 'content-length': 64 * 1024 * 1024,
    } })
  try {
    const received = new Promise<{ status: number | undefined; connection: string | undefined; body: string }>((resolve, reject) => {
      client.once('error', reject)
      client.once('response', (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.once('error', reject)
        response.once('end', () => { resolve({ status: response.statusCode,
          connection: response.headers.connection, body: Buffer.concat(chunks).toString() }) })
      })
    })
    // Leave the body unfinished: a refused upload must receive its reason without draining 64MiB.
    client.write(Buffer.alloc(65536))
    expect(await received).toEqual({ status: 200, connection: 'close',
      body: '{"ok":false,"error":{"code":"FS_IO_ERROR","outcome":"not-published"}}' })
    await finished.promise
    expect(originalClosed).toBe(true)
    expect(pulledBytes).toBeGreaterThan(0)
    expect(pulledBytes).toBeLessThanOrEqual(65536)
  } finally {
    client.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
    await finished.promise
  }
})
