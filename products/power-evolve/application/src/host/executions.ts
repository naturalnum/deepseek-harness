/** Agent-scoped cloud command tool; the platform admits and runs it in Agent Sandbox. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const receipt = z.object({ executionId: z.uuid(), state: z.string(), command: z.string(), cwd: z.string() }).passthrough()

/** Register only when the trusted platform has enabled an execution provider. */
export function installExecutionTools(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  if (!grant.executionEnabled) return
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'cloud_exec',
    description: 'Run one Bash command in this conversation\'s authorized cloud Sandbox and persistent workspace. The call returns an execution ID immediately; do not claim it finished. Wait for the trusted platform result in this conversation before deciding the next command. Use this for Git, coding, dependency installation, and tests. Avoid background processes.',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command, at most 8192 characters.' },
      cwd: { type: 'string', description: 'Relative directory inside the persistent workspace; default is its root.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      executionId: { type: 'string', required: true }, state: { type: 'string', required: true },
      command: { type: 'string', required: true }, cwd: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const result = receipt.parse(await runtime.call('/runtime/executions/propose', grant.token, {
        callId: String(exec.callId), command: args.command, cwd: args.cwd ?? '',
      }))
      return { executionId: result.executionId, state: result.state, command: result.command, cwd: result.cwd }
    },
  })))
}
