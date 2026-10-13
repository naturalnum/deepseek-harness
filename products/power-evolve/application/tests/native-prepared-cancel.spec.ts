/** Actual PG prepared cancellation, immutable lost-reply replay and purpose-specific refusal. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { expect, test } from 'vitest'
import { requestId, operationId } from '../src/contracts.ts'
import { nativeExecutionFrame } from '../src/native-execution-frame-contracts.ts'
import { nativePreparedCancelCommit, nativePreparedCancelIntentDigest } from '../src/native-prepared-cancel-contracts.ts'
import { nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputQueueCommand, inputCohortId, originInputId,
  type NativeInputLedgerLimits } from '../src/native-input-ledger-contracts.ts'
import { foldInputHistory } from '../src/native-input-ledger-records.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import type { NativeAssistantBatch } from '../src/native-assistant-records.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger, NativeInputNativePlanner } from '../src/platform/native-input-ledger.ts'
import { NativePreparedCancel } from '../src/platform/native-prepared-cancel.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { digest } from '../src/platform/identity.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedTestStore, retainedNativeFacts } from './native-retained-intent-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Harness = Awaited<ReturnType<typeof prepare>>
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 16, maxActivePerUser: 2 }
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const inputLimits: NativeInputLedgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
  maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }

class ExpiringPublication extends NativeAssistantStore {
  expireOnCancel = false
  override async commitInputInTransaction(client: PoolClient, token: string, count: number, batch: NativeAssistantBatch) {
    const receipt = await super.commitInputInTransaction(client, token, count, batch)
    if (this.expireOnCancel) await client.query(`UPDATE pe_native_presentations
      SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=(SELECT id FROM pe_sessions WHERE grant_digest=$1)`,
    [digest(token)])
    return receipt
  }
}

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Prepared cancellation fixture returned no row')
  return row
}

async function prepare(f: Fixture, siblings: boolean, expiring: boolean) {
  expect(first((await f.pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).version).toBe(CURRENT_SCHEMA_VERSION)
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'A original', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Prepared cancellation fixture did not acquire its original operation')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const lease = await writers.acquire(grant.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
  const authority = { operationToken: grant.token, writer }
  const events = new EventStore(tasks, { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes })
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits,
    (client, request) => frames.verifyInTransaction(client, request))
  const publisher = expiring ? new ExpiringPublication(tasks, events, presentationLimits)
    : new NativeAssistantStore(tasks, events, presentationLimits)
  const bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers, { input: inputLimits, presentation: presentationLimits })
  const cancel = new NativePreparedCancel(tasks, ledger, frames, publisher, writers,
    { input: inputLimits, presentation: presentationLimits })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), publisherId = randomUUID()
  let ack = await publisher.apply(grant.token,
    { version: 1, epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: 1, items: [] })
  if (siblings) for (const text of ['B sibling', 'C sibling']) {
    await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), text, f.alice.token)
  }
  const items = (await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client, authority, 16))).items
  const order = siblings ? [first(items.slice(1)), first(items), first(items.slice(2))] : [first(items)]
  let prepared
  for (const item of order) {
    const target = item.acceptedInputAudit.text === 'C sibling' ? 'next-step' : 'next-turn'
    const start = target === 'next-step' ? 0 : item.originOperationId === grant.operationId && siblings ? 1 : 0
    const expectedEventCount = native.seq
    const event = native.append('agent/inbox/spliced', { target, start, inserted: [item.message] })
    const result = await bridge.commitAccepted(grant.token, { version: 1, writer,
      command: nativeInputAdmissionCommand.parse({ rpcNonce: `admit:${item.originOperationId}`, sessionId: created.sessionId,
        originInputId: originInputId.parse(item.originOperationId), originOperationId: item.originOperationId,
        messageId: item.message.id, target }), expectedEventCount, events: [event],
      presentation: { epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: ack.lastOrdinal + 1 },
      prepareFrame: item.originOperationId === grant.operationId })
    if (result.kind !== 'admission') throw new Error('Unexpected prepared fixture admission result')
    ack = result.presentation
    if (result.frame?.phase === 'prepared') prepared = result.frame
  }
  if (!prepared) throw new Error('Prepared cancellation fixture did not create its actual frame')
  return { tasks, writers, writer, grant, authority, events, frames, ledger, publisher, bridge, cancel, header, native,
    publisherId, ack, prepared }
}

async function request(n: Harness) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
    const command = nativeInputQueueCommand.parse({ rpcNonce: `cancel:${randomUUID()}`,
      payload: { sessionId: n.grant.sessionId, itemId: n.prepared.messageId, action: { kind: 'remove' } } })
    const planned = await new NativeInputNativePlanner(ctx.sessionProjections).planQueue(n.header, n.native.snapshotEvents(), command)
    return nativePreparedCancelCommit.parse({ version: 1, writer: n.writer, frame: n.prepared, command,
      expectedEventCount: planned.expectedEventCount, events: planned.events,
      presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 },
      seal: { publisherId: n.publisherId, lastOrdinal: n.ack.lastOrdinal, eventCount: n.ack.eventCount, revision: n.ack.revision } })
  } finally { await ctx.fiber.dispose() }
}

async function state(f: Fixture) {
  return {
    session: (await f.pool.query('SELECT id,event_count,event_bytes,lease_epoch,grant_digest,lease_until FROM pe_sessions ORDER BY id')).rows,
    events: (await f.pool.query<{ seq: string; event: SessionEvent }>(
      'SELECT seq,event FROM pe_events ORDER BY session_id,seq')).rows,
    operations: (await f.pool.query<{
      id: string
      state: string
      error_code: string | null
      attempts: number
      completed_at: Date | null
    }>('SELECT id,state,error_code,attempts,completed_at FROM pe_operations ORDER BY id')).rows,
    attempts: (await f.pool.query<{ ended_at: Date | null }>('SELECT * FROM pe_attempts ORDER BY operation_id,epoch')).rows,
    frames: (await f.pool.query<{ grant_json: unknown }>(
      'SELECT * FROM pe_native_turn_frames ORDER BY operation_id,operation_epoch')).rows,
    receipts: (await f.pool.query<{ kind: string }>('SELECT * FROM pe_native_input_commands ORDER BY command_id')).rows,
    presentation: (await f.pool.query('SELECT * FROM pe_native_presentations ORDER BY session_id')).rows,
    entries: (await f.pool.query('SELECT * FROM pe_native_presentation_entries ORDER BY session_id,ordinal')).rows,
  }
}

test('prepared cancel atomically removes its non-head input, preserves siblings and replays an original lost reply after all leases end',
  () => cloudFixture(async (f) => {
    const n = await prepare(f, true, false)
    const frozen = first((await f.pool.query<{ grant_json: unknown }>('SELECT grant_json FROM pe_native_turn_frames')).rows).grant_json
    const original = first(foldInputHistory(n.header, n.native.snapshotEvents()).inbox['next-turn'].slice(1))
    const content = [{ type: 'text' as const, text: 'A edited pending body' }]
    const editSeq = n.native.seq
    const edit = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1,
      inserted: [{ ...original, content }], outcome: 'canceled' })
    const edited = await n.bridge.commitQueue(f.alice.token, n.grant.token, { version: 1, writer: n.writer,
      command: { rpcNonce: `edit:${randomUUID()}`, payload: { sessionId: n.grant.sessionId,
        itemId: n.prepared.messageId, action: { kind: 'edit', content } } }, expectedEventCount: editSeq, events: [edit],
      presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 } })
    if (edited.kind !== 'queue') throw new Error('Prepared candidate edit did not return its real queue publication')
    n.ack = edited.presentation
    const latest = first((await f.pool.query<{ input_digest: string }>(`SELECT input_digest FROM pe_native_input_revisions
    WHERE origin_input_id=$1 ORDER BY input_revision DESC LIMIT 1`, [n.prepared.candidateOriginInputId])).rows)
    const intent = await request(n)
    await n.tasks.cancelActive(f.alice.user, n.grant.sessionId, f.alice.token)
    const result = await n.cancel.commit(n.grant.token, intent)
    expect(result.input.payloadDigest).toBe(nativePreparedCancelIntentDigest(n.grant.token, intent))
    expect(result.input.result).toMatchObject({ kind: 'removed', inputRevision: 2, inputDigest: latest.input_digest })
    expect(result.frame).toEqual({ ...n.prepared, phase: 'retired', reason: 'user_cancel', requeued: false, eventCount: intent.expectedEventCount + 1 })
    const done = await state(f), suffix = first(done.events.slice(-1)).event

    // A true user cancellation receipt cannot promise to requeue its retired original input.
    const originalReceipt = structuredClone(result), facts = await retainedNativeFacts(f.pool)
    const nativeInputs = n.native.snapshotEvents()
    expect(nativeExecutionFrame.safeParse({ ...result.frame, requeued: true })).toMatchObject({
      success: false, error: { issues: [{ code: 'custom',
        message: 'Retirement must preserve its prepared prefix and explicit cancellation' }] },
    })
    expect(result).toEqual(originalReceipt)
    expect(nativeExecutionFrame.parse(result.frame)).toEqual(originalReceipt.frame)
    expect(n.native.snapshotEvents()).toEqual(nativeInputs)
    expect(await retainedNativeFacts(f.pool)).toEqual(facts)
    expect(suffix).toMatchObject({ type: 'agent/inbox/spliced', data: { start: 1, removedCount: 1, inserted: [], outcome: 'canceled' } })
    const folded = foldInputHistory(n.header, done.events.map(row => row.event))
    expect(folded.inbox['next-turn'].map(message => message.content)).toEqual([[{ type: 'text', text: 'B sibling' }]])
    expect(folded.inbox['next-step'].map(message => message.content)).toEqual([[{ type: 'text', text: 'C sibling' }]])
    expect(done.operations.find(row => row.id === n.grant.operationId)).toMatchObject({ state: 'failed', error_code: 'turn_user', attempts: 1 })
    expect(done.operations.filter(row => row.id !== n.grant.operationId).map(row => row.state)).toEqual(['queued', 'queued'])
    expect(first(done.session)).toMatchObject({ lease_epoch: n.grant.epoch, grant_digest: null, lease_until: null })
    expect(first(done.attempts).ended_at).not.toBeNull()
    expect(first(done.frames).grant_json).toEqual(frozen)
    expect((await f.pool.query('SELECT 1 FROM pe_native_input_claims UNION ALL SELECT 1 FROM pe_native_input_cohorts')).rowCount).toBe(0)
    expect(done.receipts.filter(row => row.kind === 'remove')).toHaveLength(1)
    await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.grant.sessionId])
    await f.pool.query('DELETE FROM pe_native_presentations WHERE session_id=$1', [n.grant.sessionId])
    const replayState = await state(f)
    expect(await n.cancel.commit(n.grant.token, intent)).toEqual(result)
    expect(await state(f)).toEqual(replayState)
    await expect(n.cancel.commit(n.grant.token, { ...intent, presentation: { ...intent.presentation, batchId: randomUUID() } }))
      .rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
    await expect(n.cancel.commit(randomBytes(32).toString('base64url'), intent)).rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
    expect(await state(f)).toEqual(replayState)
  }))

test('prepared cancel refuses an uncanceled source, ordinary active-owner remove, foreign Writer and actual claimed ownership',
  () => cloudFixture(async (f) => {
    const n = await prepare(f, false, false), intent = await request(n), before = await state(f)
    await expect(n.cancel.commit(n.grant.token, intent)).rejects.toMatchObject({ code: 'native_input_prepared_cancel_conflict' })
    await expect(n.bridge.commitQueue(f.alice.token, n.grant.token, { version: 1, writer: n.writer, command: intent.command,
      expectedEventCount: intent.expectedEventCount, events: intent.events, presentation: intent.presentation }))
      .rejects.toMatchObject({ code: 'native_input_remove_active_owner' })
    await expect(n.cancel.commit(n.grant.token, { ...intent, writer: { ...n.writer, workerId: randomUUID() } }))
      .rejects.toMatchObject({ code: 'native_writer_lost' })
    await expect(n.cancel.commit(n.grant.token, { ...intent, frame: { ...intent.frame, operationId: operationId.parse(randomUUID()) } }))
      .rejects.toMatchObject({ code: 'native_input_prepared_cancel_conflict' })
    expect(await state(f)).toEqual(before)
    const start = n.native.append('turn/start', { turn: 1 })
    const splice = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const claimed = await n.bridge.commitClaim(n.grant.token, { version: 1, writer: n.writer,
      command: nativeInputClaimCommand.parse({ rpcNonce: `claim:${randomUUID()}`, cohortId: inputCohortId.parse(randomUUID()),
        boundaryKind: 'initial-turn-step', frame: { sessionId: n.prepared.sessionId, operationId: n.prepared.operationId,
          operationEpoch: n.prepared.operationEpoch, writerEpoch: n.prepared.writerEpoch,
          frozenSnapshotDigest: n.prepared.frozenSnapshotDigest } }),
      expectedEventCount: start.seq, events: [start, splice], presentation: intent.presentation })
    if (claimed.kind !== 'claim') throw new Error('Prepared cancellation fixture did not consume its real initial cohort')
    await n.tasks.cancelActive(f.alice.user, n.grant.sessionId, f.alice.token)
    const closedIntent = { ...intent, expectedEventCount: claimed.presentation.eventCount,
      events: [{ ...first(intent.events) as object, seq: claimed.presentation.eventCount }],
      presentation: { ...intent.presentation, batchId: randomUUID(), firstOrdinal: claimed.presentation.lastOrdinal + 1 },
      seal: { publisherId: n.publisherId, lastOrdinal: claimed.presentation.lastOrdinal,
        eventCount: claimed.presentation.eventCount, revision: claimed.presentation.revision } }
    const consumed = await state(f)
    await expect(n.cancel.commit(n.grant.token, closedIntent)).rejects.toMatchObject({ code: 'native_input_prepared_cancel_conflict' })
    expect(await state(f)).toEqual(consumed)
  }))

test('prepared cancellation rolls back its real canonical publication and terminal writes when publication expires before final proof',
  () => cloudFixture(async (f) => {
    const n = await prepare(f, false, true), intent = await request(n)
    await n.tasks.cancelActive(f.alice.user, n.grant.sessionId, f.alice.token)
    if (!(n.publisher instanceof ExpiringPublication)) throw new Error('Missing actual publisher expiration injection')
    n.publisher.expireOnCancel = true
    const before = await state(f)
    await expect(n.cancel.commit(n.grant.token, intent)).rejects.toMatchObject({ code: 'native_input_authority_lost' })
    expect(await state(f)).toEqual(before)
  }))


test('the prepared-cancel journal ACK rolls back all actual native terminal facts on failure and survives an original lost reply', () => cloudFixture(async (f) => {
  const n = await prepare(f, true, false)
  await n.tasks.cancelActive(f.alice.user, n.grant.sessionId, f.alice.token)
  const intent = await request(n)
  const turn = new NativeTurnContinuationV2(n.tasks, n.writers, (client, request) => n.frames.verifyInTransaction(client, request),
    { ...inputLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser, assistant: presentationLimits }, n.frames)
  const fresh = retainedTestStore(n, { input: inputLimits, presentation: presentationLimits }, turn)
  const before = await retainedNativeFacts(f.pool)
  const prepared = await fresh().prepare(n.grant.token, { version: 1, workerId: n.writer.workerId,
    mutation: { family: 'prepared-cancel', request: intent } })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  const execute = { version: 1 as const, workerId: n.writer.workerId, intentId: prepared.intentId }
  await f.pool.query(`CREATE FUNCTION pe_test_cancel_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state='committed' THEN RAISE EXCEPTION 'actual cancellation ACK failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER pe_test_cancel_ack_failure BEFORE UPDATE ON pe_native_retained_intents
      FOR EACH ROW EXECUTE FUNCTION pe_test_cancel_ack_failure()`)
  await expect(fresh().execute(n.grant.token, execute)).rejects.toMatchObject({ message: 'actual cancellation ACK failure' })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  expect((await f.pool.query('SELECT state,receipt_json FROM pe_native_retained_intents')).rows).toEqual([{ state: 'prepared', receipt_json: null }])
  await f.pool.query('DROP TRIGGER pe_test_cancel_ack_failure ON pe_native_retained_intents; DROP FUNCTION pe_test_cancel_ack_failure()')
  const result = await fresh().execute(n.grant.token, execute)
  expect(result.family).toBe('prepared-cancel')
  await n.writers.release(n.writer)
  const complete = await retainedNativeFacts(f.pool)
  expect(await fresh().execute(n.grant.token, execute)).toEqual(result)
  expect((await fresh().reconcile({ version: 1, workerId: n.writer.workerId, limit: 8 })).items[0]?.outcome)
    .toEqual({ state: 'committed', receipt: result, retired: true })
  expect(await retainedNativeFacts(f.pool)).toEqual(complete)
  expect(JSON.stringify(result)).not.toContain(n.grant.token)
  expect(JSON.stringify(result)).not.toContain(n.writer.token)
}))
