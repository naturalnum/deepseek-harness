import type { ExecutionAvailability } from './types.ts'

/** Execution is unavailable; no allocation or process submission was attempted. */
export class ExecutionUnavailableError extends Error {
  /** Stable error code identifying unavailable execution. */
  // oxlint-disable-next-line typescript/prefer-as-const -- Public error discriminants keep explicit types for Typert.
  readonly code: 'cloud/execution-unavailable' = 'cloud/execution-unavailable'

  /**
   * @param availability - missing required capabilities and infrastructure, without secrets or paths.
   * @param reason - deployment-disabled refusal, or missing execution verification when omitted.
   */
  constructor(readonly availability: ExecutionAvailability, readonly reason: 'unverified' | 'disabled' = 'unverified') {
    super(reason === 'disabled' ? 'Cloud execution is disabled by this deployment.'
      : 'OpenSandbox execution is unavailable: complete the required channel, isolation and lifecycle verification before mounting execution.')
    this.name = 'ExecutionUnavailableError'
  }
}

/** Execution registration, unsupported operation or generation refusal before user submission. */
export class ExecutionStateError extends Error {
  /**
   * @param code - existing cloud failure classification.
   * @param message - secret-free failure and required correction.
   */
  constructor(readonly code: 'cloud/invalid-config' | 'cloud/stale-generation' | 'cloud/account-unavailable'
    | 'cloud/capacity' | 'cloud/execution-unavailable' | 'cloud/forbidden' | 'cloud/stop-unconfirmed', message: string) {
    super(message)
    this.name = 'ExecutionStateError'
  }
}
