/** Explicit Loader entry points are /root and /account; the package root is a Host library. */
export { ExecutionUnavailableError } from './errors.ts'
export { assessExecution } from './capabilities.ts'
export { SandboxCoordinator } from './coordinator.ts'
export type {
  ExecutionAvailability,
  ExecutionCapability,
  ExecutionPrerequisite,
  ExecutionRequirements,
} from './types.ts'
