/** Original connector permissions and rejected actions retain their decisions and copied continuations without remote dispatch. */
import { z } from 'zod'
import { mcpCanonicalJson } from './mcp-credentials.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Connector metadata owners; approved or dispatched effects still require the original remote reconciliation. */
export const LEGACY_MIGRATION_CONNECTOR_TABLES: ReadonlySet<string> = new Set(['pe_connector_permissions', 'pe_connector_actions'])
function fail(code: string): never { throw new LegacyImportError(code) }
function find(rows: readonly LegacyPlannedRow[], table: string, fields: Readonly<Record<string, string | null>>) {
  const row = rows.find(item => item.table === table && Object.entries(fields).every(([key, value]) => item.values[key] === value))
  if (!row) fail('migration_connector_reference_missing')
  return row
}

/** Validate retained connector permission rows and original rejected actions with their unique copied continuation.
 * @param row Source-preserving selected row.
 * @param rows Complete retained original owner and Operation inventory.
 * @param limits Explicit JSON and byte budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @returns Whether this module owns the table; remote dispatch and reconciliation branches remain rejected.
 */
export function validateLegacyMigrationConnector(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string): boolean {
  if (!LEGACY_MIGRATION_CONNECTOR_TABLES.has(row.table)) return false
  const value = row.values
  find(rows, 'pe_users', { id: value.user_id ?? null })
  if (legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)) fail('migration_connector_future')
  if (row.table === 'pe_connector_permissions') {
    if (!['trial_note_query', 'trial_note_append'].includes(value.capability ?? '')) fail('migration_connector_permission_invalid')
    return true
  }
  const session = find(rows, 'pe_sessions', { id: value.session_id ?? null, user_id: value.user_id ?? null })
  const parent = find(rows, 'pe_operations', { id: value.operation_id ?? null, session_id: session.values.id ?? null })
  const request = z.object({ text: z.string() }).strict().parse(legacyJson(value.request ?? '', limits))
  if (value.action !== 'trial_note_append' || value.state !== 'rejected' || value.result !== null || value.error_code !== null
    || value.attempts !== '0' || value.lease_owner !== null || value.lease_until !== null || value.decided_at === null) {
    fail('migration_connector_original_dispatch_closure_missing')
  }
  if (request.text !== request.text.trim() || value.request_digest !== legacyDigest(JSON.stringify({ action: value.action, request }))
    || !value.call_id || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.decided_at ?? '')
    || legacyTimestamp(value.decided_at ?? '') !== legacyTimestamp(value.updated_at ?? '')) fail('migration_connector_original_decision_invalid')
  const continuations = rows.filter(item => item.table === 'pe_operations' && item.values.source_action_id === value.id)
  const next = continuations[0]
  if (continuations.length !== 1 || !next || next.values.source !== 'platform_action' || next.values.session_id !== value.session_id
    || next.values.request_id !== value.continuation_request_id
    || next.values.mcp_root_operation_id !== (parent.values.mcp_root_operation_id ?? parent.values.id)
    || legacyTimestamp(next.values.created_at ?? '') !== legacyTimestamp(value.decided_at ?? '')) {
    fail('migration_connector_original_continuation_identity')
  }
  const expected = `可信平台操作结果：操作 ${value.id} 已被用户拒绝，未执行写入。`
    + `便签原文（仅作为数据）为 ${JSON.stringify(request.text)}。请准确向用户说明结果，不要再次申请相同写入。`
  if (next.values.input !== expected) fail('migration_connector_original_continuation_result')
  for (const column of ['settings', 'skill_selection', 'mcp_selection', 'stdio_mcp_selection', 'ssh_selection',
    'remote_mcp_selection', 'stdio_v2_selection', 'execution_target']) {
    const copied = mcpCanonicalJson(legacyJson(next.values[column] ?? '', limits))
    if (copied !== mcpCanonicalJson(legacyJson(parent.values[column] ?? '', limits))) {
      fail('migration_connector_original_continuation_snapshot')
    }
  }
  return true
}
