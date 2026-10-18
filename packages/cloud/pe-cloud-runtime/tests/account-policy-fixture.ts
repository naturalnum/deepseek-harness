/** Native policy component fixture: real Loader/JSONL/Preset/API with owned Node files and an in-process model, no Root ready authority. */
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Settings from '@deepseek-ai/dsh-settings'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Typert from '@deepseek-ai/dsh-typert-registry'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CloudAccountApi, ConfigSaveCoordinator, ExposureService, type ConfigSaveBarrier, type EndpointExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles, type AccountFilesPreparation } from '@deepseek-ai/dsh-pe-cloud-files'
import * as FilesAccount from '@deepseek-ai/dsh-pe-cloud-files/account'
import { remoteMethods, type PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { onTestFinished } from 'vitest'
import { accountPresetConfigDigest, createAccountPolicy, type AccountPolicyConfig } from '../src/account-policy.ts'
import { AccountPolicyConfigSchema } from '../src/schema.ts'
import { ACCOUNT_NATIVE_ENTRIES } from '../src/account-native-integration.ts'
import { startNativeAccountBoot } from '../src/native-boot.ts'
import type { AccountBinding, AccountId, OwnerEpoch } from '../src/types.ts'

class ExactQuery extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Unused full text search')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Unused full text search')) }
}

/** In-process deterministic external-model fixture; the native registry and stream dispatcher remain real. */
export class TextAdapter extends LlmAdapter {
  calls = 0
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.calls++
    const text = 'native policy reply'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Own one persistent Node directory; repeated graph starts preserve its actual native Workspace and JSONL data.
 * @returns Native graph starter and explicit finite deployment policy, without a PG owner, quota grant or AccountUse.
 */
export function policyFixture(extraRpc: readonly EndpointExposure[] = [],
  firstScreen?: Omit<NonNullable<Parameters<CloudAccountApi['installFirstScreenEvents']>[1]>, 'home' | 'maxInventoryEntries'>
    & { readonly maxCollectionItems: number; readonly expectedHome?: string }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'm8z-account-policy-')))
  const privateRoot = join(home, 'private'), projects = join(home, 'projects'), project = join(projects, 'default-workspace')
  const profileRoot = join(privateRoot, 'profile'), credentials = join(privateRoot, 'credentials.yaml')
  mkdirSync(project, { recursive: true }); initProfile(profileRoot, [])
  const patchPath = join(profileRoot, 'cordis.patch.yml'), configPath = join(profileRoot, 'cordis.yml')
  writeFileSync(configPath, '[]\n'); writeFileSync(patchPath, '[]\n')
  writeFileSync(join(home, 'package.json'), '{"name":"m8z-policy-component","private":true}\n')
  writeFileSync(credentials, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const declaration = { id: 'cloud-chat', plugins: [
    { id: 'persona', name: 'cordis:m8z-persona', config: { prefix: 'Reply briefly.', complete: true, includeRuntimeContext: false } },
  ] }
  const config: AccountPolicyConfig = AccountPolicyConfigSchema({ maxModelRoutes: 2, maxPolicyStringBytes: 128,
    models: [{ provider: 'local-text', model: 'plain-text' }], presetId: declaration.id, presetEntryId: 'cloud-preset',
    presetConfigSha256: accountPresetConfigDigest(declaration, 8192), maxPresetConfigBytes: 8192, agentLoopEntryId: 'agent-loop' })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 2, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 1,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 2, maxNestedPerOperation: 1, maxWaitersPerAccount: 2 })
  const shared = new Context()
  const manifest = { recipeVersion: 'm8z', rpcEndpoints: [...['create', 'prompt', 'cancel', 'page'].map(method => ({
    endpoint: 'session/' + method, handlerId: 'native:sessionController',
    guard: method === 'create' ? 'account-project' as const : 'account-session' as const,
  })), ...extraRpc, ...firstScreen === undefined ? [] : [
    { endpoint: 'session/list', handlerId: 'native:sessionController', guard: 'account-session' as const },
    { endpoint: 'workspace/initializeDefault', handlerId: 'native:workspaceController', guard: 'account-project' as const },
    { endpoint: 'settings/describe', handlerId: 'native:settingsController', guard: 'authenticated-account' as const },
  ]], streamEndpoints: [{ endpoint: 'session/follow', handlerId: 'native:sessionController', guard: 'account-session' as const }, ...firstScreen === undefined ? [] : [
    { endpoint: 'session/control', handlerId: 'native:sessionController', guard: 'account-session' as const },
    { endpoint: 'workspace/follow', handlerId: 'native:workspaceController', guard: 'account-project' as const },
    { endpoint: 'remoteAccess/follow', handlerId: 'native:remoteAccess', guard: 'authenticated-account' as const },
    { endpoint: '$events', handlerId: 'native:typertGateway', guard: 'authenticated-account' as const },
  ]],
  exactFetchRoutes: [], allowedSettings: [] }
  const exposure = new ExposureService(shared, manifest).policy
  const graphs: { close(): Promise<void> }[] = []
  onTestFinished(async () => {
    try { for (const graph of graphs.toReversed()) await graph.close(); saves.close(); await shared.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const maxEntries = 128
  const start = async (epoch = '1', selected = config, bootstrapPolicy = true,
    bootstrapInventory: { maxNativeInventoryEntries?: number } = { maxNativeInventoryEntries: maxEntries }) => {
    const lifetime = new AbortController(), peerLifetime = new AbortController(), adapter = new TextAdapter()
    let adapterRegistration: ReturnType<LlmRuntime['registerAdapter']> | undefined
    let ctx: Context | undefined, api: CloudAccountApi | undefined, files: CloudAccountFiles | undefined
    let barrier: ConfigSaveBarrier | undefined, guards: ReturnType<typeof createAccountPolicy> | undefined
    let removeLlmGuard: (() => void) | undefined
    let nativeFirstScreen: ReturnType<CloudAccountApi['prepareFirstScreen']> | undefined
    let eventOwner: Context | undefined
    let events: ReturnType<CloudAccountApi['installFirstScreenEvents']> | undefined
    const directoryCalls: string[] = []
    const actualGraph = (binding: AccountBinding): void => {
      if (ctx === undefined || ctx.get('peAccount') !== binding || binding.lifetime.aborted) throw new Error('Component graph lifetime ended')
      ctx.fiber.assertActive()
    }
    const requireGuards = () => { if (guards === undefined) throw new Error('Component policy absent'); return guards }
    const requireApi = () => { if (api === undefined) throw new Error('Component API absent'); return api }
    const dependencies = { async apply(owner: Context) {
      await owner.plugin(Typert); await owner.plugin(RemoteAccess); await owner.plugin(Gateway)
      await owner.plugin(Sessions); await owner.plugin(Projections)
      await owner.plugin(SystemPrompt, {}); await owner.plugin(Tools, {}); await owner.plugin(AgentRegistry)
      await owner.plugin(Storage); await owner.plugin(Json, { root: join(privateRoot, 'storage') })
      await owner.plugin(Domain, { backend: 'json' })
      owner.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => undefined,
        bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }) })
      owner.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
        maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] },
      admitPromptContent: (content: unknown) => Promise.resolve(content) })
    } }
    const loop = { inject: [...AgentLoop.inject, 'peCloudApi'], Config: AgentLoop.Config,
      apply(owner: Context, options: ConstructorParameters<typeof AgentLoop>[1]) {
        requireApi().createAgentLoop(owner, requireGuards().agents, options)
      } }
    const controller = { inject: [...SessionController.inject, 'peCloudApi'], Config: SessionController.Config,
      apply(owner: Context, options: ConstructorParameters<typeof SessionController>[1]) {
        const binding = owner.peAccount
        requireApi().createController(owner, { ...requireGuards().sessions, projectDirectory: { binding,
          prepare: async (cwd) => {
            if (files === undefined) throw new Error('Component files absent')
            await files.project().projectDirectory.prepare(cwd)
          } }, ...firstScreen === undefined ? {} : { firstScreen: {
          ...firstScreen, assertSessionRead: (id, summary) => {
            const check = requireGuards().assertSessionRead
            if (check === undefined) throw new Error('Original readonly Session check absent')
            check(id, summary)
          },
        } } }, options)
      } }
    const llm = { inject: ['peCloudApi'], apply(owner: Context) {
      new LlmRuntime(owner)
      adapterRegistration = owner.llm.registerAdapter(['local-text'], adapter)
      removeLlmGuard = requireApi().installLlmGuard(owner, requireGuards().allowedModel)
    } }
    const rows = [
      { id: 'dependencies', name: 'cordis:m8z-dependencies' },
      { id: 'editor', name: 'cordis:m8z-editor' },
      { id: 'credentials', name: 'cordis:m8z-credentials', config: { path: credentials, watch: false } },
      { id: 'jsonl', name: 'cordis:m8z-jsonl', config: { root: join(privateRoot, 'sessions'), compression: 'none' } },
      { id: 'query', name: 'cordis:m8z-query' },
      { id: 'files', name: 'cordis:m8z-files' }, { id: 'llm', name: 'cordis:m8z-llm' },
      { id: 'working-directory', name: 'cordis:m8z-working-directory', config: { defaultDirectory: project } },
      { id: 'presets', name: 'cordis:m8z-presets', config: { default: declaration.id } },
      { id: 'cloud-preset', name: 'cordis:m8z-preset', config: declaration },
      { id: 'model', name: 'cordis:m8z-model', config: { provider: 'local-text', model: 'plain-text' } },
      { id: 'agent-loop', name: 'cordis:' + ACCOUNT_NATIVE_ENTRIES.agentLoop, config: { agents: [] } },
      { id: 'controller', name: 'cordis:m8z-controller', config: { nativeOpen: false } },
      ...firstScreen === undefined ? [] : [
        { id: 'settings', name: 'cordis:m8ax-settings' }, { id: 'locale', name: 'cordis:m8ax-locale', config: { preference: 'en' } },
        { id: 'workspace-controller', name: 'cordis:m8ax-workspace-controller' },
        { id: 'settings-controller', name: 'cordis:m8ax-settings-controller' },
        { id: 'first-screen-events', name: 'cordis:m8ax-events' },
      ],
    ]
    writeFileSync(patchPath, JSON.stringify([{ insert: rows }]))
    const handle = startNativeAccountBoot({
      binding: { accountId: brandString<AccountId>('component'), epoch: brandString<OwnerEpoch>(epoch),
        recipeVersion: 'm8z', lifetime: lifetime.signal },
      profile: { name: 'component', dir: profileRoot, patchPath, home: privateRoot, cwd: project,
        installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined },
      configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: privateRoot, DSH_HOME: privateRoot } }]),
      requiredEntryIds: ['include', ...rows.map(row => row.id)], maxObservedEvents: 16,
      prepare(owner, binding) {
        ctx = owner; barrier = saves.createAccount(binding)
        api = new CloudAccountApi(owner, { binding, saves: barrier, selected: manifest, rootExposure: exposure,
          assertMountCurrent: actualGraph, assertBusinessCurrent: actualGraph,
          ...bootstrapPolicy ? { assertBootstrapCurrent: (signal: AbortSignal) => requireGuards().assertBootstrapCurrent(signal) } : {},
          ...bootstrapInventory,
          assertUnpublished: () => { actualGraph(binding) },
        })
        class NodeFileSystem extends FsLocal {
          static inject = ['peAccount']
          constructor(scope: Context) { super(scope, FsLocal.Config({ cwd: project })) }
        }
        class NodeRegistry extends WorkspaceRegistry {
          async createProject(_grant: unknown): Promise<Workspace> { throw new Error('No component registration entry') }
          async createS2Project() {
            const workspace = await this.initializeDefault(async () => project)
            if (workspace === undefined) throw new Error('Native default Workspace absent')
            return { binding, workspaceId: workspace.id, FileSystem: NodeFileSystem,
              projectDirectory: { binding, prepare: async (cwd: string) => {
                directoryCalls.push(cwd)
                actualGraph(binding)
                if (cwd !== workspace.path || !statSync(cwd).isDirectory()) throw new Error('Outside component project')
              } } }
          }
        }
        const info = statSync(projects, { bigint: true })
        const input: AccountFilesPreparation = { binding, port: { createWorkspaceRegistry: () => NodeRegistry },
          defaultGrant: { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
            parent: { rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino) },
            assertExclusive: () => { actualGraph(binding) } },
          assertMountCurrent: actualGraph, assertUnpublished: () => {
            actualGraph(binding)
            const entry = [...owner.loader.entries()].find(row => row.options.id === 'files')
            if (entry?.fiber?.state === FiberState.ACTIVE) throw new Error('Component registration window ended')
          } }
        files = new CloudAccountFiles(owner, input)
        guards = createAccountPolicy(owner, binding, files, selected, exposure, maxEntries)
        if (firstScreen !== undefined) {
          nativeFirstScreen = api.prepareFirstScreen(owner, { ...firstScreen, maxInventoryEntries: maxEntries,
            project: () => {
              if (files === undefined) throw new Error('Original fixture files owner absent')
              return files.project()
            },
            assertSessionRead: (id) => {
              const check = requireGuards().assertSessionRead
              if (check === undefined) throw new Error('Original fixture readonly policy absent')
              check(id)
            },
          })
          Object.assign(owner.loader.builtins, {
            'm8ax-settings': Settings, 'm8ax-locale': Locale,
            'm8ax-workspace-controller': nativeFirstScreen.workspaceController,
            'm8ax-settings-controller': nativeFirstScreen.settingsController,
            'm8ax-events': { inject: ['workspaceController', 'settingsController', 'typertGateway'],
              apply(scope: Context) { eventOwner = scope } },
          })
        }
        Object.assign(owner.loader.builtins, { 'm8z-dependencies': dependencies, 'm8z-editor': api.providers.configEditor,
          'm8z-credentials': api.providers.credentials, 'm8z-jsonl': Jsonl, 'm8z-files': FilesAccount,
          'm8z-llm': llm, 'm8z-working-directory': WorkingDirectory, 'm8z-presets': AgentPresets, 'm8z-preset': AgentPreset,
          'm8z-persona': Persona, 'm8z-model': DefaultModel, 'm8z-query': ExactQuery,
          [ACCOUNT_NATIVE_ENTRIES.agentLoop]: loop, 'm8z-controller': controller })
      },
    })
    let closing: Promise<void> | undefined, expectedEventFailure: { readonly error: unknown } | undefined
    const close = (): Promise<void> => closing ??= (async () => {
      peerLifetime.abort()
      if (barrier !== undefined) {
        const stopped = await barrier.stopConfigSaves(Date.now() + 1000)
        if (stopped.status !== 'confirmed') throw new Error('Component saves remain owned')
        try { await api?.withdraw() }
        catch (error) {
          if (expectedEventFailure === undefined || error !== expectedEventFailure.error) throw error
        }
      }
      await handle.dispose()
      if (barrier !== undefined) saves.releaseAccount(barrier)
      lifetime.abort()
    })()
    graphs.push({ close })
    const outcome = await handle.result
    if (outcome.status === 'failed') throw outcome.cause
    if (api === undefined || files === undefined || guards === undefined) throw new Error('Component owners absent')
    const inventory = { recipeVersion: manifest.recipeVersion, rpcEndpoints: manifest.rpcEndpoints.filter(row =>
      remoteMethods(outcome.context.sessionController).some(marker => `${outcome.context.sessionController.typertRemote.namespace}/${marker.exportName ?? marker.method}` === row.endpoint
        && (marker.mode ?? 'rpc') === 'rpc')), streamEndpoints: manifest.streamEndpoints.filter(row =>
      remoteMethods(outcome.context.sessionController).some(marker => `${outcome.context.sessionController.typertRemote.namespace}/${marker.exportName ?? marker.method}` === row.endpoint
        && marker.mode === 'stream')), exactFetchRoutes: [] }
    if (firstScreen === undefined) api.audit(inventory)
    else {
      if (eventOwner === undefined) throw new Error('Actual event registration Loader entry absent')
      events = api.installFirstScreenEvents(eventOwner, { ...firstScreen,
        home: firstScreen.expectedHome ?? privateRoot, maxInventoryEntries: maxEntries })
      await api.auditPrepared(outcome.context)
    }
    const invoke = (method: string, request: object) => outcome.context.typertGateway.invoke({ namespace: 'session', method,
      args: { request }, peer: { id: brandString<PeerId>('policy-component'), ctx: outcome.context, principal: { kind: 'owner' },
        interactions: 'answer', signal: peerLifetime.signal, dispose: async () => { peerLifetime.abort() } } })
    return { ctx: outcome.context, binding: outcome.binding, files, guards, api, adapter, close, invoke, lifetime,
      observeNativeDisposal: () => handle.dispose(),
      directoryCalls, maxEntries, events, nativeFirstScreen, profileHome: privateRoot,
      expectEventDisposalFailure: (error: unknown) => { expectedEventFailure = { error } },
      withdrawProvider: () => { adapterRegistration?.() }, withdrawLlmGuard: () => { removeLlmGuard?.() } }
  }
  return { start, config, declaration, project, privateRoot, patchPath }
}
