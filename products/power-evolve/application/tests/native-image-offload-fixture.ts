/** Real original image history for detached input planning and archival recovery. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** Create a canonical closed image turn using the owning Host SessionStore and a real attachment provider.
 * @param ctx Host whose SessionStore has the official image message projection registered.
 * @param header Original Platform storage metadata for this owned Session.
 * @param home Isolated physical original-image directory removed by the outer cloud fixture.
 * @returns Original immutable prefix, still-live detached Session, and physical image verification/cleanup.
 */
export async function prepareNativeImageOffloadHistory(ctx: Context, header: SessionHeader, home: string) {
  const imageContext = new Context()
  try {
    const originals = new AttachmentLocal(imageContext, { dshHome: home, maxImageBytes: 65536, maxImagePixels: 4_000_000,
      maxImageDimension: 8192, normalizedImageMaxBytes: 65536, normalizedImageMaxPixels: 4096, normalizedImageMaxDimension: 64 })
    const input = await readFile(new URL('./fixtures/native-image-original.png', import.meta.url))
    const ref = await originals.saveImage({ data: input, mediaType: 'image/png', name: 'original.png' })
    const { data: bytes } = await originals.readImage(ref)
    const session = ctx.sessions.prepare(header.id, { meta: header })
    const start = session.append('turn/start', { turn: 1 })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: ref }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const offload = session.append('image/offload', { targets: [{ seq: message.seq, imageIndexes: [0] }] })
    return { session, prefix: [start, message, end, offload], message: message.data, ref, bytes,
      readOriginal: () => originals.readImage(ref), dispose: () => imageContext.fiber.dispose() }
  } catch (error) {
    await imageContext.fiber.dispose()
    throw error
  }
}
