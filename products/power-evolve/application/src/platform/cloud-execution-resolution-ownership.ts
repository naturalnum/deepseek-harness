/** Cleanup ownership shared by Sandbox and Workspace recovery workers. */
import type { PoolClient } from 'pg'
import { PlatformError } from '../contracts.ts'

/**
 * Refuse a different durable resolution owner while the caller holds the user update lock.
 * Completed intents do not reserve a new mount generation; blocked intents retain their old writer.
 * @param client Existing transaction client.
 * @param userId Owner of the shared writable mount slot.
 * @param requestId Resolution allowed to clean this slot; ordinary cleanup omits it.
 * @returns Resolves only when no other unresolved intent owns cleanup.
 */
export async function assertCloudResolutionCleanup(client: PoolClient, userId: string, requestId?: string): Promise<void> {
  const intent = await client.query(`SELECT request_id FROM pe_cloud_execution_resolutions
    WHERE user_id=$1 AND state<>'completed' AND ($2::uuid IS NULL OR request_id<>$2) LIMIT 1`,
  [userId, requestId ?? null])
  if (intent.rowCount) throw new PlatformError(409, 'execution_resolution_owns_cleanup')
}
