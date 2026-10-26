import { MODEL_KEY_FIXTURE as APPROVED_MODEL_KEY, modelKeyBinding } from './model-key-policy-data.ts'
/** Real Loader/Settings/Gateway with synthetic login and AccountUse; no PG, model or production storage qualification. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, cpSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import Sessions from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Settings from '@deepseek-ai/dsh-settings'
import Subagents from '@deepseek-ai/dsh-subagent'
import type { ApprovedConfigurationField } from '../src/types.ts'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Typert from '@deepseek-ai/dsh-typert-registry'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { TYPERT } from '@deepseek-ai/dsh-api-settings-controller/typert'
import { fileURLToPath } from 'node:url'
import * as RuntimeAccount from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { startNativeAccountBoot, type NativeAccountBootHandle } from '@deepseek-ai/dsh-pe-cloud-runtime/src/native-boot.ts'
import { CloudAccountFiles, type SkillBundlePort, type SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as ModelProvider from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Agents from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Projections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { MODEL_KEY_RPC_ENDPOINTS, modelKeyCodecs } from '../src/model-key-json.ts'
import { AccountModelKeyEnvironment } from '../src/model-key.ts'
import type { ModelKeyPeerConsumer } from '../src/cloud-model-key.ts'
import { onTestFinished } from 'vitest'
import { CloudAccountApi } from '../src/account-service.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'
import type { NativeFirstScreen } from '../src/native-first-screen.ts'
import type { ManagedSkillPreparation } from '../src/managed-skill-source.ts'

/** This locale-only fixture supplies no project registration or skill write capability. */
class LocaleWorkspaceRegistry extends WorkspaceRegistry {
  createProject(): Promise<never> { return Promise.reject(new Error('No Cloud project registration in locale fixture')) }
  createAdmittedProject(): Promise<never> { return Promise.reject(new Error('No Cloud project registration in locale fixture')) }
  createS2Project(): Promise<never> { return Promise.reject(new Error('No Cloud project registration in locale fixture')) }
}

interface LocaleCallOptions {
  ns?: string
  method?: string
  forgedPeer?: boolean
  extraArgs?: Record<string, unknown>
}

export async function localeFixture(name = 'a', enabled = true, fields: readonly ApprovedConfigurationField[] = [{ namespace: 'locale', field: 'preference', values: ['zh', 'en'] }]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'locale-field-'))), dir = join(home, 'profile')
  mkdirSync(dir); initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'locale-native-owned-fixture', private: true,
    dependencies: { '@deepseek-ai/dsh-pe-cloud-api': '0.2.1-rc.2' } }) + '\n')
  mkdirSync(join(home, 'node_modules', '@deepseek-ai'), { recursive: true })
  // Ordinary finite artifact copies keep this fixture independent of shared workspace links.
  const apiDir = fileURLToPath(new URL('..', import.meta.url))
  const installedApi = join(home, 'node_modules', '@deepseek-ai', 'dsh-pe-cloud-api')
  mkdirSync(join(installedApi, 'lib'), { recursive: true })
  copyFileSync(join(apiDir, 'package.json'), join(installedApi, 'package.json'))
  copyFileSync(join(apiDir, 'lib/typert.host.js'), join(installedApi, 'lib/typert.host.js'))
  const protocolDir = fileURLToPath(new URL('../../../typert/protocol', import.meta.url))
  const installedProtocol = join(home, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
  mkdirSync(join(installedProtocol, 'lib/types'), { recursive: true })
  copyFileSync(join(protocolDir, 'package.json'), join(installedProtocol, 'package.json'))
  copyFileSync(join(protocolDir, 'lib/types/remote-info.js'), join(installedProtocol, 'lib/types/remote-info.js'))
  cpSync(dirname(createRequire(import.meta.url).resolve('zod/package.json')), join(home, 'node_modules/zod'), { recursive: true, dereference: true })
  const projectPath = join(home, 'project'); mkdirSync(projectPath)
  const credentialPath = join(home, 'credentials.yaml')
  writeFileSync(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const skillPointer = join(home, 'skill-current-fixture.json')
  writeFileSync(skillPointer, '{"fixture":"immutable existing sample marker"}\n')
  const profile: ProfileContext = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const configPath = join(dir, 'cordis.yml')
  // Same five immutable rows as the frozen current account-base; only owned Profile paths differ.
  const base = [
    { id: 'model-key-typert', name: '@deepseek-ai/dsh-typert-loader', config: { packages: ['@deepseek-ai/dsh-pe-cloud-api'] } },
    { id: 'model-key', name: 'cordis:pe-cloud-model-key', config: {} },
    { id: 'skill-registry', name: '@deepseek-ai/dsh-skill' },
    { id: 'account-skills', name: 'cordis:pe-cloud-skills', config: {} },
    { id: 'skill-tool', name: '@deepseek-ai/dsh-tool-skill', config: { catalogDescriptionMaxLength: 500 } },
  ]
  writeFileSync(configPath, JSON.stringify(base) + '\n')
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
    { id: 'runtime-account', name: 'cordis:locale-account' },
    { id: 'dependencies', name: 'cordis:locale-dependencies' },
    { id: 'jsonl', name: 'cordis:locale-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'registry', name: 'cordis:locale-registry' },
    { id: 'initialize', name: 'cordis:locale-initialize' },
    { id: 'editor', name: 'cordis:locale-editor' },
    { id: 'settings', name: 'cordis:locale-settings' },
    { id: 'locale', name: 'cordis:locale-host', config: { preference: 'en' } },
    { id: 'subagent', name: 'cordis:locale-subagent', config: { maxActiveSubagents: 8, maxDepth: 1 } },
    { id: 'workspace-controller', name: 'cordis:locale-workspace-controller' },
    { id: 'settings-controller', name: 'cordis:locale-settings-controller' },
    { id: 'credentials', name: 'cordis:locale-credentials', config: { path: credentialPath, watch: false } },
    { id: 'model-provider', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { apiKeyEnv: APPROVED_MODEL_KEY.ref,
      models: [{ id: 'synthetic', maxOutputTokens: 128, contextSize: 4096, capabilities: [] }] } },
  ] }]) + '\n')
  const lifetime = new AbortController()
  let binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'locale-component', lifetime: lifetime.signal })
  const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion,
    allowedSettings: enabled ? [...new Set(fields.map(field => field.namespace))].map(namespace => ({
      namespace, fields: fields.filter(field => field.namespace === namespace).map(field => field.field),
    })) : [], exactFetchRoutes: [],
    rpcEndpoints: [
      ...MODEL_KEY_RPC_ENDPOINTS.map(endpoint => ({ endpoint, handlerId: 'native:cloudModelKey', guard: 'authenticated-account' as const })),
      ...['current', 'publish', 'installed', 'details', 'install', 'update', 'uninstall', 'download'].map(method => ({
        endpoint: 'cloudSkills/' + method, handlerId: 'native:cloudSkills', guard: 'authenticated-account' as const })),
      { endpoint: 'workspace/initializeDefault', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'workspace/create', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'settings/describe', handlerId: 'native:settingsController', guard: 'authenticated-account' },
      ...enabled ? [{ endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' } as const] : [],
    ], streamEndpoints: [
      { endpoint: 'workspace/follow', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'remoteAccess/follow', handlerId: 'native:remoteAccess', guard: 'authenticated-account' },
    ] })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 3, maxWaitersPerAccount: 2 })
  const nativeBoot: { handle?: NativeAccountBootHandle } = {}
  let api: CloudAccountApi | undefined, barrier: ConfigSaveBarrier | undefined
  let native: NativeFirstScreen | undefined, workspace: Workspace | undefined, use: AccountUse | undefined
  let current = true, wrongUse = false, contained = false
  let accepted = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    try {
      if (api !== undefined && barrier !== undefined) {
        const receipt = await api.stopConfigSaves(Date.now() + 1_000)
        if (receipt.status === 'confirmed') { await api.withdraw(); saves.releaseAccount(barrier); saves.close() }
        // An injected unknown result remains retained; ending this owned component does not certify a production clean.
      }
      await nativeBoot.handle?.dispose()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  nativeBoot.handle = startNativeAccountBoot({ binding, profile, configPath,
    bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
    environment: new AccountModelKeyEnvironment(createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]), [APPROVED_MODEL_KEY.ref]),
    requiredEntryIds: ['include', ...base.map(row => row.id), 'runtime-account', 'editor', 'locale', 'settings-controller'],
    maxObservedEvents: 16, maxEntries: 64,
    prepare(owner, installedBinding) {
      binding = installedBinding
      const assert = (actual: AccountBinding): void => {
        lifetime.signal.throwIfAborted()
        if (actual !== binding || contained) throw new CloudApiError('cloud/account-unavailable', 'Owned fixture unavailable.')
      }
      barrier = saves.createAccount(binding, { references: [APPROVED_MODEL_KEY.ref], maxReferences: 1, maxReferenceBytes: 64 },
        () => { contained = true })
      api = new CloudAccountApi(owner, { binding, rootExposure: policy, selected: policy.manifest, saves: barrier,
        assertMountCurrent: assert, assertBusinessCurrent: assert })
      use = { binding, context: owner, assertCurrent: () => { assert(binding) }, release() {} }
      const consumer: ModelKeyPeerConsumer = { withModelKeyPeerUse: (actual, consume) => {
        if (actual !== peer || use === undefined) throw new CloudApiError('cloud/forbidden', 'Wrong original fixture Peer.')
        const check = (): void => { if (!current) throw new CloudApiError('cloud/stale-generation', 'Original fixture Peer ended.'); assert(binding) }
        check()
        const selected = wrongUse ? { ...use, binding: { ...binding, epoch: brandString<AccountBinding['epoch']>('other') } } : use
        const operation = consume(selected, check)
        accepted.resolve(undefined)
        return operation
      } }
      const assertWorkspace = (actual: Workspace): void => { if (actual !== workspace) throw new Error('Wrong Workspace') }
      native = api.prepareFirstScreen(owner, {
        project: () => { if (workspace === undefined) throw new Error('Workspace missing'); return { binding, workspace } },
        assertWorkspace,
        assertSessionRead: () => { throw new Error('No Session activation in this fixture') },
        maxInventoryEntries: 256, maxCollectionItems: 16, maxFrameBytes: 65536,
        ...enabled ? { settingsWrites: { ...consumer, fields } } : {},
      })
      const preparedApi = api, firstScreen = native
      const keyLimits = { bindings: [modelKeyBinding('model-provider')], maxKeyBytes: 64, maxVersionBytes: 128, maxReplyBytes: 4096, maxMetadataBytes: 65536 }
      const deny = (): never => { throw new Error('No skill storage writes or resource execution in the locale fixture') }
      const bundles: SkillBundlePort = { prepareBundle: deny, commitCatalog: deny, withBundleSource: deny,
        exportBundle: deny, materializeBundleVersion: deny,
        observeCatalog(signal) {
          signal.throwIfAborted(); assert(binding)
          return Promise.resolve({ value: { entries: [], revision: null }, release() {} })
        } }
      const skillPort: SkillVersionPort & { bundles: SkillBundlePort } = { bundles, prepare: deny, commit: deny, withSource: deny,
        current: async (signal) => { signal.throwIfAborted(); return { value: undefined, release() {} } } }
      const info = statSync(home, { bigint: true })
      const files = new CloudAccountFiles(owner, { binding,
        defaultGrant: { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'project',
          parent: { rootPath: home, rootDevice: String(info.dev), rootInode: String(info.ino) },
          assertExclusive: () => { assert(binding) } },
        skillVersions: () => skillPort, assertMountCurrent: assert, assertUnpublished: () => { assert(binding) },
        port: { createWorkspaceRegistry: () => LocaleWorkspaceRegistry } })
      const managed: ManagedSkillPreparation = {
        limits: { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 },
        bundleLimits: { maxInstallations: 4, maxFiles: 8, maxDirectories: 6, maxDepth: 5, maxPathBytes: 256,
          maxFileBytes: 4096, maxContentBytes: 16384, maxArchiveBytes: 32768, maxArchiveEntries: 16,
          maxExpandedArchiveBytes: 16384, maxInputBytes: 65536, maxManifestBytes: 8192, maxCatalogBytes: 8192,
          maxDownloadBytes: 32768, maxRequestBytes: 65536, maxReplyBytes: 131072,
          maxStagingBytes: 65536, reservationBytes: 65536 }, assertWorkspace,
      }
      // Source aliases supply the original module namespaces to the native bare-module resolver.
      const internal = owner.loader.internal
      if (internal === undefined) throw new Error('Native module resolver missing')
      const nativeImport = internal.import
      internal.import = async (specifier: string, ...args: unknown[]) => {
        if (specifier === '@deepseek-ai/dsh-typert-loader') return TypertLoader
        if (specifier === '@deepseek-ai/dsh-skill') return { default: SkillRegistry }
        if (specifier === '@deepseek-ai/dsh-tool-skill') return ToolSkill
        if (specifier === '@deepseek-ai/dsh-llm-deepseek-api-key') return ModelProvider
        const value: unknown = await Reflect.apply(nativeImport, internal, [specifier, ...args])
        return value
      }
      owner.effect(() => () => { internal.import = nativeImport }, 'fixture: original resolver restoration')

      Object.assign(owner.loader.builtins, {
        'locale-account': RuntimeAccount,
        'pe-cloud-model-key': { inject: ['typert', 'credentials', 'settings', 'llm'], apply(scope: Context) {
          preparedApi.prepareCloudModelKey(scope, { ...consumer, limits: keyLimits, maxNativeInventoryEntries: 256 })
        } },
        'pe-cloud-skills': { inject: ['typert', 'skills'], apply(scope: Context) {
          preparedApi.prepareCloudSkills(scope, { ...consumer, files, managed,
            limits: { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 4096, maxRetainedVersions: 4 } })
        } },
        'locale-dependencies': { async apply(scope: Context) {
          await scope.plugin(Typert); await scope.plugin(RemoteAccess); await scope.plugin(Gateway)
          await scope.plugin(Sessions); await scope.plugin(Storage); await scope.plugin(JsonStorage, { root: join(home, 'storage') })
          await scope.plugin(StorageDomain, { backend: 'json' })
          await scope.plugin(LlmRuntime); await scope.plugin(Agents); await scope.plugin(Projections)
          await scope.plugin(SystemPrompt, SystemPrompt.Config({})); await scope.plugin(Tools)
          await scope.plugin(FsLocal, { cwd: projectPath })
          await scope.plugin(WorkingDirectory, { defaultDirectory: projectPath })
          scope.get('typert')!.register(validateTypertManifest('@deepseek-ai/dsh-api-settings-controller', TYPERT))
        } },
        'locale-jsonl': Jsonl, 'locale-registry': WorkspaceRegistry,
        'locale-initialize': { inject: ['workspaceRegistry'], async apply(scope: Context) {
          workspace = await scope.workspaceRegistry.initializeDefault(async () => projectPath)
        } },
        'locale-editor': preparedApi.providers.configEditor, 'locale-settings': Settings, 'locale-host': Locale, 'locale-subagent': Subagents,
        'locale-credentials': preparedApi.providers.credentials,
        'locale-workspace-controller': firstScreen.workspaceController, 'locale-settings-controller': firstScreen.settingsController,
      })
    } })
  const outcome = await nativeBoot.handle.result
  if (outcome.status !== 'mounted') throw outcome.cause
  const ctx = outcome.context
  if (api === undefined || native === undefined || barrier === undefined) throw new Error('Fixture owners missing')
  await ctx.cloudModelKey.auditProvider()
  await ctx.cloudSkills.restore()
  const inventory = native.inspect()
  api.audit({ ...inventory, rpcEndpoints: [...inventory.rpcEndpoints, ...ctx.cloudModelKey.inspect().rpcEndpoints,
    ...ctx.cloudSkills.inspect().rpcEndpoints] })
  const abort = new AbortController()
  const peer: PeerScope = { id: brandString<PeerScope['id']>('peer-' + name), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: abort.signal, dispose: () => Promise.resolve() }
  const ref = APPROVED_MODEL_KEY.ref
  const codecs = modelKeyCodecs({ maxKeyBytes: 64, maxVersionBytes: 128, maxReplyBytes: 4096 }, [ref])
  const keyState = async () => codecs.state.create().parse(await ctx.typertGateway.invoke({ namespace: 'cloudModelKey',
    method: 'describe', args: { request: { ref } }, peer }))
  const initialKey = await keyState()
  await ctx.typertGateway.invoke({ namespace: 'cloudModelKey', method: 'set',
    args: { request: { ref, value: 'synthetic-fixture-key', version: initialKey.version } }, peer })
  const keyStateBefore = await keyState()
  accepted = Promise.withResolvers<undefined>()
  const sourceBefore = readFileSync(skillPointer), keyBefore = readFileSync(credentialPath)
  const ownedApi = api, ownedBarrier = barrier, originalPeer = peer
  return { ctx, api: ownedApi, barrier: ownedBarrier, saves, profile, configPath, binding, lifetime,
    credentialPath, skillPointer, sourceBefore, keyBefore, ref, keyState, keyStateBefore,
    revision: (ns = 'locale') => ctx.settingsController.describe().namespaces.find(row => row.ns === ns)!.revision,
    call: (ops: unknown, revision: unknown, options: LocaleCallOptions = {}) =>
      ctx.typertGateway.invoke({ namespace: 'settings', method: options.method ?? 'mutate',
        args: { ns: options.ns ?? 'locale', ops, expectedRevision: revision, ...options.extraArgs },
        peer: options.forgedPeer ? { ...originalPeer } : originalPeer }),
    revoke: () => { current = false }, restore: () => { current = true },
    wrongUse: (value: boolean) => { wrongUse = value },
    accepted: () => accepted.promise, nextAccepted: () => { accepted = Promise.withResolvers<undefined>() },
    contained: () => contained,
  }
}
