/** Immutable, tenant-owned copies of bounded workspace files. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireActiveAccount } from './account-authority.ts'
import type { FileService } from './files.ts'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_TEXT_PREVIEW = 128 * 1024

interface ArtifactRow {
  id: string
  user_id: string
  workspace_id: string
  session_id: string
  source_path: string
  filename: string
  mime: string
  size_bytes: string
  sha256: string
  created_at: Date
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function publicRecord(row: ArtifactRow) {
  return { artifactId: row.id, workspaceId: row.workspace_id, sessionId: row.session_id,
    sourcePath: row.source_path, filename: row.filename, mime: row.mime,
    sizeBytes: Number(row.size_bytes), sha256: row.sha256, createdAt: row.created_at.toISOString() }
}

/** The artifact directory is private to the platform and is never mounted into an executor. */
export class ArtifactService {
  private readonly root: string

  constructor(private readonly pool: Pool, private readonly files: FileService, root: string) {
    if (!isAbsolute(root)) throw new Error('Artifact root must be absolute')
    this.root = resolve(root)
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Artifact root must be a real directory')
  }

  private async userDirectory(userId: string): Promise<string> {
    const path = join(this.root, userId)
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(503, 'artifact_unavailable')
    return path
  }

  private async owned(user: Identity, artifactId: string): Promise<ArtifactRow> {
    const result = await this.pool.query<ArtifactRow>(
      'SELECT * FROM pe_artifacts WHERE id=$1 AND user_id=$2', [artifactId, user.userId],
    )
    if (!result.rows[0]) throw new PlatformError(404, 'artifact_not_found')
    return result.rows[0]
  }

  /** Publish one file from the Session's immutable workspace; a retry returns its first result. */
  async publish(user: Identity, requestId: string, sessionId: string, sourcePath: string): Promise<ReturnType<typeof publicRecord>> {
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const prior = await client.query<ArtifactRow>(
        'SELECT * FROM pe_artifacts WHERE user_id=$1 AND request_id=$2', [user.userId, requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].session_id !== sessionId || prior.rows[0].source_path !== sourcePath) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return publicRecord(prior.rows[0])
      }
      const session = await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [sessionId, user.userId],
      )
      const workspaceId = session.rows[0]?.workspace_id
      if (!workspaceId) throw new PlatformError(404, 'session_not_found')
      const source = await this.files.readInWorkspace(user, workspaceId, sourcePath)
      const bytes = Buffer.from(source.data, 'base64')
      if (bytes.length !== source.size || bytes.length > MAX_BYTES || digest(bytes) !== source.revision) {
        throw new PlatformError(503, 'artifact_source_changed')
      }
      const directory = await this.userDirectory(user.userId)
      const target = join(directory, `${requestId}.bin`)
      const temporary = join(directory, `.${randomUUID()}.part`)
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally { await file.close() }
      try {
        await rename(temporary, target)
        const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await folder.sync() } finally { await folder.close() }
      } finally { await rm(temporary, { force: true }) }
      const result = await client.query<ArtifactRow>(
        `INSERT INTO pe_artifacts(id,user_id,workspace_id,session_id,request_id,source_path,
           filename,mime,size_bytes,sha256)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [requestId, user.userId, workspaceId, sessionId, requestId, sourcePath,
          basename(sourcePath), source.mime, bytes.length, source.revision],
      )
      return publicRecord(result.rows[0]!)
    })
  }

  /** Return one bounded page, optionally narrowed to an owned Workspace or Session. */
  async list(user: Identity, filters: { workspaceId?: string | undefined; sessionId?: string | undefined;
    cursor?: string | undefined; limit: number }): Promise<{
    items: ReturnType<typeof publicRecord>[]; nextCursor: string | null
  }> {
    if (filters.workspaceId) {
      const owned = await this.pool.query('SELECT 1 FROM pe_workspaces WHERE id=$1 AND user_id=$2',
        [filters.workspaceId, user.userId])
      if (!owned.rowCount) throw new PlatformError(404, 'workspace_not_found')
    }
    if (filters.sessionId) {
      const owned = await this.pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [filters.sessionId, user.userId],
      )
      if (!owned.rows[0] || filters.workspaceId && owned.rows[0].workspace_id !== filters.workspaceId) {
        throw new PlatformError(404, 'session_not_found')
      }
    }
    let cursor: { created_at: Date; id: string } | undefined
    if (filters.cursor) {
      const found = await this.pool.query<{ created_at: Date; id: string }>(
        'SELECT created_at,id FROM pe_artifacts WHERE id=$1 AND user_id=$2', [filters.cursor, user.userId],
      )
      if (!found.rows[0]) throw new PlatformError(400, 'invalid_cursor')
      cursor = found.rows[0]
    }
    const result = await this.pool.query<ArtifactRow>(
      `SELECT * FROM pe_artifacts WHERE user_id=$1
       AND ($2::uuid IS NULL OR workspace_id=$2) AND ($3::uuid IS NULL OR session_id=$3)
       AND ($4::timestamptz IS NULL OR (created_at,id)<($4,$5::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $6`,
      [user.userId, filters.workspaceId ?? null, filters.sessionId ?? null,
        cursor?.created_at ?? null, cursor?.id ?? null, filters.limit + 1],
    )
    const page = result.rows.slice(0, filters.limit)
    return { items: page.map(publicRecord), nextCursor: result.rows.length > filters.limit ? page.at(-1)!.id : null }
  }

  /** Verify immutable bytes against PG metadata before returning a preview or download. */
  async bytes(user: Identity, artifactId: string): Promise<{ record: ReturnType<typeof publicRecord>; bytes: Buffer }> {
    const row = await this.owned(user, artifactId)
    const path = join(await this.userDirectory(user.userId), `${row.id}.bin`)
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PlatformError(503, 'artifact_unavailable')
      throw error
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== Number(row.size_bytes) || stat.size > MAX_BYTES) {
        throw new PlatformError(503, 'artifact_unavailable')
      }
      const bytes = await file.readFile()
      if (bytes.length !== stat.size || digest(bytes) !== row.sha256) {
        throw new PlatformError(503, 'artifact_unavailable')
      }
      return { record: publicRecord(row), bytes }
    } finally { await file.close() }
  }

  async preview(user: Identity, artifactId: string): Promise<unknown> {
    const { record, bytes } = await this.bytes(user, artifactId)
    if (record.mime.startsWith('text/')) {
      let text: string
      const decoder = new TextDecoder('utf-8', { fatal: true })
      try {
        decoder.decode(bytes)
        let end = Math.min(bytes.length, MAX_TEXT_PREVIEW)
        // The byte limit can fall inside a multibyte UTF-8 character.
        for (;;) {
          try { text = decoder.decode(bytes.subarray(0, end)); break }
          catch { if (--end < MAX_TEXT_PREVIEW - 3) throw new Error('Invalid UTF-8 prefix') }
        }
      }
      catch { throw new PlatformError(415, 'artifact_not_text') }
      return { artifactId, mime: record.mime, sizeBytes: bytes.length, text,
        truncated: bytes.length > MAX_TEXT_PREVIEW }
    }
    if (record.mime === 'image/png' || record.mime === 'image/jpeg') {
      return { artifactId, mime: record.mime, sizeBytes: bytes.length, data: bytes.toString('base64'), truncated: false }
    }
    return { artifactId, mime: record.mime, sizeBytes: bytes.length, truncated: false }
  }
}
