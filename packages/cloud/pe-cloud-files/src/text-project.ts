/** One account file provider; each target captures the trusted caller's exact registered project and anchor. */
import type { Context } from '@deepseek-ai/cordis'
import FileSystem, { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
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
import type { FdDirectoryEntry, FdPathMetadata } from './worker-protocol.ts'

/** Native constructor only; creating it neither installs a provider nor enables tools or an RPC. */
export interface NativeTextFileSystemConstructor {
  new(ctx: Context): FileSystem
  readonly inject: readonly string[]
}

/** Package-private input issued on the original lane for an exact selected native Workspace. */
export interface TextProjectBackend {
  readonly binding: AccountBinding
  readonly workspace: Workspace
  readonly reader: FixedRootReader
  readonly maxPathBytes: number
  assertCurrent(): void
  assertInstalled(ctx: Context): void
  canonicalPath(path: string, signal?: AbortSignal): Promise<string>
  readText(path: string, signal?: AbortSignal): Promise<ResidentResult<string>>
  lstat(path: string, signal?: AbortSignal): Promise<ResidentResult<FdPathMetadata | undefined>>
  listDir(path: string, signal?: AbortSignal): Promise<ResidentResult<readonly FdDirectoryEntry[]>>
  readBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<ResidentResult<Uint8Array>>
  readByteRange(path: string, range: { offset: number; length: number }, signal?: AbortSignal): Promise<ResidentResult<Uint8Array>>
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

/** A trusted runtime selection; its current check stays bound to the original operation. */
export interface AccountFileSelection {
  readonly workspace: Workspace
  assertCurrent(): void
}

/** Resolve caller identity before any model path is interpreted; cold observation may be asynchronous. */
export type ResolveAccountFileProject = (caller: Context, signal?: AbortSignal) => Promise<AccountFileSelection>

/** One account provider, with operation-local project backends on its original lane. */
export interface AccountTextBackend {
  readonly binding: AccountBinding
  readonly bootstrapWorkspace: Workspace
  readonly resolveProject: ResolveAccountFileProject
  /** Exact active-request verified-copy lookup; omission exposes no host path mapping. */
  readonly mapProcessPath?: (caller: Context, hostPath: string) => string | undefined
  assertCurrent(): void
  assertInstalled(ctx: Context): void
  project(workspace: Workspace, assertSelection: () => void, signal?: AbortSignal): Promise<TextProjectBackend>
}

interface IssuedTarget {
  readonly scope: AccountFileSelection
  readonly backend: TextProjectBackend
  readonly relative: string
  readonly key: FsTargetKey
  readonly entryOnly: boolean
}

/**
 * Prepare the sole account FS; every issued target retains its selected original project and anchor.
 * @param account Trusted asynchronous selection and same-lane project backend factory.
 * @returns Native constructor; this does not install another service for any project.
 */
export function createTextProjectFileSystem(account: AccountTextBackend): NativeTextFileSystemConstructor {
  account.assertCurrent()
  const prefix = randomUUID()
  return class AccountTextFileSystem extends FileSystem {
    static inject = ['peAccount', 'workspaceRegistry']
    private readonly identity = Symbol()
    private readonly targets = new WeakMap<FsTarget, IssuedTarget>()

    constructor(ctx: Context) {
      account.assertInstalled(ctx)
      if (ctx.get('fs') !== undefined || ctx.get('workspaceRegistry')?.get(account.bootstrapWorkspace.id) !== account.bootstrapWorkspace
        || ctx.get('peAccount') !== account.binding) throw new FsError('Registered account project required.', 'FS_PERMISSION_DENIED')
      super(ctx)
    }

    private current(signal?: AbortSignal): void {
      account.assertCurrent()
      account.assertInstalled(this.ctx)
      const installed = this.ctx.get('fs')
      if (!(installed instanceof AccountTextFileSystem) || installed.identity !== this.identity || this.ctx.get('peAccount') !== account.binding) {
        throw new FsError('The original account filesystem is unavailable.', 'FS_PERMISSION_DENIED')
      }
      if (signal?.aborted) throw new FsError('File operation aborted.', 'FS_ABORTED', { cause: signal.reason })
    }

    private selection(scope: AccountFileSelection, signal?: AbortSignal): void {
      this.current(signal)
      scope.assertCurrent()
      if (this.ctx.get('workspaceRegistry')?.get(scope.workspace.id) !== scope.workspace) {
        throw new FsError('The selected native Workspace is unavailable.', 'FS_PERMISSION_DENIED')
      }
    }

    private relative(backend: TextProjectBackend, path: string): string {
      const relative = posix.relative(backend.workspace.path, path)
      if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
        throw new FsError('File is outside the approved project.', 'FS_PERMISSION_DENIED')
      }
      return relative || '.'
    }

    private target(target: FsTarget, signal?: AbortSignal): IssuedTarget {
      this.current(signal)
      const record = this.targets.get(target)
      if (record === undefined || target.targetKey !== record.key || target.displayPath !== record.relative) {
        throw new FsError('File target belongs to another provider.', 'FS_PERMISSION_DENIED')
      }
      this.selection(record.scope, signal)
      record.backend.assertCurrent()
      return record
    }

    private issue(scope: AccountFileSelection, backend: TextProjectBackend, relative: string, entryOnly = false): FsTarget {
      const key = FsTargetKey(`${prefix}:${scope.workspace.id}:${relative}`)
      const target = Object.freeze({ targetKey: key, displayPath: relative })
      this.targets.set(target, { scope, backend, relative, key, entryOnly })
      return target
    }

    private path(backend: TextProjectBackend, path: string, cwd = backend.workspace.path): string {
      if (Buffer.byteLength(path) > backend.maxPathBytes || Buffer.byteLength(cwd) > backend.maxPathBytes) {
        throw new FsError('File path exceeds its limit.', 'FS_TOO_LARGE')
      }
      if (!path || path.includes('\0') || path.split('/').includes('..') || !posix.isAbsolute(cwd)
        || cwd.includes('\0') || cwd.split('/').includes('..')) throw new FsError('File path is not permitted.', 'FS_PERMISSION_DENIED')
      this.relative(backend, cwd)
      const absolute = posix.resolve(cwd, path)
      if (Buffer.byteLength(absolute) > backend.maxPathBytes) throw new FsError('File path exceeds its limit.', 'FS_TOO_LARGE')
      return this.relative(backend, absolute)
    }

    private content(record: IssuedTarget): void {
      if (record.entryOnly) throw new FsError('This directory entry grants metadata observation only.', 'FS_PERMISSION_DENIED')
    }

    private async selectedProject(signal?: AbortSignal): Promise<{ scope: AccountFileSelection; backend: TextProjectBackend }> {
      this.current(signal)
      const scope = await account.resolveProject(this.ctx, signal)
      this.selection(scope, signal)
      const backend = await account.project(scope.workspace, () => { this.selection(scope) }, signal)
      if (backend.binding !== account.binding || backend.workspace !== scope.workspace) {
        throw new FsError('Project backend belongs to another account.', 'FS_PERMISSION_DENIED')
      }
      this.selection(scope, signal)
      return { scope, backend }
    }

    private async selectedTarget(target: FsTarget, signal?: AbortSignal): Promise<{ record: IssuedTarget; check: () => void }> {
      const record = this.target(target, signal)
      const selected = await account.resolveProject(this.ctx, signal)
      this.selection(selected, signal)
      if (selected.workspace !== record.scope.workspace) throw new FsError('File target belongs to another project.', 'FS_PERMISSION_DENIED')
      const check = (): void => { this.target(target); this.selection(selected) }
      check()
      return { record, check }
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
        const { scope, backend } = await this.selectedProject(opts?.signal)
        const target = await backend.reader.resolve(path, opts)
        const relative = this.relative(backend, backend.reader.processPath(target))
        let canonical: string
        try { canonical = await backend.canonicalPath(relative, opts?.signal) } catch (error) {
          if (!(error instanceof DirectoryMetadataFailure) || error.reason !== 'missing' || relative === '.') throw error
          canonical = posix.join(await backend.canonicalPath(posix.dirname(relative), opts?.signal), posix.basename(relative))
        }
        this.selection(scope, opts?.signal)
        backend.assertCurrent()
        const issuedPath = this.relative(backend, canonical)
        return this.issue(scope, backend, issuedPath)
      } catch (error) { throw nativeReadFailure(error) }
    }

    override processPath(target: FsTarget): string {
      const record = this.target(target)
      return posix.join(record.backend.workspace.path, record.relative)
    }
    override processPathFromHostPath(hostPath: string): string | undefined {
      this.current()
      return account.mapProcessPath?.(this.ctx, hostPath)
    }
    override fileUrl(target: FsTarget): string { return pathToFileURL(this.processPath(target)).href }
    override contains(parent: FsTarget, child: FsTarget): boolean {
      const a = this.target(parent), b = this.target(child)
      if (a.scope.workspace !== b.scope.workspace) return false
      const relative = posix.relative(a.relative, b.relative)
      return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
    }
    override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
      const { record, check } = await this.selectedTarget(target, signal)
      if (record.entryOnly) {
        const result = await record.backend.lstat(record.relative, signal).catch((error: unknown) => { throw nativeReadFailure(error) })
        try {
          check()
          const info = result.value
          return info === undefined ? undefined : { version: FsVersion(info.version), type: 'other' }
        } finally { result.release() }
      }
      const value = await record.backend.reader.stat(await record.backend.reader.resolve(record.relative,
        signal === undefined ? undefined : { signal }), signal)
      check()
      return value
    }
    override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
      try {
        const { record, check } = await this.selectedTarget(target, signal)
        this.content(record)
        const result = await record.backend.readText(record.relative, signal)
        try { check(); signal?.throwIfAborted(); return result.value } finally { result.release() }
      } catch (error) { throw nativeReadFailure(error) }
    }
    override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      const { record, check } = await this.selectedTarget(target, signal)
      this.content(record)
      const stream = await record.backend.reader.streamText(await record.backend.reader.resolve(record.relative,
        signal === undefined ? undefined : { signal }), signal)
      check()
      return (async function* () {
        check()
        signal?.throwIfAborted()
        for await (const text of stream) { check(); signal?.throwIfAborted(); yield text }
        check()
      })()
    }
    override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
      try {
        const { record, check } = await this.selectedTarget(target, signal)
        this.content(record)
        if (record.relative === '.') throw new FsError('A regular file target is required.', 'FS_NOT_REGULAR_FILE')
        if (record.relative === '.pe/attachments' || record.relative.startsWith('.pe/attachments/')) {
          throw new FsError('Stored attachment copies are read-only.', 'FS_PERMISSION_DENIED')
        }
        const result = await record.backend.writeText(record.relative, content, expected, signal)
        try { check(); return result.value } finally { result.release() }
      } catch (error) {
        if (error instanceof FdTextWriteFailure) throw new FsError(error.outcome === 'unknown'
          ? 'File write could not be confirmed. Further writes are blocked; ask the account operator to reconcile the file before retrying.'
          : 'Cloud file write failed.', error.code, { cause: error })
        throw nativeReadFailure(error)
      }
    }
    override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
      try {
        const { scope, backend } = await this.selectedProject(signal)
        const result = await backend.lstat(this.path(backend, path, opts?.cwd), signal)
        try {
          this.selection(scope, signal)
          backend.assertCurrent()
          const info = result.value
          return info === undefined ? undefined : { version: FsVersion(info.version), type: info.type,
            ...info.size === undefined ? {} : { size: info.size } }
        } finally { result.release() }
      } catch (error) { throw nativeReadFailure(error) }
    }
    override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      try {
        const { record, check } = await this.selectedTarget(target, signal)
        this.content(record)
        const result = await record.backend.readBytes(record.relative, maxBytes, signal)
        try { check(); this.current(signal); return result.value.slice() } finally { result.release() }
      } catch (error) { throw nativeReadFailure(error) }
    }
    override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
      try {
        const { record, check } = await this.selectedTarget(target, signal)
        this.content(record)
        const result = await record.backend.readByteRange(record.relative, range, signal)
        try { check(); this.current(signal); return result.value } finally { result.release() }
      } catch (error) { throw nativeReadFailure(error) }
    }
    override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
      try {
        const { record, check } = await this.selectedTarget(target, signal)
        this.content(record)
        const result = await record.backend.listDir(record.relative, signal)
        try {
          check()
          const entries = result.value.map((entry): FsDirEntry => {
            const relative = this.path(record.backend, posix.join(record.relative, entry.name))
            const entryOnly = entry.type === 'symlink' || entry.type === 'other'
            return { name: entry.name, type: entry.type === 'file' ? 'file' : entry.type === 'directory' ? 'directory' : 'other',
              target: this.issue(record.scope, record.backend, relative, entryOnly), version: FsVersion(entry.version),
              ...entry.type === 'file' ? { size: entry.size } : {} }
          })
          check()
          this.current(signal)
          return entries
        } finally { result.release() }
      } catch (error) { throw nativeReadFailure(error) }
    }
    override editText(): Promise<FsEditOutcome> { return this.denied() }
    override watch(): Promise<() => Promise<void>> {
      return new Promise((_resolve, reject) => {
        this.current()
        reject(new FsError('Cloud filesystem watching is unsupported.', 'FS_PERMISSION_DENIED'))
      })
    }
  }
}
