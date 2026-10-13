/** Original immutable file bytes and explicitly minted migration receipts; filesystem paths never establish tenant identity. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fileLeafName, saveFileStreamVerbatim, storedFilePath } from '@deepseek-ai/dsh-attachment-local'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { nativeFileAttachment } from '../native-attachment-contracts.ts'
import { LegacyImportError, legacyDigest, type LegacyImportLimits } from './legacy-import-codec.ts'
import type { LegacyMigratedHistory } from './legacy-migration-v2-history.ts'

/** A source owner declares the storage root and exact archived event carrying a durable file reference. */
export const legacyMigrationFileSource = z.object({ userId: z.uuid(), originSessionId: z.uuid(), rootId: z.string().min(1),
  sourceRowSha256: z.string().regex(/^[a-f0-9]{64}$/u), file: nativeFileAttachment }).strict()
/** One explicit original file assignment, independent of its storage path. */
export type LegacyMigrationFileSource = z.infer<typeof legacyMigrationFileSource>
/** New authority is named as a migration binding, never an original browser-upload request. */
export interface LegacyMigrationFileReceipt {
  readonly id: string
  readonly userId: string
  readonly sessionId: string
  readonly storageSessionId: string
  readonly bindingRequestId: string
  readonly file: FileAttachmentRef
  readonly sourceRootId: string
  readonly sourceRowSha256: string
  readonly sourceRowSha256s: readonly string[]
  readonly sourceObjectSha256: string
  readonly referencedEventSeqs: readonly number[]
  readonly authority: 'verified-history-migration'
}
function stableUuid(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify([domain, ...values])).digest()
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x80
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
/** Map one original physical row or logical event through every maintained adjacent stage.
 * @param history Restored artifact and complete emitted coordinate ledger.
 * @param sourceRow Original zero-based row or event index.
 * @returns Exact current emitted event positions derived from that source.
 */
export function legacyHistoryTargetSequences(history: LegacyMigratedHistory, sourceRow: number): readonly number[] {
  let current = [sourceRow]
  if (history.encoding === 'released-physical') {
    current = history.coordinates.filter(item => item.stage === `decode-v${history.sourceVersion}`
      && item.input.includes(sourceRow)).flatMap(item => [...item.output])
  }
  for (let version = history.sourceVersion; version < 4; version++) {
    current = [...new Set(history.coordinates.filter(item => item.stage === `${version}->${version + 1}`
      && item.input.some(input => current.includes(input))).flatMap(item => [...item.output]))]
  }
  return current
}
function messageFiles(history: LegacyMigratedHistory): readonly {
  seq: number
  file: FileAttachmentRef
}[] {
  const found: {
    seq: number
    file: FileAttachmentRef
  }[] = []
  for (const event of history.events) {
    if (event.type !== 'user/message') continue
    const message = z.object({ content: z.array(z.object({ type: z.string() }).loose()) }).loose().parse(event.data)
    for (const part of message.content) {
      if (part.type === 'file') found.push({ seq: event.seq, file: nativeFileAttachment.parse(part.attachment) })
    }
  }
  return found
}
function sameFile(left: FileAttachmentRef, right: FileAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId && left.name === right.name && left.bytes === right.bytes
}
/** Require a reference to belong to the exact same-user inherited ancestor prefix.
 * @param history Receiving current history.
 * @param origin Explicit original storage Session identity.
 * @param seq Referenced current event position.
 * @param histories Complete validated parent inventory.
 * @returns Whether this origin owns the event through every inherited cut.
 */
export function legacyHistoryAncestorOrigin(history: LegacyMigratedHistory, origin: string, seq: number,
  histories: readonly LegacyMigratedHistory[]): boolean {
  let child = history
  const visited = new Set<string>()
  while (child.sessionId !== origin) {
    if (visited.has(child.sessionId) || seq >= child.inheritedEventCount || child.header.parentSession === undefined) return false
    visited.add(child.sessionId)
    const parent = histories.find(item => item.sessionId === child.header.parentSession)
    if (!parent || parent.userId !== history.userId) return false
    child = parent
  }
  return true
}

/** Resolve complete exact history bindings without consulting or inferring owners from file paths.
 * @param migrationId Stable maintenance identity for newly minted receipt/request UUIDs.
 * @param histories Validated complete current histories and original-coordinate ledgers.
 * @param declarations Exact source-owned object assignments from the stopped file cut.
 * @returns New migration receipts with original source fields and every referencing event sequence.
 */
export function planLegacyHistoryFiles(migrationId: string, histories: readonly LegacyMigratedHistory[],
  declarations: readonly LegacyMigrationFileSource[]): readonly LegacyMigrationFileReceipt[] {
  z.uuid().parse(migrationId)
  const sources = declarations.map(input => legacyMigrationFileSource.parse(input))
  const used = new Set<LegacyMigrationFileSource>()
  const receipts: LegacyMigrationFileReceipt[] = []
  for (const history of histories) {
    const files = messageFiles(history)
    const grouped = new Map<string, {
      file: FileAttachmentRef
      seqs: number[]
      source: LegacyMigrationFileSource
      rows: string[]
    }>()
    for (const reference of files) {
      const matching = sources.filter((source) => {
        if (source.userId !== history.userId || !sameFile(source.file, reference.file)
          || !legacyHistoryAncestorOrigin(history, source.originSessionId, reference.seq, histories)) return false
        const origin = histories.find(item => item.sessionId === source.originSessionId)
        const row = origin?.sourceRows.indexOf(source.sourceRowSha256) ?? -1
        return origin !== undefined && row >= 0 && legacyHistoryTargetSequences(origin, row).includes(reference.seq)
          && messageFiles(origin).some(item => item.seq === reference.seq && sameFile(item.file, source.file))
      })
      if (matching.length !== 1 || !matching[0]) throw new LegacyImportError('history_file_source_unqualified')
      const source = matching[0]
      used.add(source)
      const key = JSON.stringify([source.originSessionId, source.file])
      const previous = grouped.get(key)
      if (previous) {
        if (previous.source.rootId !== source.rootId) throw new LegacyImportError('history_file_root_conflict')
        previous.seqs.push(reference.seq)
        if (!previous.rows.includes(source.sourceRowSha256)) previous.rows.push(source.sourceRowSha256)
      } else grouped.set(key, { file: source.file, seqs: [reference.seq], source, rows: [source.sourceRowSha256] })
    }
    for (const value of grouped.values()) {
      const ids = [migrationId, history.userId, history.sessionId, value.source.originSessionId,
        String(value.file.attachmentId), value.file.name]
      receipts.push(Object.freeze({ id: stableUuid('legacy-migration-v2-file-receipt', ids), userId: history.userId,
        sessionId: history.sessionId, storageSessionId: value.source.originSessionId,
        bindingRequestId: stableUuid('legacy-migration-v2-history-binding', ids), file: value.file,
        sourceRootId: value.source.rootId, sourceRowSha256: value.source.sourceRowSha256,
        sourceRowSha256s: Object.freeze(value.rows),
        sourceObjectSha256: String(value.file.attachmentId).slice('sha256:'.length),
        referencedEventSeqs: Object.freeze(value.seqs), authority: 'verified-history-migration' }))
    }
  }
  if (used.size !== sources.length) throw new LegacyImportError('history_file_inventory_unused')
  return Object.freeze(receipts)
}

async function checkedSource(root: string, ref: FileAttachmentRef, destination: string): Promise<string> {
  if (!isAbsolute(root) || !isAbsolute(destination) || ref.name !== fileLeafName(ref.name)) throw new LegacyImportError('history_file_root')
  const source = await realpath(resolve(root)), target = resolve(destination)
  const inside = (parent: string, child: string) => {
    const suffix = relative(parent, child)
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
  }
  if (inside(source, target) || inside(target, source) || (await lstat(root)).isSymbolicLink()) {
    throw new LegacyImportError('history_file_root_overlap')
  }
  const path = storedFilePath(source, ref)
  let directory = dirname(path)
  for (;;) {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LegacyImportError('history_file_symlink')
    if (directory === source) break
    const parent = dirname(directory)
    if (parent === directory || !inside(source, parent)) throw new LegacyImportError('history_file_escape')
    directory = parent
  }
  return path
}

/** Stream verified original bytes into the maintained target object/alias layout before receipt insertion.
 * @param receipts Complete source-backed migration bindings, including inherited fork references.
 * @param sourceRoots Explicit root IDs from protected source storage assignments.
 * @param targetRoot New private target attachment root whose lifecycle belongs to the caller.
 * @param limits Explicit aggregate object/file budgets.
 * @param signal Maintenance cancellation; partially copied candidates remain unpublished.
 * @returns Original alias digests copied once per owner/origin/file identity; shared immutable bytes count once per stored object.
 */
export async function stageLegacyHistoryFiles(receipts: readonly LegacyMigrationFileReceipt[],
  sourceRoots: Readonly<Record<string, string>>, targetRoot: string, limits: LegacyImportLimits,
  signal: AbortSignal): Promise<readonly string[]> {
  const copied = new Set<string>(), countedObjects = new Set<string>(), digests: string[] = []
  let total = 0
  for (const receipt of receipts) {
    signal.throwIfAborted()
    const key = JSON.stringify([receipt.userId, receipt.storageSessionId, receipt.file])
    const objectKey = JSON.stringify([receipt.userId, receipt.storageSessionId, receipt.file.attachmentId])
    const additionalBytes = countedObjects.has(objectKey) ? 0 : receipt.file.bytes
    if (copied.has(key)) continue
    if (copied.size >= limits.maxFiles || receipt.file.bytes > limits.maxFileBytes
      || total + additionalBytes > limits.maxStorageBytes) throw new LegacyImportError('history_file_budget')
    const root = sourceRoots[receipt.sourceRootId]
    if (!root) throw new LegacyImportError('history_file_root_missing')
    const target = join(targetRoot, receipt.userId, receipt.storageSessionId)
    const path = await checkedSource(root, receipt.file, target)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size !== BigInt(receipt.file.bytes)) throw new LegacyImportError('history_file_size')
      const hash = createHash('sha256')
      let count = 0
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        for (;;) {
          signal.throwIfAborted()
          const buffer = Buffer.alloc(65536)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, count)
          if (!bytesRead) break
          const bytes = buffer.subarray(0, bytesRead)
          count += bytes.byteLength
          if (count > receipt.file.bytes) throw new LegacyImportError('history_file_changed')
          hash.update(bytes)
          yield bytes
        }
        if (count !== receipt.file.bytes || hash.digest('hex') !== receipt.sourceObjectSha256) {
          throw new LegacyImportError('history_file_digest')
        }
      }
      const copiedFile = await saveFileStreamVerbatim(target, { data: chunks(), name: receipt.file.name, signal })
      const after = await handle.stat({ bigint: true }), linked = await lstat(path, { bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || linked.dev !== before.dev || linked.ino !== before.ino || !sameFile(copiedFile, receipt.file)) {
        throw new LegacyImportError('history_file_changed')
      }
      await checkedSource(root, receipt.file, target)
      digests.push(legacyDigest(JSON.stringify([receipt.userId, receipt.storageSessionId, receipt.file])))
      copied.add(key); countedObjects.add(objectKey); total += additionalBytes
    } finally { await handle.close() }
  }
  return Object.freeze(digests)
}
