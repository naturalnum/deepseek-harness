/** Original SSH credentials and historical management receipts retain explicit format, AAD and replay identities. */
import { z } from 'zod'
import { sshCreateTicketRequest, sshSelection } from '../contracts.ts'
import { sshCredentialTicketRequest, sshConnectionUpdateRequest, sshConnectionToggleRequest, sshConnectionDeleteRequest,
  sshConfigurationInput, sshConnectionValue, type SshConfigurationInput, type SshCredentialUpload } from '../ssh-management-contracts.ts'
import { SshCredentialCipher, sshCanonicalJson, sshNeedsUpload, sshChangesCredential, mergeSshCredential,
  type SshCredential } from './ssh-credentials.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { SshActionCipher } from './ssh-execute.ts'
import { LEGACY_MIGRATION_SSH_ACTION_TABLES, validateLegacyMigrationSshAction } from './legacy-migration-v2-ssh-actions.ts'

/** Metadata owners; call/execute workers and their original transport/process closure are separate retained owners. */
export const LEGACY_MIGRATION_SSH_TABLES: ReadonlySet<string> = new Set(['pe_ssh_connections', 'pe_ssh_upload_intents',
  'pe_ssh_updates', 'pe_ssh_credential_versions', 'pe_ssh_configuration_versions', 'pe_ssh_management_requests'])
/** Protected source key includes independently captured code and deployment key identities. */
export const legacyMigrationSshKey = z.object({ format: z.literal('power-evolve-legacy-ssh-key'), version: z.literal(1),
  keyId: z.string().min(1).max(200), sourceCodeId: z.string().min(1).max(200), key: z.string().min(1).max(100) }).strict()
/** Process-issued cipher context; only public key/code identities enter the signed inventory digest. */
export interface LegacyMigrationSshContext { readonly evidenceSha256: string }
const contexts = new WeakMap<LegacyMigrationSshContext, { credential: SshCredentialCipher; action: SshActionCipher }>()
const oldToggle = sshConnectionToggleRequest.omit({ requestId: true })
const metadataColumns = ['display_name', 'host', 'port', 'username', 'host_key_sha256', 'working_directory'] as const
const metadataFields = [['display_name', 'displayName'], ['host', 'host'], ['port', 'port'], ['username', 'username'],
  ['host_key_sha256', 'hostKeySha256'], ['working_directory', 'workingDirectory']] as const
function fail(code: string): never { throw new LegacyImportError(code) }
function find(rows: readonly LegacyPlannedRow[], table: string, fields: Readonly<Record<string, string | null>>): LegacyPlannedRow {
  const found = rows.find(row => row.table === table && Object.entries(fields).every(([key, value]) => row.values[key] === value))
  if (!found) fail('migration_ssh_original_reference_missing')
  return found
}
function json(row: LegacyPlannedRow, column: string, limits: LegacyImportLimits) {
  return legacyJson(row.values[column] ?? '', limits)
}
function millis(time: string): bigint { return legacyTimestamp(time) / 1000n * 1000n }
function originalInput(row: LegacyPlannedRow, limits: LegacyImportLimits) {
  const input = json(row, 'input', limits), purpose = row.values.purpose, format = row.values.request_format_version
  if (format === '1') {
    if (purpose === 'toggle') return oldToggle.parse(input)
    if (purpose !== 'create') fail('migration_ssh_original_request_format')
    return sshCreateTicketRequest.parse(input)
  }
  if (format !== '2') fail('migration_ssh_original_request_format')
  if (purpose === 'create' || purpose === 'update' && row.values.size_bytes !== null) return sshCredentialTicketRequest.parse(input)
  if (purpose === 'update') return sshConnectionUpdateRequest.parse(input)
  if (purpose === 'toggle') return sshConnectionToggleRequest.parse(input)
  if (purpose === 'delete') return sshConnectionDeleteRequest.parse(input)
  return fail('migration_ssh_original_request_format')
}
function configuration(row: LegacyPlannedRow, limits: LegacyImportLimits): SshConfigurationInput | undefined {
  const input = originalInput(row, limits)
  if ('configuration' in input) return input.configuration
  if (!('credentialKind' in input)) return undefined
  return { displayName: input.displayName, host: input.host, port: input.port, username: input.username,
    hostKeySha256: input.hostKeySha256, workingDirectory: null, authentication: { kind: 'password', password: 'replace' },
    enabled: input.enabled }
}
function receipt(row: LegacyPlannedRow, limits: LegacyImportLimits) {
  if (row.values.result === null) fail('migration_ssh_original_receipt_missing')
  return sshConnectionValue.parse(json(row, 'result', limits))
}
function originalVersionReceipt(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits) {
  const matches = rows.filter(item => item.table === 'pe_ssh_management_requests' && item.values.user_id === row.values.user_id
    && item.values.connection_id === row.values.connection_id && item.values.result !== null)
    .filter(item => String(receipt(item, limits).revision) === row.values.revision)
  if (matches.length !== 1 || !matches[0]) fail('migration_ssh_original_version_receipt')
  return matches[0]
}
function version(rows: readonly LegacyPlannedRow[], owner: string, connection: string, revision: string) {
  return find(rows, 'pe_ssh_configuration_versions', { user_id: owner, connection_id: connection, revision })
}
function credential(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits, cipher: SshCredentialCipher) {
  const value = row.values
  const firstVersion = rows.filter(item => item.table === 'pe_ssh_configuration_versions' && item.values.user_id === value.user_id
    && item.values.connection_id === value.connection_id && item.values.credential_revision === value.credential_revision)
    .sort((left, right) => Number(left.values.revision) - Number(right.values.revision))[0]
  if (!firstVersion) fail('migration_ssh_original_credential_closure')
  const request = originalVersionReceipt(firstVersion, rows, limits), input = originalInput(request, limits)
  if (request.values.request_format_version !== value.format_version || !['password', 'private_key'].includes(value.credential_kind ?? '')
    || !/^\\x(?:[a-f0-9]{2}){29,}$/u.test(value.encrypted_credential ?? '')) fail('migration_ssh_original_credential_identity')
  const formatVersion = value.format_version === '1' ? 1 : 2
  const originalRequestId = 'requestId' in input ? input.requestId : undefined
  if (formatVersion === 1 && (originalRequestId?.toLowerCase() !== value.aad_request_id || value.credential_kind !== 'password'
    || value.passphrase_configured !== 'false') || formatVersion === 2 && value.aad_request_id !== null) {
    fail('migration_ssh_original_credential_identity')
  }
  let opened: SshCredential
  try {
    opened = cipher.open({ userId: value.user_id ?? '', connectionId: request.values.purpose === 'create'
      ? originalRequestId ?? '' : value.connection_id ?? '', credentialRevision: Number(value.credential_revision),
    credentialKind: value.credential_kind === 'password' ? 'password' : 'private_key', formatVersion,
    aadRequestId: formatVersion === 1 ? originalRequestId ?? null : null },
    Buffer.from((value.encrypted_credential ?? '').slice(2), 'hex'))
  } catch { fail('migration_ssh_original_credential_unavailable') }
  if ((opened.kind === 'private_key' && opened.passphrase !== undefined) !== (value.passphrase_configured === 'true')) {
    fail('migration_ssh_original_secret_metadata')
  }
  return opened
}
function secretForVersion(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits,
  cipher: SshCredentialCipher) {
  return credential(find(rows, 'pe_ssh_credential_versions', { user_id: row.values.user_id ?? null,
    connection_id: row.values.connection_id ?? null, credential_revision: row.values.credential_revision ?? null }), rows, limits, cipher)
}
function replacements(config: SshConfigurationInput, opened: SshCredential): SshCredentialUpload {
  const plan = config.authentication
  if (plan.kind !== opened.kind) fail('migration_ssh_original_secret_metadata')
  if (plan.kind === 'password' && opened.kind === 'password') return { formatVersion: 2,
    ...(plan.password === 'replace' ? { password: opened.password } : {}) }
  if (plan.kind !== 'private_key' || opened.kind !== 'private_key') fail('migration_ssh_original_secret_metadata')
  if (plan.passphrase === 'replace' && opened.passphrase === undefined) fail('migration_ssh_original_supplied_missing')
  return { formatVersion: 2, ...(plan.privateKey === 'replace' ? { privateKey: opened.privateKey } : {}),
    ...(plan.passphrase === 'replace' ? { passphrase: opened.passphrase } : {}) }
}
function request(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits, cipher: SshCredentialCipher) {
  const value = row.values, input = originalInput(row, limits), config = configuration(row, limits)
  if ('requestId' in input && input.requestId.toLowerCase() !== value.request_id
    || 'purpose' in input && input.purpose !== value.purpose
    || config && config.host !== config.host.toLowerCase()
    || 'connectionId' in input && (input.connectionId.toLowerCase() !== value.connection_id || String(input.baseRevision) !== value.base_revision)
    || ('sizeBytes' in input ? String(input.sizeBytes) : null) !== value.size_bytes) fail('migration_ssh_original_input_identity')
  const original = value.request_format_version === '1' ? JSON.stringify(input)
    : sshCanonicalJson({ formatVersion: 2, purpose: value.purpose, userId: value.user_id, input })
  if (legacyDigest(original) !== value.request_digest) fail('migration_ssh_original_request_digest')
  const prior = value.purpose === 'create' ? undefined
    : version(rows, value.user_id ?? '', value.connection_id ?? '', value.base_revision ?? '')
  if (value.purpose === 'create' ? value.base_revision !== null || value.base_credential_revision !== null
    : prior?.values.credential_revision !== value.base_credential_revision) fail('migration_ssh_original_base_version')
  if (value.result === null) {
    if (value.completed_at !== null || value.secret_digest !== null || !config || !sshNeedsUpload(config.authentication)) {
      fail('migration_ssh_original_pending_request')
    }
    return
  }
  const result = receipt(row, limits), current = find(rows, 'pe_ssh_connections', { id: value.connection_id ?? null, user_id: value.user_id ?? null })
  const target = version(rows, value.user_id ?? '', result.connectionId, String(result.revision))
  const key = find(rows, 'pe_ssh_credential_versions', { user_id: value.user_id ?? null, connection_id: result.connectionId,
    credential_revision: String(result.credentialRevision) })
  if (result.connectionId !== value.connection_id || result.revision !== (prior ? Number(prior.values.revision) + 1 : 1)
    || result.revision > Number(current.values.revision) || result.credentialRevision !== Number(target.values.credential_revision)
    || result.authentication !== key.values.credential_kind || result.passphraseConfigured !== (key.values.passphrase_configured === 'true')
    || !result.secretConfigured || legacyTimestamp(result.createdAt) !== millis(current.values.created_at ?? '')
    || legacyTimestamp(result.updatedAt) !== millis(value.completed_at ?? '')
    || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.completed_at ?? '')
    || metadataFields.some(([column, key]) => String(result[key]) !== String(target.values[column]))) {
    fail('migration_ssh_original_result_identity')
  }
  const changes = config ? sshChangesCredential(config.authentication) : false
  if (result.credentialRevision !== (prior ? Number(prior.values.credential_revision) + (changes ? 1 : 0) : 1)) {
    fail('migration_ssh_original_credential_revision')
  }
  if (config) {
    sshConfigurationInput.parse(config)
    if (metadataFields.some(([column, key]) => String(config[key]) !== String(target.values[column]))
      || result.enabled !== config.enabled || result.deletedAt !== null) fail('migration_ssh_original_configuration')
    const opened = secretForVersion(target, rows, limits, cipher)
    const supplied = replacements(config, opened)
    const previous = prior ? secretForVersion(prior, rows, limits, cipher) : undefined
    if (sshCanonicalJson(mergeSshCredential(config.authentication, supplied, previous)) !== sshCanonicalJson(opened)) {
      fail('migration_ssh_original_retained_secret_changed')
    }
    if (value.size_bytes !== null) {
      const digest = value.request_format_version === '1' && opened.kind === 'password'
        ? cipher.legacyFingerprint(Buffer.from(opened.password, 'utf8')) : cipher.fingerprint('upload', { requestDigest: value.request_digest, upload: supplied })
      if (digest !== value.secret_digest || value.request_format_version === '1' && opened.kind === 'password'
        && String(Buffer.byteLength(opened.password, 'utf8')) !== value.size_bytes) fail('migration_ssh_original_secret_digest')
    } else if (value.secret_digest !== null || sshNeedsUpload(config.authentication)) fail('migration_ssh_original_secret_digest')
  } else {
    if (!prior || metadataColumns.some(column => target.values[column] !== prior.values[column])
      || result.enabled !== (value.purpose === 'delete' ? false : 'enabled' in input && input.enabled)
      || (result.deletedAt !== null) !== (value.purpose === 'delete') || result.deletedAt !== null
        && legacyTimestamp(result.deletedAt) !== millis(value.completed_at ?? '') || value.secret_digest !== null) {
      fail('migration_ssh_original_mutation_identity')
    }
  }
}

/** Bind the original source key without exposing secret bytes in signed inventory or plans.
 * @param key Protected original key declaration.
 * @param sourceCodeId Independently captured source code identity.
 * @returns Process-issued original cipher context with public identity digest.
 */
export function createLegacyMigrationSshContext(key: unknown, sourceCodeId: string): LegacyMigrationSshContext {
  const input = legacyMigrationSshKey.parse(key)
  if (input.sourceCodeId !== sourceCodeId) fail('migration_ssh_original_key_identity')
  let cipher: SshCredentialCipher
  try { cipher = new SshCredentialCipher(input.key) } catch { fail('migration_ssh_original_key_invalid') }
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify({ format: input.format, version: input.version,
    keyId: input.keyId, sourceCodeId: input.sourceCodeId })) })
  contexts.set(context, { credential: cipher, action: new SshActionCipher(input.key) })
  return context
}

/** Validate original accepted SSH metadata against its immutable historical version, preserving disabled/deleted authority.
 * @param row Original accepted Operation row.
 * @param rows Complete retained original relation.
 * @param limits Explicit JSON budgets.
 * @returns Nothing after every original selected target matches its original immutable metadata.
 */
export function validateLegacyMigrationSshOperation(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits): void {
  const selected = z.array(sshSelection).parse(json(row, 'ssh_selection', limits))
  const session = find(rows, 'pe_sessions', { id: row.values.session_id ?? null })
  for (const item of selected) {
    const original = version(rows, session.values.user_id ?? '', item.connectionId, String(item.revision))
    if (original.values.credential_revision !== String(item.credentialRevision)
      || ([['display_name', 'displayName'], ['host', 'host'], ['port', 'port'], ['username', 'username']] as const)
        .some(([column, key]) => String(item[key]) !== original.values[column])) {
      fail('migration_ssh_original_selection_identity')
    }
  }
}

/** Validate original encrypted management metadata without replaying mutations or acquiring remote execution authority.
 * @param row Original selected owner row.
 * @param rows Complete retained relation.
 * @param limits Explicit source and JSON budgets.
 * @param cut Independently authenticated stopped-source timestamp.
 * @param context Protected process-issued original key context bound into the signed inventory.
 * @returns Whether this module owns the table; call and execute owners remain separate.
 */
export function validateLegacyMigrationSsh(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits,
  cut: string, context?: LegacyMigrationSshContext): boolean {
  if (!LEGACY_MIGRATION_SSH_TABLES.has(row.table) && !LEGACY_MIGRATION_SSH_ACTION_TABLES.has(row.table)) return false
  const originalContext = context && contexts.get(context)
  if (!originalContext) fail('migration_ssh_original_evidence_missing')
  const cipher = originalContext.credential
  const value = row.values
  find(rows, 'pe_users', { id: value.user_id ?? null })
  for (const column of ['created_at', 'updated_at', 'completed_at', 'consumed_at', 'deleted_at']) {
    if (value[column] !== undefined && value[column] !== null && legacyTimestamp(value[column]) > legacyTimestamp(cut)) {
      fail('migration_ssh_original_future')
    }
  }
  if (validateLegacyMigrationSshAction(row, rows, limits, cut, originalContext.action)) return true
  if (row.table === 'pe_ssh_management_requests') request(row, rows, limits, cipher)
  if (row.table === 'pe_ssh_credential_versions') credential(row, rows, limits, cipher)
  if (row.table === 'pe_ssh_configuration_versions') originalVersionReceipt(row, rows, limits)
  if (row.table === 'pe_ssh_connections') {
    const original = version(rows, value.user_id ?? '', value.id ?? '', value.revision ?? '')
    const key = find(rows, 'pe_ssh_credential_versions', { user_id: value.user_id ?? null, connection_id: value.id ?? null,
      credential_revision: value.credential_revision ?? null })
    const install = find(rows, 'pe_ssh_management_requests', { user_id: value.user_id ?? null,
      request_id: value.install_request_id ?? null,
      purpose: 'create', connection_id: value.id ?? null })
    const current = receipt(originalVersionReceipt(original, rows, limits), limits)
    const versions = rows.filter(item => item.table === 'pe_ssh_configuration_versions' && item.values.user_id === value.user_id
      && item.values.connection_id === value.id).sort((left, right) => Number(left.values.revision) - Number(right.values.revision))
    const keys = rows.filter(item => item.table === 'pe_ssh_credential_versions' && item.values.user_id === value.user_id
      && item.values.connection_id === value.id)
      .sort((left, right) => Number(left.values.credential_revision) - Number(right.values.credential_revision))
    if (metadataColumns.filter(column => column !== 'working_directory').some(column => value[column] !== original.values[column])
      || value.credential_revision !== original.values.credential_revision || value.credential_kind !== key.values.credential_kind
      || value.encrypted_credential !== key.values.encrypted_credential || value.install_digest !== install.values.request_digest
      || current.enabled !== (value.enabled === 'true') || (value.deleted_at === null) !== (current.deletedAt === null)
      || current.deletedAt !== null && legacyTimestamp(current.deletedAt) !== millis(value.deleted_at ?? '')
      || legacyTimestamp(current.updatedAt) !== millis(value.updated_at ?? '')
      || versions.length !== Number(value.revision) || versions.some((item, index) => item.values.revision !== String(index + 1))
      || keys.length !== Number(value.credential_revision)
      || keys.some((item, index) => item.values.credential_revision !== String(index + 1))) {
      fail('migration_ssh_original_current_pointer')
    }
  }
  if (row.table === 'pe_ssh_upload_intents') {
    const original = find(rows, 'pe_ssh_management_requests', { user_id: value.user_id ?? null, request_id: value.request_id ?? null })
    if (value.request_digest !== original.values.request_digest || value.format_version !== original.values.request_format_version
      || value.purpose !== original.values.purpose || value.size_bytes !== original.values.size_bytes
      || sshCanonicalJson(json(row, 'config', limits)) !== sshCanonicalJson(json(original, 'input', limits))
      || legacyTimestamp(value.expires_at ?? '') > legacyTimestamp(cut)) fail('migration_ssh_original_ticket_identity')
    if (value.consumed_at === null) {
      if (value.result !== null || value.secret_digest !== null || value.verification_failures !== '0' || original.values.result !== null) {
        fail('migration_ssh_original_ticket_result')
      }
    } else {
      const result = z.object({ item: z.json(), failedVerifications: z.number().int().nonnegative() }).strict().parse(json(row, 'result', limits))
      const item = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(),
        credentialRevision: z.number().int().positive(),
        displayName: z.string(), host: z.string(), port: z.number().int(), username: z.string(),
        hostKeySha256: z.string(), enabled: z.boolean() })
        .loose().parse(result.item)
      const recorded = receipt(original, limits)
      const recordedEntries = new Map<string, unknown>(Object.entries(recorded))
      if (Object.entries(item).some(([key, entry]) => sshCanonicalJson(entry) !== sshCanonicalJson(recordedEntries.get(key)))
        || value.secret_digest !== original.values.secret_digest || result.failedVerifications !== Number(value.verification_failures)
        || value.consumed_at !== original.values.completed_at) fail('migration_ssh_original_ticket_result')
    }
  }
  if (row.table === 'pe_ssh_updates') {
    const original = find(rows, 'pe_ssh_management_requests', { user_id: value.user_id ?? null, request_id: value.request_id ?? null,
      purpose: 'toggle', request_format_version: '1', connection_id: value.connection_id ?? null })
    const result = receipt(original, limits), old = z.object({ connectionId: z.uuid(), displayName: z.string(), host: z.string(),
      port: z.number().int(), username: z.string(), hostKeySha256: z.string(), enabled: z.boolean(), revision: z.number().int(),
      credentialRevision: z.number().int() }).strict().parse(json(row, 'result', limits))
    const resultEntries = new Map<string, unknown>(Object.entries(result))
    if (Object.entries(old).some(([key, entry]) => entry !== resultEntries.get(key))
      || value.request_digest !== original.values.request_digest
      || value.created_at !== original.values.completed_at) fail('migration_ssh_original_legacy_update')
  }
  return true
}
