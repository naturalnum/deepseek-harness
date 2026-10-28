/** Optional read-only composition summaries owned by the original admitted page. */
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'

type InventoryPreset = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
/** Public module and state facts only; complete configuration and disabled expressions are excluded. */
export type AgentPresetCompositionEntry = Pick<InventoryPreset['rows'][number], 'entryId' | 'moduleName' | 'enabled' | 'fiberPhase'>

/** One actual preset and its public composition, without raw configuration text. */
export type AgentPresetCompositionSummary = Pick<InventoryPreset, 'id' | 'name' | 'isDefault' | 'broken'>
  & Pick<AgentPresetRow, 'description'> & {
    readonly rows: readonly AgentPresetCompositionEntry[]
  }

/** Preparation precedes plugin activation; presence makes all preset surfaces read-only. */
export interface AgentPresetSettingsIntegration {
  /** @returns Whether this original page still admits reads. */
  readonly isCurrent: () => boolean
  /** @returns Actual account compositions; rejection never reads the global profile. */
  readonly list: () => Promise<readonly AgentPresetCompositionSummary[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Original page-owned preset composition reads; absent in ordinary native applications. */
    agentPresetSettingsIntegration: AgentPresetSettingsIntegration
  }
}
