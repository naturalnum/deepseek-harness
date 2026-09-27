/** Native Session boundary validation, shared by the storage client and platform. */
import { z } from 'zod'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { validateStoredEvents, type SessionHeader } from '@deepseek-ai/dsh-session-persistence'

export const headerSchema = z.object({
  id: z.uuid().transform(SessionId), version: z.literal(SESSION_FORMAT_VERSION),
  createdAt: z.number().int().nonnegative(), isSeeded: z.literal(false),
}).strict()

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
