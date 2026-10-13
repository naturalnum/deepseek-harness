/** Original fixed-preset MCP metadata and complete toggle receipts; no network check or credential authority is replayed. */
import { z } from 'zod'
import { mcpSelection } from '../contracts.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Retained fixed-preset MCP owners, independent of generic encrypted remote-MCP configuration. */
export const LEGACY_MIGRATION_FIXED_MCP_TABLES: ReadonlySet<string> = new Set(['pe_mcp_connections', 'pe_mcp_updates'])
const originalResult = z.object({ connectionId: z.uuid(), name: z.string().min(1).max(80), enabled: z.boolean(),
  revision: z.number().int().min(2).max(2_147_483_647), toolName: z.literal('mcp__personal__whoami'),
  description: z.literal('读取当前账户标识（只读）') }).strict()
function connection(rows: readonly LegacyPlannedRow[], row: LegacyPlannedRow) {
  const owner = rows.find(item => item.table === 'pe_mcp_connections' && item.values.id === row.values.connection_id
    && item.values.user_id === row.values.user_id)
  if (!owner) throw new LegacyImportError('migration_fixed_mcp_owner_missing')
  return owner
}
function receipt(row: LegacyPlannedRow, owner: LegacyPlannedRow, limits: LegacyImportLimits) {
  const result = originalResult.parse(legacyJson(row.values.result ?? '', limits))
  if (result.connectionId !== owner.values.id || result.name !== owner.values.name
    || result.revision > Number(owner.values.revision) || row.values.request_digest !== legacyDigest(JSON.stringify({
    connectionId: result.connectionId, baseRevision: result.revision - 1, enabled: result.enabled,
  })) || legacyTimestamp(row.values.created_at ?? '') < legacyTimestamp(owner.values.created_at ?? '')
    || legacyTimestamp(row.values.created_at ?? '') > legacyTimestamp(owner.values.updated_at ?? '')) {
    throw new LegacyImportError('migration_fixed_mcp_receipt_invalid')
  }
  return result
}

/** Validate selected fixed MCP rows against original install identities and the complete historical toggle chain.
 * @param row Original source-preserving row after fixed-layout cell parsing.
 * @param rows Complete selected owner and receipt inventory.
 * @param limits Explicit row and JSON budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @returns Whether this module owns the table; other retained owners remain rejected by the plan.
 */
export function validateLegacyMigrationFixedMcp(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string): boolean {
  if (!LEGACY_MIGRATION_FIXED_MCP_TABLES.has(row.table)) return false
  const value = row.values
  if (legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) throw new LegacyImportError('migration_fixed_mcp_future')
  if (row.table === 'pe_mcp_updates') {
    receipt(row, connection(rows, row), limits)
    return true
  }
  const revision = Number(value.revision)
  if (!rows.some(user => user.table === 'pe_users' && user.values.id === value.user_id)
    || value.id !== value.install_request_id || !z.string().min(1).max(80).safeParse(value.name).success
    || revision < 1 || revision > limits.maxRows || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)) throw new LegacyImportError('migration_fixed_mcp_connection_invalid')
  const updates = rows.filter(item => item.table === 'pe_mcp_updates' && item.values.connection_id === value.id
    && item.values.user_id === value.user_id).map(item => ({ result: receipt(item, row, limits), createdAt: item.values.created_at ?? '' }))
    .sort((a, b) => a.result.revision - b.result.revision)
  if (updates.length !== revision - 1 || updates.some((item, index) => item.result.revision !== index + 2
    || index > 0 && legacyTimestamp(item.createdAt) < legacyTimestamp(updates[index - 1]?.createdAt ?? ''))
    || (updates.at(-1)?.result.enabled ?? true) !== (value.enabled === 'true')) {
    throw new LegacyImportError('migration_fixed_mcp_toggle_chain')
  }
  return true
}

/** Validate frozen fixed MCP selections against their original Session owner and enabled historical revision.
 * @param operation Original settled parent or continuation retaining the accepted selection.
 * @param rows Complete original connection and toggle receipt inventory.
 * @param limits Explicit JSON budgets.
 * @returns Nothing after each historical selection qualifies; later revocation remains the current connection state.
 */
export function validateLegacyMigrationFixedMcpOperation(operation: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits): void {
  const selected = z.array(mcpSelection).max(1).parse(legacyJson(operation.values.mcp_selection ?? '', limits))
  if (!selected.length) return
  const session = rows.find(item => item.table === 'pe_sessions' && item.values.id === operation.values.session_id)
  if (!session) throw new LegacyImportError('migration_fixed_mcp_operation_owner_missing')
  const acceptedAt = legacyTimestamp(operation.values.created_at ?? '')
  for (const item of selected) {
    const owner = rows.find(row => row.table === 'pe_mcp_connections' && row.values.id === item.connectionId
      && row.values.user_id === session.values.user_id)
    if (!owner) throw new LegacyImportError('migration_fixed_mcp_operation_owner_missing')
    const update = item.revision === 1 ? undefined : rows.find(row => row.table === 'pe_mcp_updates'
      && row.values.connection_id === item.connectionId && row.values.user_id === session.values.user_id
      && originalResult.parse(legacyJson(row.values.result ?? '', limits)).revision === item.revision)
    const original = update === undefined ? undefined : receipt(update, owner, limits)
    const enabled = item.revision === 1 || original?.enabled === true
    const createdAt = item.revision === 1 ? owner.values.created_at : update?.values.created_at
    if (!enabled || !createdAt || item.revision > Number(owner.values.revision)
      || legacyTimestamp(createdAt) > acceptedAt) throw new LegacyImportError('migration_fixed_mcp_operation_selection_invalid')
  }
}
