/** Bounded Office preview wire records; authorization and Pod stop evidence belong to the Platform. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { FILE_DOWNLOAD_MAX_FILE_BYTES, fileDownloadPath } from './file-download.ts'

/** Existing authorized source-byte protocol ceiling. */
export const OFFICE_PREVIEW_MAX_INPUT_BYTES = FILE_DOWNLOAD_MAX_FILE_BYTES
/** Complete PDF protocol ceiling; deployment budgets may be lower. */
export const OFFICE_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** Fixed endpoints for short authenticated requests; conversion does not hold one Platform HTTP request. */
export const OFFICE_PREVIEW_ROUTES = {
  generation: '/office-preview/generation', prepare: '/office-preview/prepare',
  status: '/office-preview/status', content: '/office-preview/content', cancel: '/office-preview/cancel',
} as const

/** An owner-scoped, stable native RPC request identity. */
export type OfficePreviewRequestId = Branded<'PowerEvolveOfficePreviewRequestId'>
/** Server-created persistent preview task identity. */
export type OfficePreviewJobId = Branded<'PowerEvolveOfficePreviewJobId'>
/** Source Session identity; the authenticated Platform resolves its owned Workspace. */
export type OfficePreviewSessionId = Branded<'PowerEvolveOfficePreviewSessionId'>
/** Digest of the fixed converter, fonts and policy; identical replicas publish the same value. */
export type OfficePreviewGeneration = Branded<'PowerEvolveOfficePreviewGeneration'>
/** Server-created creation nonce, permanently bound to one parser task. */
export type OfficePreviewNonce = Branded<'PowerEvolveOfficePreviewNonce'>

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const generation = digest.transform(value => brandString<OfficePreviewGeneration>(value))
const jobId = z.uuid().transform(value => brandString<OfficePreviewJobId>(value))
const nonce = z.uuid().transform(value => brandString<OfficePreviewNonce>(value))
const requestId = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/u)
  .transform(value => brandString<OfficePreviewRequestId>(value))
const sessionId = z.uuid().transform(value => brandString<OfficePreviewSessionId>(value))
const missingFonts = z.array(z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/u)).max(128)

/** Native error reasons preserve the existing document-render classification. */
export const officePreviewErrorCode = z.enum([
  'input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format',
  'invalid-output', 'timeout', 'unavailable', 'failed', 'busy', 'source-changed',
])
/** Validated converter failure category, excluding credentials and diagnostics. */
export type OfficePreviewErrorCode = z.infer<typeof officePreviewErrorCode>

/** Prepare immutable source input with a stable retry key and expected provider generation. */
export const officePreviewPrepareRequest = z.object({
  requestId, sessionId, path: fileDownloadPath,
  priority: z.enum(['foreground', 'background']), generation,
}).strict()
/** Artifact admission fixes its publication identity, exact filename and expected immutable digest. */

/** Workspace requests retain their original JSON and digest; artifact requests cannot contain a Workspace path. */
export const officePreviewSourcePrepareRequest = officePreviewPrepareRequest
/** Status, content and cancellation select an owned persistent task, never a file root or Pod. */
export const officePreviewRefRequest = z.object({ jobId, generation }).strict()
/** Cancel by returned task id or by the original stable key when admission's reply was lost. */
export const officePreviewCancelRequest = z.union([
  officePreviewRefRequest,
  z.object({ requestId, generation }).strict(),
])
/** Shared provider generation returned after authenticating the current account. */
export const officePreviewGenerationView = z.object({ generation }).strict()
/** Persisted public states; blocked retains resources whose termination is unconfirmed. */
export const officePreviewJobView = z.object({
  jobId, generation,
  state: z.enum(['queued', 'creating', 'running', 'stopping', 'succeeded', 'failed', 'cancelled', 'blocked']),
  errorCode: officePreviewErrorCode.nullable(),
}).strict().refine(value => value.state === 'failed' || value.state === 'blocked'
  ? value.errorCode !== null : value.errorCode === null)

const base64 = z.string().max(Math.ceil(OFFICE_PREVIEW_MAX_OUTPUT_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u).refine((value) => {
    if (value.length % 4 !== 0) return false
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    if (value.endsWith('==')) return alphabet.indexOf(value.charAt(value.length - 3)) % 16 === 0
    if (value.endsWith('=')) return alphabet.indexOf(value.charAt(value.length - 2)) % 4 === 0
    return true
  })
/** Bounded private content response; the Host verifies PDF bytes/SHA before native multipart delivery. */
export const officePreviewContentView = z.object({
  absolutePath: z.string().min(1).max(1024).refine(value => value.startsWith('/workspace/')
    && fileDownloadPath.safeParse(value.slice('/workspace/'.length)).success),
  version: digest, bytes: z.number().int().positive().max(OFFICE_PREVIEW_MAX_OUTPUT_BYTES),
  offset: z.literal(0), eof: z.literal(true), data: base64,
  missingFonts, generation, pdfSha256: digest,
}).strict().refine(value => value.data.length / 4 * 3
  - (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0) === value.bytes)

/** Explicit per-task parser budgets with fixed protocol maxima; no runtime path or executable selection. */
export const officePreviewLimits = z.object({
  inputBytes: z.number().int().positive().max(OFFICE_PREVIEW_MAX_INPUT_BYTES),
  outputBytes: z.number().int().positive().max(OFFICE_PREVIEW_MAX_OUTPUT_BYTES),
  timeoutMs: z.number().int().min(1000).max(180_000),
  archiveEntries: z.number().int().positive().max(10_000),
  uncompressedBytes: z.number().int().positive().max(128 * 1024 * 1024),
  fontLoadedBytes: z.number().int().positive().max(256 * 1024 * 1024),
  pages: z.number().int().positive().max(1000),
  fontFiles: z.number().int().positive().max(10_000),
  fontFileBytes: z.number().int().positive().max(128 * 1024 * 1024),
  fontResolutionEntries: z.number().int().positive().max(100_000),
  imageResolution: z.number().int().positive().max(600),
}).strict()
/** Fixed one-task input inside the isolated parser; filenames are derived from the validated extension. */
export const officePreviewJobSchema = z.object({
  protocolVersion: z.literal(1), jobId, nonce, generation,
  sourceSha256: digest, sourceBytes: z.number().int().min(0).max(OFFICE_PREVIEW_MAX_INPUT_BYTES),
  extension: z.enum(['doc', 'docx', 'ppt', 'pptx']), limits: officePreviewLimits,
}).strict().refine(value => value.sourceBytes <= value.limits.inputBytes)
/** Atomic result marker; it is data, not evidence that the parser Pod has stopped. */
export const officePreviewResultSchema = z.object({
  protocolVersion: z.literal(1), jobId, nonce, generation, sourceSha256: digest,
  pdfSha256: digest, pdfBytes: z.number().int().positive().max(OFFICE_PREVIEW_MAX_OUTPUT_BYTES),
  pages: z.number().int().positive().max(1000), missingFonts, backend: z.literal('wasm'),
}).strict()
/** Optional failed-task marker written after cleanup; it supplies no Pod stop proof or diagnostic text. */
export const officePreviewFailureSchema = z.object({
  protocolVersion: z.literal(1), jobId, nonce, generation, sourceSha256: digest,
  errorCode: officePreviewErrorCode,
}).strict()

/** Validated durable admission request. */
export type OfficePreviewPrepareRequest = z.infer<typeof officePreviewPrepareRequest>
/** Workspace or artifact admission; Workspace JSON remains compatible with earlier records. */
export type OfficePreviewSourcePrepareRequest = z.infer<typeof officePreviewSourcePrepareRequest>
/** Validated owned task selector. */
export type OfficePreviewRefRequest = z.infer<typeof officePreviewRefRequest>
/** Validated cancellation target; an early request-key cancellation must remain durable. */
export type OfficePreviewCancelRequest = z.infer<typeof officePreviewCancelRequest>
/** Bounded persistent task view. */
export type OfficePreviewJobView = z.infer<typeof officePreviewJobView>
/** Validated complete content; consumers still authenticate and verify its byte digest. */
export type OfficePreviewContentView = z.infer<typeof officePreviewContentView>
/** Frozen isolated parser input. */
export type OfficePreviewJob = z.infer<typeof officePreviewJobSchema>
/** Frozen isolated parser result, awaiting independent byte and stop verification. */
export type OfficePreviewResult = z.infer<typeof officePreviewResultSchema>
/** Validated failure classification, bound to the original task and independent termination facts. */
export type OfficePreviewFailure = z.infer<typeof officePreviewFailureSchema>
