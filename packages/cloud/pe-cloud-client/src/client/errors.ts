/** Local carrier outcomes; these are not a replacement cloud wire error protocol. */

/** Failures this browser lifetime can distinguish without parsing diagnostic text. */
export type ClientFailureCode =
  | 'closed' | 'capacity' | 'target-denied' | 'binding-conflict'
  | 'unauthenticated' | 'stale-generation' | 'response-too-large'
  | 'bootstrap-rejected' | 'bootstrap-invalid' | 'bootstrap-timeout' | 'close-unconfirmed'

/** Internal typed failure; snapshots and diagnostics expose no rejected wire values. */
export class ClientFailure extends Error {
  /**
   * @param code - handling discriminator owned by this browser operation.
   * @param cause - original failure, absent for a directly observed rejection.
   */
  constructor(readonly code: ClientFailureCode, cause?: unknown) {
    super(`cloud client ${code}`, cause === undefined ? undefined : { cause })
    this.name = 'ClientFailure'
  }
}
