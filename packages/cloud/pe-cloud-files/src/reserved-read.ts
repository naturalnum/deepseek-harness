/** Fixed readers sharing one already reserved snapshot operation and exclusive worker slot. */
import { FsError } from '@deepseek-ai/dsh-fs'
import { createFixedRootReader, decodeTextStream, nativeReadFailure } from './read-only.ts'
import type { FixedRootReader } from './read-only.ts'
import { FdWorkerFailure } from './worker-client.ts'
import type { FdByteStream, FdWorkerClient } from './worker-client.ts'
import type { FdRootIdentity } from './worker-protocol.ts'

/** An independently verified source-directory anchor issued by the storage owner. */
export interface ReservedReadSource {
  readonly root: FdRootIdentity
}

/** Validated per-path/read limits; the caller has already reserved the complete snapshot budget. */
export interface ReservedReadLimits {
  readonly maxPathBytes: number
  readonly maxReadBytes: number
  readonly readChunkBytes: number
}

/** Readers remain usable only until this session closes or its original operation is cancelled. */
export interface ReservedReadSession {
  readonly readers: readonly FixedRootReader[]
  /**
   * Seal admission, cancel streams and join actual replies/FD closure, without a second deadline.
   * @returns The same close observation; requested cancellation must still finish, and other worker/cancel failures reject.
   */
  close(): Promise<void>
}

/**
 * Capture several fixed sources inside one outer reservation without acquiring another lane or slot.
 * The worker's existing busy rejection applies: consume operations and streams sequentially.
 * @param client Exclusive worker borrowed by the outer snapshot owner.
 * @param sources Independent source-directory anchors, never a broader private parent plus a path prefix.
 * @param limits Validated limits covered by the outer reservation, including all retained snapshot text.
 * @param assertCurrent Original owner's synchronous current-operation check.
 * @param signal Original actual-work cancellation; per-reader signals cancel only their operation.
 * @returns Fixed native readers and an idempotent close that must settle before releasing the outer slot.
 */
export function createReservedReadSession(
  client: Pick<FdWorkerClient, 'stat' | 'stream'>, sources: readonly ReservedReadSource[], limits: ReservedReadLimits,
  assertCurrent: () => void, signal: AbortSignal,
): ReservedReadSession {
  const { maxPathBytes, maxReadBytes, readChunkBytes } = limits
  const stopping = new AbortController()
  const lifetime = AbortSignal.any([signal, stopping.signal])
  const pending = new Set<Promise<void>>()
  const streams = new Set<() => void>()
  const failures: unknown[] = []
  let closing: Promise<void> | undefined
  const current = (caller?: AbortSignal): void => {
    if (closing !== undefined || lifetime.aborted || caller?.aborted === true) {
      throw new FsError('The reserved file read has ended.', 'FS_ABORTED')
    }
    assertCurrent()
  }
  const observe = (actual: Promise<unknown>, cancelled: () => boolean, settled?: () => void): void => {
    const observed = actual.then(() => {}, (error: unknown) => {
      if (!(error instanceof FdWorkerFailure && error.code === 'FS_ABORTED' && cancelled())) {
        failures.push(nativeReadFailure(error))
      }
    }).finally(() => { pending.delete(observed); settled?.() })
    pending.add(observed)
  }
  current()
  const readers = Object.freeze(sources.map((source): FixedRootReader => {
    const root = Object.freeze({ ...source.root })
    return createFixedRootReader(root.rootPath, {
      maxPathBytes, assertCurrent: () => { current() },
      stat: async (path, caller) => {
        current(caller)
        const control = caller === undefined ? lifetime : AbortSignal.any([lifetime, caller])
        const actual = client.stat(root, path, control)
        observe(actual, () => control.aborted)
        const value = await actual
        // The outer snapshot owns this metadata and its complete reserved bytes.
        return { value, release: () => {} }
      },
      streamText: (path, caller) => {
        current(caller)
        return Promise.resolve((async function* (): AsyncIterable<string> {
          current(caller)
          const control = caller === undefined ? lifetime : AbortSignal.any([lifetime, caller])
          let actual: FdByteStream
          try { actual = client.stream(root, path, maxReadBytes, readChunkBytes, control) }
          catch (error) { throw nativeReadFailure(error) }
          let cancelled = false
          const cancel = (): void => {
            if (cancelled) return
            cancelled = true
            try { actual.cancel() } catch (error) { failures.push(error) }
          }
          streams.add(cancel)
          observe(actual.finished, () => cancelled || control.aborted, () => { streams.delete(cancel) })
          const owned: FdByteStream = { finished: actual.finished, next: () => actual.next(), cancel }
          yield* decodeTextStream(owned, () => { current(caller) })
        })())
      },
    })
  }))
  return Object.freeze({
    readers,
    close: () => {
      if (closing !== undefined) return closing
      const completion = Promise.withResolvers<void>()
      closing = completion.promise
      stopping.abort()
      for (const cancel of streams) cancel()
      void Promise.all(pending).then(() => {
        if (failures.length > 0) {
          throw new FsError('Reserved file read cleanup failed.', 'FS_IO_ERROR', { cause: new AggregateError(failures) })
        }
      }).then(completion.resolve, completion.reject)
      return closing
    },
  })
}
