/** Durable acceptance, per-session leases, and operation attempts. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { grant, PlatformError, settings, type Grant, type Identity, type RequestId, type Settings } from '../contracts.ts'
import { digest } from './identity.ts'
import { transaction } from './database.ts'

interface SessionRow {
  id: string
  user_id: string
  header: SessionHeader
  event_count: number
  event_bytes: string
  lease_epoch: number
}

/** Limits are deployment inputs, applied atomically during acceptance and claiming. */
export interface TaskLimits {
  readonly leaseMs: number
  readonly maxPendingPerUser: number
  readonly maxActivePerUser: number
}

/** Platform-owned state machine. Host callers never choose a task's user identity. */
export class TaskStore {
  constructor(readonly pool: Pool, private readonly limits: TaskLimits) {}

  /** Create a durable empty native Session, deduplicated within one authenticated user. */
  async create(user: Identity, requestId: RequestId): Promise<{ sessionId: SessionId }> {
    const id = randomUUID()
    const header: SessionHeader = { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO pe_sessions(id,user_id,create_request_id,header) VALUES ($1,$2,$3,$4)
       ON CONFLICT(user_id,create_request_id) DO UPDATE SET create_request_id=excluded.create_request_id RETURNING id`,
      [id, user.userId, requestId, header],
    )
    return { sessionId: SessionId(result.rows[0]!.id) }
  }

  /** Return only the authenticated user's bounded Session catalog. */
  async list(user: Identity, offset: number, limit: number): Promise<unknown> {
    const result = await this.pool.query(
      `SELECT id AS "sessionId", created_at AS "createdAt", event_count AS "eventCount",
       (SELECT left(input,80) FROM pe_operations o WHERE o.session_id=s.id ORDER BY created_at,id LIMIT 1) AS title
       FROM pe_sessions s WHERE user_id=$1 ORDER BY created_at DESC,id OFFSET $2 LIMIT $3`,
      [user.userId, offset, limit],
    )
    return { items: result.rows, offset, limit }
  }

  /** Commit an input before returning acceptance; identical retries reuse the Operation. */
  async accept(user: Identity, session: SessionId, requestId: RequestId, text: string, config: Settings): Promise<unknown> {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      await this.owned(client, user, session)
      const prior = await client.query<{ id: string; input: string; state: string }>(
        'SELECT id,input,state FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session, requestId],
      )
      const found = prior.rows[0]
      if (found) {
        if (found.input !== text) throw new PlatformError(409, 'request_id_conflict')
        return { accepted: true, operationId: found.id, state: found.state }
      }
      const count = await client.query<{ count: string }>(
        `SELECT count(*) FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
         WHERE s.user_id=$1 AND o.state IN ('queued','running')`, [user.userId],
      )
      if (Number(count.rows[0]!.count) >= this.limits.maxPendingPerUser) throw new PlatformError(429, 'pending_limit')
      const id = randomUUID()
      await client.query(
        `INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,$4,$5,'queued')`,
        [id, session, requestId, text, config],
      )
      await client.query('SELECT pg_notify(\'pe_tasks\',$1)', [session])
      return { accepted: true, operationId: id, state: 'queued' }
    })
  }

  /** Claim one eligible Operation and its Session lease in the same transaction. */
  async claim(workerId: string): Promise<Grant | null> {
    return transaction(this.pool, async client => {
      const candidate = await client.query<{
        id: string; session_id: string; user_id: string; request_id: string; input: string; settings: unknown;
      }>(
        `SELECT o.id,o.session_id,s.user_id,o.request_id,o.input,o.settings
         FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
         WHERE o.state IN ('queued','running') AND (s.lease_until IS NULL OR s.lease_until<=now())
         AND (SELECT count(*) FROM pe_sessions active WHERE active.user_id=s.user_id AND active.lease_until>now())<$1
         AND NOT EXISTS (SELECT 1 FROM pe_operations earlier WHERE earlier.session_id=s.id
           AND earlier.state IN ('queued','running') AND (earlier.created_at,earlier.id)<(o.created_at,o.id))
         ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF s,o SKIP LOCKED`, [this.limits.maxActivePerUser],
      )
      const row = candidate.rows[0]
      if (!row) return null
      // Serialize a user's capacity check across otherwise independent Session rows.
      const lockedUser = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE SKIP LOCKED', [row.user_id])
      if (lockedUser.rowCount !== 1) return null
      const active = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_sessions WHERE user_id=$1 AND lease_until>now()', [row.user_id],
      )
      if (Number(active.rows[0]!.count) >= this.limits.maxActivePerUser) return null
      const token = randomBytes(32).toString('base64url')
      const updated = await client.query<{ lease_epoch: number }>(
        `UPDATE pe_sessions SET lease_epoch=lease_epoch+1,grant_digest=$2,
         lease_until=now()+$3::double precision*interval '1 millisecond' WHERE id=$1 RETURNING lease_epoch`,
        [row.session_id, digest(token), this.limits.leaseMs],
      )
      const epoch = updated.rows[0]!.lease_epoch
      await client.query('UPDATE pe_operations SET state=\'running\',attempts=attempts+1 WHERE id=$1', [row.id])
      await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,$2,$3)', [row.id, epoch, workerId])
      return grant.parse({
        operationId: row.id, sessionId: row.session_id, userId: row.user_id, requestId: row.request_id,
        text: row.input, settings: settings.parse(row.settings), token, epoch,
      })
    })
  }

  /** Verify current write authority under the caller's transaction lock. */
  async authorized(client: PoolClient, token: string): Promise<SessionRow & { operation_id: string; settings: unknown }> {
    const result = await client.query<SessionRow & { operation_id: string; settings: unknown }>(
      `SELECT s.*,o.id AS operation_id,o.settings FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
       WHERE s.grant_digest=$1 AND s.lease_until>now() AND o.state='running' FOR UPDATE OF s`, [digest(token)],
    )
    const row = result.rows[0]
    if (!row) throw new PlatformError(409, 'lease_lost')
    return row
  }

  /** Renew only an unexpired grant; an expired process cannot reacquire its former lease. */
  async renew(token: string): Promise<void> {
    await transaction(this.pool, async client => {
      const row = await this.authorized(client, token)
      await client.query(`UPDATE pe_sessions SET lease_until=now()+$2::double precision*interval '1 millisecond' WHERE id=$1`,
        [row.id, this.limits.leaseMs])
    })
  }

  /** Settle an Operation only after the caller has flushed and disposed its Agent. */
  async finish(token: string, outcome: 'completed' | 'failed', errorCode: string | null): Promise<void> {
    await transaction(this.pool, async client => {
      const row = await this.authorized(client, token)
      await client.query('UPDATE pe_operations SET state=$2,error_code=$3,completed_at=now() WHERE id=$1',
        [row.operation_id, outcome, errorCode])
      await client.query('UPDATE pe_attempts SET ended_at=now() WHERE operation_id=$1 AND epoch=$2',
        [row.operation_id, row.lease_epoch])
      await client.query('UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL,updated_at=now() WHERE id=$1', [row.id])
    })
  }

  /** Require ownership without disclosing whether another user's Session exists. */
  async owned(client: Pick<PoolClient, 'query'>, user: Identity, session: SessionId): Promise<SessionRow> {
    const result = await client.query<SessionRow>('SELECT * FROM pe_sessions WHERE id=$1 AND user_id=$2', [session, user.userId])
    const row = result.rows[0]
    if (!row) throw new PlatformError(404, 'session_not_found')
    return row
  }
}
