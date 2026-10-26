/** Purpose classification and filtering for the account plugin view. */
import type { AccountPluginCard, PluginCategory } from './types.ts'

/**
 * Classify stable module identities independently of translated display names.
 * @param identity Original module or contribution identity.
 * @returns The matching purpose category, or other when no supported purpose matches.
 */
export function pluginCategory(identity: string): PluginCategory {
  if (/(?:terminal|shell|bash|sandbox)/u.test(identity)) return 'execution'
  if (/(?:agent|loop|plan|goal)/u.test(identity)) return 'agents'
  if (/(?:search|browser|fetch)/u.test(identity)) return 'search'
  if (/(?:mcp|connector|integration|power-evolve\/host)/u.test(identity)) return 'integrations'
  return 'other'
}

/**
 * Apply the page's search, stable category and known-installed filters without changing account data.
 * @param plugins Current account rows, already localized by their owner.
 * @param query Search text entered on this page.
 * @param category Selected purpose, or all.
 * @param installedOnly Whether unknown and uninstalled rows are hidden.
 * @returns Matching rows in the owner's stable order.
 */
export function filterPlugins(plugins: readonly AccountPluginCard[], query: string, category: PluginCategory | 'all', installedOnly: boolean): readonly AccountPluginCard[] {
  const normalized = query.trim().toLocaleLowerCase()
  return plugins.filter(plugin => (!installedOnly || plugin.installed === true)
    && (category === 'all' || plugin.category === category)
    && `${plugin.title} ${plugin.description} ${plugin.packageName} ${plugin.moduleName ?? ''}`.toLocaleLowerCase().includes(normalized))
}
