/** Pure typed reference declarations for accepted MCP tools and captured Cloud storage identities. */
import { mcpOperationTool, mcpOperationTools } from '../mcp-operation-contracts.ts'
import { LegacyImportError } from './legacy-import-codec.ts'
import { storageBinding } from './cloud-storage-types.ts'
import type { LegacyJsonReference, LegacyOwnerContext, LegacyReferenceValue } from './legacy-import-preflight.ts'

function jsonValue(path: readonly (string | number)[]): LegacyReferenceValue { return { kind: 'json', path } }
function catalogReferences(column: string, prefix: readonly (string | number)[]): readonly LegacyJsonReference[] {
  const field = (targetColumn: string, key: string) => ({ targetColumn, value: jsonValue([...prefix, key]) })
  const owner = { targetColumn: 'user_id', value: { kind: 'owner' as const } }
  return [
    { column, targetTable: 'pe_mcp_catalog_versions', ownership: 'same', fields: [
      field('id', 'catalogId'), owner, field('connection_id', 'connectionId'),
      field('configuration_revision', 'configurationRevision'), field('credential_revision', 'credentialRevision'),
    ] },
    { column, targetTable: 'pe_mcp_configuration_versions', ownership: 'same', fields: [
      field('connection_id', 'connectionId'), owner, field('configuration_revision', 'configurationRevision'),
      field('credential_revision', 'credentialRevision'),
    ] },
  ]
}
/** Declare exact historical catalog/configuration tuples without interpreting raw tool schemas or arguments.
 * @param context Owner-validated Operation selection or MCP action with its original JSON.
 * @returns Typed identity paths; unsupported tables and invalid typed payloads reject.
 */
export function legacyMcpJsonReferences(context: LegacyOwnerContext): readonly LegacyJsonReference[] {
  if (context.row.table === 'pe_operations') {
    const tools = mcpOperationTools.parse(context.json.remote_mcp_selection)
    return tools.flatMap((_tool, index) => catalogReferences('remote_mcp_selection', [index]))
  }
  if (context.row.table === 'pe_mcp_actions') {
    mcpOperationTool.parse(context.json.tool)
    return catalogReferences('tool', [])
  }
  throw new LegacyImportError('json_reference_owner_unsupported')
}
/** Verify captured generation and declare immutable storage identities independently of today's binding address.
 * @param context Completed Cloud resolution with its original binding snapshot.
 * @returns Workspace and storage-space identities; current mutable binding paths are not substituted.
 */
export function legacyResolutionJsonReferences(context: LegacyOwnerContext): readonly LegacyJsonReference[] {
  if (context.row.table !== 'pe_cloud_execution_resolutions') throw new LegacyImportError('json_reference_owner_unsupported')
  const binding = storageBinding.parse(context.json.binding_snapshot)
  if (String(binding.generation) !== context.row.values.mount_generation
    || binding.workspaceId !== context.row.values.workspace_id) throw new LegacyImportError('json_identity_changed')
  return [
    { column: 'binding_snapshot', targetTable: 'pe_workspaces', ownership: 'same', fields: [
      { targetColumn: 'id', value: { kind: 'json', path: ['workspaceId'], equalsRowColumn: 'workspace_id' } },
      { targetColumn: 'user_id', value: { kind: 'owner' } },
    ] },
    { column: 'binding_snapshot', targetTable: 'pe_storage_spaces', ownership: 'same', fields: [
      { targetColumn: 'id', value: jsonValue(['spaceId']) },
      { targetColumn: 'root_key', value: jsonValue(['rootKey']) },
      { targetColumn: 'user_id', value: { kind: 'owner' } },
    ] },
  ]
}
