/** Private native image permissions bind accepted SDK metadata to its original owned prompt and storage. */
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { AdmittedPromptContentPart, AttachmentId, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { referencedSessionImage } from '@deepseek-ai/dsh-api-session-controller'
import { PlatformError } from '../contracts.ts'
import { admittedNativeContent } from '../native-attachment-contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import type { EventLimits } from './events.ts'
import { readImageWithinLimits, type LegacyMigrationImageReader } from './legacy-migration-v2-image-reader.ts'
import { legacyMigrationImage, type LegacyMigrationImageReadLimits } from './legacy-migration-v2-media-contracts.ts'
import { readLegacyOriginalImage } from './legacy-migration-v2-images.ts'
import type { TaskStore } from './tasks.ts'

const bindingSchema = z.object({ image: legacyMigrationImage, storageSessionId: z.uuid(), sourceRequestId: z.uuid(),
  acceptedContentDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const ledgerSchema = z.object({ version: z.literal(1), userId: z.uuid(), sessionId: z.uuid(),
  bindings: z.array(bindingSchema) }).strict()
type Binding = z.infer<typeof bindingSchema>
type Ledger = z.infer<typeof ledgerSchema>
type BrowserLimits = Pick<EventLimits, 'maxHistoryEvents' | 'maxHistoryBytes'>
type MigrationReader = Pick<LegacyMigrationImageReader, 'read'> & Partial<Pick<LegacyMigrationImageReader, 'readOwnedInTransaction'>>

interface BrowserSession { id: string; header: unknown; header_bytes: string; event_count: number; event_bytes: string }

function budget(maxLedgerBytes: number): void {
  if (!Number.isSafeInteger(maxLedgerBytes) || maxLedgerBytes < 1) throw new PlatformError(503, 'native_image_configuration')
}

async function readLedger(client: PoolClient, userId: string, sessionId: string, maxLedgerBytes: number,
  lock: 'share' | 'update'): Promise<Ledger | undefined> {
  budget(maxLedgerBytes)
  const result = await client.query<{ value: unknown; bytes: string }>(`SELECT
    CASE WHEN octet_length(value::text)<=$3 THEN value END AS value,octet_length(value::text)::text AS bytes
    FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2 FOR ${lock === 'update' ? 'UPDATE' : 'SHARE'}`,
  [userId, `native-images:${sessionId}`, maxLedgerBytes])
  const row = result.rows[0]
  if (!row) return undefined
  if (BigInt(row.bytes) > BigInt(maxLedgerBytes)) throw new PlatformError(413, 'native_image_ledger_limit')
  const parsed = ledgerSchema.safeParse(row.value)
  if (!parsed.success || parsed.data.userId !== userId || parsed.data.sessionId !== sessionId
    || nativeInputRecordDigest(row.value) !== nativeInputRecordDigest(parsed.data)) {
    throw new PlatformError(503, 'native_image_ledger_invalid')
  }
  return parsed.data
}

async function readSource(client: PoolClient, userId: string, storageSessionId: string, sourceRequestId: string,
  maxLedgerBytes: number) {
  const result = await client.query<{ admitted: unknown; bytes: string }>(`SELECT
    CASE WHEN octet_length(p.admitted::text)<=$4 THEN p.admitted END AS admitted,
    octet_length(p.admitted::text)::text AS bytes FROM pe_native_prompt_inputs p
    JOIN pe_sessions s ON s.id=p.session_id WHERE p.session_id=$1 AND p.request_id=$2 AND s.user_id=$3 FOR SHARE OF p,s`,
  [storageSessionId, sourceRequestId, userId, maxLedgerBytes])
  const row = result.rows[0]
  if (!row) throw new PlatformError(503, 'native_image_origin_missing')
  if (BigInt(row.bytes) > BigInt(maxLedgerBytes)) throw new PlatformError(413, 'native_image_content_limit')
  const parsed = admittedNativeContent.safeParse(row.admitted)
  if (!parsed.success || nativeInputRecordDigest(row.admitted) !== nativeInputRecordDigest(parsed.data)) {
    throw new PlatformError(503, 'native_image_origin_changed')
  }
  return { content: parsed.data, digest: nativeInputRecordDigest(row.admitted) }
}

async function proveBinding(client: PoolClient, userId: string, binding: Binding, maxLedgerBytes: number): Promise<void> {
  const source = await readSource(client, userId, binding.storageSessionId, binding.sourceRequestId, maxLedgerBytes)
  if (source.digest !== binding.acceptedContentDigest || !source.content.some(part =>
    part.type === 'image' && isDeepStrictEqual(part.attachment, binding.image))) {
    throw new PlatformError(503, 'native_image_origin_changed')
  }
}

async function writeLedger(client: PoolClient, ledger: Ledger, maxLedgerBytes: number): Promise<void> {
  const serialized = JSON.stringify(ledger)
  if (Buffer.byteLength(serialized) > maxLedgerBytes) throw new PlatformError(413, 'native_image_ledger_limit')
  await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3::jsonb,1)
    ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,
      revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`,
  [ledger.userId, `native-images:${ledger.sessionId}`, serialized])
  await readLedger(client, ledger.userId, ledger.sessionId, maxLedgerBytes, 'update')
}

async function ownedBrowserSession(client: PoolClient, userId: string, sessionId: SessionId,
  limits: BrowserLimits): Promise<BrowserSession> {
  const result = await client.query<BrowserSession>(`SELECT id,
    CASE WHEN octet_length(header::text)<=$3 THEN header END AS header,
    octet_length(header::text)::text AS header_bytes,event_count,event_bytes::text
    FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE`, [sessionId, userId, limits.maxHistoryBytes])
  const row = result.rows[0]
  if (!row) throw new PlatformError(404, 'session_not_found')
  if (row.event_count > limits.maxHistoryEvents || BigInt(row.event_bytes) > BigInt(limits.maxHistoryBytes)
    || BigInt(row.header_bytes) > BigInt(limits.maxHistoryBytes)) throw new PlatformError(413, 'native_image_history_limit')
  if (headerSchema.parse(row.header).id !== sessionId) throw new PlatformError(503, 'native_image_history_invalid')
  return row
}

async function referencedBrowserImage(client: PoolClient, row: BrowserSession, attachmentId: AttachmentId,
  limits: BrowserLimits): Promise<{ header: SessionHeader; image: ImageAttachmentRef }> {
  const size = await client.query<{ count: string; bytes: string }>(`SELECT count(*)::text AS count,
    COALESCE(sum(octet_length(event::text)),0)::text AS bytes FROM pe_events WHERE session_id=$1`, [row.id])
  const measured = size.rows[0]
  if (!measured || BigInt(measured.count) !== BigInt(row.event_count)) throw new PlatformError(503, 'native_image_history_gap')
  if (BigInt(measured.bytes) + BigInt(row.header_bytes) > BigInt(limits.maxHistoryBytes)) {
    throw new PlatformError(413, 'native_image_history_limit')
  }
  const result = await client.query<{ seq: string; event: unknown; bytes: string }>(`SELECT seq::text,event,
    octet_length(event::text)::text AS bytes FROM pe_events WHERE session_id=$1 ORDER BY pe_events.seq LIMIT $2`,
  [row.id, limits.maxHistoryEvents + 1])
  if (result.rows.length !== row.event_count || result.rows.some((event, index) => BigInt(event.seq) !== BigInt(index))) {
    throw new PlatformError(503, 'native_image_history_gap')
  }
  if (result.rows.reduce((total, event) => total + BigInt(event.bytes), BigInt(row.header_bytes))
    > BigInt(limits.maxHistoryBytes)) throw new PlatformError(413, 'native_image_history_limit')
  const header = headerSchema.parse(row.header)
  const events = parseEvents(header, result.rows.map(event => event.event))
  if (events.some((event, index) => event.seq !== index)
    || nativeInputRecordDigest(result.rows.map(event => event.event)) !== nativeInputRecordDigest(events)) {
    throw new PlatformError(503, 'native_image_history_invalid')
  }
  const ref = referencedSessionImage(events, attachmentId)
  if (!ref) throw new PlatformError(404, 'native_image_not_referenced')
  return { header, image: legacyMigrationImage.parse(ref) }
}

/** Save only SDK-admitted image permissions after the original prompt insert in the caller's acceptance transaction.
 * @param client Acceptance transaction retaining the authenticated account and receiving Session locks.
 * @param userId Authenticated owner of the receiving Session.
 * @param sessionId Original receiving Session and physical storage identity.
 * @param requestId Original accepted prompt request, already inserted in pe_native_prompt_inputs.
 * @param admitted Complete ordered SDK-admitted content, with no encoded image bytes or caller storage reference.
 * @param maxLedgerBytes Explicit bound for permission and complete source-content reads and writes.
 */
export async function saveNativeImageBindings(client: PoolClient, userId: string, sessionId: string, requestId: string,
  admitted: readonly AdmittedPromptContentPart[], maxLedgerBytes: number): Promise<void> {
  budget(maxLedgerBytes)
  const images = admitted.flatMap(part => part.type === 'image' ? [legacyMigrationImage.parse(part.attachment)] : [])
  if (!images.length) return
  const source = await readSource(client, userId, sessionId, requestId, maxLedgerBytes)
  if (nativeInputRecordDigest(admitted) !== source.digest) throw new PlatformError(503, 'native_image_origin_changed')
  const previous = await readLedger(client, userId, sessionId, maxLedgerBytes, 'update')
  const bindings = [...previous?.bindings ?? []]
  for (const image of images) {
    const binding = bindingSchema.parse({ image, storageSessionId: sessionId, sourceRequestId: requestId,
      acceptedContentDigest: source.digest })
    if (!bindings.some(existing => isDeepStrictEqual(existing, binding))) bindings.push(binding)
  }
  await writeLedger(client, ledgerSchema.parse({ version: 1, userId, sessionId, bindings }), maxLedgerBytes)
}

/** Inherit only exact native image references contained in an already validated, owned fork prefix.
 * @param client Fork transaction retaining the authenticated account and original Session locks.
 * @param userId Shared authenticated parent and child owner.
 * @param parentSessionId Owned parent whose complete native prefix was verified by the caller.
 * @param childSessionId New owned child receiving only the selected parent permissions.
 * @param seedEvents Exact validated inherited events, excluding later parent messages.
 * @param maxLedgerBytes Explicit bound for permission and complete original prompt proofs.
 */
export async function inheritNativeImageBindings(client: PoolClient, userId: string, parentSessionId: string,
  childSessionId: string, seedEvents: readonly SessionEvent[], maxLedgerBytes: number): Promise<void> {
  const parent = await readLedger(client, userId, parentSessionId, maxLedgerBytes, 'share')
  if (!parent) return
  const bindings = parent.bindings.filter(binding => referencedSessionImage(seedEvents, binding.image.attachmentId,
    ref => isDeepStrictEqual(legacyMigrationImage.parse(ref), binding.image)) !== undefined)
  if (!bindings.length) return
  for (const binding of bindings) await proveBinding(client, userId, binding, maxLedgerBytes)
  const existing = await readLedger(client, userId, childSessionId, maxLedgerBytes, 'update')
  const ledger = ledgerSchema.parse({ version: 1, userId, sessionId: childSessionId, bindings })
  if (existing) {
    if (!isDeepStrictEqual(existing, ledger)) throw new PlatformError(409, 'native_image_fork_conflict')
    return
  }
  const child = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE', [childSessionId, userId])
  if (!child.rowCount) throw new PlatformError(503, 'native_image_origin_missing')
  await writeLedger(client, ledger, maxLedgerBytes)
}

/** Read exact native image bytes under the current operation, preserving independent migration permissions as fallback. */
export class NativeImageReader {
  /**
   * @param pool Platform-owned PG connection pool.
   * @param tasks Actual current operation and account authority.
   * @param limits Absolute original storage root and explicit read, pixel and private ledger budgets.
   * @param legacyReader Existing migration reader retaining its separate unchanged authorization.
   * @param browserLimits Explicit complete canonical history bounds, required when browser preview is enabled.
   */
  constructor(private readonly pool: Pool, private readonly tasks: TaskStore, private readonly limits: LegacyMigrationImageReadLimits,
    private readonly legacyReader?: MigrationReader, private readonly browserLimits?: BrowserLimits) {
    if (!isAbsolute(limits.root) || [limits.maxImageBytes, limits.maxImagePixels, limits.maxLedgerBytes]
      .some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid native image read limits')
    if (browserLimits && [browserLimits.maxHistoryEvents, browserLimits.maxHistoryBytes]
      .some(value => !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER)) {
      throw new Error('Invalid native image browser limits')
    }
  }

  /** Return unchanged SDK-verified original bytes only while the exact current operation remains authorized.
   * @param token Actual Platform-issued current operation bearer.
   * @param ref Exact original admitted or inherited image metadata, without a caller storage path.
   * @param signal Caller cancellation and transport lifetime.
   * @returns Original image bytes and metadata after complete prompt and final current-operation proof.
   */
  async read(token: string, ref: ImageAttachmentRef, signal: AbortSignal): Promise<StoredImageAttachment> {
    const image = readImageWithinLimits(ref, this.limits, 'native_image_limit')
    try {
      return await transaction(this.pool, async (client) => {
        signal.throwIfAborted()
        const grant = await this.tasks.authorized(client, token)
        const stored = await this.readBoundImage(client, grant.user_id, grant.id, image, signal)
        signal.throwIfAborted()
        const current = await this.tasks.authorized(client, token)
        if (current.id !== grant.id || current.user_id !== grant.user_id || current.lease_epoch !== grant.lease_epoch
          || current.operation_id !== grant.operation_id) throw new PlatformError(409, 'lease_lost')
        signal.throwIfAborted()
        return stored
      })
    } catch (error) {
      if (error instanceof PlatformError && error.status === 404 && error.code === 'native_image_not_found' && this.legacyReader) {
        return this.legacyReader.read(token, image, signal)
      }
      throw error
    }
  }

  /** Preview an exact image referenced by owned canonical history with a current browser credential and no operation grant.
   * @param credential Actual Platform browser credential, rechecked before and after the original image read.
   * @param sessionId Owned receiving Session whose complete ordered history is read under explicit limits.
   * @param attachmentId Official image identity; exact metadata must come from the server's canonical history.
   * @param signal Caller cancellation and transport lifetime, checked after final browser authorization.
   * @returns Unchanged SDK original bytes proven by native admission or existing immutable migration permissions.
   */
  async readBrowser(credential: string, sessionId: SessionId, attachmentId: AttachmentId,
    signal: AbortSignal): Promise<StoredImageAttachment> {
    const limits = this.browserLimits
    if (!limits) throw new PlatformError(503, 'native_image_browser_configuration')
    return transaction(this.pool, async (client) => {
      signal.throwIfAborted()
      const actor = await requireBrowserAccount(client, credential)
      const row = await ownedBrowserSession(client, actor.userId, sessionId, limits)
      const { header, image } = await referencedBrowserImage(client, row, attachmentId, limits)
      if (image.bytes > this.limits.maxImageBytes || BigInt(image.width) * BigInt(image.height) > BigInt(this.limits.maxImagePixels)) {
        throw new PlatformError(413, 'native_image_limit')
      }
      let stored: StoredImageAttachment
      try {
        stored = await this.readBoundImage(client, actor.userId, sessionId, image, signal)
      } catch (error) {
        if (!(error instanceof PlatformError) || error.status !== 404 || error.code !== 'native_image_not_found'
          || !this.legacyReader?.readOwnedInTransaction) throw error
        stored = await this.legacyReader.readOwnedInTransaction(client, actor.userId, sessionId, header, image, signal)
      }
      signal.throwIfAborted()
      await ownedBrowserSession(client, actor.userId, sessionId, limits)
      const current = await requireBrowserAccount(client, credential)
      if (current.userId !== actor.userId) throw new PlatformError(401, 'unauthorized')
      signal.throwIfAborted()
      return stored
    })
  }

  private async readBoundImage(client: PoolClient, userId: string, sessionId: string, image: ImageAttachmentRef,
    signal: AbortSignal): Promise<StoredImageAttachment> {
    signal.throwIfAborted()
    const ledger = await readLedger(client, userId, sessionId, this.limits.maxLedgerBytes, 'share')
    const bindings = ledger?.bindings.filter(binding => isDeepStrictEqual(binding.image, image)) ?? []
    if (!bindings.length) throw new PlatformError(404, 'native_image_not_found')
    for (const binding of bindings) await proveBinding(client, userId, binding, this.limits.maxLedgerBytes)
    const first = bindings[0]
    if (!first) throw new PlatformError(404, 'native_image_not_found')
    return readLegacyOriginalImage(join(this.limits.root, userId, first.storageSessionId), image,
      join(this.limits.root, 'request-cache'), { maxFileBytes: this.limits.maxImageBytes,
        maxStorageBytes: this.limits.maxImageBytes }, signal)
  }
}
