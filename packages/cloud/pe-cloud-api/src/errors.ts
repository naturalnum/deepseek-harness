/** Stable API policy failures without request values or private paths. */

/** Denials and missing integration requirements owned by this package. */
export type CloudApiErrorCode =
  | 'cloud/forbidden' | 'cloud/invalid-config' | 'cloud/account-unavailable'
  | 'cloud/stale-generation' | 'cloud/model-not-allowed'
  | 'cloud/config-busy' | 'cloud/capacity'

/** Expected failure before a native operation is delegated. */
export class CloudApiError extends Error {
  override readonly name: string = 'CloudApiError'

  /**
   * @param code - machine-readable policy or integration failure.
   * @param message - fixed diagnostic without sensitive request data.
   */
  constructor(readonly code: CloudApiErrorCode, message: string) {
    super(message)
  }
}
