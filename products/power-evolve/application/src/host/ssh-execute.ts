/** An Agent proposes an exact SSH command; only the trusted approval and Runner execute it. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const receipt = z.object({ actionId: z.uuid(), state: z.enum(['pending', 'rejected', 'approved',
  'succeeded', 'failed', 'uncertain', 'cancelled']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  callId: z.uuid().optional(), errorCode: z.string().max(100).optional() }).strict()

/** Install only on this Agent's child context for its pinned cloud connections. */
export function installSshExecuteTool(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  if (grant.source !== 'user' || grant.target.kind !== 'cloud' || !grant.sshConnections.length) return
  const connections = grant.sshConnections.map(item =>
    `${item.connectionId}@${item.username}@${item.host}:${item.port}`).join('; ')
  agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'power-evolve:ssh-execute-approval',
    order: 707, interpolate: false,
    text: `The SSH tool only proposes one exact command. It does not execute until the user reviews and approves it on the trusted platform page. After a pending receipt, end this turn and do not repeat the proposal. The trusted platform will deliver the outcome in this Session. Pinned connection IDs and destinations: ${connections}`,
  }))
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'ssh_execute_propose',
    description: 'Propose one exact SSH command for approval. Use one pinned connection ID from the system instructions. The receipt is not execution; the user reviews the exact command on the trusted approval page.',
    parameters: { connectionId: { type: 'string', required: true,
      description: 'One exact connection ID listed in this tool description.' },
    command: { type: 'string', required: true, description: 'The exact SSH command to review, at most 16 KiB.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      actionId: { type: 'string', required: true }, state: { type: 'string', required: true },
      fingerprint: { type: 'string', required: true }, approvalUrl: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const selected = grant.sshConnections.find(value => value.connectionId === args.connectionId)
      if (!selected || !args.command || args.command.includes('\0')
        || Buffer.byteLength(args.command) > 16_384) throw new Error('SSH command or connection invalid')
      const value = receipt.parse(await runtime.call('/runtime/ssh-execute/propose', grant.token, {
        callKey: String(exec.callId), connectionId: selected.connectionId,
        connectionRevision: selected.revision, credentialRevision: selected.credentialRevision,
        command: args.command,
      }))
      return { actionId: value.actionId, state: value.state, fingerprint: value.fingerprint,
        approvalUrl: new URL('/approval', runtime.config.platformUrl).toString() }
    },
  })))
}
