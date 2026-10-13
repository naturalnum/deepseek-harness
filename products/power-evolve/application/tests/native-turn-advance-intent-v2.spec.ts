/** Actual PG preparation followed by the existing full-cohort continuation and actual Host publisher seal. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, onTestFinished, test } from 'vitest'
import { operationId, requestId } from '../src/contracts.ts'
import { NativeAssistantPublisher } from '../src/host/native-assistant-publisher.ts'
import { nativeAssistantBatch } from '../src/native-assistant-records.ts'
import { admittedInputMessage, inputCohortId, nativeInputAdmissionCommand, nativeInputClaimCommand,
  nativeInputQueueCommand, nativeInputStepCommand, originInputId, type NativeInputFrameVerifier } from '../src/native-input-ledger-contracts.ts'
import { foldInputHistory, nativeInputRecordDigest } from '../src/native-input-ledger-records.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnAdvanceIntentV2 } from '../src/platform/native-turn-advance-intent-v2.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const token = () => randomBytes(32).toString('base64url')
const taskLimits = { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const ledgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
  maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const assistantLimits = { maxBatchItems: 128, maxBatchBytes: 2_097_152, maxItemBytes: 1_048_576,
  maxActiveBytes: 1_048_576, maxRingItems: 128, maxRingBytes: 2_097_152, ttlMs: 60_000, maxEventBytes: 524_288 }
const limits = { ...ledgerLimits, leaseMs: 60_000, maxActivePerUser: 2, assistant: assistantLimits }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned advance intent v2 fixture returned no row')
  return row
}
function userMessage(input: unknown) {
  const message = admittedInputMessage.parse(input)
  if (message.source.kind !== 'user') throw new Error('Owned fixture requires an actual user acceptance')
  return { ...message, source: message.source }
}

async function schema(f: Fixture): Promise<void> {
  const frames = process.env.PE_NATIVE_TURN_TEST_DDL_FILE, ledger = process.env.PE_NATIVE_INPUT_TEST_DDL_FILE
  const continuation = process.env.PE_NATIVE_CONTINUATION_V2_TEST_DDL_FILE
  const tables = ['pe_native_turn_frames', 'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
    'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_transitions_v2']
  const inspect = async () => (await f.pool.query<{ name: string; present: boolean }>(
    "SELECT name,to_regclass('public.'||name) IS NOT NULL AS present FROM unnest($1::text[]) AS needed(name)",
    [[...tables, 'pe_native_turn_transitions']])).rows
  const versions = (await f.pool.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
  if (versions.length !== 1 || first(versions).family !== 'cloud-native') throw new Error('Invalid cloud fixture schema metadata')
  const present = await inspect()
  if (frames !== undefined || ledger !== undefined || continuation !== undefined) {
    if (!frames || !ledger || !continuation || first(versions).version !== 4 || present.some(row => row.present)) {
      throw new Error('Private intent v2 DDL requires an empty schema4 extension and all three complete files')
    }
    await f.pool.query(await readFile(frames, 'utf8'))
    await f.pool.query(await readFile(ledger, 'utf8'))
    await f.pool.query(await readFile(continuation, 'utf8'))
    const installed = await inspect()
    if (tables.some(name => !installed.find(row => row.name === name)?.present)) {
      throw new Error('Private intent v2 DDL did not install every required table')
    }
  } else if (first(versions).version !== CURRENT_SCHEMA_VERSION || tables.some(name => !present.find(row => row.name === name)?.present)
    || present.find(row => row.name === 'pe_native_turn_transitions')?.present) {
    throw new Error(`Intent v2 tests require complete formal cloud-native schema${CURRENT_SCHEMA_VERSION}`)
  }
}

async function prepare(f: Fixture, pending = true, pendingTarget: 'next-turn' | 'next-step' = 'next-turn') {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const aRequest = requestId.parse(randomUUID())
  await tasks.accept(f.alice.user, created.sessionId, aRequest, 'A original owner', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), a = await tasks.claim(workerId)
  if (!a) throw new Error('Actual bootstrap operation was not claimed')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 60_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: token() }
  const leased = await writers.acquire(a.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: a.token }
  const events = new EventStore(tasks, { maxEventBytes: taskLimits.maxEventBytes, ...historyLimits })
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const verifier: NativeInputFrameVerifier = (client, request) => frames.verifyInTransaction(client, request)
  const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits, verifier)
  const store = new NativeAssistantStore(tasks, events, assistantLimits)
  const publisher = new NativeAssistantPublisher(a, 0, { ...assistantLimits, maxQueueItems: 128,
    maxQueueBytes: 2_097_152 }, (credential, input) => store.apply(credential, input))
  onTestFinished(() => publisher.close())
  publisher.heartbeat(); await publisher.flush()
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const inputs: {
    message: ReturnType<typeof userMessage>
    operationId: ReturnType<typeof operationId.parse>
    originInputId: ReturnType<typeof originInputId.parse> }[] = []
  const add = async (id: ReturnType<typeof requestId.parse>) => {
    const operation = first((await f.pool.query<{ id: string }>(
      'SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows)
    const content = first((await f.pool.query<{ admitted: unknown }>(
      'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows).admitted
    const value = { operationId: operationId.parse(operation.id), originInputId: originInputId.parse(randomUUID()),
      message: userMessage({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId: id }, content }) }
    inputs.push(value); return value
  }
  await add(aRequest)
  for (const name of ['B', 'C']) {
    const id = requestId.parse(randomUUID())
    await tasks.accept(f.alice.user, created.sessionId, id, `${name} queued input`, f.alice.token)
    await add(id)
  }
  const commit = async <T>(expectedEventCount: number, batch: SessionEvent[],
    write: (client: Parameters<typeof verifier>[0]) => Promise<T>) => publisher.commitInput(expectedEventCount, batch, false,
    position => transaction(f.pool, async (client) => {
      const value = await write(client)
      const receipt = await store.commitInputInTransaction(client, a.token, expectedEventCount, nativeAssistantBatch.parse({
        version: 1, epoch: position.epoch, publisherId: position.publisherId, batchId: randomUUID(),
        firstOrdinal: position.firstOrdinal, items: batch.map(event => ({ type: 'event', event })) }))
      return { receipt, value }
    }))
  const admit = async (item: typeof inputs[number], target: 'next-turn' | 'next-step') => {
    const expectedEventCount = history.length, start = foldInputHistory(header, history).inbox[target].length
    const event = native.append('agent/inbox/spliced', { target, start, inserted: [item.message] })
    history.push(event)
    await commit(expectedEventCount, [event], client => ledger.commitAcceptedAdmissionInTransaction(client,
      nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: a.sessionId, originInputId: item.originInputId,
        originOperationId: item.operationId, messageId: item.message.id, target }), authority, { expectedEventCount, events: [event] }))
  }
  await admit(first(inputs.slice(1)), 'next-step'); await admit(first(inputs.slice(2)), 'next-step'); await admit(first(inputs), 'next-turn')
  const frame = await transaction(f.pool, client => frames.prepareInTransaction(client, authority, first(inputs).originInputId))
  if (pending) {
    const id = requestId.parse(randomUUID())
    await tasks.accept(f.alice.user, a.sessionId, id, 'D original input', f.alice.token)
    const item = await add(id)
    if (pendingTarget === 'next-turn') await admit(item, pendingTarget)
  }
  const cohorts: ReturnType<typeof nativeInputClaimCommand.parse>[] = []
  const claim = async (initial: boolean) => {
    const expectedEventCount = history.length
    const batch = initial ? [native.append('turn/start', { turn: 1 }),
      native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [] }),
      native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })] : []
    history.push(...batch)
    const command = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
      boundaryKind: initial ? 'initial-turn-step' : 'continuing-step', frame: { sessionId: a.sessionId,
        operationId: a.operationId, operationEpoch: a.epoch, writerEpoch: writer.epoch,
        frozenSnapshotDigest: frame.frozenSnapshotDigest } })
    await commit(expectedEventCount, batch, client => ledger.commitClaimInTransaction(client, command, authority,
      { expectedEventCount, events: batch }))
    cohorts.push(command)
  }
  const publish = async (batch: SessionEvent[]) => { history.push(...batch); await publisher.append(batch) }
  const step = async (number: number, bind = true) => {
    const event = native.append('step/start', { turn: 1, step: number })
    await publish([event])
    if (bind) {
      const cohort = first(cohorts.slice(number - 1))
      await transaction(f.pool, client => ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: cohort.cohortId,
        frame: cohort.frame, stepStartSeq: event.seq }), authority))
    }
    await publish([native.append('step/end', { turn: 1, step: number })])
  }
  const editPending = async () => {
    const d = first(inputs.slice(3)), expectedEventCount = history.length
    const content = [{ type: 'text' as const, text: 'D edited in actual PG' }], message = { ...d.message, content }
    const event = native.append('agent/inbox/spliced', { target: pendingTarget, start: 0, removedCount: 1,
      outcome: 'canceled', inserted: [message] })
    history.push(event)
    await commit(expectedEventCount, [event], client => ledger.commitQueueInTransaction(client, f.alice.token,
      nativeInputQueueCommand.parse({ rpcNonce: randomUUID(), payload: { sessionId: a.sessionId,
        itemId: d.message.id, action: { kind: 'edit', content } } }), authority, { expectedEventCount, events: [event] }))
    return message
  }
  const finish = async () => {
    await publish([native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    return { writer, transitionId: randomUUID(), candidateToken: token(), seal: await publisher.seal() }
  }
  const close = async () => { await claim(true); await step(1); return finish() }
  const builder = new NativeTurnAdvanceIntentV2(tasks, writers, verifier, { ...historyLimits,
    maxAcceptedAuditBytes: ledgerLimits.maxAcceptedAuditBytes, maxRevisionBytes: ledgerLimits.maxRevisionBytes,
    maxCohortInputs: ledgerLimits.maxCohortInputs, maxCommandBytes: ledgerLimits.maxCommandBytes, assistant: assistantLimits })
  const continuation = new NativeTurnContinuationV2(tasks, writers, verifier, limits)
  return { tasks, writer, a, publisher, native, history, inputs, cohorts, builder, continuation,
    claim, step, publish, editPending, finish, close, admitPending: () => admit(first(inputs.slice(3)), 'next-step') }
}

async function intentCase(run: (f: Fixture, n: Prepared) => Promise<void>, pending = true,
  target: 'next-turn' | 'next-step' = 'next-turn'): Promise<void> {
  await cloudFixture(async (f) => { await schema(f); await run(f, await prepare(f, pending, target)) })
}
async function state(f: Fixture) {
  const result = []
  for (const table of ['pe_sessions', 'pe_operations', 'pe_attempts', 'pe_native_writers', 'pe_native_turn_frames',
    'pe_native_turn_transitions_v2', 'pe_native_presentations', 'pe_native_presentation_entries', 'pe_native_input_origins',
    'pe_native_input_revisions', 'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_input_commands', 'pe_events']) {
    result.push((await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)
  }
  return result
}

test('actual PG supplies full B,C,A source and pending D, then actual continuation settles once', () => intentCase(async (f, n) => {
  const retained = await n.close(), before = await state(f), intent = await n.builder.prepare(n.a.token, retained)
  expect(await state(f)).toEqual(before)
  expect(intent).toMatchObject({ version: 2, kind: 'advance', ...retained, expectedEventCount: n.history.length,
    expectedQueueRevision: n.history.findLast(event => event.type === 'agent/inbox/spliced')?.seq,
    from: { operationToken: n.a.token, turn: 1, turnStartSeq: n.history.find(event => event.type === 'turn/start')?.seq,
      turnEndSeq: n.history.at(-1)?.seq, cohortIds: n.cohorts.map(cohort => cohort.cohortId),
      claimedOriginInputIds: [first(n.inputs.slice(1)).originInputId, first(n.inputs.slice(2)).originInputId,
        first(n.inputs).originInputId] },
    expectedNext: { originInputId: first(n.inputs.slice(3)).originInputId, operationId: first(n.inputs.slice(3)).operationId,
      messageId: first(n.inputs.slice(3)).message.id, inputRevision: 1,
      inputDigest: nativeInputRecordDigest(first(n.inputs.slice(3)).message), target: 'next-turn' } })
  const result = await n.continuation.transition(intent)
  expect(result.receipt.settled.map(item => item.originInputId)).toEqual(intent.from.claimedOriginInputIds)
  expect(result.current.kind).toBe('live')
  if (result.current.kind !== 'live') throw new Error('Expected actual original D grant')
  expect(result.current.grant).toMatchObject({ operationId: first(n.inputs.slice(3)).operationId, token: retained.candidateToken })
  n.publisher.retire(retained.seal)
  const after = await state(f)
  expect(await n.continuation.transition(intent)).toEqual({ ...result, replayed: true })
  expect(await state(f)).toEqual(after)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(2)
}))

test('empty continuing cohort remains ordered in the generated intent and empty pending head parks', () => intentCase(async (f, n) => {
  await n.claim(true); await n.step(1); await n.claim(false); await n.step(2)
  const retained = await n.finish(), before = await state(f), intent = await n.builder.prepare(n.a.token, retained)
  expect(await state(f)).toEqual(before)
  expect(intent.from.cohortIds).toEqual(n.cohorts.map(cohort => cohort.cohortId))
  expect(intent.from.claimedOriginInputIds).toHaveLength(3)
  expect(intent.expectedNext).toBeNull()
  expect(first((await f.pool.query<{ count: number }>(
    'SELECT claim_count AS count FROM pe_native_input_cohorts WHERE boundary_ordinal=1')).rows).count).toBe(0)
  const result = await n.continuation.transition(intent)
  expect(result.current).toEqual({ kind: 'parked' })
  expect(result.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
  n.publisher.retire(retained.seal)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(1)
}, false))

test('pending first next-step head uses the latest actual ledger revision after an edit', () => intentCase(async (f, n) => {
  await n.claim(true); await n.step(1)
  await n.admitPending()
  const edited = await n.editPending(), retained = await n.finish(), before = await state(f)
  const intent = await n.builder.prepare(n.a.token, retained)
  expect(await state(f)).toEqual(before)
  expect(intent.expectedNext).toMatchObject({ inputRevision: 2, inputDigest: nativeInputRecordDigest(edited), target: 'next-step' })
  const result = await n.continuation.transition(intent)
  expect(result.current.kind).toBe('live')
  if (result.current.kind !== 'live') throw new Error('Expected actual original D grant')
  expect(result.current.grant).toMatchObject({ operationId: first(n.inputs.slice(3)).operationId,
    nativeContent: first(n.inputs.slice(3)).message.content })
  n.publisher.retire(retained.seal)
}, true, 'next-step'))

test('old original bearer cannot prepare after the retained intent has transitioned', () => intentCase(async (f, n) => {
  const retained = await n.close(), intent = await n.builder.prepare(n.a.token, retained)
  await n.continuation.transition(intent); n.publisher.retire(retained.seal)
  const before = await state(f)
  await expect(n.builder.prepare(n.a.token, retained)).rejects.toMatchObject({ code: 'lease_lost' })
  expect(await state(f)).toEqual(before)
}))

test('a prepared candidate cannot settle after actual PG events and publisher watermark change', () => intentCase(async (f, n) => {
  const retained = await n.close(), intent = await n.builder.prepare(n.a.token, retained)
  await n.editPending()
  const before = await state(f)
  await expect(n.continuation.transition(intent)).rejects.toMatchObject({ code: 'native_continuation_v2_watermark' })
  expect(await state(f)).toEqual(before)
  expect(first((await f.pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pe_native_turn_transitions_v2')).rows).count).toBe(0)
}))

test('actual presentation seal is required and caller source, phase and revision coordinates are rejected', () => intentCase(async (f, n) => {
  const retained = await n.close(), before = await state(f)
  for (const seal of [{ ...retained.seal, publisherId: randomUUID() },
    { ...retained.seal, lastOrdinal: retained.seal.lastOrdinal + 1 },
    { ...retained.seal, revision: retained.seal.revision + 1 }, { ...retained.seal, eventCount: retained.seal.eventCount + 1 }]) {
    await expect(n.builder.prepare(n.a.token, { ...retained, seal })).rejects.toMatchObject({ code: 'native_advance_intent_v2_seal' })
  }
  for (const foreign of [{ from: {} }, { phase: 'closed' }, { expectedQueueRevision: 0 }, { expectedNext: null }]) {
    await expect(n.builder.prepare(n.a.token, { ...retained, ...foreign })).rejects.toMatchObject({ code: 'invalid_request' })
  }
  expect(await state(f)).toEqual(before)
}))

test('an actual second step with no corresponding durable cohort refuses without settlement', () => intentCase(async (f, n) => {
  await n.claim(true); await n.step(1); await n.step(2, false)
  const retained = await n.finish(), before = await state(f)
  await expect(n.builder.prepare(n.a.token, retained)).rejects.toMatchObject({ code: 'native_advance_intent_v2_cohort_incomplete' })
  expect(await state(f)).toEqual(before)
}))

test('an open owned turn cannot be prepared from its current acknowledged publisher seal', () => intentCase(async (f, n) => {
  await n.claim(true); await n.step(1)
  const retained = { writer: n.writer, transitionId: randomUUID(), candidateToken: token(), seal: await n.publisher.seal() }
  const before = await state(f)
  await expect(n.builder.prepare(n.a.token, retained)).rejects.toMatchObject({ code: 'native_advance_intent_v2_not_closed' })
  expect(await state(f)).toEqual(before)
}))

test.each(['operation', 'writer', 'presentation'] as const)('expired actual %s clock refuses without any preparation write',
  clock => intentCase(async (f, n) => {
    const retained = await n.close()
    const sql = clock === 'operation' ? 'UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 second\' WHERE id=$1'
      : clock === 'writer' ? 'UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval \'1 second\' WHERE session_id=$1'
        : 'UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval \'1 second\' WHERE session_id=$1'
    await f.pool.query(sql, [n.a.sessionId])
    const before = await state(f)
    await expect(n.builder.prepare(n.a.token, retained)).rejects.toMatchObject({ status: 409 })
    expect(await state(f)).toEqual(before)
  }))
