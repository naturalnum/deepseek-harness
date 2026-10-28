/** Actual Web route registration and native runtime seal refusal; no positive account or schema is fabricated. */
import { Context } from '@deepseek-ai/cordis'
import { WebServer, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BetterAuthAccess } from '../src/auth.ts'
import { AuthAccessError } from '../src/auth-error.ts'
import { CloudIngress } from '../src/ingress.ts'
import { parseAuthRootConfig } from '../src/root-config.ts'
import { accessConfig, carrier, ingressConfig, rootConfig } from './ingress-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture(preview = false) {
  const ctx = new Context()
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Constructing the real service does not invoke Service.init or open its listener.
  const web = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'test', database: 'unavailable', password: 'test', max: 1, connectionTimeoutMillis: 30 })
  const config = preview ? { ...accessConfig(), publicOrigin: 'http://console.dsh.localhost:4100',
    servicePreview: { origin: 'http://preview.dsh.localhost:4100', cookieDomain: 'dsh.localhost' } } : accessConfig()
  const limits = { ...ingressConfig(), ...(preview ? { servicePreview: { maxUrlBytes: 1024, maxFieldBytes: 128,
    maxRequestHeaderCount: 16, maxRequestHeaderBytes: 2048,
    response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 8, maxHeaderCount: 32, maxHeaderBytes: 4096 } } } : {}) }
  const auth = await BetterAuthAccess.create(config, pool, 'ingress-test-secret-thirty-two-characters-123456', async () => {})
  const authCurrent = vi.fn((): void => { throw new AuthAccessError('cloud/account-unavailable', 'test' as AuthAccessError['requestId']) })
  const ingress = new CloudIngress(ctx, config, limits, auth, {
    web, runtime, recipeVersion: 'ingress-test', assertAuthenticationCurrent: authCurrent,
  })
  cleanups.push(async () => {
    await Promise.allSettled([ingress.closeActual()])
    await auth.close()
    await pool.end()
    await ctx.fiber.dispose()
  })
  const register = vi.spyOn(web, 'register')
  const upgrade = vi.spyOn(web, 'registerUpgrade')
  const seal = vi.spyOn(runtime, 'assertRecipeSealed')
  const authenticate = vi.spyOn(auth, 'authenticate')
  const previewAuth = vi.spyOn(auth, 'authenticateServicePreview')
  const bootstrap = vi.spyOn(auth, 'authenticateForBootstrap')
  const authHandler = vi.spyOn(auth, 'handleNodeRequest')
  const locate = vi.spyOn(runtime, 'locateAccount')
  const acquire = vi.spyOn(runtime, 'acquireAccount')
  const borrow = vi.spyOn(runtime, 'borrowAccount')
  const http = vi.spyOn(HostConnectionService.prototype, 'handleNodeRequest')
  const stream = vi.spyOn(TypertGatewayService.prototype, 'createNodeStreamTransport')
  const query = vi.spyOn(pool, 'query')
  return {
    ctx, web, ingress, register, upgrade, seal, authCurrent, authenticate, previewAuth, bootstrap, authHandler,
    locate, acquire, borrow, http, stream, query, stderr,
  }
}

function responseRequestId(body: string): string {
  const value: unknown = JSON.parse(body)
  if (value === null || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string') {
    throw new Error('Actual safe response request id missing')
  }
  return value.requestId
}

describe('shared Web ingress under the actual unsealed runtime', () => {
  it('reports only the actually registered fixed preview route and keeps unsealed admission before login or account work', async () => {
    const f = await fixture(true)
    await f.ingress.install()
    const rows = f.ingress.inspectRootFetch()
    expect(rows).toEqual([{ method: 'GET', path: '/cloud/service-preview', handlerId: 'cloud:servicePreview', guard: 'account-session' }])
    expect(f.ingress.observe()).toMatchObject({ current: true, registeredRoutes: 6 })
    const route = f.register.mock.calls.map(([value]) => value).find(value => value.path === '/cloud/service-preview')
    if (route === undefined) throw new Error('Actual preview registration missing')
    const input = carrier('/cloud/service-preview?sessionId=a&serviceHandle=s&peAccount=A&peGeneration=old')
    input.request.headers.host = 'preview.dsh.localhost:4100'; input.request.rawHeaders[1] = 'preview.dsh.localhost:4100'
    await route.handler(input.request, input.response)
    expect(input.response.statusCode).toBe(503)
    expect(f.previewAuth).not.toHaveBeenCalled(); expect(f.authenticate).not.toHaveBeenCalled()
    expect(f.locate).not.toHaveBeenCalled(); expect(f.acquire).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
    await f.ingress.closeActual()
    expect(() => f.ingress.inspectRootFetch()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  })

  it('retains the original five registrations without preview policy and refuses preview method/host before login', async () => {
    const disabled = await fixture(); await disabled.ingress.install()
    expect(disabled.ingress.observe().registeredRoutes).toBe(5)
    expect(disabled.ingress.inspectRootFetch()).toEqual([])
    const f = await fixture(true); await f.ingress.install()
    const route = f.register.mock.calls.map(([value]) => value).find(value => value.path === '/cloud/service-preview')
    if (route === undefined) throw new Error('Actual preview registration missing')
    for (const [method, host] of [['HEAD', 'preview.dsh.localhost:4100'], ['GET', 'console.dsh.localhost:4100']]) {
      const input = carrier('/cloud/service-preview', method)
      input.request.headers.host = host; input.request.rawHeaders[1] = host!
      await route.handler(input.request, input.response)
      expect(input.response.statusCode).toBe(403)
    }
    expect(f.previewAuth).not.toHaveBeenCalled(); expect(f.seal).not.toHaveBeenCalled()
  })

  it.each([
    ['/cloud/auth', '/cloud/auth/sign-in/email', 'POST'],
    ['/cloud/bootstrap', '/cloud/bootstrap', 'GET'],
    ['/cloud/settings', '/cloud/settings', 'POST'],
    ['/api', '/api/session/list', 'POST'],
  ])('returns safe 503 from the actual %s registration before any authentication, owner or native call', async (routePath, path, method) => {
    const f = await fixture()
    const log = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    await f.ingress.install()
    const route = f.register.mock.calls.map(call => call[0]).find(route => route.path === routePath)
    if (route === undefined) throw new Error('Actual shared Web route was not registered')
    const { request, response, socket } = carrier(path, method, ['Cookie', 'must-not-be-read', 'X-Pe-Account', 'old-account'])
    const read = vi.spyOn(request, 'read')
    await route.handler(request, response)
    const wire = Buffer.concat(socket.output).toString('utf8')
    expect(response.statusCode).toBe(503)
    expect(wire).toContain('cloud/account-unavailable')
    expect(wire).not.toContain('must-not-be-read')
    expect(wire).not.toContain('old-account')
    expect(wire).toContain('cache-control: no-store')
    const body = wire.slice(wire.indexOf('\r\n\r\n') + 4)
    expect(Buffer.byteLength(body)).toBe(212)
    expect(log).toHaveBeenCalledExactlyOnceWith('Cloud ingress request failed: %j', {
      requestId: responseRequestId(body), stage: 'ingress.current', code: 'cloud/account-unavailable',
      causeCodes: [null, null], sites: [], headersSent: false, writableEnded: false, destroyed: false,
    })
    expect(f.stderr.mock.calls).toEqual(log.mock.calls)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/must-not-be-read|old-account/)
    expect(f.seal).toHaveBeenCalledWith('ingress-test')
    for (const operation of [f.authCurrent, f.authenticate, f.bootstrap, f.authHandler,
      f.locate, f.acquire, f.borrow, f.http, f.stream, f.query, read]) expect(operation).not.toHaveBeenCalled()
    expect(request.destroyed).toBe(true)
  })

  it('records the original machine codes before mapping, reads only two causes and omits private error/request data', async () => {
    const f = await fixture()
    const log = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const forbidden = vi.fn(() => 'PRIVATE_ERROR_ACCESSOR')
    const nested = { code: 'EPIPE' }
    Object.defineProperty(nested, 'cause', { get: forbidden })
    const error = Object.assign(new Error('PRIVATE_MESSAGE'), {
      code: 'cloud/account-starting', cause: { code: 'ECONNRESET', cause: nested },
    })
    Object.defineProperty(error, 'message', { get: forbidden })
    Object.defineProperty(error, 'stack', { get: forbidden })
    f.seal.mockImplementationOnce(() => { throw error })
    await f.ingress.install()
    const route = f.register.mock.calls.map(call => call[0]).find(value => value.path === '/api')
    if (route === undefined) throw new Error('Actual API route missing')
    const { request, response, socket } = carrier('/api/session/list?private=PRIVATE_PATH', 'POST', [
      'Cookie', 'PRIVATE_COOKIE', 'X-Pe-Account', 'PRIVATE_ACCOUNT', 'X-Private-Key', 'PRIVATE_KEY',
    ])
    request.push('PRIVATE_BODY')
    await route.handler(request, response)
    expect(response.statusCode).toBe(503)
    const wire = Buffer.concat(socket.output).toString('utf8')
    const body = wire.slice(wire.indexOf('\r\n\r\n') + 4)
    expect(Buffer.byteLength(body)).toBe(212)
    expect(JSON.parse(body)).toMatchObject({ code: 'cloud/account-unavailable', retry: 'after-status-check' })
    expect(log).toHaveBeenCalledExactlyOnceWith('Cloud ingress request failed: %j', {
      requestId: responseRequestId(body), stage: 'ingress.current', code: 'cloud/account-starting',
      causeCodes: ['ECONNRESET', 'EPIPE'], sites: [], headersSent: false, writableEnded: false, destroyed: false,
    })
    expect(forbidden).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_')
    expect(f.query).not.toHaveBeenCalled()
    expect(f.ingress.observe().pendingOperations).toBe(0)
  })

  it.each(['PRIVATE_CODE', 'x'.repeat(49), 'EPIPE\nPRIVATE_CODE', 'accessor', 'proxy', 'cycle'])(
    'bounds and allowlists diagnostics at the actual authentication stage: %s', async (code) => {
      const f = await fixture()
      const log = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
      const accessor = vi.fn(() => 'PRIVATE_ACCESSOR')
      const error = Object.assign(new Error('PRIVATE_MESSAGE'), { code })
      if (code === 'accessor') Object.defineProperty(error, 'code', { get: accessor })
      if (code === 'proxy') Object.defineProperty(error, 'cause', { value: new Proxy({}, {
        getOwnPropertyDescriptor: () => { throw new Error('PRIVATE_PROXY') },
      }) })
      if (code === 'cycle') { error.code = 'EPIPE'; Object.defineProperty(error, 'cause', { value: error }) }
      f.seal.mockImplementation(() => {})
      f.authCurrent.mockImplementation(() => {})
      f.authenticate.mockRejectedValueOnce(error)
      await f.ingress.install()
      const route = f.register.mock.calls.map(call => call[0]).find(value => value.path === '/api')
      if (route === undefined) throw new Error('Actual API route missing')
      const { request, response, socket } = carrier('/api/session/list', 'POST', ['Cookie', 'PRIVATE_COOKIE'])
      await route.handler(request, response)
      const wire = Buffer.concat(socket.output).toString('utf8')
      const body = wire.slice(wire.indexOf('\r\n\r\n') + 4)
      expect(response.statusCode).toBe(503)
      expect(Buffer.byteLength(body)).toBe(212)
      expect(log).toHaveBeenCalledExactlyOnceWith('Cloud ingress request failed: %j', {
        requestId: responseRequestId(body), stage: 'auth.authenticate', code: code === 'cycle' ? 'EPIPE' : 'unknown',
        causeCodes: code === 'cycle' ? ['EPIPE', 'EPIPE'] : code === 'proxy' ? ['unknown', null] : [null, null],
        sites: [],
        headersSent: false, writableEnded: false, destroyed: false,
      })
      expect(accessor).not.toHaveBeenCalled()
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_')
      expect(f.query).not.toHaveBeenCalled()
    },
  )

  it('keeps the original response and cleanup when the diagnostic exporter fails', async () => {
    const f = await fixture()
    vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => { throw new Error('PRIVATE_EXPORTER') })
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
    await f.ingress.install()
    const route = f.register.mock.calls.map(call => call[0]).find(value => value.path === '/api')
    if (route === undefined) throw new Error('Actual API route missing')
    const { request, response, socket } = carrier('/api/session/list', 'POST')
    await route.handler(request, response)
    expect(response.statusCode).toBe(503)
    const wire = Buffer.concat(socket.output).toString('utf8')
    expect(Buffer.byteLength(wire.slice(wire.indexOf('\r\n\r\n') + 4))).toBe(212)
    expect(wire).not.toContain('PRIVATE_EXPORTER')
    expect(fallback).toHaveBeenCalledExactlyOnceWith('Cloud ingress failure diagnostics unavailable.')
    expect(request.destroyed).toBe(true)
    expect(f.ingress.observe().pendingOperations).toBe(0)
    expect(f.query).not.toHaveBeenCalled()
  })

  it('rejects the actual native upgrade route with 503 before authentication or native socket ownership', async () => {
    const f = await fixture()
    await f.ingress.install()
    const route = f.upgrade.mock.calls[0]?.[0]
    if (route === undefined) throw new Error('Actual shared upgrade route was not registered')
    expect(route.path).toBe(REMOTE_STREAM_MUX_PATH)
    const { request, response, socket } = carrier(REMOTE_STREAM_MUX_PATH + '?peAccount=old&peGeneration=old', 'GET', [
      'Origin', accessConfig().publicOrigin,
    ])
    response.detachSocket(socket)
    await route.handler(request, socket, Buffer.alloc(0))
    const wire = Buffer.concat(socket.output).toString('utf8')
    expect(wire).toContain('HTTP/1.1 503')
    expect(wire).toContain('cloud/account-unavailable')
    expect(socket.destroyed).toBe(true)
    expect(f.seal).toHaveBeenCalledTimes(1)
    for (const operation of [f.authenticate, f.locate, f.acquire, f.borrow, f.http, f.stream, f.query]) {
      expect(operation).not.toHaveBeenCalled()
    }
  })

  it('checks the original unique WS Origin before the seal and every authentication call', async () => {
    const f = await fixture()
    await f.ingress.install()
    const route = f.upgrade.mock.calls[0]?.[0]
    if (route === undefined) throw new Error('Actual upgrade route was not registered')
    for (const headers of [[], ['Origin', 'https://wrong.example'], ['Origin', accessConfig().publicOrigin, 'origin', accessConfig().publicOrigin]]) {
      const { request, response, socket } = carrier(REMOTE_STREAM_MUX_PATH, 'GET', headers)
      response.detachSocket(socket)
      await route.handler(request, socket, Buffer.alloc(0))
      expect(Buffer.concat(socket.output).toString('utf8')).toContain('HTTP/1.1 403')
      expect(socket.destroyed).toBe(true)
    }
    expect(f.seal).not.toHaveBeenCalled()
    expect(f.authenticate).not.toHaveBeenCalled()
  })

  it('unregisters every actual HTTP/upgrade route before reporting actual closure', async () => {
    const f = await fixture()
    await f.ingress.install()
    expect(f.ingress.observe()).toMatchObject({ state: 'installed', current: true, registeredRoutes: 5, pendingOperations: 0 })
    expect(f.seal).not.toHaveBeenCalled()
    const routes = f.register.mock.calls.map(call => call[0])
    const upgrades = f.upgrade.mock.calls.map(call => call[0])
    await f.ingress.closeActual()
    expect(f.ingress.observe()).toMatchObject({ state: 'closed', current: false, registeredRoutes: 0, pendingOperations: 0 })
    await f.ingress.closeActual()
    for (const route of routes) f.web.register(route)()
    for (const route of upgrades) f.web.registerUpgrade(route)()
    expect(f.http).not.toHaveBeenCalled()
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('loses current registration evidence after the real owning fiber disposes without recursively checking the seal', async () => {
    const f = await fixture()
    await f.ingress.install()
    expect(f.ingress.observe().current).toBe(true)
    await f.ctx.fiber.dispose()
    expect(f.ingress.observe()).toMatchObject({ current: false, registeredRoutes: 0 })
    expect(f.seal).not.toHaveBeenCalled()
    expect(f.authenticate).not.toHaveBeenCalled()
  })

  it('rolls back earlier actual registrations after a collision without deleting the original route', async () => {
    const f = await fixture()
    const original: WebRoute = { kind: 'exact', path: '/cloud/bootstrap', handler: (_req, res) => { res.end() } }
    const remove = f.web.register(original)
    await expect(f.ingress.install()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    const after = f.web.register({ kind: 'prefix', path: '/cloud/auth', handler: original.handler })
    after()
    expect(() => f.web.register(original)).toThrow('duplicate')
    remove()
  })

  it('retains unknown registration cleanup even when Cordis contains the actual disposer failure', async () => {
    const f = await fixture()
    const register = f.web.register.bind(f.web)
    let removeActual: (() => void) | undefined
    f.register.mockImplementationOnce((route) => {
      removeActual = register(route)
      return () => { throw new Error('private teardown detail') }
    })
    const log = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
    try {
      await f.ingress.install()
      const actualClose = f.ingress.closeActual()
      await expect(actualClose).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
      expect(f.ingress.closeActual()).toBe(actualClose)
      expect(f.ingress.observe()).toMatchObject({ state: 'unknown', current: false, registeredRoutes: 1 })
      expect(JSON.stringify(log.mock.calls)).not.toContain('private teardown detail')
    } finally {
      // Remove the test-owned native registration; the product observation deliberately remains unknown.
      removeActual?.()
    }
  })

  it('keeps ingress optional and requires every configured budget without treating presence as readiness', () => {
    const input = rootConfig()
    const { ingress, ...resourceOnly } = input
    expect(parseAuthRootConfig(resourceOnly).ingress).toBeUndefined()
    expect(parseAuthRootConfig(input).ingress).toEqual(ingress)
    for (const field of Object.keys(ingressConfig())) {
      const omitted = Object.fromEntries(Object.entries(ingressConfig()).filter(([name]) => name !== field))
      expect(() => parseAuthRootConfig({ ...input, ingress: omitted } as typeof input)).toThrow('explicit valid database')
    }
    expect(() => parseAuthRootConfig({ ...input, ingress: { ...ingressConfig(), maxOperationsPerAccount: 5 } })).toThrow()
    expect(() => parseAuthRootConfig({ ...input, ingress: { ...ingressConfig(), maxLogicalStreamsPerPeer: 5 } })).toThrow()
  })
})
