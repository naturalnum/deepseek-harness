/** Select complete current MCP catalogs during durable input acceptance; never perform network I/O. */
import type { PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { PlatformError, type UserId } from '../contracts.ts'
import { mcpDiscoveredTool, mcpToolId, type McpConnectionId } from '../mcp-contracts.ts'
import { compileMcpModelTool, McpToolAdmissionError, type McpToolAdmissionLimits } from '../mcp-model-tools.ts'
import { mcpOperationTool, type McpOperationTool } from '../mcp-operation-contracts.ts'
import { z } from 'zod'
import { mcpCanonicalJson } from './mcp-credentials.ts'

/** Bounded per-operation admission, independent of the number of installed connections. */
export interface McpOperationAdmissionLimits extends McpToolAdmissionLimits {
  maxTools: number
  maxSnapshotBytes: number
}

const catalogTools = z.array(z.object({ toolId: mcpToolId, publicName: z.string(),
  descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u), raw: mcpDiscoveredTool }).strict())

/**
 * Pin enabled, discovered connections without exposing credentials to the shared Host.
 * @param client Acceptance transaction; the caller already holds the authenticated user's lock.
 * @param userId Authenticated owner, never an ID supplied by an Agent.
 * @param limits Deployment bounds for the complete selection; excess is refused, never truncated.
 * @returns Detached, versioned tool records to persist atomically with the accepted input.
 */
export async function selectMcpOperationTools(client: PoolClient, userId: UserId,
  limits: McpOperationAdmissionLimits): Promise<McpOperationTool[]> {
  const catalogs = await client.query<{ connection_id: McpConnectionId
    display_name: string
    revision: number
    configuration_revision: number
    credential_revision: number | null
    catalog_id: string
    tools: unknown }>(
    `SELECT c.id AS connection_id,c.revision,c.configuration_revision,v.credential_revision,
      v.configuration->>'displayName' AS display_name,cat.id AS catalog_id,cat.tools FROM pe_mcp_remote_connections c
     JOIN pe_mcp_configuration_versions v ON v.connection_id=c.id AND v.user_id=c.user_id
       AND v.configuration_revision=c.configuration_revision
     JOIN pe_mcp_catalog_versions cat ON cat.id=c.current_catalog_id AND cat.user_id=c.user_id
       AND cat.connection_id=c.id AND cat.configuration_revision=c.configuration_revision
       AND cat.credential_revision IS NOT DISTINCT FROM v.credential_revision
     WHERE c.user_id=$1 AND c.enabled AND c.deleted_at IS NULL ORDER BY c.id FOR SHARE OF c`, [userId])
  const selection: McpOperationTool[] = []
  const names = new Set<string>()
  let bytes = 2
  for (const row of catalogs.rows) {
    for (const tool of catalogTools.parse(row.tools)) {
      if (names.has(tool.publicName)) throw new PlatformError(409, 'mcp_tool_name_conflict')
      names.add(tool.publicName)
      let model
      try { model = compileMcpModelTool(tool, limits,
        { connectionId: row.connection_id, displayName: row.display_name }) }
      catch (error) {
        if (error instanceof McpToolAdmissionError) throw new PlatformError(409, error.code)
        throw error
      }
      const saved = mcpOperationTool.parse({ formatVersion: 1, connectionId: row.connection_id,
        connectionRevision: row.revision, configurationRevision: row.configuration_revision,
        credentialRevision: row.credential_revision, catalogId: row.catalog_id,
        toolId: tool.toolId, descriptorDigest: tool.descriptorDigest, raw: tool.raw, model,
        modelDigest: createHash('sha256').update(mcpCanonicalJson(model)).digest('hex') })
      bytes += Buffer.byteLength(JSON.stringify(saved)) + (selection.length > 0 ? 1 : 0)
      if (selection.length >= limits.maxTools || bytes > limits.maxSnapshotBytes) {
        throw new PlatformError(429, 'mcp_operation_tool_limit')
      }
      selection.push(saved)
    }
  }
  return selection
}
