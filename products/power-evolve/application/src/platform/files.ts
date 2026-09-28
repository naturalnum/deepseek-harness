/** Authorized POSIX workspace. The filesystem is authoritative so sandbox edits remain visible. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Pool } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { SafePosix, type SafePosixOptions } from './safe-posix.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function parts(input: string, directory = false): string[] {
  if (directory && input === '') return []
  if (input.length === 0 || input.length > 512 || input.includes('\\') || input.includes('\0')) throw new PlatformError(400, 'invalid_path')
  const value = input.split('/')
  if (value.length > 16 || value.some(part => !part || part === '.' || part === '..' || part.length > 100)) throw new PlatformError(400, 'invalid_path')
  return value
}

function mime(path: string): string {
  const extension = basename(path).split('.').at(-1)?.toLowerCase()
  switch (extension) {
    case 'txt': case 'md': case 'csv': case 'tsv': case 'py': case 'js': case 'ts': case 'tsx': case 'json': case 'html': case 'css': case 'yml': case 'yaml': return 'text/plain'
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'pdf': return 'application/pdf'
    default: return 'application/octet-stream'
  }
}

function decode(value: string): Buffer {
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new PlatformError(400, 'invalid_file_data')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== value) throw new PlatformError(413, 'file_too_large')
  return bytes
}

/** All resource paths are derived from a server-owned workspace id after authentication. */
export class FileService {
  private readonly root: string
  private readonly safe: SafePosix
  constructor(private readonly pool: Pool, root: string, sandboxOwner?: { uid: number; gid: number },
    safeOptions?: SafePosixOptions) {
    this.root = resolve(root)
    this.safe = new SafePosix(this.root, sandboxOwner, safeOptions)
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace root must be a real directory')
    await this.safe.init()
  }

  private async directory(id: string): Promise<{ id: string; path: string }> {
    await this.safe.ensureWorkspace(id)
    return { id, path: this.safe.path(id) }
  }

  private async defaultWorkspaceId(userId: string): Promise<string> {
    let result = await this.pool.query<{ id: string }>('SELECT id FROM pe_workspaces WHERE user_id=$1 AND is_default', [userId])
    if (!result.rows[0]) {
      await this.pool.query(
        `INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)
         ON CONFLICT(user_id) WHERE is_default DO NOTHING`, [randomUUID(), userId])
      result = await this.pool.query<{ id: string }>('SELECT id FROM pe_workspaces WHERE user_id=$1 AND is_default', [userId])
    }
    return result.rows[0]!.id
  }

  private async ownedWorkspaceId(userId: string, workspaceId: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2', [workspaceId, userId])
    if (!result.rows[0]) throw new PlatformError(404, 'workspace_not_found')
    return result.rows[0].id
  }

  /** Return the authenticated user's default Sandbox mount source. */
  async workspaceForUser(userId: string): Promise<{ id: string; path: string }> {
    return this.directory(await this.defaultWorkspaceId(userId))
  }

  /** Resolve only a workspace belonging to this user; callers never supply a filesystem root. */
  async workspaceForId(userId: string, workspaceId: string): Promise<{ id: string; path: string }> {
    return this.directory(await this.ownedWorkspaceId(userId, workspaceId))
  }

  private async workspace(user: Identity, workspaceId?: string): Promise<{ id: string; path: string }> {
    const id = workspaceId === undefined
      ? await this.defaultWorkspaceId(user.userId) : await this.ownedWorkspaceId(user.userId, workspaceId)
    return { id, path: this.safe.path(id) }
  }

  /** Inspect one authorized entry without following its final component. */
  async kind(user: Identity, path: string, workspaceId?: string): Promise<'file' | 'directory'> {
    const workspace = await this.workspace(user, workspaceId)
    const segments = parts(path, true)
    return this.safe.kind(workspace.id, segments)
  }

  async list(user: Identity, directory: string, workspaceId?: string): Promise<unknown> {
    const workspace = await this.workspace(user, workspaceId)
    const segments = parts(directory, true)
    const listing = await this.safe.list(workspace.id, segments)
    const items = listing.items.sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
      path: [...segments, entry.name].join('/'), name: entry.name, kind: entry.kind,
      size: entry.size, updatedAt: entry.updatedAt, mime: entry.kind === 'file' ? mime(entry.name) : null,
    }))
    return { workspace: workspace.id, directory, items }
  }

  async read(user: Identity, path: string, workspaceId?: string): Promise<{
    path: string; size: number; mime: string; revision: string; data: string
  }> {
    const workspace = await this.workspace(user, workspaceId)
    const bytes = await this.safe.read(workspace.id, parts(path))
    if (!bytes) throw new PlatformError(404, 'file_not_found')
    return { path, size: bytes.length, mime: mime(path), revision: sha256(bytes), data: bytes.toString('base64') }
  }

  /** Read bytes only from an explicitly owned Workspace for immutable artifact publication. */
  async readInWorkspace(user: Identity, workspaceId: string, path: string): ReturnType<FileService['read']> {
    return this.read(user, path, workspaceId)
  }

  /** Commit a conditional write under the user's PG lock; repeated request ids never reapply it. */
  async put(user: Identity, requestId: string, path: string, baseRevision: string | null, data: string,
    workspaceId?: string): Promise<unknown> {
    const segments = parts(path)
    const bytes = decode(data)
    const digest = sha256(bytes)
    const workspace = await this.workspace(user, workspaceId)
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const previous = await client.query<{ workspace_id: string; path: string; digest: string; base_digest: string | null; size: string }>(
        'SELECT workspace_id,path,digest,base_digest,size FROM pe_file_mutations WHERE user_id=$1 AND request_id=$2', [user.userId, requestId],
      )
      if (previous.rows[0]) {
        const prior = previous.rows[0]
        if (prior.workspace_id !== workspace.id || prior.path !== path || prior.digest !== digest || prior.base_digest !== baseRevision) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return { path, size: Number(prior.size), mime: mime(path), revision: prior.digest }
      }
      const mount = await client.query<{ state: string }>(
        'SELECT state FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [user.userId])
      if (mount.rows[0] && mount.rows[0].state !== 'free') throw new PlatformError(409, 'workspace_busy')
      const completed = await client.query('SELECT request_id FROM pe_file_mutations WHERE user_id=$1 AND workspace_id=$2 AND path=$3 AND digest=$4 LIMIT 1',
        [user.userId, workspace.id, path, digest])
      // The helper checks the old revision and renames under one retained parent
      // descriptor. The PG lock still orders platform writes and idempotency.
      await this.safe.put(workspace.id, segments, data, digest, baseRevision, !!completed.rowCount)
      await client.query(
        'INSERT INTO pe_file_mutations(user_id,request_id,workspace_id,path,digest,base_digest,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [user.userId, requestId, workspace.id, path, digest, baseRevision, mime(path), bytes.length],
      )
      return { path, size: bytes.length, mime: mime(path), revision: digest }
    })
  }
}
