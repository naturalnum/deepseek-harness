/** Agent-scoped durability barrier before every native tool body, including nested calls. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PlatformError } from '../contracts.ts'

/** Persist the recorded call before dispatching any tool that may touch external state.
 * @param agent The resumed Agent whose write handle and scope are owned by the scheduler.
 * @returns Nothing; disposing the Agent scope removes the listener.
 */
export function installDurableToolDispatch(agent: Agent): void {
  agent.ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent !== agent) throw new PlatformError(403, 'session_not_leased')
    exec.signal.throwIfAborted()
    if (!await agent.ctx.sessions.flush(agent.session)) throw new PlatformError(503, 'persistence_unavailable')
    exec.signal.throwIfAborted()
    return next()
  })
}
