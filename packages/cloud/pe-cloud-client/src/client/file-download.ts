/** One Session/page-bound download through the original WorkspaceFiles Remote. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import { parseFileAddress, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'

/** Original generated method; no second wire DTO or resource protocol. */
export type CloudFileReadBytes = TypertClientRemote['workspaceFiles']['readBytes']

/** Immutable input captured for one native file occurrence in one prepared page. */
export interface CloudFileDownloadInput {
  /** Session named by the original tab/resource, never a mutable currently selected Session. */
  readonly sessionId: SessionId
  readonly resourceAddress: string
  /** Original prepared-page lifetime, combined with the owning tab by assembly; abort does not confirm native carrier settlement. */
  readonly signal: AbortSignal
  /** Bound original generated Remote method on that page's captured carrier. */
  readonly readBytes: CloudFileReadBytes
  /** Explicit finite total-byte cap for the locally buffered file; native window limits still bound each read. */
  readonly maxFileBytes: number
}

/** Browser initiation is observable; successful operating-system file persistence is not. */
export type CloudFileDownloadResult =
  | { readonly kind: 'started' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed'; readonly reason: 'invalid-resource' | 'too-large' | 'incomplete' | 'native' | 'browser'; readonly cause?: unknown }

interface UrlLease {
  readonly url: string
  readonly timer: ReturnType<typeof setTimeout>
  readonly released: () => void
}

interface DownloadOperation {
  readonly control: AbortController
  readonly task: Promise<CloudFileDownloadResult>
  cancellation?: Promise<void>
}

/** One bounded read at a time; disposal joins the read and releases its owned Blob URL. */
export class CloudFileDownload {
  private readonly input: CloudFileDownloadInput
  private readonly ended: () => void
  private operation: DownloadOperation | undefined
  private closing: Promise<void> | undefined
  private lease: UrlLease | undefined

  /**
   * @param input Fixed Session/resource/carrier, owning lifetime and explicit finite file cap.
   * @throws RangeError for an absent, nonpositive or unsafe file cap before any RPC or browser effect.
   */
  constructor(input: CloudFileDownloadInput) {
    if (!Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes < 1) throw new RangeError('A finite positive maxFileBytes is required.')
    this.input = Object.freeze({ ...input })
    this.ended = () => { void this.dispose() }
    input.signal.addEventListener('abort', this.ended, { once: true })
    if (input.signal.aborted) void this.dispose()
  }

  /**
   * Read the complete file again under current server authorization, then request a browser save.
   * @returns A local outcome; native failures retain their cause without exposing it as UI copy.
   * An already issued browser download cannot be rolled back. Authorized byte ranges share one file identity and version.
   */
  save(): Promise<CloudFileDownloadResult> {
    if (this.closing !== undefined || this.input.signal.aborted) return Promise.resolve({ kind: 'cancelled' })
    if (this.operation !== undefined) return Promise.resolve({ kind: 'busy' })
    let finish!: (result: CloudFileDownloadResult) => void
    const task = new Promise<CloudFileDownloadResult>((resolve) => { finish = resolve })
    const control = new AbortController()
    const operation = { control, task }
    this.operation = operation
    void this.perform(control.signal).then(finish, (cause: unknown) => { finish({ kind: 'failed', reason: 'browser', cause }) })
    void task.then(() => {
      if (this.operation === operation) this.operation = undefined
    })
    return task
  }

  /**
   * Cancel the current read/save observation without changing its captured resource.
   * @returns Actual consumer settlement before another explicit save can start; an already issued browser request cannot be undone.
   */
  cancel(): Promise<void> {
    const operation = this.operation
    if (operation === undefined) return Promise.resolve()
    if (operation.cancellation !== undefined) return operation.cancellation
    operation.cancellation = operation.task.then(() => undefined)
    operation.control.abort()
    this.releaseUrl()
    return operation.cancellation
  }

  /**
   * Seal this occurrence, abort observation, revoke its URL and join the original submitted read.
   * @returns Actual consumer settlement; native transport/server owners independently retain their actual work.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    let finish!: () => void
    this.closing = new Promise<void>((resolve) => { finish = resolve })
    this.input.signal.removeEventListener('abort', this.ended)
    void this.cancel()
    void (this.operation?.task ?? Promise.resolve()).then(finish)
    return this.closing
  }

  private releaseUrl(): void {
    const lease = this.lease
    if (lease === undefined) return
    this.lease = undefined
    clearTimeout(lease.timer)
    try { URL.revokeObjectURL(lease.url) } finally { lease.released() }
  }

  private async perform(signal: AbortSignal): Promise<CloudFileDownloadResult> {
    const cancelled = (): boolean => signal.aborted
    const { sessionId, resourceAddress, readBytes, maxFileBytes } = this.input
    const file = parseFileAddress(resourceAddress)
    if (file?.scope !== 'session' || file.sessionId !== sessionId || file.path.length === 0) {
      return { kind: 'failed', reason: 'invalid-resource' }
    }
    const name = pathPartsOf(file.path).name.replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    if (name === '' || name === '.' || name === '..') return { kind: 'failed', reason: 'invalid-resource' }
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let offset = 0
    let version: string | undefined
    let absolutePath: string | undefined
    let bytes: number | undefined
    while (true) {
      const length = Math.min(32 * 1024, Math.max(1, maxFileBytes - offset))
      let result: Awaited<ReturnType<CloudFileReadBytes>>
      try { result = await readBytes(sessionId, file.path, { range: { offset, length } }, signal) } catch (cause) {
        return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'native', cause }
      }
      if (signal.aborted) return { kind: 'cancelled' }
      if (!result.ok) return { kind: 'failed',
        reason: result.error.code === 'workspace-file/too-large' ? 'too-large' : 'native', cause: result.error }
      const part = result.value
      if (offset + part.data.byteLength > maxFileBytes || (part.bytes !== undefined && part.bytes > maxFileBytes)) {
        return { kind: 'failed', reason: 'too-large' }
      }
      if (part.offset !== offset || part.data.byteLength > length
        || (version !== undefined && part.version !== version)
        || (absolutePath !== undefined && part.absolutePath !== absolutePath)
        || (part.bytes !== undefined && (!Number.isSafeInteger(part.bytes) || part.bytes < 0))
        || (bytes !== undefined && part.bytes !== undefined && part.bytes !== bytes)) return { kind: 'failed', reason: 'incomplete' }
      version = part.version
      absolutePath = part.absolutePath
      bytes ??= part.bytes
      chunks.push(part.data)
      offset += part.data.byteLength
      if (part.eof) {
        if (bytes !== undefined && offset !== bytes) return { kind: 'failed', reason: 'incomplete' }
        let final: Awaited<ReturnType<CloudFileReadBytes>>
        try { final = await readBytes(sessionId, file.path, { range: { offset, length: 1 } }, signal) } catch (cause) {
          return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'native', cause }
        }
        if (signal.aborted) return { kind: 'cancelled' }
        if (!final.ok) return { kind: 'failed', reason: 'native', cause: final.error }
        if (final.value.offset !== offset || !final.value.eof || final.value.data.byteLength !== 0
          || final.value.absolutePath !== absolutePath || final.value.version !== version
          || (final.value.bytes !== undefined && final.value.bytes !== offset)
          || (bytes !== undefined && final.value.bytes !== undefined && final.value.bytes !== bytes)) {
          return { kind: 'failed', reason: 'incomplete' }
        }
        break
      }
      if (part.data.byteLength === 0) return { kind: 'failed', reason: 'incomplete' }
    }
    let anchor: HTMLAnchorElement | undefined
    try {
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }))
      const handedOff = new Promise<void>((released) => {
        this.lease = { url, released, timer: setTimeout(() => { this.releaseUrl() }, 0) }
      })
      if (cancelled()) return { kind: 'cancelled' }
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener noreferrer'
      anchor.hidden = true
      document.body.append(anchor)
      anchor.click()
      // Give the browser one task to consume the download before releasing the URL.
      await handedOff
      return cancelled() ? { kind: 'cancelled' } : { kind: 'started' }
    } finally {
      anchor?.remove()
      this.releaseUrl()
    }
  }
}
