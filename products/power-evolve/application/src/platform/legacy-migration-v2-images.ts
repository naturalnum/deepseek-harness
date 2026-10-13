/** Source-backed image permissions and original normalized objects; image/offload never replaces their identity or bytes. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal, { commitPreparedImageFile, readImageFile } from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { parseEvents } from '../session-records.ts'
import { LegacyImportError, type LegacyImportLimits } from './legacy-import-codec.ts'
import type { LegacyMigratedHistory } from './legacy-migration-v2-history.ts'
import { legacyHistoryAncestorOrigin, legacyHistoryTargetSequences } from './legacy-migration-v2-attachments.ts'
import { legacyMigrationImage, legacyMigrationImageBinding, legacyMigrationImageSource,
  type LegacyMigrationImageBinding, type LegacyMigrationImageSource } from './legacy-migration-v2-media-contracts.ts'

/** Original immutable image occurrences, including messages later shadowed or offloaded.
 * @param history Complete validated current artifact.
 * @returns Exact message event/image indexes and unchanged metadata.
 */
export function legacyHistoryImages(history: LegacyMigratedHistory): readonly {
  seq: number
  imageIndex: number
  image: ImageAttachmentRef
}[] {
  const images: { seq: number; imageIndex: number; image: ImageAttachmentRef }[] = []
  for (const event of parseEvents(history.header, history.events)) {
    const message = deriveEventMessage(event)
    if (!message) continue
    let imageIndex = 0
    for (const block of message.content) if (block.type === 'image') {
      images.push({ seq: event.seq, imageIndex: imageIndex++, image: legacyMigrationImage.parse(block.attachment) })
    }
  }
  return images
}

/** Bind every current image occurrence to one exact stopped-source declaration.
 * @param migrationId New migration identity, never a browser upload identity.
 * @param histories Complete current parent/fork inventory and original coordinates.
 * @param declarations Source owner/root/row/occurrence assignments.
 * @returns Explicit image permissions for each Session and inherited prefix.
 */
export function planLegacyHistoryImages(migrationId: string, histories: readonly LegacyMigratedHistory[],
  declarations: readonly LegacyMigrationImageSource[]): readonly LegacyMigrationImageBinding[] {
  const sources = declarations.map(value => legacyMigrationImageSource.parse(value)), used = new Set<LegacyMigrationImageSource>()
  const bindings: LegacyMigrationImageBinding[] = []
  const occurrences = new Map(histories.map(history => [history.sessionId, legacyHistoryImages(history)]))
  for (const history of histories) {
    const grouped = new Map<string, {
      source: LegacyMigrationImageSource
      rows: string[]
      occurrences: { seq: number; imageIndex: number }[]
    }>()
    for (const occurrence of occurrences.get(history.sessionId) ?? []) {
      const matching = sources.filter((source) => {
        if (source.userId !== history.userId || source.imageIndex !== occurrence.imageIndex
          || !isDeepStrictEqual(source.image, occurrence.image)
          || !legacyHistoryAncestorOrigin(history, source.originSessionId, occurrence.seq, histories)) return false
        const origin = histories.find(item => item.sessionId === source.originSessionId)
        const row = origin?.sourceRows.indexOf(source.sourceRowSha256) ?? -1
        return origin !== undefined && row >= 0 && legacyHistoryTargetSequences(origin, row).includes(occurrence.seq)
          && occurrences.get(origin.sessionId)?.some(item => item.seq === occurrence.seq && item.imageIndex === source.imageIndex
            && isDeepStrictEqual(item.image, source.image)) === true
      })
      if (matching.length !== 1 || !matching[0]) throw new LegacyImportError('history_image_source_unqualified')
      const source = matching[0]
      used.add(source)
      const key = JSON.stringify([source.originSessionId, source.image]), previous = grouped.get(key)
      if (previous) {
        if (previous.source.rootId !== source.rootId) throw new LegacyImportError('history_image_root_conflict')
        if (!previous.rows.includes(source.sourceRowSha256)) previous.rows.push(source.sourceRowSha256)
        previous.occurrences.push({ seq: occurrence.seq, imageIndex: occurrence.imageIndex })
      } else grouped.set(key, { source, rows: [source.sourceRowSha256],
        occurrences: [{ seq: occurrence.seq, imageIndex: occurrence.imageIndex }] })
    }
    for (const group of grouped.values()) bindings.push(legacyMigrationImageBinding.parse({ kind: 'image',
      authority: 'verified-history-migration', migrationId, userId: history.userId, sessionId: history.sessionId,
      storageSessionId: group.source.originSessionId, sourceRootId: group.source.rootId,
      sourceRowSha256s: group.rows, image: group.source.image, occurrences: group.occurrences }))
  }
  if (used.size !== sources.length) throw new LegacyImportError('history_image_inventory_unused')
  return Object.freeze(bindings)
}

/** Resolve the maintained provider's normalized path without encoding or rewriting the object.
 * @param home Explicit DSH home assigned by the source owner or candidate deployment.
 * @param image Exact durable SDK reference.
 * @returns Maintained immutable object path and versioned root.
 */
export async function legacyImageLocation(home: string, image: ImageAttachmentRef): Promise<{ root: string; path: string }> {
  if (!isAbsolute(home)) throw new LegacyImportError('history_image_home')
  const ctx = new Context()
  try {
    const provider = new AttachmentLocal(ctx, { dshHome: home })
    return { root: provider.root, path: provider.imageHostPath(image) }
  } finally { await ctx.fiber.dispose() }
}

/** Verify one source object through a bounded no-follow descriptor and the maintained image reader.
 * @param home Explicit detached DSH home, never an inferred tenant identity.
 * @param image Recorded normalized metadata and digest.
 * @param destination Disjoint candidate image home.
 * @param limits Explicit byte/pixel-independent migration budgets.
 * @param signal Maintenance cancellation.
 * @returns Original bytes after inode, size, digest, media type and dimensions checks.
 */
export async function readLegacyOriginalImage(home: string, image: ImageAttachmentRef, destination: string,
  limits: Pick<LegacyImportLimits, 'maxFileBytes' | 'maxStorageBytes'>, signal: AbortSignal): Promise<StoredImageAttachment> {
  signal.throwIfAborted()
  if (image.bytes > limits.maxFileBytes || image.bytes > limits.maxStorageBytes) throw new LegacyImportError('history_image_budget')
  const source = await realpath(resolve(home)), target = resolve(destination)
  const inside = (parent: string, child: string) => {
    const tail = relative(parent, child)
    return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)
  }
  if (!isAbsolute(home) || !isAbsolute(destination) || inside(source, target) || inside(target, source)
    || (await lstat(home)).isSymbolicLink()) throw new LegacyImportError('history_image_root_overlap')
  const location = await legacyImageLocation(source, image)
  let cursor = dirname(location.path)
  const ancestors: { path: string; dev: bigint; ino: bigint }[] = []
  for (;;) {
    const stat = await lstat(cursor, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LegacyImportError('history_image_symlink')
    ancestors.push({ path: cursor, dev: stat.dev, ino: stat.ino })
    if (cursor === source) break
    cursor = dirname(cursor)
    if (!inside(source, cursor)) throw new LegacyImportError('history_image_escape')
  }
  const handle = await open(location.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(image.bytes)) throw new LegacyImportError('history_image_size')
    const bytes = Buffer.alloc(image.bytes)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset)
      if (!read.bytesRead) throw new LegacyImportError('history_image_changed')
      offset += read.bytesRead
    }
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== image.attachmentId) throw new LegacyImportError('history_image_digest')
    const stored = await readImageFile(location.root, image, signal)
    for (const ancestor of ancestors) {
      const stat = await lstat(ancestor.path, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ancestor.dev || stat.ino !== ancestor.ino) {
        throw new LegacyImportError('history_image_changed')
      }
    }
    const after = await handle.stat({ bigint: true }), linked = await lstat(location.path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.dev !== linked.dev || before.ino !== linked.ino || !Buffer.from(stored.data).equals(bytes)) {
      throw new LegacyImportError('history_image_changed')
    }
    return stored
  } finally { await handle.close() }
}

/** Publish unchanged normalized bytes under their explicit original owner/origin image home.
 * @param bindings Complete source-qualified migration permissions.
 * @param sourceHomes Protected root-ID to original DSH-home assignments.
 * @param targetRoot Existing private original attachment root; SDK images stay separate from file-store objects.
 * @param limits Explicit count and aggregate byte budgets.
 * @param maxImagePixels Explicit normalized raster bound checked before reading.
 * @param signal Maintenance lifetime.
 * @returns Exact original object digests published once per owner/origin/identity.
 */
export async function stageLegacyHistoryImages(bindings: readonly LegacyMigrationImageBinding[],
  sourceHomes: Readonly<Record<string, string>>, targetRoot: string, limits: LegacyImportLimits,
  maxImagePixels: number, signal: AbortSignal): Promise<readonly string[]> {
  const copied = new Set<string>()
  let total = 0
  const digests: string[] = []
  for (const binding of bindings) {
    if (!Number.isSafeInteger(maxImagePixels) || maxImagePixels < 1
      || BigInt(binding.image.width) * BigInt(binding.image.height) > BigInt(maxImagePixels)) {
      throw new LegacyImportError('history_image_pixel_budget')
    }
    const key = JSON.stringify([binding.userId, binding.storageSessionId, binding.image.attachmentId])
    const target = join(targetRoot, binding.userId, binding.storageSessionId)
    if (copied.has(key)) {
      const location = await legacyImageLocation(target, binding.image)
      await readImageFile(location.root, binding.image, signal)
      continue
    }
    if (copied.size >= limits.maxFiles || total + binding.image.bytes > limits.maxStorageBytes) throw new LegacyImportError('history_image_budget')
    const source = sourceHomes[binding.sourceRootId]
    if (!source) throw new LegacyImportError('history_image_home_missing')
    const stored = await readLegacyOriginalImage(source, binding.image, target, limits, signal)
    const location = await legacyImageLocation(target, binding.image)
    signal.throwIfAborted()
    await commitPreparedImageFile(location.root, stored)
    const checked = await readImageFile(location.root, binding.image, signal)
    if (!Buffer.from(checked.data).equals(Buffer.from(stored.data))) throw new LegacyImportError('history_image_target_changed')
    copied.add(key); total += binding.image.bytes; digests.push(String(binding.image.attachmentId))
  }
  return Object.freeze(digests)
}
