/** Convert an approved account Remote's qualified native read into presentation data. */
import { ClientFailure } from '../../errors.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountPluginCard, AccountPluginId } from './types.ts'
import type { AccountPluginText } from './account-projection.ts'
import { type AccountPluginEditState } from './plugin-edit.ts'
import type { BootstrapPlugin } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { pluginCategory } from './catalog.ts'

/**
 * Present native entry or bundle facts without treating readable files, profile dependency and selection as one state.
 * @param state Accepted current/applied facts from the original cloudPlugins namespace, never bootstrap approval rows.
 * @param text Existing metadata owner's localized title and description.
 * @param controls Actual presentation-owner operation readiness; callbacks remain independently required by the page.
 * @param approval Original bootstrap row, preserving its actual installation capability.
 * @returns Approved entry or bundle card; absent native facts remain unknown.
 */
export function pluginCardFromCurrent(state: AccountPluginEditState, text: AccountPluginText,
  controls: Pick<AccountPluginCard, 'toggle' | 'configuration'>, approval: BootstrapPlugin): AccountPluginCard {
  if (state.selectionTarget.kind === 'bundle') {
    const bundle = state.bundle
    if (bundle === undefined || state.plugin !== undefined || bundle.name !== state.selectionTarget.name) throw new ClientFailure('closed')
    return { id: brandString<AccountPluginId>(state.id), title: text.title, description: text.description,
      packageName: bundle.name, moduleName: null, version: bundle.version ?? null, category: pluginCategory(bundle.name),
      approved: true, installed: bundle.installed, enabled: null, selected: bundle.enabled, availability: bundle.availability,
      installable: approval.installable, selectionTarget: state.selectionTarget, operations: state.operations, maxImpact: state.maxImpact,
      toggle: !approval.installable ? 'not-approved' : !state.operations.includes('selected') ? 'read-only'
        : bundle.availability === 'missing' ? 'not-installed' : bundle.error !== undefined || bundle.readOnlyReason !== undefined
          ? 'read-only' : controls.toggle,
      configuration: 'read-only' }
  }
  const plugin = state.plugin
  if (plugin === undefined || state.bundle !== undefined) throw new ClientFailure('closed')
  return { id: brandString<AccountPluginId>(state.id), title: text.title, description: text.description,
    packageName: plugin.moduleName, moduleName: plugin.moduleName, version: null,
    category: pluginCategory(plugin.moduleName), approved: true, installed: true, enabled: plugin.enabled,
    installable: approval.installable, selectionTarget: state.selectionTarget, operations: state.operations, maxImpact: state.maxImpact,
    selected: null,
    toggle: !approval.toggleable ? 'not-approved' : state.operations.includes('enabled') ? controls.toggle : 'read-only',
    configuration: state.operations.includes('configure') && state.configuration.fields.length > 0 ? controls.configuration : 'read-only' }
}
