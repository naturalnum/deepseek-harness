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

async function fixture() {
  const ctx = new Context()
  // Constructing the real service does not invoke Service.init or open its listener.
  const web = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'test', database: 'unavailable', password: 'test', max: 1, connectionTimeoutMillis: 30 })
  const auth = await BetterAuthAccess.create(accessConfig(), pool, 'ingress-test-secret-thirty-two-characters-123456', async () => {})
  const authCurrent = vi.fn(() => { throw new AuthAccessError('cloud/account-unavailable', 'test' as AuthAccessError['requestId']) })
  const ingress = new CloudIngress(ctx, accessConfig(), ingressConfig(), auth, {
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
  const bootstrap = vi.spyOn(auth, 'authenticateForBootstrap')
  const authHandler = vi.spyOn(auth, 'handleNodeRequest')
  const locate = vi.spyOn(runtime, 'locateAccount')
  const acquire = vi.spyOn(runtime, 'acquireAccount')
  const borrow = vi.spyOn(runtime, 'borrowAccount')
  const http = vi.spyOn(HostConnectionService.prototype, 'handleNodeRequest')
  const stream = vi.spyOn(TypertGatewayService.prototype, 'createNodeStreamTransport')
  const query = vi.spyOn(pool, 'query')
  return {
    ctx, web, ingress, register, upgrade, seal, authCurrent, authenticate, bootstrap, authHandler,
    locate, acquire, borrow, http, stream, query,
  }
}

describe('shared Web ingress under the actual unsealed runtime', () => {
  it.each([
    ['/cloud/auth', '/cloud/auth/sign-in/email', 'POST'],
    ['/cloud/bootstrap', '/cloud/bootstrap', 'GET'],
    ['/cloud/settings', '/cloud/settings', 'POST'],
    ['/api', '/api/session/list', 'POST'],
  ])('returns safe 503 from the actual %s registration before any authentication, owner or native call', async (routePath, path, method) => {
    const f = await fixture()
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
    expect(f.seal).toHaveBeenCalledWith('ingress-test')
    for (const operation of [f.authCurrent, f.authenticate, f.bootstrap, f.authHandler,
      f.locate, f.acquire, f.borrow, f.http, f.stream, f.query, read]) expect(operation).not.toHaveBeenCalled()
    expect(request.destroyed).toBe(true)
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
