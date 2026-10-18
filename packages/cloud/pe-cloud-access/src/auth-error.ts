/** C-01 authentication failures; raw library errors and credentials stay off the wire. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Login admission and Peer cleanup failures, separate from native business RPC errors. */
export type AuthFailureCode = 'cloud/unauthenticated' | 'cloud/forbidden' | 'cloud/login-active' | 'cloud/account-unavailable' | 'cloud/capacity' | 'cloud/stop-unconfirmed'

/** Authentication failure with a fixed, credential-free public message. */
export class AuthAccessError extends Error {
  /** HTTP status for the outer cloud handler. */
  readonly status: 401 | 403 | 409 | 429 | 503
  /** Whether the client must check status before another operation. */
  readonly retry: 'never' | 'after-status-check'

  /**
   * @param code - Authentication or availability failure, without raw library details.
   * @param requestId - Server-generated correlation id.
   * @param options - Optional internal cause; it is never included by toJSON.
   */
  constructor(readonly code: AuthFailureCode, readonly requestId: Branded<'pe-request-id'>, options?: ErrorOptions) {
    super(code === 'cloud/unauthenticated' ? 'Sign in again before sending an account request.'
      : code === 'cloud/login-active' ? 'Sign out before starting another login in this browser.'
        : code === 'cloud/forbidden' ? 'Request origin or transport is not permitted.'
          : code === 'cloud/stop-unconfirmed' ? 'Login Peer cleanup is unconfirmed. Check status before sending a new operation.'
            : code === 'cloud/capacity' ? 'Authentication capacity is full. Check status before sending a new operation.'
              : 'Authentication could not be confirmed. Check status before sending a new operation.', options)
    this.name = 'AuthAccessError'
    this.status = code === 'cloud/unauthenticated' ? 401 : code === 'cloud/forbidden' ? 403 : code === 'cloud/login-active' ? 409 : code === 'cloud/capacity' ? 429 : 503
    this.retry = code === 'cloud/account-unavailable' || code === 'cloud/capacity' || code === 'cloud/stop-unconfirmed' ? 'after-status-check' : 'never'
  }

  /**
   * Serialize a safe cloud failure.
   * @returns C-01 fields without credentials, identities or internal causes.
   */
  toJSON(): { code: AuthFailureCode; message: string; requestId: Branded<'pe-request-id'>; retry: 'never' | 'after-status-check' } {
    return { code: this.code, message: this.message, requestId: this.requestId, retry: this.retry }
  }
}
