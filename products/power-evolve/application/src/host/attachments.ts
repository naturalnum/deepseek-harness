/** Agent-scoped read access to original files committed by the receiving Session. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

const result = z.object({ attachmentId: z.string(), name: z.string(), bytes: z.number().int().min(0),
  offset: z.number().int().positive(), text: z.string(), lines: z.number().int().nonnegative(), eof: z.boolean() }).strict()
const copied = z.object({ path: z.string(), size: z.number().int().nonnegative(), mime: z.string(), revision: z.string() }).strict()
const attachmentOutputSchema = {
  type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false,
} as const
const attachmentOutput = {
  schema: attachmentOutputSchema,
  render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }],
}

/** Resolve only the immutable upload accepted by the receiving Session. */
function acceptedAttachment(grant: Grant, attachmentId: string, name: string): Grant['attachments'][number] {
  const file = grant.attachments.find(ref => ref.attachmentId === attachmentId && ref.name === name)
  if (file === undefined) throw new Error('File was not accepted by this Session')
  return file
}

/** Register a bounded file reader and logged metadata for this Session's accepted immutable uploads.
 * @param agent Current leased Agent whose effects own the tool and instruction section.
 * @param grant Platform-issued upload metadata belonging to this exact Session.
 * @param runtime Bounded transport carrying the current operation lease.
 */
export function installAttachmentTools(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  if (grant.attachments.length === 0) return
  agent.ctx.effect(() => agent.ctx.systemPrompt.section({
    name: 'power-evolve:uploaded-files', order: 704, interpolate: false,
    text: 'Uploaded files have no Host-local readable path. The cloud_file_read tool can read their verified original UTF-8 text through the trusted Platform. '
      + 'Use the exact attachmentId and name from this Session-only catalog. cloud_file_copy creates a writable Workspace copy for Office or authorized cloud execution; the original remains private and read-only. Never claim to have read bytes from metadata alone.\n'
      + JSON.stringify(grant.attachments),
  }))
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'cloud_file_read', description: 'Read verified original UTF-8 lines from a file uploaded and accepted in this Session. Does not start a Sandbox or modify the original file.',
    parameters: {
      attachmentId: { type: 'string', required: true, description: 'Exact sha256 attachment identity from the uploaded-files catalog.' },
      name: { type: 'string', required: true, description: 'Exact stored display name from the same catalog entry.' },
      offset: { type: 'number', description: 'One-based starting line; default 1.' },
      limit: { type: 'number', description: 'Maximum lines, from 1 to 200; default 200. Output is also capped at 32 KiB.' },
    },
    output: attachmentOutput,
    async execute(args, exec) {
      const file = acceptedAttachment(grant, args.attachmentId, args.name)
      const value = result.parse(await runtime.call('/runtime/attachments/read', grant.token,
        { file, offset: args.offset ?? 1, limit: args.limit ?? 200 }, exec.signal))
      return { result: JSON.stringify(value) }
    },
  })))
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'cloud_file_copy', description: 'Create a writable copy of an accepted original upload inside this Session Workspace for Office or cloud execution. Never overwrites an existing different file.',
    parameters: {
      attachmentId: { type: 'string', required: true, description: 'Exact attachment identity from the uploaded-files catalog.' },
      name: { type: 'string', required: true, description: 'Exact stored display name from the same entry.' },
      path: { type: 'string', required: true, description: 'Canonical relative destination inside the receiving Workspace, at most 512 characters.' },
    },
    output: attachmentOutput,
    async execute(args, exec) {
      const file = acceptedAttachment(grant, args.attachmentId, args.name)
      const value = copied.parse(await runtime.call('/runtime/attachments/copy', grant.token,
        { file, callId: String(exec.callId), path: args.path }, exec.signal))
      return { result: JSON.stringify(value) }
    },
  })))
}
