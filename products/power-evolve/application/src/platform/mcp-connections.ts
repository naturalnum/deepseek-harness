/** Generic remote MCP management. No method invokes a remote tool or exposes secrets to Host. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, type Identity, type RequestId, type UserId } from '../contracts.ts'
import { mcpCatalogId, mcpCheckId, mcpCheckRequest, mcpConnectionId, mcpCreateRequest,
  mcpDeleteRequest, mcpDraftId, mcpDraftRequest, mcpLeaseOwnerId, mcpResourceId, mcpSessionId,
  mcpRequestId, mcpTicketRequest, mcpToggleRequest, mcpUpdateRequest, type McpCatalog, type McpCatalogId,
  type McpCheck, type McpCheckId, type McpCheckLease, type McpConfigurationInput, type McpConnection,
  type McpConnectionId, type McpCredentialUpload, type McpDiscoveredTool, type McpDraftId,
  type McpManagementOptions, type McpManagementResult, type McpPinnedConnection,
  type McpPrivateSnapshot, type McpResourceId } from '../mcp-contracts.ts'
import { transaction } from './database.ts'
import { mcpCatalogDigest, mcpCatalogTools } from './mcp-catalog.ts'
import { McpCredentialCipher, mcpCanonicalJson, normalizeMcpConfiguration,
  normalizeMcpUpload } from './mcp-credentials.ts'

type Owner = Pick<Identity, 'userId'>
type Mutation = { purpose: 'create' | 'update' | 'draft'; requestId: RequestId; configuration: McpConfigurationInput;
  connectionId?: McpConnectionId; sourceConnectionId?: McpConnectionId; baseRevision?: number;
  sessionId?: z.infer<typeof mcpSessionId> }
type Configuration = { displayName: string; serverUrl: string; serverName: string;
  authentication: 'none' | 'bearer' | 'headers'; headerNames: string[]; secretConfigured: boolean }
type ConnectionRow = { id: McpConnectionId; user_id: UserId; server_name: string; revision: number;
  configuration_revision: number; credential_revision: number | null; enabled: boolean;
  deleted_at: Date | null; current_catalog_id: McpCatalogId | null; configuration: Configuration;
  created_at: Date; updated_at: Date }
type RequestRow = { purpose: string; metadata_digest: string; secret_digest: string | null; result: McpManagementResult | null }
type TicketRow = { user_id: UserId; request_id: RequestId; input: Mutation; resource_id: McpResourceId;
  size_bytes: number; token_digest: string; expires_at: Date; consumed_at: Date | null }
type CheckRow = { id: McpCheckId; user_id: UserId; session_id: z.infer<typeof mcpSessionId>;
  connection_id: McpConnectionId | null; draft_id: McpDraftId | null; connection_revision: number | null;
  configuration_revision: number; credential_revision: number | null; state: McpCheck['state'];
  catalog_id: McpCatalogId | null; discovered_tools: number | null; error_code: string | null;
  cancel_requested: boolean; created_at: Date; expires_at: Date; lease_owner: string | null; lease_epoch: number }
type DraftRow = { id: McpDraftId; user_id: UserId; configuration: Configuration;
  credential_revision: number | null; credential_sealed: Buffer | null;
  source_connection_id: McpConnectionId | null; source_revision: number | null }
type CatalogRow = { id: McpCatalogId; user_id: UserId; connection_id: McpConnectionId | null;
  draft_id: McpDraftId | null; configuration_revision: number; credential_revision: number | null;
  catalog_digest: string; tools: McpCatalog['tools']; created_at: Date }

const connectionSql = `SELECT c.*,v.configuration,v.credential_revision FROM pe_mcp_remote_connections c
  JOIN pe_mcp_configuration_versions v ON v.connection_id=c.id AND v.user_id=c.user_id
  AND v.configuration_revision=c.configuration_revision`
const emptySecret: McpCredentialUpload = { formatVersion: 1 }
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const safeError = /^[a-z][a-z0-9_]{0,99}$/u

/** The service requires deployment limits, an encryption key and operator endpoint admission. */
export class McpConnectionService {
  private readonly cipher: McpCredentialCipher
  private readonly options: McpManagementOptions
  constructor(private readonly pool: Pool, key: string, options: McpManagementOptions) {
    this.cipher = new McpCredentialCipher(key)
    const fields = ['maxConnections', 'maxPendingTickets', 'maxActiveChecks', 'maxDrafts', 'maxDraftsPerHour',
      'maxTools', 'maxCatalogBytes', 'maxToolBytes', 'ticketLifetimeMs', 'checkLifetimeMs',
      'draftLifetimeMs', 'retentionMs', 'checkLeaseMs'] as const
    const limits = options
    if (typeof options.assertEndpoint !== 'function' || fields.some(field =>
      !Number.isSafeInteger(limits[field]) || limits[field] <= 0) || limits.maxToolBytes > limits.maxCatalogBytes
      || limits.checkLeaseMs > limits.checkLifetimeMs || limits.checkLifetimeMs > limits.draftLifetimeMs) {
      throw new Error('Invalid MCP management options')
    }
    this.options = Object.freeze({ ...options })
  }

  private present(row: ConnectionRow): McpConnection {
    return { connectionId: mcpConnectionId.parse(row.id), revision: row.revision,
      configurationRevision: row.configuration_revision, credentialRevision: row.credential_revision,
      displayName: row.configuration.displayName, serverName: row.server_name,
      serverUrl: row.configuration.serverUrl, transport: 'streamable-http',
      authentication: row.configuration.authentication, headerNames: row.configuration.headerNames,
      secretConfigured: row.configuration.secretConfigured, enabled: row.enabled,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      currentCatalogId: row.current_catalog_id === null ? null : mcpCatalogId.parse(row.current_catalog_id),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }
  }
  private checkView(row: CheckRow): McpCheck {
    return { checkId: mcpCheckId.parse(row.id), connectionId: row.connection_id, draftId: row.draft_id,
      sessionId: mcpSessionId.parse(row.session_id), connectionRevision: row.connection_revision,
      configurationRevision: row.configuration_revision, credentialRevision: row.credential_revision,
      state: row.state, catalogId: row.catalog_id, discoveredTools: row.discovered_tools,
      errorCode: row.error_code, cancelRequested: row.cancel_requested,
      createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }
  }
  private catalogView(row: CatalogRow): McpCatalog {
    return { catalogId: mcpCatalogId.parse(row.id), connectionId: row.connection_id, draftId: row.draft_id,
      configurationRevision: row.configuration_revision, credentialRevision: row.credential_revision,
      catalogDigest: row.catalog_digest, tools: row.tools, createdAt: row.created_at.toISOString() }
  }
  private async owner(client: PoolClient, user: Owner): Promise<void> {
    const found = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [user.userId])
    if (!found.rowCount) throw new PlatformError(401, 'unauthorized')
  }
  private async owned(client: PoolClient, user: Owner, id: McpConnectionId, base?: number): Promise<ConnectionRow> {
    const found = await client.query<ConnectionRow>(`${connectionSql}
      WHERE c.id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL FOR UPDATE OF c`, [id, user.userId])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'mcp_connection_not_found')
    if (base !== undefined && row.revision !== base) throw new PlatformError(409, 'revision_conflict')
    return row
  }
  private async session(client: PoolClient, user: Owner, id: Mutation['sessionId']): Promise<void> {
    if (!id || !(await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2', [id, user.userId])).rowCount) {
      throw new PlatformError(404, 'session_not_found')
    }
  }
  private async existingRequest(client: Pool | PoolClient, user: Owner, requestId: RequestId,
    purpose: string, input: unknown, sizeBytes = 0, lock = false): Promise<RequestRow | null> {
    const digest = this.cipher.fingerprint('metadata', { userId: user.userId, purpose, input, sizeBytes })
    const prior = (await client.query<RequestRow>(
      `SELECT * FROM pe_mcp_management_requests WHERE user_id=$1 AND request_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [user.userId, requestId])).rows[0]
    if (prior) {
      if (prior.purpose !== purpose || prior.metadata_digest !== digest) throw new PlatformError(409, 'request_id_conflict')
      return prior
    }
    return null
  }
  private async reserve(client: PoolClient, user: Owner, requestId: RequestId, purpose: string,
    input: unknown, sizeBytes = 0): Promise<RequestRow> {
    const prior = await this.existingRequest(client, user, requestId, purpose, input, sizeBytes, true)
    if (prior) return prior
    const digest = this.cipher.fingerprint('metadata', { userId: user.userId, purpose, input, sizeBytes })
    await client.query(`INSERT INTO pe_mcp_management_requests(user_id,request_id,purpose,metadata_digest)
      VALUES($1,$2,$3,$4)`, [user.userId, requestId, purpose, digest])
    return { purpose, metadata_digest: digest, secret_digest: null, result: null }
  }
  private async outcome(client: PoolClient, user: Owner, id: RequestId, result: McpManagementResult,
    secretDigest: string | null = null): Promise<McpManagementResult> {
    await client.query(`UPDATE pe_mcp_management_requests SET result=$3::json,secret_digest=$4
      WHERE user_id=$1 AND request_id=$2`, [user.userId, id, JSON.stringify(result), secretDigest])
    return result
  }
  private normalized(purpose: Mutation['purpose'], value: unknown): Mutation {
    const parsed = purpose === 'create' ? mcpCreateRequest.parse(value)
      : purpose === 'update' ? mcpUpdateRequest.parse(value) : mcpDraftRequest.parse(value)
    const configuration = normalizeMcpConfiguration(parsed.configuration)
    return { ...parsed, purpose, configuration }
  }
  private async checkEndpoint(user: Owner, input: Mutation, sizeBytes = 0): Promise<void> {
    const prior = await this.existingRequest(this.pool, user, input.requestId, input.purpose, input, sizeBytes)
    if (!prior?.result) await this.options.assertEndpoint(input.configuration.serverUrl)
  }
  private async source(client: PoolClient, user: Owner, input: Mutation): Promise<ConnectionRow | null> {
    const id = input.purpose === 'update' ? input.connectionId : input.sourceConnectionId
    return id ? this.owned(client, user, id, input.baseRevision) : null
  }
  private replacement(configuration: McpConfigurationInput): boolean {
    const auth = configuration.authentication
    return auth.kind === 'bearer' && auth.action === 'replace'
      || auth.kind === 'headers' && auth.headers.some(header => header.action === 'replace')
  }
  private async credentials(client: PoolClient, row: ConnectionRow): Promise<McpCredentialUpload> {
    if (row.credential_revision === null) return emptySecret
    const found = await client.query<{ sealed: Buffer }>(`SELECT sealed FROM pe_mcp_credential_versions
      WHERE connection_id=$1 AND user_id=$2 AND configuration_revision=$3 AND credential_revision=$4`,
    [row.id, row.user_id, row.configuration_revision, row.credential_revision])
    if (!found.rows[0]) throw new PlatformError(503, 'mcp_credential_unavailable')
    return this.cipher.open({ kind: 'connection', userId: row.user_id, resourceId: mcpResourceId.parse(row.id),
      configurationRevision: row.configuration_revision, credentialRevision: row.credential_revision }, found.rows[0].sealed)
  }
  private resolve(configuration: McpConfigurationInput, supplied: McpCredentialUpload,
    previous: McpCredentialUpload): McpCredentialUpload {
    const auth = configuration.authentication
    if (auth.kind !== 'bearer' && supplied.bearerToken !== undefined
      || auth.kind !== 'headers' && supplied.headers !== undefined) throw new PlatformError(400, 'mcp_credential_plan_mismatch')
    if (auth.kind === 'none') return emptySecret
    if (auth.kind === 'bearer') {
      if (auth.action !== 'replace' && supplied.bearerToken !== undefined) throw new PlatformError(400, 'mcp_credential_plan_mismatch')
      const token = auth.action === 'replace' ? supplied.bearerToken : auth.action === 'retain' ? previous.bearerToken : undefined
      if (!token && auth.action !== 'clear') throw new PlatformError(400, 'mcp_credential_required')
      if (!token && configuration.enabled) throw new PlatformError(400, 'mcp_credential_required')
      return token ? { formatVersion: 1, bearerToken: token } : emptySecret
    }
    const provided = new Map(supplied.headers?.map(header => [header.name, header.value]))
    const replacements = auth.headers.filter(header => header.action === 'replace')
    if (provided.size !== replacements.length || replacements.some(header => !provided.has(header.name))) {
      throw new PlatformError(400, 'mcp_credential_plan_mismatch')
    }
    const retained = new Map(previous.headers?.map(header => [header.name, header.value]))
    const headers = auth.headers.map(header => {
      const value = (header.action === 'replace' ? provided : retained).get(header.name)
      if (value === undefined) throw new PlatformError(400, 'mcp_credential_required')
      return { name: header.name, value }
    })
    return normalizeMcpUpload({ formatVersion: 1, headers })
  }
  private stored(input: McpConfigurationInput, secret: McpCredentialUpload, serverName: string): Configuration {
    return { displayName: input.displayName, serverUrl: input.serverUrl, serverName,
      authentication: input.authentication.kind,
      headerNames: input.authentication.kind === 'headers' ? input.authentication.headers.map(header => header.name) : [],
      secretConfigured: secret.bearerToken !== undefined || (secret.headers?.length ?? 0) > 0 }
  }
  private async checkCapacity(client: PoolClient, user: Owner): Promise<void> {
    const found = await client.query<{ n: string }>(`SELECT count(*) AS n FROM pe_mcp_checks
      WHERE user_id=$1 AND state IN ('queued','running') AND expires_at>now()`, [user.userId])
    if (Number(found.rows[0]!.n) >= this.options.maxActiveChecks) throw new PlatformError(429, 'mcp_check_limit')
  }
  private async insertCheck(client: PoolClient, user: Owner, sessionId: NonNullable<Mutation['sessionId']>,
    source: { connectionId: McpConnectionId | null; draftId: McpDraftId | null;
      revision: number | null; configurationRevision: number; credentialRevision: number | null }): Promise<McpCheck> {
    await this.checkCapacity(client, user)
    const id = mcpCheckId.parse(randomUUID())
    const found = await client.query<CheckRow>(`INSERT INTO pe_mcp_checks(id,user_id,session_id,connection_id,
      draft_id,connection_revision,configuration_revision,credential_revision,state,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',clock_timestamp(),now()+$9::double precision*interval '1 millisecond') RETURNING *`,
    [id, user.userId, sessionId, source.connectionId, source.draftId, source.revision,
      source.configurationRevision, source.credentialRevision, this.options.checkLifetimeMs])
    return this.checkView(found.rows[0]!)
  }
  private async apply(client: PoolClient, user: Owner, input: Mutation, supplied: McpCredentialUpload,
    sizeBytes: number, resourceId: McpResourceId): Promise<McpManagementResult> {
    const request = await this.reserve(client, user, input.requestId, input.purpose, input, sizeBytes)
    const digest = this.cipher.fingerprint('supplied-credentials', supplied)
    if (request.result) {
      if (request.secret_digest !== digest) throw new PlatformError(409, 'mcp_credential_conflict')
      return request.result
    }
    const previous = await this.source(client, user, input)
    const auth = input.configuration.authentication
    const retains = auth.kind === 'bearer' && auth.action === 'retain'
      || auth.kind === 'headers' && auth.headers.some(header => header.action === 'retain')
    const secret = this.resolve(input.configuration, supplied,
      previous && retains ? await this.credentials(client, previous) : emptySecret)
    if (input.purpose === 'draft') {
      await this.session(client, user, input.sessionId)
      await this.checkCapacity(client, user)
      const count = await client.query<{ total: string; recent: string }>(`SELECT count(*) AS total,
        count(*) FILTER(WHERE created_at>now()-interval '1 hour') AS recent FROM pe_mcp_drafts WHERE user_id=$1`, [user.userId])
      if (Number(count.rows[0]!.total) >= this.options.maxDrafts
        || Number(count.rows[0]!.recent) >= this.options.maxDraftsPerHour) throw new PlatformError(429, 'mcp_draft_limit')
      const id = mcpDraftId.parse(resourceId), name = `c_${id.replaceAll('-', '')}`
      const configuration = this.stored(input.configuration, secret, name)
      const credentialRevision = configuration.secretConfigured ? 1 : null
      const sealed = credentialRevision === null ? null : this.cipher.seal({ kind: 'draft', userId: user.userId,
        resourceId, configurationRevision: 1, credentialRevision }, secret)
      await client.query(`INSERT INTO pe_mcp_drafts(id,user_id,session_id,source_connection_id,source_revision,
        configuration,configuration_revision,credential_revision,credential_sealed,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::json,1,$7,$8,now()+$9::double precision*interval '1 millisecond')`,
      [id, user.userId, input.sessionId, previous?.id ?? null, previous?.revision ?? null,
        JSON.stringify(configuration), credentialRevision, sealed, this.options.draftLifetimeMs])
      const item = await this.insertCheck(client, user, input.sessionId!, { connectionId: null, draftId: id,
        revision: null, configurationRevision: 1, credentialRevision })
      return this.outcome(client, user, input.requestId, { kind: 'check', item }, digest)
    }
    const id = previous?.id ?? mcpConnectionId.parse(resourceId)
    const nextConfiguration = (previous?.configuration_revision ?? 0) + 1
    const name = previous?.server_name ?? `c_${id.replaceAll('-', '')}`
    const configuration = this.stored(input.configuration, secret, name)
    const credentialRevision = configuration.secretConfigured ? nextConfiguration : null
    if (!previous) {
      const count = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM pe_mcp_remote_connections WHERE user_id=$1 AND deleted_at IS NULL', [user.userId])
      if (Number(count.rows[0]!.n) >= this.options.maxConnections) throw new PlatformError(413, 'mcp_connection_limit')
      await client.query(`INSERT INTO pe_mcp_remote_connections(id,user_id,server_name,revision,configuration_revision,enabled)
        VALUES($1,$2,$3,1,1,$4)`, [id, user.userId, name, input.configuration.enabled])
    }
    await client.query(`INSERT INTO pe_mcp_configuration_versions(connection_id,user_id,configuration_revision,
      credential_revision,configuration) VALUES($1,$2,$3,$4,$5::json)`,
    [id, user.userId, nextConfiguration, credentialRevision, JSON.stringify(configuration)])
    if (credentialRevision !== null) {
      const sealed = this.cipher.seal({ kind: 'connection', userId: user.userId, resourceId: mcpResourceId.parse(id),
        configurationRevision: nextConfiguration, credentialRevision }, secret)
      await client.query(`INSERT INTO pe_mcp_credential_versions(connection_id,user_id,configuration_revision,
        credential_revision,format_version,sealed) VALUES($1,$2,$3,$4,1,$5)`,
      [id, user.userId, nextConfiguration, credentialRevision, sealed])
    }
    if (previous) await client.query(`UPDATE pe_mcp_remote_connections SET revision=revision+1,
      configuration_revision=$3,enabled=$4,current_catalog_id=NULL,updated_at=now() WHERE id=$1 AND user_id=$2`,
    [id, user.userId, nextConfiguration, input.configuration.enabled])
    return this.outcome(client, user, input.requestId,
      { kind: 'connection', item: this.present(await this.owned(client, user, id)) }, digest)
  }

  /** List only this owner's live connections; endpoint metadata contains no authentication values.
   * @param user Platform-authenticated connection owner.
   * @returns Live connections with their latest check metadata, when present.
   */
  async list(user: Owner): Promise<{ items: { connection: McpConnection; latestCheck: McpCheck | null }[] }> {
    const rows = await this.pool.query<ConnectionRow>(`${connectionSql}
      WHERE c.user_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`, [user.userId])
    const items = []
    for (const row of rows.rows) {
      const latest = (await this.pool.query<CheckRow>(`SELECT * FROM pe_mcp_checks
        WHERE user_id=$1 AND connection_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [user.userId, row.id])).rows[0]
      items.push({ connection: this.present(row), latestCheck: latest ? this.checkView(latest) : null })
    }
    return { items }
  }
  /** Query only the owner's durable original management result after an upload response is lost.
   * @param user Platform-authenticated request owner.
   * @param requestId Original management request identity.
   * @returns The original completed result, or null if no owned result exists.
   */
  async receipt(user: Owner, requestId: RequestId): Promise<{ result: McpManagementResult | null }> {
    const row = (await this.pool.query<RequestRow>(`SELECT result FROM pe_mcp_management_requests
      WHERE user_id=$1 AND request_id=$2`, [user.userId, mcpRequestId.parse(requestId)])).rows[0]
    return { result: row?.result ?? null }
  }
  /** Read one owned connection. Foreign IDs and deleted identities are indistinguishable.
   * @param user Platform-authenticated connection owner.
   * @param id Exact connection identity.
   * @returns Current live connection metadata, excluding credential values.
   */
  async get(user: Owner, id: McpConnectionId): Promise<McpConnection> {
    return transaction(this.pool, async client => this.present(await this.owned(client, user, mcpConnectionId.parse(id))))
  }
  /** Create without replacement secrets; credentials must otherwise arrive using a ticket.
   * @param user Platform-authenticated connection owner.
   * @param value Untrusted create metadata and its stable request identity.
   * @returns Created connection metadata, or the original result on identical replay.
   */
  async create(user: Owner, value: unknown): Promise<McpConnection> { return this.mutate(user, 'create', value) }
  /** Update using explicit retain/clear instructions. Replacement values never enter this method.
   * @param user Platform-authenticated connection owner.
   * @param value Untrusted complete configuration, base revision and request identity.
   * @returns Updated connection metadata, or the original result on identical replay.
   */
  async update(user: Owner, value: unknown): Promise<McpConnection> { return this.mutate(user, 'update', value) }
  private async mutate(user: Owner, purpose: 'create' | 'update', value: unknown): Promise<McpConnection> {
    const input = this.normalized(purpose, value)
    if (this.replacement(input.configuration)) throw new PlatformError(400, 'mcp_ticket_required')
    await this.checkEndpoint(user, input)
    const result = await transaction(this.pool, async client => {
      await this.owner(client, user)
      return this.apply(client, user, input, emptySecret, 0, mcpResourceId.parse(randomUUID()))
    })
    if (result.kind !== 'connection') throw new PlatformError(503, 'mcp_request_unavailable')
    return result.item
  }
  /** Compare-and-swap current authority; an identical request returns its original result.
   * @param user Platform-authenticated connection owner.
   * @param value Untrusted enablement, connection identity, base revision and request identity.
   * @returns Connection metadata with the resulting authority revision.
   */
  async toggle(user: Owner, value: unknown): Promise<McpConnection> {
    const input = mcpToggleRequest.parse(value)
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      const prior = await this.reserve(client, user, input.requestId, 'toggle', input)
      if (prior.result?.kind === 'connection') return prior.result.item
      const row = await this.owned(client, user, input.connectionId, input.baseRevision)
      if (input.enabled && row.configuration.authentication !== 'none' && !row.configuration.secretConfigured) {
        throw new PlatformError(400, 'mcp_credential_required')
      }
      await client.query(`UPDATE pe_mcp_remote_connections SET revision=revision+1,enabled=$3,updated_at=now()
        WHERE id=$1 AND user_id=$2`, [row.id, user.userId, input.enabled])
      const item = this.present(await this.owned(client, user, row.id))
      await this.outcome(client, user, input.requestId, { kind: 'connection', item })
      return item
    })
  }
  /** Soft-delete once, retaining immutable versions and original receipts.
   * @param user Platform-authenticated connection owner.
   * @param value Untrusted connection identity, base revision and deletion request identity.
   * @returns Deleted connection metadata, or the original result on identical replay.
   */
  async remove(user: Owner, value: unknown): Promise<McpConnection> {
    const input = mcpDeleteRequest.parse(value)
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      const prior = await this.reserve(client, user, input.requestId, 'delete', input)
      if (prior.result?.kind === 'connection') return prior.result.item
      const row = await this.owned(client, user, input.connectionId, input.baseRevision)
      const found = await client.query<{ deleted_at: Date; updated_at: Date }>(`UPDATE pe_mcp_remote_connections
        SET revision=revision+1,enabled=false,deleted_at=now(),current_catalog_id=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING deleted_at,updated_at`, [row.id, user.userId])
      const item = this.present({ ...row, revision: row.revision + 1, enabled: false,
        current_catalog_id: null, ...found.rows[0]! })
      await this.outcome(client, user, input.requestId, { kind: 'connection', item })
      return item
    })
  }

  /** Reserve a one-use direct Platform capability. Reissuing invalidates the previous token.
   * @param user Platform-authenticated credential request owner.
   * @param value Untrusted create/update/draft metadata and exact upload byte count.
   * @param platformOrigin Trusted Platform origin used to construct the direct upload URL.
   * @returns A pending upload ticket; completed secret replays are verified during upload.
   */
  async issueTicket(user: Owner, value: unknown, platformOrigin: string): Promise<{
    state: 'pending'; requestId: RequestId; ticket: string; uploadUrl: string; expiresAt: string
  }> {
    const parsed = mcpTicketRequest.parse(value)
    const { purpose, sizeBytes, ...metadata } = parsed
    const input = this.normalized(purpose, metadata)
    await this.checkEndpoint(user, input, sizeBytes)
    const origin = new URL(platformOrigin)
    if (origin.username || origin.password || origin.search || origin.hash
      || !['https:', 'http:'].includes(origin.protocol)) throw new PlatformError(400, 'mcp_platform_origin_invalid')
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      const request = await this.reserve(client, user, input.requestId, purpose, input, sizeBytes)
      if (!request.result) {
        await this.source(client, user, input)
        if (purpose === 'draft') await this.session(client, user, input.sessionId)
      }
      const count = await client.query<{ n: string }>(`SELECT count(*) AS n FROM pe_mcp_credential_tickets
        WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>now() AND request_id<>$2`, [user.userId, input.requestId])
      if (Number(count.rows[0]!.n) >= this.options.maxPendingTickets) throw new PlatformError(429, 'mcp_ticket_limit')
      const token = randomBytes(32).toString('base64url')
      const row = (await client.query<{ expires_at: Date }>(`INSERT INTO pe_mcp_credential_tickets
        (user_id,request_id,token_digest,purpose,input,resource_id,size_bytes,expires_at)
        VALUES($1,$2,$3,$4,$5::json,$6,$7,now()+$8::double precision*interval '1 millisecond')
        ON CONFLICT(user_id,request_id) DO UPDATE SET token_digest=EXCLUDED.token_digest,
          consumed_at=NULL,expires_at=EXCLUDED.expires_at RETURNING expires_at`,
      [user.userId, input.requestId, hashToken(token), purpose, JSON.stringify(input),
        randomUUID(), sizeBytes, this.options.ticketLifetimeMs])).rows[0]!
      return { state: 'pending' as const, requestId: input.requestId, ticket: token,
        uploadUrl: new URL('/mcp/connections/upload', origin).href,
        expiresAt: row.expires_at.toISOString() }
    })
  }
  /** Consume exact UTF-8 secret bytes; identical fresh-ticket replay returns the original receipt.
   * @param ticket One-use bearer capability issued for this credential request.
   * @param body Direct Platform upload stream containing the versioned secret envelope.
   * @returns The original connection or draft-check result after credential verification.
   */
  async upload(ticket: string, body: AsyncIterable<Uint8Array>): Promise<McpManagementResult> {
    const tokenDigest = hashToken(ticket)
    const intent = (await this.pool.query<TicketRow>(`SELECT * FROM pe_mcp_credential_tickets
      WHERE token_digest=$1 AND consumed_at IS NULL AND expires_at>now()`, [tokenDigest])).rows[0]
    if (!intent) throw new PlatformError(401, 'invalid_mcp_ticket')
    const chunks: Buffer[] = []
    let bytes: Buffer | undefined
    try {
      let size = 0
      for await (const part of body) {
        const chunk = Buffer.from(part); chunks.push(chunk); size += chunk.length
        if (size > intent.size_bytes || size > 16_384) throw new PlatformError(413, 'mcp_credential_too_large')
      }
      bytes = Buffer.concat(chunks)
      if (size !== intent.size_bytes || !Buffer.from(bytes.toString('utf8')).equals(bytes)) {
        throw new PlatformError(400, 'mcp_credential_mismatch')
      }
      let raw: unknown
      try { raw = JSON.parse(bytes.toString('utf8')) } catch { throw new PlatformError(400, 'mcp_credential_invalid') }
      const supplied = normalizeMcpUpload(raw)
      const input = intent.input
      await this.checkEndpoint({ userId: intent.user_id }, input, intent.size_bytes)
      return await transaction(this.pool, async client => {
        await this.owner(client, { userId: intent.user_id })
        const current = (await client.query<TicketRow>(`SELECT * FROM pe_mcp_credential_tickets
          WHERE token_digest=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [tokenDigest])).rows[0]
        if (!current) throw new PlatformError(401, 'invalid_mcp_ticket')
        const result = await this.apply(client, { userId: current.user_id }, current.input, supplied,
          current.size_bytes, current.resource_id)
        await client.query('UPDATE pe_mcp_credential_tickets SET consumed_at=now() WHERE token_digest=$1', [tokenDigest])
        return result
      })
    } finally { bytes?.fill(0); for (const chunk of chunks) chunk.fill(0) }
  }

  /** Persist an independent unsaved snapshot; replacement credentials use a draft ticket.
   * @param user Platform-authenticated draft owner.
   * @param value Untrusted draft configuration, owned Session and request identity.
   * @returns Queued draft-check metadata, or the original result on identical replay.
   */
  async startDraftCheck(user: Owner, value: unknown): Promise<McpCheck> {
    const input = this.normalized('draft', value)
    if (this.replacement(input.configuration)) throw new PlatformError(400, 'mcp_ticket_required')
    await this.checkEndpoint(user, input)
    const result = await transaction(this.pool, async client => {
      await this.owner(client, user)
      return this.apply(client, user, input, emptySecret, 0, mcpResourceId.parse(randomUUID()))
    })
    if (result.kind !== 'check') throw new PlatformError(503, 'mcp_request_unavailable')
    return result.item
  }
  /** Enqueue discovery of an exact saved version, including intentionally disabled connections.
   * @param user Platform-authenticated connection and Session owner.
   * @param value Untrusted connection revision, Session and stable check request identity.
   * @returns Queued saved-check metadata, or the original result on identical replay.
   */
  async startCheck(user: Owner, value: unknown): Promise<McpCheck> {
    const input = mcpCheckRequest.parse(value)
    const completed = await this.existingRequest(this.pool, user, input.requestId, 'check', input)
    if (completed?.result?.kind === 'check') return completed.result.item
    const metadata = await this.get(user, input.connectionId)
    await this.options.assertEndpoint(metadata.serverUrl)
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      const prior = await this.reserve(client, user, input.requestId, 'check', input)
      if (prior.result?.kind === 'check') return prior.result.item
      await this.session(client, user, input.sessionId)
      const row = await this.owned(client, user, input.connectionId, input.baseRevision)
      const item = await this.insertCheck(client, user, input.sessionId, { connectionId: row.id, draftId: null,
        revision: row.revision, configurationRevision: row.configuration_revision, credentialRevision: row.credential_revision })
      await this.outcome(client, user, input.requestId, { kind: 'check', item })
      return item
    })
  }
  /** Owner-only polling, including historical terminal check metadata.
   * @param user Platform-authenticated check owner.
   * @param id Exact saved or draft check identity.
   * @returns Current retained check metadata without private credentials.
   */
  async check(user: Owner, id: McpCheckId): Promise<McpCheck> {
    const row = (await this.pool.query<CheckRow>('SELECT * FROM pe_mcp_checks WHERE id=$1 AND user_id=$2',
      [mcpCheckId.parse(id), user.userId])).rows[0]
    if (!row) throw new PlatformError(404, 'mcp_check_not_found')
    return this.checkView(row)
  }
  /** Cancellation fences completion writes and is idempotent for every terminal state.
   * @param user Platform-authenticated check owner.
   * @param id Exact check identity to cancel.
   * @returns Cancelled metadata, or the existing terminal result if already settled.
   */
  async cancelCheck(user: Owner, id: McpCheckId): Promise<McpCheck> {
    return transaction(this.pool, async client => {
      const row = (await client.query<CheckRow>(
        'SELECT * FROM pe_mcp_checks WHERE id=$1 AND user_id=$2 FOR UPDATE', [mcpCheckId.parse(id), user.userId])).rows[0]
      if (!row) throw new PlatformError(404, 'mcp_check_not_found')
      if (!['queued', 'running'].includes(row.state)) return this.checkView(row)
      const updated = await client.query<CheckRow>(`UPDATE pe_mcp_checks SET state='cancelled',cancel_requested=true,
        lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [row.id])
      return this.checkView(updated.rows[0]!)
    })
  }
  /** Claim/recover metadata for handshake/listTools only. Network work happens after this commits.
   * @param ownerId Platform check worker identity.
   * @returns A current check lease and epoch, or null when no check can be claimed.
   */
  async claimCheck(ownerId: McpCheckLease['ownerId']): Promise<McpCheckLease | null> {
    mcpLeaseOwnerId.parse(ownerId)
    return transaction(this.pool, async client => {
      await client.query(`UPDATE pe_mcp_checks SET state='expired',error_code='mcp_check_expired',
        lease_owner=NULL,lease_until=NULL,updated_at=now()
        WHERE state IN ('queued','running') AND expires_at<=now()`)
      const row = (await client.query<CheckRow>(`SELECT * FROM pe_mcp_checks
        WHERE state IN ('queued','running') AND cancel_requested=false AND expires_at>now()
          AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0]
      if (!row) return null
      const next = (await client.query<CheckRow>(`UPDATE pe_mcp_checks SET state='running',lease_owner=$2,
        lease_epoch=lease_epoch+1,lease_until=LEAST(expires_at,now()+$3::double precision*interval '1 millisecond'),
        updated_at=now() WHERE id=$1 RETURNING *`, [row.id, ownerId, this.options.checkLeaseMs])).rows[0]!
      return { checkId: mcpCheckId.parse(next.id), ownerId, epoch: next.lease_epoch }
    })
  }
  private async leased(client: PoolClient, lease: McpCheckLease): Promise<CheckRow> {
    const row = (await client.query<CheckRow>(`SELECT * FROM pe_mcp_checks WHERE id=$1 AND lease_owner=$2
      AND lease_epoch=$3 AND lease_until>now() AND expires_at>now() AND state='running'
      AND cancel_requested=false FOR UPDATE`, [lease.checkId, lease.ownerId, lease.epoch])).rows[0]
    if (!row) throw new PlatformError(409, 'mcp_check_lease_lost')
    return row
  }
  /** Renew only live epochs; expired workers cannot reacquire their former claim.
   * @param lease Exact worker identity and epoch of the current check claim.
   * @returns Nothing once the live lease is extended within the check lifetime.
   */
  async renewCheck(lease: McpCheckLease): Promise<void> {
    await transaction(this.pool, async client => {
      await this.leased(client, lease)
      await client.query(`UPDATE pe_mcp_checks SET lease_until=LEAST(expires_at,
        now()+$2::double precision*interval '1 millisecond'),updated_at=now() WHERE id=$1`,
      [lease.checkId, this.options.checkLeaseMs])
    })
  }
  private material(userId: UserId, resourceId: McpResourceId, configurationRevision: number,
    credentialRevision: number | null, configuration: Configuration, secret: McpCredentialUpload): McpPrivateSnapshot {
    const headers = secret.bearerToken === undefined
      ? Object.fromEntries(secret.headers?.map(header => [header.name, header.value]) ?? [])
      : { Authorization: `Bearer ${secret.bearerToken}` }
    return { userId, resourceId, configurationRevision, credentialRevision,
      serverUrl: configuration.serverUrl, serverName: configuration.serverName,
      authentication: configuration.authentication, headers }
  }
  /** Platform-only credentials of the exact leased snapshot; never serve through Host RPC.
   * @param lease Exact live check worker identity and epoch.
   * @returns Private endpoint and authentication material for handshake/listTools only.
   */
  async checkSnapshot(lease: McpCheckLease): Promise<McpPrivateSnapshot> {
    return transaction(this.pool, async client => {
      const check = await this.leased(client, lease)
      if (check.connection_id) {
        const row = await this.owned(client, { userId: check.user_id }, check.connection_id, check.connection_revision!)
        if (row.configuration_revision !== check.configuration_revision || row.credential_revision !== check.credential_revision) {
          throw new PlatformError(409, 'mcp_check_stale')
        }
        return this.material(row.user_id, mcpResourceId.parse(row.id), row.configuration_revision,
          row.credential_revision, row.configuration, await this.credentials(client, row))
      }
      const draft = (await client.query<DraftRow>('SELECT * FROM pe_mcp_drafts WHERE id=$1 AND user_id=$2 AND expires_at>now()',
        [check.draft_id, check.user_id])).rows[0]
      if (!draft) throw new PlatformError(409, 'mcp_check_stale')
      if (draft.source_connection_id) await this.owned(client, { userId: check.user_id },
        draft.source_connection_id, draft.source_revision!)
      const resourceId = mcpResourceId.parse(draft.id)
      const secret = draft.credential_revision === null ? emptySecret : this.cipher.open({ kind: 'draft',
        userId: draft.user_id, resourceId, configurationRevision: 1, credentialRevision: draft.credential_revision }, draft.credential_sealed!)
      return this.material(draft.user_id, resourceId, 1, draft.credential_revision, draft.configuration, secret)
    })
  }

  /** Save complete prevalidated catalogs; only the newest check of the current authority publishes or revokes.
   * @param lease Exact live check worker identity and epoch.
   * @param outcome Complete tools already validated for admission, or a safe failure code.
   * @returns Terminal check metadata with its immutable catalog identity on success.
   */
  async finishCheck(lease: McpCheckLease, outcome: { tools: readonly McpDiscoveredTool[] } | { errorCode: string }): Promise<McpCheck> {
    let tools: McpCatalog['tools'] | undefined, digest: string | undefined
    if ('tools' in outcome) {
      if (outcome.tools.length > this.options.maxTools
        || Buffer.byteLength(mcpCanonicalJson(outcome.tools)) > this.options.maxCatalogBytes
        || outcome.tools.some(tool => Buffer.byteLength(mcpCanonicalJson(tool)) > this.options.maxToolBytes)) {
        throw new PlatformError(413, 'mcp_catalog_limit')
      }
      digest = mcpCatalogDigest(outcome.tools)
    } else if (!safeError.test(outcome.errorCode)) throw new PlatformError(400, 'mcp_error_code_invalid')
    return transaction(this.pool, async client => {
      const check = await this.leased(client, lease)
      let catalogId: McpCatalogId | null = null
      const connection = check.connection_id ? (await client.query<ConnectionRow>(`${connectionSql}
        WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE OF c`, [check.connection_id, check.user_id])).rows[0] : undefined
      if ('tools' in outcome) {
        const resourceId = mcpResourceId.parse(check.connection_id ?? check.draft_id)
        tools = mcpCatalogTools(resourceId, outcome.tools)
        if (Buffer.byteLength(mcpCanonicalJson(tools)) > this.options.maxCatalogBytes) throw new PlatformError(413, 'mcp_catalog_limit')
        const previous = (await client.query<CatalogRow>(`SELECT * FROM pe_mcp_catalog_versions
          WHERE user_id=$1 AND connection_id IS NOT DISTINCT FROM $2::uuid AND draft_id IS NOT DISTINCT FROM $3::uuid
            AND configuration_revision=$4 AND credential_revision IS NOT DISTINCT FROM $5::integer AND catalog_digest=$6`,
        [check.user_id, check.connection_id, check.draft_id, check.configuration_revision, check.credential_revision, digest])).rows[0]
        catalogId = previous?.id ?? mcpCatalogId.parse(randomUUID())
        if (!previous) await client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,draft_id,
          configuration_revision,credential_revision,catalog_digest,tools) VALUES($1,$2,$3,$4,$5,$6,$7,$8::json)`,
        [catalogId, check.user_id, check.connection_id, check.draft_id, check.configuration_revision,
          check.credential_revision, digest, JSON.stringify(tools)])
      }
      if (connection && !connection.deleted_at && connection.revision === check.connection_revision
        && connection.configuration_revision === check.configuration_revision
        && connection.credential_revision === check.credential_revision) await client.query(`UPDATE pe_mcp_remote_connections
          SET current_catalog_id=$2,updated_at=now() WHERE id=$1
          AND NOT EXISTS(SELECT 1 FROM pe_mcp_checks newer WHERE newer.connection_id=$1
            AND newer.user_id=$3 AND newer.connection_revision=$4
            AND newer.configuration_revision=$5 AND newer.credential_revision IS NOT DISTINCT FROM $6::integer
            AND (newer.created_at,newer.id)>(SELECT created_at,id FROM pe_mcp_checks WHERE id=$7))`,
        [connection.id, catalogId, check.user_id, check.connection_revision,
          check.configuration_revision, check.credential_revision, check.id])
      const updated = (await client.query<CheckRow>(`UPDATE pe_mcp_checks SET state=$2,catalog_id=$3,
        discovered_tools=$4,error_code=$5,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
      [check.id, 'tools' in outcome ? 'succeeded' : 'failed', catalogId,
        'tools' in outcome ? outcome.tools.length : null, 'errorCode' in outcome ? outcome.errorCode : null])).rows[0]!
      return this.checkView(updated)
    })
  }
  /** Owner-only immutable catalog read; drafts remain separate from admission selection.
   * @param user Platform-authenticated catalog owner.
   * @param id Exact immutable catalog identity.
   * @param client Existing caller transaction, when the read must share its locks.
   * @returns The retained catalog, including every original tool descriptor.
   */
  async getCatalog(user: Owner, id: McpCatalogId, client?: PoolClient): Promise<McpCatalog> {
    const row = (await (client ?? this.pool).query<CatalogRow>(
      'SELECT * FROM pe_mcp_catalog_versions WHERE id=$1 AND user_id=$2', [mcpCatalogId.parse(id), user.userId])).rows[0]
    if (!row) throw new PlatformError(404, 'mcp_catalog_not_found')
    return this.catalogView(row)
  }
  /** Admission reads current enabled formal catalogs under its existing transaction; no credentials return.
   * @param client Existing admission transaction holding the authenticated owner's lock.
   * @param user Platform-authenticated connection owner.
   * @returns Current enabled formal connections with their matching immutable catalogs.
   */
  async admissionCatalogs(client: PoolClient, user: Owner): Promise<{ connection: McpConnection; catalog: McpCatalog }[]> {
    const rows = await client.query<ConnectionRow>(`${connectionSql}
      WHERE c.user_id=$1 AND c.enabled=true AND c.deleted_at IS NULL AND c.current_catalog_id IS NOT NULL
      ORDER BY c.id FOR SHARE OF c`, [user.userId])
    const output = []
    for (const row of rows.rows) {
      const catalog = await this.getCatalog(user, row.current_catalog_id!, client)
      if (catalog.connectionId !== row.id || catalog.draftId !== null
        || catalog.configurationRevision !== row.configuration_revision
        || catalog.credentialRevision !== row.credential_revision) throw new PlatformError(503, 'mcp_catalog_unavailable')
      output.push({ connection: this.present(row), catalog })
    }
    return output
  }
  /** Private runtime lookup locks exact live authority in the caller's dispatch transaction.
   * @param client Dispatch/admission transaction; network I/O must occur after commit.
   * @param user Platform-authenticated owner, never a Host-asserted identity.
   * @param pinned Exact accepted connection/configuration/credential/catalog identity.
   * @returns Endpoint and authentication material for Platform transport only.
   */
  async runtimeSnapshot(client: PoolClient, user: Owner, pinned: McpPinnedConnection): Promise<McpPrivateSnapshot> {
    const row = (await client.query<ConnectionRow>(`${connectionSql} JOIN pe_mcp_catalog_versions k
      ON k.id=c.current_catalog_id AND k.user_id=c.user_id AND k.connection_id=c.id AND k.draft_id IS NULL
      AND k.configuration_revision=c.configuration_revision AND k.credential_revision IS NOT DISTINCT FROM v.credential_revision
      WHERE c.id=$1 AND c.user_id=$2 AND c.revision=$3 AND c.configuration_revision=$4
        AND v.credential_revision IS NOT DISTINCT FROM $5::integer AND c.current_catalog_id=$6
        AND c.enabled=true AND c.deleted_at IS NULL FOR SHARE OF c`,
    [pinned.connectionId, user.userId, pinned.revision, pinned.configurationRevision,
      pinned.credentialRevision, pinned.catalogId])).rows[0]
    if (!row) throw new PlatformError(403, 'mcp_connection_revoked')
    return this.material(row.user_id, mcpResourceId.parse(row.id), row.configuration_revision,
      row.credential_revision, row.configuration, await this.credentials(client, row))
  }
  /** Remove expired terminal discovery state after retention; formal versions and audit receipts remain.
   * @param user Platform-authenticated discovery owner.
   * @returns Counts of deleted checks and drafts for this owner.
   */
  async pruneChecks(user: Owner): Promise<{ checks: number; drafts: number }> {
    return transaction(this.pool, async client => {
      await this.owner(client, user)
      await client.query(`UPDATE pe_mcp_checks SET state='expired',error_code='mcp_check_expired',
        lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE user_id=$1
        AND state IN ('queued','running') AND expires_at<=now()`, [user.userId])
      const removed = await client.query(`DELETE FROM pe_mcp_checks WHERE user_id=$1
        AND state NOT IN ('queued','running') AND expires_at<now()-$2::double precision*interval '1 millisecond'
        RETURNING draft_id`, [user.userId, this.options.retentionMs])
      await client.query(`DELETE FROM pe_mcp_catalog_versions k WHERE k.user_id=$1 AND k.draft_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM pe_mcp_checks c WHERE c.draft_id=k.draft_id)
        AND EXISTS(SELECT 1 FROM pe_mcp_drafts d WHERE d.id=k.draft_id
          AND d.expires_at<now()-$2::double precision*interval '1 millisecond')`, [user.userId, this.options.retentionMs])
      const drafts = await client.query(`DELETE FROM pe_mcp_drafts d WHERE d.user_id=$1
        AND d.expires_at<now()-$2::double precision*interval '1 millisecond'
        AND NOT EXISTS(SELECT 1 FROM pe_mcp_checks c WHERE c.draft_id=d.id) RETURNING id`, [user.userId, this.options.retentionMs])
      return { checks: removed.rowCount ?? 0, drafts: drafts.rowCount ?? 0 }
    })
  }
}
