/** Native Fs stream frames retain the SDK's UTF-8 and binary-file semantics without whole-file buffering. */
import { z } from 'zod'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { Readable } from 'node:stream'

/** Credential-free worker text or failure frame. */
export const nativeFsStreamFrame = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }).strict(),
  z.object({ kind: z.literal('end') }).strict(),
  z.object({ kind: z.literal('error'), code: z.enum(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
    'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED',
    'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED']), message: z.string() }).strict(),
])

/** Decode bounded worker frames; arbitrary chunk boundaries never change native text semantics.
 * @param stream Raw worker output from the same execution world.
 * @param maximum Maximum one serialized frame, independent of file size.
 * @param signal Consumer cancellation checked before emitting every native chunk.
 * @returns Native decoded text chunks, or the original filesystem failure.
 */
export async function* decodeNativeFsStream(stream: Readable, maximum: number, signal?: AbortSignal): AsyncIterable<string> {
  let pending = Buffer.alloc(0), ended = false
  for await (const chunk of stream) {
    if (signal?.aborted) throw new FsError('Native text read aborted.', 'FS_ABORTED')
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)])
    for (;;) {
      const end = pending.indexOf(10)
      if (end < 0) break
      if (end > maximum) throw new FsError('Native text frame exceeds its bound.', 'FS_TOO_LARGE')
      const frame = nativeFsStreamFrame.parse(JSON.parse(pending.subarray(0, end).toString('utf8')))
      pending = pending.subarray(end + 1)
      if (ended) throw new FsError('Native text stream continued after EOF.', 'FS_IO_ERROR')
      if (frame.kind === 'error') throw new FsError(frame.message, frame.code)
      if (frame.kind === 'end') ended = true
      else { if (signal?.aborted) throw new FsError('Native text read aborted.', 'FS_ABORTED'); yield frame.text }
    }
    if (pending.length > maximum) throw new FsError('Native text frame exceeds its bound.', 'FS_TOO_LARGE')
  }
  if (pending.length || !ended) throw new FsError('Native text stream ended without EOF.', 'FS_IO_ERROR')
}

/** Retain an eagerly allocated reader even when its generator has never started.
 * @param source Native text decoder generator.
 * @param stop Cached exact-range stop and joined release.
 * @returns A single-consumer iterator whose return always closes the original reader.
 */
export function ownNativeFsStream(source: AsyncGenerator<string, void>, stop: () => Promise<void>): AsyncIterable<string> {
  let closeWork: Promise<void> | undefined
  const close = () => closeWork ??= stop()
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() { return this },
    next: () => source.next(),
    async return() { try { await close() } finally { await source.return() }; return { done: true, value: undefined } },
    async throw(error: unknown) { try { await close() } finally { await source.return() }; throw error },
  }
  return iterator
}
