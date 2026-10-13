/** Agent-local MCP tools submit bounded Platform requests; remote endpoints and credentials stay in the Platform. */
import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'
import { mcpActionReceipt } from '../mcp-action-contracts.ts'
import { assertMcpToolArguments } from '../mcp-model-tools.ts'

const TOOL = 'mcp__personal__whoami'
const response = z.object({ toolName: z.literal(TOOL), result: z.string().min(1).max(8192) }).strict()

/** Register the immutable admitted tools on this Agent, including successful result continuations.
 * @param agent Current native Agent; its effect scope owns every tool registration.
 * @param grant Platform-issued operation selection and fenced runtime credential.
 * @param runtime Bounded Platform transport; no external MCP client runs in the Host.
 * @param platformOrigin Trusted origin used for human approval links.
 */
export function installRemoteMcpTools(agent: Agent, grant: Grant, runtime: RuntimeScope, platformOrigin: string): void {
  for (const selected of grant.remoteMcpTools) {
    agent.ctx.effect(() => {
      const definition = createMcpToolDefinition(agent.ctx, {
        name: selected.model.name, rawName: selected.raw.name, description: selected.model.description,
        inputSchema: selected.model.parameters,
        // This bridge returns an acceptance receipt; the Platform validates the eventual remote output schema.
        async call(args, execution) {
          execution.signal.throwIfAborted()
          const receipt = mcpActionReceipt.parse(await runtime.call('/runtime/mcp/actions/propose', grant.token,
            { callKey: String(execution.callId), toolName: selected.model.name, arguments: args }, execution.signal))
          const value = { ...receipt, approvalUrl: new URL('/approval', platformOrigin).toString() }
          return { content: [{ type: 'text', text: JSON.stringify(value) }] }
        },
      })
      return agent.ctx.tools.register({
        ...definition,
        async execute(args, execution) {
          // Validate before the upstream adapter can replace a non-object input with an empty object.
          assertMcpToolArguments(selected.raw, args)
          return definition.execute(args, execution)
        },
      })
    })
  }
}

/** Expose only the connection fixed at acceptance, on the current cloud Agent context.
 * @param agent Native Agent whose effect scope owns the tool.
 * @param grant Current operation with the fixed personal connector selection.
 * @param runtime Bounded Platform transport carrying the operation grant.
 */
export function installPersonalMcpTool(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  const selected = grant.mcpConnections[0]
  if (grant.source !== 'user' || !selected) return
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: TOOL,
    description: 'Read the current account identity from the approved personal MCP service. This is read-only and needs no execution sandbox.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      result: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute(_args, exec) {
      const value = response.parse(await runtime.call('/runtime/mcp/call', grant.token,
        { connectionId: selected.connectionId, revision: selected.revision }, exec.signal))
      if (Buffer.byteLength(value.result, 'utf8') > 8192) throw new Error('MCP result exceeds its byte limit')
      return { result: value.result }
    },
  })))
}
