/** Remote execution admits only the original Standard composition and its committed selection. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { AccountRuntimeError } from './errors.ts'

/** Recheck Standard after the caller's original account/project admission.
 * @param ctx Original account effect scope.
 * @param agent Original registry-minted tool Agent.
 */
export function assertStandardRemoteAgent(ctx: Context, agent: Agent): void {
  const presets = ctx.get('agentPresets'), projections = ctx.get('sessionProjections')
  if (presets === undefined || projections === undefined
    || presets.composedPreset(agent.ctx) !== 'standard'
    || projections.stateOf(agent.session, 'agentPreset') !== 'standard') {
    throw new AccountRuntimeError('cloud/account-unavailable', 'Remote execution requires the original Standard composition.')
  }
}
