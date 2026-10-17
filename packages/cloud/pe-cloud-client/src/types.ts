/** Public browser limits; authentication and request-binding types belong to access. */

/** Finite public configuration for bootstrap and one captured native carrier. */
export interface CloudClientConfig {
  bootstrapPath: string
  bootstrapTimeoutMs: number
  maxBootstrapResponseBytes: number
  maxErrorResponseBytes: number
  maxPendingFetches: number
  maxSockets: number
  closeTimeoutMs: number
}
