/** Original remote-MCP metadata, encrypted snapshots, request inputs and catalogs remain independently authenticated. */
import { z } from 'zod'
import { mcpCreateRequest, mcpUpdateRequest, mcpToggleRequest, mcpDeleteRequest, mcpDraftRequest,
  mcpCheckRequest, mcpResourceId, mcpUserId, mcpDiscoveredTool, type McpCredentialUpload } from '../mcp-contracts.ts'
import { McpCredentialCipher, mcpCanonicalJson, mcpHeaderName, normalizeMcpConfiguration } from './mcp-credentials.ts'
import { mcpCatalogDigest, mcpCatalogTools } from './mcp-catalog.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { LEGACY_MIGRATION_MCP_ACTION_TABLES, validateLegacyMigrationMcpActionOwner } from './legacy-migration-v2-mcp-actions.ts'
import { legacyMigrationMcpStartedActionEvidence } from './legacy-migration-v2-mcp-started.ts'
import { legacyMigrationMcpCheckClosureEvidence, validateLegacyMigrationMcpCheckClosure } from './legacy-migration-v2-mcp-check-closure.ts'
import { legacyMigrationMcpCatalogRaceEvidence, validateLegacyMigrationMcpCatalogRaces } from './legacy-migration-v2-mcp-catalog-races.ts'

/** Metadata, drafts and qualified terminal checks; remote action closure remains separately required. */
export const LEGACY_MIGRATION_REMOTE_MCP_TABLES: ReadonlySet<string> = new Set([
  'pe_mcp_remote_connections', 'pe_mcp_configuration_versions', 'pe_mcp_credential_versions',
  'pe_mcp_management_requests', 'pe_mcp_credential_tickets', 'pe_mcp_catalog_versions',
  'pe_mcp_drafts', 'pe_mcp_checks',
  ...LEGACY_MIGRATION_MCP_ACTION_TABLES,
])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const revision = z.number().int().positive()
const purpose = z.enum(['create', 'update', 'toggle', 'delete', 'draft', 'check'])
/** Protected original source key declaration; its identifier must match the signed input evidence. */
export const legacyMigrationMcpKey = z.object({ format: z.literal('power-evolve-legacy-mcp-key'), version: z.literal(1),
  keyId: z.string().min(1).max(200), key: z.string().min(1).max(100) }).strict()
/** Original management inputs are mandatory because retained request rows contain only their HMAC identities. */
export const legacyMigrationMcpEvidence = z.object({ format: z.literal('power-evolve-legacy-mcp-inputs'), version: z.literal(1),
  keyId: z.string().min(1).max(200), sourceCodeId: z.string().min(1).max(200),
  requests: z.array(z.object({ userId: z.uuid(), requestId: z.uuid(), sourceRowSha256: digest, purpose,
    input: z.json(), sizeBytes: z.number().int().nonnegative().max(16384) }).strict()),
  checkRuns: z.array(z.object({ checkId: z.uuid(), userId: z.uuid(), sourceRowSha256: digest,
    lease: z.object({ checkId: z.uuid(), ownerId: z.uuid(), epoch: revision }).strict(),
    outcome: z.union([z.object({ tools: z.array(mcpDiscoveredTool) }).strict(),
      z.object({ errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u) }).strict()]), completed: z.json() }).strict()).optional(),
  actionRuns: z.array(legacyMigrationMcpStartedActionEvidence).optional(),
  checkClosures: z.array(legacyMigrationMcpCheckClosureEvidence).optional(),
  catalogRaces: z.array(legacyMigrationMcpCatalogRaceEvidence).optional(),
}).strict()
/** Process-issued original-key context; only its evidence digest enters the signed file-cut representation. */
export interface LegacyMigrationMcpContext { readonly evidenceSha256: string }
type Evidence = z.infer<typeof legacyMigrationMcpEvidence>
const contexts = new WeakMap<LegacyMigrationMcpContext, { cipher: McpCredentialCipher; evidence: Evidence }>()
const configuration = z.object({ displayName: z.string().min(1).max(100), serverUrl: z.string().min(1).max(2048),
  serverName: z.string().regex(/^c_[a-f0-9]{32}$/u), authentication: z.enum(['none', 'bearer', 'headers']),
  headerNames: z.array(z.string()).max(16), secretConfigured: z.boolean() }).catchall(z.json())
const connectionResult = z.object({ connectionId: z.uuid(), revision, configurationRevision: revision,
  credentialRevision: revision.nullable(), displayName: z.string(), serverName: z.string(), serverUrl: z.string(),
  transport: z.literal('streamable-http'), authentication: z.enum(['none', 'bearer', 'headers']),
  headerNames: z.array(z.string()), secretConfigured: z.boolean(), enabled: z.boolean(), deletedAt: z.string().nullable(),
  currentCatalogId: z.uuid().nullable(), createdAt: z.string(), updatedAt: z.string() }).catchall(z.json())
const checkResult = z.object({ checkId: z.uuid(), draftId: z.uuid().nullable(), connectionId: z.uuid().nullable(),
  sessionId: z.uuid(), connectionRevision: revision.nullable(), configurationRevision: revision,
  credentialRevision: revision.nullable(), state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  catalogId: z.uuid().nullable(), discoveredTools: z.number().int().nonnegative().nullable(), errorCode: z.string().nullable(),
  cancelRequested: z.boolean(), createdAt: z.string(), expiresAt: z.string() }).catchall(z.json())
const resultSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('connection'), item: connectionResult }).catchall(z.json()),
  z.object({ kind: z.literal('check'), item: checkResult }).catchall(z.json())])
const catalogTool = z.object({ toolId: z.uuid(), publicName: z.string(), descriptorDigest: digest,
  raw: mcpDiscoveredTool }).catchall(z.json())
const emptySecret: McpCredentialUpload = { formatVersion: 1 }
function fail(code: string): never { throw new LegacyImportError(code) }
function find(rows: readonly LegacyPlannedRow[], table: string, fields: Readonly<Record<string, string | null>>): LegacyPlannedRow {
  const row = rows.find(item => item.table === table && Object.entries(fields).every(([key, value]) => item.values[key] === value))
  if (!row) fail('migration_mcp_reference_missing')
  return row
}
function requireResourceRevision(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[]): void {
  const value = row.values
  if (value.connection_id !== null) find(rows, 'pe_mcp_configuration_versions', { connection_id: value.connection_id ?? null,
    user_id: value.user_id ?? null, configuration_revision: value.configuration_revision ?? null,
    credential_revision: value.credential_revision ?? null })
  else find(rows, 'pe_mcp_drafts', { id: value.draft_id ?? null, user_id: value.user_id ?? null,
    configuration_revision: value.configuration_revision ?? null, credential_revision: value.credential_revision ?? null })
}
function json(row: LegacyPlannedRow, column: string, limits: LegacyImportLimits) {
  return legacyJson(row.values[column] ?? '', limits)
}
function normalized(proof: Evidence['requests'][number]) {
  const raw = proof.purpose === 'create' ? mcpCreateRequest.parse(proof.input)
    : proof.purpose === 'update' ? mcpUpdateRequest.parse(proof.input)
      : proof.purpose === 'toggle' ? mcpToggleRequest.parse(proof.input)
        : proof.purpose === 'delete' ? mcpDeleteRequest.parse(proof.input)
          : proof.purpose === 'draft' ? mcpDraftRequest.parse(proof.input) : mcpCheckRequest.parse(proof.input)
  if (raw.requestId.toLowerCase() !== proof.requestId) fail('migration_mcp_input_identity')
  return 'configuration' in raw ? { ...raw, purpose: proof.purpose,
    configuration: normalizeMcpConfiguration(raw.configuration) } : raw
}
function config(row: LegacyPlannedRow, limits: LegacyImportLimits) {
  const value = configuration.parse(json(row, 'configuration', limits))
  const auth = value.authentication === 'none' ? { kind: 'none' as const }
    : value.authentication === 'bearer' ? { kind: 'bearer' as const, action: 'retain' as const }
      : { kind: 'headers' as const, headers: value.headerNames.map(name => ({ name, action: 'retain' as const })) }
  const normalized = normalizeMcpConfiguration({ displayName: value.displayName, serverUrl: value.serverUrl,
    enabled: false, authentication: auth })
  if (normalized.displayName !== value.displayName || normalized.serverUrl !== value.serverUrl
    || value.headerNames.some(name => mcpHeaderName(name) !== name)
    || new Set(value.headerNames).size !== value.headerNames.length
    || value.authentication !== 'headers' && value.headerNames.length
    || value.authentication === 'none' && value.secretConfigured) fail('migration_mcp_configuration_invalid')
  const credential = row.values.credential_revision
  if ((credential !== null) !== value.secretConfigured || credential !== null && credential !== row.values.configuration_revision) {
    fail('migration_mcp_credential_revision')
  }
  return value
}
function secret(cipher: McpCredentialCipher, row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits): McpCredentialUpload {
  const value = config(row, limits)
  if (row.values.credential_revision === null) return emptySecret
  const draft = row.table === 'pe_mcp_drafts'
  const credential = draft ? row : find(rows, 'pe_mcp_credential_versions', { connection_id: row.values.connection_id ?? null,
    user_id: row.values.user_id ?? null, configuration_revision: row.values.configuration_revision ?? null,
    credential_revision: row.values.credential_revision ?? null })
  const sealed = draft ? credential.values.credential_sealed : credential.values.sealed
  if (!draft && credential.values.format_version !== '1' || !/^\\x(?:[a-f0-9]{2}){29,}$/u.test(sealed ?? '')) {
    fail('migration_mcp_ciphertext_invalid')
  }
  let opened: McpCredentialUpload
  try { opened = cipher.open({ kind: draft ? 'draft' : 'connection', userId: mcpUserId.parse(row.values.user_id),
    resourceId: mcpResourceId.parse(draft ? row.values.id : row.values.connection_id),
    configurationRevision: Number(row.values.configuration_revision),
    credentialRevision: Number(row.values.credential_revision) }, Buffer.from((sealed ?? '').slice(2), 'hex')) }
  catch { fail('migration_mcp_credential_unavailable') }
  if (value.authentication === 'bearer' && (opened.bearerToken === undefined || opened.headers !== undefined)
    || value.authentication === 'headers' && (opened.bearerToken !== undefined
      || mcpCanonicalJson(opened.headers?.map(header => header.name)) !== mcpCanonicalJson(value.headerNames))) {
    fail('migration_mcp_secret_metadata')
  }
  return opened
}
function requestProof(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], evidence: Evidence) {
  const receipts = rows.filter(item => item.table === 'pe_mcp_management_requests')
  if (receipts.length !== evidence.requests.length || evidence.requests.some(proof => receipts.filter(item =>
    item.values.user_id === proof.userId && item.values.request_id === proof.requestId
      && item.sourceSha256 === proof.sourceRowSha256).length !== 1)
    || new Set(evidence.requests.map(proof => `${proof.userId}/${proof.requestId}`)).size !== evidence.requests.length) {
    fail('migration_mcp_input_inventory')
  }
  const proof = evidence.requests.find(item => item.userId === row.values.user_id && item.requestId === row.values.request_id)
  if (!proof || proof.purpose !== row.values.purpose) fail('migration_mcp_input_identity')
  return proof
}
function connectionReceipt(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits) {
  const result = resultSchema.parse(json(row, 'result', limits))
  if (result.kind !== 'connection') fail('migration_mcp_result_kind')
  const item = result.item, owner = find(rows, 'pe_mcp_remote_connections', { id: item.connectionId, user_id: row.values.user_id ?? null })
  const version = find(rows, 'pe_mcp_configuration_versions', { connection_id: item.connectionId,
    user_id: row.values.user_id ?? null, configuration_revision: String(item.configurationRevision) })
  const metadata = config(version, limits)
  if (item.revision > Number(owner.values.revision) || item.credentialRevision !== (version.values.credential_revision === null
    ? null : Number(version.values.credential_revision)) || item.serverName !== owner.values.server_name
    || ['displayName', 'serverUrl', 'authentication', 'secretConfigured'].some(key => item[key] !== metadata[key])
    || mcpCanonicalJson(item.headerNames) !== mcpCanonicalJson(metadata.headerNames)
    || legacyTimestamp(item.createdAt) !== legacyTimestamp(owner.values.created_at ?? '') / 1000n * 1000n
    || legacyTimestamp(item.createdAt) > legacyTimestamp(item.updatedAt)
    || legacyTimestamp(item.updatedAt) > legacyTimestamp(owner.values.updated_at ?? '')
    || item.deletedAt !== null && (item.enabled || legacyTimestamp(item.deletedAt) > legacyTimestamp(owner.values.updated_at ?? ''))) {
    fail('migration_mcp_result_identity')
  }
  if (item.currentCatalogId !== null) find(rows, 'pe_mcp_catalog_versions', { id: item.currentCatalogId, user_id: row.values.user_id ?? null,
    connection_id: item.connectionId, configuration_revision: String(item.configurationRevision),
    credential_revision: version.values.credential_revision ?? null })
  return { item, owner, version }
}
function historicalVersion(rows: readonly LegacyPlannedRow[], userId: string, connectionId: string,
  authorityRevision: number, limits: LegacyImportLimits) {
  const prior = rows.filter(item => item.table === 'pe_mcp_management_requests' && item.values.user_id === userId
    && item.values.result !== null).find((item) => {
    const result = resultSchema.parse(json(item, 'result', limits))
    return result.kind === 'connection' && result.item.connectionId === connectionId && result.item.revision === authorityRevision
  })
  if (!prior) fail('migration_mcp_retained_source_missing')
  return connectionReceipt(prior, rows, limits).version
}
function retained(input: ReturnType<typeof normalized>, version: LegacyPlannedRow, opened: McpCredentialUpload,
  cipher: McpCredentialCipher, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits,
  source?: { connectionId: string; authorityRevision: number }): void {
  if (!('configuration' in input)) return
  const auth = input.configuration.authentication, metadata = config(version, limits)
  if (auth.kind === 'headers' && mcpCanonicalJson(auth.headers.map(header => header.name)) !== mcpCanonicalJson(metadata.headerNames)
    || auth.kind === 'bearer' && auth.action === 'clear' && metadata.secretConfigured) fail('migration_mcp_credential_plan')
  if (!(auth.kind === 'bearer' && auth.action === 'retain'
    || auth.kind === 'headers' && auth.headers.some(header => header.action === 'retain'))) return
  if (!source) fail('migration_mcp_retained_source_missing')
  const previous = secret(cipher, historicalVersion(rows, version.values.user_id ?? '', source.connectionId,
    source.authorityRevision, limits), rows, limits)
  if (auth.kind === 'bearer' && opened.bearerToken !== previous.bearerToken
    || auth.kind === 'headers' && auth.headers.some(header => header.action === 'retain'
      && opened.headers?.find(item => item.name === header.name)?.value
        !== previous.headers?.find(item => item.name === header.name)?.value)) {
    fail('migration_mcp_retained_secret_changed')
  }
}
function supplied(input: ReturnType<typeof normalized>, opened: McpCredentialUpload): McpCredentialUpload {
  if (!('configuration' in input)) return emptySecret
  const auth = input.configuration.authentication
  if (auth.kind === 'bearer' && auth.action === 'replace') {
    if (opened.bearerToken === undefined) fail('migration_mcp_original_supplied_missing')
    return { formatVersion: 1, bearerToken: opened.bearerToken }
  }
  if (auth.kind === 'headers' && auth.headers.some(header => header.action === 'replace')) {
    const replacements = auth.headers.filter(header => header.action === 'replace').map(header => header.name)
    const headers = opened.headers?.filter(header => replacements.includes(header.name))
    if (headers?.length !== replacements.length) fail('migration_mcp_original_supplied_missing')
    return { formatVersion: 1, headers }
  }
  return emptySecret
}
function checkReceipt(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits) {
  const result = resultSchema.parse(json(row, 'result', limits))
  if (result.kind !== 'check') fail('migration_mcp_result_kind')
  const item = result.item
  find(rows, 'pe_sessions', { id: item.sessionId, user_id: row.values.user_id ?? null })
  if ((item.connectionId === null) === (item.draftId === null) || item.state !== 'queued' || item.catalogId !== null
    || item.discoveredTools !== null || item.errorCode !== null || item.cancelRequested) fail('migration_mcp_check_original_result')
  const check = rows.find(record => record.table === 'pe_mcp_checks' && record.values.id === item.checkId
    && record.values.user_id === row.values.user_id)
  if (check && (check.values.session_id !== item.sessionId || check.values.connection_id !== item.connectionId
    || check.values.draft_id !== item.draftId
    || check.values.configuration_revision !== String(item.configurationRevision)
    || check.values.credential_revision !== (item.credentialRevision === null ? null : String(item.credentialRevision))
    || check.values.connection_revision !== (item.connectionRevision === null ? null : String(item.connectionRevision))
    || legacyTimestamp(item.createdAt) !== legacyTimestamp(check.values.created_at ?? '') / 1000n * 1000n
    || legacyTimestamp(item.expiresAt) !== legacyTimestamp(check.values.expires_at ?? '') / 1000n * 1000n)) {
    fail('migration_mcp_check_result_identity')
  }
  return item
}
function originalCheckRequest(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits) {
  const receipts = rows.filter(item => item.table === 'pe_mcp_management_requests' && item.values.user_id === row.values.user_id
    && item.values.result !== null).filter((item) => {
    const result = resultSchema.parse(json(item, 'result', limits))
    return result.kind === 'check' && (row.table === 'pe_mcp_checks' ? result.item.checkId === row.values.id
      : result.item.draftId === row.values.id)
  })
  if (receipts.length !== 1) fail('migration_mcp_check_request_closure')
  const receipt = receipts[0]
  if (!receipt) fail('migration_mcp_check_request_closure')
  return checkReceipt(receipt, rows, limits)
}

function checkInventory(rows: readonly LegacyPlannedRow[], evidence: Evidence): void {
  const proofs = [...(evidence.checkRuns ?? []), ...(evidence.checkClosures ?? [])]
  const started = rows.filter(item => item.table === 'pe_mcp_checks' && item.values.lease_epoch !== '0')
  if (proofs.length !== started.length || new Set(proofs.map(proof => proof.checkId)).size !== proofs.length
    || proofs.some(proof => started.filter(item => item.values.id === proof.checkId
      && item.values.user_id === proof.userId && item.sourceSha256 === proof.sourceRowSha256).length !== 1)) {
    fail('migration_mcp_check_worker_inventory')
  }
}
function completedCheck(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], evidence: Evidence,
  limits: LegacyImportLimits, cut: string): void {
  const value = row.values, closure = evidence.checkClosures?.find(item => item.checkId === value.id && item.userId === value.user_id)
  const proof = evidence.checkRuns?.find(item => item.checkId === value.id && item.userId === value.user_id)
  if (!closure && !proof) fail('migration_mcp_check_worker_closure_missing')
  checkInventory(rows, evidence)
  if (closure) {
    validateLegacyMigrationMcpCheckClosure(row, closure, rows, limits, cut)
    const completed = checkResult.parse(closure.transition.completed)
    const expected = { checkId: value.id, connectionId: value.connection_id, draftId: value.draft_id,
      sessionId: value.session_id, connectionRevision: value.connection_revision === null ? null : Number(value.connection_revision),
      configurationRevision: Number(value.configuration_revision),
      credentialRevision: value.credential_revision === null ? null : Number(value.credential_revision),
      state: value.state, catalogId: value.catalog_id, discoveredTools: null, errorCode: value.error_code,
      cancelRequested: value.cancel_requested === 'true', createdAt: new Date(value.created_at ?? '').toISOString(),
      expiresAt: new Date(value.expires_at ?? '').toISOString() }
    if (mcpCanonicalJson(completed) !== mcpCanonicalJson(expected)) fail('migration_mcp_check_worker_result')
    return
  }
  if (!proof) fail('migration_mcp_check_worker_closure_missing')
  if (proof.lease.checkId !== value.id || String(proof.lease.epoch) !== value.lease_epoch
    || value.lease_owner !== null || value.lease_until !== null || value.cancel_requested !== 'false'
    || !['succeeded', 'failed'].includes(value.state ?? '')
    || legacyTimestamp(value.updated_at ?? '') < legacyTimestamp(value.created_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)
    || legacyTimestamp(value.updated_at ?? '') >= legacyTimestamp(value.expires_at ?? '')) {
    fail('migration_mcp_check_worker_terminal')
  }
  const completed = checkResult.parse(proof.completed)
  const expected = { checkId: value.id, connectionId: value.connection_id, draftId: value.draft_id,
    sessionId: value.session_id, connectionRevision: value.connection_revision === null ? null : Number(value.connection_revision),
    configurationRevision: Number(value.configuration_revision),
    credentialRevision: value.credential_revision === null ? null : Number(value.credential_revision),
    state: value.state, catalogId: value.catalog_id,
    discoveredTools: value.discovered_tools === null ? null : Number(value.discovered_tools),
    errorCode: value.error_code, cancelRequested: false,
    createdAt: new Date(value.created_at ?? '').toISOString(), expiresAt: new Date(value.expires_at ?? '').toISOString() }
  if (mcpCanonicalJson(completed) !== mcpCanonicalJson(expected)) fail('migration_mcp_check_worker_result')
  if ('tools' in proof.outcome) {
    if (value.state !== 'succeeded' || value.catalog_id === null || value.error_code !== null
      || Number(value.discovered_tools) !== proof.outcome.tools.length || proof.outcome.tools.length > limits.maxRows) {
      fail('migration_mcp_check_worker_catalog')
    }
    const catalog = find(rows, 'pe_mcp_catalog_versions', { id: value.catalog_id ?? null, user_id: value.user_id ?? null,
      connection_id: value.connection_id ?? null, draft_id: value.draft_id ?? null,
      configuration_revision: value.configuration_revision ?? null, credential_revision: value.credential_revision ?? null })
    const expectedTools = mcpCatalogTools(mcpResourceId.parse(value.connection_id ?? value.draft_id), proof.outcome.tools)
    if (mcpCatalogDigest(proof.outcome.tools) !== catalog.values.catalog_digest
      || mcpCanonicalJson(expectedTools) !== mcpCanonicalJson(json(catalog, 'tools', limits))
      || legacyTimestamp(catalog.values.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')) {
      fail('migration_mcp_check_worker_catalog')
    }
  } else if (value.state !== 'failed' || value.catalog_id !== null || value.discovered_tools !== null
    || value.error_code !== proof.outcome.errorCode) fail('migration_mcp_check_worker_error')
}

/** Bind the protected original key and complete original-input declarations without serializing secret values.
 * @param key Protected key declaration from the stopped original source configuration.
 * @param evidence Complete row-qualified original metadata inputs.
 * @param sourceCodeId Independently captured source code identity.
 * @param limits Explicit input inventory and JSON budgets.
 * @returns A process-issued context whose digest must be included in the authenticated file cut.
 */
export function createLegacyMigrationMcpContext(key: unknown, evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): LegacyMigrationMcpContext {
  const original = legacyMigrationMcpKey.parse(key), input = legacyMigrationMcpEvidence.parse(evidence)
  if (original.keyId !== input.keyId || input.sourceCodeId !== sourceCodeId || input.requests.length > limits.maxRows
    || (input.checkRuns?.length ?? 0) + (input.checkClosures?.length ?? 0) > limits.maxRows
    || (input.actionRuns?.length ?? 0) > limits.maxRows || (input.catalogRaces?.length ?? 0) > limits.maxRows) {
    fail('migration_mcp_original_key_identity')
  }
  let cipher: McpCredentialCipher
  try { cipher = new McpCredentialCipher(original.key) } catch { fail('migration_mcp_original_key_invalid') }
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(input)) })
  contexts.set(context, { cipher, evidence: structuredClone(input) })
  return context
}

/** Validate original remote metadata and catalog cells without key rotation, credential upload or external dispatch.
 * @param row Source-preserving selected target row.
 * @param rows Complete selected metadata relation.
 * @param limits Explicit JSON/count/byte budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Issued protected original-key and original-input context.
 * @returns Whether this module owns the row; other retained owner groups continue to reject.
 */
export function validateLegacyMigrationRemoteMcp(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationMcpContext): boolean {
  if (!LEGACY_MIGRATION_REMOTE_MCP_TABLES.has(row.table)) return false
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) fail('migration_mcp_original_evidence_missing')
  const { cipher, evidence } = original, value = row.values
  if (evidence.checkRuns !== undefined || evidence.checkClosures !== undefined) checkInventory(rows, evidence)
  validateLegacyMigrationMcpCatalogRaces(rows, evidence.catalogRaces ?? [], limits, cut)
  const started = rows.filter(item => item.table === 'pe_mcp_actions'
    && (item.values.lease_epoch !== '0' || item.values.dispatch_id !== null || item.values.dispatch_at !== null))
  if (evidence.actionRuns !== undefined && (evidence.actionRuns.length !== started.length
    || new Set(evidence.actionRuns.map(item => `${item.userId}/${item.actionId}`)).size !== started.length
    || evidence.actionRuns.some(proof => started.filter(item => item.values.id === proof.actionId
      && item.values.user_id === proof.userId && item.sourceSha256 === proof.sourceRowSha256).length !== 1))) {
    fail('migration_mcp_action_worker_inventory')
  }
  find(rows, 'pe_users', { id: value.user_id ?? null })
  if (value.created_at !== undefined && legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) fail('migration_mcp_future')
  if (validateLegacyMigrationMcpActionOwner(row, rows, limits, cut, cipher, evidence.actionRuns)) return true
  switch (row.table) {
    case 'pe_mcp_remote_connections': {
      if (value.server_name !== `c_${(value.id ?? '').replaceAll('-', '')}`
        || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
        || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)
        || value.deleted_at !== null && (value.enabled !== 'false' || value.current_catalog_id !== null
          || legacyTimestamp(value.deleted_at ?? '') > legacyTimestamp(cut))) fail('migration_mcp_connection_invalid')
      const versions = rows.filter(item => item.table === 'pe_mcp_configuration_versions' && item.values.connection_id === value.id
        && item.values.user_id === value.user_id)
        .sort((left, right) => Number(left.values.configuration_revision) - Number(right.values.configuration_revision))
      if (versions.length !== Number(value.configuration_revision)
        || versions.some((item, index) => item.values.configuration_revision !== String(index + 1))) {
        fail('migration_mcp_configuration_chain')
      }
      if (value.current_catalog_id !== null) {
        const current = versions.at(-1)
        find(rows, 'pe_mcp_catalog_versions', { id: value.current_catalog_id ?? null, user_id: value.user_id ?? null,
          connection_id: value.id ?? null, configuration_revision: value.configuration_revision ?? null,
          credential_revision: current?.values.credential_revision ?? null })
      }
      const receipts = rows.filter(item => item.table === 'pe_mcp_management_requests' && item.values.user_id === value.user_id && item.values.result !== null)
        .map(item => ({ row: item, result: resultSchema.parse(json(item, 'result', limits)) }))
        .filter(item => item.result.kind === 'connection' && item.result.item.connectionId === value.id)
      const revisions = receipts.map(item => item.result.kind === 'connection' ? item.result.item.revision : 0).sort((a, b) => a - b)
      if (revisions.length !== Number(value.revision) || revisions.some((item, index) => item !== index + 1)) fail('migration_mcp_authority_chain')
      const latest = receipts.find(item => item.result.kind === 'connection' && item.result.item.revision === Number(value.revision))
      if (!latest || latest.result.kind !== 'connection' || latest.result.item.enabled !== (value.enabled === 'true')
        || latest.result.item.configurationRevision !== Number(value.configuration_revision)
        || (latest.result.item.deletedAt !== null) !== (value.deleted_at !== null)) fail('migration_mcp_current_authority')
      if (versions.some(version => !receipts.some(item => ['create', 'update'].includes(item.row.values.purpose ?? '')
        && item.result.kind === 'connection' && item.result.item.configurationRevision === Number(version.values.configuration_revision)))) {
        fail('migration_mcp_configuration_receipt_missing')
      }
      break
    }
    case 'pe_mcp_configuration_versions': {
      const metadata = config(row, limits), owner = find(rows, 'pe_mcp_remote_connections', { id: value.connection_id ?? null, user_id: value.user_id ?? null })
      if (metadata.serverName !== owner.values.server_name) fail('migration_mcp_configuration_owner')
      secret(cipher, row, rows, limits)
      break
    }
    case 'pe_mcp_credential_versions': {
      const version = find(rows, 'pe_mcp_configuration_versions', { connection_id: value.connection_id ?? null, user_id: value.user_id ?? null,
        configuration_revision: value.configuration_revision ?? null, credential_revision: value.credential_revision ?? null })
      secret(cipher, version, rows, limits)
      break
    }
    case 'pe_mcp_management_requests': {
      const proof = requestProof(row, rows, evidence), input = normalized(proof)
      if (cipher.fingerprint('metadata', { userId: value.user_id, purpose: proof.purpose, input, sizeBytes: proof.sizeBytes }) !== value.metadata_digest) {
        fail('migration_mcp_original_metadata_digest')
      }
      if (value.result === null) {
        const ticket = find(rows, 'pe_mcp_credential_tickets', { user_id: value.user_id ?? null, request_id: value.request_id ?? null })
        if (value.secret_digest !== null || ticket.values.consumed_at !== null || legacyTimestamp(ticket.values.expires_at ?? '') > legacyTimestamp(cut)) {
          fail('migration_mcp_request_active')
        }
        break
      }
      if (proof.purpose === 'draft' || proof.purpose === 'check') {
        const item = checkReceipt(row, rows, limits)
        if (!('sessionId' in input) || typeof input.sessionId !== 'string'
          || input.sessionId.toLowerCase() !== item.sessionId) fail('migration_mcp_check_input_identity')
        if (proof.purpose === 'check') {
          if (!('connectionId' in input) || input.connectionId.toLowerCase() !== item.connectionId
            || input.baseRevision !== item.connectionRevision || value.secret_digest !== null || proof.sizeBytes !== 0) {
            fail('migration_mcp_check_input_identity')
          }
          const version = historicalVersion(rows, value.user_id ?? '', item.connectionId, item.connectionRevision, limits)
          if (version.values.configuration_revision !== String(item.configurationRevision)
            || version.values.credential_revision !== (item.credentialRevision === null ? null : String(item.credentialRevision))) {
            fail('migration_mcp_check_input_identity')
          }
        } else {
          if (item.draftId === null || item.connectionId !== null || item.connectionRevision !== null
            || !('configuration' in input)) fail('migration_mcp_draft_input_identity')
          const draft = rows.find(record => record.table === 'pe_mcp_drafts' && record.values.id === item.draftId
            && record.values.user_id === value.user_id)
          if (!draft) fail('migration_mcp_pruned_draft_evidence_missing')
          const draftInput = mcpDraftRequest.parse(proof.input)
          const metadata = config(draft, limits)
          if (metadata.displayName !== input.configuration.displayName || metadata.serverUrl !== input.configuration.serverUrl
            || metadata.authentication !== input.configuration.authentication.kind
            || draft.values.session_id !== item.sessionId
            || draft.values.source_connection_id !== (draftInput.sourceConnectionId?.toLowerCase() ?? null)
            || draft.values.source_revision !== (draftInput.baseRevision === undefined ? null : String(draftInput.baseRevision))) {
            fail('migration_mcp_draft_input_identity')
          }
          const opened = secret(cipher, draft, rows, limits)
          if (draftInput.sourceConnectionId !== undefined && draftInput.baseRevision === undefined) fail('migration_mcp_draft_input_identity')
          retained(input, draft, opened, cipher, rows, limits, draftInput.sourceConnectionId === undefined ? undefined
            : { connectionId: draftInput.sourceConnectionId.toLowerCase(), authorityRevision: draftInput.baseRevision ?? 0 })
          if (cipher.fingerprint('supplied-credentials', supplied(input, opened)) !== value.secret_digest) {
            fail('migration_mcp_original_secret_digest')
          }
        }
        break
      }
      const receipt = connectionReceipt(row, rows, limits)
      if ('connectionId' in input && input.connectionId.toLowerCase() !== receipt.item.connectionId
        || 'baseRevision' in input && input.baseRevision + 1 !== receipt.item.revision
        || proof.purpose === 'create' && (receipt.item.revision !== 1 || receipt.item.configurationRevision !== 1)
        || proof.purpose === 'toggle' && (!('enabled' in input) || input.enabled !== receipt.item.enabled)
        || proof.purpose === 'delete' && (receipt.item.enabled || receipt.item.deletedAt === null)) fail('migration_mcp_result_request')
      if ('configuration' in input) {
        const metadata = config(receipt.version, limits)
        if (input.configuration.displayName !== metadata.displayName || input.configuration.serverUrl !== metadata.serverUrl
          || input.configuration.authentication.kind !== metadata.authentication || input.configuration.enabled !== receipt.item.enabled) {
          fail('migration_mcp_result_configuration')
        }
        const opened = secret(cipher, receipt.version, rows, limits)
        retained(input, receipt.version, opened, cipher, rows, limits, 'baseRevision' in input && typeof input.baseRevision === 'number'
          ? { connectionId: receipt.item.connectionId, authorityRevision: input.baseRevision } : undefined)
        if (cipher.fingerprint('supplied-credentials', supplied(input, opened)) !== value.secret_digest) fail('migration_mcp_original_secret_digest')
      } else if (value.secret_digest !== null || proof.sizeBytes !== 0) fail('migration_mcp_secret_category')
      break
    }
    case 'pe_mcp_credential_tickets': {
      digest.parse(value.token_digest)
      const request = find(rows, 'pe_mcp_management_requests', { user_id: value.user_id ?? null, request_id: value.request_id ?? null })
      const proof = requestProof(request, rows, evidence), input = normalized(proof)
      if (!['create', 'update', 'draft'].includes(value.purpose ?? '') || value.purpose !== proof.purpose
        || proof.sizeBytes !== Number(value.size_bytes) || proof.sizeBytes < 19
        || mcpCanonicalJson(json(row, 'input', limits)) !== mcpCanonicalJson(input)
        || legacyTimestamp(value.expires_at ?? '') < legacyTimestamp(request.values.created_at ?? '')) fail('migration_mcp_ticket_identity')
      if (value.consumed_at === null) {
        if (legacyTimestamp(value.expires_at ?? '') > legacyTimestamp(cut)) fail('migration_mcp_ticket_active')
      } else if (request.values.result === null || legacyTimestamp(value.consumed_at ?? '') < legacyTimestamp(request.values.created_at ?? '')
        || legacyTimestamp(value.consumed_at ?? '') > legacyTimestamp(value.expires_at ?? '')
        || legacyTimestamp(value.consumed_at ?? '') > legacyTimestamp(cut)) fail('migration_mcp_ticket_receipt')
      if (value.purpose === 'create' && request.values.result !== null
        && value.resource_id !== connectionReceipt(request, rows, limits).item.connectionId) fail('migration_mcp_ticket_resource')
      if (value.purpose === 'draft' && request.values.result !== null
        && value.resource_id !== checkReceipt(request, rows, limits).draftId) fail('migration_mcp_ticket_resource')
      break
    }
    case 'pe_mcp_catalog_versions': {
      const resource = mcpResourceId.parse(value.connection_id ?? value.draft_id)
      const tools = z.array(catalogTool).max(limits.maxRows).parse(json(row, 'tools', limits))
      if ((value.connection_id === null) === (value.draft_id === null)) fail('migration_mcp_catalog_resource')
      requireResourceRevision(row, rows)
      const raw = tools.map(tool => tool.raw), expected = mcpCatalogTools(resource, raw)
      if (mcpCatalogDigest(raw) !== value.catalog_digest || tools.length !== expected.length || tools.some((tool, index) => {
        const match = expected[index]
        return !match || tool.toolId !== match.toolId || tool.publicName !== match.publicName
          || tool.descriptorDigest !== match.descriptorDigest
          || mcpCanonicalJson(tool.raw) !== mcpCanonicalJson(match.raw)
      })) fail('migration_mcp_original_catalog')
      break
    }
    case 'pe_mcp_drafts': {
      const metadata = config(row, limits)
      const item = originalCheckRequest(row, rows, limits)
      find(rows, 'pe_sessions', { id: value.session_id ?? null, user_id: value.user_id ?? null })
      if (value.configuration_revision !== '1' || metadata.serverName !== `c_${(value.id ?? '').replaceAll('-', '')}`
        || (value.source_connection_id === null) !== (value.source_revision === null)
        || (value.credential_revision === null) !== (value.credential_sealed === null)
        || legacyTimestamp(value.expires_at ?? '') > legacyTimestamp(cut)
        || item.sessionId !== value.session_id || item.configurationRevision !== 1
        || (item.credentialRevision === null ? null : String(item.credentialRevision)) !== value.credential_revision) {
        fail('migration_mcp_draft_identity')
      }
      if (value.source_connection_id !== null) {
        historicalVersion(rows, value.user_id ?? '', value.source_connection_id ?? '', Number(value.source_revision), limits)
      }
      secret(cipher, row, rows, limits)
      break
    }
    case 'pe_mcp_checks': {
      originalCheckRequest(row, rows, limits)
      find(rows, 'pe_sessions', { id: value.session_id ?? null, user_id: value.user_id ?? null })
      if ((value.connection_id === null) !== (value.connection_revision === null)
        || (value.connection_id === null) === (value.draft_id === null)) fail('migration_mcp_check_resource')
      if (value.lease_epoch !== '0') completedCheck(row, rows, evidence, limits, cut)
      else if (value.lease_owner !== null || value.lease_until !== null || value.catalog_id !== null || value.discovered_tools !== null
        || !['cancelled', 'expired'].includes(value.state ?? '')
        || value.state === 'cancelled' && (value.cancel_requested !== 'true' || value.error_code !== null)
        || value.state === 'expired' && (value.error_code !== 'mcp_check_expired' || legacyTimestamp(value.expires_at ?? '') > legacyTimestamp(cut))
        || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)
        || legacyTimestamp(value.updated_at ?? '') < legacyTimestamp(value.created_at ?? '')
        || (evidence.checkRuns ?? []).some(proof => proof.checkId === value.id)) fail('migration_mcp_check_no_start_invalid')
      requireResourceRevision(row, rows)
      break
    }
    default: fail('migration_mcp_metadata_dispatch')
  }
  return true
}
