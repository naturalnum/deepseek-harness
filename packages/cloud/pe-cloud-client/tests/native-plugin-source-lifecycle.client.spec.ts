/** Cloud source and original Cordis navigation ownership; no browser/server deployment. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installCloudPluginCatalog } from '../src/client/management/plugins/install.tsx'

it('provides one account source, hides the fallback navigation while native navigation exists, and withdraws cleanly', async () => {
  const ctx = new Context(), signal = new AbortController(), slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const root = slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' } } }, ({ renderSlot }) => { void renderSlot; return null })
  new TestRemote(ctx, { cloudPlugins: { list: async () => ({ ok: true, value: { bundles: [], plugins: [], controls: [] } }),
    current: async () => { throw new Error('No edit') }, change: async () => { throw new Error('No edit') } } })
  const page = { bootstrap: { capabilities: { configuration: { plugins: [] } } },
    lifetime: { transport: { signal: signal.signal } }, assertAccountManagementCurrent: () => { signal.signal.throwIfAborted() } }
  const plugin = ctx.plugin((scope) => { installCloudPluginCatalog(scope, page as never, () => {}) })
  onTestFinished(async () => { signal.abort(); root(); await ctx.fiber.dispose() })
  await plugin.await()
  await vi.waitFor(() => { expect(ctx.get('pluginManagerIntegration')).toBeDefined() })
  expect(slots.entries('sidebar.panellist').map(row => row.options.id)).toEqual(['power-evolve-plugins'])
  const native = ctx.plugin((scope) => { scope.provide('pluginNavigation', { openBundle() {} }) })
  await native.await()
  await vi.waitFor(() => { expect(slots.entries('sidebar.panellist')).toHaveLength(0) })
  await native.dispose()
  await vi.waitFor(() => { expect(slots.entries('sidebar.panellist').map(row => row.options.id)).toEqual(['power-evolve-plugins']) })
  await plugin.dispose()
  expect(ctx.get('pluginManagerIntegration')).toBeUndefined()
})
