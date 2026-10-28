/** Public browser limits; authentication and request-binding types belong to access. */
import type { BindingFieldNames, BootstrapDecodeLimits } from '@deepseek-ai/dsh-pe-cloud-access/types'

/** Root-owned public inputs for one exact GET preview entry; no account identity or application target. */
export interface CloudServicePreviewPolicy {
  /** Exact HTTP(S) management origin; must match the captured transport's origin. */
  readonly managementOrigin: string
  /** Exact preview origin using the management protocol and a different hostname. */
  readonly previewOrigin: string
  /** Fixed GET entry path: `/cloud/service-preview`. */
  readonly routePath: string
  /** Maximum UTF-8 bytes per Session, service-handle, account or generation value in the preview URL. */
  readonly maxFieldBytes: number
  /** Maximum UTF-8 bytes in the complete serialized preview URL, including query fields. */
  readonly maxUrlBytes: number
}

/** Explicit finite UTF-8 budgets; total includes the physical key and serialized envelope. */
export interface CloudPersistenceLimits {
  /** Maximum logical entries stored in one account/generation namespace. */
  readonly maxKeys: number
  /** Maximum UTF-8 bytes in one logical storage key. */
  readonly maxKeyBytes: number
  /** Maximum UTF-8 bytes in one logical stored value. */
  readonly maxValueBytes: number
  /** Maximum combined UTF-8 bytes of the physical storage key and serialized version/entries envelope. */
  readonly maxTotalBytes: number
  /** Maximum UTF-8 bytes of the physical namespace key, including its prefix and account/generation encoding. */
  readonly maxNamespaceBytes: number
}

/** Explicit observer and complete-file memory bounds for the fixed sample editor. */
export interface CloudSkillSettingsConfig {
  /** Positive safe-integer RPC observation deadline within the platform timer range. */
  readonly requestTimeoutMs: number
  /** Positive safe-integer acceptance cap for each complete file; match the approved account bound. */
  readonly maxFileBytes: number
}

/** Explicit original browser controls supplied by the cloud deployment; selection grants no server capability. */
export type CloudNativeSessionControl = 'commands' | 'models' | 'permissions' | 'goals' | 'plan' | 'feedback' | 'export' | 'attachments'

/** Finite public configuration for bootstrap and one captured native carrier. */
export interface CloudClientConfig {
  /** Document-relative route without query or fragment; Web manifests require `cloud/bootstrap`. */
  bootstrapPath: string
  /** Bootstrap abort deadline in milliseconds; actual carrier cleanup can settle later. */
  bootstrapTimeoutMs: number
  /** Maximum bootstrap response-body bytes accepted before UTF-8 JSON decoding. */
  maxBootstrapResponseBytes: number
  /** Maximum body bytes read from a 409 response while checking for stale generation. */
  maxErrorResponseBytes: number
  /** Maximum concurrent fetch operations tracked by one bound transport. */
  maxPendingFetches: number
  /** Maximum concurrent WebSocket instances tracked by one bound transport. */
  maxSockets: number
  /** Milliseconds to await carrier cleanup and revalidation on close; expiry leaves cleanup unconfirmed. */
  closeTimeoutMs: number
  /** Optional complete-file download acceptance cap; absence keeps download actions unregistered. */
  maxDownloadBytes?: number
  /** Finite native model-settings RPC observer deadline; omission keeps model editing closed. */
  modelSettingsRequestTimeoutMs?: number
  /** Omission leaves the native sample skill section unregistered. */
  skillSettings?: Readonly<CloudSkillSettingsConfig>
  /** Original browser control groups; omission preserves the existing first-screen roster. */
  nativeSessionControls?: readonly CloudNativeSessionControl[]
  /** Omission keeps preview navigation closed, independently of descriptive bootstrap availability. */
  servicePreview?: Readonly<CloudServicePreviewPolicy>
}

/** Public deployment inputs for the existing Web entry; contains no login or account state. */
export interface CloudWebManifest {
  /** Explicit bootstrap and bound-transport limits, with optional download and preview inputs. */
  readonly client: CloudClientConfig
  /** Bootstrap DTO decoding budgets, applied after bounded response-body consumption. */
  readonly decodeLimits: BootstrapDecodeLimits
  /** Limits for the page's account/generation-scoped persistence namespace. */
  readonly persistenceLimits: CloudPersistenceLimits
  /** Account/generation header and query names; must match the access ingress configuration. */
  readonly fields: BindingFieldNames
  /** Browser sign-in/sign-out deadlines and request/response body byte budgets. */
  readonly auth: {
    /** Milliseconds before a sign-in or sign-out request aborts; cleanup can settle later. */
    readonly requestTimeoutMs: number
    /** Maximum UTF-8 bytes in the serialized authentication request body before sending. */
    readonly maxRequestBytes: number
    /** Maximum response-body bytes consumed for one authentication request. */
    readonly maxResponseBytes: number
  }
}
