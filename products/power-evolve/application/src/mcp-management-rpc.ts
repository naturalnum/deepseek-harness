/** Metadata-only native RPC vocabulary; credential bytes use the direct Platform upload capability. */
import { z } from 'zod'
import { mcpCatalogId, mcpCheckId, mcpConnectionId, mcpDraftId, mcpRequestId, mcpSessionId,
  mcpCreateRequest, mcpUpdateRequest, mcpToggleRequest, mcpDeleteRequest, mcpTicketRequest,
  mcpCheckRequest, mcpDraftRequest, type McpConnection, type McpCheck } from './mcp-contracts.ts'

/** Public connection metadata; no endpoint headers or bearer value can cross this parser. */
export const mcpConnectionValue = z.object({
  connectionId: mcpConnectionId, revision: z.number().int().positive(),
  configurationRevision: z.number().int().positive(), credentialRevision: z.number().int().positive().nullable(),
  displayName: z.string().min(1).max(100), serverName: z.string().min(1).max(100),
  serverUrl: z.url().max(2048), transport: z.literal('streamable-http'),
  authentication: z.enum(['none', 'bearer', 'headers']), headerNames: z.array(z.string().min(1).max(200)).max(16),
  secretConfigured: z.boolean(), enabled: z.boolean(), deletedAt: z.iso.datetime().nullable(),
  currentCatalogId: mcpCatalogId.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict() satisfies z.ZodType<McpConnection>

/** Durable discovery state, shared by saved and draft checks. */
export const mcpCheckValue = z.object({
  checkId: mcpCheckId, draftId: mcpDraftId.nullable(), connectionId: mcpConnectionId.nullable(), sessionId: mcpSessionId,
  connectionRevision: z.number().int().positive().nullable(), configurationRevision: z.number().int().positive(),
  credentialRevision: z.number().int().positive().nullable(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  catalogId: mcpCatalogId.nullable(), discoveredTools: z.number().int().nonnegative().nullable(),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u).nullable(), cancelRequested: z.boolean(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict() satisfies z.ZodType<McpCheck>

/** A durable upload/management receipt carries only the owner's public outcome. */
export const mcpManagementResultValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection'), item: mcpConnectionValue }).strict(),
  z.object({ kind: z.literal('check'), item: mcpCheckValue }).strict(),
])

/** A pending ticket authorizes one exact direct upload; replay may return the saved result. */
export const mcpTicketValue = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), requestId: mcpRequestId,
    ticket: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u), uploadUrl: z.url(), expiresAt: z.iso.datetime() }).strict(),
  z.object({ state: z.literal('ready'), result: mcpManagementResultValue }).strict(),
])

/** Request schemas are applied by both native Host admission and trusted Platform resource methods. */
export const mcpManagementRequests = {
  mcpConnectionsList: z.object({}).strict(), mcpConnectionsCreate: mcpCreateRequest,
  mcpConnectionsUpdate: mcpUpdateRequest, mcpConnectionsToggle: mcpToggleRequest,
  mcpConnectionsDelete: mcpDeleteRequest, mcpConnectionsTicket: mcpTicketRequest,
  mcpConnectionsReceipt: z.object({ requestId: mcpRequestId }).strict(),
  mcpConnectionsCheck: mcpCheckRequest, mcpConnectionsDraftCheck: mcpDraftRequest,
  mcpConnectionsCheckStatus: z.object({ checkId: mcpCheckId }).strict(),
  mcpConnectionsCheckCancel: z.object({ checkId: mcpCheckId }).strict(),
}

/** Internal Platform paths; browsers address the corresponding flat native Typert methods. */
export const mcpManagementEndpoints = {
  mcpConnectionsList: '/mcp/connections/list', mcpConnectionsCreate: '/mcp/connections/create',
  mcpConnectionsUpdate: '/mcp/connections/update', mcpConnectionsToggle: '/mcp/connections/toggle',
  mcpConnectionsDelete: '/mcp/connections/delete', mcpConnectionsTicket: '/mcp/connections/ticket',
  mcpConnectionsReceipt: '/mcp/connections/receipt', mcpConnectionsCheck: '/mcp/connections/check',
  mcpConnectionsDraftCheck: '/mcp/connections/draft-check', mcpConnectionsCheckStatus: '/mcp/connections/check-status',
  mcpConnectionsCheckCancel: '/mcp/connections/check-cancel',
} as const
