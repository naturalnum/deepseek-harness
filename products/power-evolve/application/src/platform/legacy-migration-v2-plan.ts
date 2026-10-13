/** Strict successor plans retain original capture identities and separately declare every derived current row. */
import { z } from 'zod'
import { settings, identity, executionTarget, skillSelection, mcpSelection, stdioMcpSelection, sshSelection } from '../contracts.ts'
import { LEGACY_FOREIGN_KEYS, LEGACY_TARGET_LAYOUT, LEGACY_UNIQUE_KEYS } from './legacy-import-layout.ts'
import { legacyInsertionOrder, legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { LegacyImportError, legacyCell, legacyDigest, legacyJson, legacyLimits, legacyRowDigest,
  type LegacyFileEntry, type LegacyImportLimits } from './legacy-import-codec.ts'
import type { LegacyMigrationCapture, LegacyMigrationCells } from './legacy-migration-v2-source.ts'
import type { LegacyMigratedHistory } from './legacy-migration-v2-history.ts'
import type { LegacyMigrationFileReceipt } from './legacy-migration-v2-attachments.ts'
import { legacyMigrationImageBinding, type LegacyMigrationImageBinding } from './legacy-migration-v2-media-contracts.ts'
import { legacyHistoryImages } from './legacy-migration-v2-images.ts'
import { validateLegacyMigrationAccountOwner } from './legacy-migration-v2-account-owners.ts'
import { validateLegacyMigrationFixedMcp, validateLegacyMigrationFixedMcpOperation } from './legacy-migration-v2-fixed-mcp.ts'
import { validateLegacyMigrationStorageOwner, validateLegacyMigrationSkillOperation } from './legacy-migration-v2-storage-owners.ts'
import { validateLegacyMigrationPristineMount } from './legacy-migration-v2-mount-free.ts'
import { validateLegacyMigrationStoppedCreation,
  type LegacyMigrationStoppedCreationContext } from './legacy-migration-v2-sandbox-stopped.ts'
import { validateLegacyMigrationRemoteMcp, type LegacyMigrationMcpContext } from './legacy-migration-v2-remote-mcp.ts'
import { validateLegacyMigrationMcpOperation } from './legacy-migration-v2-mcp-actions.ts'
import { validateLegacyMigrationOffice } from './legacy-migration-v2-office.ts'
import { validateLegacyMigrationSsh, validateLegacyMigrationSshOperation,
  type LegacyMigrationSshContext } from './legacy-migration-v2-ssh.ts'
import { validateLegacyMigrationStdio, validateLegacyMigrationStdioOperation,
  type LegacyMigrationStdioContext } from './legacy-migration-v2-stdio.ts'
import { validateLegacyMigrationStdioV2Metadata, type LegacyMigrationStdioV2Context } from './legacy-migration-v2-stdio-management.ts'
import { validateLegacyMigrationConnector } from './legacy-migration-v2-connectors.ts'
import { validateLegacyMigrationBuiltinSkill, type LegacyMigrationBuiltinContext } from './legacy-migration-v2-builtin-skills.ts'
import { validateLegacyMigrationStdioCall, type LegacyMigrationStdioCallContext } from './legacy-migration-v2-stdio-calls.ts'
import { validateLegacyMigrationStdioNoStart,
  type LegacyMigrationStdioNoStartContext } from './legacy-migration-v2-stdio-no-start.ts'
import { validateLegacyMigrationStdioDiscovery, validateLegacyMigrationStdioCompletedOperation, type LegacyMigrationStdioDiscoveryContext } from './legacy-migration-v2-stdio-discovery.ts'
import { validateLegacyMigrationCloudResolution, type LegacyMigrationCloudResolutionContext } from './legacy-migration-v2-cloud-resolution.ts'
import { validateLegacyMigrationCloudCancellation,
  type LegacyMigrationCloudCancellationContext } from './legacy-migration-v2-cloud-cancel.ts'

/** Signed offline cut data must match the independently captured relation and selected file inventory. */
export const legacyMigrationCut = z.object({ version: z.literal(2), snapshotId: z.uuid(), codeId: z.string().min(1),
  stoppedAt: z.string(), cut: z.string(), catalogSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  tablesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  filesSha256: z.string().regex(/^[a-f0-9]{64}$/u), kind: z.enum(['offline-restored-source', 'owned-fixture']) }).strict()
/** Authenticated cut payload; signature verification belongs to the maintenance file reader. */
export type LegacyMigrationCut = z.infer<typeof legacyMigrationCut>
/** Issued full relation and current-history plan, separate from the frozen wire1 plan issuer. */
export interface LegacyMigrationPlan {
  readonly migrationId: string
  readonly capture: LegacyMigrationCapture
  readonly rows: readonly LegacyPlannedRow[]
  readonly histories: readonly LegacyMigratedHistory[]
  readonly receipts: readonly LegacyMigrationFileReceipt[]
  readonly images: readonly LegacyMigrationImageBinding[]
  readonly files: readonly LegacyFileEntry[]
  readonly limits: LegacyImportLimits
  readonly excluded: readonly {
    readonly table: string
    readonly sha256: string
  }[]
}
const issued = new WeakSet<LegacyMigrationPlan>()
const excludedTables = new Set(['pe_artifacts', 'pe_desktop_executions', 'pe_device_pairings', 'pe_devices',
  'pe_device_directories', 'pe_device_execution_resolutions', 'pe_device_claim_closures',
  'pe_storage_directory_requests', 'pe_workspace_binding_requests'])
const initialOwners = new Set(['pe_schema', 'pe_users', 'pe_workspaces', 'pe_storage_spaces', 'pe_workspace_bindings',
  'pe_sessions', 'pe_events', 'pe_operations', 'pe_attempts', 'pe_credentials', 'pe_login_attempt_windows',
  'pe_login_global_window', 'pe_user_models', 'pe_user_plugins', 'pe_platform_admission_policy'])
const tuple = (values: LegacyMigrationCells, columns: readonly string[]) => {
  const fields = columns.map(column => values[column])
  return fields.some(value => value === undefined || value === null) ? null : JSON.stringify(fields)
}
function rowSemantics(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], capture: LegacyMigrationCapture,
  limits: LegacyImportLimits, files: readonly LegacyFileEntry[], mcp?: LegacyMigrationMcpContext,
  ssh?: LegacyMigrationSshContext, stdio?: LegacyMigrationStdioContext, stdioV2?: LegacyMigrationStdioV2Context,
  builtin?: LegacyMigrationBuiltinContext, stdioCalls?: LegacyMigrationStdioCallContext,
  cloudCancellation?: LegacyMigrationCloudCancellationContext, stdioNoStart?: LegacyMigrationStdioNoStartContext,
  stoppedCreation?: LegacyMigrationStoppedCreationContext, stdioDiscovery?: LegacyMigrationStdioDiscoveryContext,
  cloudResolution?: LegacyMigrationCloudResolutionContext): void {
  const value = row.values
  if (validateLegacyMigrationStdioDiscovery(row, rows, limits, capture.source.cut, stdioDiscovery)) return
  if (validateLegacyMigrationAccountOwner(row, rows, limits, capture.source.cut)) return
  if (validateLegacyMigrationFixedMcp(row, rows, limits, capture.source.cut)) return
  if (validateLegacyMigrationStorageOwner(row, rows, files, limits, capture.source.cut)) return
  if (validateLegacyMigrationCloudResolution(row, rows, limits, capture.source.cut, cloudResolution)) return
  if (validateLegacyMigrationStoppedCreation(row, rows, limits, capture.source.cut, stoppedCreation)) return
  if (validateLegacyMigrationPristineMount(row, rows, capture.source.cut)) return
  if (validateLegacyMigrationRemoteMcp(row, rows, limits, capture.source.cut, mcp)) return
  if (validateLegacyMigrationOffice(row, rows, files, capture.source.cut)) return
  if (validateLegacyMigrationSsh(row, rows, limits, capture.source.cut, ssh)) return
  if (validateLegacyMigrationStdio(row, rows, limits, capture.source.cut, stdio)) return
  if (validateLegacyMigrationStdioNoStart(row, rows, limits, capture.source.cut, stdioNoStart)) return
  if (validateLegacyMigrationStdioV2Metadata(row, rows, limits, capture.source.cut, stdioV2)) return
  if (validateLegacyMigrationConnector(row, rows, limits, capture.source.cut)) return
  if (validateLegacyMigrationBuiltinSkill(row, rows, capture.source.cut, builtin)) return
  if (validateLegacyMigrationStdioCall(row, rows, limits, capture.source.cut, stdioCalls)) return
  if (validateLegacyMigrationCloudCancellation(row, rows, limits, capture.source.cut, cloudCancellation, stdioDiscovery)) return
  if (!initialOwners.has(row.table)) throw new LegacyImportError('migration_row_owner_adapter_missing', row.table)
  if (row.table === 'pe_users') {
    identity.parse({ userId: value.id, username: value.username })
    settings.parse(legacyJson(value.settings ?? '', limits))
    if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/u.test(value.password_hash ?? '')
      || !['ADMIN', 'USER'].includes(value.role ?? '')) throw new LegacyImportError('migration_account_invalid')
  }
  if (row.table === 'pe_sessions' && (value.grant_digest !== null || value.lease_until !== null
    && legacyTimestamp(value.lease_until ?? '') > legacyTimestamp(capture.source.cut))) throw new LegacyImportError('migration_session_active')
  if (row.table === 'pe_operations') {
    if (!['completed', 'failed'].includes(value.state ?? '')) throw new LegacyImportError('migration_operation_replayable')
    settings.parse(legacyJson(value.settings ?? '', limits))
    executionTarget.parse(legacyJson(value.execution_target ?? '', limits))
    z.array(skillSelection).parse(legacyJson(value.skill_selection ?? '', limits))
    validateLegacyMigrationSkillOperation(row, rows, limits)
    z.array(mcpSelection).parse(legacyJson(value.mcp_selection ?? '', limits))
    validateLegacyMigrationFixedMcpOperation(row, rows, limits)
    z.array(stdioMcpSelection).parse(legacyJson(value.stdio_mcp_selection ?? '', limits))
    if (z.array(z.json()).parse(legacyJson(value.stdio_mcp_selection ?? '', limits)).length && stdio === undefined) {
      throw new LegacyImportError('migration_stdio_original_evidence_missing')
    }
    validateLegacyMigrationStdioOperation(row, rows, limits)
    z.array(sshSelection).parse(legacyJson(value.ssh_selection ?? '', limits))
    if (z.array(z.json()).parse(legacyJson(value.ssh_selection ?? '', limits)).length && ssh === undefined) {
      throw new LegacyImportError('migration_ssh_original_evidence_missing')
    }
    validateLegacyMigrationSshOperation(row, rows, limits)
    if (z.array(z.json()).parse(legacyJson(value.remote_mcp_selection ?? '', limits)).length && mcp === undefined) {
      throw new LegacyImportError('migration_mcp_original_evidence_missing')
    }
    validateLegacyMigrationMcpOperation(row, rows, limits)
    if (z.array(z.json()).parse(legacyJson(value.stdio_v2_selection ?? '', limits)).length
      && !validateLegacyMigrationStdioCompletedOperation(row, rows, limits, capture.source.cut, stdioDiscovery)) {
      throw new LegacyImportError('migration_operation_selection_owner_missing')
    }
  }
  if (row.table === 'pe_attempts' && value.ended_at === null) throw new LegacyImportError('migration_attempt_unfinished')
  if (row.table === 'pe_credentials') {
    const owner = rows.find(item => item.table === 'pe_users' && item.values.id === value.user_id)
    if (!owner || value.credential_version === owner.values.credential_version
      && legacyTimestamp(value.expires_at ?? '') > legacyTimestamp(capture.source.cut)) throw new LegacyImportError('migration_credential_active')
  }
  if (row.table === 'pe_workspaces' && value.binding_state !== 'ready'
    || row.table === 'pe_storage_spaces' && value.root_state !== 'ready') throw new LegacyImportError('migration_storage_not_ready')
}
function relationClosure(rows: readonly LegacyPlannedRow[]): void {
  for (const key of LEGACY_UNIQUE_KEYS) {
    const found = new Set<string>()
    for (const row of rows) if (row.table === key.table) {
      const value = tuple(row.values, key.columns)
      if (value !== null && found.has(value)) throw new LegacyImportError('migration_duplicate_relation', key.name)
      if (value !== null) found.add(value)
    }
  }
  for (const key of LEGACY_FOREIGN_KEYS) {
    const parents = rows.filter(row => row.table === key.target)
    for (const row of rows) if (row.table === key.table) {
      const value = tuple(row.values, key.columns)
      if (value === null) continue
      const parent = parents.find(item => tuple(item.values, key.references) === value)
      if (!parent) throw new LegacyImportError('migration_relation_missing', key.name)
      if (row.values.user_id && parent.values.user_id && row.values.user_id !== parent.values.user_id
        && !key.columns.includes('actor_user_id') && !key.columns.includes('target_user_id')) {
        throw new LegacyImportError('migration_relation_owner', key.name)
      }
    }
  }
}

/** Prepare separately derived current rows only after source/cut/file identity and complete history validation.
 * @param migrationId Exact new migration identity, independent of original operations and uploads.
 * @param capture All original77 tables and cells.
 * @param histories Qualified current artifacts from the maintained codecs/adjacent chain.
 * @param receipts Complete source-backed file authority minted explicitly for migration.
 * @param files Original business-file inventory, never inferred from current paths.
 * @param fileEvidenceDigest Digest of the protected complete storage-assignment/inventory evidence.
 * @param signedCut Authenticated offline source/cut payload.
 * @param budgets Explicit maintenance budgets.
 * @param images Complete qualified original-image permissions, separate from upload receipts.
 * @param mcp Protected original-key and row-qualified original-request evidence, bound into the signed file cut.
 * @param ssh Protected original SSH key context and original deployment/code identity, bound into the signed file cut.
 * @param stdio Protected complete original fixed STDIO toggle inputs, bound into the signed file cut.
 * @param stdioV2 Protected original STDIO v2 parser policy, bound into the signed file cut.
 * @param builtin Protected original built-in catalog, ZIP and install-row witnesses, bound into the signed file cut.
 * @param stdioCalls Protected original refusal or dispatched-call native stop and cleanup, bound into the signed file cut.
 * @param cloudCancellation Protected original pre-worker cancellation and command-admission policy, bound into the signed file cut.
 * @param stdioNoStart Protected original unallocated STDIO discovery policy, admission and closure, bound into the signed file cut.
 * @param stoppedCreation Protected original unscheduled Manager stop and paired source rows, bound into the signed file cut.
 * @param stdioDiscovery Protected complete original successful discovery and separately stopped PVC writer.
 * @param cloudResolution Protected original completed resolution, stopped writer and unique continuation.
 * @returns Issued fixed-schema2 plan; unsupported retained owners reject without becoming excluded.
 */
export function prepareLegacyMigration(migrationId: string, capture: LegacyMigrationCapture,
  histories: readonly LegacyMigratedHistory[], receipts: readonly LegacyMigrationFileReceipt[], files: readonly LegacyFileEntry[],
  fileEvidenceDigest: string, signedCut: LegacyMigrationCut, budgets: LegacyImportLimits,
  images: readonly LegacyMigrationImageBinding[] = [], mcp?: LegacyMigrationMcpContext,
  ssh?: LegacyMigrationSshContext, stdio?: LegacyMigrationStdioContext, stdioV2?: LegacyMigrationStdioV2Context,
  builtin?: LegacyMigrationBuiltinContext, stdioCalls?: LegacyMigrationStdioCallContext,
  cloudCancellation?: LegacyMigrationCloudCancellationContext, stdioNoStart?: LegacyMigrationStdioNoStartContext,
  stoppedCreation?: LegacyMigrationStoppedCreationContext, stdioDiscovery?: LegacyMigrationStdioDiscoveryContext,
  cloudResolution?: LegacyMigrationCloudResolutionContext): LegacyMigrationPlan {
  z.uuid().parse(migrationId)
  const limits = legacyLimits(budgets), cut = legacyMigrationCut.parse(signedCut)
  if (cut.snapshotId !== capture.source.snapshotId || cut.codeId !== capture.source.codeId
    || cut.stoppedAt !== capture.source.stoppedAt || cut.cut !== capture.source.cut
    || cut.catalogSha256 !== capture.catalogSha256
    || cut.tablesSha256 !== legacyDigest(JSON.stringify(capture.tables)) || cut.filesSha256 !== fileEvidenceDigest
    || legacyTimestamp(cut.stoppedAt) > legacyTimestamp(cut.cut)) throw new LegacyImportError('migration_cut_mismatch')
  const excluded: {
      table: string
      sha256: string
    }[] = [], rows: LegacyPlannedRow[] = []
  const sessionMap = new Map(histories.map(history => [history.sessionId, history]))
  for (const [table, records] of Object.entries(capture.tables)) for (const original of records) {
    const sourceSha256 = legacyRowDigest(table, original)
    if (excludedTables.has(table) || table === 'pe_file_mutations' && original.base_digest !== null
      || table === 'pe_stdio_v2_actions' && original.execution_target !== 'cloud'
      || table === 'pe_operations' && (original.source === 'desktop_result' || original.source_desktop_execution_id !== null)) {
      excluded.push({ table, sha256: sourceSha256 }); continue
    }
    if (table === 'pe_events') continue
    const target = table === 'pe_file_mutations' ? 'pe_file_uploads' : table
    const layout = LEGACY_TARGET_LAYOUT[target]
    if (!layout) throw new LegacyImportError('migration_target_table_missing', table)
    const values: Record<string, string | null> = {}
    for (const [column, specification] of Object.entries(layout)) {
      let cell = table === 'pe_schema' ? column === 'version' ? '2' : 'cloud-native' : original[column]
      if (table === 'pe_sessions') {
        const history = sessionMap.get(original.id ?? '')
        if (!history) throw new LegacyImportError('migration_history_missing')
        if (column === 'header') cell = history.headerText
        if (column === 'event_count') cell = String(history.events.length)
        if (column === 'event_bytes') cell = history.eventBytes
      }
      if (cell === undefined) throw new LegacyImportError('migration_cell_missing', `${target}.${column}`)
      legacyCell(cell, specification, limits, `${target}.${column}`)
      if (cell !== null && specification.kind === 'timestamptz') legacyTimestamp(cell)
      values[column] = cell
    }
    rows.push(Object.freeze({ table: target, sourceTable: table, sourceSha256, values: Object.freeze(values) }))
  }
  for (const history of histories) for (const [index, text] of history.eventTexts.entries()) {
    const source = capture.tables.pe_sessions?.find(row => row.id === history.sessionId)
    if (!source) throw new LegacyImportError('migration_history_missing')
    rows.push(Object.freeze({ table: 'pe_events', sourceTable: 'pe_sessions', sourceSha256: legacyRowDigest('pe_sessions', source),
      values: Object.freeze({ session_id: history.sessionId, seq: String(index), event: text }) }))
  }
  if (rows.filter(row => row.table === 'pe_schema').length !== 1 || sessionMap.size !== (capture.tables.pe_sessions?.length ?? 0)) {
    throw new LegacyImportError('migration_schema_history_inventory')
  }
  relationClosure(rows)
  for (const row of rows) {
    rowSemantics(row, rows, capture, limits, files, mcp, ssh, stdio, stdioV2, builtin, stdioCalls, cloudCancellation, stdioNoStart,
      stoppedCreation, stdioDiscovery, cloudResolution)
  }
  const windows = rows.filter(row => row.table === 'pe_login_attempt_windows')
  const global = rows.filter(row => row.table === 'pe_login_global_window')
  if (windows.length && global.length !== 1 || global.length > 1
    || global[0] && BigInt(global[0].values.tracked_accounts ?? '') !== BigInt(windows.length)) throw new LegacyImportError('migration_login_counter')
  for (const receipt of receipts) {
    const owner = sessionMap.get(receipt.sessionId), storage = sessionMap.get(receipt.storageSessionId)
    if (!owner || !storage || owner.userId !== receipt.userId || storage.userId !== receipt.userId) {
      throw new LegacyImportError('migration_receipt_owner')
    }
  }
  const qualifiedImages = images.map(image => legacyMigrationImageBinding.parse(image))
  for (const history of histories) for (const occurrence of legacyHistoryImages(history)) {
    if (qualifiedImages.filter(image => image.sessionId === history.sessionId && image.userId === history.userId
      && JSON.stringify(image.image) === JSON.stringify(occurrence.image)
      && image.occurrences.some(item => item.seq === occurrence.seq && item.imageIndex === occurrence.imageIndex)).length !== 1) {
      throw new LegacyImportError('migration_image_binding_missing')
    }
  }
  for (const image of qualifiedImages) {
    const owner = sessionMap.get(image.sessionId), storage = sessionMap.get(image.storageSessionId)
    if (!owner || !storage || image.migrationId !== migrationId || owner.userId !== image.userId || storage.userId !== image.userId) {
      throw new LegacyImportError('migration_image_owner')
    }
  }
  const plan = Object.freeze({ migrationId, capture, rows: legacyInsertionOrder(rows), histories, receipts,
    images: Object.freeze(qualifiedImages), files, limits,
    excluded: Object.freeze(excluded) })
  issued.add(plan)
  return plan
}

/** Refuse forged successor plans before target SQL or candidate file publication.
 * @param plan Current-process issued v2 preparation result.
 * @returns Completion only for this issuer's actual plan object.
 */
export function assertLegacyMigrationPlan(plan: LegacyMigrationPlan): void {
  if (!issued.has(plan)) throw new LegacyImportError('migration_plan_unissued')
}
