/** Actual native Client RPC decoding preserves bytes across the bounded private JSON hop. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, test } from 'vitest'
import { createWebConnectionRpc } from '../../../../packages/client/connection/src/client/rpc.ts'
import { nativeRuntimeResponse, sendNativeRuntimeResponse } from '../src/host/native-rpc-response.ts'
import { readJson, sendFailure } from '../src/http.ts'
import { z } from 'zod'

test('the original browser caller receives nested, root and empty Uint8Array attachments after an actual HTTP relay', async () => {
  const first = new Uint8Array([0, 128, 255]), second = new Uint8Array([3, 4]), pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        const message = z.object({ rpcId: z.string(), method: z.string() }).loose().parse(await readJson(request, 4096))
        const encoded = message.method.endsWith('root')
          ? { ok: true as const, value: null, attachments: [{ path: [], bytes: first }] }
          : { ok: true as const, value: { content: null, items: [null, { bytes: null }] },
            attachments: [{ path: ['content'], bytes: first }, { path: ['items', 0], bytes: new Uint8Array() },
              { path: ['items', 1, 'bytes'], bytes: second }] }
        const relayed: unknown = JSON.parse(JSON.stringify(nativeRuntimeResponse(message.rpcId, encoded)))
        await sendNativeRuntimeResponse(response, message.rpcId, relayed, 1048576)
      } catch (error) { sendFailure(response, error) }
    })()
    pending.add(work); void work.finally(() => { pending.delete(work) })
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned carrier listener missing')
    const caller = createWebConnectionRpc((path, init) => fetch(new URL(path, `http://127.0.0.1:${address.port}/native/`), init))
    expect(await caller.call('/api', 'fixture/nested', { args: {} })).toEqual({ ok: true,
      value: { content: first, items: [new Uint8Array(), { bytes: second }] } })
    expect(await caller.call('/api', 'fixture/root', { args: {} })).toEqual({ ok: true, value: first })
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve,
      reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    await Promise.allSettled(pending)
  }
})

test.each(['correlation', 'base64', 'path',
  'budget'] as const)('private byte carrier refuses malformed %s before writing the original response', async (kind) => {
  const encoded = nativeRuntimeResponse('original', { ok: true, value: { content: null },
    attachments: [{ path: ['content'], bytes: new Uint8Array([1]) }] })
  const value = z.object({ rpcId: z.string(), attachments: z.array(z.object({ path: z.array(z.union([z.string(),
    z.number()])), data: z.string() }).loose()) }).loose().parse(encoded)
  if (kind === 'correlation') value.rpcId = 'another'
  if (kind === 'base64') value.attachments[0]!.data = 'not canonical base64'
  if (kind === 'path') value.attachments[0]!.path = ['missing']
  const server = createServer((_request, response) => {
    void sendNativeRuntimeResponse(response, 'original', value,
      kind === 'budget' ? 1 : 1048576).catch((error: unknown) => { sendFailure(response, error) })
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned carrier listener missing')
    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve,
      reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
})
