import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { AttachmentId, type AttachmentAdmissionPart, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { prepareImageFile, readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { sessionId, userId } from '../src/contracts.ts'
import { admitNativeImageContent, type NativeImageAdmissionConfig } from '../src/platform/native-image-admission.ts'
import { nativeAttachmentUsage } from '../src/platform/native-attachment-storage.ts'
import type { NativeAttachmentLimits } from '../src/platform/native-attachments.ts'

const owner = userId.parse('e7000000-0000-4000-8000-000000000001')
const receiving = sessionId.parse('e7000000-0000-4000-8000-000000000002')
const secondSession = sessionId.parse('e7000000-0000-4000-8000-000000000003')
const imageConfig: NativeImageAdmissionConfig = {
  maxImageBytes: 65536, maxImagesPerMessage: 4, maxMessageImageBytes: 262144,
  maxImagePixels: 4096, maxImageDimension: 64,
  normalizedImageMaxPixels: 4096, normalizedImageMaxDimension: 64, normalizedImageMaxBytes: 65536,
  imageCompressionConcurrency: 1,
}
const signal = (): AbortSignal => new AbortController().signal
type ImagePart = Extract<AttachmentAdmissionPart, { type: 'image' }>

const pngSources = {
  first: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWPgYmLmYmIGAAB+AB9eAzL0AAAAAElFTkSuQmCC',
  second: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWM4wcTMcIKJGQAH+gGbkyl0lgAAAABJRU5ErkJggg==',
  third: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAIAAACUgoPjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIYWKGIAAHVAE8WHOJuwAAAABJRU5ErkJggg==',
}

function png(source: keyof typeof pngSources, name: string): ImagePart {
  return { type: 'image', mediaType: 'image/png', data: pngSources[source], name }
}

async function preparedRef(part: ImagePart): Promise<ImageAttachmentRef> {
  const prepared = await prepareImageFile({ data: Buffer.from(part.data, 'base64'), mediaType: part.mediaType,
    ...part.name === undefined ? {} : { name: part.name } }, {
    maxImageBytes: imageConfig.maxImageBytes, maxImagesPerMessage: imageConfig.maxImagesPerMessage,
    maxMessageImageBytes: imageConfig.maxMessageImageBytes, maxImagePixels: imageConfig.maxImagePixels,
    maxImageDimension: imageConfig.maxImageDimension, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }, {
    maxPixels: imageConfig.normalizedImageMaxPixels, maxDimension: imageConfig.normalizedImageMaxDimension,
    maxBytes: imageConfig.normalizedImageMaxBytes,
  })
  return prepared.ref
}

async function storage(run: (limits: NativeAttachmentLimits) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pe-native-image-admission-'))
  try { await run({ root, maxFilesPerSession: 4, maxFilesPerUser: 8, maxBytesPerUser: 524288 }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('official SDK intake preserves mixed part order and stores verified real PNG references below the receiving DSH home', async () => {
  await storage(async (limits) => {
    const first = png('first', 'first.png'), second = png('second', 'second.png')
    const file = { attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`), name: 'already-bound.txt', bytes: 4 }
    const admitted = await admitNativeImageContent({ userId: owner, sessionId: receiving, content: [
      { type: 'text', text: 'first' }, first, { type: 'file', attachment: file }, second, { type: 'text', text: 'last' },
    ] }, limits, imageConfig, signal())
    expect(admitted.map(part => part.type)).toEqual(['text', 'image', 'file', 'image', 'text'])
    expect(admitted[2]).toEqual({ type: 'file', attachment: file })
    const refs = admitted.flatMap(part => part.type === 'image' ? [part.attachment] : [])
    expect(refs.map(ref => [ref.name, ref.width, ref.height])).toEqual([['first.png', 2, 1], ['second.png', 1, 2]])
    const root = join(limits.root, owner, receiving, 'attachments', 'v1')
    for (const ref of refs) expect((await readImageFile(root, ref)).ref).toEqual(ref)
    const usage = await nativeAttachmentUsage(limits.root, owner, limits.maxFilesPerUser, signal())
    expect(usage.bytes).toBe(refs.reduce((total, ref) => total + ref.bytes, 0))
    expect(usage.files).toBe(2)
  })
})

test('a malformed second image fails native batch preparation before any object is published', async () => {
  await storage(async (limits) => {
    await expect(admitNativeImageContent({ userId: owner, sessionId: receiving, content: [
      png('first', 'valid.png'), { type: 'image', mediaType: 'image/png', data: 'AQID' },
    ] }, limits, imageConfig, signal())).rejects.toThrow(/Unsupported or malformed image data/)
    const usage = await nativeAttachmentUsage(limits.root, owner, limits.maxFilesPerUser, signal())
    expect(usage.bytes).toBe(0)
    expect(usage.files).toBe(0)
  })
})

test('exact physical byte and slot limits admit the complete batch and a further image refuses before saving', async () => {
  await storage(async (limits) => {
    const images = [png('first', 'first.png'), png('second', 'second.png')]
    const refs = await Promise.all(images.map(preparedRef))
    const boundary = { ...limits, maxFilesPerSession: 2, maxFilesPerUser: 2,
      maxBytesPerUser: refs.reduce((total, ref) => total + ref.bytes, 0) }
    const admitted = await admitNativeImageContent({ userId: owner, sessionId: receiving, content: images },
      boundary, imageConfig, signal())
    expect(admitted).toEqual(refs.map(attachment => ({ type: 'image', attachment })))
    const before = await nativeAttachmentUsage(limits.root, owner, boundary.maxFilesPerUser, signal())
    expect(before.bytes).toBe(boundary.maxBytesPerUser)
    expect(before.files).toBe(2)
    await expect(admitNativeImageContent({ userId: owner, sessionId: receiving, content: [
      png('third', 'third.png'),
    ] }, boundary, imageConfig, signal())).rejects.toMatchObject({ code: 'attachment_count_limit' })
    expect(await nativeAttachmentUsage(limits.root, owner, boundary.maxFilesPerUser, signal())).toEqual(before)
  })
})

test('a post-save byte fence returns no references and its unreachable SDK object consumes quota in another Session', async () => {
  await storage(async (limits) => {
    const image = png('first', 'orphan.png'), ref = await preparedRef(image)
    await expect(admitNativeImageContent({ userId: owner, sessionId: receiving, content: [image] },
      { ...limits, maxBytesPerUser: ref.bytes - 1 }, imageConfig, signal()))
      .rejects.toMatchObject({ code: 'attachment_bytes_limit' })
    const orphan = await nativeAttachmentUsage(limits.root, owner, limits.maxFilesPerUser, signal())
    expect(orphan.bytes).toBe(ref.bytes)
    expect(orphan.files).toBe(1)
    await expect(admitNativeImageContent({ userId: owner, sessionId: secondSession, content: [
      png('second', 'next.png'),
    ] }, { ...limits, maxFilesPerUser: 1 }, imageConfig, signal()))
      .rejects.toMatchObject({ code: 'attachment_storage_limit' })
    expect(await nativeAttachmentUsage(limits.root, owner, limits.maxFilesPerUser, signal())).toEqual(orphan)
  })
})
