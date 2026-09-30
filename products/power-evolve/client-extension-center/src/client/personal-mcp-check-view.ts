/** Locale-owned projections of saved MCP discovery results. */
import type { PersonalMcpConnection } from './personal-mcp-client.ts'
import type { ExtensionCenterLocaleKey } from './locales.ts'

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
  const errorLabels = {
    MCP_DNS_FAILED: 'mcpCheckErrorDns',
    MCP_CONNECT_TIMEOUT: 'mcpCheckErrorConnectTimeout',
    MCP_TLS_FAILED: 'mcpCheckErrorTls',
    MCP_AUTH_REJECTED: 'mcpCheckErrorAuth',
    MCP_PROTOCOL_INVALID: 'mcpCheckErrorProtocol',
    MCP_DISCOVERY_FAILED: 'mcpCheckErrorDiscovery',
    MCP_RESPONSE_LIMIT: 'mcpCheckErrorResponseLimit',
    MCP_CANCELED: 'mcpCheckErrorCanceled',
    MCP_CONNECTION_FAILED: 'mcpCheckErrorGeneric',
  } as const
  return {
    state: check.state,
    label: labels[check.state],
    stale: check.configuration_revision !== (connection.configuration_revision ?? connection.revision)
      || check.credential_revision !== undefined && connection.credential_revision !== undefined
        && check.credential_revision !== connection.credential_revision,
    discoveredTools: check.discovered_tools,
    ...(check.error_code === null ? {} : { errorLabel: errorLabels[check.error_code] }),
  }
}
