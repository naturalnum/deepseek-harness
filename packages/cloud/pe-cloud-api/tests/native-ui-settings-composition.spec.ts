/** Original account Settings forms retain native persistence, revision checks and login ownership. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import Sessions from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Settings from '@deepseek-ai/dsh-settings'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import * as Theme from '@deepseek-ai/dsh-client-ui-theme'
import * as Chat from '@deepseek-ai/dsh-client-ui-chat'
import * as Conversation from '@deepseek-ai/dsh-client-ui-conversation'
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings'
import Typert from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import { expect, it, onTestFinished } from 'vitest'
import { CloudAccountApi } from '../src/account-service.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'
import type { NativeFirstScreen } from '../src/native-first-screen.ts'
import type { ApprovedConfigurationField } from '../src/types.ts'

const fields: readonly ApprovedConfigurationField[] = [
  { namespace: 'locale', field: 'preference', values: ['zh', 'en'] },
  ...['preference', 'fontSize', 'codeFontSize', 'terminalFontSize', 'textFontFamily', 'codeFontFamily', 'terminalFontFamily']
    .map(field => ({ namespace: 'ui-theme', field })),
  ...['transcriptView', 'collapseTiming', 'performanceUsage', 'linkOpening'].map(field => ({ namespace: 'ui-chat', field })),
  { namespace: 'ui-conversation', field: 'busyEnter' },
  { namespace: 'ui-settings', field: 'enabled' },
]

async function fixture(name: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-native-ui-settings-'))), dir = join(home, 'profile')
  const project = join(home, 'project')
  let context: Context | undefined, api: CloudAccountApi | undefined, barrier: ConfigSaveBarrier | undefined
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 3, maxWaitersPerAccount: 2 })
  onTestFinished(async () => {
    try {
      if (api !== undefined && barrier !== undefined) {
        const receipt = await api.stopConfigSaves(Date.now() + 1000)
        expect(receipt.status).toBe('confirmed')
        await api.withdraw(); saves.releaseAccount(barrier)
      }
      await context?.fiber.dispose(); saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  mkdirSync(dir); mkdirSync(project); initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"native-ui-preferences-fixture","private":true}\n')
  const profile: ProfileContext = { name: 'ui', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
    { id: 'dependencies', name: 'cordis:ui-dependencies' },
    { id: 'jsonl', name: 'cordis:ui-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'registry', name: 'cordis:ui-registry' },
    { id: 'initialize', name: 'cordis:ui-initialize' },
    { id: 'editor', name: 'cordis:ui-editor' },
    { id: 'settings', name: 'cordis:ui-settings' },
    { id: 'locale', name: 'cordis:ui-locale', config: { preference: 'en' } },
    { id: 'ui-theme', name: 'cordis:ui-theme-preferences' },
    { id: 'ui-chat', name: 'cordis:ui-chat-preferences' },
    { id: 'ui-conversation', name: 'cordis:ui-conversation-preferences' },
    { id: 'ui-settings', name: 'cordis:ui-developer-preferences' },
    { id: 'workspace-controller', name: 'cordis:ui-workspace-controller' },
    { id: 'settings-controller', name: 'cordis:ui-settings-controller' },
  ] }]) + '\n')
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'native-ui-preferences', lifetime: lifetime.signal })
  const allowedSettings = [...new Set(fields.map(field => field.namespace))].map(namespace => ({ namespace,
    fields: fields.filter(field => field.namespace === namespace).map(field => field.field) }))
  const exposure = new ExposurePolicy({ recipeVersion: binding.recipeVersion, exactFetchRoutes: [], allowedSettings,
    rpcEndpoints: [
      { endpoint: 'workspace/initializeDefault', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'workspace/create', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'settings/describe', handlerId: 'native:settingsController', guard: 'authenticated-account' },
      { endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' },
    ], streamEndpoints: [
      { endpoint: 'workspace/follow', handlerId: 'native:workspaceController', guard: 'account-project' },
      { endpoint: 'remoteAccess/follow', handlerId: 'native:remoteAccess', guard: 'authenticated-account' },
    ] })
  let native: NativeFirstScreen | undefined, workspace: Workspace | undefined
  const ctx = await boot('native-ui-preferences', configPath, readProfilePatches('native-ui-preferences', profile), (scope) => {
    context = scope; scope.provide('profileContext', profile); scope.provide('peAccount', binding)
    const current = (actual: AccountBinding): void => {
      lifetime.signal.throwIfAborted()
      if (actual !== binding || scope.get('peAccount') !== binding) throw new CloudApiError('cloud/stale-generation', 'Fixture binding changed.')
    }
    barrier = saves.createAccount(binding)
    api = new CloudAccountApi(scope, { binding, rootExposure: exposure, selected: exposure.manifest, saves: barrier,
      assertMountCurrent: current, assertBusinessCurrent: current })
    const first = api.prepareFirstScreen(scope, {
      project: () => { if (workspace === undefined) throw new Error('Workspace absent'); return { binding, workspace } },
      assertWorkspace: (actual) => { if (actual !== workspace) throw new Error('Foreign Workspace') },
      assertSessionRead: () => { throw new Error('No Sessions in settings fixture') },
      maxInventoryEntries: 256, maxCollectionItems: 32, maxFrameBytes: 65536,
      settingsWrites: { fields,
        withModelKeyPeerUse(actual, consume) {
          if (actual !== peer) throw new CloudApiError('cloud/forbidden', 'Wrong original login Peer.')
          const use: AccountUse = { binding, context: scope, assertCurrent: () => { current(binding) }, release() {} }
          return consume(use, () => { current(binding) })
        },
      },
    })
    native = first
    Object.assign(scope.loader.builtins, {
      'ui-dependencies': { async apply(owner: Context) {
        await owner.plugin(Typert); await owner.plugin(RemoteAccess); await owner.plugin(Gateway)
        await owner.plugin(Sessions); await owner.plugin(Storage)
        await owner.plugin(JsonStorage, { root: join(home, 'storage') }); await owner.plugin(StorageDomain, { backend: 'json' })
      } },
      'ui-jsonl': Jsonl, 'ui-registry': WorkspaceRegistry,
      'ui-initialize': { inject: ['workspaceRegistry'], async apply(owner: Context) {
        workspace = await owner.workspaceRegistry.initializeDefault(async () => project)
      } },
      'ui-editor': api.providers.configEditor, 'ui-settings': Settings, 'ui-locale': Locale,
      'ui-theme-preferences': Theme, 'ui-chat-preferences': Chat, 'ui-conversation-preferences': Conversation,
      'ui-developer-preferences': UiSettings,
      'ui-workspace-controller': first.workspaceController, 'ui-settings-controller': first.settingsController,
    })
  })
  if (api === undefined || native === undefined || barrier === undefined) throw new Error('Fixture owners absent')
  for (const row of ctx.loader.entries()) expect(row.fiber?.state, row.options.id).toBe(FiberState.ACTIVE)
  api.audit(native.inspect())
  const peer: PeerScope = { id: brandString<PeerScope['id']>('peer-' + name), ctx, principal: { kind: 'owner' }, interactions: 'answer',
    signal: lifetime.signal, dispose: () => Promise.resolve() }
  const originalPeer = peer
  const currentView = (ns: string): SettingsNamespaceView => {
    const row = ctx.settingsController.describe().namespaces.find(item => item.ns === ns)
    if (row === undefined) throw new Error('Native settings namespace absent: ' + ns)
    return row
  }
  return { ctx, profile, lifetime, barrier, currentView, peer: originalPeer,
    mutate(ns: string, ops: SettingsPathOpView[], selectedPeer = originalPeer, expectedRevision = currentView(ns).revision) {
      return ctx.typertGateway.invoke({ namespace: 'settings', method: 'mutate',
        args: { ns, ops, expectedRevision }, peer: selectedPeer })
    } }
}

it('persists native theme, chat and conversation preferences in one account only', async () => {
  const [a, b] = await Promise.all([fixture('a'), fixture('b')])
  const otherBefore = readFileSync(b.profile.patchPath)
  const before = a.currentView('ui-theme').revision
  await expect(a.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' },
    { op: 'set', path: ['fontSize'], value: 18 }])).resolves.toMatchObject({ ns: 'ui-theme', value: { preference: 'dark', fontSize: 18 } })
  await a.mutate('ui-chat', [{ op: 'set', path: ['performanceUsage'], value: 'compact' }])
  await a.mutate('ui-conversation', [{ op: 'set', path: ['busyEnter'], value: 'steer' }])
  await a.mutate('ui-settings', [{ op: 'set', path: ['enabled'], value: false }])
  expect(readFileSync(a.profile.patchPath, 'utf8')).toContain('dark')
  expect(a.currentView('ui-chat').value).toMatchObject({ performanceUsage: 'compact' })
  expect(a.currentView('ui-conversation').value).toMatchObject({ busyEnter: 'steer' })
  expect(a.currentView('ui-settings').value).toMatchObject({ enabled: false })
  expect(a.currentView('ui-theme').revision).toBeGreaterThan(before)
  expect(readFileSync(b.profile.patchPath)).toEqual(otherBefore)
  expect(b.currentView('ui-theme').value).toMatchObject({ preference: 'system', fontSize: 14 })
  expect(a.ctx.settingsController.describe()).toMatchObject({ writable: true, hasDocument: false })
  expect(a.barrier.snapshot().failures).toHaveLength(0)
})

it('rejects foreign login, unsupported fields and stale revisions before persistence', async () => {
  const [a, b] = await Promise.all([fixture('a'), fixture('b')])
  const before = readFileSync(a.profile.patchPath), revision = a.currentView('ui-theme').revision
  await expect(a.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }], b.peer)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.mutate('ui-theme', [{ op: 'set', path: ['hostPath'], value: '/other-account' }])).rejects.toBeDefined()
  expect(readFileSync(a.profile.patchPath)).toEqual(before)
  await a.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
  const after = readFileSync(a.profile.patchPath)
  await expect(a.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'light' }], a.peer, revision)).rejects.toMatchObject({ code: 'settings/conflict' })
  expect(readFileSync(a.profile.patchPath)).toEqual(after)
  expect(a.barrier.snapshot().failures).toHaveLength(0)
})

it('refuses an ended account generation without changing the native preference document', async () => {
  const a = await fixture('a'), before = readFileSync(a.profile.patchPath), revision = a.currentView('ui-chat').revision
  a.lifetime.abort(new CloudApiError('cloud/stale-generation', 'Fixture account ended.'))
  await expect(a.mutate('ui-chat', [{ op: 'set', path: ['performanceUsage'], value: 'compact' }], a.peer, revision)).rejects.toBeDefined()
  expect(readFileSync(a.profile.patchPath)).toEqual(before)
})
