/** Tenant-scoped file views for the native DSH Workspace Files client. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { parseArtifactDocumentPath, artifactDocumentPathFor } from '@power-evolve/contracts/artifact-document'
import { PlatformError, type Identity } from '../contracts.ts'
import type { FileService } from './files.ts'
import type { ArtifactService } from './artifacts.ts'
import { transaction } from './database.ts'
import { requireBrowserAccount } from './account-authority.ts'

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
    range: z.object({ offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(2 * 1024 * 1024).optional() }).strict().optional(),
  }).strict(),
}).strict()

const listing = z.object({ items: z.array(z.object({ name: z.string(), kind: z.enum(['file', 'directory']),
  size: z.number().nullable(), updatedAt: z.string() }).loose()) }).loose()
const file = z.object({ size: z.number().int().min(0), revision: z.string(), data: z.string() }).loose()
const root = '/workspace'
const maxFileBytes = 2 * 1024 * 1024

function artifactTarget(value: string): boolean {
  return value.startsWith('/artifacts') || value === 'artifacts' || value.startsWith('artifacts/')
}

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
  offset: number; text: string; lines: number; eof: boolean
} {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new PlatformError(400, 'file_not_text') }
  if (source.includes('\0')) throw new PlatformError(400, 'file_not_text')
  const all = source === '' ? [] : source.split('\n')
  if (source.endsWith('\n')) all.pop()
  const chosen = all.slice(offset - 1, offset - 1 + limit)
  if (Buffer.byteLength(chosen.join('\n')) > maxFileBytes) throw new PlatformError(413, 'file_too_large')
  return { offset, text: chosen.join('\n'), lines: chosen.length, eof: offset - 1 + chosen.length >= all.length }
}

/** The Session ID is checked at the platform boundary on every request. */
export class NativeFileRead {
  constructor(private readonly pool: Pool, private readonly files: FileService,
    private readonly artifacts: Pick<ArtifactService, 'bytes'>) {}

  private async owned(user: Identity, sessionId: string, database: Pool | PoolClient = this.pool): Promise<string> {
    const result = await database.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [sessionId, user.userId])
    if (!result.rows[0]) throw new PlatformError(404, 'session_not_found')
    return result.rows[0].workspace_id
  }

  private async artifact(user: Identity, sessionId: string, path: string, token?: string): Promise<{
    absolutePath: string; version: string; bytes: Buffer
  }> {
    if (token === undefined) throw new PlatformError(401, 'account_unauthorized')
    return transaction(this.pool, async client => {
      const current = await requireBrowserAccount(client, token, { lock: 'update' })
      if (current.userId !== user.userId) throw new PlatformError(401, 'account_unauthorized')
      const workspaceId = await this.owned(user, sessionId, client)
      let selected
      try { selected = parseArtifactDocumentPath(path) }
      catch (_invalidArtifactPath) { throw new PlatformError(400, 'invalid_path') }
      const { record, bytes } = await this.artifacts.bytes(user, selected.artifactId, client)
      if (record.artifactId !== selected.artifactId || record.filename !== selected.filename
        || record.sessionId !== sessionId || record.workspaceId !== workspaceId) throw new PlatformError(404, 'artifact_not_found')
      const delivery = await requireBrowserAccount(client, token, { lock: 'update' })
      if (delivery.userId !== user.userId) throw new PlatformError(401, 'account_unauthorized')
      return { absolutePath: artifactDocumentPathFor(record.artifactId, record.filename), version: record.sha256, bytes }
    })
  }

  /** List only the owned Session's mutable Workspace; immutable artifact addresses never denote directories.
   * @param user Authenticated owner.
   * @param request Owned Session and virtual Workspace directory.
   * @param _token Optional current browser token; directory listing remains limited to Workspace addresses.
   * @returns Bounded native directory entries; Artifact paths reject without Workspace fallback.
   */
  async list(user: Identity, request: z.infer<typeof nativeFileRequest>, _token?: string): Promise<unknown> {
    if (artifactTarget(request.path)) throw new PlatformError(400, 'invalid_path')
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    if (await this.files.kind(user, target.relative, workspaceId) !== 'directory') throw new PlatformError(400, 'file_not_directory')
    const value = listing.parse(await this.files.list(user, target.relative, workspaceId))
    return { path: target.relative, entries: value.items.map(item => ({ name: item.name,
      type: item.kind, ...(item.kind === 'file' && item.size !== null ? { size: item.size } : {}) })), truncated: false }
  }

  /** Read verified source size and SHA from an owned Workspace file or exact immutable Artifact address.
   * @param user Authenticated owner.
   * @param request Original owned Session and literal virtual file address.
   * @param token Current Agent credential, required and rechecked transactionally for Artifact reads.
   * @returns Native source metadata; mismatched Artifact filename or originating Session rejects.
   */
  async stat(user: Identity, request: z.infer<typeof nativeFileRequest>, token?: string): Promise<unknown> {
    if (artifactTarget(request.path)) {
      const value = await this.artifact(user, request.sessionId, request.path, token)
      return { absolutePath: value.absolutePath, version: value.version, bytes: value.bytes.length }
    }
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    if (!target.relative) throw new PlatformError(400, 'invalid_path')
    const value = file.parse(await this.files.read(user, target.relative, workspaceId))
    return { absolutePath: target.absolute, version: value.revision, bytes: value.size }
  }

  /** Read bounded UTF-8 lines from the authorized file's actual bytes.
   * @param user Authenticated owner.
   * @param request Original Session, virtual file address and line range.
   * @param token Current Agent credential, required and rechecked transactionally for Artifact reads.
   * @returns Native text lines and source metadata; binary bytes or foreign Artifact scope reject.
   */
  async read(user: Identity, request: z.infer<typeof nativeFileTextRequest>, token?: string): Promise<unknown> {
    if (artifactTarget(request.path)) {
      const value = await this.artifact(user, request.sessionId, request.path, token)
      return { absolutePath: value.absolutePath, version: value.version, bytes: value.bytes.length,
        ...textLines(value.bytes, request.range.offset ?? 1, request.range.limit ?? 5000) }
    }
    const workspaceId = await this.owned(user, request.sessionId)
    const target = virtual(request.path)
    if (!target.relative) throw new PlatformError(400, 'invalid_path')
    const value = file.parse(await this.files.read(user, target.relative, workspaceId))
    const range = textLines(Buffer.from(value.data, 'base64'), request.range.offset ?? 1,
      request.range.limit ?? 5000)
    return { absolutePath: target.absolute, version: value.revision, bytes: value.size, ...range }
  }

  /** Return a bounded byte range from an owned Workspace file or exact immutable Artifact snapshot.
   * @param user Authenticated owner.
   * @param request Original Session, virtual address and byte range; Artifact reads prohibit baseFile resolution.
   * @param token Current Agent credential, required and rechecked transactionally for Artifact reads.
   * @returns Native source SHA and bytes; aliases and relative Artifact resources never select a Workspace file.
   */
  async readBytes(user: Identity, request: z.infer<typeof nativeFileBytesRequest>, token?: string): Promise<unknown> {
    if (artifactTarget(request.path) || request.options.baseFile !== undefined && artifactTarget(request.options.baseFile)) {
      if (request.options.baseFile !== undefined) throw new PlatformError(400, 'invalid_path')
      const value = await this.artifact(user, request.sessionId, request.path, token)
      const offset = request.options.range?.offset ?? 0, length = request.options.range?.length ?? maxFileBytes
      if (offset + length > Number.MAX_SAFE_INTEGER) throw new PlatformError(400, 'invalid_range')
      const data = value.bytes.subarray(offset, offset + length)
      return { absolutePath: value.absolutePath, version: value.version, bytes: value.bytes.length,
        offset, data: data.toString('base64'), eof: offset + data.length >= value.bytes.length }
    }
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

  /** Observe the actual authorized source version without treating Artifact corruption as file absence.
   * @param user Authenticated owner.
   * @param request Original owned Session and exact virtual file or Workspace directory address.
   * @param token Current Agent credential, required and rechecked transactionally for Artifact reads.
   * @returns Native source version, or absence only for a missing mutable Workspace path.
   */
  async observe(user: Identity, request: z.infer<typeof nativeFileRequest>, token?: string): Promise<unknown> {
    if (artifactTarget(request.path)) {
      const value = await this.artifact(user, request.sessionId, request.path, token)
      return { absolutePath: value.absolutePath, version: value.version }
    }
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
