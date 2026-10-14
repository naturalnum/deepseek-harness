/** Native child grants derive from one exact live parent operation and writer without widening account authority. */
import type { PoolClient } from 'pg'
import { readNativeRuntimePolicy } from './native-runtime-policy.ts'
import { PlatformError } from '../contracts.ts'

/** Recheck a child's original parent operation, writer and elapsed derivation limit.
 * @param client Existing account and child Session transaction.
 * @param session Exact child authorization result; ordinary Sessions have no derivation record.
 * @returns Whether the Session is an authorized native child; stale parents and incomplete child records refuse.
 */
export async function assertNativeSubagentStorage(client: PoolClient,
  session: { id: string; user_id: string; operation_id: string; lease_epoch: number }): Promise<boolean> {
  const record = await client.query<{ session_id: string }>('SELECT session_id FROM pe_native_subagent_grants WHERE session_id=$1', [session.id])
  if (!record.rows[0]) return false
  const live = await client.query<{ id: string
    user_id: string
    operation_id: string
    lease_epoch: number
    parent_mode: string | null
    parent_permission_generation: string | null }>(
    `SELECT p.id,p.user_id,o.id AS operation_id,p.lease_epoch,d.parent_mode,d.parent_permission_generation FROM pe_native_subagent_grants d
    JOIN pe_sessions p ON p.id=d.parent_session_id AND p.user_id=d.user_id
    JOIN pe_operations o ON o.id=d.parent_operation_id AND o.session_id=p.id
    JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=d.parent_epoch
    JOIN pe_native_writers w ON w.session_id=p.id AND w.epoch=d.parent_writer_epoch
    WHERE d.session_id=$1 AND d.user_id=$2 AND d.operation_id=$3 AND d.expires_at>clock_timestamp()
      AND p.lease_epoch=d.parent_epoch AND p.grant_digest=d.parent_digest AND p.lease_until>clock_timestamp()
      AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested'
      AND a.worker_id=d.worker_id AND a.ended_at IS NULL AND w.worker_id=d.worker_id AND w.expires_at>clock_timestamp()
    FOR SHARE OF p,o,w`, [session.id, session.user_id, session.operation_id])
  if (live.rowCount !== 1) throw new PlatformError(409, 'native_subagent_parent_lost')
  const parent = live.rows[0]
  if (!parent) throw new PlatformError(409, 'native_subagent_parent_lost')
  await assertNativeSubagentStorage(client, parent)
  const policy = await readNativeRuntimePolicy(client, parent)
  if (parent.parent_mode !== policy.mode || Number(parent.parent_permission_generation) !== policy.permissionGeneration) {
    throw new PlatformError(409, 'native_subagent_parent_policy_changed')
  }
  return true
}

/** A derived native child may execute only in its own persisted open step with its own current writer.
 * @param client Current child execution transaction.
 * @param session Exact current operation and Session clocks.
 * @returns Completion after the native open-step and writer proof; parent proof is required by storage admission.
 */
export async function assertNativeSubagentExecution(client: PoolClient,
  session: { id: string; user_id: string; operation_id: string; lease_epoch: number }): Promise<void> {
  const operation = await client.query("SELECT 1 FROM pe_operations WHERE id=$1 AND session_id=$2 AND state='running' AND error_code IS DISTINCT FROM 'cancel_requested'", [session.operation_id, session.id])
  if (operation.rowCount !== 1) throw new PlatformError(409, 'native_subagent_cancelled')
  const current = await client.query<{ type: string }>(`SELECT event->>'type' AS type FROM pe_events
    WHERE session_id=$1 AND event->>'type' IN ('step/start','step/end','turn/end') ORDER BY seq DESC LIMIT 1`, [session.id])
  if (current.rows[0]?.type !== 'step/start') throw new PlatformError(409, 'native_execution_step_unclaimed')
  const writer = await client.query(`SELECT w.session_id FROM pe_native_writers w
    JOIN pe_attempts a ON a.worker_id=w.worker_id AND a.operation_id=$2 AND a.epoch=$3
    WHERE w.session_id=$1 AND w.expires_at>clock_timestamp() AND a.ended_at IS NULL`,
  [session.id, session.operation_id, session.lease_epoch])
  if (writer.rowCount !== 1) throw new PlatformError(409, 'native_execution_authority_lost')
}
