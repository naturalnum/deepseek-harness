/** Business execution requires a complete claimed cohort bound to the current open native step. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, operationId, sessionId, userId } from '../contracts.ts'
import { nativeOperationEpoch, nativeTurnMessageId } from '../native-turn-contracts.ts'
import { nativeWriterEpoch, nativeWriterWorkerId } from '../native-writer-contracts.ts'
import { eventSeq, inputCohortId, inputCommandId, inputRevisionNumber, originInputId, recordDigest,
  type NativeInputVerifiedFrame } from '../native-input-ledger-contracts.ts'
import { foldInputHistory, readInputClaim, readInputReceipt, readInputRevision } from '../native-input-ledger-records.ts'
import { headerSchema } from '../session-records.ts'
import { readNativeTurnHistory } from './native-turn-history.ts'
import { digest } from './identity.ts'
import type { TaskExecutionAuthority } from './tasks.ts'

type AuthorizedSession = Parameters<TaskExecutionAuthority>[1]

/** Execution history and individual durable proof bounds are mandatory deployment inputs. */
export interface NativeExecutionAuthorityLimits {
  readonly maxHistoryEvents: number
  readonly maxHistoryBytes: number
  readonly maxCohortInputs: number
  readonly maxFactBytes: number
}

/** Required actual PG v2 read provider, using the already authenticated original operation.
 * @param client Caller transaction already holding actual account and Session locks.
 * @param session Exact TaskStore.authorized result.
 * @param token Current original operation bearer.
 * @returns Exact claimed owner and frozen metadata after independent full-cohort and PG Writer checks.
 */
export type NativeExecutionFrameReader = (client: PoolClient, session: AuthorizedSession,
  token: string) => Promise<NativeInputVerifiedFrame>

const limitsSchema = z.object({ maxHistoryEvents: eventSeq.min(1).max(2_147_483_646),
  maxHistoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), maxCohortInputs: eventSeq.min(1),
  maxFactBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
const cohortSchema = z.object({ cohortId: inputCohortId, sessionId, operationId, operationEpoch: nativeOperationEpoch,
  writerEpoch: nativeWriterEpoch, frozenSnapshotDigest: recordDigest,
  ownerKind: z.enum(['next-turn-head', 'first-next-step', 'current-frame']), ownerOriginInputId: originInputId,
  ownerInputRevision: inputRevisionNumber, ownerInputDigest: recordDigest, turnStartSeq: eventSeq,
  turn: eventSeq.min(1), boundaryOrdinal: eventSeq, stepStartSeq: eventSeq, claimCount: eventSeq, commandId: inputCommandId,
}).strict()
const receiptColumns = z.object({ sessionId, commandId: inputCommandId, userId, actorKind: z.literal('writer'),
  actorId: nativeWriterWorkerId, writerEpoch: nativeWriterEpoch, rpcNonce: z.string().min(1).max(128),
  payloadDigest: recordDigest, kind: z.literal('claim'), targetOriginInputId: z.null(), eventCount: eventSeq,
  receipt: z.unknown(), bytes: eventSeq }).strict()
const claimColumns = z.object({ claim: z.unknown(), revision: z.unknown(), messageId: nativeTurnMessageId }).strict()

function refuse(code: string): never { throw new PlatformError(409, code) }
function corrupt(): never { throw new PlatformError(503, 'native_execution_authority_corrupt') }

/** Compatible with TaskExecutionAuthority; Root installs it explicitly after the native carrier is active. */
export class NativeExecutionAuthority {
  private readonly limits: NativeExecutionAuthorityLimits

  /**
   * @param frameReader Actual version-two PG read provider; prepared frames never grant execution.
   * @param limits Explicit bounded history, cohort and durable-record reads.
   */
  constructor(private readonly frameReader: NativeExecutionFrameReader, limits: NativeExecutionAuthorityLimits) {
    this.limits = limitsSchema.parse(limits)
  }

  /** Require the original claimed owner and one complete cohort bound to the current open native step.
   * @param client Caller transaction holding the account and Session locks acquired by TaskStore.authorized.
   * @param session Actual current TaskStore authorization result, never a manufactured Session row.
   * @param token Original operation bearer; its identity and both lease clocks are rechecked after all proof reads.
   * @returns Completion only when current business execution is authorized; no grant or lease is created or renewed.
   */
  async assertExecutionInTransaction(client: PoolClient, session: AuthorizedSession, token: string): Promise<void> {
    const frame = await this.frameReader(client, session, token)
    if (frame.operationId !== session.operation_id || frame.operationEpoch !== session.lease_epoch || frame.sessionId !== session.id
      || frame.frozenSnapshot.userId !== session.user_id) {
      refuse('native_execution_authority_identity')
    }
    if (frame.owner === null) refuse('native_execution_step_unclaimed')
    const stored = await readNativeTurnHistory(client, frame.sessionId, this.limits)
    const history = foldInputHistory(headerSchema.parse(session.header), stored.events)
    const step = history.step, turn = history.turn
    if (step === null || turn === null || turn.seq !== frame.owner.turnStartSeq || turn.turn !== frame.owner.turn
      || step.turn !== frame.owner.turn) refuse('native_execution_step_unclaimed')
    const rows = await client.query<Record<string, unknown>>(`SELECT cohort_id AS "cohortId",session_id AS "sessionId",
      execution_operation_id AS "operationId",operation_epoch::double precision AS "operationEpoch",
      writer_epoch::double precision AS "writerEpoch",frozen_snapshot_digest AS "frozenSnapshotDigest",
      owner_kind AS "ownerKind",owner_origin_input_id AS "ownerOriginInputId",owner_input_revision AS "ownerInputRevision",
      owner_input_digest AS "ownerInputDigest",turn_start_seq AS "turnStartSeq",turn_number AS turn,
      boundary_ordinal AS "boundaryOrdinal",step_start_seq AS "stepStartSeq",claim_count AS "claimCount",command_id AS "commandId"
      FROM pe_native_input_cohorts WHERE session_id=$1 AND step_start_seq=$2 LIMIT 2`, [frame.sessionId, step.seq])
    if (rows.rows.length !== 1) refuse('native_execution_step_unbound')
    const decoded = cohortSchema.safeParse(rows.rows[0])
    if (!decoded.success) corrupt()
    const cohort = decoded.data
    if (cohort.operationId !== frame.operationId || cohort.operationEpoch !== frame.operationEpoch
      || cohort.writerEpoch !== frame.writerEpoch || cohort.frozenSnapshotDigest !== frame.frozenSnapshotDigest
      || cohort.ownerOriginInputId !== frame.owner.originInputId || cohort.ownerInputRevision !== frame.owner.inputRevision
      || cohort.ownerInputDigest !== frame.owner.inputDigest || cohort.turnStartSeq !== turn.seq || cohort.turn !== turn.turn
      || cohort.boundaryOrdinal !== history.events.slice(turn.seq + 1, step.seq).filter(event => event.type === 'step/start').length
      || (cohort.boundaryOrdinal === 0 ? cohort.cohortId !== frame.owner.cohortId || cohort.ownerKind === 'current-frame'
        : cohort.ownerKind !== 'current-frame')) refuse('native_execution_cohort_identity')
    if (cohort.claimCount > this.limits.maxCohortInputs) throw new PlatformError(413, 'native_execution_cohort_budget')
    const receipt = await this.receipt(client, frame, cohort.commandId)
    if (receipt.result.kind !== 'claimed' || receipt.result.cohortId !== cohort.cohortId
      || receipt.eventCount > step.seq || receipt.eventCount <= turn.seq) refuse('native_execution_cohort_incomplete')
    const sizes = await client.query<{ count: number; bytes: number }>(`SELECT count(*)::integer AS count,
      COALESCE(max(octet_length(r.message_json::text)),0)::integer AS bytes FROM pe_native_input_claims c
      JOIN pe_native_input_revisions r ON r.origin_input_id=c.origin_input_id AND r.input_revision=c.input_revision
      WHERE c.cohort_id=$1 AND c.session_id=$2`, [cohort.cohortId, frame.sessionId])
    const size = sizes.rows[0]
    if (!size || size.count !== cohort.claimCount) refuse('native_execution_cohort_incomplete')
    if (size.bytes > this.limits.maxFactBytes) throw new PlatformError(413, 'native_execution_fact_budget')
    const facts = await client.query<Record<string, unknown>>(`SELECT jsonb_build_object('originInputId',c.origin_input_id,
      'sessionId',c.session_id,'inputRevision',c.input_revision,'inputDigest',c.input_digest,'cohortId',c.cohort_id,
      'claimSpliceSeq',c.claim_splice_seq,'spliceItemOrdinal',c.splice_item_ordinal,'cohortOrdinal',c.cohort_ordinal,'target',c.target) AS claim,
      jsonb_build_object('originInputId',r.origin_input_id,'sessionId',r.session_id,'inputRevision',r.input_revision,
      'previousRevision',r.previous_revision,'cause',r.cause,'message',r.message_json,'inputDigest',r.input_digest,
      'committedSpliceSeq',r.committed_splice_seq,'commandId',r.command_id) AS revision,o.message_id AS "messageId"
      FROM pe_native_input_claims c JOIN pe_native_input_revisions r ON r.origin_input_id=c.origin_input_id AND r.input_revision=c.input_revision
      JOIN pe_native_input_origins o ON o.origin_input_id=c.origin_input_id WHERE c.cohort_id=$1 AND c.session_id=$2
      ORDER BY c.cohort_ordinal LIMIT $3`, [cohort.cohortId, frame.sessionId, this.limits.maxCohortInputs + 1])
    const claims = facts.rows.map((raw) => {
      const fact = claimColumns.safeParse(raw)
      if (!fact.success) corrupt()
      const claim = readInputClaim(fact.data.claim), revision = readInputRevision(fact.data.revision)
      if (claim.originInputId !== revision.originInputId || claim.sessionId !== revision.sessionId
        || claim.inputRevision !== revision.inputRevision || claim.inputDigest !== revision.inputDigest
        || fact.data.messageId !== revision.message.id) corrupt()
      return { claim, revision }
    })
    if (claims.length !== cohort.claimCount) refuse('native_execution_cohort_incomplete')
    const sequences = [...new Set(claims.map(fact => fact.claim.claimSpliceSeq))].sort((left, right) => left - right)
    if (!isDeepStrictEqual(sequences, receipt.committedSpliceSeqs)) refuse('native_execution_cohort_incomplete')
    const firstSequence = sequences[0] ?? receipt.eventCount
    if (firstSequence <= turn.seq || (sequences.length > 0 && sequences.at(-1) !== receipt.eventCount - 1)) {
      refuse('native_execution_cohort_incomplete')
    }
    const prefix = foldInputHistory(history.header, history.events.slice(0, firstSequence))
    if (prefix.turn?.seq !== turn.seq || prefix.step !== null) refuse('native_execution_cohort_incomplete')
    const required = [
      ...prefix.inbox['next-step'].map((message, index) => ({ message, target: 'next-step' as const, index })),
      ...(cohort.boundaryOrdinal === 0 ? prefix.inbox['next-turn'].slice(0, 1)
        .map(message => ({ message, target: 'next-turn' as const, index: 0 })) : []),
    ]
    if (required.length !== claims.length) refuse('native_execution_cohort_incomplete')
    let sequence = firstSequence
    const coordinates = new Map<'next-step' | 'next-turn', number>()
    for (const target of ['next-step', 'next-turn'] as const) {
      const count = required.filter(item => item.target === target).length
      if (count === 0) continue
      const event = history.events[sequence]
      if (event?.type !== 'agent/inbox/spliced' || event.data.target !== target || event.data.start !== 0
        || event.data.removedCount !== count || event.data.inserted.length !== 0 || event.data.outcome !== undefined) {
        refuse('native_execution_cohort_incomplete')
      }
      coordinates.set(target, sequence++)
    }
    if (sequence !== receipt.eventCount || history.events.slice(receipt.eventCount, step.seq).some(event =>
      event.type === 'agent/inbox/spliced' && event.data.outcome !== 'canceled' && (event.data.removedCount ?? 0) > 0)) {
      refuse('native_execution_cohort_incomplete')
    }
    for (const [index, item] of required.entries()) {
      const fact = claims[index]
      if (!fact || fact.claim.cohortOrdinal !== index || fact.claim.target !== item.target || fact.claim.spliceItemOrdinal !== item.index
        || fact.claim.cohortId !== cohort.cohortId || fact.claim.sessionId !== frame.sessionId
        || fact.claim.claimSpliceSeq !== coordinates.get(item.target) || !isDeepStrictEqual(fact.revision.message, item.message)) {
        refuse('native_execution_cohort_incomplete')
      }
    }
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      JOIN pe_operations o ON o.id=$1 AND o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$2
      WHERE s.id=$3 AND s.user_id=$4 AND s.grant_digest=$5 AND s.lease_epoch=$2 AND s.lease_until>clock_timestamp()
      AND w.epoch=$6 AND w.expires_at>clock_timestamp()
      AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested' AND a.worker_id=w.worker_id AND a.ended_at IS NULL`,
    [frame.operationId, frame.operationEpoch, frame.sessionId, session.user_id, digest(token), frame.writerEpoch])
    if (live.rowCount !== 1) refuse('native_execution_authority_lost')
  }

  private async receipt(client: PoolClient, frame: NativeInputVerifiedFrame,
    commandId: z.infer<typeof inputCommandId>) {
    const sizes = await client.query<{ bytes: number }>('SELECT octet_length(receipt_json::text) AS bytes FROM pe_native_input_commands WHERE session_id=$1 AND command_id=$2',
      [frame.sessionId, commandId])
    if (!sizes.rows[0]) refuse('native_execution_cohort_incomplete')
    if (sizes.rows[0].bytes > this.limits.maxFactBytes) throw new PlatformError(413, 'native_execution_fact_budget')
    const rows = await client.query<Record<string, unknown>>(`SELECT session_id AS "sessionId",command_id AS "commandId",user_id AS "userId",
      actor_kind AS "actorKind",actor_id AS "actorId",writer_epoch::double precision AS "writerEpoch",transport_nonce AS "rpcNonce",
      payload_digest AS "payloadDigest",kind,target_origin_input_id AS "targetOriginInputId",committed_event_count AS "eventCount",
      receipt_json AS receipt,octet_length(receipt_json::text) AS bytes FROM pe_native_input_commands WHERE session_id=$1 AND command_id=$2`,
    [frame.sessionId, commandId])
    const result = receiptColumns.safeParse(rows.rows[0])
    if (!result.success) corrupt()
    const columns = result.data, receipt = readInputReceipt(columns.receipt)
    if (receipt.actor.kind !== 'writer' || receipt.actor.userId !== frame.frozenSnapshot.userId || columns.userId !== receipt.actor.userId
      || columns.actorId !== receipt.actor.workerId
      || receipt.actor.writerEpoch !== frame.writerEpoch || columns.writerEpoch !== receipt.actor.writerEpoch
      || receipt.sessionId !== frame.sessionId || receipt.commandId !== commandId || receipt.kind !== columns.kind
      || receipt.rpcNonce !== columns.rpcNonce || receipt.payloadDigest !== columns.payloadDigest
      || receipt.eventCount !== columns.eventCount) corrupt()
    const actual = await client.query(`SELECT w.session_id FROM pe_native_writers w JOIN pe_attempts a ON a.worker_id=w.worker_id
      WHERE w.session_id=$1 AND w.epoch=$2 AND w.worker_id=$3 AND a.operation_id=$4 AND a.epoch=$5 AND a.ended_at IS NULL`,
    [frame.sessionId, frame.writerEpoch, receipt.actor.workerId, frame.operationId, frame.operationEpoch])
    if (actual.rowCount !== 1) refuse('native_execution_authority_identity')
    return receipt
  }
}
