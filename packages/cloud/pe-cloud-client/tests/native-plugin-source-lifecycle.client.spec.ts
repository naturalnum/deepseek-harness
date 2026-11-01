/** Cloud source and original Cordis navigation ownership; no browser/server deployment. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ShellCard } from '../../../client/ui-settings-shell/src/client/ShellCard.tsx'
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

it('publishes actual managed terminal values in the native shell slot and withdraws them with the account', async () => {
  const ctx = new Context(), lifetime = new AbortController(), slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const root = slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' }, 'plugins.item': { kind: 'list', scope: 'root' } } },
  ({ renderSlot }) => { void renderSlot; return null })
  const limits = { timeoutMs: 1234, maxTimeoutMs: 5678, maxOutputBytes: 91011 }
  new TestRemote(ctx, { cloudPlugins: {
    list: async () => ({ ok: true, value: { bundles: [], plugins: [], controls: [], terminal: limits } }),
    current: async () => { throw new Error('No edit') }, change: async () => { throw new Error('No edit') } } })
  const provider = ctx.plugin((scope) => { scope.provide('shellSettingsCard', ShellCard) })
  await provider.await()
  const page = { bootstrap: { capabilities: { configuration: { plugins: [] } } },
    lifetime: { transport: { signal: lifetime.signal } }, assertAccountManagementCurrent: () => { lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin((scope) => { installCloudPluginCatalog(scope, page as never, () => {}) })
  onTestFinished(async () => { lifetime.abort(); root(); await ctx.fiber.dispose() })
  await plugin.await()
  await vi.waitFor(() => { expect(ctx.get('pluginManagerIntegration')).toBeDefined() })
  expect(slots.entries('plugins.item')).toHaveLength(0)
  await ctx.pluginManagerIntegration.read()
  const entries = slots.entries('plugins.item')
  expect(entries.map(row => row.options.id)).toEqual(['shell'])
  const face = entries[0]!.inject!() as { managedMaxTimeoutMs: number; hooks: { shellCard: { getSnapshot(): unknown } } }
  expect(face.managedMaxTimeoutMs).toBe(5678)
  expect(face.hooks.shellCard.getSnapshot()).toMatchObject({ writable: false, timeoutMs: { text: '1234' }, maxOutputBytes: { text: '91011' } })
  await provider.dispose()
  await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(0) })
  const replacement = ctx.plugin((scope) => { scope.provide('shellSettingsCard', ShellCard) })
  await replacement.await()
  await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
  lifetime.abort()
  expect(slots.entries('plugins.item')).toHaveLength(0)
  await expect(ctx.pluginManagerIntegration.read()).rejects.toBeDefined()
  await plugin.dispose()
})
