/** Write-only MCP form validation and browser-local submission fields. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  PERSONAL_MCP_CONNECTION_SERVER_URL_MAX_LENGTH,
  type PersonalMcpConnection,
  type PersonalMcpConnectionCreateRequest,
  type PersonalMcpConnectionUpdateRequest,
} from './personal-mcp-client.ts'
import { personalMcpHeaders } from './personal-mcp-client.ts'

/** Authentication choices supported by the original remote MCP form. */
export type PersonalMcpAuthenticationKind = 'none' | 'bearer' | 'headers'

/** Editable write-only header row with its saved name retained separately. */
export interface PersonalMcpHeaderFormValue {
  readonly id: string
  readonly name: string
  readonly value: string
  readonly savedName?: string
}

/** Browser-local form state; credential values never enter a Host request. */
export interface PersonalMcpFormValue {
  readonly presentation?: import('@power-evolve/contracts/mcp-metadata').McpPresentation
  readonly displayName: string
  readonly serverUrl: string
  readonly authenticationKind: PersonalMcpAuthenticationKind
  readonly bearerToken: string
  readonly clearBearerSecret: boolean
  readonly headers: readonly PersonalMcpHeaderFormValue[]
  readonly enabled: boolean
}

/** Locale-owned validation issue shown beside the original form fields. */
export type PersonalMcpFormIssue =
  | 'display-name'
  | 'server-url'
  | 'bearer-token'
  | 'header-name'
  | 'header-value'
  | 'header-duplicate'
  | 'header-limit'

/** Create an empty disabled form. @returns new browser-local field values. */
export function emptyPersonalMcpForm(): PersonalMcpFormValue {
  return {
    displayName: '', serverUrl: '', authenticationKind: 'none', bearerToken: '',
    clearBearerSecret: false, headers: [], enabled: false,
  }
}

/** Prefill metadata and saved names without echoing a credential.
 * @param connection - masked saved connection. @returns write-only edit fields.
 */
export function personalMcpFormFromConnection(connection: PersonalMcpConnection): PersonalMcpFormValue {
  const kind = connection.authentication.kind
  return {
    ...(connection.presentation === undefined ? {} : { presentation: connection.presentation }),
    displayName: connection.display_name,
    serverUrl: connection.server_url,
    authenticationKind: kind,
    bearerToken: '',
    clearBearerSecret: false,
    headers: personalMcpHeaders(connection).map((header, index) => ({
      id: `saved-${String(index)}`,
      name: header.name,
      value: '',
      savedName: header.name,
    })),
    enabled: connection.enabled,
  }
}

/** Allocate a new editable header row.
 * @param index - row ordinal. @returns an empty row with a stable local key.
 */
export function newPersonalMcpHeader(index: number): PersonalMcpHeaderFormValue {
  return { id: `new-${String(index)}-${randomUUID()}`, name: '', value: '' }
}

/** Validate the original form fields before handing them to the browser Port.
 * @param form - edited browser-local fields.
 * @param current - saved metadata that permits retaining existing authentication.
 * @returns the first validation issue, or undefined.
 */
export function validatePersonalMcpForm(
  form: PersonalMcpFormValue,
  current?: PersonalMcpConnection,
): PersonalMcpFormIssue | undefined {
  const name = form.displayName.trim().normalize('NFC')
  if (name.length === 0 || Array.from(name).length > 100 || Array.from(name).some(controlCharacter)) {
    return 'display-name'
  }
  try {
    const serverUrl = form.serverUrl.trim()
    if (serverUrl.length > PERSONAL_MCP_CONNECTION_SERVER_URL_MAX_LENGTH) return 'server-url'
    const url = new URL(serverUrl)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== '' || url.hash !== ''
      || url.href.length > PERSONAL_MCP_CONNECTION_SERVER_URL_MAX_LENGTH) return 'server-url'
  } catch { return 'server-url' }
  if (new TextEncoder().encode(form.bearerToken).byteLength > 8192
    || Array.from(form.bearerToken).some(controlCharacter)) return 'bearer-token'
  const hasExisting = current?.authentication.kind === 'bearer'
    && current.authentication.secret_configured
  if (form.authenticationKind === 'bearer' && form.enabled
    && (form.clearBearerSecret || form.bearerToken.length === 0 && !hasExisting)) {
    return 'bearer-token'
  }
  if (form.authenticationKind !== 'headers') return undefined
  if (form.headers.length > 16) return 'header-limit'
  const names = new Set<string>()
  for (const header of form.headers) {
    const headerName = header.name.trim()
    if (headerName.length === 0 || headerName.length > 200
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(headerName)) return 'header-name'
    const normalized = headerName.toLowerCase()
    if (names.has(normalized)) return 'header-duplicate'
    names.add(normalized)
    if (new TextEncoder().encode(header.value).byteLength > 8192
      || Array.from(header.value).some(controlCharacter)) return 'header-value'
    const preserving = header.value === '' && header.savedName?.toLowerCase() === normalized
    if (header.value === '' && !preserving) return 'header-value'
  }
  return undefined
}

/** Normalize metadata while preserving the exact credential bytes locally.
 * @param form - browser-local fields.
 * @param current - saved metadata for explicit credential clearing in an edit draft.
 * @returns a browser Port input, not a Host wire request.
 */
export function buildPersonalMcpCreateRequest(
  form: PersonalMcpFormValue,
  current?: PersonalMcpConnection,
): PersonalMcpConnectionCreateRequest {
  const kind = form.authenticationKind === 'headers' && form.headers.length === 0
    ? 'none'
    : form.authenticationKind
  return {
    ...(form.presentation === undefined ? {} : { presentation: form.presentation }),
    display_name: form.displayName.trim().normalize('NFC'),
    server_url: form.serverUrl.trim(),
    authentication: { kind },
    ...(kind === 'bearer' && form.bearerToken.length > 0
      ? { secrets: { bearer_token: form.bearerToken } }
      : {}),
    ...(kind === 'bearer' && form.bearerToken.length === 0 && (form.clearBearerSecret
      || current !== undefined && (current.authentication.kind !== 'bearer' || !current.authentication.secret_configured))
      ? { clear_secret_keys: ['bearer_token'] as const } : {}),
    ...(kind === 'headers' ? { headers: serializeHeaders(form.headers) } : {}),
    enabled: form.enabled,
  }
}

/** Build an explicit retain, replace, or clear edit for the browser adapter.
 * @param form - browser-local edited fields.
 * @param current - saved revision and masked authentication status.
 * @returns a browser Port edit, not a Host wire request.
 */
export function buildPersonalMcpUpdateRequest(
  form: PersonalMcpFormValue,
  current: PersonalMcpConnection,
): PersonalMcpConnectionUpdateRequest {
  const kind = form.authenticationKind === 'headers' && form.headers.length === 0
    ? 'none'
    : form.authenticationKind
  const currentKind = current.authentication.kind
  const writingToken = kind === 'bearer' && form.bearerToken.length > 0
  const clearingToken = !writingToken && (form.clearBearerSecret
    || kind === 'bearer' && (currentKind !== 'bearer' || !current.authentication.secret_configured)
    || kind !== 'bearer' && currentKind === 'bearer' && current.authentication.secret_configured)
  return {
    expected_revision: current.revision,
    ...(form.presentation === undefined ? {} : { presentation: form.presentation }),
    display_name: form.displayName.trim().normalize('NFC'),
    server_url: form.serverUrl.trim(),
    authentication: { kind },
    ...(writingToken ? { secrets: { bearer_token: form.bearerToken } } : {}),
    ...(clearingToken ? { clear_secret_keys: ['bearer_token'] } : {}),
    ...(kind === 'headers' ? { headers: serializeHeaders(form.headers) } : {}),
    enabled: form.enabled,
  }
}

/** Match only saved connection names, prefixes, and URLs.
 * @param connection - saved metadata. @param search - entered query. @returns whether the row matches.
 */
export function matchesPersonalMcpSearch(connection: PersonalMcpConnection, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  if (query.length === 0) return true
  return [connection.display_name, connection.server_name, connection.server_url]
    .some(value => value.toLocaleLowerCase().includes(query))
}

function serializeHeaders(headers: readonly PersonalMcpHeaderFormValue[]): readonly {
  readonly name: string
  readonly value?: string
}[] {
  return headers.map(header => ({
    name: header.name.trim(),
    ...(header.value === '' ? {} : { value: header.value }),
  }))
}

function controlCharacter(character: string): boolean {
  const point = character.charCodeAt(0)
  return point < 32 || point >= 127 && point <= 159
}
