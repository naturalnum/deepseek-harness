/** Public input injection only; this composition supplies no authentication or business readiness. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { bootInjections, ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { parseBootManifest, stripClientSuffix, type ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Cloud from '../src/index.ts'
import { apply, Config } from '../src/index.ts'

const HOST_BASE_URL = new URL('../', import.meta.url).href
const BROWSER_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-file-upload', '@deepseek-ai/dsh-typert-registry',
]
const FIRST_SCREEN_UI_ROWS = [
  { id: 'ui-renderer', name: '@deepseek-ai/dsh-client-ui-renderer', config: {} },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: {} },
  { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } },
  { id: 'shortcuts', name: '@deepseek-ai/dsh-client-shortcuts', config: { stopSequenceMs: 500 } },
  { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout', config: {} },
  { id: 'ui-session', name: '@deepseek-ai/dsh-client-ui-session', config: {} },
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar', config: {} },
  { id: 'ui-workspace', name: '@deepseek-ai/dsh-client-ui-workspace', config: {} },
  { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation', config: { busyEnter: 'queue' } },
  { id: 'ui-input-trigger', name: '@deepseek-ai/dsh-client-ui-input-trigger', config: {} },
  { id: 'resources', name: '@deepseek-ai/dsh-client-resources', config: {} },
  { id: 'ui-sidebar-right', name: '@deepseek-ai/dsh-client-ui-sidebar-right', config: {} },
  { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: {
    transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed', linkOpening: 'new-tab',
  } },
  { id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings', config: { enabled: false } },
]

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

/** Original Loader/Registry with actual installed Connection metadata and browser artifact; no Host Connection. */
async function composition() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = HOST_BASE_URL
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { cloud: Cloud, modules: ClientModuleRegistry })
  return ctx
}

function rows(ctx: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  return table.filter(row => row.kind === 'global' && row.name === '__DSH_CLOUD_WEB__')
}

function manifest() {
  return {
    client: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 500, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 500 },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 16, maxKeyBytes: 128, maxValueBytes: 4096, maxTotalBytes: 16384, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    auth: { requestTimeoutMs: 500, maxRequestBytes: 4096, maxResponseBytes: 8192 },
  }
}

describe('existing Cloud declaration public Web injection', () => {
  it('keeps ordinary declarations empty and provides no native service', async () => {
    const ctx = new Context(), rows: IndexInjection[] = []
    await apply(ctx, Config({}))
    ctx.emit('webserver/index-inject', rows)
    expect(rows).toEqual([])
    expect(ctx.get('connection')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('owns one detached structured global row until its declaration is disposed', async () => {
    const ctx = await composition(), input = manifest()
    await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: input } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('cloud').fiber
    if (fiber === undefined) throw new Error('Actual Cloud declaration did not import')
    input.fields.accountHeader = 'x-changed'
    const table = rows(ctx)
    expect(table).toHaveLength(1)
    expect(table[0]).toMatchObject({ kind: 'global', name: '__DSH_CLOUD_WEB__', value: { fields: { accountHeader: 'x-pe-account' } } })
    expect(renderIndexInjections('<head></head>', table)).toContain('globalThis["__DSH_CLOUD_WEB__"]')
    expect(ctx.get('connection')).toBeUndefined()
    await fiber.dispose()
    expect(rows(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects missing budgets before contributing any row', async () => {
    const ctx = new Context(), rows: IndexInjection[] = []
    expect(() => Config({ web: { ...manifest(), auth: {} } })).toThrow()
    ctx.emit('webserver/index-inject', rows)
    expect(rows).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects extra authentication identity before registering its injection', async () => {
    const ctx = new Context(), rows: IndexInjection[] = []
    await expect(apply(ctx, Config({ web: { ...manifest(), token: 'unsupported' } }))).rejects.toThrow()
    ctx.emit('webserver/index-inject', rows)
    expect(rows).toEqual([])
    await ctx.fiber.dispose()
  })

  it.each([{ packages: ['@unapproved/browser'] }, { baseUrl: 'file:///unapproved/' }])(
    'rejects caller-selected browser module supply %j', async (selection) => {
      const ctx = new Context()
      try {
        await expect(apply(ctx, Config({ web: { ...manifest(), ...selection } }))).rejects.toThrow()
        expect(rows(ctx)).toEqual([])
      } finally { await ctx.fiber.dispose() }
    },
  )

  it.each([false, true])('supplies module-only Connection and fixed browser services before activation (providerFirst=%s)', async (providerFirst) => {
    const ctx = await composition()
    if (providerFirst) await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    if (!providerFirst) {
      expect(ctx.loader.resolve('cloud').fiber?.state).toBe(FiberState.PENDING)
      expect(rows(ctx)).toEqual([])
      await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    }
    await ctx.loader.await()
    expect(ctx.loader.resolve('cloud').fiber?.state).toBe(FiberState.ACTIVE)
    const graph = ctx.clientModules.graph()
    expect(graph.entries).toHaveLength(8)
    expect(graph.entries.find(row => row.id === '@deepseek-ai/dsh-client-connection')).toMatchObject({ activate: false })
    expect(parseBootManifest(graph).plugins.map(row => row.id).sort()).toEqual([...BROWSER_CLIENT_PACKAGES].sort())
    expect(parseBootManifest(graph).modules.map(row => row.id).sort())
      .toEqual(['@deepseek-ai/dsh-client-connection', ...BROWSER_CLIENT_PACKAGES].sort())
    expect(rows(ctx)).toHaveLength(1)
    expect(ctx.get('connection')).toBeUndefined()
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('@deepseek-ai/dsh-client-connection')
    const batch = graph.batches.find(batch => batch.entries.includes('@deepseek-ai/dsh-client-connection'))
    if (batch === undefined) throw new Error('Actual module declaration did not publish a bundle')
    const response = await ctx.clientModules.fetchBundle(new Request('http://localhost/' + batch.url))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('@deepseek-ai/dsh-client-connection')
    await ctx.loader.resolve('cloud').fiber?.dispose()
    expect(ctx.clientModules.graph().entries).toEqual([])
    expect(rows(ctx)).toEqual([])
  })

  it('closes the whole browser manifest through the actual Registry and fourteen published UI declarations', async () => {
    const ctx = await composition(), resolveHost = createRequire(HOST_BASE_URL)
    await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    // Builtin source-test rows have no package metadata; supply their real browser exports through the original registry.
    ctx.effect(() => ctx.clientModules.registerClientPackages([
      '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-pe-cloud-client',
    ], HOST_BASE_URL), 'test: actual browser faces for source-test Loader builtins')
    for (const row of FIRST_SCREEN_UI_ROWS) {
      await ctx.loader.create({ ...row, name: pathToFileURL(resolveHost.resolve(row.name)).href })
    }
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.await()
    for (const id of ['modules', 'cloud', ...FIRST_SCREEN_UI_ROWS.map(row => row.id)]) {
      expect(ctx.loader.resolve(id).fiber?.state, id).toBe(FiberState.ACTIVE)
    }
    const graph = ctx.clientModules.graph(), boot = parseBootManifest(graph)
    const ids = new Set(boot.modules.map(row => row.id)), platform = getStaticModules()
    expect([...ids].sort()).toEqual([
      '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-pe-cloud-client', '@deepseek-ai/dsh-client-connection',
      ...BROWSER_CLIENT_PACKAGES, ...FIRST_SCREEN_UI_ROWS.map(row => row.name),
    ].sort())
    expect(boot.plugins).toHaveLength(23)
    expect(graph.entries.filter(row => row.activate === false).map(row => row.id)).toEqual(['@deepseek-ai/dsh-client-connection'])
    for (const row of boot.modules) {
      for (const dependency of row.inject) expect(ids.has(dependency), `${row.id} inject ${dependency}`).toBe(true)
      for (const external of row.external) {
        expect(ids.has(stripClientSuffix(external)) || Object.hasOwn(platform, external), `${row.id} external ${external}`).toBe(true)
      }
    }
    for (const service of ['connection', 'typertGateway', 'remote', 'sessionController', 'workspaceController', 'fileUpload']) {
      expect(ctx.get(service), service).toBeUndefined()
    }
    expect([...ctx.loader.entries()].map(row => row.options.name).sort()).toEqual([
      'cordis:cloud', 'cordis:modules',
      ...FIRST_SCREEN_UI_ROWS.map(row => pathToFileURL(resolveHost.resolve(row.name)).href),
    ].sort())

    // Execute the original Host facade and actual combo bytes; materialize every factory without activating browser services.
    const html = renderIndexInjections('<html><head></head><body></body></html>', bootInjections(graph))
    const facade = /<head><script>([\s\S]*?)<\/script>/.exec(html)?.[1]
    if (facade === undefined) throw new Error('Actual Registry did not publish its browser facade')
    const window: { __ModuleLoader__?: ClientModuleLoaderTarget } = {}
    const scope = createContext({ window, console, AbortController, TextDecoder, TextEncoder, URL, Blob })
    runInContext(facade, scope)
    const target = window.__ModuleLoader__
    if (target === undefined) throw new Error('Actual browser facade did not initialize')
    const loadBundle = async (url: string): Promise<void> => {
      const response = await ctx.clientModules.fetchBundle(new Request(new URL(url, 'http://localhost/')))
      expect(response.status, url).toBe(200)
      runInContext(await response.text(), scope)
    }
    for (const batch of graph.batches) await loadBundle(batch.url)
    const system = target.create({ boot: graph, staticModules: platform, loadBundle })
    for (const row of boot.modules) {
      const exports = await system.import(row.id)
      expect(exports, row.id).toBeDefined()
      expect(system.loadCache.get(row.id)?.exports, row.id).toBe(exports)
    }
    for (const row of boot.modules) expect(system.importError(row.id), row.id).toBeUndefined()
    await ctx.loader.resolve('cloud').fiber?.dispose()
    expect(ctx.clientModules.graph().entries).toHaveLength(16)
    expect(rows(ctx)).toEqual([])
    for (const id of ['@deepseek-ai/dsh-client-connection', ...BROWSER_CLIENT_PACKAGES]) {
      expect(ctx.clientModules.graph().entries.some(row => row.id === id), id).toBe(false)
    }
  })

  it('proves a pending owned inject alone does not provide an initial startup barrier', async () => {
    const ctx = await composition()
    const owner = await ctx.plugin(async (scope) => {
      const dependency = scope.inject(['clientModules'], () => {})
      await dependency
      expect(dependency.state).toBe(FiberState.PENDING)
    })
    expect(owner.state).toBe(FiberState.ACTIVE)
    await ctx.loader.await()
    expect(ctx.get('clientModules')).toBeUndefined()
  })

  it('rejects Web configuration without the original row dependency instead of publishing an incomplete manifest', async () => {
    const ctx = await composition()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', config: { web: manifest() } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('cloud').fiber
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow('must explicitly inject clientModules')
    expect(rows(ctx)).toEqual([])
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('joins the actual async module withdrawal before native Cloud disposal completes', async () => {
    const ctx = await composition(), held = Promise.withResolvers<undefined>()
    await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    const register = Reflect.get(ClientModuleRegistry.prototype, 'registerClientPackages')
    let withdrawing = false, holdWithdrawals = false
    vi.spyOn(ClientModuleRegistry.prototype, 'registerClientPackages').mockImplementation(function (
      this: ClientModuleRegistry, packages, baseUrl, options,
    ) {
      const remove = register.call(this, packages, baseUrl, options)
      return async () => { withdrawing = true; if (holdWithdrawals) await held.promise; await remove() }
    })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.await()
    await ctx.loader.resolve('cloud').fiber?.await()
    holdWithdrawals = true
    let stopped = false
    const stopping = ctx.loader.resolve('cloud').fiber?.dispose().then(() => { stopped = true })
    try {
      await expect.poll(() => withdrawing).toBe(true)
      expect(stopped).toBe(false)
    } finally { held.resolve(undefined) }
    await stopping
    expect(ctx.clientModules.graph().entries).toEqual([])
    expect(rows(ctx)).toEqual([])
  })

  it('keeps Loader startup pending through actual late Registry construction and supplies before it returns', async () => {
    const ctx = await composition(), gate = Promise.withResolvers<undefined>()
    ctx.loader.builtins.delayedModules = { async apply(scope: Context) {
      await gate.promise
      new ClientModuleRegistry(scope)
    } }
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.create({ id: 'modules', name: 'cordis:delayedModules' })
    let settled = false
    const startup = ctx.loader.await().then(() => { settled = true })
    try {
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(ctx.loader.resolve('cloud').fiber?.state).toBe(FiberState.PENDING)
      expect(rows(ctx)).toEqual([])
    } finally { gate.resolve(undefined) }
    await startup
    expect(ctx.loader.resolve('cloud').fiber?.state).toBe(FiberState.ACTIVE)
    expect(ctx.clientModules.graph().entries[0]).toMatchObject({ id: '@deepseek-ai/dsh-client-connection', activate: false })
    expect(rows(ctx)).toHaveLength(1)
  })

  it('retains original registration failure on the Cloud Loader entry and publishes no manifest', async () => {
    const ctx = await composition()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    const remove = ctx.clientModules.registerClientPackages(['@deepseek-ai/dsh-client-connection'], HOST_BASE_URL, { activate: false })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('cloud').fiber
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow('duplicate browser declaration')
    expect(rows(ctx)).toEqual([])
    expect(ctx.clientModules.graph().entries).toHaveLength(1)
    await remove()
  })

  it('withdraws module-only Connection if the fixed BFF batch fails before public injection', async () => {
    const ctx = await composition()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await ctx.loader.create({ id: 'modules', name: 'cordis:modules' })
    const remove = ctx.clientModules.registerClientPackages(['@deepseek-ai/dsh-api-remotes'], HOST_BASE_URL, { activate: true })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('cloud').fiber
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow('duplicate browser declaration')
    expect(rows(ctx)).toEqual([])
    expect(ctx.clientModules.graph().entries.map(row => row.id)).toEqual(['@deepseek-ai/dsh-api-remotes'])
    await remove()
  })
})
