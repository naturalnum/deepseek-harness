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
