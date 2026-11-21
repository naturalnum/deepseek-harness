/** Actual Unix transport with a controlled peer. Chromium isolation is verified separately. */
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { crc32, deflateSync } from 'node:zlib'
import { expect, it, onTestFinished, vi } from 'vitest'
import { assertIpApplicationRendererSocket, FRAME_HEIGHT, FRAME_WIDTH, IpApplicationPreviewConfigSchema, IpApplicationRenderer,
  parseIpApplicationPreviewConfig, readViewAction, type IpApplicationPreviewConfig } from '../src/ip-application-renderer.ts'

const config: IpApplicationPreviewConfig = {
  socketPath: '/run/pe-preview/render.sock', maxFrameBytes: 4096, maxReadsPerTurn: 1, maxResourcePathBytes: 128,
  maxRequestBodyBytes: 512, closeTimeoutMs: 100,
  response: { maxBodyBytes: 512, maxChunkBytes: 256, maxChunks: 4, maxHeaderCount: 8, maxHeaderBytes: 128 },
  views: { maxViews: 3, maxViewsPerAccount: 2, maxRetainedBytes: 65536, maxFieldBytes: 128, lifetimeMs: 1000 },
}
function chunk(name: string, body: Buffer): Buffer {
  const chunk = Buffer.alloc(body.length + 12)
  chunk.writeUInt32BE(body.length)
  chunk.write(name, 4, 'ascii')
  body.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(FRAME_WIDTH)
ihdr.writeUInt32BE(FRAME_HEIGHT, 4)
ihdr[8] = 8
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.alloc(FRAME_HEIGHT * (FRAME_WIDTH + 1)))), chunk('IEND', Buffer.alloc(0))])
const signal = new AbortController().signal
const fixtureReply = { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('private') }

async function fixture(handler: (incoming: Record<string, unknown>, socket: Socket) => object | undefined) {
  const folder = await mkdtemp(join(tmpdir(), 'pe-preview-'))
  const socketPath = join(folder, 'r.sock')
  const wire: Array<Record<string, unknown>> = []
  let ticket: unknown
  const server = createServer((socket) => {
    socket.on('error', (_error: Error) => { /* The test peer may deliberately lose the Access channel. */ })
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>
      wire.push(message)
      if (message.kind === 'register') ticket = message.ticket
      const outgoing = message.kind === 'register' ? { kind: 'registered', ticket }
        : message.kind === 'open' || message.kind === 'forget' ? handler(message, socket)
          ?? { kind: message.kind === 'open' ? 'opened' : 'forgotten', ticket } : handler(message, socket)
      if (outgoing && 'kind' in outgoing && outgoing.kind === 'closed' && !('ticket' in outgoing)) Object.assign(outgoing, { ticket })
      if (outgoing && !socket.destroyed) socket.write(JSON.stringify(outgoing) + '\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
  await chmod(socketPath, 0o660)
  const renderer = new IpApplicationRenderer({ ...config, socketPath })
  onTestFinished(async () => {
    await renderer.close().catch(() => {})
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(folder, { recursive: true })
  })
  return { renderer, socketPath, wire }
}

it('requires HTTPS with a canonical IPv4 origin and bounds renderer inputs', () => {
  expect(parseIpApplicationPreviewConfig(IpApplicationPreviewConfigSchema(config), 'https://139.198.27.71')).toEqual(config)
  for (const origin of ['https://preview.example.test', 'http://127.0.0.1', 'https://[::1]']) {
    expect(() => parseIpApplicationPreviewConfig(config, origin)).toThrow()
  }
  expect(() => parseIpApplicationPreviewConfig({ ...config, socketPath: '/tmp/../render.sock' }, 'https://127.0.0.1')).toThrow()
  expect(readViewAction({ kind: 'click', x: 1, y: 1 })).toEqual({ kind: 'click', x: 1, y: 1 })
  expect(readViewAction({ kind: 'click', x: FRAME_WIDTH, y: 1 })).toBeUndefined()
  expect(readViewAction({ kind: 'frame', sessionId: 'other' })).toBeUndefined()
})

it('sends only the fixed turn and scoped read reply across the private connection and joins close acknowledgement', async () => {
  const { renderer, socketPath, wire } = await fixture((message) => {
    if (message.kind === 'frame') return { kind: 'read', path: '/asset.js?v=2' }
    if (message.kind === 'resource') return { kind: 'frame', png: png.toString('base64') }
    if (message.kind === 'close') return { kind: 'closed' }
  })
  const read = vi.fn(async (_path: string) => fixtureReply)
  await assertIpApplicationRendererSocket(socketPath)
  await expect(renderer.render({ kind: 'frame' }, read, signal)).resolves.toEqual(png)
  expect(read.mock.calls).toEqual([['/asset.js?v=2']])
  await renderer.close()
  expect(wire).toEqual([{ kind: 'register', ticket: expect.stringMatching(/^[a-f0-9]{64}$/) }, { kind: 'open', ticket: wire[0]?.ticket },
    { kind: 'frame' }, { kind: 'resource', status: 200, headers: fixtureReply.headers,
      body: fixtureReply.body.toString('base64') }, { kind: 'close' }, { kind: 'forget', ticket: wire[0]?.ticket }])
})

it.each(['https://other.invalid/', '//other.invalid/', '/a/%2f/b'])('rejects %s before its authorized relay can run', async (path) => {
  const { renderer } = await fixture(message => message.kind === 'close' ? { kind: 'closed' }
    : message.kind === 'frame' ? { kind: 'read', path } : undefined)
  const read = vi.fn(async () => fixtureReply)
  await expect(renderer.render({ kind: 'frame' }, read, signal)).rejects.toThrow('relay path')
  expect(read).not.toHaveBeenCalled()
})

it('rejects a non-PNG frame and refuses to report retirement without the private acknowledgement', async () => {
  const { renderer } = await fixture(message => message.kind === 'frame' ? { kind: 'frame', png: 'dGV4dA==' } : undefined)
  await expect(renderer.render({ kind: 'frame' }, async () => fixtureReply, signal)).rejects.toThrow('frame')
  await expect(renderer.close()).rejects.toThrow()
})

it('rejects lost, wrong-ticket and failed receipts, then retries only the original ticket', async () => {
  let recoveries = 0
  const { renderer, wire } = await fixture((message, socket) => {
    if (message.kind === 'frame') return { kind: 'frame', png: png.toString('base64') }
    if (message.kind === 'close') { socket.destroy(); return }
    if (message.kind === 'recover') {
      recoveries++
      if (recoveries === 1) return { kind: 'closed', ticket: 'b'.repeat(64) }
      if (recoveries === 2) return { kind: 'failed' }
      return { kind: 'closed', ticket: message.ticket }
    }
  })
  await expect(renderer.render({ kind: 'frame' }, async () => fixtureReply, signal)).resolves.toEqual(png)
  await expect(renderer.close()).rejects.toThrow('close unconfirmed')
  await expect(renderer.render({ kind: 'frame' }, async () => fixtureReply, signal)).rejects.toThrow('revoked')
  await expect(renderer.close()).rejects.toThrow('close unconfirmed')
  await expect(renderer.close()).resolves.toBeUndefined()
  await vi.waitFor(() => expect(wire.filter(row => row.kind === 'forget')).toHaveLength(1))
  expect(wire.filter(row => row.kind === 'recover')).toEqual(Array(3).fill({ kind: 'recover', ticket: wire[0]?.ticket }))
})

it('reconciles the registered ticket when opened is lost without submitting any frame', async () => {
  const { renderer, wire } = await fixture((message, socket) => { if (message.kind === 'open') socket.destroy() })
  await expect(renderer.render({ kind: 'frame' }, async () => fixtureReply, signal)).rejects.toThrow()
  await renderer.close()
  expect(wire.map(row => row.kind)).toEqual(['register', 'open', 'forget'])
  expect(wire[2]?.ticket).toBe(wire[0]?.ticket)
})

it('requires confirmed record removal and repeats forget idempotently on an independent channel', async () => {
  let forgets = 0
  const { renderer, wire } = await fixture((message, socket) => {
    if (message.kind === 'frame') return { kind: 'frame', png: png.toString('base64') }
    if (message.kind === 'close') return { kind: 'closed' }
    if (message.kind === 'forget' && ++forgets <= 2) socket.destroy()
  })
  await renderer.render({ kind: 'frame' }, async () => fixtureReply, signal)
  await expect(renderer.close()).rejects.toThrow('close unconfirmed')
  await renderer.close()
  expect(wire.map(row => row.kind)).toEqual(['register', 'open', 'frame', 'close', 'forget', 'forget', 'forget'])
  expect(wire.filter(row => row.kind === 'forget').every(row => row.ticket === wire[0]?.ticket)).toBe(true)
})
