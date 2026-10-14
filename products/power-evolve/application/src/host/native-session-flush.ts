/** Native unpublished setup commits only its explicit new events through the original acquired write handle. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { PlatformError } from '../contracts.ts'
import PlatformPersistence from './persistence.ts'

/** Flush a live Session through its Store, or explicit unpublished setup events through its captured PG handle.
 * @param ctx Caller with native Session Store and Platform persistence injection.
 * @param session Exact factory-owned Session; unpublished setup has not entered the Store yet.
 * @param appended New events returned directly by setup appends, never a synchronous history scan.
 * @returns Completion after original durability acknowledgement; a missing write handle refuses publication.
 */
export async function flushNativeSession(ctx: Context, session: Session, appended: readonly SessionEvent[] = []): Promise<void> {
  if (ctx.sessions.get(session.id) === session) { await ctx.sessions.flush(session); return }
  if (!(ctx.sessionPersistence instanceof PlatformPersistence)) throw new PlatformError(403, 'native_persistence_missing')
  await ctx.sessionPersistence.flushUnpublished(session.id, appended)
}
