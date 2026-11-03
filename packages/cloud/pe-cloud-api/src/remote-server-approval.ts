/** Preserve the native approval request and its audit pair for the exact account tool call. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from './errors.ts'

/** Bind an original tool call to the existing native answerer chain.
 * Under native policy `never`, a mandatory remote ask is rejected by the native owner.
 * No browser decision, preset switch, direct waterfall dispatch or replacement Session is used.
 * @param ctx Original account API/extension scope.
 * @param binding Original runtime-installed graph binding.
 * @param exec Original native tool execution received by its registered body.
 * @param assertCurrent Original business/session admission callback.
 * @returns A one-call asker, or undefined when native approval is unavailable.
 */
export function remoteServerApproval(ctx: Context, binding: AccountBinding, exec: ToolRunContext, assertCurrent: () => void):
  { ask(reason: string): Promise<boolean> } | undefined {
  const approval = ctx.get('approval'), agent = exec.agent
  if (approval === undefined || agent === undefined) return undefined
  const originalApproval: unknown = Reflect.get(approval, symbols.original) ?? approval
  const current = (): void => {
    const selected = ctx.get('approval')
    const selectedOriginal: unknown = selected === undefined ? undefined : Reflect.get(selected, symbols.original) ?? selected
    exec.signal.throwIfAborted(); ctx.fiber.assertActive(); assertCurrent()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding
      || agent.ctx.root !== ctx.root || agent.ctx.get('peAccount') !== binding || ctx.get('agents')?.get(agent.id) !== agent
      || selectedOriginal !== originalApproval) {
      throw new CloudApiError('cloud/stale-generation', 'Remote approval requires the original account Agent and native service.')
    }
  }
  current()
  return { ask: async (reason) => {
    current()
    const outcome = await approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal })
    current()
    return outcome === 'allowed-once'
  } }
}
