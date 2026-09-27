/** Authorized POSIX workspace. The filesystem is authoritative so sandbox edits remain visible. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chown, mkdir, lstat, open, opendir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LIST_ITEMS = 200

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
  constructor(private readonly pool: Pool, root: string, private readonly sandboxOwner?: { uid: number; gid: number }) {
    this.root = resolve(root)
  }

  private async owned(path: string): Promise<void> {
    if (this.sandboxOwner) await chown(path, this.sandboxOwner.uid, this.sandboxOwner.gid)
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace root must be a real directory')
  }

  /** Return the authenticated user's existing or newly created Sandbox mount source. */
  async workspaceForUser(userId: string): Promise<{ id: string; path: string }> {
    let result = await this.pool.query<{ id: string }>('SELECT id FROM pe_workspaces WHERE user_id=$1', [userId])
    if (!result.rows[0]) {
      await this.pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING', [randomUUID(), userId])
      result = await this.pool.query<{ id: string }>('SELECT id FROM pe_workspaces WHERE user_id=$1', [userId])
    }
    const path = join(this.root, result.rows[0]!.id)
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(503, 'workspace_unavailable')
    await this.owned(path)
    return { id: result.rows[0]!.id, path }
  }

  private async workspace(user: Identity): Promise<string> { return (await this.workspaceForUser(user.userId)).path }

  private async parent(root: string, segments: string[], create: boolean): Promise<string> {
    let path = root
    for (const part of segments) {
      path = join(path, part)
      let created = false
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); created = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      let stat
      try { stat = await lstat(path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PlatformError(404, 'file_not_found')
        throw error
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(400, 'invalid_path')
      if (created) await this.owned(path)
    }
    return path
  }

  private async readAt(root: string, path: string): Promise<Buffer | null> {
    const segments = parts(path)
    let parent: string
    try { parent = await this.parent(root, segments.slice(0, -1), false) }
    catch (error) { if (error instanceof PlatformError && error.status === 404) return null; throw error }
    let file
    try { file = await open(join(parent, segments.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new PlatformError(400, 'invalid_path')
      throw error
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new PlatformError(400, 'invalid_path')
      if (stat.size > MAX_FILE_BYTES) throw new PlatformError(413, 'file_too_large')
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > MAX_FILE_BYTES) throw new PlatformError(413, 'file_too_large')
        chunks.push(buffer.subarray(0, bytesRead))
      }
      return Buffer.concat(chunks, total)
    } finally { await file.close() }
  }

  async list(user: Identity, directory: string): Promise<unknown> {
    const root = await this.workspace(user)
    const segments = parts(directory, true)
    let parent: string
    try { parent = await this.parent(root, segments, false) }
    catch (error) { if (error instanceof PlatformError && error.status === 404) return { workspace: basename(root), directory, items: [] }; throw error }
    const entries = []
    const listing = await opendir(parent)
    for await (const entry of listing) {
      if (!entry.isDirectory() && !entry.isFile()) continue
      entries.push(entry)
      if (entries.length > MAX_LIST_ITEMS) throw new PlatformError(413, 'directory_too_large')
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const items = []
    for (const entry of entries) {
      const stat = await lstat(join(parent, entry.name))
      if (stat.isSymbolicLink()) continue
      items.push({ path: [...segments, entry.name].join('/'), name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isFile() ? stat.size : null, updatedAt: stat.mtime.toISOString(), mime: entry.isFile() ? mime(entry.name) : null })
    }
    return { workspace: basename(root), directory, items }
  }

  async read(user: Identity, path: string): Promise<unknown> {
    const root = await this.workspace(user)
    const bytes = await this.readAt(root, path)
    if (!bytes) throw new PlatformError(404, 'file_not_found')
    return { path, size: bytes.length, mime: mime(path), revision: sha256(bytes), data: bytes.toString('base64') }
  }

  /** Commit a conditional write under the user's PG lock; repeated request ids never reapply it. */
  async put(user: Identity, requestId: string, path: string, baseRevision: string | null, data: string): Promise<unknown> {
    const segments = parts(path)
    const bytes = decode(data)
    const digest = sha256(bytes)
    const root = await this.workspace(user)
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const previous = await client.query<{ path: string; digest: string; base_digest: string | null; size: string }>(
        'SELECT path,digest,base_digest,size FROM pe_file_mutations WHERE user_id=$1 AND request_id=$2', [user.userId, requestId],
      )
      if (previous.rows[0]) {
        const prior = previous.rows[0]
        if (prior.path !== path || prior.digest !== digest || prior.base_digest !== baseRevision) throw new PlatformError(409, 'request_id_conflict')
        return { path, size: Number(prior.size), mime: mime(path), revision: prior.digest }
      }
      const existing = await this.readAt(root, path)
      const current = existing === null ? null : sha256(existing)
      if (current === digest && current !== baseRevision) {
        const completed = await client.query('SELECT request_id FROM pe_file_mutations WHERE user_id=$1 AND path=$2 AND digest=$3 LIMIT 1',
          [user.userId, path, digest])
        if (completed.rowCount) throw new PlatformError(409, 'file_revision_conflict')
      }
      // A crash between POSIX rename and PG commit can be completed by retrying
      // the same bytes. Another request cannot overwrite an uncertain result.
      if (current !== baseRevision && current !== digest) throw new PlatformError(409, 'file_revision_conflict')
      if (current !== digest) {
        const parent = await this.parent(root, segments.slice(0, -1), true)
        const target = join(parent, segments.at(-1)!)
        const temporary = join(parent, `.pe-${randomUUID()}.tmp`)
        const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try {
          await file.writeFile(bytes)
          if (this.sandboxOwner) await file.chown(this.sandboxOwner.uid, this.sandboxOwner.gid)
          await file.sync()
        }
        finally { await file.close() }
        try {
          await rename(temporary, target)
          const directory = await open(parent, constants.O_RDONLY)
          try { await directory.sync() } finally { await directory.close() }
        } finally { await rm(temporary, { force: true }) }
      }
      await client.query(
        'INSERT INTO pe_file_mutations(user_id,request_id,workspace_id,path,digest,base_digest,mime,size) SELECT $1,$2,id,$3,$4,$5,$6,$7 FROM pe_workspaces WHERE user_id=$1',
        [user.userId, requestId, path, digest, baseRevision, mime(path), bytes.length],
      )
      return { path, size: bytes.length, mime: mime(path), revision: digest }
    })
  }
}
