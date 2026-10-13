/** Version-two PG frame ownership, retaining original capabilities across native content revisions. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { PlatformError, grant, operationId, requestId, sessionId, type Grant, type OperationId } from '../contracts.ts'
import { nativePreparedInputRecovery, type NativePreparedInputRecovery } from '../native-prepared-input-recovery-contracts.ts'
import { nativeExecutionFrame, nativeExecutionOwner, type NativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import { nativeTurnMessageId, nativeOperationEpoch, nativeTurnSavedGrant } from '../native-turn-contracts.ts'
import { nativeWriterEpoch } from '../native-writer-contracts.ts'
import { matchesContinuationInput } from '../continuation-input.ts'
import { admittedInputMessage, eventSeq, inputClaim, nativeInputSnapshotFields, originInputId, recordDigest,
  type NativeInputFrameVerification, type NativeInputVerifiedFrame, type NativeInputStorageAuthority,
  type OriginInputId, type InputOrigin } from '../native-input-ledger-contracts.ts'
import { ledgerFrozenSnapshotDigest, nativeInputRecordDigest, readInputOrigin } from '../native-input-ledger-records.ts'
import { digest } from './identity.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { TaskStore } from './tasks.ts'
import { readNativeTurnHistory, type NativeTurnHistory, type NativeTurnHistoryLimits } from './native-turn-history.ts'

/** Bounds are checked before fetching durable frame JSON or complete native history. */
export interface NativeExecutionFrameLimits extends NativeTurnHistoryLimits {
  readonly maxFrameBytes: number
  readonly maxCohortInputs: number
}

/** Platform-only historical consumption proof; it never recreates the original operation or Writer bearer. */
export interface HistoricalNativeConsumption {
  readonly frame: NativeInputVerifiedFrame
  readonly operationFrame: Extract<NativeExecutionFrame, { phase: 'claimed' }>
  readonly storageGrant: Grant
  readonly operationDigest: string
  readonly workerId: string
}

const snapshot = nativeTurnSavedGrant.extend({
  ...nativeInputSnapshotFields,
  executionEnabled: grant.shape.executionEnabled.unwrap(), skills: grant.shape.skills.unwrap(),
  selection: grant.shape.selection.unwrap(), mcpConnections: grant.shape.mcpConnections.unwrap(),
  remoteMcpTools: grant.shape.remoteMcpTools.unwrap(), stdioV2Connections: grant.shape.stdioV2Connections.unwrap(),
  stdioMcpConnections: grant.shape.stdioMcpConnections.unwrap(), sshConnections: grant.shape.sshConnections.unwrap(),
}).strict()
const rowSchema = z.object({
  operationId, operationEpoch: nativeOperationEpoch, sessionId, writerEpoch: nativeWriterEpoch,
  requestId, messageId: nativeTurnMessageId, grantDigest: recordDigest,
  preparedEventCount: eventSeq, frame: nativeExecutionFrame, frozenSnapshot: snapshot,
}).strict()
type StoredFrame = z.infer<typeof rowSchema>
const originSchema = z.object({ originInputId, operationId, sessionId, requestId,
  messageId: nativeTurnMessageId }).strict()
const ownerProofSchema = z.object({
  operationId, operationEpoch: nativeOperationEpoch, sessionId, writerEpoch: nativeWriterEpoch,
  frozenSnapshotDigest: recordDigest, ownerKind: z.enum(['next-turn-head', 'first-next-step', 'current-frame']),
  originInputId, inputRevision: eventSeq.min(1), inputDigest: recordDigest,
  claimSpliceSeq: eventSeq, spliceItemOrdinal: eventSeq, target: z.enum(['next-step', 'next-turn']),
  turnStartSeq: eventSeq, turn: eventSeq.min(1), boundaryOrdinal: eventSeq, message: admittedInputMessage,
}).strict()
const cohortClaimSchema = inputClaim.extend({ messageId: nativeTurnMessageId, message: admittedInputMessage }).strict()

function refuse(code: string): never { throw new PlatformError(409, code) }

function emptyInterruptedTail(history: NativeTurnHistory): boolean {
  const boundary = history.events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
  return boundary?.type === 'turn/start' && !history.claims.some(claim => claim.turnStartSeq === boundary.seq)
    && history.events.slice(boundary.seq + 1).every(event => event.type === 'agent/inbox/spliced')
}

/** Native candidates gain a claimed owner only after the complete durable initial cohort has committed. */
export class NativeExecutionFrames {
  private readonly limits: NativeExecutionFrameLimits

  /**
   * @param tasks Original operation and accepted-selection authority.
   * @param writers Independent live Session writer authority.
   * @param limits Explicit frame, cohort and native-history budgets.
   */
  constructor(private readonly tasks: TaskStore, private readonly writers: NativeSessionWriter,
    limits: NativeExecutionFrameLimits) {
    this.limits = z.object({
      maxFrameBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      maxCohortInputs: z.number().int().positive().max(2_147_483_647),
      maxHistoryEvents: z.number().int().positive().max(2_147_483_646),
      maxHistoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(limits)
  }

  /** Select native pending order without replaying an unsettled consumed owner.
   * @param client Caller transaction holding the active account and expired Session lease locks.
   * @param id Locked Session identity; native event and cohort reads use the deployment history bounds.
   * @param fallback Oldest eligible operation before any native admission exists.
   * @returns Existing operation identity for reconciliation or the next-turn head followed by first-next-step.
   */
  async selectClaimInTransaction(client: PoolClient, id: z.infer<typeof sessionId>, fallback: OperationId): Promise<OperationId> {
    const history = await readNativeTurnHistory(client, id, this.limits)
    const current = await client.query<{ id: string; consumed: boolean }>(`SELECT o.id,
      EXISTS(SELECT 1 FROM pe_native_input_origins i JOIN pe_native_input_claims c ON c.origin_input_id=i.origin_input_id
        WHERE i.origin_operation_id=o.id) AS consumed
      FROM pe_sessions s JOIN pe_attempts a ON a.epoch=s.lease_epoch AND a.ended_at IS NULL
      JOIN pe_operations o ON o.id=a.operation_id AND o.session_id=s.id AND o.state='running'
      WHERE s.id=$1 LIMIT 2`, [id])
    if (current.rows.length > 1) throw new PlatformError(503, 'native_execution_frame_corrupt')
    const owner = current.rows[0]
    const boundary = history.events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
    if (owner && (owner.consumed || (boundary?.type === 'turn/start' && !emptyInterruptedTail(history)))) {
      return operationId.parse(owner.id)
    }
    const head = history.nextTurn[0] ?? history.nextStep[0]
    if (!head) return fallback
    const origins = await client.query<{ id: string }>(`SELECT i.origin_operation_id AS id
      FROM pe_native_input_origins i JOIN pe_operations o ON o.id=i.origin_operation_id AND o.session_id=i.session_id
      WHERE i.session_id=$1 AND i.message_id=$2 AND o.state IN ('queued','running') LIMIT 2`, [id, head.id])
    if (origins.rows.length !== 1 || !origins.rows[0]) throw new PlatformError(503, 'native_execution_frame_origin_missing')
    return operationId.parse(origins.rows[0].id)
  }

  /** Prepare one admitted origin after its canonical pending input and ledger have committed in this transaction.
   * @param client Caller transaction; no commit, lease extension or native mirror mutation occurs here.
   * @param authority Exact live Writer and original operation bearer.
   * @param candidateOriginInputId Original operation's stable ledger identity.
   * @returns Existing or newly prepared version-two frame with no execution permission.
   */
  async prepareInTransaction(client: PoolClient, authority: NativeInputStorageAuthority,
    candidateOriginInputId: OriginInputId): Promise<NativeExecutionFrame> {
    await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    const value = await this.tasks.restoreGrantInTransaction(client, operationId.parse(session.operation_id),
      authority.operationToken, session.lease_epoch)
    if (value.sessionId !== authority.writer.sessionId) refuse('native_execution_frame_identity')
    const origin = await this.origin(client, candidateOriginInputId)
    return this.installPreparedInTransaction(client, authority, value, origin, false)
  }

  /** Recover only an admitted, unconsumed input under the current independently issued attempt and Writer.
   * @param client Caller transaction holding current account, Session, attempt and Writer authority.
   * @param authority Current storage bearer and exact Writer; no historical bearer is recovered from PG.
   * @returns Fresh admission or a new prepared scope retaining the original accepted snapshot; consumed turns require reconciliation.
   */
  async recoverPreparedInTransaction(client: PoolClient, authority: NativeInputStorageAuthority): Promise<NativePreparedInputRecovery> {
    await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    const id = operationId.parse(session.operation_id)
    if (session.id !== authority.writer.sessionId) refuse('native_execution_frame_identity')
    const sizes = await client.query<{ id: string; bytes: number }>(`SELECT origin_input_id AS id,
      pg_column_size(accepted_audit_json) AS bytes FROM pe_native_input_origins
      WHERE origin_operation_id=$1 AND session_id=$2 LIMIT 2`, [id, session.id])
    if (sizes.rows.length > 1) throw new PlatformError(503, 'native_execution_frame_corrupt')
    const hint = sizes.rows[0]
    if (!hint) {
      const existing = await client.query('SELECT 1 FROM pe_native_turn_frames WHERE operation_id=$1 LIMIT 1', [id])
      if (existing.rowCount) throw new PlatformError(503, 'native_execution_frame_corrupt')
      await this.finalFence(client, authority, { sessionId: sessionId.parse(session.id), operationId: id,
        operationEpoch: session.lease_epoch })
      return { version: 1, kind: 'fresh' }
    }
    if (hint.bytes > this.limits.maxFrameBytes) throw new PlatformError(413, 'native_execution_frame_budget')
    const rows = await client.query<Record<string, unknown>>(`SELECT origin_input_id AS "originInputId",session_id AS "sessionId",
      origin_operation_id AS "originOperationId",original_request_id AS "originalRequestId",message_id AS "messageId",
      accepted_snapshot_digest AS "acceptedSnapshotDigest",accepted_audit_json AS "acceptedAudit"
      FROM pe_native_input_origins WHERE origin_input_id=$1`, [hint.id])
    if (!rows.rows[0]) throw new PlatformError(503, 'native_execution_frame_corrupt')
    const origin = readInputOrigin(rows.rows[0]), audit = origin.acceptedAudit
    if (origin.originOperationId !== id || origin.sessionId !== session.id || audit.userId !== session.user_id) {
      refuse('native_execution_frame_origin')
    }
    const consumed = await client.query(`SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$1
      UNION ALL SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=$1 AND kind='remove'`, [origin.originInputId])
    if (consumed.rowCount) refuse('native_input_recovery_required')
    const latest = await client.query<{ epoch: number }>(`SELECT operation_epoch::double precision AS epoch
      FROM pe_native_turn_frames WHERE operation_id=$1 ORDER BY operation_epoch DESC LIMIT 1`, [id])
    const previousEpoch = latest.rows[0]?.epoch
    if (previousEpoch !== undefined && previousEpoch > session.lease_epoch) refuse('native_execution_frame_identity')
    const previous = previousEpoch === undefined ? undefined : await this.read(client, id, previousEpoch)
    if (previous && (previous.frame.phase !== 'prepared' || previous.frame.candidateOriginInputId !== origin.originInputId
      || previous.frame.messageId !== origin.messageId)) refuse('native_input_recovery_required')
    const runtime = previous?.frozenSnapshot ?? await this.tasks.restoreGrantInTransaction(client, id,
      authority.operationToken, session.lease_epoch)
    if (audit.source !== 'user' && !matchesContinuationInput(audit.text, runtime.text)) {
      throw new PlatformError(503, 'native_execution_frame_corrupt')
    }
    const originalAttachments = runtime.attachments.filter(file =>
      audit.attachments.some(attachment => isDeepStrictEqual(attachment, file)))
    if (!isDeepStrictEqual(originalAttachments, audit.attachments)) {
      throw new PlatformError(503, 'native_execution_frame_corrupt')
    }
    // Retain the bounded continuation already frozen or issued; new deployment limits must not rewrite it.
    const original = snapshot.parse({ ...audit, text: audit.source === 'user' ? audit.text : runtime.text,
      attachments: runtime.attachments, executionEnabled: runtime.executionEnabled,
      skills: runtime.skills, epoch: previous?.frame.operationEpoch ?? session.lease_epoch })
    if (previous && !isDeepStrictEqual(original, previous.frozenSnapshot)) {
      throw new PlatformError(503, 'native_execution_frame_corrupt')
    }
    const restored = grant.parse({ ...original, epoch: session.lease_epoch, token: authority.operationToken })
    const frame = await this.installPreparedInTransaction(client, authority, restored,
      { originInputId: origin.originInputId, operationId: id, sessionId: origin.sessionId,
        requestId: origin.originalRequestId, messageId: origin.messageId }, true)
    return nativePreparedInputRecovery.parse({ version: 1, kind: 'prepared', frame, grant: restored })
  }

  /** Prove that an older attempted input has only prepared history under the current consumed owner's transaction.
   * @param client Caller transaction holding account, Session and current Writer authority.
   * @param origin Immutable original audit already proved by the current continuation.
   * @param current Actual claimed frame verified under the caller's live operation bearer.
   * @param attemptCount Original operation counter, locked and checked by the caller before issuance or settlement.
   * @param purpose Pending successor or consumption exclusively in this current complete cohort.
   * @returns Completion only for bounded, equal frozen snapshots with no historical execution owner or foreign consumption.
   */
  async assertPriorPreparedInTransaction(client: PoolClient, origin: InputOrigin, current: NativeInputVerifiedFrame,
    attemptCount: number, purpose: 'pending' | 'consumed'): Promise<void> {
    if (current.owner === null) refuse('native_execution_frame_prior_attempt')
    await this.assertPreparedHistory(client, origin, current, attemptCount, purpose)
  }

  /** Prove an archival sibling's fully ended prepared history without supplying execution authority.
   * The caller holds actual account, Session and current storage Writer locks and proves the latest pending
   * revision and original audit. Every old scope must precede the original current frame, retain its complete
   * freeze, have ended its actual attempt and contain no execution cohort, claim or removal. Rows stay unchanged.
   * @param client Caller-owned archival cancellation transaction.
   * @param origin Genuine queued sibling with its immutable original accepted audit.
   * @param current Actual prepared or claimed original frame proof, including historical consumed ownership.
   * @param attemptCount Original queued operation counter locked and checked by the caller.
   * @returns Completion only for the full original prepared scopes; no Grant or frame generation is issued.
   */
  async assertArchivePendingPreparedInTransaction(client: PoolClient, origin: InputOrigin, current: NativeInputVerifiedFrame,
    attemptCount: number): Promise<void> {
    const target = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
      WHERE o.id=$1 AND o.session_id=$2 AND s.user_id=$3 AND o.state='queued' AND o.attempts=$4
      AND NOT EXISTS(SELECT 1 FROM pe_attempts WHERE operation_id=o.id AND ended_at IS NULL) FOR UPDATE OF o`,
    [origin.originOperationId, current.sessionId, current.frozenSnapshot.userId, attemptCount])
    if (target.rowCount !== 1) refuse('native_input_archive_attempt_active')
    await this.assertPreparedHistory(client, origin, current, attemptCount, 'pending')
  }

  private async assertPreparedHistory(client: PoolClient, origin: InputOrigin, current: NativeInputVerifiedFrame,
    attemptCount: number, purpose: 'pending' | 'consumed'): Promise<void> {
    if (origin.sessionId !== current.sessionId
      || origin.originOperationId === current.operationId || origin.acceptedAudit.userId !== current.frozenSnapshot.userId
      || !Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > this.limits.maxHistoryEvents) {
      refuse('native_execution_frame_prior_attempt')
    }
    const counts = await client.query<{ attempts: number; frames: number; bytes: string }>(`SELECT
      (SELECT count(*)::integer FROM pe_attempts WHERE operation_id=$1) AS attempts,
      (SELECT count(*)::integer FROM pe_native_turn_frames WHERE operation_id=$1) AS frames,
      (SELECT COALESCE(sum(octet_length(frame_json::text)+octet_length(grant_json::text)),0)::text
        FROM pe_native_turn_frames WHERE operation_id=$1) AS bytes`, [origin.originOperationId])
    const count = counts.rows[0]
    if (!count || count.attempts !== attemptCount || count.frames !== attemptCount) refuse('native_execution_frame_prior_attempt')
    if (!/^\d+$/u.test(count.bytes) || BigInt(count.bytes) > BigInt(this.limits.maxHistoryBytes)) {
      throw new PlatformError(413, 'native_execution_frame_budget')
    }
    const executed = await client.query(`SELECT 1 FROM pe_native_input_cohorts WHERE execution_operation_id=$1
      UNION ALL SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=$2 AND kind='remove' LIMIT 1`,
    [origin.originOperationId, origin.originInputId])
    if (executed.rowCount) refuse('native_input_recovery_required')
    const claims = await client.query<{
      operationId: string
      epoch: number
      writerEpoch: number
      digest: string
      turnStartSeq: number
      turn: number
    }>(`SELECT k.execution_operation_id AS "operationId",
      k.operation_epoch::double precision AS epoch,k.writer_epoch::double precision AS "writerEpoch",
      k.frozen_snapshot_digest AS digest,k.turn_start_seq AS "turnStartSeq",k.turn_number AS turn
      FROM pe_native_input_claims c JOIN pe_native_input_cohorts k ON k.cohort_id=c.cohort_id AND k.session_id=c.session_id
      WHERE c.origin_input_id=$1 LIMIT 2`, [origin.originInputId])
    const claim = claims.rows[0]
    if (purpose === 'pending') {
      if (claims.rows.length !== 0) refuse('native_execution_frame_prior_consumption')
    } else {
      const owner = current.owner
      if (owner === null || claims.rows.length !== 1 || !claim || claim.operationId !== current.operationId
        || claim.epoch !== current.operationEpoch || claim.writerEpoch !== current.writerEpoch
        || claim.digest !== current.frozenSnapshotDigest || claim.turnStartSeq !== owner.turnStartSeq || claim.turn !== owner.turn) {
        refuse('native_execution_frame_prior_consumption')
      }
    }
    const attempts = await client.query<{ epoch: number }>(`SELECT epoch FROM pe_attempts
      WHERE operation_id=$1 ORDER BY epoch LIMIT $2`, [origin.originOperationId, this.limits.maxHistoryEvents + 1])
    if (attempts.rows.length !== attemptCount) refuse('native_execution_frame_prior_attempt')
    let original: Omit<StoredFrame['frozenSnapshot'], 'epoch'> | undefined
    for (const attempt of attempts.rows) {
      if (!Number.isSafeInteger(attempt.epoch) || attempt.epoch < 1 || attempt.epoch >= current.operationEpoch) {
        refuse('native_execution_frame_prior_attempt')
      }
      const stored = await this.read(client, origin.originOperationId, attempt.epoch)
      if (!stored || stored.frame.phase !== 'prepared' || stored.frame.sessionId !== origin.sessionId
        || stored.frame.requestId !== origin.originalRequestId || stored.frame.candidateOriginInputId !== origin.originInputId
        || stored.frame.messageId !== origin.messageId) refuse('native_execution_frame_prior_attempt')
      const frozen = stored.frozenSnapshot, audit = origin.acceptedAudit
      if (audit.source !== 'user' && !matchesContinuationInput(audit.text, frozen.text)) {
        throw new PlatformError(503, 'native_execution_frame_corrupt')
      }
      const ownAttachments = frozen.attachments.filter(file => audit.attachments.some(item => isDeepStrictEqual(item, file)))
      const accepted = snapshot.parse({ ...audit, epoch: attempt.epoch, text: audit.source === 'user' ? audit.text : frozen.text,
        attachments: frozen.attachments, skills: frozen.skills, executionEnabled: frozen.executionEnabled })
      const { epoch: _epoch, ...metadata } = frozen
      if (!isDeepStrictEqual(ownAttachments, audit.attachments) || !isDeepStrictEqual(accepted, frozen)
        || (original && !isDeepStrictEqual(metadata, original))) {
        throw new PlatformError(503, 'native_execution_frame_corrupt')
      }
      original ??= metadata
    }
  }

  /** Read original consumed ownership under a separately issued current storage attempt without rebinding any old claim.
   * @param client Caller transaction holding current account, Session and Writer authority.
   * @param authority Current bearer and independently acquired Writer; all historical identities stay tokenless.
   * @returns Original claimed frame, digest and worker for complete historical cohort proof, plus current storage-only Grant.
   */
  async readConsumedInTransaction(client: PoolClient, authority: NativeInputStorageAuthority): Promise<HistoricalNativeConsumption> {
    await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    const id = operationId.parse(session.operation_id)
    if (session.id !== authority.writer.sessionId) refuse('native_execution_frame_identity')
    const latest = await client.query<{ epoch: number }>(`SELECT operation_epoch::double precision AS epoch
      FROM pe_native_turn_frames WHERE operation_id=$1 ORDER BY operation_epoch DESC LIMIT 1`, [id])
    const epoch = latest.rows[0]?.epoch
    if (epoch === undefined || epoch >= session.lease_epoch) refuse('native_input_recovery_required')
    const stored = await this.read(client, id, epoch)
    if (!stored || stored.frame.phase !== 'claimed' || stored.frame.sessionId !== session.id
      || stored.frozenSnapshot.userId !== session.user_id) refuse('native_input_recovery_required')
    await this.proveOwner(client, stored, stored.frame.owner)
    const hint = await client.query<{ bytes: number }>(`SELECT octet_length(accepted_audit_json::text) AS bytes
      FROM pe_native_input_origins WHERE origin_input_id=$1`, [stored.frame.candidateOriginInputId])
    if (!hint.rows[0] || hint.rows[0].bytes > this.limits.maxFrameBytes) throw new PlatformError(413, 'native_execution_frame_budget')
    const rows = await client.query<Record<string, unknown>>(`SELECT origin_input_id AS "originInputId",session_id AS "sessionId",
      origin_operation_id AS "originOperationId",original_request_id AS "originalRequestId",message_id AS "messageId",
      accepted_snapshot_digest AS "acceptedSnapshotDigest",accepted_audit_json AS "acceptedAudit"
      FROM pe_native_input_origins WHERE origin_input_id=$1`, [stored.frame.candidateOriginInputId])
    const origin = readInputOrigin(rows.rows[0]), audit = origin.acceptedAudit, frozen = stored.frozenSnapshot
    const attachments = frozen.attachments.filter(file => audit.attachments.some(item => isDeepStrictEqual(item, file)))
    const accepted = snapshot.parse({ ...audit, epoch, text: audit.source === 'user' ? audit.text : frozen.text,
      attachments: frozen.attachments, skills: frozen.skills, executionEnabled: frozen.executionEnabled })
    if (origin.originOperationId !== id || origin.sessionId !== stored.frame.sessionId
      || origin.originalRequestId !== stored.frame.requestId || origin.messageId !== stored.frame.messageId
      || !isDeepStrictEqual(attachments, audit.attachments) || !isDeepStrictEqual(accepted, frozen)
      || (audit.source !== 'user' && !matchesContinuationInput(audit.text, frozen.text))) {
      throw new PlatformError(503, 'native_execution_frame_corrupt')
    }
    const attempt = await client.query<{ workerId: string }>(`SELECT worker_id AS "workerId" FROM pe_attempts
      WHERE operation_id=$1 AND epoch=$2`, [id, epoch])
    const worker = z.uuid().safeParse(attempt.rows[0]?.workerId)
    if (!worker.success) refuse('native_execution_frame_prior_attempt')
    const current = { sessionId: sessionId.parse(session.id), operationId: id, operationEpoch: session.lease_epoch }
    const storageGrant = grant.parse({ ...frozen, epoch: current.operationEpoch, token: authority.operationToken })
    await this.finalFence(client, authority, current)
    return { operationFrame: stored.frame, frame: { sessionId: stored.frame.sessionId, operationId: id, operationEpoch: epoch,
      writerEpoch: stored.frame.writerEpoch, frozenSnapshotDigest: stored.frame.frozenSnapshotDigest,
      candidateOriginInputId: stored.frame.candidateOriginInputId, messageId: stored.frame.messageId,
      frozenSnapshot: frozen, owner: stored.frame.owner }, storageGrant, operationDigest: stored.grantDigest, workerId: worker.data }
  }

  private async installPreparedInTransaction(client: PoolClient, authority: NativeInputStorageAuthority,
    value: Grant, origin: z.infer<typeof originSchema>, recovering: boolean): Promise<NativeExecutionFrame> {
    const candidateOriginInputId = origin.originInputId
    if (origin.operationId !== value.operationId || origin.sessionId !== value.sessionId
      || origin.requestId !== value.requestId) refuse('native_execution_frame_origin')
    const history = await readNativeTurnHistory(client, value.sessionId, this.limits)
    const lastTurnBoundary = history.events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
    if (lastTurnBoundary?.type === 'turn/start') {
      // The native resume factory closes an interrupted empty tail through the current fenced publisher.
      // Any consumed input or work in that turn needs separate reconciliation and cannot enter a new model step.
      if (!recovering || !emptyInterruptedTail(history)) {
        refuse('native_execution_frame_turn_open')
      }
    }
    if (![...history.nextTurn, ...history.nextStep].some(message => message.id === origin.messageId)
      || history.claims.some(claim => claim.message.id === origin.messageId)) refuse('native_execution_frame_not_pending')
    const { token: _token, ...metadata } = value
    const frozen = snapshot.parse(metadata)
    const existing = await this.read(client, value.operationId, value.epoch)
    if (existing) {
      if (existing.frame.candidateOriginInputId !== candidateOriginInputId
        || existing.frame.messageId !== origin.messageId || existing.grantDigest !== digest(authority.operationToken)
        || existing.frame.writerEpoch !== authority.writer.epoch || !isDeepStrictEqual(existing.frozenSnapshot, frozen)
        || existing.frame.phase !== 'prepared') refuse('native_execution_frame_prepare_conflict')
      await this.finalFence(client, authority, existing.frame)
      return existing.frame
    }
    const frame = nativeExecutionFrame.parse({
      version: 2, phase: 'prepared', sessionId: value.sessionId, operationId: value.operationId,
      operationEpoch: value.epoch, writerEpoch: authority.writer.epoch, requestId: value.requestId,
      messageId: origin.messageId, candidateOriginInputId,
      frozenSnapshotDigest: ledgerFrozenSnapshotDigest(frozen), preparedEventCount: history.eventCount,
    })
    this.checkBytes(frame, frozen)
    await client.query(`INSERT INTO pe_native_turn_frames(operation_id,operation_epoch,session_id,writer_epoch,
      request_id,message_id,grant_digest,frame_json,grant_json,prepared_event_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [frame.operationId, frame.operationEpoch, frame.sessionId, frame.writerEpoch, frame.requestId, frame.messageId,
      digest(authority.operationToken), JSON.stringify(frame), JSON.stringify(frozen), frame.preparedEventCount])
    await this.finalFence(client, authority, frame)
    return frame
  }

  /** Read the actual frame, or pin its owner only after the complete cohort and canonical events are present in PG.
   * @param client Caller transaction holding the established account, Session, Writer and attempt locks.
   * @param request Current internal authority and expected frame; browser fields cannot supply these identities.
   * @returns Exact current frozen snapshot and immutable claimed owner, or a prepared candidate without permission.
   */
  async verifyInTransaction(client: PoolClient, request: NativeInputFrameVerification): Promise<NativeInputVerifiedFrame> {
    await this.writers.requireInTransaction(client, request.authority.writer)
    const session = await this.tasks.authorized(client, request.authority.operationToken)
    const stored = await this.read(client, operationId.parse(session.operation_id), session.lease_epoch)
    if (!stored) refuse('native_execution_frame_missing')
    let frame = stored.frame
    if (frame.sessionId !== request.authority.writer.sessionId || frame.writerEpoch !== request.authority.writer.epoch
      || stored.grantDigest !== digest(request.authority.operationToken)
      || (frame.phase !== 'prepared' && frame.phase !== 'claimed')) refuse('native_execution_frame_identity')
    const expected = { sessionId: frame.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
      writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest }
    if (request.expected && !isDeepStrictEqual(expected, request.expected)) refuse('native_execution_frame_changed')
    if (request.kind === 'bind-owner') {
      const owner = nativeExecutionOwner.parse(request.owner)
      if (frame.phase === 'claimed') {
        if (!isDeepStrictEqual(frame.owner, owner)) refuse('native_execution_frame_owner_changed')
      } else {
        await this.proveOwner(client, stored, owner)
        frame = nativeExecutionFrame.parse({ ...frame, phase: 'claimed', owner })
        this.checkBytes(frame, stored.frozenSnapshot)
        await client.query('UPDATE pe_native_turn_frames SET frame_json=$3 WHERE operation_id=$1 AND operation_epoch=$2',
          [frame.operationId, frame.operationEpoch, JSON.stringify(frame)])
      }
    }
    if (frame.phase === 'claimed') await this.proveOwner(client, { ...stored, frame }, frame.owner)
    await this.finalFence(client, request.authority, frame)
    return { ...expected, candidateOriginInputId: frame.candidateOriginInputId, messageId: frame.messageId,
      frozenSnapshot: stored.frozenSnapshot, owner: frame.phase === 'claimed' ? frame.owner : null }
  }

  /** Read durable claimed ownership for an already authenticated business operation without minting Writer authority.
   * @param client Caller transaction holding the account and Session authorization locks.
   * @param session Exact current row returned by TaskStore.authorized for this operation bearer.
   * @param operationToken Original live operation bearer; no raw Writer token is reconstructed from PG.
   * @returns Claimed frame after complete owner proof and a joint attempt, operation and Writer clock check.
   */
  async readExecutionInTransaction(client: PoolClient,
    session: Awaited<ReturnType<TaskStore['authorized']>>, operationToken: string): Promise<NativeInputVerifiedFrame> {
    const stored = await this.read(client, operationId.parse(session.operation_id), session.lease_epoch)
    if (!stored) refuse('native_execution_frame_missing')
    const frame = stored.frame
    if (stored.grantDigest !== digest(operationToken) || frame.sessionId !== session.id
      || frame.operationId !== session.operation_id || frame.operationEpoch !== session.lease_epoch
      || frame.phase !== 'claimed') refuse('native_execution_frame_not_claimed')
    await this.proveOwner(client, stored, frame.owner)
    const live = await client.query(`SELECT s.id FROM pe_sessions s
      JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3
      JOIN pe_native_writers w ON w.session_id=s.id
      WHERE s.id=$1 AND s.lease_epoch=$3 AND s.grant_digest=$4 AND s.lease_until>clock_timestamp()
        AND o.state='running' AND o.request_id=$6 AND a.ended_at IS NULL
        AND a.worker_id=w.worker_id AND w.epoch=$5 AND w.expires_at>clock_timestamp()`,
    [frame.sessionId, frame.operationId, frame.operationEpoch, digest(operationToken), frame.writerEpoch, frame.requestId])
    if (live.rowCount !== 1) refuse('native_execution_frame_lease_lost')
    return { sessionId: frame.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
      writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest,
      candidateOriginInputId: frame.candidateOriginInputId, messageId: frame.messageId,
      frozenSnapshot: stored.frozenSnapshot, owner: frame.owner }
  }

  private checkBytes(frame: NativeExecutionFrame, frozen: z.infer<typeof snapshot>): void {
    if (Buffer.byteLength(JSON.stringify(frame)) + Buffer.byteLength(JSON.stringify(frozen)) > this.limits.maxFrameBytes) {
      throw new PlatformError(413, 'native_execution_frame_budget')
    }
  }

  /** Retire only the exact current unclaimed canceled frame after its genuine removal has been published.
   * Original capability metadata, epoch, candidate and prepared watermark remain unchanged. The caller must
   * still terminate the same source and attempt, clear only its Session lease, save the immutable receipt and
   * prove captured source/publication deadlines with the live Writer before committing this transaction.
   * @param client Atomic cancellation transaction holding account, Session, Writer, source and publication locks.
   * @param authority Exact original live operation and Writer bearers; neither is returned or renewed.
   * @param expected Complete original prepared frame retained by the caller.
   * @param eventCount Canonical count after the single actual canceled removal.
   * @returns Original frame identity with only the explicit user cancellation retirement fields added.
   */
  async retirePreparedCancelInTransaction(client: PoolClient, authority: NativeInputStorageAuthority,
    expected: Extract<NativeExecutionFrame, { phase: 'prepared' }>, eventCount: number): Promise<Extract<NativeExecutionFrame, { phase: 'retired' }>> {
    await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    const stored = await this.read(client, operationId.parse(session.operation_id), session.lease_epoch)
    if (!stored || stored.grantDigest !== digest(authority.operationToken) || !isDeepStrictEqual(stored.frame, expected)
      || stored.frame.phase !== 'prepared' || expected.sessionId !== authority.writer.sessionId
      || expected.writerEpoch !== authority.writer.epoch || session.event_count !== eventCount) {
      refuse('native_execution_frame_cancel_conflict')
    }
    const unconsumed = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
      WHERE o.id=$1 AND o.session_id=$2 AND o.state='running' AND o.error_code='cancel_requested'
      AND a.epoch=$3 AND a.worker_id=$4 AND a.ended_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$5)
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=$5 AND kind='remove')`,
    [expected.operationId, expected.sessionId, expected.operationEpoch, authority.writer.workerId, expected.candidateOriginInputId])
    if (unconsumed.rowCount !== 1) refuse('native_execution_frame_cancel_conflict')
    const frame = nativeExecutionFrame.parse({ ...expected, phase: 'retired', reason: 'user_cancel', eventCount, requeued: false })
    if (frame.phase !== 'retired') refuse('native_execution_frame_cancel_conflict')
    this.checkBytes(frame, stored.frozenSnapshot)
    const changed = await client.query(`UPDATE pe_native_turn_frames SET frame_json=$3
      WHERE operation_id=$1 AND operation_epoch=$2 AND frame_json->>'phase'='prepared' RETURNING operation_id`,
    [frame.operationId, frame.operationEpoch, JSON.stringify(frame)])
    if (changed.rowCount !== 1) refuse('native_execution_frame_cancel_conflict')
    await this.finalFence(client, authority, frame)
    return frame
  }

  private async origin(client: PoolClient, id: OriginInputId) {
    const rows = await client.query<Record<string, unknown>>(`SELECT origin_input_id AS "originInputId",
      origin_operation_id AS "operationId",session_id AS "sessionId",original_request_id AS "requestId",
      message_id AS "messageId" FROM pe_native_input_origins WHERE origin_input_id=$1`, [id])
    if (!rows.rows[0]) refuse('native_execution_frame_origin_missing')
    return originSchema.parse(rows.rows[0])
  }

  private async read(client: PoolClient, id: z.infer<typeof operationId>, epoch: number): Promise<StoredFrame | undefined> {
    const sizes = await client.query<{ bytes: number }>(`SELECT octet_length(frame_json::text)+octet_length(grant_json::text)
      AS bytes FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2 FOR UPDATE`, [id, epoch])
    if (!sizes.rows[0]) return undefined
    if (sizes.rows[0].bytes > this.limits.maxFrameBytes) throw new PlatformError(413, 'native_execution_frame_budget')
    const rows = await client.query<Record<string, unknown>>(`SELECT operation_id AS "operationId",
      operation_epoch::double precision AS "operationEpoch",session_id AS "sessionId",writer_epoch::double precision AS "writerEpoch",
      request_id AS "requestId",message_id AS "messageId",grant_digest AS "grantDigest",prepared_event_count AS "preparedEventCount",
      frame_json AS frame,grant_json AS "frozenSnapshot" FROM pe_native_turn_frames
      WHERE operation_id=$1 AND operation_epoch=$2`, [id, epoch])
    const parsed = rowSchema.safeParse(rows.rows[0])
    if (!parsed.success) throw new PlatformError(503, 'native_execution_frame_corrupt')
    const stored = parsed.data, frame = stored.frame, frozen = stored.frozenSnapshot
    if (nativeInputRecordDigest(rows.rows[0]?.frozenSnapshot) !== ledgerFrozenSnapshotDigest(frozen)) {
      throw new PlatformError(503, 'native_execution_frame_corrupt')
    }
    if (stored.operationId !== frame.operationId || stored.operationEpoch !== frame.operationEpoch
      || stored.sessionId !== frame.sessionId || stored.writerEpoch !== frame.writerEpoch
      || stored.requestId !== frame.requestId || stored.messageId !== frame.messageId
      || stored.preparedEventCount !== frame.preparedEventCount || frozen.operationId !== frame.operationId
      || frozen.epoch !== frame.operationEpoch || frozen.sessionId !== frame.sessionId || frozen.requestId !== frame.requestId
      || ledgerFrozenSnapshotDigest(frozen) !== frame.frozenSnapshotDigest) {
      throw new PlatformError(503, 'native_execution_frame_corrupt')
    }
    return stored
  }

  private async proveOwner(client: PoolClient, stored: StoredFrame, owner: z.infer<typeof nativeExecutionOwner>): Promise<void> {
    const frame = stored.frame, origin = await this.origin(client, owner.originInputId)
    if (owner.originInputId !== frame.candidateOriginInputId || origin.operationId !== frame.operationId
      || origin.sessionId !== frame.sessionId || origin.requestId !== frame.requestId || origin.messageId !== frame.messageId) {
      refuse('native_execution_frame_owner_identity')
    }
    const rows = await client.query<Record<string, unknown>>(`SELECT k.execution_operation_id AS "operationId",
      k.operation_epoch::double precision AS "operationEpoch",k.session_id AS "sessionId",
      k.writer_epoch::double precision AS "writerEpoch",k.frozen_snapshot_digest AS "frozenSnapshotDigest",
      k.owner_kind AS "ownerKind",c.origin_input_id AS "originInputId",c.input_revision AS "inputRevision",
      c.input_digest AS "inputDigest",c.claim_splice_seq AS "claimSpliceSeq",c.splice_item_ordinal AS "spliceItemOrdinal",
      c.target,k.turn_start_seq AS "turnStartSeq",k.turn_number AS turn,k.boundary_ordinal AS "boundaryOrdinal",r.message_json AS message
      FROM pe_native_input_cohorts k JOIN pe_native_input_claims c ON c.cohort_id=k.cohort_id
      JOIN pe_native_input_revisions r ON r.origin_input_id=c.origin_input_id AND r.input_revision=c.input_revision
      WHERE k.cohort_id=$1 AND c.origin_input_id=$2 AND k.owner_origin_input_id=c.origin_input_id
        AND k.owner_input_revision=c.input_revision AND k.owner_input_digest=c.input_digest`, [owner.cohortId, owner.originInputId])
    const proof = ownerProofSchema.safeParse(rows.rows[0])
    if (!proof.success) refuse('native_execution_frame_owner_unproved')
    const fact = proof.data
    if (fact.operationId !== frame.operationId || fact.operationEpoch !== frame.operationEpoch
      || fact.sessionId !== frame.sessionId || fact.writerEpoch !== frame.writerEpoch
      || fact.frozenSnapshotDigest !== frame.frozenSnapshotDigest || fact.inputRevision !== owner.inputRevision
      || fact.inputDigest !== owner.inputDigest || fact.claimSpliceSeq !== owner.claimSpliceSeq
      || fact.spliceItemOrdinal !== owner.spliceItemOrdinal || fact.target !== owner.target
      || fact.turnStartSeq !== owner.turnStartSeq || fact.turn !== owner.turn || fact.message.id !== frame.messageId
      || fact.ownerKind === 'current-frame' || fact.boundaryOrdinal !== 0
      || owner.turnStartSeq < frame.preparedEventCount) refuse('native_execution_frame_owner_unproved')
    const history = await readNativeTurnHistory(client, frame.sessionId, this.limits)
    const start = history.events[owner.turnStartSeq]
    if (start?.type !== 'turn/start' || start.data.turn !== owner.turn) refuse('native_execution_frame_owner_unproved')
    const claim = history.claims.find(item => item.message.id === frame.messageId)
    if (!claim || claim.claimSeq !== owner.claimSpliceSeq || claim.turnStartSeq !== owner.turnStartSeq
      || claim.turn !== owner.turn || !isDeepStrictEqual(claim.message, fact.message)) refuse('native_execution_frame_owner_unproved')
    const splice = history.events[owner.claimSpliceSeq]
    if (splice?.type !== 'agent/inbox/spliced' || splice.data.target !== owner.target || splice.data.start !== 0
      || splice.data.outcome === 'canceled' || splice.data.inserted.length !== 0) refuse('native_execution_frame_owner_unproved')
    const first = await client.query<{ first: number | null; count: number; min: number | null; max: number | null; expected: number }>(
      `SELECT min(c.claim_splice_seq) AS first,count(c.origin_input_id)::integer AS count,
        min(c.cohort_ordinal) AS min,max(c.cohort_ordinal) AS max,k.claim_count AS expected
        FROM pe_native_input_cohorts k LEFT JOIN pe_native_input_claims c ON c.cohort_id=k.cohort_id
        WHERE k.cohort_id=$1 GROUP BY k.claim_count`, [owner.cohortId])
    const complete = first.rows[0]
    if (!complete || complete.first === null || complete.count !== complete.expected || complete.count < 1
      || complete.count > this.limits.maxCohortInputs || complete.min !== 0 || complete.max !== complete.count - 1) {
      refuse('native_execution_frame_cohort_incomplete')
    }
    if (history.events.slice(owner.turnStartSeq + 1, complete.first).some(event => event.type === 'step/start'
      || (event.type === 'agent/inbox/spliced' && event.data.outcome !== 'canceled' && (event.data.removedCount ?? 0) > 0))) {
      refuse('native_execution_frame_not_initial_boundary')
    }
    let pending = inboxProjectionDefinition.init()
    for (const event of history.events.slice(0, complete.first)) pending = inboxProjectionDefinition.apply(pending, event)
    const required = [
      ...pending['next-step'].map((message, index) => ({ message, target: 'next-step' as const, index })),
      ...pending['next-turn'].slice(0, 1).map(message => ({ message, target: 'next-turn' as const, index: 0 })),
    ]
    if (required.length !== complete.count) refuse('native_execution_frame_cohort_incomplete')
    const cohortRows = await client.query<Record<string, unknown>>(`SELECT c.origin_input_id AS "originInputId",
      c.session_id AS "sessionId",c.input_revision AS "inputRevision",c.input_digest AS "inputDigest",
      c.cohort_id AS "cohortId",c.claim_splice_seq AS "claimSpliceSeq",c.splice_item_ordinal AS "spliceItemOrdinal",
      c.cohort_ordinal AS "cohortOrdinal",c.target,i.message_id AS "messageId",r.message_json AS message
      FROM pe_native_input_claims c JOIN pe_native_input_origins i ON i.origin_input_id=c.origin_input_id
      JOIN pe_native_input_revisions r ON r.origin_input_id=c.origin_input_id AND r.input_revision=c.input_revision
      WHERE c.cohort_id=$1 ORDER BY c.cohort_ordinal LIMIT $2`, [owner.cohortId, this.limits.maxCohortInputs + 1])
    const cohortClaims = z.array(cohortClaimSchema).safeParse(cohortRows.rows)
    if (!cohortClaims.success || cohortClaims.data.length !== required.length) refuse('native_execution_frame_cohort_incomplete')
    const coordinates = new Map<'next-step' | 'next-turn', number>()
    let sequence = complete.first
    for (const target of ['next-step', 'next-turn'] as const) {
      const count = target === 'next-step' ? pending[target].length : Math.min(pending[target].length, 1)
      if (count === 0) continue
      const removal = history.events[sequence]
      if (removal?.type !== 'agent/inbox/spliced' || removal.data.target !== target || removal.data.start !== 0
        || removal.data.removedCount !== count || removal.data.inserted.length !== 0 || removal.data.outcome === 'canceled') {
        refuse('native_execution_frame_cohort_incomplete')
      }
      coordinates.set(target, sequence++)
    }
    for (const [index, item] of required.entries()) {
      const fact = cohortClaims.data[index]
      if (!fact || fact.sessionId !== frame.sessionId || fact.cohortId !== owner.cohortId
        || fact.cohortOrdinal !== index || fact.target !== item.target || fact.spliceItemOrdinal !== item.index
        || fact.claimSpliceSeq !== coordinates.get(item.target) || fact.messageId !== item.message.id
        || !isDeepStrictEqual(fact.message, item.message) || fact.inputDigest !== nativeInputRecordDigest(fact.message)) {
        refuse('native_execution_frame_cohort_incomplete')
      }
    }
    const head = pending['next-turn'][0]
    if (head) {
      if (fact.ownerKind !== 'next-turn-head' || owner.target !== 'next-turn' || head.id !== frame.messageId) {
        refuse('native_execution_frame_owner_choice')
      }
    } else if (fact.ownerKind !== 'first-next-step' || owner.target !== 'next-step'
      || pending['next-step'][0]?.id !== frame.messageId) refuse('native_execution_frame_owner_choice')
  }

  private async finalFence(client: PoolClient, authority: NativeInputStorageAuthority,
    frame: Pick<NativeExecutionFrame, 'sessionId' | 'operationId' | 'operationEpoch'>): Promise<void> {
    const live = await client.query(`SELECT s.id FROM pe_sessions s
      JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3
      JOIN pe_native_writers w ON w.session_id=s.id
      WHERE s.id=$1 AND s.lease_epoch=$3 AND s.grant_digest=$4 AND s.lease_until>clock_timestamp()
        AND o.state='running' AND a.ended_at IS NULL AND a.worker_id=$5
        AND w.worker_id=$5 AND w.epoch=$6 AND w.token_digest=$7 AND w.expires_at>clock_timestamp()`,
    [frame.sessionId, frame.operationId, frame.operationEpoch, digest(authority.operationToken),
      authority.writer.workerId, authority.writer.epoch, digest(authority.writer.token)])
    if (live.rowCount !== 1) refuse('native_execution_frame_lease_lost')
  }
}
