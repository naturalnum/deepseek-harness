/** Account-locked archival stop records in the existing private preference table. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError } from '../contracts.ts'
import { nativeSessionStopId, nativeSessionStopIntent, type NativeSessionStopIntent } from '../native-session-stop-contracts.ts'

/** Read the original stop purpose without minting a grant or deriving completion from visibility.
 * @param client Caller transaction holding the active account and owned Session locks.
 * @param userId Exact current Session owner.
 * @param sessionId Exact owned Session whose archival stop is being read.
 * @returns Its validated original stop or absence; malformed persisted state refuses.
 */
export async function readSessionStopInTransaction(client: PoolClient, userId: string,
  sessionId: SessionId): Promise<NativeSessionStopIntent | undefined> {
  const row = (await client.query<{ value: unknown }>(`SELECT value FROM pe_native_preferences
    WHERE user_id=$1 AND namespace=$2`, [userId, `session-archive-stop:${sessionId}`])).rows[0]
  if (!row) return undefined
  const parsed = nativeSessionStopIntent.safeParse(row.value)
  if (!parsed.success || parsed.data.sessionId !== sessionId) throw new PlatformError(503, 'native_session_stop_invalid')
  return parsed.data
}

/** Issue an archival stop once, retaining an unfinished purpose even after the Session is unarchived.
 * @param client Caller transaction holding the account update and owned Session locks before the archive write.
 * @param userId Exact current Session owner.
 * @param sessionId Exact Session already verified by the archive transaction.
 * @returns Original requested stop, or a fresh identity after the preceding stop completed.
 */
export async function requestSessionStopInTransaction(client: PoolClient, userId: string,
  sessionId: SessionId): Promise<NativeSessionStopIntent> {
  const prior = await readSessionStopInTransaction(client, userId, sessionId)
  if (prior?.status === 'requested') return prior
  const value = nativeSessionStopIntent.parse({ version: 1, purpose: 'archive', sessionId,
    stopId: nativeSessionStopId.parse(randomUUID()), status: 'requested' })
  await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)
    ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,
      revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`,
  [userId, `session-archive-stop:${sessionId}`, value])
  return value
}
