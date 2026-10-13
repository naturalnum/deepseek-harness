/** Streamed immutable file intake with durable, tenant-owned Session receipts. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { readFileStreamVerbatim, saveFileStreamVerbatim } from '@deepseek-ai/dsh-attachment-local'
import type { AttachmentAdmissionPart, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fileReceiptId, NATIVE_FILE_MAX_BYTES, nativeFileAttachment,
  nativePromptContent } from '../native-attachment-contracts.ts'
import { PlatformError, userId, type Identity, type RequestId } from '../contracts.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'
import type { FileService } from './files.ts'
import { nativeAttachmentUsage } from './native-attachment-storage.ts'
import { nativeUploadChunks } from './native-upload-source.ts'

/** Deployment-owned storage and per-owner receipt admission budgets. */
export interface NativeAttachmentLimits {
  readonly root: string
  readonly maxFilesPerSession: number
  readonly maxBytesPerUser: number
  readonly maxFilesPerUser: number
}

/** Files remain outside writable Sandbox mounts; only their receiving Session may bind or read them. */
export class NativeAttachments {
  private readonly root: string
  constructor(private readonly pool: Pool, private readonly tasks: TaskStore, private readonly files: FileService,
    private readonly limits: NativeAttachmentLimits) {
    if (!isAbsolute(limits.root)) throw new Error('Attachment root must be absolute')
    this.root = resolve(limits.root)
  }

  /** Refuse writable-mount overlap before Platform opens or upgrades its database.
   * @param root Private original-file storage root.
   * @param writableRoots Deployment-owned Workspace, Home and Skill mount roots.
   * @returns Completion only when both lexical and actual ancestor paths remain disjoint.
   */
  static async validateRoot(root: string, writableRoots: readonly string[]): Promise<void> {
    if (!isAbsolute(root)) throw new Error('Attachment root must be absolute')
    const canonical = async (input: string): Promise<string> => {
      let path = resolve(input)
      const suffix: string[] = []
      for (;;) {
        try { return join(await realpath(path), ...suffix.reverse()) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          const parent = dirname(path)
          if (parent === path) throw error
          suffix.push(relative(parent, path)); path = parent
        }
      }
    }
    const inside = (parent: string, child: string): boolean => {
      const part = relative(parent, child)
      return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'))
    }
    const original = resolve(root), physical = await canonical(root)
    for (const writable of writableRoots) {
      if (!isAbsolute(writable)) throw new Error('Writable attachment exclusion must be absolute')
      const mount = resolve(writable), actualMount = await canonical(writable)
      if (inside(original, mount) || inside(mount, original)
        || inside(physical, actualMount) || inside(actualMount, physical)) {
        throw new Error('Attachment root overlaps writable storage')
      }
    }
  }

  /** Create and validate the operator-owned private storage root before intake begins. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('Attachment root must be a private real directory')
    }
  }

  /** Commit original streamed bytes and one durable receipt after authenticating the receiving Session.
   * @param user Browser-authenticated owner.
   * @param token Original browser credential, checked inside the storage transaction.
   * @param sessionId Exact receiving Session.
   * @param data Ordered original upload chunks; the transport closes its source if intake fails or is cancelled.
   * @param name Caller display name; the maintained attachment backend sanitizes it.
   * @param signal Caller lifetime and transport deadline.
   * @returns A durable receipt and verified original file metadata.
   */
  async upload(user: Identity, token: string, sessionId: string, data: AsyncIterable<Uint8Array>,
    name: string | undefined, signal: AbortSignal): Promise<{
    receiptId: z.infer<typeof fileReceiptId>
    file: FileAttachmentRef
  }> {
    return transaction(this.pool, async (client) => {
      const lostConnection = new AbortController()
      const unavailable = () => { lostConnection.abort(new PlatformError(503, 'database_unavailable')) }
      client.on('error', unavailable)
      const lifetime = AbortSignal.any([signal, lostConnection.signal])
      try {
        const actor = await requireBrowserAccount(client, token, { lock: 'update' })
        if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
        const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [sessionId, user.userId])
        if (!owned.rowCount) throw new PlatformError(404, 'session_not_found')
        const receipts = await client.query<{ file: unknown; storage_session_id: string }>(
          'SELECT file,storage_session_id FROM pe_native_file_receipts WHERE user_id=$1 AND session_id=$2',
          [user.userId, sessionId])
        const maxFiles = this.limits.maxFilesPerUser
        const usage = await nativeAttachmentUsage(this.root, user.userId, maxFiles, lifetime)
        const knownFiles = new Set(receipts.rows.filter(row => row.storage_session_id === sessionId).map((row) => {
          const file = nativeFileAttachment.parse(row.file)
          return `${file.attachmentId}\0${file.name}`
        }))
        const orphaned = [...usage.sessionSlots.get(sessionId) ?? []].filter(key => !knownFiles.has(key)).length
        if (receipts.rows.length + orphaned >= this.limits.maxFilesPerSession) throw new PlatformError(429, 'attachment_count_limit')
        if (usage.files >= maxFiles) throw new PlatformError(429, 'attachment_storage_limit')
        const remaining = this.limits.maxBytesPerUser - usage.bytes
        let sourceFailure: PlatformError | undefined
        const bounded = async function* (): AsyncGenerator<Uint8Array> {
          let bytes = 0
          for await (const chunk of nativeUploadChunks(data, lifetime)) {
            lifetime.throwIfAborted()
            bytes += chunk.byteLength
            if (bytes > NATIVE_FILE_MAX_BYTES || bytes > remaining) {
              sourceFailure = new PlatformError(413, 'attachment_bytes_limit')
              throw sourceFailure
            }
            yield chunk
          }
        }
        lifetime.throwIfAborted()
        let file: FileAttachmentRef
        try {
          file = nativeFileAttachment.parse(await saveFileStreamVerbatim(join(this.root, user.userId, sessionId), {
            data: bounded(), signal: lifetime, ...(name === undefined ? {} : { name }),
          }))
        } catch (error) { throw sourceFailure ?? error }
        lifetime.throwIfAborted()
        const receiptId = fileReceiptId.parse(randomUUID())
        await client.query('INSERT INTO pe_native_file_receipts(id,user_id,session_id,storage_session_id,file) VALUES($1,$2,$3,$3,$4)',
          [receiptId, user.userId, sessionId, file])
        return { receiptId, file }
      } finally { client.off('error', unavailable) }
    })
  }

  /** Bind staged receipts in the prompt acceptance transaction; callers own its account and Session locks.
   * @param client Existing acceptance transaction.
   * @param user Authenticated owner.
   * @param sessionId Receiving Session whose row is already locked.
   * @param requestId Stable prompt identity.
   * @param content Validated browser content in its original order.
   * @returns Ordered text, encoded images awaiting SDK admission, and native file references; foreign or reused receipts refuse.
   */
  static async bind(client: PoolClient, user: Identity, sessionId: string, requestId: RequestId,
    content: z.infer<typeof nativePromptContent>): Promise<AttachmentAdmissionPart[]> {
    const admitted: AttachmentAdmissionPart[] = []
    for (const part of content) {
      if (part.type === 'text') { admitted.push(part); continue }
      if (part.type === 'image') {
        admitted.push({ type: 'image', mediaType: part.mediaType, data: part.data,
          ...part.name === undefined ? {} : { name: part.name } })
        continue
      }
      const found = await client.query<{ file: unknown; request_id: string | null }>(
        'SELECT file,request_id FROM pe_native_file_receipts WHERE id=$1 AND user_id=$2 AND session_id=$3 FOR UPDATE',
        [part.receiptId, user.userId, sessionId])
      const row = found.rows[0]
      if (!row || (row.request_id !== null && row.request_id !== requestId)) {
        throw new PlatformError(400, 'attachment_not_staged')
      }
      admitted.push({ type: 'file', attachment: nativeFileAttachment.parse(row.file) })
      await client.query('UPDATE pe_native_file_receipts SET request_id=$2 WHERE id=$1', [part.receiptId, requestId])
    }
    return admitted
  }

  /** Read an accepted original file under a current operation lease, verifying its stored digest before returning text.
   * @param token Current operation grant.
   * @param ref Original file metadata selected from that Session's accepted receipts.
   * @param offset One-based starting line.
   * @param limit Maximum lines; response text is also capped at 32 KiB.
   * @returns Verified text and file identity; binary, missing, changed or foreign files reject.
   */
  async readText(token: string, ref: FileAttachmentRef, offset: number, limit: number): Promise<{
    attachmentId: FileAttachmentRef['attachmentId']
    name: string
    bytes: number
    offset: number
    text: string
    lines: number
    eof: boolean
  }> {
    return transaction(this.pool, async (client) => {
      const grant = await this.tasks.authorized(client, token)
      const originalBytes = await this.verifiedBytes(client, grant.user_id, grant.id, ref)
      await this.tasks.authorized(client, token)
      let source: string
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes) }
      catch (_binary) { throw new PlatformError(400, 'file_not_text') }
      if (source.includes('\0')) throw new PlatformError(400, 'file_not_text')
      const all = source === '' ? [] : source.split('\n')
      if (source.endsWith('\n')) all.pop()
      const selected: string[] = []
      let bytes = 0
      for (const line of all.slice(offset - 1, offset - 1 + limit)) {
        const next = Buffer.byteLength(line) + (selected.length ? 1 : 0)
        if (bytes + next > 32 * 1024) break
        selected.push(line); bytes += next
      }
      if (selected.length === 0 && offset <= all.length && source.length > 0) throw new PlatformError(413, 'attachment_line_limit')
      return { ...ref, offset, text: selected.join('\n'), lines: selected.length,
        eof: offset - 1 + selected.length >= all.length }
    })
  }

  /** Create one writable Workspace copy for Office or authorized cloud tools, preserving the immutable original.
   * @param token Current operation grant, rechecked with cancellation under the Session lock.
   * @param ref File accepted by this Session or its exact inherited fork prefix.
   * @param callId Stable native tool call identity; conflicting retries reject.
   * @param path Canonical relative destination, validated by the protected file service.
   * @returns Created copy metadata; existing different bytes, busy writers and lost leases refuse.
   */
  async copy(token: string, ref: FileAttachmentRef, callId: string, path: string): Promise<unknown> {
    return transaction(this.pool, async (client) => {
      const grant = await this.tasks.authorized(client, token)
      const operation = await client.query<{ error_code: string | null }>('SELECT error_code FROM pe_operations WHERE id=$1', [grant.operation_id])
      if (operation.rows[0]?.error_code === 'cancel_requested') throw new PlatformError(409, 'operation_cancelled')
      const bytes = await this.verifiedBytes(client, grant.user_id, grant.id, ref)
      const owner = await client.query<{ username: string }>('SELECT username FROM pe_users WHERE id=$1', [grant.user_id])
      if (!owner.rows[0]) throw new PlatformError(401, 'unauthorized')
      const hash = createHash('sha256').update(JSON.stringify(['native-file-copy', grant.operation_id, callId])).digest()
      hash[6] = (hash.readUInt8(6) & 0x0f) | 0x80; hash[8] = (hash.readUInt8(8) & 0x3f) | 0x80
      const hex = hash.toString('hex')
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
      return this.files.put({ userId: userId.parse(grant.user_id), username: owner.rows[0].username }, id, path,
        bytes.toString('base64'), grant.workspace_id, client, async () => { await this.tasks.authorized(client, token) })
    })
  }

  private async verifiedBytes(client: PoolClient, userId: string, sessionId: string, ref: FileAttachmentRef): Promise<Buffer> {
    const found = await client.query<{ storage_session_id: string }>(
      `SELECT storage_session_id FROM pe_native_file_receipts WHERE user_id=$1 AND session_id=$2 AND request_id IS NOT NULL
        AND file=$3::jsonb LIMIT 1`, [userId, sessionId, ref])
    const original = found.rows[0]
    if (!original) throw new PlatformError(404, 'attachment_not_found')
    const chunks: Uint8Array[] = []
    let count = 0
    for await (const chunk of readFileStreamVerbatim(join(this.root, userId, original.storage_session_id), ref)) {
      count += chunk.byteLength
      if (count > NATIVE_FILE_MAX_BYTES) throw new PlatformError(413, 'attachment_bytes_limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
}
