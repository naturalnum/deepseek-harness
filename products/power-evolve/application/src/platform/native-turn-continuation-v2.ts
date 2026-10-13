/** Atomic complete-cohort settlement and exact PG continuation through the actual version-two frame provider. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { grant, userId, PlatformError, type Grant } from '../contracts.ts'
import { continuationInput, matchesContinuationInput } from '../continuation-input.ts'
import { nativeExecutionFrame, type NativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import { acceptedInputAudit, eventSeq, recordDigest, type InputOrigin, type InputRevision,
  type NativeInputFrameVerifier, type NativeInputVerifiedFrame, type NativeInputLedgerLimits } from '../native-input-ledger-contracts.ts'
import { foldInputHistory, ledgerFrozenSnapshotDigest, nativeInputRecordDigest, readInputClaim,
  readInputOrigin, readInputReceipt, readInputRevision, type NativeInputHistory } from '../native-input-ledger-records.ts'
import { readNativeAssistantState, validateNativeAssistantLimits, type NativeAssistantLimits } from '../native-assistant-records.ts'
import { nativeContinuationSavedGrantV2, nativeTurnReceiptV2, nativeTurnResponseV2, nativeTurnTransitionV2,
  type NativeTurnReceiptV2, type NativeTurnResponseV2, type NativeTurnTransitionV2 } from '../native-turn-continuation-v2-contracts.ts'
import { headerSchema } from '../session-records.ts'
import { digest } from './identity.ts'
import { nativeInputLedgerLimitsSchema, readStoredNativeInputCohort, nativeInputCohortConflict } from './native-input-ledger.ts'
import { assertNativeRetainedBarrier, nativeRetainedTransaction,
  type NativeRetainedTransaction } from './native-retained-intent-transaction.ts'
import { readNativeTurnHistory } from './native-turn-history.ts'
import { isSessionBusinessBlockedInTransaction } from './native-workspace-layout.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'
import { completeSessionStopInTransaction } from './native-session-stop-completion.ts'
import { requireActiveAccount } from './account-authority.ts'
import type { TaskStore } from './tasks.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { NativeExecutionFrames } from './native-execution-frames.ts'

/** Explicit transaction, history, cohort and presentation budgets; none are inferred from browser fields. */
export interface NativeTurnContinuationV2Limits extends NativeInputLedgerLimits {
  readonly leaseMs: number
  readonly maxActivePerUser: number
  readonly assistant: NativeAssistantLimits
}

const originColumns = `origin_input_id AS "originInputId",session_id AS "sessionId",origin_operation_id AS "originOperationId",
  original_request_id AS "originalRequestId",message_id AS "messageId",accepted_snapshot_digest AS "acceptedSnapshotDigest",
  accepted_audit_json AS "acceptedAudit"`
const revisionColumns = `origin_input_id AS "originInputId",session_id AS "sessionId",input_revision AS "inputRevision",
  previous_revision AS "previousRevision",cause,message_json AS message,input_digest AS "inputDigest",
  committed_splice_seq AS "committedSpliceSeq",command_id AS "commandId"`
const claimColumns = `origin_input_id AS "originInputId",session_id AS "sessionId",input_revision AS "inputRevision",
  input_digest AS "inputDigest",cohort_id AS "cohortId",claim_splice_seq AS "claimSpliceSeq",
  splice_item_ordinal AS "spliceItemOrdinal",cohort_ordinal AS "cohortOrdinal",target`
const receiptRow = z.object({ intent: recordDigest, candidate: recordDigest, receipt: nativeTurnReceiptV2 }).strict()
const fenceRow = z.object({ deadline: z.string(), workerId: z.uuid(), errorCode: z.string().nullable() }).strict()
const presentationRow = z.object({ epoch: eventSeq.min(1), publisherId: z.uuid(), lastOrdinal: eventSeq,
  state: z.unknown(), deadline: z.string() }).strict()
const auditedOperation = z.object({ state: z.enum(['queued', 'running']), attempts: eventSeq,
  errorCode: z.string().nullable() }).strict()
type AuditedOperation = Pick<z.infer<typeof auditedOperation>, 'state' | 'attempts'>
type PendingInput = { origin: InputOrigin; operation: AuditedOperation }

function refuse(code: string): never { throw new PlatformError(409, code) }
function corrupt(): never { throw new PlatformError(503, 'native_continuation_v2_corrupt') }
function source(request: NativeTurnTransitionV2): NativeTurnReceiptV2['from'] {
  const { operationToken: _token, ...value } = request.from
  return value
}
function intent(request: NativeTurnTransitionV2): string {
  return nativeInputRecordDigest({ ...request, candidateToken: digest(request.candidateToken),
    writer: { ...request.writer, token: digest(request.writer.token) },
    from: { ...request.from, operationToken: digest(request.from.operationToken) } })
}
function snapshot(audit: InputOrigin['acceptedAudit'], runtime: Pick<Grant, 'executionEnabled' | 'skills'>,
  epoch: number, maxEventBytes: number, frozenText?: string) {
  return nativeContinuationSavedGrantV2.parse({ ...audit, executionEnabled: runtime.executionEnabled, skills: runtime.skills, epoch,
    text: audit.source === 'user' ? audit.text : frozenText ?? continuationInput(audit.text, maxEventBytes) })
}
function reference(frame: NativeExecutionFrame) {
  return { sessionId: frame.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
    writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest }
}
function storageEpoch(request: NativeTurnTransitionV2): number {
  return request.kind === 'reconcile' ? request.storageOperationEpoch : request.from.frame.operationEpoch
}
function receiptFrameEpoch(request: NativeTurnTransitionV2): number {
  return request.from.frame.writerEpoch
}
type ClaimAuthority = { workerId: string; writerEpoch: number; operationDigest: string }

/** A closed turn permanently settles every consumed origin while issuing at most its real pending head. */
export class NativeTurnContinuationV2 {
  private readonly limits: NativeTurnContinuationV2Limits

  /** Validate the complete original v2 wire intent and explicit transaction budgets before sealing.
   * @param input Original full transition, with all cohorts, seals and bearer identities intact.
   * @returns Strict bounded original intent; no settled receipt or authority is created.
   */
  validateRetainedRequest(input: unknown): NativeTurnTransitionV2 {
    return this.request(input)
  }

  /**
   * @param tasks Actual Platform operation/database owner; accepted selections are restored through its live attempt.
   * @param writers Actual independent Writer authority; its account and Session lock serializes transitions.
   * @param frameVerifier Required actual Root frames.verifyInTransaction provider, with no v1 or permissive fallback.
   * @param limits Explicit bounded PG reads, issuance duration, capacity and presentation limits.
   * @param preparedRecovery Actual prior-prepared proof and full snapshot restorer; absence refuses historical attempted inputs.
   */
  constructor(private readonly tasks: TaskStore, private readonly writers: NativeSessionWriter,
    private readonly frameVerifier: NativeInputFrameVerifier, limits: NativeTurnContinuationV2Limits,
    private readonly preparedRecovery?: Pick<NativeExecutionFrames,
      'assertPriorPreparedInTransaction' | 'recoverPreparedInTransaction' | 'readConsumedInTransaction'>) {
    const { assistant, ...numbers } = limits
    this.limits = { ...z.object({ leaseMs: eventSeq.min(1).max(300_000), maxActivePerUser: eventSeq.min(1),
      ...nativeInputLedgerLimitsSchema.shape,
    }).strict().parse(numbers), assistant: validateNativeAssistantLimits(assistant) }
  }

  /** Settle one exact closed native turn and retain its original tokenless result atomically.
   * Historical replay authenticates the active owner, original frame and complete persisted intent before live occupancy.
   * Lost occupancy returns only the original receipt; replay never renews a bearer or issues another successor.
   * @param input Entire retained v2 intent; retry it unchanged after an uncertain response.
   * @param context Retained journal transaction acknowledging only the tokenless receipt before both original final fences.
   * @returns Original receipt and a bearer only while its exact original successor remains live; no replay renewal occurs.
   */
  async transition(input: unknown, context?: NativeRetainedTransaction<NativeTurnReceiptV2>): Promise<NativeTurnResponseV2> {
    const request = this.request(input)
    return nativeRetainedTransaction(this.tasks.pool, context, async (client) => {
      await this.receiptOwner(client, request)
      await this.bounded(client, `SELECT octet_length(receipt_json::text) AS bytes FROM pe_native_turn_transitions_v2
        WHERE session_id=$1 AND writer_epoch=$2 AND transition_id=$3`,
      [request.writer.sessionId, receiptFrameEpoch(request), request.transitionId], this.limits.maxCommandBytes, false)
      const prior = await client.query<Record<string, unknown>>(`SELECT intent_digest AS intent,candidate_digest AS candidate,
        receipt_json AS receipt FROM pe_native_turn_transitions_v2 WHERE session_id=$1 AND writer_epoch=$2 AND transition_id=$3`,
      [request.writer.sessionId, receiptFrameEpoch(request), request.transitionId])
      if (prior.rows[0]) {
        const original = receiptRow.safeParse(prior.rows[0])
        if (!original.success) corrupt()
        if (nativeInputRecordDigest(prior.rows[0].receipt) !== nativeInputRecordDigest(original.data.receipt)) corrupt()
        if (original.data.intent !== intent(request) || original.data.candidate !== digest(request.candidateToken)) {
          refuse('native_continuation_v2_intent_conflict')
        }
        const receipt = original.data.receipt
        if (receipt.sessionId !== request.writer.sessionId || receipt.writerEpoch !== request.writer.epoch
          || receipt.transitionId !== request.transitionId || receipt.eventCount !== request.expectedEventCount
          || receipt.queueRevision !== request.expectedQueueRevision || !isDeepStrictEqual(receipt.from, source(request))) corrupt()
        if (receipt.result.kind === 'prepared' && ledgerFrozenSnapshotDigest(receipt.result.grant)
          !== receipt.result.frame.frozenSnapshotDigest) corrupt()
        await context?.acknowledge(receipt)
        return this.response(client, request, receipt, true)
      }
      await assertNativeRetainedBarrier(client, request.writer.sessionId, context !== undefined)
      const writer = await this.writers.requireInTransaction(client, request.writer)
      const used = await client.query('SELECT 1 FROM pe_native_turn_transitions_v2 WHERE from_operation_id=$1 AND from_operation_epoch=$2',
        [request.from.frame.operationId, request.from.frame.operationEpoch])
      if (used.rowCount) refuse('native_continuation_v2_source_used')
      await this.freshCandidate(client, request)
      const session = await this.tasks.authorized(client, request.from.operationToken)
      if (session.id !== request.writer.sessionId || session.operation_id !== request.from.frame.operationId
        || session.lease_epoch !== storageEpoch(request) || writer.userId !== session.user_id) {
        refuse('native_continuation_v2_identity')
      }
      const archiveStop = await readSessionStopInTransaction(client, session.user_id, request.writer.sessionId)
      const fenced = await client.query<Record<string, unknown>>(`SELECT s.lease_until::text AS deadline,
        a.worker_id AS "workerId",o.error_code AS "errorCode" FROM pe_sessions s
        JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3
        WHERE s.id=$1 AND o.state='running' AND a.ended_at IS NULL FOR UPDATE OF o,a`,
      [session.id, session.operation_id, session.lease_epoch])
      const fence = fenceRow.safeParse(fenced.rows[0])
      if (!fence.success || fence.data.workerId !== request.writer.workerId) refuse('native_continuation_v2_attempt')
      const historical = request.kind === 'reconcile' ? await this.historical(client, request) : undefined
      const verified = historical?.frame ?? await this.frameVerifier(client, { kind: 'read', expected: request.from.frame,
        authority: { writer: request.writer, operationToken: request.from.operationToken } })
      if (verified.owner === null) refuse('native_continuation_v2_unclaimed')
      const stored = await readNativeTurnHistory(client, request.writer.sessionId, this.limits)
      const history = foldInputHistory(headerSchema.parse(session.header), stored.events)
      if (history.eventCount !== request.expectedEventCount || stored.queueRevision !== request.expectedQueueRevision
        || request.seal.eventCount !== history.eventCount) refuse('native_continuation_v2_watermark')
      const end = history.events[request.from.turnEndSeq], owner = verified.owner
      const last = history.events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
      if (owner.turn !== request.from.turn || owner.turnStartSeq !== request.from.turnStartSeq
        || end?.type !== 'turn/end' || end.data.turn !== owner.turn || last !== end || history.turn !== null || history.step !== null
        || end.seq <= owner.claimSpliceSeq) refuse('native_continuation_v2_turn')
      if (foldConsumedWork(history.events.slice(owner.turnStartSeq, end.seq + 1)).end?.seq !== end.seq) {
        refuse('native_continuation_v2_unaccounted')
      }
      const claimAuthority = historical ? { workerId: historical.workerId, writerEpoch: verified.writerEpoch,
        operationDigest: historical.operationDigest } : { workerId: request.writer.workerId,
        writerEpoch: request.writer.epoch, operationDigest: digest(request.from.operationToken) }
      const origins = await this.proveCohorts(client, request, verified, history, claimAuthority)
      const original = origins.find(origin => origin.originInputId === owner.originInputId)
      if (!original || original.originOperationId !== verified.operationId) refuse('native_continuation_v2_snapshot')
      if (original.acceptedAudit.source !== 'user'
        && !matchesContinuationInput(original.acceptedAudit.text, verified.frozenSnapshot.text)) {
        refuse('native_continuation_v2_snapshot')
      }
      const accepted = snapshot(original.acceptedAudit, verified.frozenSnapshot, verified.operationEpoch,
        this.limits.maxEventBytes, verified.frozenSnapshot.text)
      const originalAttachments = verified.frozenSnapshot.attachments.filter(file =>
        original.acceptedAudit.attachments.some(attachment => isDeepStrictEqual(attachment, file)))
      if (!isDeepStrictEqual(originalAttachments, original.acceptedAudit.attachments)
        || !isDeepStrictEqual({ ...accepted, attachments: verified.frozenSnapshot.attachments }, verified.frozenSnapshot)) {
        refuse('native_continuation_v2_snapshot')
      }
      const operations = new Map<InputOrigin['originOperationId'], AuditedOperation>()
      for (const origin of origins) operations.set(origin.originOperationId,
        await this.auditOperation(client, origin, origin.originOperationId === verified.operationId, verified, 'consumed'))
      const next = await this.pendingHead(client, request, history, verified)
      // Recheck the actual provider after all cohort/audit reads and before transferring the original capability.
      if (historical) await this.historical(client, request)
      else await this.frameVerifier(client, { kind: 'read', expected: request.from.frame,
        authority: { writer: request.writer, operationToken: request.from.operationToken } })
      const presentationDeadline = await this.seal(client, request, history)
      const outcome = end.data.reason.kind === 'completed' ? 'completed' : 'failed'
      const errorCode = end.data.reason.kind === 'completed' ? null
        : end.data.reason.kind === 'aborted' && fence.data.errorCode === 'cancel_requested' ? 'turn_user' : `turn_${end.data.reason.kind}`
      const settled = origins.map(origin => ({ originInputId: origin.originInputId,
        operationId: origin.originOperationId, outcome, errorCode }))
      for (const origin of origins) {
        const operation = operations.get(origin.originOperationId)
        if (!operation) corrupt()
        const changed = await client.query(`UPDATE pe_operations SET state=$3,error_code=$4,completed_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 AND state=$5 AND attempts=$6 RETURNING id`,
        [origin.originOperationId, request.writer.sessionId, outcome, errorCode, operation.state, operation.attempts])
        if (changed.rowCount !== 1) refuse('native_continuation_v2_origin_changed')
        if (origin.originOperationId !== verified.operationId && operation.attempts > 0) {
          await this.endPriorAttempts(client, origin.originOperationId, verified.operationEpoch)
        }
      }
      if (historical) await this.endPriorAttempts(client, verified.operationId, storageEpoch(request))
      const ended = await client.query(`UPDATE pe_attempts SET ended_at=clock_timestamp()
        WHERE operation_id=$1 AND epoch=$2 AND ended_at IS NULL RETURNING operation_id`,
      [verified.operationId, storageEpoch(request)])
      if (ended.rowCount !== 1) refuse('native_continuation_v2_attempt')
      const oldFrame = await this.frame(client, verified.operationId, verified.operationEpoch)
      if (oldFrame.phase !== 'claimed') refuse('native_continuation_v2_unclaimed')
      const retired = nativeExecutionFrame.parse({ ...oldFrame, phase: 'settled', turnEndSeq: end.seq, outcome, errorCode })
      await client.query('UPDATE pe_native_turn_frames SET frame_json=$3 WHERE operation_id=$1 AND operation_epoch=$2',
        [verified.operationId, verified.operationEpoch, JSON.stringify(retired)])
      const result = await this.issue(client, request, next, writer.userId)
      const receipt = nativeTurnReceiptV2.parse({ version: 2, sessionId: request.writer.sessionId,
        writerEpoch: request.writer.epoch, transitionId: request.transitionId, eventCount: history.eventCount,
        queueRevision: stored.queueRevision, from: source(request), settled, result })
      this.bytes(receipt, this.limits.maxCommandBytes)
      await client.query(`INSERT INTO pe_native_turn_transitions_v2(session_id,writer_epoch,transition_id,intent_digest,
        candidate_digest,from_operation_id,from_operation_epoch,receipt_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [receipt.sessionId, receiptFrameEpoch(request), receipt.transitionId, intent(request), digest(request.candidateToken),
        verified.operationId, verified.operationEpoch, JSON.stringify(receipt)])
      if (archiveStop?.status === 'requested') {
        await completeSessionStopInTransaction(client, writer.userId, request.writer.sessionId, archiveStop.stopId, this.limits)
      }
      await context?.acknowledge(receipt)
      await this.finalFence(client, request, fence.data.deadline, presentationDeadline)
      const response = await this.response(client, request, receipt, false)
      await client.query("SELECT pg_notify('pe_tasks',$1)", [request.writer.sessionId])
      await this.finalFence(client, request, fence.data.deadline, presentationDeadline)
      return response
    })
  }

  private async receiptOwner(client: PoolClient, request: NativeTurnTransitionV2): Promise<void> {
    if (request.from.frame.sessionId !== request.writer.sessionId) refuse('native_continuation_v2_identity')
    const hint = await client.query<{ userId: string }>(
      'SELECT user_id AS "userId" FROM pe_sessions WHERE id=$1', [request.writer.sessionId])
    if (hint.rows.length !== 1 || !hint.rows[0]) refuse('native_continuation_v2_identity')
    const owner = userId.parse(hint.rows[0].userId)
    await requireActiveAccount(client, owner, 'update')
    const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [request.writer.sessionId, owner])
    if (owned.rowCount !== 1) refuse('native_continuation_v2_identity')
    const frames = await client.query<{ grantDigest: string }>(`SELECT grant_digest AS "grantDigest" FROM pe_native_turn_frames
      WHERE operation_id=$1 AND operation_epoch=$2 AND session_id=$3 AND writer_epoch=$4
      AND frame_json->>'phase' IN ('claimed','settled') AND frame_json->>'frozenSnapshotDigest'=$5
      AND grant_json->>'userId'=$6`,
    [request.from.frame.operationId, request.from.frame.operationEpoch, request.writer.sessionId,
      receiptFrameEpoch(request), request.from.frame.frozenSnapshotDigest, owner])
    const original = recordDigest.safeParse(frames.rows[0]?.grantDigest)
    if (frames.rowCount !== 1 || !original.success) refuse('native_continuation_v2_identity')
    // Reconciliation's separately issued storage bearer is authenticated by the complete durable intent digest.
    // Its historical consumed frame retains the older bearer digest and is never restamped to current storage.
    if (request.kind === 'advance' && original.data !== digest(request.from.operationToken)) {
      refuse('native_continuation_v2_identity')
    }
  }

  private async historical(client: PoolClient, request: NativeTurnTransitionV2) {
    if (request.kind !== 'reconcile' || !this.preparedRecovery) refuse('native_continuation_v2_recovery_unavailable')
    const result = await this.preparedRecovery.readConsumedInTransaction(client,
      { writer: request.writer, operationToken: request.from.operationToken })
    if (!isDeepStrictEqual(reference(result.operationFrame), request.from.frame)
      || result.storageGrant.epoch !== request.storageOperationEpoch) refuse('native_continuation_v2_identity')
    if (result.operationDigest === digest(request.candidateToken)) refuse('native_continuation_v2_token')
    return result
  }

  private request(input: unknown): NativeTurnTransitionV2 {
    const parsed = nativeTurnTransitionV2.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    const request = parsed.data
    this.bytes(request, this.limits.maxCommandBytes)
    if (request.from.claimedOriginInputIds.length > this.limits.maxCohortInputs
      || request.from.cohortIds.length > this.limits.maxHistoryEvents) refuse('native_continuation_v2_budget')
    return request
  }

  private bytes(value: unknown, limit: number): void {
    if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new PlatformError(413, 'native_continuation_v2_budget')
  }

  private async bounded(client: PoolClient, sql: string, values: unknown[], maximum: number, required = true): Promise<void> {
    const result = await client.query<{ bytes: number }>(sql, values), row = result.rows[0]
    if (!row) { if (required) refuse('native_continuation_v2_proof_missing'); return }
    if (row.bytes > maximum) throw new PlatformError(413, 'native_continuation_v2_budget')
  }

  private async origin(client: PoolClient, session: NativeTurnTransitionV2['writer']['sessionId'], message: string): Promise<InputOrigin> {
    await this.bounded(client, `SELECT octet_length(accepted_audit_json::text) AS bytes FROM pe_native_input_origins
      WHERE session_id=$1 AND message_id=$2`, [session, message], this.limits.maxAcceptedAuditBytes)
    const rows = await client.query<Record<string, unknown>>(`SELECT ${originColumns} FROM pe_native_input_origins
      WHERE session_id=$1 AND message_id=$2`, [session, message])
    return readInputOrigin(rows.rows[0])
  }

  private async revision(client: PoolClient, origin: InputOrigin, number?: number): Promise<InputRevision> {
    const params = [origin.originInputId, origin.sessionId, number ?? null]
    await this.bounded(client, `SELECT octet_length(message_json::text) AS bytes FROM pe_native_input_revisions
      WHERE origin_input_id=$1 AND session_id=$2 AND ($3::integer IS NULL OR input_revision=$3)
      ORDER BY input_revision DESC LIMIT 1`, params, this.limits.maxRevisionBytes)
    const rows = await client.query<Record<string, unknown>>(`SELECT ${revisionColumns} FROM pe_native_input_revisions
      WHERE origin_input_id=$1 AND session_id=$2 AND ($3::integer IS NULL OR input_revision=$3)
      ORDER BY input_revision DESC LIMIT 1`, params)
    return readInputRevision(rows.rows[0])
  }

  private async proveCohorts(client: PoolClient, request: NativeTurnTransitionV2, frame: NativeInputVerifiedFrame,
    history: NativeInputHistory, authority: ClaimAuthority): Promise<InputOrigin[]> {
    const owner = frame.owner
    if (owner === null) refuse('native_continuation_v2_unclaimed')
    const bounds = await client.query<{ count: number; claims: number }>(`SELECT count(*)::integer AS count,
      COALESCE(sum(claim_count),0)::integer AS claims FROM pe_native_input_cohorts WHERE session_id=$1 AND turn_start_seq=$2`,
    [frame.sessionId, owner.turnStartSeq])
    const bound = bounds.rows[0]
    if (!bound || bound.count < 1 || bound.count > this.limits.maxHistoryEvents || bound.claims > this.limits.maxCohortInputs) {
      refuse('native_continuation_v2_cohort_budget')
    }
    const rows = await client.query<Record<string, unknown>>(`SELECT cohort_id AS "cohortId",session_id AS "sessionId",
      execution_operation_id AS "operationId",operation_epoch::double precision AS "operationEpoch",writer_epoch::double precision AS "writerEpoch",
      frozen_snapshot_digest AS "frozenSnapshotDigest",owner_kind AS "ownerKind",owner_origin_input_id AS "originInputId",
      owner_input_revision AS "inputRevision",owner_input_digest AS "inputDigest",turn_start_seq AS "turnStartSeq",turn_number AS turn,
      boundary_ordinal AS "boundaryOrdinal",step_start_seq AS "stepStartSeq",claim_count AS "claimCount",command_id AS "commandId"
      FROM pe_native_input_cohorts WHERE session_id=$1 AND turn_start_seq=$2 ORDER BY boundary_ordinal LIMIT $3`,
    [frame.sessionId, owner.turnStartSeq, this.limits.maxHistoryEvents + 1])
    if (!isDeepStrictEqual(rows.rows.map(row => row.cohortId), request.from.cohortIds)) refuse('native_continuation_v2_cohort_changed')
    const origins: InputOrigin[] = [], proved: NativeInputHistory['claims'][number][] = []
    const steps = history.events.slice(owner.turnStartSeq, request.from.turnEndSeq)
      .filter(event => event.type === 'step/start')
    for (const [ordinal, row] of rows.rows.entries()) {
      const claims = (await client.query<Record<string, unknown>>(`SELECT ${claimColumns} FROM pe_native_input_claims
        WHERE cohort_id=$1 AND session_id=$2 ORDER BY cohort_ordinal LIMIT $3`,
      [row.cohortId, frame.sessionId, this.limits.maxCohortInputs + 1])).rows.map(readInputClaim)
      const cohort = readStoredNativeInputCohort(row, claims)
      if (nativeInputCohortConflict(cohort, claims, ordinal, frame, owner)) refuse('native_continuation_v2_cohort_unproved')
      if (ordinal === 0 ? cohort.cohortId !== owner.cohortId || cohort.owner.kind === 'current-frame'
        : cohort.owner.kind !== 'current-frame') refuse('native_continuation_v2_owner')
      await this.bounded(client, `SELECT octet_length(receipt_json::text) AS bytes FROM pe_native_input_commands
        WHERE session_id=$1 AND command_id=$2`, [frame.sessionId, cohort.commandId], this.limits.maxCommandBytes)
      const command = (await client.query<Record<string, unknown>>(`SELECT receipt_json AS receipt,actor_kind AS kind,
        actor_id AS actor,writer_epoch::double precision AS epoch,committed_event_count AS count,kind AS operation,
        transport_nonce AS nonce,payload_digest AS digest,user_id AS "userId" FROM pe_native_input_commands
        WHERE session_id=$1 AND command_id=$2`, [frame.sessionId, cohort.commandId])).rows[0]
      if (!command) refuse('native_continuation_v2_proof_missing')
      const receipt = readInputReceipt(command.receipt)
      const first = cohort.claimSpliceSeqs[0] ?? receipt.eventCount
      const claimCommand = { rpcNonce: receipt.rpcNonce, cohortId: cohort.cohortId, frame: request.from.frame,
        boundaryKind: ordinal === 0 ? 'initial-turn-step' : 'continuing-step' }
      const digestFrom = (begin: number) => nativeInputRecordDigest({ command: claimCommand,
        batch: { expectedEventCount: begin, events: history.events.slice(begin, receipt.eventCount) },
        operationDigest: authority.operationDigest })
      const matchesIntent = receipt.payloadDigest === digestFrom(first)
        || (ordinal === 0 && first === owner.turnStartSeq + 1 && receipt.payloadDigest === digestFrom(owner.turnStartSeq))
      if (receipt.kind !== 'claim' || receipt.actor.kind !== 'writer' || receipt.actor.workerId !== authority.workerId
        || receipt.actor.writerEpoch !== authority.writerEpoch || receipt.actor.userId !== frame.frozenSnapshot.userId
        || receipt.result.kind !== 'claimed' || receipt.result.cohortId !== cohort.cohortId
        || receipt.commandId !== cohort.commandId || receipt.sessionId !== frame.sessionId
        || receipt.eventCount !== command.count || receipt.rpcNonce !== command.nonce || receipt.payloadDigest !== command.digest
        || command.operation !== 'claim' || command.kind !== 'writer' || command.actor !== authority.workerId
        || command.epoch !== authority.writerEpoch || command.userId !== receipt.actor.userId
        || !matchesIntent
        || !isDeepStrictEqual(receipt.committedSpliceSeqs, cohort.claimSpliceSeqs)) refuse('native_continuation_v2_receipt_unproved')
      const pre = foldInputHistory(history.header, history.events.slice(0, first))
      if (pre.turn?.seq !== owner.turnStartSeq || pre.step !== null
        || history.events.slice(owner.turnStartSeq, first).filter(event => event.type === 'step/start').length !== ordinal) {
        refuse('native_continuation_v2_prestate')
      }
      const required = [
        ...pre.inbox['next-step'].map((message, index) => ({ message, target: 'next-step' as const, index })),
        ...ordinal === 0 ? pre.inbox['next-turn'].slice(0, 1).map(message => ({ message, target: 'next-turn' as const, index: 0 })) : [],
      ]
      if (required.length !== claims.length || receipt.eventCount !== first + cohort.claimSpliceSeqs.length
        || receipt.eventCount > request.from.turnEndSeq) refuse('native_continuation_v2_cohort_incomplete')
      let sequence = first
      const coordinates = new Map<'next-step' | 'next-turn', number>()
      for (const target of ['next-step', 'next-turn'] as const) {
        const count = required.filter(item => item.target === target).length
        if (count === 0) continue
        const event = history.events[sequence]
        if (event?.type !== 'agent/inbox/spliced' || event.data.start !== 0 || event.data.target !== target
          || event.data.removedCount !== count || event.data.inserted.length !== 0 || event.data.outcome === 'canceled') {
          refuse('native_continuation_v2_cohort_incomplete')
        }
        coordinates.set(target, sequence++)
      }
      if (cohort.stepStartSeq !== (steps[ordinal]?.seq ?? null)
        || (cohort.stepStartSeq !== null && cohort.stepStartSeq < receipt.eventCount)
        || (cohort.stepStartSeq === null && ordinal !== rows.rows.length - 1)) refuse('native_continuation_v2_step_unproved')
      for (const [index, item] of required.entries()) {
        const claim = claims[index]
        if (!claim) corrupt()
        const origin = await this.origin(client, frame.sessionId, item.message.id)
        const revision = await this.revision(client, origin, claim.inputRevision)
        const latest = (await client.query<{ number: number }>(`SELECT max(input_revision) AS number FROM pe_native_input_revisions
          WHERE origin_input_id=$1 AND committed_splice_seq<$2`, [origin.originInputId, claim.claimSpliceSeq])).rows[0]
        const native = history.claims.find(value => value.seq === claim.claimSpliceSeq && value.itemOrdinal === claim.spliceItemOrdinal)
        if (origin.originInputId !== claim.originInputId || claim.cohortId !== cohort.cohortId || claim.sessionId !== frame.sessionId
          || claim.target !== item.target || claim.spliceItemOrdinal !== item.index || claim.claimSpliceSeq !== coordinates.get(item.target)
          || !isDeepStrictEqual(revision.message, item.message) || revision.message.id !== origin.messageId
          || revision.inputDigest !== claim.inputDigest || latest?.number !== revision.inputRevision
          || native?.turnStartSeq !== owner.turnStartSeq || !isDeepStrictEqual(native.message, item.message)) {
          refuse('native_continuation_v2_claim_unproved')
        }
        origins.push(origin); proved.push(native)
      }
    }
    const actual = history.claims.filter(claim => claim.turnStartSeq === owner.turnStartSeq)
    if (!isDeepStrictEqual(actual, proved) || steps.length > rows.rows.length
      || new Set(origins.map(origin => origin.originOperationId)).size !== origins.length
      || !isDeepStrictEqual(origins.map(origin => origin.originInputId), request.from.claimedOriginInputIds)) {
      refuse('native_continuation_v2_complete_claims')
    }
    return origins
  }

  private async auditOperation(client: PoolClient, origin: InputOrigin, running: boolean,
    current: NativeInputVerifiedFrame, purpose: 'pending' | 'consumed'): Promise<AuditedOperation> {
    await this.bounded(client, 'SELECT pg_column_size(to_jsonb(o)) AS bytes FROM pe_operations o WHERE id=$1 FOR UPDATE',
      [origin.originOperationId], this.limits.maxAcceptedAuditBytes)
    const rows = await client.query<Record<string, unknown>>(`SELECT o.id AS "operationId",o.session_id AS "sessionId",s.user_id AS "userId",
      o.request_id AS "requestId",o.input AS text,o.settings,o.source,o.source_action_id AS "sourceActionId",
      o.source_execution_id AS "sourceExecutionId",o.source_stdio_mcp_call_id AS "sourceStdioMcpCallId",
      o.source_ssh_execute_action_id AS "sourceSshExecuteActionId",o.source_mcp_action_id AS "sourceMcpActionId",
      o.source_stdio_v2_action_id AS "sourceStdioV2ActionId",o.source_stdio_v2_no_start_action_id AS "sourceStdioV2NoStartActionId",
      o.source_stdio_v2_phase AS "sourceStdioV2Phase",o.execution_target AS target,o.skill_selection AS selection,
      o.mcp_selection AS "mcpConnections",o.remote_mcp_selection AS "remoteMcpTools",o.stdio_mcp_selection AS "stdioMcpConnections",
      o.ssh_selection AS "sshConnections",o.stdio_v2_selection AS "stdioV2Connections",o.state,o.attempts,o.error_code AS "errorCode"
      FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id WHERE o.id=$1 AND o.session_id=$2`,
    [origin.originOperationId, origin.sessionId])
    const row = rows.rows[0]
    if (!row) refuse('native_continuation_v2_origin_state')
    const operation = auditedOperation.safeParse({ state: row.state, attempts: row.attempts, errorCode: row.errorCode })
    if (!operation.success || (running ? operation.data.state !== 'running'
      : operation.data.attempts === 0 ? operation.data.state !== 'queued' : operation.data.errorCode !== null)) {
      refuse('native_continuation_v2_origin_state')
    }
    const { state: _state, attempts: _attempts, errorCode: _errorCode, ...metadata } = row
    const prompt = await client.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2',
      [origin.sessionId, origin.originalRequestId])
    const audit = acceptedInputAudit.safeParse({ ...metadata, nativeContent: origin.acceptedAudit.source === 'user'
      ? prompt.rows[0]?.admitted : null, attachments: origin.acceptedAudit.attachments })
    if (!audit.success || !isDeepStrictEqual(audit.data, origin.acceptedAudit)) refuse('native_continuation_v2_audit')
    if (!running) {
      if (operation.data.attempts === 0) {
        if ((await client.query('SELECT 1 FROM pe_attempts WHERE operation_id=$1', [origin.originOperationId])).rowCount) {
          refuse('native_continuation_v2_origin_attempt')
        }
      } else {
        if (!this.preparedRecovery) refuse('native_continuation_v2_recovery_unavailable')
        await this.preparedRecovery.assertPriorPreparedInTransaction(client, origin, current, operation.data.attempts, purpose)
      }
    }
    return { state: operation.data.state, attempts: operation.data.attempts }
  }

  private async pendingHead(client: PoolClient, request: NativeTurnTransitionV2, history: NativeInputHistory,
    current: NativeInputVerifiedFrame): Promise<PendingInput | undefined> {
    const head = history.inbox['next-turn'][0] ?? history.inbox['next-step'][0]
    if (!head) { if (request.expectedNext !== null) refuse('native_continuation_v2_pending_changed'); return undefined }
    const origin = await this.origin(client, request.writer.sessionId, head.id), revision = await this.revision(client, origin)
    const target = history.inbox['next-turn'].length > 0 ? 'next-turn' : 'next-step'
    const expected = { originInputId: origin.originInputId, operationId: origin.originOperationId,
      messageId: origin.messageId, inputRevision: revision.inputRevision, inputDigest: revision.inputDigest, target }
    if (!isDeepStrictEqual(request.expectedNext, expected) || !isDeepStrictEqual(head, revision.message)
      || history.claims.some(claim => claim.message.id === head.id)) refuse('native_continuation_v2_pending_changed')
    const consumed = await client.query(`SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$1
      UNION ALL SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=$1 AND kind='remove'`, [origin.originInputId])
    if (consumed.rowCount) refuse('native_continuation_v2_pending_consumed')
    const operation = await this.auditOperation(client, origin, false, current, 'pending')
    return { origin, operation }
  }

  private async freshCandidate(client: PoolClient, request: NativeTurnTransitionV2): Promise<void> {
    const hashed = digest(request.candidateToken)
    if (hashed === digest(request.writer.token) || hashed === digest(request.from.operationToken)) refuse('native_continuation_v2_token')
    const rows = await client.query(`SELECT 1 FROM pe_native_turn_frames WHERE grant_digest=$1
      UNION ALL SELECT 1 FROM pe_native_turn_transitions_v2 WHERE candidate_digest=$1
      UNION ALL SELECT 1 FROM pe_sessions WHERE grant_digest=$1
      UNION ALL SELECT 1 FROM pe_native_writers WHERE token_digest=$1`, [hashed])
    if (rows.rowCount) refuse('native_continuation_v2_token')
  }

  private async frame(client: PoolClient, operation: NativeInputVerifiedFrame['operationId'], epoch: number): Promise<NativeExecutionFrame> {
    await this.bounded(client, `SELECT octet_length(frame_json::text) AS bytes FROM pe_native_turn_frames
      WHERE operation_id=$1 AND operation_epoch=$2`, [operation, epoch], this.limits.maxCommandBytes)
    const rows = await client.query<{ frame: unknown }>('SELECT frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
      [operation, epoch])
    return nativeExecutionFrame.parse(rows.rows[0]?.frame)
  }

  private async seal(client: PoolClient, request: NativeTurnTransitionV2, history: NativeInputHistory): Promise<string> {
    await this.bounded(client, 'SELECT octet_length(state_json) AS bytes FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE',
      [request.writer.sessionId],
      this.limits.assistant.maxRingBytes + this.limits.assistant.maxActiveBytes + this.limits.assistant.maxBatchBytes)
    const rows = await client.query<Record<string, unknown>>(`SELECT epoch,publisher_id AS "publisherId",
      last_ordinal::double precision AS "lastOrdinal",state_json AS state,expires_at::text AS deadline
      FROM pe_native_presentations WHERE session_id=$1`, [request.writer.sessionId])
    const parsed = presentationRow.safeParse(rows.rows[0])
    if (!parsed.success) refuse('native_continuation_v2_seal')
    const row = parsed.data, state = readNativeAssistantState(row.state, this.limits.assistant)
    if (row.epoch !== storageEpoch(request) || row.publisherId !== request.seal.publisherId
      || state.epoch !== row.epoch || state.publisherId !== row.publisherId || row.lastOrdinal !== state.lastOrdinal
      || state.lastOrdinal !== request.seal.lastOrdinal || state.revision !== request.seal.revision
      || state.cursor !== history.eventCount - 1 || state.activeAttempt !== undefined || state.awaitingStepEnd !== undefined) {
      refuse('native_continuation_v2_seal')
    }
    const deleted = await client.query(`DELETE FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2
      AND publisher_id=$3 AND expires_at>clock_timestamp() RETURNING session_id`,
    [request.writer.sessionId, row.epoch, row.publisherId])
    if (deleted.rowCount !== 1) refuse('native_continuation_v2_seal_expired')
    return row.deadline
  }

  private async endPriorAttempts(client: PoolClient, id: InputOrigin['originOperationId'], beforeEpoch: number): Promise<void> {
    await client.query(`UPDATE pe_attempts SET ended_at=clock_timestamp()
      WHERE operation_id=$1 AND epoch<$2 AND ended_at IS NULL`, [id, beforeEpoch])
  }

  private async issue(client: PoolClient, request: NativeTurnTransitionV2, next: PendingInput | undefined,
    user: string): Promise<NativeTurnReceiptV2['result']> {
    if (next && await isSessionBusinessBlockedInTransaction(client, user, request.writer.sessionId)) {
      refuse('native_session_archived')
    }
    const active = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pe_sessions
      WHERE user_id=$1 AND id<>$2 AND lease_until>clock_timestamp()`, [user, request.writer.sessionId])
    const count = active.rows[0]?.count
    if (count === undefined) corrupt()
    if (!next || count >= this.limits.maxActivePerUser) {
      if (next && next.operation.attempts > 0) {
        const parked = await client.query(`UPDATE pe_operations SET state='queued'
          WHERE id=$1 AND session_id=$2 AND state=$3 AND attempts=$4 RETURNING id`,
        [next.origin.originOperationId, next.origin.sessionId, next.operation.state, next.operation.attempts])
        if (parked.rowCount !== 1) refuse('native_continuation_v2_pending_changed')
        await this.endPriorAttempts(client, next.origin.originOperationId, storageEpoch(request))
      }
      const cleared = await client.query(`UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND grant_digest=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp() RETURNING id`,
      [request.writer.sessionId, digest(request.from.operationToken), storageEpoch(request)])
      if (cleared.rowCount !== 1) refuse('lease_lost')
      return { kind: 'parked', reason: next ? 'capacity' : 'empty' }
    }
    const origin = next.origin
    if (storageEpoch(request) >= 2_147_483_647) refuse('native_continuation_v2_epoch')
    if (next.operation.attempts > 0) {
      await this.endPriorAttempts(client, origin.originOperationId, storageEpoch(request))
    }
    const rows = await client.query<{ epoch: number; expiresAt: number }>(`UPDATE pe_sessions SET lease_epoch=lease_epoch+1,
      grant_digest=$2,lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp()
      WHERE id=$1 AND grant_digest=$4 AND lease_epoch=$5 AND lease_until>clock_timestamp()
      RETURNING lease_epoch AS epoch,floor(extract(epoch FROM lease_until)*1000)::double precision AS "expiresAt"`,
    [request.writer.sessionId, digest(request.candidateToken), this.limits.leaseMs,
      digest(request.from.operationToken), storageEpoch(request)])
    const issued = rows.rows[0]
    if (!issued) refuse('lease_lost')
    const changed = await client.query(`UPDATE pe_operations SET state='running',attempts=attempts+1
      WHERE id=$1 AND session_id=$2 AND state=$3 AND attempts=$4 RETURNING id`,
    [origin.originOperationId, origin.sessionId, next.operation.state, next.operation.attempts])
    if (changed.rowCount !== 1) refuse('native_continuation_v2_pending_changed')
    await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,$2,$3)',
      [origin.originOperationId, issued.epoch, request.writer.workerId])
    if (next.operation.attempts > 0) {
      if (!this.preparedRecovery) refuse('native_continuation_v2_recovery_unavailable')
      const recovered = await this.preparedRecovery.recoverPreparedInTransaction(client,
        { writer: request.writer, operationToken: request.candidateToken })
      if (recovered.kind !== 'prepared' || recovered.grant.operationId !== origin.originOperationId
        || recovered.grant.epoch !== issued.epoch || recovered.grant.token !== request.candidateToken
        || recovered.frame.writerEpoch !== request.writer.epoch || recovered.frame.preparedEventCount !== request.expectedEventCount) {
        refuse('native_continuation_v2_pending_changed')
      }
      const { token: _token, ...metadata } = recovered.grant
      const frozen = nativeContinuationSavedGrantV2.parse(metadata)
      this.bytes({ frame: recovered.frame, frozen }, this.limits.maxAcceptedAuditBytes)
      return { kind: 'prepared', frame: recovered.frame, grant: frozen, expiresAt: issued.expiresAt }
    }
    const restored = await this.tasks.restoreGrantInTransaction(client, origin.originOperationId, request.candidateToken, issued.epoch)
    const frozen = snapshot(origin.acceptedAudit, restored, issued.epoch, this.limits.maxEventBytes)
    const frame = nativeExecutionFrame.parse({ version: 2, phase: 'prepared', sessionId: origin.sessionId,
      operationId: origin.originOperationId, operationEpoch: issued.epoch, writerEpoch: request.writer.epoch,
      requestId: origin.originalRequestId, messageId: origin.messageId, candidateOriginInputId: origin.originInputId,
      frozenSnapshotDigest: ledgerFrozenSnapshotDigest(frozen), preparedEventCount: request.expectedEventCount })
    this.bytes({ frame, frozen }, this.limits.maxAcceptedAuditBytes)
    await client.query(`INSERT INTO pe_native_turn_frames(operation_id,operation_epoch,session_id,writer_epoch,request_id,
      message_id,grant_digest,frame_json,grant_json,prepared_event_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [frame.operationId, frame.operationEpoch, frame.sessionId, frame.writerEpoch, frame.requestId, frame.messageId,
      digest(request.candidateToken), JSON.stringify(frame), JSON.stringify(frozen), frame.preparedEventCount])
    const verified = await this.frameVerifier(client, { kind: 'read', expected: reference(frame),
      authority: { writer: request.writer, operationToken: request.candidateToken } })
    if (verified.owner !== null || !isDeepStrictEqual(verified.frozenSnapshot, frozen)) corrupt()
    return { kind: 'prepared', frame, grant: frozen, expiresAt: issued.expiresAt }
  }

  private async live(client: PoolClient, request: NativeTurnTransitionV2, result: Extract<NativeTurnReceiptV2['result'], { kind: 'prepared' }>) {
    return (await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.id=$4 AND o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3 JOIN pe_native_writers w ON w.session_id=s.id
      WHERE s.id=$1 AND s.grant_digest=$2 AND s.lease_epoch=$3 AND s.lease_until>clock_timestamp()
        AND o.state='running' AND a.ended_at IS NULL AND a.worker_id=w.worker_id AND w.worker_id=$5
        AND w.epoch=$6 AND w.token_digest=$7 AND w.expires_at>clock_timestamp()`,
    [request.writer.sessionId, digest(request.candidateToken), result.frame.operationEpoch, result.frame.operationId,
      request.writer.workerId, request.writer.epoch, digest(request.writer.token)])).rowCount === 1
  }

  private async response(client: PoolClient, request: NativeTurnTransitionV2, receipt: NativeTurnReceiptV2,
    replayed: boolean): Promise<NativeTurnResponseV2> {
    try { return await this.currentResponse(client, request, receipt, replayed) }
    catch (error) {
      if (!replayed || receipt.result.kind !== 'prepared' || !(error instanceof PlatformError)
        || error.status !== 409 || !['native_writer_lost', 'lease_lost', 'native_input_authority_lost',
        'native_execution_frame_lease_lost'].includes(error.code)
        || await this.live(client, request, receipt.result)) throw error
      // Full original credentials were proved before this read; a fresh PG tuple now proves their live scope was lost.
      return nativeTurnResponseV2.parse({ receipt, replayed: true, current: { kind: 'expired' } })
    }
  }

  private async currentResponse(client: PoolClient, request: NativeTurnTransitionV2, receipt: NativeTurnReceiptV2,
    replayed: boolean): Promise<NativeTurnResponseV2> {
    let current: NativeTurnResponseV2['current'] = { kind: 'expired' }
    if (receipt.result.kind === 'parked') {
      const idle = await client.query(`SELECT 1 FROM pe_sessions s WHERE s.id=$1 AND s.grant_digest IS NULL AND s.lease_until IS NULL
        AND NOT EXISTS(SELECT 1 FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
          WHERE o.session_id=s.id AND o.state='running' AND a.ended_at IS NULL)`, [request.writer.sessionId])
      if (idle.rowCount === 1) current = { kind: 'parked' }
    } else if (await this.live(client, request, receipt.result)) {
      const verified = await this.frameVerifier(client, { kind: 'read', expected: reference(receipt.result.frame),
        authority: { writer: request.writer, operationToken: request.candidateToken } })
      if (!isDeepStrictEqual(verified.frozenSnapshot, receipt.result.grant)) corrupt()
      const frame = await this.frame(client, verified.operationId, verified.operationEpoch)
      if (frame.phase !== 'prepared' && frame.phase !== 'claimed') corrupt()
      current = { kind: 'live', frame, grant: grant.parse({ ...receipt.result.grant, token: request.candidateToken }) }
    }
    if (!replayed || current.kind === 'live') await this.writers.assertLiveInTransaction(client, request.writer)
    if (current.kind === 'live' && receipt.result.kind === 'prepared'
      && !await this.live(client, request, receipt.result)) current = { kind: 'expired' }
    return nativeTurnResponseV2.parse({ receipt, replayed, current })
  }

  private async finalFence(client: PoolClient, request: NativeTurnTransitionV2, oldDeadline: string,
    presentationDeadline: string): Promise<void> {
    await this.writers.assertLiveInTransaction(client, request.writer)
    const live = await client.query(`SELECT s.id FROM pe_sessions s
      JOIN pe_native_writers w ON w.session_id=s.id WHERE s.id=$1
      AND w.worker_id=$7 AND w.epoch=$8 AND w.token_digest=$9 AND w.expires_at>clock_timestamp()
      AND $2::timestamptz>clock_timestamp() AND $3::timestamptz>clock_timestamp()
      AND ((s.grant_digest IS NULL AND s.lease_until IS NULL AND NOT EXISTS(
          SELECT 1 FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
          WHERE o.session_id=s.id AND o.state='running' AND a.ended_at IS NULL))
        OR (s.grant_digest=$4 AND s.lease_until>clock_timestamp() AND s.lease_epoch=$5::bigint AND EXISTS(
          SELECT 1 FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
          WHERE o.id=$6 AND o.session_id=s.id AND o.state='running' AND a.ended_at IS NULL AND a.worker_id=$7)))`,
    [request.writer.sessionId, oldDeadline, presentationDeadline, digest(request.candidateToken),
      storageEpoch(request) + 1, request.expectedNext?.operationId ?? null, request.writer.workerId,
      request.writer.epoch, digest(request.writer.token)])
    if (live.rowCount !== 1) refuse('native_continuation_v2_expired')
  }
}
