/** Original Office cancellation tombstones remain metadata; conversion and parser closure require separate original evidence. */
import { officePreviewCancelRequest } from '@power-evolve/contracts/office-preview'
import { LegacyImportError, type LegacyFileEntry } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Validate an original cancellation that preceded admission, without minting a request, parser or stop receipt.
 * @param row Source-preserving selected owner row.
 * @param rows Complete selected owner relation.
 * @param files Complete authenticated original physical-file inventory.
 * @param cut Independently authenticated stopped-source timestamp.
 * @returns Whether this module owns the table; original admitted conversions remain explicitly unsupported.
 */
export function validateLegacyMigrationOffice(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  files: readonly LegacyFileEntry[], cut: string): boolean {
  if (row.table !== 'pe_office_preview_jobs') return false
  const value = row.values
  if (!rows.some(item => item.table === 'pe_users' && item.values.id === value.user_id)) {
    throw new LegacyImportError('migration_office_owner_missing')
  }
  if (value.request_digest !== null) throw new LegacyImportError('migration_office_original_conversion_closure_missing')
  officePreviewCancelRequest.parse({ requestId: value.request_id, generation: value.generation })
  if (value.state !== 'cancelled' || value.cancel_requested !== 'true' || value.lease_epoch !== '0' || value.attempts !== '0'
    || ['request', 'session_id', 'workspace_id', 'binding_snapshot', 'source_snapshot', 'converter_snapshot', 'error_code',
      'deadline_at', 'lease_owner', 'lease_until', 'parser_slot', 'creation_intent', 'pod_identity', 'worker_observation',
      'stop_evidence', 'result'].some(column => value[column] !== null)
    || files.some(file => file.area === 'office' && file.resource === value.id)
    || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(value.completed_at ?? '')
    || legacyTimestamp(value.completed_at ?? '') > legacyTimestamp(cut)) {
    throw new LegacyImportError('migration_office_original_tombstone_invalid')
  }
  return true
}
