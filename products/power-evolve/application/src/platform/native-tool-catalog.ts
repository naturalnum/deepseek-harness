/** Native registration names and durable request headers authorize tools without a plugin-name allowlist. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { mcpModelTool, type McpModelTool } from '../mcp-model-tools.ts'
import { PlatformError } from '../contracts.ts'
import type { TaskStore } from './tasks.ts'
import { transaction } from './database.ts'

const names = z.array(mcpModelTool.shape.name).refine(value => new Set(value).size === value.length)
/** Complete native names sampled before external MCP declarations join the Agent scope. */
export const nativeToolRegistration = z.object({ names, tools: z.array(mcpModelTool).optional() }).strict()

/** Reserve the latest actual native registry for future MCP/STDIO acceptance.
 * @param client User-authorized transaction.
 * @param userId Platform-derived account.
 * @returns Detached names; an account with no native runtime retains the legacy catalog.
 */
export async function readNativeToolNames(client: PoolClient, userId: string): Promise<string[]> {
  const stored = await client.query<{ value: unknown }>(
    'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2', [userId, 'runtime-native-tools'])
  return stored.rows[0] === undefined ? [] : nativeToolRegistration.parse(stored.rows[0].value).names
}

/** Persist the original native registrations under the exact live operation authority.
 * @param tasks Platform lease and account authority.
 * @param token Current operation bearer.
 * @param input Names sampled by the trusted native ToolRuntime before MCP registration.
 * @returns Confirmation after account and lease checks and the durable write commit.
 */
export async function registerNativeToolNames(tasks: TaskStore, token: string,
  input: z.infer<typeof nativeToolRegistration>): Promise<{ registered: true }> {
  return transaction(tasks.pool, async client => {
    const owner = await tasks.authorized(client, token)
    const tools = nativeToolRegistration.parse(input)
    await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)
      ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,
        revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`,
    [owner.user_id, 'runtime-native-tools', tools])
    await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)
      ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,
        revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`,
    [owner.user_id, `runtime-tools:${owner.operation_id}:${owner.lease_epoch}`, tools])
    return { registered: true }
  })
}

/** Read the same committed native header the Agent loop froze before model egress.
 * @param client Exact current operation transaction, already authorized by TaskStore.
 * @param sessionId Owned Session identity from that authorization.
 * @param admitted Frozen external definitions from the accepted operation.
 * @returns Native schemas from the latest logged header, or absence for a legacy caller without a header.
 */
export async function readNativeModelTools(client: PoolClient,
  operation: { id: string; user_id: string; operation_id: string; lease_epoch: number },
  admitted: readonly McpModelTool[]): Promise<McpModelTool[] | undefined> {
  const registry = await client.query<{ value: unknown }>(
    'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
    [operation.user_id, `runtime-tools:${operation.operation_id}:${operation.lease_epoch}`])
  const required = await client.query(`SELECT 1 FROM pe_attempts a JOIN pe_runtime_credentials r ON r.runtime_id=a.worker_id
    WHERE a.operation_id=$1 AND a.epoch=$2 AND r.user_id=$3`, [operation.operation_id, operation.lease_epoch, operation.user_id])
  const frozen = registry.rows[0] === undefined ? undefined : nativeToolRegistration.parse(registry.rows[0].value)
  if (required.rowCount && frozen?.tools === undefined) throw new PlatformError(403, 'native_tool_snapshot_missing')
  const stored = await client.query<{ event: unknown }>(
    `SELECT event FROM pe_events WHERE session_id=$1 AND event->>'type'='request/header'
      AND seq>(SELECT COALESCE(max(seq),-1) FROM pe_events WHERE session_id=$1 AND event->>'type'='step/start')
      ORDER BY seq DESC LIMIT 1`, [operation.id])
  if (stored.rows[0] === undefined) {
    if (required.rowCount || frozen !== undefined) throw new PlatformError(403, 'native_tool_snapshot_missing')
    return undefined
  }
  const value = z.object({ data: z.object({ header: z.object({ tools: z.array(mcpModelTool.extend({
    deferLoading: z.literal(true).optional(),
  })).optional() }) }) }).parse(stored.rows[0].event)
  const external = new Map(admitted.map(tool => [tool.name, tool]))
  const native: McpModelTool[] = []
  for (const tool of value.data.header.tools ?? []) {
    const original = external.get(tool.name)
    const schema = mcpModelTool.parse({ name: tool.name, description: tool.description, parameters: tool.parameters })
    if (original !== undefined) {
      if (!isDeepStrictEqual(schema, original)) throw new PlatformError(403, 'model_tool_not_authorized')
    } else {
      if (frozen?.tools !== undefined && !frozen.tools.some(registered => isDeepStrictEqual(registered, schema))) {
        throw new PlatformError(403, 'model_tool_not_authorized')
      }
      native.push(schema)
    }
  }
  return native
}
