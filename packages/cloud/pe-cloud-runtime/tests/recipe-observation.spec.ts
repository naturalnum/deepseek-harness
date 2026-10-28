/** Diagnostic projection alone carries no recipe, configuration, error or admission authority. */
import { expect, it, vi } from 'vitest'
import { recipeObservation } from '../src/recipe-observation.ts'
import type { RootRecipeObservation } from '../src/types.ts'

it.each(['unsealed', 'blocked', 'sealed', 'revoked', 'closed'] as const)('projects only the original safe audit fields for %s', (status) => {
  const privateGetter = vi.fn(() => 'PRIVATE_CONFIG')
  const audit: RootRecipeObservation = {
    status, recipeVersion: '/PRIVATE_RECIPE', rootEntries: 5, providers: 8, participants: 2,
    issues: Object.freeze(['root-config-unproven', 'recipe-revoked']),
  }
  Object.defineProperty(audit, 'config', { get: privateGetter })
  Object.defineProperty(audit, 'cause', { get: privateGetter })
  const result = recipeObservation(audit)
  expect(result).toEqual({ status, rootEntries: 5, providers: 8, participants: 2,
    issues: ['root-config-unproven', 'recipe-revoked'] })
  expect(result.issues).toBe(audit.issues)
  expect(privateGetter).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})
