import type { AgentPresetDocument, AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { Context } from '@deepseek-ai/cordis'

/** Optional read-only source for deployments that restrict preset selection. */
export interface AgentPresetIntegration {
  /** Read the deployment's actual roster. */
  list(): Promise<AgentPresetRoster>
  /** Read an account-visible composition for an actual roster entry. */
  read(id: string): Promise<AgentPresetDocument>
}

declare module '@deepseek-ai/cordis' {
  interface Context { agentPresetIntegration?: AgentPresetIntegration }
}

/** Resolve an optional integration without requiring its service injection.
 * @param ctx Original native controller context.
 * @returns Account integration when available.
 */
export function presetIntegrationOf(ctx: Context): AgentPresetIntegration | undefined {
  return typeof ctx.get === 'function' ? ctx.get('agentPresetIntegration') : ctx.agentPresetIntegration
}
