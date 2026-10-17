/** Wire consistency inputs and authentication-library output consumed by access. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Client expectations confer no identity, resource scope, or native capability. */
export interface RequestExpectation {
  readonly accountId: string
  readonly connectionGeneration: string
}

/** All occurrences from the selected carrier; duplicates must survive extraction. */
export interface RequestExpectationValues {
  readonly accountIds: readonly string[]
  readonly connectionGenerations: readonly string[]
}

/** Dedicated carrier field names, selected together with the product transport. */
export interface BindingFieldNames {
  accountHeader: string
  generationHeader: string
  accountQuery: string
  generationQuery: string
}

/** Trusted output of a database-backed authentication-library adapter, never client JSON. */
export interface AuthenticatedPrincipal {
  readonly accountId: AccountId
  readonly authSessionId: Branded<'pe-auth-session-id'>
}

/** Public deployment inputs; authentication secrets are referenced, not embedded. */
export interface AccessConfig {
  publicOrigin: string
  deploymentMode: 'development' | 'production'
  trustedProxyAddresses: string[]
  authSecretRef: string
  sessionRecheckMs: number
  authCheckTimeoutMs: number
  maxPeers: number
  maxPeersPerAccount: number
  maxPeerWaiters: number
  maxPeerWaitersPerAccount: number
  maxPeerCarriers: number
  maxPeerCarriersPerAccount: number
  maxPeerCarriersPerLogin: number
  peerCloseTimeoutMs: number
  maxAuthOperations: number
  maxTrackedLogins: number
  maxTrackedLoginsPerAccount: number
  maxAuthInvalidations: number
  bindingFields: BindingFieldNames
}

/** C-01 failure fields contain no credentials, expected identities, or internal paths. */
export interface RequestBindingFailure {
  readonly code: 'cloud/stale-generation'
  readonly message: string
  readonly requestId: Branded<'pe-request-id'>
  readonly retry: 'after-status-check'
}
