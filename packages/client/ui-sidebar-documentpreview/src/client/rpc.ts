/**
 * The paged read this type performs, bound to the Client Remote.
 *
 * Content is the consumer's business: the `file` resource carries metadata only,
 * and the text arrives here one page of lines at a time. The endpoint takes a
 * session and a workspace path while a tab carries a `dsh-resource://file/`
 * session address, so this module also owns that translation.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileBytes, WorkspaceFileRange, WorkspaceFileText } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** The slice of the Client Remote this package calls. */
export interface WorkspaceFilesReadRemote {
  readonly workspaceFiles: {
    /**
     * Read one page of lines.
     * @param sessionId - the session whose workspace resolves `path`.
     * @param path - workspace path, absolute or relative to the workspace root.
     * @param range - 1-based start line; the Host's page cap applies when `limit` is absent.
     * @param signal - cancels the call.
     * @returns the page, or the failure the Host declares.
     */
    read(
      sessionId: SessionId,
      path: string,
      range: WorkspaceFileRange,
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileText>>
  }
}

/**
 * The read one page performs, injected so the face stays host-free.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different files in different sessions. A
 * Remote call does not reject: the result carries the failure.
 */
export type ReadWorkspaceFilePage = (
  sessionId: SessionId,
  path: string,
  offset: number,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileText>>

/** The file one tab reads: the session the read runs under and the path handed to the Host. */
export interface SessionFile {
  /** The Session whose workspace resolves relative paths. */
  readonly sessionId: SessionId
  /** The path the Host receives, absolute or relative to the addressed Session's workspace. */
  readonly path: string
}

/**
 * The session and path one `dsh-resource://file/…` address names.
 *
 * A `session` address names its own session and a relative or absolute path, so
 * a tab addressed into another session reads from that session. An `absolute`
 * address carries no session and cannot be read here. The registry routes only
 * session-scoped `file` addresses to this type, so an address `parseFileAddress`
 * rejects or that carries no session is a programming error and throws.
 * @param address - a tab's `dsh-resource://file/…` address.
 * @returns the session and the path to hand the endpoint.
 */
export function hostFileOf(address: string): SessionFile {
  const parsed = parseFileAddress(address)
  if (parsed?.scope !== 'session') throw new Error(`ui-sidebar-documentpreview: not a session file address "${address}"`)
  // The address is a string boundary: its id segment is the Session id it names.
  return { sessionId: parsed.sessionId as SessionId, path: parsed.path }
}

/**
 * Bind the paged read to one Remote face. The page length is the Host's
 * configured cap, so no `limit` travels.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @returns the read the face performs.
 */
export function createReadPage(remote: WorkspaceFilesReadRemote): ReadWorkspaceFilePage {
  return (sessionId, path, offset, signal) => remote.workspaceFiles.read(sessionId, path, { offset }, signal)
}

/** Document bytes borrowed read-only by renderers; copy before transferring to a Worker. */
export type DocumentFileBytes = WorkspaceFileBytes<Uint8Array<ArrayBuffer>>

/**
 * Read a complete file through the Host endpoint.
 * @param file - Session and path decoded from the tab address.
 * @param signal - owning tab lifetime.
 * @param rendererId - selected whole-file renderer, if known.
 * @returns complete native bytes, including declared failures.
 */
export type ReadDocumentBytes = (file: SessionFile, signal: AbortSignal, rendererId?: string) => Promise<RemoteResult<DocumentFileBytes>>

/**
 * Read a delimited preview in bounded native byte windows. Each response is
 * authorized for the original Session and must still name the same version and
 * file; a mixed or truncated sequence is never handed to the spreadsheet parser.
 * @param read - Captured workspaceFiles readBytes remote.
 * @param file - Original Session and path of the document.
 * @param maxBytes - Configured spreadsheet source-byte limit.
 * @param signal - Owning document lifetime.
 * @returns Complete bounded bytes, or a native/validation failure.
 */
export async function readDelimitedBytes(
  read: TypertClientRemote['workspaceFiles']['readBytes'], file: SessionFile, maxBytes: number, signal: AbortSignal,
): Promise<RemoteResult<DocumentFileBytes>> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  let version: string | undefined
  let absolutePath: string | undefined
  let declaredBytes: number | undefined
  while (true) {
    signal.throwIfAborted()
    // At the cap, one extra byte distinguishes an exact cap from an oversized
    // file when a backend does not supply file size metadata.
    const length = Math.min(32 * 1024, Math.max(1, maxBytes - offset))
    const result = await read(file.sessionId, file.path, { range: { offset, length } }, signal)
    signal.throwIfAborted()
    if (!result.ok) return result
    const part = result.value
    if (part.data.byteLength > length || part.offset !== offset
      || (version !== undefined && part.version !== version)
      || (absolutePath !== undefined && part.absolutePath !== absolutePath)
      || (part.bytes !== undefined && (!Number.isSafeInteger(part.bytes) || part.bytes < 0))
      || (declaredBytes !== undefined && part.bytes !== undefined && part.bytes !== declaredBytes)) {
      return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code: 'gateway/internal',
        message: 'File changed or returned an inconsistent byte range.', details: {} } }
    }
    version = part.version
    absolutePath = part.absolutePath
    declaredBytes ??= part.bytes
    if ((declaredBytes !== undefined && declaredBytes > maxBytes) || offset + part.data.byteLength > maxBytes) {
      return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code: 'workspace-file/too-large',
        message: 'File exceeds the spreadsheet preview limit.', details: { path: file.path, limit: maxBytes } } }
    }
    chunks.push(part.data)
    offset += part.data.byteLength
    if (part.eof) {
      if (declaredBytes !== undefined && offset !== declaredBytes) {
        return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code: 'gateway/internal',
          message: 'File ended before its declared size.', details: {} } }
      }
      const final = await read(file.sessionId, file.path, { range: { offset, length: 1 } }, signal)
      signal.throwIfAborted()
      if (!final.ok) return final
      if (final.value.offset !== offset || !final.value.eof || final.value.data.byteLength !== 0
        || final.value.absolutePath !== absolutePath || final.value.version !== version
        || (final.value.bytes !== undefined && final.value.bytes !== offset)
        || (declaredBytes !== undefined && final.value.bytes !== undefined && final.value.bytes !== declaredBytes)) {
        return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code: 'gateway/internal',
          message: 'File changed before the byte-range read completed.', details: {} } }
      }
      const data = new Uint8Array(offset)
      let copied = 0
      for (const chunk of chunks) { data.set(chunk, copied); copied += chunk.byteLength }
      return { ok: true, value: { absolutePath, version, offset: 0, data, eof: true,
        ...(declaredBytes === undefined ? {} : { bytes: declaredBytes }) } }
    }
    if (part.data.byteLength === 0) {
      return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code: 'gateway/internal',
        message: 'File byte range made no progress.', details: {} } }
    }
  }
}
