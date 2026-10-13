/** Tenant-scoped file views for the native DSH Workspace Files client. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, type Identity } from '../contracts.ts'
import type { FileService } from './files.ts'

const id = z.uuid()
const path = z.string().min(1).max(1024)
/** Owned Session and literal native file address, validated at the HTTP boundary. */
export const nativeFileRequest = z.object({ sessionId: id, path }).strict()
/** Native text request with a bounded, one-based line range. */
export const nativeFileTextRequest = nativeFileRequest.extend({
  range: z.object({ offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(5000).optional() }).strict(),
}).strict()
/** Native byte request with bounded offsets and optional Workspace-relative image resolution. */
export const nativeFileBytesRequest = nativeFileRequest.extend({
  options: z.object({
    baseFile: path.optional(),
    range: z.object({ offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(32 * 1024 * 1024).optional() }).strict().optional(),

  }).strict(),
}).strict()

const listing = z.object({ items: z.array(z.object({ name: z.string(), kind: z.enum(['file', 'directory']),
  size: z.number().nullable(), updatedAt: z.string() }).loose()) }).loose()
const file = z.object({ size: z.number().int().min(0), revision: z.string(), data: z.string() }).loose()
const root = '/workspace'
const maxFileBytes = 32 * 1024 * 1024
function virtual(input: string): { relative: string; absolute: string } {
  const absolute = input.startsWith('/') ? posix.normalize(input) : posix.resolve(root, input)
  if (absolute !== root && !absolute.startsWith(`${root}/`)) throw new PlatformError(400, 'invalid_path')
  const relative = absolute === root ? '' : absolute.slice(root.length + 1)
  if (relative.length > 512) throw new PlatformError(400, 'invalid_path')
  return { relative, absolute }
}

function baseRelative(target: string, baseFile?: string): { relative: string; absolute: string } {
  if (baseFile === undefined) return virtual(target)
  if (target.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(target)) throw new PlatformError(400, 'invalid_path')
  return virtual(posix.join(posix.dirname(virtual(baseFile).absolute), target))
}

function textLines(bytes: Buffer, offset: number, limit: number): {
  offset: number
  text: string
  lines: number
  eof: boolean
} {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (_error) { throw new PlatformError(400, 'file_not_text') }
  if (source.includes('\0')) throw new PlatformError(400, 'file_not_text')
  const all = source === '' ? [] : source.split('\n')
  if (source.endsWith('\n')) all.pop()
  const chosen = all.slice(offset - 1, offset - 1 + limit)
  if (Buffer.byteLength(chosen.join('\n')) > maxFileBytes) throw new PlatformError(413, 'file_too_large')
  return { offset, text: chosen.join('\n'), lines: chosen.length, eof: offset - 1 + chosen.length >= all.length }
}

/** The Session ID is checked at the platform boundary on every request. */
export class NativeFileRead {
  constructor(private readonly pool: Pool, private readonly files: FileService) {}

  private async owned(user: Identity, sessionId: string, database: Pool | PoolClient = this.pool): Promise<string> {
    const result = await database.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [sessionId, user.userId])
    if (!result.rows[0]) throw new PlatformError(404, 'session_not_found')
    return result.rows[0].workspace_id
  }

  /** List only the owned Session's persistent Workspace.
   * @param user Authenticated owner.
   * @param request Owned Session and virtual Workspace directory.
   * @returns Bounded native directory entries for the authorized Workspace.
   */
  async list(user: Identity, request: z.infer<typeof nativeFileRequest>): Promise<unknown> {
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    if (await this.files.kind(user, target.relative, workspaceId) !== 'directory') throw new PlatformError(400, 'file_not_directory')
    const value = listing.parse(await this.files.list(user, target.relative, workspaceId))
    return { path: target.relative, entries: value.items.map(item => ({ name: item.name,
      type: item.kind, ...(item.kind === 'file' && item.size !== null ? { size: item.size } : {}) })), truncated: false }
  }

  /** Read verified source size and SHA from an owned Workspace file.
   * @param user Authenticated owner.
   * @param request Original owned Session and literal virtual file address.
   * @returns Native source metadata; missing files and foreign Session ownership reject.
   */
  async stat(user: Identity, request: z.infer<typeof nativeFileRequest>): Promise<unknown> {
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    if (!target.relative) throw new PlatformError(400, 'invalid_path')
    const value = file.parse(await this.files.read(user, target.relative, workspaceId))
    return { absolutePath: target.absolute, version: value.revision, bytes: value.size }
  }

  /** Read bounded UTF-8 lines from the authorized file's actual bytes.
   * @param user Authenticated owner.
   * @param request Original Session, virtual file address and line range.
   * @returns Native text lines and source metadata; binary bytes or foreign Session ownership reject.
   */
  async read(user: Identity, request: z.infer<typeof nativeFileTextRequest>): Promise<unknown> {
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    if (!target.relative) throw new PlatformError(400, 'invalid_path')
    const value = file.parse(await this.files.read(user, target.relative, workspaceId))
    const range = textLines(Buffer.from(value.data, 'base64'), request.range.offset ?? 1,
      request.range.limit ?? 5000)
    return { absolutePath: target.absolute, version: value.revision, bytes: value.size, ...range }
  }

  /** Return a bounded byte range from an owned Workspace file.
   * @param user Authenticated owner.
   * @param request Original Session, virtual address, optional base file and byte range.
   * @returns Native source SHA and bytes; paths outside the Workspace reject.
   */
  async readBytes(user: Identity, request: z.infer<typeof nativeFileBytesRequest>): Promise<unknown> {
    const workspaceId = await this.owned(user, request.sessionId)
    const target = baseRelative(request.path, request.options.baseFile)
    if (!target.relative) throw new PlatformError(400, 'invalid_path')
    const value = file.parse(await this.files.read(user, target.relative, workspaceId))
    const bytes = Buffer.from(value.data, 'base64')
    const offset = request.options.range?.offset ?? 0
    const length = request.options.range?.length ?? maxFileBytes
    if (offset + length > Number.MAX_SAFE_INTEGER) throw new PlatformError(400, 'invalid_range')
    const data = bytes.subarray(offset, offset + length)
    return { absolutePath: target.absolute, version: value.revision, bytes: value.size,
      offset, data: data.toString('base64'), eof: offset + data.length >= bytes.length }
  }

  /** Observe the authorized file or directory version without masking storage failures.
   * @param user Authenticated owner.
   * @param request Original owned Session and exact virtual file or Workspace directory address.
   * @returns Native source version, or absence only for a missing mutable Workspace path.
   */
  async observe(user: Identity, request: z.infer<typeof nativeFileRequest>): Promise<unknown> {
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    let kind: 'file' | 'directory'
    try {
      kind = await this.files.kind(user, target.relative, workspaceId)
    } catch (error) {
      if (error instanceof PlatformError && error.status === 404) return { absolutePath: target.absolute, absent: true }
      throw error
    }
    if (kind === 'file') {
      const value = file.parse(await this.files.read(user, target.relative, workspaceId))
      return { absolutePath: target.absolute, version: value.revision }
    }
    const value = listing.parse(await this.files.list(user, target.relative, workspaceId))
    const version = createHash('sha256').update(JSON.stringify(value.items)).digest('hex')
    return { absolutePath: target.absolute, version }
  }
}
