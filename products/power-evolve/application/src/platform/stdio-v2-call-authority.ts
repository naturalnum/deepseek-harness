/** Read the persisted original root budget under the caller's account and Session authority locks. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { PlatformError } from '../contracts.ts'

/** Root cancellation and expiry block new starts while preserving original observation and cleanup. */
export interface StdioCallRootAuthorityV2 {
  readonly expiresAt: Date
  readonly active: boolean
}

/** Inspect the original operation/root/chain without renewing its budget or requiring an active Agent turn.
 * @param client Transaction already holding the original account and Session locks before resource locks.
 * @param task Original immutable call task; discovery has no root call chain.
 * @returns Original chain expiry and current start eligibility, or null for discovery; inconsistent ownership is refused.
 */
export async function readStdioCallRootAuthorityV2(client: PoolClient, task: StdioTaskV2): Promise<StdioCallRootAuthorityV2 | null> {
  if (task.phase === 'discover') return null
  const selected = (await client.query(`SELECT o.id AS operation_id,o.session_id,o.error_code,
    r.id AS root_id,r.session_id AS root_session_id,r.source AS root_source,r.mcp_root_operation_id AS root_parent,
    r.mcp_chain_cancelled_at,s.user_id,
    c.user_id AS chain_user_id,c.session_id AS chain_session_id,c.calls,c.max_calls,c.stopped_at,c.expires_at
    FROM pe_operations o JOIN pe_operations r ON r.id=COALESCE(o.mcp_root_operation_id,o.id)
    JOIN pe_sessions s ON s.id=o.session_id JOIN pe_mcp_action_chains c ON c.root_operation_id=r.id
    WHERE o.id=$1 FOR UPDATE OF o,r,c`, [task.origin.operationId])).rows[0]
  const parsed = z.object({ operation_id: z.uuid(), session_id: z.uuid(), error_code: z.string().nullable(),
    root_id: z.uuid(), root_session_id: z.uuid(), root_source: z.string(), root_parent: z.uuid().nullable(), mcp_chain_cancelled_at: z.date().nullable(), user_id: z.uuid(),
    chain_user_id: z.uuid(), chain_session_id: z.uuid(), calls: z.number().int().nonnegative(),
    max_calls: z.number().int().positive(), stopped_at: z.date().nullable(), expires_at: z.date() }).safeParse(selected)
  if (!parsed.success) throw new PlatformError(409, 'stdio_v2_origin_changed')
  const original = parsed.data
  if (original.root_source !== 'user' || original.root_parent !== null
    || original.operation_id !== task.origin.operationId || original.root_id !== task.origin.rootOperationId
    || original.session_id !== task.sessionId || original.root_session_id !== task.sessionId || original.user_id !== task.userId
    || original.chain_user_id !== task.userId || original.chain_session_id !== task.sessionId || original.calls > original.max_calls) {
    throw new PlatformError(409, 'stdio_v2_origin_changed')
  }
  const now = z.date().parse((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now)
  return { expiresAt: original.expires_at, active: !original.mcp_chain_cancelled_at && !original.stopped_at
    && !['cancel_requested', 'turn_user', 'account_disabled'].includes(original.error_code ?? '') && original.expires_at.getTime() > now.getTime() }
}
