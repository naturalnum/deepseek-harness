/** Version-one management contracts. Secret values belong only to direct Platform intake. */
import { z } from 'zod'

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
export const mcpCreateRequest = z.object({ requestId: z.uuid(), configuration: mcpConfigurationInput }).strict()
/** Compare-and-swap a complete configuration, preserving only explicitly retained secrets. */
export const mcpUpdateRequest = mcpCreateRequest.extend({ connectionId: z.uuid(), baseRevision: revision }).strict()
/** Enablement changes connection authority without modifying immutable endpoint bytes. */
export const mcpToggleRequest = z.object({ requestId: z.uuid(), connectionId: z.uuid(),
  baseRevision: revision, enabled: z.boolean() }).strict()
/** Soft deletion retains historical configuration and idempotency receipts. */
export const mcpDeleteRequest = mcpToggleRequest.omit({ enabled: true }).strict()
/** A draft is an independent immutable check snapshot, optionally based on an owned revision. */
export const mcpDraftRequest = mcpCreateRequest.extend({ sessionId: z.uuid(),
  sourceConnectionId: z.uuid().optional(), baseRevision: revision.optional(),
}).strict().refine(value => (value.sourceConnectionId === undefined) === (value.baseRevision === undefined))
/** Saved discovery pins one owned connection revision and the result's Session. */
export const mcpCheckRequest = z.object({ requestId: z.uuid(), sessionId: z.uuid(),
  connectionId: z.uuid(), baseRevision: revision }).strict()
/** Upload capability purposes cannot be exchanged or used to enable an unrelated connection. */
export const mcpTicketRequest = z.discriminatedUnion('purpose', [
  mcpCreateRequest.extend({ purpose: z.literal('create'), sizeBytes: z.number().int().min(19).max(16_384) }).strict(),
  mcpUpdateRequest.extend({ purpose: z.literal('update'), sizeBytes: z.number().int().min(19).max(16_384) }).strict(),
  z.object({ purpose: z.literal('draft'), requestId: z.uuid(), sessionId: z.uuid(),
    configuration: mcpConfigurationInput, sourceConnectionId: z.uuid().optional(),
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
}).strict()

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
  connectionId: string; revision: number; configurationRevision: number; credentialRevision: number | null
  displayName: string; serverName: string; serverUrl: string; transport: 'streamable-http'
  authentication: 'none' | 'bearer' | 'headers'; headerNames: string[]; secretConfigured: boolean
  enabled: boolean; deletedAt: string | null; currentCatalogId: string | null
  createdAt: string; updatedAt: string
}
/** Durable discovery metadata. Raw credentials and request fingerprints never appear here. */
export interface McpCheck {
  checkId: string; draftId: string | null; connectionId: string | null; sessionId: string
  connectionRevision: number | null; configurationRevision: number; credentialRevision: number | null
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  catalogId: string | null; discoveredTools: number | null; errorCode: string | null
  cancelRequested: boolean; createdAt: string; expiresAt: string
}
/** A lease fences check metadata writes and all private snapshot reads. */
export interface McpCheckLease { checkId: string; ownerId: string; epoch: number }
/** Platform-only immutable connection material for one handshake/listTools check. */
export interface McpPrivateSnapshot {
  userId: string; resourceId: string; configurationRevision: number; credentialRevision: number | null
  serverUrl: string; serverName: string; authentication: 'none' | 'bearer' | 'headers'
  headers: Readonly<Record<string, string>>
}
/** Immutable tool routing identity. Names cannot be decoded to obtain authority. */
export interface McpCatalogTool { toolId: string; publicName: string; descriptorDigest: string; raw: McpDiscoveredTool }
/** Discovery catalog, scoped to an exact connection or draft revision. */
export interface McpCatalog {
  catalogId: string; connectionId: string | null; draftId: string | null
  configurationRevision: number; credentialRevision: number | null; catalogDigest: string
  tools: McpCatalogTool[]; createdAt: string
}
/** Durable original outcome of a management request, returned unchanged on identical replay. */
export type McpManagementResult = { kind: 'connection'; item: McpConnection } | { kind: 'check'; item: McpCheck }
/** Runtime authority is checked against every pinned identity under the caller's transaction. */
export interface McpPinnedConnection {
  connectionId: string; revision: number; configurationRevision: number
  credentialRevision: number | null; catalogId: string
}
/** Deployment-owned limits are required; the service has no hidden deployment defaults. */
export interface McpManagementOptions {
  maxConnections: number; maxPendingTickets: number; maxActiveChecks: number
  maxDrafts: number; maxDraftsPerHour: number; maxTools: number; maxCatalogBytes: number; maxToolBytes: number
  ticketLifetimeMs: number; checkLifetimeMs: number; draftLifetimeMs: number
  retentionMs: number; checkLeaseMs: number
  /** Validate operator-owned outbound policy before reserving state or decrypting a credential. */
  assertEndpoint: (url: string) => void | Promise<void>
}
