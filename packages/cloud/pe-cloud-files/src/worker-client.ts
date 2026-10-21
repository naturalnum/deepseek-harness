/** Worker transport retains operations until actual FD-closure replies or actual worker exit. */
import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FsErrorCode, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { FdTaskRequest, FdRootIdentity, FdMetadata, FdDirectoryRequest, FdDirectoryObservation, LeafBackend,
  FdStorageRequest, FdStorageView, FdTextWriteRequest, FdTextWriteResult, FdContentRequest, FdPathMetadata, FdDirectoryEntry } from './worker-protocol.ts'
import { FilesFailure } from './error.ts'
import { DirectoryMetadataFailure } from './directory-error.ts'
import { parseLeafFrame, leafPreparation, DirectoryPreparationFailure } from './leaf-frame.ts'
import type { LeafFrame } from './leaf-frame.ts'
import type { DirectoryPrepareOutcome, DirectoryCreatedIdentity } from './directory-responsibility.ts'
import { parseStorageProbeFrame } from './storage-probe.ts'
import type { StorageProbeFacts } from './storage-types.ts'
import type { StagingFacts } from './staging-native.ts'
import type { FdStageFile, FdStageResult } from './worker-protocol.ts'
import { parseEnvironmentLayoutFrame, parseProjectMetadataFrame } from './worker-protocol.ts'
import type { FdProjectMetadataFacts, FdProjectMetadataRequest, FdProjectMetadataResult } from './worker-protocol.ts'
import type { FdEnvironmentLayout, FdEnvironmentLayoutFacts, FdEnvironmentLayoutRequest } from './worker-protocol.ts'

/** Transport failure retains the native error category without private paths. */
export class FdWorkerFailure extends Error {
  constructor(readonly code: FsErrorCode, readonly syscallCode?: string) { super(code) }
}

/** Shared mutation disposition; an unknown result never releases actual-operation ownership. */
export class FdMutationFailure extends FdWorkerFailure {
  constructor(readonly outcome: 'not-published' | 'unknown', code: FsErrorCode, syscallCode?: string, options?: ErrorOptions) {
    super(code, syscallCode)
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** Text publication retains its original error class and shared mutation disposition. */
export class FdTextWriteFailure extends FdMutationFailure {}

/** Fixed-directory effects retain actual native facts; transport loss never invents a closed preparation. */
export class FdProjectMetadataFailure extends FdMutationFailure {
  constructor(outcome: 'not-published' | 'unknown', code: FsErrorCode, readonly facts?: FdProjectMetadataFacts,
    syscallCode?: string, options?: ErrorOptions) {
    super(outcome, outcome === 'unknown' ? 'FS_IO_ERROR' : code, syscallCode, options)
  }
}

/** Environment initialization preserves partial directory facts and actual operation responsibility. */
export class FdEnvironmentLayoutFailure extends FdMutationFailure {
  constructor(outcome: 'not-published' | 'unknown', code: FsErrorCode, readonly facts?: FdEnvironmentLayoutFacts,
    syscallCode?: string, options?: ErrorOptions) {
    super(outcome, outcome === 'unknown' ? 'FS_IO_ERROR' : code, syscallCode, options)
  }
}

/** Staging distinguishes proven sink cleanup from uncertain effects; source closure remains separate. */
export class FdStageFailure extends FdMutationFailure {
  constructor(outcome: 'not-published' | 'unknown', code: FsErrorCode, readonly facts?: StagingFacts, options?: ErrorOptions) {
    super(outcome, outcome === 'unknown' ? 'FS_IO_ERROR' : code, undefined, options)
  }
}

/** One borrowed worker transaction; abort signals intent, settled waits for actual reply or exit. */
export interface FdStageSink {
  readonly ready: Promise<'write' | 'reused'>
  readonly settled: Promise<FdStageResult>
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  finishSource(): Promise<FdStageResult>
  abort(): void
}

/** One outstanding pull, with an independent actual-completion promise for queue ownership. */
export interface FdByteStream {
  readonly finished: Promise<void>
  next(): Promise<IteratorResult<Uint8Array<ArrayBuffer>>>
  cancel(): void
}

interface PendingBase {
  readonly id: OperationId
  readonly maxBytes: number
  readonly cancel: Int32Array<SharedArrayBuffer>
  readonly removeAbort: () => void
}
interface PendingRead extends PendingBase {
  readonly kind: 'read'
  readonly resolve: (bytes: Uint8Array<ArrayBuffer>) => void
  readonly reject: (error: Error) => void
}
interface PendingStat extends PendingBase {
  readonly kind: 'stat'
  readonly resolve: (info: FdMetadata | undefined) => void
  readonly reject: (error: Error) => void
}
interface PendingContent extends PendingBase {
  readonly kind: 'lstat' | 'list' | 'range'
  readonly maxEntries: number
  readonly accept: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}
interface PendingTextWrite extends PendingBase {
  readonly kind: 'text-write'
  readonly content: string
  readonly resolve: (value: FdTextWriteResult) => void
  readonly reject: (error: Error) => void
}
interface PendingProjectMetadata extends PendingBase {
  readonly kind: 'project-metadata'
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly resolve: (result: FdProjectMetadataResult) => void
  readonly reject: (error: Error) => void
}
interface PendingEnvironmentLayout extends PendingBase {
  readonly kind: 'environment-layout'
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly resolve: (result: FdEnvironmentLayout) => void
  readonly reject: (error: Error) => void
}
type StageStep = { readonly kind: 'starting' } | { readonly kind: 'writing'; readonly sequence: number; readonly total: number }
  | {
    readonly kind: 'ack'
    readonly sequence: number
    readonly total: number
    readonly size: number
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }
  | { readonly kind: 'finishing' }
interface PendingStage extends PendingBase {
  readonly kind: 'stage'
  readonly file: FdStageFile
  readonly chunkBytes: number
  readonly frameBytes: number
  readonly resolveReady: (mode: 'write' | 'reused') => void
  readonly rejectReady: (error: Error) => void
  readonly resolve: (result: FdStageResult) => void
  readonly reject: (error: Error) => void
  step: StageStep
}
interface PendingDirectory extends PendingBase {
  readonly kind: 'directory'
  readonly maxPathBytes: number
  readonly resolve: (value: FdDirectoryObservation) => void
  readonly reject: (error: Error) => void
}
interface PendingLeaf extends PendingBase {
  readonly kind: 'leaf-prepare' | 'leaf-cleanup'
  readonly root: FdRootIdentity
  readonly identity?: DirectoryCreatedIdentity
  readonly backend: LeafBackend
  readonly resolve: (frame: LeafFrame) => void
  readonly reject: (error: Error) => void
}
interface PendingStorage extends PendingBase {
  readonly kind: 'storage-probe' | 'storage-record' | 'storage-view'
  readonly accept: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}
interface Pull {
  readonly resolve: (result: IteratorResult<Uint8Array<ArrayBuffer>>) => void
  readonly reject: (error: Error) => void
}
interface PendingStream extends PendingBase {
  readonly kind: 'stream'
  readonly maxChunkBytes: number
  readonly finish: (error?: Error) => void
  pull: Pull | undefined
  ready: boolean
  cancelled: boolean
  total: number
}
type Pending = PendingContent | PendingRead | PendingStat | PendingStream | PendingDirectory
  | PendingLeaf | PendingStorage | PendingTextWrite | PendingStage | PendingProjectMetadata | PendingEnvironmentLayout

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function wireError(value: Record<string, unknown>): FdWorkerFailure | undefined {
  if (typeof value.code !== 'string'
    || !['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_REGULAR_FILE', 'FS_NOT_TEXT', 'FS_TOO_LARGE',
      'FS_PERMISSION_DENIED', 'FS_ABORTED', 'FS_IO_ERROR', 'FS_NOT_OBSERVED', 'FS_STALE_VERSION'].includes(value.code)
    || (value.syscallCode !== undefined && (typeof value.syscallCode !== 'string' || !/^[A-Z]{1,16}$/.test(value.syscallCode)))) return undefined
  return new FdWorkerFailure(value.code as FsErrorCode, value.syscallCode)
}
function metadata(value: unknown): FdMetadata | undefined {
  if (!object(value) || typeof value.identity !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(value.identity)
    || typeof value.version !== 'string' || !/^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(value.version)
    || (value.type !== 'file' && value.type !== 'directory')
    || (value.type === 'file' && (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0))
    || (value.type === 'directory' && value.size !== undefined)) return undefined
  return { identity: value.identity, version: value.version, type: value.type, ...typeof value.size === 'number' ? { size: value.size } : {} }
}

function pathMetadata(value: unknown, named = false): FdPathMetadata | undefined {
  if (!object(value) || Object.keys(value).some(key => !['identity', 'version', 'type', 'size', ...named ? ['name'] : []].includes(key))
    || typeof value.identity !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(value.identity)
    || typeof value.version !== 'string' || !/^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(value.version)
    || !value.version.startsWith(value.identity + ':')
    || typeof value.size === 'number' && Number(value.version.split(':')[2]) !== value.size
    || !['file', 'directory', 'symlink', 'other'].includes(String(value.type))
    || (value.type === 'file' || value.type === 'symlink'
      ? typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 : value.size !== undefined)) return undefined
  return { identity: value.identity, version: value.version, type: value.type as FdPathMetadata['type'],
    ...typeof value.size === 'number' ? { size: value.size } : {} }
}

function stagingFacts(value: unknown, maximum: number, chunk: number): value is StagingFacts {
  if (!object(value) || Object.keys(value).length !== 10
    || Object.keys(value).some(key => !['kind', 'code', 'publication', 'closed', 'clean', 'temporaryPresent',
      'writtenBytes', 'readBytes', 'sequence', 'retainedCreatedDirectories'].includes(key))) return false
  return ['write', 'written', 'existing', 'existing-chunk', 'published', 'reused', 'aborted', 'failed', 'unknown'].includes(String(value.kind))
    && typeof value.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)
    && ['none', 'published', 'unknown'].includes(String(value.publication))
    && [value.closed, value.clean, value.temporaryPresent].every(item => typeof item === 'boolean')
    && [value.writtenBytes, value.readBytes, value.sequence, value.retainedCreatedDirectories]
      .every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
    && typeof value.writtenBytes === 'number' && value.writtenBytes <= maximum
    && typeof value.readBytes === 'number' && value.readBytes <= maximum + chunk
    && typeof value.retainedCreatedDirectories === 'number' && value.retainedCreatedDirectories <= 3
}

/** One exclusive prebuilt slot; a stream owns the slot between pulls as well as during reads. */
export class FdWorkerClient {
  /** Resolves after the required worker ABI handshake, or rejects on startup failure. */
  readonly ready: Promise<void>
  /** Resolves with the actual worker exit code after its exit event is observed. */
  readonly exited: Promise<number>
  private readyResolved = false
  private storageVersion: 1 | undefined
  private abiVersion: 6 | 7 | 8 | undefined
  private stagingVersion: 1 | undefined
  private projectMetadataVersion: 1 | undefined
  private environmentLayoutVersion: 1 | undefined
  private closed = false
  private failure: Error | undefined
  private pending: Pending | undefined
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveExit!: (code: number) => void

  constructor(private readonly worker: Worker) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.exited = new Promise<number>((resolve) => { this.resolveExit = resolve })
    // Keep initialization failures observed even before the pool installs its waiter.
    void this.ready.catch(() => {})
    worker.on('message', (value: unknown) => { this.message(value) })
    worker.on('error', (_error: Error) => { this.failure = new FdWorkerFailure('FS_IO_ERROR'); void this.close() })
    worker.once('exit', (code: number) => {
      this.closed = true
      const error = this.failure ?? new FdWorkerFailure('FS_IO_ERROR')
      if (!this.readyResolved) this.rejectReady(error)
      this.failPending(error)
      this.resolveExit(code)
    })
  }

  /** Whether this exact prebuilt worker completed the independent text-capable ABI handshake. */
  get supportsTextWrites(): boolean { return this.abiVersion === 7 || this.abiVersion === 8 }

  /** Whether the worker supports bounded nofollow/list/range commands. */
  get supportsContentReads(): boolean { return this.abiVersion === 8 }

  /** The separate staging companion must complete its own real worker handshake. */
  get supportsStaging(): boolean { return this.stagingVersion === 1 }

  /** Actual independent fixed-.pe capability, never inferred from the content ABI. */
  get supportsProjectMetadata(): boolean { return this.projectMetadataVersion === 1 }
  /** Whether this worker advertised the independent environment-layout version1 capability. */
  get supportsEnvironmentLayout(): boolean { return this.environmentLayoutVersion === 1 }

  /**
   * Prepare only home/venv/tmp in the selected environment without clearing retained Session content.
   * @param root Protected original environment anchor.
   * @param uid Expected deployment application UID.
   * @param gid Expected deployment application GID.
   * @param signal Original operation cancellation; effects remain owned until receipt or actual worker exit.
   * @returns Fixed durable identities after all descriptor closure.
   */
  prepareEnvironmentLayout(root: FdRootIdentity, uid: number, gid: number, signal: AbortSignal): Promise<FdEnvironmentLayout> {
    try { this.assertAvailable(signal) } catch (cause) {
      throw new FdEnvironmentLayoutFailure('not-published', cause instanceof FdWorkerFailure ? cause.code : 'FS_IO_ERROR',
        undefined, undefined, { cause })
    }
    if (!this.supportsEnvironmentLayout || root.rootMountId === undefined) {
      throw new FdEnvironmentLayoutFailure('not-published', 'FS_PERMISSION_DENIED')
    }
    return new Promise((resolve, reject) => {
      const pending: PendingEnvironmentLayout = { kind: 'environment-layout', ...this.base(256, signal), root, uid, gid, resolve, reject }
      this.pending = pending
      const request: FdEnvironmentLayoutRequest = { kind: 'environment-layout-prepare', id: pending.id, root, uid, gid,
        cancel: pending.cancel.buffer }
      this.post(request)
    })
  }

  /**
   * Prepare only .pe beneath the original project anchor; cancellation does not replace native creation facts.
   * @param root Original project directory/mount identity.
   * @param uid Expected deployment application UID.
   * @param gid Expected deployment application GID.
   * @param signal Actual original work cancellation; all effects remain owned until receipt or actual exit.
   * @returns Durable directory identity only after native fsync and descriptor closure.
   */
  prepareProjectMetadata(root: FdRootIdentity, uid: number, gid: number, signal: AbortSignal): Promise<FdProjectMetadataResult> {
    try { this.assertAvailable(signal) } catch (cause) {
      throw new FdProjectMetadataFailure('not-published', cause instanceof FdWorkerFailure ? cause.code : 'FS_IO_ERROR',
        undefined, undefined, { cause })
    }
    if (!this.supportsProjectMetadata || root.rootMountId === undefined) throw new FdProjectMetadataFailure('not-published', 'FS_PERMISSION_DENIED')
    return new Promise((resolve, reject) => {
      const pending: PendingProjectMetadata = { kind: 'project-metadata', ...this.base(96, signal), root, uid, gid, resolve, reject }
      this.pending = pending
      const request: FdProjectMetadataRequest = { kind: 'project-metadata-prepare', id: pending.id, root, uid, gid,
        cancel: pending.cancel.buffer }
      this.post(request)
    })
  }

  /**
   * Begin one closed-lifecycle binary sink on the already borrowed slot.
   * @param root Original selected persistent project anchor.
   * @param file Native-authorized and bounded descriptor.
   * @param chunkBytes Complete binary-frame cap; exactly one ACK may be pending.
   * @param frameBytes Existing complete metadata-frame cap.
   * @param signal Actual work cancellation; abort never settles ownership by itself.
   * @returns A sink whose settled promise waits for the actual terminal reply or worker exit.
   */
  beginStage(root: FdRootIdentity, file: FdStageFile, chunkBytes: number, frameBytes: number, signal: AbortSignal): FdStageSink {
    try { this.assertAvailable(signal) } catch (error) {
      throw new FdStageFailure(error instanceof FdWorkerFailure || error instanceof FilesFailure ? 'not-published' : 'unknown',
        error instanceof FdWorkerFailure ? error.code : 'FS_IO_ERROR', undefined, { cause: error })
    }
    if (!this.supportsStaging || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1
      || !Number.isSafeInteger(frameBytes) || frameBytes < 1) throw new FdStageFailure('not-published', 'FS_PERMISSION_DENIED')
    const ready = Promise.withResolvers<'write' | 'reused'>(), completed = Promise.withResolvers<FdStageResult>()
    void ready.promise.catch(() => {}); void completed.promise.catch(() => {})
    const pending: PendingStage = { kind: 'stage', ...this.base(file.expectedBytes, signal), file, chunkBytes, frameBytes,
      resolveReady: ready.resolve, rejectReady: ready.reject, resolve: completed.resolve, reject: completed.reject, step: { kind: 'starting' } }
    this.pending = pending
    this.post({ kind: 'stage-begin', id: pending.id, root, file, cancel: pending.cancel.buffer })
    return {
      ready: ready.promise, settled: completed.promise,
      write: (bytes) => {
        const step = pending.step
        if (this.pending !== pending || step.kind !== 'writing' || Atomics.load(pending.cancel, 0) !== 0
          || !(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0
          || bytes.byteLength !== bytes.buffer.byteLength || bytes.byteLength < 1 || bytes.byteLength > chunkBytes
          || step.total + bytes.byteLength > file.expectedBytes) {
          this.cancelStage(pending)
          return Promise.reject(new FdStageFailure('not-published', 'FS_TOO_LARGE'))
        }
        return new Promise<void>((resolve, reject) => {
          pending.step = { kind: 'ack', sequence: step.sequence, total: step.total, size: bytes.byteLength, resolve, reject }
          this.post({ kind: 'stage-chunk', id: pending.id, sequence: step.sequence, bytes }, [bytes.buffer])
        })
      },
      finishSource: () => {
        const step = pending.step
        if (this.pending !== pending || step.kind !== 'writing' || step.total !== file.expectedBytes
          || Atomics.load(pending.cancel, 0) !== 0) {
          this.cancelStage(pending)
          return Promise.reject(new FdStageFailure('not-published', 'FS_ABORTED'))
        }
        pending.step = { kind: 'finishing' }
        this.post({ kind: 'stage-source-complete', id: pending.id })
        this.post({ kind: 'stage-finish', id: pending.id })
        return completed.promise
      },
      abort: () => { this.cancelStage(pending) },
    }
  }

  /**
   * Publish one bounded UTF-8 replacement; cancellation never releases actual transport ownership.
   * @param root Already authorized fixed project anchor.
   * @param relativePath Existing-parent target beneath that anchor.
   * @param content Complete bounded UTF-8 content; the result alone normalizes newlines.
   * @param expected Native create/version guard, or unconditional replacement.
   * @param maxBytes Explicit existing text byte limit.
   * @param signal Shared cancellation observed before publication.
   * @returns Durable outcome after descriptors close; unknown effects reject distinctly.
   */
  writeText(
    root: FdRootIdentity, relativePath: string, content: string, expected: FsWriteIntent | undefined,
    maxBytes: number, signal: AbortSignal,
  ): Promise<FdTextWriteResult> {
    try { this.assertAvailable(signal) } catch (error) {
      if (error instanceof FdWorkerFailure) throw new FdTextWriteFailure('not-published', error.code, error.syscallCode, { cause: error })
      throw error
    }
    if (!this.supportsTextWrites) throw new FdTextWriteFailure('not-published', 'FS_PERMISSION_DENIED')
    if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new FdTextWriteFailure('not-published', 'FS_TOO_LARGE')
    return new Promise((resolve, reject) => {
      const pending: PendingTextWrite = { kind: 'text-write', ...this.base(maxBytes, signal), content, resolve, reject }
      this.pending = pending
      this.post({ kind: 'text-write', id: pending.id, root, relativePath, content, maxBytes,
        ...expected === undefined ? {} : { expected }, cancel: pending.cancel.buffer } satisfies FdTextWriteRequest)
    })
  }

  /**
   * Observe the final entry without following it; absence returns undefined.
   * @param root Previously authorized fixed project identity.
   * @param relativePath Bounded project-relative path.
   * @param signal Cancellation retains transport ownership until reply or exit.
   * @returns Closed-FD path metadata; ABI6/7 reject before dispatch.
   */
  lstat(root: FdRootIdentity, relativePath: string, signal: AbortSignal): Promise<FdPathMetadata | undefined> {
    return this.content({ kind: 'lstat' }, root, relativePath, 1024, 0, signal, (value) => {
      if (value.kind !== 'lstat-reply') throw new FdWorkerFailure('FS_IO_ERROR')
      const result = pathMetadata(value.metadata)
      if (value.metadata !== undefined && result === undefined) throw new FdWorkerFailure('FS_IO_ERROR')
      return result
    })
  }

  /**
   * List direct children with strict complete-reply and entry bounds; excess rejects.
   * @param root Previously authorized fixed project identity.
   * @param relativePath Project-relative directory.
   * @param maxEntries Maximum direct children, not a recursive traversal limit.
   * @param maxBytes Complete encoded reply budget including names and metadata.
   * @param signal Cancellation retains actual ownership.
   * @returns Stable UTF-8 byte-sorted nofollow entries after all descriptors close.
   */
  list(
    root: FdRootIdentity, relativePath: string, maxEntries: number, maxBytes: number, signal: AbortSignal,
  ): Promise<readonly FdDirectoryEntry[]> {
    return this.content({ kind: 'list', maxEntries, maxBytes }, root, relativePath, maxBytes, maxEntries, signal, (value) => {
      if (value.kind !== 'list-reply' || !Array.isArray(value.entries) || value.entries.length > maxEntries) throw new FdWorkerFailure('FS_IO_ERROR')
      const entries: FdDirectoryEntry[] = []
      let previous: Buffer | undefined
      for (const entry of value.entries) {
        const info = pathMetadata(entry, true)
        if (!object(entry) || info === undefined || typeof entry.name !== 'string' || !entry.name
          || entry.name === '.' || entry.name === '..' || /[/\\\0]/.test(entry.name)
          || Buffer.byteLength(entry.name) > maxBytes || Buffer.from(entry.name).toString('utf8') !== entry.name) throw new FdWorkerFailure('FS_IO_ERROR')
        const name = Buffer.from(entry.name)
        if (previous !== undefined && Buffer.compare(previous, name) >= 0) throw new FdWorkerFailure('FS_IO_ERROR')
        previous = name
        entries.push({ name: entry.name, ...info })
      }
      return entries
    })
  }

  /**
   * Read at most length bytes at a safe positional offset, including an empty EOF result.
   * @param root Previously authorized fixed project identity.
   * @param relativePath Project-relative regular file.
   * @param offset Nonnegative safe byte offset.
   * @param length Nonnegative safe window length.
   * @param maxBytes Inclusive window byte ceiling; no full-file-size restriction.
   * @param signal Cancellation retains actual ownership.
   * @returns Exact transferred window after descriptor closure.
   */
  readRange(
    root: FdRootIdentity, relativePath: string, offset: number, length: number, maxBytes: number, signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
      || !Number.isSafeInteger(offset + length) || length > maxBytes) return Promise.reject(new FdWorkerFailure('FS_TOO_LARGE'))
    return this.content({ kind: 'range', offset, length, maxBytes }, root, relativePath, maxBytes, 0, signal, (value) => {
      const bytes = value.bytes
      if (value.kind !== 'range-reply' || !(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
        || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength || bytes.byteLength > length) throw new FdWorkerFailure('FS_IO_ERROR')
      return new Uint8Array(bytes.buffer)
    })
  }

  private content<T>(
    command: { kind: 'lstat' } | { kind: 'list'; maxEntries: number; maxBytes: number }
      | { kind: 'range'; offset: number; length: number; maxBytes: number },
    root: FdRootIdentity, relativePath: string, maxBytes: number, maxEntries: number, signal: AbortSignal,
    decode: (value: Record<string, unknown>) => T,
  ): Promise<T> {
    try {
      this.assertAvailable(signal)
      if (!this.supportsContentReads) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 2_147_483_647 || (command.kind === 'list'
        && (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxBytes < 1))) throw new FdWorkerFailure('FS_TOO_LARGE')
    } catch (error) { return Promise.reject(error instanceof Error ? error : new FdWorkerFailure('FS_IO_ERROR')) }
    return new Promise((resolve, reject) => {
      const pending: PendingContent = { kind: command.kind, ...this.base(maxBytes, signal), maxEntries, reject, accept: (value) => {
        try {
          const keys = command.kind === 'list' ? ['kind', 'id', 'entries'] : command.kind === 'lstat' ? ['kind', 'id', 'metadata'] : ['kind', 'id', 'bytes']
          if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new FdWorkerFailure('FS_IO_ERROR')
          const result = decode(value)
          if (command.kind !== 'range' && Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new FdWorkerFailure('FS_IO_ERROR')
          pending.removeAbort(); this.pending = undefined; resolve(result)
        } catch (_error) { this.failProtocol() }
      } }
      this.pending = pending
      this.post({ ...command, id: pending.id, root, relativePath, cancel: pending.cancel.buffer } satisfies FdContentRequest)
    })
  }

  /**
   * Probe one fixed root deployment selector on the existing worker.
   * @param path Fixed root deployment selector.
   * @param signal Actual operation cancellation; ownership lasts until reply or exit.
   * @returns Closed-FD measured facts.
   */
  storageProbe(path: string, signal: AbortSignal): Promise<StorageProbeFacts> {
    return this.storage('storage-probe', 256, signal, value => value.kind === 'storage-probe-reply' ? parseStorageProbeFrame(value.frame) : undefined, path)
  }

  /**
   * Read the protected deployment record on the existing worker.
   * @param maximum Root record byte bound.
   * @param signal Actual operation cancellation; ownership lasts until reply or exit.
   * @returns Protected record bytes after closure.
   */
  storageRecord(maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return this.storage('storage-record', maximum, signal, value => value.kind === 'storage-record-reply' && this.exactBytes(value.bytes, maximum) ? value.bytes : undefined)
  }

  /**
   * Inspect bounded process and mount facts on the existing worker.
   * @param maximum Per-proc-file byte bound.
   * @param signal Actual operation cancellation; ownership lasts until reply or exit.
   * @returns Bounded process and mount view after closure.
   */
  storageView(maximum: number, signal: AbortSignal): Promise<FdStorageView> {
    return this.storage('storage-view', 2 * maximum, signal, (value) => {
      if (value.kind !== 'storage-view-reply' || !object(value.view)
        || !this.exactBytes(value.view.mountInfo, maximum) || !this.exactBytes(value.view.status, maximum)) return undefined
      return { mountInfo: value.view.mountInfo, status: value.view.status }
    })
  }

  private storage<T>(
    kind: PendingStorage['kind'], maximum: number, signal: AbortSignal,
    decode: (value: Record<string, unknown>) => T | undefined, path?: string,
  ): Promise<T> {
    this.assertAvailable(signal)
    if (this.storageVersion !== 1) throw new FdWorkerFailure('FS_IO_ERROR')
    return new Promise((resolve, reject) => {
      const pending: PendingStorage = { kind, ...this.base(maximum, signal), reject, accept: (value) => {
        const result = decode(value)
        if (result === undefined) { this.failProtocol(); return }
        pending.removeAbort(); this.pending = undefined; resolve(result)
      } }
      this.pending = pending
      const base = { id: pending.id, cancel: pending.cancel.buffer }
      if (kind === 'storage-probe' && path !== undefined) this.post({ ...base, kind, path } satisfies FdStorageRequest)
      else if (kind === 'storage-record' || kind === 'storage-view') this.post({ ...base, kind } satisfies FdStorageRequest)
      else this.failProtocol()
    })
  }

  private exactBytes(value: unknown, limit: number): value is Uint8Array<ArrayBuffer> {
    return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer && value.byteOffset === 0
      && value.byteLength === value.buffer.byteLength && value.byteLength > 0 && value.byteLength <= limit
  }

  /**
   * Read once; cancellation marks the request without settling actual ownership.
   * @param root Previously approved root and independently verified device/inode identity.
   * @param relativePath Bounded relative path beneath that root.
   * @param maxBytes Inclusive byte cap on the complete content.
   * @param signal Signals cancellation while actual reply or exit still owns completion.
   * @returns Transferred bytes after confirmed FD closure, or a failure after reply or actual exit.
   */
  read(root: FdRootIdentity, relativePath: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    try { this.assertAvailable(signal) } catch (error) { return Promise.reject(error instanceof Error ? error : new FdWorkerFailure('FS_IO_ERROR')) }
    return new Promise((resolve, reject) => {
      const pending: PendingRead = { kind: 'read', ...this.base(maxBytes, signal), resolve, reject }
      this.pending = pending
      this.postTask(pending, root, relativePath)
    })
  }

  /**
   * Observe bounded FD metadata; absence is a successful undefined result.
   * @param root Previously approved root and independently verified device/inode identity.
   * @param relativePath Bounded relative path beneath that root.
   * @param signal Signals cancellation while actual reply or exit still owns completion.
   * @returns The closed-FD metadata observation, or undefined for an absent target.
   */
  stat(root: FdRootIdentity, relativePath: string, signal: AbortSignal): Promise<FdMetadata | undefined> {
    try { this.assertAvailable(signal) } catch (error) { return Promise.reject(error instanceof Error ? error : new FdWorkerFailure('FS_IO_ERROR')) }
    return new Promise((resolve, reject) => {
      const pending: PendingStat = { kind: 'stat', ...this.base(0, signal), resolve, reject }
      this.pending = pending
      this.postTask(pending, root, relativePath)
    })
  }

  /**
   * Inspect a target through a verified anchor and bounded physical-spelling observation.
   * @param root Previously approved fixed root and independently verified identity.
   * @param relativePath Relative spelling resolved by the kernel beneath that root.
   * @param maxPathBytes Maximum raw and decoded canonical path length in bytes.
   * @param signal Signals cancellation without erasing actual work ownership.
   * @returns Metadata only after verified re-open and actual descriptor closure.
   */
  directory(root: FdRootIdentity, relativePath: string, maxPathBytes: number, signal: AbortSignal): Promise<FdDirectoryObservation> {
    try { this.assertAvailable(signal) } catch (error) {
      return Promise.reject(new DirectoryMetadataFailure('unavailable', 'transport', { cause: error }))
    }
    return new Promise((resolve, reject) => {
      const pending: PendingDirectory = { kind: 'directory', ...this.base(0, signal), maxPathBytes, resolve, reject }
      this.pending = pending
      this.post({ kind: 'directory', id: pending.id, root, relativePath, cancel: pending.cancel.buffer } satisfies FdDirectoryRequest)
    })
  }

  /**
   * Prepare one granted leaf; typed no-create failures remain failing business outcomes.
   * @param root Fixed trusted parent identity.
   * @param leaf Frozen server-selected basename.
   * @param signal Actual-operation cancellation, separate from an observer's wait.
   * @param backend Explicit tmpfs or verified independent ext4 branch.
   * @returns Actual creation facts after closed-FD frame or conservative transport failure.
   */
  async prepareLeaf(root: FdRootIdentity, leaf: string, signal: AbortSignal, backend: LeafBackend = 'tmpfs'): Promise<DirectoryPrepareOutcome> {
    try { this.assertAvailable(signal) } catch (_error) { return { kind: 'not-created-failure', failure: { errno: 11, phase: 0 } } }
    const result = leafPreparation(await this.leaf(root, leaf, signal, undefined, backend))
    if (!signal.aborted) return result
    if (result.kind === 'created') return { kind: 'created-known-failure', identity: result.identity, failure: { errno: 125, phase: 8 } }
    if (result.kind === 'unchanged') return { kind: 'not-created-failure', failure: { errno: 125, phase: 8 } }
    return result
  }

  /**
   * Remove only the original exact empty leaf through an already-owned cleanup operation.
   * @param root Original fixed parent.
   * @param leaf Original server-selected basename.
   * @param identity Actual created leaf identity.
   * @param signal Actual cleanup signal; observer cancellation does not cancel this ownership.
   * @param backend Original preparation backend; never changed for cleanup.
   * @returns Cleaned only after the successful closed-FD frame; other frames reject with bounded cause.
   */
  async removeEmptyLeaf(
    root: FdRootIdentity, leaf: string, identity: DirectoryCreatedIdentity, signal: AbortSignal, backend: LeafBackend = 'tmpfs',
  ): Promise<'cleaned'> {
    this.assertAvailable(signal)
    const result = await this.leaf(root, leaf, signal, identity, backend)
    if (result.tag !== 6) throw new DirectoryPreparationFailure('unknown', result.failure)
    return 'cleaned'
  }

  private leaf(root: FdRootIdentity, leaf: string, signal: AbortSignal, identity?: DirectoryCreatedIdentity, backend: LeafBackend = 'tmpfs'): Promise<LeafFrame> {
    return new Promise((resolve, reject) => {
      const pending: PendingLeaf = { ...this.base(64, signal), kind: identity === undefined ? 'leaf-prepare' : 'leaf-cleanup',
        root, backend, resolve, reject, ...identity === undefined ? {} : { identity } }
      this.pending = pending
      this.post({ kind: pending.kind, id: pending.id, root, leaf, backend, cancel: pending.cancel.buffer,
        ...identity === undefined ? {} : { identity } })
    })
  }

  /**
   * Open one FD stream with one pull credit; finished follows actual closure or exit.
   * @param root Previously approved root and independently verified device/inode identity.
   * @param relativePath Bounded relative path beneath that root.
   * @param maxBytes Inclusive byte cap on the complete raw content.
   * @param maxChunkBytes Largest transfer buffer accepted for one pull.
   * @param signal Signals cancellation while the stream retains actual-completion ownership.
   * @returns A single-credit byte stream with an independent actual-completion promise.
   */
  stream(root: FdRootIdentity, relativePath: string, maxBytes: number, maxChunkBytes: number, signal: AbortSignal): FdByteStream {
    this.assertAvailable(signal)
    const finished = Promise.withResolvers<void>()
    // The queue also observes finished; this closes the pre-registration rejection gap.
    void finished.promise.catch(() => {})
    const pending: PendingStream = {
      kind: 'stream', ...this.base(maxBytes, signal), maxChunkBytes,
      ready: false, cancelled: false, total: 0, pull: undefined,
      finish: (error) => {
        if (pending.pull !== undefined) {
          if (error === undefined) pending.pull.resolve({ done: true, value: undefined })
          else pending.pull.reject(error)
          pending.pull = undefined
        }
        if (error === undefined) finished.resolve()
        else finished.reject(error)
      },
    }
    this.pending = pending
    this.postTask(pending, root, relativePath)
    return {
      finished: finished.promise,
      next: () => {
        if (this.pending !== pending) return finished.promise.then(() => ({ done: true, value: undefined }))
        if (pending.cancelled) return Promise.reject(new FdWorkerFailure('FS_ABORTED'))
        if (pending.pull !== undefined) return Promise.reject(new FilesFailure('cloud/capacity', 'files stream has an outstanding pull'))
        return new Promise((resolve, reject) => {
          pending.pull = { resolve, reject }
          if (pending.ready) this.post({ kind: 'stream-pull', id: pending.id })
        })
      },
      cancel: () => { if (this.pending === pending) this.cancelPending(pending) },
    }
  }

  /** Healthy admission excludes startup, failure and a requested or observed exit. */
  get available(): boolean { return this.readyResolved && !this.closed && this.failure === undefined }

  /**
   * Request termination; actual exit alone completes unresolved transport ownership.
   * @returns The actual exit code once the worker's exit event is observed.
   */
  close(): Promise<number> {
    if (!this.closed) {
      this.closed = true
      if (this.pending !== undefined) Atomics.store(this.pending.cancel, 0, 1)
      void this.worker.terminate().catch((_error: unknown) => {
        console.error('cloud files worker termination is unconfirmed; retain cleanup ownership')
      })
    }
    return this.exited
  }

  private assertAvailable(signal: AbortSignal): void {
    if (!this.available) throw new FdWorkerFailure('FS_IO_ERROR')
    if (signal.aborted) throw new FdWorkerFailure('FS_ABORTED')
    if (this.pending !== undefined) throw new FilesFailure('cloud/capacity', 'files worker slot is busy')
  }

  private base(maxBytes: number, signal: AbortSignal): PendingBase {
    const id = randomUUID() as OperationId
    const cancel = new Int32Array(new SharedArrayBuffer(4))
    const abort = (): void => {
      if (this.pending?.id === id && this.pending.kind === 'stage') { this.cancelStage(this.pending); return }
      Atomics.store(cancel, 0, 1)
      if (this.pending?.id === id && this.pending.kind === 'stream') this.cancelPending(this.pending)
    }
    signal.addEventListener('abort', abort, { once: true })
    return { id, maxBytes, cancel, removeAbort: () => { signal.removeEventListener('abort', abort) } }
  }

  private postTask(pending: PendingRead | PendingStat | PendingStream, root: FdRootIdentity, relativePath: string): void {
    this.post({
      kind: pending.kind, id: pending.id, root, relativePath, maxBytes: pending.maxBytes, cancel: pending.cancel.buffer,
    } satisfies FdTaskRequest)
  }

  private post(message: object, transfer: ArrayBuffer[] = []): void {
    try { this.worker.postMessage(message, transfer) } catch (_error) { this.failProtocol() }
  }

  private cancelStage(pending: PendingStage): void {
    if (this.pending !== pending || Atomics.exchange(pending.cancel, 0, 1) !== 0) return
    this.post({ kind: 'stage-abort', id: pending.id })
  }

  private cancelPending(pending: PendingStream): void {
    if (pending.cancelled) return
    pending.cancelled = true
    Atomics.store(pending.cancel, 0, 1)
    pending.pull?.reject(new FdWorkerFailure('FS_ABORTED'))
    pending.pull = undefined
    this.post({ kind: 'stream-cancel', id: pending.id })
  }

  private message(value: unknown): void {
    if (this.failure !== undefined) return
    if (!object(value)) { this.failProtocol(); return }
    if (value.kind === 'ready') {
      if ((value.abiVersion !== 6 && value.abiVersion !== 7 && value.abiVersion !== 8) || this.readyResolved || this.closed
        || (value.storageProbeVersion !== undefined && value.storageProbeVersion !== 1)
        || (value.stagingAbiVersion !== undefined && value.stagingAbiVersion !== 1)
        || (value.projectMetadataVersion !== undefined && (value.projectMetadataVersion !== 1 || value.abiVersion !== 8))
        || (value.environmentLayoutVersion !== undefined && (value.environmentLayoutVersion !== 1 || value.abiVersion !== 8))) {
        this.failProtocol(); return
      }
      this.storageVersion = value.storageProbeVersion
      this.abiVersion = value.abiVersion
      this.stagingVersion = value.stagingAbiVersion
      this.projectMetadataVersion = value.projectMetadataVersion
      this.environmentLayoutVersion = value.environmentLayoutVersion
      this.readyResolved = true
      this.resolveReady()
      return
    }
    if (value.kind === 'startup-failed' && !this.readyResolved) {
      this.failure = wireError(value) ?? new FdWorkerFailure('FS_IO_ERROR')
      this.rejectReady(this.failure)
      void this.close()
      return
    }
    const pending = this.pending
    if (pending === undefined || value.id !== pending.id) { this.failProtocol(); return }
    if (pending.kind === 'stage') { this.stageMessage(pending, value); return }
    if (pending.kind === 'project-metadata') { this.projectMetadataMessage(pending, value); return }
    if (pending.kind === 'environment-layout') { this.environmentLayoutMessage(pending, value); return }
    if (pending.kind === 'text-write') { this.textWriteMessage(pending, value); return }
    if (pending.kind === 'directory') { this.directoryMessage(pending, value); return }
    if (pending.kind === 'leaf-prepare' || pending.kind === 'leaf-cleanup') {
      const parsed = value.kind === `${pending.kind}-reply`
        ? parseLeafFrame(value.frame, pending.kind === 'leaf-prepare' ? 1 : 2, pending.root, pending.identity, pending.backend) : undefined
      if (parsed === undefined) { this.failProtocol(); return }
      pending.removeAbort()
      this.pending = undefined
      pending.resolve(parsed)
      return
    }
    if (value.kind === 'reply' && value.ok === false) {
      const error = wireError(value)
      if (error === undefined) this.failProtocol()
      else this.failPending(error)
      return
    }
    if (pending.kind === 'lstat' || pending.kind === 'list' || pending.kind === 'range') { pending.accept(value); return }
    if (pending.kind === 'storage-probe' || pending.kind === 'storage-record' || pending.kind === 'storage-view') {
      pending.accept(value); return
    }
    if (pending.kind === 'stat' && value.kind === 'stat-reply') {
      const info = metadata(value.metadata)
      if (value.metadata !== undefined && info === undefined) { this.failProtocol(); return }
      pending.removeAbort()
      this.pending = undefined
      pending.resolve(info)
      return
    }
    if (pending.kind === 'stream') { this.streamMessage(pending, value); return }
    if (pending.kind !== 'read' || value.kind !== 'reply' || value.ok !== true) { this.failProtocol(); return }
    const bytes = value.bytes
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteLength > pending.maxBytes || bytes.buffer.byteLength > pending.maxBytes + 1) { this.failProtocol(); return }
    pending.removeAbort()
    this.pending = undefined
    pending.resolve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }

  private stageMessage(pending: PendingStage, value: Record<string, unknown>): void {
    let encoded: string
    try { encoded = JSON.stringify(value) } catch (_error) { this.failProtocol(); return }
    if (Buffer.byteLength(encoded) > pending.frameBytes) { this.failProtocol(); return }
    const step = pending.step
    if (value.kind === 'stage-ready' && step.kind === 'starting' && Object.keys(value).length === 2) {
      pending.step = { kind: 'writing', sequence: 0, total: 0 }; pending.resolveReady('write'); return
    }
    if (value.kind === 'stage-ack' && step.kind === 'ack' && Object.keys(value).length === 4
      && value.sequence === step.sequence + 1 && value.total === step.total + step.size) {
      pending.step = { kind: 'writing', sequence: step.sequence + 1, total: step.total + step.size }; step.resolve(); return
    }
    if (value.kind === 'stage-rejected' && step.kind === 'starting' && Object.keys(value).length === 3) {
      const error = wireError(value)
      if (error === undefined) { this.failProtocol(); return }
      this.finishStage(pending, new FdStageFailure('not-published', error.code)); return
    }
    if (value.kind === 'stage-failure' && Object.keys(value).length === 4
      && stagingFacts(value.facts, pending.maxBytes, pending.chunkBytes)) {
      const error = wireError(value)
      if (error === undefined) { this.failProtocol(); return }
      const facts = value.facts
      const unknown = !facts.closed || !facts.clean || facts.temporaryPresent || facts.kind === 'unknown' || facts.publication === 'unknown'
      const failure = new FdStageFailure(unknown ? 'unknown' : 'not-published', error.code, facts)
      if (unknown) {
        this.failure = failure
        if (facts.closed) this.finishStage(pending, failure)
        void this.close()
      } else this.finishStage(pending, failure)
      return
    }
    const result = value.result
    if (value.kind === 'stage-result' && Object.keys(value).length === 3 && object(result) && Object.keys(result).length === 2
      && (result.outcome === 'published' || result.outcome === 'reused') && stagingFacts(result.facts, pending.maxBytes, pending.chunkBytes)
      && result.facts.kind === result.outcome && result.facts.closed && result.facts.clean && !result.facts.temporaryPresent
      && result.facts.publication !== 'unknown'
      && (result.outcome === 'published' ? step.kind === 'finishing' && result.facts.publication === 'published'
        && result.facts.writtenBytes === pending.maxBytes : (step.kind === 'starting' || step.kind === 'finishing')
          && result.facts.readBytes === pending.maxBytes)) {
      const complete: FdStageResult = { outcome: result.outcome, facts: result.facts }
      pending.removeAbort(); this.pending = undefined
      pending.resolveReady('reused'); pending.resolve(complete); return
    }
    this.failProtocol()
  }

  private projectMetadataMessage(pending: PendingProjectMetadata, value: Record<string, unknown>): void {
    const facts = value.kind === 'project-metadata-reply'
      ? parseProjectMetadataFrame(value.frame, pending.root, pending.uid, pending.gid) : undefined
    if (facts === undefined) { this.failProtocol(); return }
    if (facts.outcome === 'unknown' || !facts.closed) {
      this.failure = new FdProjectMetadataFailure('unknown', 'FS_IO_ERROR', facts)
      void this.close()
      return
    }
    pending.removeAbort(); this.pending = undefined
    if (facts.outcome === 'not-prepared') {
      const syscallCode = ({ 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 13: 'EACCES', 18: 'EXDEV', 20: 'ENOTDIR', 22: 'EINVAL',
        28: 'ENOSPC', 40: 'ELOOP', 110: 'ETIMEDOUT', 116: 'ESTALE', 122: 'EDQUOT', 125: 'ECANCELED' } as Record<number, string>)[facts.errno]
      const code: FsErrorCode = facts.errno === 125 || facts.errno === 110 ? 'FS_ABORTED'
        : [1, 13, 18, 22, 40].includes(facts.errno) ? 'FS_PERMISSION_DENIED'
          : facts.errno === 20 ? 'FS_NOT_DIRECTORY' : facts.errno === 2 ? 'FS_NOT_FOUND' : 'FS_IO_ERROR'
      pending.reject(new FdProjectMetadataFailure('not-published', code, facts, syscallCode))
    } else pending.resolve(Object.freeze({ created: facts.created, directory: facts.directory }))
  }

  private environmentLayoutMessage(pending: PendingEnvironmentLayout, value: Record<string, unknown>): void {
    const facts = value.kind === 'environment-layout-reply'
      ? parseEnvironmentLayoutFrame(value.frame, pending.root, pending.uid, pending.gid) : undefined
    if (facts === undefined) { this.failProtocol(); return }
    if (facts.outcome === 'unknown' || !facts.closed) {
      this.failure = new FdEnvironmentLayoutFailure('unknown', 'FS_IO_ERROR', facts)
      void this.close()
      return
    }
    pending.removeAbort(); this.pending = undefined
    if (facts.outcome === 'not-prepared') {
      const codes: Partial<Record<number, string>> = { 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 13: 'EACCES', 18: 'EXDEV',
        20: 'ENOTDIR', 22: 'EINVAL', 28: 'ENOSPC', 40: 'ELOOP', 110: 'ETIMEDOUT', 116: 'ESTALE', 122: 'EDQUOT', 125: 'ECANCELED' }
      const code: FsErrorCode = facts.errno === 125 || facts.errno === 110 ? 'FS_ABORTED'
        : [1, 13, 18, 22, 40].includes(facts.errno) ? 'FS_PERMISSION_DENIED'
          : facts.errno === 20 ? 'FS_NOT_DIRECTORY' : facts.errno === 2 ? 'FS_NOT_FOUND' : 'FS_IO_ERROR'
      pending.reject(new FdEnvironmentLayoutFailure('not-published', code, facts, codes[facts.errno]))
    } else pending.resolve(facts.layout)
  }

  private finishStage(pending: PendingStage, error: FdStageFailure): void {
    pending.removeAbort(); this.pending = undefined
    if (pending.step.kind === 'ack') pending.step.reject(error)
    pending.rejectReady(error); pending.reject(error)
  }

  private textWriteMessage(pending: PendingTextWrite, value: Record<string, unknown>): void {
    if (value.kind === 'text-write-failure') {
      const error = wireError(value)
      if (error === undefined || (value.outcome !== 'not-published' && value.outcome !== 'unknown')) { this.failProtocol(); return }
      pending.removeAbort()
      this.pending = undefined
      pending.reject(new FdTextWriteFailure(value.outcome, value.outcome === 'unknown' ? 'FS_IO_ERROR' : error.code,
        error.syscallCode, { cause: error }))
      return
    }
    const result = value.result
    if (value.kind !== 'text-write-reply' || !object(result)
      || (result.operation !== 'create' && result.operation !== 'update')
      || typeof result.version !== 'string' || !/^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(result.version)
      || (result.before !== null && (typeof result.before !== 'string' || Buffer.byteLength(result.before) > pending.maxBytes))
      || result.after !== pending.content.replace(/\r\n?/g, '\n') || (result.operation === 'create' && result.before !== null)) { this.failProtocol(); return }
    pending.removeAbort()
    this.pending = undefined
    pending.resolve({ operation: result.operation, version: result.version, before: result.before, after: result.after })
  }

  private directoryMessage(pending: PendingDirectory, value: Record<string, unknown>): void {
    if (value.kind !== 'directory-reply') { this.failProtocol(); return }
    if (value.ok === true) {
      const observation = value.value
      if (!object(observation) || typeof observation.directory !== 'boolean'
        || typeof observation.anchorPath !== 'string' || !observation.anchorPath.startsWith('/')
        || observation.anchorPath.includes('\0') || Buffer.byteLength(observation.anchorPath) > pending.maxPathBytes
        || typeof observation.canonicalPath !== 'string' || !observation.canonicalPath.startsWith('/')
        || observation.canonicalPath.includes('\0') || Buffer.byteLength(observation.canonicalPath) > pending.maxPathBytes) {
        this.failProtocol()
        return
      }
      const prefix = observation.anchorPath === '/' ? '/' : `${observation.anchorPath}/`
      if (observation.canonicalPath !== observation.anchorPath && !observation.canonicalPath.startsWith(prefix)) {
        this.failProtocol()
        return
      }
      pending.removeAbort()
      this.pending = undefined
      pending.resolve({ anchorPath: observation.anchorPath, canonicalPath: observation.canonicalPath, directory: observation.directory })
      return
    }
    const error = value.ok === false ? wireError(value) : undefined
    const phase = value.phase
    if (error === undefined || (phase !== 'anchor' && phase !== 'target' && phase !== 'verify')) { this.failProtocol(); return }
    const reason = phase === 'target' && error.code === 'FS_NOT_FOUND' && error.syscallCode === 'ENOENT' ? 'missing'
      : phase === 'target' && error.code === 'FS_NOT_DIRECTORY' && error.syscallCode === 'ENOTDIR' ? 'not-directory' : 'unavailable'
    pending.removeAbort()
    this.pending = undefined
    pending.reject(new DirectoryMetadataFailure(reason, phase, {
      cause: error, ...error.syscallCode === undefined ? {} : { syscallCode: error.syscallCode },
    }))
  }

  private streamMessage(pending: PendingStream, value: Record<string, unknown>): void {
    if (value.kind === 'stream-ready' && !pending.ready) {
      pending.ready = true
      if (pending.pull !== undefined && !pending.cancelled) this.post({ kind: 'stream-pull', id: pending.id })
      return
    }
    if (value.kind === 'stream-end' && pending.ready) {
      pending.removeAbort()
      this.pending = undefined
      pending.finish()
      return
    }
    const bytes = value.bytes
    if (value.kind !== 'stream-chunk' || !pending.ready || !(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteLength < 1 || bytes.byteLength > pending.maxChunkBytes || bytes.buffer.byteLength > pending.maxChunkBytes
      || pending.total + bytes.byteLength > pending.maxBytes) { this.failProtocol(); return }
    pending.total += bytes.byteLength
    if (pending.cancelled) return
    if (pending.pull === undefined) { this.failProtocol(); return }
    const pull = pending.pull
    pending.pull = undefined
    pull.resolve({ done: false, value: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) })
  }

  private failPending(error: Error): void {
    const pending = this.pending
    if (pending === undefined) return
    if (pending.kind === 'stage') {
      this.finishStage(pending, error instanceof FdStageFailure ? error : new FdStageFailure('unknown', 'FS_IO_ERROR', undefined, { cause: error }))
      return
    }
    pending.removeAbort()
    this.pending = undefined
    if (pending.kind === 'directory') pending.reject(new DirectoryMetadataFailure('unavailable', 'transport', { cause: error }))
    else if (pending.kind === 'project-metadata') pending.reject(error instanceof FdProjectMetadataFailure ? error
      : new FdProjectMetadataFailure('unknown', 'FS_IO_ERROR', undefined, undefined, { cause: error }))
    else if (pending.kind === 'environment-layout') pending.reject(error instanceof FdEnvironmentLayoutFailure ? error
      : new FdEnvironmentLayoutFailure('unknown', 'FS_IO_ERROR', undefined, undefined, { cause: error }))
    else if (pending.kind === 'stream') pending.finish(error)
    else if (pending.kind === 'text-write') pending.reject(new FdTextWriteFailure('unknown', 'FS_IO_ERROR', undefined, { cause: error }))
    else pending.reject(error)
  }

  private failProtocol(): void { this.failure = new FdWorkerFailure('FS_IO_ERROR'); void this.close() }
}
