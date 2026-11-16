/** Actual Native listener registrations under an explicitly unsealed runtime; no business or SDK success is simulated. */
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import pg from 'pg'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { ServiceApplicationViews } from '../src/application-views.ts'
import { parseServiceApplicationConfig } from '../src/application-policy.ts'
import { SERVICE_APPLICATION_LAUNCH_ROUTE } from '../src/application-request.ts'
import { accessConfig, ingressConfig, carrier } from './ingress-fixture.ts'

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
  ingress.attachApplicationListener(content, other)
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
