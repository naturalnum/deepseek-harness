/** Private projection of the original audit; no configuration or error data enters diagnostics. */
import type { RootRecipeObservation } from './types.ts'

/** Project the original Root audit into its diagnostic fields without its recipe version.
 * @param audit Original Root recipe observation.
 * @returns The same status, counts and issues, excluding the recipe version.
 */
export function recipeObservation(audit: RootRecipeObservation): Omit<RootRecipeObservation, 'recipeVersion'> {
  const { status, rootEntries, providers, participants, issues } = audit
  return { status, rootEntries, providers, participants, issues }
}
