import type { ExecutionAvailability } from './types.ts'

/** Execution is unavailable; no allocation or process submission was attempted. */
export class ExecutionUnavailableError extends Error {
  /** Stable error code identifying unavailable execution. */
  // oxlint-disable-next-line typescript/prefer-as-const -- Public error discriminants keep explicit types for Typert.
  readonly code: 'cloud/execution-unavailable' = 'cloud/execution-unavailable'

  /**
   * @param availability - missing required capabilities and infrastructure, without secrets or paths.
   */
  constructor(readonly availability: ExecutionAvailability) {
    super('OpenSandbox execution is unavailable: complete the required channel, isolation and lifecycle verification before mounting execution.')
    this.name = 'ExecutionUnavailableError'
  }
}
