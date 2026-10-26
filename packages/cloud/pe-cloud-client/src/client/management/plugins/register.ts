/** Optional thin contribution owned by the existing Cloud page; no Loader or sidebar entry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { PluginManagementPage } from './PluginManagementPage.tsx'
import { PLUGIN_MANAGEMENT_NAMESPACE, pluginManagementDictionaries } from './locales.ts'
import type { PluginManagementInjected } from './types.ts'

/**
 * Contribute one account page through the existing native main slot.
 * @param owner Captured Cloud dependency fiber; its disposal withdraws the page and dictionaries.
 * @param panelKey Root-owned main/sidebar routing key, shared with its sidebar registration.
 * @param injected Stable current-account data source and authorized callbacks; never a global manager.
 * @returns Synchronous withdrawal of the original main contribution, wait and dictionaries.
 */
export function registerCloudPluginManagement(owner: Context, panelKey: string, injected: () => PluginManagementInjected): () => void {
  const removeCopy = owner.effect(() => owner.locale.register(PLUGIN_MANAGEMENT_NAMESPACE, pluginManagementDictionaries), 'pe-cloud-client: plugin management copy')
  let removeMain: (() => void) | undefined
  const stopWaiting = owner.slots.inject('main', () => {
    const remove = owner.slots.register({
      name: 'main', key: panelKey, locale: PLUGIN_MANAGEMENT_NAMESPACE, inject: injected,
    }, PluginManagementPage)
    removeMain = remove
    return () => { if (removeMain === remove) removeMain = undefined; remove() }
  })
  return () => { removeMain?.(); removeMain = undefined; stopWaiting(); void removeCopy() }
}
