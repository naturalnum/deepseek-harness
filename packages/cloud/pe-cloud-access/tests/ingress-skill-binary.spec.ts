/** Actual authenticated CloudIngress/Peer over TCP; root SQL and package-source timing are explicit external fixtures. */
import { createServer, request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { ReleaseSkillBinaryBudget } from '@deepseek-ai/dsh-pe-cloud-files'
import pg from 'pg'
import type { Auth } from 'better-auth'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { LoginPeerRegistry } from '../src/peers.ts'
import { ConnectionGenerations } from '../src/generations.ts'
import type { BorrowedBinaryResponse, BinaryResponseSettlement } from '../src/types.ts'
import { accessConfig, ingressConfig } from './ingress-fixture.ts'

async function fixture(workspace = false) {
  const path = workspace ? '/api/workspace-files/upload' : '/api/skills/release-archive'
  const method = workspace ? 'POST' : 'GET'
  const reviewed = (workspace ? ['POST'] : ['GET', 'HEAD']).map(method => ({ method, path,
    handlerId: workspace ? 'cloud:workspaceUpload' : 'cloud:bundledSkillArchive',
    guard: workspace ? 'account-session' as const : 'authenticated-account' as const }))
  const native = policyFixture([], undefined, 'binary-A', { selected: reviewed, inspectRootFetch: () => reviewed })
  const graph = await native.start('1', native.config, true, { maxNativeInventoryEntries: 256 })
  await graph.ctx.plugin({ inject: connectionInject, apply: applyConnection })
  const root = new Context(), sockets = new Set<Socket>(), pending: Promise<void>[] = []
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1, connectionTimeoutMillis: 10 })
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw Error('Physical SQL is outside this transport fixture') })
  const config = { ...accessConfig(), sessionRecheckMs: 5000, authCheckTimeoutMs: 1000, peerCloseTimeoutMs: 1000 }
  const auth = await BetterAuthAccess.create(config, pool, 'ingress-binary-offline-secret-01234567890123456789',
    async (id) => { await ingress.invalidateLogin(id) })
  const library = Reflect.get(auth, 'auth') as Auth, createdAt = new Date()
  let loggedIn = true, uses = 0
  const login = { user: { id: graph.binding.accountId, name: 'Binary', email: 'binary@example.test', emailVerified: true,
    createdAt, updatedAt: createdAt }, session: { id: 'original-binary-login', userId: graph.binding.accountId,
    token: 'offline-fixture', expiresAt: new Date(Date.now() + 60000), createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null } }
  const foreign = { user: { ...login.user, id: 'binary-B' }, session: { ...login.session, id: 'foreign-login', userId: 'binary-B' } }
  vi.spyOn(library.api, 'getSession').mockImplementation(async (input) => {
    const cookie = new Headers(input?.headers).get('cookie')
    return cookie === 'better-auth.session_token=foreign' ? foreign : loggedIn && cookie === 'better-auth.session_token=fixture' ? login : null
  })
  const runtime = new PeAccountRuntime(root, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  vi.spyOn(runtime, 'assertRecipeSealed').mockImplementation(() => {})
  vi.spyOn(runtime, 'assertBusinessCurrent').mockImplementation((binding) => { expect(binding).toBe(graph.binding) })
  const borrow = () => {
    uses++
    let released = false
    return { binding: graph.binding, context: graph.ctx,
      assertCurrent() { graph.ctx.fiber.assertActive(); graph.binding.lifetime.throwIfAborted() },
      release() { expect(released).toBe(false); released = true; uses-- } }
  }
  vi.spyOn(runtime, 'locateAccount').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'acquireAccount').mockImplementation(async () => borrow())
  vi.spyOn(runtime, 'borrowAccount').mockImplementation(async () => borrow())
  const acquirePeer = vi.spyOn(LoginPeerRegistry.prototype, 'acquire')
  const web = new WebServer(root, { host: '127.0.0.1', port: 0 }), routes = vi.spyOn(web, 'register')
  const ingress = new CloudIngress(root, config, { ...ingressConfig(), requestTimeoutMs: 5000, sessionRecheckLeadMs: 1000 }, auth,
    { web, runtime, recipeVersion: graph.binding.recipeVersion, assertAuthenticationCurrent() {} })
  const server = createServer((request, response) => {
    const route = routes.mock.calls.find(([value]) => value.path === '/api')?.[0]
    if (route === undefined) throw Error('Original API prefix absent')
    const actual = Promise.resolve(route.handler(request, response)); pending.push(actual); void actual.catch(() => {})
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket) }) })
  onTestFinished(async () => {
    await Promise.allSettled([ingress.closeActual(), ...pending])
    await auth.close(); await pool.end(); await root.fiber.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    vi.restoreAllMocks()
  })
  await ingress.install()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('Original listener absent')
  const generations: unknown = Reflect.get(ingress, 'generations'), peers: unknown = Reflect.get(ingress, 'peers')
  if (!(generations instanceof ConnectionGenerations) || !(peers instanceof LoginPeerRegistry)) throw Error('Original access owners absent')
  const generation = generations.current(graph.binding, 'binary-generation' as Parameters<ConnectionGenerations['current']>[1])
  const headers = { Host: '127.0.0.1:4100', Origin: config.publicOrigin, Cookie: 'better-auth.session_token=fixture',
    'x-pe-account': graph.binding.accountId, 'x-pe-generation': generation }
  const budget = new ReleaseSkillBinaryBudget({ maxArchiveBytes: 1048576, maxResidentBytes: 1114112,
    chunkBytes: 65536, maxConcurrent: 1, timeoutMs: 5000 })
  let mode: 'complete' | 'cancel' | 'unknown' = 'complete', sourceSettled = 0
  let gate = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const cause = new Error('original source cleanup unknown')
  const consume = vi.spyOn(graph.api, workspace ? 'consumeWorkspaceUploadResponse' : 'consumeSkillReleaseResponse').mockImplementation(async (borrow: BorrowedBinaryResponse): Promise<BinaryResponseSettlement> => {
    if (mode === 'unknown') {
      await budget.withArchive(1024, async (retain) => { retain(cause) })
      borrow.response.end(); await once(borrow.response, 'finish')
      return { cleanup: 'unknown', cause }
    }
    return budget.withArchive(1024, async () => {
      borrow.assertCurrent(); borrow.response.writeHead(200, { 'content-type': 'application/octet-stream' })
      if (mode === 'complete') {
        borrow.response.end('complete'); await once(borrow.response, 'finish')
        return { cleanup: 'confirmed', outcome: 'completed' }
      }
      borrow.response.write('first')
      entered.resolve(undefined)
      try { await gate.promise }
      finally { sourceSettled++ }
      if (!borrow.response.closed) { borrow.response.destroy(); await once(borrow.response, 'close') }
      return { cleanup: 'confirmed', outcome: 'cancelled' }
    })
  })
  const call = (extra: Record<string, string> = {},
    navigation?: { query: string; method?: string; headers?: boolean; path?: string }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port,
        path: navigation === undefined ? path : `${navigation.path ?? path}?${navigation.query}`, method: navigation?.method ?? method, agent: false,
        headers: { ...navigation !== undefined && !navigation.headers
          ? { Host: headers.Host, Origin: headers.Origin, Cookie: headers.Cookie } : headers, ...extra } }, (response) => {
        let body = ''; response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') }); response.on('error', reject)
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
      }); request.on('error', reject); request.end()
    })
  const cancel = () => {
    const received = Promise.withResolvers<undefined>()
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path, method, agent: false, headers }, (response) => {
      response.on('error', () => {}); response.once('data', () => { response.destroy(); request.destroy(); received.resolve(undefined) })
    }); request.on('error', () => {}); request.end(); return received.promise
  }
  return { ingress, peers, pending, budget, consume, acquirePeer, call, cancel,
    query: `peAccount=${encodeURIComponent(graph.binding.accountId)}&peGeneration=${encodeURIComponent(generation)}`,
    uses: () => uses, sourceSettled: () => sourceSettled,
    setMode(value: typeof mode) { mode = value; gate = Promise.withResolvers<undefined>(); entered = Promise.withResolvers<undefined>() },
    entered: () => entered.promise, settle: () => { gate.resolve(undefined) },
    logout: async () => { loggedIn = false; await ingress.invalidateLogin(login.session.id as Parameters<CloudIngress['invalidateLogin']>[0]) } }
}

it.each([false, true])('keeps the same real Peer after confirmed TCP cancellation and releases only after source cleanup joins (workspace=%s)', async (workspace) => {
  const f = await fixture(workspace)
  expect((await f.call()).body).toBe('complete')
  const peer: unknown = await f.acquirePeer.mock.results[0]!.value
  f.setMode('cancel')
  await f.cancel(); await f.entered()
  expect(f.budget.snapshot().active).toBe(1); expect(f.peers.reservedCarriers).toBe(1)
  expect(f.sourceSettled()).toBe(0); expect(f.uses()).toBe(2)
  f.settle(); await Promise.all(f.pending)
  expect(f.sourceSettled()).toBe(1); expect(f.peers.reservedCarriers).toBe(0); expect(f.uses()).toBe(1)
  expect(f.budget.snapshot().active).toBe(0)
  f.setMode('complete'); expect((await f.call()).body).toBe('complete')
  expect(await f.acquirePeer.mock.results.at(-1)!.value).toBe(peer)
})

it.each([false, true])('rejects foreign-account and stale-generation carriers before the binary source (workspace=%s)', async (workspace) => {
  const f = await fixture(workspace)
  expect((await f.call({ 'x-pe-generation': 'stale' })).status).toBe(409)
  expect((await f.call({ Cookie: 'better-auth.session_token=foreign' })).status).toBe(409)
  expect((await f.call({ Cookie: '' })).status).toBe(401)
  expect(f.consume).not.toHaveBeenCalled(); expect(f.peers.reservedCarriers).toBe(0)
  expect((await f.call()).status).toBe(200)
})

it.each([false, true])('closes a revoked Peer while confirmed source cleanup releases its old operation and all uses (workspace=%s)', async (workspace) => {
  const f = await fixture(workspace); f.setMode('cancel')
  await f.cancel(); await f.entered()
  const logout = f.logout()
  f.settle(); await logout; await Promise.all(f.pending)
  // Invalidation joins native cleanup first to avoid waiting on its own carrier; full owner closure joins that already-started close.
  await f.peers.closeActual()
  expect(f.sourceSettled()).toBe(1); expect(f.budget.snapshot().active).toBe(0)
  expect(f.peers.reservedCarriers).toBe(0); expect(f.peers.reservedPeers).toBe(0); expect(f.uses()).toBe(0)
  expect((await f.call()).status).toBe(401)
})

it.each([false, true])('retains original cause, positive bytes and blocked owners when source cleanup is unknown (workspace=%s)', async (workspace) => {
  const f = await fixture(workspace); f.setMode('unknown')
  await f.call()
  const settled = await Promise.allSettled(f.pending)
  expect(settled[0]).toMatchObject({ status: 'rejected', reason: { code: 'cloud/stop-unconfirmed', cause: {
    code: 'cloud/stop-unconfirmed', cause: { message: 'original source cleanup unknown' },
  } } })
  expect(f.budget.snapshot()).toMatchObject({ active: 1, residentBytes: 66560, cleanupUnknown: 1 })
  expect(f.peers.reservedCarriers).toBe(1); expect(f.peers.reservedPeers).toBe(1); expect(f.uses()).toBe(2)
  expect(f.ingress.observe().state).toBe('unknown')
})

it('borrows only the exact skill attachment GET/HEAD query through the original Loader/API Peer and revokes that login', async () => {
  const f = await fixture()
  for (const method of ['GET', 'HEAD']) {
    expect((await f.call({}, { query: f.query, method })).status).toBe(200)
    expect(f.consume.mock.calls.at(-1)?.[0].navigationQueryNames).toEqual(['peAccount', 'peGeneration'])
  }
  expect((await f.call()).status).toBe(200)
  expect(f.consume.mock.calls.at(-1)?.[0].navigationQueryNames).toBeUndefined()
  const count = f.consume.mock.calls.length
  for (const query of [f.query + '&peAccount=binary-A', f.query.replace(/peGeneration=[^&]+/, 'peGeneration=stale'),
    f.query.replace('peAccount=binary-A', 'peAccount=binary-B'), 'peAccount=binary-A', 'peGeneration=stale']) {
    expect((await f.call({}, { query })).status).toBe(409)
  }
  expect((await f.call({}, { query: f.query, headers: true })).status).toBe(409)
  expect((await f.call({}, { query: f.query, method: 'POST' })).status).toBe(409)
  expect((await f.call({}, { query: f.query, path: '/api/skills/release-archive/other' })).status).toBe(409)
  expect((await f.call({ Cookie: 'better-auth.session_token=foreign' }, { query: f.query })).status).toBe(409)
  expect((await f.call({ Cookie: '' }, { query: f.query })).status).toBe(401)
  expect(f.consume).toHaveBeenCalledTimes(count)
  await f.logout()
  expect((await f.call({}, { query: f.query })).status).toBe(401)
})
