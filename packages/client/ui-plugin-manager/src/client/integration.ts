/** Optional account-specific data and action source for the native plugin manager. */
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'

/** The original manager UI owns presentation; an integration owns admitted reads and writes. */
export interface PluginManagerIntegration {
  /** Whether the original install and uninstall controls are available. */
  readonly install: boolean
  /** Read actual manager data and refresh the integration's current permissions.
   * @returns Current native bundle and entry inventories.
   */
  read(): Promise<{ readonly bundles: readonly BundleInfo[]; readonly plugins: readonly PluginInfo[] }>
  /** Check the current account's bundle control.
   * @param name Native bundle name.
   * @returns Whether its selection may be changed.
   */
  canSetBundle(name: string): boolean
  /** Check the current account's entry control.
   * @param id Native entry id.
   * @returns Whether its activation may be changed.
   */
  canSetEntry(id: string): boolean
  /** Apply one allowed bundle change, or reject without claiming success.
   * @param name Native bundle name.
   * @param enabled Requested selection.
   */
  setBundle(name: string, enabled: boolean): Promise<void>
  /** Apply one allowed entry change, or reject without claiming success.
   * @param id Native entry id.
   * @param enabled Requested activation.
   */
  setEntry(id: string, enabled: boolean): Promise<void>
}

declare module '@deepseek-ai/cordis' { interface Context { pluginManagerIntegration: PluginManagerIntegration } }
