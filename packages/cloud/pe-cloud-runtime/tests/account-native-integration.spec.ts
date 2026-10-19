/** Actual Profile/Include/native providers with factory or component admission; owned Node paths never prove quota or ready. */
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-pe-account-instructions/types'
import * as fs from 'node:fs/promises'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState, symbols } from '@deepseek-ai/cordis'
import { boot, initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { CloudAccountApi, ConfigSaveCoordinator, ExposureService, type ConfigSaveBarrier } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles, type AccountFilesPreparation } from '@deepseek-ai/dsh-pe-cloud-files'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as ExecutionRoot from '@deepseek-ai/dsh-pe-opensandbox/root'
import NativeController, { type SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import NativeLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  missingGuards?: boolean
  firstScreen?: boolean
  copiedFilesBinding?: boolean
  stopTimeoutMs?: number
  earlyLlmAndController?: boolean
  readonlyBase?: boolean
  verifyDirectory?: (ctx: Context) => Promise<void>
  controllerEntered?: (ctx: Context) => void
  instructionSources?: InstructionSourceFixture
} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'm8s-native-integration-')))
  directories.push(directory)
  const sharedPath = join(directory, 'root.cordis.yml')
  const saves = new ConfigSaveCoordinator({ maxAccounts: 2, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 1,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 2, maxNestedPerOperation: 1, maxWaitersPerAccount: 2 })
  const barriers: ConfigSaveBarrier[] = []
  const issue = saves.createAccount.bind(saves)
  vi.spyOn(saves, 'createAccount').mockImplementation((binding) => { const barrier = issue(binding); barriers.push(barrier); return barrier })
  writeFileSync(sharedPath, JSON.stringify([
    { id: 'runtime', name: 'cordis:runtime', config: { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 } },
    { id: 'exposure', name: 'cordis:exposure', config: { recipeVersion: 'm8s',
      rpcEndpoints: options.instructionSources === undefined ? [] : ['create', 'prompt', 'cancel', 'page'].map(method => ({
        endpoint: 'session/' + method, handlerId: 'native:sessionController', guard: method === 'create' ? 'account-project' : 'account-session',
      })), streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] } },
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
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot, DSH_HOME: layout.privateRoot } }]) }
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
  ] }
  const policy = AccountPolicyConfigSchema({ maxModelRoutes: 2, maxPolicyStringBytes: 128,
    models: [{ provider: 'local-text', model: 'plain-text' }], presetId: declaration.id, presetEntryId: 'instruction-preset',
    presetConfigSha256: accountPresetConfigDigest(declaration, 8192), maxPresetConfigBytes: 8192, agentLoopEntryId: 'loop' })
  const guards = vi.fn((_ctx: Context, _installed: AccountBinding, files: CloudAccountFiles): AccountNativeGuards => {
    if (options.instructionSources !== undefined) return createAccountPolicy(_ctx, _installed, files, policy, root.peExposure.policy, 128)
    const unavailable = (): never => { throw new Error('No fixture project/model/Preset approval') }
    return {
      sessions: { assertHandlerEnabled: unavailable,
        resolveCreate: async () => unavailable(), assertSessionProject: async () => unavailable(), assertActiveScope: unavailable },
      agents: { assertCreate: async () => unavailable(), assertResume: async () => unavailable(), assertPrepared: unavailable },
      allowedModel: () => false,
      assertBootstrapCurrent: async () => unavailable(),
    }
  })
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
    { id: 'llm', name: 'cordis:' + (options.earlyLlmAndController ? 'm8s-early-llm' : names.llm) },
    { id: 'jsonl', name: 'cordis:m8s-jsonl', config: { root: layout.sessionsRoot, compression: 'none' } },
    { id: 'default-model', name: 'cordis:m8s-model', config: options.instructionSources === undefined
      ? { provider: 'unused', model: 'unused' } : { provider: 'local-text', model: 'plain-text' } },
    { id: 'working-directory', name: 'cordis:m8s-working-directory' },
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
      ...options.firstScreen ? { firstScreen: { home: layout.privateRoot, maxHomeBytes: 4096,
        maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 131072 } } : {},
      assertRootCurrent: () => {
        if (options.instructionSources === undefined) { root.peAccountRuntime.assertRecipeSealed('m8s'); return }
        root.fiber.assertActive()
        if (componentGraph === undefined) throw new Error('The instruction component graph is absent')
        assertCurrent(componentGraph.binding)
      },
      ...options.missingGuards ? {} : { guards },
      files(_ctx, installed): AccountFilesPreparation {
        // This external Node-port fixture supplies no Linux FD, quota, exclusive namespace or production storage certificate.
        class FixtureFileSystem extends FsLocal {
          static inject = ['peAccount']
          constructor(owner: Context) { super(owner, FsLocal.Config({ cwd: project })) }
        }
        class FixtureRegistry extends WorkspaceRegistry {
          async createProject(_grant: unknown, _title?: string): Promise<Workspace> { throw new Error('Unexercised registration fixture') }
          async createS2Project() {
            const workspace = await this.initializeDefault(async () => project)
            if (workspace === undefined) throw new Error('Native default project is not eligible')
            return { binding: installed, workspaceId: workspace.id, FileSystem: FixtureFileSystem,
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
        'm8s-working-directory': WorkingDirectory, 'm8ax-settings': Settings, 'm8ax-locale': Locale,
        // A separately guarded native LLM lets all Controller dependencies activate before files/account settles.
        'm8s-early-llm': { inject: ['peCloudApi'], apply(owner: Context) {
          new LlmRuntime(owner)
          owner.peCloudApi.installLlmGuard(owner, () => false)
        } },
      })
      if (options.instructionSources !== undefined) {
        const { adapter } = options.instructionSources
        Object.assign(ctx.loader.builtins, { 'm8s-presets': AgentPresets, 'm8s-preset': AgentPreset,
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
      saves.close()
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
      if (outcome.status === 'mounted') await integration?.finishBootstrap()
      return outcome
    }
    const outcome = await factory.startNativeMount(input, recipe)
    if (outcome.status === 'mounted') context = outcome.context
    return outcome
  }
  return { factory, capacity, root, saves, barriers, input, recipe, start, guards, project, layout, credentialPath, lifetime }
}

it('boots the actual factory NativeLoader with API hooks, guarded native providers and root-issued closed execution', async () => {
  const f = await fixture()
  const outcome = await f.start()
  if (outcome.status === 'failed') throw outcome.cause
  const ctx = outcome.context, binding = outcome.binding
  expect(ctx.root).not.toBe(f.root)
  expect(ctx.peCloudApi).toBeInstanceOf(CloudAccountApi)
  expect(ctx.peCloudFiles).toBeInstanceOf(CloudAccountFiles)
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
  expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('instruction-chat')
  expect(ctx.agentPresets.inspectCompositions(agent.ctx)[0]?.modules.map(module => module.moduleName))
    .toEqual(['cordis:' + names.instructions])
  expect(sources.state.reservations).toEqual([])
  await expect(ctx.sessionController.prompt({ sessionId: agent.id, requestId: brandString<SessionRequestId>('native-instructions'), mode: 'queue',
    content: [{ type: 'text', text: 'read the approved instruction snapshot' }] }, outcome.binding.lifetime))
    .resolves.toEqual({ accepted: true })
  await agent.whenIdle()
  expect(sources.adapter.calls).toBe(1)
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

it('rejects a copied files binding before an instruction Preset can admit any model or source work', async () => {
  const sources = instructionSourceFixture()
  const f = await fixture({ instructionSources: sources, copiedFilesBinding: true })
  const outcome = await f.start()
  expect(outcome).toMatchObject({ status: 'failed', cause: { cause: { code: 'cloud/stale-generation' } } })
  expect(sources.adapter.calls).toBe(0)
  expect(sources.state.reservations).toEqual([])
  expect(sources.state.reads).toEqual([])
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
