/** Immutable MCP selections cross the Platform/Host boundary without connection credentials. */
import { z } from 'zod'
import { mcpCatalogId, mcpConnectionId, mcpDiscoveredTool, mcpToolId } from './mcp-contracts.ts'
import { mcpModelTool } from './mcp-model-tools.ts'

/** One exact discovered tool admitted to an Operation; approval remains a separate decision. */
export const mcpOperationTool = z.object({
  formatVersion: z.literal(1), connectionId: mcpConnectionId, connectionRevision: z.number().int().positive(),
  configurationRevision: z.number().int().positive(), credentialRevision: z.number().int().positive().nullable(),
  catalogId: mcpCatalogId, toolId: mcpToolId, descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  raw: mcpDiscoveredTool, model: mcpModelTool, modelDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

/** The total accepted selection is bounded by Platform admission configuration. */
export const mcpOperationTools = z.array(mcpOperationTool)
/** Tool routing, original argument rules, and exact model declaration fixed at acceptance. */
export type McpOperationTool = z.infer<typeof mcpOperationTool>
