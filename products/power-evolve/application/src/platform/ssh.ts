/** Owner-scoped SSH management; secrets arrive directly at Platform and versions remain immutable. */
import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { sshCreateTicketRequest, userId, PlatformError, type Identity } from '../contracts.ts'
import { sshConfigurationInput, sshConnectionUpdateRequest, sshConnectionToggleRequest,
  sshConnectionDeleteRequest, sshCredentialTicketRequest, sshConnectionValue, sshManagementRequestId,
  SSH_CREDENTIAL_UPLOAD_MAX_BYTES, type SshConnection, type SshConfigurationInput,
  type SshCredentialTicketRequest, type SshCredentialUpload, type sshCredentialTicketValue } from '../ssh-management-contracts.ts'
import { transaction } from './database.ts'
import { SshCredentialCipher, sshCanonicalJson, sshNeedsUpload, sshChangesCredential,
  sshUploadForPlan, mergeSshCredential, type SshCredential } from './ssh-credentials.ts'

type Owner = Pick<Identity, 'userId'>
type LegacyCreate = z.infer<typeof sshCreateTicketRequest>
type Purpose = 'create' | 'update' | 'toggle' | 'delete'
type Connection = { id: string; user_id: string; revision: number; credential_revision: number;
  display_name: string; host: string; port: number; username: string; host_key_sha256: string;
  working_directory: string | null; credential_kind: SshCredential['kind']; format_version: 1 | 2;
  aad_request_id: string | null; encrypted_credential: Buffer; passphrase_configured: boolean;
  enabled: boolean; deleted_at: Date | null; created_at: Date; updated_at: Date }
type RequestRow = { user_id: string; request_id: string; purpose: Purpose; request_format_version: 1 | 2;
  request_digest: string; input: unknown; connection_id: string | null; base_revision: number | null;
  base_credential_revision: number | null; size_bytes: number | null; secret_digest: string | null;
  result: unknown; completed_at: Date | null }
type Intent = { request_id: string; user_id: string; request_digest: string; config: unknown;
  size_bytes: number; token_digest: string; expires_at: Date; consumed_at: Date | null;
  format_version: 1 | 2; purpose: 'create' | 'update'; verification_failures: number }
type Spec = { requestId: string; purpose: Purpose; formatVersion: 1 | 2; digest: string; input: unknown;
  connectionId?: string; baseRevision?: number; sizeBytes?: number; configuration?: SshConfigurationInput }
type LegacyConnection = Pick<SshConnection, 'connectionId' | 'displayName' | 'host' | 'port' | 'username'
  | 'hostKeySha256' | 'enabled' | 'revision' | 'credentialRevision'>
type Metadata = Pick<SshConnection, 'host' | 'port' | 'username' | 'hostKeySha256'
  | 'credentialRevision' | 'workingDirectory'>
type VersionMetadata = Metadata & Pick<SshConnection, 'displayName' | 'revision' | 'authentication' | 'passphraseConfigured'>
type LegacyTicket = Omit<z.infer<typeof sshCredentialTicketValue>, 'requestId'>
type ManagedTicket = LegacyTicket & Pick<Spec, 'requestId'>

/** Existing deployment defaults remain compatible; callers may explicitly configure these budgets. */
export interface SshManagementOptions {
  readonly maxConnections?: number
  readonly maxPendingTickets?: number
  readonly ticketLifetimeMs?: number
  readonly maxCompletedMismatches?: number
}
const defaults = { maxConnections: 8, maxPendingTickets: 8, ticketLifetimeMs: 5 * 60_000, maxCompletedMismatches: 3 }
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')
const connectionSql = `SELECT c.id,c.user_id,c.revision,c.credential_revision,c.enabled,c.deleted_at,
  c.created_at,c.updated_at,v.display_name,v.host,v.port,v.username,v.host_key_sha256,v.working_directory,
  k.credential_kind,k.format_version,k.aad_request_id,k.encrypted_credential,k.passphrase_configured
  FROM pe_ssh_connections c JOIN pe_ssh_configuration_versions v
    ON v.connection_id=c.id AND v.user_id=c.user_id AND v.revision=c.revision
    AND v.credential_revision=c.credential_revision
  JOIN pe_ssh_credential_versions k ON k.connection_id=c.id AND k.user_id=c.user_id
    AND k.credential_revision=v.credential_revision`

function validHost(host: string): boolean {
  if (isIP(host) === 4) return true
  if (isIP(host) !== 0 || host.length > 253 || !host.includes('.')) return false
  return host.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(part))
}
function parseAllowlist(raw: string): ReadonlySet<string> {
  if (!raw.trim()) return new Set()
  const entries = raw.split(',').map(value => value.trim().toLowerCase())
  if (entries.length > 32 || entries.some(value => {
    const match = /^([^:]+):(\d{1,5})$/u.exec(value)
    return !match || !validHost(match[1]!) || Number(match[2]) < 1 || Number(match[2]) > 65_535
  })) throw new Error('Invalid SSH destination allowlist')
  return new Set(entries)
}
/** Only metadata is projected through the historical Host methods. */
function legacy(item: SshConnection): LegacyConnection {
  return { connectionId: item.connectionId, displayName: item.displayName, host: item.host,
    port: item.port, username: item.username, hostKeySha256: item.hostKeySha256,
    enabled: item.enabled, revision: item.revision, credentialRevision: item.credentialRevision }
}

/** The optional backend key and operator allowlist are configured together; neither reaches Host. */
export class SshConnectionService {
  private readonly cipher: SshCredentialCipher | null
  private readonly allowed: ReadonlySet<string>
  private readonly options: Required<SshManagementOptions>
  /**
   * Configure owner-scoped SSH management and direct credential intake.
   * @param pool Trusted Platform database pool.
   * @param keyText Backend credential key; blank with a blank allowlist disables intake and execution.
   * @param allowlist Comma-separated operator-approved host and port pairs.
   * @param options Optional connection, pending-ticket, lifetime and completed-mismatch budgets.
   */
  constructor(private readonly pool: Pool, keyText: string, allowlist: string, options: SshManagementOptions = {}) {
    this.allowed = parseAllowlist(allowlist)
    this.options = { ...defaults, ...options }
    if (Object.values(this.options).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Invalid SSH management options')
    }
    const encoded = keyText.trim()
    if (!encoded && this.allowed.size === 0) { this.cipher = null; return }
    if (!encoded || this.allowed.size === 0) throw new Error('SSH credential key and destination allowlist must both be configured')
    this.cipher = new SshCredentialCipher(encoded)
  }
  /** Whether the backend key and operator allowlist are configured for intake and execution. */
  get available(): boolean { return this.cipher !== null }
  private requireAvailable(): SshCredentialCipher {
    if (!this.cipher) throw new PlatformError(503, 'ssh_unavailable')
    return this.cipher
  }
  private checkDestination(host: string, port: number): void {
    if (!validHost(host) || !this.allowed.has(`${host}:${port}`)) throw new PlatformError(403, 'ssh_destination_denied')
  }
  private configuration(input: SshConfigurationInput): SshConfigurationInput {
    const parsed = sshConfigurationInput.parse(input)
    return { ...parsed, host: parsed.host.toLowerCase() }
  }
  private present(row: Connection): SshConnection {
    return sshConnectionValue.parse({ connectionId: row.id, revision: row.revision,
      credentialRevision: row.credential_revision, displayName: row.display_name, host: row.host,
      port: row.port, username: row.username, hostKeySha256: row.host_key_sha256,
      workingDirectory: row.working_directory, authentication: row.credential_kind,
      secretConfigured: true, passphraseConfigured: row.passphrase_configured,
      enabled: row.enabled, deletedAt: row.deleted_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() })
  }
  private result(row: RequestRow): SshConnection | null {
    if (row.result === null) return null
    const parsed = sshConnectionValue.safeParse(row.result)
    if (!parsed.success) throw new PlatformError(503, 'ssh_management_unavailable')
    return parsed.data
  }
  private async owner(client: PoolClient, user: Owner): Promise<void> {
    if (!(await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])).rowCount) {
      throw new PlatformError(401, 'unauthorized')
    }
  }
  private async owned(client: PoolClient, user: Owner, id: string, revision?: number): Promise<Connection> {
    const found = await client.query<Connection>(`${connectionSql}
      WHERE c.id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL FOR UPDATE OF c`, [id, user.userId])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'ssh_connection_not_found')
    if (revision !== undefined && row.revision !== revision) throw new PlatformError(409, 'revision_conflict')
    return row
  }
  private assertRetention(plan: SshConfigurationInput['authentication'], source?: Connection): void {
    if (plan.kind === 'password' && plan.password === 'retain' && source?.credential_kind !== 'password'
      || plan.kind === 'private_key' && (plan.privateKey === 'retain' || plan.passphrase === 'retain')
        && source?.credential_kind !== 'private_key') throw new PlatformError(409, 'ssh_credential_retention_invalid')
  }
  private decode(row: Connection): SshCredential {
    return this.requireAvailable().open({ userId: row.user_id, connectionId: row.id,
      credentialRevision: row.credential_revision, credentialKind: row.credential_kind,
      formatVersion: row.format_version, aadRequestId: row.aad_request_id }, row.encrypted_credential)
  }
  private metadata(row: Connection): Metadata {
    return { host: row.host, port: row.port, username: row.username, hostKeySha256: row.host_key_sha256,
      credentialRevision: row.credential_revision, workingDirectory: row.working_directory }
  }
  /**
   * List the owner's current non-deleted connections without credential values.
   * @param user Verified owner whose connections are visible.
   * @returns Backend availability and full public records for the owner's live connections.
   */
  async listManaged(user: Owner): Promise<{ available: boolean; items: SshConnection[] }> {
    const rows = await this.pool.query<Connection>(`${connectionSql}
      WHERE c.user_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC,c.id`, [user.userId])
    return { available: this.available, items: rows.rows.map(row => this.present(row)) }
  }
  /**
   * List current connections through the historical Host metadata projection.
   * @param user Verified owner whose connections are visible.
   * @returns Backend availability and connection records with the original nine public fields.
   */
  async list(user: Identity): Promise<{ available: boolean; items: LegacyConnection[] }> {
    const found = await this.listManaged(user)
    return { available: found.available, items: found.items.map(legacy) }
  }
  /**
   * Read owned immutable configuration metadata after disablement or deletion without decrypting.
   * @param user Verified owner of the connection.
   * @param id Stable connection identity.
   * @param revision Immutable configuration revision to read.
   * @returns Historical target metadata, authentication kind and passphrase-presence flag.
   */
  async metadataForVersion(user: Owner, id: string, revision: number): Promise<VersionMetadata> {
    const found = await this.pool.query<Connection>(`SELECT c.id,c.user_id,c.enabled,c.deleted_at,c.created_at,c.updated_at,
      v.revision,v.credential_revision,v.display_name,v.host,v.port,v.username,v.host_key_sha256,v.working_directory,
      k.credential_kind,k.passphrase_configured FROM pe_ssh_connections c
      JOIN pe_ssh_configuration_versions v ON v.connection_id=c.id AND v.user_id=c.user_id
      JOIN pe_ssh_credential_versions k ON k.connection_id=v.connection_id AND k.user_id=v.user_id
        AND k.credential_revision=v.credential_revision WHERE c.id=$1 AND c.user_id=$2 AND v.revision=$3`,
    [id, user.userId, revision])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'ssh_connection_not_found')
    return { ...this.metadata(row), displayName: row.display_name, revision: row.revision,
      authentication: row.credential_kind, passphraseConfigured: row.passphrase_configured }
  }
  /**
   * Read current metadata only for an enabled, live and operator-allowed call target.
   * @param user Verified owner of the connection.
   * @param id Stable connection identity.
   * @param revision Expected current configuration revision.
   * @returns Call target metadata and credential revision without decrypting credential values.
   */
  async metadataForCall(user: Owner, id: string, revision: number): Promise<Metadata> {
    this.requireAvailable()
    const found = await this.pool.query<Connection>(`${connectionSql}
      WHERE c.id=$1 AND c.user_id=$2 AND c.revision=$3 AND c.enabled=true AND c.deleted_at IS NULL`,
    [id, user.userId, revision])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'ssh_connection_not_found')
    this.checkDestination(row.host, row.port)
    return this.metadata(row)
  }
  /**
   * Read Platform-only secret material; the caller must still atomically commit a dispatch permit.
   * @param user Verified owner of the connection.
   * @param id Stable identity of an enabled, live and operator-allowed connection.
   * @param revision Expected current configuration revision.
   * @returns Current target metadata and the decrypted password or private-key credential.
   */
  async credentialForCall(user: Owner, id: string, revision: number): Promise<Metadata & { credential: SshCredential }> {
    this.requireAvailable()
    const found = await this.pool.query<Connection>(`${connectionSql}
      WHERE c.id=$1 AND c.user_id=$2 AND c.revision=$3 AND c.enabled=true AND c.deleted_at IS NULL`,
    [id, user.userId, revision])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'ssh_connection_not_found')
    this.checkDestination(row.host, row.port)
    return { ...this.metadata(row), credential: this.decode(row) }
  }
  /**
   * Read an owner's original durable public mutation receipt after a lost response.
   * @param user Verified owner whose request ledger is queried.
   * @param requestId Stable management request identity.
   * @returns Original completed public record, or null when no completed owned receipt exists.
   */
  async receipt(user: Owner, requestId: string): Promise<{ item: SshConnection | null }> {
    const row = (await this.pool.query<RequestRow>(`SELECT * FROM pe_ssh_management_requests
      WHERE user_id=$1 AND request_id=$2`, [user.userId, sshManagementRequestId.parse(requestId)])).rows[0]
    return { item: row ? this.result(row) : null }
  }
  private managedSpec(user: Owner, purpose: Purpose, input: unknown, details: {
    requestId: string; connectionId?: string; baseRevision?: number; sizeBytes?: number;
    configuration?: SshConfigurationInput }): Spec {
    return { purpose, formatVersion: 2, input, ...details,
      digest: hash(sshCanonicalJson({ formatVersion: 2, purpose, userId: user.userId, input })) }
  }
  /** Reserve one purpose across endpoints before taking an intent or explicit connection lock. */
  private async reserve(client: PoolClient, user: Owner, spec: Spec): Promise<RequestRow> {
    const found = await client.query<RequestRow>(`SELECT * FROM pe_ssh_management_requests
      WHERE user_id=$1 AND request_id=$2 FOR UPDATE`, [user.userId, spec.requestId])
    if (found.rows[0]) {
      const row = found.rows[0]
      if (row.purpose !== spec.purpose || row.request_format_version !== spec.formatVersion
        || row.request_digest !== spec.digest || row.size_bytes !== (spec.sizeBytes ?? null)) {
        throw new PlatformError(409, 'request_id_conflict')
      }
      return row
    }
    let credentialRevision: number | null = null
    if (spec.connectionId !== undefined) {
      // Management writers serialize on the owner; the connection lock follows request/intent.
      const source = await client.query<{ credential_revision: number }>(`SELECT credential_revision
        FROM pe_ssh_connections WHERE id=$1 AND user_id=$2 AND revision=$3 AND deleted_at IS NULL`,
      [spec.connectionId, user.userId, spec.baseRevision])
      if (!source.rows[0]) {
        const exists = await client.query('SELECT id FROM pe_ssh_connections WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [spec.connectionId, user.userId])
        throw new PlatformError(exists.rowCount ? 409 : 404, exists.rowCount ? 'revision_conflict' : 'ssh_connection_not_found')
      }
      credentialRevision = source.rows[0].credential_revision
    }
    return (await client.query<RequestRow>(`INSERT INTO pe_ssh_management_requests(user_id,request_id,purpose,
      request_format_version,request_digest,input,connection_id,base_revision,base_credential_revision,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [user.userId, spec.requestId, spec.purpose, spec.formatVersion, spec.digest, spec.input,
      spec.connectionId ?? null, spec.baseRevision ?? null, credentialRevision, spec.sizeBytes ?? null])).rows[0]!
  }
  private async capacity(client: PoolClient, user: Owner): Promise<void> {
    const count = await client.query<{ n: string }>(`SELECT count(*) AS n FROM pe_ssh_connections
      WHERE user_id=$1 AND deleted_at IS NULL`, [user.userId])
    if (Number(count.rows[0]!.n) >= this.options.maxConnections) throw new PlatformError(413, 'ssh_connection_limit')
  }
  private fromRow(row: Connection, enabled = row.enabled): SshConfigurationInput {
    return { displayName: row.display_name, host: row.host, port: row.port, username: row.username,
      hostKeySha256: row.host_key_sha256, workingDirectory: row.working_directory, enabled,
      authentication: row.credential_kind === 'password' ? { kind: 'password', password: 'retain' }
        : { kind: 'private_key', privateKey: 'retain', passphrase: 'retain' } }
  }

  private legacySpec(input: LegacyCreate): Spec {
    const parsed = sshCreateTicketRequest.parse(input)
    const config = { ...parsed, host: parsed.host.toLowerCase() }
    if (/\s/u.test(config.username) || /[\u0000-\u001f\u007f]/u.test(config.displayName + config.username)) {
      throw new PlatformError(400, 'invalid_ssh_connection')
    }
    return { requestId: config.requestId, purpose: 'create', formatVersion: 1, input: config,
      digest: hash(JSON.stringify(config)), sizeBytes: config.sizeBytes, configuration: {
        displayName: config.displayName, host: config.host, port: config.port, username: config.username,
        hostKeySha256: config.hostKeySha256, workingDirectory: null,
        authentication: { kind: 'password', password: 'replace' }, enabled: config.enabled } }
  }
  private ticketSpec(user: Owner, input: SshCredentialTicketRequest): Spec {
    const parsed = sshCredentialTicketRequest.parse(input)
    const configuration = this.configuration(parsed.configuration)
    if (!sshNeedsUpload(configuration.authentication)) throw new PlatformError(400, 'ssh_ticket_not_required')
    const normalized = { ...parsed, configuration }
    return this.managedSpec(user, parsed.purpose, normalized, { requestId: parsed.requestId,
      ...(parsed.purpose === 'update' ? { connectionId: parsed.connectionId, baseRevision: parsed.baseRevision } : {}),
      sizeBytes: parsed.sizeBytes, configuration })
  }
  private async ticket(user: Owner, spec: Spec, platformOrigin: string): Promise<ManagedTicket> {
    this.requireAvailable()
    const origin = new URL(platformOrigin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new PlatformError(400, 'invalid_platform_origin')
    }
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      const request = await this.reserve(client, user, spec)
      const intent = (await client.query<Intent>('SELECT * FROM pe_ssh_upload_intents WHERE request_id=$1 FOR UPDATE',
        [spec.requestId])).rows[0]
      if (intent && (intent.user_id !== user.userId || intent.request_digest !== spec.digest
        || intent.format_version !== spec.formatVersion || intent.purpose !== spec.purpose
        || intent.size_bytes !== spec.sizeBytes)) throw new PlatformError(409, 'request_id_conflict')
      if ((intent?.verification_failures ?? 0) >= this.options.maxCompletedMismatches) {
        throw new PlatformError(409, 'ssh_credential_retry_limit')
      }
      if (!this.result(request)) {
        this.checkDestination(spec.configuration!.host, spec.configuration!.port)
        if (spec.purpose === 'create') await this.capacity(client, user)
      }
      const pending = await client.query<{ n: string }>(`SELECT count(*) AS n FROM pe_ssh_upload_intents
        WHERE user_id=$1 AND request_id<>$2 AND consumed_at IS NULL AND expires_at>now()`, [user.userId, spec.requestId])
      if (Number(pending.rows[0]!.n) >= this.options.maxPendingTickets) throw new PlatformError(429, 'ssh_upload_limit')
      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + this.options.ticketLifetimeMs)
      const issued = await client.query(`INSERT INTO pe_ssh_upload_intents(request_id,user_id,request_digest,config,size_bytes,
        token_digest,expires_at,format_version,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(request_id) DO UPDATE SET token_digest=EXCLUDED.token_digest,expires_at=EXCLUDED.expires_at
        WHERE pe_ssh_upload_intents.user_id=EXCLUDED.user_id
          AND pe_ssh_upload_intents.request_digest=EXCLUDED.request_digest
          AND pe_ssh_upload_intents.format_version=EXCLUDED.format_version
          AND pe_ssh_upload_intents.purpose=EXCLUDED.purpose
          AND pe_ssh_upload_intents.size_bytes=EXCLUDED.size_bytes RETURNING request_id`,
      [spec.requestId, user.userId, spec.digest, spec.input, spec.sizeBytes, hash(token), expiresAt, spec.formatVersion, spec.purpose])
      if (!issued.rowCount) throw new PlatformError(409, 'request_id_conflict')
      if (!this.result(request) && spec.purpose === 'update') {
        const source = await this.owned(client, user, spec.connectionId!, spec.baseRevision)
        if (source.credential_revision !== request.base_credential_revision) throw new PlatformError(409, 'revision_conflict')
        this.assertRetention(spec.configuration!.authentication, source)
      }
      return { state: 'pending' as const, requestId: spec.requestId, ticket: token,
        uploadUrl: new URL('/ssh/upload', origin).href, expiresAt: expiresAt.toISOString() }
    })
  }
  /**
   * Reserve or renew a direct format-two replacement upload bound to owner and request metadata.
   * @param user Verified owner creating or updating a connection.
   * @param input Request identity, complete configuration, purpose and exact upload byte length.
   * @param platformOrigin Platform HTTP origin used to construct the direct upload URL.
   * @returns Pending upload capability, request identity, URL and expiration time.
   */
  async issueManagedTicket(user: Owner, input: SshCredentialTicketRequest, platformOrigin: string): Promise<ManagedTicket> {
    return this.ticket(user, this.ticketSpec(user, input), platformOrigin)
  }
  /**
   * Reserve a legacy raw-password upload capability with its original wire shape.
   * @param user Verified owner creating the connection.
   * @param input Legacy request identity, connection metadata and exact password byte length.
   * @param platformOrigin Platform HTTP origin used to construct the direct upload URL.
   * @returns Pending upload capability, URL and expiration without a new requestId field.
   */
  async issueTicket(user: Identity, input: LegacyCreate, platformOrigin: string): Promise<LegacyTicket> {
    const value = await this.ticket(user, this.legacySpec(input), platformOrigin)
    return { state: value.state, ticket: value.ticket, uploadUrl: value.uploadUrl, expiresAt: value.expiresAt }
  }

  /** Append snapshots, then atomically advance the current pointer and durable public receipt. */
  private async commit(client: PoolClient, user: Owner, spec: Spec, config: SshConfigurationInput,
    source?: Connection, credential?: SshCredential, deleted = false, secretDigest?: string): Promise<SshConnection> {
    const id = source?.id ?? spec.requestId
    if (source && (source.revision >= 2_147_483_647
      || credential && source.credential_revision >= 2_147_483_647)) throw new PlatformError(409, 'ssh_revision_limit')
    const revision = source ? source.revision + 1 : 1
    const credentialRevision = source ? source.credential_revision + (credential ? 1 : 0) : 1
    const kind = credential?.kind ?? source!.credential_kind
    const passphraseConfigured = credential ? credential.kind === 'private_key' && credential.passphrase !== undefined
      : source!.passphrase_configured
    const sealed = credential ? this.requireAvailable().seal({ userId: user.userId, connectionId: id,
      credentialRevision, credentialKind: credential.kind, formatVersion: spec.formatVersion,
      aadRequestId: spec.formatVersion === 1 ? spec.requestId : null }, credential) : source!.encrypted_credential
    if (!source) await client.query(`INSERT INTO pe_ssh_connections(id,user_id,install_request_id,install_digest,
      display_name,host,port,username,host_key_sha256,credential_kind,encrypted_credential,enabled)
      VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, user.userId, spec.digest,
      config.displayName, config.host, config.port, config.username, config.hostKeySha256, kind, sealed, config.enabled])
    if (credential) await client.query(`INSERT INTO pe_ssh_credential_versions(connection_id,user_id,credential_revision,
      credential_kind,format_version,aad_request_id,encrypted_credential,passphrase_configured)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, user.userId, credentialRevision, kind, spec.formatVersion,
      spec.formatVersion === 1 ? spec.requestId : null, sealed, passphraseConfigured])
    await client.query(`INSERT INTO pe_ssh_configuration_versions(connection_id,user_id,revision,credential_revision,
      display_name,host,port,username,host_key_sha256,working_directory) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, user.userId, revision, credentialRevision, config.displayName, config.host, config.port,
      config.username, config.hostKeySha256, config.workingDirectory])
    if (source) await client.query(`UPDATE pe_ssh_connections SET revision=$3,credential_revision=$4,
      display_name=$5,host=$6,port=$7,username=$8,host_key_sha256=$9,credential_kind=$10,
      encrypted_credential=$11,enabled=$12,deleted_at=CASE WHEN $13 THEN now() ELSE NULL END,updated_at=now()
      WHERE id=$1 AND user_id=$2`, [id, user.userId, revision, credentialRevision, config.displayName,
      config.host, config.port, config.username, config.hostKeySha256, kind, sealed, deleted ? false : config.enabled, deleted])
    const row = (await client.query<Connection>(`${connectionSql} WHERE c.id=$1 AND c.user_id=$2`, [id, user.userId])).rows[0]!
    const result = this.present(row)
    await client.query(`UPDATE pe_ssh_management_requests SET connection_id=$3,result=$4,
      secret_digest=$5,completed_at=now() WHERE user_id=$1 AND request_id=$2`,
    [user.userId, spec.requestId, id, result, secretDigest ?? null])
    return result
  }
  private async mutate(user: Owner, spec: Spec, enabled?: boolean): Promise<SshConnection> {
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      const request = await this.reserve(client, user, spec)
      const prior = this.result(request)
      if (prior) return prior
      // No intent exists for a mutation that carries no replacements.
      const source = await this.owned(client, user, spec.connectionId!, spec.baseRevision)
      if (source.credential_revision !== request.base_credential_revision) throw new PlatformError(409, 'revision_conflict')
      const config = spec.configuration ?? this.fromRow(source, enabled)
      if (spec.purpose === 'update' || enabled === true) {
        this.requireAvailable(); this.checkDestination(config.host, config.port)
      }
      let credential: SshCredential | undefined
      if (spec.purpose === 'update') {
        this.assertRetention(config.authentication, source)
        if (sshChangesCredential(config.authentication)) {
          credential = mergeSshCredential(config.authentication, { formatVersion: 2 }, this.decode(source))
        }
      }
      return this.commit(client, user, spec, config, source, credential, spec.purpose === 'delete')
    })
  }
  /**
   * Compare-and-swap a complete configuration that retains credentials or clears a passphrase.
   * @param user Verified owner of the connection.
   * @param input Request identity, connection identity, base revision and complete configuration.
   * @returns Committed public connection record or the original receipt for an identical retry.
   */
  async update(user: Owner, input: z.infer<typeof sshConnectionUpdateRequest>): Promise<SshConnection> {
    const parsed = sshConnectionUpdateRequest.parse(input)
    const configuration = this.configuration(parsed.configuration)
    if (sshNeedsUpload(configuration.authentication)) throw new PlatformError(400, 'ssh_ticket_required')
    return this.mutate(user, this.managedSpec(user, 'update', { ...parsed, configuration },
      { ...parsed, configuration }))
  }
  /**
   * Compare-and-swap enablement while preserving target metadata and credential bytes.
   * @param user Verified owner of the connection.
   * @param input Request identity, connection identity, base revision and desired enablement.
   * @returns Committed public connection record or the original receipt for an identical retry.
   */
  async toggleManaged(user: Owner, input: z.infer<typeof sshConnectionToggleRequest>): Promise<SshConnection> {
    const parsed = sshConnectionToggleRequest.parse(input)
    return this.mutate(user, this.managedSpec(user, 'toggle', parsed, parsed), parsed.enabled)
  }
  /**
   * Tombstone an owned connection while preserving its immutable history and receipts.
   * @param user Verified owner of the connection.
   * @param input Request identity, connection identity and expected base revision.
   * @returns Disabled public tombstone or the original deletion receipt for an identical retry.
   */
  async remove(user: Owner, input: z.infer<typeof sshConnectionDeleteRequest>): Promise<SshConnection> {
    const parsed = sshConnectionDeleteRequest.parse(input)
    return this.mutate(user, this.managedSpec(user, 'delete', parsed, parsed), false)
  }
  /**
   * Compare-and-swap enablement through the historical Host request and response projections.
   * @param user Verified owner of the connection.
   * @param connectionId Stable identity of the owned connection.
   * @param requestId Stable identity used to replay the original toggle result.
   * @param baseRevision Expected current configuration revision.
   * @param enabled Desired connection enablement.
   * @returns Original nine-field public projection of the committed connection or retry receipt.
   */
  async toggle(user: Identity, connectionId: string, requestId: string, baseRevision: number, enabled: boolean): Promise<LegacyConnection> {
    const parsed = sshConnectionToggleRequest.parse({ connectionId, requestId, baseRevision, enabled })
    const oldInput = { connectionId: parsed.connectionId, baseRevision: parsed.baseRevision, enabled: parsed.enabled }
    return legacy(await this.mutate(user, { ...parsed, purpose: 'toggle', formatVersion: 1,
      input: oldInput, digest: hash(JSON.stringify(oldInput)) }, enabled))
  }

  /**
   * Consume exact upload bytes using the ticket's explicit raw-password or JSON-envelope format.
   * @param ticket Direct Platform capability issued for a fixed owner, request and byte length.
   * @param body Credential byte stream received directly by the trusted Platform.
   * @returns Original verified public receipt; format one uses the legacy projection and format two the full record.
   */
  async upload(ticket: string, body: AsyncIterable<Uint8Array>): Promise<{ item: LegacyConnection | SshConnection }> {
    const cipher = this.requireAvailable(), tokenDigest = hash(ticket)
    const intent = (await this.pool.query<Intent>('SELECT * FROM pe_ssh_upload_intents WHERE token_digest=$1', [tokenDigest])).rows[0]
    if (!intent || intent.expires_at.getTime() <= Date.now()) throw new PlatformError(401, 'invalid_ssh_ticket')
    const user = { userId: userId.parse(intent.user_id) }
    const spec = intent.format_version === 1 ? this.legacySpec(sshCreateTicketRequest.parse(intent.config))
      : this.ticketSpec(user, sshCredentialTicketRequest.parse(intent.config))
    if (spec.requestId !== intent.request_id || spec.digest !== intent.request_digest
      || spec.purpose !== intent.purpose || spec.sizeBytes !== intent.size_bytes) {
      throw new PlatformError(503, 'ssh_upload_unavailable')
    }
    const chunks: Buffer[] = []
    let plain: Buffer | undefined
    try {
      let size = 0
      for await (const value of body) {
        const chunk = Buffer.from(value); chunks.push(chunk); size += chunk.length
        if (size > (intent.format_version === 1 ? 4096 : SSH_CREDENTIAL_UPLOAD_MAX_BYTES)
          || size > intent.size_bytes) throw new PlatformError(413, 'ssh_credential_too_large')
      }
      plain = Buffer.concat(chunks)
      const text = plain.toString('utf8')
      if (plain.length !== intent.size_bytes || !Buffer.from(text, 'utf8').equals(plain)) {
        throw new PlatformError(400, 'ssh_credential_mismatch')
      }
      let supplied: SshCredentialUpload | undefined
      if (intent.format_version === 2) {
        let value: unknown
        try { value = JSON.parse(text) } catch { throw new PlatformError(400, 'ssh_credential_invalid') }
        supplied = sshUploadForPlan(spec.configuration!.authentication, value)
      }
      const secretDigest = intent.format_version === 1 ? cipher.legacyFingerprint(plain)
        : cipher.fingerprint('upload', { requestDigest: spec.digest, upload: supplied })
      const outcome = await transaction(this.pool, async client => {
        await this.owner(client, user)
        const request = await this.reserve(client, user, spec)
        const current = (await client.query<Intent>('SELECT * FROM pe_ssh_upload_intents WHERE request_id=$1 FOR UPDATE',
          [spec.requestId])).rows[0]
        if (!current || current.user_id !== user.userId || current.token_digest !== tokenDigest
          || current.expires_at.getTime() <= Date.now()) throw new PlatformError(401, 'invalid_ssh_ticket')
        if (current.request_digest !== spec.digest || current.format_version !== spec.formatVersion
          || current.purpose !== spec.purpose || current.size_bytes !== spec.sizeBytes) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        const prior = this.result(request)
        if (prior) {
          if (current.verification_failures >= this.options.maxCompletedMismatches) {
            throw new PlatformError(409, 'ssh_credential_retry_limit')
          }
          if (request.secret_digest !== secretDigest) {
            await client.query(`UPDATE pe_ssh_upload_intents SET verification_failures=verification_failures+1,
              result=$2 WHERE request_id=$1`, [spec.requestId,
              { item: prior, failedVerifications: current.verification_failures + 1 }])
            return { conflict: true as const }
          }
          return { item: prior }
        }
        let source: Connection | undefined
        if (spec.purpose === 'create') await this.capacity(client, user)
        else {
          source = await this.owned(client, user, spec.connectionId!, spec.baseRevision)
          if (source.credential_revision !== request.base_credential_revision) throw new PlatformError(409, 'revision_conflict')
        }
        const config = spec.configuration!
        this.checkDestination(config.host, config.port); this.assertRetention(config.authentication, source)
        const retain = config.authentication.kind === 'password' ? config.authentication.password === 'retain'
          : config.authentication.privateKey === 'retain' || config.authentication.passphrase === 'retain'
        const credential: SshCredential = intent.format_version === 1 ? { kind: 'password', password: text }
          : mergeSshCredential(config.authentication, supplied!, retain && source ? this.decode(source) : undefined)
        const item = await this.commit(client, user, spec, config, source, credential, false, secretDigest)
        await client.query(`UPDATE pe_ssh_upload_intents SET consumed_at=now(),secret_digest=$2,result=$3
          WHERE request_id=$1`, [spec.requestId, secretDigest, { item, failedVerifications: current.verification_failures }])
        return { item }
      })
      if ('conflict' in outcome) throw new PlatformError(409, 'ssh_credential_conflict')
      return { item: intent.format_version === 1 ? legacy(outcome.item) : outcome.item }
    } finally { plain?.fill(0); for (const chunk of chunks) chunk.fill(0) }
  }
}
