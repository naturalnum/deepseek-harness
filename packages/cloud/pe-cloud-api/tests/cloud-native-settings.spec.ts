/** Actual Loader, native inventory/preset registry and generated Gateway reads remain account-local and readonly. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { beforeAll, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { WorkspaceAnalyzer, FaceModelEmitter, findWorkspaceRoot } from '@deepseek-ai/dsh-typert-generator'
import { CloudAccountApi } from '../src/account-service.ts'
import type { CloudNativeSettingsPreparation, CloudPresetComposition } from '../src/cloud-native-settings.ts'
import { CloudApiError } from '../src/errors.ts'
import { firstScreenNativeOwner } from '../src/native-first-screen.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'

const pkg = '@deepseek-ai/dsh-pe-cloud-api', require = createRequire(import.meta.url)
let descriptorSource: string
beforeAll(() => {
  const workspace = findWorkspaceRoot(dirname(require.resolve(pkg + '/package.json')))
  const model = new WorkspaceAnalyzer({ root: workspace, packages: [pkg], faces: ['host'], mode: 'check',
    checkDiagnostics: true, rejectBuildOutputs: true }).analyze()
  const face = model.faces.find(value => value.face === 'host')
  if (face === undefined) throw new Error('Original Host descriptor face absent')
  descriptorSource = new FaceModelEmitter(face).emit(pkg).js
}, 30000)

async function fixture(label = 'a', limits: Partial<CloudNativeSettingsPreparation> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-native-settings-'))), dir = join(home, 'profile')
  mkdirSync(dir); initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"native-settings-read-fixture"}\n')
  const installed = join(home, 'node_modules/@deepseek-ai/dsh-pe-cloud-api/lib')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(dirname(installed), 'package.json'), readFileSync(require.resolve(pkg + '/package.json')))
  const remoteInfo = join(home, 'remote-info.mjs')
  writeFileSync(remoteInfo, ts.transpileModule(readFileSync(require.resolve('@deepseek-ai/dsh-typert-protocol/src/remote-info.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText)
  writeFileSync(join(installed, 'typert.host.js'), descriptorSource
    .replace(/from (['"])zod\1/g, 'from ' + JSON.stringify(pathToFileURL(require.resolve('zod')).href))
    .replace(/from (['"])@deepseek-ai\/dsh-typert-protocol\/remote-info\1/g, 'from ' + JSON.stringify(pathToFileURL(remoteInfo).href)))
  const config = join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    { id: 'artifacts', name: 'cordis:artifacts', config: { packages: [pkg] } },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'preset-registry', name: 'cordis:preset-registry', config: { default: label } },
    { id: 'preset', name: 'cordis:preset', config: { id: label, name: 'Preset ' + label, plugins: [
      { id: 'module-' + label, name: 'cordis:noop-' + label, config: { token: 'PRIVATE_CONFIG_CANARY' } },
    ] } },
    { id: 'settings-view', name: 'cordis:settings-view' },
  ]) + '\n')
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(label),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'native-settings-read', lifetime: new AbortController().signal })
  const manifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: ['inventory', 'presets', 'readPreset'].map(method => ({ endpoint: 'cloudNativeSettings/' + method,
      handlerId: 'native:cloudNativeSettings', guard: 'authenticated-account' as const })),
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 2, maxWaitersPerAccount: 2 })
  const barrier = saves.createAccount(binding)
  let api: CloudAccountApi | undefined, use: AccountUse | undefined
  let current = true, business = true, useOverride: AccountUse | undefined
  onTestFinished(async () => {
    await barrier.stopConfigSaves(Date.now() + 1000)
    try { await api?.withdraw(); await ctx.fiber.dispose() }
    finally { saves.releaseAccount(barrier); saves.close(); rmSync(home, { recursive: true, force: true }) }
  })
  const profile: ProfileContext = { name: 'read', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const ctx = await boot('native-settings-read', config, [], async (root) => {
    root.provide('profileContext', profile); root.provide('peAccount', binding)
    await root.plugin(Typert); await root.plugin(RemoteAccess); await root.plugin(Gateway)
    api = new CloudAccountApi(root, { binding, saves: barrier, rootExposure: policy, selected: manifest,
      assertMountCurrent() { root.fiber.assertActive(); binding.lifetime.throwIfAborted() },
      assertBusinessCurrent() { if (!business) throw new CloudApiError('cloud/account-unavailable', 'Fixture business admission closed.') } })
    use = { binding, context: root, assertCurrent() { if (!current) throw new CloudApiError('cloud/stale-generation', 'Fixture use closed.') }, release() {} }
    const actualApi = api
    Object.assign(root.loader.builtins, { artifacts: TypertLoader, projections: SessionProjections, 'preset-registry': AgentPresetRegistry,
      preset: AgentPreset, ['noop-' + label]: { apply() {} }, 'settings-view': { inject: ['typert', 'agentPresets'],
        apply(scope: Context) { actualApi.prepareCloudNativeSettings(scope, { maxNativeInventoryEntries: 512,
          maxCollectionItems: 64, maxFrameBytes: 65536, ...limits,
          async withModelKeyPeerUse(actual, consume) {
            if (actual !== peer || use === undefined) throw new CloudApiError('cloud/forbidden', 'Fixture peer does not own this account.')
            const selected = useOverride ?? use
            return consume(selected, () => { if (!current) throw new CloudApiError('cloud/stale-generation', 'Fixture peer was retired.') })
          } }) },
      } })
  })
  if (api === undefined || use === undefined) throw new Error('Actual native settings fixture did not initialize')
  const peer: PeerScope = { id: brandString<PeerScope['id']>('native-settings-peer-' + label), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
  api.audit(ctx.cloudNativeSettings.inspect())
  const invoke = <T>(method: string, args: Readonly<Record<string, unknown>> = {}, actualPeer = peer, signal?: AbortSignal) =>
    ctx.typertGateway.invoke({ namespace: 'cloudNativeSettings', method, args, peer: actualPeer,
      ...signal === undefined ? {} : { signal } }) as Promise<T>
  return { ctx, api, use, peer, invoke, barrier,
    closeUse() { current = false }, closeBusiness() { business = false }, overrideUse(value: AccountUse) { useOverride = value } }
}

it('returns actual native Loader and preset DTOs without configuration or writable manager authority', async () => {
  const f = await fixture()
  const inventory = await f.invoke<PluginInventorySnapshot>('inventory')
  expect(inventory.managementAvailable).toBe(false)
  expect(inventory.entries.map(row => row.moduleName)).toContain('cordis:settings-view')
  expect(inventory.agentPresets).toMatchObject([{ id: 'a', isDefault: true, rows: [
    { entryId: 'module-a', moduleName: 'cordis:noop-a', enabled: true, fiberPhase: 'active' },
  ] }])
  const presets = await f.invoke<AgentPresetRoster>('presets')
  expect(presets.presets).toEqual([{ id: 'a', isDefault: true, name: 'Preset a' }])
  const document = await f.invoke<CloudPresetComposition>('readPreset', { request: { id: 'a' } })
  expect(document).toEqual(inventory.agentPresets?.[0])
  expect(JSON.stringify({ inventory, presets, document })).not.toContain('PRIVATE_CONFIG_CANARY')
  expect(f.barrier.snapshot().pending).toEqual([])
  expect(f.ctx.cloudNativeSettings.inspect().rpcEndpoints).toHaveLength(3)
  await expect(f.invoke('select', { request: { id: 'a' } })).rejects.toThrow()
  await expect(f.invoke('readPreset', { request: { id: 'foreign' } })).rejects.toThrow()
  await expect(f.invoke('readPreset', { request: { id: 'a', config: true } })).rejects.toThrow()
}, 30000)

it('rejects another original peer, a borrowed foreign root, closed admission and removed provider registrations', async () => {
  const a = await fixture('a'), b = await fixture('b')
  await expect(a.invoke('inventory', {}, b.peer)).rejects.toThrow()
  a.overrideUse(b.use)
  await expect(a.invoke('presets')).rejects.toThrow()
  const c = await fixture('c'); c.closeUse()
  await expect(c.invoke('inventory')).rejects.toThrow()
  const d = await fixture('d'); d.closeBusiness()
  await expect(d.invoke('presets')).rejects.toThrow()
  const owner = firstScreenNativeOwner(b.ctx, 'agentPresets', b.ctx.agentPresets, 512).fiber
  await owner.dispose()
  await expect(b.invoke('inventory')).rejects.toThrow()
}, 30000)

it('retains cancellation and current checks across original native reads, with explicit frame and collection bounds', async () => {
  const f = await fixture(), original = f.ctx.agentPresets.remoteExportList.bind(f.ctx.agentPresets)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const hold = vi.spyOn(f.ctx.agentPresets, 'remoteExportList').mockImplementation(async () => {
    entered.resolve(undefined); await release.promise; return original()
  })
  onTestFinished(() => { hold.mockRestore(); release.resolve(undefined) })
  const pending = f.invoke('presets'); await entered.promise
  f.closeUse(); release.resolve(undefined)
  await expect(pending).rejects.toThrow()
  const bounded = await fixture('bounded', { maxFrameBytes: 16 })
  await expect(bounded.invoke('inventory')).rejects.toThrow()
  const collection = await fixture('collection', { maxCollectionItems: 1 })
  await expect(collection.invoke('inventory')).rejects.toThrow()
}, 30000)

it('excludes original YAML, conditional expressions and native failure text from every public settings response', async () => {
  const f = await fixture()
  const remove = await f.ctx.agentPresets.register({ id: 'broken', plugins: [
    { id: 'condition', name: 'cordis:noop-a', disabled: { __jsExpr: 'PRIVATE_EXPRESSION_CANARY' },
      config: { key: 'PRIVATE_CONFIG_CANARY' } },
  ] })
  onTestFinished(remove)
  const readDocument = vi.spyOn(f.ctx.agentPresets, 'readDocument')
  onTestFinished(() => { readDocument.mockRestore() })
  const inventory = await f.invoke<PluginInventorySnapshot>('inventory')
  const roster = await f.invoke<AgentPresetRoster>('presets')
  const composition = await f.invoke<CloudPresetComposition>('readPreset', { request: { id: 'broken' } })
  expect(composition).toMatchObject({ id: 'broken', broken: 'The native preset composition is unavailable.', rows: [
    { moduleName: 'cordis:noop-a', enabled: 'conditional', fiberPhase: null },
  ] })
  expect(JSON.stringify({ inventory, roster, composition })).not.toContain('PRIVATE_')
  expect(readDocument).not.toHaveBeenCalled()
}, 30000)

it('does not publish a native read after the original observer aborts during its awaited work', async () => {
  const f = await fixture(), original = f.ctx.agentPresets.remoteExportList.bind(f.ctx.agentPresets)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const hold = vi.spyOn(f.ctx.agentPresets, 'remoteExportList').mockImplementation(async () => {
    entered.resolve(undefined); await release.promise; return original()
  })
  onTestFinished(() => { hold.mockRestore(); release.resolve(undefined) })
  const observer = new AbortController(), pending = f.invoke('presets', {}, f.peer, observer.signal)
  await entered.promise
  observer.abort(); release.resolve(undefined)
  await expect(pending).rejects.toThrow()
}, 30000)

it('refuses an inventory containing a private module file path instead of publishing the path', async () => {
  const f = await fixture()
  await f.ctx.loader.create({ name: 'file:///PRIVATE_MODULE_PATH_CANARY/module.mjs', disabled: true })
  await expect(f.invoke('inventory')).rejects.toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
}, 30000)
