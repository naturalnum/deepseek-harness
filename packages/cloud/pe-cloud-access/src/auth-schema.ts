/** Internal inspection of the pinned authentication library's actual migration plan. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'

type MigrationPlan = Awaited<ReturnType<BetterAuthAccess['planMigrations']>>

/**
 * Reject every library-reported schema gap without compiling SQL or executing DDL.
 * @param plan - Plan returned by the pinned Better Auth migration inspector.
 * @param requestId - Server-generated deployment correlation id.
 * @throws AuthAccessError if deployment must migrate or repair its authentication schema.
 */
export function assertAuthSchemaCurrent(plan: MigrationPlan, requestId: Branded<'pe-request-id'>): void {
  if (plan.toBeCreated.length !== 0 || plan.toBeAdded.length !== 0 || plan.toBeAddedIndexes.length !== 0
    || plan.unsafeChanges.length !== 0 || plan.schemaProblems.length !== 0) {
    throw new AuthAccessError('cloud/account-unavailable', requestId)
  }
}
