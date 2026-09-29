/** Agent-scoped connector tools; requests cross the trusted platform boundary. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const note = z.object({ actionId: z.uuid(), owner: z.uuid(), text: z.string(), createdAt: z.string() }).strict()
const noteList = z.object({ items: z.array(note).max(100) }).strict()
const receipt = z.object({ actionId: z.uuid(), state: z.string(), text: z.string() }).passthrough()

/** Register only on this Agent's child context, never on the shared host root. */
export function installConnectorTools(agent: Agent, grant: Grant, runtime: RuntimeScope, platformOrigin: string): void {
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'trial_notes_list',
    description: 'List this user\'s notes from the controlled remote trial API. This is a read-only network call and needs no sandbox.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        actionId: { type: 'string', required: true }, owner: { type: 'string', required: true },
        text: { type: 'string', required: true }, createdAt: { type: 'string', required: true },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: value.items.length
      ? value.items.map(item => `${item.text} (${item.createdAt})`).join('\n') : 'No notes found.' }] },
    async execute() { return noteList.parse(await runtime.call('/runtime/connectors/notes', grant.token, {})) },
  })))
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'trial_notes_append',
    description: 'Propose one note for this user in the controlled remote trial API. The call only saves an approval request; it does not write the note. Tell the user to review the exact text in the trusted approval page. Do not repeat a pending request.',
    parameters: { text: { type: 'string', required: true, description: 'The exact note text to submit for human approval, up to 1000 characters.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      actionId: { type: 'string', required: true }, state: { type: 'string', required: true },
      text: { type: 'string', required: true }, approvalUrl: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const response = receipt.parse(await runtime.call('/runtime/connectors/prepare', grant.token, {
        callId: String(exec.callId), text: args.text,
      }))
      return { actionId: response.actionId, state: response.state, text: response.text,
        approvalUrl: new URL('/approval', platformOrigin).toString() }
    },
  })))
}
