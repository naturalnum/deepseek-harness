/** Failure to close an actual resource acquired by a JSONL read. */
export class JsonlReadCleanupError extends AggregateError {
  override readonly name = 'JsonlReadCleanupError'

  /** @param closeError - actual resource close failure.
   * @param readFailure - read failure already in flight, if any.
   */
  constructor(closeError: unknown, readFailure?: { readonly error: unknown }) {
    super(readFailure === undefined ? [closeError] : [readFailure.error, closeError],
      'JSONL read resource cleanup failed', { cause: closeError })
  }
}

/** Retain an actual I/O rejection even when it equals the caller's abort reason.
 * @param signal - cancellation observed around the operation.
 * @param operation - one actual I/O operation without cancellation checks of its own.
 * @returns The operation's result, or its failure with coincident cancellation distinguished.
 */
export async function readJsonlIo<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error: unknown) {
    if (signal?.aborted === true && error === signal.reason) {
      throw new AggregateError([error], 'JSONL I/O failed during cancellation', { cause: error })
    }
    throw error
  }
}
