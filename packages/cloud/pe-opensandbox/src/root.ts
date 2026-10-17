/** Root Loader entry; missing execution infrastructure is a startup failure. */
import type { Context } from '@deepseek-ai/cordis'
import { requireExecution } from './capabilities.ts'
import { executionRequirementsSchema } from './config.ts'
import type { ExecutionRequirements } from './types.ts'

/** Loader identity for the root coordinator composition. */
export const name = 'pe-opensandbox/root'
/** Missing wiring is an explicit startup error rather than a pending injection warning. */
export const inject: string[] = []
/** Fixed recipe requirements; no option turns unverified execution into ready. */
export interface Config extends ExecutionRequirements {}
/** Required mode declaration; accepting it supplies no verification evidence. */
export const Config = executionRequirementsSchema

/**
 * Reject an incomplete root before publishing a coordinator or drain participant.
 * @param _ctx - root plugin context; no service or resource is registered on failure.
 * @param config - explicit execution requirements.
 * @throws ExecutionUnavailableError until persistent reconciliation and target verification exist.
 */
export function apply(_ctx: Context, config: Config): never {
  return requireExecution(config)
}
