/** Current-grant image reads from protected migration permissions; neither caller metadata nor a storage path grants access. */
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { PlatformError } from '../contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'
import { readLegacyOriginalImage } from './legacy-migration-v2-images.ts'
import { legacyMigrationImage, legacyMigrationImageLedger,
  type LegacyMigrationImageReadLimits } from './legacy-migration-v2-media-contracts.ts'

/** Parse exact image metadata and enforce its original byte and pixel limits.
 * @param ref Original image reference from the receiving Session.
 * @param limits Reader-owned image and pixel budgets.
 * @param errorCode Reader-specific image-budget refusal.
 * @returns Parsed image metadata without changing any normalized bytes.
 */
export function readImageWithinLimits(ref: ImageAttachmentRef, limits: LegacyMigrationImageReadLimits,
  errorCode: 'legacy_image_limit' | 'native_image_limit'): ImageAttachmentRef {
  const image = legacyMigrationImage.parse(ref)
  if (image.bytes > limits.maxImageBytes || BigInt(image.width) * BigInt(image.height) > BigInt(limits.maxImagePixels)) {
    throw new PlatformError(413, errorCode)
  }
  return image
}

/** Lease-fenced image consumer under Platform's existing original attachment root, including retained offloaded occurrences. */
export class LegacyMigrationImageReader {
  constructor(private readonly pool: Pool, private readonly tasks: TaskStore,
    private readonly limits: LegacyMigrationImageReadLimits) {
    if (!isAbsolute(limits.root) || [limits.maxImageBytes, limits.maxImagePixels, limits.maxLedgerBytes]
      .some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid migration image read limits')
  }

  /** Read unchanged normalized bytes only while this exact current operation remains authorized.
   * @param token Current Platform-issued operation grant.
   * @param ref Exact original image reference from the owned Session history.
   * @param signal Caller cancellation and transport lifetime.
   * @returns Maintained SDK-verified original image bytes and metadata.
   */
  async read(token: string, ref: ImageAttachmentRef, signal: AbortSignal): Promise<StoredImageAttachment> {
    const image = readImageWithinLimits(ref, this.limits, 'legacy_image_limit')
    return transaction(this.pool, async (client) => {
      signal.throwIfAborted()
      const grant = await this.tasks.authorized(client, token)
      const bytes = await this.readOwnedInTransaction(client, grant.user_id, grant.id,
        headerSchema.parse(grant.header), image, signal)
      signal.throwIfAborted()
      const current = await this.tasks.authorized(client, token)
      if (current.id !== grant.id || current.user_id !== grant.user_id || current.lease_epoch !== grant.lease_epoch
        || current.operation_id !== grant.operation_id) {
        throw new PlatformError(409, 'lease_lost')
      }
      return bytes
    })
  }

  /** Reuse the immutable migration permission proof within an already authorized receiving Session transaction.
   * @param client Caller transaction holding actual account and receiving Session authority.
   * @param userId Authenticated receiving Session owner, never an image-path owner supplied by a browser.
   * @param sessionId Receiving Session proven by current grant or owned canonical browser history.
   * @param header Exact server-owned receiving Session header.
   * @param ref Exact canonical image metadata; permission and every migration occurrence must still match.
   * @param signal Caller cancellation and transport lifetime.
   * @returns Unchanged SDK-verified original bytes after the same protected migration proof.
   */
  async readOwnedInTransaction(client: PoolClient, userId: string, sessionId: string, header: SessionHeader,
    ref: ImageAttachmentRef, signal: AbortSignal): Promise<StoredImageAttachment> {
    signal.throwIfAborted()
    const image = readImageWithinLimits(ref, this.limits, 'legacy_image_limit')
    const receiving = await client.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE', [sessionId, userId])
    if (!receiving.rows[0] || !isDeepStrictEqual(headerSchema.parse(receiving.rows[0].header), header)) {
      throw new PlatformError(503, 'legacy_image_origin_missing')
    }
    const found = await client.query<{ value: unknown; bytes: string }>(
      `SELECT CASE WHEN octet_length(value::text)<=$3 THEN value END AS value,octet_length(value::text)::text AS bytes
       FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2 FOR SHARE`,
      [userId, `legacy-migration-v2-images:${sessionId}`, this.limits.maxLedgerBytes])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'legacy_image_not_found')
    if (BigInt(row.bytes) > BigInt(this.limits.maxLedgerBytes)) throw new PlatformError(413, 'legacy_image_ledger_limit')
    const ledger = legacyMigrationImageLedger.parse(row.value)
    if (ledger.userId !== userId || ledger.sessionId !== sessionId) throw new PlatformError(503, 'legacy_image_ledger_invalid')
    const matching = ledger.bindings.filter(binding => binding.userId === userId && binding.sessionId === sessionId
      && isDeepStrictEqual(binding.image, image))
    if (matching.length !== 1 || !matching[0]) throw new PlatformError(404, 'legacy_image_not_found')
    const binding = matching[0]
    const original = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',
      [binding.storageSessionId, userId])
    if (!original.rowCount) throw new PlatformError(503, 'legacy_image_origin_missing')
    const seqs = [...new Set(binding.occurrences.map(occurrence => occurrence.seq))]
    const events = await client.query<{ event: unknown; bytes: string }>(
      'SELECT CASE WHEN octet_length(event::text)<=$3 THEN event END AS event,octet_length(event::text)::text AS bytes FROM pe_events WHERE session_id=$1 AND seq=ANY($2::bigint[]) ORDER BY seq',
      [sessionId, seqs, this.limits.maxLedgerBytes])
    if (events.rows.some(event => BigInt(event.bytes) > BigInt(this.limits.maxLedgerBytes))) throw new PlatformError(413, 'legacy_image_event_limit')
    const decoded = parseEvents(header, events.rows.map(event => event.event))
    if (decoded.length !== seqs.length || binding.occurrences.some((occurrence) => {
      const event = decoded.find(item => item.seq === occurrence.seq)
      if (!event) return true
      const images = deriveEventMessage(event)?.content.filter(block => block.type === 'image') ?? []
      const block = images[occurrence.imageIndex]
      return !block || !isDeepStrictEqual(legacyMigrationImage.parse(block.attachment), image)
    })) throw new PlatformError(503, 'legacy_image_reference_changed')
    const bytes = await readLegacyOriginalImage(join(this.limits.root, userId, binding.storageSessionId), image,
      join(this.limits.root, 'request-cache'), { maxFileBytes: this.limits.maxImageBytes,
        maxStorageBytes: this.limits.maxImageBytes }, signal)
    signal.throwIfAborted()
    return bytes
  }
}

/** Copy only image permissions whose exact event occurrences lie inside an already validated native fork prefix.
 * @param client Existing browser-authorized native fork transaction.
 * @param userId Account owner shared by parent and child.
 * @param parentSessionId Parent whose row and full native history the caller has checked.
 * @param childSessionId New current Session owned by the same account.
 * @param inheritedEventCount Exact inherited event prefix, excluding the child's own seed marker.
 * @param maxLedgerBytes Deployment-configured bound, never an unbounded permission read.
 * @returns Completion after a new child ledger is inserted, or when the parent has no image bindings.
 */
export async function inheritLegacyImageBindings(client: PoolClient, userId: string, parentSessionId: string,
  childSessionId: string, inheritedEventCount: number, maxLedgerBytes: number): Promise<void> {
  if (![inheritedEventCount, maxLedgerBytes].every(value => Number.isSafeInteger(value) && value >= 0) || maxLedgerBytes < 1) {
    throw new PlatformError(503, 'legacy_image_fork_configuration')
  }
  const found = await client.query<{ value: unknown; bytes: string }>(
    'SELECT CASE WHEN octet_length(value::text)<=$3 THEN value END AS value,octet_length(value::text)::text AS bytes FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
    [userId, `legacy-migration-v2-images:${parentSessionId}`, maxLedgerBytes])
  const row = found.rows[0]
  if (!row) return
  if (BigInt(row.bytes) > BigInt(maxLedgerBytes)) throw new PlatformError(413, 'legacy_image_ledger_limit')
  const parent = legacyMigrationImageLedger.parse(row.value)
  if (parent.userId !== userId || parent.sessionId !== parentSessionId) throw new PlatformError(503, 'legacy_image_ledger_invalid')
  const bindings = parent.bindings.flatMap((binding) => {
    if (binding.userId !== userId || binding.sessionId !== parentSessionId) throw new PlatformError(503, 'legacy_image_ledger_invalid')
    const occurrences = binding.occurrences.filter(occurrence => occurrence.seq < inheritedEventCount)
    return occurrences.length ? [{ ...binding, sessionId: childSessionId, occurrences }] : []
  })
  if (!bindings.length) return
  const ledger = legacyMigrationImageLedger.parse({ version: 1, userId, sessionId: childSessionId, bindings })
  if (Buffer.byteLength(JSON.stringify(ledger)) > maxLedgerBytes) throw new PlatformError(413, 'legacy_image_ledger_limit')
  await client.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3::jsonb,1)',
    [userId, `legacy-migration-v2-images:${childSessionId}`, JSON.stringify(ledger)])
}
