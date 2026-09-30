/** Locale-owned projections of saved MCP discovery results. */
import type { PersonalMcpConnection, PersonalMcpConnectionCheck,
  PersonalMcpConnectionCheckErrorCode } from './personal-mcp-client.ts'
import type { ExtensionCenterLocaleKey } from './locales.ts'

const errorLabels = {
  MCP_DNS_FAILED: 'mcpCheckErrorDns', MCP_CONNECT_TIMEOUT: 'mcpCheckErrorConnectTimeout',
  MCP_TLS_FAILED: 'mcpCheckErrorTls', MCP_AUTH_REJECTED: 'mcpCheckErrorAuth',
  MCP_PROTOCOL_INVALID: 'mcpCheckErrorProtocol', MCP_DISCOVERY_FAILED: 'mcpCheckErrorDiscovery',
  MCP_RESPONSE_LIMIT: 'mcpCheckErrorResponseLimit', MCP_CANCELED: 'mcpCheckErrorCanceled',
  MCP_CONNECTION_FAILED: 'mcpCheckErrorGeneric', MCP_SCHEMA_UNSUPPORTED: 'mcpCheckErrorSchemaUnsupported',
  MCP_TASKS_UNSUPPORTED: 'mcpCheckErrorTasksUnsupported', MCP_TOOL_SIZE_LIMIT: 'mcpCheckErrorToolSizeLimit',
  MCP_DESCRIPTION_SIZE_LIMIT: 'mcpCheckErrorDescriptionSizeLimit', MCP_TOOL_NAME_CONFLICT: 'mcpCheckErrorToolNameConflict',
  MCP_CATALOG_LIMIT: 'mcpCheckErrorCatalogLimit', MCP_TOOL_DUPLICATE: 'mcpCheckErrorToolDuplicate',
  MCP_TOOL_COLLISION: 'mcpCheckErrorToolCollision', MCP_CHECK_STALE: 'mcpCheckErrorStale',
  MCP_CONNECTION_UNAVAILABLE: 'mcpCheckErrorConnectionUnavailable', MCP_CHECK_SNAPSHOT_FAILED: 'mcpCheckErrorSnapshot',
  MCP_CHECK_EXPIRED: 'mcpCheckErrorExpired', MCP_REQUEST_LIMIT: 'mcpCheckErrorRequestLimit',
  MCP_INVALID_CONFIG: 'mcpCheckErrorConfig', MCP_INVALID_ENDPOINT: 'mcpCheckErrorEndpoint',
  MCP_INVALID_HEADERS: 'mcpCheckErrorHeaders', MCP_ADDRESS_DENIED: 'mcpCheckErrorAddressDenied',
  MCP_INVALID_CATALOG: 'mcpCheckErrorInvalidCatalog', MCP_TOOL_NOT_FOUND: 'mcpCheckErrorToolNotFound',
  MCP_ENDPOINT_CHANGED: 'mcpCheckErrorEndpointChanged', MCP_REDIRECT_DENIED: 'mcpCheckErrorRedirectDenied',
  MCP_UNSUPPORTED_RESPONSE: 'mcpCheckErrorUnsupportedResponse', MCP_TRANSPORT_FAILED: 'mcpCheckErrorTransport',
  MCP_CHECK_TIMEOUT: 'mcpCheckErrorTimeout', MCP_CHECK_ABORTED: 'mcpCheckErrorAborted',
  MCP_DISPATCH_REJECTED: 'mcpCheckErrorDispatchRejected', MCP_CALLBACK_UNCERTAIN: 'mcpCheckErrorCallbackUncertain',
  MCP_DISPATCH_REPLAY_DENIED: 'mcpCheckErrorReplayDenied',
} as const satisfies Record<PersonalMcpConnectionCheckErrorCode, ExtensionCenterLocaleKey>

/** Resolve only a sanitized fixed refusal code for both saved and draft check results.
 * @param code - browser adapter's allowlisted check failure. @returns its locale-owned explanation.
 */
export function personalMcpCheckErrorLabel(code: PersonalMcpConnectionCheckErrorCode): ExtensionCenterLocaleKey {
  return errorLabels[code]
}

/** Match saved discovery material; enablement-only authority revisions do not change that material.
 * @param connection - current saved metadata. @param check - historical saved check, never a draft.
 * @returns whether its connection, configuration or credentials differ from the current material.
 */
export function personalMcpSavedCheckIsStale(connection: PersonalMcpConnection, check: PersonalMcpConnectionCheck): boolean {
  return check.connection_id !== connection.connection_id
    || check.configuration_revision !== (connection.configuration_revision ?? connection.revision)
    || check.credential_revision !== undefined && connection.credential_revision !== undefined
      && check.credential_revision !== connection.credential_revision
}

/** Localized check status with its original revision and zero-tool result retained. */
export interface PersonalMcpCheckView {
  readonly state: 'never' | NonNullable<PersonalMcpConnection['latest_check']>['state']
  readonly label: ExtensionCenterLocaleKey
  readonly stale: boolean
  readonly discoveredTools: number | null
  readonly errorLabel?: ExtensionCenterLocaleKey
}

/** Project a saved check without converting stale or empty results to failures.
 * @param connection - saved metadata and latest check. @returns locale keys and durable status.
 */
export function personalMcpCheckView(connection: PersonalMcpConnection): PersonalMcpCheckView {
  const check = connection.latest_check
  if (check === null) {
    return {
      state: 'never', label: 'mcpCheckNever', stale: false, discoveredTools: null,
    }
  }
  const labels = {
    queued: 'mcpCheckQueued',
    running: 'mcpCheckRunning',
    succeeded: check.discovered_tools === 0
      ? 'mcpCheckSucceededZero'
      : check.discovered_tools === null ? 'mcpCheckSucceededUnknown' : 'personalMcpCheckSucceeded',
    failed: 'personalMcpCheckFailed',
    canceled: 'mcpCheckCanceled',
    timed_out: 'mcpCheckTimedOut',
    expired: 'mcpCheckExpired',
  } as const
  return {
    state: check.state,
    label: labels[check.state],
    stale: personalMcpSavedCheckIsStale(connection, check),
    discoveredTools: check.discovered_tools,
    ...(check.error_code === null ? {} : { errorLabel: personalMcpCheckErrorLabel(check.error_code) }),
  }
}
