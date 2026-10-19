/** Actual Loader profiles install one API owner and native credential/editor hooks before activation. */
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CloudAccountApi, type AccountApiPreparation } from '../src/account-service.ts'
import * as AccountEntry from '../src/account.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceValue } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { CloudProjectsService, type CloudProjectsPreparation } from '../src/cloud-projects.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as NativeFiles from '../src/native-files.ts'

const ref = credentialRef('ACCOUNT_API_SERVICE_FIXTURE')
const nativeFileConfig = {
  maxBytes: 1024, maxFileBytes: 4096, maxLines: 32, maxEntries: 16,
} satisfies ConstructorParameters<typeof WorkspaceFiles>[1]

function observeNativeFiles() {
  const original = NativeFiles.createNativeWorkspaceFiles
  let registered: NativeFiles.NativeWorkspaceFiles | undefined
  const factory = vi.spyOn(NativeFiles, 'createNativeWorkspaceFiles')
    .mockImplementation((...args: Parameters<typeof original>) => {
      registered = original(...args)
      return registered
    })
  onTestFinished(() => { factory.mockRestore() })
  return { factory, get value(): NativeFiles.NativeWorkspaceFiles {
    if (registered === undefined) throw new Error('Native files did not register')
    return registered
  } }
}

function fixture(projects?: CloudProjectsPreparation, files = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'account-api-service-')))
  const saves = new ConfigSaveCoordinator({ maxAccounts: 4, maxRunning: 2, maxQueued: 4, maxQueuedPerAccount: 2,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 2, maxWaitersPerAccount: 2 })
  const root = new ExposurePolicy({ recipeVersion: 'api-service-fixture', rpcEndpoints: [
    ...projects === undefined ? [] : [{ endpoint: 'cloudProjects/create', handlerId: 'native:cloudProjects', guard: 'authenticated-account' as const }],
    ...files ? ['read', 'stat', 'list', 'readBytes'].map(method => ({ endpoint: 'workspaceFiles/' + method,
      handlerId: 'native:workspaceFiles', guard: 'account-session' as const })) : [],
  ], streamEndpoints: files ? [{ endpoint: 'workspaceFiles/changes', handlerId: 'native:workspaceFiles', guard: 'account-session' }] : [],
  exactFetchRoutes: [], allowedSettings: [] })
  const accounts: Array<{ ctx: Context; api: CloudAccountApi; barrier: ConfigSaveBarrier }> = []
  onTestFinished(async () => {
    try {
      for (const { ctx, api, barrier } of accounts.toReversed()) {
        const stopped = await api.stopConfigSaves(Date.now() + 1000)
        if (stopped.status === 'confirmed') { await api.withdraw(); saves.releaseAccount(barrier) }
        await ctx.fiber.dispose()
      }
      saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  async function account(name: string) {
    const dir = join(home, name), profileDir = join(dir, 'profile')
    mkdirSync(profileDir, { recursive: true })
    initProfile(profileDir, [])
    const configPath = join(profileDir, 'cordis.yml'), patchPath = join(profileDir, 'cordis.patch.yml')
    const credentials = join(dir, '.credentials.yaml')
    writeFileSync(join(dir, 'package.json'), '{"name":"api-service-fixture"}\n')
    writeFileSync(patchPath, '[]\n')
    writeFileSync(credentials, `version: 1\nrefs:\n  ACCOUNT_API_SERVICE_FIXTURE: value-${name}\n`, { mode: 0o600 })
    writeFileSync(configPath, JSON.stringify([
      ...projects === undefined && !files ? [] : [
        { id: 'typert', name: 'cordis:api-service-typert' },
        { id: 'remoteAccess', name: 'cordis:api-service-access' },
        { id: 'gateway', name: 'cordis:api-service-gateway' },
      ],
      ...files ? [
        { id: 'sessions', name: 'cordis:api-service-sessions' },
        { id: 'projections', name: 'cordis:api-service-projections' },
        { id: 'sandboxPolicy', name: 'cordis:api-service-policy', config: { mode: 'workspace-write', workspaceRoot: dir } },
        { id: 'fs', name: 'cordis:api-service-fs', config: { cwd: dir } },
        { id: 'workspaceFiles', name: 'cordis:api-service-files', config: nativeFileConfig },
      ] : [],
      { id: 'editor', name: 'cordis:api-service-editor' },
      { id: 'credentials', name: 'cordis:api-service-credentials', config: { path: credentials, watch: false } },
      { id: 'api', name: 'cordis:api-service-account', config: {} },
    ]))
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
      epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: root.manifest.recipeVersion, lifetime: lifetime.signal })
    const mountCurrent = vi.fn((actual: AccountBinding) => { expect(actual).toBe(binding); lifetime.signal.throwIfAborted() })
    const businessClosed = new Error('Business publication remains closed')
    const businessCurrent = vi.fn((_binding: AccountBinding): void => { throw businessClosed })
    const profile: ProfileContext = { name: 'account', dir: profileDir, patchPath, installAnchor: join(dir, 'package.json'),
      cwd: dir, home: dir, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    let api: CloudAccountApi | undefined, input: AccountApiPreparation | undefined
    const ctx = await boot('api-service-' + name, configPath, [], (scope) => {
      scope.provide('profileContext', profile)
      scope.provide('peAccount', binding)
      const barrier = saves.createAccount(binding)
      input = { binding, rootExposure: root, selected: root.manifest, saves: barrier,
        assertMountCurrent: mountCurrent, assertBusinessCurrent: businessCurrent,
        ...files ? { maxNativeInventoryEntries: 512 } : {} }
      api = new CloudAccountApi(scope, input)
      if (projects !== undefined) {
        expect(scope.get('typert')).toBeUndefined()
        api.prepareCloudProjects(scope, projects)
      }
      accounts.push({ ctx: scope, api, barrier })
      Object.assign(scope.loader.builtins, {
        'api-service-editor': api.providers.configEditor,
        'api-service-credentials': api.providers.credentials,
        'api-service-account': AccountEntry,
        'api-service-typert': TypertRegistry,
        'api-service-access': RemoteAccess,
        'api-service-gateway': Gateway,
        'api-service-sessions': Sessions,
        'api-service-projections': SessionProjections,
        'api-service-policy': SandboxPolicy,
        'api-service-fs': LocalFileSystem,
        'api-service-files': { inject: WorkspaceFiles.inject, Config: WorkspaceFiles.Config,
          apply(owner: Context, config: ConstructorParameters<typeof WorkspaceFiles>[1]) {
            if (api === undefined) throw new Error('API owner not prepared')
            api.createWorkspaceFiles(owner, config)
          } },
      })
    })
    if (api === undefined || input === undefined) throw new Error('API preparation did not run')
    return { ctx, api, input, credentials, businessClosed, businessCurrent, lifetime, mountCurrent }
  }
  return { account }
}

it('loads the real account entry while business stays closed and native writes retain the existing save barrier', async () => {
  const f = await fixture().account('A')
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'api')
  expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
  const traced = f.ctx.get('peCloudApi')
  expect(traced).toBeInstanceOf(CloudAccountApi)
  expect(traced?.binding).toBe(f.api.binding)
  traced?.assertInstalled()
  expect(f.businessCurrent).not.toHaveBeenCalled()
  expect(() => traced?.requireRpc('session/create')).toThrow(f.businessClosed)
  await expect(f.api.assertBootstrapCurrent(f.ctx)).rejects.toBe(f.businessClosed)
  await expect(f.api.auditPrepared(f.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect((await f.ctx.credentials.resolve(ref))?.value).toBe('value-A')
  await f.ctx.credentials.set(ref, 'updated-A')
  const before = readFileSync(f.credentials, 'utf8')
  expect(before).toContain('updated-A')
  expect((await f.api.stopConfigSaves(Date.now() + 1000)).status).toBe('confirmed')
  await expect(f.ctx.credentials.set(ref, 'must-not-save')).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(readFileSync(f.credentials, 'utf8')).toBe(before)
  await f.api.withdraw()
  expect(() => { f.api.assertInstalled() }).toThrow('withdrawn')
})

it('rejects duplicate or foreign ownership and keeps another account view and native credentials independent', async () => {
  const shared = fixture(), a = await shared.account('A'), b = await shared.account('B')
  expect(() => new CloudAccountApi(a.ctx, a.input)).toThrow('already has an API owner')
  expect(() => { a.api.assertInstalled(b.ctx) }).toThrow()
  const shadow = a.ctx.isolate('peCloudApi')
  shadow.provide('peCloudApi', b.api)
  expect(() => { a.api.assertInstalled(shadow) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  a.api.audit({ recipeVersion: a.input.binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] })
  b.api.audit({ recipeVersion: b.input.binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] })
  a.businessCurrent.mockImplementation(() => {})
  b.businessCurrent.mockImplementation(() => {})
  expect(() => b.api.requireRpc('not-exposed')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await a.api.stopConfigSaves(Date.now() + 1000)
  expect(() => a.api.requireRpc('not-exposed')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => b.api.requireRpc('not-exposed')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect((await b.ctx.credentials.resolve(ref))?.value).toBe('value-B')
  a.lifetime.abort()
  expect(() => { a.api.assertInstalled() }).toThrow()
  b.api.assertInstalled()
})

it('refuses an unprepared entry and nonempty Loader configuration', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  expect(() => { AccountEntry.apply(ctx, {}) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => AccountEntry.Config({ binding: 'not-an-input' })).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
})

it('discovers the prepare-time project Remote after actual Loader activation and rejects blank/large titles without allocation', async () => {
  const value: WorkspaceValue = { workspace: { workspaceId: brandString<WorkspaceValue['workspace']['workspaceId']>('native-project'), path: '/trusted/allocated',
    title: 'Project', sessionIds: [], createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' } }
  const createProject = vi.fn(async (): Promise<WorkspaceValue> => value)
  const f = await fixture({ createProject }).account('A')
  const service = f.ctx.cloudProjects
  const inventory = service.inspect()
  expect(inventory.rpcEndpoints).toEqual([{ endpoint: 'cloudProjects/create', handlerId: 'native:cloudProjects', guard: 'authenticated-account' }])
  f.api.audit(inventory)
  f.businessCurrent.mockImplementation(() => {})
  const peer: PeerScope = { id: brandString<PeerScope['id']>('project-peer'), ctx: f.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: f.lifetime.signal, dispose: async () => {} }
  const invoke = (request: { title?: string }) => f.ctx.typertGateway.invoke({ namespace: 'cloudProjects', method: 'create', args: { request }, peer })
  await expect(invoke({ title: '  Project  ' })).resolves.toEqual(value)
  expect(createProject).toHaveBeenCalledWith('Project', expect.any(AbortSignal))
  for (const title of ['', '  ', 'x'.repeat(257), '中'.repeat(86)]) {
    await expect(invoke({ title })).rejects.toMatchObject({ code: 'cloud/invalid-project-title' })
  }
  const clientPath = { title: 'Name', path: '/not-authority' }
  await expect(invoke(clientPath)).rejects.toMatchObject({ code: 'cloud/invalid-project-title' })
  expect(createProject).toHaveBeenCalledTimes(1)
  await expect(invoke({})).resolves.toEqual(value)
  expect(createProject).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  expect(() => f.api.prepareCloudProjects(f.ctx, { createProject })).toThrow('already has a native installation')
  expect(() => new CloudProjectsService(f.ctx, f.api, { createProject })).toThrow('already has a project creation service')
  f.businessCurrent.mockImplementation(() => { throw f.businessClosed })
  await expect(invoke({ title: 'closed' })).rejects.toBe(f.businessClosed)
  expect(createProject).toHaveBeenCalledTimes(2)
  f.lifetime.abort()
  await expect(service.create({ title: 'stale' }, new AbortController().signal)).rejects.toThrow()
  expect(createProject).toHaveBeenCalledTimes(2)
})

it('joins an admitted project callback after cancellation and never reports a late allocation as a successful response', async () => {
  let complete!: (value: WorkspaceValue) => void
  const allocation = new Promise<WorkspaceValue>((resolve) => { complete = resolve })
  const createProject = vi.fn(() => allocation)
  const f = await fixture({ createProject }).account('A')
  f.api.audit(f.ctx.cloudProjects.inspect())
  f.businessCurrent.mockImplementation(() => {})
  const abort = new AbortController()
  const result = f.ctx.cloudProjects.create({ title: 'one' }, abort.signal)
  let settled = false
  void result.then(() => { settled = true }, () => { settled = true })
  abort.abort(new Error('cancelled'))
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(createProject).toHaveBeenCalledTimes(1)
  complete({ workspace: { workspaceId: brandString<WorkspaceValue['workspace']['workspaceId']>('allocated'), path: '/trusted/allocated', title: 'one', sessionIds: [], createdAt: '', updatedAt: '' } })
  await expect(result).rejects.toThrow('cancelled')
  expect(settled).toBe(true)
})

it('constructs one unchanged WorkspaceFiles through the actual Loader, inventories native modes and dispatches through the original Gateway', async () => {
  const observed = observeNativeFiles(), factory = observed.factory
  const f = await fixture(undefined, true).account('A')
  expect(factory).toHaveBeenCalledOnce()
  const native = observed.value
  expect(f.ctx.workspaceFiles).toBeInstanceOf(WorkspaceFiles)
  expect(Reflect.get(native.value, 'stat')).toBe(Reflect.get(WorkspaceFiles.prototype, 'stat'))
  const inventory = native.inspect()
  expect(inventory.rpcEndpoints.map(row => row.endpoint).sort()).toEqual([
    'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat',
  ])
  expect(inventory.streamEndpoints).toEqual([{ endpoint: 'workspaceFiles/changes', handlerId: 'native:workspaceFiles', guard: 'account-session' }])
  f.api.audit(inventory)
  f.businessCurrent.mockImplementation(() => {})
  expect(f.api.requireRpc('workspaceFiles/stat').guard).toBe('account-session')
  expect(f.api.requireStream('workspaceFiles/changes').guard).toBe('account-session')
  const path = join(f.ctx.sandboxPolicy.workspaceRoot, 'native.txt')
  writeFileSync(path, 'original native contents\n')
  const sessionId = SessionId('workspace-files-local-component')
  f.ctx.sessions.create(sessionId, { meta: { cwd: f.ctx.sandboxPolicy.workspaceRoot } })
  const peer: PeerScope = { id: brandString<PeerScope['id']>('native-file-peer'), ctx: f.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: f.lifetime.signal, dispose: async () => {} }
  const stat = await f.ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'stat',
    args: { workspaceFileScopeId: sessionId, path: 'native.txt' }, peer })
  expect(stat).toMatchObject({ absolutePath: path, bytes: 25 })
  expect(() => f.api.createWorkspaceFiles(f.ctx, WorkspaceFiles.Config(nativeFileConfig))).toThrow('already has a native installation')
  expect(factory).toHaveBeenCalledOnce()
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'workspaceFiles')
  if (entry?.fiber === undefined) throw new Error('WorkspaceFiles Loader fiber missing')
  await entry.fiber.dispose()
  await f.ctx.plugin(WorkspaceFiles, WorkspaceFiles.Config(nativeFileConfig))
  expect(() => native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => f.api.requireRpc('workspaceFiles/stat')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => f.api.requireStream('workspaceFiles/changes')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects a removed or replaced original filesystem provider before native file dispatch', async () => {
  const observed = observeNativeFiles()
  const f = await fixture(undefined, true).account('A')
  const native = observed.value
  f.api.audit(native.inspect())
  f.businessCurrent.mockImplementation(() => {})
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'fs')
  if (entry?.fiber === undefined) throw new Error('Filesystem Loader fiber missing')
  await entry.fiber.dispose()
  expect(() => native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await f.ctx.plugin(LocalFileSystem, { cwd: f.ctx.sandboxPolicy.workspaceRoot })
  expect(() => f.api.requireRpc('workspaceFiles/readBytes')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})
