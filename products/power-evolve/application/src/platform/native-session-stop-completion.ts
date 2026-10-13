/** Account-locked native archive completion, independent of physical worker stop and cleanup evidence. */
import type { PoolClient } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError } from '../contracts.ts'
import type { NativeInputLedgerLimits } from '../native-input-ledger-contracts.ts'
import { readInputHistory } from '../native-input-ledger-records.ts'
import { nativeSessionStopIntent, type NativeSessionStopId } from '../native-session-stop-contracts.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'

/** Complete only the original archival stop after native inputs, boundaries and operation leases are fully settled.
 * The caller holds active account then owned Session locks; this function supplies no new authorization.
 * Pending inputs, an open turn/step, queued/running work, any unended historical attempt or an unreleased
 * Session lease keep the original requested marker and return false. Complete repeats retain the original
 * identity without rewriting its revision. History budgets and malformed native state refuse loudly.
 * Completion records native cleanup only; independent Writer, worker stop and physical cleanup identities
 * and flags remain unchanged and must be proved through their own providers.
 * @param client Caller transaction retaining the account and Session locks until its final clock checks.
 * @param userId Exact authenticated Session owner, never inferred from the stop record.
 * @param sessionId Exact owned Session whose original archival stop is being completed.
 * @param expectedStopId Original requested identity retained by the producer or terminal transaction.
 * @param limits Explicit existing native history budgets, without added defaults.
 * @returns True for that original completed stop, or false while its native cleanup remains unfinished.
 */
export async function completeSessionStopInTransaction(client: PoolClient, userId: string, sessionId: SessionId,
  expectedStopId: NativeSessionStopId,
  limits: Pick<NativeInputLedgerLimits, 'maxHistoryEvents' | 'maxHistoryBytes'>): Promise<boolean> {
  const keys = ['maxHistoryEvents', 'maxHistoryBytes'] as const
  if (keys.some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1) || limits.maxHistoryEvents > 2_147_483_646) {
    throw new Error('Invalid native stop completion limits')
  }
  const owned = await client.query<{ grant_digest: string | null; lease_until: Date | null }>(
    'SELECT grant_digest,lease_until FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [sessionId, userId])
  const session = owned.rows[0]
  if (owned.rowCount !== 1 || !session) throw new PlatformError(404, 'session_not_found')
  const stop = await readSessionStopInTransaction(client, userId, sessionId)
  if (!stop || stop.stopId !== expectedStopId) throw new PlatformError(409, 'native_session_stop_changed')
  const history = await readInputHistory(client, sessionId, limits)
  if (stop.status === 'complete') return true
  const active = await client.query<{ operations: boolean; attempts: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')) AS operations,
    EXISTS(SELECT 1 FROM pe_attempts a JOIN pe_operations o ON o.id=a.operation_id
      WHERE o.session_id=$1 AND a.ended_at IS NULL) AS attempts`, [sessionId])
  const resources = active.rows[0]
  if (!resources) throw new PlatformError(503, 'native_session_stop_invalid')
  if (history.inbox['next-turn'].length !== 0 || history.inbox['next-step'].length !== 0
    || history.turn !== null || history.step !== null || resources.operations || resources.attempts
    || session.grant_digest !== null || session.lease_until !== null) return false
  const complete = nativeSessionStopIntent.parse({ ...stop, status: 'complete' })
  const written = await client.query(`UPDATE pe_native_preferences SET value=$3,revision=revision+1,updated_at=clock_timestamp()
    WHERE user_id=$1 AND namespace=$2 AND value=$4::jsonb RETURNING revision`,
  [userId, `session-archive-stop:${sessionId}`, complete, JSON.stringify(stop)])
  if (written.rowCount !== 1) throw new PlatformError(409, 'native_session_stop_changed')
  return true
}
