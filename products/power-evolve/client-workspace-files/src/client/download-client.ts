/** Prepare bounded metadata; the native browser owns the subsequent byte transfer. */
import {
  FILE_DOWNLOAD_MAX_FILES, fileDownloadPrepareRequest, fileDownloadUrl, fileDownloadView,
} from '@power-evolve/contracts/file-download'
import type { FileDownloadPrepareRequest, FileDownloadView } from '@power-evolve/contracts/file-download'
import { relativeWorkspacePath } from './workspace-file-download.ts'

export { FILE_DOWNLOAD_MAX_FILES as MAX_DOWNLOAD_FILES } from '@power-evolve/contracts/file-download'
const MAX_RESPONSE_BYTES = 16 * 1024

/** Preparation failure categories translated by the native Files toolbar. */
export type DownloadFailure = 'limit' | 'missing' | 'busy' | 'denied' | 'changed' | 'timeout' | 'failed'

/** Preparation failures retain selections so the reader can retry or revise them. */
export class DownloadError extends Error {
  constructor(readonly reason: DownloadFailure) {
    super(`Workspace download: ${reason}`)
  }
}

/** Validate absolute Workspace entries and the eventual encoded URL before making a request.
 * @param sessionId - viewed Session owning the selected files.
 * @param paths - ordered absolute file paths under `/workspace`.
 * @returns validated input with canonical Workspace-relative paths.
 * @throws {DownloadError} for invalid input or selection and URL limits.
 */
export function downloadPaths(sessionId: string, paths: readonly string[]): FileDownloadPrepareRequest {
  if (paths.length === 0 || paths.length > FILE_DOWNLOAD_MAX_FILES) throw new DownloadError('limit')
  let request: FileDownloadPrepareRequest
  try {
    request = fileDownloadPrepareRequest.parse({ sessionId, paths: paths.map(relativeWorkspacePath) })
  } catch (_error) {
    throw new DownloadError('failed')
  }
  try { fileDownloadUrl({ ...request, revision: '0'.repeat(64) }) }
  catch (_error) { throw new DownloadError('limit') }
  return request
}

/** Authenticated preparation; no file bytes or ZIP buffers are read by this client. */
export class WorkspaceDownloadClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  /** Prepare a download without fetching its contents.
   * @param sessionId - viewed Session owning the files.
   * @param paths - ordered absolute Workspace file paths.
   * @param signal - preparation lifetime; cancellation prevents browser handoff.
   * @returns bounded metadata matching this Session and exact selection.
   * @throws {DownloadError} for refused or invalid metadata; transport and abort errors propagate.
   */
  async prepare(sessionId: string, paths: readonly string[], signal: AbortSignal): Promise<FileDownloadView> {
    const request = downloadPaths(sessionId, paths)
    signal.throwIfAborted()
    const response = await this.request('/api/powerEvolve/filesDownloadPrepare', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      const reason = response.status === 413 || response.status === 414 ? 'limit'
        : response.status === 404 ? 'missing'
          : response.status === 429 || response.status === 503 ? 'busy'
            : response.status === 401 || response.status === 403 ? 'denied'
              : response.status === 409 ? 'changed' : response.status === 504 ? 'timeout' : 'failed'
      throw new DownloadError(reason)
    }
    const parsed = fileDownloadView.safeParse(await boundedJson(response, signal))
    if (!parsed.success) throw new DownloadError('failed')
    const view = parsed.data
    if (view.sessionId !== request.sessionId || view.fileCount !== request.paths.length
      || view.downloadUrl !== fileDownloadUrl({ ...request, revision: view.revision })) {
      throw new DownloadError('failed')
    }
    signal.throwIfAborted()
    return view
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new DownloadError('failed')
  const cancel = (): void => { void reader.cancel().catch((_error: unknown) => { /* read() retains the preparation failure. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    signal.throwIfAborted()
    for (;;) {
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new DownloadError('failed')
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return value
    }
    catch (_error) { throw new DownloadError('failed') }
  } finally {
    signal.removeEventListener('abort', cancel)
    try { await reader.cancel() }
    catch (_error) { /* Retain the original parse, transport or cancellation failure. */ }
    reader.releaseLock()
  }
}

/** Start an authenticated same-origin download; browser UI owns progress and cancellation.
 * @param prepared - shared validated metadata, including the sole permitted content URL.
 * @throws if metadata cannot be validated; browser download failures remain in browser UI.
 */
export function startBrowserDownload(prepared: FileDownloadView): void {
  const view = fileDownloadView.parse(prepared)
  const link = document.createElement('a')
  link.href = view.downloadUrl
  link.download = view.fileName
  link.target = '_blank'
  link.rel = 'noopener'
  document.body.append(link)
  try { link.click() } finally { link.remove() }
}
