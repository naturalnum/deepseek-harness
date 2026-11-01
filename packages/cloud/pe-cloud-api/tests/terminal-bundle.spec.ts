/** Real native bundle code, composer, Manager/Editor, stopped saves and replacement Loader graphs.
 * No PG/files/execution or production-ready evidence is fabricated by this component fixture. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boot, initProfile, PluginPackages, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ExposureService from '../src/root.ts'
import { ModelKeyProvider } from '../src/model-key-provider.ts'
import { modelKeyBinding } from './model-key-policy-data.ts'
import { expect, it, onTestFinished } from 'vitest'
import { AccountPluginControl } from '../src/plugin-control.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { bindNativeConfigSaveHook } from '../src/native-save-hook.ts'
import { parseApprovedConfigurationCatalog } from '../src/approved-catalog.ts'
import type { AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

declare module '@deepseek-ai/cordis' {
  interface Context { terminalFixtureValue: string; terminalFixtureResult: string }
}
const bundleName = '@deepseek-ai/dsh-terminal-fixture-bundle'
const provider = '@deepseek-ai/dsh-terminal-fixture-provider', consumer = '@deepseek-ai/dsh-terminal-fixture-consumer'
const pluginLimits = { maxProfileBytes: 32768, maxRequestBytes: 2048, maxReplyBytes: 16384, maxVersionBytes: 128 }
const saveLimits = { maxAccounts: 2, maxRunning: 2, maxQueued: 4, maxQueuedPerAccount: 4,
  maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 8, maxWaitersPerAccount: 4 }

async function fixture(web = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-bundle-native-'))), dir = join(home, 'profile')
  mkdirSync(dir)
  const packageDir = (name: string) => { const path = join(home, 'node_modules', name); mkdirSync(path, { recursive: true }); return path }
  const resolve = createRequire(import.meta.url)
  const schema = pathToFileURL(resolve.resolve('@deepseek-ai/schemastery')).href
  const pkg = (name: string, source: string) => {
    const path = packageDir(name)
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.mjs' }))
    writeFileSync(join(path, 'index.mjs'), source)
  }
  pkg(provider, `import z from ${JSON.stringify(schema)}
export const name = 'terminal-provider'
export const provide = 'terminalFixtureValue'
export const Config = z.object({ message: z.string() })
export function apply(ctx, config) { ctx.provide('terminalFixtureValue', config.message) }
`)
  pkg(consumer, `import z from ${JSON.stringify(schema)}
export const name = 'terminal-consumer'
export const inject = ['terminalFixtureValue']
export const provide = 'terminalFixtureResult'
export const Config = z.object({ suffix: z.string() })
export function apply(ctx, config) { ctx.provide('terminalFixtureResult', ctx.get('terminalFixtureValue') + config.suffix) }
`)
  const bundle = packageDir(bundleName)
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: bundleName, version: '1.0.0', dsh: { bundle: { patch: 'patch.yml' } } }))
  writeFileSync(join(bundle, 'patch.yml'), JSON.stringify([{ insert: [
    { id: 'terminal-provider', name: provider, config: { message: 'native-string' } },
    { id: 'terminal-consumer', name: consumer, config: { suffix: '-consumer' } },
  ] }]))
  if (web) {
    // Resolve the declared package dependencies from this test's package, not the runner's cwd.
    for (const name of ['dsh-web', 'dsh-web-search-deepseek', 'dsh-web-deepseek-api', 'dsh-web-fetch-http',
      'dsh-llm-deepseek-api-key']) {
      const source = dirname(resolve.resolve('@deepseek-ai/' + name + '/package.json'))
      symlinkSync(source, join(home, 'node_modules', '@deepseek-ai', name), 'dir')
    }
  }
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'terminal-bundle-component', dependencies: { [bundleName]: '1.0.0', [provider]: '1.0.0', [consumer]: '1.0.0' } }))
  initProfile(dir, [])
  const profile: ProfileContext = { name: 'terminal-bundle', dir, home, cwd: home, installAnchor: anchor,
    patchPath: join(dir, 'cordis.patch.yml'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  writeFileSync(join(dir, 'cordis.yml'), JSON.stringify([
    { id: 'editor', name: 'cordis:editor' }, { id: 'manager', name: 'cordis:manager' },
    ...web ? [
      { id: 'settings', name: 'cordis:settings' }, { id: 'llm', name: 'cordis:llm' },
      { id: 'model-provider', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'fixture-model' }] } },
      { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
      { id: 'web-search-deepseek', name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/anthropic/v1' } },
      { id: 'web-deepseek-api', name: '@deepseek-ai/dsh-web-deepseek-api', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1/tools' } },
      { id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' },
    ] : [],
  ]))
  writeFileSync(profile.patchPath, '[]\n')
  const fields = web ? [
    { namespace: 'web', field: 'searchProvider', values: ['deepseek-official', 'deepseek-search-api'] },
    { namespace: 'web', field: 'fetchProvider', values: ['http', 'deepseek-fetch-api'] },
    { namespace: 'web-search-deepseek', field: 'baseURL', values: ['https://api.deepseek.com/anthropic/v1'] },
    { namespace: 'web-search-deepseek', field: 'maxUses' },
    { namespace: 'web-deepseek-api', field: 'baseURL', values: ['https://api.deepseek.com/v1/tools'] },
    { namespace: 'web-deepseek-api', field: 'count' },
  ] : []
  const modelKey = { bindings: [modelKeyBinding('model-provider')], maxKeyBytes: 8192,
    maxVersionBytes: 128, maxReplyBytes: 4096, maxMetadataBytes: 65536 }
  const input = { recipeVersion: 'terminal-component', catalogVersion: 'bundle-v1',
    maxEntries: 16, maxStringBytes: 256, maxCatalogBytes: 8192, pluginControl: pluginLimits, plugins: [],
    bundles: [{ id: 'native-bundle', packageName: bundleName, packageVersion: '1.0.0',
      control: { selectionTarget: { kind: 'bundle', name: bundleName }, operations: ['selected'], maxImpact: 'graph', fields: [] },
      members: [{ entryId: 'include:terminal-provider', moduleName: provider, packageName: provider, packageVersion: '1.0.0' },
        { entryId: 'include:terminal-consumer', moduleName: consumer, packageName: consumer, packageVersion: '1.0.0' }] }],
    fields, ...web ? { modelKey } : {}, skills: { mode: 'closed' }, credentials: { mode: 'read-only' } }
  const exposureRoot = new Context()
  const rpc = ['current', 'change', 'list'].map(method => ({ endpoint: 'cloudPlugins/' + method,
    handlerId: 'native:cloudPlugins', guard: 'authenticated-account' as const }))
  const keyRpc = ['metadata', 'describe', 'set', 'unset'].map(method => ({ endpoint: 'cloudModelKey/' + method,
    handlerId: 'native:cloudModelKey', guard: 'authenticated-account' as const }))
  const allowedSettings = [...new Set(fields.map(row => row.namespace))].map(namespace => ({ namespace,
    fields: fields.filter(row => row.namespace === namespace).map(row => row.field) }))
  const config = ExposureService.Config({ recipeVersion: 'terminal-component', streamEndpoints: [], exactFetchRoutes: [], allowedSettings,
    rpcEndpoints: [...rpc, ...web ? [...keyRpc, { endpoint: 'settings/mutate', handlerId: 'native:settingsController',
      guard: 'authenticated-account' as const }] : []], approvedConfiguration: input })
  const catalog = web ? new ExposureService(exposureRoot, config).approvedConfiguration!
    : parseApprovedConfigurationCatalog(input, 'terminal-component', true)!
  const coordinator = new ConfigSaveCoordinator(saveLimits)
  const graphs: Context[] = []
  let epoch = 0
  const start = async () => {
    const binding = Object.freeze({ accountId: brandString<AccountId>('terminal-component'), epoch: brandString<OwnerEpoch>(String(++epoch)),
      recipeVersion: 'terminal-component', lifetime: new AbortController().signal })
    const saves = coordinator.createAccount(binding)
    let control: AccountPluginControl | undefined
    const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), async (owner) => {
      owner.provide('profileContext', profile); owner.provide('peAccount', binding)
      await owner.plugin(PluginPackages)
      control = new AccountPluginControl(owner, saves, { limits: pluginLimits, catalog, maxNativeInventoryEntries: 64,
        requiredEntryIds: ['include:editor', 'include:manager', ...web ? [
          'include:settings', 'include:llm', 'include:model-provider', 'include:web', 'include:web-search-deepseek',
          'include:web-deepseek-api', 'include:web-fetch-http'] : []], resolvePackages: () => owner.get('pluginPackages'),
        async withModelKeyPeerUse() { throw new Error('No production Peer in native component fixture') },
        async withConfigurationPeer() { throw new Error('No production Peer in native component fixture') },
        async withIdleConfiguration() { throw new Error('No production idle window in native component fixture') },
        scheduleRebuild() { throw new Error('No production Factory in native component fixture') },
      }, () => { owner.fiber.assertActive() })
      class Editor extends ConfigEditor { constructor(scope: Context) { super(scope); bindNativeConfigSaveHook(scope, saves, this) } }
      Object.assign(owner.loader.builtins, { editor: Editor, manager: control.provider, settings: Settings, llm: LlmRuntime })
    })
    graphs.push(ctx)
    if (control === undefined) throw new Error('Original native preparation did not run')
    const check = () => { ctx.fiber.assertActive() }
    await control.restore()
    if (web) await new ModelKeyProvider(ctx, catalog.modelKey!, 64, true).audit()
    return { ctx, saves, control, binding, check }
  }
  onTestFinished(async () => {
    for (const graph of graphs.reverse()) await graph.fiber.dispose()
    await exposureRoot.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const commit = async (graph: Awaited<ReturnType<typeof start>>, selected: boolean) => {
    const current = await graph.control.current('native-bundle', graph.check)
    const prepared = await graph.control.prepareRebuild(
      'native-bundle', current.version, { kind: 'selected', selected }, graph.check,
    )
    if (!prepared.accepted) throw prepared.error
    const stopped = await graph.saves.stopConfigSaves(Date.now() + 2000)
    expect(stopped.status).toBe('confirmed')
    const persisted = await coordinator.commitStoppedConfiguration(
      graph.saves, () => graph.control.applyRebuild(prepared.intent, graph.check),
    )
    expect((await graph.saves.stopConfigSaves(Date.now() + 2000)).status).toBe('confirmed')
    return { intent: prepared.intent, persisted }
  }
  return { start, commit, coordinator, profile, bundle, home, catalog, manifest: () => readFileSync(join(dir, 'package.json'), 'utf8') }
}

it('selects and removes a real multi-entry provide/inject bundle with native persistence distinct from replacement graph verification', async () => {
  const f = await fixture(), first = await f.start()
  const initial = await first.control.current('native-bundle', first.check)
  expect(initial.bundle).toMatchObject({ name: bundleName, enabled: false, availability: 'installation' })
  expect(initial.plugin).toBeUndefined()
  expect(first.ctx.get('terminalFixtureResult')).toBeUndefined()
  const enabled = await f.commit(first, true)
  expect(enabled.persisted.native).toMatchObject({ changed: true, application: 'restart-required', restartReason: 'no-hmr' })
  expect(first.ctx.get('terminalFixtureResult')).toBeUndefined() // Saved did not activate the old graph.
  const oldWriters = [...first.ctx.loader.entries()].map(entry => entry.fiber).filter(fiber => fiber !== undefined)
  await first.ctx.fiber.dispose()
  expect(oldWriters.every(fiber => fiber.state === FiberState.DISPOSED)).toBe(true)
  f.coordinator.releaseAccount(first.saves)
  const second = await f.start()
  expect(second.ctx.root).not.toBe(first.ctx.root)
  const applied = await second.control.verifyRebuild(enabled.intent, enabled.persisted, second.check)
  expect(second.binding.epoch).not.toBe(first.binding.epoch)
  expect(applied.value.bundle?.enabled).toBe(true)
  expect(applied.persisted).toBe(enabled.persisted)
  expect(applied.value.version.epoch).not.toBe(applied.persisted.epoch)
  expect(second.ctx.get('terminalFixtureResult')).toBe('native-string-consumer')
  const provider = [...second.ctx.loader.entries()].find(entry => entry.id === 'include:terminal-provider')!.fiber!
  const consumer = [...second.ctx.loader.entries()].find(entry => entry.id === 'include:terminal-consumer')!.fiber!
  expect(consumer.store?.terminalFixtureValue?.fiber).toBe(provider)
  const disabled = await f.commit(second, false)
  expect(disabled.persisted.native).toMatchObject({ changed: true, application: 'restart-required', restartReason: 'no-hmr' })
  expect(second.ctx.get('terminalFixtureResult')).toBe('native-string-consumer')
  await second.ctx.fiber.dispose()
  expect(consumer.state).toBe(FiberState.DISPOSED); expect(provider.state).toBe(FiberState.DISPOSED)
  f.coordinator.releaseAccount(second.saves)
  const third = await f.start()
  const removed = await third.control.verifyRebuild(disabled.intent, disabled.persisted, third.check)
  expect(removed.value.bundle?.enabled).toBe(false)
  expect(third.ctx.get('terminalFixtureResult')).toBeUndefined()
  expect([...third.ctx.loader.entries()].some(entry => entry.id === 'include:terminal-provider' || entry.id === 'include:terminal-consumer')).toBe(false)
  expect(f.manifest()).not.toContain('"' + bundleName + '"')
})

it('rejects a changed bundle version or unapproved complete member set before stopping or writing', async () => {
  for (const fault of ['version', 'members'] as const) {
    const f = await fixture(), graph = await f.start()
    const current = await graph.control.current('native-bundle', graph.check), before = f.manifest()
    const fibers = [...graph.ctx.loader.entries()].map(entry => entry.fiber)
    if (fault === 'version') {
      const path = join(f.bundle, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string }
      manifest.version = '2.0.0'; writeFileSync(path, JSON.stringify(manifest))
    } else writeFileSync(join(f.bundle, 'patch.yml'), JSON.stringify([{ insert: [
      { id: 'terminal-provider', name: provider, config: { message: 'native-string' } },
      { id: 'terminal-consumer', name: consumer, config: { suffix: '-consumer' } },
      { id: 'unapproved-extra', name: consumer, config: { suffix: '-unapproved' } },
    ] }]))
    await expect(graph.control.prepareRebuild('native-bundle', current.version,
      { kind: 'selected', selected: true }, graph.check)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(f.manifest()).toBe(before)
    expect([...graph.ctx.loader.entries()].map(entry => entry.fiber)).toEqual(fibers)
    expect(graph.saves.snapshot()).toMatchObject({ admission: 'open', failures: [] })
  }
})

it('rejects required entry replacement, a stale profile token and member-package version drift before native publication', async () => {
  for (const fault of ['required', 'profile', 'member-version'] as const) {
    const f = await fixture(), graph = await f.start()
    const current = await graph.control.current('native-bundle', graph.check), before = f.manifest()
    if (fault === 'required') writeFileSync(join(f.bundle, 'patch.yml'), JSON.stringify([{ id: 'editor', disabled: true }, { insert: [
      { id: 'terminal-provider', name: provider, config: { message: 'native-string' } },
      { id: 'terminal-consumer', name: consumer, config: { suffix: '-consumer' } },
    ] }]))
    else if (fault === 'profile') writeFileSync(graph.ctx.configEditor.documentPath, '[]\n\n')
    else {
      const path = join(f.home, 'node_modules', provider, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string }
      manifest.version = '2.0.0'; writeFileSync(path, JSON.stringify(manifest))
    }
    const actual = graph.control.prepareRebuild('native-bundle', current.version, { kind: 'selected', selected: true }, graph.check)
    if (fault === 'profile') expect(await actual).toMatchObject({ accepted: false, error: { code: 'cloud/config-conflict' } })
    else await expect(actual).rejects.toBeInstanceOf(Error)
    expect(f.manifest()).toBe(before)
    expect(graph.ctx.get('terminalFixtureResult')).toBeUndefined()
    expect(graph.saves.snapshot().failures).toEqual([])
  }
})

it('does not mint graph persistence from a paused save owner, and binds replacement verification to the original intent and revision', async () => {
  const f = await fixture(), graph = await f.start()
  const current = await graph.control.current('native-bundle', graph.check), before = f.manifest()
  const prepared = await graph.control.prepareRebuild('native-bundle', current.version, { kind: 'selected', selected: true }, graph.check)
  if (!prepared.accepted) throw prepared.error
  expect((await graph.saves.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
  await expect(graph.control.applyRebuild(prepared.intent, graph.check)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  graph.saves.resumeAccountChanges()
  expect(f.manifest()).toBe(before); expect(graph.saves.snapshot().failures).toEqual([])
  expect((await graph.saves.stopConfigSaves(Date.now() + 1000)).status).toBe('confirmed')
  await expect(graph.control.applyRebuild(prepared.intent, graph.check)).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(f.manifest()).toBe(before); expect(graph.saves.snapshot().failures).toEqual([])
  const persisted = await f.coordinator.commitStoppedConfiguration(graph.saves,
    () => graph.control.applyRebuild(prepared.intent, graph.check))
  const saved = { intent: prepared.intent, persisted }
  await graph.ctx.fiber.dispose(); f.coordinator.releaseAccount(graph.saves)
  const replacement = await f.start()
  await expect(replacement.control.verifyRebuild({ ...saved.intent, operation: { kind: 'selected', selected: false } },
    saved.persisted, replacement.check)).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(replacement.control.verifyRebuild(saved.intent, { ...saved.persisted, revision: 'stale' },
    replacement.check)).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect((await replacement.control.verifyRebuild(saved.intent, saved.persisted, replacement.check)).value.bundle?.enabled).toBe(true)
})

it('rechecks the fixed bundle version at the original terminal writer after earlier intent preparation', async () => {
  const f = await fixture(), graph = await f.start()
  const current = await graph.control.current('native-bundle', graph.check), before = f.manifest()
  const prepared = await graph.control.prepareRebuild('native-bundle', current.version, { kind: 'selected', selected: true }, graph.check)
  if (!prepared.accepted) throw prepared.error
  expect((await graph.saves.stopConfigSaves(Date.now() + 1000)).status).toBe('confirmed')
  const path = join(f.bundle, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string }
  manifest.version = '2.0.0'; writeFileSync(path, JSON.stringify(manifest))
  await expect(f.coordinator.commitStoppedConfiguration(graph.saves,
    () => graph.control.applyRebuild(prepared.intent, graph.check))).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(f.manifest()).toBe(before)
  expect(graph.ctx.get('terminalFixtureResult')).toBeUndefined()
  expect(graph.saves.snapshot().admission).toBe('stopped')
})

it('selects an unrelated Root-approved native bundle with Web enabled and re-audits the rebuilt Web providers', async () => {
  const f = await fixture(true), first = await f.start()
  expect((await first.control.current('native-bundle', first.check)).bundle?.enabled).toBe(false)
  const originalWeb = ['web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http'].map((id) => {
    const entry = [...first.ctx.loader.entries()].find(row => row.options.id === id)!
    return { id, name: entry.options.name }
  })
  const enabled = await f.commit(first, true)
  expect(enabled.persisted.native).toMatchObject({ changed: true, application: 'restart-required' })
  await first.ctx.fiber.dispose(); f.coordinator.releaseAccount(first.saves)
  const rebuilt = await f.start()
  expect(rebuilt.binding.epoch).not.toBe(first.binding.epoch)
  expect((await rebuilt.control.verifyRebuild(enabled.intent, enabled.persisted, rebuilt.check)).value.bundle?.enabled).toBe(true)
  expect(rebuilt.ctx.get('terminalFixtureResult')).toBe('native-string-consumer')
  for (const original of originalWeb) {
    const entry = [...rebuilt.ctx.loader.entries()].find(row => row.options.id === original.id)
    expect(entry?.options.name).toBe(original.name)
    expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
  }
  await expect(new ModelKeyProvider(rebuilt.ctx, f.catalog.modelKey!, 64, true).audit()).resolves.toBeUndefined()
})

it.each(['web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http'] as const)(
  'rejects an unrelated bundle that changes protected %s during the stopped C06 rebuild', async (id) => {
    const f = await fixture(true), graph = await f.start()
    const current = await graph.control.current('native-bundle', graph.check), before = f.manifest()
    const prepared = await graph.control.prepareRebuild('native-bundle', current.version, { kind: 'selected', selected: true }, graph.check)
    if (!prepared.accepted) throw prepared.error
    writeFileSync(join(f.bundle, 'patch.yml'), JSON.stringify([{ id, disabled: true }, { insert: [
      { id: 'terminal-provider', name: provider, config: { message: 'native-string' } },
      { id: 'terminal-consumer', name: consumer, config: { suffix: '-consumer' } },
    ] }]))
    expect((await graph.saves.stopConfigSaves(Date.now() + 2000)).status).toBe('confirmed')
    await expect(f.coordinator.commitStoppedConfiguration(graph.saves,
      () => graph.control.applyRebuild(prepared.intent, graph.check))).rejects.toBeDefined()
    expect(f.manifest()).toBe(before)
    expect([...graph.ctx.loader.entries()].find(row => row.options.id === id)?.fiber?.state).toBe(FiberState.ACTIVE)
  },
)
