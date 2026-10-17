/** Execution modes reviewed separately under C-08; declarations do not authorize execution. */
export type ExecutionCapability = 'argv-collect' | 'pipes' | 'control' | 'inherit' | 'terminal'

/** Requested deployment capabilities; accepting an empty list cannot establish readiness. */
export interface ExecutionRequirements {
  readonly requiredCapabilities: readonly ExecutionCapability[]
}

/** Static evidence gaps which prevent execution from being mounted by this increment. */
export type ExecutionPrerequisite =
  | 'runtime-participant-registration'
  | 'allocation-store-and-reconciliation'
  | 'account-execution-port'
  | 'session-project-authorization'
  | 'verified-execution-channel'
  | 'managed-range-stop-proof'
  | 'resource-isolation'

/** Local assessment only; no declared mode is accepted without target evidence. */
export interface ExecutionAvailability {
  readonly availableCapabilities: readonly ExecutionCapability[]
  readonly missingCapabilities: readonly ExecutionCapability[]
  readonly missingPrerequisites: readonly ExecutionPrerequisite[]
}
