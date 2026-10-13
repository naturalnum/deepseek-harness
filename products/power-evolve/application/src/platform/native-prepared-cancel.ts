/** Atomic prepared user cancellation with immutable replay independent of expired source and publisher leases. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { PlatformError, userId } from '../contracts.ts'
import { nativePreparedCancelCommit, nativePreparedCancelReceipt, nativePreparedCancelIntentDigest,
  type NativePreparedCancelCommit, type NativePreparedCancelReceipt } from '../native-prepared-cancel-contracts.ts'
import { inputCommandReceipt, nativeInputStorageAuthority,
  type InputCommandReceipt, type NativeInputStorageAuthority } from '../native-input-ledger-contracts.ts'
import type { NativeRetainedTransaction } from './native-retained-intent-transaction.ts'
import { digest } from './identity.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'
import { completeSessionStopInTransaction } from './native-session-stop-completion.ts'
import type { NativeAssistantStore, NativeAssistantReceipt } from './native-assistant-store.ts'
import type { NativeExecutionFrames } from './native-execution-frames.ts'
import type { NativeInputCommitConfig } from './native-input-commit.ts'
import type { NativeInputLedger } from './native-input-ledger.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { TaskStore } from './tasks.ts'

import { assertCancellationBytes, validateCancellationLimits, validateCancellationRequest, runCancellationTransaction,
  requireCancellationSource, parseCancellationEvents, publishCancellation, readCancellationPresentation } from './native-archive-input.ts'

function refuse(code: string): never { throw new PlatformError(409, code) }

/** A purpose-specific retirement; ordinary browser remove and executing-owner cancellation keep their separate guards. */
export class NativePreparedCancel {
  private readonly limits: NativeInputCommitConfig

  /** Validate the strict original cancellation and its deployment byte budget before sealing.
   * @param input Complete original ownerless-frame cancellation request.
   * @param header Actual owned Session header when validating the proposed native suffix.
   * @returns Bounded strict request without a native fact write or new execution authority.
   */
  validateRetainedRequest(input: unknown, header?: unknown): NativePreparedCancelCommit {
    return validateCancellationRequest(nativePreparedCancelCommit, input, this.limits, header)
  }

  /**
   * @param tasks Actual current source authorization and Platform PG pool.
   * @param ledger Actual immutable origin, revision, canonical append and command receipt provider.
   * @param frames Actual prepared frame provider preserving its complete original frozen capability.
   * @param publisher Actual ordered publisher that must commit while the canceled source is still running.
   * @param writers Actual independent Session Writer, retained until the caller finishes local synchronization.
   * @param config Explicit existing input and publication budgets, without added defaults.
   */
  constructor(private readonly tasks: TaskStore, private readonly ledger: NativeInputLedger,
    private readonly frames: NativeExecutionFrames, private readonly publisher: NativeAssistantStore,
    private readonly writers: NativeSessionWriter, config: NativeInputCommitConfig) {
    this.limits = validateCancellationLimits(config, 'Invalid prepared cancellation limits')
  }

  /** Retire only the canceled current prepared candidate and return its original immutable acknowledgement.
   * Exact replay authenticates the active account and owned Session plus the original Writer scope and full
   * intent before any current Task, frame or presentation lookup. It succeeds after source/Writer expiry,
   * terminal state or publisher eviction without renewing or issuing authority. A changed nonce intent refuses.
   * First commit requires a live canceled source/current attempt, current Writer, ownerless prepared frame,
   * exact latest pending revision and actual publisher prefix. Canonical removal and publication commit while
   * the source runs; terminal writes retain its epoch and freeze, clear only its lease, and preserve siblings.
   * Captured source and publication deadlines and the current Writer are jointly checked after every write.
   * @param operationToken Original operation bearer retained unchanged across uncertain responses.
   * @param input Complete original request including frame, canonical splice, nonce and publisher counters.
   * @param context Retained journal transaction; ACK write precedes the original joint clock proof.
   * @returns Stored tokenless input, original publication acknowledgement and exact user-canceled retired frame.
   */
  async commit(operationToken: string, input: unknown,
    context?: NativeRetainedTransaction<NativePreparedCancelReceipt>): Promise<NativePreparedCancelReceipt> {
    const request = validateCancellationRequest(nativePreparedCancelCommit, input, this.limits)
    const authority = nativeInputStorageAuthority.parse({ writer: request.writer, operationToken })
    const operationDigest = digest(operationToken)
    const intent = nativePreparedCancelIntentDigest(operationToken, request)
    return runCancellationTransaction(this.tasks, this.ledger, request, intent, this.limits.input.maxCommandBytes,
      context, receipt => this.response(receipt, request), async (client, owner) => {
        const archiveStop = await readSessionStopInTransaction(client, owner, request.frame.sessionId)
        const writer = await this.writers.requireInTransaction(client, request.writer)
        const session = await this.tasks.authorized(client, operationToken)
        if (writer.userId !== owner || session.user_id !== owner || session.id !== request.frame.sessionId
        || session.operation_id !== request.frame.operationId || session.lease_epoch !== request.frame.operationEpoch) {
          refuse('native_input_prepared_cancel_conflict')
        }
        const sourceDeadline = await requireCancellationSource(client, session, operationDigest, request.writer.workerId,
          'native_input_prepared_cancel_conflict')
        const publication = await readCancellationPresentation(client, request, this.limits.presentation, request.frame.operationEpoch)
        const events = parseCancellationEvents(session.header, request, this.limits.input)
        const batch = { expectedEventCount: request.expectedEventCount, events }
        const removed = await this.ledger.stagePreparedCancelInTransaction(client, authority,
          request.command, request.frame, intent, batch)
        const presentation = await publishCancellation(client, this.publisher, operationToken, request, events,
          removed.eventCount, this.limits.presentation)
        const frame = await this.frames.retirePreparedCancelInTransaction(client, authority, request.frame, removed.eventCount)
        if (removed.result.kind !== 'removed') refuse('native_input_prepared_cancel_conflict')
        const receipt = inputCommandReceipt.parse({ ...removed, result: { ...removed.result,
          retirement: { purpose: 'prepared-user-cancel', presentation, frame } } })
        const ended = await client.query(`UPDATE pe_attempts SET ended_at=clock_timestamp()
        WHERE operation_id=$1 AND epoch=$2 AND worker_id=$3 AND ended_at IS NULL RETURNING operation_id`,
        [frame.operationId, frame.operationEpoch, request.writer.workerId])
        if (ended.rowCount !== 1) refuse('native_input_prepared_cancel_conflict')
        await client.query(`UPDATE pe_attempts SET ended_at=clock_timestamp()
        WHERE operation_id=$1 AND epoch<$2 AND ended_at IS NULL`, [frame.operationId, frame.operationEpoch])
        const finished = await client.query(`UPDATE pe_operations SET state='failed',error_code='turn_user',completed_at=clock_timestamp()
        WHERE id=$1 AND session_id=$2 AND state='running' AND error_code='cancel_requested' RETURNING id`,
        [frame.operationId, frame.sessionId])
        if (finished.rowCount !== 1) refuse('native_input_prepared_cancel_conflict')
        const parked = await client.query(`UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL
        WHERE id=$1 AND user_id=$2 AND lease_epoch=$3 AND grant_digest=$4 AND event_count=$5 RETURNING id`,
        [frame.sessionId, owner, frame.operationEpoch, operationDigest, frame.eventCount])
        if (parked.rowCount !== 1) refuse('native_input_prepared_cancel_conflict')
        await this.ledger.savePreparedCancelReceiptInTransaction(client, receipt)
        await client.query("SELECT pg_notify('pe_tasks',$1)", [frame.sessionId])
        const response = this.response(receipt, request)
        if (archiveStop?.status === 'requested') {
          await completeSessionStopInTransaction(client, owner, frame.sessionId, archiveStop.stopId, this.limits.input)
        }
        await context?.acknowledge(response)
        await this.final(client, authority, owner, request, response, sourceDeadline, publication.deadline)
        return response
      })
  }

  private response(input: InputCommandReceipt, request: NativePreparedCancelCommit): NativePreparedCancelReceipt {
    if (input.result.kind !== 'removed' || !input.result.retirement) refuse('native_input_prepared_cancel_conflict')
    const retirement = input.result.retirement
    if (!isDeepStrictEqual(retirement.frame, { ...request.frame, phase: 'retired', reason: 'user_cancel',
      eventCount: input.eventCount, requeued: false })) refuse('native_input_prepared_cancel_conflict')
    const response = nativePreparedCancelReceipt.parse({ version: 1, kind: 'prepared-cancel', input,
      presentation: retirement.presentation, frame: retirement.frame })
    assertCancellationBytes(response, this.limits.input.maxCommandBytes)
    return response
  }

  private async final(client: PoolClient, authority: NativeInputStorageAuthority, owner: z.infer<typeof userId>,
    request: NativePreparedCancelCommit, response: NativePreparedCancelReceipt,
    sourceDeadline: string, publicationDeadline: string): Promise<void> {
    const frame = response.frame, ack: NativeAssistantReceipt = response.presentation
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3
      JOIN pe_native_turn_frames f ON f.operation_id=o.id AND f.operation_epoch=a.epoch AND f.session_id=s.id
      JOIN pe_native_presentations p ON p.session_id=s.id AND p.epoch=$3
      JOIN pe_native_input_commands c ON c.session_id=s.id AND c.command_id=$12
      WHERE s.id=$1 AND s.user_id=$4 AND s.lease_epoch=$3 AND s.grant_digest IS NULL AND s.lease_until IS NULL
      AND s.event_count=$5 AND o.state='failed' AND o.error_code='turn_user' AND o.completed_at IS NOT NULL
      AND a.worker_id=$6 AND a.ended_at IS NOT NULL
      AND w.worker_id=$6 AND w.epoch=$7 AND w.token_digest=$8 AND w.expires_at>clock_timestamp()
      AND f.writer_epoch=$7 AND f.grant_digest=$9 AND f.frame_json=$10::jsonb
      AND $11::timestamptz>clock_timestamp() AND $13::timestamptz>clock_timestamp()
      AND p.publisher_id=$14 AND p.last_ordinal=$15 AND p.last_batch_id=$16 AND p.expires_at>clock_timestamp()
      AND (p.state_json::jsonb->>'revision')=$17 AND (p.state_json::jsonb->>'cursor')=$18
      AND c.receipt_json=$19::jsonb AND c.kind='remove' AND c.target_origin_input_id=$20
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$20)
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=$20 AND kind='remove' AND command_id<>$12)
      AND NOT EXISTS(SELECT 1 FROM pe_attempts WHERE operation_id=o.id AND epoch<$3 AND ended_at IS NULL)`,
    [frame.sessionId, frame.operationId, frame.operationEpoch, owner, frame.eventCount, authority.writer.workerId,
      authority.writer.epoch, digest(authority.writer.token), digest(authority.operationToken), JSON.stringify(frame),
      sourceDeadline, response.input.commandId, publicationDeadline, ack.publisherId, ack.lastOrdinal,
      request.presentation.batchId, String(ack.revision), String(frame.eventCount - 1), JSON.stringify(response.input),
      frame.candidateOriginInputId])
    if (live.rowCount !== 1) refuse('native_input_authority_lost')
  }
}
