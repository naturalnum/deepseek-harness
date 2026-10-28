/** Real Loader account, auth guard and loopback native HTTP/WS; only Root admission and DB answers are fixtures. */
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostConnectionService, apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import pg from 'pg'
import type { Auth } from 'better-auth'
import WebSocket from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { ConnectionGenerations } from '../src/generations.ts'
import { LoginPeerRegistry } from '../src/peers.ts'
import { accessConfig, ingressConfig } from './ingress-fixture.ts'

type Phase = 'locate' | 'acquire' | 'peer' | 'consume'

async function fixture(phase: Phase, reject: 'none' | 'revoked' | 'replaced' | 'aborted' = 'none') {
  const native = policyFixture([], { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
      maxQueuedEvents: 128, maxQueuedBytes: 4194304 }), graph = await native.start()
  await graph.ctx.plugin({ inject: connectionInject, apply: applyConnection })
  const root = new Context(), sockets = new Set<Socket>(), clients = new Set<WebSocket>()
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1, connectionTimeoutMillis: 10 })
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Physical SQL is forbidden in this component fixture') })
  const clock = { now: 10000 }, crossed = { value: false }
  let armed = true, canonical: Awaited<ReturnType<BetterAuthAccess['authenticate']>> | undefined
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const config = { ...accessConfig(), sessionRecheckMs: 5000, authCheckTimeoutMs: 1000, peerCloseTimeoutMs: 1000 }
  const auth = await BetterAuthAccess.create(config, pool, 'ingress-freshness-offline-secret-01234567890123456789',
    async (id) => { await ingress.invalidateLogin(id) })
  const library = Reflect.get(auth, 'auth') as Auth, createdAt = new Date()
  const login = { user: { id: graph.binding.accountId, name: 'Freshness', email: 'freshness@example.test', emailVerified: true,
    createdAt, updatedAt: createdAt }, session: { id: 'captured-original-login', userId: graph.binding.accountId,
    token: 'offline-fixture', expiresAt: new Date(Date.now() + 60000), createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null } }
  const sessions = vi.spyOn(library.api, 'getSession').mockImplementation(async () => {
    if (crossed.value && reject === 'revoked') return null
    if (crossed.value && reject === 'replaced') return { ...login, session: { ...login.session, id: 'different-login' } }
    return login
  })
  const crossedNow = async (): Promise<void> => {
    if (!armed) return
    crossed.value = true; clock.now += 6000
    if (reject === 'aborted') graph.lifetime.abort()
    // The live Peer can have its own successful DB recheck while this distinct operation principal is stale.
    if (canonical !== undefined && reject === 'none') {
      await auth.recheckLogin(canonical, 'canonical-recheck' as Parameters<BetterAuthAccess['recheckLogin']>[1])
    }
  }
  // Root storage/control and AccountUses remain explicit external fixtures, never a fabricated recipe seal.
  const runtime = new PeAccountRuntime(root, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  vi.spyOn(runtime, 'assertRecipeSealed').mockImplementation(() => {})
  vi.spyOn(runtime, 'assertBusinessCurrent').mockImplementation((binding) => {
    expect(binding).toBe(graph.binding); graph.binding.lifetime.throwIfAborted()
  })
  const release = vi.fn(), borrow = () => ({ binding: graph.binding, context: graph.ctx,
    assertCurrent() { graph.ctx.fiber.assertActive(); graph.binding.lifetime.throwIfAborted() }, release })
  vi.spyOn(runtime, 'locateAccount').mockImplementation(async () => { if (phase === 'locate') await crossedNow(); return undefined })
  vi.spyOn(runtime, 'acquireAccount').mockImplementation(async () => { if (phase === 'acquire') await crossedNow(); return borrow() })
  vi.spyOn(runtime, 'borrowAccount').mockImplementation(async () => borrow())
  const acquire = LoginPeerRegistry.prototype.acquire
  vi.spyOn(LoginPeerRegistry.prototype, 'acquire').mockImplementation(async function (this: LoginPeerRegistry, ...args) {
    const result = await acquire.apply(this, args)
    canonical ??= result.principal
    if (phase === 'peer') await crossedNow()
    return result
  })
  const handleHttp = LoginPeerRegistry.prototype.handleNodeRequest, handleUpgrade = LoginPeerRegistry.prototype.handleUpgrade
  vi.spyOn(LoginPeerRegistry.prototype, 'handleNodeRequest').mockImplementation(async function (this: LoginPeerRegistry, ...args) {
    const finished = once(args[2], 'finish')
    await handleHttp.apply(this, args)
    await finished
    if (phase === 'consume') await crossedNow()
  })
  vi.spyOn(LoginPeerRegistry.prototype, 'handleUpgrade').mockImplementation(async function (this: LoginPeerRegistry, ...args) {
    await handleUpgrade.apply(this, args); if (phase === 'consume') await crossedNow()
  })
  const web = new WebServer(root, { host: '127.0.0.1', port: 0 }), httpRoutes = vi.spyOn(web, 'register')
  const upgradeRoutes = vi.spyOn(web, 'registerUpgrade'), authenticated = vi.spyOn(auth, 'authenticate')
  const rechecks = vi.spyOn(auth, 'recheckLogin'), dispatches = vi.spyOn(HostConnectionService.prototype, 'handleNodeRequest')
  const ingress = new CloudIngress(root, config, { ...ingressConfig(), requestTimeoutMs: 2000, sessionRecheckLeadMs: 1000,
    maxRequestBodyBytes: 262144, maxFrameBytes: 262144 }, auth,
  { web, runtime, recipeVersion: graph.binding.recipeVersion, assertAuthenticationCurrent() {} })
  const ownedIngress = ingress, pending: Promise<void>[] = []
  const server = createServer((request, response) => {
    const route = httpRoutes.mock.calls.find(([value]) => value.path === '/api')?.[0]
    if (route === undefined) throw new Error('Original native route absent')
    pending.push(Promise.resolve(route.handler(request, response)))
  })
  server.on('connection', (socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket) })
  })
  server.on('upgrade', (request, socket, head) => {
    const route = upgradeRoutes.mock.calls[0]?.[0]
    if (route === undefined) throw new Error('Original native upgrade route absent')
    pending.push(Promise.resolve(route.handler(request, socket, head)))
  })
  onTestFinished(async () => {
    for (const client of clients) client.terminate()
    try { await ownedIngress.closeActual(); await Promise.all(pending); await auth.close(); await pool.end(); await root.fiber.dispose() }
    finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      vi.restoreAllMocks()
    }
  })
  await ingress.install()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture listener missing')
  const generations: unknown = Reflect.get(ingress, 'generations')
  if (!(generations instanceof ConnectionGenerations)) throw new Error('Original generation owner absent')
  const generation = generations.current(graph.binding, 'fixture-generation' as Parameters<ConnectionGenerations['current']>[1])
  const headers = { Host: '127.0.0.1:4100', Origin: config.publicOrigin, Cookie: 'better-auth.session_token=captured-original-cookie',
    'x-pe-account': graph.binding.accountId, 'x-pe-generation': generation }
  const http = (): Promise<number> => new Promise((resolve, reject) => {
    const body = JSON.stringify({ args: [] })
    const request = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/session/list', agent: false,
      headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      response.resume(); response.on('error', reject); response.on('end', () => { resolve(response.statusCode ?? 0) })
    })
    request.on('error', reject); request.end(body)
  })
  const upgrade = async (): Promise<{ status: number; client: WebSocket }> => {
    const url = new URL(`ws://127.0.0.1:${address.port}${REMOTE_STREAM_MUX_PATH}`)
    url.searchParams.set('peAccount', graph.binding.accountId); url.searchParams.set('peGeneration', generation)
    const client = new WebSocket(url, { headers, perMessageDeflate: false }); clients.add(client)
    return await new Promise((resolve, reject) => {
      client.once('error', reject)
      client.once('open', () => { resolve({ status: 101, client }) })
      client.once('unexpected-response', (_request, response) => {
        response.resume(); response.once('end', () => { resolve({ status: response.statusCode ?? 0, client }) })
      })
    })
  }
  const warm = async (): Promise<void> => {
    armed = false; expect(await http()).toBe(200); await Promise.all(pending)
    armed = true; rechecks.mockClear(); sessions.mockClear(); authenticated.mockClear(); dispatches.mockClear()
  }
  return { http, upgrade, warm, ingress, auth, clock, rechecks, sessions, authenticated, dispatches, crossed, pending, release,
    canonical: () => canonical }
}

for (const transport of ['http', 'upgrade'] as const) {
  it.each<Phase>(['locate', 'acquire', 'peer', 'consume'])(`renews the same operation login after a slow %s await on real ${transport}`, async (phase) => {
    const f = await fixture(phase)
    await f.warm()
    if (transport === 'http') expect(await f.http()).toBe(200)
    else {
      const { status, client } = await f.upgrade(); expect(status).toBe(101)
      await vi.waitFor(() => { expect(f.rechecks.mock.calls.length).toBeGreaterThanOrEqual(4) })
      const closed = once(client, 'close'); client.close(1000); await closed
    }
    await Promise.all(f.pending)
    expect(f.crossed.value).toBe(true)
    const original = await f.authenticated.mock.results[0]!.value
    expect(original).not.toBe(f.canonical())
    expect(f.rechecks.mock.calls.filter(([principal]) => principal === original)).toHaveLength(4)
    for (const [input] of f.sessions.mock.calls) expect(new Headers(input?.headers).get('cookie'))
      .toBe('better-auth.session_token=captured-original-cookie')
    f.clock.now += 5000
    expect(() => { f.auth.assertLoginCurrent(original, 'fixture-request' as Parameters<BetterAuthAccess['assertLoginCurrent']>[1]) })
      .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    expect(f.ingress.observe().pendingOperations).toBe(0)
  })

  for (const phase of ['locate', 'acquire', 'peer'] as const) {
    it.each(['revoked', 'replaced'] as const)(`refuses a %s captured login after ${phase} before real ${transport} admission`, async (reject) => {
      const f = await fixture(phase, reject)
      if (transport === 'http') expect(await f.http()).toBe(401)
      else expect((await f.upgrade()).status).toBe(401)
      await Promise.all(f.pending)
      expect(f.dispatches).not.toHaveBeenCalled()
      const original = await f.authenticated.mock.results[0]!.value
      expect(f.rechecks.mock.calls.at(-1)?.[0]).toBe(original)
      expect(() => { f.auth.assertLoginCurrent(original, 'fixture-request' as Parameters<BetterAuthAccess['assertLoginCurrent']>[1]) }).toThrow()
      expect(f.ingress.observe().pendingOperations).toBe(0)
    })
  }
}
