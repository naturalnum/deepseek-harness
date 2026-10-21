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
  /** Fixed isolated GET preview origin and shared session-cookie suffix; omission preserves host-only cookies. */
  servicePreview?: Readonly<{ origin: string; cookieDomain: string }>
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

/** Descriptive feature availability; no state confers server authorization or account readiness. */
export type BootstrapCapability =
  | Readonly<{ state: 'available' }>
  | Readonly<{ state: 'disabled'; reason: 'not-approved' }>
  | Readonly<{ state: 'temporarily-unavailable'; reason: 'channel-unavailable' }>

/** Actual approved subprocess modes and consumer identifiers, supplied by the server. */
export interface BootstrapSubprocessCapabilities {
  readonly spawn: boolean
  readonly pipes: boolean
  readonly control: boolean
  readonly inherit: boolean
  readonly terminal: boolean
  readonly consumers: readonly string[]
}

/** One approved plugin's public installation controls; no import path or configuration values. */
export interface BootstrapPlugin {
  readonly id: string
  readonly installable: boolean
  readonly toggleable: boolean
}

/** A configuration field description; its application level never authorizes a submission. */
export interface BootstrapConfigurationField {
  readonly namespace: string
  readonly path: string
  readonly application: 'live' | 'local-remount' | 'graph-rebuild'
}

/** Sanitized configuration controls; no values, schemas, credentials or backend code locations. */
export interface BootstrapConfiguration {
  readonly catalogVersion: string
  readonly plugins: readonly BootstrapPlugin[]
  readonly skills: Readonly<{ manage: boolean }>
  readonly credentials: Readonly<{ write: boolean }>
  readonly fields: readonly BootstrapConfigurationField[]
}

/** C-11 metadata from the server's actual recipe and providers; decoding does not verify those facts. */
export interface BootstrapCapabilities {
  readonly projects: BootstrapCapability
  readonly filePreview: BootstrapCapability
  readonly shell: BootstrapCapability
  readonly developmentServices: BootstrapCapability
  readonly servicePreview: BootstrapCapability
  readonly sandboxScope: 'session'
  readonly backgroundJobs: false
  readonly localDesktop: false
  readonly arbitraryBackendPlugins: false
  readonly subprocess: BootstrapSubprocessCapabilities
  readonly configuration: BootstrapConfiguration
}

/** Browser wire metadata, distinct from the adapter-origin-tracked AuthenticatedPrincipal. */
export interface CloudBootstrap {
  readonly account: Readonly<{ id: string; displayName: string }>
  readonly recipeVersion: string
  readonly connectionGeneration: string
  readonly capabilities: BootstrapCapabilities
}

/** Explicit decoder budgets; the caller still bounds raw response bytes before JSON.parse. */
export interface BootstrapDecodeLimits {
  /** Maximum UTF-8 bytes of the complete compact validated JSON result, including keys and delimiters. */
  readonly maxBodyBytes: number
  /** Maximum UTF-8 bytes per string value, including protocol string values. */
  readonly maxStringBytes: number
  /** Combined maximum entries across consumers, plugins and configuration fields; zero permits only empty lists. */
  readonly maxListItems: number
}

/** Safe actual registration observation consumed by root recipe audit, without calling that audit recursively. */
export interface IngressObservation {
  readonly state: 'absent' | 'prepared' | 'installing' | 'installed' | 'closing' | 'closed' | 'unknown'
  readonly current: boolean
  readonly registeredRoutes: number
  readonly pendingOperations: number
}
