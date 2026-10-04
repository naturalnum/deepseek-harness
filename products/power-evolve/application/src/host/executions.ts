/** Agent-scoped command tool; the Platform admits it for the operation's selected target. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const receipt = z.object({ executionId: z.uuid(), state: z.string(), command: z.string(), cwd: z.string() }).passthrough()

/** Register only when the trusted platform has enabled an execution provider. */
export function installExecutionTools(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  if (grant.target.kind === 'cloud' && !grant.executionEnabled) return
  const desktop = grant.target.kind === 'desktop'
  agent.ctx.effect(() => agent.ctx.systemPrompt.section({
    name: 'power-evolve:execution-continuation', order: 705, interpolate: false,
    text: 'Execution tools return a durable acceptance receipt before the command finishes. After a queued or running receipt, end this turn with one brief status. The trusted platform will automatically deliver the command result as a new message and resume this Session; do not poll with another command, retry the write, or ask the user to notify you. Only after that result arrives should you inspect it and decide the next command. Never claim a test passed from an acceptance receipt.',
  }))
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: desktop ? 'desktop_exec' : 'cloud_exec',
    description: desktop
      ? 'Run one Bash command on the user-selected desktop device. Its locally authorized project directory is mounted at /workspace in the local container, with persistent Home at /home/agent and selected read-only skill packages at /opt/power-evolve/skills/sha256/<packageDigest>/skill; read each selected skill for its exact package path. A queued receipt is not a result: end this turn and wait for the trusted platform to resume the Session automatically. Do not poll or issue another command until its result arrives. Cloud files are separate.'
      : 'Run one Bash command in this conversation\'s authorized cloud Sandbox and persistent workspace. A queued receipt is not a result: end this turn and wait for the trusted platform to resume the Session automatically. Do not poll or issue another command until its result arrives. Use this for Git, coding, dependency installation, and tests. Avoid background processes.',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command, at most 8192 characters.' },
      cwd: { type: 'string', description: 'Relative directory inside the persistent workspace; default is its root.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      executionId: { type: 'string', required: true }, state: { type: 'string', required: true },
      command: { type: 'string', required: true }, cwd: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const result = receipt.parse(await runtime.call(desktop ? '/runtime/desktop-executions/propose' : '/runtime/executions/propose', grant.token, {
        callId: String(exec.callId), command: args.command, cwd: args.cwd ?? '',
      }))
      return { executionId: result.executionId, state: result.state, command: result.command, cwd: result.cwd }
    },
  })))
}
