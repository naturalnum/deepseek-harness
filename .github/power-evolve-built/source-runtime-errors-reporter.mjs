/** Record Vitest's actual end reason and unhandled errors separately from its assertion JSON. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

/** Preserve runtime failures that the standard JSON reporter does not include. */
export default class SourceRuntimeErrorsReporter {
  /** Write the complete runner-end facts, including cancellation and unhandled errors.
   * @param modules Complete test modules returned by this Vitest run.
   * @param errors Unhandled errors returned by Vitest, separate from failed assertions.
   * @param reason Actual Vitest end reason: passed, failed or interrupted.
   * @returns Nothing; writes the owned runtime-error report synchronously.
   */
  onTestRunEnd(modules, errors, reason) {
    assert(process.env.PE_CLOUD_SOURCE_RUNTIME_ERRORS_FILE)
    writeFileSync(process.env.PE_CLOUD_SOURCE_RUNTIME_ERRORS_FILE,
      JSON.stringify({ version: 1, reason, unhandledErrors: errors.length, modules: modules.length }) + '\n',
      { flag: 'wx', mode: 0o600 })
  }
}
