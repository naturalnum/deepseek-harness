/** Bounded HTTP adapters shared by authenticated workspace download routes. */
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { z } from 'zod'
import { FILE_DOWNLOAD_CONTENT_PATH, FILE_DOWNLOAD_MAX_FILE_BYTES, FILE_DOWNLOAD_MAX_URL_BYTES,
  FILE_DOWNLOAD_PLATFORM_PATH, fileDownloadContentRequest, fileDownloadUrl,
  type FileDownloadContentRequest } from '@power-evolve/contracts/file-download'
import { PlatformError } from './contracts.ts'

/** Parse a credential-free content query, rejecting duplicate and unexpected fields.
 * @param url - Actual incoming URL; the caller owns route matching.
 * @returns Validated Session, paths and prepared metadata digest.
 */
export function parseFileDownloadQuery(url: URL): FileDownloadContentRequest {
  if (Buffer.byteLength(`${FILE_DOWNLOAD_CONTENT_PATH}${url.search}`) > FILE_DOWNLOAD_MAX_URL_BYTES) {
    throw new PlatformError(413, 'download_limit')
  }
  const names = [...url.searchParams.keys()]
  if (names.length !== 3 || ['sessionId', 'paths', 'revision'].some(name => url.searchParams.getAll(name).length !== 1)) {
    throw new PlatformError(400, 'invalid_request')
  }
  let paths: unknown
  try { paths = JSON.parse(url.searchParams.get('paths')!) }
  catch (error) { throw new PlatformError(400, error instanceof SyntaxError ? 'invalid_json' : 'invalid_request') }
  return fileDownloadContentRequest.parse({ sessionId: url.searchParams.get('sessionId'),
    paths, revision: url.searchParams.get('revision') })
}

/** Send exact bounded bytes while awaiting socket capacity and cancelling the producer on disconnect.
 * @param body - Stream whose producer releases its own read/transfer resources on cancellation.
 * @param response - Response with already validated headers.
 * @param length - Expected complete byte count.
 * @param signal - Request and service deadline lifetime.
 * @param authorize - Optional credential recheck immediately before further output.
 */
export async function writeFileDownload(body: ReadableStream<Uint8Array>, response: ServerResponse,
  length: number, signal: AbortSignal, authorize?: () => Promise<void>): Promise<void> {
  const reader = body.getReader()
  const abort = (): void => { void reader.cancel(signal.reason).catch((_error: unknown) => { /* Producer errors remain visible to read(). */ }) }
  signal.addEventListener('abort', abort, { once: true })
  let received = 0
  try {
    signal.throwIfAborted()
    for (;;) {
      const item = await reader.read()
      signal.throwIfAborted()
      await authorize?.()
      signal.throwIfAborted()
      if (item.done) break
      received += item.value.byteLength
      if (received > length) throw new PlatformError(502, 'download_length_mismatch')
      if (!response.write(item.value)) await once(response, 'drain', { signal })
    }
    if (received !== length) throw new PlatformError(502, 'download_length_mismatch')
    response.end()
  } finally {
    signal.removeEventListener('abort', abort)
    try { await reader.cancel() }
    catch (_error) { /* The producer may already have failed; retain the transport's original outcome. */ }
    reader.releaseLock()
  }
}

async function platformFailure(response: Response): Promise<PlatformError> {
  const allowed = new Set([400, 401, 403, 404, 409, 413, 429, 504])
  if (!allowed.has(response.status) || !response.body) {
    await response.body?.cancel()
    return new PlatformError(502, 'download_unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > 1024) return new PlatformError(502, 'download_unavailable')
      chunks.push(item.value)
    }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch (_error) { return new PlatformError(502, 'download_unavailable') }
    const parsed = z.object({ error: z.string().max(100).regex(/^[a-z][a-z0-9_]*$/u) }).strict().safeParse(value)
    return new PlatformError(parsed.success ? response.status : 502, parsed.success ? parsed.data.error : 'download_unavailable')
  } finally {
    try { await reader.cancel() }
    catch (_error) { /* Preserve the bounded failure result after an upstream disconnect. */ }
    reader.releaseLock()
  }
}

/** Forward one Platform download without reading user files or buffering the whole response in the Host.
 * @param platformUrl - Deployment-owned Platform endpoint.
 * @param token - Authenticated request credential, never placed in a URL.
 * @param request - Validated selection and metadata digest.
 * @param response - Browser response owned by the Host route.
 * @param signal - Client connection and timeout lifetime.
 */
export async function proxyFileDownload(platformUrl: string, token: string, request: FileDownloadContentRequest,
  response: ServerResponse, signal: AbortSignal): Promise<void> {
  const query = fileDownloadUrl(request).slice(FILE_DOWNLOAD_CONTENT_PATH.length)
  const upstream = await fetch(new URL(`${FILE_DOWNLOAD_PLATFORM_PATH}${query}`, platformUrl), {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal,
  })
  if (!upstream.ok) throw await platformFailure(upstream)
  const rawLength = upstream.headers.get('content-length')
  const length = rawLength && /^[0-9]+$/u.test(rawLength) ? Number(rawLength) : NaN
  const contentType = request.paths.length === 1 ? 'application/octet-stream' : 'application/zip'
  const maxBytes = request.paths.length * FILE_DOWNLOAD_MAX_FILE_BYTES + (request.paths.length > 1 ? 1024 * 1024 : 0)
  if (!upstream.body || !Number.isSafeInteger(length) || length < 0
    || length > maxBytes
    || upstream.headers.get('content-type') !== contentType) {
    await upstream.body?.cancel()
    throw new PlatformError(502, 'download_unavailable')
  }
  const fileName = request.paths.length === 1 ? request.paths[0]!.split('/').at(-1)! : 'workspace-files.zip'
  response.writeHead(200, { 'content-type': contentType,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'content-length': String(length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  await writeFileDownload(upstream.body, response, length, signal)
}
