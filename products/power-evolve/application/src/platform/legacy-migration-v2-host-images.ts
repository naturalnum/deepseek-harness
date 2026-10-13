/** Agent-scoped SDK reader for original migrated images; a captured grant fences every asynchronous Platform read. */
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentStore, AttachmentError, type ImageAttachmentLimits, type ImageAttachmentRef,
  type ImageRequestTarget, type RequestImageAttachment, type SaveImageAttachment,
  type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { readRequestImageFile } from '@deepseek-ai/dsh-attachment-local'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from '../host/scope.ts'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { PlatformError } from '../contracts.ts'
import { legacyMigrationImage } from './legacy-migration-v2-media-contracts.ts'

/** Explicit Host-only derivative cache and image request bounds. */
export interface LegacyMigrationHostImageOptions {
  readonly cacheRoot: string
  readonly imageLimits: ImageAttachmentLimits
}
const response = z.object({ image: legacyMigrationImage, data: z.string() }).strict()

/** SDK attachment service whose exact Agent scope selects an immutable grant, without a Host database or source path. */
export class LegacyMigrationHostImages extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits
  private readonly bindings = new WeakMap<ScopeKey, Grant>()
  constructor(ctx: Context,
    private readonly runtime: Pick<RuntimeScope, 'assertGrant' | 'call'>,
    private readonly options: LegacyMigrationHostImageOptions) {
    super(ctx)
    if (!isAbsolute(options.cacheRoot) || [options.imageLimits.maxImageBytes, options.imageLimits.maxImagesPerMessage,
      options.imageLimits.maxMessageImageBytes, options.imageLimits.maxImagePixels, options.imageLimits.maxImageDimension]
      .some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid migration Host image limits')
    this.imageLimits = Object.freeze({ ...options.imageLimits, mediaTypes: Object.freeze([...options.imageLimits.mediaTypes]) })
  }

  /** Register one unpublished Agent's exact scope and dispose its permission with that Agent.
   * @param agentCtx Native Agent context carrying its maintained scope key.
   * @param grant Immutable current operation received from Platform.
   */
  bind(agentCtx: Context, grant: Grant): void {
    const key = scopeOf(agentCtx)
    if (!key || this.bindings.has(key)) throw new PlatformError(503, 'legacy_image_scope_invalid')
    this.runtime.assertGrant(grant)
    agentCtx.effect(() => {
      this.bindings.set(key, grant)
      return () => { if (this.bindings.get(key) === grant) this.bindings.delete(key) }
    })
  }

  private currentGrant(): Grant {
    const key = scopeOf(this.ctx), grant = key && this.bindings.get(key)
    if (!grant) throw new PlatformError(403, 'session_not_leased')
    this.runtime.assertGrant(grant)
    return grant
  }

  /** This historical reader grants no new image upload authority.
   * @param input New caller image submission.
   * @returns Rejection because this provider only reads original migrated images.
   */
  validateImage(input: SaveImageAttachment): Promise<void> {
    void input
    return Promise.reject(new AttachmentError('Image intake is unavailable on the migration reader.', 'ATTACHMENT_PROJECTION_UNSUPPORTED'))
  }

  /** This historical reader never normalizes or creates a new durable image.
   * @param input New caller image submission.
   * @returns Rejection without publication.
   */
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError('Image intake is unavailable on the migration reader.', 'ATTACHMENT_PROJECTION_UNSUPPORTED'))
  }

  /** Fetch SDK-verified original bytes through the trusted Platform under the captured operation grant.
   * @param ref Exact original image reference from native history.
   * @param signal Optional caller lifetime; RuntimeScope enforces its own transport deadline.
   * @returns Original reference and bytes after exact metadata, size, digest and lease checks.
   */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const grant = this.currentGrant()
    const image = legacyMigrationImage.parse(ref)
    if (image.bytes > this.imageLimits.maxImageBytes
      || BigInt(image.width) * BigInt(image.height) > BigInt(this.imageLimits.maxImagePixels)) {
      throw new AttachmentError('Original image exceeds configured read limits.', 'IMAGE_TOO_LARGE')
    }
    const value = response.parse(await this.runtime.call('/runtime/attachments/image', grant.token, { image }, signal))
    signal?.throwIfAborted()
    this.runtime.assertGrant(grant)
    const data = Buffer.from(value.data, 'base64')
    if (data.toString('base64') !== value.data || data.byteLength !== image.bytes
      || JSON.stringify(value.image) !== JSON.stringify(image)
      || `sha256:${createHash('sha256').update(data).digest('hex')}` !== image.attachmentId) {
      throw new AttachmentError('Platform image response does not match original history.', 'ATTACHMENT_CORRUPT')
    }
    return { ref: image, data }
  }

  /** Derive a current request variant from original bytes using the maintained SDK cache and encoder.
   * @param ref Durable original image metadata, unchanged by derivation.
   * @param target Exact current route-selected request dimensions and byte budget.
   * @param signal Optional cancellation and current operation lifetime.
   * @returns SDK-verified derivative with its deterministic variant identity.
   */
  override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget,
    signal?: AbortSignal): Promise<RequestImageAttachment> {
    const grant = this.currentGrant()
    if (![target.width, target.height, target.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || target.width > this.imageLimits.maxImageDimension || target.height > this.imageLimits.maxImageDimension
      || BigInt(target.width) * BigInt(target.height) > BigInt(this.imageLimits.maxImagePixels)
      || target.maxBytes > this.imageLimits.maxImageBytes) throw new AttachmentError('Request image target exceeds configured limits.', 'IMAGE_TOO_LARGE')
    const stored = await this.readImage(ref, signal)
    const result = await readRequestImageFile(join(this.options.cacheRoot, grant.userId, grant.sessionId), stored, target, signal)
    signal?.throwIfAborted()
    this.runtime.assertGrant(grant)
    return result
  }
}
