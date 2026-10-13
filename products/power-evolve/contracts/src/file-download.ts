/** Browser-safe preparation and content requests for authorized workspace downloads. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Protocol ceiling; the Platform may configure a lower file count. */
export const FILE_DOWNLOAD_MAX_FILES = 1
/** Encoded same-origin URL ceiling shared by preparation and content requests. */
export const FILE_DOWNLOAD_MAX_URL_BYTES = 6000
/** Browser content endpoint; its query never carries a credential. */
export const FILE_DOWNLOAD_CONTENT_PATH = '/api/powerEvolve/workspace-download'
/** Trusted Platform content endpoint reached by the authenticated Host. */
export const FILE_DOWNLOAD_PLATFORM_PATH = '/files/download'
/** Existing workspace single-file byte ceiling. */
export const FILE_DOWNLOAD_MAX_FILE_BYTES = 32 * 1024 * 1024
/** Source-byte protocol ceiling; deployment limits may be lower. */
export const FILE_DOWNLOAD_MAX_SOURCE_BYTES = FILE_DOWNLOAD_MAX_FILES * FILE_DOWNLOAD_MAX_FILE_BYTES
/** Session identity in the browser download protocol. */
export type DownloadSessionId = Branded<'PowerEvolveDownloadSessionId'>
/** Workspace identity in the browser download protocol. */
export type DownloadWorkspaceId = Branded<'PowerEvolveDownloadWorkspaceId'>
const sessionId = z.uuid().transform(value => brandString<DownloadSessionId>(value))
const workspaceId = z.uuid().transform(value => brandString<DownloadWorkspaceId>(value))
const revision = z.string().regex(/^[a-f0-9]{64}$/u)

/** Canonical relative path without traversal or platform-specific path syntax. */
export const fileDownloadPath = z.string().min(1).max(512).refine((value) => {
  const parts = value.split('/')
  const canonical = !value.includes('\\') && value.normalize('NFC') === value
    && !/^[A-Za-z]:/u.test(value) && parts.length <= 16
    && parts.every(part => part.length > 0 && part.length <= 100 && part !== '.' && part !== '..')
  if (!canonical) return false
  for (const character of value) {
    const point = character.codePointAt(0)
    if (point === undefined || point <= 0x1f || point === 0x7f || point >= 0xd800 && point <= 0xdfff) return false
  }
  return true
})
const paths = z.tuple([fileDownloadPath])

/** Read-only preparation; the authenticated Session determines its Workspace. */
export const fileDownloadPrepareRequest = z.object({ sessionId, paths }).strict()
/** A content request binds the selected files to their prepared metadata digest. */
export const fileDownloadContentRequest = fileDownloadPrepareRequest.extend({ revision }).strict()
/** Prepared metadata contains neither file bytes nor physical filesystem paths. */
export const fileDownloadView = z.object({
  sessionId, workspaceId, revision,
  downloadUrl: z.string().min(1).max(FILE_DOWNLOAD_MAX_URL_BYTES),
  fileName: z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f/\\]/u.test(value)),
  contentType: z.literal('application/octet-stream'),
  fileCount: z.literal(1),
  sourceBytes: z.number().int().min(0).max(FILE_DOWNLOAD_MAX_SOURCE_BYTES),
  totalBytes: z.number().int().min(0).max(FILE_DOWNLOAD_MAX_SOURCE_BYTES + 1024 * 1024),
}).strict().refine((value) => {
  if (!value.downloadUrl.startsWith(`${FILE_DOWNLOAD_CONTENT_PATH}?`)) return false
  try {
    const url = new URL(value.downloadUrl, 'https://power-evolve.invalid')
    if (url.hash || [...url.searchParams.keys()].length !== 3
      || ['sessionId', 'paths', 'revision'].some(name => url.searchParams.getAll(name).length !== 1)) return false
    const encodedPaths = url.searchParams.get('paths')
    if (encodedPaths === null) return false
    const decodedPaths: unknown = JSON.parse(encodedPaths)
    const request = fileDownloadContentRequest.parse({ sessionId: url.searchParams.get('sessionId'),
      paths: decodedPaths, revision: url.searchParams.get('revision') })
    return value.downloadUrl === fileDownloadUrl(request) && value.sessionId === request.sessionId
      && value.revision === request.revision
      && value.sourceBytes <= value.fileCount * FILE_DOWNLOAD_MAX_FILE_BYTES
      && value.totalBytes >= value.sourceBytes
      && value.fileName === request.paths[0].split('/').at(-1)
      && value.totalBytes === value.sourceBytes
  } catch (_error) {
    // An invalid or oversized URL must never become a browser navigation target.
    return false
  }
})
/** Validated preparation input. */
export type FileDownloadPrepareRequest = z.infer<typeof fileDownloadPrepareRequest>
/** Validated content input. */
export type FileDownloadContentRequest = z.infer<typeof fileDownloadContentRequest>
/** Bounded metadata returned before a browser-owned download. */
export type FileDownloadView = z.infer<typeof fileDownloadView>

/** Build the sole permitted browser download URL from already validated fields.
 * @param request - Session, ordered selection and prepared metadata digest.
 * @returns Relative same-origin URL; throws if the encoded request exceeds its wire ceiling.
 */
export function fileDownloadUrl(request: FileDownloadContentRequest): string {
  const query = new URLSearchParams({ sessionId: request.sessionId, paths: JSON.stringify(request.paths), revision: request.revision })
  const url = `${FILE_DOWNLOAD_CONTENT_PATH}?${query}`
  if (new TextEncoder().encode(url).byteLength > FILE_DOWNLOAD_MAX_URL_BYTES) throw new RangeError('Download URL exceeds protocol limit')
  return url
}
