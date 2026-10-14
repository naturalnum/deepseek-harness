/** Actual Node transports cover startup admission, browser-cookie forwarding and original HMR bytes. */
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { installNativeClientHttp } from '../src/native-client-http.ts'
import { installNativeClientRouting } from '../src/host/native-client-routing.ts'
import { proxyRuntimeHttp } from '../src/runtime-http-proxy.ts'
import { BrowserAgentAuth } from '../src/host/browser-auth.ts'
import NativeAdmission from '../src/host/native-runtime-ui-admission.ts'

const token = 'a'.repeat(43), runtimeToken = 'b'.repeat(43), userId = randomUUID()
const user = { userId, username: 'fixture', settings: { model: 'fixture-model', maxTokens: 1000, revision: 1 } }
const limits = { maxBytes: 1048576, maxFrameBytes: 1048576, handshakeMs: 1000, lifetimeMs: 3000 }

async function web(admission?: (request: import('node:http').IncomingMessage) => Promise<boolean>) {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, ...(admission ? { requestAdmission: admission } : {}) })
  return ctx
}

test('startup HTTP admission gates original exact routes and joins a late credential decision', async () => {
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<boolean>()
  const ctx = await web(async () => { entered.resolve(undefined); return gate.promise })
  const dispatched = vi.fn((_request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => { response.end('original') })
  ctx.webServer.register({ kind: 'exact', path: '/plugins/events', handler: dispatched })
  const request = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/plugins/events`)
  request.on('error', () => {})
  let disposed = false
  try {
    request.end(); await entered.promise
    const close = ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve)); expect(disposed).toBe(false)
    gate.resolve(true); await close
    expect(dispatched).not.toHaveBeenCalled()
  } finally { gate.resolve(false); request.destroy(); await ctx.fiber.dispose() }
})

test('tenant startup admission rejects missing and foreign credentials on actual original routes', async () => {
  const ctx = new Context(), verifier = vi.fn(async (path: string, credential: string) => {
    if (path !== '/identity/me' || credential !== token) throw new Error('denied')
    return user
  })
  ctx.provide('powerEvolveRuntime', { config: { runtimeUserId: userId }, call: verifier,
    verifyBroker: async (credential?: string) => { if (credential !== runtimeToken) throw new Error('denied') } })
  const admission = new NativeAdmission(ctx, { origin: 'http://127.0.0.1:12345', platformOrigin: 'https://platform.example' })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, requestAdmission: admission.admit })
  for (const path of ['/plugins/events', '/api', '/api/remote.mux']) {
    ctx.webServer.register({ kind: 'exact', path, handler: (_request, response) => { response.end('original') } })
  }
  try {
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    for (const headers of [{}, { 'x-power-evolve-runner-token': 'foreign', 'x-power-evolve-browser-token': token },
      { 'x-power-evolve-runner-token': runtimeToken, 'x-power-evolve-browser-token': 'c'.repeat(43) }]) {
      expect((await fetch(base + '/plugins/events', { headers })).status).toBe(403)
    }
    const headers = { 'x-power-evolve-runner-token': runtimeToken, 'x-power-evolve-browser-token': token }
    expect(await (await fetch(base + '/plugins/events', { headers })).text()).toBe('original')
    expect((await fetch(base + '/api', { headers })).status).toBe(403)
    expect((await fetch(base + '/api/remote.mux', { headers })).status).toBe(403)
  } finally { await admission.shutdown(); await ctx.fiber.dispose() }
})

test('browser-scoped cookie forwards unchanged combo revision bytes through the actual Host carrier', async () => {
  const upstream = createServer((request, response) => {
    expect(request.url).toBe('/native/runtime/plugins/??fixture/client.js&rev=original')
    expect(request.headers.authorization).toBe(`Bearer ${token}`)
    response.writeHead(200, { 'content-type': 'text/javascript' }); response.end('original-client-bytes')
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Missing owned listener')
  const ctx = await web(), origin = `http://127.0.0.1:${ctx.webServer.port}`
  const auth = new BrowserAgentAuth(origin, 'https://platform.example', { call: async (_path, credential) => {
    if (credential !== token) throw new Error('denied'); return user
  } })
  const close = installNativeClientRouting(ctx, auth, origin, `http://127.0.0.1:${address.port}`, 1048576, 1000)
  try {
    const response = await fetch(origin + '/native/plugins/??fixture/client.js&rev=original',
      { headers: { cookie: `pe_agent=${token}`, 'sec-fetch-site': 'same-origin' } })
    expect(response.status).toBe(200); expect(await response.text()).toBe('original-client-bytes')
    expect((await fetch(origin + '/native/plugins/??fixture/client.js&rev=original')).status).toBe(401)
  } finally { await close(); await ctx.fiber.dispose(); upstream.closeAllConnections(); upstream.close(); await once(upstream, 'close') }
})

test('whole accepted client carrier shutdown joins held admission and refuses late dispatch', async () => {
  const ctx = await web(), entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  const dispatch = vi.fn(), close = installNativeClientHttp(ctx, '/native/plugins', async (_request, response, _target, _method, signal) => {
    entered.resolve(undefined); await gate.promise; signal.throwIfAborted(); dispatch(); response.end()
  })
  const request = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/native/plugins/events`); request.on('error', () => {})
  let settled = false
  try {
    request.end(); await entered.promise
    const disposing = close().then(() => { settled = true }); expect(close()).toBe(close())
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false)
    gate.resolve(undefined); await disposing; expect(dispatch).not.toHaveBeenCalled()
  } finally { gate.resolve(undefined); request.destroy(); await close(); await ctx.fiber.dispose() }
})

test('an unanswered upstream handshake is interrupted and joined within its original budget', async () => {
  const upstream = createServer(), accepted = new Set<import('node:net').Socket>()
  upstream.on('connection', (socket) => { accepted.add(socket); socket.once('close', () => { accepted.delete(socket) }) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Missing owned listener')
  const ctx = await web()
  const close = installNativeClientHttp(ctx, '/native/plugins', async (_request, response, _target, method, signal) => {
    await proxyRuntimeHttp(response, new URL(`http://127.0.0.1:${address.port}/plugins/events`),
      { method, events: true, limits: { ...limits, handshakeMs: 30 }, signal })
  })
  try {
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/native/plugins/events`)
    expect(response.status).toBe(503)
    await response.text(); await close(); await expect.poll(() => accepted.size).toBe(0)
  } finally { await close(); await ctx.fiber.dispose(); upstream.closeAllConnections(); upstream.close(); await once(upstream, 'close') }
})
