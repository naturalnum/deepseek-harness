/** Optional reads owned by the admitted page, prepared before the inventory plugin activates. */
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'

/** An account inventory read never resolves a replacement page or the unrestricted profile. */
export interface PluginInventorySettingsIntegration {
  /** @returns Whether this original page still admits reads. */
  readonly isCurrent: () => boolean
  /** @returns The account's actual native inventory; rejection does not fall back to global reads. */
  readonly list: () => Promise<PluginInventorySnapshot>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Original page-owned inventory reads; absent in ordinary native applications. */
    pluginInventorySettingsIntegration: PluginInventorySettingsIntegration
  }
}
