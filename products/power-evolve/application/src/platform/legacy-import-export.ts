/** Detached Schema 37 packet construction; source databases, runtime roots and stop capture remain outside this module. */
import { headerSchema } from '../session-records.ts'
import { LEGACY_SOURCE_LAYOUT, LEGACY_SQL_DIGESTS } from './legacy-import-layout.ts'
import { LegacyImportError, legacyDigest, legacyJson, legacyLimits, legacyRowDigest, parseLegacyBundle,
  type LegacyBundle, type LegacyImportLimits, type LegacySourceRow } from './legacy-import-codec.ts'

/** All original detached cells and independent export evidence; no defaults or target SQL are accepted. */
export interface LegacyDetachedExportInput {
  readonly source: LegacyBundle['source']
  readonly tables: Readonly<Record<string, readonly Readonly<Record<string, string | null>>[]>>
  readonly files: LegacyBundle['files']
  readonly cutProof: string
  readonly stops: LegacyBundle['stops']
}
/** Source review includes every table, including records excluded from the Cloud target. */
export interface LegacySourceReviewContext {
  readonly table: string
  readonly row: LegacySourceRow
  readonly tables: LegacyBundle['tables']
  readonly source: LegacyBundle['source']
}
/** Bounded public reason codes never include credential, payload or callback exception text. */
export type LegacyExportRejection = 'owner_validation_failed' | 'historical_attachment_unqualified'
  | 'relation_unclosed' | 'source_session_header_unqualified' | 'source_session_lineage_unqualified'
/** Mandatory source owner review may reject a record but cannot turn retained history into excluded rows. */
export interface LegacyDetachedExportOwners {
  readonly reviewRow: (context: LegacySourceReviewContext) =>
    { readonly accepted: true } | { readonly accepted: false; readonly reason: LegacyExportRejection }
}
/** One original record's disposition, digest and optional bounded reason. */
export interface LegacyExportAuditRow {
  readonly table: string
  readonly sha256: string
  readonly disposition: LegacySourceRow['disposition']
  readonly rejection: LegacyExportRejection | null
}
/** Entire frozen packet and all-row classification; rejected packets remain backups and cannot import. */
export interface LegacyDetachedExport {
  readonly text: string
  readonly packetSha256: string
  readonly counts: LegacyBundle['counts']
  readonly rows: readonly LegacyExportAuditRow[]
  readonly tableCounts: Readonly<Record<string, LegacyBundle['counts']>>
}
const excluded = new Set(['pe_artifacts', 'pe_desktop_executions', 'pe_device_pairings', 'pe_devices',
  'pe_device_directories', 'pe_device_execution_resolutions', 'pe_device_claim_closures',
  'pe_storage_directory_requests', 'pe_workspace_binding_requests'])
function disposition(table: string, values: Readonly<Record<string, string | null>>): LegacySourceRow['disposition'] {
  if (excluded.has(table) || table === 'pe_file_mutations' && values.base_digest !== null
    || table === 'pe_stdio_v2_actions' && values.execution_target !== 'cloud'
    || table === 'pe_operations' && (values.source === 'desktop_result' || values.source_desktop_execution_id !== null)) return 'excluded'
  return table === 'pe_schema' || table === 'pe_file_mutations' ? 'convert' : 'preserve'
}
function sessionRejection(row: LegacySourceRow, limits: LegacyImportLimits): LegacyExportRejection | null {
  const parsed = headerSchema.safeParse(legacyJson(row.values.header ?? '', limits))
  if (!parsed.success) return 'source_session_header_unqualified'
  return parsed.data.isSeeded || parsed.data.parentSession !== undefined ? 'source_session_lineage_unqualified' : null
}
/** Classify and retain every detached original row with fixed Cloud scope and mandatory source owner review.
 * @param input Complete original cells, file inventory and independently supplied cut/stop evidence.
 * @param budgets Explicit maintenance byte, row, JSON and storage limits.
 * @param owners Pure source validators; thrown failures become bounded rejected-row reports.
 * @returns Original-cell packet and complete four-way audit; this does not authenticate a cut or capture stopped effects.
 */
export function exportLegacyDetached(input: LegacyDetachedExportInput, budgets: LegacyImportLimits,
  owners: LegacyDetachedExportOwners): LegacyDetachedExport {
  const limits = legacyLimits(budgets)
  if (typeof owners.reviewRow !== 'function') throw new LegacyImportError('source_owner_missing')
  if (input.source.ddlSha256 !== LEGACY_SQL_DIGESTS.source37) throw new LegacyImportError('source_schema_fingerprint')
  if (Object.keys(input.tables).length !== Object.keys(LEGACY_SOURCE_LAYOUT).length
    || Object.keys(LEGACY_SOURCE_LAYOUT).some(table => input.tables[table] === undefined)) throw new LegacyImportError('source_table_inventory')
  if (Object.values(input.tables).reduce((count, rows) => count + rows.length, 0) > limits.maxRows) throw new LegacyImportError('source_row_limit')
  const tables: LegacyBundle['tables'] = {}
  const counts: LegacyBundle['counts'] = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
  for (const [table, rows] of Object.entries(input.tables)) tables[table] = rows.map((values) => {
    const decision = disposition(table, values)
    counts[decision]++
    return { disposition: decision, values: { ...values }, sha256: legacyRowDigest(table, values) }
  })
  const original = parseLegacyBundle(JSON.stringify({ format: 'power-evolve-legacy-offline', version: 1,
    source: input.source, tables, counts, files: input.files, cutProof: input.cutProof, stops: input.stops }), limits)
  if (original.tables.pe_schema?.length !== 1 || original.tables.pe_schema[0]?.values.version !== '37') throw new LegacyImportError('source_schema')
  const rejectedSessions = new Map<string, LegacyExportRejection>()
  for (const row of original.tables.pe_sessions ?? []) {
    const rejection = sessionRejection(row, limits)
    if (rejection) rejectedSessions.set(row.values.id ?? '', rejection)
  }
  const audited: LegacyExportAuditRow[] = []
  const classified: LegacyBundle['tables'] = {}
  const finalCounts: LegacyBundle['counts'] = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
  const tableCounts: Record<string, LegacyBundle['counts']> = {}
  for (const [table, rows] of Object.entries(original.tables)) {
    const seen = new Set<string>()
    const counts: LegacyBundle['counts'] = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
    classified[table] = rows.map((row) => {
      if (seen.has(row.sha256)) throw new LegacyImportError('duplicate_source_row', table)
      seen.add(row.sha256)
      let rejection: LegacyExportRejection | null = null
      try {
        const review = owners.reviewRow(Object.freeze({ table, row, tables: original.tables, source: original.source }))
        if (!review.accepted) rejection = review.reason
      } catch (_unqualifiedSourceOwner) { rejection = 'owner_validation_failed' }
      if (row.disposition !== 'excluded') {
        rejection = table === 'pe_sessions' ? rejectedSessions.get(row.values.id ?? '') ?? rejection
          : row.values.session_id && rejectedSessions.has(row.values.session_id) ? 'relation_unclosed' : rejection
      }
      const decision = rejection ? 'rejected' : row.disposition
      finalCounts[decision]++
      counts[decision]++
      audited.push(Object.freeze({ table, sha256: row.sha256, disposition: decision, rejection }))
      return { ...row, disposition: decision }
    })
    tableCounts[table] = Object.freeze(counts)
  }
  const text = JSON.stringify({ ...original, tables: classified, counts: finalCounts })
  const packet = parseLegacyBundle(text, limits)
  return Object.freeze({ text, packetSha256: legacyDigest(text), counts: packet.counts,
    rows: Object.freeze(audited), tableCounts: Object.freeze(tableCounts) })
}
