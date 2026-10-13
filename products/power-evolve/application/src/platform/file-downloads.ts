/** Read-only, Session-owned file downloads with bounded per-replica transfer admission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Pool } from 'pg'
import { bindingGeneration } from '@power-evolve/contracts/storage'
import {
  FILE_DOWNLOAD_MAX_FILE_BYTES, FILE_DOWNLOAD_MAX_FILES, FILE_DOWNLOAD_MAX_SOURCE_BYTES,
  fileDownloadPrepareRequest, fileDownloadContentRequest, fileDownloadUrl, fileDownloadView,
  type FileDownloadPrepareRequest, type FileDownloadContentRequest, type FileDownloadView,
} from '@power-evolve/contracts/file-download'
import { PlatformError, type Identity } from '../contracts.ts'
import { requireActiveAccount, assertProductLoginAllowed } from './account-authority.ts'
import { transaction } from './database.ts'
import type { FileService } from './files.ts'
import { createDownloadStream } from './download-stream.ts'

const CHUNK_BYTES = 64 * 1024

/** Deployment limits; maxTotalBytes applies to selected source bytes before transfer. */
export interface FileDownloadLimits {
  readonly maxFiles: number
  readonly maxTotalBytes: number
  readonly maxConcurrentTransfers: number
  readonly maxUserConcurrentTransfers: number
  readonly transferTimeoutMs: number
}
interface PreparedFile { path: string; size: number; sha256: string }
interface DownloadBinding { workspaceId: string; generation: number }
interface Prepared { view: FileDownloadView; files: [PreparedFile]; binding: DownloadBinding }
type Authorize = () => Promise<void>

/** Downloads never create Workspaces, mutate files, or read storage from the Host. */
export class FileDownloadService {
  private active = 0
  private readonly users = new Map<string, number>()
  private readonly limits: FileDownloadLimits

  constructor(private readonly pool: Pool, private readonly files: FileService, limits: FileDownloadLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid file download ${name}`)
    }
    if (limits.maxFiles > FILE_DOWNLOAD_MAX_FILES || limits.maxTotalBytes > FILE_DOWNLOAD_MAX_SOURCE_BYTES
      || limits.maxUserConcurrentTransfers > limits.maxConcurrentTransfers) throw new TypeError('File download limits exceed their ceilings')
    this.limits = { ...limits }
  }

  /**
   * Re-read selected files and prepare an ordered content digest without durable side effects.
   * @param user Authenticated owner; current account and Session ownership are rechecked.
   * @param request Session and canonical unique selection, in output order.
   * @param signal Connection cancellation.
   * @param authorize Optional request-local bearer revalidation, including expiry and rotation.
   * @returns Bounded metadata; invalid, missing, oversized, busy or timed-out requests fail.
   */
  async prepare(user: Identity, request: FileDownloadPrepareRequest, signal: AbortSignal,
    authorize?: Authorize): Promise<FileDownloadView> {
    const input = this.validate(request, false)
    const lifetime = this.admit(user, signal)
    try { return (await this.inspect(user, input, lifetime, authorize)).view }
    finally { void lifetime.finish() }
  }

  /**
   * Re-read the whole selection before opening, then verify each file again before emitting it.
   * @param user Authenticated owner; every verification checks the current account and Session.
   * @param request Session, ordered paths and the prepared content digest.
   * @param signal Connection cancellation.
   * @param authorize Optional request-local bearer revalidation before and after reads/output waits.
   * @returns Metadata and original-byte Web stream; changed selections fail with 409.
   */
  async open(user: Identity, request: FileDownloadContentRequest, signal: AbortSignal,
    authorize?: Authorize): Promise<{ view: FileDownloadView; body: ReadableStream<Uint8Array> }> {
    const input = this.validate(request, true)
    const lifetime = this.admit(user, signal)
    try {
      const prepared = await this.inspect(user, input, lifetime, authorize, true)
      if (prepared.view.revision !== request.revision) throw new PlatformError(409, 'download_changed')
      await this.authorize(user, input.sessionId, lifetime, authorize, prepared.binding)
      const body = createDownloadStream((streamSignal) => {
        const chunks = (file: PreparedFile) => this.verifiedChunks(user, input.sessionId,
          prepared.binding, file, lifetime, streamSignal, authorize)
        return chunks(prepared.files[0])
      }, lifetime.signal, () => lifetime.finish())
      return { view: prepared.view, body }
    } catch (error) { void lifetime.finish(); throw error }
  }

  private validate(request: FileDownloadPrepareRequest | FileDownloadContentRequest, content: boolean): FileDownloadPrepareRequest {
    if (Array.isArray(request.paths) && request.paths.length > this.limits.maxFiles) throw new PlatformError(413, 'download_too_large')
    const result = (content ? fileDownloadContentRequest : fileDownloadPrepareRequest).safeParse(request)
    if (!result.success) throw new PlatformError(400, 'download_invalid')
    this.url({ ...result.data, revision: '0'.repeat(64) })
    return result.data
  }

  private url(request: FileDownloadContentRequest): string {
    try { return fileDownloadUrl(request) }
    catch (error) {
      if (error instanceof RangeError) throw new PlatformError(413, 'download_too_large')
      throw error
    }
  }

  private admit(user: Identity, signal: AbortSignal): TransferLifetime {
    signal.throwIfAborted()
    const current = this.users.get(user.userId) ?? 0
    if (this.active >= this.limits.maxConcurrentTransfers || current >= this.limits.maxUserConcurrentTransfers) {
      throw new PlatformError(429, 'download_busy')
    }
    this.active += 1
    this.users.set(user.userId, current + 1)
    return new TransferLifetime(signal, this.limits.transferTimeoutMs, () => {
      this.active -= 1
      const admitted = this.users.get(user.userId)
      assert(admitted !== undefined)
      const remaining = admitted - 1
      if (remaining) this.users.set(user.userId, remaining)
      else this.users.delete(user.userId)
    })
  }

  private async authorize(user: Identity, session: string, lifetime: TransferLifetime,
    authorize?: Authorize, expected?: DownloadBinding, signal = lifetime.signal): Promise<DownloadBinding> {
    signal.throwIfAborted()
    if (authorize) await lifetime.wait(authorize(), signal)
    const binding = await lifetime.wait(transaction(this.pool, async (client) => {
      assertProductLoginAllowed(await requireActiveAccount(client, user.userId))
      const result = await client.query<{ workspace_id: string; binding_generation: string; binding_state: string }>(
        `SELECT s.workspace_id,w.binding_generation,w.binding_state FROM pe_sessions s
        JOIN pe_workspaces w ON w.id=s.workspace_id AND w.user_id=$2 WHERE s.id=$1 AND s.user_id=$2`, [session, user.userId])
      if (!result.rows[0]) throw new PlatformError(404, 'session_not_found')
      const row = result.rows[0]
      if (row.binding_state !== 'ready') throw new PlatformError(409, 'download_changed')
      return { workspaceId: row.workspace_id, generation: bindingGeneration.parse(Number(row.binding_generation)) }
    }), signal)
    signal.throwIfAborted()
    if (expected !== undefined && (binding.workspaceId !== expected.workspaceId || binding.generation !== expected.generation)) {
      throw new PlatformError(409, 'download_changed')
    }
    return binding
  }

  private async read(user: Identity, session: string, binding: DownloadBinding, path: string,
    lifetime: TransferLifetime, signal: AbortSignal, authorize?: Authorize, changed = false): Promise<Buffer> {
    await this.authorize(user, session, lifetime, authorize, binding, signal)
    let bytes: Buffer
    try { bytes = await lifetime.wait(this.files.readBytesInWorkspace(user,
      binding.workspaceId, path, signal, binding.generation), signal) }
    catch (error) {
      if (error instanceof PlatformError && (error.code === 'file_binding_changed'
        || changed && ['file_not_found', 'file_too_large', 'invalid_path'].includes(error.code))) {
        throw new PlatformError(409, 'download_changed')
      }
      throw error
    }
    await this.authorize(user, session, lifetime, authorize, binding, signal)
    if (bytes.length > FILE_DOWNLOAD_MAX_FILE_BYTES) throw new PlatformError(413, 'download_too_large')
    return bytes
  }

  private async inspect(user: Identity, request: FileDownloadPrepareRequest, lifetime: TransferLifetime,
    authorize?: Authorize, changed = false): Promise<Prepared> {
    const binding = await this.authorize(user, request.sessionId, lifetime, authorize)
    const files: PreparedFile[] = []
    let sourceBytes = 0
    for (const path of request.paths) {
      const bytes = await this.read(user, request.sessionId, binding, path, lifetime, lifetime.signal, authorize, changed)
      sourceBytes += bytes.length
      if (sourceBytes > this.limits.maxTotalBytes) throw new PlatformError(changed ? 409 : 413,
        changed ? 'download_changed' : 'download_too_large')
      files.push({ path, size: bytes.length, sha256: sha256(bytes) })
    }
    const revision = sha256(Buffer.from(JSON.stringify({ binding, files })))
    const file = files[0]
    assert(file)
    const view = fileDownloadView.parse({ sessionId: request.sessionId, workspaceId: binding.workspaceId, revision,
      downloadUrl: this.url({ ...request, revision }), fileName: posix.basename(file.path),
      contentType: 'application/octet-stream', fileCount: 1, sourceBytes, totalBytes: sourceBytes })
    return { view, files: [file], binding }
  }

  private async* verifiedChunks(user: Identity, session: string, binding: DownloadBinding, file: PreparedFile,
    lifetime: TransferLifetime, signal: AbortSignal, authorize?: Authorize): AsyncGenerator<Uint8Array> {
    const bytes = await this.read(user, session, binding, file.path, lifetime, signal, authorize, true)
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new PlatformError(409, 'download_changed')
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      await this.authorize(user, session, lifetime, authorize, binding, signal)
      yield bytes.subarray(offset, offset + CHUNK_BYTES)
    }
    // Empty files also require current authority.
    await this.authorize(user, session, lifetime, authorize, binding, signal)
  }
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/** Retain admission until both the consumer and every actual underlying operation finish. */
class TransferLifetime {
  readonly signal: AbortSignal
  private pending = 0
  private finished = false
  private released = false
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly done: Promise<void>
  private resolveDone!: () => void

  constructor(signal: AbortSignal, timeoutMs: number, private readonly release: () => void) {
    const deadline = new AbortController()
    this.signal = AbortSignal.any([signal, deadline.signal])
    this.timer = setTimeout(() => { deadline.abort(new PlatformError(504, 'download_timeout')) }, timeoutMs)
    this.timer.unref()
    this.done = new Promise((resolve) => { this.resolveDone = resolve })
  }

  async wait<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    this.pending += 1
    const tracked = task.finally(() => { this.pending -= 1; this.releaseIfComplete() })
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error('File download aborted', { cause: reason }))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void tracked.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    })
  }

  finish(): Promise<void> {
    this.finished = true
    clearTimeout(this.timer)
    this.releaseIfComplete()
    return this.done
  }

  private releaseIfComplete(): void {
    if (this.finished && !this.pending && !this.released) {
      this.released = true
      this.release()
      this.resolveDone()
    }
  }
}
