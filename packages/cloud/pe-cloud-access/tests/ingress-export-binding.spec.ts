/** Real loopback ingress and native download routes; Root, login DB and file bytes are explicit fixtures. */
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
import { registerWorkspaceTransfers } from '../../pe-cloud-api/src/workspace-transfers.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { ConnectionGenerations } from '../src/generations.ts'
import { accessConfig, ingressConfig } from './ingress-fixture.ts'

const exportRoutes = ['GET', 'HEAD'].map(method => ({ method, path: SESSION_LOG_EXPORT_PATH,
  handlerId: 'native:sessionLogDownload', guard: 'account-session' as const }))
const downloadPath = '/api/workspace-files/download'
const downloadRoutes = ['GET', 'HEAD'].map(method => ({ method, path: downloadPath,
  handlerId: 'native:workspaceFiles', guard: 'account-session' as const }))

async function fixture(reviewDownload = true) {
  const reviewed = [...exportRoutes, ...reviewDownload ? downloadRoutes : []]
  const native = policyFixture([], { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
    maxQueuedEvents: 128, maxQueuedBytes: 4194304 }, 'component',
  { selected: reviewed, inspectRootFetch: () => reviewed })
  const start = (epoch = '1') => native.start(epoch, native.config, true, { maxNativeInventoryEntries: 256 })
  let graph = await start()
  const data = Buffer.from([0, 255, 2, 13, 10]), content = vi.fn(), select = vi.fn()
  const install = async (): Promise<void> => {
    const current = graph
    await current.ctx.plugin({ inject: connectionInject, apply: applyConnection })
    current.ctx.provide('commands', { register: () => () => {} } as never)
    registerSessionLogExport(current.ctx, {}, async (sessionId, request) => {
      await current.guards.sessions.assertSessionProject(sessionId)
      return request.signal
    })
    // The storage worker is outside this ingress fixture; native Session selection and HTTP streaming remain real.
    vi.spyOn(current.files, 'workspaceContent').mockImplementation(async (_workspace, check, signal) => {
      check(); signal?.throwIfAborted(); content()
      return {
        lstat: async (path: string) => ({ value: path === 'report.bin'
          ? { type: 'file', size: data.length, version: 'fixture-v1' } : undefined, release() {} }),
        readByteRange: async (_path: string, range: { offset: number; length: number }) =>
          ({ value: data.subarray(range.offset, range.offset + range.length), release() {} }),
      } as never
    })
    registerWorkspaceTransfers(current.ctx, { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 2048,
      chunkBytes: 2, maxPathBytes: 1024, timeoutMs: 5000 }, async (id, signal) => {
      select()
      const resolve = current.guards.resolveFileTransfer
      if (resolve === undefined) throw new Error('Original account Session file policy absent')
      return { ...await resolve(id, signal), files: current.files }
    }, (method, path) => { current.api.requireFetch(method, path) }, current.binding.lifetime)
  }
  await install()
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
    new Promise<{ status: number; body: Buffer; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path, method, agent: false,
        headers: { Host: '127.0.0.1:4100', Origin: config.publicOrigin, ...includeCookie ? { Cookie: cookie } : {}, ...extra } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) }); response.on('error', reject)
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers }) })
      })
      request.on('error', reject); request.end()
    })
  const restart = async () => {
    await Promise.allSettled(pending)
    await graph.close()
    graph = await start('2')
    await install()
    const next = generations.current(graph.binding, 'fixture-next-generation' as Parameters<ConnectionGenerations['current']>[1])
    const own = await graph.ctx.sessionController.create({})
    return { query: `peAccount=${encodeURIComponent(account)}&peGeneration=${encodeURIComponent(next)}`, own: own.sessionId }
  }
  return { call, query, account, generation, own: own.sessionId, pending, data, content, select, restart,
    expireLogin: () => { login.session.expiresAt = new Date(Date.now() - 1000) } }
}

it('binds the original ZIP navigation query to the authenticated account and current generation', async () => {
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

it('downloads with explicit query binding and retains header-bound HEAD preflight', async () => {
  const f = await fixture(), route = `${downloadPath}?sessionId=${encodeURIComponent(f.own)}&path=report.bin`
  const headers = { 'x-pe-account': f.account, 'x-pe-generation': f.generation }
  for (const method of ['GET', 'HEAD']) {
    for (const carrier of ['query', 'headers']) {
      const response = await f.call(carrier === 'query' ? `${route}&${f.query}` : route, method,
        carrier === 'headers' ? headers : {})
      expect(response.status).toBe(200)
      expect(response.headers['content-disposition']).toContain('attachment;')
      expect(response.headers['content-length']).toBe(String(f.data.length))
      expect(response.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : f.data)
    }
  }
  const preflight = await f.call(`${downloadPath}?sessionId=${f.own}`, 'HEAD', headers)
  expect(preflight.status).toBe(200)
  expect(preflight.headers['x-workspace-max-files']).toBe('10')
})

it('rejects missing, duplicate, mixed, wrong-account and stale download bindings before Session selection', async () => {
  const f = await fixture(), route = `${downloadPath}?sessionId=${f.own}&path=report.bin`
  const account = `peAccount=${encodeURIComponent(f.account)}`, generation = `peGeneration=${encodeURIComponent(f.generation)}`
  for (const method of ['GET', 'HEAD']) {
    for (const binding of ['', account, generation, `${account}&peGeneration=stale`, `peAccount=foreign&${generation}`,
      `${f.query}&${account}`, `${f.query}&${generation}`]) {
      expect((await f.call(`${route}&${binding}`, method)).status).toBe(409)
    }
    const mixedHeaders: Record<string, string>[] = [{ 'x-pe-account': f.account }, { 'x-pe-generation': f.generation },
      { 'x-pe-account': f.account, 'x-pe-generation': f.generation }]
    for (const headers of mixedHeaders) {
      expect((await f.call(`${route}&${f.query}`, method, headers)).status).toBe(409)
    }
  }
  expect(f.select).not.toHaveBeenCalled()
  expect(f.content).not.toHaveBeenCalled()
})

it('does not accept query binding on other paths or download methods', async () => {
  const f = await fixture()
  for (const [path, method] of [[`${downloadPath}/other`, 'GET'], [`${downloadPath}/`, 'HEAD'],
    [downloadPath, 'POST'], [downloadPath, 'OPTIONS'], ['/api/workspace-files/directory', 'POST'],
    ['/api/session/list', 'GET'], ['/api/workspace-files/download.other', 'GET']]) {
    expect((await f.call(`${path}?sessionId=${f.own}&path=report.bin&${f.query}`, method)).status).toBe(409)
  }
  expect(f.select).not.toHaveBeenCalled()
  expect(f.content).not.toHaveBeenCalled()
})

it('requires authenticated current login and original Session membership for a bound download', async () => {
  const f = await fixture(), route = `${downloadPath}?sessionId=${f.own}&path=report.bin&${f.query}`
  expect((await f.call(route, 'GET', {}, false)).status).toBe(401)
  expect((await f.call(route, 'GET', { Origin: 'http://other.invalid' })).status).toBe(403)
  expect(f.select).not.toHaveBeenCalled()
  expect((await f.call(`${downloadPath}?sessionId=foreign-session&path=report.bin&${f.query}`)).status).toBe(400)
  expect(f.content).not.toHaveBeenCalled()
  expect((await f.call(route)).body).toEqual(f.data)
  f.expireLogin()
  f.content.mockClear(); f.select.mockClear()
  expect((await f.call(route)).status).toBe(401)
  expect(f.select).not.toHaveBeenCalled()
  expect(f.content).not.toHaveBeenCalled()
})

it('rejects a previous epoch download token and accepts only the replacement graph token', async () => {
  const f = await fixture(), route = `${downloadPath}?sessionId=${f.own}&path=report.bin`
  expect((await f.call(`${route}&${f.query}`)).body).toEqual(f.data)
  const next = await f.restart()
  expect(next.query).not.toBe(f.query)
  const nextRoute = `${downloadPath}?sessionId=${next.own}&path=report.bin`
  f.content.mockClear(); f.select.mockClear()
  for (const method of ['GET', 'HEAD']) expect((await f.call(`${nextRoute}&${f.query}`, method)).status).toBe(409)
  expect(f.select).not.toHaveBeenCalled()
  expect(f.content).not.toHaveBeenCalled()
  expect((await f.call(`${nextRoute}&${next.query}`)).body).toEqual(f.data)
})

it('does not expose an unreviewed download handler merely because query binding is accepted', async () => {
  const f = await fixture(false)
  expect((await f.call(`${downloadPath}?sessionId=${f.own}&path=report.bin&${f.query}`)).status).toBe(403)
  expect(f.select).not.toHaveBeenCalled()
  expect(f.content).not.toHaveBeenCalled()
})
