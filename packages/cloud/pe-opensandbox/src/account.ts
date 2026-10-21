/** Account Loader entry installs the providers selected by its original Root-issued execution capability. */
import type { Context } from '@deepseek-ai/cordis'
import { requireExecution } from './capabilities.ts'
import { executionRequirementsSchema } from './config.ts'
import type { ExecutionRequirements } from './types.ts'
import { requireAccountExecutionPort, installClosedExecutionProviders } from './closed-owner.ts'
import { requireIssuedExecutionPort } from './account-port.ts'
import { installManagedExecutionProviders } from './managed-coordinator.ts'
import { ExecutionStateError } from './errors.ts'

/** Loader identity for the account-native execution composition. */
export const name = 'pe-opensandbox/account'
/** Missing wiring is an explicit startup error rather than a pending injection warning. */
export const inject: string[] = []
/** The account recipe's explicitly required execution modes. */
export interface Config extends ExecutionRequirements {}
/** Required mode declaration; the original Root capability independently authorizes provider selection. */
export const Config = executionRequirementsSchema

/**
 * Install the native providers using the exact original Root-issued port and matching selection.
 * @param ctx - account plugin context with its exact installed root binding and port.
 * @param config - fixed recipe requirements.
 * @throws for mismatched selections, unsupported capabilities, missing/shadowed ports or duplicate providers.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'closed' && config.mode !== 'session-collect') return requireExecution(config)
  const resolved = Config({ mode: config.mode, requiredCapabilities: [...config.requiredCapabilities] })
  if (resolved.requiredCapabilities.some(capability => resolved.mode !== 'session-collect' || capability !== 'argv-collect')) {
    return requireExecution(resolved)
  }
  const port = requireIssuedExecutionPort(ctx)
  if (port.mode !== resolved.mode) {
    throw new ExecutionStateError('cloud/invalid-config', 'The account execution selection differs from its original Root-issued port.')
  }
  if (ctx.get('shell') !== undefined || ctx.get('subprocess') !== undefined
    || ctx.root.get('shell') !== undefined || ctx.root.get('subprocess') !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'The account already has a native execution provider.')
  }
  if (resolved.mode === 'session-collect') installManagedExecutionProviders(ctx, port)
  else installClosedExecutionProviders(ctx, requireAccountExecutionPort(ctx))
}
