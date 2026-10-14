/** Hard revocation preserves exact original cleanup without restoring storage reads, dispatch or model authority. */
import type { Pool } from 'pg'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { operationId, PlatformError, userId } from '../contracts.ts'
import { nativeWriterIdentity } from '../native-writer-contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'
import { lockAccountAuthorities } from './account-authority.ts'
import { appendOwnedEvents, type OwnedAppendState } from './native-owned-append.ts'
import type { EventLimits } from './events.ts'

/** Original operation and Writer proof; this method accepts no caller-authored Session events. */
export const nativeRuntimeCleanupRequest = z.object({ operationId, epoch: z.number().int().positive(),
  writer: nativeWriterIdentity, errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u) }).strict()
const receipt = z.object({ cleaned: z.literal(true), operationId, sessionId: z.uuid(), epoch: z.number().int().positive(),
  eventCount: z.number().int().nonnegative() }).strict()

/** Close only the original owned attempt from its committed prefix, including after expiry or account revocation.
 * @param pool Platform PG authority.
 * @param token Original retained operation bearer; current browser/Runtime credentials grant no substitution.
 * @param input Exact original operation epoch and independent Writer identity.
 * @param limits Original native event/history budgets.
 * @returns Durable tokenless cleanup receipt; identical retries return only that original receipt.
 */
export async function cleanupNativeRuntime(pool: Pool, token: string,
  input: z.infer<typeof nativeRuntimeCleanupRequest>, limits: EventLimits): Promise<z.infer<typeof receipt>> {
  const hashed = digest(token), writerDigest = digest(input.writer.token)
  return transaction(pool, async client => {
    const known = await client.query<{ user_id: string }>('SELECT s.user_id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id WHERE o.id=$1', [input.operationId])
    const hint = known.rows[0]
    if (!hint) throw new PlatformError(409, 'native_cleanup_lost')
    await lockAccountAuthorities(client, [userId.parse(hint.user_id)], 'update')
    const old = await client.query<{ grant_digest: string; writer_digest: string; writer_epoch: string; worker_id: string;
      operation_epoch: string; error_code: string; receipt: unknown }>('SELECT * FROM pe_native_cleanup_receipts WHERE operation_id=$1 FOR UPDATE', [input.operationId])
    const repeated = old.rows[0]
    if (repeated) {
      if (repeated.grant_digest !== hashed || repeated.writer_digest !== writerDigest || Number(repeated.writer_epoch) !== input.writer.epoch
        || repeated.worker_id !== input.writer.workerId || Number(repeated.operation_epoch) !== input.epoch || repeated.error_code !== input.errorCode) {
        throw new PlatformError(409, 'native_cleanup_conflict')
      }
      return receipt.parse(repeated.receipt)
    }
    const owned = await client.query<OwnedAppendState>(`SELECT s.id,s.header,s.event_count,s.event_bytes FROM pe_sessions s
      JOIN pe_operations o ON o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
      JOIN pe_native_writers w ON w.session_id=s.id AND w.worker_id=a.worker_id
      WHERE o.id=$1 AND o.state='running' AND s.grant_digest=$2 AND s.lease_epoch=$3 AND a.ended_at IS NULL
        AND w.worker_id=$4 AND w.epoch=$5 AND w.token_digest=$6 AND s.id=$7 FOR UPDATE OF s,o,w`,
    [input.operationId, hashed, input.epoch, input.writer.workerId, input.writer.epoch, writerDigest, input.writer.sessionId])
    const session = owned.rows[0]
    if (!session) throw new PlatformError(409, 'native_cleanup_lost')
    if (session.event_count > limits.maxHistoryEvents || Number(session.event_bytes) > limits.maxHistoryBytes) {
      throw new PlatformError(409, 'native_cleanup_history_limit')
    }
    const header = headerSchema.parse(session.header)
    const stored = await client.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.id])
    const closers = interruptedTurnClosers(parseEvents(header, stored.rows.map(row => row.event)))
    if (closers.length) await appendOwnedEvents(client, hint.user_id, session, closers, limits)
    const result = receipt.parse({ cleaned: true, operationId: input.operationId, sessionId: session.id,
      epoch: input.epoch, eventCount: session.event_count + closers.length })
    await client.query(`UPDATE pe_operations SET state='failed',error_code=$2,completed_at=clock_timestamp() WHERE id=$1`, [input.operationId, input.errorCode])
    await client.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND epoch=$2', [input.operationId, input.epoch])
    await client.query('UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL WHERE id=$1 AND grant_digest=$2 AND lease_epoch=$3', [session.id, hashed, input.epoch])
    await client.query('UPDATE pe_native_writers SET expires_at=NULL WHERE session_id=$1 AND worker_id=$2 AND epoch=$3 AND token_digest=$4',
      [session.id, input.writer.workerId, input.writer.epoch, writerDigest])
    await client.query('DELETE FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2', [session.id, input.epoch])
    await client.query('UPDATE pe_native_interactive_grants SET released_at=clock_timestamp() WHERE operation_id=$1 AND released_at IS NULL', [input.operationId])
    await client.query(`INSERT INTO pe_native_cleanup_receipts(operation_id,session_id,user_id,worker_id,operation_epoch,
      grant_digest,writer_epoch,writer_digest,error_code,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.operationId, session.id, hint.user_id, input.writer.workerId, input.epoch, hashed,
      input.writer.epoch, writerDigest, input.errorCode, result])
    return result
  })
}
