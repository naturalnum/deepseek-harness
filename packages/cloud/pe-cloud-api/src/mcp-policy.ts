/** Explicit opt-in HTTP MCP policy; credentials and account identities never appear in deployment JSON. */
import { z } from 'zod'
import type { McpStoreLimits } from '@deepseek-ai/dsh-pe-cloud-files'
import type { McpConnectionRuntimePolicy } from './mcp-connection-runtime.ts'

/** Reviewed policy for the optional account MCP entry. */
export interface ApprovedMcpConnections {
  readonly limits: McpStoreLimits & { readonly maxRequestBytes: number; readonly maxReplyBytes: number }
  readonly runtime: McpConnectionRuntimePolicy
}
/** Parse the closed deployment policy before account assembly.
 * @param input Untrusted Root Loader value.
 * @returns Detached finite HTTP-only policy; absence must be handled by the caller as disabled.
 */
export function mcpConnectionsPolicy(input: unknown): ApprovedMcpConnections {
  const positive = z.number().int().positive().max(2147483647)
  const value = z.strictObject({ limits: z.strictObject({ maxConnections: positive.max(64),
    maxUrlBytes: positive.max(65536), maxHeaderBytes: positive.max(65536), maxHeaderCount: positive.max(64),
    maxToolCallTimeoutMs: positive, maxRequestBytes: positive.max(1048576), maxReplyBytes: positive.max(1048576) }),
  runtime: z.strictObject({ maxInstructionBytes: positive.max(1048576), maxIncomingResponseBytes: positive.max(67108864),
    listMaxPages: positive.max(64), reconnect: z.strictObject({
      enabled: z.boolean(), initialDelayMs: positive, maxDelayMs: positive, maxAttempts: positive }) }) }).parse(input)
  if (value.runtime.reconnect.maxDelayMs < value.runtime.reconnect.initialDelayMs
    || value.limits.maxReplyBytes < value.limits.maxConnections * (6 * value.limits.maxUrlBytes + 512) + 512
    || value.limits.maxRequestBytes < value.limits.maxHeaderBytes + 6 * value.limits.maxUrlBytes + 512) {
    throw new Error('cloud/invalid-mcp-budgets')
  }
  return Object.freeze({ limits: Object.freeze(value.limits), runtime: Object.freeze({
    maxInstructionBytes: value.runtime.maxInstructionBytes, maxIncomingResponseBytes: value.runtime.maxIncomingResponseBytes,
    listMaxPages: value.runtime.listMaxPages, reconnect: Object.freeze(value.runtime.reconnect) }) })
}
