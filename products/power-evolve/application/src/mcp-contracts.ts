/** Version-one management contracts. Secret values belong only to direct Platform intake. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RequestId, UserId } from './contracts.ts'

/** Identity of a generic remote connection; legacy fixed-preset IDs remain distinct. */
export type McpConnectionId = Branded<'PowerEvolveMcpConnectionId'>
/** Identity of an immutable discovery catalog. */
export type McpCatalogId = Branded<'PowerEvolveMcpCatalogId'>
/** Identity of one durable discovery attempt. */
export type McpCheckId = Branded<'PowerEvolveMcpCheckId'>
/** Identity of one immutable unsaved configuration. */
export type McpDraftId = Branded<'PowerEvolveMcpDraftId'>
/** Stable identity of one raw tool within a connection/draft namespace. */
export type McpToolId = Branded<'PowerEvolveMcpToolId'>
/** Ciphertext resource identity is independently validated at its private boundary. */
export type McpResourceId = Branded<'PowerEvolveMcpResourceId'>
/** Check worker identity; an epoch is additionally required for writes. */
export type McpLeaseOwnerId = Branded<'PowerEvolveMcpLeaseOwnerId'>
/** Validate a generic connection's wire UUID. */
export const mcpConnectionId = z.uuid().transform(value => brandString<McpConnectionId>(value))
/** Validate an immutable catalog's wire UUID. */
export const mcpCatalogId = z.uuid().transform(value => brandString<McpCatalogId>(value))
/** Validate a check's wire UUID. */
export const mcpCheckId = z.uuid().transform(value => brandString<McpCheckId>(value))
/** Validate a draft's wire UUID. */
export const mcpDraftId = z.uuid().transform(value => brandString<McpDraftId>(value))
/** Validate a stable tool's wire UUID. */
export const mcpToolId = z.uuid().transform(value => brandString<McpToolId>(value))
/** Validate an encryption resource UUID. */
export const mcpResourceId = z.uuid().transform(value => brandString<McpResourceId>(value))
/** Validate a check lease owner's wire UUID. */
export const mcpLeaseOwnerId = z.uuid().transform(value => brandString<McpLeaseOwnerId>(value))
/** Validate the existing product request identity without a runtime contracts dependency. */
export const mcpRequestId = z.uuid().transform(value => brandString<RequestId>(value))
/** Validate the existing user identity at private SQL/transport boundaries. */
export const mcpUserId = z.uuid().transform(value => brandString<UserId>(value))
/** Native Session identity; JSON transport continues to use UUID strings. */
export const mcpSessionId = z.uuid().transform(brandString<SessionId>)

const revision = z.number().int().positive()
const text = z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
const headerName = z.string().trim().min(1).max(200)

/** Public configuration carries credential intent, never credential bytes. */
export const mcpConfigurationInput = z.object({
  displayName: text, serverUrl: z.string().trim().min(1).max(2048), enabled: z.boolean(),
  authentication: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('bearer'), action: z.enum(['retain', 'replace', 'clear']) }).strict(),
    z.object({ kind: z.literal('headers'), headers: z.array(z.object({
      name: headerName, action: z.enum(['retain', 'replace']),
    }).strict()).min(1).max(16) }).strict(),
  ]),
}).strict()

/** Create metadata; replacement credentials require a direct-upload ticket. */
export const mcpCreateRequest = z.object({ requestId: mcpRequestId, configuration: mcpConfigurationInput }).strict()
/** Compare-and-swap a complete configuration, preserving only explicitly retained secrets. */
export const mcpUpdateRequest = mcpCreateRequest.extend({ connectionId: mcpConnectionId, baseRevision: revision }).strict()
/** Enablement changes connection authority without modifying immutable endpoint bytes. */
export const mcpToggleRequest = z.object({ requestId: mcpRequestId, connectionId: mcpConnectionId,
  baseRevision: revision, enabled: z.boolean() }).strict()
/** Soft deletion retains historical configuration and idempotency receipts. */
export const mcpDeleteRequest = mcpToggleRequest.omit({ enabled: true }).strict()
/** A draft is an independent immutable check snapshot, optionally based on an owned revision. */
export const mcpDraftRequest = mcpCreateRequest.extend({ sessionId: mcpSessionId,
  sourceConnectionId: mcpConnectionId.optional(), baseRevision: revision.optional(),
}).strict().refine(value => (value.sourceConnectionId === undefined) === (value.baseRevision === undefined))
/** Saved discovery pins one owned connection revision and the result's Session. */
export const mcpCheckRequest = z.object({ requestId: mcpRequestId, sessionId: mcpSessionId,
  connectionId: mcpConnectionId, baseRevision: revision }).strict()
/** Upload capability purposes cannot be exchanged or used to enable an unrelated connection. */
export const mcpTicketRequest = z.discriminatedUnion('purpose', [
  mcpCreateRequest.extend({ purpose: z.literal('create'), sizeBytes: z.number().int().min(19).max(16_384) }).strict(),
  mcpUpdateRequest.extend({ purpose: z.literal('update'), sizeBytes: z.number().int().min(19).max(16_384) }).strict(),
  z.object({ purpose: z.literal('draft'), requestId: mcpRequestId, sessionId: mcpSessionId,
    configuration: mcpConfigurationInput, sourceConnectionId: mcpConnectionId.optional(),
    baseRevision: revision.optional(), sizeBytes: z.number().int().min(19).max(16_384),
  }).strict().refine(value => (value.sourceConnectionId === undefined) === (value.baseRevision === undefined)),
])
/** Only the Platform upload endpoint accepts this versioned secret envelope. */
export const mcpCredentialUpload = z.object({ formatVersion: z.literal(1), bearerToken: z.string().optional(),
  headers: z.array(z.object({ name: headerName, value: z.string() }).strict()).max(16).optional(),
}).strict()
/** Raw discovery retains MCP JSON fields, including escaped NUL in untrusted descriptions. */
export const mcpDiscoveredTool = z.object({ name: z.string().min(1).max(128)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value)), description: z.string().optional(),
inputSchema: z.record(z.string(), z.json()), outputSchema: z.record(z.string(), z.json()).optional(),
annotations: z.record(z.string(), z.json()).optional(),
execution: z.record(z.string(), z.json()).optional(), _meta: z.record(z.string(), z.json()).optional(),
title: z.string().optional(),
}).catchall(z.json())

/** Metadata-only complete configuration request. */
export type McpConfigurationInput = z.infer<typeof mcpConfigurationInput>
/** Capability issuance request, without any secret values. */
export type McpTicketRequest = z.infer<typeof mcpTicketRequest>
/** Direct Platform credential body. Never expose this type through Host RPC. */
export type McpCredentialUpload = z.infer<typeof mcpCredentialUpload>
/** Persisted untrusted MCP tool descriptor, not a permission grant. */
export type McpDiscoveredTool = z.infer<typeof mcpDiscoveredTool>
/** Public live/historical connection metadata with explicit credential readiness. */
export interface McpConnection {
  connectionId: McpConnectionId
  revision: number
  configurationRevision: number
  credentialRevision: number | null
  displayName: string
  serverName: string
  serverUrl: string
  transport: 'streamable-http'
  authentication: 'none' | 'bearer' | 'headers'
  headerNames: string[]
  secretConfigured: boolean
  enabled: boolean
  deletedAt: string | null
  currentCatalogId: McpCatalogId | null
  createdAt: string
  updatedAt: string
}
/** Durable discovery metadata. Raw credentials and request fingerprints never appear here. */
export interface McpCheck {
  checkId: McpCheckId
  draftId: McpDraftId | null
  connectionId: McpConnectionId | null
  sessionId: SessionId
  connectionRevision: number | null
  configurationRevision: number
  credentialRevision: number | null
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  catalogId: McpCatalogId | null
  discoveredTools: number | null
  errorCode: string | null
  cancelRequested: boolean
  createdAt: string
  expiresAt: string
}
/** A lease fences check metadata writes and all private snapshot reads. */
export interface McpCheckLease { checkId: McpCheckId; ownerId: McpLeaseOwnerId; epoch: number }
/** Platform-only immutable connection material for one handshake/listTools check. */
export interface McpPrivateSnapshot {
  userId: UserId
  resourceId: McpResourceId
  configurationRevision: number
  credentialRevision: number | null
  serverUrl: string
  serverName: string
  authentication: 'none' | 'bearer' | 'headers'
  headers: Readonly<Record<string, string>>
}
/** Immutable tool routing identity. Names cannot be decoded to obtain authority. */
export interface McpCatalogTool { toolId: McpToolId; publicName: string; descriptorDigest: string; raw: McpDiscoveredTool }
/** Discovery catalog, scoped to an exact connection or draft revision. */
export interface McpCatalog {
  catalogId: McpCatalogId
  connectionId: McpConnectionId | null
  draftId: McpDraftId | null
  configurationRevision: number
  credentialRevision: number | null
  catalogDigest: string
  tools: McpCatalogTool[]
  createdAt: string
}
/** Durable original outcome of a management request, returned unchanged on identical replay. */
export type McpManagementResult = { kind: 'connection'; item: McpConnection } | { kind: 'check'; item: McpCheck }
/** Runtime authority is checked against every pinned identity under the caller's transaction. */
export interface McpPinnedConnection {
  connectionId: McpConnectionId
  revision: number
  configurationRevision: number
  credentialRevision: number | null
  catalogId: McpCatalogId
}
/** Deployment-owned limits are required; the service has no hidden deployment defaults. */
export interface McpManagementOptions {
  maxConnections: number
  maxPendingTickets: number
  maxActiveChecks: number
  maxDrafts: number
  maxDraftsPerHour: number
  maxTools: number
  maxCatalogBytes: number
  maxToolBytes: number
  ticketLifetimeMs: number
  checkLifetimeMs: number
  draftLifetimeMs: number
  retentionMs: number
  checkLeaseMs: number
  /** Validate operator-owned outbound policy before reserving state or decrypting a credential. */
  assertEndpoint: (url: string) => void | Promise<void>
}
