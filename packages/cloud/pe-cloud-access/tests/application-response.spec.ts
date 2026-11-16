/** Bounded content policy over an explicit response double; no SDK or browser result is asserted. */
import { expect, it } from 'vitest'
import type { ApplicationReadResponse } from '@deepseek-ai/dsh-pe-opensandbox/types'
import { readServiceApplicationReply } from '../src/application-response.ts'

const limits = { maxBodyBytes: 128, maxChunkBytes: 64, maxChunks: 8, maxHeaderCount: 32, maxHeaderBytes: 4096 }
const origin = 'https://' + 'a'.repeat(32) + '.apps.example.test', management = 'https://console.auth.example.test'
function source(status = 200, body = '<button>page</button>', headers: Array<readonly [string, string]> = [['Content-Type', 'text/html']]) {
  const bytes = Buffer.from(body), closed: unknown[] = []
  let offset = 0
  const response: ApplicationReadResponse = { status, headers,
    async read(maximum) {
      if (offset === bytes.length) return null
      const chunk = bytes.subarray(offset, offset + maximum); offset += chunk.byteLength; return chunk
    }, async close(reason) { closed.push(reason) } }
  return { response, closed }
}
const read = (response: ApplicationReadResponse) => readServiceApplicationReply(response, limits, origin, management,
  new AbortController().signal, () => {})

it('preserves application status and MIME with platform CSP and strips cookies, CORS and response-control headers', async () => {
  const f = source(201, '{"counter":1}', [['Content-Type', 'application/json'], ['Set-Cookie', 'bad=1; Domain=example.test'],
    ['Access-Control-Allow-Origin', '*'], ['Clear-Site-Data', '"cookies"'], ['Refresh', '0;url=https://evil.test'],
    ['Content-Security-Policy', 'default-src *; frame-ancestors *']])
  const reply = await read(f.response)
  expect(reply.status).toBe(201); expect(Buffer.from(reply.body).toString()).toBe('{"counter":1}')
  expect(reply.headers['content-type']).toBe('application/json')
  expect(reply.headers['content-security-policy']).toContain("connect-src 'self'")
  expect(reply.headers['content-security-policy']).toContain('frame-ancestors ' + management)
  for (const name of ['set-cookie', 'access-control-allow-origin', 'clear-site-data', 'refresh']) expect(reply.headers[name]).toBeUndefined()
  expect(f.closed).toEqual([undefined])
})

it('rewrites only a selected SDK relative redirect to this same content origin', async () => {
  const f = source(302, '', [['Location', '/v1/sandboxes/sandbox-A/proxy/8000/next?q=1']])
  expect((await read(f.response)).headers.location).toBe('/next?q=1')
  const foreign = source(302, '', [['Location', 'https://evil.test/next']])
  await expect(read(foreign.response)).rejects.toThrow()
  expect(foreign.closed).toHaveLength(1)
})

it('rejects oversized bodies and duplicate lengths while still joining original response close', async () => {
  for (const f of [source(200, 'x'.repeat(129)), source(200, '', [['Content-Length', '0'], ['Content-Length', '0']])]) {
    await expect(read(f.response)).rejects.toThrow()
    expect(f.closed).toHaveLength(1)
  }
})

it('retains an unknown original close outcome', async () => {
  const f = source()
  f.response.close = async () => { throw new Error('Unconfirmed original response close') }
  await expect(read(f.response)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
})
