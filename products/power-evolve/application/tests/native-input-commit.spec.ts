/** Actual PG transaction bridge over the maintained ledger, frames, Writer and publisher. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { nativeInputCommitReceipt } from '../src/native-input-commit-contracts.ts'
import { inputCohortId, nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputQueueCommand, originInputId,
  type NativeInputLedgerLimits } from '../src/native-input-ledger-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger, type NativeAcceptedPendingInput } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedTestStore, retainedNativeFacts } from './native-retained-intent-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 16, maxActivePerUser: 2 }
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const ledgerLimits: NativeInputLedgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
  maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned input-commit fixture returned no row')
  return row
}

async function schema(f: Fixture): Promise<void> {
  const frames = process.env.PE_NATIVE_TURN_TEST_DDL_FILE, ledger = process.env.PE_NATIVE_INPUT_TEST_DDL_FILE
  const tables = ['pe_native_turn_frames', 'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
    'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_transitions_v2']
  const inspect = async () => (await f.pool.query<{ name: string; present: boolean }>(
    "SELECT name,to_regclass('public.'||name) IS NOT NULL AS present FROM unnest($1::text[]) AS needed(name)",
    [[...tables, 'pe_native_turn_transitions']])).rows
  const versions = (await f.pool.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
  if (versions.length !== 1 || first(versions).family !== 'cloud-native') throw new Error('Invalid cloud fixture schema metadata')
  const present = await inspect()
  if (frames !== undefined || ledger !== undefined) {
    if (!frames || !ledger || first(versions).version !== 4 || present.some(row => row.present)) {
      throw new Error('Private input-commit DDL requires an empty schema4 extension and both complete files')
    }
    await f.pool.query(await readFile(frames, 'utf8'))
    await f.pool.query(await readFile(ledger, 'utf8'))
    const installed = await inspect()
    if (tables.filter(name => name !== 'pe_native_turn_transitions_v2').some(name => !installed.find(row => row.name === name)?.present)) {
      throw new Error('Private input-commit DDL did not install every required table')
    }
  } else if (first(versions).version !== CURRENT_SCHEMA_VERSION || tables.some(name => !present.find(row => row.name === name)?.present)
    || present.find(row => row.name === 'pe_native_turn_transitions')?.present) {
    throw new Error('Input-commit tests require complete formal current cloud-native schema')
  }
}

async function prepare(f: Fixture) {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'A original owner', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), a = await tasks.claim(workerId)
  if (!a) throw new Error('Actual bootstrap operation was not claimed')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(a.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: a.token }
  const events = new EventStore(tasks, { maxEventBytes: taskLimits.maxEventBytes, ...historyLimits })
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits,
    (client, request) => frames.verifyInTransaction(client, request))
  const publisher = new NativeAssistantStore(tasks, events, presentationLimits)
  const bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers, { input: ledgerLimits, presentation: presentationLimits })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), publisherId = randomUUID()
  await publisher.apply(a.token, { version: 1, epoch: a.epoch, publisherId, batchId: randomUUID(), firstOrdinal: 1, items: [] })
  return { tasks, writers, writer, authority, a, events, frames, ledger, publisher, bridge, native, publisherId, nextOrdinal: 1 }
}

async function commitCase(run: (f: Fixture, n: Prepared) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => { await schema(f); await run(f, await prepare(f)) })
}

async function pending(f: Fixture, n: Prepared, limit = 16) {
  return transaction(f.pool, client => n.ledger.readAcceptedPendingInTransaction(client, n.authority, limit))
}

function publication(n: Prepared) {
  return { epoch: n.a.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.nextOrdinal }
}

function proposal(n: Prepared, item: NativeAcceptedPendingInput, target: 'next-turn' | 'next-step', start: number) {
  const expectedEventCount = n.native.seq
  const event = n.native.append('agent/inbox/spliced', { target, start, inserted: [item.message] })
  return { version: 1, writer: n.writer, command: nativeInputAdmissionCommand.parse({ rpcNonce: `accepted:${item.originOperationId}`,
    sessionId: n.a.sessionId, originInputId: originInputId.parse(item.originOperationId), originOperationId: item.originOperationId,
    messageId: item.message.id, target }), expectedEventCount, events: [event], presentation: publication(n),
  prepareFrame: item.originOperationId === n.a.operationId }
}

async function bootstrap(f: Fixture, n: Prepared) {
  const item = first((await pending(f, n)).items), request = proposal(n, item, 'next-turn', 0)
  const result = nativeInputCommitReceipt.parse(await n.bridge.commitAccepted(n.a.token, request))
  if (result.kind !== 'admission' || result.frame === null) throw new Error('Actual bootstrap frame was not returned')
  n.nextOrdinal = result.presentation.lastOrdinal + 1
  return { item, request, result, frame: result.frame }
}

async function ordinary(n: Prepared, events: readonly SessionEvent[]) {
  const receipt = await n.publisher.apply(n.a.token, { version: 1, ...publication(n), items: events.map(event => ({ type: 'event', event })) })
  n.nextOrdinal = receipt.lastOrdinal + 1
  return receipt
}

async function state(f: Fixture) {
  return {
    sessions: (await f.pool.query('SELECT id,event_count,event_bytes FROM pe_sessions ORDER BY id')).rows,
    events: (await f.pool.query('SELECT session_id,seq,event FROM pe_events ORDER BY session_id,seq')).rows,
    origins: (await f.pool.query('SELECT origin_input_id FROM pe_native_input_origins ORDER BY origin_input_id')).rows,
    commands: (await f.pool.query('SELECT command_id,receipt_json FROM pe_native_input_commands ORDER BY command_id')).rows,
    revisions: (await f.pool.query('SELECT origin_input_id,input_revision FROM pe_native_input_revisions ORDER BY origin_input_id,input_revision')).rows,
    cohorts: (await f.pool.query('SELECT cohort_id,step_start_seq FROM pe_native_input_cohorts ORDER BY cohort_id')).rows,
    claims: (await f.pool.query('SELECT origin_input_id,cohort_id FROM pe_native_input_claims ORDER BY origin_input_id')).rows,
    frames: (await f.pool.query('SELECT frame_json FROM pe_native_turn_frames ORDER BY operation_id')).rows,
    presentations: (await f.pool.query('SELECT state_json,last_batch_id,last_batch_json FROM pe_native_presentations ORDER BY session_id')).rows,
    entries: (await f.pool.query('SELECT ordinal,item_json FROM pe_native_presentation_entries ORDER BY session_id,ordinal')).rows,
  }
}

test('actual accepted admission, full B,C,A claim, published step and empty continuing cohort commit and replay without duplicate facts', () => commitCase(async (f, n) => {
  const a = await bootstrap(f, n), admitted = await state(f)
  expect(a.item.message.id).toBe(n.a.operationId)
  expect(a.item.message.source).toEqual({ kind: 'user', rpcId: n.a.requestId })
  expect(await n.bridge.commitAccepted(n.a.token, a.request)).toEqual(a.result)
  await expect(n.bridge.commitAccepted(n.a.token, { ...a.request, prepareFrame: false })).rejects.toMatchObject({ code: 'native_input_prepare_conflict' })
  await expect(n.bridge.commitAccepted(n.a.token, { ...a.request, presentation: { ...a.request.presentation, firstOrdinal: 2 } }))
    .rejects.toMatchObject({ code: 'native_assistant_batch_conflict' })
  expect(await state(f)).toEqual(admitted)
  expect((await pending(f, n)).items).toEqual([])
  for (const text of ['B queued', 'C queued']) await n.tasks.accept(f.alice.user, n.a.sessionId, requestId.parse(randomUUID()), text, f.alice.token)
  const queued = (await pending(f, n)).items
  expect(queued.map(item => item.acceptedInputAudit.text)).toEqual(['B queued', 'C queued'])
  for (const [index, item] of queued.entries()) {
    const result = await n.bridge.commitAccepted(n.a.token, proposal(n, item, 'next-step', index))
    n.nextOrdinal = result.presentation.lastOrdinal + 1
  }
  const expectedEventCount = n.native.seq, events = [n.native.append('turn/start', { turn: 1 }),
    n.native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [] }),
    n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  const frame = { sessionId: a.frame.sessionId, operationId: a.frame.operationId, operationEpoch: a.frame.operationEpoch,
    writerEpoch: a.frame.writerEpoch, frozenSnapshotDigest: a.frame.frozenSnapshotDigest }
  const command = nativeInputClaimCommand.parse({ rpcNonce: 'complete-native-cohort', cohortId: inputCohortId.parse(randomUUID()),
    boundaryKind: 'initial-turn-step', frame })
  const request = { version: 1, writer: n.writer, command, expectedEventCount, events, presentation: publication(n) }
  const claimed = await n.bridge.commitClaim(n.a.token, request), afterClaim = await state(f)
  n.nextOrdinal = claimed.presentation.lastOrdinal + 1
  expect(await n.bridge.commitClaim(n.a.token, request)).toEqual(claimed)
  expect(await state(f)).toEqual(afterClaim)
  expect((await f.pool.query<{ state: string }>('SELECT state FROM pe_operations ORDER BY created_at,id')).rows.map(row => row.state)).toEqual(['running', 'queued', 'queued'])
  expect((await f.pool.query('SELECT epoch FROM pe_attempts')).rowCount).toBe(1)
  const start = n.native.append('step/start', { turn: 1, step: 1 }), published = await ordinary(n, [start])
  const { epoch: _epoch, ...seal } = published
  const step = { version: 1, writer: n.writer, command: { cohortId: command.cohortId, frame, stepStartSeq: start.seq }, seal }
  const bound = nativeInputCommitReceipt.parse(await n.bridge.bindStep(n.a.token, step))
  expect(bound.kind).toBe('step')
  if (bound.kind !== 'step') throw new Error('Expected actual step binding')
  expect(bound.claims).toHaveLength(3)
  expect(bound.cohort.stepStartSeq).toBe(start.seq)
  expect(await n.bridge.bindStep(n.a.token, step)).toEqual(bound)
  await ordinary(n, [n.native.append('step/end', { turn: 1, step: 1 })])
  const empty = { version: 1, writer: n.writer, command: nativeInputClaimCommand.parse({ rpcNonce: 'empty-continuing',
    cohortId: inputCohortId.parse(randomUUID()), boundaryKind: 'continuing-step', frame }),
  expectedEventCount: n.native.seq, events: [], presentation: publication(n) }
  const continued = await n.bridge.commitClaim(n.a.token, empty), afterEmpty = await state(f)
  expect(continued.presentation.eventCount).toBe(n.native.seq)
  expect(continued.presentation.lastOrdinal).toBe(n.nextOrdinal - 1)
  expect(await n.bridge.commitClaim(n.a.token, empty)).toEqual(continued)
  await expect(n.bridge.commitClaim(n.a.token, { ...empty, presentation: { ...empty.presentation, batchId: randomUUID() } }))
    .rejects.toMatchObject({ code: 'native_input_publication_conflict' })
  await expect(n.bridge.commitClaim(n.a.token, { ...empty, command: { ...empty.command, rpcNonce: 'fresh-nonce' } }))
    .rejects.toMatchObject({ code: 'native_input_publication_conflict' })
  expect(await state(f)).toEqual(afterEmpty)

  // A wire ACK cannot truncate its real cohort or borrow a different commit's acknowledgement.
  const receipts = structuredClone({ admission: a.result, claimed, bound }), facts = await retainedNativeFacts(f.pool)
  const nativeInputs = n.native.snapshotEvents()
  expect(nativeInputCommitReceipt.safeParse({ ...bound, claims: bound.claims.slice(1) })).toMatchObject({
    success: false, error: { issues: [{ code: 'custom', message: 'Step result must retain its complete bound cohort' }] },
  })
  expect(nativeInputCommitReceipt.safeParse({ ...a.result, presentation: claimed.presentation })).toMatchObject({
    success: false, error: { issues: [{ code: 'custom', message: 'Input and presentation receipts must acknowledge the same commit' }] },
  })
  expect(nativeInputCommitReceipt.safeParse({ ...claimed, kind: 'queue' })).toMatchObject({
    success: false, error: { issues: [{ code: 'custom', message: 'Input and presentation receipts must acknowledge the same commit' }] },
  })
  expect({ admission: a.result, claimed, bound }).toEqual(receipts)
  expect(nativeInputCommitReceipt.parse(a.result)).toEqual(receipts.admission)
  expect(nativeInputCommitReceipt.parse(claimed)).toEqual(receipts.claimed)
  expect(nativeInputCommitReceipt.parse(bound)).toEqual(receipts.bound)
  expect(n.native.snapshotEvents()).toEqual(nativeInputs)
  expect(await retainedNativeFacts(f.pool)).toEqual(facts)
}))

test('publisher ordinal refusal rolls back an already staged admission and every canonical and ledger fact', () => commitCase(async (f, n) => {
  const request = proposal(n, first((await pending(f, n)).items), 'next-turn', 0), before = await state(f)
  await expect(n.bridge.commitAccepted(n.a.token, { ...request, presentation: { ...request.presentation, firstOrdinal: 2 } }))
    .rejects.toMatchObject({ status: 409, code: 'native_assistant_input_prefix' })
  expect(await state(f)).toEqual(before)
  const receipt = await n.bridge.commitAccepted(n.a.token, request)
  expect(receipt.kind).toBe('admission')
}))

test('late actual frame preparation refusal rolls back the preceding publisher update and native admission together', () => commitCase(async (f, n) => {
  await ordinary(n, [n.native.append('turn/start', { turn: 1 })])
  const request = proposal(n, first((await pending(f, n)).items), 'next-turn', 0), before = await state(f)
  await expect(n.bridge.commitAccepted(n.a.token, request)).rejects.toMatchObject({ status: 409, code: 'native_execution_frame_turn_open' })
  expect(await state(f)).toEqual(before)
}))

test('accepted pending reads exclude canceled, admitted, foreign Session and foreign user operations and report bounded remainder', () => commitCase(async (f, n) => {
  const own = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await n.tasks.accept(f.alice.user, own.sessionId, requestId.parse(randomUUID()), 'other Session', f.alice.token)
  const other = await n.tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
  await n.tasks.accept(f.bob.user, other.sessionId, requestId.parse(randomUUID()), 'other user', f.bob.token)
  const cancelRequest = requestId.parse(randomUUID())
  await n.tasks.accept(f.alice.user, n.a.sessionId, cancelRequest, 'canceled pending', f.alice.token)
  await f.pool.query("UPDATE pe_operations SET error_code='cancel_requested' WHERE session_id=$1 AND request_id=$2", [n.a.sessionId, cancelRequest])
  await n.tasks.accept(f.alice.user, n.a.sessionId, requestId.parse(randomUUID()), 'eligible B', f.alice.token)
  const firstPage = await pending(f, n, 1)
  expect(firstPage.more).toBe(true)
  expect(firstPage.items.map(item => item.originOperationId)).toEqual([n.a.operationId])
  const a = await bootstrap(f, n)
  expect(a.result.frame?.operationId).toBe(n.a.operationId)
  const remaining = await pending(f, n)
  expect(remaining.more).toBe(false)
  expect(remaining.items.map(item => item.acceptedInputAudit.text)).toEqual(['eligible B'])
  expect(JSON.stringify(remaining)).not.toContain(n.writer.token)
  expect(JSON.stringify(remaining)).not.toContain(n.a.token)
}))

test('browser remove history is returned before replanning while changed nonce payload and another user refuse', () => commitCase(async (f, n) => {
  await bootstrap(f, n)
  await n.tasks.accept(f.alice.user, n.a.sessionId, requestId.parse(randomUUID()), 'B removable', f.alice.token)
  const b = first((await pending(f, n)).items), admitted = await n.bridge.commitAccepted(n.a.token, proposal(n, b, 'next-turn', 1))
  n.nextOrdinal = admitted.presentation.lastOrdinal + 1
  const command = nativeInputQueueCommand.parse({ rpcNonce: 'retained-remove', payload: { sessionId: n.a.sessionId,
    itemId: b.message.id, action: { kind: 'remove' } } })
  expect(await n.bridge.readQueueReceipt(f.alice.token, command)).toBeNull()
  const expectedEventCount = n.native.seq, event = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1,
    removedCount: 1, inserted: [], outcome: 'canceled' })
  const request = { version: 1, writer: n.writer, command, expectedEventCount, events: [event], presentation: publication(n) }
  const removed = nativeInputCommitReceipt.parse(await n.bridge.commitQueue(f.alice.token, n.a.token, request))
  if (removed.kind !== 'queue') throw new Error('Expected queue result')
  expect(await n.bridge.readQueueReceipt(f.alice.token, command)).toEqual(removed.input)
  expect(await n.bridge.commitQueue(f.alice.token, n.a.token, request)).toEqual(removed)
  const before = await state(f)
  await expect(n.bridge.readQueueReceipt(f.alice.token, { ...command, payload: { ...command.payload,
    action: { kind: 'edit', content: [{ type: 'text', text: 'changed' }] } } })).rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
  await expect(n.bridge.readQueueReceipt(f.bob.token, command)).rejects.toMatchObject({ status: 404 })
  await expect(n.bridge.commitQueue(f.alice.token, n.a.token, { ...request, activity: { phase: 'maintenance' } }))
    .rejects.toMatchObject({ status: 400 })
  expect(await state(f)).toEqual(before)
}))

test('a mismatched ordinary seal cannot bind a cohort or acknowledge unpublished step coordinates', () => commitCase(async (f, n) => {
  const a = await bootstrap(f, n), expectedEventCount = n.native.seq
  const events = [n.native.append('turn/start', { turn: 1 }),
    n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  const frame = { sessionId: n.a.sessionId, operationId: n.a.operationId, operationEpoch: n.a.epoch,
    writerEpoch: n.writer.epoch, frozenSnapshotDigest: a.frame.frozenSnapshotDigest }
  const command = nativeInputClaimCommand.parse({ rpcNonce: 'one-owner-claim', cohortId: inputCohortId.parse(randomUUID()),
    boundaryKind: 'initial-turn-step', frame })
  const claimed = await n.bridge.commitClaim(n.a.token, { version: 1, writer: n.writer, command, expectedEventCount, events,
    presentation: publication(n) })
  n.nextOrdinal = claimed.presentation.lastOrdinal + 1
  const event = n.native.append('step/start', { turn: 1, step: 1 }), published = await ordinary(n, [event])
  const { epoch: _epoch, ...seal } = published, before = await state(f)
  await expect(n.bridge.bindStep(n.a.token, { version: 1, writer: n.writer,
    command: { cohortId: command.cohortId, frame, stepStartSeq: event.seq }, seal: { ...seal, revision: seal.revision + 1 } }))
    .rejects.toMatchObject({ code: 'native_input_publication_conflict' })
  expect(await state(f)).toEqual(before)
}))


test('journal admission claim step and browser queue ACKs stay atomic and tokenless after real Writer release', () => commitCase(async (f, n) => {
  const turn = new NativeTurnContinuationV2(n.tasks, n.writers, (client, request) => n.frames.verifyInTransaction(client, request),
    { ...ledgerLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser,
      assistant: presentationLimits }, n.frames)
  const fresh = retainedTestStore(n, { input: ledgerLimits, presentation: presentationLimits }, turn), store = fresh()
  const accepted = first((await pending(f, n)).items), admission = proposal(n, accepted, 'next-turn', 0)
  const before = await retainedNativeFacts(f.pool)
  const a = await store.prepare(n.a.token, { version: 1, workerId: n.writer.workerId, mutation: { family: 'admission', request: admission } })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  const execute = (intentId: typeof a.intentId) => ({ version: 1 as const, workerId: n.writer.workerId, intentId })
  await f.pool.query(`CREATE FUNCTION pe_test_input_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state='committed' THEN RAISE EXCEPTION 'actual input ACK failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER pe_test_input_ack_failure BEFORE UPDATE ON pe_native_retained_intents
      FOR EACH ROW EXECUTE FUNCTION pe_test_input_ack_failure()`)
  await expect(store.execute(n.a.token, execute(a.intentId))).rejects.toMatchObject({ message: 'actual input ACK failure' })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  expect((await f.pool.query('SELECT state,receipt_json FROM pe_native_retained_intents')).rows).toEqual([{ state: 'prepared', receipt_json: null }])
  await f.pool.query('DROP TRIGGER pe_test_input_ack_failure ON pe_native_retained_intents; DROP FUNCTION pe_test_input_ack_failure()')
  const admitted = await store.execute(n.a.token, execute(a.intentId))
  if (admitted.family !== 'admission' || admitted.result.kind !== 'admission' || !admitted.result.frame) throw new Error('Expected actual original admission frame')
  n.nextOrdinal = admitted.result.presentation.lastOrdinal + 1
  const frame = admitted.result.frame, expectedEventCount = n.native.seq
  const command = nativeInputClaimCommand.parse({ rpcNonce: 'journal-original-cohort', cohortId: inputCohortId.parse(randomUUID()),
    boundaryKind: 'initial-turn-step', frame: { sessionId: frame.sessionId, operationId: frame.operationId,
      operationEpoch: frame.operationEpoch, writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
  const events = [n.native.append('turn/start', { turn: 1 }),
    n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  const c = await store.prepare(n.a.token, { version: 1, workerId: n.writer.workerId, mutation: { family: 'claim', request:
    { version: 1, writer: n.writer, command, expectedEventCount, events, presentation: publication(n) } } })
  const claimed = await store.execute(n.a.token, execute(c.intentId))
  if (claimed.family !== 'claim') throw new Error('Expected actual original claim acknowledgement')
  n.nextOrdinal = claimed.result.presentation.lastOrdinal + 1
  const start = n.native.append('step/start', { turn: 1, step: 1 }), published = await ordinary(n, [start])
  const { epoch: _epoch, ...seal } = published
  const s = await store.prepare(n.a.token, { version: 1, workerId: n.writer.workerId, mutation: { family: 'step', request:
    { version: 1, writer: n.writer, command: { cohortId: command.cohortId, frame: command.frame, stepStartSeq: start.seq }, seal } } })
  const bound = await store.execute(n.a.token, execute(s.intentId))
  if (bound.family !== 'step' || bound.result.kind !== 'step') throw new Error('Expected actual original step acknowledgement')
  expect(bound.result.cohort.stepStartSeq).toBe(start.seq)
  await n.tasks.accept(f.alice.user, n.a.sessionId, requestId.parse(randomUUID()), 'journal removable sibling', f.alice.token)
  const b = first((await pending(f, n)).items)
  const admittedB = await n.bridge.commitAccepted(n.a.token, proposal(n, b, 'next-turn', 0))
  n.nextOrdinal = admittedB.presentation.lastOrdinal + 1
  const queueCommand = nativeInputQueueCommand.parse({ rpcNonce: 'journal-browser-remove', payload: { sessionId: n.a.sessionId,
    itemId: b.message.id, action: { kind: 'remove' } } })
  const queueExpected = n.native.seq, removal = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0,
    removedCount: 1, inserted: [], outcome: 'canceled' })
  const q = await store.prepare(n.a.token, { version: 1, workerId: n.writer.workerId, mutation: { family: 'queue', request:
    { credential: f.alice.token, request: { version: 1, writer: n.writer, command: queueCommand, expectedEventCount: queueExpected,
      events: [removal], presentation: publication(n) } } } })
  const removed = await store.execute(n.a.token, execute(q.intentId))
  expect(removed.family).toBe('queue')
  await n.writers.release(n.writer)
  const retained = await retainedNativeFacts(f.pool)
  for (const [prepared, receipt] of [[a, admitted], [c, claimed], [s, bound], [q, removed]] as const) {
    expect(await fresh().execute(n.a.token, execute(prepared.intentId))).toEqual(receipt)
    expect(await retainedNativeFacts(f.pool)).toEqual(retained)
  }
  const results = await fresh().reconcile({ version: 1, workerId: n.writer.workerId, limit: 8 })
  expect(results.items.map(item => item.outcome.state)).toEqual(['committed', 'committed', 'committed', 'committed'])
  expect(JSON.stringify(results)).not.toContain(n.a.token)
  expect(JSON.stringify(results)).not.toContain(n.writer.token)
  expect(JSON.stringify(results)).not.toContain(f.alice.token)
  expect(await retainedNativeFacts(f.pool)).toEqual(retained)
}))

test.each(['operation', 'writer'] as const)('cold admission abandons its nonrevivable original %s scope and retains independent facts', lost => commitCase(async (f, n) => {
  const turn = new NativeTurnContinuationV2(n.tasks, n.writers, (client, request) => n.frames.verifyInTransaction(client, request),
    { ...ledgerLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser,
      assistant: presentationLimits }, n.frames)
  const fresh = retainedTestStore(n, { input: ledgerLimits, presentation: presentationLimits }, turn)
  const item = first((await pending(f, n)).items), request = proposal(n, item, 'next-turn', 0)
  const prepared = await fresh().prepare(n.a.token, { version: 1, workerId: n.writer.workerId, mutation: { family: 'admission', request } })
  if (lost === 'writer') {
    await n.writers.release(n.writer)
    await transaction(f.pool, client => n.tasks.authorized(client, n.a.token))
  } else {
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.a.sessionId])
    await transaction(f.pool, client => n.writers.requireInTransaction(client, n.writer))
  }
  const before = await retainedNativeFacts(f.pool)
  const result = await fresh().reconcile({ version: 1, workerId: n.writer.workerId, limit: 8 })
  expect(result.items[0]).toMatchObject({ intentId: prepared.intentId, outcome: { state: 'abandoned' } })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  expect((await f.pool.query('SELECT fence_kind FROM pe_native_retained_intents')).rows).toEqual([{ fence_kind: 'operation-and-writer' }])
  await expect(fresh().execute(n.a.token, { version: 1, workerId: n.writer.workerId, intentId: prepared.intentId }))
    .rejects.toMatchObject({ code: 'native_intent_abandoned' })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
}))

test.each(['batch size', 'history size', 'event bytes', 'wrong prefix'] as const)(
  'retained admission refuses %s before sealing or changing native facts', invalid => commitCase(async (f, n) => {
    const config = { input: { ...ledgerLimits, ...(invalid === 'history size' ? { maxHistoryEvents: 1 } : {}),
      ...(invalid === 'event bytes' ? { maxEventBytes: 1 } : {}) },
    presentation: { ...presentationLimits, ...(invalid === 'batch size' ? { maxBatchItems: 1 } : {}) } }
    const bridge = new NativeInputCommit(n.tasks, n.ledger, n.frames, n.publisher, n.writers, config)
    const turn = new NativeTurnContinuationV2(n.tasks, n.writers, (client, request) => n.frames.verifyInTransaction(client, request),
      { ...ledgerLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser,
        assistant: presentationLimits }, n.frames)
    const store = retainedTestStore({ ...n, bridge }, config, turn)()
    const item = first((await pending(f, n)).items), request = proposal(n, item, 'next-turn', 0)
    if (invalid === 'batch size' || invalid === 'history size') {
      request.events.push(n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [item.message] }))
    }
    const before = await retainedNativeFacts(f.pool)
    await expect(store.prepare(n.a.token, { version: 1, workerId: n.writer.workerId, mutation: { family: 'admission',
      request: { ...request, expectedEventCount: invalid === 'wrong prefix' ? 1 : request.expectedEventCount } } }))
      .rejects.toMatchObject(invalid === 'wrong prefix'
        ? { status: 409, code: 'native_input_batch_conflict' } : { status: 413, code: 'native_input_command_budget' })
    expect(await retainedNativeFacts(f.pool)).toEqual(before)
    expect((await f.pool.query('SELECT intent_id FROM pe_native_retained_intents')).rows).toEqual([])
  }))
