/** Preserve never-reserved original mount slots without issuing a writer or inventing stop evidence. */
import { z } from 'zod'
import { LegacyImportError } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Only the original free, generation-zero branch; allocated and released generations require separate stop qualification. */
export const LEGACY_MIGRATION_PRISTINE_MOUNT_TABLES: ReadonlySet<string> = new Set(['pe_mount_slots'])

/** Validate a never-reserved slot against its retained owner and absence of original executor records.
 * @param row Source-preserving original mount slot.
 * @param rows Complete retained owner and execution inventory.
 * @param cut Authenticated stopped-source timestamp.
 * @returns Whether the row belongs to this owner; no Pod, Runner, mount or stop receipt is created.
 */
export function validateLegacyMigrationPristineMount(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], cut: string): boolean {
  if (!LEGACY_MIGRATION_PRISTINE_MOUNT_TABLES.has(row.table)) return false
  const value = row.values, userId = z.uuid().parse(value.user_id)
  if (rows.filter(item => item.table === 'pe_users' && item.values.id === userId).length !== 1) {
    throw new LegacyImportError('migration_mount_slot_owner_missing')
  }
  if (value.state !== 'free' || value.generation !== '0'
    || ['session_id', 'workspace_id', 'pod_uid', 'runner_instance_id', 'stop_pod_uid', 'stop_evidence', 'binding_snapshot']
      .some(column => value[column] !== null)
    || legacyTimestamp(value.created_at ?? '') !== legacyTimestamp(value.updated_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)) {
    throw new LegacyImportError('migration_mount_slot_pristine_required')
  }
  if (rows.some(item => ['pe_sandbox_instances', 'pe_cloud_executions', 'pe_stdio_v2_actions', 'pe_stdio_mcp_calls']
    .includes(item.table) && item.values.user_id === userId)) {
    throw new LegacyImportError('migration_mount_slot_original_occupancy')
  }
  return true
}
