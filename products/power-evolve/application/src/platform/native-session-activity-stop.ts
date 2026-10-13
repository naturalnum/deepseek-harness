/** Archival requests for the existing Session execution carriers; workers retain stop and cleanup ownership. */
import type { PoolClient } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError, type Identity } from '../contracts.ts'
import type { SshCallRow } from './ssh-calls.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'
import { isSessionBusinessBlockedInTransaction } from './native-workspace-layout.ts'

/** Require a row returned by an already-checked activity mutation or singleton query.
 * @param rows Result rows from the caller's original transaction.
 * @returns The required first row; a missing store record refuses rather than fabricating one.
 */
export function requireActivityRow<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new PlatformError(503, 'activity_record_missing')
  return row
}

/** Check the original business lineage without revoking result storage or cleanup.
 * @param client Transaction already holding the owner's account lock.
 * @param origin Original owned Session and operation identities from the persisted activity.
 * @returns Whether the Session or its original root prevents another business dispatch or follow-up.
 */
export async function isSessionOperationStoppedInTransaction(client: PoolClient,
  origin: { readonly userId: string; readonly sessionId: string; readonly operationId: string }): Promise<boolean> {
  const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [origin.sessionId, origin.userId])
  if (!owned.rowCount) return true
  if (await isSessionBusinessBlockedInTransaction(client, origin.userId, origin.sessionId)) return true
  const root = await client.query<{ mcp_chain_cancelled_at: Date | null }>(`SELECT r.mcp_chain_cancelled_at
    FROM pe_operations o JOIN pe_operations r ON r.id=COALESCE(o.mcp_root_operation_id,o.id)
    WHERE o.id=$1 AND o.session_id=$2 AND r.session_id=$2`, [origin.operationId, origin.sessionId])
  return !root.rows[0] || root.rows[0].mcp_chain_cancelled_at !== null
}

/** Reuse the cloud command cancellation request without inventing a Runner outcome.
 * @param client Transaction holding the original execution row lock.
 * @param executionId Exact owned legacy command execution selected by the caller.
 * @returns Completion after the flag write; the original worker confirms termination.
 */
export async function requestCloudCommandStopInTransaction(client: PoolClient, executionId: string): Promise<void> {
  await client.query(`UPDATE pe_cloud_executions SET cancel_requested=true,updated_at=clock_timestamp()
    WHERE id=$1 AND execution_kind='legacy_command'
      AND state IN ('queued','starting','running','cancelling','uncertain')`, [executionId])
}

/** Cancel an approval that has never created an SSH call.
 * @param client Transaction holding the owned pending action lock.
 * @param userId Original authenticated action owner.
 * @param actionId Exact pending SSH execute approval.
 * @returns Completion after the pending action is cancelled, without dispatching or creating a call.
 */
export async function cancelPendingSshExecuteInTransaction(client: PoolClient, userId: string, actionId: string): Promise<void> {
  await client.query(`UPDATE pe_ssh_execute_actions SET state='cancelled',updated_at=clock_timestamp()
    WHERE id=$1 AND user_id=$2 AND state='pending'`, [actionId, userId])
}

/** Request the existing SSH execute stop while retaining its exact dispatch and Runner identities.
 * @param client Transaction holding the original call lock, followed by its approved action lock.
 * @param call Original owned SSH execute call read under that lock.
 * @returns Completion after the request; only an undispatched accepted call becomes cancelled immediately.
 */
export async function requestSshExecuteCallStopInTransaction(client: PoolClient,
  call: Pick<SshCallRow, 'id' | 'user_id' | 'state' | 'dispatch_digest'>): Promise<void> {
  if (['succeeded', 'failed', 'cancelled'].includes(call.state)) return
  await client.query(`UPDATE pe_ssh_calls SET cancel_requested=true,
    state=CASE WHEN state='accepted' THEN 'cancelled' WHEN dispatch_digest IS NOT NULL THEN 'uncertain' ELSE state END,
    lease_until=CASE WHEN state='accepted' THEN lease_until ELSE clock_timestamp() END,updated_at=clock_timestamp()
    WHERE id=$1 AND user_id=$2 AND kind='ssh.execute'`, [call.id, call.user_id])
}

/** Request the original converter generation's cancellation without asserting parser termination.
 * @param client Transaction holding the owned preview job lock.
 * @param job Original generation and creation intent selected by the caller.
 * @returns The updated stored job for the existing preview receipt validator.
 */
export async function requestOfficePreviewStopInTransaction(client: PoolClient,
  job: { readonly id: string
    readonly user_id: string
    readonly generation: string
    readonly creation_intent: unknown }): Promise<unknown> {
  const state = job.creation_intent === null ? 'cancelled' : 'stopping'
  const updated = await client.query(`UPDATE pe_office_preview_jobs SET cancel_requested=true,state=$4,error_code=NULL,
    completed_at=CASE WHEN $4='cancelled' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
    WHERE id=$1 AND user_id=$2 AND generation=$3 RETURNING *`, [job.id, job.user_id, job.generation, state])
  return updated.rows[0]
}

/** Request stops for one archived Session's existing cloud commands, SSH execute approvals/calls and previews.
 * The caller holds account then owned Session locks and has persisted the original requested archival stop
 * and permanent cancellation of all existing operation roots. STDIO and native inbox cleanup have separate owners.
 * @param client Original archive transaction; no provider calls or independent transactions occur here.
 * @param userIdentity Owner already authenticated under the account lock.
 * @param sessionId Exact owned Session whose requested stop has been persisted.
 * @returns Completion after durable requests; workers retain leases, observations and cleanup identities.
 */
export async function requestSessionActivityStopInTransaction(client: PoolClient,
  userIdentity: Pick<Identity, 'userId'>, sessionId: SessionId): Promise<void> {
  const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [sessionId, userIdentity.userId])
  if (!owned.rowCount) throw new PlatformError(404, 'session_not_found')
  const stop = await readSessionStopInTransaction(client, userIdentity.userId, sessionId)
  if (stop?.status !== 'requested') throw new PlatformError(409, 'native_session_stop_required')
  const commands = await client.query<{ id: string }>(`SELECT e.id FROM pe_cloud_executions e
    JOIN pe_operations o ON o.id=e.operation_id AND o.session_id=e.session_id
    JOIN pe_operations r ON r.id=COALESCE(o.mcp_root_operation_id,o.id) AND r.session_id=o.session_id
    WHERE e.user_id=$1 AND e.session_id=$2 AND e.execution_kind='legacy_command'
      AND e.state IN ('queued','starting','running','cancelling','uncertain') ORDER BY e.id FOR UPDATE OF e`,
  [userIdentity.userId, sessionId])
  for (const command of commands.rows) await requestCloudCommandStopInTransaction(client, command.id)
  await client.query(`UPDATE pe_connector_actions a SET state='failed',error_code='native_session_stopped',
    updated_at=clock_timestamp() FROM pe_operations o,pe_operations r
    WHERE a.user_id=$1 AND a.session_id=$2 AND a.state IN ('pending','approved')
      AND o.id=a.operation_id AND o.session_id=a.session_id
      AND r.id=COALESCE(o.mcp_root_operation_id,o.id) AND r.session_id=o.session_id`, [userIdentity.userId, sessionId])
  const ssh = await client.query<{ id: string }>(`SELECT a.id FROM pe_ssh_execute_actions a
    JOIN pe_operations o ON o.id=a.operation_id AND o.session_id=a.session_id
    JOIN pe_operations r ON r.id=COALESCE(o.mcp_root_operation_id,o.id) AND r.session_id=o.session_id
    WHERE a.user_id=$1 AND a.session_id=$2 AND a.state IN ('pending','approved') ORDER BY a.id`,
  [userIdentity.userId, sessionId])
  for (const hint of ssh.rows) {
    const call = (await client.query<SshCallRow>(`SELECT c.* FROM pe_ssh_calls c
      JOIN pe_ssh_execute_actions a ON a.id=c.id AND a.user_id=c.user_id AND a.operation_id=c.operation_id
      WHERE a.id=$1 AND a.user_id=$2 AND a.session_id=$3 AND c.kind='ssh.execute' FOR UPDATE OF c`,
    [hint.id, userIdentity.userId, sessionId])).rows[0]
    const action = (await client.query<{ state: string }>(`SELECT state FROM pe_ssh_execute_actions
      WHERE id=$1 AND user_id=$2 AND session_id=$3 FOR UPDATE`, [hint.id, userIdentity.userId, sessionId])).rows[0]
    if (action?.state === 'pending') await cancelPendingSshExecuteInTransaction(client, userIdentity.userId, hint.id)
    else if (action?.state === 'approved') {
      if (!call) throw new PlatformError(503, 'ssh_call_missing')
      await requestSshExecuteCallStopInTransaction(client, call)
      if (call.state === 'accepted') await client.query(`UPDATE pe_ssh_execute_actions SET state='cancelled',updated_at=clock_timestamp()
        WHERE id=$1 AND user_id=$2 AND session_id=$3 AND state='approved'`, [hint.id, userIdentity.userId, sessionId])
    }
  }
  const previews = await client.query<{ id: string; user_id: string; generation: string; creation_intent: unknown }>(
    `SELECT id,user_id,generation,creation_intent FROM pe_office_preview_jobs WHERE user_id=$1 AND session_id=$2
      AND state IN ('queued','creating','running','stopping','blocked') ORDER BY id FOR UPDATE`, [userIdentity.userId, sessionId])
  for (const preview of previews.rows) await requestOfficePreviewStopInTransaction(client, preview)
}
