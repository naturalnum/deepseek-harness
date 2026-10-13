/** Authorized POSIX workspace. The filesystem is authoritative so sandbox edits remain visible. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireActiveAccount } from './account-authority.ts'
import { accountUserId } from '../account-contracts.ts'
import { SafePosix, type SafePosixOptions } from './safe-posix.ts'
import { ManagedCloudStorage } from './managed-storage.ts'
import type { StorageBinding } from './cloud-storage-types.ts'
import { fileDownloadPath } from '@power-evolve/contracts/file-download'

const MAX_FILE_BYTES = 32 * 1024 * 1024

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function parts(input: string, directory = false): string[] {
  if (directory && input === '') return []
  if (!fileDownloadPath.safeParse(input).success) throw new PlatformError(400, 'invalid_path')
  return input.split('/')
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
  /** Persistent cloud roots use the same descriptor helper as ordinary files. */
  readonly storage: ManagedCloudStorage
  constructor(private readonly pool: Pool, root: string, sandboxOwner?: { uid: number; gid: number },
    safeOptions?: SafePosixOptions) {
    this.root = resolve(root)
    this.safe = new SafePosix(this.root, sandboxOwner, safeOptions)
    this.storage = new ManagedCloudStorage(pool, this.safe)
  }

  /**
   * Initialize the configured managed root and verify descriptor support.
   */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace root must be a real directory')
    await this.safe.init()
  }

  /**
   * Ensure default metadata without probing or replacing existing bytes.
   * @param userId Authenticated owner identity.
   * @param client Optional transaction already holding the owner lock.
   * @returns The durable default Workspace identity.
   */
  async defaultWorkspaceId(userId: string, client?: PoolClient): Promise<string> {
    const ensure = async (current: PoolClient) => {
      await requireActiveAccount(current, accountUserId.parse(userId), 'update')
      await current.query(
        `INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)
         ON CONFLICT(user_id) WHERE is_default DO NOTHING`, [randomUUID(), userId])
      const result = await current.query<{ id: string }>('SELECT id FROM pe_workspaces WHERE user_id=$1 AND is_default', [userId])
      const row = result.rows[0]
      assert(row !== undefined)
      return row.id
    }
    return client ? ensure(client) : transaction(this.pool, ensure)
  }

  /**
   * Resolve the owner's default writable mount source.
   * @param userId Authenticated owner identity.
   * @returns The stable Workspace identity and verified physical mount path.
   */
  async workspaceForUser(userId: string): Promise<{ id: string; path: string }> {
    return this.workspaceForId(userId, await this.defaultWorkspaceId(userId))
  }

  /**
   * Resolve an explicitly owned Workspace without replacing missing ready storage.
   * @param userId Authenticated owner identity.
   * @param workspaceId Stable owned Workspace identity.
   * @returns The stable identity and descriptor-verified current mount path.
   */
  async workspaceForId(userId: string, workspaceId: string): Promise<{ id: string; path: string }> {
    const binding = await this.bindingForId(userId, workspaceId)
    return { id: binding.workspaceId, path: this.safe.path(binding) }
  }

  /**
   * Resolve the complete storage identity under the caller's admission transaction.
   * @param userId Authenticated owner identity.
   * @param workspaceId Stable owned Workspace identity.
   * @param client Optional transaction already holding the account update lock.
   * @returns Current owned binding; missing or recovering storage rejects with 503.
   */
  async bindingForId(userId: string, workspaceId: string, client?: PoolClient): Promise<StorageBinding> {
    if (client) await requireActiveAccount(client, accountUserId.parse(userId), 'update')
    return this.storage.resolve(userId, workspaceId, client)
  }

  private async withBinding<T>(user: Identity, workspaceId: string | undefined,
    action: (binding: StorageBinding) => Promise<T>, client?: PoolClient): Promise<T> {
    // Default metadata is accepted before its persisted provisioning intent creates bytes.
    const id = workspaceId ?? await this.defaultWorkspaceId(user.userId)
    const run = async (current: PoolClient) => {
      await requireActiveAccount(current, user.userId, 'update')
      const binding = await this.bindingForId(user.userId, id, current)
      return action(binding)
    }
    return client ? run(client) : transaction(this.pool, run)
  }

  /**
   * Inspect an authorized entry without following links.
   * @param user Authenticated owner.
   * @param path Canonical path relative to the bound directory.
   * @param workspaceId Explicit owned Workspace, otherwise the default.
   * @returns The regular entry kind.
   */
  async kind(user: Identity, path: string, workspaceId?: string): Promise<'file' | 'directory'> {
    const segments = parts(path, true)
    return this.withBinding(user, workspaceId, binding => this.safe.kind(binding, segments))
  }

  /**
   * List an authorized directory while holding its binding generation.
   * @param user Authenticated owner.
   * @param directory Canonical relative directory or the empty root.
   * @param workspaceId Explicit owned Workspace, otherwise the default.
   * @returns Bounded visible entries and their logical Workspace scope.
   */
  async list(user: Identity, directory: string, workspaceId?: string): Promise<unknown> {
    const segments = parts(directory, true)
    return this.withBinding(user, workspaceId, async (binding) => {
      const listing = await this.safe.list(binding, segments)
      const items = listing.items.sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
        path: [...segments, entry.name].join('/'), name: entry.name, kind: entry.kind,
        size: entry.size, updatedAt: entry.updatedAt, mime: entry.kind === 'file' ? mime(entry.name) : null,
      }))
      return { workspace: binding.workspaceId, directory, items }
    })
  }

  /**
   * Read bounded source bytes from the current owned binding.
   * @param user Authenticated owner.
   * @param path Canonical relative file path.
   * @param workspaceId Explicit owned Workspace, otherwise the default.
   * @returns Base64 bytes, content digest, size and MIME.
   */
  async read(user: Identity, path: string, workspaceId?: string): Promise<{
    path: string
    size: number
    mime: string
    revision: string
    data: string
  }> {
    return this.readInWorkspace(user, workspaceId ?? await this.defaultWorkspaceId(user.userId), path)
  }

  /**
   * Read an explicitly owned source using an existing publication transaction.
   * @param user Authenticated owner.
   * @param workspaceId Stable owned Workspace identity.
   * @param path Canonical relative file path.
   * @param client Optional caller transaction; prevents nested account-lock waits.
   * @returns Source bytes and their metadata from one binding generation.
   */
  async readInWorkspace(user: Identity, workspaceId: string, path: string, client?: PoolClient): ReturnType<FileService['read']> {
    const segments = parts(path)
    return this.withBinding(user, workspaceId, async (binding) => {
      const bytes = await this.safe.read(binding, segments)
      if (!bytes) throw new PlatformError(404, 'file_not_found')
      return { path, size: bytes.length, mime: mime(path), revision: sha256(bytes), data: bytes.toString('base64') }
    }, client)
  }

  /**
   * Read bounded original bytes through the descriptor helper without a second base64 conversion.
   * @param user Authenticated resource owner.
   * @param workspaceId Explicit owned Workspace, without creating a default Workspace.
   * @param path Canonical relative file path.
   * @param signal Cancellation kills the helper and waits for its process to close.
   * @param expectedGeneration A prepared multi-file download must keep this binding generation.
   * @returns Original bytes; missing or unsafe files fail with a Platform error.
   */
  async readBytesInWorkspace(user: Identity, workspaceId: string, path: string, signal?: AbortSignal,
    expectedGeneration?: number): Promise<Buffer> {
    signal?.throwIfAborted()
    const segments = parts(path)
    return this.withBinding(user, workspaceId, async (binding) => {
      signal?.throwIfAborted()
      if (expectedGeneration !== undefined && binding.generation !== expectedGeneration) throw new PlatformError(409, 'file_binding_changed')
      const bytes = await this.safe.read(binding, segments, signal)
      if (!bytes) throw new PlatformError(404, 'file_not_found')
      return bytes
    })
  }

  /**
   * Create a file without overwriting existing bytes; matching bytes acknowledge a lost reply.
   * @param user Authenticated owner.
   * @param requestId Stable owner-scoped mutation identity.
   * @param path Canonical relative file path.
   * @param data Bounded canonical base64 bytes.
   * @param workspaceId Explicit owned Workspace, otherwise the default.
   * @param client Optional caller transaction already holding the account admission lock.
   * @param authorize Optional caller authority check after resource lock waits, immediately before write admission or retry
   * acknowledgement.
   * @returns Committed metadata; retries after rebinding reject with file_binding_changed.
   */
  async put(user: Identity, requestId: string, path: string, data: string,
    workspaceId?: string, client?: PoolClient, authorize?: () => Promise<void>): Promise<unknown> {
    const segments = parts(path)
    const bytes = decode(data)
    const digest = sha256(bytes)
    const id = workspaceId ?? await this.defaultWorkspaceId(user.userId, client)
    const operation = async (client: PoolClient) => {
      await requireActiveAccount(client, user.userId, 'update')
      const binding = await this.bindingForId(user.userId, id, client)
      const previous = await client.query<{ workspace_id: string; path: string; digest: string; size: string; binding_generation: string }>(
        'SELECT workspace_id,path,digest,size,binding_generation FROM pe_file_uploads WHERE user_id=$1 AND request_id=$2', [user.userId, requestId],
      )
      if (previous.rows[0]) {
        await authorize?.()
        const prior = previous.rows[0]
        if (prior.workspace_id !== binding.workspaceId || prior.path !== path || prior.digest !== digest) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        if (Number(prior.binding_generation) !== binding.generation) throw new PlatformError(409, 'file_binding_changed')
        return { path, size: Number(prior.size), mime: mime(path), revision: prior.digest }
      }
      const mount = await client.query<{ state: string }>(
        'SELECT state FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [user.userId])
      if (mount.rows[0] && mount.rows[0].state !== 'free') throw new PlatformError(409, 'workspace_busy')
      await authorize?.()
      await this.safe.put(binding, segments, data, digest)
      await client.query(
        'INSERT INTO pe_file_uploads(user_id,request_id,workspace_id,path,digest,mime,size,binding_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [user.userId, requestId, binding.workspaceId, path, digest, mime(path), bytes.length, binding.generation],
      )
      return { path, size: bytes.length, mime: mime(path), revision: digest }
    }
    return client ? operation(client) : transaction(this.pool, operation)
  }
}
