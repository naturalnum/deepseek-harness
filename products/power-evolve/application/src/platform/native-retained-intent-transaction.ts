/** Caller-owned native mutation transactions acknowledge the journal before the original final fence. */
import type { Pool, PoolClient } from 'pg'
import { PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'

/** Acknowledgement uses the same connection and cannot replace the provider's final authority proof. */
export interface NativeRetainedTransaction<T> {
  readonly client: PoolClient
  readonly acknowledge: (result: T) => Promise<void>
}

/** Use the original direct transaction or the retained intent's already locked transaction.
 * @param pool Actual Platform database owner for a direct service call.
 * @param context Private retained execution connection and acknowledgement, when installed.
 * @param operation Original native provider work, including all existing final checks.
 * @returns Result after the caller-owned transaction or the direct transaction settles.
 */
export function nativeRetainedTransaction<T, R>(pool: Pool, context: NativeRetainedTransaction<R> | undefined,
  operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return context ? operation(context.client) : transaction(pool, operation)
}

/** Reject a direct mutation while its Session has an unresolved retained request.
 * @param client Transaction already holding the actual owned Session lock.
 * @param sessionId Actual authorized Session, never an unverified request scope.
 * @param retained Whether the caller is executing the sealed request in its journal transaction.
 */
export async function assertNativeRetainedBarrier(client: PoolClient, sessionId: string, retained: boolean): Promise<void> {
  if (retained) return
  const pending = await client.query("SELECT 1 FROM pe_native_retained_intents WHERE session_id=$1 AND state='prepared' LIMIT 1", [sessionId])
  if (pending.rowCount) throw new PlatformError(409, 'native_intent_pending')
}
