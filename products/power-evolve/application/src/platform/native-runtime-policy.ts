/** Committed native sandbox events are the sole permission authority for execution-world generations. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { TaskStore } from './tasks.ts'

const policy = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  permissionGeneration: z.coerce.number().int().positive() }).strict()

/** Resolve the last durable native mode, refusing request-time mode claims and retaining a read-only empty-log fallback.
 * @param client Existing account and Session-locked authorization transaction.
 * @param session Exact authorized original or derived Session.
 * @returns Native file policy and an event-position generation; every later mode event fences the old world.
 */
export async function readNativeRuntimePolicy(client: PoolClient,
  session: Pick<Awaited<ReturnType<TaskStore['authorized']>>, 'id' | 'operation_id'>): Promise<z.infer<typeof policy>> {
  return readNativeSessionExecutionPolicy(client, session.id, session.operation_id)
}

/** Read committed policy for an owned storage Session, optionally retaining an original derived operation ceiling.
 * @param client Existing account and Session-locked transaction.
 * @param sessionId Original owned storage Session; no writer or model turn is created.
 * @param operationId Original model operation when the execution originated in a claimed turn.
 * @returns Last committed mode and its event-position generation, or the read-only empty-log policy.
 */
export async function readNativeSessionExecutionPolicy(client: PoolClient, sessionId: string,
  operationId?: string): Promise<z.infer<typeof policy>> {
  const current = await client.query<{ mode: string; permissionGeneration: string }>(`
    SELECT event->'data'->>'mode' AS mode,(seq+2)::text AS "permissionGeneration" FROM pe_events
    WHERE session_id=$1 AND event->>'type'='sandbox/mode' ORDER BY seq DESC LIMIT 1`, [sessionId])
  const resolved = policy.parse(current.rows[0] ?? { mode: 'read-only', permissionGeneration: 1 })
  if (operationId === undefined) return resolved
  const derived = await client.query<{ parent_mode: string | null }>('SELECT parent_mode FROM pe_native_subagent_grants WHERE session_id=$1 AND operation_id=$2', [sessionId, operationId])
  if (!derived.rows[0]) return resolved
  const ceiling = policy.shape.mode.parse(derived.rows[0].parent_mode)
  const order = ['read-only', 'workspace-write', 'danger-full-access'] as const
  return { ...resolved, mode: order.indexOf(resolved.mode) > order.indexOf(ceiling) ? ceiling : resolved.mode }
}
