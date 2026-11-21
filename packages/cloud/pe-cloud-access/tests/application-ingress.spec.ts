/** Actual Native listener registrations under an explicitly unsealed runtime; no business or SDK success is simulated. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RegisteredApplicationService } from '@deepseek-ai/dsh-pe-opensandbox/types'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import pg from 'pg'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { ServiceApplicationViews } from '../src/application-views.ts'
import { parseServiceApplicationConfig } from '../src/application-policy.ts'
import { SERVICE_APPLICATION_LAUNCH_ROUTE } from '../src/application-request.ts'
import { IP_APPLICATION_VIEW_PATH, IpApplicationRenderer, type IpApplicationPreviewConfig } from '../src/ip-application-renderer.ts'
import type { AuthenticatedPrincipal } from '../src/types.ts'
import type { AuthAccessError } from '../src/auth-error.ts'
import { parseAuthRootConfig } from '../src/root-config.ts'
import { accessConfig, ingressConfig, carrier, rootConfig } from './ingress-fixture.ts'

it('requires a distinct actual Native content listener and preserves unsealed refusal before authentication', async () => {
  const ctx = new Context(), content = ctx.isolate('webServer')
  const web = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const other = new WebServer(content, { host: '127.0.0.1', port: 0 })
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'component', database: 'unavailable', password: 'component', max: 1 })
  const access = { ...accessConfig(), publicOrigin: 'http://console.auth.dsh.localhost:4100',
    servicePreview: { origin: 'http://text.auth.dsh.localhost:4100', cookieDomain: 'auth.dsh.localhost' } }
  const auth = await BetterAuthAccess.create(access, pool, 'component-secret-at-least-thirty-two-characters', async () => {})
  const config = parseServiceApplicationConfig({ origin: 'http://apps.dsh.localhost:4101', siteDomain: 'dsh.localhost',
    maxUrlBytes: 2048, maxPathBytes: 1024, maxRequestHeaderCount: 32, maxRequestHeaderBytes: 4096,
    maxRequestBodyBytes: 4096, maxQueuedRequests: 2, queueTimeoutMs: 1000,
    views: { maxViews: 2, maxViewsPerAccount: 1, maxRetainedBytes: 65536, maxFieldBytes: 128, lifetimeMs: 10000 },
    response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 32, maxHeaderCount: 32, maxHeaderBytes: 4096 } }, access)
  const views = new ServiceApplicationViews(auth, config.views)
  const ingress = new CloudIngress(ctx, access, ingressConfig(), auth, { web, runtime, recipeVersion: 'component',
    assertAuthenticationCurrent: () => {}, applications: { config, views } })
  onTestFinished(async () => {
    await ingress.closeActual(); await auth.close(); await pool.end(); await ctx.fiber.dispose(); vi.restoreAllMocks()
  })
  const management = vi.spyOn(web, 'register'), fallback = vi.spyOn(other, 'registerFallback'), authenticate = vi.spyOn(auth, 'authenticate')
  const query = vi.spyOn(pool, 'query')
  await ingress.install()
  expect(ingress.observe().current).toBe(false)
  expect(() => ingress.attachApplicationListener(ctx, web)).toThrow()
  expect(ingress.inspectApplicationListener()).toBeUndefined()
  ingress.attachApplicationListener(content, other)
  expect(ingress.inspectApplicationListener()).toEqual({ ctx: content, web: other })
  expect(Object.isFrozen(ingress.inspectApplicationListener())).toBe(true)
  expect(ingress.inspectApplicationListener()).not.toBe(ingress.inspectApplicationListener())
  expect(ingress.observe()).toMatchObject({ current: true, registeredRoutes: 7 })
  expect(ingress.inspectRootFetch()).toEqual([SERVICE_APPLICATION_LAUNCH_ROUTE])
  const launch = management.mock.calls.map(([route]) => route).find(route => route.path === SERVICE_APPLICATION_LAUNCH_ROUTE.path)
  const handler = fallback.mock.calls[0]?.[0]
  if (launch === undefined || handler === undefined) throw new Error('Missing actual service application registration')
  for (const invoke of [launch.handler, handler]) {
    const input = carrier('/cloud/service-application', 'POST', ['Origin', access.publicOrigin])
    input.request.headers.host = new URL(access.publicOrigin).host
    input.request.rawHeaders[1] = new URL(access.publicOrigin).host
    onTestFinished(() => { input.request.destroy(); input.response.destroy(); input.socket.destroy() })
    await invoke(input.request, input.response)
    expect(Buffer.concat(input.socket.output).toString()).toContain('cloud/account-unavailable')
  }
  expect(authenticate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled()
})

it('installs the IP launch and trusted viewer on management only and denies admission while the recipe is unsealed', async () => {
  const ctx = new Context()
  const web = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'component', database: 'unavailable', password: 'component', max: 1 })
  const access = { ...accessConfig(), publicOrigin: 'https://127.0.0.1:4100' }
  const auth = await BetterAuthAccess.create(access, pool, 'component-secret-at-least-thirty-two-characters', async () => {})
  const config: IpApplicationPreviewConfig = { socketPath: '/run/pe-preview/render.sock', maxFrameBytes: 8192, maxReadsPerTurn: 4,
    maxResourcePathBytes: 512, maxRequestBodyBytes: 4096, closeTimeoutMs: 1000,
    views: { maxViews: 5, maxViewsPerAccount: 1, maxRetainedBytes: 65536, maxFieldBytes: 128, lifetimeMs: 10000 },
    response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 32, maxHeaderCount: 32, maxHeaderBytes: 4096 } }
  const deploy = { ...rootConfig(), ...access, ipApplicationPreview: config }
  expect(parseAuthRootConfig(deploy).ipApplicationPreview).toEqual(config)
  expect(() => parseAuthRootConfig({ ...deploy, publicOrigin: 'http://127.0.0.1:4100' })).toThrow()
  const views = new ServiceApplicationViews(auth, config.views)
  const ingress = new CloudIngress(ctx, access, ingressConfig(), auth, { web, runtime, recipeVersion: 'component',
    assertAuthenticationCurrent: () => {}, ipApplicationPreview: { config, views } })
  onTestFinished(async () => {
    await ingress.closeActual(); await auth.close(); await pool.end(); await ctx.fiber.dispose(); vi.restoreAllMocks()
  })
  const register = vi.spyOn(web, 'register'), authenticate = vi.spyOn(auth, 'authenticate')
  await ingress.install()
  expect(ingress.inspectApplicationListener()).toBeUndefined()
  expect(ingress.observe()).toMatchObject({ current: true, registeredRoutes: 7 })
  expect(ingress.inspectRootFetch()).toEqual([SERVICE_APPLICATION_LAUNCH_ROUTE])
  const routes = register.mock.calls.map(([route]) => route)
  for (const [path, target, method] of [
    [SERVICE_APPLICATION_LAUNCH_ROUTE.path, SERVICE_APPLICATION_LAUNCH_ROUTE.path, 'POST'],
    [IP_APPLICATION_VIEW_PATH, IP_APPLICATION_VIEW_PATH + '?view=' + 'a'.repeat(32), 'GET'],
  ] as const) {
    const route = routes.find(candidate => candidate.path === path)
    if (route === undefined) throw new Error('Missing actual IP application registration')
    const input = carrier(target, method, ['Origin', access.publicOrigin])
    Object.defineProperty(input.socket, 'encrypted', { value: true })
    onTestFinished(() => { input.request.destroy(); input.response.destroy(); input.socket.destroy() })
    await route.handler(input.request, input.response)
    expect(Buffer.concat(input.socket.output).toString()).toContain('cloud/account-unavailable')
  }
  expect(authenticate).not.toHaveBeenCalled()
  expect(views.observe()).toEqual({ views: 0, retainedBytes: 0 })
})

async function ipFixture() {
  const ctx = new Context()
  const web = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, max: 1 })
  const access = { ...accessConfig(), publicOrigin: 'https://127.0.0.1:4100' }
  const auth = await BetterAuthAccess.create(access, pool, 'fixture-secret-at-least-thirty-two-characters', async () => {})
  const config: IpApplicationPreviewConfig = { socketPath: '/run/pe-preview/render.sock', maxFrameBytes: 8192, maxReadsPerTurn: 4,
    maxResourcePathBytes: 512, maxRequestBodyBytes: 4096, closeTimeoutMs: 100,
    views: { maxViews: 3, maxViewsPerAccount: 1, maxRetainedBytes: 65536, maxFieldBytes: 128, lifetimeMs: 10000 },
    response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 32, maxHeaderCount: 32, maxHeaderBytes: 4096 } }
  const requestId = brandString<AuthAccessError['requestId']>('ip-retirement-test')
  const make = (label: string) => {
    const principal: AuthenticatedPrincipal = { accountId: brandString<AuthenticatedPrincipal['accountId']>(label),
      authSessionId: brandString<AuthenticatedPrincipal['authSessionId']>('login-' + label) }
    const stop = new AbortController()
    type Scope = RegisteredApplicationService['scope']
    const service: RegisteredApplicationService = {
      scope: { accountId: principal.accountId, epoch: brandString<Scope['epoch']>('1'), sessionId: SessionId('session-' + label),
        allocationId: brandString<Scope['allocationId']>('allocation-' + label), serviceId: brandString<Scope['serviceId']>('service-' + label) },
      lifetime: stop.signal, port: 8000, assertCurrent: () => stop.signal.throwIfAborted(),
      withResponse: vi.fn<RegisteredApplicationService['withResponse']>(),
    }
    return { principal, label, service, stop }
  }
  const a = make('A'), b = make('B')
  vi.spyOn(runtime, 'assertRecipeSealed').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(auth, 'authenticate').mockImplementation(async request => request.headers.cookie === 'A' ? a.principal : b.principal)
  vi.spyOn(auth, 'recheckLogin').mockResolvedValue()
  vi.spyOn(auth, 'assertLoginCurrent').mockImplementation(() => {})
  vi.spyOn(auth, 'retainPrincipal').mockImplementation(() => {})
  vi.spyOn(auth, 'releasePrincipal').mockImplementation(() => {})
  vi.spyOn(auth, 'retainedPrincipalBytes').mockReturnValue(32)
  const routes = vi.spyOn(web, 'register')
  const views = new ServiceApplicationViews(auth, config.views)
  const ingress = new CloudIngress(ctx, access, { ...ingressConfig(), requestTimeoutMs: 3500, maxOperationsPerAccount: 4 }, auth,
    { web, runtime, recipeVersion: 'ip-retirement-test', assertAuthenticationCurrent() {}, ipApplicationPreview: { config, views } })
  onTestFinished(async () => {
    await ingress.closeActual(); await auth.close(); await pool.end(); await ctx.fiber.dispose(); vi.restoreAllMocks()
  })
  type Consume = (service: RegisteredApplicationService, check: () => void) => Promise<void>
  // Only the account factory borrow is substituted; the handler, transfer latch and view registry remain actual.
  Reflect.set(ingress, 'withApplicationService', async (_operation: object, principal: AuthenticatedPrincipal,
    _expected: object, _selection: object, consume: (service: RegisteredApplicationService, check: () => void,
      borrow: (fn: Consume) => Promise<void>) => Promise<void>) => {
    const { service } = principal.accountId === a.principal.accountId ? a : b
    const check = () => service.assertCurrent()
    await consume(service, check, fn => fn(service, check))
  })
  await ingress.install()
  const route = routes.mock.calls.map(([row]) => row).find(row => row.path === IP_APPLICATION_VIEW_PATH)
  if (route === undefined) throw new Error('Missing actual IP application route')
  const issue = async (seat: typeof a) => {
    const view = views.issue(seat.principal, seat.service.scope, 'generation-'+seat.label, seat.stop.signal, requestId)
    await views.authorize(view.id, view.proof, requestId, async () => {})
    return view.id
  }
  const start = (view: string, seat: typeof a, action: object, before?: (input: ReturnType<typeof carrier>) => void) => {
    const input = carrier(IP_APPLICATION_VIEW_PATH + '?view=' + view, 'POST',
      ['Origin', access.publicOrigin, 'Content-Type', 'application/json', 'Cookie', seat.label])
    Object.defineProperty(input.socket, 'encrypted', { value: true })
    input.request.complete = true
    input.request.push(JSON.stringify(action)); input.request.push(null)
    before?.(input)
    return { ...input, settled: route.handler(input.request, input.response) }
  }
  const send = async (view: string, seat: typeof a, action: object) => {
    const output = start(view, seat, action)
    await output.settled
    return { status: output.response.statusCode, text: Buffer.concat(output.socket.output).toString() }
  }
  return { a, b, issue, start, send, ingress, views }
}

it('scopes an unconfirmed Close to A, retains its quota, and retries only that view', async () => {
  const f = await ipFixture(), a = await f.issue(f.a), b = await f.issue(f.b)
  const render = vi.spyOn(IpApplicationRenderer.prototype, 'render').mockResolvedValue(Buffer.alloc(4096))
  const retire = vi.spyOn(IpApplicationRenderer.prototype, 'close').mockResolvedValue().mockRejectedValueOnce(Error('missing receipt'))
  expect((await f.send(a, f.a, { kind: 'frame' })).status).toBe(200)
  expect((await f.send(b, f.b, { kind: 'frame' })).status).toBe(200)
  expect(await f.send(a, f.a, { kind: 'close' })).toMatchObject({ status: 503, text: expect.stringContaining('cloud/account-stop-unconfirmed') })
  expect(f.ingress.observe().current).toBe(true)
  expect(f.views.observe().views).toBe(2)
  await expect(f.issue(f.a)).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect((await f.send(a, f.a, { kind: 'frame' })).status).toBe(401)
  expect((await f.send(a, f.b, { kind: 'close' })).status).toBe(401)
  expect((await f.send(b, f.b, { kind: 'click', x: 3, y: 3 })).status).toBe(200)
  expect(render).toHaveBeenCalledTimes(3)
  expect((await f.send(a, f.a, { kind: 'close' })).status).toBe(204)
  expect(retire).toHaveBeenCalledTimes(2)
  expect(f.views.observe().views).toBe(1)
  expect(await f.issue(f.a)).not.toBe(a)
})

it.each(['resource read', 'PNG transfer', 'explicit Close during PNG transfer'] as const)(
  'aborts A during %s and joins its actual carrier before retirement', async (phase) => {
    const f = await ipFixture(), a = await f.issue(f.a), b = await f.issue(f.b)
    const cancelled = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let entered = false
    let closing: ReturnType<typeof f.start> | undefined
    let pendingWrite: (() => void) | undefined
    const png = Buffer.alloc(4096, 2)
    vi.mocked(f.a.service.withResponse).mockImplementation(async (_input, _limits, signal) => {
      entered = true
      signal.addEventListener('abort', () => cancelled.resolve(undefined), { once: true })
      await cancelled.promise
      await release.promise
      signal.throwIfAborted()
    })
    const render = vi.spyOn(IpApplicationRenderer.prototype, 'render').mockResolvedValue(png)
    if (phase === 'resource read') render.mockImplementationOnce(async (_action, read) => {
      await read('/asset.js')
      return png
    })
    const terminal = Promise.withResolvers<undefined>()
    const retire = vi.spyOn(IpApplicationRenderer.prototype, 'close').mockResolvedValue().mockImplementationOnce(() => terminal.promise)
    const request = f.start(a, f.a, { kind: 'frame' }, ({ socket }) => {
      if (phase === 'resource read') return
      const hold = (chunk: Buffer, callback: () => void) => {
        socket.output.push(Buffer.from(chunk).subarray(0, 32))
        pendingWrite = callback
        entered = true
      }
      vi.spyOn(socket, '_write').mockImplementation((chunk, _encoding, callback) => hold(chunk, callback))
      vi.spyOn(socket, '_writev').mockImplementation((chunks, callback) => hold(chunks[0]!.chunk, callback))
    })
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      if (phase !== 'resource read') {
        expect(request.response.headersSent).toBe(true)
        expect(request.response.writableFinished).toBe(false)
        expect(Buffer.concat(request.socket.output)).toHaveLength(32)
      }
      expect((await f.send(a, f.a, { kind: 'click', x: 3, y: 3 })).status).toBe(429)
      if (phase === 'explicit Close during PNG transfer') closing = f.start(a, f.a, { kind: 'close' })
      else f.a.stop.abort()
      await vi.waitFor(() => expect(request.response.closed).toBe(true))
      if (phase === 'resource read') {
        await cancelled.promise
        expect(retire).not.toHaveBeenCalled()
      }
      expect(f.views.observe().views).toBe(2)
      if (closing !== undefined) expect(closing.response.headersSent).toBe(false)
      expect((await f.send(a, f.a, { kind: 'frame' })).status).toBe(401)
      expect((await f.send(a, f.a, { kind: 'click', x: 3, y: 3 })).status).toBe(401)
      expect((await f.send(b, f.b, { kind: 'click', x: 3, y: 3 })).status).toBe(200)
    } finally {
      release.resolve(undefined); pendingWrite?.()
      await request.settled
      terminal.resolve(undefined)
      if (closing !== undefined) await closing.settled
    }
    if (closing !== undefined) expect(closing.response.statusCode).toBe(204)
    await vi.waitFor(() => expect(f.views.observe().views).toBe(1))
    expect(retire).toHaveBeenCalledOnce()
  })
