/** Public browser limits; authentication and request-binding types belong to access. */
import type { BindingFieldNames, BootstrapDecodeLimits } from '@deepseek-ai/dsh-pe-cloud-access/types'

/** Explicit finite UTF-8 budgets; total includes the physical key and serialized envelope. */
export interface CloudPersistenceLimits {
  readonly maxKeys: number
  readonly maxKeyBytes: number
  readonly maxValueBytes: number
  readonly maxTotalBytes: number
  readonly maxNamespaceBytes: number
}

/** Finite public configuration for bootstrap and one captured native carrier. */
export interface CloudClientConfig {
  bootstrapPath: string
  bootstrapTimeoutMs: number
  maxBootstrapResponseBytes: number
  maxErrorResponseBytes: number
  maxPendingFetches: number
  maxSockets: number
  closeTimeoutMs: number
  /** Optional complete-file download acceptance cap; absence keeps download actions unregistered. */
  maxDownloadBytes?: number
}

/** Public deployment inputs for the existing Web entry; contains no login or account state. */
export interface CloudWebManifest {
  readonly client: CloudClientConfig
  readonly decodeLimits: BootstrapDecodeLimits
  readonly persistenceLimits: CloudPersistenceLimits
  readonly fields: BindingFieldNames
  readonly auth: {
    readonly requestTimeoutMs: number
    readonly maxRequestBytes: number
    readonly maxResponseBytes: number
  }
}
