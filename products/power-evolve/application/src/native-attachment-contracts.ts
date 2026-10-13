/** Durable Session file intake and prompt receipts on the trusted Platform. */
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import { legacyMigrationImage } from './platform/legacy-migration-v2-media-contracts.ts'

/** Maximum original file bytes accepted by the native cloud attachment protocol. */
export const NATIVE_FILE_MAX_BYTES = 32 * 1024 * 1024
/** Platform-minted authority for one upload into one owned Session. */
export const fileReceiptId = z.uuid().transform(value => brandString<FileUploadReceiptId>(value))
/** Original file identity; byte count and digest are verified when the object is read. */
export const nativeFileAttachment = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(brandString<AttachmentId>),
  name: z.string().min(1).max(255), bytes: z.number().int().min(0).max(NATIVE_FILE_MAX_BYTES),
}).strict()
/** Browser prompt content preserves part ordering and never accepts a caller-supplied stored file identity. */
export const nativePromptContent = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('file'), receiptId: fileReceiptId }).strict(),
  z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(1), name: z.string().max(4096).optional() }).strict(),
])).min(1).max(32).refine(parts => parts.some(part => part.type !== 'text' || part.text.trim().length > 0),
  { message: 'Prompt must contain visible text or an attachment' })
/** Prompt parts after durable receipt binding, used directly by the native Agent. */
export const admittedNativeContent = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('file'), attachment: nativeFileAttachment }).strict(),
  z.object({ type: z.literal('image'), attachment: legacyMigrationImage }).strict(),
])).min(1).max(32)
