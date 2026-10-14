/** Actual route registrations, HTTP bodies and delayed socket closes exercise both native carrier owners. */
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { IncomingMessage, request as httpRequest } from 'node:http'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { identity } from '../src/contracts.ts'
import { BrowserAgentAuth } from '../src/host/browser-auth.ts'
import { installNativeRuntimeRoutingUpgrade } from '../src/host/native-runtime-routing.ts'
import { installNativeRuntimePoolRoutes } from '../src/platform/native-runtime-pool-routes.ts'
import { installNativeExecutionHttp } from '../src/platform/native-execution-http.ts'
import type { NativeRuntimePool, NativeRuntimePoolConfig } from '../src/platform/native-runtime-pool.ts'
import type { IdentityService } from '../src/platform/identity.ts'

const origin = 'https://trial.example', token = 'a'.repeat(43)
const user = { ...identity.parse({ userId: randomUUID(), username: 'fixture' }),
  settings: { model: 'fixture-model', maxTokens: 1000, revision: 1 } }
const config: NativeRuntimePoolConfig = {
  kubeconfigFile: '/unused', namespace: 'owned', image: 'fixture@sha256:' + 'a'.repeat(64), runtimeClass: 'gvisor',
  volumeClaimName: 'owned', storageSubPath: 'homes', localStateRoot: '/unused',
  deployment: { mode: 'https', privateDir: '/unused', dshHome: '/unused', hostOrigin: origin,
    platformOrigin: 'https://platform.example', platformInternalUrl: 'http://platform', rows: {} },
  credentialLifetimeMs: 60000, readyTimeoutMs: 1000, requestTimeoutMs: 1000, stopTimeoutMs: 1000,
  reconcileMs: 60000, maxResponseBytes: 1048576, maxRuntimeSeconds: 60, maxAccounts: 2, lockConnections: 1,
  resources: { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } },
}

async function web() {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return ctx
}

function dependencies(authenticate: IdentityService['authenticate'] = async () => user) {
  return { pool: { invoke: vi.fn<NativeRuntimePool['invoke']>(async (_id, _token, request) => ({ original: request })),
    streamTarget: vi.fn(async () => ({ path: '/owned', token: 'fixture-runtime' })),
    reconcile: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  identities: { authenticate }, kube: { proxyUpgrade: vi.fn(async () => {}) } }
}

class DeferredCloseTransport extends PassThrough {
  release = Promise.withResolvers<void>()
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    void this.release.promise.then(() => { callback(error) })
  }
}

for (const kind of ['host', 'platform'] as const) test(`${kind} rejection remains owned until its transport actually closes`, async () => {
  const ctx = await web(), socket = new DeferredCloseTransport(), registered = vi.spyOn(ctx.webServer, 'registerUpgrade')
  const request = new IncomingMessage(new Socket())
  request.url = '/native/api/remote.mux'; request.headers = { origin, host: 'trial.example' }
  if (kind === 'host') {
    installNativeRuntimeRoutingUpgrade(ctx, new BrowserAgentAuth(origin, 'https://platform.example', { call: async () => user }),
      origin, 'http://127.0.0.1:1', 1000)
  } else installNativeRuntimePoolRoutes(ctx, dependencies().pool, dependencies().kube, dependencies().identities, config, 4096)
  const handler = registered.mock.calls[0]?.[0].handler
  if (!handler) throw new Error('Factory did not register its native upgrade')
  let serving: Promise<void> | undefined, disposing: Promise<void> | undefined, settled = false
  try {
    const finished = once(socket, 'finish')
    serving = Promise.resolve(handler(request, socket, Buffer.alloc(0)))
    await finished
    disposing = ctx.fiber.dispose().then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    socket.release.resolve(); await serving; await disposing
    expect(socket.closed).toBe(true)
  } finally {
    socket.release.resolve(); socket.destroy(); request.destroy()
    await serving; await (disposing ?? ctx.fiber.dispose())
  }
})

test('platform shutdown joins authentication and never starts a late account allocation', async () => {
  const ctx = await web(), registered = vi.spyOn(ctx.webServer, 'registerUpgrade'), socket = new PassThrough()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<typeof user>()
  const deps = dependencies(async () => { entered.resolve(); return await release.promise })
  const close = installNativeRuntimePoolRoutes(ctx, deps.pool, deps.kube, deps.identities, config, 4096)
  const handler = registered.mock.calls[0]?.[0].handler
  if (!handler) throw new Error('Factory did not register its native upgrade')
  const request = new IncomingMessage(new Socket()); request.headers = { origin, authorization: 'Bearer ' + token }
  let serving: Promise<void> | undefined, disposing: Promise<void> | undefined, settled = false
  try {
    serving = Promise.resolve(handler(request, socket, Buffer.alloc(0))); await entered.promise
    disposing = close().then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false)
    release.resolve(user); await serving; await disposing
    expect(deps.pool.streamTarget).not.toHaveBeenCalled()
    expect(deps.kube.proxyUpgrade).not.toHaveBeenCalled()
    expect(deps.pool.close).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve(user); socket.destroy(); request.destroy(); await serving; await disposing; await ctx.fiber.dispose()
  }
})

test('the registered platform HTTP carrier preserves the original native envelope and bearer', async () => {
  const ctx = await web(), deps = dependencies(), close = installNativeRuntimePoolRoutes(ctx, deps.pool, deps.kube, deps.identities, config, 4096)
  const body = { type: 'client-request', rpcId: 'original', method: 'pluginManager/example', payload: { args: { exact: 'original' } } }
  try {
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/native/runtime/invoke`, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ original: body })
    expect(deps.pool.invoke).toHaveBeenCalledWith(user.userId, token, body)
  } finally { await close(); await ctx.fiber.dispose() }
})

for (const kind of ['platform', 'execution'] as const) test(`${kind} HTTP shutdown cancels a partial body and joins its transport before returning`, async () => {
  const ctx = await web(), entered = Promise.withResolvers<void>(), original = ctx.webServer.register.bind(ctx.webServer)
  vi.spyOn(ctx.webServer, 'register').mockImplementation(route => original({ ...route, handler: (request, response) => {
    request.once('data', () => { entered.resolve() }); return route.handler(request, response)
  } }))
  const deps = dependencies(), dispatch = vi.fn(async () => ({ stopped: true }))
  const close = kind === 'platform' ? installNativeRuntimePoolRoutes(ctx, deps.pool, deps.kube, deps.identities, config, 4096)
    : installNativeExecutionHttp(ctx, { route: dispatch }, 4096)
  const client = httpRequest(`http://127.0.0.1:${ctx.webServer.port}` + (kind === 'platform' ? '/native/runtime/invoke' : '/runtime/native-world/process/release'),
    { method: 'POST', headers: { authorization: 'Bearer ' + token, origin, 'content-type': 'application/json' } })
  client.on('error', () => {})
  const exited = new Promise<void>(resolve => { client.once('close', () => { resolve() }) })
  try {
    client.write('{"incomplete":'); await entered.promise
    expect(close()).toBe(close()); await close(); await exited
    expect(deps.pool.invoke).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  } finally { client.destroy(); await close(); await ctx.fiber.dispose() }
})

test('the registered execution cleanup carrier forwards the original bearer without browser substitution', async () => {
  const ctx = await web(), dispatch = vi.fn(async () => ({ stopped: true })), close = installNativeExecutionHttp(ctx, { route: dispatch }, 4096)
  const body = { world: { original: 'identity' }, id: randomUUID() }
  try {
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/runtime/native-world/process/release`, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ stopped: true })
    expect(dispatch).toHaveBeenCalledWith('/runtime/native-world/process/release', token, body)
  } finally { await close(); await ctx.fiber.dispose() }
})

for (const kind of ['platform', 'execution'] as const) test(`${kind} HTTP shutdown joins a dispatch already admitted before close`, async () => {
  const ctx = await web(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const dispatch = vi.fn(async () => { entered.resolve(); await release.promise; return { stopped: true } })
  const deps = dependencies()
  deps.pool.invoke = dispatch
  const close = kind === 'platform' ? installNativeRuntimePoolRoutes(ctx, deps.pool, deps.kube, deps.identities, config, 4096)
    : installNativeExecutionHttp(ctx, { route: dispatch }, 4096)
  const body = kind === 'platform' ? { type: 'client-request', rpcId: 'joined', method: 'pluginManager/example', payload: { args: {} } }
    : { original: 'operation' }
  const client = httpRequest(`http://127.0.0.1:${ctx.webServer.port}` + (kind === 'platform' ? '/native/runtime/invoke' : '/runtime/native-world/process/release'),
    { method: 'POST', headers: { authorization: 'Bearer ' + token, origin, 'content-type': 'application/json' } })
  client.on('error', () => {})
  const exited = new Promise<void>(resolve => { client.once('close', () => { resolve() }) })
  let disposing: Promise<void> | undefined, settled = false
  try {
    client.end(JSON.stringify(body)); await entered.promise
    disposing = close().then(() => { settled = true })
    await exited; await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    release.resolve(); await disposing
    expect(dispatch).toHaveBeenCalledTimes(1)
    if (kind === 'platform') expect(deps.pool.close).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); client.destroy(); await disposing; await close(); await ctx.fiber.dispose() }
})
