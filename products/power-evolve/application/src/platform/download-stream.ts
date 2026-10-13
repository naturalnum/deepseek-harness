/** Cancellation-aware delivery of one authorized cloud file. */
const CHUNK_BYTES = 64 * 1024
/**
 * Bridge a sequential producer to a Web stream with one bounded chunk of read ahead.
 * @param source Producer whose pending reads observe the combined cancellation signal.
 * @param signal External connection cancellation or transfer deadline.
 * @param finish Called after producer cleanup; the owner still tracks pending underlying reads.
 * @returns Byte stream; cancel waits for producer cleanup before resolving.
 */
export function createDownloadStream(source: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
  signal: AbortSignal, finish: () => Promise<void>): ReadableStream<Uint8Array> {
  const consumer = new AbortController()
  const combined = AbortSignal.any([signal, consumer.signal])
  const iterator = source(combined)[Symbol.asyncIterator]()
  let settled = false
  let completion: Promise<void> | undefined
  let abort: () => void
  const complete = () => completion ??= (async () => {
    settled = true
    combined.removeEventListener('abort', abort)
    try { await iterator.return?.() }
    finally { await finish() }
  })()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        controller.error(combined.reason)
        // Error the consumer immediately, while retaining the permit until cleanup settles.
        void complete().catch(() => { /* The consumer already received the transfer error. */ })
      }
      combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) abort()
    },
    async pull(controller) {
      try {
        combined.throwIfAborted()
        const next = await iterator.next()
        combined.throwIfAborted()
        if (next.done) {
          controller.close()
          await complete()
        } else { controller.enqueue(next.value) }
      } catch (error) {
        if (!settled) controller.error(error)
        await complete()
      }
    },
    async cancel(reason) {
      combined.removeEventListener('abort', abort)
      consumer.abort(reason instanceof Error ? reason : new DOMException('Download canceled', 'AbortError'))
      await complete()
    },
  }, { highWaterMark: CHUNK_BYTES, size: chunk => chunk.byteLength })
}
