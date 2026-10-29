// @vitest-environment jsdom
import { TEST_PLUGIN_ID, pluginFixture } from './plugin-fixtures.client.ts'
/** Original Cordis page, namespace and shared navigation; scripted replies never publish backend configuration. */
import type { ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { installCloudSkillSettings } from '../src/client/skill-settings.ts'
import { installCloudManagement } from '../src/client/management/register.tsx'
import { CLOUD_MANAGEMENT_NAMESPACE } from '../src/client/management/locales.ts'
import { PLUGIN_MANAGEMENT_NAMESPACE } from '../src/client/management/plugins/locales.ts'
import { type CloudPluginRemote } from '../src/client/management/plugins/plugin-edit.ts'
import type { PluginManagementInjected } from '../src/client/management/plugins/types.ts'
import type { ManagementActionToastInjected } from '../src/client/management/ManagementActionToast.tsx'

const facts = pluginFixture('test-edit')
function TestHost({ renderSlot }: PropsRenderSlots<'main' | 'sidebar.panellist' | 'shell.overlay' | 'settings.section'>): ReactNode {
  return [renderSlot('main', {}, { entryKey: 'power-evolve-plugins' }),
    renderSlot('sidebar.panellist', { size: 16, active: false }), renderSlot('shell.overlay', {}),
    renderSlot('settings.section', { close: () => {} })]
}
class Socket implements ConnectionWebSocket {
  readyState = 1
  private readonly listeners = new Set<() => void>()
  send(): void {}
  close(): void { this.readyState = 3; for (const listener of this.listeners) listener(); this.listeners.clear() }
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'close') this.listeners.add(() => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = () => {}
}
async function fixture(skills: boolean, connect: boolean, toggleable = true) {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  const bootstrap: CloudBootstrap = { account: { id: 'A', displayName: 'A' }, recipeVersion: 'plugin-entry', connectionGeneration: 'G',
    capabilities: { projects: { state: 'available' }, filePreview: disabled, shell: disabled, developmentServices: disabled,
      servicePreview: disabled, sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'test', plugins: [{ id: TEST_PLUGIN_ID, installable: false, toggleable }],
        skills: { manage: skills }, credentials: { write: false }, fields: [] } } }
  const prepared = PreparedCloudPage.prepare({ baseUrl: 'https://example.test/app/',
    config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000,
      ...skills ? { skillSettings: { requestTimeoutMs: 1000, maxFileBytes: 4096 } } : {} },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 64, maxValueBytes: 256, maxTotalBytes: 4096, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => Response.json(bootstrap), createWebSocket: () => new Socket(),
  }, new AbortController().signal)
  const page = await prepared.ready, ctx = new Context(), cleanup = Promise.withResolvers<undefined>()
  const failed: Promise<unknown>[] = []
  ctx.on('internal/status', (fiber) => { if (fiber.state === FiberState.FAILED) failed.push(fiber.await().catch((error: unknown) => error)) })
  onTestFinished(async () => { cleanup.resolve(undefined); await prepared.dispose() })
  let holdCleanup = false, owner: Context | undefined, management: ReturnType<Context['plugin']> | undefined
  ctx.provide('clientPersistence', page.nativeOptions.persistence)
  const slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx); locale.setLocale('en'); ctx.provide('locale', locale)
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  ctx.provide('layout', { panelInfo, selectPanel: (panelId) => { panelInfo.set({ activePanelId: panelId }) },
    beginNavigation: () => new AbortController().signal, toggleSidebar: () => {}, openRightbar: () => {}, closeRightbar: () => {} })
  const declare = () => slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' },
  } }, TestHost)
  const withdrawDeclaration = declare()
  const current = vi.fn<CloudPluginRemote['current']>(async () => ({ ok: true, value: facts }))
  const change = vi.fn<CloudPluginRemote['change']>(async (): Promise<never> => { throw new Error('No write belongs to registration verification') })
  const skillUnused = vi.fn(async (): Promise<never> => { throw new Error('No skill RPC belongs to plugin registration') })
  const connectRemote = (): void => { new TestRemote(ctx, {
    cloudPlugins: { current, change } satisfies CloudPluginRemote,
    cloudSkills: { current: skillUnused, publish: skillUnused, installed: skillUnused, details: skillUnused,
      install: skillUnused, update: skillUnused, uninstall: skillUnused, download: skillUnused },
  }) }
  if (connect) connectRemote()
  const installManagement = async (): Promise<void> => {
    if (owner === undefined) throw new Error('Missing original activation')
    management = owner.plugin((scope) => { installCloudManagement(scope, page) })
    await management.await()
    await Promise.resolve()
    for (const error of await Promise.all(failed)) throw error
  }
  await page.start({ run: async () => {
    page.nativeOptions.prepareContext(ctx)
    await ctx.plugin((scope) => { owner = scope; page.activate(scope); installCloudSkillSettings(scope, page) }).await()
    await installManagement()
  }, dispose: async () => { if (holdCleanup) await cleanup.promise; await ctx.fiber.dispose() } })
  const face = (): PluginManagementInjected => {
    const injected = slots.entries('main').find(entry => entry.options.key === 'power-evolve-plugins')?.inject?.() as Partial<PluginManagementInjected> | undefined
    if (injected?.hooks === undefined) throw new Error('Missing original plugin injection')
    return injected as PluginManagementInjected
  }
  const toast = (): ManagementActionToastInjected => {
    const injected = slots.entries('shell.overlay')[0]?.inject?.() as Partial<ManagementActionToastInjected> | undefined
    if (injected?.hooks === undefined || injected.dismiss === undefined) throw new Error('Missing common feedback')
    return injected as ManagementActionToastInjected
  }
  return {
    page, slots, locale, panelInfo, current, change, skillUnused, face, toast, declare,
    withdrawDeclaration, connectRemote, installManagement,
    management: () => { if (management === undefined) throw new Error('Missing management owner'); return management },
    hold: () => { holdCleanup = true }, release: () => { cleanup.resolve(undefined) } }
}
it('loads the approved account catalog when its panel is selected, without reading on startup or retrying while selected', async () => {
  const f = await fixture(false, true), source = f.face().hooks.accountPluginCatalog
  expect(source.getSnapshot().phase).toBe('unread')
  expect(f.current).not.toHaveBeenCalled()
  const panel = brandString<MainPanelId>('power-evolve-plugins')
  f.panelInfo.set({ activePanelId: panel })
  await vi.waitFor(() => { expect(source.getSnapshot().phase).toBe('ready') })
  expect(f.current).toHaveBeenCalledExactlyOnceWith({ id: TEST_PLUGIN_ID }, expect.any(AbortSignal))
  expect(source.getSnapshot().plugins[0]).toMatchObject({ id: TEST_PLUGIN_ID, installed: true })
  f.panelInfo.set({ activePanelId: panel })
  expect(f.current).toHaveBeenCalledTimes(1)

  f.panelInfo.set({ activePanelId: null })
  f.current.mockRejectedValueOnce(new Error('scripted current failure'))
  f.panelInfo.set({ activePanelId: panel })
  await vi.waitFor(() => { expect(source.getSnapshot().phase).toBe('error') })
  f.panelInfo.set({ activePanelId: panel })
  expect(f.current).toHaveBeenCalledTimes(2)
  expect(f.change).not.toHaveBeenCalled()
  f.face().refreshPluginCatalog?.()
  await vi.waitFor(() => { expect(source.getSnapshot().phase).toBe('ready') })
  expect(f.current).toHaveBeenCalledTimes(3)
  await f.page.dispose()
  f.panelInfo.set({ activePanelId: null }); f.panelInfo.set({ activePanelId: panel })
  expect(f.current).toHaveBeenCalledTimes(3)
  expect(source.getSnapshot().phase).toBe('unavailable')
})
it('loads the selected plugin panel when its original namespace becomes available later', async () => {
  const f = await fixture(false, false)
  f.panelInfo.set({ activePanelId: brandString<MainPanelId>('power-evolve-plugins') })
  expect(f.current).not.toHaveBeenCalled()
  f.connectRemote()
  await vi.waitFor(() => { expect(f.slots.entries('main')).toHaveLength(1) })
  await vi.waitFor(() => { expect(f.face().hooks.accountPluginCatalog.getSnapshot().phase).toBe('ready') })
  expect(f.current).toHaveBeenCalledOnce()
  expect(f.change).not.toHaveBeenCalled()
})
it('shares one navigation and feedback owner, reads only on refresh and ignores a reply after synchronous withdrawal', async () => {
  const f = await fixture(true, true)
  expect(f.slots.entries('main').map(entry => entry.options.key).sort()).toEqual(['power-evolve-plugins', 'power-evolve-skills'])
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(2)
  expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  expect(f.slots.entries('settings.section')).toEqual([])
  expect(f.current).not.toHaveBeenCalled(); expect(f.skillUnused).not.toHaveBeenCalled()
  const face = f.face(), source = face.hooks.accountPluginCatalog, notice = f.toast().hooks.managementNotice
  expect(source.getSnapshot()).toEqual({ phase: 'unread', plugins: [], refreshing: false })
  expect(face.requestPluginEnabled).toBeTypeOf('function'); expect(face.openPluginConfiguration).toBeTypeOf('function')
  face.refreshPluginCatalog?.()
  await vi.waitFor(() => { expect(source.getSnapshot().phase).toBe('ready') })
  expect(f.current).toHaveBeenCalledExactlyOnceWith({ id: TEST_PLUGIN_ID }, expect.any(AbortSignal))
  expect(source.getSnapshot().plugins[0]).toMatchObject({ installed: true, enabled: false, version: null,
    toggle: 'available', configuration: 'available', moduleName: facts.plugin.moduleName })
  expect(source.getSnapshot().plugins[0]).not.toHaveProperty('editToken')
  expect(notice.getSnapshot()).toEqual({ sequence: 1, action: 'plugin-refresh', outcome: 'confirmed' })
  f.locale.setLocale('zh')
  expect(source.getSnapshot().plugins[0]?.title).toBe('测试 execution-tuning')
  const label = f.slots.entries('sidebar.panellist').find(entry => entry.options.id === 'power-evolve-plugins')?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('插件')
  expect(f.current).toHaveBeenCalledTimes(1)
  f.withdrawDeclaration(); f.declare()
  await vi.waitFor(() => { expect(f.slots.entries('main')).toHaveLength(2) })
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(2); expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  expect(f.face().hooks.accountPluginCatalog).toBe(source)
  expect(f.toast().hooks.managementNotice).toBe(notice)

  const late = Promise.withResolvers<Awaited<ReturnType<CloudPluginRemote['current']>>>()
  f.current.mockImplementationOnce(async () => await late.promise)
  face.refreshPluginCatalog?.(); face.refreshPluginCatalog?.()
  expect(f.current).toHaveBeenCalledTimes(2)
  expect(source.getSnapshot()).toMatchObject({ phase: 'ready', refreshing: true })
  f.hold(); const closing = f.page.dispose()
  expect(f.slots.entries('main')).toEqual([]); expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toEqual([])
  expect(f.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('plugins')).toBe('plugins')
  expect(f.locale.bind(PLUGIN_MANAGEMENT_NAMESPACE)('knownStateRequired')).toBe('knownStateRequired')
  expect(f.current.mock.calls[1]?.[1]?.aborted).toBe(true)
  const retired = source.getSnapshot()
  expect(retired).toMatchObject({ phase: 'unavailable', refreshing: false })
  late.resolve({ ok: true, value: { ...facts, plugin: { ...facts.plugin, enabled: true } } })
  await late.promise; await new Promise(resolve => setTimeout(resolve, 0))
  expect(source.getSnapshot()).toBe(retired)
  expect(notice.getSnapshot()?.sequence).toBe(1)
  expect(f.change).not.toHaveBeenCalled(); expect(f.skillUnused).not.toHaveBeenCalled()
  f.release(); await closing
})
it('retires a namespace wait before HMR replacement and contributes exactly once when the original namespace arrives', async () => {
  const f = await fixture(false, false)
  expect(f.slots.entries('main')).toEqual([]); expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  const closing = f.management().dispose()
  expect(f.slots.entries('shell.overlay')).toEqual([])
  expect(f.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('plugins')).toBe('plugins')
  await closing
  f.connectRemote(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.slots.entries('main')).toEqual([]); expect(f.slots.entries('sidebar.panellist')).toEqual([])
  await f.installManagement()
  expect(f.slots.entries('main')).toHaveLength(1)
  expect(f.slots.entries('main')[0]?.options.key).toBe('power-evolve-plugins')
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(1); expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  expect(f.current).not.toHaveBeenCalled(); expect(f.change).not.toHaveBeenCalled(); expect(f.skillUnused).not.toHaveBeenCalled()
  const retiring = f.management().dispose()
  expect(f.slots.entries('main')).toEqual([]); expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toEqual([])
  expect(f.locale.bind(PLUGIN_MANAGEMENT_NAMESPACE)('knownStateRequired')).toBe('knownStateRequired')
  await retiring
  await f.installManagement()
  expect(f.slots.entries('main')).toHaveLength(1)
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(1); expect(f.slots.entries('shell.overlay')).toHaveLength(1)
})
it('retains qualified rows after a failed explicit refresh and reports through the common overlay without retry or writes', async () => {
  const f = await fixture(false, true), face = f.face(), source = face.hooks.accountPluginCatalog
  face.refreshPluginCatalog?.()
  await vi.waitFor(() => { expect(source.getSnapshot().phase).toBe('ready') })
  const rows = source.getSnapshot().plugins
  f.current.mockRejectedValueOnce(new Error('scripted unavailable'))
  face.refreshPluginCatalog?.()
  await vi.waitFor(() => { expect(source.getSnapshot().phase).toBe('error') })
  expect(source.getSnapshot().plugins).toBe(rows)
  expect(source.getSnapshot().refreshing).toBe(false)
  expect(f.toast().hooks.managementNotice.getSnapshot()).toEqual({ sequence: 2, action: 'plugin-refresh', outcome: 'unavailable' })
  expect(f.current).toHaveBeenCalledTimes(2); expect(f.change).not.toHaveBeenCalled()
  expect(face.requestPluginEnabled).toBeTypeOf('function'); expect(face.openPluginConfiguration).toBeTypeOf('function')
})

it('mounts configuration-only approved rows without eager reads or writes', async () => {
  const f = await fixture(true, true, false)
  expect(f.slots.entries('main').map(entry => entry.options.key).sort()).toEqual(['power-evolve-plugins', 'power-evolve-skills'])
  expect(f.current).not.toHaveBeenCalled(); expect(f.change).not.toHaveBeenCalled()
  expect(f.slots.entries('shell.overlay')).toHaveLength(1)
})
