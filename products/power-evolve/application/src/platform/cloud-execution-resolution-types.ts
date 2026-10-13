/** Durable Cloud requests and Runner wire validation shared by dispatch and resolution. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Persisted Cloud states, including a stopped executor with no verifiable command outcome. */
export type CloudExecutionState = 'queued' | 'starting' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'closed_unknown'
/** Legacy command fields selected by explicit kind from PostgreSQL; opaque results remain JSON, not JSONB. */
export interface CloudExecutionRow {
  execution_kind: 'legacy_command'
  /** Historical source fixtures omit v7 fields; the migrated database fills continuation explicitly. */
  result_delivery?: 'continuation' | 'native_tool'
  requested_timeout_ms?: number | null
  command_timeout_ms?: number | null
  native_tool_grant_digest?: string | null
  native_tool_credential_version?: number | null
  native_tool_stop_request_id?: string | null
  native_tool_stop_target?: unknown
  native_tool_cancel_cause?: 'timeout' | 'abort' | null
  id: string
  user_id: string
  session_id: string
  operation_id: string
  call_id: string
  command: string
  cwd: string
  request_digest: string
  state: CloudExecutionState
  cancel_requested: boolean
  result: unknown
  error_code: string | null
  sandbox_name: string | null
  dispatch_request: unknown
  pod_uid: string | null
  runner_instance_id: string | null
  lease_owner: string | null
  continuation_request_id: string
  created_at: Date
  attempts: number
}
/** Exact command request captured before the first Runner dispatch. */
export const cloudRunnerRequest = z.object({ id: z.uuid(), command: z.string().min(1).max(8192), cwd: z.string().max(4096),
  timeoutMs: z.number().int().min(1000).max(300_000), instanceId: z.uuid(), outputMode: z.literal('tail').optional(),
  dshEnv: z.object({ DSH_SHELL: z.literal('1'), DSH_HOME: z.literal('/home/agent/.dsh'),
    DSH_SESSION_ID: z.uuid() }).strict().optional() }).strict()
/** Build only the native variables managed by the authorized Platform.
 * @param sessionId Original execution Session, never supplied by the tool request.
 * @returns Stable ordered fields for native request hashing and Runner dispatch.
 */
export function nativeCloudEnvironment(sessionId: string): NonNullable<z.infer<typeof cloudRunnerRequest>['dshEnv']> {
  return { DSH_SHELL: '1', DSH_HOME: '/home/agent/.dsh', DSH_SESSION_ID: sessionId }
}
/** Bounded Runner observation; identities and digest must also match the captured request. */
export const cloudRunnerResult = z.object({
  id: z.uuid(), state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  digest: z.string().regex(/^[a-f0-9]{64}$/), exitCode: z.number().int().nullable(),
  stdout: z.string().max(65_536), stderr: z.string().max(65_536),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(), timedOut: z.boolean(), instanceId: z.uuid(),
}).strict()
/**
 * Hash the exact JSON request representation used by admission and Runner dispatch.
 * @param value Ordered request fields.
 * @returns Lowercase SHA-256 digest.
 */
export function cloudRequestDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
/**
 * Use an explicitly selected legacy command's persisted dispatch request; reconstruction requires its original admission digest.
 * @param row Durable execution and captured Runner identity.
 * @param legacyTimeoutMs Current timeout, used only if its reconstructed admission digest matches.
 * @returns Verifiable exact request, or null without guessing a historical timeout.
 */
export function capturedRunnerRequest(row: CloudExecutionRow, legacyTimeoutMs: number): z.infer<typeof cloudRunnerRequest> | null {
  if (!row.runner_instance_id) return null
  const raw = row.dispatch_request ?? { id: row.id, command: row.command, cwd: row.cwd,
    timeoutMs: row.command_timeout_ms ?? legacyTimeoutMs, instanceId: row.runner_instance_id,
    ...(row.result_delivery === 'native_tool' ? { outputMode: 'tail', dshEnv: nativeCloudEnvironment(row.session_id) } : {}) }
  const parsed = cloudRunnerRequest.safeParse(raw)
  if (!parsed.success) return null
  const request = parsed.data
  if (request.id !== row.id || request.command !== row.command || request.cwd !== row.cwd
    || request.instanceId !== row.runner_instance_id
    || row.result_delivery === 'native_tool' && (row.command_timeout_ms === null
      || row.command_timeout_ms === undefined || request.timeoutMs !== row.command_timeout_ms || request.outputMode !== 'tail'
      || request.dshEnv?.DSH_SESSION_ID !== row.session_id)
    || row.result_delivery !== 'native_tool' && (request.outputMode !== undefined || request.dshEnv !== undefined)
    || cloudRequestDigest({ command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs,
      ...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }) }) !== row.request_digest) return null
  return request
}
