/** Disposable presentation cleanup without changing canonical events or accepted work. */
import { PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'

/** Release only the original writer's presentation after its local Agent and publisher drain.
 * @param tasks Authority for the captured live operation grant and transaction pool.
 * @param token Original grant; a Session identifier never substitutes for authorization.
 * @param publisherId Exact writer identity captured when its persistence handle opened.
 * @returns Successful idempotent release after the same grant passes the final clock check.
 */
export async function releaseNativeAssistant(tasks: TaskStore, token: string,
  publisherId: string): Promise<{ released: true }> {
  return transaction(tasks.pool, async (client) => {
    const row = await tasks.authorized(client, token)
    const current = await client.query<{ publisher_id: string }>(
      'SELECT publisher_id FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2 FOR UPDATE', [row.id, row.lease_epoch])
    if (current.rows[0] && current.rows[0].publisher_id !== publisherId) throw new PlatformError(409, 'native_assistant_publisher')
    await client.query('DELETE FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2 AND publisher_id=$3',
      [row.id, row.lease_epoch, publisherId])
    await tasks.authorized(client, token)
    return { released: true }
  })
}

/** Collect superseded or expired unowned presentations; live operation state and busy publishers are retained.
 * @param tasks Pool whose native schema and statement deadline belong to the Platform.
 * @returns Number of presentation parents removed; FK cascade removes their temporary entries.
 */
export async function pruneNativeAssistant(tasks: TaskStore): Promise<number> {
  const result = await tasks.pool.query(`DELETE FROM pe_native_presentations WHERE session_id IN (
    SELECT p.session_id FROM pe_native_presentations p JOIN pe_sessions s ON s.id=p.session_id
    WHERE p.epoch<=s.lease_epoch AND (p.epoch<s.lease_epoch OR (p.expires_at<=clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
        WHERE o.session_id=s.id AND o.state='running' AND s.grant_digest IS NOT NULL
          AND s.lease_until>clock_timestamp() AND a.epoch=s.lease_epoch AND a.ended_at IS NULL)))
    ORDER BY p.updated_at,p.session_id LIMIT 100 FOR UPDATE OF p SKIP LOCKED)`)
  return result.rowCount ?? 0
}
