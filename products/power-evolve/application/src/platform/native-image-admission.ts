/** Scoped native SDK image intake under caller-held account and Session authorization. */
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore, { MAX_IMAGE_COMPRESSION_CONCURRENCY, type Config as LocalConfig } from '@deepseek-ai/dsh-attachment-local'
import type { AdmittedPromptContentPart, AttachmentAdmissionPart } from '@deepseek-ai/dsh-attachment'
import { PlatformError, sessionId, userId, type Identity } from '../contracts.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { NativeAttachmentLimits } from './native-attachments.ts'
import { nativeAttachmentUsage } from './native-attachment-storage.ts'

/** Explicit deployment image policy; the protected DSH home is derived from server-owned identities. */
export type NativeImageAdmissionConfig = Readonly<Required<Omit<LocalConfig, 'dshHome'>>>

/** Already authorized receiving identity and validated ordered prompt parts; this object supplies no authorization. */
export interface NativeImageAdmissionInput {
  /** Account identity whose update lock the caller retains through intake and final acceptance. */
  readonly userId: Identity['userId']
  /** Owned receiving Session whose lock the caller retains through intake. */
  readonly sessionId: SessionId
  /** Text, already resolved file references, and original encoded image parts in prompt order. */
  readonly content: readonly AttachmentAdmissionPart[]
}

/**
 * Admit images through the maintained SDK without owning PG, credentials, or Session authorization.
 * The caller validates the protected root and holds account/Session locks, checks exact request replay
 * and model capability before calling, then rechecks account authority and commits admitted content.
 * Intake conservatively reserves one physical slot per submitted image before the SDK batch, and
 * checks actual owner bytes and slots afterward, allowing usage exactly at each limit. An SDK write,
 * cancellation, quota failure, or later PG rollback can leave unreachable immutable objects; they
 * remain charged by nativeAttachmentUsage and no partial references are returned. SDK preparation
 * and saving are awaited to completion before the scoped fiber is disposed; cancellation is checked
 * around these operations rather than abandoning an uncancellable SDK write.
 * @param input - server-owned receiving identities and validated prompt parts with file receipts resolved.
 * @param limits - existing shared physical byte and slot budgets and the protected attachment root.
 * @param imageConfig - explicit maintained LocalAttachmentStore admission, normalization and concurrency policy.
 * @param signal - caller lifetime, observed during quota scans and before and after SDK intake.
 * @returns complete ordered prompt parts containing durable native image references, or a rejection.
 */
export async function admitNativeImageContent(input: NativeImageAdmissionInput, limits: NativeAttachmentLimits,
  imageConfig: NativeImageAdmissionConfig, signal: AbortSignal): Promise<AdmittedPromptContentPart[]> {
  signal.throwIfAborted()
  const owner = userId.parse(input.userId), receiving = sessionId.parse(input.sessionId)
  const quotas = { ...limits }
  if (!isAbsolute(quotas.root)
    || [quotas.maxBytesPerUser, quotas.maxFilesPerUser, quotas.maxFilesPerSession]
      .some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('Invalid native image storage limits')
  }
  const config: Required<LocalConfig> = {
    dshHome: join(resolve(quotas.root), owner, receiving),
    maxImageBytes: imageConfig.maxImageBytes,
    maxImagesPerMessage: imageConfig.maxImagesPerMessage,
    maxMessageImageBytes: imageConfig.maxMessageImageBytes,
    maxImagePixels: imageConfig.maxImagePixels,
    maxImageDimension: imageConfig.maxImageDimension,
    normalizedImageMaxPixels: imageConfig.normalizedImageMaxPixels,
    normalizedImageMaxDimension: imageConfig.normalizedImageMaxDimension,
    normalizedImageMaxBytes: imageConfig.normalizedImageMaxBytes,
    imageCompressionConcurrency: imageConfig.imageCompressionConcurrency,
  }
  if (Object.entries(config).some(([key, value]) => key !== 'dshHome'
    && (!Number.isSafeInteger(value) || Number(value) < 1))
    || config.imageCompressionConcurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY) {
    throw new Error('Native image SDK limits must be explicit positive integers within SDK bounds')
  }
  const imageCount = input.content.filter(part => part.type === 'image').length
  if (imageCount > 0) {
    const usage = await nativeAttachmentUsage(quotas.root, owner, quotas.maxFilesPerUser, signal)
    if ((usage.sessionSlots.get(receiving)?.size ?? 0) + imageCount > quotas.maxFilesPerSession) {
      throw new PlatformError(429, 'attachment_count_limit')
    }
    if (usage.files + imageCount > quotas.maxFilesPerUser) throw new PlatformError(429, 'attachment_storage_limit')
    if (usage.bytes >= quotas.maxBytesPerUser) throw new PlatformError(413, 'attachment_bytes_limit')
  }
  const ctx = new Context()
  try {
    await ctx.plugin(LocalAttachmentStore, config)
    signal.throwIfAborted()
    const admitted = await ctx.attachments.admitPromptContent(input.content)
    signal.throwIfAborted()
    if (imageCount > 0) {
      const usage = await nativeAttachmentUsage(quotas.root, owner, quotas.maxFilesPerUser, signal)
      if ((usage.sessionSlots.get(receiving)?.size ?? 0) > quotas.maxFilesPerSession) {
        throw new PlatformError(429, 'attachment_count_limit')
      }
      if (usage.bytes > quotas.maxBytesPerUser) throw new PlatformError(413, 'attachment_bytes_limit')
    }
    return admitted
  } finally {
    await ctx.fiber.dispose()
  }
}
