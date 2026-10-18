import { ExecutionUnavailableError } from './errors.ts'
import type { ExecutionAvailability, ExecutionRequirements } from './types.ts'

/**
 * Assess unverified execution without allocating or contacting a backend.
 * @param requirements - modes required by the fixed deployment recipe.
 * @returns enabling prerequisites; closed registration readiness is owned by the actual coordinator.
 */
export function assessExecution(requirements: ExecutionRequirements): ExecutionAvailability {
  return Object.freeze({
    availableCapabilities: Object.freeze([]),
    missingCapabilities: Object.freeze([...new Set(requirements.requiredCapabilities)]),
    missingPrerequisites: Object.freeze([
      'runtime-participant-registration',
      'allocation-store-and-reconciliation',
      'account-execution-port',
      'session-project-authorization',
      'verified-execution-channel',
      'managed-range-stop-proof',
      'resource-isolation',
    ] as const),
  })
}

/**
 * Refuse mounting execution until the target and lifecycle implementation are verified.
 * @param requirements - declared recipe requirements, including an empty declaration.
 * @returns never; always throws the declared execution-unavailable error.
 * @throws ExecutionUnavailableError; an empty requirement list does not bypass missing infrastructure.
 */
export function requireExecution(requirements: ExecutionRequirements): never {
  throw new ExecutionUnavailableError(assessExecution(requirements))
}
