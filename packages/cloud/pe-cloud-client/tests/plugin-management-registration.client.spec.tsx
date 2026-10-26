// @vitest-environment jsdom
/** Real Cordis contribution lifetimes: main declaration replacement and owner unload retire the actual entries. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, onTestFinished, vi } from 'vitest'
import { registerCloudPluginManagement } from '../src/client/management/plugins/register.ts'
import { PluginManagementPage } from '../src/client/management/plugins/PluginManagementPage.tsx'
import { PLUGIN_MANAGEMENT_NAMESPACE, pluginManagementDictionaries } from '../src/client/management/plugins/locales.ts'
import type { AccountPluginCatalog, PluginManagementInjected } from '../src/client/management/plugins/types.ts'

const panelKey = 'cloud-plugin-registration-test'
function MainHost({ renderSlot }: PropsRenderSlots<'main'>) {
  return renderSlot('main', {}, { entryKey: panelKey })
}
async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx); locale.setLocale('en'); ctx.provide('locale', locale)
  const snapshot: AccountPluginCatalog = { phase: 'unavailable', plugins: [], refreshing: false }
  const source = { getSnapshot: vi.fn(() => snapshot), subscribe: vi.fn(() => () => {}) }
  const injected = vi.fn((): PluginManagementInjected => ({ hooks: { accountPluginCatalog: source } }))
  const mount = () => ctx.plugin({
    name: 'cloud-plugin-page-test-owner', inject: ['slots', 'locale'],
    apply(owner: Context) { registerCloudPluginManagement(owner, panelKey, injected) },
  })
  const declare = () => ctx.slots.register({
    name: 'root', children: { main: { kind: 'keyed', scope: 'root' } },
  }, MainHost)
  return { ctx, locale, source, injected, mount, declare, t: locale.bind(PLUGIN_MANAGEMENT_NAMESPACE) }
}

it('follows main declaration replacement and releases page and both dictionaries before owner remount', async () => {
  const f = await fixture(), firstOwner = f.mount(); await firstOwner.await()
  expect(f.ctx.slots.entries('main')).toEqual([])
  expect(f.t('knownStateRequired')).toBe(pluginManagementDictionaries.en.knownStateRequired)
  const collapse = f.declare()
  expect(f.ctx.slots.entries('main')).toHaveLength(1)
  const firstEntry = f.ctx.slots.entries('main')[0]!
  expect(firstEntry.options.key).toBe(panelKey)
  expect(firstEntry.locale).toBe(PLUGIN_MANAGEMENT_NAMESPACE)
  expect(firstEntry.component).toBe(PluginManagementPage)
  expect(f.injected).not.toHaveBeenCalled()
  expect(f.source.getSnapshot).not.toHaveBeenCalled(); expect(f.source.subscribe).not.toHaveBeenCalled()

  collapse()
  expect(f.ctx.slots.entries('main')).toEqual([])
  // The contributor still owns its dictionaries while the frame declaration is absent.
  f.locale.setLocale('zh')
  expect(f.t('knownStateRequired')).toBe(pluginManagementDictionaries.zh.knownStateRequired)
  f.declare()
  expect(f.ctx.slots.entries('main')).toHaveLength(1)
  expect(f.ctx.slots.entries('main')[0]).not.toBe(firstEntry)

  await firstOwner.dispose()
  expect(f.ctx.slots.entries('main')).toEqual([])
  expect(f.t('knownStateRequired')).toBe('knownStateRequired')
  f.locale.setLocale('en')
  expect(f.t('knownStateRequired')).toBe('knownStateRequired')

  const replacement = f.mount(); await replacement.await()
  expect(f.ctx.slots.entries('main')).toHaveLength(1)
  expect(f.ctx.slots.entries('main')[0]).not.toBe(firstEntry)
  expect(f.t('knownStateRequired')).toBe(pluginManagementDictionaries.en.knownStateRequired)
  await replacement.dispose()
  expect(f.ctx.slots.entries('main')).toEqual([])
  expect(f.t('knownStateRequired')).toBe('knownStateRequired')
})

it('does not resurrect a disposed waiting contributor when main is declared later', async () => {
  const f = await fixture(), waiting = f.mount(); await waiting.await()
  await waiting.dispose()
  expect(f.t('knownStateRequired')).toBe('knownStateRequired')
  const collapse = f.declare()
  expect(f.ctx.slots.entries('main')).toEqual([])
  const replacement = f.mount(); await replacement.await()
  expect(f.ctx.slots.entries('main')).toHaveLength(1)
  collapse(); expect(f.ctx.slots.entries('main')).toEqual([])
  await replacement.dispose()
  f.declare(); expect(f.ctx.slots.entries('main')).toEqual([])
  expect(f.source.getSnapshot).not.toHaveBeenCalled(); expect(f.source.subscribe).not.toHaveBeenCalled()
})
