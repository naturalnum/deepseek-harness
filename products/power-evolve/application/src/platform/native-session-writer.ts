/** Platform-owned Session writer occupancy, independent of operation execution capacity. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, userId, type UserId } from '../contracts.ts'
import { nativeWriterAcquire, nativeWriterEpoch, nativeWriterIdentity, nativeWriterLease, nativeWriterWorkerId,
  type NativeWriterIdentity, type NativeWriterLease, type NativeWriterReleased } from '../native-writer-contracts.ts'
import { requireActiveAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'
import type { TaskStore } from './tasks.ts'

/** Bounded server-side writer duration; renew does not extend an operation grant. */
export interface NativeSessionWriterLimits { readonly leaseMs: number }

const limitsSchema = z.object({ leaseMs: z.number().int().min(1).max(300_000) }).strict()
const duplicateDigest = z.object({ code: z.literal('23505') })
const writerRow = z.object({ epoch: nativeWriterEpoch, workerId: nativeWriterWorkerId,
  digest: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).strict()
type WriterRow = z.infer<typeof writerRow>
const columns = `epoch::double precision AS epoch,worker_id AS "workerId",token_digest AS digest,
  floor(extract(epoch FROM expires_at)*1000)::double precision AS "expiresAt"`
const receiptColumns = `session_id AS "sessionId",worker_id AS "workerId",epoch::double precision AS epoch,
  floor(extract(epoch FROM expires_at)*1000)::double precision AS "expiresAt"`

function maintenanceIdentity(input: unknown): NativeWriterIdentity {
  const parsed = nativeWriterIdentity.safeParse(input)
  if (!parsed.success) throw new PlatformError(400, 'invalid_request')
  return parsed.data
}

/** Maintains one fenced writer per Session; it cannot append events or authorize model/execution work. */
export class NativeSessionWriter {
  private readonly leaseMs: number

  /**
   * @param tasks Current operation authority and Platform database owner.
   * @param limits Writer duration in milliseconds, from 1 through 300000.
   */
  constructor(private readonly tasks: TaskStore, limits: NativeSessionWriterLimits) {
    this.leaseMs = limitsSchema.parse(limits).leaseMs
  }

  /** Acquire under the current operation's exact worker after account and Session authorization.
   * Same live worker/token retries preserve both epoch and expiry; expired/released token retries fail.
   * @param operationToken Current operation bearer, rechecked after writer SQL waits.
   * @param input Strict acquisition record whose random token was generated and retained by Host.
   * @returns Committed writer receipt without the raw token; ownership may expire before delivery.
   */
  async acquire(operationToken: string, input: unknown): Promise<NativeWriterLease> {
    const parsed = nativeWriterAcquire.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    const request = parsed.data, hashed = digest(request.token)
    return transaction(this.tasks.pool, async (client) => {
      const session = await this.tasks.authorized(client, operationToken)
      if (session.id !== request.sessionId.toLowerCase()) throw new PlatformError(409, 'lease_lost')
      const attempt = await client.query<{ worker_id: string }>(`SELECT worker_id FROM pe_attempts
        WHERE operation_id=$1 AND epoch=$2 AND ended_at IS NULL`, [session.operation_id, session.lease_epoch])
      if (attempt.rows[0]?.worker_id !== request.workerId) throw new PlatformError(409, 'lease_lost')
      const previous = await this.lockedRow(client, request.sessionId)
      if (previous?.digest === hashed) {
        if (previous.workerId !== request.workerId) throw new PlatformError(409, 'native_writer_lost')
        await this.tasks.authorized(client, operationToken)
        return this.currentLease(client, { ...request, epoch: previous.epoch })
      }
      const live = await client.query(`SELECT session_id FROM pe_native_writers
        WHERE session_id=$1 AND expires_at>clock_timestamp()`, [request.sessionId])
      if (live.rowCount) throw new PlatformError(409, 'native_writer_busy')
      if (previous?.epoch === Number.MAX_SAFE_INTEGER) throw new PlatformError(503, 'native_writer_epoch')
      const epoch = (previous?.epoch ?? 0) + 1
      try {
        await client.query(`INSERT INTO pe_native_writers(session_id,worker_id,epoch,token_digest,expires_at)
          VALUES($1,$2,$3,$4,clock_timestamp()+$5::double precision*interval '1 millisecond')
          ON CONFLICT(session_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,epoch=EXCLUDED.epoch,
          token_digest=EXCLUDED.token_digest,expires_at=EXCLUDED.expires_at`,
        [request.sessionId, request.workerId, epoch, hashed, this.leaseMs])
      } catch (error) {
        if (duplicateDigest.safeParse(error).success) throw new PlatformError(409, 'native_writer_token_conflict')
        throw error
      }
      // A uniqueness/table wait can outlast the operation grant after its earlier Session check.
      await this.tasks.authorized(client, operationToken)
      return this.currentLease(client, { ...request, epoch })
    })
  }

  /** Renew exact live occupancy without requiring the originating operation to remain running.
   * @param input Strict Session/worker/epoch/token identity, checked under current active-account locks.
   * @returns Committed receipt with expiry measured from the post-lock PostgreSQL clock.
   */
  async renew(input: unknown): Promise<NativeWriterLease> {
    const identity = maintenanceIdentity(input)
    return transaction(this.tasks.pool, async (client) => {
      await this.lockIdentity(client, identity)
      const renewed = await client.query(`UPDATE pe_native_writers
        SET expires_at=clock_timestamp()+$5::double precision*interval '1 millisecond'
        WHERE session_id=$1 AND worker_id=$2 AND epoch=$3 AND token_digest=$4
          AND expires_at>clock_timestamp() RETURNING session_id`,
      [identity.sessionId, identity.workerId, identity.epoch, digest(identity.token), this.leaseMs])
      if (!renewed.rowCount) throw new PlatformError(409, 'native_writer_lost')
      return this.currentLease(client, identity)
    })
  }

  /** Release exact live occupancy, retaining epoch and the last identity for idempotent repeats.
   * @param input Strict writer identity; an expired, replaced or unknown identity is rejected.
   * @returns Committed release receipt; a repeat succeeds only until a new identity acquires the Session.
   */
  async release(input: unknown): Promise<NativeWriterReleased> {
    const identity = maintenanceIdentity(input)
    return transaction(this.tasks.pool, async (client) => {
      const row = await this.lockIdentity(client, identity)
      if (row.expiresAt !== null) {
        const released = await client.query(`UPDATE pe_native_writers SET expires_at=NULL
          WHERE session_id=$1 AND worker_id=$2 AND epoch=$3 AND token_digest=$4
            AND expires_at>clock_timestamp() RETURNING session_id`,
        [identity.sessionId, identity.workerId, identity.epoch, digest(identity.token)])
        if (!released.rowCount) throw new PlatformError(409, 'native_writer_lost')
      }
      return { sessionId: identity.sessionId, workerId: identity.workerId, epoch: identity.epoch, released: true }
    })
  }

  /** Lock active account, Session and exact writer in the caller's transaction, then check the current PG clock.
   * @param client Existing transaction; call before locking operation or publication rows.
   * @param identity Validated writer identity, independent of an operation bearer.
   * @returns Owner and live occupancy receipt; this does not renew or issue execution authority.
   */
  async requireInTransaction(client: PoolClient, identity: NativeWriterIdentity): Promise<NativeWriterLease & { userId: UserId }> {
    const locked = await this.lockIdentity(client, identity)
    const lease = await this.currentLease(client, identity)
    return { ...lease, userId: locked.userId }
  }

  /** Recheck exact live writer after later SQL waits without opening a nested transaction or renewing it.
   * @param client Transaction already holding account, Session and writer locks from requireInTransaction.
   * @param identity The same validated writer identity held by the caller.
   * @returns Completion when the account and writer remain live at the current PostgreSQL clock.
   */
  async assertLiveInTransaction(client: PoolClient, identity: NativeWriterIdentity): Promise<void> {
    await this.requireInTransaction(client, identity)
  }

  private async lockedRow(client: PoolClient, sessionId: string): Promise<WriterRow | undefined> {
    const result = await client.query<Record<string, unknown>>(`SELECT ${columns} FROM pe_native_writers WHERE session_id=$1 FOR UPDATE`,
      [sessionId])
    const row = result.rows[0]
    return row === undefined ? undefined : writerRow.parse(row)
  }

  private async lockIdentity(client: PoolClient, identity: NativeWriterIdentity): Promise<WriterRow & { userId: UserId }> {
    const hashed = digest(identity.token)
    const hint = await client.query<{ user_id: string }>(`SELECT s.user_id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      WHERE w.session_id=$1 AND w.worker_id=$2 AND w.epoch=$3 AND w.token_digest=$4`,
    [identity.sessionId, identity.workerId, identity.epoch, hashed])
    const owner = hint.rows[0]
    if (!owner) throw new PlatformError(409, 'native_writer_lost')
    const ownerId = userId.parse(owner.user_id)
    await requireActiveAccount(client, ownerId, 'update')
    const session = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [identity.sessionId, owner.user_id])
    if (!session.rowCount) throw new PlatformError(409, 'native_writer_lost')
    const row = await this.lockedRow(client, identity.sessionId)
    if (row?.epoch !== identity.epoch || row.workerId !== identity.workerId || row.digest !== hashed) {
      throw new PlatformError(409, 'native_writer_lost')
    }
    return { ...row, userId: ownerId }
  }

  private async currentLease(client: PoolClient, identity: NativeWriterIdentity): Promise<NativeWriterLease> {
    const result = await client.query<Record<string, unknown>>(`SELECT ${receiptColumns} FROM pe_native_writers
      WHERE session_id=$1 AND worker_id=$2 AND epoch=$3 AND token_digest=$4 AND expires_at>clock_timestamp()`,
    [identity.sessionId, identity.workerId, identity.epoch, digest(identity.token)])
    const row = result.rows[0]
    if (!row) throw new PlatformError(409, 'native_writer_lost')
    return nativeWriterLease.parse(row)
  }
}
