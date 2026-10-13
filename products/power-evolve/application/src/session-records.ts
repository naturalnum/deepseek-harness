/** Native Session boundary validation, shared by the storage client and platform. */
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { type SessionId, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { validateStoredEvents, type SessionHeader } from '@deepseek-ai/dsh-session-persistence'

/** Validate current native headers, retaining official lineage and composition metadata. */
export const headerSchema = z.object({
  id: z.uuid().transform(brandString<SessionId>), version: z.literal(SESSION_FORMAT_VERSION),
  createdAt: z.number().int().nonnegative(), isSeeded: z.boolean(),
  parentSession: z.uuid().transform(brandString<SessionId>).optional(),
  cwd: z.string().refine(isAbsolute).optional(), origin: z.literal('subagent').optional(),
  delegationDepth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), agentPreset: z.string().optional(),
}).strict().transform((value): SessionHeader => ({
  id: value.id, version: value.version, createdAt: value.createdAt, isSeeded: value.isSeeded,
  ...(value.parentSession === undefined ? {} : { parentSession: value.parentSession }),
  ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  ...(value.origin === undefined ? {} : { origin: value.origin }),
  ...(value.delegationDepth === undefined ? {} : { delegationDepth: value.delegationDepth }),
  ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }),
}))

const envelope = z.object({
  seq: z.number().int().nonnegative().transform(SessionSeq),
  time: z.number().int().nonnegative(), type: z.string(), data: z.json(),
}).catchall(z.json())

/** Validate envelopes and the native fail-closed vocabulary before use.
 * @param header - the validated Session metadata.
 * @param input - decoded wire records.
 * @returns adopted native events, retaining their exact log representation.
 */
export function parseEvents(header: SessionHeader, input: unknown): SessionEvent[] {
  const values = z.array(envelope).parse(input)
  return validateStoredEvents(header, values as SessionEvent[])
}
