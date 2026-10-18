// @vitest-environment jsdom
/** Canonical preparation consumed by real Loader entries before native cache/Connection use. */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type { ClientBundleRegistration, ClientModuleLoaderTarget, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { installConnection, type ConnectionHandle, type ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as cloud from '../src/client/index.ts'
import { PreparedCloudPage, type CloudPagePreparationInput } from '../src/client/prepared-page.ts'

const config = {
  bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
  maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000,
}
function bootstrap(accountId = 'A', connectionGeneration = 'G1'): CloudBootstrap {
  return {
    account: { id: accountId, displayName: accountId }, recipeVersion: 'recipe-1', connectionGeneration,
    capabilities: {
      projects: { state: 'available' }, filePreview: { state: 'disabled', reason: 'not-approved' },
      shell: { state: 'disabled', reason: 'not-approved' }, developmentServices: { state: 'disabled', reason: 'not-approved' },
      servicePreview: { state: 'disabled', reason: 'not-approved' }, sandboxScope: 'session',
      backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'catalog-1', plugins: [], skills: { manage: false }, credentials: { write: false }, fields: [] },
    },
  }
}
class Socket implements ConnectionWebSocket {
  readyState = 1
  send = vi.fn()
  private readonly listeners = new Set<() => void>()
  close(): void { this.readyState = 3; for (const listener of this.listeners) listener() }
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'close') this.listeners.add(() => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = () => {}
}
function fixture(response = bootstrap()) {
  const values = new Map<string, string>(), requests: Headers[] = [], sockets: string[] = []
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) },
  }
  const fetcher = vi.fn<CloudPagePreparationInput['fetch']>(async (url, init) => {
    if (new URL(url).pathname.endsWith('/cloud/bootstrap')) return Response.json(response)
    requests.push(new Headers(init.headers))
    if (typeof init.body !== 'string') throw new TypeError('Native RPC fixture requires a JSON body')
    const body: unknown = JSON.parse(init.body)
    const rpcId = typeof body === 'object' && body !== null && 'rpcId' in body ? body.rpcId : undefined
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: 'accepted' } })
  })
  const input: CloudPagePreparationInput = {
    baseUrl: 'https://example.test/app/', config, storage, fetch: fetcher,
    createWebSocket: (url) => { sockets.push(url); return new Socket() },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 20, maxKeyBytes: 128, maxValueBytes: 1000, maxTotalBytes: 5000, maxNamespaceBytes: 200 },
  }
  return { input, values, storage, fetcher, requests, sockets }
}

/** The real Loader owns both modules; only immutable module arrival and a finite native consumer are fixtures. */
function native(page: PreparedCloudPage, options: { bind?: boolean; config?: cloud.Config } = {}) {
  const ctx = new Context(), events: string[] = []
  const consumer = {
    inject: ['connection'],
    async apply(scope: Context) {
      events.push('native')
      expect(scope.get('peCloudPage')).toBe(page)
      const source = createSnapshotStore('', { persist: { name: 'draft.same-session', storage: scope.get('clientPersistence') } })
      source.set(page.bootstrap.account.id)
      const connection = scope.get('connection') as ConnectionHandle
      expect(await connection.rpc.call('/api', 'session/prompt', { sessionId: 'same-session' })).toEqual({ ok: true, value: 'accepted' })
      connection.openWebSocket('/api/remote.mux')
    },
  }
  const entry = {
    async run() {
      ctx.provide('clientPersistence', page.nativeOptions.persistence)
      if (options.bind !== false) page.nativeOptions.prepareContext(ctx)
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { cloud, 'native-consumer': consumer })
      // A dependent row starts first; the service dependency owns activation order.
      await Promise.all([
        ctx.loader.create({ name: 'cordis:native-consumer' }),
        ctx.loader.create({ name: 'cordis:cloud', config: options.config ?? {} }),
      ])
      await ctx.loader.await()
      if ([...ctx.loader.entries()].some(row => row.fiber?.state !== FiberState.ACTIVE)) throw new Error('native Loader activation failed')
    },
    async dispose() {
      const fibers = ctx.get('loader') === undefined ? [] : [...ctx.loader.entries()].flatMap(row => row.fiber === undefined ? [] : [row.fiber])
      await Promise.all(fibers.reverse().map(fiber => fiber.dispose()))
      await ctx.fiber.dispose()
    },
  }
  return { ctx, entry, events }
}

it('uses canonical bootstrap then the real Cloud Loader entry before native cache, HTTP and WS access', async () => {
  const f = fixture(), preparation = PreparedCloudPage.prepare(f.input, new AbortController().signal)
  onTestFinished(() => preparation.dispose())
  const page = await preparation.ready
  expect(preparation.getSnapshot()).toMatchObject({ phase: 'decoded', settled: true, cleanup: 'confirmed' })
  expect(f.storage.getItem).not.toHaveBeenCalled()
  expect(page.bootstrap.account.id).toBe('A')
  const graph = native(page)
  await page.start(graph.entry)
  expect(graph.events).toEqual(['native'])
  expect(f.requests[0]!.get('x-account')).toBe('A')
  expect(f.requests[0]!.get('x-generation')).toBe('G1')
  expect(f.sockets[0]).toContain('account=A&generation=G1')
  expect(page.nativeOptions.persistence.getItem('draft.same-session')).toBe('"A"')
  expect(graph.ctx.get('connection')).toBeDefined()
  await preparation.dispose()
  expect(f.values.size).toBe(0)
})

it.each([401, 409])('does not issue an owner, touch storage or activate native services after bootstrap HTTP %s', async (status) => {
  const f = fixture()
  const input = { ...f.input, fetch: vi.fn(async () => new Response(null, { status })) }
  const preparation = PreparedCloudPage.prepare(input, new AbortController().signal)
  await expect(preparation.ready).rejects.toMatchObject({ code: status === 401 ? 'unauthenticated' : 'bootstrap-rejected' })
  await preparation.dispose()
  expect(f.storage.getItem).not.toHaveBeenCalled()
  expect(f.values.size).toBe(0)
})

it('rejects malformed canonical metadata before issuing cache authority', async () => {
  const f = fixture()
  const input = { ...f.input, fetch: vi.fn(async () => Response.json({ account: { id: 'invented' }, ready: true })) }
  const preparation = PreparedCloudPage.prepare(input, new AbortController().signal)
  await expect(preparation.ready).rejects.toThrow()
  await preparation.dispose()
  expect(f.storage.getItem).not.toHaveBeenCalled()
})

it.each([false, true])('rejects missing preparation or mismatched Loader config without a Connection provider (bound=%s)', async (bind) => {
  const f = fixture(), preparation = PreparedCloudPage.prepare(f.input, new AbortController().signal)
  const page = await preparation.ready
  const graph = native(page, { bind, config: { ...config, maxSockets: config.maxSockets + 1 } })
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(async () => { await Promise.allSettled([preparation.dispose()]); report.mockRestore() })
  await expect(page.start(graph.entry)).rejects.toThrow('native Loader activation failed')
  expect(f.requests).toEqual([])
  expect(graph.events).toEqual([])
})

it('parent cancellation after preparation revokes the same fixed page without rebinding it', async () => {
  const f = fixture(), controller = new AbortController()
  const preparation = PreparedCloudPage.prepare(f.input, controller.signal)
  onTestFinished(() => preparation.dispose())
  const page = await preparation.ready
  const graph = native(page)
  await page.start(graph.entry)
  controller.abort(new Error('page left'))
  expect(() => { page.nativeOptions.persistence.setItem('draft.same-session', 'late') }).toThrow()
  await preparation.dispose()
  expect(page.getSnapshot().phase).toBe('stopped')
})


const win = globalThis as DshWindow
afterEach(() => {
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  document.body.replaceChildren()
})

function actualNative(
  page: PreparedCloudPage, gate?: { entered: () => void; release: Promise<undefined> }, beforeBind?: (ctx: Context) => void,
) {
  const container = document.createElement('div')
  document.body.append(container)
  let root: Context | undefined
  let mounted = false
  const cleanup: string[] = []
  const captured = page.lifetime.transport.hooks
  const navigate = page.lifetime.transport.navigationUrl.bind(page.lifetime.transport)
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue,
    create: options => modulesClient.createClientModuleSystem(target, {
      id: '@deepseek-ai/dsh-client-modules', exports: modulesClient,
    }, options),
    load: (registration) => { pendingQueue.push(registration) },
  }
  win.__ModuleLoader__ = target
  win.__DSH_BOOT__ = {
    rev: 'prepared-cloud', entries: [
      { id: 'cloud', url: '/cloud.js', rev: '1' }, { id: 'renderer', url: '/renderer.js', rev: '1' },
    ],
    batches: [{ phase: 'application', url: '/application.js', rev: '1', entries: ['cloud', 'renderer'] }],
  }
  const renderer = {
    inject: ['connection'],
    apply(ctx: Context) {
      expect(ctx.get('peCloudPage')).toBe(page)
      const source = createSnapshotStore('', { persist: { name: 'native.view', storage: ctx.get('clientPersistence') } })
      source.set('mounted')
      ctx.effect(() => () => {
        cleanup.push(page.lifetime.persistence.getSnapshot().phase)
        expect(() => { source.set('late child write') }).toThrow()
        expect(() => { page.nativeOptions.persistence.removeItem('native.view') }).toThrow()
        expect(() => captured.createWebSocket!('wss://example.test/app/api/remote.mux')).toThrow()
        expect(() => navigate('api/download')).toThrow()
        return expect((async () => captured.fetch!('api/rpc', { method: 'POST', body: '{}' }))()).rejects.toMatchObject({ code: 'closed' })
      }, 'test: earliest native cache and captured carrier consumer cleanup')
      ctx.provide('uiRenderer', { mount: () => {
        mounted = true
        container.textContent = 'native fixture renderer'
        return () => { container.replaceChildren() }
      } })
    },
  }
  const entry = new AppWebEntry(container, {
    ...page.nativeOptions,
    prepareContext: async (ctx) => {
      root = ctx
      if (gate !== undefined) { gate.entered(); await gate.release }
      beforeBind?.(ctx)
      page.nativeOptions.prepareContext(ctx)
    },
    loadBundle: async () => {
      target.load({ id: 'cloud', factory: () => cloud })
      target.load({ id: 'renderer', factory: () => renderer })
    },
  })
  return { entry, root: () => root, mounted: () => mounted, cleanup }
}

it.each(['page', 'native', 'cloud-entry'] as const)('joins actual AppWebEntry/Loader cleanup without a self-disposal cycle (%s first)', async (firstStop) => {
  const f = fixture(), preparation = PreparedCloudPage.prepare(f.input, new AbortController().signal)
  const page = await preparation.ready
  const app = actualNative(page)
  onTestFinished(async () => { await Promise.allSettled([preparation.dispose(), app.entry.dispose()]) })
  await page.start(app.entry)
  expect(app.mounted()).toBe(true)
  if (firstStop === 'native') await app.entry.dispose()
  else if (firstStop === 'cloud-entry') {
    const root = app.root()!
    const entry = [...root.loader.entries()].find(row => row.options.name === 'cloud')!
    await entry.fiber!.dispose()
  } else await page.dispose()
  expect(() => { page.nativeOptions.persistence.removeItem('native.view') }).toThrow()
  await preparation.dispose()
  expect(page.getSnapshot().phase).toBe('stopped')
  expect(app.cleanup).toEqual(['revoked'])
  expect(f.fetcher).toHaveBeenCalledOnce() // Bootstrap only; cleanup cannot send another request.
  expect(f.sockets).toEqual([])
  expect(f.requests).toEqual([])
  expect(f.values.size).toBe(0)
})

it.each([['page', 'resolve'], ['page', 'reject'], ['native', 'resolve'], ['native', 'reject']] as const)(
  'joins late preparation after %s disposal (%s)', async (firstStop, outcome) => {
    const f = fixture(), preparation = PreparedCloudPage.prepare(f.input, new AbortController().signal)
    const page = await preparation.ready
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const app = actualNative(page, { entered: () => { entered.resolve(undefined) }, release: release.promise })
    const starting = page.start(app.entry)
    const observedStartup = Promise.allSettled([starting])
    onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([preparation.dispose(), app.entry.dispose()]) })
    await entered.promise
    const stopping = firstStop === 'page' ? page.dispose() : app.entry.dispose()
    const observedStop = Promise.allSettled([stopping])
    expect(app.mounted()).toBe(false)
    expect(app.root()!.get('connection')).toBeUndefined()
    expect(() => { page.nativeOptions.persistence.setItem('late', 'denied') }).toThrow()
    if (outcome === 'resolve') release.resolve(undefined)
    else release.reject(new Error('late native preparation failed'))
    const reports = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await observedStartup).map(result => result.status)).toEqual(['rejected'])
      expect((await observedStop).map(result => result.status)).toEqual(['rejected'])
      await Promise.allSettled([page.dispose()])
      expect(page.getSnapshot().phase).toBe('unconfirmed')
    } finally { reports.mockRestore() }
    expect(app.mounted()).toBe(false)
    expect(app.root()!.get('peCloudPage')).toBeUndefined()
  })


it('rejects a preinstalled Connection in actual Context preparation before native Loader consumers run', async () => {
  const f = fixture(), preparation = PreparedCloudPage.prepare(f.input, new AbortController().signal)
  const page = await preparation.ready
  const app = actualNative(page, undefined, (ctx) => {
    installConnection(ctx, { transport: page.lifetime.transport.hooks })
  })
  const reports = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(async () => {
    await Promise.allSettled([preparation.dispose(), app.entry.dispose()])
    reports.mockRestore()
  })
  await expect(page.start(app.entry)).rejects.toThrow('sole native Connection installer')
  expect(app.mounted()).toBe(false)
  expect(app.root()!.get('peCloudPage')).toBeUndefined()
  expect(f.requests).toEqual([])
})

it('keeps cancelled bootstrap cleanup pending until the real late carrier settles, without issuing an owner', async () => {
  const f = fixture(), pending = Promise.withResolvers<Response>()
  const preparation = PreparedCloudPage.prepare({ ...f.input, fetch: () => pending.promise }, new AbortController().signal)
  const denied = expect(preparation.ready).rejects.toMatchObject({ code: 'closed' })
  const stopping = preparation.dispose()
  expect(preparation.dispose()).toBe(stopping)
  await denied
  expect(preparation.getSnapshot()).toMatchObject({ settled: false, cleanup: 'pending' })
  expect(f.storage.getItem).not.toHaveBeenCalled()
  pending.resolve(Response.json(bootstrap('late-account', 'late-generation')))
  await stopping
  expect(preparation.getSnapshot()).toMatchObject({ settled: true, cleanup: 'confirmed' })
  expect(f.storage.getItem).not.toHaveBeenCalled()
  expect(f.values.size).toBe(0)
})
