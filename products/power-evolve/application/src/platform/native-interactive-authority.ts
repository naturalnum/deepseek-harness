/** Native interactive access derives from an explicit bounded holder, separate from model input consumption. */
import type { PoolClient } from 'pg'
import { PlatformError } from '../contracts.ts'

/** Recheck the interactive holder's original browser, Runtime and elapsed lifetime.
 * @param client Account and Session-locked original transaction.
 * @param session Exact current interactive operation and Session clocks.
 * @returns Completion after the original explicit interactive derivation remains live.
 */
export async function assertNativeInteractiveStorage(client: PoolClient,
  session: { id: string; user_id: string; operation_id: string; lease_epoch: number }): Promise<void> {
  const live = await client.query(`SELECT g.operation_id FROM pe_native_interactive_grants g
    JOIN pe_runtime_credentials r ON r.id=g.runtime_credential_id AND r.runtime_id=g.runtime_id
    JOIN pe_credentials b ON b.digest=g.browser_digest AND b.user_id=g.user_id AND b.audience='agent'
    JOIN pe_users u ON u.id=g.user_id
    JOIN pe_attempts a ON a.operation_id=g.operation_id AND a.epoch=$4 AND a.worker_id=g.runtime_id
    WHERE g.operation_id=$1 AND g.session_id=$2 AND g.user_id=$3 AND g.released_at IS NULL
      AND g.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp() AND r.revoked_at IS NULL
      AND r.user_id=g.user_id AND r.generation=g.runtime_generation AND a.ended_at IS NULL
      AND g.credential_version=u.credential_version AND b.credential_version=u.credential_version
      AND r.credential_version=u.credential_version AND b.expires_at>clock_timestamp()
      AND u.enabled AND u.deleted_at IS NULL AND NOT u.password_change_required FOR SHARE OF g,r,b`,
  [session.operation_id, session.id, session.user_id, session.lease_epoch])
  if (live.rowCount !== 1) throw new PlatformError(409, 'native_interactive_authority_lost')
}

/** Require the interactive holder's own current independent Writer before native world access.
 * @param client Original storage or execution authorization transaction.
 * @param session Exact bounded interactive operation and clocks.
 * @returns Completion after the native Writer identity belongs to the same Runtime and operation.
 */
export async function assertNativeInteractiveWorld(client: PoolClient,
  session: { id: string; operation_id: string; lease_epoch: number }): Promise<void> {
  const writer = await client.query(`SELECT w.session_id FROM pe_native_writers w
    JOIN pe_native_interactive_grants g ON g.session_id=w.session_id AND g.runtime_id=w.worker_id
    JOIN pe_attempts a ON a.worker_id=w.worker_id AND a.operation_id=g.operation_id AND a.epoch=$3
    WHERE w.session_id=$1 AND g.operation_id=$2 AND g.released_at IS NULL
      AND w.expires_at>clock_timestamp() AND a.ended_at IS NULL FOR SHARE OF w`,
  [session.id, session.operation_id, session.lease_epoch])
  if (writer.rowCount !== 1) throw new PlatformError(409, 'native_interactive_writer_lost')
}
