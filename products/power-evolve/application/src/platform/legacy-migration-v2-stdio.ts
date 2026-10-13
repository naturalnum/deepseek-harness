/** Original fixed STDIO metadata and input-qualified toggle history; retained calls need their separate worker closure. */
import { z } from 'zod'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Fixed STDIO connection and receipt owners; execution rows remain unsupported. */
export const LEGACY_MIGRATION_STDIO_TABLES: ReadonlySet<string> = new Set([
  'pe_stdio_mcp_connections', 'pe_stdio_mcp_updates',
])
const toggleInput = z.object({ id: z.uuid(), baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict()
const originalResult = z.object({ connectionId: z.uuid(), name: z.string().min(1).max(80), enabled: z.boolean(),
  revision: z.number().int().min(2).max(2_147_483_647), toolName: z.literal('mcp__stdio__whoami'),
  description: z.literal('在隔离进程中读取当前账户标识（只读）') }).strict()
/** Original toggle inputs retain UUID spelling because the service hashes the supplied id before PG canonicalizes it. */
export const legacyMigrationStdioEvidence = z.object({ format: z.literal('power-evolve-legacy-stdio-inputs'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), requests: z.array(z.object({
    userId: z.uuid(), requestId: z.uuid(), sourceRowSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    input: toggleInput,
  }).strict()) }).strict()
/** Process-issued original input context, authenticated by its digest in the signed file cut. */
export interface LegacyMigrationStdioContext { readonly evidenceSha256: string }
const contexts = new WeakMap<LegacyMigrationStdioContext, z.infer<typeof legacyMigrationStdioEvidence>>()
function fail(code: string): never { throw new LegacyImportError(code) }
function connection(rows: readonly LegacyPlannedRow[], id: string | null | undefined, user: string | null | undefined) {
  const owner = rows.find(item => item.table === 'pe_stdio_mcp_connections' && item.values.id === id && item.values.user_id === user)
  if (!owner) fail('migration_stdio_owner_missing')
  return owner
}
function receipt(row: LegacyPlannedRow, owner: LegacyPlannedRow, limits: LegacyImportLimits,
  evidence: z.infer<typeof legacyMigrationStdioEvidence>) {
  const proof = evidence.requests.find(item => item.userId === row.values.user_id && item.requestId === row.values.request_id)
  if (!proof || proof.sourceRowSha256 !== row.sourceSha256) fail('migration_stdio_input_identity')
  const result = originalResult.parse(legacyJson(row.values.result ?? '', limits))
  const input = proof.input
  if (input.id.toLowerCase() !== owner.values.id || result.connectionId !== owner.values.id
    || result.name !== owner.values.name || result.revision !== input.baseRevision + 1
    || result.enabled !== input.enabled || result.revision > Number(owner.values.revision)
    || row.values.request_digest !== legacyDigest(JSON.stringify({ id: input.id,
      baseRevision: input.baseRevision, enabled: input.enabled }))
    || legacyTimestamp(row.values.created_at ?? '') < legacyTimestamp(owner.values.created_at ?? '')
    || legacyTimestamp(row.values.created_at ?? '') > legacyTimestamp(owner.values.updated_at ?? '')) {
    fail('migration_stdio_receipt_invalid')
  }
  return result
}
function inventory(rows: readonly LegacyPlannedRow[], evidence: z.infer<typeof legacyMigrationStdioEvidence>) {
  const receipts = rows.filter(item => item.table === 'pe_stdio_mcp_updates')
  if (receipts.length !== evidence.requests.length || new Set(evidence.requests.map(item =>
    `${item.userId}/${item.requestId}`)).size !== evidence.requests.length
    || evidence.requests.some(proof => receipts.filter(item => item.values.user_id === proof.userId
      && item.values.request_id === proof.requestId && item.sourceSha256 === proof.sourceRowSha256).length !== 1)) {
    fail('migration_stdio_input_inventory')
  }
}

/** Issue original input evidence without creating Runner access, calls or worker authority.
 * @param evidence Protected complete original toggle inputs and exact retained receipt digests.
 * @param sourceCodeId Original deployment/code identity from the independently captured source.
 * @param limits Explicit request-count budgets.
 * @returns Immutable context whose evidence digest belongs in the signed file cut.
 */
export function createLegacyMigrationStdioContext(evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): LegacyMigrationStdioContext {
  const original = legacyMigrationStdioEvidence.parse(evidence)
  if (original.sourceCodeId !== sourceCodeId || original.requests.length > limits.maxRows) fail('migration_stdio_original_input_identity')
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, structuredClone(original))
  return context
}

/** Validate retained fixed STDIO metadata against complete original inputs and revision history.
 * @param row Source-preserving row after fixed-layout parsing.
 * @param rows Complete retained source inventory.
 * @param limits Explicit row and JSON budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Process-issued original input context.
 * @returns Whether the metadata owner is supported; retained calls remain separately rejected.
 */
export function validateLegacyMigrationStdio(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationStdioContext): boolean {
  if (!LEGACY_MIGRATION_STDIO_TABLES.has(row.table)) return false
  const evidence = context === undefined ? undefined : contexts.get(context)
  if (!evidence) fail('migration_stdio_original_evidence_missing')
  inventory(rows, evidence)
  const value = row.values
  if (legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) fail('migration_stdio_future')
  if (row.table === 'pe_stdio_mcp_updates') {
    receipt(row, connection(rows, value.connection_id, value.user_id), limits, evidence)
    return true
  }
  const revision = Number(value.revision)
  if (!rows.some(item => item.table === 'pe_users' && item.values.id === value.user_id)
    || value.id !== value.install_request_id || !z.string().min(1).max(80).safeParse(value.name).success
    || revision < 1 || revision > limits.maxRows || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)) fail('migration_stdio_connection_invalid')
  const updates = rows.filter(item => item.table === 'pe_stdio_mcp_updates' && item.values.connection_id === value.id
    && item.values.user_id === value.user_id).map(item => ({ result: receipt(item, row, limits, evidence), time: item.values.created_at ?? '' }))
    .sort((a, b) => a.result.revision - b.result.revision)
  if (updates.length !== revision - 1 || updates.some((item, index) => item.result.revision !== index + 2
    || index > 0 && legacyTimestamp(item.time) < legacyTimestamp(updates[index - 1]?.time ?? ''))
    || (updates.at(-1)?.result.enabled ?? true) !== (value.enabled === 'true')
    || legacyTimestamp(value.updated_at ?? '') !== legacyTimestamp(updates.at(-1)?.time ?? value.created_at ?? '')) {
    fail('migration_stdio_toggle_chain')
  }
  return true
}

/** Validate accepted original fixed STDIO snapshots at their historical revision, including later-disabled connections.
 * @param operation Original settled Operation retaining its accepted input and selection bytes.
 * @param rows Complete metadata and Session owner inventory.
 * @param limits Explicit JSON budgets.
 * @returns Completion only when each selection was enabled and current when the original Operation was accepted.
 */
export function validateLegacyMigrationStdioOperation(operation: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits): void {
  const selections = z.array(z.object({ connectionId: z.uuid(), revision: z.number().int().positive() }).strict()).max(1)
    .parse(legacyJson(operation.values.stdio_mcp_selection ?? '', limits))
  if (!selections.length) return
  const session = rows.find(item => item.table === 'pe_sessions' && item.values.id === operation.values.session_id)
  if (!session) fail('migration_stdio_operation_owner_missing')
  const acceptedAt = legacyTimestamp(operation.values.created_at ?? '')
  for (const selected of selections) {
    const owner = connection(rows, selected.connectionId, session.values.user_id)
    const updates = rows.filter(item => item.table === 'pe_stdio_mcp_updates' && item.values.connection_id === selected.connectionId)
      .map(item => ({ result: originalResult.parse(legacyJson(item.values.result ?? '', limits)),
        time: legacyTimestamp(item.values.created_at ?? '') }))
    const version = selected.revision === 1 ? { enabled: true, time: legacyTimestamp(owner.values.created_at ?? '') }
      : updates.find(item => item.result.revision === selected.revision)
    const enabled = version && ('result' in version ? version.result.enabled : version.enabled)
    if (!version || !enabled || version.time > acceptedAt || selected.revision > Number(owner.values.revision)
      || updates.some(item => item.result.revision > selected.revision && item.time <= acceptedAt)) {
      fail('migration_stdio_operation_selection_invalid')
    }
  }
}
