/** Durable Cloud requests and Runner wire validation shared by dispatch and resolution. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Persisted Cloud states, including a stopped executor with no verifiable command outcome. */
export type CloudExecutionState = 'queued' | 'starting' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'closed_unknown'
/** Platform-owned execution fields read from PostgreSQL; opaque results remain JSON, not JSONB. */
export interface CloudExecutionRow {
  id: string; user_id: string; session_id: string; operation_id: string; call_id: string
  command: string; cwd: string; request_digest: string; state: CloudExecutionState; cancel_requested: boolean
  result: unknown; error_code: string | null; sandbox_name: string | null; dispatch_request: unknown
  pod_uid: string | null; runner_instance_id: string | null; lease_owner: string | null
  continuation_request_id: string; created_at: Date; attempts: number
}
/** Exact command request captured before the first Runner dispatch. */
export const cloudRunnerRequest = z.object({ id: z.uuid(), command: z.string().min(1).max(8192), cwd: z.string().max(4096),
  timeoutMs: z.number().int().positive(), instanceId: z.uuid() }).strict()
/** Bounded Runner observation; identities and digest must also match the captured request. */
export const cloudRunnerResult = z.object({
  id: z.uuid(), state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  digest: z.string().regex(/^[a-f0-9]{64}$/), exitCode: z.number().int().nullable(),
  stdout: z.string().max(65_536), stderr: z.string().max(65_536),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(), timedOut: z.boolean(), instanceId: z.uuid(),
  fileChanges: z.unknown().optional(),
}).strict()
/**
 * Hash the exact JSON request representation used by admission and Runner dispatch.
 * @param value Ordered request fields.
 * @returns Lowercase SHA-256 digest.
 */
export function cloudRequestDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
/**
 * Use a persisted dispatch request; legacy reconstruction is allowed only by the original admission digest.
 * @param row Durable execution and captured Runner identity.
 * @param legacyTimeoutMs Current timeout, used only if its reconstructed admission digest matches.
 * @returns Verifiable exact request, or null without guessing a historical timeout.
 */
export function capturedRunnerRequest(row: CloudExecutionRow, legacyTimeoutMs: number): z.infer<typeof cloudRunnerRequest> | null {
  if (!row.runner_instance_id) return null
  const raw = row.dispatch_request ?? { id: row.id, command: row.command, cwd: row.cwd,
    timeoutMs: legacyTimeoutMs, instanceId: row.runner_instance_id }
  const parsed = cloudRunnerRequest.safeParse(raw)
  if (!parsed.success) return null
  const request = parsed.data
  if (request.id !== row.id || request.command !== row.command || request.cwd !== row.cwd
    || request.instanceId !== row.runner_instance_id
    || cloudRequestDigest({ command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs }) !== row.request_digest) return null
  return request
}
