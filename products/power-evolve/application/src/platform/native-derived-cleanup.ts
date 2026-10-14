/** Expired native derivations close from their committed logs without restarting an Agent or replaying a prompt. */
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { PoolClient } from 'pg'
import { appendOwnedEvents, type OwnedAppendState } from './native-owned-append.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { transaction } from './database.ts'
import type { EventLimits } from './events.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'
import { completeSessionStopInTransaction } from './native-session-stop-completion.ts'
import type { TaskStore } from './tasks.ts'

/** Reconcile only an authenticated account's expired, unowned interactive and native child operations.
 * @param tasks Platform Session pool and original task authority.
 * @param owner Fixed account whose Runtime credential is rechecked under an account update lock.
 * @param limits Original native event/history budgets.
 * @param maxSessions Explicit bound for one maintenance pass.
 * @returns Number of terminalized derivations; live Writers and unresolved original mutations remain untouched.
 */
export async function cleanupExpiredNativeDerivations(tasks: TaskStore,
  owner: { userId: string; authenticate: (client: PoolClient) => Promise<void> }, limits: EventLimits,
  maxSessions: number): Promise<number> {
  return transaction(tasks.pool, async (client) => {
    await owner.authenticate(client)
    const rows = await client.query<OwnedAppendState & { operation_id: string; lease_epoch: number }>(`
      SELECT s.id,s.header,s.event_count,s.event_bytes,s.lease_epoch,o.id AS operation_id FROM pe_sessions s
      JOIN pe_operations o ON o.session_id=s.id AND o.state='running'
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch AND a.ended_at IS NULL
      WHERE s.user_id=$1 AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
        AND (o.source='native_interactive' OR EXISTS(SELECT 1 FROM pe_native_subagent_grants g WHERE g.operation_id=o.id))
        AND NOT EXISTS(SELECT 1 FROM pe_native_writers w WHERE w.session_id=s.id AND w.expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM pe_native_retained_intents j WHERE j.session_id=s.id AND j.state='prepared')
      ORDER BY o.created_at,o.id LIMIT $2 FOR UPDATE OF s,o`, [owner.userId, maxSessions])
    let closed = 0
    for (const row of rows.rows) {
      const current = await client.query(`SELECT 1 FROM pe_sessions s WHERE s.id=$1
        AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM pe_native_writers w WHERE w.session_id=s.id AND w.expires_at>clock_timestamp())`, [row.id])
      if (!current.rowCount || row.event_count > limits.maxHistoryEvents || Number(row.event_bytes) > limits.maxHistoryBytes) continue
      const header = headerSchema.parse(row.header)
      const stored = await client.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [row.id])
      const closers = interruptedTurnClosers(parseEvents(header, stored.rows.map(item => item.event)))
      if (closers.length) await appendOwnedEvents(client, owner.userId, row, closers, limits)
      await client.query("UPDATE pe_operations SET state='failed',error_code='native_derivation_expired',completed_at=clock_timestamp() WHERE id=$1", [row.operation_id])
      await client.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND ended_at IS NULL', [row.operation_id])
      await client.query('UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL WHERE id=$1 AND lease_epoch=$2', [row.id, row.lease_epoch])
      await client.query('DELETE FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2', [row.id, row.lease_epoch])
      await client.query('UPDATE pe_native_interactive_grants SET released_at=clock_timestamp() WHERE operation_id=$1 AND released_at IS NULL', [row.operation_id])
      const stop = await readSessionStopInTransaction(client, owner.userId, header.id)
      if (stop) await completeSessionStopInTransaction(client, owner.userId, header.id, stop.stopId, limits)
      closed++
    }
    return closed
  })
}
