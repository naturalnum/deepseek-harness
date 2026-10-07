/** Agent-local frozen STDIO declarations submit durable proposals; the Host never starts a provider. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { stdioActionRequestV2, stdioDigestV2, stdioExecutionRefV2 } from '@power-evolve/contracts/stdio-mcp'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import { assertStdioToolArgumentsV2 } from '../stdio-v2-model-tools.ts'
import type { StdioOperationConnectionV2 } from '../stdio-v2-operation-contracts.ts'
import type { StdioCallReceiptV2 } from '../platform/stdio-v2-call-admission.ts'
import type RuntimeScope from './scope.ts'

const receipt: z.ZodType<StdioCallReceiptV2> = z.object({
  actionId: stdioActionRequestV2.shape.actionId, executionRef: stdioExecutionRefV2.options[0], taskDigest: stdioDigestV2,
  state: z.enum(['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping', 'blocked',
    'succeeded', 'failed', 'cancelled', 'rejected', 'expired']),
}).strict()

/** Register only this Agent's immutable Cloud declarations and acceptance-receipt presentation.
 * @param agent Native Agent whose effect scope owns the tools and waiting instruction.
 * @param grant Original execution target and operation bearer, never connector credentials.
 * @param selections Complete validated groups frozen at admission, including the ordered raw catalog and SDK limits.
 * @param runtime Bounded Platform transport; each execution submits once with its native call ID and signal.
 * @param platformOrigin Trusted configured origin for the human approval console.
 */
export function installStdioOperationToolsV2(agent: Agent, grant: Pick<Grant, 'token' | 'target'>,
  selections: readonly StdioOperationConnectionV2[], runtime: Pick<RuntimeScope, 'call'>, platformOrigin: string): void {
  if (grant.target.kind !== 'cloud') return
  const groups = structuredClone(selections).filter(selected => selected.scopeBinding.kind === 'cloud')
  if (!groups.some(selected => selected.tools.length > 0)) return
  const token = grant.token, approvalUrl = new URL('/approval', platformOrigin).toString()
  agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'power-evolve:stdio-v2-result',
    order: 707, interpolate: false,
    text: 'STDIO MCP tools return durable acceptance receipts, not provider results. End this turn after a receipt and wait for the trusted Platform continuation in this Session. Do not repeat a pending or uncertain call. If approval is required, show the trusted approval URL and wait; the Host cannot approve or start the provider.',
  }))
  for (const selected of groups) {
    for (const [index, tool] of selected.tools.entries()) {
      const raw = selected.rawCatalog[index]
      if (!raw || raw.name !== tool.rawName) throw new TypeError('stdio_v2_operation_model_map_invalid')
      agent.ctx.effect(() => {
        const definition = createMcpToolDefinition(agent.ctx, {
          name: tool.model.name, rawName: raw.name, description: tool.model.description, inputSchema: tool.model.parameters,
          // Native output is the committed receipt; provider output arrives through the formal Session continuation.
          async call(args, execution) {
            execution.signal.throwIfAborted()
            const accepted = receipt.parse(await runtime.call('/runtime/stdio-v2/calls/propose', token,
              { callKey: String(execution.callId), toolName: tool.model.name, arguments: args }, execution.signal))
            return { content: [{ type: 'text', text: JSON.stringify({ ...accepted, approvalUrl }) }] }
          },
        })
        return agent.ctx.tools.register({ ...definition,
          async execute(args, execution) {
            // Validate original model JSON before the upstream adapter's non-object fallback.
            assertStdioToolArgumentsV2(raw, args, selected.limits)
            return definition.execute(args, execution)
          },
        })
      })
    }
  }
}
