/** Browser network substitutes assert secret separation; this suite does not run a real Platform or executor. */
import { expect, test, vi } from 'vitest'
import { stdioEnvironmentSource } from '@power-evolve/contracts/stdio-environment'
import { StdioEnvironmentHttpClient } from '../src/client/stdio-environment-api.ts'
import { requestUrl, bodyText } from './fetch-fixture.ts'
import { id } from './stdio-v2-fixtures.ts'

const origin = 'https://platform.example.test'
const ref = { credentialVersion: id(30), keys: ['API_TOKEN', 'KEEP'] }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

test('environment replacement bytes go directly to trusted Platform while Host receives only key metadata', async () => {
  const host: string[] = [], uploads: RequestInit[] = [], bodies: string[] = []
  const request: typeof fetch = async (input, init) => {
    const url = requestUrl(input)
    if (url.endsWith('stdioV2EnvironmentReceipt')) return json({ environment: null })
    if (url.endsWith('stdioV2EnvironmentTicket')) {
      host.push(bodyText(init?.body))
      return json({ requestId: id(20), ticket: 'a'.repeat(43), uploadUrl: `${origin}/stdio-environment/upload`, expiresAt: '2099-01-01T00:00:00.000Z' })
    }
    if (url.endsWith('accountCapabilities')) return json({})
    if (url === '/config') return json({ approvalUrl: `${origin}/approval` })
    if (url === `${origin}/stdio-environment/upload`) { uploads.push(init!); bodies.push(await new Response(init?.body).text()); return json({ environment: ref }) }
    throw new Error(`Unexpected fixture URL: ${url}`)
  }
  const result = await new StdioEnvironmentHttpClient(request).prepare(id(20), [{ name: 'API_TOKEN', value: 'private-secret' }, { name: 'KEEP' }],
    stdioEnvironmentSource.parse({ connectionId: id(4), expectedRevision: 1, credentialVersion: id(10) }))
  expect(result).toEqual(ref)
  expect(host.join('')).not.toContain('private-secret')
  expect(JSON.parse(host[0]!)).toMatchObject({ request: { keys: [{ name: 'API_TOKEN', action: 'replace' }, { name: 'KEEP', action: 'retain' }] } })
  expect(uploads).toHaveLength(1)
  const upload = uploads[0]!
  expect(upload.credentials).toBe('omit'); expect(upload.redirect).toBe('error')
  expect(JSON.parse(bodies[0]!)).toEqual({ formatVersion: 1, values: [{ name: 'API_TOKEN', value: 'private-secret' }] })
})

test('an uncertain direct upload reads its original receipt without sending values through Host or starting a process', async () => {
  let reads = 0, uploads = 0
  const request: typeof fetch = async (input) => {
    const url = requestUrl(input)
    if (url.endsWith('stdioV2EnvironmentReceipt')) return json({ environment: ++reads === 1 ? null : ref })
    if (url.endsWith('stdioV2EnvironmentTicket')) return json({ requestId: id(20), ticket: 'a'.repeat(43),
      uploadUrl: `${origin}/stdio-environment/upload`, expiresAt: '2099-01-01T00:00:00.000Z' })
    if (url === '/config') return json({ approvalUrl: `${origin}/approval` })
    if (url === `${origin}/stdio-environment/upload`) { uploads++; throw new Error('Lost after commit') }
    throw new Error(`Unexpected fixture URL: ${url}`)
  }
  expect(await new StdioEnvironmentHttpClient(request).prepare(id(20), [{ name: 'API_TOKEN', value: 'secret' }])).toEqual(ref)
  expect(uploads).toBe(1); expect(reads).toBe(2)
})

test('a ticket cannot redirect secret bytes to another origin', async () => {
  let uploads = 0
  const request: typeof fetch = async (input) => {
    const url = requestUrl(input)
    if (url.endsWith('stdioV2EnvironmentReceipt')) return json({ environment: null })
    if (url.endsWith('stdioV2EnvironmentTicket')) return json({ requestId: id(20), ticket: 'a'.repeat(43),
      uploadUrl: 'https://untrusted.test/stdio-environment/upload', expiresAt: '2099-01-01T00:00:00.000Z' })
    if (url === '/config') return json({ approvalUrl: `${origin}/approval` })
    uploads++; throw new Error('Untrusted upload')
  }
  await expect(new StdioEnvironmentHttpClient(request).prepare(id(20), [{ name: 'API_TOKEN', value: 'secret' }])).rejects.toMatchObject({ status: 502 })
  expect(uploads).toBe(0)
})

test('empty environments need no capability while an existing receipt uses the original reference', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ environment: ref }))
  try {
    const client = new StdioEnvironmentHttpClient()
    expect(await client.prepare(id(20), [])).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    expect(await client.prepare(id(20), [{ name: 'API_TOKEN', value: 'private-secret' }])).toEqual(ref)
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toBe('/api/powerEvolve/stdioV2EnvironmentReceipt')
    expect(bodyText(request.mock.calls[0]?.[1]?.body)).not.toContain('private-secret')
  } finally { request.mockRestore() }
})

test.each([
  { uploadUrl: `${origin}/another-path` },
  { uploadUrl: 'https://user@platform.example.test/stdio-environment/upload' },
  { uploadUrl: 'https://:password@platform.example.test/stdio-environment/upload' },
  { uploadUrl: `${origin}/stdio-environment/upload?redirect=1` },
  { uploadUrl: `${origin}/stdio-environment/upload#fragment` },
  { requestId: id(21) },
  { expiresAt: '2020-01-01T00:00:00.000Z' },
])('rejects an altered or expired upload capability without sending any secret bytes: %j', async (changed) => {
  const request = vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input)
    if (url.endsWith('stdioV2EnvironmentReceipt')) return json({ environment: null })
    if (url.endsWith('stdioV2EnvironmentTicket')) return json({ requestId: id(20), ticket: 'a'.repeat(43),
      uploadUrl: `${origin}/stdio-environment/upload`, expiresAt: '2099-01-01T00:00:00.000Z', ...changed })
    if (url === '/config') return json({ approvalUrl: `${origin}/approval` })
    throw new Error('Unexpected direct upload')
  })
  await expect(new StdioEnvironmentHttpClient(request).prepare(id(20), [{ name: 'API_TOKEN', value: 'secret' }]))
    .rejects.toMatchObject({ status: 502 })
  expect(request.mock.calls.every(([input]) => !requestUrl(input).startsWith(`${origin}/stdio-environment/`))).toBe(true)
})

test.each(['missing-reference', 'rejected-upload', 'network-error'] as const)(
  'propagates %s after an empty original receipt and erases its private byte buffer', async (mode) => {
    let reads = 0
    let uploaded: Uint8Array | undefined
    const request: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url.endsWith('stdioV2EnvironmentReceipt')) { reads++; return json({ environment: null }) }
      if (url.endsWith('stdioV2EnvironmentTicket')) return json({ requestId: id(20), ticket: 'a'.repeat(43),
        uploadUrl: `${origin}/stdio-environment/upload`, expiresAt: '2099-01-01T00:00:00.000Z' })
      if (url === '/config') return json({ approvalUrl: `${origin}/approval` })
      if (url === `${origin}/stdio-environment/upload`) {
        if (!(init?.body instanceof Uint8Array)) throw new Error('Private byte buffer required')
        uploaded = init.body
        if (mode === 'network-error') throw new Error('Connection lost')
        return mode === 'rejected-upload' ? new Response('', { status: 403 }) : json({ environment: null })
      }
      throw new Error(`Unexpected fixture URL: ${url}`)
    }
    const operation = new StdioEnvironmentHttpClient(request).prepare(id(20), [{ name: 'API_TOKEN', value: 'secret' }])
    if (mode === 'network-error') await expect(operation).rejects.toThrow('Connection lost')
    else await expect(operation).rejects.toMatchObject({ status: mode === 'rejected-upload' ? 403 : 502 })
    expect(reads).toBe(2)
    expect(uploaded?.byteLength).toBeGreaterThan(0)
    expect(uploaded?.every(byte => byte === 0)).toBe(true)
  },
)
