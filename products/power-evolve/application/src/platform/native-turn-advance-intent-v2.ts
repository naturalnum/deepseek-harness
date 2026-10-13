/** Read-only PG preparation of one retained v2 continuation intent; no execution authority is created. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { eventSeq, type InputOrigin, type NativeInputFrameVerifier, type NativeInputVerifiedFrame,
  type NativeInputLedgerLimits } from '../native-input-ledger-contracts.ts'
import { foldInputHistory, readInputClaim, readInputOrigin, readInputRevision,
  type NativeInputHistory } from '../native-input-ledger-records.ts'
import { readNativeAssistantState, validateNativeAssistantLimits, type NativeAssistantLimits } from '../native-assistant-records.ts'
import { nativeTurnSealV2, nativeTurnTransitionV2, type NativeTurnTransitionV2 } from '../native-turn-continuation-v2-contracts.ts'
import { nativeTransitionId } from '../native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterToken } from '../native-writer-contracts.ts'
import { headerSchema } from '../session-records.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'
import { nativeInputLedgerLimitsSchema, readStoredNativeInputCohort, nativeInputCohortConflict } from './native-input-ledger.ts'
import { readNativeTurnHistory } from './native-turn-history.ts'
import type { TaskStore } from './tasks.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { NativeExecutionFrames } from './native-execution-frames.ts'

/** Only retained Host identities and an actual publisher seal enter the preparer; PG supplies all source and queue coordinates. */
export const nativeTurnAdvanceIntentV2Input = z.object({ writer: nativeWriterIdentity,
  transitionId: nativeTransitionId, candidateToken: nativeWriterToken, seal: nativeTurnSealV2,
  kind: z.literal('reconcile').optional() }).strict()
/** Strict internal preparation input, separate from the resulting retained continuation request. */
export type NativeTurnAdvanceIntentV2Input = z.infer<typeof nativeTurnAdvanceIntentV2Input>
/** Deployment-owned bounds for the full native prefix and immutable ledger/presentation reads. */
export interface NativeTurnAdvanceIntentV2Limits extends Pick<NativeInputLedgerLimits,
  'maxAcceptedAuditBytes' | 'maxRevisionBytes' | 'maxCohortInputs' | 'maxHistoryEvents' | 'maxHistoryBytes' | 'maxCommandBytes'> {
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
const presentationRow = z.object({ epoch: eventSeq.min(1), publisherId: z.uuid(), lastOrdinal: eventSeq,
  state: z.unknown() }).strict()
function refuse(code: string): never { throw new PlatformError(409, code) }
function reference(frame: NativeInputVerifiedFrame) {
  return { sessionId: frame.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
    writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest }
}

/** Produces one candidate from actual committed native state; continuation re-proves it in its separate settlement transaction. */
export class NativeTurnAdvanceIntentV2 {
  private readonly limits: NativeTurnAdvanceIntentV2Limits

  /**
   * @param tasks Actual Platform operation/database authority.
   * @param writers Actual independent Session Writer provider.
   * @param frameVerifier Required actual Root frames.verifyInTransaction provider; read never binds or rewrites an owner.
   * @param limits Explicit full-history, ledger-record, cohort and presentation bounds.
   * @param consumedRecovery Actual historical provider; reconciliation is refused when it is unavailable.
   */
  constructor(private readonly tasks: TaskStore, private readonly writers: NativeSessionWriter,
    private readonly frameVerifier: NativeInputFrameVerifier, limits: NativeTurnAdvanceIntentV2Limits,
    private readonly consumedRecovery?: Pick<NativeExecutionFrames, 'readConsumedInTransaction'>) {
    const { assistant, ...numbers } = limits
    this.limits = { ...nativeInputLedgerLimitsSchema.omit({ maxEventBytes: true }).parse(numbers),
      assistant: validateNativeAssistantLimits(assistant) }
  }

  /** Generate an exact retained advance request without settling, issuing, renewing or changing PG records.
   * @param operationToken Current original operation bearer, never recovered from a receipt or fabricated from inputs.
   * @param input Host-retained identities and actual publisher seal; no caller supplies phase, claims or pending revisions.
   * @returns Candidate only; retain it unchanged and call continuation.transition under a quiet before-next-turn hook.
   */
  async prepare(operationToken: string, input: unknown): Promise<NativeTurnTransitionV2> {
    const parsed = nativeTurnAdvanceIntentV2Input.safeParse(input), token = nativeWriterToken.safeParse(operationToken)
    if (!parsed.success || !token.success) throw new PlatformError(400, 'invalid_request')
    const request = parsed.data
    if (Buffer.byteLength(JSON.stringify(request)) > this.limits.maxCommandBytes) throw new PlatformError(413, 'native_advance_intent_v2_budget')
    return transaction(this.tasks.pool, async (client) => {
      const writer = await this.writers.requireInTransaction(client, request.writer)
      const session = await this.tasks.authorized(client, token.data)
      if (session.id !== request.writer.sessionId || session.user_id !== writer.userId) refuse('native_advance_intent_v2_identity')
      if (request.kind === 'reconcile' && !this.consumedRecovery) refuse('native_advance_intent_v2_recovery_unavailable')
      const historical = request.kind === 'reconcile' ? await this.consumedRecovery?.readConsumedInTransaction(client,
        { writer: request.writer, operationToken: token.data }) : undefined
      const frame = historical?.frame ?? await this.frameVerifier(client, { kind: 'read', expected: null,
        authority: { writer: request.writer, operationToken: token.data } })
      if (frame.owner === null) refuse('native_advance_intent_v2_unclaimed')
      if (frame.sessionId !== session.id || frame.operationId !== session.operation_id || frame.frozenSnapshot.userId !== session.user_id
        || (historical ? frame.operationEpoch >= session.lease_epoch
          : frame.operationEpoch !== session.lease_epoch || frame.writerEpoch !== request.writer.epoch)) {
        refuse('native_advance_intent_v2_identity')
      }
      const stored = await readNativeTurnHistory(client, frame.sessionId, this.limits)
      const history = foldInputHistory(headerSchema.parse(session.header), stored.events), owner = frame.owner
      const end = history.events.find(event => event.type === 'turn/end' && event.seq > owner.turnStartSeq && event.data.turn === owner.turn)
      const last = history.events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
      if (end?.type !== 'turn/end' || last !== end || history.turn !== null || history.step !== null
        || end.seq <= owner.claimSpliceSeq) refuse('native_advance_intent_v2_not_closed')
      const cohorts = await this.cohorts(client, frame, history, end.seq)
      const next = await this.pending(client, frame, history)
      await this.presentation(client, request, frame, history, session.lease_epoch)
      const result = nativeTurnTransitionV2.parse({ version: 2,
        ...historical ? { kind: 'reconcile', storageOperationEpoch: session.lease_epoch } : { kind: 'advance' }, writer: request.writer,
        transitionId: request.transitionId, candidateToken: request.candidateToken, seal: request.seal,
        expectedEventCount: history.eventCount, expectedQueueRevision: stored.queueRevision, expectedNext: next,
        from: { frame: reference(frame), operationToken: token.data, turn: owner.turn, turnStartSeq: owner.turnStartSeq,
          turnEndSeq: end.seq, cohortIds: cohorts.ids, claimedOriginInputIds: cohorts.origins } })
      if (Buffer.byteLength(JSON.stringify(result)) > this.limits.maxCommandBytes) throw new PlatformError(413, 'native_advance_intent_v2_budget')
      if (historical) {
        const again = await this.consumedRecovery?.readConsumedInTransaction(client,
          { writer: request.writer, operationToken: token.data })
        if (!again || !isDeepStrictEqual(again, historical)) refuse('native_advance_intent_v2_identity')
      } else await this.frameVerifier(client, { kind: 'read', expected: reference(frame),
        authority: { writer: request.writer, operationToken: token.data } })
      await this.writers.assertLiveInTransaction(client, request.writer)
      await this.clocks(client, token.data, request, frame, session.lease_epoch)
      return result
    })
  }

  private async bounded(client: PoolClient, sql: string, params: unknown[], maximum: number): Promise<void> {
    const row = (await client.query<{ bytes: number }>(sql, params)).rows[0]
    if (!row) refuse('native_advance_intent_v2_proof_missing')
    if (row.bytes > maximum) throw new PlatformError(413, 'native_advance_intent_v2_budget')
  }

  private async origin(client: PoolClient, frame: NativeInputVerifiedFrame, id: string): Promise<InputOrigin> {
    await this.bounded(client, `SELECT octet_length(accepted_audit_json::text) AS bytes FROM pe_native_input_origins
      WHERE session_id=$1 AND origin_input_id=$2`, [frame.sessionId, id], this.limits.maxAcceptedAuditBytes)
    const row = (await client.query<Record<string, unknown>>(`SELECT ${originColumns} FROM pe_native_input_origins
      WHERE session_id=$1 AND origin_input_id=$2`, [frame.sessionId, id])).rows[0]
    const origin = readInputOrigin(row)
    if (origin.acceptedAudit.userId !== frame.frozenSnapshot.userId) refuse('native_advance_intent_v2_origin')
    return origin
  }

  private async revision(client: PoolClient, origin: InputOrigin, number?: number) {
    const params = [origin.originInputId, origin.sessionId, number ?? null]
    await this.bounded(client, `SELECT octet_length(message_json::text) AS bytes FROM pe_native_input_revisions
      WHERE origin_input_id=$1 AND session_id=$2 AND ($3::integer IS NULL OR input_revision=$3)
      ORDER BY input_revision DESC LIMIT 1`, params, this.limits.maxRevisionBytes)
    const row = (await client.query<Record<string, unknown>>(`SELECT ${revisionColumns} FROM pe_native_input_revisions
      WHERE origin_input_id=$1 AND session_id=$2 AND ($3::integer IS NULL OR input_revision=$3)
      ORDER BY input_revision DESC LIMIT 1`, params)).rows[0]
    const revision = readInputRevision(row)
    if (revision.message.id !== origin.messageId) refuse('native_advance_intent_v2_revision')
    return revision
  }

  private async cohorts(client: PoolClient, frame: NativeInputVerifiedFrame, history: NativeInputHistory, end: number) {
    const owner = frame.owner
    if (owner === null) refuse('native_advance_intent_v2_unclaimed')
    const bound = (await client.query<{ count: number; claims: number }>(`SELECT count(*)::integer AS count,
      COALESCE(sum(claim_count),0)::double precision AS claims FROM pe_native_input_cohorts
      WHERE session_id=$1 AND turn_start_seq=$2`, [frame.sessionId, owner.turnStartSeq])).rows[0]
    if (!bound || bound.count < 1 || bound.count > this.limits.maxHistoryEvents || bound.claims > this.limits.maxCohortInputs) {
      refuse('native_advance_intent_v2_cohort_budget')
    }
    const rows = (await client.query<Record<string, unknown>>(`SELECT cohort_id AS "cohortId",session_id AS "sessionId",
      execution_operation_id AS "operationId",operation_epoch::double precision AS "operationEpoch",writer_epoch::double precision AS "writerEpoch",
      frozen_snapshot_digest AS "frozenSnapshotDigest",owner_kind AS "ownerKind",owner_origin_input_id AS "originInputId",
      owner_input_revision AS "inputRevision",owner_input_digest AS "inputDigest",turn_start_seq AS "turnStartSeq",turn_number AS turn,
      boundary_ordinal AS "boundaryOrdinal",step_start_seq AS "stepStartSeq",claim_count AS "claimCount",command_id AS "commandId"
      FROM pe_native_input_cohorts WHERE session_id=$1 AND turn_start_seq=$2 ORDER BY boundary_ordinal LIMIT $3`,
    [frame.sessionId, owner.turnStartSeq, this.limits.maxHistoryEvents + 1])).rows
    const native = history.claims.filter(claim => claim.turnStartSeq === owner.turnStartSeq)
    const steps = history.events.slice(owner.turnStartSeq, end).filter(event => event.type === 'step/start')
    const origins: InputOrigin[] = [], ids: NativeTurnTransitionV2['from']['cohortIds'] = [], proved: typeof native = []
    for (const [ordinal, row] of rows.entries()) {
      const claims = (await client.query<Record<string, unknown>>(`SELECT ${claimColumns} FROM pe_native_input_claims
        WHERE session_id=$1 AND cohort_id=$2 ORDER BY cohort_ordinal LIMIT $3`,
      [frame.sessionId, row.cohortId, this.limits.maxCohortInputs + 1])).rows.map(readInputClaim)
      const cohort = readStoredNativeInputCohort(row, claims)
      if (nativeInputCohortConflict(cohort, claims, ordinal, frame, owner)
        || cohort.stepStartSeq !== (steps[ordinal]?.seq ?? null)
        || (cohort.stepStartSeq === null && ordinal !== rows.length - 1)
        || (ordinal === 0 ? cohort.cohortId !== owner.cohortId || cohort.owner.kind === 'current-frame'
          : cohort.owner.kind !== 'current-frame')) refuse('native_advance_intent_v2_cohort_incomplete')
      ids.push(cohort.cohortId)
      for (const claim of claims) {
        const origin = await this.origin(client, frame, claim.originInputId)
        const revision = await this.revision(client, origin, claim.inputRevision)
        const actual = native.find(value => value.seq === claim.claimSpliceSeq && value.itemOrdinal === claim.spliceItemOrdinal)
        if (claim.sessionId !== frame.sessionId || claim.cohortId !== cohort.cohortId || claim.inputDigest !== revision.inputDigest
          || actual?.target !== claim.target || !isDeepStrictEqual(actual.message, revision.message)
          || claim.claimSpliceSeq <= owner.turnStartSeq || claim.claimSpliceSeq >= end
          || (cohort.stepStartSeq !== null && claim.claimSpliceSeq >= cohort.stepStartSeq)) refuse('native_advance_intent_v2_claim')
        origins.push(origin); proved.push(actual)
      }
    }
    if (steps.length > rows.length || !isDeepStrictEqual(proved, native)
      || new Set(origins.map(origin => origin.originInputId)).size !== origins.length
      || !origins.some(origin => origin.originInputId === owner.originInputId && origin.originOperationId === frame.operationId)) {
      refuse('native_advance_intent_v2_cohort_incomplete')
    }
    return { ids, origins: origins.map(origin => origin.originInputId) }
  }

  private async pending(client: PoolClient, frame: NativeInputVerifiedFrame, history: NativeInputHistory) {
    const head = history.inbox['next-turn'][0] ?? history.inbox['next-step'][0]
    if (!head) return null
    const located = (await client.query<{ id: string }>(`SELECT origin_input_id AS id FROM pe_native_input_origins
      WHERE session_id=$1 AND message_id=$2`, [frame.sessionId, head.id])).rows[0]
    if (!located) refuse('native_advance_intent_v2_origin')
    const origin = await this.origin(client, frame, located.id), revision = await this.revision(client, origin)
    const consumed = await client.query(`SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$1
      UNION ALL SELECT 1 FROM pe_native_input_commands WHERE target_origin_input_id=$1 AND kind='remove'`, [origin.originInputId])
    if (consumed.rowCount || history.claims.some(claim => claim.message.id === head.id)
      || !isDeepStrictEqual(revision.message, head) || revision.committedSpliceSeq >= history.eventCount) refuse('native_advance_intent_v2_pending')
    return { originInputId: origin.originInputId, operationId: origin.originOperationId, messageId: origin.messageId,
      inputRevision: revision.inputRevision, inputDigest: revision.inputDigest,
      target: history.inbox['next-turn'].length > 0 ? 'next-turn' as const : 'next-step' as const }
  }

  private async presentation(client: PoolClient, request: NativeTurnAdvanceIntentV2Input, frame: NativeInputVerifiedFrame,
    history: NativeInputHistory, storageEpoch: number): Promise<void> {
    const maximum = this.limits.assistant.maxActiveBytes + this.limits.assistant.maxRingBytes + this.limits.assistant.maxBatchBytes
    await this.bounded(client, 'SELECT octet_length(state_json) AS bytes FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE',
      [frame.sessionId], maximum)
    const raw = (await client.query<Record<string, unknown>>(`SELECT epoch,publisher_id AS "publisherId",
      last_ordinal::double precision AS "lastOrdinal",state_json AS state FROM pe_native_presentations WHERE session_id=$1`, [frame.sessionId])).rows[0]
    const decoded = presentationRow.safeParse(raw)
    if (!decoded.success) refuse('native_advance_intent_v2_seal')
    const row = decoded.data, state = readNativeAssistantState(row.state, this.limits.assistant)
    if (request.seal.eventCount !== history.eventCount || row.epoch !== storageEpoch || row.epoch !== state.epoch
      || row.publisherId !== request.seal.publisherId || state.publisherId !== row.publisherId
      || row.lastOrdinal !== state.lastOrdinal || state.lastOrdinal !== request.seal.lastOrdinal
      || state.revision !== request.seal.revision || state.cursor !== history.eventCount - 1
      || state.activeAttempt !== undefined || state.awaitingStepEnd !== undefined) refuse('native_advance_intent_v2_seal')
  }

  private async clocks(client: PoolClient, operationToken: string, request: NativeTurnAdvanceIntentV2Input,
    frame: NativeInputVerifiedFrame, storageEpoch: number): Promise<void> {
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3 JOIN pe_native_writers w ON w.session_id=s.id
      JOIN pe_native_presentations p ON p.session_id=s.id WHERE s.id=$1 AND s.grant_digest=$4 AND s.lease_epoch=$3
        AND s.lease_until>clock_timestamp() AND o.state='running' AND a.ended_at IS NULL AND a.worker_id=$5
        AND w.worker_id=$5 AND w.epoch=$6 AND w.token_digest=$7 AND w.expires_at>clock_timestamp()
        AND p.epoch=$3 AND p.publisher_id=$8 AND p.expires_at>clock_timestamp()`,
    [frame.sessionId, frame.operationId, storageEpoch, digest(operationToken), request.writer.workerId,
      request.writer.epoch, digest(request.writer.token), request.seal.publisherId])
    if (live.rowCount !== 1) refuse('native_advance_intent_v2_expired')
  }
}
