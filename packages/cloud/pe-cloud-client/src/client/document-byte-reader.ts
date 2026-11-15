/** Cloud provider window policy; the original Native preview and Remote keep their owners. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { DocumentFileBytes, SessionFile, DocumentPreviewByteReader } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

/**
 * Read a complete file, using bounded windows if its provider cannot return it at once.
 * @param read - Captured workspaceFiles readBytes remote.
 * @param file - Original Session and path of the document.
 * @param signal - Owning document lifetime.
 * @returns Complete stable bytes within the Host's declared file cap, or the original failure.
 */
export async function readCompleteBytes(
  read: TypertClientRemote['workspaceFiles']['readBytes'], file: SessionFile, signal: AbortSignal,
): Promise<RemoteResult<DocumentFileBytes>> {
  const result = await read(file.sessionId, file.path, {}, signal)
  signal.throwIfAborted()
  if (result.ok || result.error.code !== 'workspace-file/too-large') return result
  const limit = result.error.details.limit
  if (!Number.isSafeInteger(limit) || limit < 1) return result
  return readDelimitedBytes(read, file, limit, signal)
}

/**
 * Read a complete preview in bounded native byte windows. Each response is
 * authorized for the original Session and must still name the same version and
 * file; a mixed or truncated sequence is never handed to the spreadsheet parser.
 * @param read - Captured workspaceFiles readBytes remote.
 * @param file - Original Session and path of the document.
 * @param maxBytes - Owner-selected total source-byte limit.
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
        message: 'File exceeds the preview limit.', details: { path: file.path, limit: maxBytes } } }
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

/**
 * Bind the account's original Remote to complete-byte preview reads without starting I/O at registration.
 * @param ctx - Original Cloud page plugin scope and its dependency lifetime.
 */
export function installCloudDocumentByteReader(ctx: Context): void {
  ctx.inject(['remote', 'remote.workspaceFiles'], (owner) => {
    const lifetime = new AbortController()
    owner.effect(() => () => { lifetime.abort() }, 'Cloud document byte reader lifetime')
    const original = owner.remote.workspaceFiles.readBytes.bind(owner.remote.workspaceFiles)
    const read: TypertClientRemote['workspaceFiles']['readBytes'] = (...args) => {
      owner.fiber.assertActive()
      return original(...args)
    }
    const reader: DocumentPreviewByteReader = {
      read(file, signal, options) {
        const current = AbortSignal.any([signal, lifetime.signal]); current.throwIfAborted()
        return options.rendererId === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel' && /\.(?:csv|tsv)$/i.test(file.path)
          ? readDelimitedBytes(read, file, options.delimitedMaxBytes, current)
          : readCompleteBytes(read, file, current)
      },
    }
    owner.provide('documentPreviewByteReader', reader)
  })
}
