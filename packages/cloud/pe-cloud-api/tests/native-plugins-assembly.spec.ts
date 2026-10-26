/** Actual original API/Manager/Editor/Remote/generated-descriptor assembly; no business-ready runtime or M1 capability is supplied. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { WorkspaceAnalyzer, FaceModelEmitter, findWorkspaceRoot } from '@deepseek-ai/dsh-typert-generator'
import { boot, initProfile, PluginPackages, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Typert from '@deepseek-ai/dsh-typert-registry'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import * as Reminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { CloudAccountFiles, type AccountFilesPreparation, type SkillVersionPort, type SkillBundlePort } from '@deepseek-ai/dsh-pe-cloud-files'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudAccountApi } from '../src/account-service.ts'
import { CloudApiError } from '../src/errors.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { parseApprovedConfigurationCatalog } from '../src/approved-catalog.ts'
import { APPROVED_PLUGIN_CONTROL as fixed } from '../src/plugin-json.ts'

class UnusedWorkspaceRegistry extends WorkspaceRegistry {
  createProject(): Promise<never> { return Promise.reject(Error('No workspace activation in this fixture')) }
  createAdmittedProject(): Promise<never> { return Promise.reject(Error('No workspace activation in this fixture')) }
  createS2Project(): Promise<never> { return Promise.reject(Error('No workspace activation in this fixture')) }
}

it('assembles original plugin controls and managed skills together with exact generated descriptors and one save owner', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-plugin-assembly-'))), dir = join(home, 'profile')
  mkdirSync(dir); mkdirSync(join(home, 'node_modules/@deepseek-ai'), { recursive: true }); initProfile(dir, [])
  const require = createRequire(import.meta.url)
  symlinkSync(dirname(require.resolve(fixed.moduleName + '/package.json')), join(home, 'node_modules', fixed.moduleName))
  const anchor = join(home, 'package.json'); writeFileSync(anchor, '{"name":"native-plugin-assembly-owned","dependencies":{}}')
  const profile: ProfileContext = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: anchor, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>('native-assembly'),
    epoch: brandString<OwnerEpoch>('epoch-one'), recipeVersion: 'native-assembly', lifetime: new AbortController().signal })
  const pluginLimits = { maxProfileBytes: 32768, maxRequestBytes: 2048, maxReplyBytes: 16384, maxVersionBytes: 128 }
  const catalog = parseApprovedConfigurationCatalog({ recipeVersion: binding.recipeVersion, catalogVersion: 'native-generic',
    maxEntries: 16, maxStringBytes: 256, maxCatalogBytes: 8192, pluginControl: pluginLimits,
    plugins: [{ ...fixed, installable: false, toggleable: true }], fields: [], skills: { mode: 'closed' },
    credentials: { mode: 'read-only' } }, binding.recipeVersion, true)!
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 8, maxWaitersPerAccount: 2 })
  const skillMethods = ['current','publish','installed','details','install','update','uninstall','download']
  const barrier = saves.createAccount(binding), policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion,
    rpcEndpoints: [...['cloudPlugins/current', 'cloudPlugins/change'].map(endpoint => ({ endpoint,
      handlerId: 'native:cloudPlugins', guard: 'authenticated-account' as const })), ...skillMethods.map(method => ({ endpoint: 'cloudSkills/'+method,
      handlerId: 'native:cloudSkills', guard: 'authenticated-account' as const }))], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] })
  let ctx: Context | undefined = undefined, api: CloudAccountApi | undefined
  onTestFinished(async () => {
    await barrier.stopConfigSaves(Date.now() + 1000)
    try { await api?.withdraw(); await ctx?.fiber.dispose() }
    finally { saves.releaseAccount(barrier); saves.close(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) }
  })
  const apiManifest = require.resolve('@deepseek-ai/dsh-pe-cloud-api/package.json')
  const workspace = findWorkspaceRoot(dirname(apiManifest))
  const model = new WorkspaceAnalyzer({ root: workspace, packages: ['@deepseek-ai/dsh-pe-cloud-api'],
    faces: ['host'], mode: 'check', checkDiagnostics: true, rejectBuildOutputs: true }).analyze()
  const face = model.faces.find(value => value.face === 'host')
  if (face === undefined) throw new Error('Original Cloud API Host model absent')
  const remoteSource = readFileSync(require.resolve('@deepseek-ai/dsh-typert-protocol/src/remote-info.ts'), 'utf8')
  const remote = ts.transpileModule(remoteSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  }).outputText
  expect(ts.createSourceFile('remote-info.js', remote, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
    .statements.filter(ts.isImportDeclaration)).toEqual([])
  const factoryPath = join(home, 'remote-info.mjs'); writeFileSync(factoryPath, remote)
  const descriptor = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-pe-cloud-api').js
    .replace(/from (['"])zod\1/g, 'from ' + JSON.stringify(pathToFileURL(require.resolve('zod')).href))
    .replace(/from (['"])@deepseek-ai\/dsh-typert-protocol\/remote-info\1/g,
      'from ' + JSON.stringify(pathToFileURL(factoryPath).href))
  const installed = join(home, 'node_modules/@deepseek-ai/dsh-pe-cloud-api')
  mkdirSync(join(installed, 'lib'), { recursive: true })
  writeFileSync(join(installed, 'package.json'), readFileSync(apiManifest))
  writeFileSync(join(installed, 'lib/typert.host.js'), descriptor)
  const config = join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([{ id: 'artifacts', name: 'cordis:artifacts', config: { packages: ['@deepseek-ai/dsh-pe-cloud-api'] } },
    { id: 'registry', name: 'cordis:registry' }, { id: 'editor', name: 'cordis:editor' }, { id: 'manager', name: 'cordis:manager' }, { id: 'plugins', name: 'cordis:plugins' },
    { id: 'skills', name: 'cordis:skills' },
    { id: 'repeat-tool-reminder', name: fixed.moduleName, disabled: true, config: { thresholds: [3, 5, 8] } }]))
  ctx = await boot('dsh', config, [], async (owner) => {
    owner.provide('profileContext', profile); owner.provide('peAccount', binding)
    await owner.plugin(Typert); await owner.plugin(PluginPackages)
    api = new CloudAccountApi(owner, { binding, saves: barrier, rootExposure: policy, selected: policy.manifest,
      assertMountCurrent() { owner.fiber.assertActive(); binding.lifetime.throwIfAborted() },
      assertBusinessCurrent() { throw new CloudApiError('cloud/account-unavailable', 'No actual production ready graph in this fixture.') },
      plugins: { catalog, limits: pluginLimits,
        maxNativeInventoryEntries: 64, requiredEntryIds: ['include:editor'], resolvePackages: () => owner.get('pluginPackages'),
        async withModelKeyPeerUse() { throw new Error('No production M1 capability') },
        async withConfigurationPeer() { throw new Error('No production M1 capability') },
        async withIdleConfiguration() { throw new Error('No production idle factory') },
        scheduleRebuild() { throw new Error('No production terminal factory') },
      } })
    const deny = (): never => { throw Error('No source write, projection or live Peer in this fixture') }
    const bundles: SkillBundlePort = { prepareBundle: deny, commitCatalog: deny, withBundleSource: deny, exportBundle: deny,
      materializeBundleVersion: deny, observeCatalog: async () => ({ value: { entries: [], revision: null }, release() {} }) }
    const versions: SkillVersionPort & { bundles: SkillBundlePort } = {
      bundles, prepare: deny, commit: deny, withSource: deny, current: deny }
    const info = statSync(home, { bigint: true })
    const grant: AccountFilesPreparation['defaultGrant'] = { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
      parent: { rootPath: home, rootDevice: String(info.dev), rootInode: String(info.ino) },
      assertExclusive() { owner.fiber.assertActive() } }
    const files = new CloudAccountFiles(owner, { binding, defaultGrant: grant, skillVersions: () => versions,
      assertMountCurrent() { owner.fiber.assertActive() }, assertUnpublished() { owner.fiber.assertActive() },
      port: { createWorkspaceRegistry: () => UnusedWorkspaceRegistry } })
    const actual = api
    Object.assign(owner.loader.builtins, { artifacts: TypertLoader, registry: SkillRegistry, editor: actual.providers.configEditor,
      manager: actual.providers.pluginManager!, plugins: { inject: ['typert', 'pluginManager', 'configEditor'],
        apply(scope: Context) { actual.prepareCloudPlugins(scope) } }, skills: { inject: ['skills','typert'], apply(scope: Context) {
        actual.prepareCloudSkills(scope, { files,
          limits: { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 8192, maxRetainedVersions: 8 },
          withModelKeyPeerUse: deny, managed: {
            limits: { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 },
            bundleLimits: { maxInstallations: 4, maxFiles: 8, maxDirectories: 6, maxDepth: 5, maxPathBytes: 256,
              maxFileBytes: 4096, maxContentBytes: 16384, maxArchiveBytes: 32768, maxArchiveEntries: 16, maxExpandedArchiveBytes: 16384,
              maxInputBytes: 65536, maxManifestBytes: 8192, maxCatalogBytes: 8192, maxDownloadBytes: 32768,
              maxRequestBytes: 65536, maxReplyBytes: 131072, maxStagingBytes: 65536, reservationBytes: 65536 }, assertWorkspace: deny } })
      } } })
    const nativeLoader = owner.loader.internal
    if (nativeLoader === undefined) throw new Error('Original Loader import authority absent')
    const nativeImport = nativeLoader.import
    vi.spyOn(nativeLoader, 'import').mockImplementation(async (...args: Parameters<typeof nativeLoader.import>) => {
      const result: unknown = args[0] === fixed.moduleName ? Reminder : await Reflect.apply(nativeImport, nativeLoader, args)
      return result
    })
  })
  if (api === undefined) throw new Error('Original native API preparation absent')
  await api.restoreApprovedPlugins(); await ctx.cloudSkills.restore()
  const inventory = ctx.cloudPlugins.inspect()
  expect(inventory.rpcEndpoints.map(row => row.endpoint)).toEqual(['cloudPlugins/current', 'cloudPlugins/change'])
  const skills = ctx.cloudSkills.inspect()
  expect(skills.rpcEndpoints.map(row => row.endpoint)).toEqual(skillMethods.map(method => 'cloudSkills/'+method))
  expect(saves.snapshot()).toMatchObject({ accounts: 1, tracked: 0 })
  for (const endpoint of [...inventory.rpcEndpoints, ...skills.rpcEndpoints]) {
    const descriptor = ctx.typert.local.get(endpoint.endpoint)
    expect(descriptor).toMatchObject({ service: endpoint.endpoint.split('/')[0], invocation: { kind: 'direct' },
      parameters: [{ source: 'json', wire: 'request', codec: { mode: 'strict' } }], result: { mode: 'strict' } })
  }
  const installedApi = api
  expect(() => installedApi.requireRpc('cloudPlugins/current')).toThrow(CloudApiError)
  expect(barrier.snapshot().pending).toEqual([]); expect(barrier.snapshot().failures).toEqual([])
}, 30000)
