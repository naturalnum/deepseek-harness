/** Browser-local MCP page fields and metadata/credential-separated operations. */
import type { ExtensionCenterLocaleKey } from './locales.ts'

/** Maximum URL length accepted by the original personal MCP form. */
export const PERSONAL_MCP_CONNECTION_SERVER_URL_MAX_LENGTH = 2048

/** Account-owned check states displayed by the original MCP page. */
export type PersonalMcpConnectionCheckState =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'expired'

/** Sanitized discovery errors understood by the page. */
export type PersonalMcpConnectionCheckErrorCode =
  | 'MCP_DNS_FAILED' | 'MCP_CONNECT_TIMEOUT' | 'MCP_TLS_FAILED' | 'MCP_AUTH_REJECTED'
  | 'MCP_PROTOCOL_INVALID' | 'MCP_DISCOVERY_FAILED' | 'MCP_RESPONSE_LIMIT'
  | 'MCP_CANCELED' | 'MCP_CONNECTION_FAILED'

/** Write-only authentication status; the Port never returns credential values. */
export type PersonalMcpConnectionAuthentication =
  | { readonly kind: 'none'; readonly secret_configured: false }
  | { readonly kind: 'bearer' | 'headers'; readonly secret_configured: boolean }

/** A durable connection or draft check projected into the original page fields. */
export interface PersonalMcpConnectionCheck {
  readonly check_id: string
  readonly connection_id: string | null
  readonly configuration_revision: number
  readonly state: PersonalMcpConnectionCheckState
  readonly error_code: PersonalMcpConnectionCheckErrorCode | null
  readonly discovered_tools: number | null
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly cancel_requested?: boolean
  readonly credential_revision?: number | null
}

/** Masked header metadata shown when editing an existing connection. */
export interface PersonalMcpMaskedHeader {
  readonly name: string
  readonly value_configured: boolean
}

/** Original UI projection; this is a page Port type, not a wire DTO. */
export interface PersonalMcpConnection {
  readonly connection_id: string
  readonly revision: number
  readonly configuration_revision?: number
  readonly credential_revision?: number | null
  readonly display_name: string
  readonly server_name: string
  readonly server_url: string
  readonly headers?: readonly PersonalMcpMaskedHeader[]
  readonly authentication: PersonalMcpConnectionAuthentication
  readonly enabled: boolean
  readonly latest_check: PersonalMcpConnectionCheck | null
  readonly created_at: string
  readonly updated_at: string
}

/** Return only saved header names and whether a value is configured.
 * @param connection - masked connection projection.
 * @returns masked headers, or an empty list for other authentication kinds.
 */
export function personalMcpHeaders(connection: PersonalMcpConnection): readonly PersonalMcpMaskedHeader[] {
  return connection.headers ?? []
}

/** Form-local header write; an omitted value preserves an unchanged saved name. */
export interface PersonalMcpHeaderInput {
  readonly name: string
  readonly value?: string
}

/** Form submission consumed only by the browser adapter; secrets go directly to Platform. */
export interface PersonalMcpConnectionCreateRequest {
  readonly display_name: string
  readonly server_url: string
  readonly authentication: { readonly kind: 'none' | 'bearer' | 'headers' }
  readonly headers?: readonly PersonalMcpHeaderInput[]
  readonly secrets?: { readonly bearer_token?: string }
  readonly clear_secret_keys?: readonly 'bearer_token'[]
  readonly enabled: boolean
}

/** Form-local edit with an explicit saved revision and optional credential clearing. */
export interface PersonalMcpConnectionUpdateRequest extends PersonalMcpConnectionCreateRequest {
  readonly expected_revision: number
}

/** One original-page list page. */
export interface PersonalMcpConnectionPage {
  readonly available?: boolean
  readonly items: readonly PersonalMcpConnection[]
  readonly nextCursor?: string
}

/** Frozen form input used by a check; it is not an Operation or execution grant. */
export interface PersonalMcpConnectionCheckDraftRequest {
  readonly session_id: string
  readonly configuration: PersonalMcpConnectionCreateRequest
  readonly connection_id?: string
  readonly expected_revision?: number
}

/** Browser page operations. Implementations must separate Host metadata from Platform credentials. */
export interface PersonalMcpConnectionPort {
  /** @param query - original list pagination. @param signal - canceled read. @returns bounded masked metadata. */
  list(query?: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal): Promise<PersonalMcpConnectionPage>
  /** @param input - browser-local fields. @param requestId - immutable submission ID. @returns saved masked metadata. */
  create(input: PersonalMcpConnectionCreateRequest, requestId: string): Promise<PersonalMcpConnection>
  /** @param connectionId - saved target. @param input - versioned edit. @param requestId - immutable submission ID. @returns edited masked metadata. */
  update(connectionId: string, input: PersonalMcpConnectionUpdateRequest, requestId: string): Promise<PersonalMcpConnection>
  /** @param connectionId - saved target. @param expectedRevision - authority revision. @param enabled - next state. @param requestId - immutable submission ID. @returns updated metadata. */
  toggle(connectionId: string, expectedRevision: number, enabled: boolean, requestId: string): Promise<PersonalMcpConnection>
  /** @param connectionId - saved target. @param expectedRevision - authority revision. @param requestId - immutable submission ID. */
  remove(connectionId: string, expectedRevision: number, requestId: string): Promise<void>
  /** @param connectionId - saved target. @param input - exact Session and revision. @param requestId - immutable submission ID. @returns its saved check. */
  createCheck(connectionId: string, input: PersonalMcpConnectionCheckDraftRequest, requestId: string): Promise<PersonalMcpConnectionCheck>
  /** @param connectionId - saved target. @param checkId - exact check. @param signal - canceled read. @returns durable state. */
  getCheck(connectionId: string, checkId: string, signal?: AbortSignal): Promise<PersonalMcpConnectionCheck>
  /** @param connectionId - saved target. @param checkId - exact check. @param requestId - original Port cancellation ID. @returns durable state. */
  cancelCheck(connectionId: string, checkId: string, requestId: string): Promise<PersonalMcpConnectionCheck>
  /** @param input - immutable draft and Session. @param requestId - immutable submission ID. @returns an independent draft check. */
  createDraftCheck(input: PersonalMcpConnectionCheckDraftRequest, requestId: string): Promise<PersonalMcpConnectionCheck>
  /** @param checkId - exact draft check. @param signal - canceled read. @returns durable state. */
  getDraftCheck(checkId: string, signal?: AbortSignal): Promise<PersonalMcpConnectionCheck>
  /** @param checkId - exact draft check. @param requestId - original Port cancellation ID. @returns durable state. */
  cancelDraftCheck(checkId: string, requestId: string): Promise<PersonalMcpConnectionCheck>
}

/** Sanitized browser adapter error with locale-owned product copy. */
export class PersonalMcpConnectionRequestError extends Error {
  /** @param status - failed HTTP status. @param label - safe localized message key. */
  constructor(readonly status: number, readonly label: ExtensionCenterLocaleKey = status === 401
    ? 'sessionExpired' : status === 409 ? 'mcpRevisionConflict' : 'mcpLoadFailed') {
    super(`MCP request failed: ${status}`)
    this.name = 'PersonalMcpConnectionRequestError'
  }
}

/** Allocate an identifier for one explicitly started check.
 * @returns a browser-generated request UUID preserved across uncertain retries.
 */
export function createPersonalMcpCheckIdempotencyKey(): string {
  return globalThis.crypto.randomUUID()
}
