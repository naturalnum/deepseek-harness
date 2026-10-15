/** Real HTTP native model transport: original requests, opaque replay and joined cancellation. */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { expect, onTestFinished, test } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { nativeModelPreparationId } from '../src/model-runtime-contracts.ts'
import { streamNativeModel } from '../src/host/native-model-stream.ts'

const preparationId = nativeModelPreparationId.parse(randomUUID())

async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const failures: unknown[] = []
  const server = createServer((req, res) => {
    void Promise.resolve().then(() => handler(req, res)).catch((error: unknown) => { failures.push(error); res.destroy() })
  })
  onTestFinished(() => { if (failures.length) throw new AggregateError(failures, 'Owned stream peer failed') })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Owned model peer address unavailable')
  return { platformUrl: `http://127.0.0.1:${address.port}`, maxResponseBytes: 1_048_576, streamIdleTimeoutMs: 5000 }
}
function request(): GenerateOptions {
  return { provider: 'owned-anthropic', model: 'owned-model', sessionId: brandString<SessionId>(randomUUID()), messages: [] }
}
async function collect(source: AsyncIterable<StreamChunk>) {
  const values: StreamChunk[] = []
  for await (const value of source) values.push(value)
  return values
}

test('keeps native request fields and opaque replay unchanged over split UTF-8 chunks', async () => {
  const input = request(), calls: { url: string | undefined; auth: string | undefined; body: unknown }[] = []
  const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '模型🙂' },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { provider: 'anthropic', opaque: ['owned', { id: 3 }] }, blocks: [{ signature: 'unmodified' }] } }]
  const config = await peer(async (req, res) => {
    const bytes: Buffer[] = []; for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Owned peer expected byte chunks')
      bytes.push(chunk)
    }
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(bytes).toString()) })
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const wire = Buffer.from(chunks.map(chunk => JSON.stringify(chunk) + '\n').join(''))
    for (const byte of wire) res.write(Buffer.from([byte]))
    res.end()
  })
  expect(await collect(streamNativeModel(config, 'original-operation-bearer', input, preparationId))).toEqual(chunks)
  expect(calls).toEqual([{ url: '/runtime/models/stream', auth: 'Bearer original-operation-bearer', body: { ...input, preparationId } }])
})

test('preserves a provider failure finish instead of translating its native failure facts', async () => {
  const finish: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider quota', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 1200 } } }
  const config = await peer((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(JSON.stringify(finish) + '\n') })
  expect(await collect(streamNativeModel(config, 'operation', request(), preparationId))).toEqual([finish])
})

test('consumer return aborts and joins the original HTTP response', async () => {
  const closed = Promise.withResolvers<undefined>()
  const config = await peer((_req, res) => {
    res.once('close', () => { closed.resolve(undefined) })
    res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write(JSON.stringify({ type: 'text-delta', index: 0, text: 'one' }) + '\n')
  })
  for await (const chunk of streamNativeModel(config, 'operation', request(), preparationId)) { expect(chunk.type).toBe('text-delta'); break }
  await closed.promise
})

test('caller cancellation settles a blocked response without a replacement dispatch', async () => {
  const connected = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>(); let calls = 0
  const config = await peer((_req, res) => { calls++; res.once('close', () => { closed.resolve(undefined) }); res.writeHead(200,
    { 'content-type': 'application/x-ndjson' }); res.flushHeaders(); connected.resolve(undefined) })
  const controller = new AbortController(), result = collect(streamNativeModel(config, 'operation', { ...request(), signal: controller.signal }, preparationId))
  const failure = expect(result).rejects.toMatchObject({ code: 'ABORTED' })
  await connected.promise; controller.abort(); await failure; await closed.promise
  expect(calls).toBe(1)
})

test('idle timeout cancels and joins the actual response', async () => {
  const closed = Promise.withResolvers<undefined>()
  const config = await peer((_req, res) => { res.once('close', () => { closed.resolve(undefined) }); res.writeHead(200,
    { 'content-type': 'application/x-ndjson' }); res.flushHeaders() })
  await expect(collect(streamNativeModel({ ...config, streamIdleTimeoutMs: 20 }, 'operation', request(), preparationId))).rejects.toMatchObject({ code: 'TIMEOUT' })
  await closed.promise
})

test.each([
  ['missing finish', JSON.stringify({ type: 'text-delta', index: 0, text: 'partial' }) + '\n', 'STREAM_CLOSED'],
  ['partial line', JSON.stringify({ type: 'finish', reason: { kind: 'stop' } }), 'STREAM_CLOSED'],
  ['data after finish', JSON.stringify({ type: 'finish', reason: { kind: 'stop' } }) + '\n' + JSON.stringify({ type: 'text-delta', index: 0, text: 'late' }) + '\n', 'STREAM_CLOSED'],
  ['invalid chunk', JSON.stringify({ type: 'text-delta', index: 0, text: 'one', apiKey: 'forbidden-extra-field' }) + '\n', 'TRANSPORT'],
] as const)('rejects %s from the actual NDJSON peer', async (_label, wire, code) => {
  const config = await peer((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(wire) })
  await expect(collect(streamNativeModel(config, 'operation', request(), preparationId))).rejects.toMatchObject({ code })
})

test('enforces the complete response byte limit with multibyte output', async () => {
  const config = await peer((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(JSON.stringify({ type: 'text-delta', index: 0, text: '多'.repeat(100) }) + '\n') })
  await expect(collect(streamNativeModel({ ...config, maxResponseBytes: 100 }, 'operation', request(), preparationId))).rejects.toMatchObject({ code: 'TRANSPORT' })
})
