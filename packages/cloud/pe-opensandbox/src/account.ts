/** Account Loader entry; it cannot install an unverified provider or host fallback. */
import type { Context } from '@deepseek-ai/cordis'
import { requireExecution } from './capabilities.ts'
import { executionRequirementsSchema } from './config.ts'
import type { ExecutionRequirements } from './types.ts'

/** Loader identity for the account-native execution composition. */
export const name = 'pe-opensandbox/account'
/** Missing wiring is an explicit startup error rather than a pending injection warning. */
export const inject: string[] = []
/** The account recipe's explicitly required execution modes. */
export interface Config extends ExecutionRequirements {}
/** Required mode declaration; it cannot enable an unverified provider. */
export const Config = executionRequirementsSchema

/**
 * Reject mounting rather than install a provider that only pretends to satisfy readiness.
 * @param _ctx - account plugin context, never a source of a global current account.
 * @param config - fixed recipe requirements.
 * @throws ExecutionUnavailableError; no provider, allocation, or remote process is created.
 */
export function apply(_ctx: Context, config: Config): never {
  return requireExecution(config)
}
