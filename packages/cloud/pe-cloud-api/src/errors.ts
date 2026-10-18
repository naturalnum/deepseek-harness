/** Stable API policy failures without request values or private paths. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Denials and missing integration requirements owned by this package. */
export type CloudApiErrorCode =
  | 'cloud/forbidden' | 'cloud/invalid-config' | 'cloud/account-unavailable'
  | 'cloud/stale-generation' | 'cloud/model-not-allowed'
  | 'cloud/config-busy' | 'cloud/capacity'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'cloud/forbidden': {}
    'cloud/invalid-config': Record<string, never>
    'cloud/account-unavailable': {}
    'cloud/stale-generation': {}
    'cloud/model-not-allowed': Record<string, never>
    'cloud/config-busy': Record<string, never>
    'cloud/capacity': {}
  }
}

/** Expected account policy failure retained by native Remote error encoding with empty details. */
export class CloudApiError extends RemoteError<CloudApiErrorCode> {
  override readonly name: string = 'CloudApiError'

  /**
   * @param code - machine-readable policy or integration failure.
   * @param message - fixed diagnostic without sensitive request data.
   */
  constructor(code: CloudApiErrorCode, message: string) {
    super(code, message, {})
  }
}
