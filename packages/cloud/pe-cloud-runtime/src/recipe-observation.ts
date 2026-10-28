/** Private projection of the original audit; no configuration or error data enters diagnostics. */
import type { RootRecipeObservation } from './types.ts'

export function recipeObservation(audit: RootRecipeObservation): Omit<RootRecipeObservation, 'recipeVersion'> {
  const { status, rootEntries, providers, participants, issues } = audit
  return { status, rootEntries, providers, participants, issues }
}
