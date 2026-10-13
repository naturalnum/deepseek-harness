/** Cancellation interrupts a pending upload chunk; the transport owns closing its underlying source. */

function uploadFailure(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Native upload failed', { cause: reason })
}

/** Consume exact upload chunks without waiting for another source chunk after cancellation.
 * @param source Transport-owned iterator; its carrier must close it when intake fails or is cancelled.
 * @param signal Upload deadline, caller disconnection and database connection lifetime.
 * @returns Original chunks until EOF; cancellation rejects the current wait and requests iterator cleanup.
 */
export async function* nativeUploadChunks(source: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        const aborted = () => { signal.removeEventListener('abort', aborted); reject(uploadFailure(signal.reason)) }
        signal.addEventListener('abort', aborted, { once: true })
        Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next() }).then(
          (value) => { signal.removeEventListener('abort', aborted); resolve(value) },
          (error: unknown) => { signal.removeEventListener('abort', aborted); reject(uploadFailure(error)) },
        )
        if (signal.aborted) aborted()
      })
      signal.throwIfAborted()
      if (next.done) return
      yield next.value
    }
  } finally {
    // A blocked next() must not delay filesystem cleanup; carrier disposal releases the pending source wait.
    if (signal.aborted) void iterator.return?.().catch((_sourceClosed: unknown) => { /* Intake already reports its cancellation. */ })
    else await iterator.return?.()
  }
}
