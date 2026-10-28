/** Private projection of the original audit; no configuration or error data enters diagnostics. */
import type { RootRecipeObservation } from './types.ts'

/**
 * Select bounded audit status, counts and issue codes for private diagnostics.
 * @param audit Snapshot from the original recipe owner; no readiness authority is created.
 * @returns Original status, counts and issues without the deployment recipe version.
 */
export function recipeObservation(audit: RootRecipeObservation): Omit<RootRecipeObservation, 'recipeVersion'> {
  const { status, rootEntries, providers, participants, issues } = audit
  return { status, rootEntries, providers, participants, issues }
}
