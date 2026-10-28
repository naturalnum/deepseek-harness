/** Real Loader/catalog/API and original auth guard; DB login response and monotonic cost are external fixtures. */
import { readFileSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import pg from 'pg'
import type { Auth } from 'better-auth'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { CloudAccountApi, type ApprovedConfigurationCatalog } from '@deepseek-ai/dsh-pe-cloud-api'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'
import * as producer from '../src/bootstrap-producer.ts'
import { CloudIngress } from '../src/ingress.ts'
import { accessConfig, carrier, ingressConfig } from './ingress-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
  maxQueuedEvents: 128, maxQueuedBytes: 4194304 }
const version = (relative: string): string => (JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { version: string }).version
const catalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'native-metadata-regression', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [
    { id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: version('../../../client/locale/package.json'), installable: false, toggleable: false },
    { id: 'model-provider', entryId: 'include:model-provider', moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key', packageName: '@deepseek-ai/dsh-llm-deepseek-api-key',
      packageVersion: version('../../../llm/llm-deepseek-api-key/package.json'), installable: false, toggleable: false },
  ], skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [],
}
type Graph = Awaited<ReturnType<ReturnType<typeof policyFixture>['start']>>

async function fixture() {
  const native = policyFixture([], bounds, 'bootstrap-metadata-regression', undefined, catalog), graph = await native.start()
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1, connectionTimeoutMillis: 10 })
  const connect = vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Physical DB connect forbidden in this component fixture') })
  const query = vi.spyOn(pool, 'query').mockImplementation(() => { throw new Error('Physical DB query forbidden in this component fixture') })
  const resources: { auth?: BetterAuthAccess } = {}
  const socket = new Socket(), request = new IncomingMessage(socket)
  onTestFinished(async () => {
    await resources.auth?.close(); await pool.end(); request.destroy(); socket.destroy(); vi.restoreAllMocks()
  })
  const auth = await BetterAuthAccess.create({ ...accessConfig(), sessionRecheckMs: 5000, authCheckTimeoutMs: 10000 },
    pool, 'offline-metadata-regression-secret-01234567890123456789', async () => {})
  resources.auth = auth
  const library = Reflect.get(auth, 'auth') as Auth, createdAt = new Date(), expiresAt = new Date(Date.now() + 60000)
  const session = vi.spyOn(library.api, 'getSession').mockResolvedValue({
    user: { id: graph.binding.accountId, name: 'Metadata regression', email: 'metadata@example.test', emailVerified: true, createdAt, updatedAt: createdAt },
    session: { id: 'metadata-regression-login', userId: graph.binding.accountId, token: 'offline-library-response', expiresAt,
      createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null },
  })
  request.method = 'GET'; request.url = '/cloud/bootstrap'
  request.headers = { host: '127.0.0.1:4100', cookie: 'better-auth.session_token=external-fixture' }
  request.rawHeaders = ['Host', '127.0.0.1:4100', 'Cookie', 'better-auth.session_token=external-fixture']
  const requestId = 'bootstrap-metadata-regression-request' as Parameters<BetterAuthAccess['authenticateForBootstrap']>[1]
  const authenticate = () => auth.authenticateForBootstrap(request, requestId, 65536)
  const produce = (verified: Awaited<ReturnType<typeof authenticate>>, recheckLogin?: () => Promise<void>,
    signal: AbortSignal = graph.binding.lifetime) => produceCloudBootstrap(graph.ctx, graph.binding,
    native.exposureOwner, () => native.bootstrapPackages, verified.account, 65536, signal, () => {
      auth.assertLoginCurrent(verified.principal, requestId)
      graph.ctx.fiber.assertActive(); graph.binding.lifetime.throwIfAborted(); native.assertRootActive()
    }, () => 'metadata-regression-generation', recheckLogin)
  return { native, graph, auth, authenticate, produce, requestId, session, connect, query, request }
}

function costEachEndpoint(graph: Graph, clock: { now: number }, milliseconds: number) {
  const rpc = vi.spyOn(graph.api, 'requireRpc').mockImplementation(function (this: CloudAccountApi, endpoint) {
    const result = CloudAccountApi.prototype.requireRpc.call(this, endpoint)
    clock.now += milliseconds
    return result
  })
  const stream = vi.spyOn(graph.api, 'requireStream').mockImplementation(function (this: CloudAccountApi, endpoint) {
    const result = CloudAccountApi.prototype.requireStream.call(this, endpoint)
    clock.now += milliseconds
    return result
  })
  return { rpc, stream }
}

it('keeps metadata projection within the original five-second login window without repeating endpoint admission per reader check', async () => {
  const f = await fixture(), clock = { now: 10000 }
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const cost = costEachEndpoint(f.graph, clock, 20), verified = await f.authenticate()
  const projected = await f.produce(verified)
  f.auth.assertLoginCurrent(verified.principal, f.requestId)
  projected.assertCurrent()
  expect(JSON.parse(projected.body)).toMatchObject({ capabilities: { configuration: {
    plugins: [{ id: 'locale' }, { id: 'model-provider' }], skills: { manage: false },
  } } })
  const manifest = f.native.exposureOwner.policy.manifest
  expect(cost.rpc.mock.calls.length + cost.stream.mock.calls.length)
    .toBe(2 * (manifest.rpcEndpoints.length + manifest.streamEndpoints.length + 1))
  expect(clock.now - 10000).toBeLessThan(5000)
  clock.now = 14999; f.auth.assertLoginCurrent(verified.principal, f.requestId)
  clock.now = 15000
  expect(() => { f.auth.assertLoginCurrent(verified.principal, f.requestId) }).toThrow(expect.objectContaining({
    code: 'cloud/account-unavailable', status: 503,
  }))
  now.mockRestore()
  expect(f.session).toHaveBeenCalledTimes(1)
  expect(f.query).not.toHaveBeenCalled()
  expect(f.connect.mock.calls.length).toBeLessThanOrEqual(1)
  expect(f.graph.adapter.calls).toBe(0)
})

it.each([false, true])('rechecks the captured login after slow production and preserves final native refusal (withdraw=%s)', async (withdraw) => {
  const f = await fixture(), clock = { now: 10000 }, root = new Context()
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  // Only Root storage/control admission and its AccountUse are external fixtures here; no runtime seal is issued.
  const runtime = new PeAccountRuntime(root, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  vi.spyOn(runtime, 'assertRecipeSealed').mockImplementation(() => {})
  vi.spyOn(runtime, 'assertBusinessCurrent').mockImplementation((binding) => { expect(binding).toBe(f.graph.binding) })
  vi.spyOn(runtime, 'locateAccount').mockResolvedValue(undefined)
  const release = vi.fn()
  vi.spyOn(runtime, 'acquireAccount').mockResolvedValue({ binding: f.graph.binding, context: f.graph.ctx,
    assertCurrent() { f.graph.ctx.fiber.assertActive(); f.graph.binding.lifetime.throwIfAborted() }, release })
  root.provide('peExposure', f.native.exposureOwner)
  root.provide('pluginPackages', f.native.bootstrapPackages)
  const web = new WebServer(root, { host: '127.0.0.1', port: 0 }), registered = vi.spyOn(web, 'register')
  const ingress = new CloudIngress(root, { ...accessConfig(), sessionRecheckMs: 5000, authCheckTimeoutMs: 10000 },
    { ...ingressConfig(), maxBootstrapResponseBytes: 65536 }, f.auth,
    { web, runtime, recipeVersion: f.graph.binding.recipeVersion, exposure: f.native.exposureOwner,
      assertAuthenticationCurrent() {} })
  const original = producer.produceCloudBootstrap
  vi.spyOn(producer, 'produceCloudBootstrap').mockImplementation(async (...args) => {
    const projected = await original(...args)
    clock.now += 6000
    if (withdraw) f.graph.withdrawLlmGuard()
    return projected
  })
  const recheck = vi.spyOn(f.auth, 'recheckLogin')
  const input = carrier('/cloud/bootstrap', 'GET', ['Cookie', 'better-auth.session_token=external-fixture'])
  try {
    await ingress.install()
    const route = registered.mock.calls.find(([row]) => row.path === '/cloud/bootstrap')?.[0]
    if (route === undefined) throw new Error('Original bootstrap route was not registered')
    await route.handler(input.request, input.response)
    expect(input.response.statusCode).toBe(withdraw ? 503 : 200)
    expect(recheck).toHaveBeenCalledTimes(7)
    expect(release).toHaveBeenCalledTimes(1)
    for (const [value] of f.session.mock.calls) {
      expect(new Headers(value?.headers).get('cookie')).toBe('better-auth.session_token=external-fixture')
    }
    expect(f.graph.adapter.calls).toBe(0)
  } finally {
    await ingress.closeActual(); await root.fiber.dispose(); input.request.destroy(); input.socket.destroy()
  }
})

it('rejects native guard withdrawal after projection and before response transfer', async () => {
  const f = await fixture(), projected = await f.produce(await f.authenticate())
  f.graph.withdrawLlmGuard()
  expect(projected.assertCurrent).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('retains the original stale-login refusal after a slow catalog await when no captured-cookie recheck is provided', async () => {
  const f = await fixture(), clock = { now: 10000 }
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const verified = await f.authenticate()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale') clock.now += 6000
    return result
  })
  await expect(f.produce(verified)).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
  expect(f.session).toHaveBeenCalledTimes(1)
})

it.each(['catalog', 'native'] as const)('rechecks the same captured login after a %s await exceeds the unchanged five-second window', async (phase) => {
  const f = await fixture(), clock = { now: 10000 }
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const verified = await f.authenticate()
  // A later request-cookie mutation must never select a different login for the admitted bootstrap.
  f.request.headers.cookie = 'better-auth.session_token=different-later-cookie'
  if (phase === 'catalog') {
    const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
    const tree = locale.parent.tree, load = tree.import.bind(tree)
    vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
      const result: unknown = await load(name, stack)
      if (name === '@deepseek-ai/dsh-client-locale') clock.now += 6000
      return result
    })
  } else {
    const check = f.graph.api.assertBootstrapCurrent.bind(f.graph.api)
    vi.spyOn(f.graph.api, 'assertBootstrapCurrent').mockImplementation(async (owner, signal) => {
      const result = await check(owner, signal)
      clock.now += 6000
      return result
    })
  }
  const recheck = vi.fn(() => f.auth.recheckLogin(verified.principal, f.requestId))
  const projected = await f.produce(verified, recheck)
  projected.assertCurrent()
  f.auth.assertLoginCurrent(verified.principal, f.requestId)
  expect(clock.now).toBe(16000)
  expect(recheck).toHaveBeenCalledTimes(4)
  expect(f.session).toHaveBeenCalledTimes(5)
  for (const [input] of f.session.mock.calls) {
    expect(new Headers(input?.headers).get('cookie')).toBe('better-auth.session_token=external-fixture')
  }
  clock.now = 21000
  expect(() => { projected.assertCurrent() }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(f.query).not.toHaveBeenCalled()
  expect(f.graph.adapter.calls).toBe(0)
})

it('rejects a revoked captured login during the catalog await instead of refreshing only its timestamp', async () => {
  const f = await fixture(), clock = { now: 10000 }
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const verified = await f.authenticate()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale') {
      clock.now += 6000
      f.session.mockResolvedValueOnce(null)
    }
    return result
  })
  const native = vi.spyOn(f.graph.api, 'assertBootstrapCurrent')
  await expect(f.produce(verified, () => f.auth.recheckLogin(verified.principal, f.requestId)))
    .rejects.toMatchObject({ code: 'cloud/unauthenticated', status: 401 })
  expect(native).not.toHaveBeenCalled()
  expect(f.session).toHaveBeenCalledTimes(2)
  expect(() => { f.auth.assertLoginCurrent(verified.principal, f.requestId) }).toThrow()
})

it('does not start another login query when the bootstrap observer aborts during the catalog await', async () => {
  const f = await fixture(), verified = await f.authenticate(), observer = new AbortController()
  const aborted = new Error('Bootstrap observer ended')
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale') observer.abort(aborted)
    return result
  })
  const recheck = vi.fn(() => f.auth.recheckLogin(verified.principal, f.requestId))
  await expect(f.produce(verified, recheck, observer.signal)).rejects.toBe(aborted)
  expect(recheck).not.toHaveBeenCalled()
  expect(f.session).toHaveBeenCalledTimes(1)
})

it('rejects a substituted original native implementation before response transfer', async () => {
  const f = await fixture(), projected = await f.produce(await f.authenticate())
  const replaced = vi.spyOn(RemoteAccess.prototype, 'follow').mockImplementation(() => { throw new Error('Replaced native handler must not run') })
  expect(projected.assertCurrent).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(replaced).not.toHaveBeenCalled()
})

it('rejects native guard withdrawal during the actual catalog module await', async () => {
  const f = await fixture(), verified = await f.authenticate()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  let withdrawn = false
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale' && !withdrawn) { withdrawn = true; f.graph.withdrawLlmGuard() }
    return result
  })
  await expect(f.produce(verified)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(withdrawn).toBe(true)
})

it('rejects original Root owner closure during the catalog await', async () => {
  const f = await fixture(), verified = await f.authenticate()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  let closed = false
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale' && !closed) { closed = true; await f.native.closeRoot() }
    return result
  })
  await expect(f.produce(verified)).rejects.toThrow()
  expect(closed).toBe(true)
})

it('keeps original authentication shutdown authoritative at final transfer', async () => {
  const f = await fixture(), projected = await f.produce(await f.authenticate())
  await f.auth.close()
  expect(projected.assertCurrent).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable', status: 503 }))
})
