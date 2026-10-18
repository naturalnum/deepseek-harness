/** Public input injection only; this composition supplies no authentication or business readiness. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Cloud from '../src/index.ts'
import { apply, Config } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

/** Original Loader/Registry with actual installed Connection metadata and browser artifact; no Host Connection. */
async function composition() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = new URL('../', import.meta.url).href
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

  it.each([false, true])('supplies the actual fixed Connection module before declaration activation (providerFirst=%s)', async (providerFirst) => {
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
    expect(graph.entries).toHaveLength(1)
    expect(graph.entries[0]).toMatchObject({ id: '@deepseek-ai/dsh-client-connection', activate: false })
    expect(parseBootManifest(graph).plugins).toEqual([])
    expect(parseBootManifest(graph).modules.map(row => row.id)).toEqual(['@deepseek-ai/dsh-client-connection'])
    expect(rows(ctx)).toHaveLength(1)
    expect(ctx.get('connection')).toBeUndefined()
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('@deepseek-ai/dsh-client-connection')
    const batch = graph.batches[0]
    if (batch === undefined) throw new Error('Actual module declaration did not publish a bundle')
    const response = await ctx.clientModules.fetchBundle(new Request('http://localhost/' + batch.url))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('@deepseek-ai/dsh-client-connection')
    await ctx.loader.resolve('cloud').fiber?.dispose()
    expect(ctx.clientModules.graph().entries).toEqual([])
    expect(rows(ctx)).toEqual([])
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
    let withdrawing = false
    vi.spyOn(ClientModuleRegistry.prototype, 'registerClientPackages').mockImplementation(function (packages, baseUrl, options) {
      const remove = register.call(this, packages, baseUrl, options)
      return async () => { withdrawing = true; await held.promise; await remove() }
    })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.await()
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
    const remove = ctx.clientModules.registerClientPackages(['@deepseek-ai/dsh-client-connection'], ctx.baseUrl, { activate: false })
    await ctx.loader.create({ id: 'cloud', name: 'cordis:cloud', inject: ['clientModules'], config: { web: manifest() } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('cloud').fiber
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow('duplicate browser declaration')
    expect(rows(ctx)).toEqual([])
    expect(ctx.clientModules.graph().entries).toHaveLength(1)
    await remove()
  })
})
