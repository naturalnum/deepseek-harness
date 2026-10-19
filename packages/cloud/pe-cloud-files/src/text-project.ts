/** Opt-in default-project text provider; registration and project authority remain with the owning graph. */
import type { Context } from '@deepseek-ai/cordis'
import FileSystem, { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsInfo, FsWriteIntent, FsWriteOutcome, FsDirEntry, FsPathInfo, FsEditOutcome } from '@deepseek-ai/dsh-fs'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { FixedRootReader } from './read-only.ts'
import { nativeReadFailure } from './read-only.ts'
import { DirectoryMetadataFailure } from './directory-error.ts'
import { FdTextWriteFailure } from './worker-client.ts'
import type { ResidentResult } from './work-queue.ts'

/** Native constructor only; creating it neither installs a provider nor enables tools or an RPC. */
export interface NativeTextFileSystemConstructor {
  new(ctx: Context): FileSystem
  readonly inject: readonly string[]
}

/** Package-private input issued on the original lane after the native Registry selects its default Workspace. */
export interface TextProjectBackend {
  readonly binding: AccountBinding
  readonly workspace: Workspace
  readonly reader: FixedRootReader
  assertCurrent(): void
  assertInstalled(ctx: Context): void
  canonicalPath(path: string, signal?: AbortSignal): Promise<string>
  readText(path: string, signal?: AbortSignal): Promise<ResidentResult<string>>
  writeText(path: string, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<ResidentResult<FsWriteOutcome>>
}

/**
 * Decode a bounded complete text result using the native UTF-8 and first-8192-byte NUL rule.
 * @param bytes Already bounded worker bytes whose reservation remains owned by the caller.
 * @returns Original decoded text; no newline normalization is applied to reads.
 */
export function decodeBoundedText(bytes: Uint8Array): string {
  if (bytes.subarray(0, 8192).includes(0)) throw new FsError('File contains binary data.', 'FS_NOT_TEXT')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) {
    if (error instanceof TypeError) throw new FsError('File is not valid UTF-8 text.', 'FS_NOT_TEXT', { cause: error })
    throw error
  }
}

/**
 * Prepare one native text-only constructor for the original registered Workspace.
 * @param backend Verified default-project FD identity, same-lane I/O and exact installed graph checks.
 * @returns Constructor exposing bounded text read/write; other content capabilities remain explicitly denied.
 */
export function createTextProjectFileSystem(backend: TextProjectBackend): NativeTextFileSystemConstructor {
  backend.assertCurrent()
  const root = backend.workspace.path
  const prefix = randomUUID()
  return class ProjectTextFileSystem extends FileSystem {
    static inject = ['peAccount', 'workspaceRegistry']
    private readonly identity = Symbol()
    private readonly targets = new WeakMap<FsTarget, string>()

    constructor(ctx: Context) {
      backend.assertInstalled(ctx)
      if (ctx.get('fs') !== undefined || ctx.get('workspaceRegistry')?.get(backend.workspace.id) !== backend.workspace
        || ctx.get('peAccount') !== backend.binding) throw new FsError('Registered default project required.', 'FS_PERMISSION_DENIED')
      super(ctx)
    }

    private current(signal?: AbortSignal): void {
      backend.assertCurrent()
      backend.assertInstalled(this.ctx)
      const installed = this.ctx.get('fs')
      if (!(installed instanceof ProjectTextFileSystem) || installed.identity !== this.identity
        || this.ctx.get('workspaceRegistry')?.get(backend.workspace.id) !== backend.workspace || this.ctx.get('peAccount') !== backend.binding) {
        throw new FsError('The original registered project is unavailable.', 'FS_PERMISSION_DENIED')
      }
      if (signal?.aborted) throw new FsError('File operation aborted.', 'FS_ABORTED', { cause: signal.reason })
    }

    private relative(path: string): string {
      const relative = posix.relative(root, path)
      if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) throw new FsError('File is outside the approved project.', 'FS_PERMISSION_DENIED')
      return relative || '.'
    }

    private targetPath(target: FsTarget, signal?: AbortSignal): string {
      this.current(signal)
      const path = this.targets.get(target)
      if (path === undefined || target.targetKey !== `${prefix}:${path}` || target.displayPath !== path) {
        throw new FsError('File target belongs to another provider.', 'FS_PERMISSION_DENIED')
      }
      return path
    }

    private denied(): Promise<never> {
      return Promise.resolve().then(() => {
        this.current()
        throw new FsError('This file capability is not enabled by the text project provider.', 'FS_PERMISSION_DENIED')
      })
    }

    override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
      this.current(opts?.signal)
      try {
        const target = await backend.reader.resolve(path, opts)
        const relative = this.relative(backend.reader.processPath(target))
        let canonical: string
        try { canonical = await backend.canonicalPath(relative, opts?.signal) } catch (error) {
          if (!(error instanceof DirectoryMetadataFailure) || error.reason !== 'missing' || relative === '.') throw error
          canonical = posix.join(await backend.canonicalPath(posix.dirname(relative), opts?.signal), posix.basename(relative))
        }
        this.current(opts?.signal)
        const issuedPath = this.relative(canonical)
        const issued = Object.freeze({ targetKey: FsTargetKey(`${prefix}:${issuedPath}`), displayPath: issuedPath })
        this.targets.set(issued, issuedPath)
        return issued
      } catch (error) { throw nativeReadFailure(error) }
    }

    override processPath(target: FsTarget): string { return posix.join(root, this.targetPath(target)) }
    override fileUrl(target: FsTarget): string { return pathToFileURL(this.processPath(target)).href }
    override contains(parent: FsTarget, child: FsTarget): boolean {
      const relative = posix.relative(this.targetPath(parent), this.targetPath(child))
      return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
    }
    override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
      const path = this.targetPath(target, signal)
      const value = await backend.reader.stat(await backend.reader.resolve(path, signal === undefined ? undefined : { signal }), signal)
      this.current(signal)
      return value
    }
    override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
      const path = this.targetPath(target, signal)
      try {
        const result = await backend.readText(path, signal)
        try { this.current(signal); return result.value } finally { result.release() }
      } catch (error) { throw nativeReadFailure(error) }
    }
    override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      const path = this.targetPath(target, signal)
      return backend.reader.streamText(await backend.reader.resolve(path, signal === undefined ? undefined : { signal }), signal)
    }
    override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
      const path = this.targetPath(target, signal)
      if (path === '.') throw new FsError('A regular file target is required.', 'FS_NOT_REGULAR_FILE')
      try {
        const result = await backend.writeText(path, content, expected, signal)
        try { this.current(); return result.value } finally { result.release() }
      } catch (error) {
        if (error instanceof FdTextWriteFailure) throw new FsError(error.outcome === 'unknown'
          ? 'File write could not be confirmed. Further writes are blocked; ask the account operator to reconcile the file before retrying.'
          : 'Cloud file write failed.', error.code, { cause: error })
        throw nativeReadFailure(error)
      }
    }
    override lstat(): Promise<FsPathInfo | undefined> { return this.denied() }
    override readBytes(): Promise<Uint8Array> { return this.denied() }
    override readByteRange(): Promise<Uint8Array> { return this.denied() }
    override listDir(): Promise<FsDirEntry[]> { return this.denied() }
    override editText(): Promise<FsEditOutcome> { return this.denied() }
    override watch(): Promise<() => Promise<void>> { return this.denied() }
  }
}
