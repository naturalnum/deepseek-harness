/** Fixed-origin policy and real Better Auth cookie/no-cookie paths; no DB, browser or network is used. */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCookies } from 'better-auth/cookies'
import type { Auth, BetterAuthOptions } from 'better-auth'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccessConfig } from '../src/types.ts'
import { parseAccessConfig, AccessConfigSchema } from '../src/config.ts'
import { assertAuthTransport } from '../src/auth-trust.ts'
import { BetterAuthAccess } from '../src/auth.ts'

const requestId = 'preview-origin-test' as Branded<'pe-request-id'>
const previewInput = { kind: 'service-preview', method: 'GET', url: '/cloud/service-preview' } as const
const adapters: BetterAuthAccess[] = [], pools: pg.Pool[] = [], sockets: Socket[] = []
function baseConfig(): AccessConfig {
  return {
    publicOrigin: 'https://console.dsh.example.test', deploymentMode: 'production', trustedProxyAddresses: [], authSecretRef: 'test-reference',
    sessionRecheckMs: 50, authCheckTimeoutMs: 500, maxPeers: 4, maxPeersPerAccount: 2,
    maxPeerWaiters: 32, maxPeerWaitersPerAccount: 24, maxPeerCarriers: 16, maxPeerCarriersPerAccount: 8,
    maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 500, maxAuthOperations: 8,
    maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 8,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
}
function previewConfig(): AccessConfig {
  return { ...baseConfig(), servicePreview: { origin: 'https://preview.dsh.example.test', cookieDomain: 'dsh.example.test' } }
}
function headersRaw(headers: Record<string, string>): string[] { return Object.entries(headers).flatMap(([name, value]) => [name, value]) }
function check(
  headers: Record<string, string>, config = previewConfig(), transport: Parameters<typeof assertAuthTransport>[6] = previewInput,
  raw = headersRaw(headers), address?: string, secure = true,
): void { assertAuthTransport(headers, raw, address, secure, config, requestId, transport) }
function request(host: string, url: string = previewInput.url, method = 'GET', extra: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket(); sockets.push(socket)
  Object.defineProperty(socket, 'encrypted', { value: true })
  const req = new IncomingMessage(socket)
  req.method = method; req.url = url; req.headers = { host, ...extra }; req.rawHeaders = headersRaw({ host, ...extra })
  return req
}
async function create(config: AccessConfig): Promise<BetterAuthAccess> {
  // The real library is initialized with an unconnected real pool. Any accidental SQL admission fails before network.
  const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 50 }); pools.push(pool)
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('DB/network is outside this candidate check') })
  vi.spyOn(pool, 'query').mockImplementation(() => { throw new Error('DB/network is outside this candidate check') })
  const adapter = await BetterAuthAccess.create(config, pool, 'candidate-dummy-secret-longer-than-thirty-two-characters', async () => {})
  adapters.push(adapter); return adapter
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()))
  for (const pool of pools.splice(0)) {
    await pool.end(); expect(pool.totalCount).toBe(0); expect(pool.idleCount).toBe(0)
  }
  for (const socket of sockets.splice(0)) socket.destroy()
  vi.restoreAllMocks()
})

describe('optional fixed preview deployment inputs', () => {
  it('preserves omitted schema/config values and existing management-only HTTP acceptance', () => {
    expect(parseAccessConfig(baseConfig())).toStrictEqual(baseConfig())
    expect(AccessConfigSchema(baseConfig())).toStrictEqual(baseConfig())
    expect(Object.hasOwn(parseAccessConfig(baseConfig()), 'servicePreview')).toBe(false)
    for (const publicOrigin of ['http://localhost:4100', 'http://127.0.0.1:4100', 'http://[::1]:4100']) {
      expect(parseAccessConfig({ ...baseConfig(), deploymentMode: 'development', publicOrigin }).publicOrigin).toBe(publicOrigin)
    }
    expect(() => parseAccessConfig({ ...baseConfig(), deploymentMode: 'development', publicOrigin: 'http://console.dsh.localhost:4100' })).toThrow()
  })
  it('accepts one fixed HTTPS pair or standard localhost subdomains in explicit development preview configuration', () => {
    expect(parseAccessConfig(previewConfig())).toStrictEqual(previewConfig())
    const dev: AccessConfig = { ...baseConfig(), deploymentMode: 'development', publicOrigin: 'http://console.dsh.localhost:4100',
      servicePreview: { origin: 'http://preview.dsh.localhost:4100', cookieDomain: 'dsh.localhost' } }
    expect(parseAccessConfig(dev)).toStrictEqual(dev)
    expect(() => parseAccessConfig({ ...dev, deploymentMode: 'production' })).toThrow()
  })
  it.each([
    'https://preview.dsh.example.test/', 'https://preview.dsh.example.test/path', 'https://preview.dsh.example.test?x=1',
    'https://preview.dsh.example.test#x', 'https://u:p@preview.dsh.example.test', 'https://PREVIEW.dsh.example.test',
    'https://preview.dsh.example.test:443', 'http://preview.dsh.example.test', 'file:///preview',
    'https://console.dsh.example.test', 'https://console.dsh.example.test:4100',
    'https://outside.example.test', 'https://dsh.example.test', 'https://evildsh.example.test',
  ])('rejects unapproved preview origin %s', (origin) => {
    expect(() => parseAccessConfig({ ...previewConfig(), servicePreview: { origin, cookieDomain: 'dsh.example.test' } })).toThrow()
  })
  it.each(['.dsh.example.test', 'DSH.example.test', 'test', 'dsh.example.test.', 'bad..test', '-bad.test', 'bad-.test',
    'dsh.example.test:443', 'dsh.example.test/path', 'dsh_example.test', '例子.test', '127.0.0.1', 'localhost'])('rejects invalid cookie suffix %s', (cookieDomain) => {
    expect(() => parseAccessConfig({ ...previewConfig(), servicePreview: { origin: 'https://preview.dsh.example.test', cookieDomain } })).toThrow()
  })
  it.each(['http://console.localhost.evil:4100', 'http://console.example.test:4100', 'http://notlocalhost:4100',
    'http://console..localhost:4100', 'http://-console.localhost:4100'])('rejects non-loopback development management origin %s', (publicOrigin) => {
    expect(() => parseAccessConfig({ ...previewConfig(), publicOrigin, deploymentMode: 'development' })).toThrow()
  })
  it('rejects malformed optional fields and configurable paths instead of expanding the fixed read route', () => {
    for (const servicePreview of [null, {}, { origin: 'https://preview.dsh.example.test' },
      { cookieDomain: 'dsh.example.test' }, { origin: 42, cookieDomain: 'dsh.example.test' },
      { origin: 'https://preview.dsh.example.test', cookieDomain: 'dsh.example.test', path: '/cloud/auth' }]) {
      expect(() => parseAccessConfig({ ...baseConfig(), servicePreview })).toThrow()
    }
    expect(() => parseAccessConfig({ ...previewConfig(), publicOrigin: 'https://127.0.0.1' })).toThrow()
    expect(() => parseAccessConfig({ ...previewConfig(), publicOrigin: 'https://console.dsh.example.test/' })).toThrow()
  })
})

describe('one shared original transport guard', () => {
  const previewHeaders = { host: 'preview.dsh.example.test' }
  it('allows only explicit preview GET with canonical exact path and optional query, retaining the original origin rule', () => {
    check(previewHeaders)
    check({ ...previewHeaders, origin: 'https://preview.dsh.example.test' })
    check(previewHeaders, previewConfig(), { ...previewInput, url: '/cloud/service-preview?path=%2Fstatus&peAccount=a' })
    expect(() => { check(previewHeaders, baseConfig()) }).toThrow()
    expect(() => { check(previewHeaders, previewConfig(), 'http') }).toThrow()
    expect(() => { check({ ...previewHeaders, origin: baseConfig().publicOrigin }) }).toThrow()
    expect(() => { check({ ...previewHeaders, origin: 'null' }) }).toThrow()
    expect(() => { check({ host: 'console.dsh.example.test' }) }).toThrow()
  })
  it.each(['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'get', undefined])('rejects preview method %s', (method) => {
    expect(() => { check(previewHeaders, previewConfig(), { ...previewInput, method }) }).toThrow()
  })
  it.each([
    '/cloud/auth', '/cloud/auth/get-session', '/cloud/bootstrap', '/api/session/list', '/cloud/native', '/cloud/service-preview/',
    '/cloud/service-preview/child', '/cloud/%73ervice-preview', '/cloud/./service-preview', '//preview.dsh.example.test/cloud/service-preview',
    'https://preview.dsh.example.test/cloud/service-preview', '/cloud/service-preview#x', '/cloud/service-preview?',
    '/cloud/service-preview?x=\\evil', '/cloud/service-preview?x=\n', undefined,
  ])('rejects preview target %s', (url) => { expect(() => { check(previewHeaders, previewConfig(), { ...previewInput, url }) }).toThrow() })
  it('retains raw duplicate Host/Origin and proxy/TLS denial rules for preview reads', () => {
    for (const raw of [[], ['Host', previewHeaders.host, 'host', previewHeaders.host],
      ['Host', previewHeaders.host, 'Origin', 'https://preview.dsh.example.test', 'origin', 'https://preview.dsh.example.test']]) {
      expect(() => { check(previewHeaders, previewConfig(), previewInput, raw) }).toThrow()
    }
    expect(() => { check(previewHeaders, previewConfig(), previewInput, headersRaw(previewHeaders), undefined, false) }).toThrow()
    for (const extra of [{ 'x-forwarded-host': previewHeaders.host }, { 'x-forwarded-proto': 'https' }, { forwarded: 'host=preview.dsh.example.test' }]) {
      expect(() => { check({ ...previewHeaders, ...extra }) }).toThrow()
    }
    const trusted = { ...previewConfig(), trustedProxyAddresses: ['127.0.0.1'] }
    const forwarded = { ...previewHeaders, 'x-forwarded-host': previewHeaders.host, 'x-forwarded-proto': 'https' }
    check(forwarded, trusted, previewInput, headersRaw(forwarded), '127.0.0.1', false)
    for (const extra of [{ 'x-forwarded-host': 'console.dsh.example.test' }, { 'x-forwarded-proto': 'http' },
      { 'x-forwarded-host': 'preview.dsh.example.test, preview.dsh.example.test' }]) {
      const headers = { ...forwarded, ...extra }
      expect(() => { check(headers, trusted, previewInput, headersRaw(headers), '127.0.0.1', false) }).toThrow()
    }
  })
  it('keeps WS management-only and rejects upgrade headers on the preview read entry', () => {
    for (const extra of [{ upgrade: 'websocket' }, { connection: 'keep-alive, Upgrade' }, { 'sec-websocket-key': 'fake' }]) {
      expect(() => { check({ ...previewHeaders, ...extra }) }).toThrow()
    }
    expect(() => { check({ ...previewHeaders, origin: 'https://preview.dsh.example.test' }, previewConfig(), 'websocket') }).toThrow()
    check({ host: 'console.dsh.example.test', origin: baseConfig().publicOrigin }, previewConfig(), 'websocket')
    expect(() => { check({ host: 'console.dsh.example.test' }, previewConfig(), 'websocket') }).toThrow()
    expect(() => { check({ host: 'console.dsh.example.test', origin: 'https://preview.dsh.example.test' }, previewConfig(), 'http') }).toThrow()
  })
})

describe('original pinned Better Auth adapter', () => {
  it('keeps actual default cookies host-only and auth trustedOrigins at management', async () => {
    const adapter = await create(baseConfig()), options = Reflect.get(adapter, 'options') as BetterAuthOptions
    expect(options.trustedOrigins).toEqual([baseConfig().publicOrigin])
    expect(options.advanced?.crossSubDomainCookies).toBeUndefined()
    expect(getCookies(options).sessionToken.attributes).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' })
    expect(getCookies(options).sessionToken.attributes.domain).toBeUndefined()
  })
  it('sets only actual library crossSubDomainCookies when configured, retaining baseURL, trustedOrigins and security attributes', async () => {
    const config = previewConfig(), adapter = await create(config), options = Reflect.get(adapter, 'options') as BetterAuthOptions
    expect(options.baseURL).toBe(config.publicOrigin); expect(options.basePath).toBe('/cloud/auth')
    expect(options.trustedOrigins).toEqual([config.publicOrigin]); expect(options.session?.cookieCache?.enabled).toBe(false)
    expect(options.advanced?.trustedProxyHeaders).toBe(false)
    expect(options.advanced?.crossSubDomainCookies).toEqual({ enabled: true, domain: 'dsh.example.test' })
    expect(getCookies(options).sessionToken.attributes).toMatchObject({ domain: 'dsh.example.test', httpOnly: true, sameSite: 'lax', secure: true, path: '/' })
    const dev = await create({ ...config, deploymentMode: 'development', publicOrigin: 'http://console.dsh.localhost:4100',
      servicePreview: { origin: 'http://preview.dsh.localhost:4100', cookieDomain: 'dsh.localhost' } })
    const devOptions = Reflect.get(dev, 'options') as BetterAuthOptions
    expect(getCookies(devOptions).sessionToken.attributes).toMatchObject({ domain: 'dsh.localhost', httpOnly: true, sameSite: 'lax', secure: false })
  })
  it('uses real getSession with DB connection blocked, preserves original preview request, and issues no principal', async () => {
    const adapter = await create(previewConfig()), native = Reflect.get(adapter, 'auth') as Auth
    const read = vi.spyOn(native.api, 'getSession')
    const req = request('preview.dsh.example.test', '/cloud/service-preview?path=%2Fstatus', 'GET', { origin: 'https://preview.dsh.example.test' })
    const original = { headers: req.headers, rawHeaders: req.rawHeaders, url: req.url }
    await expect(adapter.authenticateServicePreview(req, requestId)).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
    expect(read).toHaveBeenCalledTimes(1)
    const actual = read.mock.calls[0]?.[0]
    expect(actual?.headers).toBeInstanceOf(Headers)
    expect(new Headers(actual?.headers).get('host')).toBe('preview.dsh.example.test')
    expect(new Headers(actual?.headers).get('origin')).toBe('https://preview.dsh.example.test')
    expect(actual?.query).toEqual({ disableCookieCache: true, disableRefresh: true })
    expect(req.headers).toBe(original.headers); expect(req.rawHeaders).toBe(original.rawHeaders); expect(req.url).toBe(original.url)
    expect(adapter.pendingOperations).toBe(0)
  })
  it('rejects preview bypass through default authenticate, bootstrap and auth bridge before real library entry', async () => {
    const adapter = await create(previewConfig()), native = Reflect.get(adapter, 'auth') as Auth
    const read = vi.spyOn(native.api, 'getSession'), handle = vi.spyOn(native, 'handler')
    expect(() => adapter.authenticate(request('preview.dsh.example.test'), requestId)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    expect(() => adapter.authenticateForBootstrap(request('preview.dsh.example.test', '/cloud/bootstrap'), requestId, 64))
      .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    for (const [host, path] of [['preview.dsh.example.test', '/cloud/auth/sign-in/email'],
      ['preview.dsh.example.test', '/cloud/auth/get-session'], ['console.dsh.example.test', '/cloud/service-preview']] as const) {
      const req = request(host, path, 'POST'), response = new ServerResponse(req)
      try { await expect(adapter.handleNodeRequest(req, response, requestId)).rejects.toMatchObject({ code: 'cloud/forbidden' }) }
      finally { response.destroy() }
    }
    expect(read).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled()
    expect(adapter.pendingOperations).toBe(0)
  })
  it('applies the same path/method/raw-header guard inside preview authenticate, and keeps unconfigured behavior closed', async () => {
    const adapter = await create(previewConfig()), native = Reflect.get(adapter, 'auth') as Auth
    const read = vi.spyOn(native.api, 'getSession')
    for (const [path, method] of [['/cloud/auth/get-session', 'GET'], ['/api/session/list', 'GET'],
      ['/cloud/service-preview', 'HEAD'], ['/cloud/service-preview', 'POST'], ['/cloud/./service-preview', 'GET']] as const) {
      expect(() => adapter.authenticateServicePreview(request('preview.dsh.example.test', path, method), requestId))
        .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    }
    const duplicate = request('preview.dsh.example.test'); duplicate.rawHeaders.push('host', 'preview.dsh.example.test')
    expect(() => adapter.authenticateServicePreview(duplicate, requestId)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    expect(read).not.toHaveBeenCalled()
    const closed = await create(baseConfig())
    expect(() => closed.authenticateServicePreview(request('preview.dsh.example.test'), requestId))
      .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    await expect(adapter.authenticate(request('console.dsh.example.test', '/api/session/list'), requestId))
      .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })
})
