/** Atomic native turn settlement, preparation and exact historical continuation receipts. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient, QueryResult } from 'pg'
import type { OperationId, Grant, UserId } from '../contracts.ts'
import { operationId, requestId, PlatformError } from '../contracts.ts'
import { z } from 'zod'
import { nativeTurnFrame, nativeTurnPrepare, nativeTurnReceipt, nativeTurnResponse, nativeTurnSavedGrant,
  nativeOperationEpoch, nativeTurnMessageId, nativeTurnTransition,
  type NativeTurnFrame, type NativeTurnReceipt, type NativeTurnResponse,
  type NativeTurnTransition } from '../native-turn-contracts.ts'
import { nativeWriterEpoch, type NativeWriterIdentity } from '../native-writer-contracts.ts'
import { readNativeAssistantState, validateNativeAssistantLimits, type NativeAssistantLimits } from '../native-assistant-records.ts'
import { digest } from './identity.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import { nativeInputForTurn } from './native-turn-input.ts'
import { closedNativeTurn, readNativeTurnHistory, type NativeTurnHistory,
  type NativeTurnHistoryLimits } from './native-turn-history.ts'

/** Execution capacity, duration and native history/presentation limits supplied by deployment. */
export interface NativeTurnContinuationLimits extends NativeTurnHistoryLimits {
  readonly leaseMs: number
  readonly maxActivePerUser: number
  readonly assistant: NativeAssistantLimits
}

const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const frameRow = z.object({ sessionId: z.uuid(), frame: nativeTurnFrame, grant: nativeTurnSavedGrant,
  operationId, operationEpoch: nativeOperationEpoch, writerEpoch: nativeWriterEpoch,
  requestId, messageId: nativeTurnMessageId,
  digest: hash, preparedEventCount: safeCount }).strict()
type FrameRow = z.infer<typeof frameRow>
const transitionRow = z.object({ intentDigest: hash, candidateDigest: hash, receipt: nativeTurnReceipt }).strict()
const operationFence = z.object({ deadline: z.string(), epoch: z.number().int().positive(),
  operationId, workerId: z.uuid(), errorCode: z.string().nullable() }).strict()
type OperationFence = z.infer<typeof operationFence> & { token: string }
const presentationRow = z.object({ epoch: z.number().int().positive(), publisherId: z.uuid(),
  lastOrdinal: safeCount, state: z.unknown(), deadline: z.string() }).strict()
const duplicateToken = z.object({ code: z.literal('23505'), constraint: z.enum([
  'pe_native_turn_frames_grant_digest_key', 'pe_native_turn_transitions_candidate_digest_key',
  'pe_sessions_grant',
]) })

function refuse(code: string): never { throw new PlatformError(409, code) }

function savedGrant(value: Grant): z.infer<typeof nativeTurnSavedGrant> {
  const { token: _bearer, ...metadata } = value
  return nativeTurnSavedGrant.parse(metadata)
}

function intentDigest(request: NativeTurnTransition): string {
  const from = request.from.kind === 'parked' ? request.from
    : { ...request.from, operationToken: digest(request.from.operationToken) }
  return digest(JSON.stringify({ ...request, candidateToken: digest(request.candidateToken),
    writer: { ...request.writer, token: digest(request.writer.token) }, from }))
}

function receiptSource(from: NativeTurnTransition['from']): NativeTurnReceipt['from'] {
  if (from.kind === 'parked') return from
  const { operationToken: _bearer, ...identity } = from
  return identity
}

async function candidateWrite<T>(write: () => Promise<T>): Promise<T> {
  try { return await write() }
  catch (error) {
    if (duplicateToken.safeParse(error).success) refuse('native_turn_token_conflict')
    throw error
  }
}

/** Only committed native consumption can retire an execution frame; Writer occupancy remains independent. */
export class NativeTurnContinuation {
  private readonly limits: NativeTurnContinuationLimits

  /**
   * @param tasks Platform operation/database owner; grant restoration reads original acceptance.
   * @param writers Platform Writer provider with transaction-scoped authority checks.
   * @param limits Explicit deployment capacity, duration and storage bounds.
   */
  constructor(private readonly tasks: TaskStore, private readonly writers: NativeSessionWriter,
    limits: NativeTurnContinuationLimits) {
    const numbers = z.object({ leaseMs: z.number().int().min(1).max(300_000),
      maxActivePerUser: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      maxHistoryEvents: z.number().int().min(1).max(2_147_483_646),
      maxHistoryBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().parse({
      leaseMs: limits.leaseMs, maxActivePerUser: limits.maxActivePerUser,
      maxHistoryEvents: limits.maxHistoryEvents, maxHistoryBytes: limits.maxHistoryBytes,
    })
    this.limits = { ...numbers, assistant: validateNativeAssistantLimits(limits.assistant) }
  }

  /** Bind current bootstrap authority before the native input can be delivered or claimed.
   * @param input Strict Writer/token/message request; identical retries keep the original message identity.
   * @returns Current authoritative frame; a claimed result must never be delivered again.
   */
  async prepare(input: unknown): Promise<NativeTurnFrame> {
    const parsed = nativeTurnPrepare.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    const request = parsed.data
    return transaction(this.tasks.pool, async (client) => {
      await this.writers.requireInTransaction(client, request.writer)
      const current = await this.authorizeOperation(client, request.writer, request.operationToken)
      const value = await this.tasks.restoreGrantInTransaction(client, current.operationId, current.token, current.epoch)
      const history = await readNativeTurnHistory(client, request.writer.sessionId, this.limits)
      let stored = await this.frame(client, current.operationId, current.epoch)
      if (stored) {
        if (stored.sessionId !== request.writer.sessionId || stored.digest !== digest(current.token)
          || stored.frame.messageId !== request.messageId
          || stored.frame.writerEpoch !== request.writer.epoch) refuse('native_turn_prepare_conflict')
      } else {
        await this.assertStableInput(client, value, request.messageId, history)
        const prepared = nativeTurnFrame.parse({ phase: 'prepared', operationId: value.operationId,
          operationEpoch: value.epoch, writerEpoch: request.writer.epoch, requestId: value.requestId,
          messageId: request.messageId, inputRevision: 1 })
        stored = await this.insertFrame(client, prepared, value, history.eventCount)
      }
      const result = await this.auditFrame(client, stored, history)
      await this.finalFence(client, request.writer, current)
      return result
    })
  }

  /** Commit one immutable successor under the live Writer, replaying its receipt before checking old A authority.
   * @param input Strict advance, parked activation or unclaimed retirement intent.
   * @returns Original receipt plus current execution authority; expired historical B has no bearer.
   */
  async transition(input: unknown): Promise<NativeTurnResponse> {
    const parsed = nativeTurnTransition.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    const request = parsed.data
    return transaction(this.tasks.pool, async (client) => {
      const owner = await this.writers.requireInTransaction(client, request.writer)
      const prior = await client.query<Record<string, unknown>>(`SELECT intent_digest AS "intentDigest",
        candidate_digest AS "candidateDigest",receipt_json AS receipt FROM pe_native_turn_transitions
        WHERE session_id=$1 AND writer_epoch=$2 AND transition_id=$3`,
      [request.writer.sessionId, request.writer.epoch, request.transitionId])
      if (prior.rows[0]) {
        const original = transitionRow.parse(prior.rows[0])
        if (original.intentDigest !== intentDigest(request) || original.candidateDigest !== digest(request.candidateToken)) {
          refuse('native_turn_intent_conflict')
        }
        if (original.receipt.sessionId !== request.writer.sessionId || original.receipt.writerEpoch !== request.writer.epoch
          || original.receipt.transitionId !== request.transitionId || original.receipt.eventCount !== request.expectedEventCount
          || original.receipt.queueRevision !== request.expectedQueueRevision
          || !isDeepStrictEqual(original.receipt.from, receiptSource(request.from))) {
          throw new PlatformError(503, 'native_turn_receipt_corrupt')
        }
        return this.response(client, request, original.receipt)
      }
      await this.assertUnusedSource(client, request)
      await this.assertFreshCandidate(client, request)
      const history = await readNativeTurnHistory(client, request.writer.sessionId, this.limits)
      if (history.eventCount !== request.expectedEventCount || history.queueRevision !== request.expectedQueueRevision) {
        refuse('native_turn_queue_changed')
      }
      let fence: OperationFence | undefined
      let presentationDeadline: string | undefined
      let unclaimed: Extract<NativeTurnReceipt['result'], { kind: 'parked' }>['unclaimed']
      if (request.kind === 'advance') {
        const { fence: provedFence, stored, observed } = await this.originalFrame(client, request, history)
        fence = provedFence
        const closed = closedNativeTurn(history, stored.frame.messageId)
        if (observed.phase !== 'claimed' || closed.claimed.turn !== request.from.turn
          || closed.claimed.turnStartSeq !== request.from.turnStartSeq || closed.end.seq !== request.from.turnEndSeq
          || request.from.claimedMessageIds[0] !== stored.frame.messageId) refuse('native_turn_claim_conflict')
        presentationDeadline = await this.seal(client, request, fence, history)
        await this.settle(client, fence, closed.outcome, closed.errorCode)
        await this.writeFrame(client, nativeTurnFrame.parse({ ...observed, phase: 'settled',
          claim: { ...observed.claim, turnEndSeq: closed.end.seq }, outcome: closed.outcome, errorCode: closed.errorCode }))
      } else if (request.kind === 'park') {
        const { fence: provedFence, stored, observed } = await this.originalFrame(client, request, history)
        fence = provedFence
        if (observed.phase !== 'prepared' || history.events.some(event => event.seq >= stored.preparedEventCount
          && event.type === 'turn/start')) refuse('native_turn_already_started')
        if (request.reason === 'user_cancel' ? fence.errorCode !== 'cancel_requested' : fence.errorCode === 'cancel_requested') {
          refuse('native_turn_cancel_conflict')
        }
        await this.retire(client, fence, request.reason)
        await this.writeFrame(client, nativeTurnFrame.parse({ ...observed, phase: 'retired', reason: request.reason,
          eventCount: history.eventCount, requeued: request.reason === 'preparation_failed' }))
        unclaimed = { operationId: fence.operationId, messageId: stored.frame.messageId,
          action: request.reason === 'preparation_failed' ? 'retain' : 'remove' }
      } else {
        await this.parkedSource(client, request)
      }
      const result = request.kind === 'park'
        ? { kind: 'parked' as const, reason: request.reason, unclaimed }
        : await this.next(client, request, owner.userId, history)
      const from = receiptSource(request.from)
      const receipt = nativeTurnReceipt.parse({ version: 1, sessionId: request.writer.sessionId,
        writerEpoch: request.writer.epoch, transitionId: request.transitionId, eventCount: history.eventCount,
        queueRevision: history.queueRevision, from, result })
      const successor = receipt.result.kind === 'prepared' ? { ...receipt.result, token: request.candidateToken } : undefined
      await this.insertReceipt(client, request, receipt)
      await this.finalFence(client, request.writer, fence, presentationDeadline, successor)
      await client.query("SELECT pg_notify('pe_tasks',$1)", [request.writer.sessionId])
      const response = nativeTurnResponse.parse({ receipt, replayed: false, current: receipt.result.kind === 'parked'
        ? { kind: 'parked' } : { kind: 'live', frame: { ...receipt.result.frame, phase: 'prepared' },
          grant: { ...receipt.result.grant, token: request.candidateToken } } })
      await this.finalFence(client, request.writer, fence, presentationDeadline, successor)
      return response
    })
  }

  /** Reconcile native claims under the live Writer without issuing or extending an execution grant.
   * @param writer Exact current Writer identity.
   * @param id Exact operation identity.
   * @param epoch Exact attempt epoch, including a historical attempt.
   * @returns Native consumption state; no input is inserted or replayed.
   */
  async inspect(writer: NativeWriterIdentity, id: OperationId, epoch: number): Promise<NativeTurnFrame> {
    return transaction(this.tasks.pool, async (client) => {
      await this.writers.requireInTransaction(client, writer)
      const stored = await this.requiredFrame(client, id, epoch)
      if (stored.sessionId !== writer.sessionId || stored.frame.writerEpoch !== writer.epoch) refuse('native_turn_frame_conflict')
      const history = await readNativeTurnHistory(client, writer.sessionId, this.limits)
      const result = await this.auditFrame(client, stored, history)
      await this.writers.assertLiveInTransaction(client, writer)
      return result
    })
  }

  /** Require an open native consumed step before model or external-effect execution.
   * @param client Caller transaction, already holding account and Session authority.
   * @param session Actual TaskStore.authorized result on this connection, never a caller-supplied record.
   * @param token Exact operation bearer authorized by the caller.
   * @returns Completion only with a persisted input claim, open step and current live operation/Writer fences.
   */
  async assertExecutionInTransaction(client: PoolClient,
    session: Awaited<ReturnType<TaskStore['authorized']>>, token: string): Promise<void> {
    const hint = await client.query<{ epoch: number }>(`SELECT writer_epoch::double precision AS epoch
      FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2`, [session.operation_id, session.lease_epoch])
    if (!hint.rows[0]) refuse('native_turn_frame_missing')
    const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(hint.rows[0].epoch)
    const writer = await client.query(`SELECT w.session_id FROM pe_native_writers w JOIN pe_attempts a
      ON a.worker_id=w.worker_id WHERE w.session_id=$1 AND w.epoch=$2 AND w.expires_at>clock_timestamp()
        AND a.operation_id=$3 AND a.epoch=$4 AND a.ended_at IS NULL FOR UPDATE OF w,a`,
    [session.id, epoch, session.operation_id, session.lease_epoch])
    if (!writer.rowCount) refuse('native_turn_execution_fenced')
    const stored = await this.requiredFrame(client, operationId.parse(session.operation_id), session.lease_epoch)
    if (stored.sessionId !== session.id || stored.digest !== digest(token) || stored.frame.writerEpoch !== epoch) {
      refuse('native_turn_execution_fenced')
    }
    const history = await readNativeTurnHistory(client, stored.grant.sessionId, this.limits)
    const frame = await this.auditFrame(client, stored, history)
    if (frame.phase !== 'claimed' || frame.claim.turnEndSeq !== null) refuse('native_turn_execution_unclaimed')
    const boundary = history.events.findLast(event => (event.type === 'step/start' || event.type === 'step/end')
      && event.data.turn === frame.claim.turn)
    if (boundary?.type !== 'step/start' || boundary.seq <= frame.claim.claimSeq
      || !history.events.some(event => event.type === 'user/message' && event.seq > frame.claim.claimSeq
        && isDeepStrictEqual(event.data, nativeInputForTurn(stored.grant, frame.messageId)))) {
      refuse('native_turn_execution_unclaimed')
    }
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
      JOIN pe_native_writers w ON w.session_id=s.id AND w.worker_id=a.worker_id
      WHERE s.id=$1 AND s.grant_digest=$2 AND s.lease_epoch=$3 AND s.lease_until>clock_timestamp()
        AND o.id=$4 AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested' AND a.ended_at IS NULL
        AND w.epoch=$5 AND w.expires_at>clock_timestamp()`,
    [session.id, digest(token), session.lease_epoch, session.operation_id, stored.frame.writerEpoch])
    if (!live.rowCount) refuse('native_turn_execution_fenced')
  }

  private async authorizeOperation(client: PoolClient, writer: NativeWriterIdentity, token: string): Promise<OperationFence> {
    const session = await this.tasks.authorized(client, token)
    if (session.id !== writer.sessionId) refuse('native_turn_operation_conflict')
    const record = await client.query<Record<string, unknown>>(`SELECT s.lease_until::text AS deadline,
      s.lease_epoch AS epoch,o.id AS "operationId",a.worker_id AS "workerId",o.error_code AS "errorCode"
      FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
      WHERE s.id=$1 AND o.id=$2 AND o.state='running' AND a.ended_at IS NULL FOR UPDATE OF o,a`,
    [session.id, session.operation_id])
    if (!record.rows[0]) refuse('lease_lost')
    const value = operationFence.parse(record.rows[0])
    if (value.workerId !== writer.workerId) refuse('native_turn_worker_conflict')
    return { ...value, token }
  }

  private async originalFrame(client: PoolClient, request: Extract<NativeTurnTransition, { kind: 'advance' | 'park' }>,
    history: NativeTurnHistory): Promise<{ fence: OperationFence; stored: FrameRow; observed: NativeTurnFrame }> {
    const fence = await this.authorizeOperation(client, request.writer, request.from.operationToken)
    this.assertFrom(request, fence)
    const stored = await this.requiredFrame(client, fence.operationId, fence.epoch)
    this.assertBound(stored, request.writer, fence)
    const observed = await this.auditFrame(client, stored, history)
    return { fence, stored, observed }
  }

  private assertFrom(request: Extract<NativeTurnTransition, { kind: 'advance' | 'park' }>, fence: OperationFence): void {
    if (request.from.operationId !== fence.operationId || request.from.operationEpoch !== fence.epoch) {
      refuse('native_turn_operation_conflict')
    }
  }

  private assertBound(stored: FrameRow, writer: NativeWriterIdentity, fence: OperationFence): void {
    if (stored.sessionId !== writer.sessionId || stored.frame.writerEpoch !== writer.epoch
      || stored.digest !== digest(fence.token)) refuse('native_turn_frame_conflict')
  }

  private async frame(client: PoolClient, id: OperationId, epoch: number): Promise<FrameRow | undefined> {
    const result = await client.query<Record<string, unknown>>(`SELECT session_id AS "sessionId",frame_json AS frame,
      operation_id AS "operationId",operation_epoch::double precision AS "operationEpoch",
      writer_epoch::double precision AS "writerEpoch",request_id AS "requestId",message_id AS "messageId",
      grant_json AS grant,grant_digest AS digest,prepared_event_count AS "preparedEventCount"
      FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2 FOR UPDATE`, [id, epoch])
    if (!result.rows[0]) return undefined
    const stored = frameRow.parse(result.rows[0])
    if (stored.frame.operationId !== id || stored.frame.operationEpoch !== epoch || stored.grant.operationId !== id
      || stored.grant.epoch !== epoch || stored.grant.sessionId !== stored.sessionId
      || stored.grant.requestId !== stored.frame.requestId || stored.operationId !== id || stored.operationEpoch !== epoch
      || stored.writerEpoch !== stored.frame.writerEpoch || stored.requestId !== stored.frame.requestId
      || stored.messageId !== stored.frame.messageId) throw new PlatformError(503, 'native_turn_frame_corrupt')
    return stored
  }

  private async requiredFrame(client: PoolClient, id: OperationId, epoch: number): Promise<FrameRow> {
    const stored = await this.frame(client, id, epoch)
    if (!stored) refuse('native_turn_frame_missing')
    return stored
  }

  private async assertStableInput(client: PoolClient, value: Grant, messageId: NativeTurnFrame['messageId'],
    history: NativeTurnHistory): Promise<void> {
    const prior = await client.query<{ frame: unknown }>(`SELECT frame_json AS frame FROM pe_native_turn_frames
      WHERE session_id=$1 AND (operation_id=$2 OR message_id=$3) FOR UPDATE`, [value.sessionId, value.operationId, messageId])
    for (const row of prior.rows) {
      const pinned = nativeTurnFrame.parse(row.frame)
      if (pinned.operationId !== value.operationId || pinned.requestId !== value.requestId || pinned.messageId !== messageId) {
        refuse('native_turn_input_identity_conflict')
      }
    }
    if (history.claims.some(item => item.message.id === messageId)) refuse('native_turn_input_replayed')
    const pending = [...history.nextTurn, ...history.nextStep].find(message => message.id === messageId)
    if (pending && !isDeepStrictEqual(pending, nativeInputForTurn(value, messageId))) refuse('native_turn_input_changed')
  }

  private async insertFrame(client: PoolClient, frame: NativeTurnFrame, value: Grant, eventCount: number): Promise<FrameRow> {
    const metadata = savedGrant(value)
    await candidateWrite(() => client.query(`INSERT INTO pe_native_turn_frames(operation_id,operation_epoch,session_id,writer_epoch,
        request_id,message_id,grant_digest,frame_json,grant_json,prepared_event_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [frame.operationId, frame.operationEpoch, value.sessionId, frame.writerEpoch, frame.requestId, frame.messageId,
      digest(value.token), JSON.stringify(frame), JSON.stringify(metadata), eventCount]))
    return { sessionId: value.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
      writerEpoch: frame.writerEpoch, requestId: frame.requestId, messageId: frame.messageId,
      frame, grant: metadata, digest: digest(value.token), preparedEventCount: eventCount }
  }

  private async writeFrame(client: PoolClient, frame: NativeTurnFrame): Promise<void> {
    await client.query('UPDATE pe_native_turn_frames SET frame_json=$3 WHERE operation_id=$1 AND operation_epoch=$2',
      [frame.operationId, frame.operationEpoch, JSON.stringify(frame)])
  }

  private async auditFrame(client: PoolClient, stored: FrameRow, history: NativeTurnHistory): Promise<NativeTurnFrame> {
    const claimed = history.claims.find(item => item.message.id === stored.frame.messageId)
    if (!claimed) {
      if (stored.frame.phase === 'claimed' || stored.frame.phase === 'settled') {
        throw new PlatformError(503, 'native_turn_claim_missing')
      }
      return stored.frame
    }
    if (claimed.claimSeq < stored.preparedEventCount || stored.frame.phase === 'retired'
      || !isDeepStrictEqual(claimed.message, nativeInputForTurn(stored.grant, stored.frame.messageId))) {
      refuse('native_turn_claim_conflict')
    }
    if (history.claims.filter(item => item.turnStartSeq === claimed.turnStartSeq).length !== 1) {
      refuse('native_turn_cohort_unsupported')
    }
    const end = history.events.find(event => event.type === 'turn/end' && event.seq > claimed.turnStartSeq
      && event.data.turn === claimed.turn)
    const facts = { turn: claimed.turn, turnStartSeq: claimed.turnStartSeq, claimSeq: claimed.claimSeq,
      turnEndSeq: end?.seq ?? null }
    if (stored.frame.phase === 'settled') {
      if (!isDeepStrictEqual(stored.frame.claim, facts)) throw new PlatformError(503, 'native_turn_frame_corrupt')
      return stored.frame
    }
    const frame = nativeTurnFrame.parse({ ...stored.frame, phase: 'claimed', claim: facts })
    await this.writeFrame(client, frame)
    return frame
  }

  private async assertUnusedSource(client: PoolClient, request: NativeTurnTransition): Promise<void> {
    const prior = request.from.kind === 'parked'
      ? await client.query(`SELECT transition_id FROM pe_native_turn_transitions WHERE session_id=$1
        AND writer_epoch=$2 AND from_transition_id=$3`, [request.writer.sessionId, request.writer.epoch, request.from.transitionId])
      : await client.query(`SELECT transition_id FROM pe_native_turn_transitions WHERE from_operation_id=$1
        AND from_operation_epoch=$2`, [request.from.operationId, request.from.operationEpoch])
    if (prior.rowCount) refuse('native_turn_source_used')
  }

  private async assertFreshCandidate(client: PoolClient, request: NativeTurnTransition): Promise<void> {
    const hashed = digest(request.candidateToken)
    if (hashed === digest(request.writer.token)
      || (request.from.kind !== 'parked' && hashed === digest(request.from.operationToken))) refuse('native_turn_token_conflict')
    const prior = await client.query(`SELECT 1 FROM pe_native_turn_frames WHERE grant_digest=$1
      UNION ALL SELECT 1 FROM pe_native_turn_transitions WHERE candidate_digest=$1
      UNION ALL SELECT 1 FROM pe_sessions WHERE grant_digest=$1`, [hashed])
    if (prior.rowCount) refuse('native_turn_token_conflict')
  }

  private async seal(client: PoolClient, request: Extract<NativeTurnTransition, { kind: 'advance' }>,
    fence: OperationFence, history: NativeTurnHistory): Promise<string> {
    const result = await client.query<Record<string, unknown>>(`SELECT epoch,publisher_id AS "publisherId",
      last_ordinal::double precision AS "lastOrdinal",state_json AS state,expires_at::text AS deadline
      FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE`, [request.writer.sessionId])
    if (!result.rows[0]) refuse('native_turn_seal_missing')
    const presentation = presentationRow.parse(result.rows[0])
    const state = readNativeAssistantState(presentation.state, this.limits.assistant)
    if (presentation.epoch !== fence.epoch || presentation.publisherId !== request.seal.publisherId
      || state.epoch !== fence.epoch || state.publisherId !== request.seal.publisherId
      || presentation.lastOrdinal !== request.seal.lastOrdinal || state.lastOrdinal !== request.seal.lastOrdinal
      || state.revision !== request.seal.revision || state.cursor !== history.eventCount - 1
      || state.activeAttempt !== undefined || state.awaitingStepEnd !== undefined) refuse('native_turn_seal_conflict')
    const released = await client.query(`DELETE FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2
      AND publisher_id=$3 AND expires_at>clock_timestamp() RETURNING session_id`,
    [request.writer.sessionId, fence.epoch, request.seal.publisherId])
    if (!released.rowCount) refuse('native_assistant_expired')
    return presentation.deadline
  }

  private async settle(client: PoolClient, fence: OperationFence, outcome: 'completed' | 'failed',
    errorCode: string | null): Promise<void> {
    const code = errorCode === 'turn_aborted' && fence.errorCode === 'cancel_requested' ? 'turn_user' : errorCode
    await client.query(`UPDATE pe_operations SET state=$2,error_code=$3,completed_at=clock_timestamp()
      WHERE id=$1 AND state='running'`, [fence.operationId, outcome, code])
    await client.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND epoch=$2',
      [fence.operationId, fence.epoch])
  }

  private async retire(client: PoolClient, fence: OperationFence, reason: 'preparation_failed' | 'user_cancel'): Promise<void> {
    const outcome = reason === 'preparation_failed' ? 'queued' : 'failed'
    await client.query(`UPDATE pe_operations SET state=$2,error_code=$3,
      completed_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
    [fence.operationId, outcome, reason === 'user_cancel' ? 'turn_user' : null])
    await client.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1 AND epoch=$2',
      [fence.operationId, fence.epoch])
    const present = await client.query<{ state: unknown }>(
      'SELECT state_json AS state FROM pe_native_presentations WHERE session_id=(SELECT session_id FROM pe_operations WHERE id=$1) AND epoch=$2 FOR UPDATE',
      [fence.operationId, fence.epoch])
    if (present.rows[0]) {
      const state = readNativeAssistantState(present.rows[0].state, this.limits.assistant)
      if (state.activeAttempt || state.awaitingStepEnd) refuse('native_turn_already_started')
    }
    await client.query(`DELETE FROM pe_native_presentations
      WHERE session_id=(SELECT session_id FROM pe_operations WHERE id=$1) AND epoch=$2`, [fence.operationId, fence.epoch])
    await this.clearOperationLease(client, fence)
  }

  private async clearOperationLease(client: PoolClient, fence: Pick<OperationFence, 'token' | 'epoch'>): Promise<void> {
    const cleared = await client.query(`UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE grant_digest=$1 AND lease_epoch=$2 AND lease_until>clock_timestamp() RETURNING id`, [digest(fence.token), fence.epoch])
    if (!cleared.rowCount) refuse('lease_lost')
  }

  private async parkedSource(client: PoolClient, request: Extract<NativeTurnTransition, { kind: 'activate' }>): Promise<void> {
    const stored = await client.query<{ receipt: unknown }>(`SELECT receipt_json AS receipt FROM pe_native_turn_transitions
      WHERE session_id=$1 AND writer_epoch=$2 AND transition_id=$3 FOR UPDATE`,
    [request.writer.sessionId, request.writer.epoch, request.from.transitionId])
    if (!stored.rows[0] || nativeTurnReceipt.parse(stored.rows[0].receipt).result.kind !== 'parked') {
      refuse('native_turn_parked_missing')
    }
    const idle = await client.query(`SELECT id FROM pe_sessions WHERE id=$1 AND grant_digest IS NULL AND lease_until IS NULL
      AND NOT EXISTS(SELECT 1 FROM pe_operations o WHERE o.session_id=$1 AND o.state='running')`, [request.writer.sessionId])
    if (!idle.rowCount) refuse('native_turn_not_parked')
  }

  private async next(client: PoolClient, request: Extract<NativeTurnTransition, { kind: 'advance' | 'activate' }>,
    userId: UserId, history: NativeTurnHistory): Promise<NativeTurnReceipt['result']> {
    if (history.nextStep.length > 0) refuse('native_turn_cohort_unsupported')
    const head = history.nextTurn[0]
    if (request.expectedNext === null) {
      if (head) refuse('native_turn_queue_changed')
      if (request.kind === 'advance') await this.clearOperationLease(client,
        { token: request.from.operationToken, epoch: request.from.operationEpoch })
      return { kind: 'parked', reason: 'empty' }
    }
    if (head?.id !== request.expectedNext.messageId) refuse('native_turn_queue_changed')
    const candidate = await client.query<{ id: string }>(`SELECT id FROM pe_operations WHERE session_id=$1 AND state='queued'
      ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [request.writer.sessionId])
    if (candidate.rows[0]?.id !== request.expectedNext.operationId) refuse('native_turn_queue_changed')
    const active = await client.query<{ count: string }>(`SELECT count(*) FROM pe_sessions
      WHERE user_id=$1 AND id<>$2 AND lease_until>clock_timestamp()`, [userId, request.writer.sessionId])
    const count = z.string().regex(/^\d+$/u).transform(Number).parse(active.rows[0]?.count)
    if (count >= this.limits.maxActivePerUser) {
      if (request.kind === 'advance') await this.clearOperationLease(client,
        { token: request.from.operationToken, epoch: request.from.operationEpoch })
      return { kind: 'parked', reason: 'capacity' }
    }
    const epochRow = await client.query<{ epoch: number }>('SELECT lease_epoch AS epoch FROM pe_sessions WHERE id=$1',
      [request.writer.sessionId])
    const previousEpoch = z.number().int().min(1).max(2_147_483_647).parse(epochRow.rows[0]?.epoch)
    if (previousEpoch === 2_147_483_647) throw new PlatformError(503, 'native_turn_epoch')
    const authority = request.kind === 'advance'
      ? { digest: digest(request.from.operationToken), epoch: request.from.operationEpoch }
      : { digest: null, epoch: previousEpoch }
    const updated: QueryResult<Record<string, unknown>> = await candidateWrite(() => client.query<Record<string, unknown>>(
      `UPDATE pe_sessions SET lease_epoch=lease_epoch+1,
      grant_digest=$2,lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp()
      WHERE id=$1 AND lease_epoch=$4 AND grant_digest IS NOT DISTINCT FROM $5
        AND ($5::text IS NULL AND lease_until IS NULL OR $5::text IS NOT NULL AND lease_until>clock_timestamp())
      RETURNING lease_epoch AS epoch,floor(extract(epoch FROM lease_until)*1000)::double precision AS "expiresAt"`,
      [request.writer.sessionId, digest(request.candidateToken), this.limits.leaseMs, authority.epoch, authority.digest]))
    if (!updated.rows[0]) refuse('lease_lost')
    const issued = z.object({ epoch: z.number().int().positive(), expiresAt: safeCount }).strict().parse(updated.rows[0])
    await client.query("UPDATE pe_operations SET state='running',attempts=attempts+1 WHERE id=$1 AND state='queued'",
      [request.expectedNext.operationId])
    await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,$2,$3)',
      [request.expectedNext.operationId, issued.epoch, request.writer.workerId])
    const value = await this.tasks.restoreGrantInTransaction(client, request.expectedNext.operationId,
      request.candidateToken, issued.epoch)
    await this.assertStableInput(client, value, request.expectedNext.messageId, history)
    const frame = nativeTurnFrame.parse({ phase: 'prepared', operationId: value.operationId,
      operationEpoch: value.epoch, writerEpoch: request.writer.epoch, requestId: value.requestId,
      messageId: request.expectedNext.messageId, inputRevision: 1 })
    await this.insertFrame(client, frame, value, history.eventCount)
    return { kind: 'prepared', frame: { operationId: frame.operationId, operationEpoch: frame.operationEpoch,
      writerEpoch: frame.writerEpoch, requestId: frame.requestId, messageId: frame.messageId, inputRevision: 1 },
    grant: savedGrant(value), expiresAt: issued.expiresAt }
  }

  private async insertReceipt(client: PoolClient, request: NativeTurnTransition, receipt: NativeTurnReceipt): Promise<void> {
    await candidateWrite(() => client.query(`INSERT INTO pe_native_turn_transitions(session_id,writer_epoch,transition_id,intent_digest,
        candidate_digest,from_operation_id,from_operation_epoch,from_transition_id,receipt_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [request.writer.sessionId, request.writer.epoch, request.transitionId, intentDigest(request), digest(request.candidateToken),
      request.from.kind === 'parked' ? null : request.from.operationId,
      request.from.kind === 'parked' ? null : request.from.operationEpoch,
      request.from.kind === 'parked' ? request.from.transitionId : null, JSON.stringify(receipt)]))
  }

  private async response(client: PoolClient, request: NativeTurnTransition, receipt: NativeTurnReceipt): Promise<NativeTurnResponse> {
    let current: NativeTurnResponse['current']
    if (receipt.result.kind === 'parked') {
      const successor = await client.query(`SELECT 1 FROM pe_native_turn_transitions WHERE session_id=$1 AND writer_epoch=$2
        AND from_transition_id=$3 UNION ALL SELECT 1 FROM pe_sessions WHERE id=$1 AND grant_digest IS NOT NULL`,
      [request.writer.sessionId, request.writer.epoch, receipt.transitionId])
      current = successor.rowCount ? { kind: 'expired' } : { kind: 'parked' }
    } else {
      const original = receipt.result
      if (!await this.originalResultLive(client, request, original)) current = { kind: 'expired' }
      else {
        const stored = await this.requiredFrame(client, original.frame.operationId, original.frame.operationEpoch)
        if (stored.digest !== digest(request.candidateToken) || !isDeepStrictEqual(stored.grant, original.grant)
          || stored.frame.writerEpoch !== request.writer.epoch || original.frame.writerEpoch !== stored.frame.writerEpoch
          || original.frame.requestId !== stored.frame.requestId || original.frame.messageId !== stored.frame.messageId) {
          throw new PlatformError(503, 'native_turn_receipt_corrupt')
        }
        const history = await readNativeTurnHistory(client, request.writer.sessionId, this.limits)
        const frame = await this.auditFrame(client, stored, history)
        if (frame.phase !== 'prepared' && frame.phase !== 'claimed') throw new PlatformError(503, 'native_turn_receipt_corrupt')
        current = { kind: 'live', frame, grant: { ...original.grant, token: request.candidateToken } }
      }
    }
    await this.writers.assertLiveInTransaction(client, request.writer)
    if (receipt.result.kind === 'prepared' && !await this.originalResultLive(client, request, receipt.result)) {
      current = { kind: 'expired' }
    }
    return nativeTurnResponse.parse({ receipt, replayed: true, current })
  }

  private async originalResultLive(client: PoolClient, request: NativeTurnTransition,
    original: Extract<NativeTurnReceipt['result'], { kind: 'prepared' }>): Promise<boolean> {
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
      JOIN pe_native_writers w ON w.session_id=s.id AND w.worker_id=a.worker_id
      WHERE s.id=$1 AND s.grant_digest=$2 AND s.lease_epoch=$3 AND s.lease_until>clock_timestamp()
        AND o.id=$4 AND o.state='running' AND a.ended_at IS NULL AND a.worker_id=$5
        AND w.epoch=$6 AND w.token_digest=$7 AND w.expires_at>clock_timestamp()`,
    [request.writer.sessionId, digest(request.candidateToken), original.frame.operationEpoch,
      original.frame.operationId, request.writer.workerId, request.writer.epoch, digest(request.writer.token)])
    return Boolean(live.rowCount)
  }

  private async finalFence(client: PoolClient, writer: NativeWriterIdentity, original?: OperationFence,
    presentationDeadline?: string, successor?: Extract<NativeTurnReceipt['result'], { kind: 'prepared' }> & { token: string }): Promise<void> {
    await this.writers.assertLiveInTransaction(client, writer)
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      WHERE s.id=$1 AND w.worker_id=$2 AND w.epoch=$3 AND w.token_digest=$4 AND w.expires_at>clock_timestamp()
        AND ($5::timestamptz IS NULL OR $5::timestamptz>clock_timestamp())
        AND ($6::timestamptz IS NULL OR $6::timestamptz>clock_timestamp())
        AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
          WHERE o.id=$7 AND o.session_id=s.id AND o.state='running' AND a.epoch=$8 AND a.ended_at IS NULL
            AND a.worker_id=w.worker_id AND s.lease_epoch=$8 AND s.grant_digest=$9 AND s.lease_until>clock_timestamp()))`,
    [writer.sessionId, writer.workerId, writer.epoch, digest(writer.token), original?.deadline ?? null,
      presentationDeadline ?? null, successor?.frame.operationId ?? null, successor?.frame.operationEpoch ?? null,
      successor ? digest(successor.token) : null])
    if (!live.rowCount) refuse('native_turn_fence_expired')
  }
}
