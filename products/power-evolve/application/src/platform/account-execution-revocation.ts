/** Account disablement fences Agent grants and durably cancels work without contacting providers. */
import type { PoolClient } from 'pg'
import type { UserId } from '../contracts.ts'

/** Counts of durable work changed by one disablement transaction. */
export interface AccountExecutionRevocation {
  readonly sessions: number
  readonly operations: number
  readonly attempts: number
  readonly approvals: number
  readonly executions: number
}

/**
 * Fence all existing account work in the account service's state-change transaction.
 * The caller holds the user's UPDATE lock before any resource lock. Provider
 * leases and execution identities survive cancellation so workers can observe results
 * and confirm cleanup without an Agent grant. Repeated calls do not revive any work.
 * @param client Account update transaction, with the target user row already locked.
 * @param userId Target account identity selected and authorized by the account service.
 * @returns Counts of grants, inputs, attempts, approvals and executions changed.
 */
export async function revokeAccountExecutions(client: PoolClient, userId: UserId): Promise<AccountExecutionRevocation> {
  await client.query('SELECT id FROM pe_sessions WHERE user_id=$1 ORDER BY id FOR UPDATE', [userId])
  const sessions = await client.query(`UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL,
    lease_epoch=lease_epoch+1,updated_at=now() WHERE user_id=$1
    AND (grant_digest IS NOT NULL OR lease_until IS NOT NULL)`, [userId])
  await client.query(`SELECT o.id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
    WHERE s.user_id=$1 ORDER BY o.id FOR UPDATE OF o`, [userId])
  const operations = await client.query(`UPDATE pe_operations o SET state='failed',error_code='account_disabled',
    completed_at=now(),mcp_chain_cancelled_at=COALESCE(mcp_chain_cancelled_at,clock_timestamp())
    FROM pe_sessions s WHERE s.id=o.session_id AND s.user_id=$1 AND o.state IN ('queued','running')`, [userId])
  const attempts = await client.query(`UPDATE pe_attempts a SET ended_at=now()
    FROM pe_operations o,pe_sessions s WHERE a.operation_id=o.id AND s.id=o.session_id
    AND s.user_id=$1 AND a.ended_at IS NULL`, [userId])
  await client.query(`UPDATE pe_mcp_action_chains SET stopped_at=COALESCE(stopped_at,clock_timestamp()),
    error_code=COALESCE(error_code,'account_disabled') WHERE user_id=$1`, [userId])
  await client.query(`UPDATE pe_mcp_permissions SET revoked_at=COALESCE(revoked_at,clock_timestamp())
    WHERE user_id=$1 AND revoked_at IS NULL`, [userId])

  const checks = await client.query(`UPDATE pe_mcp_checks SET state='cancelled',cancel_requested=true,
    error_code='account_disabled',lease_owner=NULL,lease_until=NULL,updated_at=now()
    WHERE user_id=$1 AND state IN ('queued','running')`, [userId])
  const connector = await client.query(`UPDATE pe_connector_actions SET state='failed',error_code='account_disabled',
    lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE user_id=$1 AND state IN ('pending','approved')`, [userId])
  await client.query(`UPDATE pe_connector_actions SET error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state IN ('dispatching','uncertain')`, [userId])
  const mcp = await client.query(`UPDATE pe_mcp_actions SET state='cancelled',error_code='account_disabled',
    lease_owner=NULL,lease_until=NULL,updated_at=now()
    WHERE user_id=$1 AND dispatch_id IS NULL AND state IN ('pending','approved','preparing')`, [userId])
  // Keep the original dispatch lease: its worker may still deliver a verified reply.
  await client.query(`UPDATE pe_mcp_actions SET error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state='dispatch-intent'`, [userId])
  const ssh = await client.query(`UPDATE pe_ssh_execute_actions SET state='cancelled',error_code='account_disabled',
    updated_at=now() WHERE user_id=$1 AND state='pending'`, [userId])
  await client.query(`UPDATE pe_ssh_execute_actions SET error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state='approved'`, [userId])

  const cloud = await client.query(`UPDATE pe_cloud_executions SET cancel_requested=true,
    state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state IN ('queued','starting','running','cancelling','uncertain')
    AND (cancel_requested=false OR error_code IS DISTINCT FROM 'account_disabled')`, [userId])
  const desktop = await client.query(`UPDATE pe_desktop_executions SET cancel_requested=true,
    state=CASE WHEN state='queued' THEN 'cancelled' WHEN state='running' THEN 'cancelling' ELSE state END,
    error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state IN ('queued','running','cancelling','uncertain')
    AND (cancel_requested=false OR error_code IS DISTINCT FROM 'account_disabled')`, [userId])
  const sshCalls = await client.query(`UPDATE pe_ssh_calls SET cancel_requested=true,
    state=CASE WHEN state='accepted' THEN 'cancelled' ELSE state END,error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')
    AND (cancel_requested=false OR error_code IS DISTINCT FROM 'account_disabled')`, [userId])
  // STDIO has no cancelled state or cancel flag; retain preparation identities for cleanup.
  const stdio = await client.query(`UPDATE pe_stdio_mcp_calls SET error_code='account_disabled',updated_at=now()
    WHERE user_id=$1 AND state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')
    AND error_code IS DISTINCT FROM 'account_disabled'`, [userId])
  await client.query('DELETE FROM pe_device_pairings WHERE user_id=$1', [userId])
  // Idle writers can begin cleanup immediately; active executions first observe/cancel their Runner.
  await client.query(`UPDATE pe_mount_slots m SET state='stopping',updated_at=now()
    WHERE m.user_id=$1 AND m.state='ready' AND NOT EXISTS(SELECT 1 FROM pe_cloud_executions e
      WHERE e.session_id=m.session_id AND e.state IN ('starting','running','cancelling','uncertain'))`, [userId])
  await client.query(`UPDATE pe_sandbox_instances i SET state='deleting',updated_at=now()
    FROM pe_mount_slots m WHERE m.user_id=$1 AND m.session_id=i.session_id AND m.state='stopping'
    AND i.state='ready'`, [userId])
  await client.query("SELECT pg_notify('pe_executions',$1)", [userId])
  return { sessions: sessions.rowCount ?? 0, operations: operations.rowCount ?? 0, attempts: attempts.rowCount ?? 0,
    approvals: (connector.rowCount ?? 0) + (mcp.rowCount ?? 0) + (ssh.rowCount ?? 0),
    executions: (checks.rowCount ?? 0) + (cloud.rowCount ?? 0) + (desktop.rowCount ?? 0) + (sshCalls.rowCount ?? 0) + (stdio.rowCount ?? 0) }
}
