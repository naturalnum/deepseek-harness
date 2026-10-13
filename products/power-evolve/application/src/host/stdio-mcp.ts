/** Agent-scoped read-only process MCP tool; shared Host never starts the process. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const receipt = z.object({ callId: z.uuid(), state: z.enum(['accepted', 'preparing', 'ready',
  'dispatch-intent', 'running', 'succeeded', 'failed', 'uncertain']),
result: z.string().max(8192).optional(), errorCode: z.string().max(100).optional() }).strict()

/** Register only for a cloud Operation that pinned this user's connection revision.
 * @param agent Native Agent whose effect scope owns the isolated process tool.
 * @param grant Original user operation with its immutable selected connection revision.
 * @param runtime Platform transport observing the tool execution lifetime.
 */
export function installStdioMcpTool(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  const selected = grant.stdioMcpConnections[0]
  if (grant.source !== 'user' || !selected) return
  agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'power-evolve:stdio-mcp-result',
    order: 706, interpolate: false,
    text: 'The process MCP tool returns a durable call receipt. End this turn after an accepted or running receipt. The trusted platform will deliver the result in this Session; do not repeat the call while waiting.',
  }))
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'mcp__stdio__whoami',
    description: 'Read the current account identity through an isolated, short-lived MCP STDIO process. A receipt is not the result; the platform resumes this conversation with the result.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      callId: { type: 'string', required: true }, state: { type: 'string', required: true },
      result: { type: 'string' }, errorCode: { type: 'string' },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const value = receipt.parse(await runtime.call('/runtime/stdio-mcp/call', grant.token,
        { connectionId: selected.connectionId, revision: selected.revision,
          callKey: String(exec.callId) }, exec.signal))
      if (value.result !== undefined && Buffer.byteLength(value.result, 'utf8') > 8192) {
        throw new Error('MCP result exceeds its byte limit')
      }
      return { callId: value.callId, state: value.state,
        ...(value.result === undefined ? {} : { result: value.result }),
        ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }) }
    },
  })))
}
