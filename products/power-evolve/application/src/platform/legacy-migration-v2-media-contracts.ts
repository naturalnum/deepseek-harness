/** Exact original image identities and migration-owned permissions; offload decisions retain their durable event coordinates. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const dimension = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
/** Original normalized image metadata; publication never normalizes these bytes again. */
export const legacyMigrationImage = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(brandString<AttachmentId>),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: count, width: dimension, height: dimension, name: z.string().optional(),
  originalDimensions: z.object({ width: dimension, height: dimension }).strict().optional(),
}).strict().transform((value): ImageAttachmentRef => ({
  attachmentId: value.attachmentId, mediaType: value.mediaType, bytes: value.bytes, width: value.width, height: value.height,
  ...(value.name === undefined ? {} : { name: value.name }),
  ...(value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions }),
}))
/** Source-owned assignment of one exact image occurrence and its detached DSH home. */
export const legacyMigrationImageSource = z.object({
  kind: z.literal('image'), userId: z.uuid(), originSessionId: z.uuid(), rootId: z.string().min(1),
  sourceRowSha256: digest, imageIndex: count, image: legacyMigrationImage,
}).strict()
/** One qualified source image occurrence, independent of any inferred path owner. */
export type LegacyMigrationImageSource = z.infer<typeof legacyMigrationImageSource>
/** An immutable image permission minted by this migration, with no browser upload or old request identity. */
export const legacyMigrationImageBinding = z.object({
  kind: z.literal('image'), authority: z.literal('verified-history-migration'), migrationId: z.uuid(),
  userId: z.uuid(), sessionId: z.uuid(), storageSessionId: z.uuid(), sourceRootId: z.string().min(1),
  sourceRowSha256s: z.array(digest).min(1), image: legacyMigrationImage,
  occurrences: z.array(z.object({ seq: count, imageIndex: count }).strict()).min(1),
}).strict()
/** Durable image authority tied to exact original metadata and inherited event occurrences. */
export type LegacyMigrationImageBinding = z.infer<typeof legacyMigrationImageBinding>
/** Source image inventory and explicit raster budget included in the signed file cut. */
export const legacyMigrationImagesInput = z.object({ sources: z.array(legacyMigrationImageSource),
  sourceHomes: z.record(z.string(), z.string().min(1)), maxImagePixels: dimension }).strict()
/** Complete protected image input for one maintenance run. */
export type LegacyMigrationImagesInput = z.infer<typeof legacyMigrationImagesInput>
/** Private per-Session image permissions; native browser preferences cannot write this namespace. */
export const legacyMigrationImageLedger = z.object({
  version: z.literal(1), userId: z.uuid(), sessionId: z.uuid(),
  bindings: z.array(legacyMigrationImageBinding),
}).strict()
/** Explicit deployment bounds for original reads and derived request images. */
export interface LegacyMigrationImageReadLimits {
  readonly root: string
  readonly maxImageBytes: number
  readonly maxImagePixels: number
  readonly maxLedgerBytes: number
}
