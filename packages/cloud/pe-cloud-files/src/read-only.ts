/** Internal native read-only methods; fixed roots are inputs from a trusted issuer, never inferred authority. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { FdMetadata } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'
import { FdWorkerFailure } from './worker-client.ts'
import type { FdByteStream } from './worker-client.ts'

/** Exactly the native operations consumed by account-instructions; no filesystem registration. */
export type FixedRootReader = Pick<FileSystem, 'resolve' | 'stat' | 'streamText' | 'processPath'>

interface ReadBackend {
  readonly maxPathBytes: number
  assertCurrent(): void
  stat(path: string, signal?: AbortSignal): Promise<ResidentResult<FdMetadata | undefined>>
  streamText(path: string, signal?: AbortSignal): Promise<AsyncIterable<string>>
}
interface IssuedTarget {
  readonly relativePath: string
  readonly targetKey: FsTargetKey
  readonly displayPath: string
}

/**
 * Translate the private transport error into the original native filesystem taxonomy.
 * @param error Transport failure or an error already owned by another layer.
 * @returns The native error, preserving other owners' failures unchanged.
 */
export function nativeReadFailure(error: unknown): unknown {
  return error instanceof FdWorkerFailure ? new FsError('Cloud file read failed.', error.code, { cause: error }) : error
}

/**
 * Convert one owned FD observation without interpreting its freshness token.
 * @param info Bounded metadata validated at the worker message parser.
 * @returns Native metadata with the backend-issued opaque version.
 */
export function nativeInfo(info: FdMetadata): FsInfo {
  return { version: FsVersion(info.version), type: info.type, ...info.size === undefined ? {} : { size: info.size } }
}

/**
 * Issue native targets only within a previously authorized fixed root.
 * @param rootPath Backend execution-world root, already authorized by the owning factory.
 * @param backend Bound epoch checks and worker-backed operations.
 * @returns Native method signatures with exact issued-object target validation.
 */
export function createFixedRootReader(rootPath: string, backend: ReadBackend): FixedRootReader {
  const root = posix.resolve(rootPath)
  const prefix = randomUUID()
  const issued = new WeakMap<FsTarget, IssuedTarget>()
  const current = (signal?: AbortSignal): void => {
    backend.assertCurrent()
    if (signal?.aborted) throw new FsError('File read aborted.', 'FS_ABORTED')
  }
  const targetRecord = (target: FsTarget, signal?: AbortSignal): IssuedTarget => {
    current(signal)
    const record = issued.get(target)
    if (record === undefined || record.targetKey !== target.targetKey || record.displayPath !== target.displayPath) {
      throw new FsError('File target was not issued by this bound reader.', 'FS_PERMISSION_DENIED')
    }
    return record
  }
  const within = (absolute: string): string => {
    const relative = posix.relative(root, absolute)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      throw new FsError('File path is outside the approved root.', 'FS_PERMISSION_DENIED')
    }
    return relative || '.'
  }
  return Object.freeze({
    resolve: async (path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> => {
      current(opts?.signal)
      if (Buffer.byteLength(path) > backend.maxPathBytes) throw new FsError('File path is too large.', 'FS_TOO_LARGE')
      if (path.length === 0 || path.includes('\0') || path.split('/').includes('..')) {
        throw new FsError('File path is not a permitted relative or in-root path.', 'FS_PERMISSION_DENIED')
      }
      const cwd = opts?.cwd ?? root
      if (Buffer.byteLength(cwd) > backend.maxPathBytes) throw new FsError('File cwd is too large.', 'FS_TOO_LARGE')
      if (!posix.isAbsolute(cwd) || cwd.includes('\0') || cwd.split('/').includes('..')) {
        throw new FsError('File cwd is not an approved execution-world path.', 'FS_PERMISSION_DENIED')
      }
      within(cwd)
      const relativePath = within(posix.resolve(cwd, path))
      let held: ResidentResult<FdMetadata | undefined>
      try { held = await backend.stat(relativePath, opts?.signal) } catch (error) { throw nativeReadFailure(error) }
      try {
        current(opts?.signal)
        const target = Object.freeze({
          targetKey: FsTargetKey(`${prefix}:${held.value?.identity ?? `absent:${relativePath}`}`),
          displayPath: relativePath,
        })
        issued.set(target, { relativePath, targetKey: target.targetKey, displayPath: target.displayPath })
        return target
      } finally { held.release() }
    },
    processPath: (target: FsTarget): string => posix.join(root, targetRecord(target).relativePath),
    stat: async (target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> => {
      const record = targetRecord(target, signal)
      let held: ResidentResult<FdMetadata | undefined>
      try { held = await backend.stat(record.relativePath, signal) } catch (error) { throw nativeReadFailure(error) }
      try {
        current(signal)
        return held.value === undefined ? undefined : nativeInfo(held.value)
      } finally { held.release() }
    },
    streamText: async (target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> => {
      const record = targetRecord(target, signal)
      try { return await backend.streamText(record.relativePath, signal) } catch (error) { throw nativeReadFailure(error) }
    },
  })
}

/**
 * Decode a credit-controlled stream with native fatal UTF-8 and first-8192-byte NUL sampling.
 * @param stream One worker-owned FD stream; each next grants exactly one chunk credit.
 * @param assertCurrent Exact bound-generation admission check before each delivery.
 * @returns Decoded chunks; an early return requests cancellation while actual work remains owned.
 */
export async function* decodeTextStream(stream: FdByteStream, assertCurrent: () => void): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampled = 0
  const decode = (bytes?: Uint8Array): string => {
    try { return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }) } catch (error) {
      if (error instanceof TypeError) throw new FsError('File is not valid UTF-8 text.', 'FS_NOT_TEXT', { cause: error })
      throw error
    }
  }
  try {
    while (true) {
      assertCurrent()
      const next = await stream.next()
      assertCurrent()
      if (next.done === true) break
      // Match the pinned native backend's binary sample, without accumulating that sample.
      const sample = next.value.subarray(0, Math.max(0, 8192 - sampled))
      if (sample.includes(0)) throw new FsError('File contains binary data.', 'FS_NOT_TEXT')
      sampled += sample.byteLength
      const text = decode(next.value)
      if (text.length > 0) yield text
    }
    const tail = decode()
    if (tail.length > 0) yield tail
  } catch (error) { throw nativeReadFailure(error) } finally { stream.cancel() }
}
