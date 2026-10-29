/** Real loopback ingress and native ZIP route; Root admission and login database answers are explicit fixtures. */
import { createServer, request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { registerSessionLogExport, SESSION_LOG_EXPORT_PATH } from '@deepseek-ai/dsh-session-log-export'
import { SessionId } from '@deepseek-ai/dsh-session'
import pg from 'pg'
import type { Auth } from 'better-auth'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { ConnectionGenerations } from '../src/generations.ts'
import { accessConfig, ingressConfig } from './ingress-fixture.ts'

const exportRoutes = ['GET', 'HEAD'].map(method => ({ method, path: SESSION_LOG_EXPORT_PATH,
  handlerId: 'native:sessionLogDownload', guard: 'account-session' as const }))

async function fixture() {
  const native = policyFixture([], { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
    maxQueuedEvents: 128, maxQueuedBytes: 4194304 }, 'component',
  { selected: exportRoutes, inspectRootFetch: () => exportRoutes })
  const graph = await native.start()
  await graph.ctx.plugin({ inject: connectionInject, apply: applyConnection })
  graph.ctx.provide('commands', { register: () => () => {} } as never)
  registerSessionLogExport(graph.ctx, {}, async (sessionId, request) => {
    await graph.guards.sessions.assertSessionProject(sessionId)
    return request.signal
  })
  const own = await graph.ctx.sessionController.create({})
  const root = new Context(), sockets = new Set<Socket>(), pending: Promise<void>[] = []
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1, connectionTimeoutMillis: 10 })
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Physical SQL is forbidden in this fixture') })
  const config = { ...accessConfig(), sessionRecheckMs: 5000, authCheckTimeoutMs: 1000, peerCloseTimeoutMs: 1000 }
  const auth = await BetterAuthAccess.create(config, pool, 'ingress-export-offline-secret-01234567890123456789',
    async (id) => { await ingress.invalidateLogin(id) })
  const library = Reflect.get(auth, 'auth') as Auth, createdAt = new Date()
  const login = { user: { id: graph.binding.accountId, name: 'Export', email: 'export@example.test', emailVerified: true,
    createdAt, updatedAt: createdAt }, session: { id: 'original-export-login', userId: graph.binding.accountId,
    token: 'offline-fixture', expiresAt: new Date(Date.now() + 60000), createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null } }
  vi.spyOn(library.api, 'getSession').mockImplementation(async input =>
    new Headers(input?.headers).get('cookie') === 'better-auth.session_token=fixture' ? login : null)
  const runtime = new PeAccountRuntime(root, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  vi.spyOn(runtime, 'assertRecipeSealed').mockImplementation(() => {})
  vi.spyOn(runtime, 'assertBusinessCurrent').mockImplementation((binding) => {
    expect(binding).toBe(graph.binding); graph.binding.lifetime.throwIfAborted()
  })
  const borrow = () => ({ binding: graph.binding, context: graph.ctx,
    assertCurrent() { graph.ctx.fiber.assertActive(); graph.binding.lifetime.throwIfAborted() }, release() {} })
  vi.spyOn(runtime, 'locateAccount').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'acquireAccount').mockImplementation(async () => borrow())
  vi.spyOn(runtime, 'borrowAccount').mockImplementation(async () => borrow())
  const web = new WebServer(root, { host: '127.0.0.1', port: 0 }), routes = vi.spyOn(web, 'register')
  const ingress = new CloudIngress(root, config, { ...ingressConfig(), requestTimeoutMs: 5000, sessionRecheckLeadMs: 1000,
    maxRequestBodyBytes: 262144, maxFrameBytes: 262144 }, auth,
  { web, runtime, recipeVersion: graph.binding.recipeVersion, assertAuthenticationCurrent() {} })
  const server = createServer((request, response) => {
    const route = routes.mock.calls.find(([value]) => value.path === '/api')?.[0]
    if (route === undefined) throw new Error('Original API ingress route absent')
    pending.push(Promise.resolve(route.handler(request, response)))
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket) }) })
  onTestFinished(async () => {
    try { await ingress.closeActual(); await Promise.allSettled(pending); await auth.close(); await pool.end(); await root.fiber.dispose() }
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
  if (address === null || typeof address === 'string') throw new Error('Export fixture listener missing')
  const generations: unknown = Reflect.get(ingress, 'generations')
  if (!(generations instanceof ConnectionGenerations)) throw new Error('Original generation owner absent')
  const generation = generations.current(graph.binding, 'fixture-generation' as Parameters<ConnectionGenerations['current']>[1])
  const cookie = 'better-auth.session_token=fixture', account = graph.binding.accountId
  const query = `peAccount=${encodeURIComponent(account)}&peGeneration=${encodeURIComponent(generation)}`
  const call = (path: string, method = 'GET', extra: Record<string, string> = {}, includeCookie = true) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path, method, agent: false,
        headers: { Host: '127.0.0.1:4100', Origin: config.publicOrigin, ...includeCookie ? { Cookie: cookie } : {}, ...extra } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) }); response.on('error', reject)
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }) })
      })
      request.on('error', reject); request.end()
    })
  return { call, query, account, generation, own: own.sessionId, pending }
}

it('binds only the original ZIP navigation query to the authenticated account and current generation', async () => {
  const f = await fixture(), route = `${SESSION_LOG_EXPORT_PATH}?sessionId=${encodeURIComponent(f.own)}&includeDescendants=true`
  const downloaded = await f.call(`${route}&${f.query}`)
  expect(downloaded.status).toBe(200)
  expect(downloaded.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  expect((await f.call(route, 'GET', { 'x-pe-account': f.account, 'x-pe-generation': f.generation })).status).toBe(200)
  expect((await f.call(route, 'HEAD', { 'x-pe-account': f.account, 'x-pe-generation': f.generation })).status).toBe(200)
  expect((await f.call(`${route}&${f.query}`, 'HEAD')).status).toBe(409)
  expect((await f.call(`/api/session/list?${f.query}`)).status).toBe(409)
  expect((await f.call(`${SESSION_LOG_EXPORT_PATH}/other?${f.query}`)).status).toBe(409)
  expect((await f.call(`${route}&${f.query}`, 'POST')).status).toBe(409)
  expect((await f.call(`${route}&${f.query}&peAccount=${encodeURIComponent(f.account)}`)).status).toBe(409)
  expect((await f.call(`${route}&${f.query}&peGeneration=${encodeURIComponent(f.generation)}`)).status).toBe(409)
  expect((await f.call(`${route}&peAccount=${encodeURIComponent(f.account)}`)).status).toBe(409)
  expect((await f.call(`${route}&peAccount=foreign&peGeneration=${encodeURIComponent(f.generation)}`)).status).toBe(409)
  expect((await f.call(`${route}&peAccount=${encodeURIComponent(f.account)}&peGeneration=stale`)).status).toBe(409)
  expect((await f.call(`${route}&${f.query}`, 'GET', { 'x-pe-account': 'foreign', 'x-pe-generation': f.generation })).status).toBe(409)
  expect((await f.call(`${route}&${f.query}`, 'GET', { Origin: 'http://other.invalid' })).status).toBe(403)
  expect((await f.call(`${route}&${f.query}`, 'GET', {}, false)).status).toBe(401)
  expect((await f.call(`${SESSION_LOG_EXPORT_PATH}?sessionId=${SessionId('foreign-session')}&${f.query}`)).status).toBe(403)
  await Promise.allSettled(f.pending)
})
