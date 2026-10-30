import { MODEL_KEY_FIXTURE as APPROVED_MODEL_KEY, modelKeyBinding } from '../../pe-cloud-api/tests/model-key-policy-data.ts'
/** Actual Profile/Include/native providers with factory or component admission; owned Node paths never prove quota or ready. */
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-pe-account-instructions/types'
import type { OfficeToPdfKey } from '@deepseek-ai/dsh-office-to-pdf/types'
import * as fs from 'node:fs/promises'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState, symbols } from '@deepseek-ai/cordis'
import { boot, initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { CloudAccountApi, ConfigSaveCoordinator, ExposureService, AccountModelKeyEnvironment, type ConfigSaveBarrier } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles, type AccountFilesPreparation, type ResolveAccountFileProject } from '@deepseek-ai/dsh-pe-cloud-files'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as ExecutionRoot from '@deepseek-ai/dsh-pe-opensandbox/root'
import NativeController, { type SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import NativeLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { FsError } from '@deepseek-ai/dsh-fs'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Settings from '@deepseek-ai/dsh-settings'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import Typert from '@deepseek-ai/dsh-typert-registry'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PeAccountRuntime } from '../src/root.ts'
import { AccountFactory } from '../src/account-factory.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { deriveAccountLayout, defaultProjectLayout } from '../src/account-layout.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import { ACCOUNT_NATIVE_ENTRIES as names, ACCOUNT_FIRST_SCREEN_ENTRIES as firstScreenNames, AccountNativeIntegration, type AccountNativeGuards } from '../src/account-native-integration.ts'
import { mountAccount, type AccountRecipe } from '../src/account-mount.ts'
import { accountPresetConfigDigest, createAccountPolicy } from '../src/account-policy.ts'
import { AccountPolicyConfigSchema } from '../src/schema.ts'
import { AccountRuntimeError } from '../src/errors.ts'
import type { NativeAccountBootHandle } from '../src/native-boot.ts'
import { instructionLimits, instructionSourceFixture, type InstructionSourceFixture } from './instruction-source-fixture.ts'
import { nativeProjectDeriver, nativeRoutedFileSystem } from './native-project-fixture.ts'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountId, AccountMountInput, OwnerEpoch } from '../src/types.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
beforeEach(async () => { vi.mocked(fs.rename).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).rename) })

class ExactQuery extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Unexercised search fixture')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Unexercised search fixture')) }
}

const cleanups: (() => Promise<void>)[] = []
const roots: Context[] = []
const directories: string[] = []
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally {
    for (const root of roots.splice(0)) await root.fiber.dispose()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
})

async function fixture(options: {
  modelKey?: boolean
  terminalProbe?: boolean
  missingGuards?: boolean
  firstScreen?: boolean
  copiedFilesBinding?: boolean
  stopTimeoutMs?: number
  earlyLlmAndController?: boolean
  readonlyBase?: boolean
  verifyDirectory?: (ctx: Context) => Promise<void>
  controllerEntered?: (ctx: Context) => void
  instructionSources?: InstructionSourceFixture
  nativeFiles?: boolean
  auditedFileCalls?: boolean
  installFileApi?: boolean
  office?: boolean
  officeUnselected?: boolean
  beforeBootstrap?: (ctx: Context) => void
  verifyBootstrap?: (api: CloudAccountApi) => Promise<void>
} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'm8s-native-integration-')))
  directories.push(directory)
  const sharedPath = join(directory, 'root.cordis.yml')
  const saves = new ConfigSaveCoordinator({ maxAccounts: 2, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 1,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 2, maxNestedPerOperation: 1, maxWaitersPerAccount: 2 })
  const barriers: ConfigSaveBarrier[] = []
  const issue = saves.createAccount.bind(saves)
  vi.spyOn(saves, 'createAccount').mockImplementation((binding, ...policy) => { const barrier = issue(binding, ...policy); barriers.push(barrier); return barrier })
  writeFileSync(sharedPath, JSON.stringify([
    { id: 'runtime', name: 'cordis:runtime', config: { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 } },
    { id: 'exposure', name: 'cordis:exposure', config: { recipeVersion: 'm8s',
      rpcEndpoints: options.instructionSources === undefined ? [] : ['create', 'prompt', 'cancel', 'page'].map(method => ({
        endpoint: 'session/' + method, handlerId: 'native:sessionController', guard: method === 'create' ? 'account-project' : 'account-session',
      })).concat(options.auditedFileCalls ? ['read', 'stat'].map(method => ({ endpoint: `workspaceFiles/${method}`,
        handlerId: 'native:workspaceFiles', guard: 'account-session' })) : []).concat(options.office && !options.officeUnselected ? [
        { endpoint: 'officeToPdf/render', handlerId: 'native:officeToPdf', guard: 'account-session' },
        { endpoint: 'officeToPdf/generation', handlerId: 'native:officeToPdf', guard: 'authenticated-account' },
      ] : []),
      streamEndpoints: options.auditedFileCalls ? [{ endpoint: 'workspaceFiles/changes',
        handlerId: 'native:workspaceFiles', guard: 'account-session' }] : [], exactFetchRoutes: [], allowedSettings: [] } },
    { id: 'execution', name: 'cordis:execution', config: { mode: 'closed', requiredCapabilities: [], maxBoundAccounts: 2 } },
  ]))
  const root = await boot('m8s-shared-root', sharedPath, [], (ctx) => {
    Object.assign(ctx.loader.builtins, { runtime: PeAccountRuntime, exposure: ExposureService, execution: { ...ExecutionRoot, inject: ['peAccountRuntime'] } })
  })
  roots.push(root)
  const capacity = new RuntimeCapacity({ maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const factory = new AccountFactory(capacity, { maxWaiters: 2, maxWaitersPerAccount: 2, maxBorrows: 2, maxBorrowsPerAccount: 2 })
  const identity = createProcessInstanceIdentity()
  const accountId = brandString<AccountId>('m8s-' + directory)
  const layout = deriveAccountLayout(accountId, identity.instanceId, {
    sharedAccountsRoot: join(directory, 'accounts'), localCacheRoot: join(directory, 'cache'), maxPathBytes: 4096,
  })
  const project = defaultProjectLayout(layout, 4096).root
  mkdirSync(project, { recursive: true })
  initProfile(layout.profileRoot, [])
  const anchor = join(directory, 'package.json')
  writeFileSync(anchor, '{"name":"m8s-native-fixture","private":true}\n')
  const configPath = join(layout.profileRoot, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  if (options.readonlyBase) chmodSync(configPath, 0o444)
  mkdirSync(layout.credentialsRoot, { recursive: true })
  const credentialPath = join(layout.credentialsRoot, 'credentials.yaml')
  writeFileSync(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId, epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'm8s', lifetime: lifetime.signal })
  const input: AccountMountInput = { binding, instanceId: identity.instanceId, layout,
    environment: options.modelKey ? new AccountModelKeyEnvironment(createLaunchEnvironmentSnapshot([]), [APPROVED_MODEL_KEY.ref])
      : createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot, DSH_HOME: layout.privateRoot } }]) }
  let componentGraph: { ctx: Context; binding: AccountBinding } | undefined
  const assertCurrent = (current: AccountBinding): void => {
    if (options.instructionSources === undefined) { factory.assertMountCurrent(current); return }
    if (componentGraph?.binding !== current || componentGraph.ctx.get('peAccount') !== current || current.lifetime.aborted) {
      throw new AccountRuntimeError('cloud/stale-generation', 'The instruction component graph has ended')
    }
    componentGraph.ctx.fiber.assertActive()
  }
  const declaration = { id: 'instruction-chat', plugins: [
    { id: 'file-instructions', name: 'cordis:' + names.instructions, config: instructionLimits },
    ...options.nativeFiles ? [{ id: 'native-tools', name: 'cordis:m8s-tool-fs',
      config: { read: true, write: true, edit: false, readImage: false } }] : [],
  ] }
  const policy = AccountPolicyConfigSchema({ maxModelRoutes: 2, maxPolicyStringBytes: 128,
    models: [{ provider: 'local-text', model: 'plain-text' }], presetId: declaration.id, presetEntryId: 'instruction-preset',
    presetConfigSha256: accountPresetConfigDigest(declaration, 8192), maxPresetConfigBytes: 8192, agentLoopEntryId: 'loop' })
  const guards = vi.fn((_ctx: Context, _installed: AccountBinding, files: CloudAccountFiles): AccountNativeGuards => {
    if (options.instructionSources !== undefined) return createAccountPolicy(_ctx, _installed, files, policy, root.peExposure.policy, 128)
    const unavailable = (): never => { throw new AccountRuntimeError('cloud/account-unavailable', 'No fixture project/model/Preset approval') }
    return {
      assertWorkspace: unavailable, projectForAgent: unavailable, projectForSession: unavailable,
      projectForObservedHeader: unavailable, projectForDirectory: unavailable, getFileProject: async () => unavailable(),
      resolveFileScope: async () => unavailable(),
      sessions: { assertHandlerEnabled: unavailable,
        resolveCreate: async () => unavailable(), assertSessionProject: async () => unavailable(), assertActiveScope: unavailable },
      agents: { assertCreate: async () => unavailable(), assertResume: async () => unavailable(), assertPrepared: unavailable },
      allowedModel: () => false,
      assertBootstrapCurrent: async () => unavailable(),
    }
  })
  let resolveFiles: ResolveAccountFileProject | undefined
  const dependencies = { async apply(ctx: Context) {
    await ctx.plugin(Typert)
    await ctx.plugin(RemoteAccess)
    if (options.firstScreen || options.instructionSources !== undefined) await ctx.plugin(Gateway)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools, {})
    await ctx.plugin(Agents)
    // Native-only tests own these Node directories. This local provider never supplies product quota approval.
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root: layout.storageRoot })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    await ctx.plugin(ExactQuery)
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => undefined,
      bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) })
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] },
    admitPromptContent: (content: unknown) => Promise.resolve(content) })
  } }
  const rows = [
    { id: 'account', name: 'cordis:' + names.runtime }, { id: 'api', name: 'cordis:' + names.api },
    { id: 'files', name: 'cordis:' + names.files },
    { id: 'editor', name: 'cordis:' + names.editor },
    { id: 'credentials', name: 'cordis:' + names.credentials, config: { path: credentialPath, watch: false } },
    { id: 'dependencies', name: 'cordis:m8s-dependencies' },
    ...options.terminalProbe ? [{ id: 'terminal-probe', name: 'cordis:m8s-terminal-probe', config: { value: 1 } }] : [],
    ...options.modelKey ? [{ id: 'model-key', name: 'cordis:' + names.modelKey }] : [],
    { id: 'llm', name: 'cordis:' + (options.earlyLlmAndController ? 'm8s-early-llm' : names.llm) },
    { id: 'jsonl', name: 'cordis:m8s-jsonl', config: { root: layout.sessionsRoot, compression: 'none' } },
    { id: 'default-model', name: 'cordis:m8s-model', config: options.instructionSources === undefined
      ? { provider: 'unused', model: 'unused' } : { provider: 'local-text', model: 'plain-text' } },
    { id: 'working-directory', name: 'cordis:m8s-working-directory' },
    ...options.nativeFiles ? [{ id: 'sandbox-policy', name: 'cordis:m8s-sandbox-policy',
      config: { mode: 'workspace-write', workspaceRoot: project } }] : [],
    ...options.auditedFileCalls || options.installFileApi ? [{ id: 'native-file-api', name: 'cordis:' + names.workspaceFiles,
      config: { maxBytes: 4096, maxFileBytes: 4096, maxLines: 20, maxEntries: 20 } }] : [],
    ...options.office ? [{ id: 'native-office', name: 'cordis:' + names.officeToPdf, config: { maxInputBytes: 16 } }] : [],
    ...options.instructionSources === undefined ? [] : [
      { id: 'instruction-adapter', name: 'cordis:m8s-instruction-adapter' },
      { id: 'instruction-presets', name: 'cordis:m8s-presets', config: { default: declaration.id } },
      { id: 'instruction-preset', name: 'cordis:m8s-preset', config: declaration },
    ],
    { id: 'loop', name: 'cordis:' + names.agentLoop, config: { agents: [] } },
    { id: 'controller', name: 'cordis:' + names.controller, config: { nativeOpen: false } },
    { id: 'execution', name: 'cordis:' + names.execution, config: { mode: 'closed', requiredCapabilities: [] } },
    ...options.firstScreen ? [
      { id: 'settings', name: 'cordis:m8ax-settings' }, { id: 'locale', name: 'cordis:m8ax-locale' },
      { id: 'workspace-controller', name: 'cordis:' + firstScreenNames.workspaceController },
      { id: 'settings-controller', name: 'cordis:' + firstScreenNames.settingsController },
      { id: 'first-screen-events', name: 'cordis:' + firstScreenNames.events },
    ] : [],
  ]
  if (options.earlyLlmAndController) rows.sort((a, b) => Number(b.id === 'controller') - Number(a.id === 'controller'))
  writeFileSync(layout.patchPath, JSON.stringify([{ insert: rows }]))
  const recipe: AccountRecipe = {
    profile: { name: 'account', dir: layout.profileRoot, patchPath: layout.patchPath, installAnchor: anchor,
      cwd: project, home: layout.privateRoot, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined },
    configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
    requiredEntryIds: ['include', ...rows.map(row => row.id)], maxObservedEvents: 16, maxPathBytes: 4096,
    native: { saves, exposure: root.peExposure.policy, execution: root.peSandboxCoordinator, stopTimeoutMs: options.stopTimeoutMs ?? 5000,
      maxNativeInventoryEntries: 128,
      ...options.modelKey ? { modelKey: { limits: { bindings: [modelKeyBinding('provider')], maxKeyBytes: 128, maxVersionBytes: 128,
        maxReplyBytes: 4096, maxMetadataBytes: 65536 }, maxNativeInventoryEntries: 128,
      withModelKeyPeerUse: async () => { throw new Error('No component login or production ready borrow') },
      } } : {},
      ...options.firstScreen ? { firstScreen: { home: layout.privateRoot, maxHomeBytes: 4096,
        maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 131072 } } : {},
      assertRootCurrent: () => {
        if (options.instructionSources === undefined) { root.peAccountRuntime.assertRecipeSealed('m8s'); return }
        root.fiber.assertActive()
        if (componentGraph === undefined) throw new Error('The instruction component graph is absent')
        assertCurrent(componentGraph.binding)
      },
      ...options.missingGuards ? {} : { guards },
      files(_ctx, installed, getFileProject): AccountFilesPreparation {
        resolveFiles = getFileProject
        // This external Node-port fixture supplies no Linux FD, quota, exclusive namespace or production storage certificate.
        class FixtureFileSystem extends FsLocal {
          static inject = ['peAccount']
          constructor(owner: Context) { super(owner, FsLocal.Config({ cwd: project })) }
        }
        class FixtureRegistry extends WorkspaceRegistry {
          async createProject(_grant: unknown, _title?: string): Promise<Workspace> { throw new Error('Unexercised registration fixture') }
          async createAdmittedProject(): Promise<Workspace> { throw new Error('No component ready borrow grants project registration') }
          async createS2Project() {
            const workspace = await this.initializeDefault(async () => project)
            if (workspace === undefined) throw new Error('Native default project is not eligible')
            return { binding: installed, workspaceId: workspace.id,
              FileSystem: options.nativeFiles ? nativeRoutedFileSystem(project, getFileProject) : FixtureFileSystem,
              projectDirectory: { binding: installed, prepare: async (cwd: string) => {
                assertCurrent(installed)
                if (cwd !== workspace.path || !statSync(cwd).isDirectory()) throw new Error('Outside the Node fixture project')
                await options.verifyDirectory?.(_ctx)
              } } }
          }
        }
        const info = statSync(layout.projectsRoot, { bigint: true })
        return { binding: options.copiedFilesBinding ? { ...installed } : installed,
          port: { createWorkspaceRegistry: () => FixtureRegistry },
          projectFor: nativeProjectDeriver(installed, () => { assertCurrent(installed) }),
          ...options.instructionSources === undefined ? {} : {
            withInstructionReaders: options.instructionSources.bind(() => { assertCurrent(installed) }),
          },
          defaultGrant: { binding: installed, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
            parent: { rootPath: layout.projectsRoot, rootDevice: String(info.dev), rootInode: String(info.ino) },
            assertExclusive: () => { assertCurrent(installed) } },
          assertMountCurrent: (current) => { assertCurrent(current) },
          assertUnpublished: () => { assertCurrent(installed) } }
      } },
    prepare(ctx) {
      Object.assign(ctx.loader.builtins, { 'm8s-dependencies': dependencies, 'm8s-jsonl': Jsonl, 'm8s-model': DefaultModel,
        'm8s-sandbox-policy': SandboxPolicyService,
        'm8s-terminal-probe': { Config: z.object({ value: z.number().default(1).volatile() }), apply() {} },
        'm8s-working-directory': WorkingDirectory, 'm8ax-settings': Settings, 'm8ax-locale': Locale,
        // A separately guarded native LLM lets all Controller dependencies activate before files/account settles.
        'm8s-early-llm': { inject: ['peCloudApi'], apply(owner: Context) {
          new LlmRuntime(owner)
          owner.peCloudApi.installLlmGuard(owner, () => false)
        } },
      })
      if (options.instructionSources !== undefined) {
        const { adapter } = options.instructionSources
        Object.assign(ctx.loader.builtins, { 'm8s-presets': AgentPresets, 'm8s-preset': AgentPreset, 'm8s-tool-fs': ToolFs,
          'm8s-instruction-adapter': { inject: ['llm'], apply(owner: Context) {
            owner.effect(() => owner.llm.registerAdapter(['local-text'], adapter))
          } },
        })
      }
      if (options.controllerEntered !== undefined) {
        const plugin: unknown = ctx.loader.builtins[names.controller]
        if (plugin === null || typeof plugin !== 'object') throw new Error('Actual Controller wrapper is absent')
        const apply: unknown = Reflect.get(plugin, 'apply')
        if (typeof apply !== 'function') throw new Error('Actual Controller apply is absent')
        ctx.loader.builtins[names.controller] = { inject: [...NativeController.inject, 'peCloudApi'], Config: NativeController.Config,
          async apply(owner: Context, config: ConstructorParameters<typeof NativeController>[1]) {
            options.controllerEntered?.(owner)
            await Reflect.apply(apply, plugin, [owner, config])
          } }
      }
    },
  }
  let context: Context | undefined
  let componentNative: NativeAccountBootHandle | undefined, integration: AccountNativeIntegration | undefined
  cleanups.push(async () => {
    try {
      await integration?.stop()
      await componentNative?.dispose()
      await factory.close()
      await context?.fiber.dispose()
      for (const barrier of barriers) {
        const receipt = await barrier.stopConfigSaves(Date.now() + 1000)
        if (receipt.status === 'confirmed') saves.releaseAccount(barrier)
      }
      if (options.modelKey && barriers.some(barrier => barrier.snapshot().failures.length !== 0)) {
        expect(() => { saves.close() }).toThrow(expect.objectContaining({ code: 'cloud/config-busy' }))
      } else saves.close()
      await root.fiber.dispose()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const start = async () => {
    if (options.instructionSources !== undefined) {
      const native = recipe.native
      if (native === undefined) throw new Error('The instruction component requires actual native integration')
      // This component supplies graph-liveness admission to the real integration, without a Root seal or factory ready publication.
      componentNative = mountAccount(input, { ...recipe, async prepare(ctx, installed) {
        context = ctx
        componentGraph = { ctx, binding: installed }
        integration = new AccountNativeIntegration(native)
        try {
          integration.prepare(ctx, installed, assertCurrent, assertCurrent, () => { assertCurrent(installed) })
          await recipe.prepare(ctx, installed)
        } catch (error) { await integration.stop(); throw error }
      } })
      const outcome = await componentNative.result
      if (outcome.status === 'mounted') {
        options.beforeBootstrap?.(outcome.context)
        await integration?.finishBootstrap(options.verifyBootstrap)
      }
      return outcome
    }
    const outcome = await factory.startNativeMount(input, recipe)
    if (outcome.status === 'mounted') context = outcome.context
    return outcome
  }
  return { factory, capacity, root, saves, barriers, input, recipe, start, guards, project, layout, credentialPath, lifetime,
    finishBootstrap: () => {
      if (integration === undefined) throw new Error('The original native component integration is absent')
      return integration.finishBootstrap()
    },
    stopComponent: (hook: Parameters<AccountNativeIntegration['stop']>[0]) => {
      if (integration === undefined) throw new Error('The original native component integration is absent')
      return integration.stop(hook)
    },
    fileProject: (caller: Context, signal?: AbortSignal) => {
      if (resolveFiles === undefined) throw new Error('Original native Files callback absent')
      return resolveFiles(caller, signal)
    } }
}

it('boots the actual factory NativeLoader with API hooks, guarded native providers and root-issued closed execution', async () => {
  const f = await fixture()
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, binding = outcome.binding
  expect(ctx.root).not.toBe(f.root)
  expect(ctx.peCloudApi).toBeInstanceOf(CloudAccountApi)
  expect(ctx.peCloudFiles).toBeInstanceOf(CloudAccountFiles)
  expect(ctx.get('workspaceFiles')).toBeUndefined()
  expect(ctx.peCloudFiles.project().projectDirectory.binding).toBe(binding)
  expect(ctx.workspaceRegistry.get(ctx.peCloudFiles.project().workspace.id)).toBe(ctx.peCloudFiles.project().workspace)
  expect(ctx.sessionController).toBeInstanceOf(NativeController)
  expect(ctx.agentLoop).toBeInstanceOf(NativeLoop)
  expect(ctx.llm).toBeInstanceOf(LlmRuntime)
  expect(ctx.peCloudApi.binding).toBe(binding)
  expect(f.barriers[0]?.binding).toBe(binding)
  expect(binding).not.toBe(f.input.binding)
  expect(ctx.get('peSandboxCoordinator')).toBeUndefined()
  expect(ctx.get('peFilesPool')).toBeUndefined()
  expect([...ctx.loader.entries()].every(row => row.fiber?.state === FiberState.ACTIVE)).toBe(true)
  expect(f.guards).toHaveBeenCalledTimes(1)
  const denied = { code: 'cloud/account-unavailable' }
  await expect(ctx.peCloudApi.assertBootstrapCurrent(ctx)).rejects.toMatchObject(denied)
  // Unpublished authority cannot replace the original native Typert Gateway absent from this fixture.
  await expect(ctx.peCloudApi.auditPrepared(ctx)).rejects.toThrow('Bootstrap requires the original guarded native providers and shared policy.')
  await expect(ctx.sessionController.create({ cwd: f.project })).rejects.toMatchObject(denied)
  await expect(ctx.agents.create({ sessionId: SessionId('must-not-write'), meta: { cwd: f.project } })).rejects.toMatchObject(denied)
  const stream = ctx.llm.stream({ provider: 'unused', model: 'unused', messages: [] })[Symbol.asyncIterator]()
  await expect(stream.next()).rejects.toMatchObject(denied)
  await expect(ctx.subprocess.resolveExecutable('must-not-spawn')).rejects.toMatchObject({ code: 'cloud/execution-unavailable', reason: 'disabled' })
  expect(ctx.sessions.list()).toEqual([])
  await expect(f.factory.borrowCurrent(binding)).rejects.toMatchObject(denied)
  const ref = credentialRef('M8S_NATIVE_CREDENTIAL')
  await ctx.credentials.set(ref, 'native-value')
  expect(readFileSync(f.credentialPath, 'utf8')).toContain('native-value')
  await expect(f.factory.stopNative(binding.accountId)).resolves.toMatchObject({ status: 'observed', native: { status: 'confirmed' } })
  expect(f.saves.snapshot().accounts).toBe(1)
  expect(ctx.get('peCloudApi')).toBeUndefined()
})

it.each(['admission', 'fiber'] as const)('joins native teardown after Root %s closure and native-only binding abort', async (rootClose) => {
  const f = await fixture({ firstScreen: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, binding = outcome.binding, files = ctx.peCloudFiles
  const loop = [...ctx.loader.entries()].find(entry => entry.options.id === 'loop')?.fiber
  expect(loop?.state).toBe(FiberState.ACTIVE)
  expect(files.project().binding).toBe(binding)
  expect(ctx.agents.list()).toEqual([])
  expect(ctx.sessions.list()).toEqual([])

  const runtime = f.root.peAccountRuntime
  if (rootClose === 'fiber') await f.root.fiber.dispose()
  else await runtime.close()
  expect(() => { runtime.assertRecipeSealed('m8s') }).toThrow('closed')
  // This native-only fixture owns its generation controller; production claimAndMount owns it inside the factory.
  f.lifetime.abort()
  const closing = f.factory.close()
  expect(binding.lifetime.aborted).toBe(true)
  expect(() => { f.factory.assertMountCurrent(binding) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => files.project()).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  await expect(closing).resolves.toEqual([{ accountId: binding.accountId, status: 'observed', native: {
    status: 'confirmed', errorEvents: 0, warningEvents: 0, overflow: false,
  } }])
  expect(loop?.state).toBe(FiberState.DISPOSED)
  expect(ctx.get('loader')).toBeUndefined()
  expect(ctx.get('peCloudApi')).toBeUndefined()
  expect(f.barriers[0]?.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
  expect(f.factory.inspect()).toMatchObject({ pending: 0, borrows: 0, waiters: 0, unknown: 0 })
})

it('stops the native Loop before whole graph disposal without changing a readonly base or Loader entries', async () => {
  const f = await fixture({ firstScreen: true, readonlyBase: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context
  const configPath = f.recipe.configPath, patchPath = f.layout.patchPath
  const base = readFileSync(configPath), patch = readFileSync(patchPath)
  const entries = [...ctx.loader.entries()].map(entry => ({ entry, fiber: entry.fiber, disabled: entry.options.disabled }))
  const loop = entries.find(row => row.entry.options.id === 'loop')?.fiber
  const raw: unknown = Reflect.get(ctx.sessionPersistence, symbols.original) ?? ctx.sessionPersistence
  if (!(raw instanceof SessionPersistence)) throw new Error('Original native SessionPersistence is absent')
  const flush = raw.flush.bind(raw)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanups.push(async () => { release.resolve(undefined) })
  const stopped = vi.spyOn(NativeLoop.prototype, 'stop')
  vi.spyOn(raw, 'flush').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    await flush()
  })
  let updates = 0
  ctx.on('loader/config-update', () => { updates++ })
  vi.mocked(fs.rename).mockClear()
  // This Loader composition deliberately has no approved live Agent; native stop tests own live JSONL coverage.
  expect(ctx.agents.list()).toEqual([])
  expect(ctx.sessions.list()).toEqual([])
  const stopping = f.factory.stopNative(outcome.binding.accountId)
  await entered.promise
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(loop?.state).toBe(FiberState.ACTIVE)
  for (const row of entries) {
    expect(row.entry.fiber).toBe(row.fiber)
    expect(row.fiber?.state).toBe(FiberState.ACTIVE)
    expect(row.entry.options.disabled).toBe(row.disabled)
  }
  expect(updates).toBe(0)
  expect(readFileSync(configPath)).toEqual(base)
  expect(readFileSync(patchPath)).toEqual(patch)
  release.resolve(undefined)
  await expect(stopping).resolves.toMatchObject({ status: 'observed', native: {
    status: 'confirmed', errorEvents: 0, warningEvents: 0, overflow: false,
  } })
  expect(loop?.state).toBe(FiberState.DISPOSED)
  expect(updates).toBe(0)
  expect(readFileSync(configPath)).toEqual(base)
  expect(readFileSync(patchPath)).toEqual(patch)
  expect(vi.mocked(fs.rename).mock.calls.filter(([, target]) => target === configPath || target === patchPath)).toEqual([])
  expect(f.barriers[0]?.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
})

it('retains the actual graph and save hooks while an admitted native credential rename is pending', async () => {
  const f = await fixture()
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    await actual.rename(...args)
  })
  const writing = ctx.credentials.set(credentialRef('M8S_PENDING'), 'retained')
  await entered.promise
  const closing = f.factory.stopNative(outcome.binding.accountId)
  let settled = false
  void closing.then(() => { settled = true })
  try {
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(ctx.fiber.state).toBe(FiberState.ACTIVE)
    expect(ctx.get('credentials')).toBeDefined()
    expect(f.barriers[0]?.snapshot().pending).toHaveLength(1)
  } finally { release.resolve(undefined) }
  await writing
  await expect(closing).resolves.toMatchObject({ status: 'observed', native: { status: 'confirmed' } })
  expect(f.barriers[0]?.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
})

it.each(['missingGuards', 'copiedFilesBinding'] as const)('rejects %s during actual native activation without publishing ready', async (key) => {
  const f = await fixture({ [key]: true })
  const outcome = await f.start()
  expect(outcome.status).toBe('failed')
  expect(f.factory.inspect().borrows).toBe(0)
  expect(f.saves.snapshot().accounts).toBe(1)
})

it('keeps native resources and capacity when a save observation expires while its actual rename remains pending', async () => {
  const f = await fixture({ stopTimeoutMs: 10 })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    await actual.rename(...args)
  })
  const writing = outcome.context.credentials.set(credentialRef('M8S_UNKNOWN_SAVE'), 'retained')
  await entered.promise
  try {
    await expect(f.factory.stopNative(outcome.binding.accountId)).resolves.toMatchObject({ status: 'unknown' })
    expect(outcome.context.fiber.state).toBe(FiberState.ACTIVE)
    expect(f.factory.inspect()).toMatchObject({ slots: 1, unknown: 1 })
    expect(() => f.capacity.reserveDrain(outcome.binding.accountId)).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    expect(() => f.capacity.reserveMount(outcome.binding.accountId)).toThrow(expect.objectContaining({ code: 'cloud/account-starting' }))
    expect(f.barriers[0]?.snapshot().pending).toHaveLength(1)
  } finally { release.resolve(undefined); await writing }
})

it.each(['complete', 'fail'] as const)('defers Controller project access while delayed files directory verification can %s', async (mode) => {
  const directoryEntered = Promise.withResolvers<Context>()
  const controllerEntered = Promise.withResolvers<Context>()
  const release = Promise.withResolvers<undefined>()
  const f = await fixture({ earlyLlmAndController: true,
    verifyDirectory: async (ctx) => {
      directoryEntered.resolve(ctx)
      await release.promise
      if (mode === 'fail') throw new Error('Delayed files directory verification failed')
    },
    controllerEntered: (ctx) => { controllerEntered.resolve(ctx) },
  })
  const starting = f.start()
  let settled = false
  void starting.then(() => { settled = true })
  try {
    const ctx = await directoryEntered.promise
    const controllerScope = await controllerEntered.promise
    expect(controllerScope.root).toBe(ctx)
    expect(ctx.get('fs')).toBeInstanceOf(FsLocal)
    const filesEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'files')
    expect(filesEntry?.fiber?.state).toBe(FiberState.LOADING)
    expect(() => ctx.peCloudFiles.project()).toThrow('has not completed')
    expect(ctx.get('sessionController')).toBeInstanceOf(NativeController)
    await expect(ctx.sessionController.create({ cwd: f.project })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(settled).toBe(false)
    release.resolve(undefined)
    const outcome = await starting
    if (mode === 'complete') {
      if (outcome.status === 'failed') throw outcome.cause
      expect(filesEntry?.fiber?.state).toBe(FiberState.ACTIVE)
      expect(outcome.context.sessionController).toBeInstanceOf(NativeController)
      expect(outcome.context.peCloudFiles.project().binding).toBe(outcome.binding)
      await expect(f.factory.borrowCurrent(outcome.binding)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    } else {
      expect(outcome.status).toBe('failed')
      expect(ctx.get('sessionController')).toBeUndefined()
      expect(f.factory.inspect().borrows).toBe(0)
    }
  } finally { release.resolve(undefined); await starting }
})

it('mounts only the fixed optional first-screen constructors while native-only assembly grants no event/business readiness', async () => {
  const f = await fixture({ firstScreen: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context
  const firstScreenEntries = [...ctx.loader.entries()]
    .filter(row => Object.values(firstScreenNames).some(name => row.options.name === 'cordis:' + name))
  expect(firstScreenEntries).toHaveLength(3)
  expect(firstScreenEntries.every(row => row.fiber?.state === FiberState.ACTIVE)).toBe(true)
  expect(ctx.get('workspaceController')).toBeDefined()
  expect(ctx.get('settingsController')).toBeDefined()
  expect(ctx.get('typertGateway')).toBeInstanceOf(Gateway)
  expect(() => ctx.peCloudApi.requireStream('$events')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => ctx.settingsController.describe()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(ctx.sessions.list()).toEqual([])
  await expect(f.factory.stopNative(outcome.binding.accountId)).resolves.toMatchObject({ status: 'observed', native: { status: 'confirmed' } })
})

it('uses the approved Preset private instruction builtin in a native turn and retains its account/Workspace snapshot in JSONL', async () => {
  const sources = instructionSourceFixture()
  const f = await fixture({ instructionSources: sources })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, project = ctx.peCloudFiles.project()
  const stream = sources.adapter.stream.bind(sources.adapter)
  const model = vi.spyOn(sources.adapter, 'stream').mockImplementation(async function* (options) {
    expect(sources.state.heldBytes).toBe(0)
    yield* stream(options)
  })
  expect(sources.state.reservations).toEqual([])
  const created = await ctx.sessionController.create({})
  const agent = ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('The actual approved native Agent is absent')
  const currentDirectory = vi.spyOn(ctx.workingDirectory, 'get')
  expect(ctx.workingDirectory.get(agent.session)).toBe(project.workspace.path)
  expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('instruction-chat')
  expect(ctx.agentPresets.inspectCompositions(agent.ctx)[0]?.modules.map(module => module.moduleName))
    .toEqual(['cordis:' + names.instructions])
  expect(sources.state.reservations).toEqual([])
  await expect(ctx.sessionController.prompt({ sessionId: agent.id, requestId: brandString<SessionRequestId>('native-instructions'), mode: 'queue',
    content: [{ type: 'text', text: 'read the approved instruction snapshot' }] }, outcome.binding.lifetime))
    .resolves.toEqual({ accepted: true })
  await agent.whenIdle()
  expect(sources.adapter.calls).toBe(1)
  expect(currentDirectory).toHaveBeenCalledWith(agent.session)
  expect(sources.state.reservations).toEqual([instructionLimits.maxResidentBytes])
  expect(sources.state.workspaces).toEqual([project.workspace])
  expect(sources.state.workspaces[0]).toBe(project.workspace)
  expect(sources.state.reads).toEqual(['account/AGENTS.md', 'project/AGENTS.md'])
  expect(sources.state.releases).toBe(1)
  expect(sources.state.heldBytes).toBe(0)
  const contexts = agent.session.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')
  expect(contexts).toHaveLength(1)
  const message = contexts[0]
  if (message?.source.kind !== 'pe-account-instructions') throw new Error('The actual native instruction log is absent')
  expect(message.source.snapshot).toMatchObject({ accountId: outcome.binding.accountId,
    epoch: outcome.binding.epoch, workspaceId: project.workspace.id })
  expect(message.source.snapshot.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
    ['account', 'AGENTS.md', sources.text.account], ['project', 'AGENTS.md', sources.text.project],
  ])
  expect(Object.isFrozen(message.source.snapshot)).toBe(true)
  expect(model.mock.calls[0]?.[0].messages.find(value => value.source?.kind === 'pe-account-instructions'))
    .toMatchObject({ id: message.id, source: message.source, content: message.content })
  await ctx.sessionPersistence.flush()
  const files = (await fs.readdir(f.layout.sessionsRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const file = files[0]
  if (file === undefined) throw new Error('The native JSONL log is absent')
  const log = await fs.readFile(join(f.layout.sessionsRoot, file), 'utf8')
  expect(log).toContain(JSON.stringify(message.source.snapshot))
  expect(log).toContain('native policy reply')
  expect(f.factory.inspect().slots).toBe(0)
  await expect(f.factory.borrowCurrent(outcome.binding)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
})

it('isolates native parallel ToolFS writes, instruction snapshots and cold Gateway reads across two registered projects', async () => {
  // Content handshake is stubbed only in this Node routing/API component; this never certifies ABI8 or production content.
  const sources = instructionSourceFixture(), f = await fixture({ instructionSources: sources, nativeFiles: true,
    auditedFileCalls: true, beforeBootstrap: (ctx) => { vi.spyOn(ctx.peCloudFiles, 'assertContentAvailable').mockImplementation(() => {}) } })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, originalFs = ctx.fs, a = ctx.peCloudFiles.project().workspace
  const nativeEntry = [...ctx.loader.entries()].find(row => row.options.id === 'native-file-api')
  const policyEntry = [...ctx.loader.entries()].find(row => row.options.id === 'sandbox-policy')
  expect(nativeEntry?.options.name).toBe('cordis:' + names.workspaceFiles)
  expect(nativeEntry?.fiber?.state).toBe(FiberState.ACTIVE)
  const builtin: unknown = ctx.loader.builtins[names.workspaceFiles]
  if ((builtin === null || typeof builtin !== 'object') && typeof builtin !== 'function') throw new Error('Native file builtin absent')
  expect(Reflect.get(builtin, 'Config') === WorkspaceFiles.Config).toBe(true)
  expect(Reflect.get(builtin, 'inject')).toEqual([...WorkspaceFiles.inject, 'peCloudApi'])
  expect(policyEntry?.moduleNamespace === SandboxPolicyService).toBe(true)
  expect(ctx.sandboxPolicy instanceof SandboxPolicyService).toBe(true)
  expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  expect(ctx.sandboxPolicy.workspaceRoot).toBe(f.project)
  expect(ctx.workspaceFiles instanceof WorkspaceFiles).toBe(true)
  const nativeFiles: unknown = Reflect.get(ctx.workspaceFiles, symbols.original) ?? ctx.workspaceFiles
  if (!(nativeFiles instanceof WorkspaceFiles)) throw new Error('Original native WorkspaceFiles absent')
  expect(nativeFiles.read === WorkspaceFiles.prototype.read).toBe(true)
  expect(nativeFiles.stat === WorkspaceFiles.prototype.stat).toBe(true)
  const secondPath = join(f.layout.projectsRoot, 'second-project')
  mkdirSync(secondPath)
  const b = await ctx.workspaceRegistry.create(secondPath, 'Second project')
  const workspaces = [a, b]
  const turns = new Map<string, number>()
  for (const [i, workspace] of workspaces.entries()) sources.setProject(workspace, `private instruction project ${i}`)
  vi.spyOn(sources.adapter, 'stream').mockImplementation(async function* (options) {
    const instruction = options.messages.find(message => message.source?.kind === 'pe-account-instructions')
    if (instruction?.source?.kind !== 'pe-account-instructions') throw new Error('Native C09 snapshot absent')
    const id = instruction.source.snapshot.workspaceId, turn = (turns.get(id) ?? 0) + 1
    turns.set(id, turn)
    const index = workspaces.findIndex(workspace => workspace.id === id)
    if (index < 0) throw new Error('Unknown original Workspace')
    if (turn <= 2) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`${id}-${turn}`),
        name: turn === 1 ? 'write' : 'read', arguments: JSON.stringify({ file_path: 'result.txt',
          ...turn === 1 ? { content: `private output project ${index}` } : {} }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `done project ${index}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  const created = await Promise.all(workspaces.map(workspace => ctx.sessionController.create({ workspaceId: workspace.id })))
  const agents = created.map(({ sessionId }) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Actual native Agent absent')
    return agent
  })
  const result = f.guards.mock.results[0], firstAgent = agents[0], secondAgent = agents[1]
  if (result?.type !== 'return' || firstAgent === undefined || secondAgent === undefined) throw new Error('Native guards/Agents absent')
  const approved = result.value
  await expect(ctx.agents.withInitiator(firstAgent, () => approved.getFileProject(secondAgent.ctx)))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  const retained = await ctx.agents.withInitiator(firstAgent, () => approved.getFileProject(firstAgent.ctx))
  expect(retained.workspace).toBe(a)
  await a.detachSession(firstAgent.id)
  expect(() => { retained.assertCurrent() }).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await a.attachSession(firstAgent.id)
  for (const agent of agents) agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write and read result.txt' }],
    source: { kind: 'user' } }))
  await Promise.all(agents.map(agent => agent.whenIdle()))
  for (const [i, agent] of agents.entries()) {
    const workspace = workspaces[i]
    if (workspace === undefined) throw new Error('Workspace absent')
    expect(readFileSync(join(workspace.path, 'result.txt'), 'utf8')).toBe(`private output project ${i}`)
    const log = JSON.stringify(agent.session.snapshotEvents())
    expect(log).toContain(`private output project ${i}`)
    expect(log).toContain(`private instruction project ${i}`)
    expect(log).not.toContain(`private output project ${1 - i}`)
    expect(log).not.toContain(`private instruction project ${1 - i}`)
    expect(turns.get(workspace.id)).toBe(3)
  }
  expect((Reflect.get(ctx.fs, symbols.original) ?? ctx.fs) === (Reflect.get(originalFs, symbols.original) ?? originalFs)).toBe(true)
  expect(ctx.peCloudFiles.project().workspace).toBe(a)
  await ctx.sessionPersistence.flush()
  const logNames = (await fs.readdir(f.layout.sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'))
  const persisted = await Promise.all(logNames.map(name => fs.readFile(join(f.layout.sessionsRoot, name), 'utf8')))
  expect(persisted).toHaveLength(2)
  for (const [i, agent] of agents.entries()) {
    const log = persisted.find(value => value.includes(agent.id))
    expect(log).toContain(`private instruction project ${i}`)
    expect(log).toContain(`private output project ${i}`)
    expect(log).not.toContain(`private instruction project ${1 - i}`)
    expect(log).not.toContain(`private output project ${1 - i}`)
  }
  await ctx.agentLoop.stop()
  expect(ctx.agents.list()).toEqual([])
  expect(ctx.sessions.list()).toEqual([])
  const peer = { id: brandString<PeerId>('two-project-component'), ctx, principal: { kind: 'owner' as const },
    interactions: 'answer' as const, signal: outcome.binding.lifetime, dispose: async () => {} }
  const read = (id: SessionId, path = 'result.txt') => ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'read',
    args: { workspaceFileScopeId: id, path, range: {} }, peer, signal: outcome.binding.lifetime })
  const fullQuery = vi.spyOn(ctx.sessionQuery, 'observeSession')
  const selecting = vi.spyOn(approved, 'getFileProject')
  const values = await Promise.all(agents.map(agent => read(agent.id)))
  expect(values).toEqual([expect.objectContaining({ text: 'private output project 0' }),
    expect.objectContaining({ text: 'private output project 1' })])
  expect(fullQuery).not.toHaveBeenCalled()
  for (const agent of agents) {
    await expect(ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'stat',
      args: { workspaceFileScopeId: agent.id, path: 'result.txt' }, peer, signal: outcome.binding.lifetime }))
      .resolves.toMatchObject({ bytes: Buffer.byteLength('private output project 0') })
  }
  const first = agents[0]
  if (first === undefined) throw new Error('First native Agent absent')
  const feed = (await ctx.typertGateway.stream({ namespace: 'workspaceFiles', method: 'changes',
    args: { workspaceFileScopeId: first.id, path: 'result.txt' }, peer, signal: outcome.binding.lifetime }))[Symbol.asyncIterator]()
  try { expect(await feed.next()).toMatchObject({ done: false, value: { kind: 'ready' } }) }
  finally { await feed.return?.() }
  await expect(read(first.id, join(b.path, 'result.txt'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await a.detachSession(first.id)
  await expect(read(first.id)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const caller = selecting.mock.calls[0]?.[0]
  if (caller === undefined) throw new Error('Original Gateway file caller absent')
  const providers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    .filter(fiber => fiber.ctx.root === ctx.root && fiber.store?.fs?.fiber === fiber)
  expect(providers).toHaveLength(1)
  const provider = providers[0]
  if (provider === undefined) throw new Error('Original native FS provider absent')
  await provider.dispose()
  selecting.mockClear()
  await expect(f.fileProject(caller)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(selecting).not.toHaveBeenCalled()
})

it('rejects unselected native Gateway file calls before shared project selection or content reads', async () => {
  const sources = instructionSourceFixture(), f = await fixture({ instructionSources: sources, nativeFiles: true, installFileApi: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, result = f.guards.mock.results[0]
  if (result?.type !== 'return') throw new Error('Original policy absent')
  const selecting = vi.spyOn(result.value, 'getFileProject')
  const created = await ctx.sessionController.create({})
  writeFileSync(join(f.project, 'private.txt'), 'must not be read')
  await ctx.sessionPersistence.flush()
  await ctx.agentLoop.stop()
  expect(ctx.workspaceFiles instanceof WorkspaceFiles).toBe(true)
  const content = vi.spyOn(ctx.fs, 'streamText')
  await expect(ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'read',
    args: { workspaceFileScopeId: created.sessionId, path: 'private.txt', range: {} },
    peer: { id: brandString<PeerId>('unselected-native-file'), ctx, principal: { kind: 'owner' }, interactions: 'answer',
      signal: outcome.binding.lifetime, dispose: async () => {} } })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(selecting).not.toHaveBeenCalled()
  expect(content).not.toHaveBeenCalled()
})

it('requires the real native SandboxPolicy provider when the private file builtin is explicitly installed', async () => {
  const sources = instructionSourceFixture(), f = await fixture({ instructionSources: sources, installFileApi: true })
  const outcome = await f.start()
  expect(outcome.status).toBe('failed')
  expect(sources.adapter.calls).toBe(0)
})

it('rejects a foreign native Session and a real no-cwd history even though the native policy fallback names an owned project', async () => {
  const f = await fixture({ instructionSources: instructionSourceFixture(), nativeFiles: true, auditedFileCalls: true,
    beforeBootstrap: (ctx) => { vi.spyOn(ctx.peCloudFiles, 'assertContentAvailable').mockImplementation(() => {}) } })
  const other = await fixture({ instructionSources: instructionSourceFixture() })
  const outcome = await f.start(), foreign = await other.start()
  if (outcome.status === 'failed') throw outcome.cause
  if (foreign.status === 'failed') throw foreign.cause
  const ctx = outcome.context, created = await foreign.context.sessionController.create({})
  const own = await ctx.sessionController.create({})
  writeFileSync(join(f.project, 'private.txt'), 'owned data remains private')
  await ctx.sessionPersistence.flush()
  await ctx.agentLoop.stop()
  const detached = ctx.sessions.prepare(SessionId('native-file-fallback-without-cwd'), { meta: { agentPreset: 'instruction-chat' } })
  const writer = await ctx.sessionPersistence.create(detached.header)
  await writer.flush()
  await writer.close()
  expect(detached.header.cwd).toBeUndefined()
  expect(ctx.sandboxPolicy.resolve()).toEqual({ mode: 'workspace-write', workspaceRoot: f.project })
  const content = vi.spyOn(ctx.fs, 'streamText')
  const read = (id: SessionId) => ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'read',
    args: { workspaceFileScopeId: id, path: 'private.txt', range: {} },
    peer: { id: brandString<PeerId>('native-file-foreign-scope'), ctx, principal: { kind: 'owner' }, interactions: 'answer',
      signal: outcome.binding.lifetime, dispose: async () => {} } })
  expect(created.sessionId).not.toBe(own.sessionId)
  const metadata = vi.spyOn(ctx.sessionPersistence, 'stat')
  await expect(read(created.sessionId)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(read(detached.header.id)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(metadata).not.toHaveBeenCalled()
  expect(content).not.toHaveBeenCalled()
  await expect(read(own.sessionId)).resolves.toMatchObject({ text: 'owned data remains private' })
})

it('rejects a copied files binding before an instruction Preset can admit any model or source work', async () => {
  const sources = instructionSourceFixture()
  const f = await fixture({ instructionSources: sources, copiedFilesBinding: true })
  const outcome = await f.start()
  expect(outcome).toMatchObject({ status: 'failed', cause: { cause: { code: 'cloud/stale-generation' } } })
  expect(sources.adapter.calls).toBe(0)
  expect(sources.state.reservations).toEqual([])
  expect(sources.state.reads).toEqual([])
})

it.each(['before-build', 'during-read'] as const)('rejects a real native cwd change %s without publishing mixed instructions or entering the model', async (phase) => {
  const entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const gate = async (): Promise<void> => { entered.resolve(undefined); await proceed.promise }
  const sources = instructionSourceFixture(phase === 'before-build' ? { beforeBuild: gate } : { beforeRead: gate })
  const f = await fixture({ instructionSources: sources })
  cleanups.push(async () => { proceed.resolve(undefined) })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, created = await ctx.sessionController.create({})
  const agent = ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('Actual approved native Agent absent')
  const child = join(f.project, 'nested-current-directory')
  mkdirSync(child)
  expect(ctx.workingDirectory instanceof WorkingDirectory).toBe(true)
  expect(ctx.workingDirectory.get(agent.session)).toBe(f.project)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'capture the original instruction cwd' }], source: { kind: 'user' } }))
    await entered.promise
    expect(sources.state.heldBytes).toBe(instructionLimits.maxResidentBytes)
    await expect(ctx.workingDirectory.set(agent, child, outcome.binding.lifetime)).resolves.toBe(child)
    expect(ctx.workingDirectory.get(agent.session)).toBe(child)
    expect(agent.session.header.cwd).toBe(f.project)
  } finally { proceed.resolve(undefined) }
  await agent.whenIdle()
  expect(sources.adapter.calls).toBe(0)
  expect(sources.state.reservations).toEqual([instructionLimits.maxResidentBytes])
  expect(sources.state.heldBytes).toBe(0)
  expect(sources.state.releases).toBe(1)
  expect(agent.session.deriveMessages().some(message => message.source.kind === 'pe-account-instructions')).toBe(false)
  if (phase === 'before-build') expect(sources.state.reads).toEqual([])
  else expect(sources.state.reads.length).toBeGreaterThan(0)
})

it('returns the instruction reservation when its original graph is withdrawn during native preparation', async () => {
  const entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const sources = instructionSourceFixture({ beforeBuild: async () => { entered.resolve(undefined); await proceed.promise } })
  const f = await fixture({ instructionSources: sources })
  cleanups.push(async () => { proceed.resolve(undefined) })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context
  const created = await ctx.sessionController.create({})
  const agent = ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('The actual approved native Agent is absent')
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'withdraw this graph' }], source: { kind: 'user' } }))
    await entered.promise
    expect(sources.state.heldBytes).toBe(instructionLimits.maxResidentBytes)
    f.lifetime.abort(new Error('The component owner withdrew this generation'))
  } finally { proceed.resolve(undefined) }
  await agent.whenIdle()
  expect(outcome.binding.lifetime.aborted).toBe(true)
  expect(sources.adapter.calls).toBe(0)
  expect(sources.state.reads).toEqual([])
  expect(sources.state.releases).toBe(1)
  expect(sources.state.heldBytes).toBe(0)
  expect(agent.session.deriveMessages().some(message => message.source.kind === 'pe-account-instructions')).toBe(false)
  await expect(ctx.sessionController.prompt({ sessionId: agent.id, requestId: brandString<SessionRequestId>('old-graph'), mode: 'queue',
    content: [{ type: 'text', text: 'an old graph must not accept another prompt' }] }, outcome.binding.lifetime))
    .rejects.toMatchObject({ code: 'cloud/stale-generation' })
})

it('rejects an unavailable instruction source without logging partial sources or calling the native model', async () => {
  const sources = instructionSourceFixture({ failure: new FsError('The original fixture source is unavailable.', 'FS_IO_ERROR') })
  const f = await fixture({ instructionSources: sources })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context
  const created = await ctx.sessionController.create({})
  const agent = ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('The actual approved native Agent is absent')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fail the complete snapshot' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(sources.adapter.calls).toBe(0)
  expect(sources.state.reservations).toEqual([instructionLimits.maxResidentBytes])
  expect(sources.state.reads).toEqual(['account/AGENTS.md'])
  expect(sources.state.releases).toBe(1)
  expect(sources.state.heldBytes).toBe(0)
  expect(agent.session.deriveMessages().some(message => message.source.kind === 'pe-account-instructions')).toBe(false)
})


it.each([false, true])('retains an unknown approved native key write through original factory containment (drain full: %s)', async (full) => {
  const f = await fixture({ firstScreen: true, modelKey: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, barrier = f.barriers[0]
  if (barrier === undefined) throw new Error('Original save barrier absent')
  const ref = APPROVED_MODEL_KEY.ref
  const version = await barrier.describeCredentialEdit(ref, () => ctx.credentials.describe(ref))
  const otherId = brandString<AccountId>('other-component-account')
  const otherMount = full ? f.capacity.reserveMount(otherId) : undefined
  otherMount?.settleMount()
  const occupied = full ? f.capacity.reserveDrain(otherId) : undefined
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args)
    throw new Error('Synthetic response loss after actual native persistence')
  })
  await expect(barrier.commitCredentialEdit(ref, version.version, () => ctx.credentials.set(ref, 'r05-native-unknown-canary')))
    .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(readFileSync(f.credentialPath, 'utf8')).toContain('r05-native-unknown-canary')
  expect(ctx.fiber.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('credentials')).toBeDefined()
  expect(() => { f.factory.assertMountCurrent(outcome.binding) }).toThrow()
  expect(barrier.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [{ outcome: 'unknown' }] })
  expect(f.saves.snapshot()).toMatchObject({ accounts: 1, tracked: 1 })
  if (occupied !== undefined) occupied.release()
  otherMount?.releaseAccount()
  await expect(f.factory.stopNative(outcome.binding.accountId)).resolves.toMatchObject({ status: 'unknown' })
  expect(f.factory.inspect()).toMatchObject({ slots: 1, unknown: 1 })
  expect(() => { f.saves.releaseAccount(barrier) }).toThrow()
  await expect(barrier.describeCredentialEdit(ref, () => ctx.credentials.describe(ref))).rejects.toBeDefined()
  expect(ctx.fiber.state).toBe(FiberState.ACTIVE)
})


it('commits on the stopped original graph after native flush and before save-hook withdrawal or disposal', async () => {
  const f = await fixture({ instructionSources: instructionSourceFixture(), terminalProbe: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, barrier = f.barriers[0]
  if (barrier === undefined) throw new Error('Original save barrier absent')
  const raw: unknown = Reflect.get(ctx.sessionPersistence, symbols.original) ?? ctx.sessionPersistence
  if (!(raw instanceof SessionPersistence)) throw new Error('Original native persistence absent')
  const flush = vi.spyOn(raw, 'flush'), hold = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  cleanups.push(async () => { hold.resolve(undefined) })
  let disposed = false, terminalEntered = false
  ctx.effect(() => () => { disposed = true })
  let late: Parameters<NonNullable<Parameters<AccountNativeIntegration['stop']>[0]>>[0] | undefined
  const stopped = f.stopComponent(async (commit) => {
    late = commit
    expect(flush).toHaveBeenCalled(); expect(disposed).toBe(false); ctx.fiber.assertActive()
    expect(barrier.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
    await commit(async (api) => {
      api.assertInstalled(); expect(flush).toHaveBeenCalledTimes(2)
      const entry = [...ctx.loader.entries()].find(row => row.options.id === 'terminal-probe')
      if (entry === undefined) throw new Error('Original native probe entry absent')
      await ctx.configEditor.edit(entry, () => ({ value: 2 }))
      expect(readFileSync(f.layout.patchPath, 'utf8')).toContain('value: 2')
      terminalEntered = true; entered.resolve(undefined); await hold.promise
    })
  })
  await Promise.race([entered.promise, stopped.then(() => {
    if (!terminalEntered) throw new Error('Original shutdown withdrew hooks before its terminal commit')
  })])
  expect(disposed).toBe(false)
  expect(barrier.snapshot()).toMatchObject({ admission: 'stopped', pending: [{ kind: 'config-editor' }] })
  expect(() => barrier.admit('settings', async () => {})).toThrow()
  hold.resolve(undefined)
  await expect(stopped).resolves.toMatchObject({ status: 'confirmed', admission: 'stopped' })
  expect(disposed).toBe(false); ctx.fiber.assertActive()
  expect(() => { ctx.peCloudApi.assertInstalled() }).toThrow()
  const settledCommit = late
  if (settledCommit === undefined) throw new Error('Original terminal capability absent')
  await expect(settledCommit(async () => {})).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(flush).toHaveBeenCalledTimes(3)
  expect(barrier.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
})


it('retains replacement verification inside the real unpublished native bootstrap and propagates its failure', async () => {
  const entered = Promise.withResolvers<CloudAccountApi>(), hold = Promise.withResolvers<undefined>()
  const failure = new Error('Replacement intent verification refused')
  cleanups.push(async () => { hold.resolve(undefined) })
  const f = await fixture({ instructionSources: instructionSourceFixture(), verifyBootstrap: async (api) => {
    api.assertInstalled()
    entered.resolve(api)
    await hold.promise
    throw failure
  } })
  const started = f.start()
  const rejected = expect(started).rejects.toBe(failure)
  const api = await entered.promise
  expect(f.factory.inspect().slots).toBe(0)
  await expect(f.factory.borrowCurrent(api.binding)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  hold.resolve(undefined)
  await rejected
  await expect(f.finishBootstrap()).rejects.toBe(failure)
  expect(f.factory.inspect().slots).toBe(0)
})

it('retains the original account Session file authority for the native Office Remote', async () => {
  const sources = instructionSourceFixture(), f = await fixture({ instructionSources: sources, nativeFiles: true,
    auditedFileCalls: true, office: true,
    beforeBootstrap: (ctx) => { vi.spyOn(ctx.peCloudFiles, 'assertContentAvailable').mockImplementation(() => {}) } })
  const other = await fixture({ instructionSources: instructionSourceFixture() })
  const outcome = await f.start(), foreign = await other.start()
  if (outcome.status === 'failed') throw outcome.cause
  if (foreign.status === 'failed') throw foreign.cause
  const foreignSession = await foreign.context.sessionController.create({})
  const ctx = outcome.context, created = await ctx.sessionController.create({})
  const secondPath = join(dirname(f.project), 'office-other-project')
  mkdirSync(secondPath)
  const second = await ctx.workspaceRegistry.create(secondPath, 'Other project')
  const otherSession = await ctx.sessionController.create({ workspaceId: second.id })
  writeFileSync(join(secondPath, 'other.docx'), 'other project private document')
  symlinkSync(join(secondPath, 'other.docx'), join(f.project, 'escape.docx'))
  writeFileSync(join(f.project, 'report.docx'), 'owned office document')
  await ctx.sessionPersistence.flush()
  await ctx.agentLoop.stop()
  const converter = vi.spyOn(ctx.officeToPdf, 'convert').mockImplementation(async (request) => {
    const data = await request.source.read(new AbortController().signal, 4096)
    expect(Buffer.from(data.bytes).toString()).toBe('owned office document')
    return { pdf: new Uint8Array([37, 80, 68, 70]), missingFonts: [],
      cacheKey: brandString<OfficeToPdfKey>('fixture-key'), generation: ctx.officeToPdf.generation }
  })
  const peer = { id: brandString<PeerId>('office-session-scope'), ctx, principal: { kind: 'owner' as const },
    interactions: 'answer' as const, signal: outcome.binding.lifetime, dispose: async () => {} }
  const render = (sessionId: SessionId, path: string) => ctx.typertGateway.invoke({ namespace: 'officeToPdf', method: 'render',
    args: { workspaceFileScopeId: sessionId, path, priority: 'foreground' }, peer, signal: outcome.binding.lifetime })
  await expect(render(created.sessionId, 'report.docx')).resolves.toMatchObject({ data: new Uint8Array([37, 80, 68, 70]) })
  expect(converter).toHaveBeenCalledTimes(1)
  await expect(render(created.sessionId, '/etc/passwd.docx')).rejects.toBeInstanceOf(Error)
  await expect(render(created.sessionId, join(secondPath, 'other.docx'))).rejects.toBeInstanceOf(Error)
  await expect(render(created.sessionId, 'escape.docx')).rejects.toBeInstanceOf(Error)
  await expect(render(otherSession.sessionId, join(f.project, 'report.docx'))).rejects.toBeInstanceOf(Error)
  const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
  const orphan = ctx.sessions.prepare(SessionId('office-orphan-session'), { meta: { agentPreset: 'instruction-chat' } })
  const writer = await ctx.sessionPersistence.create(orphan.header)
  await writer.flush(); await writer.close()
  const observed = []
  for (const id of [foreignSession.sessionId, SessionId('office-missing-session'), orphan.header.id]) {
    try { await render(id, 'report.docx'); throw new Error('Unauthorized scope was admitted') }
    catch (cause) { observed.push(cause) }
  }
  expect(observed).toHaveLength(3)
  for (const error of observed) expect(error).toMatchObject({ code: 'cloud/forbidden' })
  expect(stat).not.toHaveBeenCalled()

  await expect(ctx.typertGateway.invoke({ namespace: 'officeToPdf', method: 'render',
    args: { workspaceFileScopeId: created.sessionId, path: 'report.docx', priority: 'foreground' }, peer,
    signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error)
  expect(converter).toHaveBeenCalledTimes(1)
  converter.mockImplementationOnce(async (request) => {
    writeFileSync(join(f.project, 'report.docx'), 'changed after original authorization')
    await request.source.read(new AbortController().signal, 4096)
    throw new Error('changed source unexpectedly admitted')
  })
  await expect(render(created.sessionId, 'report.docx')).rejects.toMatchObject({ code: 'document-render/failed' })
  expect(converter).toHaveBeenCalledTimes(2)
  converter.mockRestore()
  await expect(render(created.sessionId, 'report.docx')).rejects.toMatchObject({ code: 'document-render/failed',
    details: { reason: 'input-too-large' } })
  const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    .filter(fiber => fiber.ctx.root === ctx.root && fiber.store?.officeToPdf?.fiber === fiber)
  expect(fibers).toHaveLength(1)
  const provider = fibers[0]
  if (provider === undefined) throw new Error('Original Office provider absent')
  await provider.dispose()
  expect(() => ctx.peCloudApi.requireRpc('officeToPdf/render')).toThrow()
})

it('rejects unselected Office calls before reading the original project', async () => {
  const f = await fixture({ instructionSources: instructionSourceFixture(), nativeFiles: true,
    auditedFileCalls: true, office: true, officeUnselected: true,
    beforeBootstrap: (ctx) => { vi.spyOn(ctx.peCloudFiles, 'assertContentAvailable').mockImplementation(() => {}) } })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, created = await ctx.sessionController.create({})
  writeFileSync(join(f.project, 'report.docx'), 'unselected document')
  await ctx.sessionPersistence.flush()
  await ctx.agentLoop.stop()
  const read = vi.spyOn(ctx.fs, 'readByteRange'), convert = vi.spyOn(ctx.officeToPdf, 'convert')
  await expect(ctx.typertGateway.invoke({ namespace: 'officeToPdf', method: 'render',
    args: { workspaceFileScopeId: created.sessionId, path: 'report.docx', priority: 'foreground' },
    peer: { id: brandString<PeerId>('office-unselected'), ctx, principal: { kind: 'owner' }, interactions: 'answer',
      signal: outcome.binding.lifetime, dispose: async () => {} } })).rejects.toBeInstanceOf(Error)
  expect(read).not.toHaveBeenCalled()
  expect(convert).not.toHaveBeenCalled()
  const resolver = ctx.typert.lookups.get('workspaceFileScope')
  if (resolver === undefined) throw new Error('Original file lookup absent')
  const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    .filter(fiber => fiber.ctx.root === ctx.root && fiber.store?.workspaceFiles?.fiber === fiber)
  expect(fibers).toHaveLength(1)
  const owner = fibers[0]
  if (owner === undefined) throw new Error('Original WorkspaceFiles fiber absent')
  await owner.dispose()
  const metadata = vi.spyOn(ctx.sessionPersistence, 'stat')
  await expect(resolver.resolve(created.sessionId)).rejects.toBeInstanceOf(Error)
  expect(metadata).not.toHaveBeenCalled()
})

it('retains the factory account slot if the original Office owner cannot confirm shutdown', async () => {
  const f = await fixture({ nativeFiles: true, installFileApi: true, office: true })
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, original: unknown = Reflect.get(ctx.officeToPdf, symbols.original) ?? ctx.officeToPdf
  if (original === null || typeof original !== 'object' || !('closeAndConfirm' in original)) throw new Error('Office owner absent')
  const office = ctx.officeToPdf, failure = new Error('Unconfirmed original scratch')
  const stop = vi.spyOn(office, 'closeAndConfirm').mockRejectedValueOnce(failure)
  await expect(f.factory.stopNative(outcome.binding.accountId)).resolves.toMatchObject({ status: 'unknown', cause: failure })
  expect(stop).toHaveBeenCalledOnce()
  expect(f.factory.inspect()).toMatchObject({ slots: 1, unknown: 1 })
  expect(ctx.fiber.state).toBe(FiberState.ACTIVE)
})
