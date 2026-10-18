/** Fixed-root read-only metadata backend; no Registry, ProjectScope, or directory preparation authority. */
import { posix } from 'node:path'
import { DirectoryMetadataFailure } from './directory-error.ts'
import type { FdDirectoryObservation } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'

/** Read-only subset only; it cannot be installed as the complete native Workspace directory dependency. */
export interface DirectoryReadPort {
  canonicalPath(path: string, signal?: AbortSignal): Promise<string>
  isDirectory(path: string, signal?: AbortSignal): Promise<boolean>
}

interface DirectoryBackend {
  readonly maxPathBytes: number
  readonly replyOverheadBytes: number
  assertCurrent(): void
  inspect(relativePath: string, reservedBytes: number, signal?: AbortSignal): Promise<ResidentResult<FdDirectoryObservation>>
}

/**
 * Route bounded absolute inputs through a fixed root that the trusted factory has already selected.
 * @param rootPath Previously approved backend root; this value alone is not production authorization.
 * @param backend Exact-generation checks and existing bounded worker admission.
 * @returns Read-only metadata methods with no ensure operation or filesystem registration.
 */
export function createDirectoryReadPort(rootPath: string, backend: DirectoryBackend): DirectoryReadPort {
  // Collapse separators in the trusted routing address, without normalizing input symlink/.. semantics.
  const root = posix.normalize(rootPath)
  let physicalRoot: string | undefined
  const inspect = async (path: string, signal?: AbortSignal): Promise<ResidentResult<FdDirectoryObservation>> => {
    try { backend.assertCurrent() } catch (error) {
      throw new DirectoryMetadataFailure('unavailable', 'admission', { cause: error })
    }
    if (!posix.isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > backend.maxPathBytes) {
      throw new DirectoryMetadataFailure('unavailable', 'input')
    }
    const spelling = path.replace(/\/+/g, '/')
    // A second spelling addresses the same anchor; kernel verification still runs on every request.
    const addresses = physicalRoot === undefined || physicalRoot === root
      ? [root] : [root, physicalRoot].sort((a, b) => b.length - a.length)
    const address = addresses.find(candidate =>
      spelling === candidate || spelling.startsWith(candidate === '/' ? '/' : `${candidate}/`))
    if (address === undefined) throw new DirectoryMetadataFailure('unavailable', 'input')
    const prefix = address === '/' ? '/' : `${address}/`
    const relativePath = spelling === address ? '.' : spelling.slice(prefix.length) || '.'
    // Four bounded native link buffers, UTF-8/UTF-16/clone copies, inputs and response/record overhead.
    const reservedBytes = 12 * (backend.maxPathBytes + 1)
      + 2 * (Buffer.byteLength(rootPath) + Buffer.byteLength(relativePath)) + backend.replyOverheadBytes
    try { return await backend.inspect(relativePath, reservedBytes, signal) } catch (error) {
      if (error instanceof DirectoryMetadataFailure) throw error
      throw new DirectoryMetadataFailure('unavailable', 'admission', { cause: error })
    }
  }
  const observe = async <T>(path: string, select: (value: FdDirectoryObservation) => T, signal?: AbortSignal): Promise<T> => {
    const held = await inspect(path, signal)
    try {
      try { backend.assertCurrent() } catch (error) { throw new DirectoryMetadataFailure('unavailable', 'admission', { cause: error }) }
      if (signal?.aborted) throw new DirectoryMetadataFailure('unavailable', 'admission', { cause: signal.reason })
      physicalRoot = held.value.anchorPath
      return select(held.value)
    } finally { held.release() }
  }
  return Object.freeze({
    canonicalPath: (path: string, signal?: AbortSignal) => observe(path, value => value.canonicalPath, signal),
    isDirectory: (path: string, signal?: AbortSignal) => observe(path, value => value.directory, signal),
  })
}
