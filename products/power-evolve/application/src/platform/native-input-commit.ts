/** One PG transaction for native input facts, canonical events and the existing presentation generation. */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError } from '../contracts.ts'
import { nativeInputAcceptedCommit, nativeInputClaimCommit, nativeInputQueueCommit, nativeInputStepCommit,
  type NativeInputAcceptedCommit, type NativeInputClaimCommit, type NativeInputQueueCommit,
  type NativeInputCommitReceipt } from '../native-input-commit-contracts.ts'
import { nativeInputQueueCommand, eventSeq, type InputCommandReceipt, type NativeInputStorageAuthority,
  type NativeInputDecodedBatch, type NativeInputLedgerLimits } from '../native-input-ledger-contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { parseNativeAssistantBatch, readNativeAssistantState, validateNativeAssistantLimits,
  type NativeAssistantBatch, type NativeAssistantLimits } from '../native-assistant-records.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { assertNativeRetainedBarrier, nativeRetainedTransaction,
  type NativeRetainedTransaction } from './native-retained-intent-transaction.ts'
import { digest } from './identity.ts'
import { validateNativeRetainedEvents } from './native-retained-intent-validation.ts'
import type { NativeAssistantStore, NativeAssistantReceipt } from './native-assistant-store.ts'
import type { NativeExecutionFrames } from './native-execution-frames.ts'
import { nativeInputLedgerLimitsSchema, type NativeInputLedger } from './native-input-ledger.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { TaskStore } from './tasks.ts'

/** Required deployment budgets; the bridge has no implicit request or presentation limits. */
export interface NativeInputCommitConfig {
  readonly input: NativeInputLedgerLimits
  readonly presentation: NativeAssistantLimits
}
type BatchRequest = NativeInputAcceptedCommit | NativeInputClaimCommit | NativeInputQueueCommit
type SessionRow = Awaited<ReturnType<TaskStore['authorized']>>
const presentationRow = z.object({ epoch: eventSeq.min(1), publisherId: z.uuid(),
  lastOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), state: z.string(), lastBatchId: z.uuid().nullable() }).strict()

function refuse(code: string): never { throw new PlatformError(409, code) }
function assertNever(_value: never): never { throw new PlatformError(503, 'native_input_family_corrupt') }

/** Joins actual ledger, Writer, frame and publisher services without minting execution authority. */
export class NativeInputCommit {
  private readonly limits: NativeInputCommitConfig

  /**
   * @param tasks Actual Platform storage authorization and PG pool.
   * @param ledger Actual immutable native input provider.
   * @param frames Actual version-two execution frame provider.
   * @param publisher Actual ordered presentation provider, initialized by ordinary publication.
   * @param writers Actual independent Session Writer provider.
   * @param config Required deployment request and presentation budgets.
   */
  constructor(private readonly tasks: TaskStore, private readonly ledger: NativeInputLedger,
    private readonly frames: NativeExecutionFrames, private readonly publisher: NativeAssistantStore,
    private readonly writers: NativeSessionWriter, config: NativeInputCommitConfig) {
    this.limits = { input: nativeInputLedgerLimitsSchema.parse(config.input),
      presentation: validateNativeAssistantLimits(config.presentation) }
  }

  /** Validate the original input wire schema and request budget before journal preparation.
   * @param family Exact native input mutation family.
   * @param input Complete original request, without replacing its nonce, frame or publication counters.
   * @param header Actual owned Session header when validating the proposed native suffix.
   */
  validateRetainedRequest(family: 'admission' | 'claim' | 'queue' | 'step', input: unknown, header?: unknown): void {
    const validate = (request: BatchRequest) => {
      if (header !== undefined) validateNativeRetainedEvents(header, request.events, request.expectedEventCount,
        this.limits.input, this.limits.presentation.maxBatchItems)
    }
    switch (family) {
      case 'admission': validate(this.request(nativeInputAcceptedCommit, input)); return
      case 'claim': validate(this.request(nativeInputClaimCommit, input)); return
      case 'queue': validate(this.request(nativeInputQueueCommit, input)); return
      case 'step': this.request(nativeInputStepCommit, input); return
    }
    return assertNever(family)
  }

  /** Admit an originally accepted operation and atomically acknowledge its canonical insertion.
   * @param operationToken Current actual storage operation bearer, excluded from the wire DTO and result.
   * @param input Whole retained admission request; bootstrap preparation must identify the current operation.
   * @param context Retained journal transaction whose ACK is written before the original final proof.
   * @returns Tokenless ledger/publication receipts and the actual prepared bootstrap frame when required.
   */
  async commitAccepted(operationToken: string, input: unknown,
    context?: NativeRetainedTransaction<NativeInputCommitReceipt>): Promise<NativeInputCommitReceipt> {
    const request = this.request(nativeInputAcceptedCommit, input)
    return nativeRetainedTransaction(this.tasks.pool, context, async (client) => {
      const authority = { writer: request.writer, operationToken }
      const session = await this.authorize(client, authority, request.command.sessionId)
      await assertNativeRetainedBarrier(client, session.id, context !== undefined)
      if (request.prepareFrame !== (request.command.originOperationId === session.operation_id)) {
        refuse('native_input_prepare_conflict')
      }
      const batch = this.decode(session, request)
      const writer = await this.writers.requireInTransaction(client, request.writer)
      const prior = await this.ledger.replayInTransaction(client, authority.writer.sessionId,
        { kind: 'writer', userId: writer.userId, workerId: request.writer.workerId, writerEpoch: request.writer.epoch },
        request.command.rpcNonce, nativeInputRecordDigest(request.command))
      await this.pair(client, session, request, prior)
      const receipt = await this.ledger.commitAcceptedAdmissionInTransaction(client, request.command, authority, batch)
      const presentation = await this.publish(client, authority, request, batch, receipt)
      const frame = request.prepareFrame ? await this.frames.prepareInTransaction(client, authority, request.command.originInputId) : null
      const result: NativeInputCommitReceipt = { version: 1, kind: 'admission', input: receipt, presentation, frame }
      await context?.acknowledge(result)
      await this.final(client, authority, session, presentation)
      return result
    })
  }

  /** Commit the entire native claim cohort and the derived event-only presentation batch.
   * @param operationToken Current actual storage operation bearer.
   * @param input Whole retained initial or continuing native claim request, including empty cohorts.
   * @param context Retained journal transaction whose ACK is written before the original final proof.
   * @returns Exact tokenless immutable input and presentation receipts.
   */
  async commitClaim(operationToken: string, input: unknown,
    context?: NativeRetainedTransaction<NativeInputCommitReceipt>): Promise<NativeInputCommitReceipt> {
    const request = this.request(nativeInputClaimCommit, input)
    return nativeRetainedTransaction(this.tasks.pool, context, async (client) => {
      const authority = { writer: request.writer, operationToken }
      const session = await this.authorize(client, authority, request.command.frame.sessionId)
      await assertNativeRetainedBarrier(client, session.id, context !== undefined)
      const batch = this.decode(session, request)
      const writer = await this.writers.requireInTransaction(client, request.writer)
      const prior = await this.ledger.replayInTransaction(client, authority.writer.sessionId,
        { kind: 'writer', userId: writer.userId, workerId: request.writer.workerId, writerEpoch: request.writer.epoch },
        request.command.rpcNonce, nativeInputRecordDigest({ command: request.command, batch, operationDigest: digest(operationToken) }))
      await this.pair(client, session, request, prior)
      const receipt = await this.ledger.commitClaimInTransaction(client, request.command, authority, batch)
      const presentation = await this.publish(client, authority, request, batch, receipt)
      const result: NativeInputCommitReceipt = { version: 1, kind: 'claim', input: receipt, presentation }
      await context?.acknowledge(result)
      await this.final(client, authority, session, presentation)
      return result
    })
  }

  /** Commit a browser mutation already planned under the Host's genuine protected native activity.
   * @param credential Current browser bearer, never stored or returned by the bridge.
   * @param operationToken Actual current Session owner's storage operation bearer.
   * @param input Complete retained canonical queue batch; no serialized activity or independent items are accepted.
   * @param context Retained journal transaction whose ACK is written before the original final proof.
   * @returns Exact tokenless input and presentation receipts after the joint commit.
   */
  async commitQueue(credential: string, operationToken: string, input: unknown,
    context?: NativeRetainedTransaction<NativeInputCommitReceipt>): Promise<NativeInputCommitReceipt> {
    const request = this.request(nativeInputQueueCommit, input)
    return nativeRetainedTransaction(this.tasks.pool, context, async (client) => {
      const account = await requireBrowserAccount(client, credential, { lock: 'update' })
      await this.tasks.owned(client, { userId: account.userId, username: account.username }, request.command.payload.sessionId)
      const authority = { writer: request.writer, operationToken }
      const session = await this.authorize(client, authority, request.command.payload.sessionId)
      await assertNativeRetainedBarrier(client, session.id, context !== undefined)
      if (session.user_id !== account.userId) refuse('native_input_scope_conflict')
      const batch = this.decode(session, request)
      const prior = await this.ledger.lookupQueueReceiptInTransaction(client, credential, request.command)
      await this.pair(client, session, request, prior)
      const receipt = await this.ledger.commitQueueInTransaction(client, credential, request.command, authority, batch)
      const presentation = await this.publish(client, authority, request, batch, receipt)
      const result: NativeInputCommitReceipt = { version: 1, kind: 'queue', input: receipt, presentation }
      await context?.acknowledge(result)
      await this.final(client, authority, session, presentation, credential)
      return result
    })
  }

  /** Read an immutable browser result before attempting to plan an already removed input.
   * @param credential Current browser bearer, authenticated twice against the exact Session.
   * @param input Original queue command and retained nonce, without operation or Writer authority.
   * @returns Original tokenless receipt or null; changed payload under the same nonce refuses.
   */
  async readQueueReceipt(credential: string, input: unknown): Promise<InputCommandReceipt | null> {
    const command = this.request(nativeInputQueueCommand, input)
    return transaction(this.tasks.pool, client => this.ledger.lookupQueueReceiptInTransaction(client, credential, command))
  }

  /** Bind a complete consumed cohort only after ordinary publication has stored its actual step/start.
   * @param operationToken Actual current Session owner's storage bearer.
   * @param input Exact frame/cohort/step and retained ordinary publisher watermark.
   * @param context Retained journal transaction whose ACK is written before the original final proof.
   * @returns Complete permanent claims, their bound cohort and the matching tokenless publication receipt.
   */
  async bindStep(operationToken: string, input: unknown,
    context?: NativeRetainedTransaction<NativeInputCommitReceipt>): Promise<NativeInputCommitReceipt> {
    const request = this.request(nativeInputStepCommit, input)
    return nativeRetainedTransaction(this.tasks.pool, context, async (client) => {
      const authority = { writer: request.writer, operationToken }
      const session = await this.authorize(client, authority, request.command.frame.sessionId)
      await assertNativeRetainedBarrier(client, session.id, context !== undefined)
      const row = await this.presentation(client, session.id)
      const state = readNativeAssistantState(row.state, this.limits.presentation)
      if (row.epoch !== session.lease_epoch || state.epoch !== row.epoch || state.publisherId !== row.publisherId
        || row.publisherId !== request.seal.publisherId || row.lastOrdinal !== state.lastOrdinal
        || state.lastOrdinal !== request.seal.lastOrdinal || state.revision !== request.seal.revision
        || state.cursor !== session.event_count - 1 || request.seal.eventCount !== session.event_count) {
        refuse('native_input_publication_conflict')
      }
      const bound = await this.ledger.bindStepInTransaction(client, request.command, authority)
      const presentation: NativeAssistantReceipt = { epoch: session.lease_epoch, ...request.seal }
      const result: NativeInputCommitReceipt = { version: 1, kind: 'step', cohort: bound.cohort, claims: [...bound.claims], presentation }
      await context?.acknowledge(result)
      await this.final(client, authority, session, presentation)
      return result
    })
  }

  private request<T>(codec: z.ZodType<T>, input: unknown): T {
    const parsed = codec.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    const encoded = JSON.stringify(parsed.data)
    if (Buffer.byteLength(encoded) > this.limits.input.maxCommandBytes) {
      throw new PlatformError(413, 'native_input_command_budget')
    }
    return parsed.data
  }

  private async authorize(client: PoolClient, authority: NativeInputStorageAuthority, sessionId: SessionId): Promise<SessionRow> {
    if (authority.writer.sessionId !== sessionId) refuse('native_input_scope_conflict')
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    if (session.id !== sessionId || session.user_id !== writer.userId) refuse('native_input_scope_conflict')
    return session
  }

  private decode(session: SessionRow, request: BatchRequest): NativeInputDecodedBatch {
    const header = headerSchema.parse(session.header)
    const events = parseEvents(header, request.events)
    if (events.length > this.limits.presentation.maxBatchItems
      || request.expectedEventCount + events.length > this.limits.input.maxHistoryEvents
      || events.some(event => Buffer.byteLength(JSON.stringify(event)) > this.limits.input.maxEventBytes)) {
      throw new PlatformError(413, 'native_input_command_budget')
    }
    if (events.some((event, index) => event.seq !== request.expectedEventCount + index)) refuse('native_input_queue_changed')
    return { expectedEventCount: request.expectedEventCount, events }
  }

  private async presentation(client: PoolClient, sessionId: SessionRow['id']) {
    const rows = await client.query<Record<string, unknown>>(`SELECT epoch,publisher_id AS "publisherId",
      last_ordinal::double precision AS "lastOrdinal",state_json AS state,last_batch_id AS "lastBatchId"
      FROM pe_native_presentations WHERE session_id=$1 AND expires_at>clock_timestamp() FOR UPDATE`, [sessionId])
    if (!rows.rows[0]) refuse('native_input_publication_missing')
    const parsed = presentationRow.safeParse(rows.rows[0])
    if (!parsed.success) throw new PlatformError(503, 'native_input_publication_corrupt')
    return parsed.data
  }

  private async pair(client: PoolClient, session: SessionRow, request: BatchRequest, prior: InputCommandReceipt | null): Promise<void> {
    const row = await this.presentation(client, session.id)
    if (row.epoch !== session.lease_epoch || row.epoch !== request.presentation.epoch
      || row.publisherId !== request.presentation.publisherId
      || (prior !== null ? row.lastBatchId !== request.presentation.batchId : row.lastBatchId === request.presentation.batchId)) {
      refuse('native_input_publication_conflict')
    }
    const count = request.expectedEventCount + request.events.length
    if (session.event_count !== (prior === null ? request.expectedEventCount : count)
      || (prior !== null && prior.eventCount !== count)) refuse('native_input_queue_changed')
  }

  private async publish(client: PoolClient, authority: NativeInputStorageAuthority, request: BatchRequest,
    batch: NativeInputDecodedBatch, receipt: InputCommandReceipt): Promise<NativeAssistantReceipt> {
    const publication: NativeAssistantBatch = parseNativeAssistantBatch({ version: 1, ...request.presentation,
      items: batch.events.map(event => ({ type: 'event', event })) }, this.limits.presentation)
    const presentation = await this.publisher.commitInputInTransaction(client, authority.operationToken,
      batch.expectedEventCount, publication)
    if (receipt.eventCount !== batch.expectedEventCount + batch.events.length || presentation.eventCount !== receipt.eventCount
      || presentation.epoch !== request.presentation.epoch || presentation.publisherId !== request.presentation.publisherId
      || presentation.lastOrdinal !== request.presentation.firstOrdinal + batch.events.length - 1) {
      refuse('native_input_publication_conflict')
    }
    return presentation
  }

  private async final(client: PoolClient, authority: NativeInputStorageAuthority, session: SessionRow,
    presentation: NativeAssistantReceipt, credential?: string): Promise<void> {
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      JOIN pe_operations o ON o.id=$1 AND o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$2
      JOIN pe_native_presentations p ON p.session_id=s.id AND p.epoch=$2
      WHERE s.id=$3 AND s.user_id=$4 AND s.grant_digest=$5 AND s.lease_epoch=$2 AND s.lease_until>clock_timestamp()
      AND w.worker_id=$6 AND w.epoch=$7 AND w.token_digest=$8 AND w.expires_at>clock_timestamp()
      AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested' AND a.worker_id=w.worker_id AND a.ended_at IS NULL
      AND s.event_count=$9 AND p.publisher_id=$10 AND p.last_ordinal=$11 AND p.expires_at>clock_timestamp()
      AND ($12::text IS NULL OR EXISTS(SELECT 1 FROM pe_credentials c JOIN pe_users u ON u.id=c.user_id
        WHERE c.digest=$12 AND c.user_id=s.user_id AND c.audience='agent' AND c.credential_version=u.credential_version
        AND c.expires_at>clock_timestamp()))`,
    [session.operation_id, session.lease_epoch, session.id, session.user_id, digest(authority.operationToken),
      authority.writer.workerId, authority.writer.epoch, digest(authority.writer.token), presentation.eventCount,
      presentation.publisherId, presentation.lastOrdinal, credential === undefined ? null : digest(credential)])
    if (!live.rowCount) refuse('native_input_authority_lost')
  }
}
