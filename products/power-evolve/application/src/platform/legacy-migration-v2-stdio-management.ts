/** Original disabled STDIO v2 configuration and mutation history; catalogs and execution authority need separate adapters. */
import { z } from 'zod'
import { stdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementLimitsV2, stdioManagementSchemasV2 } from '@power-evolve/contracts/stdio-management'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Metadata owners with complete mutation history and no historical catalog or execution admission. */
export const LEGACY_MIGRATION_STDIO_MANAGEMENT_TABLES: ReadonlySet<string> = new Set([
  'pe_stdio_v2_connections', 'pe_stdio_v2_configurations', 'pe_stdio_v2_management_requests',
])
/** Protected original parser budgets and source identity; no executor or program is loaded. */
export const legacyMigrationStdioV2Policy = z.object({ format: z.literal('power-evolve-legacy-stdio-v2-policy'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), limits: stdioLimitsV2,
  management: stdioManagementLimitsV2 }).strict()
/** Process-issued original policy context whose digest is authenticated by the signed file cut. */
export interface LegacyMigrationStdioV2Context { readonly evidenceSha256: string }
type Policy = z.infer<typeof legacyMigrationStdioV2Policy>
type Original = { policy: Policy; schemas: ReturnType<typeof stdioManagementSchemasV2> }
const contexts = new WeakMap<LegacyMigrationStdioV2Context, Original>()
function fail(code: string): never { throw new LegacyImportError(code) }
function find(rows: readonly LegacyPlannedRow[], table: string, fields: Readonly<Record<string, string | null>>) {
  const row = rows.find(item => item.table === table && Object.entries(fields).every(([key, value]) => item.values[key] === value))
  if (!row) fail('migration_stdio_v2_reference_missing')
  return row
}
function jsonLimits(original: Original) {
  return { maxDepth: original.policy.limits.maxJsonDepth, maxNodes: original.policy.limits.maxJsonNodes,
    maxBytes: original.policy.limits.maxInputBytes }
}
function configuration(row: LegacyPlannedRow, limits: LegacyImportLimits, original: Original) {
  const value = original.schemas.configuration.parse(legacyJson(row.values.configuration ?? '', limits))
  if (stdioSha256V2('configuration', value, jsonLimits(original)) !== row.values.config_digest) {
    fail('migration_stdio_v2_configuration_digest')
  }
  return value
}
function receipt(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits, original: Original) {
  const value = row.values, purpose = value.purpose
  if (purpose === 'check') fail('migration_stdio_v2_execution_owner_missing')
  const raw = legacyJson(value.request ?? '', limits), schemas = original.schemas
  const mutation = purpose === 'create' ? { purpose: 'create' as const, input: schemas.create.parse(raw) }
    : purpose === 'update' ? { purpose: 'update' as const, input: schemas.update.parse(raw) }
      : purpose === 'toggle' ? { purpose: 'toggle' as const, input: schemas.toggle.parse(raw) }
        : purpose === 'delete' ? { purpose: 'delete' as const, input: schemas.remove.parse(raw) }
          : fail('migration_stdio_v2_request_purpose')
  const result = schemas.mutationReceipt.parse(legacyJson(value.receipt ?? '', limits)), input = mutation.input
  const owner = find(rows, 'pe_stdio_v2_connections', { id: result.connectionId.toLowerCase(), user_id: value.user_id ?? null })
  if (input.requestId.toLowerCase() !== value.request_id || result.requestId !== input.requestId || result.purpose !== purpose
    || 'connectionId' in input && result.connectionId !== input.connectionId
    || result.revision !== (mutation.purpose === 'create' ? 1 : 'expectedRevision' in input
      ? input.expectedRevision + (mutation.purpose === 'update' ? 1 : 0) : 0)
    || result.deleted !== (purpose === 'delete') || result.enabled !== (purpose === 'toggle' && 'enabled' in input && input.enabled)
    || value.request_digest !== stdioSha256V2('management', mutation, jsonLimits(original))
    || legacyTimestamp(value.created_at ?? '') < legacyTimestamp(owner.values.created_at ?? '')
    || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(owner.values.updated_at ?? '')) fail('migration_stdio_v2_receipt_invalid')
  if (result.enabled) fail('migration_stdio_v2_catalog_owner_missing')
  if ('configuration' in input) {
    const version = find(rows, 'pe_stdio_v2_configurations', { connection_id: owner.values.id ?? null,
      user_id: value.user_id ?? null, revision: String(result.revision) })
    configuration(version, limits, original)
    if (version.values.config_digest !== stdioSha256V2('configuration', input.configuration, jsonLimits(original))
      || legacyTimestamp(version.values.created_at ?? '') !== legacyTimestamp(value.created_at ?? '')) {
      fail('migration_stdio_v2_original_configuration_binding')
    }
  }
  return { mutation, result, owner, time: legacyTimestamp(value.created_at ?? '') }
}

/** Issue original STDIO v2 parser policy without importing executors or minting execution authority.
 * @param policy Protected original deployment parser budgets and source/code identity.
 * @param sourceCodeId Source identity authenticated in the independent capture and signed cut.
 * @returns Immutable context retaining the original policy digest.
 */
export function createLegacyMigrationStdioV2Context(policy: unknown, sourceCodeId: string): LegacyMigrationStdioV2Context {
  const original = legacyMigrationStdioV2Policy.parse(policy)
  if (original.sourceCodeId !== sourceCodeId) fail('migration_stdio_v2_original_policy_identity')
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, { policy: structuredClone(original), schemas: stdioManagementSchemasV2(original.limits, original.management) })
  return context
}

/** Validate original disabled STDIO v2 configurations and complete create/update/toggle/delete receipts.
 * @param row Source-preserving selected metadata row.
 * @param rows Complete retained original inventory.
 * @param limits Explicit maintenance cell and JSON budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Process-issued protected original parser policy.
 * @returns Whether this module owns the table; catalog, check and execution branches remain separately rejected.
 */
export function validateLegacyMigrationStdioV2Metadata(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationStdioV2Context): boolean {
  if (!LEGACY_MIGRATION_STDIO_MANAGEMENT_TABLES.has(row.table)) return false
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) fail('migration_stdio_v2_original_policy_missing')
  const value = row.values
  find(rows, 'pe_users', { id: value.user_id ?? null })
  if (legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) fail('migration_stdio_v2_future')
  if (row.table === 'pe_stdio_v2_management_requests') { receipt(row, rows, limits, original); return true }
  if (row.table === 'pe_stdio_v2_configurations') {
    const owner = find(rows, 'pe_stdio_v2_connections', { id: value.connection_id ?? null, user_id: value.user_id ?? null })
    configuration(row, limits, original)
    if (Number(value.revision) > Number(owner.values.revision)) fail('migration_stdio_v2_configuration_revision')
    const origins = rows.filter(item => item.table === 'pe_stdio_v2_management_requests' && item.values.user_id === value.user_id
      && item.values.purpose !== 'check')
      .map(item => receipt(item, rows, limits, original)).filter(item => item.owner === owner
        && ['create', 'update'].includes(item.mutation.purpose) && item.result.revision === Number(value.revision))
    if (origins.length !== 1) fail('migration_stdio_v2_configuration_origin_missing')
    return true
  }
  const revision = Number(value.revision), createdAt = legacyTimestamp(value.created_at ?? ''), updatedAt = legacyTimestamp(value.updated_at ?? '')
  if (value.enabled !== 'false' || value.current_catalog_id !== null) fail('migration_stdio_v2_catalog_owner_missing')
  if (createdAt > updatedAt || updatedAt > legacyTimestamp(cut) || revision < 1 || revision > limits.maxRows
    || value.deleted_at !== null && (legacyTimestamp(value.deleted_at ?? '') < createdAt
      || legacyTimestamp(value.deleted_at ?? '') > updatedAt)) fail('migration_stdio_v2_connection_invalid')
  const versions = rows.filter(item => item.table === 'pe_stdio_v2_configurations' && item.values.connection_id === value.id)
    .sort((a, b) => Number(a.values.revision) - Number(b.values.revision))
  if (versions.length !== revision || versions.some((item, index) => Number(item.values.revision) !== index + 1
    || item.values.user_id !== value.user_id)) fail('migration_stdio_v2_configuration_chain')
  const history = rows.filter(item => item.table === 'pe_stdio_v2_management_requests' && item.values.user_id === value.user_id
    && item.values.purpose !== 'check')
    .map(item => receipt(item, rows, limits, original)).filter(item => item.owner === row)
    .sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0)
  let currentRevision = 0, deleted = false
  for (const item of history) {
    const mutation = item.mutation
    if (deleted || mutation.purpose === 'create' && currentRevision !== 0
      || mutation.purpose !== 'create' && mutation.input.expectedRevision !== currentRevision) fail('migration_stdio_v2_mutation_chain')
    if (mutation.purpose === 'create') currentRevision = 1
    else if (mutation.purpose === 'update') currentRevision++
    else if (mutation.purpose === 'delete') {
      deleted = true
      if (value.deleted_at === null || legacyTimestamp(value.deleted_at ?? '') < item.time) fail('migration_stdio_v2_deletion_receipt')
    }
  }
  if (currentRevision !== revision || deleted !== (value.deleted_at !== null)) fail('migration_stdio_v2_mutation_chain')
  return true
}
