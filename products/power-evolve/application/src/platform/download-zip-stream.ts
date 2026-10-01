/** Sequential STORE ZIP output adapted from PowerEvolve's workspace download stream. */
import { Zip, ZipPassThrough } from 'fflate'

const CHUNK_BYTES = 64 * 1024

/** A canonical entry and its sequential, bounded original-byte chunks. */
export interface DownloadZipEntry {
  readonly path: string
  readonly chunks: AsyncIterable<Uint8Array>
}

/**
 * Encode entries without collecting the archive or reading the next entry ahead.
 * @param entries Entries in the user's selected order.
 * @param signal Transfer cancellation, including the consumer's cancellation.
 * @returns ZIP chunks; failures terminate the archive before a valid completion record.
 */
export async function* downloadZipChunks(entries: AsyncIterable<DownloadZipEntry>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const output: Uint8Array[] = []
  let failure: Error | undefined
  const archive = new Zip((error, chunk) => {
    if (error) failure = error
    else if (chunk.length) output.push(chunk)
  })
  function* drain(): Generator<Uint8Array> {
    if (failure) throw failure
    for (const chunk of output.splice(0)) {
      for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
        signal.throwIfAborted()
        yield chunk.subarray(offset, offset + CHUNK_BYTES)
      }
    }
  }
  try {
    for await (const entry of entries) {
      signal.throwIfAborted()
      const file = new ZipPassThrough(entry.path)
      archive.add(file)
      for await (const chunk of entry.chunks) {
        for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
          signal.throwIfAborted()
          file.push(chunk.subarray(offset, offset + CHUNK_BYTES), false)
          yield* drain()
        }
      }
      file.push(new Uint8Array(0), true)
      yield* drain()
    }
    signal.throwIfAborted()
    archive.end()
    yield* drain()
  } finally { archive.terminate() }
}

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
