/** Native metadata RPC and direct Platform credential intake for the original MCP page Port. */
import { approvalUrl } from './plugins-api.ts'
import { PersonalMcpConnectionRequestError, type PersonalMcpConnection,
  type PersonalMcpConnectionCheck, type PersonalMcpConnectionCheckDraftRequest,
  type PersonalMcpConnectionCreateRequest, type PersonalMcpConnectionPage,
  type PersonalMcpConnectionPort, type PersonalMcpConnectionUpdateRequest } from './personal-mcp-client.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const TICKET = /^[A-Za-z0-9_-]{32,256}$/u
const CONNECTION_KEYS = ['connectionId', 'revision', 'configurationRevision', 'credentialRevision',
  'displayName', 'serverName', 'serverUrl', 'transport', 'authentication', 'headerNames', 'secretConfigured',
  'enabled', 'deletedAt', 'currentCatalogId', 'createdAt', 'updatedAt']
const CHECK_KEYS = ['checkId', 'draftId', 'connectionId', 'sessionId', 'connectionRevision',
  'configurationRevision', 'credentialRevision', 'state', 'catalogId', 'discoveredTools', 'errorCode',
  'cancelRequested', 'createdAt', 'expiresAt']

type Authentication = { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly action: 'retain' | 'replace' | 'clear' }
  | { readonly kind: 'headers'; readonly headers: readonly { readonly name: string; readonly action: 'retain' | 'replace' }[] }
interface Configuration {
  readonly displayName: string
  readonly serverUrl: string
  readonly enabled: boolean
  readonly authentication: Authentication
}
interface CredentialBody {
  readonly formatVersion: 1
  readonly bearerToken?: string
  readonly headers?: readonly { readonly name: string; readonly value: string }[]
}
type Result = { readonly kind: 'connection'; readonly item: PersonalMcpConnection }
  | { readonly kind: 'check'; readonly item: PersonalMcpConnectionCheck }

function configuration(input: PersonalMcpConnectionCreateRequest, canRetain: boolean): Configuration {
  const kind = input.authentication.kind
  const authentication: Authentication = kind === 'none' ? { kind }
    : kind === 'bearer' ? { kind, action: input.secrets?.bearer_token !== undefined ? 'replace'
      : input.clear_secret_keys?.includes('bearer_token') || !canRetain ? 'clear' : 'retain' }
      : { kind, headers: (input.headers ?? []).map(header => ({ name: header.name,
        action: header.value === undefined ? 'retain' : 'replace' })) }
  return { displayName: input.display_name, serverUrl: input.server_url, enabled: input.enabled, authentication }
}

function editedConfiguration(input: PersonalMcpConnectionUpdateRequest): Configuration {
  const value = configuration(input, true)
  return value.authentication.kind === 'bearer' && input.secrets?.bearer_token === undefined
    && input.clear_secret_keys?.includes('bearer_token')
    ? { ...value, authentication: { kind: 'bearer', action: 'clear' } } : value
}

function credentialBody(input: PersonalMcpConnectionCreateRequest): CredentialBody | undefined {
  if (input.authentication.kind === 'bearer' && input.secrets?.bearer_token !== undefined) {
    return { formatVersion: 1, bearerToken: input.secrets.bearer_token }
  }
  if (input.authentication.kind === 'headers') {
    const headers = input.headers?.flatMap(header => header.value === undefined ? [] : [{ name: header.name, value: header.value }]) ?? []
    if (headers.length > 0) return { formatVersion: 1, headers }
  }
  return undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function nullableUuid(value: unknown): value is string | null { return value === null || uuid(value) }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function timestamp(value: unknown): value is string { return text(value, 64) && Number.isFinite(Date.parse(value)) }
function invalid(): never { throw new PersonalMcpConnectionRequestError(502) }
function requestId(value: string): void { if (!uuid(value)) throw new PersonalMcpConnectionRequestError(400) }

function connection(value: unknown, deleted = false): PersonalMcpConnection {
  if (!exact(value, CONNECTION_KEYS) || !uuid(value.connectionId) || !positive(value.revision)
    || !positive(value.configurationRevision) || value.credentialRevision !== null && !positive(value.credentialRevision)
    || !text(value.displayName, 100) || !text(value.serverName, 100) || !text(value.serverUrl, 2048)
    || value.transport !== 'streamable-http' || !Array.isArray(value.headerNames)
    || value.headerNames.length > 16 || typeof value.secretConfigured !== 'boolean'
    || typeof value.enabled !== 'boolean' || value.deletedAt !== null && !timestamp(value.deletedAt)
    || (value.deletedAt !== null) !== deleted
    || !nullableUuid(value.currentCatalogId) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) invalid()
  const kind = value.authentication
  if (kind !== 'none' && kind !== 'bearer' && kind !== 'headers' || kind === 'none' && value.secretConfigured) invalid()
  let endpoint: URL
  try { endpoint = new URL(value.serverUrl) } catch (_cause: unknown) { return invalid() }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.hash) invalid()
  const headerNames = value.headerNames.map(name => {
    if (!text(name, 200) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) invalid()
    return name
  })
  if (new Set(headerNames.map(name => name.toLowerCase())).size !== headerNames.length) invalid()
  return { connection_id: value.connectionId, revision: value.revision,
    configuration_revision: value.configurationRevision, credential_revision: value.credentialRevision,
    display_name: value.displayName, server_name: value.serverName, server_url: value.serverUrl,
    authentication: kind === 'none' ? { kind, secret_configured: false } : { kind, secret_configured: value.secretConfigured },
    ...(kind === 'headers' ? { headers: headerNames.map(name => ({ name, value_configured: value.secretConfigured === true })) } : {}),
    enabled: value.enabled, latest_check: null, created_at: value.createdAt, updated_at: value.updatedAt }
}

function check(value: unknown, expected: { readonly checkId?: string; readonly connectionId?: string;
  readonly sessionId?: string; readonly draft?: boolean } = {}): PersonalMcpConnectionCheck {
  if (!exact(value, CHECK_KEYS) || !uuid(value.checkId) || !nullableUuid(value.draftId)
    || !nullableUuid(value.connectionId) || !uuid(value.sessionId)
    || value.connectionRevision !== null && !positive(value.connectionRevision)
    || !positive(value.configurationRevision) || value.credentialRevision !== null && !positive(value.credentialRevision)
    || !nullableUuid(value.catalogId) || value.discoveredTools !== null
      && (typeof value.discoveredTools !== 'number' || !Number.isSafeInteger(value.discoveredTools) || value.discoveredTools < 0)
    || value.errorCode !== null && (typeof value.errorCode !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/u.test(value.errorCode))
    || typeof value.cancelRequested !== 'boolean' || !timestamp(value.createdAt) || !timestamp(value.expiresAt)) invalid()
  if (expected.checkId !== undefined && expected.checkId !== value.checkId
    || expected.connectionId !== undefined && expected.connectionId !== value.connectionId
    || expected.sessionId !== undefined && expected.sessionId !== value.sessionId
    || expected.draft === true && value.draftId === null || expected.draft === false && value.draftId !== null) invalid()
  const state = value.state === 'cancelled' ? 'canceled' : value.state
  if (state !== 'queued' && state !== 'running' && state !== 'succeeded' && state !== 'failed'
    && state !== 'canceled' && state !== 'expired') invalid()
  const errorCode = value.errorCode === null ? null : discoveryError(value.errorCode)
  return { check_id: value.checkId, connection_id: value.connectionId,
    configuration_revision: value.configurationRevision, credential_revision: value.credentialRevision,
    state, error_code: errorCode, discovered_tools: value.discoveredTools,
    started_at: null, finished_at: null, cancel_requested: value.cancelRequested }
}

function discoveryError(code: string): NonNullable<PersonalMcpConnectionCheck['error_code']> {
  switch (code.replace(/^mcp_/u, '')) {
    case 'dns_failed': return 'MCP_DNS_FAILED'
    case 'connect_timeout': return 'MCP_CONNECT_TIMEOUT'
    case 'tls_failed': return 'MCP_TLS_FAILED'
    case 'auth_rejected': return 'MCP_AUTH_REJECTED'
    case 'protocol_invalid': return 'MCP_PROTOCOL_INVALID'
    case 'discovery_failed': return 'MCP_DISCOVERY_FAILED'
    case 'response_limit': return 'MCP_RESPONSE_LIMIT'
    case 'canceled': case 'cancelled': return 'MCP_CANCELED'
    default: return 'MCP_CONNECTION_FAILED'
  }
}

function result(value: unknown, expectedCheck: { readonly sessionId?: string; readonly draft?: boolean } = {}): Result {
  if (!exact(value, ['kind', 'item'])) invalid()
  if (value.kind === 'connection') return { kind: value.kind, item: connection(value.item) }
  if (value.kind === 'check') return { kind: value.kind, item: check(value.item, expectedCheck) }
  return invalid()
}

/** Browser adapter for the frozen flat MCP management RPC; credential values never enter Host RPC. */
export class PersonalMcpConnectionHttpClient implements PersonalMcpConnectionPort {
  private readonly uncertainUploads = new Map<string, string>()

  /** @param request - browser fetch, replaceable only at the network test boundary. */
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new PersonalMcpConnectionRequestError(response.status)
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) invalid()
    try { return await response.json() } catch (_cause: unknown) { return invalid() }
  }

  private async post(method: string, input: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${method}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: input }), ...(signal === undefined ? {} : { signal }),
    })
    return this.json(response)
  }

  private async receipt(id: string, expectedCheck: { readonly sessionId?: string; readonly draft?: boolean }): Promise<Result | null> {
    const value = await this.post('mcpConnectionsReceipt', { requestId: id })
    if (!exact(value, ['result'])) invalid()
    return value.result === null ? null : result(value.result, expectedCheck)
  }

  private async write(purpose: 'create' | 'update' | 'draft', metadata: { readonly requestId: string;
    readonly configuration: Configuration; readonly connectionId?: string; readonly baseRevision?: number;
    readonly sessionId?: string; readonly sourceConnectionId?: string }, body: CredentialBody | undefined): Promise<Result> {
    const fingerprintBytes = new TextEncoder().encode(JSON.stringify({ purpose, metadata, body }))
    let fingerprint: string
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', fingerprintBytes)
      fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    } finally { fingerprintBytes.fill(0) }
    const expectedCheck = { ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }), draft: purpose === 'draft' }
    if (this.uncertainUploads.has(metadata.requestId)) {
      if (this.uncertainUploads.get(metadata.requestId) !== fingerprint) throw new PersonalMcpConnectionRequestError(409)
      const prior = await this.receipt(metadata.requestId, expectedCheck)
      if (prior === null) throw new PersonalMcpConnectionRequestError(503, 'personalMcpMutationUncertain')
      this.uncertainUploads.delete(metadata.requestId)
      return prior
    }
    if (body === undefined) {
      const method = purpose === 'create' ? 'mcpConnectionsCreate' : purpose === 'update'
        ? 'mcpConnectionsUpdate' : 'mcpConnectionsDraftCheck'
      const value = await this.post(method, metadata)
      return purpose === 'draft' ? { kind: 'check', item: check(value, expectedCheck) }
        : { kind: 'connection', item: connection(value) }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    try {
      if (bytes.byteLength < 19 || bytes.byteLength > 16_384) throw new PersonalMcpConnectionRequestError(413)
      const ticket = await this.post('mcpConnectionsTicket', { purpose, ...metadata, sizeBytes: bytes.byteLength })
      if (exact(ticket, ['state', 'result']) && ticket.state === 'ready') return result(ticket.result, expectedCheck)
      if (!exact(ticket, ['state', 'requestId', 'ticket', 'uploadUrl', 'expiresAt']) || ticket.state !== 'pending'
        || ticket.requestId !== metadata.requestId || typeof ticket.ticket !== 'string' || !TICKET.test(ticket.ticket)
        || !text(ticket.uploadUrl, 2048) || !timestamp(ticket.expiresAt)) invalid()
      if (Date.parse(ticket.expiresAt) <= Date.now()) throw new PersonalMcpConnectionRequestError(410)
      const trusted = new URL(await approvalUrl(this.request))
      let destination: URL
      try { destination = new URL(ticket.uploadUrl) } catch (_cause: unknown) { return invalid() }
      if (destination.origin !== trusted.origin || destination.pathname !== '/mcp/connections/upload'
        || destination.search || destination.hash || destination.username || destination.password) invalid()
      try {
        const response = await this.request(destination.href, { method: 'POST', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', headers: { authorization: `Bearer ${ticket.ticket}`,
            'content-type': 'application/octet-stream', accept: 'application/json' }, body: bytes })
        return result(await this.json(response), expectedCheck)
      } catch (cause) {
        this.uncertainUploads.set(metadata.requestId, fingerprint)
        const prior = await this.receipt(metadata.requestId, expectedCheck)
        if (prior !== null) { this.uncertainUploads.delete(metadata.requestId); return prior }
        if (cause instanceof PersonalMcpConnectionRequestError && cause.status < 500) {
          this.uncertainUploads.delete(metadata.requestId)
          throw cause
        }
        throw new PersonalMcpConnectionRequestError(503, 'personalMcpMutationUncertain')
      }
    } finally { bytes.fill(0) }
  }

  /** @param query - original Port pagination; the frozen service supplies one bounded list. @param signal - canceled read. @returns live masked connections and latest checks. */
  async list(query: { readonly limit?: number; readonly cursor?: string } = {}, signal?: AbortSignal): Promise<PersonalMcpConnectionPage> {
    if (query.cursor !== undefined) throw new PersonalMcpConnectionRequestError(400)
    const value = await this.post('mcpConnectionsList', {}, signal)
    if (!exact(value, ['available', 'items']) || typeof value.available !== 'boolean' || !Array.isArray(value.items)) invalid()
    const items = value.items.map(row => {
      if (!exact(row, ['connection', 'latestCheck'])) invalid()
      const item = connection(row.connection)
      return { ...item, latest_check: row.latestCheck === null ? null
        : check(row.latestCheck, { connectionId: item.connection_id, draft: false }) }
    })
    if (new Set(items.map(item => item.connection_id)).size !== items.length) invalid()
    return { available: value.available, items }
  }

  /** @param input - browser-local form fields. @param id - stable user submission ID. @returns masked created metadata. */
  async create(input: PersonalMcpConnectionCreateRequest, id: string): Promise<PersonalMcpConnection> {
    requestId(id)
    const value = await this.write('create', { requestId: id, configuration: configuration(input, false) }, credentialBody(input))
    if (value.kind !== 'connection') invalid()
    this.matches(value.item, input)
    return value.item
  }

  /** @param connectionId - edited connection. @param input - browser-local versioned edit. @param id - stable user submission ID. @returns masked edited metadata. */
  async update(connectionId: string, input: PersonalMcpConnectionUpdateRequest, id: string): Promise<PersonalMcpConnection> {
    requestId(id); requestId(connectionId)
    const value = await this.write('update', { requestId: id, connectionId, baseRevision: input.expected_revision,
      configuration: editedConfiguration(input) }, credentialBody(input))
    if (value.kind !== 'connection' || value.item.connection_id !== connectionId || value.item.revision <= input.expected_revision) invalid()
    this.matches(value.item, input)
    return value.item
  }

  private matches(item: PersonalMcpConnection, input: PersonalMcpConnectionCreateRequest): void {
    if (item.display_name !== input.display_name || new URL(item.server_url).href !== new URL(input.server_url).href
      || item.enabled !== input.enabled || item.authentication.kind !== input.authentication.kind) invalid()
  }

  /** @param connectionId - target connection. @param expectedRevision - current authority revision. @param enabled - next enabled state. @param id - stable request ID. @returns updated masked metadata. */
  async toggle(connectionId: string, expectedRevision: number, enabled: boolean, id: string): Promise<PersonalMcpConnection> {
    requestId(id); requestId(connectionId)
    const item = connection(await this.post('mcpConnectionsToggle', { requestId: id, connectionId, baseRevision: expectedRevision, enabled }))
    if (item.connection_id !== connectionId || item.enabled !== enabled || item.revision <= expectedRevision) invalid()
    return item
  }

  /** @param connectionId - soft-deleted target. @param expectedRevision - current authority revision. @param id - stable request ID. */
  async remove(connectionId: string, expectedRevision: number, id: string): Promise<void> {
    requestId(id); requestId(connectionId)
    const item = connection(await this.post('mcpConnectionsDelete', { requestId: id, connectionId, baseRevision: expectedRevision }), true)
    if (item.connection_id !== connectionId || item.enabled || item.revision <= expectedRevision) invalid()
  }

  /** @param connectionId - saved target. @param input - fixed revision and Session. @param id - stable request ID. @returns the exact saved check. */
  async createCheck(connectionId: string, input: PersonalMcpConnectionCheckDraftRequest, id: string): Promise<PersonalMcpConnectionCheck> {
    requestId(id); requestId(connectionId); requestId(input.session_id)
    if (input.connection_id !== connectionId || !positive(input.expected_revision)) throw new PersonalMcpConnectionRequestError(400)
    return check(await this.post('mcpConnectionsCheck', { requestId: id, connectionId,
      baseRevision: input.expected_revision, sessionId: input.session_id }), { connectionId, sessionId: input.session_id, draft: false })
  }

  /** @param input - immutable unsaved form and Session. @param id - stable draft submission ID. @returns its independent check. */
  async createDraftCheck(input: PersonalMcpConnectionCheckDraftRequest, id: string): Promise<PersonalMcpConnectionCheck> {
    requestId(id); requestId(input.session_id)
    if ((input.connection_id === undefined) !== (input.expected_revision === undefined)) throw new PersonalMcpConnectionRequestError(400)
    if (input.connection_id !== undefined) requestId(input.connection_id)
    const value = await this.write('draft', { requestId: id, sessionId: input.session_id,
      configuration: configuration(input.configuration, input.connection_id !== undefined), ...(input.connection_id === undefined ? {}
        : { sourceConnectionId: input.connection_id, baseRevision: input.expected_revision }) }, credentialBody(input.configuration))
    if (value.kind !== 'check') invalid()
    return value.item
  }

  /** @param connectionId - saved target. @param checkId - exact check. @param signal - canceled read. @returns durable saved-check state. */
  async getCheck(connectionId: string, checkId: string, signal?: AbortSignal): Promise<PersonalMcpConnectionCheck> {
    requestId(connectionId); requestId(checkId)
    return check(await this.post('mcpConnectionsCheckStatus', { checkId }, signal), { connectionId, checkId, draft: false })
  }

  /** @param connectionId - saved target. @param checkId - exact idempotent cancellation key. @param _id - original Port ID, not sent on this route. @returns durable state. */
  async cancelCheck(connectionId: string, checkId: string, _id: string): Promise<PersonalMcpConnectionCheck> {
    requestId(connectionId); requestId(checkId)
    return check(await this.post('mcpConnectionsCheckCancel', { checkId }), { connectionId, checkId, draft: false })
  }

  /** @param checkId - independent draft check. @param signal - canceled read. @returns durable state. */
  async getDraftCheck(checkId: string, signal?: AbortSignal): Promise<PersonalMcpConnectionCheck> {
    requestId(checkId)
    return check(await this.post('mcpConnectionsCheckStatus', { checkId }, signal), { checkId, draft: true })
  }

  /** @param checkId - exact idempotent cancellation key. @param _id - original Port ID, not sent on this route. @returns durable state. */
  async cancelDraftCheck(checkId: string, _id: string): Promise<PersonalMcpConnectionCheck> {
    requestId(checkId)
    return check(await this.post('mcpConnectionsCheckCancel', { checkId }), { checkId, draft: true })
  }
}
