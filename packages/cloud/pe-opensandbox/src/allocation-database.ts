/** Allocation SQL shares the Root runtime executor without importing the runtime Host composition. */
import type { RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { AllocationQuery } from './allocation-types.ts'
import { AllocationQueryNotSubmittedError } from './allocation-store.ts'

class RootAllocationNotSubmittedError extends AllocationQueryNotSubmittedError {
  constructor(cause: unknown) { super({ cause }) }
}

/**
 * Bind fixed allocation SQL to the original registered participant's Root capability.
 * @param database Runtime-issued metadata access, retained through actual execution shutdown.
 * @returns A driver preserving actual settlement and the original adapter's zero-submission classification.
 */
export function allocationDatabase(database: RootMetadataDatabase): AllocationQuery {
  return Object.freeze({
    async query(text: string, values: readonly (string | null)[]) {
      try { return await database.query(text, values) }
      catch (cause) {
        if (database.wasNotSubmitted(cause)) throw new RootAllocationNotSubmittedError(cause)
        throw cause
      }
    },
  })
}
