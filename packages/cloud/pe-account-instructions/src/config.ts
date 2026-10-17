/** Required instruction source limits. */
import z from '@deepseek-ai/schemastery'
import { InstructionConfigurationError } from './error.ts'
import { requiredResidentBytes } from './budget.ts'

/** Finite, deployment-supplied source limits; no process-wide defaults apply. */
export interface Config {
  /** Maximum declared source directories, including directories without a file. */
  maxFiles: number
  /** Maximum UTF-8 bytes accepted from a selected file. */
  maxFileBytes: number
  /** Maximum combined UTF-8 source text bytes retained by one load. */
  maxTotalBytes: number
  /** Maximum UTF-8 JSON bytes of the complete native message, including metadata. */
  maxSnapshotBytes: number
  /** Per-snapshot byte/text storage available for construction, copies and handoff. */
  maxResidentBytes: number
}

/** Loader schema; deployment must provide every finite limit. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().step(1).min(1).required(),
  maxFileBytes: z.number().step(1).min(1).required(),
  maxTotalBytes: z.number().step(1).min(1).required(),
  maxSnapshotBytes: z.number().step(1).min(1).required(),
  maxResidentBytes: z.number().step(1).min(1).required(),
})

/**
 * Reject invalid limits before any provider operation.
 * @param config - explicit deployment limits.
 * @throws when any limit is not a positive safe integer.
 */
export function validateLimits(config: Config): void {
  for (const key of ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxSnapshotBytes', 'maxResidentBytes'] as const) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new InstructionConfigurationError(`pe-account-instructions: ${key} must be a positive safe integer`)
    }
  }
  if (requiredResidentBytes(config) > config.maxResidentBytes) {
    throw new InstructionConfigurationError('maxResidentBytes must cover the declared source, message and copy budgets.')
  }
}
