/** Real Loader installations and package lookup; no AccountUse, successful seal or complete C11 fixture is supplied. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import * as Api from '@deepseek-ai/dsh-pe-cloud-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectBootstrapConfiguration } from '../src/bootstrap-inventory.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = new URL('../package.json', import.meta.url).href
  await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
  const packagesFiber = ctx.plugin(PluginPackages)
  await packagesFiber
  const packages = ctx.get('pluginPackages')!, loader = ctx.get('loader')!
  const moduleName = '@deepseek-ai/dsh-pe-cloud-api'
  const metadata = packages.packageOf(moduleName, ctx.baseUrl)
  if (metadata?.version === undefined) throw new Error('Actual native package metadata is missing')
  // Vitest supplies this actual source namespace to the original Loader, preserving the source plane.
  const nativeImport = loader.import.bind(loader)
  const imported = vi.spyOn(loader, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = name === moduleName ? Api : await nativeImport(name, stack)
    return result
  })
  const config = Api.ExposureService.Config({ recipeVersion: 'inventory-test', rpcEndpoints: [], streamEndpoints: [],
    exactFetchRoutes: [], allowedSettings: [], approvedConfiguration: {
      recipeVersion: 'inventory-test', catalogVersion: 'actual-closed-catalog', maxEntries: 4, maxStringBytes: 128, maxCatalogBytes: 4096,
      plugins: [{ id: 'policy', entryId: 'policy', moduleName, packageName: metadata.name,
        packageVersion: metadata.version, installable: false, toggleable: false }],
      skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [],
    } })
  const options = { id: 'policy', name: moduleName, config }
  await loader.create(options)
  const catalog = ctx.get('peExposure')?.approvedConfiguration
  if (catalog === undefined) throw new Error('Actual catalog provider did not activate')
  return { ctx, loader, imported, catalog, packagesFiber, current: () => { ctx.fiber.assertActive() } }
}

describe('approved catalog compared with actual installed Loader entries', () => {
  it('projects only public controls after actual installation/package/no-op checks and rejects later native disposal', async () => {
    const f = await fixture()
    const result = await inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))
    expect(result.configuration).toEqual({ catalogVersion: 'actual-closed-catalog',
      plugins: [{ id: 'policy', installable: false, toggleable: false }], skills: { manage: false },
      credentials: { write: false }, fields: [] })
    expect(JSON.stringify(result.configuration)).not.toContain('packageName')
    expect(JSON.stringify(result.configuration)).not.toContain('moduleName')
    result.assertCurrent()
    await f.loader.resolve('policy').fiber?.dispose()
    expect(result.assertCurrent).toThrow()
  })

  it('rejects an approved row whose actual package version differs', async () => {
    const f = await fixture()
    const catalog = { ...f.catalog, plugins: f.catalog.plugins.map(row => ({ ...row, packageVersion: 'not-installed' })) }
    await expect(inspectBootstrapConfiguration(f.ctx, catalog, f.current, () => f.ctx.get('pluginPackages'))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('rejects a missing approved installation while allowing unlisted infrastructure without projecting a control', async () => {
    const f = await fixture()
    const missing = { ...f.catalog, plugins: f.catalog.plugins.map(plugin => ({ ...plugin, entryId: 'missing' })) }
    await expect(inspectBootstrapConfiguration(f.ctx, missing, f.current, () => f.ctx.get('pluginPackages'))).rejects.toThrow()
    f.loader.builtins['inventory-infrastructure'] = { apply() {} }
    const extra = { id: 'infrastructure', name: 'cordis:inventory-infrastructure' }
    await f.loader.create(extra)
    const result = await inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))
    expect(result.configuration.plugins).toHaveLength(1)
    await f.loader.resolve('policy').fiber?.dispose()
    await expect(inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))).rejects.toThrow()
  })

  it('retains original module identity across the actual asynchronous import and detects late config drift', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
    f.imported.mockImplementationOnce(async () => { entered.resolve(undefined); await gate.promise; return Api })
    const work = inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))
    await entered.promise
    f.loader.resolve('policy').options.config = { recipeVersion: 'replaced' }
    gate.resolve(undefined)
    await expect(work).rejects.toThrow()
  })

  it('rejects a substituted namespace or replacement of an approved public entry with a different builtin', async () => {
    const f = await fixture()
    f.imported.mockResolvedValueOnce({})
    await expect(inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))).rejects.toThrow()
    f.loader.resolve('policy').options.name = 'cordis:pe-cloud-api-account'
    await expect(inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('requires the original package resolver and bounds the complete actual Loader walk', async () => {
    const f = await fixture()
    await expect(inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => undefined)).rejects.toThrow()
    f.loader.builtins['inventory-budget'] = { apply() {} }
    const extra = { id: 'budget', name: 'cordis:inventory-budget' }
    await f.loader.create(extra)
    await expect(inspectBootstrapConfiguration(f.ctx, { ...f.catalog, maxEntries: 1 }, f.current,
      () => f.ctx.get('pluginPackages'))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('withdraws the projection when the actual original resolver provider is disposed', async () => {
    const f = await fixture()
    const result = await inspectBootstrapConfiguration(f.ctx, f.catalog, f.current, () => f.ctx.get('pluginPackages'))
    await f.packagesFiber.dispose()
    expect(result.assertCurrent).toThrow()
  })
})
