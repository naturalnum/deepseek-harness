/** Native tool consumers; account admission, credentials and actual process ownership remain injected original capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AccountRemoteServers, RemoteServer } from './account.ts'
import type { ApprovalAsker } from './gate.ts'
import type { RemoteExecOutcome } from './types.ts'
import { PROBE_SCRIPT } from './probe.ts'

/** Actual native tool dependencies; no model JSON supplies any collaborator. */
export interface RemoteToolPorts {
  readonly maxReplyBytes: number
  assertCurrent(exec: ToolRunContext): void
  approval(exec: ToolRunContext): ApprovalAsker | undefined
  run(exec: ToolRunContext, target: RemoteServer, command: string, current: () => void, probe: boolean): Promise<RemoteExecOutcome>
}
/** Install and withdraw the two original upstream tools through native registration effects.
 * @param ctx Account Loader effect scope.
 * @param collection Same account's current collection.
 * @param ports Original permissions, execution and finite result bound.
 */
export function installRemoteServerTools(ctx: Context, collection: AccountRemoteServers, ports: RemoteToolPorts): void {
  const output = { schema: { type: 'object' as const, additionalProperties: false,
    properties: { detail: { type: 'string' as const, required: true as const }, ran: { type: 'boolean' as const,
      required: true as const } } },
  render: (_args: object, value: { detail: string; ran: boolean }) => [{ type: 'text' as const, text: value.detail }] }
  const perform = async (server: string, command: string, exec: ToolRunContext, probe: boolean) => {
    ports.assertCurrent(exec)
    const result = await collection.execute(server, command, ports.approval(exec), exec.signal,
      (target, _signal, current) => ports.run(exec, target, command, current, probe))
    ports.assertCurrent(exec)
    let detail: string
    if (result.outcome === undefined) detail = `Not run: ${result.decision.reason}`
    else {
      const value = result.outcome
      if (probe) collection.observe(server, value)
      detail = JSON.stringify(value)
      if (value.kind === 'timeout' || value.kind === 'cancelled') {
        detail += '\nThe local SSH operation stopped. Remote descendants may still be running.'
      }
    }
    const value = { detail, ran: result.outcome !== undefined }
    if (Buffer.byteLength(JSON.stringify(value)) > ports.maxReplyBytes) throw new Error('cloud/remote-reply-too-large')
    return value
  }
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'remote_exec',
    description: 'Execute one command on the remote server reference selected by the user. Copy the exact reference from the server mention. '
      + 'Mandatory or high-risk requests use human approval. Native never policy refuses those requests; use an existing permission setting that permits asking. '
      + 'Cancellation stops the local SSH operation and does not prove remote descendant termination.',
    parameters: { server: { type: 'string', required: true, description: 'Exact current server reference from the selected mention.' },
      command: { type: 'string', required: true, description: 'One command passed verbatim to the remote shell.' } },
    output, execute: (args, exec) => perform(args.server, args.command, exec, false),
    presentCall: args => ({ card: 'terminal', title: 'remote_exec', command: args.command }),
  })), 'remote-server: native remote_exec')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'remote_server_info',
    description: 'Collect current hostname, OS, CPU, memory, disk and uptime from the selected remote server over SSH. '
      + 'Use the exact server reference from the mention. The original approval and cancellation rules apply.',
    parameters: { server: { type: 'string', required: true, description: 'Exact current server reference from the selected mention.' } },
    output, execute: (args, exec) => perform(args.server, PROBE_SCRIPT, exec, true),
    presentCall: () => ({ card: 'terminal', title: 'remote_server_info' }),
  })), 'remote-server: native remote_server_info')
}
