/** One canonical identity algorithm for private discovery storage and admitted model tools. */
import { createHash } from 'node:crypto'
import { mcpDiscoveredTool, mcpResourceId, mcpToolId, type McpCatalogTool,
  type McpDiscoveredTool, type McpResourceId, type McpToolId } from '../mcp-contracts.ts'
import { PlatformError } from '../contracts.ts'
import { mcpCanonicalJson } from './mcp-credentials.ts'

const hash = (value: unknown) => createHash('sha256').update(mcpCanonicalJson(value)).digest('hex')

/** Hash every original MCP JSON field, including extension metadata.
 * @param raw Complete validated raw descriptor.
 * @returns SHA-256 of canonical JSON v1.
 */
export function mcpDescriptorDigest(raw: McpDiscoveredTool): string { return hash(mcpDiscoveredTool.parse(raw)) }

/** Catalog ordering is canonical; duplicate names remain invalid rather than silently overwritten.
 * @param rawTools Complete discovered descriptor list, including a legitimate empty list.
 * @returns Version-one catalog identity independent of server list ordering.
 */
export function mcpCatalogDigest(rawTools: readonly McpDiscoveredTool[]): string {
  const tools = rawTools.map(raw => mcpDiscoveredTool.parse(raw))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new PlatformError(502, 'mcp_tool_duplicate')
  return hash({ formatVersion: 1, tools })
}

/** Derive a deterministic UUID v8 in a resource namespace; tool names never carry routing authority.
 * @param resourceId Owned connection/draft UUID.
 * @param rawName Raw MCP name.
 * @returns Stable branded tool UUID.
 */
export function mcpStableToolId(resourceId: McpResourceId, rawName: string): McpToolId {
  mcpResourceId.parse(resourceId)
  const bytes = Buffer.from(hash({ formatVersion: 1, resourceId, rawName }), 'hex').subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 128
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = bytes.toString('hex')
  return mcpToolId.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)
}

/** Keep public names within 63 ASCII characters, retaining full UUIDs in saved routing metadata.
 * @param resourceId Connection/draft namespace.
 * @param toolId Full stable tool UUID, separately persisted.
 * @returns Model-visible name; never parse it back for authorization.
 */
export function mcpPublicToolName(resourceId: McpResourceId, toolId: McpToolId): string {
  return `mcp__${mcpResourceId.parse(resourceId).replaceAll('-', '')}__${mcpToolId.parse(toolId).replaceAll('-', '').slice(0, 24)}`
}

/** Build all immutable mappings; any collision fails the entire catalog.
 * @param resourceId Connection/draft namespace.
 * @param rawTools Complete discovery result; caller enforces configured byte/count budgets.
 * @returns Stable mappings preserving each descriptor's original JSON fields.
 */
export function mcpCatalogTools(resourceId: McpResourceId, rawTools: readonly McpDiscoveredTool[]): McpCatalogTool[] {
  mcpCatalogDigest(rawTools)
  const tools = rawTools.map(value => {
    const raw = mcpDiscoveredTool.parse(value), toolId = mcpStableToolId(resourceId, raw.name)
    return { toolId, publicName: mcpPublicToolName(resourceId, toolId), descriptorDigest: mcpDescriptorDigest(raw), raw }
  }).sort((left, right) => left.raw.name < right.raw.name ? -1 : left.raw.name > right.raw.name ? 1 : 0)
  if (new Set(tools.map(tool => tool.publicName)).size !== tools.length) throw new PlatformError(502, 'mcp_tool_collision')
  return tools
}
