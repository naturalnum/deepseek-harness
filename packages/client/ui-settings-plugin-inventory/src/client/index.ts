/** Read-only Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-modules/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'settings.agentPreset' LocaleNamespaceMap merge, whose
// dictionaries the shipped-preset name resolution below reads.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
// Inline-safe shared fold: shipped ids map to dictionary keys in one home.
import { presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from './locales.ts'
import type {} from './integration.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'
export type { PluginInventorySettingsIntegration } from './integration.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Host plugin inventory copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'modules']

/** Contribute the lazy inventory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const integration = ctx.get('pluginInventorySettingsIntegration')
  let active = true
  ctx.effect(() => () => { active = false }, 'ui-settings-plugin-inventory: admitted reads')
  const isCurrent = (): boolean => active && integration?.isCurrent() !== false
  const register = (scope: ClientContext, list: PluginInventorySettingsTabInjected['list']): void => {
    // Resolved per call over ui-agent-preset's dictionaries, so a language
    // switch re-resolves shipped names; user-authored metadata passes through.
    const agentPresetCopy = ctx.locale.bind('settings.agentPreset')
    const presetName: PluginInventorySettingsTabInjected['presetName'] = preset =>
      presetDisplayText(preset, agentPresetCopy).name
    const injected = (): PluginInventorySettingsTabInjected => ({
      list, presetName,
      ...integration === undefined ? {} : { isCurrent },
      resolveText: text => ctx.locale.resolveText(text),
      hooks: { clientSync: ctx.modules.entries.state },
      retryClient: () => {
        if (!isCurrent()) return
        void ctx.modules.entries.retry().catch((error: unknown) => { ctx.logger.error(error) })
      },
    })

    scope.slots.inject('settings.plugins.tab', () => scope.slots.register({
      name: 'settings.plugins.tab',
      id: 'all',
      order: 10,
      label: () => t('tab'),
      locale: NS,
      inject: injected,
    }, PluginInventorySettingsTab))
  }
  if (integration !== undefined) {
    register(ctx, async () => {
      if (!isCurrent()) throw new Error(t('pageUnavailable'))
      const snapshot = await integration.list()
      if (!isCurrent()) throw new Error(t('pageUnavailable'))
      return snapshot
    })
  } else ctx.inject(['remote', 'remote.pluginInventory'], (scope) => {
    register(scope, async () => {
      const result = await scope.remote.pluginInventory.list()
      if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    })
  })
}
