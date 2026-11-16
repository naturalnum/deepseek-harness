/** Explicit content-origin policy only; no listener, login or service is enabled. */
import { expect, it } from 'vitest'
import type { AccessConfig } from '../src/types.ts'
import { parseServiceApplicationConfig, serviceApplicationOrigin, type ServiceApplicationConfig } from '../src/application-policy.ts'

const access: AccessConfig = { deploymentMode: 'development', publicOrigin: 'http://console.auth.dsh.localhost:4100',
  servicePreview: { origin: 'http://text.auth.dsh.localhost:4100', cookieDomain: 'auth.dsh.localhost' },
  trustedProxyAddresses: [], authSecretRef: 'test-only-ref', sessionRecheckMs: 5000, authCheckTimeoutMs: 1000,
  maxPeers: 8, maxPeersPerAccount: 4, maxPeerWaiters: 16, maxPeerWaitersPerAccount: 8,
  maxPeerCarriers: 16, maxPeerCarriersPerAccount: 8, maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 1000,
  maxAuthOperations: 8, maxTrackedLogins: 8, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 8,
  bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' } }
function input(): ServiceApplicationConfig {
  return { origin: 'http://apps.dsh.localhost:4101', siteDomain: 'dsh.localhost', maxUrlBytes: 4096, maxPathBytes: 2048,
    maxRequestHeaderCount: 32, maxRequestHeaderBytes: 4096, maxRequestBodyBytes: 4096,
    maxQueuedRequests: 8, queueTimeoutMs: 3000,
    response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 512, maxHeaderCount: 32, maxHeaderBytes: 4096 },
    views: { maxViews: 8, maxViewsPerAccount: 4, maxRetainedBytes: 131072, maxFieldBytes: 128, lifetimeMs: 120000 } }
}

it('uses a separate host-only content origin outside the original auth Cookie domain', () => {
  const source = input(), parsed = parseServiceApplicationConfig(source, access)
  const id = 'a'.repeat(32)
  expect(serviceApplicationOrigin(parsed, id)).toBe('http://' + id + '.apps.dsh.localhost:4101')
  expect(parsed).toEqual(source)
  Reflect.set(source.views, 'maxViews', 1)
  expect(parsed.views.maxViews).toBe(8)
})

it.each(['http://apps.auth.dsh.localhost:4101', 'http://auth.dsh.localhost:4101',
  'http://console.auth.dsh.localhost:4100', 'http://apps.other.localhost:4101',
  'http://apps.dsh.localhost:4101/path', 'http://user:password@apps.dsh.localhost:4101'])('refuses unapproved content origin %s', (origin) => {
  expect(() => parseServiceApplicationConfig({ ...input(), origin }, access)).toThrow('isolated explicit origins')
})

it('rejects shared auth/content suffixes, non-loopback development HTTP and production HTTP', () => {
  expect(() => parseServiceApplicationConfig(input(), { ...access,
    servicePreview: { origin: 'http://text.dsh.localhost:4100', cookieDomain: 'dsh.localhost' } })).toThrow()
  expect(() => parseServiceApplicationConfig({ ...input(), origin: 'http://apps.example.test:4101', siteDomain: 'example.test' },
    { ...access, publicOrigin: 'http://console.auth.example.test:4100',
      servicePreview: { origin: 'http://text.auth.example.test:4100', cookieDomain: 'auth.example.test' } })).toThrow()
  expect(() => parseServiceApplicationConfig(input(), { ...access, deploymentMode: 'production' })).toThrow()
})
