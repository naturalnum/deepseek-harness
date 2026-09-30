/** Remote MCP action identities, frozen requests, and metadata-only receipts. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { mcpLeaseOwnerId } from './mcp-contracts.ts'

/** Identity of one approval and its sole possible remote invocation. */
export type McpActionId = Branded<'PowerEvolveMcpActionId'>
/** Identity of a revocable version-specific human permission. */
export type McpPermissionId = Branded<'PowerEvolveMcpPermissionId'>
/** Parse an action UUID independently of user-supplied tool names. */
export const mcpActionId = z.uuid().transform(value => brandString<McpActionId>(value))
/** Parse an approval permission UUID. */
export const mcpPermissionId = z.uuid().transform(value => brandString<McpPermissionId>(value))
/** The Platform resolves routing and versions from the accepted operation's tool name. */
export const mcpActionRequest = z.object({
  // oxlint-disable-next-line no-control-regex -- Durable call keys intentionally exclude every control character.
  callKey: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u),
  toolName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), arguments: z.record(z.string(), z.json()),
}).strict()
/** Terminal uncertain actions never become runnable again. */
export const mcpActionState = z.enum(['pending', 'approved', 'preparing', 'dispatch-intent',
  'succeeded', 'failed', 'rejected', 'cancelled', 'expired', 'uncertain'])
/** Approval choices originate only at the separately authenticated Platform endpoint. */
export const mcpActionDecision = z.enum(['reject', 'once', 'session', 'persistent'])
/** A current worker epoch owns preparation, intent, and completion. */
export const mcpActionLease = z.object({ actionId: mcpActionId, ownerId: mcpLeaseOwnerId,
  epoch: z.number().int().positive() }).strict()
/** Receipt is acceptance/status metadata, never an assertion that execution completed. */
export const mcpActionReceipt = z.object({ actionId: mcpActionId, state: mcpActionState,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), errorCode: z.string().nullable() }).strict()
/** Parsed model invocation before credential resolution. */
export type McpActionRequest = z.infer<typeof mcpActionRequest>
/** Persisted invocation lifecycle. */
export type McpActionState = z.infer<typeof mcpActionState>
/** Explicit human choice; remote annotations cannot create one. */
export type McpActionDecision = z.infer<typeof mcpActionDecision>
/** A permission to work on metadata, not to repeat a committed remote intent. */
export type McpActionLease = z.infer<typeof mcpActionLease>
/** Bounded public status returned by proposal and management. */
export type McpActionReceipt = z.infer<typeof mcpActionReceipt>
