/** Runtime failures use the frozen cloud error identities without defining another wire envelope. */

/** Runtime-owned failure identities used by local registration and capacity admission. */
export type AccountRuntimeErrorCode =
  | 'cloud/invalid-config'
  | 'cloud/capacity'
  | 'cloud/account-starting'
  | 'cloud/account-unavailable'
  | 'cloud/account-quarantined'
  | 'cloud/stop-unconfirmed'
  | 'cloud/config-conflict'
  | 'cloud/config-busy'
  | 'cloud/stale-generation'

/** Local failure; access owns request ids, localization, and the HTTP/WS error envelope. */
export class AccountRuntimeError extends Error {
  /**
   * Preserve a machine-readable failure without exposing account paths or credentials.
   * @param code Handling identity from C-01.
   * @param message Safe diagnostic describing the rejected operation.
   * @param options Optional cause retained for internal diagnosis, never a wire response.
   */
  constructor(readonly code: AccountRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AccountRuntimeError'
  }
}
