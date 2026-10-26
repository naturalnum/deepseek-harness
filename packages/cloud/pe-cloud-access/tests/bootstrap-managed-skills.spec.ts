/** Real bootstrap, native first-screen API and Loader inventory; added skill endpoint audits are stubs, not managed-service readiness. */
import { readFileSync } from 'node:fs'
import { Context, symbols } from '@deepseek-ai/cordis'
import { CloudApiError, ExposureService, type ApprovedConfigurationCatalog, type EndpointExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'
import { sourceSettingsManifest } from './fixtures/source-settings-manifest.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
  maxQueuedEvents: 128, maxQueuedBytes: 4194304 }
const version = (relative: string): string => (JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { version: string }).version
const catalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'bootstrap-skills-modes', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [
    { id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: version('../../../client/locale/package.json'), installable: false, toggleable: false },
    { id: 'model-provider', entryId: 'include:model-provider', moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key', packageName: '@deepseek-ai/dsh-llm-deepseek-api-key',
      packageVersion: version('../../../llm/llm-deepseek-api-key/package.json'), installable: false, toggleable: false },
  ], skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [],
}
const limits = { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 4096, maxRetainedVersions: 4 }
const management = { maxRequestBytes: 65536, maxReplyBytes: 65536, maxMetadataBytes: 65536, maxRetainedProviders: 4 }
type Mode = ApprovedConfigurationCatalog['skills']['mode']
const methods = ['current', 'publish', 'installed', 'details', 'install', 'update', 'uninstall', 'download']
const rows: readonly EndpointExposure[] = methods.map(method => ({ endpoint: `cloudSkills/${method}`,
  handlerId: 'native:cloudSkills', guard: 'authenticated-account' }))
const list: EndpointExposure = { endpoint: 'skills/list', handlerId: 'native:sessionSkillCatalog', guard: 'account-session' }
const selection = (mode: Mode): readonly EndpointExposure[] => mode === 'closed' ? [] : mode === 'sample' ? rows.slice(0, 2) : rows

async function fixture(mode: Mode, selected: readonly EndpointExposure[] = [...selection(mode), ...mode === 'closed' ? [] : [list]]) {
  const root = new Context(), policyRoot = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await root.fiber.dispose(); await policyRoot.fiber.dispose() })
  const skills: ApprovedConfigurationCatalog['skills'] = mode === 'closed' ? { mode } : mode === 'sample'
    ? { mode, limits } : { mode, limits, management }
  // This original Root constructor rejects incomplete or unauthorized cloudSkills groups before graph admission.
  const selectedPolicy = new ExposureService(policyRoot, ExposureService.Config({ recipeVersion: catalog.recipeVersion,
    rpcEndpoints: [...selected], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [],
    approvedConfiguration: { ...catalog, skills } }))
  const native = policyFixture([], bounds, 'bootstrap-skills-modes', undefined, catalog), graph = await native.start()
  const manifest = native.exposureOwner.policy.manifest
  const exposure = new ExposureService(root, { ...manifest,
    rpcEndpoints: [...manifest.rpcEndpoints, ...selectedPolicy.policy.manifest.rpcEndpoints],
    approvedConfiguration: { ...catalog, skills } })
  const requireRpc = graph.api.requireRpc.bind(graph.api)
  // Native first-screen checks, assertBootstrapCurrent and inventory imports remain original.
  const audited = vi.spyOn(graph.api, 'requireRpc').mockImplementation(endpoint =>
    selected.find(row => row.endpoint === endpoint) ?? requireRpc(endpoint))
  const bootstrap = vi.spyOn(graph.api, 'assertBootstrapCurrent')
  const produce = () => produceCloudBootstrap(graph.ctx, graph.binding, exposure, () => native.bootstrapPackages,
    { id: graph.binding.accountId, displayName: 'Bootstrap skill modes' }, 65536, graph.binding.lifetime,
    () => { graph.ctx.fiber.assertActive(); native.assertRootActive(); root.fiber.assertActive() }, () => 'bootstrap-skills-generation')
  return { graph, produce, audited, bootstrap }
}

it.each(['managed', 'sample', 'closed'] as const)('projects %s through the real bootstrap and original Loader with its exact native skill group', async (mode) => {
  const f = await fixture(mode), result = await f.produce()
  const value: unknown = JSON.parse(result.body)
  expect(value).toMatchObject({ capabilities: { configuration: {
    catalogVersion: catalog.catalogVersion, plugins: [{ id: 'locale' }, { id: 'model-provider' }],
    skills: { manage: mode !== 'closed' }, credentials: { write: false }, fields: [],
  } } })
  for (const row of selection(mode)) expect(f.audited).toHaveBeenCalledWith(row.endpoint)
  if (mode !== 'closed') expect(f.audited).toHaveBeenCalledWith('skills/list')
  expect(f.bootstrap).toHaveBeenCalledOnce()
  expect(f.graph.adapter.calls).toBe(0)
  result.assertCurrent()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')
  if (locale === undefined) throw new Error('Original Loader locale entry is missing')
  locale.options.config = { replaced: true }
  expect(result.assertCurrent).toThrow()
})

it('admits the complete managed eight without manufacturing the optional native catalog endpoint', async () => {
  const f = await fixture('managed', rows), result = await f.produce()
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { configuration: { skills: { manage: true } } } })
  for (const row of rows) expect(f.audited).toHaveBeenCalledWith(row.endpoint)
  expect(f.audited).not.toHaveBeenCalledWith('skills/list')
  result.assertCurrent()
})

it.each(methods)('refuses managed approval missing original cloudSkills/%s before bootstrap admission', async (method) => {
  await expect(fixture('managed', rows.filter(row => row.endpoint !== `cloudSkills/${method}`)))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
})

it.each([
  { handlerId: 'other:cloudSkills', guard: 'authenticated-account' as const },
  { handlerId: 'native:cloudSkills', guard: 'account-session' as const },
])('refuses unauthorized managed original handler or guard: %j', async (change) => {
  await expect(fixture('managed', rows.map(row => row.endpoint === 'cloudSkills/install' ? { ...row, ...change } : row)))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
})

it.each([
  { ...list, handlerId: 'native:cloudSkills' },
  { ...list, guard: 'authenticated-account' as const },
])('keeps the exact original skills/list handler and guard: %j', async (row) => {
  const f = await fixture('managed', [...rows, row])
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.audited).not.toHaveBeenCalledWith('skills/list')
})

it('keeps native skills/list closed without an open skill approval', async () => {
  const f = await fixture('closed', [list])
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.audited).not.toHaveBeenCalledWith('skills/list')
})

it('rejects managed methods in the old sample mode and all cloudSkills methods in closed mode', async () => {
  await expect(fixture('sample', rows)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  await expect(fixture('closed', rows)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
})

it('requires each selected skill owner before projection and again at final response transfer', async () => {
  const f = await fixture('managed'), audit = f.audited.getMockImplementation()
  if (audit === undefined) throw new Error('Original audit fixture is missing')
  let available = false
  f.audited.mockImplementation((endpoint) => {
    if (endpoint === 'cloudSkills/download' && !available) throw new CloudApiError('cloud/account-unavailable', 'Original skill registration ended')
    return audit(endpoint)
  })
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.bootstrap).not.toHaveBeenCalled()
  available = true
  const result = await f.produce()
  result.assertCurrent()
  available = false
  expect(result.assertCurrent).toThrow('Original skill registration ended')
})

const localeWriter: EndpointExposure = { endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' }
const localeCatalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'bootstrap-native-locale', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [{ id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale',
    packageName: '@deepseek-ai/dsh-client-locale', packageVersion: version('../../../client/locale/package.json'),
    installable: false, toggleable: false }],
  skills: { mode: 'closed' }, credentials: { mode: 'read-only' },
  fields: [{ namespace: 'locale', field: 'preference', values: ['zh', 'en'] }],
}

it('composes the actual native locale writer with the current producer and preserves audit and rejected-setting behavior', async () => {
  const native = policyFixture([localeWriter], bounds, 'bootstrap-native-locale', undefined, localeCatalog, await sourceSettingsManifest())
  const graph = await native.start(), originalRoot = graph.ctx.root, originalSettings = graph.ctx.settings
  const originalEditor = graph.ctx.configEditor, audit = vi.spyOn(graph.api, 'requireRpc')
  onTestFinished(() => { audit.mockRestore() })
  const produce = () => produceCloudBootstrap(graph.ctx, graph.binding, native.exposureOwner, () => native.bootstrapPackages,
    { id: graph.binding.accountId, displayName: 'Native locale component' }, 65536, graph.binding.lifetime,
    () => { graph.ctx.fiber.assertActive(); native.assertRootActive() }, () => 'native-locale-generation')
  const before = await produce(); before.assertCurrent()
  expect(JSON.parse(before.body)).toMatchObject({ capabilities: { arbitraryBackendPlugins: false, configuration: {
    fields: [{ namespace: 'locale', path: 'preference', application: 'live' }], credentials: { write: false },
  } } })
  expect(audit).toHaveBeenCalledWith('settings/mutate')
  for (const value of ['zh', 'en']) {
    const current = graph.ctx.settingsController.describe().namespaces[0]
    if (current === undefined) throw new Error('Native locale namespace absent')
    await expect(graph.invokeSettings('locale', [{ op: 'set', path: ['preference'], value }], current.revision))
      .resolves.toMatchObject({ ns: 'locale', value: { preference: value } })
    const fresh = await produce(); fresh.assertCurrent()
  }
  const revision = graph.ctx.settingsController.describe().namespaces[0]?.revision
  for (const [namespace, ops] of [
    ['unapproved', [{ op: 'set', path: ['preference'], value: 'zh' }]],
    ['locale', [{ op: 'set', path: ['other'], value: 'zh' }]],
    ['locale', [{ op: 'set', path: ['preference'], value: 'fr' }]],
  ] as const) await expect(graph.invokeSettings(namespace, ops, revision)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.settingsController.describe().namespaces[0]?.value).toEqual({ preference: 'en' })
  expect(graph.ctx.root === originalRoot).toBe(true)
  expect((Reflect.get(graph.ctx.settings, symbols.original) ?? graph.ctx.settings)
    === (Reflect.get(originalSettings, symbols.original) ?? originalSettings)).toBe(true)
  expect((Reflect.get(graph.ctx.configEditor, symbols.original) ?? graph.ctx.configEditor)
    === (Reflect.get(originalEditor, symbols.original) ?? originalEditor)).toBe(true)
  expect(graph.saveBarrier.snapshot()).toMatchObject({ pending: [], failures: [] })
  expect(graph.adapter.calls).toBe(0)
})
