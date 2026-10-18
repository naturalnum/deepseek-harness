/** Actual factory/Profile/Include/native providers; owned Node paths and closed business are fixtures, never quota evidence. */
import type {} from '@deepseek-ai/dsh-subprocess'
import * as fs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@deepseek-ai/cordis'
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
import NativeController from '@deepseek-ai/dsh-api-session-controller'
import NativeLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
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
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PeAccountRuntime } from '../src/root.ts'
import { AccountFactory } from '../src/account-factory.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { deriveAccountLayout, defaultProjectLayout } from '../src/account-layout.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import { ACCOUNT_NATIVE_ENTRIES as names, ACCOUNT_FIRST_SCREEN_ENTRIES as firstScreenNames, type AccountNativeGuards } from '../src/account-native-integration.ts'
import type { AccountRecipe } from '../src/account-mount.ts'
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
  verifyDirectory?: (ctx: Context) => Promise<void>
  controllerEntered?: (ctx: Context) => void
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
    { id: 'exposure', name: 'cordis:exposure', config: { recipeVersion: 'm8s', rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] } },
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
  mkdirSync(layout.credentialsRoot, { recursive: true })
  const credentialPath = join(layout.credentialsRoot, 'credentials.yaml')
  writeFileSync(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId, epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'm8s', lifetime: lifetime.signal })
  const input: AccountMountInput = { binding, instanceId: identity.instanceId, layout,
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot, DSH_HOME: layout.privateRoot } }]) }
  const guards = vi.fn((_ctx: Context, _installed: AccountBinding): AccountNativeGuards => {
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
    if (options.firstScreen) await ctx.plugin(Gateway)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools, {})
    await ctx.plugin(Agents)
    // Native-only tests own these Node directories. This local provider never supplies product quota approval.
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root: layout.storageRoot })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    new ExactQuery(ctx)
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] } })
  } }
  const rows = [
    { id: 'account', name: 'cordis:' + names.runtime }, { id: 'api', name: 'cordis:' + names.api },
    { id: 'files', name: 'cordis:' + names.files },
    { id: 'editor', name: 'cordis:' + names.editor },
    { id: 'credentials', name: 'cordis:' + names.credentials, config: { path: credentialPath, watch: false } },
    { id: 'dependencies', name: 'cordis:m8s-dependencies' },
    { id: 'llm', name: 'cordis:' + (options.earlyLlmAndController ? 'm8s-early-llm' : names.llm) },
    { id: 'jsonl', name: 'cordis:m8s-jsonl', config: { root: layout.sessionsRoot, compression: 'none' } },
    { id: 'default-model', name: 'cordis:m8s-model', config: { provider: 'unused', model: 'unused' } },
    { id: 'working-directory', name: 'cordis:m8s-working-directory' },
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
      assertRootCurrent: () => { root.peAccountRuntime.assertRecipeSealed('m8s') },
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
                factory.assertMountCurrent(installed)
                if (cwd !== workspace.path || !statSync(cwd).isDirectory()) throw new Error('Outside the Node fixture project')
                await options.verifyDirectory?.(_ctx)
              } } }
          }
        }
        const info = statSync(layout.projectsRoot, { bigint: true })
        return { binding: options.copiedFilesBinding ? { ...installed } : installed,
          port: { createWorkspaceRegistry: () => FixtureRegistry },
          defaultGrant: { binding: installed, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
            parent: { rootPath: layout.projectsRoot, rootDevice: String(info.dev), rootInode: String(info.ino) },
            assertExclusive: () => { factory.assertMountCurrent(installed) } },
          assertMountCurrent: (current) => { factory.assertMountCurrent(current) },
          assertUnpublished: () => { factory.assertMountCurrent(installed) } }
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
  cleanups.push(async () => {
    try {
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
