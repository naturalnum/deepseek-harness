/** Original bound transport with explicit HTTP responses; no browser Cookie, backend or sandbox acceptance. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudServiceApplicationPolicy } from '../src/types.ts'
import { BoundTransport } from '../src/client/transport.ts'

const policy = { managementOrigin: 'https://console.auth.example.test', contentOrigin: 'https://apps.example.test',
  requestTimeoutMs: 1000, maxRequestBytes: 1024, maxResponseBytes: 2048, maxFieldBytes: 128 }
const origin = 'https://' + 'a'.repeat(32) + '.apps.example.test'
const proof = 'b'.repeat(64)
const selection = { sessionId: SessionId('session-A'), serviceHandle: 'service-A' }

function fixture(fetch: RpcFetch, serviceApplications: CloudServiceApplicationPolicy = policy) {
  return new BoundTransport({ baseUrl: serviceApplications.managementOrigin + '/', fetch, serviceApplications,
    fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    expectation: { accountId: 'account-A', connectionGeneration: 'generation-A' },
    limits: { maxPendingFetches: 1, maxSockets: 1, maxErrorResponseBytes: 512, closeTimeoutMs: 1000 },
    createWebSocket: () => { throw new Error('No socket in launch fixture') } })
}

it('keeps proof in its POST body and returns only the clean confirmed content URL', async () => {
  const fetch = vi.fn<RpcFetch>().mockResolvedValueOnce(Response.json({ origin, proof }))
    .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 204 }))
  const transport = fixture(fetch)
  try {
    expect(await transport.serviceApplicationNavigationUrl(selection)).toBe(origin + '/')
    expect(fetch).toHaveBeenCalledTimes(3)
    const calls = fetch.mock.calls
    expect(calls.map(([target]) => String(target))).toEqual([policy.managementOrigin + '/cloud/service-application',
      origin + '/.well-known/dsh-service-preview/authorize', origin + '/.well-known/dsh-service-preview/ready'])
    expect(calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: {
      'x-pe-account': 'account-A', 'x-pe-generation': 'generation-A' } })
    expect(calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ proof }) })
    expect(calls[2]?.[1]).toMatchObject({ method: 'GET', credentials: 'include' })
    expect(calls.every(([target]) => !String(target).includes(proof))).toBe(true)
    expect(transport.getSnapshot().pendingFetches).toBe(0)
  } finally { await transport.close() }
})

it.each(['https://evil.test', origin + '?proof=' + proof, policy.managementOrigin])('refuses an unexpected launch origin %s before sending its proof', async (returned) => {
  const fetch = vi.fn<RpcFetch>().mockResolvedValueOnce(Response.json({ origin: returned, proof }))
  const transport = fixture(fetch)
  try {
    await expect(transport.serviceApplicationNavigationUrl(selection)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { await transport.close() }
})

it('keeps its original capacity and close join while a late launch response remains unresolved', async () => {
  const gate = Promise.withResolvers<Response>(), fetch = vi.fn<RpcFetch>(() => gate.promise)
  const transport = fixture(fetch), launched = transport.serviceApplicationNavigationUrl(selection)
  const failed = expect(launched).rejects.toThrow()
  expect(() => transport.serviceApplicationNavigationUrl(selection)).toThrow()
  const closing = transport.close()
  expect(transport.getSnapshot().pendingFetches).toBe(1)
  gate.resolve(Response.json({ origin, proof }))
  await failed; await closing
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(transport.getSnapshot()).toMatchObject({ phase: 'closed', pendingFetches: 0 })
})

it('creates a fixed same-origin viewer URL from the authenticated launch without a proof or content handoff', async () => {
  const { contentOrigin: _content, ...limits } = policy
  const ipPolicy = { ...limits, mode: 'ip-render' as const, managementOrigin: 'https://139.198.27.71' }
  const viewId = 'c'.repeat(32)
  const fetch = vi.fn<RpcFetch>().mockResolvedValueOnce(Response.json({ viewId }))
    .mockResolvedValueOnce(Response.json({ viewId, origin: 'https://other.invalid' }))
  const transport = fixture(fetch, ipPolicy)
  try {
    expect(await transport.serviceApplicationNavigationUrl(selection)).toBe(ipPolicy.managementOrigin + '/cloud/service-application-view?view=' + viewId)
    await expect(transport.serviceApplicationNavigationUrl(selection)).rejects.toThrow()
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(Array(2).fill(ipPolicy.managementOrigin + '/cloud/service-application'))
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'x-pe-account': 'account-A' } })
  } finally { await transport.close() }
})
