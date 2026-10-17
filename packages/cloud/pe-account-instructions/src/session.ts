/** Session Loader entry; file instructions remain closed without owner adapters. */
import type { Context } from '@deepseek-ai/cordis'
import { validateLimits } from './config.ts'
import type { Config } from './types.ts'
import { InstructionConfigurationError } from './error.ts'

export { Config } from './config.ts'
/** Loader name for the bounded account instruction behavior. */
export const name = 'pe-account-instructions'
/** Activation itself fails until audited owner interfaces can be consumed. */
export const inject: string[] = []

/**
 * Reject activation while the cross-package owner adapters are unavailable.
 * @param ctx - session plugin owner; no effects or filesystem calls are started.
 * @param config - explicit finite instruction budgets.
 * @throws InstructionConfigurationError; file instructions cannot be enabled without owner adapters.
 */
export function apply(ctx: Context, config: Config): never {
  void ctx
  validateLimits(config)
  throw new InstructionConfigurationError('pe-account-instructions: the audited account/project and read-only files adapters are not connected; keep file instructions disabled.')
}
