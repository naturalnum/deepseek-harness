/** Bounded native image responses under current operation or browser Session authorization. */
import { z } from 'zod'
import { AttachmentId, isAttachmentError } from '@deepseek-ai/dsh-attachment'
import { PlatformError, sessionId } from '../contracts.ts'
import type { LegacyMigrationImageReader } from './legacy-migration-v2-image-reader.ts'
import type { NativeImageReader } from './native-images.ts'
import { legacyMigrationImage } from './legacy-migration-v2-media-contracts.ts'

/** Return verified original bytes without accepting caller storage paths or upload authority.
 * @param reader Platform-owned original image reader and current-grant authorization.
 * @param token Current operation bearer from the authenticated HTTP request.
 * @param input Untrusted JSON carrying only an exact native image reference.
 * @param signal HTTP disconnect and deployment-configured read deadline.
 * @returns Exact original image metadata and canonical base64 bytes.
 */
export async function readNativeImageResponse(reader: Pick<LegacyMigrationImageReader, 'read'>,
  token: string, input: unknown, signal: AbortSignal) {
  const request = z.object({ image: legacyMigrationImage }).strict().parse(input)
  const stored = await reader.read(token, request.image, signal)
  return { image: stored.ref, data: Buffer.from(stored.data).toString('base64') }
}

/** Native browser image lookup accepts only an addressed Session and opaque original attachment identity. */
export const nativeBrowserImageRequest = z.object({ sessionId,
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(AttachmentId) }).strict()

/** Read a canonically referenced original image under current browser authority, including after its turn has ended.
 * @param reader Actual Platform permission and owned canonical history provider.
 * @param credential Current browser bearer, never substituted with an operation grant.
 * @param input Native Session and attachment lookup, without bytes, metadata or storage paths.
 * @param signal HTTP disconnect and configured original-read deadline.
 * @returns Official native attachment response with SDK-verified original metadata and canonical base64 bytes.
 */
export async function readNativeBrowserImageResponse(reader: Pick<NativeImageReader, 'readBrowser'>,
  credential: string, input: unknown, signal: AbortSignal) {
  const request = nativeBrowserImageRequest.parse(input)
  try {
    const stored = await reader.readBrowser(credential, request.sessionId, request.attachmentId, signal)
    return { attachment: stored.ref, data: Buffer.from(stored.data).toString('base64') }
  } catch (error) {
    if (isAttachmentError(error)) throw new PlatformError(400, error.code)
    throw error
  }
}
