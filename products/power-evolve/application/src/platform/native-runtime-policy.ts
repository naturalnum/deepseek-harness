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
  const current = await client.query<{ mode: string; permissionGeneration: string }>(`
    SELECT event->'data'->>'mode' AS mode,(seq+2)::text AS "permissionGeneration" FROM pe_events
    WHERE session_id=$1 AND event->>'type'='sandbox/mode' ORDER BY seq DESC LIMIT 1`, [session.id])
  const resolved = policy.parse(current.rows[0] ?? { mode: 'read-only', permissionGeneration: 1 })
  const derived = await client.query<{ parent_mode: string | null }>('SELECT parent_mode FROM pe_native_subagent_grants WHERE session_id=$1 AND operation_id=$2', [session.id, session.operation_id])
  if (!derived.rows[0]) return resolved
  const ceiling = policy.shape.mode.parse(derived.rows[0].parent_mode)
  const order = ['read-only', 'workspace-write', 'danger-full-access'] as const
  return { ...resolved, mode: order.indexOf(resolved.mode) > order.indexOf(ceiling) ? ceiling : resolved.mode }
}
