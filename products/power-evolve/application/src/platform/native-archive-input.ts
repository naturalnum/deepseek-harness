/** Atomic archival sibling removals with immutable replay and an unchanged live source frame. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { PlatformError, userId } from '../contracts.ts'
import { nativeArchiveInputCancelCommit, nativeArchiveInputCancelReceipt, nativeArchiveInputCancelIntentDigest,
  type NativeArchiveInputCancelCommit, type NativeArchiveInputCancelReceipt } from '../native-archive-input-contracts.ts'
import type { NativePreparedCancelCommit } from '../native-prepared-cancel-contracts.ts'
import { inputCommandReceipt, nativeInputStorageAuthority,
  type InputCommandReceipt, type NativeInputStorageAuthority, type NativeInputVerifiedFrame } from '../native-input-ledger-contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { parseNativeAssistantBatch, readNativeAssistantState, validateNativeAssistantLimits } from '../native-assistant-records.ts'
import type { NativeSessionStopIntent } from '../native-session-stop-contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { requireActiveAccount } from './account-authority.ts'
import { assertNativeRetainedBarrier, nativeRetainedTransaction,
  type NativeRetainedTransaction } from './native-retained-intent-transaction.ts'
import { digest } from './identity.ts'
import { validateNativeRetainedEvents } from './native-retained-intent-validation.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'
import type { NativeAssistantStore, NativeAssistantReceipt } from './native-assistant-store.ts'
import type { NativeExecutionFrames } from './native-execution-frames.ts'
import type { NativeInputCommitConfig } from './native-input-commit.ts'
import type { NativeInputLedger } from './native-input-ledger.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { TaskStore } from './tasks.ts'

const presentationRow = z.object({ epoch: z.number().int().positive(), publisherId: z.uuid(),
  lastOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), state: z.string(),
  lastBatchId: z.uuid().nullable(), deadline: z.string() }).strict()
const inputLimitKeys = ['maxAcceptedAuditBytes', 'maxRevisionBytes', 'maxCohortInputs', 'maxHistoryEvents',
  'maxHistoryBytes', 'maxCommandBytes', 'maxEventBytes'] as const
function refuse(code: string): never { throw new PlatformError(409, code) }

type CancellationRequest = NativeArchiveInputCancelCommit | NativePreparedCancelCommit
type CancellationReplay = {
  owner: z.infer<typeof userId>
  prior: InputCommandReceipt | null
}

/** Validate cancellation budgets without supplying defaults.
 * @param config Explicit input and publication limits.
 * @param message Purpose-specific configuration error.
 * @returns Copied input limits and validated publication limits.
 */
export function validateCancellationLimits(config: NativeInputCommitConfig, message: string): NativeInputCommitConfig {
  if (inputLimitKeys.some(key => !Number.isSafeInteger(config.input[key]) || config.input[key] < 1)
    || config.input.maxHistoryEvents > 2_147_483_646) throw new Error(message)
  return { input: { ...config.input }, presentation: validateNativeAssistantLimits(config.presentation) }
}

/** Enforce the original request and acknowledgement JSON byte budget.
 * @param value Complete request or acknowledgement.
 * @param maxBytes Configured command byte limit.
 */
export function assertCancellationBytes(value: unknown, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new PlatformError(413, 'native_input_command_budget')
}

/** Parse a purpose-specific request before retained sealing or transaction entry.
 * @param schema Strict cancellation request parser.
 * @param input Complete original request.
 * @param limits Explicit input and publication budgets.
 * @param header Owned Session header for optional canonical suffix validation.
 * @returns Strict request within the original byte and event budgets.
 */
export function validateCancellationRequest<T extends CancellationRequest>(schema: z.ZodType<T>, input: unknown,
  limits: NativeInputCommitConfig, header?: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new PlatformError(400, 'invalid_request')
  assertCancellationBytes(parsed.data, limits.input.maxCommandBytes)
  if (header !== undefined) validateNativeRetainedEvents(header, parsed.data.events, parsed.data.expectedEventCount,
    limits.input, limits.presentation.maxBatchItems)
  return parsed.data
}

/** Authenticate and lock the owned Session before checking a bounded immutable replay.
 * @param client Caller-owned transaction retaining account and Session locks.
 * @param ledger Immutable command receipt provider.
 * @param request Original Writer, Session and nonce scope.
 * @param intent Digest of the original bearer and complete request.
 * @param maxBytes Configured stored receipt byte limit.
 * @returns Active owner and original matching receipt, or null when no receipt exists.
 */
async function readCancellationReplay(client: PoolClient, ledger: NativeInputLedger,
  request: CancellationRequest, intent: string, maxBytes: number): Promise<CancellationReplay> {
  const hint = await client.query<{ user_id: string }>('SELECT user_id FROM pe_sessions WHERE id=$1', [request.frame.sessionId])
  if (!hint.rows[0]) refuse('native_input_scope_conflict')
  const owner = userId.parse(hint.rows[0].user_id)
  await requireActiveAccount(client, owner, 'update')
  const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [request.frame.sessionId, owner])
  if (owned.rowCount !== 1) refuse('native_input_scope_conflict')
  const actor: Extract<InputCommandReceipt['actor'], { kind: 'writer' }> = {
    kind: 'writer', userId: owner, workerId: request.writer.workerId, writerEpoch: request.writer.epoch,
  }
  const found = await client.query<{ bytes: string }>(`SELECT octet_length(receipt_json::text)::text AS bytes
      FROM pe_native_input_commands WHERE session_id=$1 AND actor_kind='writer' AND actor_id=$2
      AND writer_epoch=$3 AND transport_nonce=$4`,
  [request.frame.sessionId, request.writer.workerId, request.writer.epoch, request.command.rpcNonce])
  if (found.rows[0] && BigInt(found.rows[0].bytes) > BigInt(maxBytes)) {
    throw new PlatformError(413, 'native_input_command_budget')
  }
  const prior = await ledger.replayInTransaction(client, request.frame.sessionId, actor, request.command.rpcNonce, intent)
  return { owner, prior }
}

/** Return an authenticated immutable replay or enter the purpose-specific cancellation under the same locks.
 * @param tasks Platform pool owning the transaction.
 * @param ledger Immutable command receipt provider.
 * @param request Complete original request with its Writer and nonce.
 * @param intent Original bearer and full request digest.
 * @param maxBytes Original stored receipt byte limit.
 * @param context Retained journal transaction receiving the replay acknowledgement before return.
 * @param response Purpose-specific replay validation and response parser.
 * @param commit First-commit procedure after the retained-intent barrier, retaining all acquired locks.
 * @returns Original replay acknowledgement or the atomic first-commit acknowledgement.
 */
export function runCancellationTransaction<R>(tasks: TaskStore, ledger: NativeInputLedger, request: CancellationRequest,
  intent: string, maxBytes: number, context: NativeRetainedTransaction<R> | undefined,
  response: (receipt: InputCommandReceipt) => R, commit: (client: PoolClient, owner: z.infer<typeof userId>) => Promise<R>): Promise<R> {
  return nativeRetainedTransaction(tasks.pool, context, async (client) => {
    const { owner, prior } = await readCancellationReplay(client, ledger, request, intent, maxBytes)
    if (prior) {
      const receipt = response(prior)
      await context?.acknowledge(receipt)
      return receipt
    }
    await assertNativeRetainedBarrier(client, request.frame.sessionId, context !== undefined)
    return commit(client, owner)
  })
}

/** Lock the running cancel-requested operation and its current open attempt.
 * @param client Caller-owned transaction holding the owned Session lock.
 * @param session Already authorized current operation and Session.
 * @param operationDigest Original operation bearer digest.
 * @param workerId Original Writer worker.
 * @param conflict Purpose-specific failure code.
 * @returns Original live source deadline for the final joint clock check.
 */
export async function requireCancellationSource(client: PoolClient, session: Awaited<ReturnType<TaskStore['authorized']>>,
  operationDigest: string, workerId: CancellationRequest['writer']['workerId'], conflict: string): Promise<string> {
  const source = await client.query<{ deadline: string }>(`SELECT s.lease_until::text AS deadline
        FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id AND o.id=$2
        JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3
        WHERE s.id=$1 AND s.grant_digest=$4 AND s.lease_epoch=$3 AND s.lease_until>clock_timestamp()
        AND o.state='running' AND o.error_code='cancel_requested' AND a.worker_id=$5 AND a.ended_at IS NULL
        FOR UPDATE OF o,a`, [session.id, session.operation_id, session.lease_epoch, operationDigest, workerId])
  const sourceDeadline = source.rows[0]?.deadline
  if (source.rowCount !== 1 || sourceDeadline === undefined) refuse(conflict)
  return sourceDeadline
}

/** Validate the exact canonical event suffix before staging a removal.
 * @param header Authorized Session header.
 * @param request Original event suffix and expected prefix count.
 * @param limits Input event and history budgets.
 * @returns Parsed events with unchanged digest, contiguous sequence and bounded bytes.
 */
export function parseCancellationEvents(header: unknown, request: CancellationRequest,
  limits: NativeInputCommitConfig['input']): ReturnType<typeof parseEvents> {
  const events = parseEvents(headerSchema.parse(header), request.events)
  if (nativeInputRecordDigest(request.events) !== nativeInputRecordDigest(events)
    || events.some((event, index) => event.seq !== request.expectedEventCount + index)
    || events.some(event => Buffer.byteLength(JSON.stringify(event)) > limits.maxEventBytes)
    || request.expectedEventCount + events.length > limits.maxHistoryEvents) refuse('native_input_batch_conflict')
  return events
}

/** Publish a staged removal while its source remains running and check the exact acknowledgement counters.
 * @param client Caller-owned transaction after removal staging.
 * @param publisher Actual ordered publication provider.
 * @param operationToken Original source bearer.
 * @param request Original publication identity and ordinal.
 * @param events Validated canonical suffix.
 * @param eventCount Staged removal event count.
 * @param limits Explicit publication budgets.
 * @returns Actual publisher acknowledgement matching the staged suffix and original identity.
 */
export async function publishCancellation(client: PoolClient, publisher: NativeAssistantStore, operationToken: string,
  request: CancellationRequest, events: ReturnType<typeof parseEvents>, eventCount: number,
  limits: NativeInputCommitConfig['presentation']): Promise<NativeAssistantReceipt> {
  const wire = parseNativeAssistantBatch({ version: 1, ...request.presentation,
    items: events.map(event => ({ type: 'event', event })) }, limits)
  const presentation = await publisher.commitInputInTransaction(client, operationToken, request.expectedEventCount, wire)
  if (presentation.eventCount !== eventCount || presentation.epoch !== request.presentation.epoch
    || presentation.publisherId !== request.presentation.publisherId
    || presentation.lastOrdinal !== request.presentation.firstOrdinal) refuse('native_input_publication_conflict')
  return presentation
}

/** Lock the live publication and match its original sealed prefix before staging a removal.
 * @param client Caller-owned transaction after source authorization.
 * @param request Original seal, publication batch and event prefix.
 * @param limits Explicit publication budgets.
 * @param epoch Purpose-specific expected source or publication epoch.
 * @returns Exact live publication row and its original deadline.
 */
export async function readCancellationPresentation(client: PoolClient, request: CancellationRequest,
  limits: NativeInputCommitConfig['presentation'], epoch: number): Promise<z.infer<typeof presentationRow>> {
  const rows = await client.query<Record<string, unknown>>(`SELECT epoch,publisher_id AS "publisherId",
      last_ordinal::double precision AS "lastOrdinal",state_json AS state,last_batch_id AS "lastBatchId",
      expires_at::text AS deadline FROM pe_native_presentations
      WHERE session_id=$1 AND expires_at>clock_timestamp() FOR UPDATE`, [request.frame.sessionId])
  if (!rows.rows[0]) refuse('native_input_publication_missing')
  const row = presentationRow.parse(rows.rows[0]), state = readNativeAssistantState(row.state, limits)
  if (row.epoch !== epoch || state.epoch !== row.epoch || state.publisherId !== row.publisherId
    || row.publisherId !== request.seal.publisherId || state.lastOrdinal !== row.lastOrdinal
    || row.lastOrdinal !== request.seal.lastOrdinal || state.revision !== request.seal.revision
    || state.cursor !== request.expectedEventCount - 1 || row.lastBatchId === request.presentation.batchId) {
    refuse('native_input_publication_conflict')
  }
  return row
}

/** Cancel one pending queued sibling for an issued archive stop, preserving the current source for further batches. */
export class NativeArchiveInputCancel {
  private readonly limits: NativeInputCommitConfig

  /** Validate the strict original archival sibling request and byte budget before sealing.
   * @param input Complete original stop, frame, Writer and publication request.
   * @param header Actual owned Session header when validating the proposed native suffix.
   * @returns Bounded strict request without a native fact write or new execution authority.
   */
  validateRetainedRequest(input: unknown, header?: unknown): NativeArchiveInputCancelCommit {
    return validateCancellationRequest(nativeArchiveInputCancelCommit, input, this.limits, header)
  }

  /**
   * @param tasks Actual storage authorization and Platform PG pool.
   * @param ledger Actual origins, latest revisions, canonical append and immutable command receipt provider.
   * @param frames Actual current and historical consumed frame provider; original generations are never rewritten.
   * @param publisher Actual ordered publisher committing while the source remains running.
   * @param writers Actual independently acquired current Session Writer.
   * @param config Explicit existing input and publisher budgets, without added defaults.
   */
  constructor(private readonly tasks: TaskStore, private readonly ledger: NativeInputLedger,
    private readonly frames: NativeExecutionFrames, private readonly publisher: NativeAssistantStore,
    private readonly writers: NativeSessionWriter, config: NativeInputCommitConfig) {
    this.limits = validateCancellationLimits(config, 'Invalid archival input cancellation limits')
  }

  /** Commit one queued sibling removal for the exact currently requested archival stop.
   * First commit requires a running cancel-requested source, its current actual attempt and Writer, a closed
   * native turn/step and the real publisher seal. Current prepared ownership and permanent claims cannot be
   * removed here. Historical claimed frames use actual consumed proof under the new storage generation.
   * Canonical append, queued-origin failure, real publication and one immutable receipt commit together;
   * source, frame, attempts, accepted freezes and other siblings remain unchanged. The final query jointly
   * checks current stop identity, source/Writer/publisher clocks and the unique latest-revision removal.
   * Exact replay first authenticates the active account and owned Session plus the complete original intent.
   * It returns the original acknowledgement after source expiry or publisher eviction without issuing authority.
   * @param operationToken Original Platform-issued storage bearer, retained across uncertain replies.
   * @param input Complete retained stop, Writer, original frame, remove command, canonical splice and counters.
   * @param context Retained journal transaction; ACK write precedes the original joint clock proof.
   * @returns Original tokenless removed-input and real publisher acknowledgement for this archival stop.
   */
  async commit(operationToken: string, input: unknown,
    context?: NativeRetainedTransaction<NativeArchiveInputCancelReceipt>): Promise<NativeArchiveInputCancelReceipt> {
    const request = validateCancellationRequest(nativeArchiveInputCancelCommit, input, this.limits)
    const authority = nativeInputStorageAuthority.parse({ writer: request.writer, operationToken })
    const operationDigest = digest(operationToken), intent = nativeArchiveInputCancelIntentDigest(operationToken, request)
    return runCancellationTransaction(this.tasks, this.ledger, request, intent, this.limits.input.maxCommandBytes,
      context, receipt => this.response(receipt, request), async (client, owner) => {
        const stop = await readSessionStopInTransaction(client, owner, request.frame.sessionId)
        if (stop?.status !== 'requested' || stop.stopId !== request.stopId) refuse('native_input_archive_stop_conflict')
        const writer = await this.writers.requireInTransaction(client, request.writer)
        const session = await this.tasks.authorized(client, operationToken)
        if (writer.userId !== owner || session.user_id !== owner || session.id !== request.frame.sessionId
        || session.operation_id !== request.frame.operationId || session.lease_epoch !== request.presentation.epoch) {
          refuse('native_input_archive_conflict')
        }
        const sourceDeadline = await requireCancellationSource(client, session, operationDigest, request.writer.workerId,
          'native_input_archive_conflict')
        const frame = await this.frame(client, authority, request)
        const publication = await readCancellationPresentation(client, request, this.limits.presentation, request.presentation.epoch)
        const events = parseCancellationEvents(session.header, request, this.limits.input)
        const removed = await this.ledger.stageArchiveCancelInTransaction(client, authority, request.command,
          frame.verified, request.stopId, intent, { expectedEventCount: request.expectedEventCount, events },
          (client, origin, current, attempts) => this.frames.assertArchivePendingPreparedInTransaction(client, origin, current, attempts))
        const presentation = await publishCancellation(client, this.publisher, operationToken, request, events,
          removed.eventCount, this.limits.presentation)
        if (removed.result.kind !== 'removed') refuse('native_input_publication_conflict')
        const receipt = inputCommandReceipt.parse({ ...removed, result: { ...removed.result,
          archive: { purpose: 'archive', stopId: request.stopId, presentation } } })
        await this.ledger.saveArchiveCancelReceiptInTransaction(client, receipt)
        const response = this.response(receipt, request)
        await context?.acknowledge(response)
        await this.final(client, authority, owner, request, response, stop, frame.originalDigest,
          frame.verified.frozenSnapshot, sourceDeadline, publication.deadline)
        return response
      })
  }

  private async frame(client: PoolClient, authority: NativeInputStorageAuthority, request: NativeArchiveInputCancelCommit) {
    let verified: NativeInputVerifiedFrame, originalDigest = digest(authority.operationToken)
    if (request.frame.phase === 'claimed' && request.frame.operationEpoch < request.presentation.epoch) {
      const original = await this.frames.readConsumedInTransaction(client, authority)
      if (!isDeepStrictEqual(original.operationFrame, request.frame)) refuse('native_input_archive_frame_conflict')
      verified = original.frame
      originalDigest = original.operationDigest
    } else {
      const frame = request.frame
      verified = await this.frames.verifyInTransaction(client, { authority, kind: 'read',
        expected: { sessionId: frame.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
          writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
    }
    const original = await client.query(`SELECT operation_id FROM pe_native_turn_frames
      WHERE operation_id=$1 AND operation_epoch=$2 AND session_id=$3 AND writer_epoch=$4
      AND grant_digest=$5 AND frame_json=$6::jsonb AND frame_json->>'frozenSnapshotDigest'=$7`,
    [request.frame.operationId, request.frame.operationEpoch, request.frame.sessionId, request.frame.writerEpoch,
      originalDigest, JSON.stringify(request.frame), request.frame.frozenSnapshotDigest])
    if (original.rowCount !== 1) refuse('native_input_archive_frame_conflict')
    return { verified, originalDigest }
  }

  private response(input: InputCommandReceipt, request: NativeArchiveInputCancelCommit): NativeArchiveInputCancelReceipt {
    if (input.result.kind !== 'removed' || input.result.archive === undefined) refuse('native_input_archive_conflict')
    const archive = input.result.archive, ack = archive.presentation
    if (archive.stopId !== request.stopId || input.sessionId !== request.frame.sessionId
      || input.rpcNonce !== request.command.rpcNonce || input.actor.kind !== 'writer'
      || input.actor.workerId !== request.writer.workerId || input.actor.writerEpoch !== request.writer.epoch
      || ack.epoch !== request.presentation.epoch || ack.publisherId !== request.presentation.publisherId
      || ack.lastOrdinal !== request.presentation.firstOrdinal || ack.eventCount !== request.expectedEventCount + 1) {
      refuse('native_input_archive_conflict')
    }
    const response = nativeArchiveInputCancelReceipt.parse({ version: 1, kind: 'archive-input-cancel',
      stopId: archive.stopId, input, presentation: ack })
    assertCancellationBytes(response, this.limits.input.maxCommandBytes)
    return response
  }

  private async final(client: PoolClient, authority: NativeInputStorageAuthority, owner: z.infer<typeof userId>,
    request: NativeArchiveInputCancelCommit, response: NativeArchiveInputCancelReceipt, stop: NativeSessionStopIntent,
    originalDigest: string, frozen: NativeInputVerifiedFrame['frozenSnapshot'],
    sourceDeadline: string, publicationDeadline: string): Promise<void> {
    const input = response.input, ack = response.presentation
    if (input.result.kind !== 'removed') refuse('native_input_archive_conflict')
    const result = input.result
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3
      JOIN pe_native_turn_frames f ON f.operation_id=o.id AND f.operation_epoch=$10 AND f.session_id=s.id
      JOIN pe_native_presentations p ON p.session_id=s.id AND p.epoch=$3
      JOIN pe_native_input_commands c ON c.session_id=s.id AND c.command_id=$21
      JOIN pe_native_input_origins t ON t.session_id=s.id AND t.origin_input_id=$23
      JOIN pe_operations target ON target.id=t.origin_operation_id AND target.session_id=s.id
      JOIN pe_native_input_revisions r ON r.origin_input_id=t.origin_input_id AND r.input_revision=$27 AND r.input_digest=$28
      JOIN pe_native_preferences q ON q.user_id=s.user_id AND q.namespace=$24
      WHERE s.id=$1 AND s.user_id=$4 AND s.lease_epoch=$3 AND s.grant_digest=$9 AND s.lease_until>clock_timestamp()
      AND s.event_count=$5 AND o.state='running' AND o.error_code='cancel_requested' AND o.completed_at IS NULL
      AND a.worker_id=$6 AND a.ended_at IS NULL
      AND w.worker_id=$6 AND w.epoch=$7 AND w.token_digest=$8 AND w.expires_at>clock_timestamp()
      AND f.writer_epoch=$11 AND f.grant_digest=$12 AND f.frame_json=$13::jsonb
      AND f.frame_json->>'frozenSnapshotDigest'=$26 AND f.grant_json=$30::jsonb
      AND $14::timestamptz>clock_timestamp() AND $15::timestamptz>clock_timestamp()
      AND p.publisher_id=$16 AND p.last_ordinal=$17 AND p.last_batch_id=$18 AND p.expires_at>clock_timestamp()
      AND (p.state_json::jsonb->>'revision')=$19 AND (p.state_json::jsonb->>'cursor')=$20
      AND c.receipt_json=$22::jsonb AND c.kind='remove' AND c.target_origin_input_id=t.origin_input_id
      AND target.id<>o.id AND target.state='failed' AND target.error_code='turn_user' AND target.completed_at IS NOT NULL
      AND q.value=$29::jsonb AND q.value->>'stopId'=$25 AND q.value->>'status'='requested'
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=t.origin_input_id)
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_revisions WHERE origin_input_id=t.origin_input_id AND input_revision>$27)
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=t.origin_input_id
        AND kind='remove' AND command_id<>$21)`,
    [request.frame.sessionId, request.frame.operationId, request.presentation.epoch, owner, input.eventCount,
      authority.writer.workerId, authority.writer.epoch, digest(authority.writer.token), digest(authority.operationToken),
      request.frame.operationEpoch, request.frame.writerEpoch, originalDigest, JSON.stringify(request.frame),
      sourceDeadline, publicationDeadline, ack.publisherId, ack.lastOrdinal, request.presentation.batchId,
      String(ack.revision), String(input.eventCount - 1), input.commandId, JSON.stringify(input), result.originInputId,
      `session-archive-stop:${request.frame.sessionId}`, request.stopId, request.frame.frozenSnapshotDigest,
      result.inputRevision, result.inputDigest, JSON.stringify(stop), JSON.stringify(frozen)])
    if (live.rowCount !== 1) refuse('native_input_authority_lost')
  }
}
