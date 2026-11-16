// @vitest-environment jsdom
/** Prepared Cloud owner and Native Sidebar navigation; HTTP and browser rendering remain separate acceptance. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { createSidebarRightController } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/service.ts'
import { createSidebarRightStore } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as cloud from '../src/client/index.ts'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'

const sessionId = SessionId('preview-session')
const policy = { managementOrigin: 'http://console.dsh.localhost:4100', previewOrigin: 'http://preview.dsh.localhost:4100',
  routePath: '/cloud/service-preview', maxFieldBytes: 128, maxUrlBytes: 2048 }

async function fixture(account = 'account-A', generation = 'generation-A', launch?: () => Promise<Response>) {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  const bootstrap: CloudBootstrap = { account: { id: account, displayName: 'Preview fixture' }, recipeVersion: 'preview-fixture',
    connectionGeneration: generation, capabilities: { projects: disabled, filePreview: disabled, shell: disabled,
      developmentServices: disabled, servicePreview: { state: 'available' }, sandboxScope: 'session', backgroundJobs: false,
      localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'preview-fixture', plugins: [], skills: { manage: false },
        credentials: { write: false }, fields: [] } } }
  const values = new Map<string, string>(), open = vi.fn<(url: string) => void>()
  const refused = vi.fn<(code: 'closed' | 'target-denied') => void>()
  const preparation = PreparedCloudPage.prepare({ baseUrl: policy.managementOrigin + '/',
    config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 2, maxSockets: 1, closeTimeoutMs: 1000, servicePreview: policy,
      ...launch === undefined ? {} : { serviceApplications: { managementOrigin: policy.managementOrigin,
        contentOrigin: 'http://apps.dsh.localhost:4101', requestTimeoutMs: 1000,
        maxRequestBytes: 1024, maxResponseBytes: 2048, maxFieldBytes: 128 } } },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 512, maxListItems: 32 },
    persistenceLimits: { maxKeys: 8, maxKeyBytes: 256, maxValueBytes: 4096, maxTotalBytes: 16384, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) } },
    fetch: async (input) => {
      const path = new URL(input).pathname
      if (path === '/cloud/bootstrap') return Response.json(bootstrap)
      if (path === '/cloud/service-application' && launch !== undefined) return launch()
      return new Response(null, { status: 204 })
    }, createWebSocket: () => { throw new Error('No socket in navigation fixture') },
    previewNavigation: { open, refused },
  }, new AbortController().signal)
  onTestFinished(() => preparation.dispose())
  const page = await preparation.ready, ctx = new Context(), tabs = new SidebarRightTabRegistry(ctx)
  const removeBrowser = tabs.register({ id: 'native-browser-fixture', kind: 'browser', multiple: true, title: () => 'Browser' })
  const native = createSidebarRightController(tabs, () => {}, {
    autoFullscreen: () => false, openWithFocus: (_session, action) => { action() },
    closeWithFocus: (_session, _pane, action) => { action() },
  })
  const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'Guide' })).create()
  const unadopt = native.adopt(sessionId, store)
  ctx.effect(() => () => { unadopt(); native.controller.tabDomain.dispose(); removeBrowser() })
  ctx.provide('sidebarRightTabs', tabs)
  ctx.provide('sidebarRight', native.controller)
  await page.start({
    async run() {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx, undefined, { preference: 'en', languages: ['en'] }))
      ctx.provide('clientPersistence', page.nativeOptions.persistence)
      page.nativeOptions.prepareContext(ctx)
      await ctx.plugin(Loader)
      ctx.loader.builtins.cloud = cloud
      await ctx.loader.create({ name: 'cordis:cloud' })
      await ctx.loader.await()
      native.show(sessionId)
    },
    async dispose() { await ctx.fiber.dispose() },
  })
  const records = () => Object.values(store.getSnapshot().bySession[sessionId]?.layout.tabs ?? {})
  const browserUrl = (): URL => {
    const tab = records().find(row => row.kind === 'browser')
    if (tab === undefined) throw new Error('No Native Browser tab')
    const navigation = native.controller.tabDomain.occurrence(sessionId, tab).navigation.getSnapshot()
    const params = navigation.params
    if (params === undefined || !('url' in params) || typeof params.url !== 'string') throw new Error('No Browser navigation URL')
    return new URL(params.url)
  }
  return { page, native, open, refused, removeBrowser, records, browserUrl }
}

it('opens the registered Native Browser with the original Session, service and page identity', async () => {
  const f = await fixture()
  f.page.servicePreviewNavigation!({ sessionId, serviceHandle: 'service-A' })
  expect(f.browserUrl().origin).toBe(policy.previewOrigin)
  expect(f.browserUrl().pathname).toBe(policy.routePath)
  expect(Object.fromEntries(f.browserUrl().searchParams)).toEqual({ sessionId, serviceHandle: 'service-A',
    peAccount: 'account-A', peGeneration: 'generation-A' })
  expect(f.open).not.toHaveBeenCalled()
  expect(f.refused).not.toHaveBeenCalled()
})

it('refuses a stale Session seat instead of opening its service in the newly selected Session', async () => {
  const f = await fixture()
  f.native.show(SessionId('other-session'))
  f.page.servicePreviewNavigation!({ sessionId, serviceHandle: 'service-A' })
  expect(f.records()).toHaveLength(0)
  expect(f.open).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(f.refused).toHaveBeenCalledExactlyOnceWith('target-denied') })
})

it('retains the captured application navigation when the optional Browser registration is absent', async () => {
  const f = await fixture()
  f.removeBrowser()
  f.page.servicePreviewNavigation!({ sessionId, serviceHandle: 'service-A' })
  expect(f.records()).toHaveLength(0)
  expect(f.open).toHaveBeenCalledTimes(1)
  expect(new URL(f.open.mock.calls[0]![0]).searchParams.get('peAccount')).toBe('account-A')
})

it('keeps separate pages bound to their own Browser state and refuses a revoked callback', async () => {
  const a = await fixture(), b = await fixture('account-B', 'generation-B')
  const old = a.page.servicePreviewNavigation!
  old({ sessionId, serviceHandle: 'service-A' })
  b.page.servicePreviewNavigation!({ sessionId, serviceHandle: 'service-B' })
  expect(a.browserUrl().searchParams.get('peAccount')).toBe('account-A')
  expect(b.browserUrl().searchParams.get('peAccount')).toBe('account-B')
  expect(b.browserUrl().searchParams.get('peGeneration')).toBe('generation-B')
  const count = a.records().length
  await a.page.dispose()
  old({ sessionId, serviceHandle: 'service-A' })
  expect(a.records()).toHaveLength(count)
  expect(a.open).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(a.refused).toHaveBeenLastCalledWith('closed') })
})

it('opens only the clean content URL after the private handoff without saving its proof', async () => {
  const origin = 'http://' + 'a'.repeat(32) + '.apps.dsh.localhost:4101', proof = 'b'.repeat(64)
  const f = await fixture('account-A', 'generation-A', async () => Response.json({ origin, proof }))
  f.page.servicePreviewNavigation!({ sessionId, serviceHandle: 'service-A' })
  await vi.waitFor(() => { expect(f.browserUrl().href).toBe(origin + '/') })
  expect(JSON.stringify(f.records())).not.toContain(proof)
  expect(f.open).not.toHaveBeenCalled(); expect(f.refused).not.toHaveBeenCalled()
})

it('refuses an asynchronous handoff after the selected Native Session has changed', async () => {
  const pending = Promise.withResolvers<Response>()
  const f = await fixture('account-A', 'generation-A', () => pending.promise)
  f.page.servicePreviewNavigation!({ sessionId, serviceHandle: 'service-A' })
  f.native.show(SessionId('other-session'))
  pending.resolve(Response.json({ origin: 'http://' + 'a'.repeat(32) + '.apps.dsh.localhost:4101', proof: 'b'.repeat(64) }))
  await vi.waitFor(() => { expect(f.refused).toHaveBeenCalledExactlyOnceWith('target-denied') })
  expect(f.records()).toHaveLength(0); expect(f.open).not.toHaveBeenCalled()
})
