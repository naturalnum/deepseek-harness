import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { RemoteStreamMuxServer, rejectRemoteStreamUpgrade } from '../src/index.ts'

it('exports the native mux for an authenticated application carrier', () => {
  expect(RemoteStreamMuxServer).toBeTypeOf('function')
})

it.each([
  [401, 'Unauthorized'], [403, 'Forbidden'], [503, 'Service Unavailable'],
] as const)('rejects an upgrade with HTTP %i and its own closed body', async (status, reason) => {
  const socket = new PassThrough()
  const chunks: Buffer[] = []
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const ended = new Promise<void>(resolve => socket.once('end', resolve))
  rejectRemoteStreamUpgrade(socket, status)
  await ended
  const body = reason.toLowerCase()
  expect(Buffer.concat(chunks).toString()).toBe(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
})
