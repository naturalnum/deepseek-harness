/** Bounded File hashing and account-bound binary upload for the native workspace tree. */
import { Hash } from 'fast-sha256'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { readResponse } from './read-response.ts'

/** Closed project publication; this value is never a Native conversation attachment reference. */
export interface WorkspaceFileUploadReceipt {
  readonly kind: 'workspace-upload'
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly outcome: 'published' | 'reused'
}

/** Captured page transport, cancellation and finite allocation budgets for one immutable File. */
export interface WorkspaceFileUploadInput {
  readonly sessionId: SessionId
  readonly directory: string
  readonly name: string
  readonly file: File
  readonly fetch: FileUploadFetch
  readonly lifetime: AbortSignal
  readonly signal: AbortSignal
  readonly maxFileBytes: number
  readonly maxMetadataBytes: number
  readonly readChunkBytes: number
}

/** Locally rejected input or an unconfirmed server publication; no operation is automatically retried. */
export class WorkspaceFileUploadFailure extends Error {
  /**
   * @param code Local handling discriminator, never server diagnostic text.
   * @param outcome Known no-publication decision or unknown submitted operation.
   * @param cause Original client/transport failure when available.
   */
  constructor(
    readonly code: 'upload-too-large' | 'invalid-path' | 'upload-unconfirmed',
    readonly outcome: 'not-published' | 'unknown', cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'WorkspaceFileUploadFailure'
  }
}

function relative(path: string): string | undefined {
  const value = path.startsWith('./') ? path.slice(2) : path
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..' || part === '.pe'
    || /[\\\u0000-\u001f\u007f]/u.test(part))) return undefined
  return value
}

function destination(actual: string, expected: string): boolean {
  const path = relative(actual)
  if (path === undefined) return false
  const slash = expected.lastIndexOf('/')
  if (path.lastIndexOf('/') !== slash || path.slice(0, slash + 1) !== expected.slice(0, slash + 1)) return false
  const name = expected.slice(slash + 1), published = path.slice(slash + 1)
  if (new TextEncoder().encode(published).byteLength > 255) return false
  if (published === name) return true
  // Native staging inserts a canonical uint64 counter before the final extension; an initial dot is not an extension.
  const dot = name.lastIndexOf('.'), split = dot > 0 ? dot : name.length
  const prefix = `${name.slice(0, split)}_`, extension = name.slice(split)
  if (!published.startsWith(prefix) || !published.endsWith(extension)) return false
  const suffix = published.slice(prefix.length, extension ? -extension.length : undefined)
  return /^[1-9][0-9]{0,19}$/u.test(suffix) && BigInt(suffix) <= 18446744073709551615n
}

async function digest(file: File, readChunkBytes: number, signal: AbortSignal): Promise<string> {
  const hash = new Hash()
  try {
    for (let offset = 0; offset < file.size; offset += readChunkBytes) {
      signal.throwIfAborted()
      const bytes = await file.slice(offset, Math.min(file.size, offset + readChunkBytes)).arrayBuffer()
      signal.throwIfAborted()
      hash.update(new Uint8Array(bytes))
    }
    signal.throwIfAborted()
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
  } finally { hash.clean() }
}

function receipt(value: unknown, path: string, sha256: string, bytes: number): WorkspaceFileUploadReceipt {
  if (value === null || typeof value !== 'object' || !('ok' in value) || value.ok !== true
    || !('value' in value) || value.value === null || typeof value.value !== 'object') {
    throw new WorkspaceFileUploadFailure('upload-unconfirmed', 'unknown')
  }
  const file = value.value
  if (!('kind' in file) || file.kind !== 'workspace-upload' || !('path' in file) || typeof file.path !== 'string'
    || !destination(file.path, path) || !('sha256' in file) || file.sha256 !== sha256
    || !('bytes' in file) || file.bytes !== bytes || !('outcome' in file)
    || file.outcome !== 'published' && file.outcome !== 'reused') {
    throw new WorkspaceFileUploadFailure('upload-unconfirmed', 'unknown')
  }
  return Object.freeze({ kind: file.kind, path: file.path, sha256, bytes, outcome: file.outcome })
}

function rejected(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'ok' in value && value.ok === false
    && 'error' in value && value.error !== null && typeof value.error === 'object'
    && 'code' in value.error && value.error.code === 'workspace/upload-rejected'
    && 'outcome' in value.error && value.error.outcome === 'not-published'
}

/**
 * Hash bounded Blob slices, then send the original File through the captured account transport.
 * @param input Selected Session/directory/name, immutable browser File and original page/request signals. Read budgets are explicit.
 * @returns Only an exact successful Cloud workspace receipt after its complete bounded response is consumed.
 * @throws Input failures before submission; cancellation joins the current bounded Blob read. Fetch/body failures or invalid receipts
 * leave publication unconfirmed and must not be retried automatically. Browser Fetch supplies Content-Length for the File body.
 */
export async function uploadWorkspaceFile(input: WorkspaceFileUploadInput): Promise<WorkspaceFileUploadReceipt> {
  const { file, maxFileBytes, maxMetadataBytes, readChunkBytes } = input
  if ([maxFileBytes, maxMetadataBytes, readChunkBytes].some(value => !Number.isSafeInteger(value) || value < 1)
    || readChunkBytes > maxFileBytes) throw new RangeError('Invalid finite workspace upload limits.')
  const signal = AbortSignal.any([input.lifetime, input.signal])
  signal.throwIfAborted()
  if (file.size > maxFileBytes) throw new WorkspaceFileUploadFailure('upload-too-large', 'not-published')
  const directory = input.directory === '.' ? '' : relative(input.directory)
  if (directory === undefined || relative(input.name) !== input.name || input.name.includes('/')) {
    throw new WorkspaceFileUploadFailure('invalid-path', 'not-published')
  }
  const expected = directory ? `${directory}/${input.name}` : input.name
  const sha256 = await digest(file, readChunkBytes, signal)
  signal.throwIfAborted()
  const query = new URLSearchParams({ sessionId: input.sessionId, name: input.name, directory: input.directory })
  try {
    const response = await input.fetch(`api/workspace-files/upload?${query}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': sha256 }, body: file, signal,
    })
    if (signal.aborted) {
      await response.body?.cancel(signal.reason)
      signal.throwIfAborted()
    }
    const bytes = await readResponse(response, maxMetadataBytes, signal)
    signal.throwIfAborted()
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!response.ok) throw new WorkspaceFileUploadFailure('upload-unconfirmed', rejected(value) ? 'not-published' : 'unknown')
    return receipt(value, expected, sha256, file.size)
  } catch (cause) {
    if (cause instanceof WorkspaceFileUploadFailure) throw cause
    throw new WorkspaceFileUploadFailure('upload-unconfirmed', 'unknown', cause)
  }
}
