/** Standard-stream observation at the library bridge; original Node request bytes are never pre-parsed. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { AuthAccessError } from './auth-error.ts'

/** Package-private bridge ownership, including actual asynchronous cancellation. */
export interface TrackedBody {
  readonly stream: ReadableStream<Uint8Array>
  readonly settled: Promise<void>
  readonly failure: AuthAccessError | undefined
  /** @returns Actual reader cancellation, including the source's original cancel Promise. */
  cancel(): Promise<void>
}

/**
 * Wrap a library-provided stream without reading before its consumer pulls.
 * @param source Original incoming or outgoing library body.
 * @param maxBytes Raw incoming byte cap; undefined observes an outgoing body without buffering it.
 * @param requestId Server correlation id.
 * @returns A forwarding stream and its actual read/cancel completion.
 */
export function trackBody(
  source: ReadableStream<Uint8Array>, maxBytes: number | undefined, requestId: Branded<'pe-request-id'>,
): TrackedBody {
  const reader = source.getReader()
  const completion = Promise.withResolvers<void>()
  let bytes = 0
  let ended = false
  let cancelled = false
  let cancellation: Promise<void> | undefined
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  let failure: AuthAccessError | undefined
  const isCancelled = (): boolean => cancelled
  const safe = (error: unknown): AuthAccessError => error instanceof AuthAccessError
    ? error : new AuthAccessError('cloud/account-unavailable', requestId)
  // The bridge owner joins settled even if the library rejects parsing before returning its Response.
  void completion.promise.catch((_error: unknown) => {})
  const cancel = (): Promise<void> => {
    if (cancellation !== undefined) return cancellation
    if (ended) return Promise.resolve()
    cancelled = true
    cancellation = (async () => {
      try {
        await reader.cancel()
        await reading
        reader.releaseLock()
        ended = true
        completion.resolve()
      } catch (error) {
        const closed = await reader.closed.then(() => true, () => false)
        await Promise.allSettled([reading])
        reader.releaseLock()
        ended = true
        failure = closed ? new AuthAccessError('cloud/stop-unconfirmed', requestId) : safe(error)
        completion.reject(failure)
        // Cancelling an already errored reader invokes no source cleanup; its read failure remains in settled.
        if (closed) throw failure
      }
    })()
    return cancellation
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled || ended) return
      try {
        reading = reader.read()
        const item = await reading
        if (isCancelled()) return
        if (item.done) {
          ended = true
          reader.releaseLock()
          controller.close()
          completion.resolve()
          return
        }
        bytes += item.value.byteLength
        if (maxBytes !== undefined && bytes > maxBytes) {
          failure = new AuthAccessError('cloud/capacity', requestId)
          controller.error(failure)
          await cancel()
          return
        }
        controller.enqueue(item.value)
      } catch (error) {
        if (isCancelled()) return
        failure = safe(error)
        controller.error(failure)
        ended = true
        reader.releaseLock()
        completion.reject(failure)
      } finally { reading = undefined }
    },
    cancel,
  }, { highWaterMark: 0 })
  return { stream, settled: completion.promise, cancel, get failure() { return failure } }
}
