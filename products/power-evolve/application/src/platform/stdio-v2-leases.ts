/** Database-clock STDIO worker leases; acquiring a lease never creates an executor start permit. */
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioActionRequestV2, type StdioActionIdV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionLeaseV2, stdioWorkerIdV2, type StdioActionLeaseV2, type StdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { PlatformError } from '../contracts.ts'
import { accountUserId } from '../account-contracts.ts'
import { lockAccountAuthorities } from './account-authority.ts'
import { transaction } from './database.ts'

const original = z.object({ user_id: accountUserId, session_id: z.uuid(), connection_id: z.uuid(), execution_id: z.uuid(),
  execution_target: z.enum(['cloud', 'desktop']) })
const active = ['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping', 'blocked', 'rejected', 'expired']

/** Require the current original worker generation inside an already ordered transaction.
 * @param client Caller holding the original account, Session, connection, action and execution locks.
 * @param lease Internal original worker and epoch; the database clock fences expiry.
 * @returns Resolves while the original action lease is live; it grants no executor start.
 */
export async function assertStdioActionLeaseV2(client: PoolClient, lease: StdioActionLeaseV2): Promise<void> {
  const selected = stdioActionLeaseV2.parse(lease)
  const row = await client.query(`SELECT id FROM pe_stdio_v2_actions WHERE id=$1 AND lease_owner=$2
    AND lease_epoch=$3 AND lease_until>clock_timestamp()`, [selected.actionId, selected.workerId, selected.leaseEpoch])
  if (row.rowCount !== 1) throw new PlatformError(409, 'stdio_v2_lease_lost')
}

/** Trusted workers claim or renew one original action using account-to-execution lock ordering. */
export class StdioActionLeaseServiceV2 {
  constructor(private readonly pool: Pool, private readonly options: { leaseMs: number }) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) throw new TypeError('stdio_v2_lease_budget_invalid')
    this.options = { ...options }
  }

  private async lock(client: PoolClient, actionId: StdioActionIdV2): Promise<z.infer<typeof original>> {
    const hint = (await client.query('SELECT user_id,session_id,connection_id,execution_id,execution_target FROM pe_stdio_v2_actions WHERE id=$1',
      [actionId])).rows[0]
    if (!hint) throw new PlatformError(404, 'stdio_v2_action_not_found')
    const row = original.parse(hint)
    // Disabled accounts retain reconciliation work for already dispatched executors.
    await lockAccountAuthorities(client, [row.user_id], 'update')
    if (!(await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.session_id, row.user_id])).rowCount
      || !(await client.query('SELECT id FROM pe_stdio_v2_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.connection_id, row.user_id])).rowCount
      || !(await client.query(`SELECT id FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 AND session_id=$3
        AND connection_id=$4 AND execution_id=$5 AND execution_target=$6 FOR UPDATE`,
      [actionId, row.user_id, row.session_id, row.connection_id, row.execution_id, row.execution_target])).rowCount) {
      throw new PlatformError(409, 'stdio_v2_record_invalid')
    }
    const table = row.execution_target === 'cloud' ? 'pe_cloud_executions' : 'pe_desktop_executions'
    if (!(await client.query(`SELECT id FROM ${table} WHERE id=$1 AND user_id=$2 AND session_id=$3
      AND execution_kind='stdio_v2' AND stdio_action_id=$4 FOR UPDATE`,
    [row.execution_id, row.user_id, row.session_id, actionId])).rowCount) throw new PlatformError(409, 'stdio_v2_record_invalid')
    return row
  }

  private async mirror(client: PoolClient, row: z.infer<typeof original>, lease: StdioActionLeaseV2): Promise<void> {
    if (row.execution_target !== 'cloud') return
    const changed = await client.query(`UPDATE pe_cloud_executions SET lease_owner=$2,
      lease_until=(SELECT lease_until FROM pe_stdio_v2_actions WHERE id=$1),updated_at=clock_timestamp()
      WHERE id=$4 AND user_id=$5 AND session_id=$6 AND execution_kind='stdio_v2' AND stdio_action_id=$1
        AND state IN ('queued','starting','running','cancelling','uncertain')
        AND (lease_owner IS NULL OR lease_owner=$2 OR lease_until<=clock_timestamp())
        AND EXISTS(SELECT 1 FROM pe_stdio_v2_actions WHERE id=$1 AND lease_owner=$2
          AND lease_epoch=$3 AND lease_until>clock_timestamp()) RETURNING id`,
    [lease.actionId, lease.workerId, lease.leaseEpoch, row.execution_id, row.user_id, row.session_id])
    if (changed.rowCount !== 1) throw new PlatformError(409, 'stdio_v2_lease_lost')
  }

  private decode(actionId: StdioActionIdV2, workerId: StdioWorkerIdV2, leaseEpoch: unknown): StdioActionLeaseV2 {
    return stdioActionLeaseV2.parse({ actionId, workerId, leaseEpoch: z.coerce.number().int().positive().safe().parse(leaseEpoch) })
  }

  /** Claim one unfinished action; a live different owner is never displaced and the same live owner retains its epoch.
   * @param actionId Original durable action selected by the trusted worker.
   * @param workerId Authenticated internal worker generation; parsing this ID alone authenticates nobody.
   * @returns Current lease or null when another owner is live or the action has already finished.
   */
  async claim(actionId: StdioActionIdV2, workerId: StdioWorkerIdV2): Promise<StdioActionLeaseV2 | null> {
    const id = stdioActionRequestV2.parse({ actionId }).actionId, owner = stdioWorkerIdV2.parse(workerId)
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(72819532)')
      const row = await this.lock(client, id)
      const current = (await client.query(`SELECT lease_epoch FROM pe_stdio_v2_actions WHERE id=$1
        AND state=ANY($3::text[]) AND lease_owner=$2 AND lease_until>clock_timestamp()`, [id, owner, active])).rows[0]
      if (current) {
        const lease = this.decode(id, owner, current.lease_epoch)
        await this.mirror(client, row, lease)
        return lease
      }
      const claimed = (await client.query(`UPDATE pe_stdio_v2_actions SET lease_owner=$2,
        lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',lease_epoch=lease_epoch+1,updated_at=clock_timestamp()
        WHERE id=$1 AND state=ANY($4::text[]) AND (lease_owner IS NULL OR lease_until<=clock_timestamp())
          AND lease_epoch<9007199254740991 RETURNING lease_epoch`, [id, owner, this.options.leaseMs, active])).rows[0]
      if (!claimed) return null
      const lease = this.decode(id, owner, claimed.lease_epoch)
      await this.mirror(client, row, lease)
      return lease
    })
  }

  /** Renew only the current unexpired generation; expired leases must be reclaimed with a new epoch.
   * @param lease Original worker ID and epoch returned by claim.
   * @returns The same epoch after its database-clock expiry is extended.
   */
  async renew(lease: StdioActionLeaseV2): Promise<StdioActionLeaseV2> {
    const selected = stdioActionLeaseV2.parse(lease)
    return transaction(this.pool, async client => {
      const original = await this.lock(client, selected.actionId)
      const row = (await client.query(`UPDATE pe_stdio_v2_actions SET
        lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond',updated_at=clock_timestamp()
        WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
        RETURNING lease_epoch`, [selected.actionId, selected.workerId, selected.leaseEpoch, this.options.leaseMs])).rows[0]
      if (!row) throw new PlatformError(409, 'stdio_v2_lease_lost')
      await this.mirror(client, original, selected)
      return this.decode(selected.actionId, selected.workerId, row.lease_epoch)
    })
  }
}
