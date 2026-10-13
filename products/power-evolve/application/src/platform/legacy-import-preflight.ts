/** Pure Schema 37 import planning; every retained relation is checked before target SQL or files. */
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { headerSchema, parseEvents } from '../session-records.ts'
import { executionTarget, settings, skillSelection, mcpSelection, stdioMcpSelection, sshSelection } from '../contracts.ts'
import { LEGACY_FOREIGN_KEYS, LEGACY_SQL_DIGESTS,
  LEGACY_TARGET_LAYOUT, LEGACY_UNIQUE_KEYS } from './legacy-import-layout.ts'
import { LegacyImportError, legacyCell, legacyDigest, legacyJson, legacyLimits, parseLegacyBundle,
  type LegacyBundle, type LegacyFileEntry, type LegacyImportLimits, type LegacyJson, type LegacySourceRow } from './legacy-import-codec.ts'

/** Retained row with its full original values; generated columns remain available for comparison. */
export interface LegacyPlannedRow {
  readonly table: string
  readonly sourceTable: string
  readonly sourceSha256: string
  readonly values: Readonly<Record<string, string | null>>
}
/** Pure owner-validation access to the complete retained relation and decoded JSON. */
export interface LegacyOwnerContext {
  readonly rows: readonly LegacyPlannedRow[]
  readonly source: LegacyBundle['source']
  readonly limits: LegacyImportLimits
  readonly row: LegacyPlannedRow
  readonly owner: string | null
  readonly json: Readonly<Record<string, LegacyJson>>
}
/** A typed identity component selected by its subsystem owner, never by a JSON property-name scan. */
export type LegacyReferenceValue =
  | { readonly kind: 'json'; readonly path: readonly (string | number)[]; readonly equalsRowColumn?: string }
  | { readonly kind: 'row'; readonly column: string }
  | { readonly kind: 'owner' }
/** One exact retained tuple referenced from an owner-validated JSON column. */
export interface LegacyJsonReference {
  readonly column: string
  readonly targetTable: string
  readonly fields: readonly { readonly targetColumn: string; readonly value: LegacyReferenceValue }[]
  readonly ownership: 'same' | 'independent'
}
/** Required adapters validate signed export cuts, secret/configuration compatibility and subsystem facts.
 * Adapters are synchronous and pure: they must not query a running source, dispatch work or mutate records.
 * Missing historical format/file adapters reject through these owners rather than removing accepted Cloud rows.
 */
export interface LegacyImportOwners {
  /** Verify the stopped export cut and its matching code/config/file backup identity. */
  readonly verifyCut: (source: LegacyBundle['source'], proof: LegacyJson, packetSha256: string) => void
  /** Validate all subsystem JSON, request digests, key/AAD compatibility and immutable snapshots for this row. */
  readonly validateRow: (context: LegacyOwnerContext) => void
  /** Declare every typed JSON identity tuple after validating this row's subsystem payloads. */
  readonly references: (context: LegacyOwnerContext) => readonly LegacyJsonReference[]
  /** Verify exact original physical identities and ended effects against an independent durable proof. */
  readonly verifyStopped: (context: LegacyOwnerContext, proof: LegacyJson) => void
  /** Validate complete file inventories, modes, snapshots and declared directory ownership at the export cut. */
  readonly verifyFiles: (source: LegacyBundle['source'], files: readonly LegacyFileEntry[], rows: readonly LegacyPlannedRow[]) => void
}
/** Frozen insertion plan; source disposition counts include excluded and rejected rows. */
export interface LegacyImportPlan {
  readonly packetSha256: string
  readonly source: LegacyBundle['source']
  readonly counts: LegacyBundle['counts']
  readonly rows: readonly LegacyPlannedRow[]
  readonly files: readonly LegacyFileEntry[]
  readonly limits: LegacyImportLimits
}
const issued = new WeakSet<LegacyImportPlan>()
const excludedTables = new Set(['pe_artifacts', 'pe_desktop_executions', 'pe_device_pairings', 'pe_devices',
  'pe_device_directories', 'pe_device_execution_resolutions', 'pe_device_claim_closures',
  'pe_storage_directory_requests', 'pe_workspace_binding_requests'])
const terminal: Readonly<Record<string, readonly string[]>> = {
  pe_operations: ['completed', 'failed'], pe_cloud_executions: ['succeeded', 'failed', 'cancelled', 'closed_unknown'],
  pe_cloud_execution_resolutions: ['completed', 'cancelled'], pe_connector_actions: ['rejected', 'succeeded', 'failed'],
  pe_mcp_actions: ['succeeded', 'failed', 'rejected', 'cancelled', 'expired'],
  pe_mcp_checks: ['succeeded', 'failed', 'cancelled', 'expired'],
  pe_ssh_execute_actions: ['rejected', 'succeeded', 'failed', 'cancelled'],
  pe_ssh_calls: ['succeeded', 'failed', 'cancelled'], pe_stdio_mcp_calls: ['succeeded', 'failed', 'cancelled'],
  pe_stdio_v2_actions: ['succeeded', 'failed', 'cancelled', 'rejected', 'expired'],
  pe_office_preview_jobs: ['succeeded', 'failed', 'cancelled'], pe_mount_slots: ['free'], pe_sandbox_instances: ['deleted'],
}
const stopTables = new Set(['pe_cloud_executions', 'pe_cloud_execution_resolutions', 'pe_connector_actions',
  'pe_mcp_actions', 'pe_mcp_checks', 'pe_ssh_calls', 'pe_stdio_mcp_calls', 'pe_stdio_v2_actions',
  'pe_office_preview_jobs', 'pe_sandbox_instances'])
/** Exact reviewed empty-schema constraints created after unchanged Skill, STDIO and remote MCP catalog rows. */
export const LEGACY_LATE_CONSTRAINTS = Object.freeze(['pe_skill_package_versions_skill_id_user_id_fkey',
  'pe_user_skills_package_version', 'pe_stdio_v2_connections_current_catalog', 'pe_mcp_remote_catalog'])

function fail(code: string, row?: LegacyPlannedRow): never {
  throw new LegacyImportError(code, row ? `${row.table}:${row.sourceSha256}` : '')
}
function invoke(run: () => void, code: string, row?: LegacyPlannedRow): void {
  try { run() }
  catch (_ownerRejected) { fail(code, row) }
}
/** Convert an accepted UTC export timestamp to exact microseconds.
 * @param value Export timestamp with up to six fraction digits.
 * @returns Epoch microseconds, preserving digits beyond JavaScript Date precision.
 */
export function legacyTimestamp(value: string): bigint {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
    || value.startsWith('0000-')) throw new LegacyImportError('invalid_timestamp')
  const fraction = value.split('.')[1]?.replace('Z', '') ?? ''
  return BigInt(parsed) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3))
}
function tuple(columns: readonly string[], values: Readonly<Record<string, string | null>>): string | null {
  const result = columns.map(column => values[column])
  return result.some(value => value === null || value === undefined) ? null : JSON.stringify(result)
}
function indexed(rows: readonly LegacyPlannedRow[], table: string, columns: readonly string[]) {
  const map = new Map<string, LegacyPlannedRow>()
  for (const row of rows) if (row.table === table) {
    const key = tuple(columns, row.values)
    if (key !== null) map.set(key, row)
  }
  return map
}
function lookup(rows: readonly LegacyPlannedRow[], table: string, id: string | null | undefined) {
  return id === null || id === undefined ? undefined : rows.find(row => row.table === table && row.values.id === id)
}
function rowOwner(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], seen = new Set<LegacyPlannedRow>()): string | null {
  if (seen.has(row)) return null
  seen.add(row)
  if (row.table === 'pe_users') return row.values.id ?? null
  if (row.values.user_id) return row.values.user_id
  const links: Readonly<Record<string, readonly string[]>> = {
    session_id: ['pe_sessions'], operation_id: ['pe_operations'], action_id: ['pe_stdio_v2_actions', 'pe_mcp_actions', 'pe_connector_actions'],
    connection_id: ['pe_mcp_connections', 'pe_mcp_remote_connections', 'pe_ssh_connections', 'pe_stdio_mcp_connections', 'pe_stdio_v2_connections'],
  }
  for (const [column, targets] of Object.entries(links)) for (const target of targets) {
    const parent = lookup(rows, target, row.values[column])
    if (parent) return rowOwner(parent, rows, seen)
  }
  return null
}
function mapped(table: string, record: LegacySourceRow, limits: LegacyImportLimits): LegacyPlannedRow | null {
  const values = record.values
  const excluded = excludedTables.has(table) || table === 'pe_file_mutations' && values.base_digest !== null
    || table === 'pe_stdio_v2_actions' && values.execution_target !== 'cloud'
    || table === 'pe_operations' && (values.source === 'desktop_result' || values.source_desktop_execution_id !== null)
  if (record.disposition === 'rejected') throw new LegacyImportError('source_rows_rejected', table)
  if (excluded) {
    if (record.disposition !== 'excluded') throw new LegacyImportError('excluded_disposition', table)
    return null
  }
  const conversion = table === 'pe_schema' || table === 'pe_file_mutations'
  if (record.disposition !== (conversion ? 'convert' : 'preserve')) throw new LegacyImportError('accepted_row_disposition', table)
  const target = table === 'pe_file_mutations' ? 'pe_file_uploads' : table
  const layout = LEGACY_TARGET_LAYOUT[target]
  if (!layout) throw new LegacyImportError('unknown_target_table')
  const retained: Record<string, string | null> = {}
  for (const [column, specification] of Object.entries(layout)) {
    const cell = table === 'pe_schema' ? column === 'version' ? '2' : 'cloud-native' : values[column]
    if (cell === undefined) throw new LegacyImportError('missing_target_cell', `${target}.${column}`)
    legacyCell(cell, specification, limits, `${target}.${column}`)
    if (specification.kind === 'timestamptz' && cell !== null) legacyTimestamp(cell)
    retained[column] = cell
  }
  if (table === 'pe_schema' && values.version !== '37') throw new LegacyImportError('source_schema')
  if (target === 'pe_stdio_v2_actions' && (values.desktop_execution_id !== null || retained.cloud_execution_id !== values.execution_id)) {
    throw new LegacyImportError('generated_execution_identity')
  }
  if (target === 'pe_workspaces' && (values.recovery_request_id !== null || values.create_storage_target !== null)) {
    throw new LegacyImportError('workspace_recovery_unfinished')
  }
  return Object.freeze({ table: target, sourceTable: table, sourceSha256: record.sha256, values: Object.freeze(retained) })
}
function relations(rows: readonly LegacyPlannedRow[]): void {
  for (const unique of LEGACY_UNIQUE_KEYS) {
    const keys = new Set<string>()
    for (const row of rows) if (row.table === unique.table) {
      const key = tuple(unique.columns, row.values)
      if (key === null) continue
      if (keys.has(key)) fail('duplicate_relation_key', row)
      keys.add(key)
    }
  }
  for (const reference of LEGACY_FOREIGN_KEYS) {
    const parents = indexed(rows, reference.target, reference.references)
    for (const row of rows) if (row.table === reference.table) {
      const key = tuple(reference.columns, row.values)
      if (key === null) continue
      const parent = parents.get(key)
      if (!parent) fail('missing_foreign_key', row)
      const owner = rowOwner(row, rows), parentOwner = rowOwner(parent, rows)
      if (!reference.columns.some(column => column === 'actor_user_id' || column === 'target_user_id')
        && owner !== null && parentOwner !== null && owner !== parentOwner) fail('foreign_owner', row)
    }
  }
  for (const row of rows) if (row.table === 'pe_cloud_execution_resolutions') {
    const execution = lookup(rows, 'pe_cloud_executions', row.values.execution_id)
    if (!execution || ['user_id', 'session_id', 'sandbox_name', 'pod_uid', 'runner_instance_id']
      .some(column => row.values[column] !== execution.values[column])
      || row.values.execution_request_digest !== execution.values.request_digest
      || row.values.state === 'completed' && row.values.final_execution_state !== execution.values.state) {
      fail('resolution_execution_identity_changed', row)
    }
  }
}
function jsonObject(value: LegacyJson): value is Readonly<Record<string, LegacyJson>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function referenceValue(value: LegacyReferenceValue, json: LegacyJson, context: LegacyOwnerContext): string | null {
  if (value.kind === 'owner') return context.owner
  if (value.kind === 'row') {
    const cell = context.row.values[value.column]
    if (cell === undefined) fail('json_reference_declaration_invalid', context.row)
    return cell
  }
  let item = json
  for (const part of value.path) {
    if (typeof part === 'number') {
      if (!Array.isArray(item) || !Number.isSafeInteger(part) || part < 0 || item[part] === undefined) fail('json_reference_path_invalid', context.row)
      item = (item as readonly LegacyJson[])[part] as LegacyJson
    } else {
      if (!jsonObject(item) || !Object.hasOwn(item, part)) fail('json_reference_path_invalid', context.row)
      item = item[part] as LegacyJson
    }
  }
  if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
    fail('json_reference_value_invalid', context.row)
  }
  const cell = item === null ? null : String(item)
  if (value.equalsRowColumn !== undefined && context.row.values[value.equalsRowColumn] !== cell) fail('json_identity_changed', context.row)
  return cell
}
function jsonReferences(references: readonly LegacyJsonReference[], context: LegacyOwnerContext): void {
  for (const reference of references) {
    const json = context.json[reference.column], target = LEGACY_TARGET_LAYOUT[reference.targetTable]
    if (json === undefined || !target || !reference.fields.length
      || new Set(reference.fields.map(field => field.targetColumn)).size !== reference.fields.length
      || reference.fields.some(field => !target[field.targetColumn])) fail('json_reference_declaration_invalid', context.row)
    const fields = reference.fields.map(field => ({ column: field.targetColumn, value: referenceValue(field.value, json, context) }))
    const candidates = context.rows.filter(row => row.table === reference.targetTable
      && fields.every(field => row.values[field.column] === field.value))
    if (!candidates.length) fail('json_reference_missing', context.row)
    if (reference.ownership === 'same' && (context.owner === null
      || candidates.some(row => rowOwner(row, context.rows) !== context.owner))) fail('json_foreign_owner', context.row)
  }
}
function ended(context: LegacyOwnerContext): void {
  const { row, rows, json, source } = context, values = row.values
  const states = terminal[row.table]
  if (states && (!values.state || !states.includes(values.state))) fail('replayable_state', row)
  if (row.table === 'pe_sessions' && (values.grant_digest !== null || values.lease_until !== null
    && legacyTimestamp(values.lease_until ?? '') > legacyTimestamp(source.cut))) fail('active_session_authority', row)
  if (row.table === 'pe_attempts' && values.ended_at === null) fail('unfinished_attempt', row)
  if (row.table === 'pe_credentials') {
    const owner = lookup(rows, 'pe_users', values.user_id)
    if (!owner || values.credential_version === owner.values.credential_version
      && legacyTimestamp(values.expires_at ?? '') > legacyTimestamp(source.cut)) fail('live_legacy_credential', row)
  }
  if (['pe_mcp_credential_tickets', 'pe_skill_upload_intents', 'pe_ssh_upload_intents', 'pe_stdio_v2_start_permits'].includes(row.table)) {
    if (values.consumed_at === null || row.table !== 'pe_mcp_credential_tickets') {
      if (values.expires_at && legacyTimestamp(values.expires_at) > legacyTimestamp(source.cut)) fail('live_legacy_permit', row)
    }
  }
  if (['pe_ssh_calls', 'pe_stdio_mcp_calls'].includes(row.table) && values.cleanup_complete !== 'true') fail('unfinished_cleanup', row)
  if (row.table === 'pe_workspaces' && values.binding_state !== 'ready'
    || row.table === 'pe_storage_spaces' && values.root_state !== 'ready') fail('storage_not_ready', row)
  if (row.table === 'pe_users' || row.table === 'pe_operations') {
    const parsed = settings.safeParse(json.settings)
    if (!parsed.success) fail('accepted_settings_invalid', row)
  }
  if (row.table === 'pe_operations') {
    if (!executionTarget.safeParse(json.execution_target).success || !z.array(skillSelection).safeParse(json.skill_selection).success
      || !z.array(mcpSelection).safeParse(json.mcp_selection).success
      || !z.array(stdioMcpSelection).safeParse(json.stdio_mcp_selection).success
      || !z.array(sshSelection).safeParse(json.ssh_selection).success) fail('accepted_selection_invalid', row)
  }
  if (row.table === 'pe_office_preview_jobs') {
    const input = json.source_snapshot
    if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'kind' in input && input.kind === 'artifact') {
      fail('historical_artifact_adapter_missing', row)
    }
  }
}
function history(rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits): void {
  for (const row of rows) if (row.table === 'pe_sessions') {
    let header: z.infer<typeof headerSchema>
    try { header = headerSchema.parse(legacyJson(row.values.header ?? '', limits)) }
    catch (_unsupportedHeader) { fail('session_format_adapter_missing', row) }
    if (header.isSeeded || header.parentSession !== undefined || header.id !== row.values.id) fail('session_lineage_adapter_missing', row)
    const count = BigInt(row.values.event_count ?? ''), bytes = BigInt(row.values.event_bytes ?? '')
    const events = rows.filter(event => event.table === 'pe_events' && event.values.session_id === row.values.id)
      .sort((a, b) => BigInt(a.values.seq ?? '') < BigInt(b.values.seq ?? '') ? -1 : 1)
    if (count !== BigInt(events.length) || count < 0n || bytes < 0n) fail('history_count', row)
    const decoded: LegacyJson[] = []
    let total = 0n
    for (const [index, event] of events.entries()) {
      if (event.values.seq !== String(index)) fail('history_gap', row)
      const value = legacyJson(event.values.event ?? '', limits)
      const contains = (item: LegacyJson, predicate: (text: string) => boolean): boolean => typeof item === 'string' ? predicate(item)
        : item !== null && typeof item === 'object'
          ? Object.entries(item).some(([key, child]) => predicate(key) || contains(child, predicate)) : false
      if (contains(value, text => text.includes('\0'))) fail('native_json_nul_adapter_missing', row)
      if (contains(value, text => Buffer.from(text).toString('utf8') !== text)) fail('native_json_surrogate_adapter_missing', row)
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !('seq' in value) || value.seq !== index) fail('history_sequence', row)
      decoded.push(value); total += BigInt(Buffer.byteLength(JSON.stringify(value)))
    }
    if (total !== bytes) fail('history_bytes', row)
    try {
      const parsed = parseEvents(header, decoded)
      Session.fromRestore(header.id, parsed, header, SessionLogOffset(0), 'detached')
    } catch (_invalidNativeHistory) { fail('native_history_invalid', row) }
  }
}
function noStart(rows: readonly LegacyPlannedRow[]): void {
  for (const row of rows) if (row.table === 'pe_stdio_v2_no_start_closures') {
    if (rows.some(other => ['pe_stdio_v2_start_permits', 'pe_stdio_v2_results', 'pe_stdio_v2_dispatches'].includes(other.table)
      && other.values.action_id === row.values.action_id)) fail('start_and_no_start', row)
  }
  for (const row of rows) if (row.table === 'pe_cloud_executions' && row.values.state === 'closed_unknown') {
    if (!rows.some(other => other.table === 'pe_cloud_execution_resolutions' && other.values.execution_id === row.values.id
      && other.values.state === 'completed' && other.values.final_execution_state === 'closed_unknown' && other.values.stop_evidence !== null)) {
      fail('unknown_closure_missing', row)
    }
  }
  const counter = rows.filter(row => row.table === 'pe_login_global_window')
  const windows = rows.filter(row => row.table === 'pe_login_attempt_windows')
  if (counter.length > 1 || windows.length && counter.length !== 1
    || counter[0] && BigInt(counter[0].values.tracked_accounts ?? '') !== BigInt(windows.length)) fail('login_counter_mismatch')
}
/** Order unchanged rows under fixed immediate FKs; unhandled real cycles are reported, never removed.
 * @param rows Complete retained relation.
 * @returns Row order with deferred FKs and the four reviewed late constraints preserved.
 */
export function legacyInsertionOrder(rows: readonly LegacyPlannedRow[]): readonly LegacyPlannedRow[] {
  const parents = new Map<LegacyPlannedRow, Set<LegacyPlannedRow>>()
  for (const row of rows) parents.set(row, new Set())
  for (const key of LEGACY_FOREIGN_KEYS) {
    if (key.deferred || LEGACY_LATE_CONSTRAINTS.includes(key.name)) continue
    const lookup = indexed(rows, key.target, key.references)
    for (const row of rows) if (row.table === key.table) {
      const tupleKey = tuple(key.columns, row.values)
      const parent = tupleKey === null ? undefined : lookup.get(tupleKey)
      if (parent && parent !== row) parents.get(row)?.add(parent)
    }
  }
  const result: LegacyPlannedRow[] = [], waiting = new Set(rows)
  while (waiting.size) {
    const ready = [...waiting].filter(row => [...parents.get(row) ?? []].every(parent => !waiting.has(parent)))
    if (!ready.length) fail('unhandled_immediate_foreign_key_cycle', waiting.values().next().value)
    for (const row of ready) { waiting.delete(row); result.push(row) }
  }
  return Object.freeze(result)
}
/** Validate and plan an entire detached export with mandatory subsystem owners.
 * @param text Original packet; all source rows and original JSON text are retained in its digest.
 * @param input Explicit maintenance budgets.
 * @param owners Pure export, subsystem, stopping and file validators supplied by their trusted owners.
 * @returns Frozen, issued plan; any rejected row or missing adapter prevents all target writes.
 */
export function preflightLegacyImport(text: string, input: LegacyImportLimits, owners: LegacyImportOwners): LegacyImportPlan {
  const limits = legacyLimits(input)
  const bundle = parseLegacyBundle(text, limits), packetSha256 = legacyDigest(text)
  if (bundle.source.ddlSha256 !== LEGACY_SQL_DIGESTS.source37) fail('source_schema_fingerprint')
  if (legacyTimestamp(bundle.source.stoppedAt) > legacyTimestamp(bundle.source.cut)) fail('export_before_stop')
  invoke(() => { owners.verifyCut(bundle.source, legacyJson(bundle.cutProof, limits), packetSha256) }, 'export_cut_unverified')
  const retained: LegacyPlannedRow[] = []
  for (const [table, records] of Object.entries(bundle.tables)) for (const record of records) {
    const result = mapped(table, record, limits)
    if (result) retained.push(result)
  }
  if (retained.filter(row => row.table === 'pe_schema').length !== 1) fail('source_schema_identity')
  const rows = Object.freeze(retained)
  relations(rows); noStart(rows); history(rows, limits)
  const stops = new Map<string, LegacyJson>()
  for (const stop of bundle.stops) {
    const key = `${stop.table}:${stop.rowSha256}`
    if (stops.has(key) || !bundle.tables[stop.table]?.some(row => row.sha256 === stop.rowSha256)) fail('invalid_stop_inventory')
    stops.set(key, legacyJson(stop.evidence, limits))
  }
  for (const row of rows) {
    const json: Record<string, LegacyJson> = {}
    for (const [column, specification] of Object.entries(LEGACY_TARGET_LAYOUT[row.table] ?? {})) {
      const value = row.values[column]
      if ((specification.kind === 'json' || specification.kind === 'jsonb') && value !== null && value !== undefined) json[column] = legacyJson(value, limits)
    }
    const context: LegacyOwnerContext = Object.freeze({ row, rows, source: bundle.source, limits,
      owner: rowOwner(row, rows), json: Object.freeze(json) })
    ended(context)
    invoke(() => { owners.validateRow(context) }, 'subsystem_record_unverified', row)
    let references: readonly LegacyJsonReference[] = []
    invoke(() => { references = owners.references(context) }, 'json_reference_owner_missing', row)
    jsonReferences(references, context)
    if (stopTables.has(row.table)) {
      const proof = stops.get(`${row.sourceTable}:${row.sourceSha256}`)
      if (proof === undefined) fail('original_stop_proof_missing', row)
      invoke(() => { owners.verifyStopped(context, proof) }, 'original_stop_unverified', row)
    }
  }
  invoke(() => { owners.verifyFiles(bundle.source, bundle.files, rows) }, 'file_snapshot_unverified')
  const plan = Object.freeze({ packetSha256, source: bundle.source, counts: bundle.counts,
    rows: legacyInsertionOrder(rows), files: bundle.files, limits })
  issued.add(plan)
  return plan
}
/** Refuse fabricated or mutable plans at the SQL/file owner.
 * @param plan Issued preflight result.
 * @returns Completion only for a plan issued by this module.
 */
export function assertLegacyImportPlan(plan: LegacyImportPlan): void {
  if (!issued.has(plan)) fail('unissued_import_plan')
}
