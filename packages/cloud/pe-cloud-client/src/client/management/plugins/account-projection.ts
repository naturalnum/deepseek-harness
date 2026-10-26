/** Read-only join over the original account policy and native PluginManager read projections. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { ApprovedConfigurationPlugin } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { AccountPluginCard, AccountPluginCatalog, AccountPluginId, PluginManagementInjected } from './types.ts'
import { pluginCategory } from './catalog.ts'

/** Localized display text supplied by the existing account metadata owner. */
export interface AccountPluginText {
  readonly title: string
  readonly description: string
}

/**
 * Join already accepted account reads without treating catalog approval or a Profile dependency as installation.
 * @param approved Original account-approved identities, not an arbitrary plugin catalog.
 * @param bundles Same account/Peer native listBundles result, or undefined when no accepted read exists.
 * @param plugins Same account/Peer native listPlugins result from the same accepted projection, or undefined.
 * @param displayText Existing account metadata owner's localized text resolver.
 * @returns Closed-control cards; actual package availability/version and exact native entry establish installed state.
 */
export function projectApprovedAccountPlugins(
  approved: readonly ApprovedConfigurationPlugin[], bundles: readonly BundleInfo[] | undefined,
  plugins: readonly PluginInfo[] | undefined, displayText: (plugin: ApprovedConfigurationPlugin) => AccountPluginText,
): readonly AccountPluginCard[] {
  return approved.map((plugin): AccountPluginCard => {
    const bundle = bundles?.find(item => item.name === plugin.packageName)
    const entry = plugins?.find(item => item.entryId === plugin.entryId && item.moduleName === plugin.moduleName)
    const text = displayText(plugin)
    // Native "installed" means a Profile dependency declaration; only availability establishes readable package files.
    const installed = bundles === undefined || plugins === undefined ? null : bundle?.availability === 'missing' ? false
      : bundle !== undefined && bundle.version === plugin.packageVersion && entry !== undefined ? true : null
    const enabled = installed !== true || entry === undefined ? null
      : entry.enabled && entry.fiberPhase === 'active' ? true
        : !entry.enabled && entry.fiberPhase === null ? false : null
    return {
      id: brandString<AccountPluginId>(plugin.id), title: text.title, description: text.description,
      packageName: plugin.packageName, moduleName: plugin.moduleName, version: bundle?.version ?? null,
      category: pluginCategory(plugin.moduleName), approved: true, installable: plugin.installable, installed, enabled,
      toggle: 'not-connected', configuration: 'not-connected',
    }
  })
}

/**
 * Pass the existing page-owned stable source to the frozen presentation without constructing a data/save owner.
 * @param catalog Original current-account presentation source, withdrawn with its original page/Peer lifetime.
 * @param refresh Optional existing account reader's explicit refresh; no automatic read or retry is started here.
 * @returns The frozen page's injection with no toggle/configuration write callbacks.
 */
export function readOnlyAccountPluginInjection(
  catalog: ObservableSnapshot<AccountPluginCatalog>, refresh?: () => void,
): PluginManagementInjected {
  return { hooks: { accountPluginCatalog: catalog }, ...refresh === undefined ? {} : { refreshPluginCatalog: refresh } }
}
