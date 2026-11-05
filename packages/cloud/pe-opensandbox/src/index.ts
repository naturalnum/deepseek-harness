/** Explicit Loader entry points are /root and /account; the package root is a Host library. */
export { ExecutionUnavailableError, ExecutionStateError } from './errors.ts'
export { assessExecution } from './capabilities.ts'
export { parseRootDeploymentInput } from './bootstrap/deployment-input.ts'
export { SandboxCoordinator } from './coordinator.ts'
export type { NativeAccountExecutionAuthority } from './coordinator.ts'
export { installAccountExecutionPort, assertClosedAccountExecution } from './closed-owner.ts'
export { assertAccountExecutionProviders, accountExecutionMode, accountServiceAvailability, accountTerminalLimits,
  withAccountApplicationService } from './account-port.ts'
export type { AccountExecutionPort } from './account-port.ts'
export type {
  ExecutionAvailability,
  ExecutionCapability,
  ExecutionPrerequisite,
  ExecutionRequirements,
} from './types.ts'

export { runRemoteSsh, assertRemoteSshAvailable } from './remote-ssh.ts'
export type { RemoteSshConfig } from './remote-ssh.ts'
