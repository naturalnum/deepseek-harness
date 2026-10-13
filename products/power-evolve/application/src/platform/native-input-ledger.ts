/** PG-owned native input revisions, complete claim cohorts and immutable nonce receipts. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { Session, SessionLogOffset, type SessionId, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { planInboxCommand } from '@deepseek-ai/dsh-agent-loop'
import { resolveInboxTarget, type PendingInputCommand } from '@deepseek-ai/dsh-agent'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { PlatformError, userId, type UserId } from '../contracts.ts'
import { continuationInput, matchesContinuationInput } from '../continuation-input.ts'
import { inputOrigin, inputRevision, inputClaim, inputCohort, inputCommandId, inputCommandReceipt, admittedInputMessage, acceptedInputAudit,
  nativeInputAdmissionCommand, nativeInputQueueCommand, nativeInputClaimCommand, nativeInputStepCommand,
  nativeInputStorageAuthority, eventSeq, recordDigest,
  type InputOrigin, type InputRevision, type InputClaim, type InputCohort, type InputCommandReceipt,
  type NativeInputAdmissionCommand, type NativeInputQueueCommand, type NativeInputClaimCommand, type NativeInputStepCommand,
  type NativeInputStorageAuthority, type NativeInputDecodedBatch, type NativeInputLedgerLimits,
  type NativeInputFrameExpected, type NativeInputFrameVerifier, type NativeInputVerifiedFrame,
  type NativeInputOwnerBinding, type NativeInputPlannerPort, type NativeInputPlanningActivity } from '../native-input-ledger-contracts.ts'
import { nativeInputRecordDigest, ledgerFrozenSnapshotDigest, readInputOrigin, readInputRevision, readInputClaim,
  readInputCohort, readInputReceipt, readInputHistory, foldInputHistory, type NativeInputHistory } from '../native-input-ledger-records.ts'
import { parseEvents } from '../session-records.ts'
import { nativeWriterEpoch } from '../native-writer-contracts.ts'
import { nativeTurnMessageId } from '../native-turn-contracts.ts'
import { nativeFileAttachment } from '../native-attachment-contracts.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { digest } from './identity.ts'
import { transaction } from './database.ts'
import { isSessionBusinessBlockedInTransaction } from './native-workspace-layout.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'
import type { NativeSessionStopId } from '../native-session-stop-contracts.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { EventStore } from './events.ts'
import type { TaskStore } from './tasks.ts'

type Actor = InputCommandReceipt['actor']
type Authorized = Awaited<ReturnType<TaskStore['authorized']>>
type Context = { authority: NativeInputStorageAuthority; session: Authorized; userId: UserId }
/** Strict deployment input bounds shared by the ledger and its transaction adapters. */
export const nativeInputLedgerLimitsSchema = z.object({ maxAcceptedAuditBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxRevisionBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), maxCohortInputs: eventSeq.min(1),
  maxHistoryEvents: eventSeq.min(1).max(2_147_483_646), maxHistoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxCommandBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), maxEventBytes: eventSeq.min(1),
}).strict()
const commandRow = z.object({ sessionId: z.uuid(), commandId: inputCommandId, userId, actorKind: z.enum(['browser', 'writer']),
  actorId: z.uuid(), writerEpoch: nativeWriterEpoch.nullable(), rpcNonce: z.string(), payloadDigest: recordDigest,
  kind: z.enum(['admission', 'edit', 'remove', 'retarget', 'claim']), targetOriginInputId: z.uuid().nullable(),
  eventCount: eventSeq, receipt: z.unknown() }).strict()
const originColumns = `origin_input_id AS "originInputId",session_id AS "sessionId",origin_operation_id AS "originOperationId",
  original_request_id AS "originalRequestId",message_id AS "messageId",accepted_snapshot_digest AS "acceptedSnapshotDigest",
  accepted_audit_json AS "acceptedAudit"`
const revisionColumns = `origin_input_id AS "originInputId",session_id AS "sessionId",input_revision AS "inputRevision",
  previous_revision AS "previousRevision",cause,message_json AS message,input_digest AS "inputDigest",
  committed_splice_seq AS "committedSpliceSeq",command_id AS "commandId"`
const claimColumns = `origin_input_id AS "originInputId",session_id AS "sessionId",input_revision AS "inputRevision",
  input_digest AS "inputDigest",cohort_id AS "cohortId",claim_splice_seq AS "claimSpliceSeq",
  splice_item_ordinal AS "spliceItemOrdinal",cohort_ordinal AS "cohortOrdinal",target`
const knownDuplicate = z.object({ code: z.literal('23505'), constraint: z.enum([
  'pe_native_input_origins_pkey', 'pe_native_input_origins_origin_operation_id_key',
  'pe_native_input_origins_session_id_message_id_key', 'pe_native_input_claims_pkey',
  'pe_native_input_commands_session_id_actor_kind_actor_id_writer_key',
  'pe_native_input_cohorts_pkey', 'pe_native_input_revisions_pkey',
]) })
function refuse(code: string): never { throw new PlatformError(409, code) }
function corrupt(): never { throw new PlatformError(503, 'native_input_ledger_corrupt') }
function request<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new PlatformError(400, 'invalid_request')
  return result.data
}
async function write<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() }
  catch (error) { if (knownDuplicate.safeParse(error).success) refuse('native_input_conflict'); throw error }
}
function actorFields(actor: Actor): { id: string; epoch: number | null } {
  return actor.kind === 'browser' ? { id: actor.userId, epoch: null } : { id: actor.workerId, epoch: actor.writerEpoch }
}

/** Original accepted input awaiting admission; stable message identity is its original operation UUID. */
export interface NativeAcceptedPendingInput {
  readonly originOperationId: InputOrigin['originOperationId']
  readonly requestId: InputOrigin['originalRequestId']
  readonly acceptedInputAudit: InputOrigin['acceptedAudit']
  readonly message: z.infer<typeof admittedInputMessage>
}

/** Detached official planner; its registry must have the maintained native Inbox projection installed. */
export class NativeInputNativePlanner implements NativeInputPlannerPort {
  /** @param projections Actual native registry supplied by the Host adapter. */
  constructor(private readonly projections: SessionProjectionRegistry) {}

  /** Preserve native canceled removals, full text replacement and abort-aware send target resolution.
   * @param header Actual PG native header.
   * @param events Whole strictly decoded PG history.
   * @param command Existing native public queue payload and retained RPC nonce.
   * @param activity Actual protected native capture; steering requires it and an open native turn.
   * @returns Whole official canonical event batch and native-resolved target.
   */
  planQueue(header: SessionHeader, events: readonly SessionEvent[], command: NativeInputQueueCommand,
    activity?: NativeInputPlanningActivity): Promise<NativeInputDecodedBatch & { readonly resolvedTarget: 'next-step' | 'next-turn' | null }> {
    const marker = events.findLastIndex(event => event.type === 'session/end-seed' && event.data.inherited === true)
    if (header.isSeeded ? marker < 0 : marker >= 0) corrupt()
    const session = Session.forPlanning(header.id, events, header, SessionLogOffset(header.isSeeded ? marker : 0))
    const pending = foldInputHistory(header, events)
    const target = pending.inbox['next-turn'].some(message => message.id === command.payload.itemId) ? 'next-turn'
      : pending.inbox['next-step'].some(message => message.id === command.payload.itemId) ? 'next-step' : null
    if (target === null) refuse('native_input_not_found')
    const action = command.payload.action
    if (action.kind === 'steer' && (target !== 'next-turn' || pending.turn === null || activity === undefined)) {
      refuse('native_input_steer_unavailable')
    }
    const nativeCommand: PendingInputCommand = action.kind === 'steer'
      ? { kind: 'retarget', messageId: command.payload.itemId, target: 'next-step', wakeup: true }
      : action.kind === 'edit' ? { kind: 'edit', messageId: command.payload.itemId, content: action.content }
        : { kind: 'remove', messageId: command.payload.itemId }
    const planned = planInboxCommand(session, this.projections, nativeCommand, activity)
    if (!planned.found) refuse('native_input_not_found')
    const insertion = planned.events.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)
    const resolvedTarget = action.kind === 'remove' ? null
      : action.kind === 'steer' && activity ? resolveInboxTarget('next-step', true, activity.aborted) : target
    if (action.kind !== 'remove' && (insertion?.type !== 'agent/inbox/spliced' || insertion.data.target !== resolvedTarget)) {
      refuse('native_input_batch_conflict')
    }
    activity?.assertCurrent()
    return Promise.resolve({ expectedEventCount: events.length, events: planned.events, resolvedTarget })
  }
}

/** Decode the original cohort row and its complete claim splice positions without changing either input.
 * @param row Original PG text/number cells from the existing bounded cohort query.
 * @param claims Original parsed claims in their existing SQL order.
 * @returns Strict cohort metadata checked by the existing native records decoder.
 */
export function readStoredNativeInputCohort(row: Readonly<Record<string, unknown>>, claims: readonly InputClaim[]): InputCohort {
  return readInputCohort({ cohortId: row.cohortId, frame: { sessionId: row.sessionId, operationId: row.operationId,
    operationEpoch: row.operationEpoch, writerEpoch: row.writerEpoch, frozenSnapshotDigest: row.frozenSnapshotDigest,
    ownerInput: { originInputId: row.originInputId, inputRevision: row.inputRevision, inputDigest: row.inputDigest } },
  owner: { kind: row.ownerKind, originInputId: row.originInputId }, turnStartSeq: row.turnStartSeq, turn: row.turn,
  boundaryOrdinal: row.boundaryOrdinal, stepStartSeq: row.stepStartSeq, claimCount: row.claimCount, commandId: row.commandId,
  claimSpliceSeqs: [...new Set(claims.map(claim => claim.claimSpliceSeq))].sort((a, b) => a - b) })
}

/** Compare the original common cohort identity and contiguous claims before caller-specific boundary checks.
 * @param cohort Strict stored cohort decoded from the existing row and claims.
 * @param claims Parsed original claim cohort in SQL order.
 * @param ordinal Expected boundary ordinal in the complete native turn.
 * @param frame Current proved operation and Writer identity.
 * @param owner Original proved turn owner and input revision.
 * @returns Whether the original common identity or claim count/ordering checks find a conflict.
 */
export function nativeInputCohortConflict(cohort: InputCohort, claims: readonly InputClaim[], ordinal: number,
  frame: NativeInputVerifiedFrame, owner: NativeInputOwnerBinding): boolean {
  return cohort.boundaryOrdinal !== ordinal || cohort.frame.operationId !== frame.operationId
    || cohort.frame.operationEpoch !== frame.operationEpoch || cohort.frame.writerEpoch !== frame.writerEpoch
    || cohort.frame.frozenSnapshotDigest !== frame.frozenSnapshotDigest || cohort.turn !== owner.turn
    || cohort.owner.originInputId !== owner.originInputId || cohort.frame.ownerInput.inputRevision !== owner.inputRevision
    || cohort.frame.ownerInput.inputDigest !== owner.inputDigest || claims.length !== cohort.claimCount
    || claims.some((claim, index) => claim.cohortOrdinal !== index)
}

/** Stores native facts only after current browser/Writer/attempt authority and complete PG pre-state proof. */
export class NativeInputLedger {
  private readonly limits: NativeInputLedgerLimits

  /**
   * @param tasks Real Platform TaskStore; this service never mints or renews a grant.
   * @param writers Current exact Writer provider using caller-owned transactions.
   * @param events Maintained canonical event append service.
   * @param limits Required deployment bounds.
   * @param frameVerifier Explicit Root-owned frame provider; missing installation refuses mutations.
   * @param planner Optional official native planner; missing installation refuses public queue planning.
   */
  constructor(private readonly tasks: TaskStore, private readonly writers: NativeSessionWriter, private readonly events: EventStore,
    limits: NativeInputLedgerLimits, private readonly frameVerifier?: NativeInputFrameVerifier,
    private readonly planner?: NativeInputPlannerPort) { this.limits = nativeInputLedgerLimitsSchema.parse(limits) }

  /** Read only original accepted operations still eligible for this exact Session's Writer admission.
   * @param client Caller transaction holding the current storage operation and Writer.
   * @param authority Exact current storage A and independent Writer; queued inputs supply no authority.
   * @param limit Required deployment selection bound, within the configured cohort budget.
   * @returns Stable creation-order inputs and an explicit indication of additional eligible rows.
   */
  async readAcceptedPendingInTransaction(client: PoolClient, authority: NativeInputStorageAuthority,
    limit: number): Promise<{ items: readonly NativeAcceptedPendingInput[]; more: boolean }> {
    const bound = eventSeq.min(1).max(this.limits.maxCohortInputs).parse(limit)
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    const context = await this.authorize(client, authority, authority.writer.sessionId, writer.userId)
    const rows = await client.query<{ id: string }>(`SELECT o.id FROM pe_operations o
      JOIN pe_sessions s ON s.id=o.session_id WHERE o.session_id=$1 AND s.user_id=$2
      AND (o.state='queued' OR (o.state='running' AND o.id=$3)) AND o.error_code IS DISTINCT FROM 'cancel_requested'
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_origins i WHERE i.origin_operation_id=o.id)
      ORDER BY o.created_at,o.id LIMIT $4 FOR UPDATE OF o`,
    [context.session.id, writer.userId, context.session.operation_id, bound + 1])
    const items: NativeAcceptedPendingInput[] = []
    for (const row of rows.rows.slice(0, bound)) {
      const id = inputOrigin.shape.originOperationId.parse(row.id)
      const audit = await this.audit(client, id, authority.writer.sessionId, writer.userId)
      items.push({ originOperationId: id, requestId: audit.requestId, acceptedInputAudit: audit,
        message: admittedInputMessage.parse({ id: nativeTurnMessageId.parse(id), role: 'user', source: this.source(audit),
          content: audit.nativeContent ?? [{ type: 'text', text: continuationInput(audit.text, this.limits.maxEventBytes) }] }) })
      this.bytes(items, this.limits.maxCommandBytes, 'native_input_command_budget')
    }
    await this.final(client, context)
    return { items, more: rows.rows.length > bound }
  }

  /** Look up an immutable browser command before planning against current pending state.
   * @param client Caller-owned PG transaction.
   * @param credential Current browser bearer, rechecked before returning the historical result.
   * @param command Validated original queue payload and retained nonce.
   * @returns Original tokenless receipt or null; conflicting nonce payloads refuse.
   */
  async lookupQueueReceiptInTransaction(client: PoolClient, credential: string,
    command: NativeInputQueueCommand): Promise<InputCommandReceipt | null> {
    this.bytes(command, this.limits.maxCommandBytes, 'native_input_command_budget')
    const actor = await this.browser(client, credential, command.payload.sessionId)
    const prior = await this.replayInTransaction(client, command.payload.sessionId, actor, command.rpcNonce,
      nativeInputRecordDigest(command))
    await this.browser(client, credential, command.payload.sessionId)
    return prior
  }

  /** Commit an already decoded complete admission batch; the original operation remains unchanged.
   * @param client Caller-owned PG transaction.
   * @param credential Current browser bearer, absent from stored records.
   * @param command Original accepted operation and stable message identities.
   * @param authority Exact current storage grant and Writer, supplied by the internal adapter.
   * @param batch Complete official native insertion events.
   * @returns Original tokenless result staged for the caller's commit.
   */
  async commitAdmissionInTransaction(client: PoolClient, credential: string, command: NativeInputAdmissionCommand,
    authority: NativeInputStorageAuthority, batch: NativeInputDecodedBatch): Promise<InputCommandReceipt> {
    this.verifier()
    const actor = await this.browser(client, credential, command.sessionId)
    const intent = nativeInputRecordDigest(command)
    const prior = await this.replayInTransaction(client, command.sessionId, actor, command.rpcNonce, intent)
    if (prior) { await this.browser(client, credential, command.sessionId); return prior }
    const context = await this.authorize(client, authority, command.sessionId, actor.userId)
    return this.admission(client, context, actor, command, batch, credential)
  }

  /** Admit an actual previously accepted operation through its current Session Writer, without a browser bearer.
   * @param client Caller transaction; the full canonical insertion and ledger facts commit or roll back together.
   * @param command Original accepted operation, stable logical/message identities and Writer-retained nonce.
   * @param authority Actual current storage operation and independent Session Writer, never a grant assembled from queued inputs.
   * @param batch Whole strictly decoded official native insertion batch against the locked PG prefix.
   * @returns Original immutable Writer-scoped admission result; this neither claims the queued operation nor permits execution.
   */
  async commitAcceptedAdmissionInTransaction(client: PoolClient, command: NativeInputAdmissionCommand,
    authority: NativeInputStorageAuthority, batch: NativeInputDecodedBatch): Promise<InputCommandReceipt> {
    this.verifier()
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    if (authority.writer.sessionId !== command.sessionId) refuse('native_input_scope_conflict')
    const actor: Actor = { kind: 'writer', userId: writer.userId, workerId: authority.writer.workerId, writerEpoch: authority.writer.epoch }
    const prior = await this.replayInTransaction(client, command.sessionId, actor, command.rpcNonce, nativeInputRecordDigest(command))
    if (prior) { await this.writers.assertLiveInTransaction(client, authority.writer); return prior }
    const context = await this.authorize(client, authority, command.sessionId, writer.userId)
    return this.admission(client, context, actor, command, batch)
  }

  private async admission(client: PoolClient, context: Context, actor: Actor, command: NativeInputAdmissionCommand,
    batch: NativeInputDecodedBatch, credential?: string): Promise<InputCommandReceipt> {
    const intent = nativeInputRecordDigest(command)
    const history = await readInputHistory(client, command.sessionId, this.limits)
    this.batch(history, batch)
    if (batch.events.length !== 1) refuse('native_input_batch_incomplete')
    const event = batch.events[0]
    if (event?.type !== 'agent/inbox/spliced' || event.data.target !== command.target
      || event.data.start !== history.inbox[command.target].length || (event.data.removedCount ?? 0) !== 0
      || event.data.outcome !== undefined || event.data.inserted.length !== 1) refuse('native_input_batch_conflict')
    const audit = await this.audit(client, command.originOperationId, command.sessionId, actor.userId)
    const message = admittedInputMessage.parse({ id: command.messageId, role: 'user', source: this.source(audit),
      content: audit.nativeContent ?? [{ type: 'text', text: continuationInput(audit.text, this.limits.maxEventBytes) }] })
    if (!isDeepStrictEqual(message, event.data.inserted[0])) refuse('native_input_revision_conflict')
    if (history.claims.some(claim => claim.message.id === command.messageId)) refuse('native_input_already_consumed')
    const existing = await client.query('SELECT origin_input_id FROM pe_native_input_origins WHERE origin_operation_id=$1 OR origin_input_id=$2',
      [command.originOperationId, command.originInputId])
    if (existing.rowCount) refuse('native_input_origin_conflict')
    const commandId = inputCommandId.parse(randomUUID())
    const origin = inputOrigin.parse({ originInputId: command.originInputId, sessionId: command.sessionId,
      originOperationId: command.originOperationId, originalRequestId: audit.requestId, messageId: command.messageId,
      acceptedSnapshotDigest: nativeInputRecordDigest(audit), acceptedAudit: audit })
    const revision = inputRevision.parse({ originInputId: origin.originInputId, sessionId: command.sessionId,
      inputRevision: 1, previousRevision: null, cause: 'admission', message, inputDigest: nativeInputRecordDigest(message),
      committedSpliceSeq: event.seq, commandId })
    this.bytes(revision.message, this.limits.maxRevisionBytes, 'native_input_revision_budget')
    const receipt: InputCommandReceipt = { version: 1, commandId, sessionId: command.sessionId, actor, rpcNonce: command.rpcNonce,
      payloadDigest: intent, kind: 'admission', eventCount: history.eventCount + batch.events.length, committedSpliceSeqs: [event.seq],
      result: { kind: 'pending', originInputId: origin.originInputId, inputRevision: 1, inputDigest: revision.inputDigest, target: command.target } }
    await this.append(client, context, batch)
    await write(() => client.query(`INSERT INTO pe_native_input_origins(origin_input_id,session_id,origin_operation_id,original_request_id,
      message_id,accepted_snapshot_digest,accepted_audit_json) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [origin.originInputId, origin.sessionId, origin.originOperationId, origin.originalRequestId, origin.messageId,
      origin.acceptedSnapshotDigest, origin.acceptedAudit]))
    await this.saveReceipt(client, receipt, origin.originInputId)
    await this.saveRevision(client, revision)
    const prepared = await client.query('SELECT operation_id FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
      [context.session.operation_id, context.session.lease_epoch])
    if (prepared.rowCount) await this.frame(client, context, null)
    await this.final(client, context, credential)
    return receipt
  }

  /** Commit a complete initial or subsequent native removal boundary, never one splice of a cohort.
   * @param client Caller transaction.
   * @param command Retained cohort identity and exact requested frame coordinates.
   * @param authority Current internal Writer and operation authority.
   * @param batch Entire strictly decoded native claim boundary.
   * @returns Immutable original cohort receipt staged in the same transaction as all events and claims.
   */
  async commitClaimInTransaction(client: PoolClient, command: NativeInputClaimCommand,
    authority: NativeInputStorageAuthority, batch: NativeInputDecodedBatch): Promise<InputCommandReceipt> {
    this.verifier()
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    if (authority.writer.sessionId !== command.frame.sessionId) refuse('native_input_frame_conflict')
    const actor: Actor = { kind: 'writer', userId: writer.userId, workerId: authority.writer.workerId, writerEpoch: authority.writer.epoch }
    const intent = nativeInputRecordDigest({ command, batch, operationDigest: digest(authority.operationToken) })
    const prior = await this.replayInTransaction(client, command.frame.sessionId, actor, command.rpcNonce, intent)
    if (prior) { await this.writers.assertLiveInTransaction(client, authority.writer); return prior }
    const context = await this.authorize(client, authority, command.frame.sessionId, writer.userId)
    const frame = await this.frame(client, context, command.frame)
    const history = await readInputHistory(client, command.frame.sessionId, this.limits)
    this.batch(history, batch)
    const events = [...batch.events]
    let native = history
    const first = events[0]
    if (first?.type === 'turn/start') {
      if (command.boundaryKind !== 'initial-turn-step' || history.turn !== null) refuse('native_input_turn_conflict')
      native = foldInputHistory(history.header, [...history.events, first])
      events.shift()
    }
    if (native.turn === null || native.step !== null) refuse('native_input_turn_conflict')
    const boundary = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_input_cohorts WHERE session_id=$1 AND turn_start_seq=$2',
      [command.frame.sessionId, native.turn.seq])
    const ordinal = eventSeq.parse(Number(boundary.rows[0]?.count))
    const initial = command.boundaryKind === 'initial-turn-step'
    if (initial ? ordinal !== 0 || frame.owner !== null : ordinal === 0 || frame.owner === null
      || frame.owner.turnStartSeq !== native.turn.seq || frame.owner.turn !== native.turn.turn) refuse('native_input_owner_conflict')
    const precedingSteps = native.events.slice(native.turn.seq + 1).filter(event => event.type === 'step/start').length
    if (precedingSteps !== ordinal) refuse('native_input_step_conflict')
    const expected: { target: 'next-step' | 'next-turn'; messages: readonly NativeInputHistory['inbox']['next-step'][number][] }[] = []
    if (native.inbox['next-step'].length) expected.push({ target: 'next-step', messages: native.inbox['next-step'] })
    const head = native.inbox['next-turn'][0]
    if (initial && head) expected.push({ target: 'next-turn', messages: [head] })
    if (events.length !== expected.length) refuse('native_input_batch_incomplete')
    const claims: InputClaim[] = []
    for (const [spliceIndex, group] of expected.entries()) {
      const event = events[spliceIndex]
      if (event?.type !== 'agent/inbox/spliced' || event.data.target !== group.target || event.data.start !== 0
        || event.data.removedCount !== group.messages.length || event.data.inserted.length !== 0
        || event.data.outcome !== undefined) refuse('native_input_batch_conflict')
      for (const [itemOrdinal, message] of group.messages.entries()) {
        const pending = await this.pending(client, command.frame.sessionId, message.id, native)
        if (pending.origin.acceptedAudit.userId !== context.userId) corrupt()
        claims.push(inputClaim.parse({ originInputId: pending.origin.originInputId, sessionId: command.frame.sessionId,
          inputRevision: pending.revision.inputRevision, inputDigest: pending.revision.inputDigest, cohortId: command.cohortId,
          claimSpliceSeq: event.seq, spliceItemOrdinal: itemOrdinal, cohortOrdinal: claims.length, target: group.target }))
      }
    }
    if (claims.length > this.limits.maxCohortInputs) throw new PlatformError(413, 'native_input_cohort_budget')
    const ownerMessage = initial ? head ?? native.inbox['next-step'][0] : undefined
    let owner: NativeInputOwnerBinding
    const ownerKind: InputCohort['owner']['kind'] = initial ? head ? 'next-turn-head' : 'first-next-step' : 'current-frame'
    if (initial) {
      if (!ownerMessage) refuse('native_input_owner_missing')
      const owned = await this.pending(client, command.frame.sessionId, ownerMessage.id, native)
      const claim = claims.find(item => item.originInputId === owned.origin.originInputId)
      if (!claim || claim.spliceItemOrdinal !== 0 || frame.candidateOriginInputId !== owned.origin.originInputId
        || frame.messageId !== ownerMessage.id || frame.operationId !== owned.origin.originOperationId) refuse('native_input_owner_conflict')
      this.snapshotOwner(frame, owned.origin)
      owner = { originInputId: claim.originInputId, inputRevision: claim.inputRevision, inputDigest: claim.inputDigest,
        cohortId: command.cohortId, claimSpliceSeq: claim.claimSpliceSeq, spliceItemOrdinal: claim.spliceItemOrdinal,
        target: claim.target, turnStartSeq: native.turn.seq, turn: native.turn.turn }
    } else {
      if (frame.owner === null) refuse('native_input_owner_missing')
      owner = frame.owner
      await this.ownerClaim(client, frame, owner)
    }
    const commandId = inputCommandId.parse(randomUUID())
    const cohort = inputCohort.parse({ cohortId: command.cohortId,
      frame: { ...command.frame, ownerInput: { originInputId: owner.originInputId, inputRevision: owner.inputRevision,
        inputDigest: owner.inputDigest } },
      commandId, owner: { kind: ownerKind, originInputId: owner.originInputId }, turnStartSeq: native.turn.seq,
      turn: native.turn.turn, boundaryOrdinal: ordinal, stepStartSeq: null, claimCount: claims.length,
      claimSpliceSeqs: events.map(event => event.seq) })
    const receipt: InputCommandReceipt = { version: 1, commandId, sessionId: command.frame.sessionId, actor,
      rpcNonce: command.rpcNonce, payloadDigest: intent, kind: 'claim', eventCount: history.eventCount + batch.events.length,
      committedSpliceSeqs: cohort.claimSpliceSeqs, result: { kind: 'claimed', cohortId: cohort.cohortId } }
    await this.append(client, context, batch)
    await this.saveReceipt(client, receipt, null)
    await this.saveCohort(client, cohort)
    for (const claim of claims) await write(() => client.query(`INSERT INTO pe_native_input_claims(origin_input_id,session_id,input_revision,
      input_digest,cohort_id,claim_splice_seq,splice_item_ordinal,cohort_ordinal,target) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [claim.originInputId, claim.sessionId, claim.inputRevision, claim.inputDigest, claim.cohortId,
      claim.claimSpliceSeq, claim.spliceItemOrdinal, claim.cohortOrdinal, claim.target]))
    if (initial) {
      const bound = await this.verifier()(client, { authority, expected: command.frame, kind: 'bind-owner', owner })
      this.frameFields(bound, context, command.frame)
      if (!isDeepStrictEqual(bound.owner, owner)) refuse('native_input_owner_conflict')
    }
    await this.final(client, context)
    return receipt
  }

  /** Strict foreign admission entry; native vocabulary is decoded against actual PG metadata.
   * @param credential Current browser bearer.
   * @param input Command, internal authority and whole native JSON batch.
   * @returns Immutable result after successful commit.
   */
  async admit(credential: string, input: unknown): Promise<InputCommandReceipt> {
    const value = request(z.object({ command: nativeInputAdmissionCommand, authority: nativeInputStorageAuthority,
      expectedEventCount: eventSeq, events: z.array(z.json()) }).strict(), input)
    return transaction(this.tasks.pool, async (client) => {
      await this.browser(client, credential, value.command.sessionId)
      const history = await readInputHistory(client, value.command.sessionId, this.limits)
      const batch = { expectedEventCount: value.expectedEventCount, events: parseEvents(history.header, value.events) }
      return this.commitAdmissionInTransaction(client, credential, value.command, value.authority, batch)
    })
  }

  /** Strict foreign complete-boundary entry; it never consumes only the first splice.
   * @param input Retained command, exact internal authority and native JSON events.
   * @returns Original cohort result after commit.
   */
  async claim(input: unknown): Promise<InputCommandReceipt> {
    const value = request(z.object({ command: nativeInputClaimCommand, authority: nativeInputStorageAuthority,
      expectedEventCount: eventSeq, events: z.array(z.json()) }).strict(), input)
    return transaction(this.tasks.pool, async (client) => {
      await this.writers.requireInTransaction(client, value.authority.writer)
      if (value.authority.writer.sessionId !== value.command.frame.sessionId) refuse('native_input_frame_conflict')
      const history = await readInputHistory(client, value.command.frame.sessionId, this.limits)
      const batch = { expectedEventCount: value.expectedEventCount, events: parseEvents(history.header, value.events) }
      return this.commitClaimInTransaction(client, value.command, value.authority, batch)
    })
  }

  /** Commit one complete native public edit, removal or steering batch against its locked PG pre-state.
   * @param client Caller transaction.
   * @param credential Current authenticated browser bearer.
   * @param command Existing public payload and retained carrier nonce.
   * @param authority Exact internal storage Writer and operation grant.
   * @param batch Entire strictly decoded official native batch.
   * @returns Original immutable result; edits retain source, role and MessageId, and removal retires its queued origin.
   */
  async commitQueueInTransaction(client: PoolClient, credential: string, command: NativeInputQueueCommand,
    authority: NativeInputStorageAuthority, batch: NativeInputDecodedBatch): Promise<InputCommandReceipt> {
    this.verifier()
    const actor = await this.browser(client, credential, command.payload.sessionId)
    const intent = nativeInputRecordDigest(command)
    const prior = await this.replayInTransaction(client, command.payload.sessionId, actor, command.rpcNonce, intent)
    if (prior) { await this.browser(client, credential, command.payload.sessionId); return prior }
    const context = await this.authorize(client, authority, command.payload.sessionId, actor.userId)
    await this.frame(client, context, null)
    const history = await readInputHistory(client, command.payload.sessionId, this.limits)
    this.batch(history, batch)
    const pending = await this.pending(client, command.payload.sessionId, command.payload.itemId, history)
    if (pending.origin.acceptedAudit.userId !== actor.userId) corrupt()
    const from = history.inbox['next-turn'].some(message => message.id === command.payload.itemId) ? 'next-turn' : 'next-step'
    const position = history.inbox[from].findIndex(message => message.id === command.payload.itemId)
    const action = command.payload.action
    let resolvedTarget: 'next-step' | 'next-turn' = from
    const message = action.kind === 'edit' ? { ...pending.revision.message, content: action.content } : pending.revision.message
    const expectedCount = action.kind === 'steer' ? 2 : 1
    if (batch.events.length !== expectedCount) refuse('native_input_batch_incomplete')
    const removal = batch.events[0]
    if (removal?.type !== 'agent/inbox/spliced' || removal.data.target !== from || removal.data.start !== position
      || removal.data.removedCount !== 1 || removal.data.outcome !== 'canceled'
      || !isDeepStrictEqual(removal.data.inserted, action.kind === 'edit' ? [message] : [])) refuse('native_input_batch_conflict')
    if (action.kind === 'steer') {
      const insertion = batch.events[1]
      if (from !== 'next-turn' || history.turn === null || insertion?.type !== 'agent/inbox/spliced'
        || insertion.data.start !== history.inbox[insertion.data.target].length - (insertion.data.target === from ? 1 : 0)
        || (insertion.data.removedCount ?? 0) !== 0 || insertion.data.outcome !== undefined
        || !isDeepStrictEqual(insertion.data.inserted, [message])) refuse('native_input_batch_conflict')
      resolvedTarget = insertion.data.target
    }
    const commandId = inputCommandId.parse(randomUUID())
    const revision = action.kind === 'edit' ? inputRevision.parse({ ...pending.revision,
      inputRevision: pending.revision.inputRevision + 1, previousRevision: pending.revision.inputRevision, cause: 'edit',
      message, inputDigest: nativeInputRecordDigest(message), committedSpliceSeq: removal.seq, commandId }) : pending.revision
    this.bytes(message, this.limits.maxRevisionBytes, 'native_input_revision_budget')
    const receipt: InputCommandReceipt = { version: 1, commandId, sessionId: command.payload.sessionId, actor,
      rpcNonce: command.rpcNonce, payloadDigest: intent, kind: action.kind === 'steer' ? 'retarget' : action.kind,
      eventCount: history.eventCount + batch.events.length, committedSpliceSeqs: batch.events.map(event => event.seq),
      result: action.kind === 'remove'
        ? { kind: 'removed', originInputId: pending.origin.originInputId, inputRevision: revision.inputRevision, inputDigest: revision.inputDigest }
        : { kind: 'pending', originInputId: pending.origin.originInputId, inputRevision: revision.inputRevision,
          inputDigest: revision.inputDigest, target: resolvedTarget } }
    if (action.kind === 'remove') {
      const audit = await this.audit(client, pending.origin.originOperationId, command.payload.sessionId, actor.userId)
      if (nativeInputRecordDigest(audit) !== pending.origin.acceptedSnapshotDigest) corrupt()
      // An active prepared owner needs its own fenced retirement; it cannot be ended as an unrelated queued origin.
      const retired = await client.query(`UPDATE pe_operations SET state='failed',error_code='native_input_removed',
        completed_at=clock_timestamp() WHERE id=$1 AND session_id=$2 AND state='queued'
        AND NOT EXISTS(SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$3) RETURNING id`,
      [pending.origin.originOperationId, command.payload.sessionId, pending.origin.originInputId])
      if (retired.rowCount !== 1) refuse('native_input_remove_active_owner')
    }
    await this.append(client, context, batch)
    await this.saveReceipt(client, receipt, pending.origin.originInputId)
    if (action.kind === 'edit') await this.saveRevision(client, revision)
    await this.final(client, context, credential)
    return receipt
  }

  /** Stage only the current canceled prepared candidate's genuine pending removal, without ending its source.
   * The caller must publish this canonical suffix while the source is running, retire the same frame and source,
   * then insert the complete immutable receipt and perform the terminal joint clock check in this transaction.
   * @param client Caller-owned atomic cancellation transaction.
   * @param authority Original operation bearer and exact current independent Writer.
   * @param command Retained remove command addressing only the prepared candidate's native message.
   * @param expected Original prepared frame coordinates, separately checked by the frame provider.
   * @param intent Digest of the complete retained request and original operation bearer digest.
   * @param batch One strictly decoded native canceled removal against the exact current canonical prefix.
   * @returns Tokenless removed-input facts not yet persisted as an immutable command receipt.
   */
  async stagePreparedCancelInTransaction(client: PoolClient, authority: NativeInputStorageAuthority,
    command: NativeInputQueueCommand, expected: NativeInputFrameExpected, intent: string,
    batch: NativeInputDecodedBatch): Promise<InputCommandReceipt> {
    if (command.payload.action.kind !== 'remove') refuse('native_input_prepared_cancel_conflict')
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    if (session.id !== command.payload.sessionId || session.id !== authority.writer.sessionId
      || session.user_id !== writer.userId) refuse('native_input_scope_conflict')
    const active = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
      WHERE o.id=$1 AND o.session_id=$2 AND o.state='running' AND o.error_code='cancel_requested'
      AND a.epoch=$3 AND a.worker_id=$4 AND a.ended_at IS NULL FOR UPDATE OF o,a`,
    [session.operation_id, session.id, session.lease_epoch, authority.writer.workerId])
    if (active.rowCount !== 1) refuse('native_input_prepared_cancel_conflict')
    const context: Context = { authority, session, userId: writer.userId }
    const receiving = command.payload.sessionId
    const frame = await this.frame(client, context, { sessionId: expected.sessionId, operationId: expected.operationId,
      operationEpoch: expected.operationEpoch, writerEpoch: expected.writerEpoch, frozenSnapshotDigest: expected.frozenSnapshotDigest })
    if (frame.owner !== null || frame.messageId !== command.payload.itemId) refuse('native_input_prepared_cancel_conflict')
    const history = await readInputHistory(client, receiving, this.limits)
    this.batch(history, batch)
    if (history.turn !== null || history.step !== null || batch.events.length !== 1) refuse('native_input_turn_conflict')
    const pending = await this.pending(client, receiving, command.payload.itemId, history)
    if (pending.origin.originInputId !== frame.candidateOriginInputId || pending.origin.originOperationId !== session.operation_id
      || pending.origin.acceptedAudit.userId !== writer.userId) refuse('native_input_prepared_cancel_conflict')
    const audit = await this.audit(client, pending.origin.originOperationId, receiving, writer.userId, 'prepared-user-cancel')
    if (nativeInputRecordDigest(audit) !== pending.origin.acceptedSnapshotDigest) corrupt()
    this.snapshotOwner(frame, pending.origin)
    const target = history.inbox['next-turn'].some(message => message.id === command.payload.itemId) ? 'next-turn' : 'next-step'
    const position = history.inbox[target].findIndex(message => message.id === command.payload.itemId)
    const event = batch.events[0]
    if (event?.type !== 'agent/inbox/spliced' || event.data.target !== target || event.data.start !== position
      || event.data.removedCount !== 1 || event.data.outcome !== 'canceled' || event.data.inserted.length !== 0) {
      refuse('native_input_batch_conflict')
    }
    const receipt: InputCommandReceipt = { version: 1, commandId: inputCommandId.parse(randomUUID()), sessionId: receiving,
      actor: { kind: 'writer', userId: writer.userId, workerId: authority.writer.workerId, writerEpoch: authority.writer.epoch },
      rpcNonce: command.rpcNonce, payloadDigest: intent, kind: 'remove', eventCount: history.eventCount + 1,
      committedSpliceSeqs: [event.seq], result: { kind: 'removed', originInputId: pending.origin.originInputId,
        inputRevision: pending.revision.inputRevision, inputDigest: pending.revision.inputDigest } }
    await this.append(client, context, batch)
    return receipt
  }

  /** Insert a complete prepared retirement receipt once, after its real publication and terminal writes.
   * @param client Caller transaction retaining the source, Writer and publication proofs until its final clock check.
   * @param value Removed-input receipt with the actual tokenless publication acknowledgement and retired frame.
   * @returns Completion after one immutable command insertion; this never updates an older receipt.
   */
  async savePreparedCancelReceiptInTransaction(client: PoolClient, value: InputCommandReceipt): Promise<void> {
    const receipt = inputCommandReceipt.parse(value)
    if (receipt.kind !== 'remove' || receipt.result.kind !== 'removed' || !receipt.result.retirement) {
      refuse('native_input_prepared_cancel_conflict')
    }
    await this.saveReceipt(client, receipt, receipt.result.originInputId)
  }

  /** Remove one queued sibling for the current requested archival stop while keeping the source running.
   * The caller proves the original frame through the actual frame provider in this transaction, publishes
   * the canonical suffix, saves the complete acknowledgement and checks source, Writer and publisher clocks.
   * Historical prepared rows, accepted audits, permanent claims and the current source remain unchanged.
   * @param client Caller transaction holding the active account and owned Session locks.
   * @param authority Current actual storage operation and independently acquired Session Writer.
   * @param command Retained remove command identifying one genuine pending sibling.
   * @param frame Original current or historical consumed frame proof supplied by the actual provider.
   * @param stopId Original requested archival stop identity, independent of visibility and operation generations.
   * @param intent Digest of the complete retained request and original operation bearer digest.
   * @param batch One strictly decoded official canceled splice against the exact latest native prefix.
   * @param verifyPrepared Actual read-only frame provider for fully ended historical prepared sibling scopes.
   * @returns Removed-input facts pending real publication and one immutable receipt insertion.
   */
  async stageArchiveCancelInTransaction(client: PoolClient, authority: NativeInputStorageAuthority,
    command: NativeInputQueueCommand, frame: NativeInputVerifiedFrame, stopId: NativeSessionStopId,
    intent: string, batch: NativeInputDecodedBatch,
    verifyPrepared: (client: PoolClient, origin: InputOrigin, current: NativeInputVerifiedFrame, attempts: number) => Promise<void>)
    : Promise<InputCommandReceipt> {
    if (command.payload.action.kind !== 'remove') refuse('native_input_archive_conflict')
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    const session = await this.tasks.authorized(client, authority.operationToken)
    if (session.id !== command.payload.sessionId || session.id !== authority.writer.sessionId
      || session.user_id !== writer.userId || frame.sessionId !== session.id || frame.operationId !== session.operation_id) {
      refuse('native_input_scope_conflict')
    }
    const stop = await readSessionStopInTransaction(client, writer.userId, command.payload.sessionId)
    if (stop?.status !== 'requested' || stop.stopId !== stopId) refuse('native_input_archive_stop_conflict')
    const active = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
      WHERE o.id=$1 AND o.session_id=$2 AND o.state='running' AND o.error_code='cancel_requested'
      AND a.epoch=$3 AND a.worker_id=$4 AND a.ended_at IS NULL FOR UPDATE OF o,a`,
    [session.operation_id, session.id, session.lease_epoch, authority.writer.workerId])
    if (active.rowCount !== 1 || (frame.owner === null && command.payload.itemId === frame.messageId)) {
      refuse('native_input_archive_conflict')
    }
    const history = await readInputHistory(client, command.payload.sessionId, this.limits)
    this.batch(history, batch)
    if (history.turn !== null || history.step !== null || batch.events.length !== 1) refuse('native_input_turn_conflict')
    const pending = await this.pending(client, command.payload.sessionId, command.payload.itemId, history)
    if (pending.origin.originOperationId === session.operation_id || pending.origin.originInputId === frame.candidateOriginInputId
      || pending.origin.acceptedAudit.userId !== writer.userId) refuse('native_input_archive_conflict')
    const audit = await this.audit(client, pending.origin.originOperationId, command.payload.sessionId, writer.userId)
    if (nativeInputRecordDigest(audit) !== pending.origin.acceptedSnapshotDigest) corrupt()
    const scope = await client.query<{ attempts: number; open: boolean; historical: boolean; executed: boolean }>(`SELECT o.attempts,
      EXISTS(SELECT 1 FROM pe_attempts WHERE operation_id=o.id AND ended_at IS NULL) AS open,
      EXISTS(SELECT 1 FROM pe_attempts WHERE operation_id=o.id
        UNION ALL SELECT 1 FROM pe_native_turn_frames WHERE operation_id=o.id) AS historical,
      EXISTS(SELECT 1 FROM pe_native_input_cohorts WHERE execution_operation_id=o.id) AS executed
      FROM pe_operations o WHERE o.id=$1 AND o.session_id=$2 AND o.state='queued' FOR UPDATE OF o`,
    [pending.origin.originOperationId, command.payload.sessionId])
    const targetScope = scope.rows[0]
    if (scope.rowCount !== 1 || !targetScope) refuse('native_input_archive_conflict')
    if (targetScope.open) refuse('native_input_archive_attempt_active')
    if (targetScope.executed) refuse('native_input_already_consumed')
    if (targetScope.attempts > 0) await verifyPrepared(client, pending.origin, frame, targetScope.attempts)
    else if (targetScope.historical) corrupt()
    const target = history.inbox['next-turn'].some(message => message.id === command.payload.itemId) ? 'next-turn' : 'next-step'
    const position = history.inbox[target].findIndex(message => message.id === command.payload.itemId), event = batch.events[0]
    if (event?.type !== 'agent/inbox/spliced' || event.data.target !== target || event.data.start !== position
      || event.data.removedCount !== 1 || event.data.outcome !== 'canceled' || event.data.inserted.length !== 0) {
      refuse('native_input_batch_conflict')
    }
    const removed = await client.query(`UPDATE pe_operations SET state='failed',error_code='turn_user',completed_at=clock_timestamp()
      WHERE id=$1 AND session_id=$2 AND state='queued' AND attempts=$4
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_claims WHERE origin_input_id=$3) RETURNING id`,
    [pending.origin.originOperationId, command.payload.sessionId, pending.origin.originInputId, targetScope.attempts])
    if (removed.rowCount !== 1) refuse('native_input_archive_conflict')
    const receipt: InputCommandReceipt = { version: 1, commandId: inputCommandId.parse(randomUUID()), sessionId: command.payload.sessionId,
      actor: { kind: 'writer', userId: writer.userId, workerId: authority.writer.workerId, writerEpoch: authority.writer.epoch },
      rpcNonce: command.rpcNonce, payloadDigest: intent, kind: 'remove', eventCount: history.eventCount + 1,
      committedSpliceSeqs: [event.seq], result: { kind: 'removed', originInputId: pending.origin.originInputId,
        inputRevision: pending.revision.inputRevision, inputDigest: pending.revision.inputDigest } }
    await this.append(client, { authority, session, userId: writer.userId }, batch)
    return receipt
  }

  /** Save one archival removal with its original stop and real publisher acknowledgement.
   * @param client Caller transaction retaining current source, Writer, stop and publisher proofs.
   * @param value Complete tokenless archival receipt; existing immutable rows are never updated.
   * @returns Completion after one command insertion, before the caller's joint final clock check.
   */
  async saveArchiveCancelReceiptInTransaction(client: PoolClient, value: InputCommandReceipt): Promise<void> {
    const receipt = inputCommandReceipt.parse(value)
    if (receipt.kind !== 'remove' || receipt.actor.kind !== 'writer' || receipt.result.kind !== 'removed'
      || receipt.result.archive === undefined || receipt.result.retirement !== undefined) refuse('native_input_archive_conflict')
    await this.saveReceipt(client, receipt, receipt.result.originInputId)
  }

  /** Plan through the installed official detached adapter, then commit the complete native batch.
   * @param credential Current browser bearer.
   * @param input Existing public request and retained carrier nonce, without internal authority fields.
   * @param authority Exact current internal Writer and storage operation grant.
   * @param activity Protected native phase capture supplied by the adapter.
   * @returns Original immutable result after successful commit; absent planner refuses.
   */
  async queue(credential: string, input: unknown, authority: NativeInputStorageAuthority,
    activity?: NativeInputPlanningActivity): Promise<InputCommandReceipt> {
    const command = request(nativeInputQueueCommand, input)
    this.verifier()
    const planner = this.planner
    if (!planner) throw new PlatformError(503, 'native_input_planner_unavailable')
    return transaction(this.tasks.pool, async (client) => {
      const actor = await this.browser(client, credential, command.payload.sessionId)
      const prior = await this.replayInTransaction(client, command.payload.sessionId, actor, command.rpcNonce,
        nativeInputRecordDigest(command))
      if (prior) { await this.browser(client, credential, command.payload.sessionId); return prior }
      await this.authorize(client, authority, command.payload.sessionId, actor.userId)
      const history = await readInputHistory(client, command.payload.sessionId, this.limits)
      activity?.assertCurrent()
      const plan = await planner.planQueue(history.header, history.events, command, activity)
      const result = await this.commitQueueInTransaction(client, credential, command, authority, plan)
      activity?.assertCurrent()
      return result
    })
  }

  /** Bind a complete consumed cohort to one actual stored step/start, never reconsume its inputs.
   * @param client Caller transaction after its canonical step event append.
   * @param command Original cohort and exact current frame coordinates.
   * @param authority Live internal Writer and original operation authority.
   * @returns Accurate cohort and all permanent claims after one-time binding.
   */
  async bindStepInTransaction(client: PoolClient, command: NativeInputStepCommand,
    authority: NativeInputStorageAuthority): Promise<{ cohort: InputCohort; claims: readonly InputClaim[] }> {
    this.verifier()
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    const context = await this.authorize(client, authority, command.frame.sessionId, writer.userId)
    const frame = await this.frame(client, context, command.frame)
    const stored = await this.cohort(client, command.cohortId, command.frame.sessionId)
    if (frame.owner === null || stored.cohort.frame.operationId !== frame.operationId
      || stored.cohort.frame.operationEpoch !== frame.operationEpoch || stored.cohort.frame.writerEpoch !== frame.writerEpoch
      || stored.cohort.frame.frozenSnapshotDigest !== frame.frozenSnapshotDigest
      || stored.cohort.owner.originInputId !== frame.owner.originInputId
      || stored.cohort.turnStartSeq !== frame.owner.turnStartSeq) refuse('native_input_frame_conflict')
    await this.ownerClaim(client, frame, frame.owner)
    const history = await readInputHistory(client, command.frame.sessionId, this.limits)
    const step = history.events[command.stepStartSeq]
    if (step?.type !== 'step/start' || step.data.turn !== stored.cohort.turn
      || command.stepStartSeq <= Math.max(stored.cohort.turnStartSeq, ...stored.cohort.claimSpliceSeqs)) refuse('native_input_step_conflict')
    const before = history.events.slice(stored.cohort.turnStartSeq + 1, command.stepStartSeq)
    const actualOrdinal = before.filter(event => event.type === 'step/start').length
    if (actualOrdinal !== stored.cohort.boundaryOrdinal || before.some(event => event.type === 'turn/end')) refuse('native_input_step_conflict')
    if (stored.cohort.stepStartSeq !== null && stored.cohort.stepStartSeq !== command.stepStartSeq) refuse('native_input_step_conflict')
    if (stored.cohort.stepStartSeq === null) await client.query('UPDATE pe_native_input_cohorts SET step_start_seq=$3 WHERE cohort_id=$1 AND session_id=$2',
      [command.cohortId, command.frame.sessionId, command.stepStartSeq])
    await this.final(client, context)
    return { cohort: { ...stored.cohort, stepStartSeq: command.stepStartSeq }, claims: stored.claims }
  }

  /** Strict foreign step-binding entry for an already stored actual native event.
   * @param input Exact step command and current internal authority.
   * @returns Original complete cohort with the single accurate step binding.
   */
  async bindStep(input: unknown): Promise<{ cohort: InputCohort; claims: readonly InputClaim[] }> {
    const value = request(z.object({ command: nativeInputStepCommand, authority: nativeInputStorageAuthority }).strict(), input)
    return transaction(this.tasks.pool, client => this.bindStepInTransaction(client, value.command, value.authority))
  }

  /** Replay only inside the currently authenticated Session and actor namespace.
   * @param client Transaction already authenticating the actor and locking this Session.
   * @param sessionId Exact currently authorized Session; never omitted from the nonce lookup.
   * @param actor Current authenticated browser or live Writer scope.
   * @param nonce Original retained RPC identity.
   * @param intent Digest of the original command, excluding newly chosen output ids.
   * @returns Original immutable result or null; conflicting payloads refuse.
   */
  async replayInTransaction(client: PoolClient, sessionId: SessionId, actor: Actor, nonce: string,
    intent: string): Promise<InputCommandReceipt | null> {
    const scope = actorFields(actor)
    const result = await client.query<Record<string, unknown>>(`SELECT session_id AS "sessionId",command_id AS "commandId",user_id AS "userId",
      actor_kind AS "actorKind",actor_id AS "actorId",writer_epoch::double precision AS "writerEpoch",transport_nonce AS "rpcNonce",
      payload_digest AS "payloadDigest",kind,target_origin_input_id AS "targetOriginInputId",committed_event_count AS "eventCount",
      receipt_json AS receipt FROM pe_native_input_commands WHERE session_id=$1 AND actor_kind=$2 AND actor_id=$3
      AND writer_epoch IS NOT DISTINCT FROM $4::bigint AND transport_nonce=$5`, [sessionId, actor.kind, scope.id, scope.epoch, nonce])
    const raw = result.rows[0]
    if (!raw) return null
    const row = commandRow.safeParse(raw)
    if (!row.success) corrupt()
    const stored = row.data
    if (stored.payloadDigest !== intent) refuse('native_input_nonce_conflict')
    const receipt = readInputReceipt(stored.receipt)
    if (receipt.sessionId !== sessionId || receipt.commandId !== stored.commandId || receipt.eventCount !== stored.eventCount
      || receipt.rpcNonce !== nonce || receipt.payloadDigest !== intent || receipt.kind !== stored.kind
      || stored.userId !== actor.userId || !isDeepStrictEqual(receipt.actor, actor)) corrupt()
    if (receipt.result.kind === 'claimed') {
      if (stored.targetOriginInputId !== null) corrupt()
      const cohort = await this.cohort(client, receipt.result.cohortId, sessionId)
      if (cohort.cohort.commandId !== receipt.commandId
        || !isDeepStrictEqual(cohort.cohort.claimSpliceSeqs, receipt.committedSpliceSeqs)) corrupt()
    } else {
      if (stored.targetOriginInputId !== receipt.result.originInputId) corrupt()
      const origin = await this.origin(client, receipt.result.originInputId, sessionId)
      if (origin.acceptedAudit.userId !== actor.userId) corrupt()
      const revision = await this.revision(client, receipt.result.originInputId, receipt.result.inputRevision, sessionId)
      if (revision.inputDigest !== receipt.result.inputDigest) corrupt()
    }
    return receipt
  }

  private verifier(): NativeInputFrameVerifier {
    if (!this.frameVerifier) throw new PlatformError(503, 'native_input_frame_verifier_unavailable')
    return this.frameVerifier
  }

  private async browser(client: PoolClient, credential: string, sessionId: SessionId): Promise<Extract<Actor, { kind: 'browser' }>> {
    const actor = await requireBrowserAccount(client, credential, { lock: 'update' })
    const owned = await this.tasks.owned(client, { userId: actor.userId, username: actor.username }, sessionId)
    const lock = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [owned.id, actor.userId])
    if (!lock.rowCount) throw new PlatformError(404, 'session_not_found')
    return { kind: 'browser', userId: actor.userId }
  }

  private async authorize(client: PoolClient, authority: NativeInputStorageAuthority, sessionId: SessionId,
    owner: UserId): Promise<Context> {
    const writer = await this.writers.requireInTransaction(client, authority.writer)
    if (writer.userId !== owner || authority.writer.sessionId !== sessionId) refuse('native_input_scope_conflict')
    const session = await this.tasks.authorized(client, authority.operationToken)
    if (session.id !== sessionId || session.user_id !== owner) refuse('native_input_scope_conflict')
    if (await isSessionBusinessBlockedInTransaction(client, owner, sessionId)) refuse('native_session_archived')
    const attempt = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
      WHERE o.id=$1 AND o.session_id=$2 AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested'
      AND a.epoch=$3 AND a.worker_id=$4 AND a.ended_at IS NULL FOR UPDATE OF o,a`,
    [session.operation_id, sessionId, session.lease_epoch, authority.writer.workerId])
    if (!attempt.rowCount) refuse('native_input_attempt_conflict')
    return { authority, session, userId: owner }
  }

  private async frame(client: PoolClient, context: Context, expected: NativeInputFrameExpected | null): Promise<NativeInputVerifiedFrame> {
    const frame = await this.verifier()(client, { authority: context.authority, expected, kind: 'read' })
    this.frameFields(frame, context, expected)
    return frame
  }

  private frameFields(frame: NativeInputVerifiedFrame, context: Context, expected: NativeInputFrameExpected | null): void {
    if (frame.sessionId !== context.session.id || frame.operationId !== context.session.operation_id
      || frame.operationEpoch !== context.session.lease_epoch || frame.writerEpoch !== context.authority.writer.epoch
      || frame.frozenSnapshot.userId !== context.userId || frame.frozenSnapshot.sessionId !== frame.sessionId
      || frame.frozenSnapshot.operationId !== frame.operationId || frame.frozenSnapshot.epoch !== frame.operationEpoch
      || ledgerFrozenSnapshotDigest(frame.frozenSnapshot) !== frame.frozenSnapshotDigest
      || (expected !== null && (expected.sessionId !== frame.sessionId || expected.operationId !== frame.operationId
        || expected.operationEpoch !== frame.operationEpoch || expected.writerEpoch !== frame.writerEpoch
        || expected.frozenSnapshotDigest !== frame.frozenSnapshotDigest))) refuse('native_input_frame_conflict')
  }

  private batch(history: NativeInputHistory, batch: NativeInputDecodedBatch): void {
    this.bytes(batch, this.limits.maxCommandBytes, 'native_input_command_budget')
    if (batch.expectedEventCount !== history.eventCount || batch.events.some((event, index) => event.seq !== history.eventCount + index)) {
      refuse('native_input_queue_changed')
    }
    if (history.eventCount + batch.events.length > this.limits.maxHistoryEvents) throw new PlatformError(413, 'native_input_history_budget')
    foldInputHistory(history.header, [...history.events, ...batch.events])
  }

  private bytes(value: unknown, maximum: number, code: string): void {
    if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new PlatformError(413, code)
  }

  private async append(client: PoolClient, context: Context, batch: NativeInputDecodedBatch): Promise<void> {
    await this.events.appendInTransaction(client, context.session, batch.events)
  }

  private async final(client: PoolClient, context: Context, credential?: string): Promise<void> {
    if (credential !== undefined) await this.browser(client, credential, context.authority.writer.sessionId)
    const live = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
      JOIN pe_operations o ON o.id=$1 AND o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$2
      WHERE s.id=$3 AND s.user_id=$4 AND s.grant_digest=$5 AND s.lease_epoch=$2 AND s.lease_until>clock_timestamp()
      AND w.worker_id=$6 AND w.epoch=$7 AND w.token_digest=$8 AND w.expires_at>clock_timestamp()
      AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested' AND a.worker_id=w.worker_id AND a.ended_at IS NULL
      AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM pe_credentials c JOIN pe_users u ON u.id=c.user_id
        WHERE c.digest=$9 AND c.user_id=s.user_id AND c.audience='agent' AND c.credential_version=u.credential_version
        AND c.expires_at>clock_timestamp()))`,
    [context.session.operation_id, context.session.lease_epoch, context.session.id, context.userId,
      digest(context.authority.operationToken),
      context.authority.writer.workerId, context.authority.writer.epoch, digest(context.authority.writer.token),
      credential === undefined ? null : digest(credential)])
    if (!live.rowCount) refuse('native_input_authority_lost')
  }

  private async audit(client: PoolClient, id: InputOrigin['originOperationId'], sessionId: SessionId, owner: UserId,
    purpose?: 'prepared-user-cancel'): Promise<InputOrigin['acceptedAudit']> {
    const size = await client.query<{ bytes: number; state: string; errorCode: string | null }>(`SELECT pg_column_size(to_jsonb(o)) AS bytes,
      o.state,o.error_code AS "errorCode" FROM pe_operations o
      JOIN pe_sessions s ON s.id=o.session_id WHERE o.id=$1 AND o.session_id=$2 AND s.user_id=$3 FOR UPDATE OF o`, [id, sessionId, owner])
    const hint = size.rows[0]
    if (!hint || !['queued', 'running'].includes(hint.state)
      || (purpose === 'prepared-user-cancel' ? hint.state !== 'running' || hint.errorCode !== 'cancel_requested'
        : hint.errorCode === 'cancel_requested')) refuse('native_input_origin_conflict')
    if (hint.bytes > this.limits.maxAcceptedAuditBytes) throw new PlatformError(413, 'native_input_audit_budget')
    const found = await client.query<Record<string, unknown>>(`SELECT o.id AS "operationId",o.session_id AS "sessionId",s.user_id AS "userId",
      o.request_id AS "requestId",o.input AS text,o.settings,o.source,o.source_action_id AS "sourceActionId",
      o.source_execution_id AS "sourceExecutionId",o.source_stdio_mcp_call_id AS "sourceStdioMcpCallId",
      o.source_ssh_execute_action_id AS "sourceSshExecuteActionId",o.source_mcp_action_id AS "sourceMcpActionId",
      o.source_stdio_v2_action_id AS "sourceStdioV2ActionId",o.source_stdio_v2_no_start_action_id AS "sourceStdioV2NoStartActionId",
      o.source_stdio_v2_phase AS "sourceStdioV2Phase",o.execution_target AS target,o.skill_selection AS selection,
      o.mcp_selection AS "mcpConnections",o.remote_mcp_selection AS "remoteMcpTools",o.stdio_mcp_selection AS "stdioMcpConnections",
      o.ssh_selection AS "sshConnections",o.stdio_v2_selection AS "stdioV2Connections" FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
      WHERE o.id=$1 AND o.session_id=$2`, [id, sessionId])
    const raw = found.rows[0]
    if (!raw) corrupt()
    const prompt = await client.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2',
      [sessionId, raw.requestId])
    if (raw.source === 'user' && !prompt.rows[0]) corrupt()
    const files = await client.query<{ file: unknown }>('SELECT DISTINCT file FROM pe_native_file_receipts WHERE user_id=$1 AND session_id=$2 AND request_id=$3',
      [owner, sessionId, raw.requestId])
    const attachments = files.rows.map(row => nativeFileAttachment.parse(row.file)).sort((a, b) =>
      a.attachmentId.localeCompare(b.attachmentId) || a.name.localeCompare(b.name))
    const parsed = acceptedInputAudit.safeParse({ ...raw, nativeContent: raw.source === 'user' ? prompt.rows[0]?.admitted : null, attachments })
    if (!parsed.success) corrupt()
    this.bytes(parsed.data, this.limits.maxAcceptedAuditBytes, 'native_input_audit_budget')
    return parsed.data
  }

  private source(audit: InputOrigin['acceptedAudit']): z.infer<typeof admittedInputMessage>['source'] {
    const value = audit.source === 'user' ? { kind: 'user', rpcId: audit.requestId }
      : audit.source === 'platform_action' ? { kind: 'power-evolve-action', actionId: audit.sourceActionId }
        : audit.source === 'sandbox_result' ? { kind: 'power-evolve-execution', executionId: audit.sourceExecutionId }
          : audit.source === 'stdio_mcp_result' ? { kind: 'power-evolve-stdio-mcp', callId: audit.sourceStdioMcpCallId }
            : audit.source === 'ssh_execute_result' ? { kind: 'power-evolve-ssh-execute', actionId: audit.sourceSshExecuteActionId }
              : audit.source === 'remote_mcp_result' ? { kind: 'power-evolve-remote-mcp', actionId: audit.sourceMcpActionId }
                : audit.source === 'stdio_v2_result' ? { kind: 'power-evolve-stdio-v2-result', actionId: audit.sourceStdioV2ActionId, phase: audit.sourceStdioV2Phase }
                  : { kind: 'power-evolve-stdio-v2-no-start', actionId: audit.sourceStdioV2NoStartActionId, phase: audit.sourceStdioV2Phase }
    return admittedInputMessage.shape.source.parse(value)
  }

  private async origin(client: PoolClient, id: InputOrigin['originInputId'], sessionId: SessionId): Promise<InputOrigin> {
    const result = await client.query<Record<string, unknown>>(`SELECT ${originColumns} FROM pe_native_input_origins WHERE origin_input_id=$1 AND session_id=$2`, [id, sessionId])
    const row = result.rows[0]
    if (!row) refuse('native_input_not_found')
    return readInputOrigin(row)
  }

  private async revision(client: PoolClient, id: InputOrigin['originInputId'], revision: number, sessionId: SessionId): Promise<InputRevision> {
    const result = await client.query<Record<string, unknown>>(`SELECT ${revisionColumns} FROM pe_native_input_revisions WHERE origin_input_id=$1 AND input_revision=$2 AND session_id=$3`, [id, revision, sessionId])
    if (!result.rows[0]) corrupt()
    return readInputRevision(result.rows[0])
  }

  private async pending(client: PoolClient, sessionId: SessionId, messageId: string,
    history: NativeInputHistory): Promise<{ origin: InputOrigin; revision: InputRevision }> {
    const located = await client.query<Record<string, unknown>>(`SELECT ${originColumns} FROM pe_native_input_origins WHERE session_id=$1 AND message_id=$2`, [sessionId, messageId])
    if (!located.rows[0]) refuse('native_input_not_found')
    const origin = readInputOrigin(located.rows[0])
    const consumed = await client.query('SELECT origin_input_id FROM pe_native_input_claims WHERE origin_input_id=$1', [origin.originInputId])
    const removed = await client.query("SELECT command_id FROM pe_native_input_commands WHERE target_origin_input_id=$1 AND kind='remove'", [origin.originInputId])
    if (consumed.rowCount || removed.rowCount || history.claims.some(claim => claim.message.id === messageId)) refuse('native_input_already_consumed')
    const latest = await client.query<Record<string, unknown>>(`SELECT ${revisionColumns} FROM pe_native_input_revisions WHERE origin_input_id=$1 AND session_id=$2 ORDER BY input_revision DESC LIMIT 1`, [origin.originInputId, sessionId])
    if (!latest.rows[0]) corrupt()
    const revision = readInputRevision(latest.rows[0])
    const actual = [...history.inbox['next-step'], ...history.inbox['next-turn']].find(message => message.id === messageId)
    if (!actual || revision.message.id !== origin.messageId || !isDeepStrictEqual(actual, revision.message)) refuse('native_input_revision_conflict')
    return { origin, revision }
  }

  private snapshotOwner(frame: NativeInputVerifiedFrame, origin: InputOrigin): void {
    const snapshot = frame.frozenSnapshot, audit = origin.acceptedAudit
    if (snapshot.requestId !== audit.requestId || snapshot.source !== audit.source || snapshot.userId !== audit.userId
      || (audit.source === 'user' ? snapshot.text !== audit.text : !matchesContinuationInput(audit.text, snapshot.text))
      || !isDeepStrictEqual(snapshot.nativeContent, audit.nativeContent)
      || nativeInputRecordDigest([snapshot.settings, snapshot.selection, snapshot.mcpConnections, snapshot.remoteMcpTools,
        snapshot.stdioMcpConnections, snapshot.stdioV2Connections, snapshot.sshConnections, snapshot.sourceActionId,
        snapshot.sourceExecutionId, snapshot.sourceStdioMcpCallId, snapshot.sourceSshExecuteActionId, snapshot.sourceMcpActionId,
        snapshot.sourceStdioV2ActionId, snapshot.sourceStdioV2NoStartActionId, snapshot.sourceStdioV2Phase, snapshot.target])
        !== nativeInputRecordDigest([audit.settings, audit.selection, audit.mcpConnections, audit.remoteMcpTools,
          audit.stdioMcpConnections, audit.stdioV2Connections, audit.sshConnections, audit.sourceActionId,
          audit.sourceExecutionId, audit.sourceStdioMcpCallId, audit.sourceSshExecuteActionId, audit.sourceMcpActionId,
          audit.sourceStdioV2ActionId, audit.sourceStdioV2NoStartActionId, audit.sourceStdioV2Phase, audit.target])
      || audit.attachments.some(file => !snapshot.attachments.some(saved => isDeepStrictEqual(saved, file)))) refuse('native_input_snapshot_conflict')
  }

  private async ownerClaim(client: PoolClient, frame: NativeInputVerifiedFrame, owner: NativeInputOwnerBinding): Promise<void> {
    const found = await client.query<Record<string, unknown>>(`SELECT ${claimColumns} FROM pe_native_input_claims WHERE origin_input_id=$1`, [owner.originInputId])
    if (!found.rows[0]) refuse('native_input_owner_missing')
    const claim = readInputClaim(found.rows[0])
    const stored = await this.cohort(client, claim.cohortId, frame.sessionId)
    if (claim.cohortId !== owner.cohortId || claim.inputRevision !== owner.inputRevision || claim.inputDigest !== owner.inputDigest
      || claim.claimSpliceSeq !== owner.claimSpliceSeq || claim.spliceItemOrdinal !== owner.spliceItemOrdinal
      || claim.target !== owner.target
      || stored.cohort.frame.operationId !== frame.operationId || stored.cohort.frame.operationEpoch !== frame.operationEpoch
      || stored.cohort.frame.writerEpoch !== frame.writerEpoch || stored.cohort.turnStartSeq !== owner.turnStartSeq
      || stored.cohort.turn !== owner.turn || stored.cohort.owner.originInputId !== owner.originInputId) refuse('native_input_owner_conflict')
  }

  private async saveReceipt(client: PoolClient, receipt: InputCommandReceipt, target: InputOrigin['originInputId'] | null): Promise<void> {
    this.bytes(receipt, this.limits.maxCommandBytes, 'native_input_command_budget')
    const scope = actorFields(receipt.actor)
    await write(() => client.query(`INSERT INTO pe_native_input_commands(command_id,session_id,user_id,actor_kind,actor_id,writer_epoch,
      transport_nonce,payload_digest,kind,target_origin_input_id,committed_event_count,receipt_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [receipt.commandId, receipt.sessionId, receipt.actor.userId, receipt.actor.kind, scope.id, scope.epoch,
      receipt.rpcNonce, receipt.payloadDigest, receipt.kind, target, receipt.eventCount, receipt]))
  }

  private async saveRevision(client: PoolClient, revision: InputRevision): Promise<void> {
    await write(() => client.query(`INSERT INTO pe_native_input_revisions(origin_input_id,session_id,input_revision,previous_revision,cause,message_json,
      input_digest,committed_splice_seq,command_id,command_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$5)`,
    [revision.originInputId, revision.sessionId, revision.inputRevision, revision.previousRevision, revision.cause,
      revision.message, revision.inputDigest, revision.committedSpliceSeq, revision.commandId]))
  }

  private async saveCohort(client: PoolClient, value: InputCohort): Promise<void> {
    await write(() => client.query(`INSERT INTO pe_native_input_cohorts(cohort_id,session_id,execution_operation_id,operation_epoch,writer_epoch,
      frozen_snapshot_digest,owner_kind,owner_origin_input_id,owner_input_revision,owner_input_digest,turn_start_seq,turn_number,
      boundary_ordinal,step_start_seq,claim_count,command_id,command_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'claim')`,
    [value.cohortId, value.frame.sessionId, value.frame.operationId, value.frame.operationEpoch, value.frame.writerEpoch,
      value.frame.frozenSnapshotDigest, value.owner.kind, value.owner.originInputId, value.frame.ownerInput.inputRevision,
      value.frame.ownerInput.inputDigest, value.turnStartSeq, value.turn, value.boundaryOrdinal, value.stepStartSeq,
      value.claimCount, value.commandId]))
  }

  private async cohort(client: PoolClient, id: InputCohort['cohortId'], sessionId: SessionId): Promise<{ cohort: InputCohort; claims: readonly InputClaim[] }> {
    const rows = await client.query<Record<string, unknown>>(`SELECT ${claimColumns} FROM pe_native_input_claims WHERE cohort_id=$1 AND session_id=$2 ORDER BY cohort_ordinal`, [id, sessionId])
    const claims = rows.rows.map(readInputClaim)
    const stored = await client.query<Record<string, unknown>>(`SELECT cohort_id AS "cohortId",session_id AS "sessionId",
      execution_operation_id AS "operationId",operation_epoch::double precision AS "operationEpoch",writer_epoch::double precision AS "writerEpoch",
      frozen_snapshot_digest AS "frozenSnapshotDigest",owner_kind AS "ownerKind",owner_origin_input_id AS "originInputId",
      owner_input_revision AS "inputRevision",owner_input_digest AS "inputDigest",turn_start_seq AS "turnStartSeq",turn_number AS turn,
      boundary_ordinal AS "boundaryOrdinal",step_start_seq AS "stepStartSeq",claim_count AS "claimCount",command_id AS "commandId"
      FROM pe_native_input_cohorts WHERE cohort_id=$1 AND session_id=$2`, [id, sessionId])
    const row = stored.rows[0]
    if (!row) refuse('native_input_not_found')
    const value = readStoredNativeInputCohort(row, claims)
    if (claims.length !== value.claimCount || claims.some((claim, index) => claim.cohortOrdinal !== index)) corrupt()
    for (const claim of claims) {
      const revision = await this.revision(client, claim.originInputId, claim.inputRevision, sessionId)
      if (revision.inputDigest !== claim.inputDigest) corrupt()
    }
    return { cohort: value, claims }
  }
}
