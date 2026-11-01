/** Real Loader/native Workspace feeds; Node fixture directories provide no Cloud storage authority. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import Sessions from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry, { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Settings from '@deepseek-ai/dsh-settings'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import Typert from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import type { WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CloudAccountApi } from '../src/account-service.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'
import type { NativeFirstScreen } from '../src/native-first-screen.ts'

async function fixture(maxCollectionItems = 8) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-native-workspaces-')))
  const profileDir = join(home, 'profile')
  mkdirSync(profileDir)
  initProfile(profileDir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"cloud-workspaces-fixture","private":true}\n')
  const paths = [join(home, 'default-workspace'), join(home, 'second-workspace'), join(home, 'unapproved')]
  for (const path of paths) mkdirSync(path)
  const configPath = join(profileDir, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { id: 'dependencies', name: 'cordis:workspace-dependencies' },
    { id: 'jsonl', name: 'cordis:workspace-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'registry', name: 'cordis:workspace-registry' },
    { id: 'initialize', name: 'cordis:workspace-initialize' },
    { id: 'editor', name: 'cordis:workspace-editor' },
    { id: 'settings', name: 'cordis:workspace-settings' },
    { id: 'locale', name: 'cordis:workspace-locale', config: { preference: 'en' } },
    { id: 'workspace-controller', name: 'cordis:workspace-controller' },
    { id: 'settings-controller', name: 'cordis:workspace-settings-controller' },
  ]))
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>('workspaces'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'workspaces-component', lifetime: lifetime.signal })
  const exposure = new ExposurePolicy({ recipeVersion: binding.recipeVersion, allowedSettings: [], exactFetchRoutes: [],
    rpcEndpoints: [
      { endpoint: 'workspace/initializeDefault', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'workspace/create', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'workspace/rename', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'settings/describe', handlerId: 'native:settingsController', guard: 'authenticated-account' },
    ], streamEndpoints: [
      { endpoint: 'workspace/follow', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'remoteAccess/follow', handlerId: 'native:remoteAccess', guard: 'authenticated-account' },
    ] })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 1, maxWaitersPerAccount: 2 })
  let context: Context | undefined, api: CloudAccountApi | undefined, barrier: ConfigSaveBarrier | undefined
  let native: NativeFirstScreen | undefined
  let defaultWorkspace: Workspace | undefined
  const approved = new Set<Workspace>()
  const streams: Array<{ abort: AbortController; iterator: AsyncIterator<WorkspaceFollowFrame> }> = []
  onTestFinished(async () => {
    try {
      for (const stream of streams) { stream.abort.abort(); await stream.iterator.return?.() }
      if (api !== undefined && barrier !== undefined) {
        const receipt = await api.stopConfigSaves(Date.now() + 1000)
        if (receipt.status === 'confirmed') { await api.withdraw(); saves.releaseAccount(barrier) }
      }
      await context?.fiber.dispose()
      saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const ctx = await boot('cloud-workspaces-component', configPath, [], (scope) => {
    context = scope
    const profile: ProfileContext = { name: 'component', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
      home, cwd: home, installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    scope.provide('profileContext', profile)
    scope.provide('peAccount', binding)
    barrier = saves.createAccount(binding)
    const current = (actual: AccountBinding): void => {
      lifetime.signal.throwIfAborted()
      if (actual !== binding || scope.get('peAccount') !== binding) throw new Error('Foreign fixture binding')
    }
    api = new CloudAccountApi(scope, { binding, rootExposure: exposure, selected: exposure.manifest, saves: barrier,
      assertMountCurrent: current, assertBusinessCurrent: current })
    const firstScreen = api.prepareFirstScreen(scope, {
      project: () => {
        if (defaultWorkspace === undefined) throw new Error('Default fixture Workspace absent')
        return { binding, workspace: defaultWorkspace }
      },
      assertWorkspace: (workspace) => {
        current(binding)
        if (!approved.has(workspace) || scope.workspaceRegistry.get(workspace.id) !== workspace) {
          throw new Error('Unapproved fixture Workspace')
        }
      },
      assertSessionRead: () => { throw new Error('This fixture has no Sessions') },
      maxInventoryEntries: 256, maxCollectionItems, maxFrameBytes: 65536,
    })
    native = firstScreen
    Object.assign(scope.loader.builtins, {
      'workspace-dependencies': { async apply(owner: Context) {
        await owner.plugin(Typert)
        await owner.plugin(RemoteAccess)
        await owner.plugin(Sessions)
        await owner.plugin(Storage)
        await owner.plugin(JsonStorage, { root: join(home, 'storage') })
        await owner.plugin(StorageDomain, { backend: 'json' })
      } },
      'workspace-jsonl': Jsonl, 'workspace-registry': WorkspaceRegistry,
      'workspace-initialize': { inject: ['workspaceRegistry'], async apply(owner: Context) {
        defaultWorkspace = await owner.workspaceRegistry.initializeDefault(async () => paths[0]!)
        if (defaultWorkspace === undefined) throw new Error('Default fixture Workspace ineligible')
        approved.add(defaultWorkspace)
        approved.add(await owner.workspaceRegistry.create(paths[1]!))
      } },
      'workspace-editor': api.providers.configEditor, 'workspace-settings': Settings, 'workspace-locale': Locale,
      'workspace-controller': firstScreen.workspaceController, 'workspace-settings-controller': firstScreen.settingsController,
    })
  })
  if (api === undefined || native === undefined) throw new Error('Fixture API not prepared')
  api.audit(native.inspect())
  return { ctx, paths, approved, lifetime, home, api,
    follow() {
      const abort = new AbortController()
      const iterator = ctx.workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
      streams.push({ abort, iterator })
      return iterator
    } }
}

it('follows two actual native Workspaces and preserves their identities', async () => {
  const f = await fixture()
  const frame = await f.follow().next()
  expect(frame.done).toBe(false)
  expect(frame.value).toMatchObject({ type: 'baseline', value: {
    items: f.ctx.workspaceRegistry.list().map(workspace => ({ workspaceId: workspace.id, path: workspace.path })),
  } })
  expect(f.approved.size).toBe(2)
})

it('rejects a native Workspace absent from the approved graph selection', async () => {
  const f = await fixture()
  await f.ctx.workspaceRegistry.create(f.paths[2]!)
  await expect(f.follow().next()).rejects.toThrow('Unapproved fixture Workspace')
})

it('delegates existing project adoption to the native command and rejects an unregistered path', async () => {
  const f = await fixture()
  const registered = f.ctx.workspaceRegistry.list()[1]
  if (registered === undefined) throw new Error('Second native Workspace absent')
  await expect(f.ctx.workspaceController.create({ path: registered.path })).resolves.toMatchObject({
    created: false, workspace: { workspaceId: registered.id, path: registered.path },
  })
  await expect(f.ctx.workspaceController.create({ path: f.paths[2]! })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.ctx.workspaceRegistry.list()).toHaveLength(2)
})

it('enforces the complete collection limit before returning a multi-Workspace frame', async () => {
  const f = await fixture(1)
  await expect(f.follow().next()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('renames the approved native Workspace, publishes an upsert and persists its title', async () => {
  const f = await fixture(), workspace = f.ctx.workspaceRegistry.list()[1]!
  const follow = f.follow()
  expect((await follow.next()).value).toMatchObject({ type: 'baseline' })
  expect(f.api.requireRpc('workspace/rename')).toMatchObject({ handlerId: 'native:workspaceController', guard: 'account-project' })
  await expect(f.ctx.workspaceController.rename({ workspaceId: workspace.id, title: '  Renamed project  ' }))
    .resolves.toMatchObject({ workspace: { workspaceId: workspace.id, path: workspace.path, title: 'Renamed project' } })
  expect((await follow.next()).value).toMatchObject({ type: 'upsert', workspace: { workspaceId: workspace.id, title: 'Renamed project' } })
  const disk = JSON.parse(readFileSync(join(f.home, 'storage', 'workspace.json'), 'utf8')) as { tables: { workspaces: Record<string, { title: string }> } }
  expect(disk.tables.workspaces[workspace.id]?.title).toBe('Renamed project')
})

it('denies an unknown or unapproved Workspace before any native rename', async () => {
  const f = await fixture(), foreign = await f.ctx.workspaceRegistry.create(f.paths[2]!)
  const title = foreign.title
  await expect(f.ctx.workspaceController.rename({ workspaceId: WorkspaceId('foreign-account-id'), title: 'stolen' }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.ctx.workspaceController.rename({ workspaceId: foreign.id, title: 'stolen' })).rejects.toThrow('Unapproved fixture Workspace')
  expect(foreign.title).toBe(title)
})

it('preserves native validation, duplicate-name serialization and finite input limits', async () => {
  const f = await fixture(), [first, second] = f.ctx.workspaceRegistry.list()
  if (first === undefined || second === undefined) throw new Error('Fixture Workspaces absent')
  await expect(f.ctx.workspaceController.rename({ workspaceId: first.id, title: '  ' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  await expect(f.ctx.workspaceController.rename({ workspaceId: first.id, title: '测'.repeat(22000) })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const results = await Promise.allSettled([
    f.ctx.workspaceController.rename({ workspaceId: first.id, title: 'same' }),
    f.ctx.workspaceController.rename({ workspaceId: second.id, title: 'same' }),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'workspace/name-conflict' } }])
  expect(f.ctx.workspaceRegistry.list().filter(workspace => workspace.title === 'same')).toHaveLength(1)
})

it('joins an accepted queued rename on the original Workspace when later admission is lost', async () => {
  const f = await fixture()
  const first = f.ctx.workspaceRegistry.list().find(workspace => workspace.path === f.paths[0])
  const second = f.ctx.workspaceRegistry.list().find(workspace => workspace.path === f.paths[1])
  if (first === undefined || second === undefined) throw new Error('Fixture Workspaces absent')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = first.setTitle.bind(first)
  const spy = vi.spyOn(first, 'setTitle').mockImplementation(async (title) => {
    entered.resolve(undefined); await release.promise; await original(title)
  })
  try {
    const one = f.ctx.workspaceController.rename({ workspaceId: first.id, title: 'first renamed' })
    await entered.promise
    const two = f.ctx.workspaceController.rename({ workspaceId: second.id, title: 'accepted while queued' })
    const rejected = expect(two).rejects.toThrow('Unapproved fixture Workspace')
    f.approved.delete(second)
    release.resolve(undefined)
    await one
    await rejected
    expect(f.ctx.workspaceRegistry.get(second.id)).toBe(second)
    expect(second.title).toBe('accepted while queued')
  } finally { release.resolve(undefined); spy.mockRestore() }
})

it('retains the original account record through the native table queue after admission is lost', async () => {
  const f = await fixture(), other = await fixture()
  const workspace = f.ctx.workspaceRegistry.list().find(item => item.path === f.paths[1])
  const foreign = other.ctx.workspaceRegistry.list().find(item => item.path === other.paths[1])
  if (workspace === undefined || foreign === undefined) throw new Error('Fixture Workspaces absent')
  const table = Reflect.get(f.ctx.workspaceRegistry, 'table') as { update(id: Workspace['id'], edit: (record: unknown) => unknown): Promise<unknown> }
  const unit = Reflect.get(Reflect.get(table, 'host'), 'unit') as { putRecord(name: string, key: string, value: unknown): Promise<void> }
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = unit.putRecord.bind(unit)
  let held = false
  const put = vi.spyOn(unit, 'putRecord').mockImplementation(async (name, key, value) => {
    if (!held) { held = true; entered.resolve(undefined); await release.promise }
    await original(name, key, value)
  })
  const update = vi.spyOn(table, 'update')
  const foreignTitle = foreign.title
  try {
    const blocker = table.update(workspace.id, record => record)
    await entered.promise
    const rename = f.ctx.workspaceController.rename({ workspaceId: workspace.id, title: 'admitted before loss' })
    const rejected = expect(rename).rejects.toThrow('Unapproved fixture Workspace')
    await vi.waitFor(() => { expect(update).toHaveBeenCalledTimes(2) })
    f.approved.delete(workspace)
    release.resolve(undefined)
    await blocker
    await rejected
    expect(f.ctx.workspaceRegistry.get(workspace.id)).toBe(workspace)
    expect(workspace.title).toBe('admitted before loss')
    expect(other.ctx.workspaceRegistry.get(foreign.id)).toBe(foreign)
    expect(foreign.title).toBe(foreignTitle)
  } finally { release.resolve(undefined); update.mockRestore(); put.mockRestore(); f.approved.add(workspace) }
})

it('refuses a replaced Workspace object before the native queued command can target it', async () => {
  const f = await fixture(), other = await fixture()
  const first = f.ctx.workspaceRegistry.list().find(workspace => workspace.path === f.paths[0])
  const second = f.ctx.workspaceRegistry.list().find(workspace => workspace.path === f.paths[1])
  const foreign = other.ctx.workspaceRegistry.list()[0]
  if (first === undefined || second === undefined || foreign === undefined) throw new Error('Fixture Workspaces absent')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const originalSet = first.setTitle.bind(first)
  const blocked = vi.spyOn(first, 'setTitle').mockImplementation(async (title) => {
    entered.resolve(undefined); await release.promise; await originalSet(title)
  })
  const registry = f.ctx.workspaceRegistry, originalGet = registry.get.bind(registry)
  const get = vi.spyOn(registry, 'get')
  const foreignTitle = foreign.title, originalTitle = second.title
  try {
    const one = f.ctx.workspaceController.rename({ workspaceId: first.id, title: 'original project' })
    await entered.promise
    const two = f.ctx.workspaceController.rename({ workspaceId: second.id, title: 'wrong object' })
    const rejected = expect(two).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    get.mockImplementation(id => id === second.id ? foreign : originalGet(id))
    release.resolve(undefined)
    await one; await rejected
    expect(second.title).toBe(originalTitle)
    expect(foreign.title).toBe(foreignTitle)
  } finally { release.resolve(undefined); get.mockRestore(); blocked.mockRestore() }
})
