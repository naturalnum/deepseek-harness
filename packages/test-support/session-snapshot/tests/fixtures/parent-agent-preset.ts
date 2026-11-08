/** Mount the headless snapshot's parent preset before Agent publication checks. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

export const name = 'parent-agent-preset'
export const inject = ['agentPresets']

/**
 * Register the root Session's initial preset selection.
 * @param ctx - Snapshot composition context with the preset roster.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    // Agent publication already owns its maintenance phase. Select's separate
    // maintenance boundary is for an idle, published agent, so initialize the
    // fixture's known preset within the existing publication boundary instead.
    const preset = await ctx.agentPresets.recompose(agent.ctx, 'parent')
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  }, { prepend: true })
}
