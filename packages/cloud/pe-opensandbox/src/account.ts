/** Account Loader entry installs an actual native refusal pair for explicit closed execution. */
import type { Context } from '@deepseek-ai/cordis'
import { requireExecution } from './capabilities.ts'
import { executionRequirementsSchema } from './config.ts'
import type { ExecutionRequirements } from './types.ts'
import { requireAccountExecutionPort, installClosedExecutionProviders } from './closed-owner.ts'
import { ExecutionStateError } from './errors.ts'

/** Loader identity for the account-native execution composition. */
export const name = 'pe-opensandbox/account'
/** Missing wiring is an explicit startup error rather than a pending injection warning. */
export const inject: string[] = []
/** The account recipe's explicitly required execution modes. */
export interface Config extends ExecutionRequirements {}
/** Required mode declaration; it cannot enable an unverified provider. */
export const Config = executionRequirementsSchema

/**
 * Install one native provider pair using the existing root-issued refusal port.
 * @param ctx - account plugin context with its exact installed root binding and port.
 * @param config - fixed recipe requirements.
 * @throws for unverified modes, required capabilities, missing/shadowed ports or duplicate providers.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'closed') return requireExecution(config)
  const resolved = Config({ mode: 'closed', requiredCapabilities: [...config.requiredCapabilities] })
  if (resolved.requiredCapabilities.length !== 0) return requireExecution(resolved)
  const port = requireAccountExecutionPort(ctx)
  if (ctx.get('shell') !== undefined || ctx.get('subprocess') !== undefined
    || ctx.root.get('shell') !== undefined || ctx.root.get('subprocess') !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'The account already has a native execution provider.')
  }
  installClosedExecutionProviders(ctx, port)
}
