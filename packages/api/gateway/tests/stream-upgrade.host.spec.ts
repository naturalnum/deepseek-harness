import { PassThrough } from 'node:stream'
import { text } from 'node:stream/consumers'
import { describe, expect, it } from 'vitest'
import { rejectRemoteStreamUpgrade } from '../src/stream-server.ts'

describe('Remote stream upgrade rejection', () => {
  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [503, 'Service Unavailable'],
  ] as const)('closes an unadmitted socket with HTTP %s', async (status, reason) => {
    const socket = new PassThrough()
    const response = text(socket)
    rejectRemoteStreamUpgrade(socket, status)
    const body = reason.toLowerCase()
    expect(await response).toBe([
      `HTTP/1.1 ${String(status)} ${reason}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      '',
      body,
    ].join('\r\n'))
    expect(socket.writableEnded).toBe(true)
  })
})
