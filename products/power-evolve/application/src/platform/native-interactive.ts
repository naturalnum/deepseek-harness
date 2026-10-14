/** Explicit bounded interactive occupancy lets original native commands and Terminal use one cold PG Session. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, grant, requestId, sessionId, operationId, settings, type Grant } from '../contracts.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { headerSchema } from '../session-records.ts'
import { isSessionBusinessBlockedInTransaction } from './native-workspace-layout.ts'
import type { TaskStore } from './tasks.ts'
import type { NativeRuntimeAuthority } from './native-runtime-authority.ts'

/** Original caller ids and token are retained before dispatch; uncertain opens never mint a replacement. */
export const nativeInteractiveOpen = z.object({ sessionId, requestId, browserToken: z.string().min(32).max(256),
  candidateToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict()
/** Explicit interactive occupancy and renewal bounds. */
export interface NativeInteractiveLimits { lifetimeMs: number; leaseMs: number; maxActivePerUser: number }

/** PG creates no prompt, input origin or turn for interactive occupancy. */
export class NativeInteractive {
  constructor(private readonly tasks: TaskStore, private readonly authority: NativeRuntimeAuthority,
    private readonly limits: NativeInteractiveLimits) {}

  /** Open one ordinary cold Session under both original Browser and fixed Runtime authority.
   * @param runtimeToken Current account-bound Runtime bearer.
   * @param input Retained original Session, nonce, Browser token and operation candidate.
   * @returns Its bounded interactive Grant; an identical uncertain retry restores that original grant.
   */
  async open(runtimeToken: string, input: z.infer<typeof nativeInteractiveOpen>): Promise<Grant> {
    return transaction(this.tasks.pool, async (client) => {
      const runtime = await this.authority.authenticateInTransaction(client, runtimeToken, undefined, 'update')
      const browserHint = await client.query<{ user_id: string }>("SELECT user_id FROM pe_credentials WHERE digest=$1 AND audience='agent'", [digest(input.browserToken)])
      if (browserHint.rows[0]?.user_id !== runtime.userId) throw new PlatformError(403, 'native_interactive_owner_mismatch')
      const browser = await requireBrowserAccount(client, input.browserToken, { lock: 'update' })
      if (runtime.userId !== browser.userId) throw new PlatformError(403, 'native_interactive_owner_mismatch')
      const prior = await client.query<{ operation_id: string; session_id: string; epoch: number; browser_digest: string }>(`
        SELECT g.operation_id,g.session_id,s.lease_epoch AS epoch,g.browser_digest FROM pe_native_interactive_grants g
        JOIN pe_sessions s ON s.id=g.session_id WHERE g.runtime_id=$1 AND g.request_id=$2`, [runtime.runtimeId, input.requestId])
      const repeated = prior.rows[0]
      if (repeated) {
        if (repeated.session_id !== input.sessionId || repeated.browser_digest !== digest(input.browserToken)) {
          throw new PlatformError(409, 'native_interactive_request_conflict')
        }
        return this.tasks.restoreGrantInTransaction(client, operationId.parse(repeated.operation_id), input.candidateToken, repeated.epoch)
      }
      const found = await client.query<{ header: unknown; lease_epoch: number; leased: boolean }>(`
        SELECT header,lease_epoch,COALESCE(lease_until>clock_timestamp(),false) AS leased FROM pe_sessions
        WHERE id=$1 AND user_id=$2 FOR UPDATE`, [input.sessionId, runtime.userId])
      const session = found.rows[0]
      if (!session) throw new PlatformError(404, 'session_not_found')
      const header = headerSchema.parse(session.header)
      if (header.origin === 'subagent') {
        throw new PlatformError(403, 'native_interactive_subagent_owned')
      }
      if (session.leased || (await client.query('SELECT 1 FROM pe_native_writers WHERE session_id=$1 AND expires_at>clock_timestamp()', [input.sessionId])).rowCount) {
        throw new PlatformError(409, 'native_session_busy')
      }
      await this.expire(client, input.sessionId)
      if ((await client.query("SELECT 1 FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running') LIMIT 1", [input.sessionId])).rowCount
        || (await client.query("SELECT 1 FROM pe_native_retained_intents WHERE session_id=$1 AND state='prepared' LIMIT 1", [input.sessionId])).rowCount) {
        throw new PlatformError(409, 'native_interactive_pending_work')
      }
      if (await isSessionBusinessBlockedInTransaction(client, runtime.userId, input.sessionId)) throw new PlatformError(409, 'native_session_archived')
      const active = await client.query<{ count: string }>('SELECT count(*) FROM pe_native_interactive_grants WHERE user_id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()', [runtime.userId])
      if (Number(active.rows[0]?.count) >= this.limits.maxActivePerUser) throw new PlatformError(429, 'native_interactive_limit')
      const account = await client.query<{ settings: unknown }>('SELECT settings FROM pe_users WHERE id=$1', [runtime.userId])
      const originalSettings = settings.parse(account.rows[0]?.settings), id = operationId.parse(randomUUID()), epoch = session.lease_epoch + 1
      await client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,attempts,source)
        VALUES($1,$2,$3,'',$4,'running',1,'native_interactive')`, [id, input.sessionId, input.requestId, originalSettings])
      await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,$2,$3)', [id, epoch, runtime.runtimeId])
      await client.query(`UPDATE pe_sessions SET lease_epoch=$2,grant_digest=$3,
        lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond' WHERE id=$1`,
      [input.sessionId, epoch, digest(input.candidateToken), this.limits.leaseMs])
      await client.query(`INSERT INTO pe_native_interactive_grants(operation_id,session_id,user_id,runtime_credential_id,
        runtime_id,runtime_generation,browser_digest,credential_version,request_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,LEAST(to_timestamp($10::double precision/1000),
          clock_timestamp()+$11::double precision*interval '1 millisecond'))`,
      [id, input.sessionId, runtime.userId, runtime.credentialId, runtime.runtimeId, runtime.generation, digest(input.browserToken),
        runtime.credentialVersion, input.requestId, runtime.expiresAt, this.limits.lifetimeMs])
      return grant.parse(await this.tasks.restoreGrantInTransaction(client, id, input.candidateToken, epoch))
    })
  }

  private async expire(client: PoolClient, id: string): Promise<void> {
    const dead = await client.query<{ operation_id: string }>(`UPDATE pe_native_interactive_grants SET released_at=clock_timestamp()
      WHERE session_id=$1 AND released_at IS NULL AND (expires_at<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM pe_sessions s WHERE s.id=session_id AND s.lease_until<=clock_timestamp())
        OR EXISTS(SELECT 1 FROM pe_runtime_credentials r WHERE r.id=runtime_credential_id AND (r.revoked_at IS NOT NULL OR r.expires_at<=clock_timestamp())))
        RETURNING operation_id`, [id])
    for (const row of dead.rows) {
      await client.query("UPDATE pe_operations SET state='failed',error_code='native_interactive_expired',completed_at=clock_timestamp() WHERE id=$1 AND source='native_interactive' AND state='running'", [row.operation_id])
      await client.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND ended_at IS NULL', [row.operation_id])
    }
  }
}
