/** Worker transport retains operations until actual FD-closure replies or actual worker exit. */
import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import type { FdTaskRequest, FdRootIdentity, FdMetadata } from './worker-protocol.ts'
import { FilesFailure } from './error.ts'

/** Transport failure retains the native error category without private paths. */
export class FdWorkerFailure extends Error {
  constructor(readonly code: FsErrorCode, readonly syscallCode?: string) { super(code) }
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
type Pending = PendingRead | PendingStat | PendingStream

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function wireError(value: Record<string, unknown>): FdWorkerFailure | undefined {
  if (typeof value.code !== 'string'
    || !['FS_NOT_FOUND', 'FS_NOT_REGULAR_FILE', 'FS_NOT_TEXT', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_ABORTED', 'FS_IO_ERROR'].includes(value.code)
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

/** One exclusive prebuilt slot; a stream owns the slot between pulls as well as during reads. */
export class FdWorkerClient {
  /** Resolves after the required worker ABI handshake, or rejects on startup failure. */
  readonly ready: Promise<void>
  /** Resolves with the actual worker exit code after its exit event is observed. */
  readonly exited: Promise<number>
  private readyResolved = false
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
      Atomics.store(cancel, 0, 1)
      if (this.pending?.id === id && this.pending.kind === 'stream') this.cancelPending(this.pending)
    }
    signal.addEventListener('abort', abort, { once: true })
    return { id, maxBytes, cancel, removeAbort: () => { signal.removeEventListener('abort', abort) } }
  }

  private postTask(pending: Pending, root: FdRootIdentity, relativePath: string): void {
    this.post({
      kind: pending.kind, id: pending.id, root, relativePath, maxBytes: pending.maxBytes, cancel: pending.cancel.buffer,
    } satisfies FdTaskRequest)
  }

  private post(message: object): void {
    try { this.worker.postMessage(message) } catch (_error) { this.failProtocol() }
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
      if (value.abiVersion !== 3 || this.readyResolved || this.closed) { this.failProtocol(); return }
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
    if (value.kind === 'reply' && value.ok === false) {
      const error = wireError(value)
      if (error === undefined) this.failProtocol()
      else this.failPending(error)
      return
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
    pending.removeAbort()
    this.pending = undefined
    if (pending.kind === 'stream') pending.finish(error)
    else pending.reject(error)
  }

  private failProtocol(): void { this.failure = new FdWorkerFailure('FS_IO_ERROR'); void this.close() }
}
