/** Fixed Agent-local MCP tool; transport, endpoint and credentials remain in the trusted platform. */
import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const TOOL = 'mcp__personal__whoami'
const response = z.object({ toolName: z.literal(TOOL), result: z.string().min(1).max(8192) }).strict()

/** Expose only the connection fixed at acceptance, on the current cloud Agent context. */
export function installPersonalMcpTool(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  const selected = grant.mcpConnections[0]
  if (grant.source !== 'user' || grant.target.kind !== 'cloud' || !selected) return
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: TOOL,
    description: 'Read the current account identity from the approved personal MCP service. This is read-only and needs no execution sandbox.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      result: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute() {
      const value = response.parse(await runtime.call('/runtime/mcp/call', grant.token,
        { connectionId: selected.connectionId, revision: selected.revision }))
      if (Buffer.byteLength(value.result, 'utf8') > 8192) throw new Error('MCP result exceeds its byte limit')
      return { result: value.result }
    },
  })))
}
