/** Authenticated artifact operations and bounded Platform execution file facts. */
import { artifactPublishRequest, executionFilesRequest, executionFilesView } from '@power-evolve/contracts/execution-files'
import type { ExecutionFilesView } from '@power-evolve/contracts/execution-files'
import { artifactDocumentLocation } from '@power-evolve/contracts/artifact-document'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i

/** Immutable publication metadata validated from the authenticated Platform reply. */
export interface Artifact {
  readonly artifactId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly sourcePath: string
  readonly filename: string
  readonly mime: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly createdAt: string
}
/** One scoped catalog page and its continuation cursor. */
export interface ArtifactPage { readonly items: readonly Artifact[]; readonly nextCursor: string | null }
/** Bounded text or image preview of an immutable artifact. */
export interface ArtifactPreview { readonly artifactId: string; readonly mime: string; readonly sizeBytes: number;
  readonly text?: string; readonly data?: string; readonly truncated: boolean }

/** HTTP status with an optional validated Platform failure code. */
export class ArtifactHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`Artifact request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** Convert a native absolute Workspace file path for publication.
 * @param absolutePath - selected native file path.
 * @returns the relative source path; rejects traversal and paths outside the Workspace.
 */
export function relativeArtifactSource(absolutePath: string): string {
  if (!absolutePath.startsWith('/workspace/')) throw new Error('File is outside this Workspace')
  const path = absolutePath.slice('/workspace/'.length)
  if (!path || path.length > 1024 || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Workspace file path')
  return path
}

/** Address immutable content through the authenticated same-origin route.
 * @param artifactId - published artifact UUID.
 * @returns its native browser download URL.
 */
export function artifactDownloadUrl(artifactId: string): string {
  if (!isUuid(artifactId)) throw new Error('Invalid artifact ID')
  return `/api/powerEvolve/artifacts/${artifactId}/content`
}

function parseArtifact(value: unknown): Artifact {
  if (!record(value) || !isUuid(value.artifactId) || !isUuid(value.workspaceId) || !isUuid(value.sessionId)
    || typeof value.sourcePath !== 'string' || typeof value.filename !== 'string'
    || typeof value.mime !== 'string' || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0 || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
    || typeof value.createdAt !== 'string') throw new Error('Invalid artifact response')
  artifactDocumentLocation.parse({ artifactId: value.artifactId, filename: value.filename })
  return { artifactId: value.artifactId, workspaceId: value.workspaceId, sessionId: value.sessionId,
    sourcePath: value.sourcePath, filename: value.filename, mime: value.mime, sizeBytes: value.sizeBytes,
    sha256: value.sha256, createdAt: value.createdAt }
}

function parsePage(value: unknown): ArtifactPage {
  if (!record(value) || !Array.isArray(value.items)
    || !(value.nextCursor === null || value.nextCursor === undefined || typeof value.nextCursor === 'string')) {
    throw new Error('Invalid artifact list response')
  }
  return { items: value.items.map(parseArtifact), nextCursor: value.nextCursor ?? null }
}

function parsePreview(value: unknown, artifactId: string): ArtifactPreview {
  if (!record(value) || value.artifactId !== artifactId || typeof value.mime !== 'string'
    || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || typeof value.truncated !== 'boolean' || (value.text !== undefined && typeof value.text !== 'string')
    || (value.data !== undefined && typeof value.data !== 'string')) throw new Error('Invalid artifact preview response')
  return { artifactId, mime: value.mime, sizeBytes: value.sizeBytes, truncated: value.truncated,
    ...(value.text === undefined ? {} : { text: value.text }), ...(value.data === undefined ? {} : { data: value.data }) }
}

/** Authenticated transport for publication, catalog, previews and verified execution facts. */
export class ArtifactHttpClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, request: object, signal?: AbortSignal, maxBytes?: number): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      let code: string | undefined
      try {
        const value = await boundedJson(response, 1024, signal)
        if (record(value) && typeof value.error === 'string' && /^[a-z][a-z0-9_]{0,99}$/u.test(value.error)) code = value.error
      } catch (error) {
        if (signal?.aborted) throw error
        // Malformed failure bodies retain their status without inventing a Platform error code.
      }
      throw new ArtifactHttpError(response.status, code)
    }
    const value: unknown = maxBytes === undefined ? await response.json() : await boundedJson(response, maxBytes, signal)
    signal?.throwIfAborted()
    return value
  }

  /** Explicitly publish a source version; ordinary manual publication may omit its digest.
   * @param sessionId - viewed Session owning the file.
   * @param absolutePath - native Workspace file path.
   * @param requestId - stable identity reused after an uncertain or failed response.
   * @param signal - action lifetime.
   * @param expectedRevision - verified SHA-256; publishing a different version is rejected.
   * @returns validated immutable artifact matching the request.
   */
  async publish(sessionId: string, absolutePath: string, requestId: string, signal?: AbortSignal, expectedRevision?: string): Promise<Artifact> {
    const path = relativeArtifactSource(absolutePath)
    const request = artifactPublishRequest.parse({ requestId, sessionId, path,
      ...(expectedRevision === undefined ? {} : { expectedRevision }) })
    const result = parseArtifact(await this.post('artifactsPublish', request, signal))
    if (result.sessionId !== sessionId || result.sourcePath !== path
      || (expectedRevision !== undefined && result.sha256 !== expectedRevision)) throw new Error('Artifact publish response mismatch')
    return result
  }

  /** Read exact execution identities; call-id association is checked against native receipts by the closing owner.
   * @param sessionId - viewed Session owning every queried execution.
   * @param executionIds - unique execution identities, at most the shared ceiling.
   * @param signal - facts request lifetime.
   * @returns bounded facts for exactly the requested Session and executions.
   */
  async executionFiles(sessionId: string, executionIds: readonly string[], signal: AbortSignal): Promise<ExecutionFilesView> {
    const request = executionFilesRequest.parse({ sessionId, executionIds })
    signal.throwIfAborted()
    const result = executionFilesView.parse(await this.post('executionFiles', request, signal, 2 * 1024 * 1024))
    if (result.sessionId !== request.sessionId || result.items.length !== request.executionIds.length
      || result.items.some(item => !request.executionIds.includes(item.executionId))) {
      throw new Error('Execution files response mismatch')
    }
    return result
  }

  /** Read one scoped artifact catalog page.
   * @param filter - Workspace, Session or page cursor.
   * @param signal - view lifetime.
   * @returns validated metadata and its continuation cursor.
   */
  async list(filter: { workspaceId?: string; sessionId?: string; cursor?: string }, signal?: AbortSignal): Promise<ArtifactPage> {
    if (filter.workspaceId !== undefined && !isUuid(filter.workspaceId)) throw new Error('Invalid Workspace ID')
    if (filter.sessionId !== undefined && !isUuid(filter.sessionId)) throw new Error('Invalid Session ID')
    return parsePage(await this.post('artifactsList', { ...filter, limit: 30 }, signal))
  }

  /** Read a published artifact preview.
   * @param artifactId - immutable publication identity.
   * @param signal - preview lifetime.
   * @returns validated text or image data and its truncation flag.
   */
  async preview(artifactId: string, signal?: AbortSignal): Promise<ArtifactPreview> {
    if (!isUuid(artifactId)) throw new Error('Invalid artifact ID')
    return parsePreview(await this.post('artifactsPreview', { artifactId }, signal), artifactId)
  }
}

async function boundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Artifact response has no body')
  const abort = (): void => { void reader.cancel().catch((_error: unknown) => { /* Preserve the original read or abort failure. */ }) }
  signal?.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    signal?.throwIfAborted()
    for (;;) {
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error('Artifact response exceeds its byte limit')
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return value
  } finally {
    signal?.removeEventListener('abort', abort)
    try { await reader.cancel() }
    catch (_error) { /* Keep the transport or parsing failure already in flight. */ }
    reader.releaseLock()
  }
}
