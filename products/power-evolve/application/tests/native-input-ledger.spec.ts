/** Real PG admissions and complete native cohorts using the actual version-two frame provider. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { operationId, requestId } from '../src/contracts.ts'
import { admittedInputMessage, inputCohortId, inputCommandId, inputCommandReceipt, nativeInputAdmissionCommand, nativeInputClaimCommand,
  nativeInputQueueCommand, nativeInputStepCommand, originInputId, type NativeInputLedgerLimits }  from '../src/native-input-ledger-contracts.ts'
import { foldInputHistory, nativeInputRecordDigest, readInputOrigin, readInputRevision } from '../src/native-input-ledger-records.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger, NativeInputNativePlanner } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { SkillService } from '../src/platform/skills.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const taskLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const ledgerLimits: NativeInputLedgerLimits = { maxEventBytes: taskLimits.maxEventBytes,
  maxHistoryBytes: taskLimits.maxHistoryBytes, maxHistoryEvents: taskLimits.maxHistoryEvents, maxAcceptedAuditBytes: 2_097_152,
  maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const frameLimits = { maxHistoryEvents: taskLimits.maxHistoryEvents, maxHistoryBytes: taskLimits.maxHistoryBytes,
  maxFrameBytes: 2_097_152, maxCohortInputs: 128 }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned ledger fixture returned no row')
  return row
}

async function schema(f: Fixture): Promise<void> {
  const frames = process.env.PE_NATIVE_TURN_TEST_DDL_FILE
  const ledger = process.env.PE_NATIVE_INPUT_TEST_DDL_FILE
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
      throw new Error('Private ledger DDL requires an empty schema4 extension and both complete files')
    }
    await f.pool.query(await readFile(frames, 'utf8'))
    await f.pool.query(await readFile(ledger, 'utf8'))
    const installed = await inspect()
    if (tables.filter(name => name !== 'pe_native_turn_transitions_v2').some(name => !installed.find(row => row.name === name)?.present)) {
      throw new Error('Private ledger DDL did not install every required table')
    }
  } else if (first(versions).version !== CURRENT_SCHEMA_VERSION || tables.some(name => !present.find(row => row.name === name)?.present)
    || present.find(row => row.name === 'pe_native_turn_transitions')?.present) {
    throw new Error('Input-ledger tests require the complete current formal cloud-native schema')
  }
}

async function prepare(f: Fixture, targets: readonly ('next-step' | 'next-turn')[] = ['next-step', 'next-step', 'next-turn'],
  indexes: readonly number[] = [1, 2, 0], admissionActor: 'browser' | 'writer' = 'browser') {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const requests = [requestId.parse(randomUUID()), requestId.parse(randomUUID()), requestId.parse(randomUUID())]
  const aRequest = first(requests)
  await tasks.accept(f.alice.user, created.sessionId, aRequest, 'A original input', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID())
  const a = await tasks.claim(workerId)
  if (!a) throw new Error('Actual bootstrap admission was not claimed')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(a.token, acquire)
  const writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: a.token }
  const events = new EventStore(tasks, taskLimits)
  const frames = new NativeExecutionFrames(tasks, writers, frameLimits)
  const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits,
    (client, command) => frames.verifyInTransaction(client, command))
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header)
  const history: SessionEvent[] = []
  const inputs: {
    message: ReturnType<typeof admittedInputMessage.parse>
    operationId: ReturnType<typeof operationId.parse>
    originInputId: ReturnType<typeof originInputId.parse>
  }[] = []
  for (const [index, id] of requests.entries()) {
    if (index !== 0) await tasks.accept(f.alice.user, created.sessionId, id, `${index === 1 ? 'B' : 'C'} original input`, f.alice.token)
    const accepted = first((await f.pool.query<{ id: string }>('SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows)
    const content = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows).admitted
    const message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId: id }, content })
    inputs.push({ message, operationId: operationId.parse(accepted.id), originInputId: originInputId.parse(randomUUID()) })
  }
  const order = indexes.map(index => inputs[index])
  const admissions = []
  for (const [index, item] of order.entries()) {
    if (!item) throw new Error('Owned fixture lacks native input')
    const target = targets[index]
    if (!target) throw new Error('Owned fixture lacks input target')
    const prefix = history.length
    const event = native.append('agent/inbox/spliced', { target, start: foldInputHistory(header, history).inbox[target].length, inserted: [item.message] })
    history.push(event)
    const command = nativeInputAdmissionCommand.parse({ rpcNonce: `admit-${index}`, sessionId: created.sessionId,
      originInputId: item.originInputId, originOperationId: item.operationId, messageId: item.message.id, target })
    const receipt = admissionActor === 'writer'
      ? await transaction(f.pool, client => ledger.commitAcceptedAdmissionInTransaction(client, command, authority,
        { expectedEventCount: prefix, events: [event] }))
      : await ledger.admit(f.alice.token, { command, authority, expectedEventCount: prefix, events: [event] })
    admissions.push({ command, receipt, event })
  }
  const owner = first(inputs)
  const frame = await transaction(f.pool, client => frames.prepareInTransaction(client, authority, owner.originInputId))
  return { tasks, writers, writer, a, authority, events, frames, ledger, header, native, history, inputs, admissions, frame }
}

async function ledgerCase(run: (f: Fixture, n: Prepared) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => { await schema(f); await run(f, await prepare(f)) })
}

function claimBatch(n: Prepared) {
  const prefix = n.history.length
  const events: SessionEvent[] = [n.native.append('turn/start', { turn: 1 })]
  n.history.push(first(events))
  const inbox = foldInputHistory(n.header, n.history).inbox
  if (inbox['next-step'].length) events.push(n.native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: inbox['next-step'].length, inserted: [] }))
  if (inbox['next-turn'].length) events.push(n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }))
  n.history.push(...events.slice(1))
  const command = nativeInputClaimCommand.parse({ rpcNonce: 'claim-initial', cohortId: inputCohortId.parse(randomUUID()),
    frame: { sessionId: n.a.sessionId, operationId: n.a.operationId, operationEpoch: n.a.epoch,
      writerEpoch: n.writer.epoch, frozenSnapshotDigest: n.frame.frozenSnapshotDigest }, boundaryKind: 'initial-turn-step' })
  return { command, authority: n.authority, expectedEventCount: prefix, events }
}

async function state(f: Fixture) {
  const tables = ['pe_sessions', 'pe_operations', 'pe_attempts', 'pe_native_writers', 'pe_events', 'pe_native_turn_frames',
    'pe_native_input_origins', 'pe_native_input_revisions', 'pe_native_input_commands', 'pe_native_input_cohorts', 'pe_native_input_claims']
  return Promise.all(tables.map(async table => ({ table, rows: (await f.pool.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows })))
}

test('actual admission and full B,C,A cohort bind A alone without claiming B or C operation grants', () => ledgerCase(async (f, n) => {
  const batch = claimBatch(n)
  const receipt = await n.ledger.claim(batch)
  expect(receipt.result).toEqual({ kind: 'claimed', cohortId: batch.command.cohortId })
  expect(receipt.committedSpliceSeqs).toEqual(batch.events.slice(1).map(event => event.seq))
  const claims = (await f.pool.query<{ message_id: string; cohort_ordinal: number; splice_item_ordinal: number; target: string }>(`SELECT o.message_id,c.cohort_ordinal,c.splice_item_ordinal,c.target
    FROM pe_native_input_claims c JOIN pe_native_input_origins o USING(origin_input_id) ORDER BY c.cohort_ordinal`)).rows
  expect(claims).toEqual([n.inputs[1], n.inputs[2], n.inputs[0]].map((item, index) => ({ message_id: item?.message.id,
    cohort_ordinal: index, splice_item_ordinal: index === 2 ? 0 : index, target: index === 2 ? 'next-turn' : 'next-step' })))
  const stored = first((await f.pool.query<{ frame_json: unknown; grant_json: unknown }>('SELECT frame_json,grant_json FROM pe_native_turn_frames')).rows)
  expect(stored.frame_json).toMatchObject({ version: 2, phase: 'claimed', owner: { originInputId: first(n.inputs).originInputId, inputRevision: 1, target: 'next-turn' } })
  const verified = await transaction(f.pool, client => n.frames.verifyInTransaction(client,
    { authority: n.authority, expected: batch.command.frame, kind: 'read' }))
  const frozen = verified.frozenSnapshot
  expect(frozen.operationId).toBe(n.a.operationId)
  expect(frozen.requestId).toBe(n.a.requestId)
  const operations = (await f.pool.query<{ id: string; state: string }>('SELECT id,state FROM pe_operations ORDER BY id')).rows
  for (const item of n.inputs) expect(operations.find(row => row.id === item.operationId)?.state).toBe(item.operationId === n.a.operationId ? 'running' : 'queued')
  expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_attempts')).rows).count).toBe('1')
  const before = await state(f)
  expect(await n.ledger.claim(batch)).toEqual(receipt)
  expect(await state(f)).toEqual(before)
}))

test('a partial two-splice cohort refuses and rolls back every native and ledger fact', () => ledgerCase(async (f, n) => {
  const batch = claimBatch(n), before = await state(f)
  await expect(n.ledger.claim({ ...batch, events: batch.events.slice(0, 2) })).rejects.toMatchObject({ status: 409, code: 'native_input_batch_incomplete' })
  expect(await state(f)).toEqual(before)
}))

test('a wrong snapshot digest refuses before any complete-cohort effect', () => ledgerCase(async (f, n) => {
  const batch = claimBatch(n), before = await state(f)
  await expect(n.ledger.claim({ ...batch, command: { ...batch.command, frame: { ...batch.command.frame, frozenSnapshotDigest: 'a'.repeat(64) } } })).rejects.toMatchObject({ status: 409 })
  expect(await state(f)).toEqual(before)
}))

test('browser nonce replay returns its original revision while conflicting commands refuse', () => ledgerCase(async (f, n) => {
  const admitted = first(n.admissions), before = await state(f)
  expect(await n.ledger.admit(f.alice.token, { command: admitted.command, authority: n.authority,
    expectedEventCount: admitted.event.seq, events: [admitted.event] })).toEqual(admitted.receipt)
  await expect(n.ledger.admit(f.alice.token, { command: { ...admitted.command, target: 'next-turn' }, authority: n.authority,
    expectedEventCount: admitted.event.seq, events: [admitted.event] })).rejects.toMatchObject({ status: 409, code: 'native_input_nonce_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('cross-account admission replay cannot enter another Session nonce namespace', () => ledgerCase(async (f, n) => {
  const admitted = first(n.admissions), before = await state(f)
  await expect(n.ledger.admit(f.bob.token, { command: admitted.command, authority: n.authority,
    expectedEventCount: admitted.event.seq, events: [admitted.event] })).rejects.toMatchObject({ status: 404 })
  expect(await state(f)).toEqual(before)
}))

test('an edit preserves original capabilities and source but the complete cohort consumes revision two', () => ledgerCase(async (f, n) => {
  const owner = first(n.inputs)
  const command = nativeInputQueueCommand.parse({ rpcNonce: 'owner-edit', payload: { sessionId: n.a.sessionId, itemId: owner.message.id,
    action: { kind: 'edit', content: [{ type: 'text', text: 'A edited input' }] } } })
  const expectedEventCount = n.history.length
  const event = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled',
    inserted: [{ ...owner.message, content: [{ type: 'text', text: 'A edited input' }] }] })
  n.history.push(event)
  const receipt = await transaction(f.pool, client => n.ledger.commitQueueInTransaction(client, f.alice.token, command,
    n.authority, { expectedEventCount, events: [event] }))
  expect(receipt.result).toMatchObject({ kind: 'pending', inputRevision: 2 })
  const batch = claimBatch(n)
  await n.ledger.claim(batch)
  const frame = first((await f.pool.query<{ frame_json: unknown; grant_json: unknown }>('SELECT frame_json,grant_json FROM pe_native_turn_frames')).rows)
  expect(frame.frame_json).toMatchObject({ owner: { inputRevision: 2, originInputId: owner.originInputId } })
  expect(frame.grant_json).toMatchObject({ text: 'A original input', nativeContent: [{ type: 'text', text: 'A original input' }] })
  expect(first((await f.pool.query<{ accepted_audit_json: unknown }>('SELECT accepted_audit_json FROM pe_native_input_origins WHERE origin_input_id=$1', [owner.originInputId])).rows).accepted_audit_json)
    .toMatchObject({ text: 'A original input' })
  expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_input_claims')).rows).count).toBe('3')
}))

test('claimed inputs remain permanently consumed before any step or user message', () => ledgerCase(async (f, n) => {
  const batch = claimBatch(n)
  await n.ledger.claim(batch)
  expect(first((await f.pool.query<{ step_start_seq: number | null }>('SELECT step_start_seq FROM pe_native_input_cohorts')).rows).step_start_seq).toBeNull()
  const before = await state(f), owner = first(n.inputs)
  const command = nativeInputQueueCommand.parse({ rpcNonce: 'late-edit', payload: { sessionId: n.a.sessionId, itemId: owner.message.id,
    action: { kind: 'edit', content: [{ type: 'text', text: 'too late' }] } } })
  await expect(transaction(f.pool, client => n.ledger.commitQueueInTransaction(client, f.alice.token, command, n.authority,
    { expectedEventCount: n.history.length, events: [] }))).rejects.toMatchObject({ status: 409, code: 'native_input_already_consumed' })
  expect(await state(f)).toEqual(before)
}))

test('a real stored step binds once and repeated binding returns the same immutable cohort', () => ledgerCase(async (f, n) => {
  const batch = claimBatch(n)
  await n.ledger.claim(batch)
  const event = n.native.append('step/start', { turn: 1, step: 1 })
  n.history.push(event)
  await n.events.append(n.a.token, [event])
  const command = nativeInputStepCommand.parse({ cohortId: batch.command.cohortId, stepStartSeq: event.seq, frame: batch.command.frame })
  const bound = await n.ledger.bindStep({ command, authority: n.authority }), before = await state(f)
  expect(bound.cohort.stepStartSeq).toBe(event.seq)
  expect(bound.claims).toHaveLength(3)
  expect(await n.ledger.bindStep({ command, authority: n.authority })).toEqual(bound)
  await expect(n.ledger.bindStep({ command: { ...command, stepStartSeq: event.seq - 1 }, authority: n.authority }))
    .rejects.toMatchObject({ status: 409 })
  expect(await state(f)).toEqual(before)
}))

test('missing frame verifier and official planner both refuse rather than reporting success', () => ledgerCase(async (f, n) => {
  const noVerifier = new NativeInputLedger(n.tasks, n.writers, n.events, ledgerLimits)
  const admitted = first(n.admissions), before = await state(f)
  await expect(noVerifier.admit(f.alice.token, { command: admitted.command, authority: n.authority,
    expectedEventCount: admitted.event.seq, events: [admitted.event] })).rejects.toMatchObject({ status: 503, code: 'native_input_frame_verifier_unavailable' })
  await expect(n.ledger.queue(f.alice.token, { rpcNonce: 'missing-planner', payload: { sessionId: n.a.sessionId,
    itemId: first(n.inputs).message.id, action: { kind: 'remove' } } }, n.authority))
    .rejects.toMatchObject({ status: 503, code: 'native_input_planner_unavailable' })
  expect(await state(f)).toEqual(before)
}))

test('durable audit and revision digests compare exact raw JSON rather than repairing omitted metadata', () => ledgerCase(async (f) => {
  const origin = first((await f.pool.query<{ origin: unknown }>(`SELECT jsonb_build_object('originInputId',origin_input_id,'sessionId',session_id,
    'originOperationId',origin_operation_id,'originalRequestId',original_request_id,'messageId',message_id,
    'acceptedSnapshotDigest',accepted_snapshot_digest,'acceptedAudit',accepted_audit_json) AS origin FROM pe_native_input_origins LIMIT 1`)).rows).origin
  const parsed = readInputOrigin(origin)
  expect(nativeInputRecordDigest(parsed.acceptedAudit)).toBe(parsed.acceptedSnapshotDigest)
  const revision = first((await f.pool.query<{ revision: unknown }>(`SELECT jsonb_build_object('originInputId',origin_input_id,'sessionId',session_id,
    'inputRevision',input_revision,'previousRevision',previous_revision,'cause',cause,'message',message_json,
    'inputDigest',input_digest,'committedSpliceSeq',committed_splice_seq,'commandId',command_id) AS revision FROM pe_native_input_revisions LIMIT 1`)).rows).revision
  const decoded = readInputRevision(revision)
  expect(() => readInputRevision({ ...decoded, message: { ...decoded.message, content: [{ type: 'text', text: 'changed' }] } })).toThrow('native_input_ledger_corrupt')
  expect(() => readInputOrigin({ ...parsed, acceptedAudit: { ...parsed.acceptedAudit, source: undefined } })).toThrow('native_input_ledger_corrupt')
}))

test('official detached planner commits a complete edit then removal without inventing an activity capture', () => ledgerCase(async (f, n) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
    const ledger = new NativeInputLedger(n.tasks, n.writers, n.events, ledgerLimits,
      (client, command) => n.frames.verifyInTransaction(client, command), new NativeInputNativePlanner(ctx.sessionProjections))
    const item = first(n.inputs.slice(1))
    const original = first((await f.pool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM pe_operations WHERE id=$1', [item.operationId])).rows)
    expect(original).toEqual({ state: 'queued', attempts: 0 })
    const edited = await ledger.queue(f.alice.token, { rpcNonce: 'official-edit', payload: { sessionId: n.a.sessionId,
      itemId: item.message.id, action: { kind: 'edit', content: [{ type: 'text', text: 'official replacement' }] } } }, n.authority)
    expect(edited.result).toMatchObject({ kind: 'pending', inputRevision: 2, target: 'next-step' })
    const removeCommand = nativeInputQueueCommand.parse({ rpcNonce: 'official-remove', payload: { sessionId: n.a.sessionId,
      itemId: item.message.id, action: { kind: 'remove' } } })
    const removed = await ledger.queue(f.alice.token, removeCommand, n.authority)
    expect(removed.result).toMatchObject({ kind: 'removed', originInputId: item.originInputId, inputRevision: 2 })
    expect(first((await f.pool.query<{ state: string; error_code: string; attempts: number; completed: boolean; input: string }>(
      'SELECT state,error_code,attempts,completed_at IS NOT NULL AS completed,input FROM pe_operations WHERE id=$1',
      [item.operationId])).rows)).toEqual({ state: 'failed', error_code: 'native_input_removed', attempts: 0,
      completed: true, input: 'B original input' })
    expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_attempts WHERE operation_id=$1',
      [item.operationId])).rows).count).toBe('0')
    expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_input_claims')).rows).count).toBe('0')
    const committed = await state(f)
    expect(await ledger.queue(f.alice.token, removeCommand, n.authority)).toEqual(removed)
    expect(await state(f)).toEqual(committed)
    const recorded = (await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [n.a.sessionId])).rows
    expect(recorded.slice(-2).map(row => row.event)).toMatchObject([
      { type: 'agent/inbox/spliced', data: { outcome: 'canceled', removedCount: 1, inserted: [{ id: item.message.id, source: item.message.source }] } },
      { type: 'agent/inbox/spliced', data: { outcome: 'canceled', removedCount: 1, inserted: [] } },
    ])
    // Remove the real fixture's lease/Writer barriers before checking ordinary claim eligibility.
    await n.tasks.finish(n.a.token, 'failed', 'owned_fixture_finished')
    await n.writers.release(n.writer)
    const remaining = await n.tasks.claim(nativeWriterWorkerId.parse(randomUUID()))
    if (!remaining) throw new Error('Remaining queued C was not claimable after releasing fixture occupancy')
    expect(remaining.operationId).toBe(first(n.inputs.slice(2)).operationId)
    await n.tasks.finish(remaining.token, 'completed', null)
    expect(await n.tasks.claim(nativeWriterWorkerId.parse(randomUUID()))).toBeNull()
    expect(first((await f.pool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM pe_operations WHERE id=$1', [item.operationId])).rows)).toEqual({ state: 'failed', attempts: 0 })
    expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_attempts WHERE operation_id=$1',
      [item.operationId])).rows).count).toBe('0')
  } finally { await ctx.fiber.dispose() }
}))

test('official remove refuses the active prepared owner and rolls back every native and operation fact', () => ledgerCase(async (f, n) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
    const ledger = new NativeInputLedger(n.tasks, n.writers, n.events, ledgerLimits,
      (client, command) => n.frames.verifyInTransaction(client, command), new NativeInputNativePlanner(ctx.sessionProjections))
    const owner = first(n.inputs)
    expect(owner.operationId).toBe(n.a.operationId)
    expect(first((await f.pool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM pe_operations WHERE id=$1', [owner.operationId])).rows)).toEqual({ state: 'running', attempts: 1 })
    expect(first((await f.pool.query<{ operation_id: string; frame: unknown }>(
      'SELECT operation_id,frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1', [owner.operationId])).rows))
      .toMatchObject({ operation_id: owner.operationId,
        frame: { version: 2, phase: 'prepared', candidateOriginInputId: owner.originInputId } })
    const before = await state(f)
    const watermark = first((await f.pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1',
      [n.a.sessionId])).rows).event_count
    const command = nativeInputQueueCommand.parse({ rpcNonce: 'remove-prepared-owner', payload: {
      sessionId: n.a.sessionId, itemId: owner.message.id, action: { kind: 'remove' },
    } })
    await expect(ledger.queue(f.alice.token, command, n.authority))
      .rejects.toMatchObject({ status: 409, code: 'native_input_remove_active_owner' })
    expect(first((await f.pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1',
      [n.a.sessionId])).rows).event_count).toBe(watermark)
    expect(await state(f)).toEqual(before)
    expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_input_commands WHERE transport_nonce=$1',
      [command.rpcNonce])).rows).count).toBe('0')
  } finally { await ctx.fiber.dispose() }
}))

test('initial ownership without a next-turn head is the first next-step input of its original operation', () => cloudFixture(async (f) => {
  await schema(f)
  const n = await prepare(f, ['next-step', 'next-step', 'next-step'], [0, 1, 2]), batch = claimBatch(n)
  await n.ledger.claim(batch)
  expect(first((await f.pool.query<{ owner_kind: string; owner_origin_input_id: string }>(
    'SELECT owner_kind,owner_origin_input_id FROM pe_native_input_cohorts')).rows))
    .toEqual({ owner_kind: 'first-next-step', owner_origin_input_id: first(n.inputs).originInputId })
  expect(first((await f.pool.query<{ frame_json: unknown }>('SELECT frame_json FROM pe_native_turn_frames')).rows).frame_json)
    .toMatchObject({ owner: { originInputId: first(n.inputs).originInputId, target: 'next-step', spliceItemOrdinal: 0 } })
}))

test('Root v2 independently refuses B,A ledger facts against the complete canonical B,C,A pre-state', () => ledgerCase(async (f, n) => {
  const batch = claimBatch(n), before = await state(f), owner = first(n.inputs), b = first(n.inputs.slice(1))
  const commandId = inputCommandId.parse(randomUUID()), firstSplice = first(batch.events.slice(1))
  const ownerSplice = first(batch.events.slice(2))
  const receipt = inputCommandReceipt.parse({ version: 1, commandId, sessionId: n.a.sessionId,
    actor: { kind: 'writer', userId: n.a.userId, workerId: n.writer.workerId, writerEpoch: n.writer.epoch },
    rpcNonce: 'forged-incomplete-proof', payloadDigest: nativeInputRecordDigest(batch), kind: 'claim',
    eventCount: batch.expectedEventCount + batch.events.length, committedSpliceSeqs: [firstSplice.seq, ownerSplice.seq],
    result: { kind: 'claimed', cohortId: batch.command.cohortId } })
  await expect(transaction(f.pool, async (client) => {
    const session = await n.tasks.authorized(client, n.a.token)
    await n.events.appendInTransaction(client, session, batch.events)
    await client.query(`INSERT INTO pe_native_input_commands(command_id,session_id,user_id,actor_kind,actor_id,writer_epoch,
      transport_nonce,payload_digest,kind,target_origin_input_id,committed_event_count,receipt_json)
      VALUES($1,$2,$3,'writer',$4,$5,$6,$7,'claim',NULL,$8,$9)`,
    [commandId, n.a.sessionId, n.a.userId, n.writer.workerId, n.writer.epoch, receipt.rpcNonce, receipt.payloadDigest,
      receipt.eventCount, receipt])
    const ownerDigest = nativeInputRecordDigest(owner.message)
    await client.query(`INSERT INTO pe_native_input_cohorts(cohort_id,session_id,execution_operation_id,operation_epoch,writer_epoch,
      frozen_snapshot_digest,owner_kind,owner_origin_input_id,owner_input_revision,owner_input_digest,turn_start_seq,turn_number,
      boundary_ordinal,step_start_seq,claim_count,command_id,command_kind)
      VALUES($1,$2,$3,$4,$5,$6,'next-turn-head',$7,1,$8,$9,1,0,NULL,2,$10,'claim')`,
    [batch.command.cohortId, n.a.sessionId, n.a.operationId, n.a.epoch, n.writer.epoch,
      n.frame.frozenSnapshotDigest, owner.originInputId, ownerDigest, first(batch.events).seq, commandId])
    for (const [ordinal, item] of [b, owner].entries()) await client.query(`INSERT INTO pe_native_input_claims(origin_input_id,session_id,
      input_revision,input_digest,cohort_id,claim_splice_seq,splice_item_ordinal,cohort_ordinal,target) VALUES($1,$2,1,$3,$4,$5,0,$6,$7)`,
    [item.originInputId, n.a.sessionId, nativeInputRecordDigest(item.message), batch.command.cohortId,
      ordinal === 0 ? firstSplice.seq : ownerSplice.seq, ordinal, ordinal === 0 ? 'next-step' : 'next-turn'])
    await n.frames.verifyInTransaction(client, { authority: n.authority, expected: batch.command.frame, kind: 'bind-owner', owner: {
      originInputId: owner.originInputId, inputRevision: 1, inputDigest: ownerDigest, cohortId: batch.command.cohortId,
      claimSpliceSeq: ownerSplice.seq, spliceItemOrdinal: 0, target: 'next-turn', turnStartSeq: first(batch.events).seq, turn: 1 } })
  })).rejects.toMatchObject({ status: 409, code: 'native_execution_frame_cohort_incomplete' })
  expect(await state(f)).toEqual(before)
}))

test('Root v2 refuses omitted durable nested skill-selection defaults rather than parsing them back into the snapshot', () => cloudFixture(async (f) => {
  await schema(f)
  const skills = new SkillService(f.pool, f.root)
  await skills.init()
  await skills.install(f.alice.user, randomUUID(), 'Original selection', 'Original skill', 'Original instructions')
  const n = await prepare(f), batch = claimBatch(n)
  expect(n.a.selection).toHaveLength(1)
  await f.pool.query(`UPDATE pe_native_turn_frames SET grant_json=jsonb_set(grant_json,'{selection,0}',
    (grant_json#>'{selection,0}')-'kind'-'version') WHERE operation_id=$1`, [n.a.operationId])
  const before = await state(f)
  await expect(n.ledger.claim(batch)).rejects.toMatchObject({ status: 503, code: 'native_execution_frame_corrupt' })
  expect(await state(f)).toEqual(before)
}))

async function acceptedProposal(f: Fixture, n: Prepared, acceptedSession = n.a.sessionId, actor = f.alice) {
  const acceptingHost = new TaskStore(f.pool, taskLimits), id = requestId.parse(randomUUID())
  await acceptingHost.accept(actor.user, acceptedSession, id, 'B accepted on another Host', actor.token)
  const operation = first((await f.pool.query<{ id: string }>('SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2',
    [acceptedSession, id])).rows)
  const content = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2',
    [acceptedSession, id])).rows).admitted
  const message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId: id }, content })
  const expectedEventCount = n.history.length
  const event = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: foldInputHistory(n.header, n.history).inbox['next-turn'].length,
    inserted: [message] })
  n.history.push(event)
  const command = nativeInputAdmissionCommand.parse({ rpcNonce: 'accepted-writer-admission', sessionId: n.a.sessionId,
    originInputId: originInputId.parse(randomUUID()), originOperationId: operation.id, messageId: message.id, target: 'next-turn' })
  return { command, batch: { expectedEventCount, events: [event] }, message }
}

test('accepted Writer admission bootstraps actual A before frame preparation without a browser actor', () => cloudFixture(async (f) => {
  await schema(f)
  const n = await prepare(f, ['next-turn', 'next-step', 'next-step'], [0, 1, 2], 'writer')
  const initial = first(n.admissions)
  expect(initial.command.originOperationId).toBe(n.a.operationId)
  expect(initial.receipt.eventCount).toBe(1)
  expect(initial.receipt.actor).toEqual({ kind: 'writer', userId: n.a.userId, workerId: n.writer.workerId, writerEpoch: n.writer.epoch })
  expect(n.frame).toMatchObject({ version: 2, phase: 'prepared', preparedEventCount: 3, candidateOriginInputId: first(n.inputs).originInputId })
  expect(first((await f.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM pe_native_input_commands WHERE actor_kind='browser'")).rows).n).toBe('0')
}))

test('accepted Writer admission persists queued cross-Host B after its accepting browser bearer is logged out', () => ledgerCase(async (f, n) => {
  const claimed = claimBatch(n)
  await n.ledger.claim(claimed)
  const step = n.native.append('step/start', { turn: 1, step: 1 })
  n.history.push(step)
  await transaction(f.pool, async (client) => {
    const session = await n.tasks.authorized(client, n.a.token)
    await n.events.appendInTransaction(client, session, [step])
    await n.ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: claimed.command.cohortId,
      frame: claimed.command.frame, stepStartSeq: step.seq }), n.authority)
  })
  const proposal = await acceptedProposal(f, n)
  await f.identities.logout(f.alice.token)
  const beforeFrame = first((await f.pool.query<{ frame_json: unknown; grant_json: unknown }>('SELECT frame_json,grant_json FROM pe_native_turn_frames')).rows)
  const receipt = await transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    proposal.command, n.authority, proposal.batch))
  expect(receipt.actor).toEqual({ kind: 'writer', userId: n.a.userId, workerId: n.writer.workerId, writerEpoch: n.writer.epoch })
  expect(receipt.result).toMatchObject({ kind: 'pending', originInputId: proposal.command.originInputId, inputRevision: 1, target: 'next-turn' })
  expect(first((await f.pool.query<{ state: string; settings: unknown; input: string }>(
    'SELECT state,settings,input FROM pe_operations WHERE id=$1', [proposal.command.originOperationId])).rows))
    .toMatchObject({ state: 'queued', input: 'B accepted on another Host' })
  expect(first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2',
    [n.a.sessionId, proposal.message.source.kind === 'user' ? proposal.message.source.rpcId : null])).rows).admitted).toEqual(proposal.message.content)
  expect(first((await f.pool.query<{ frame_json: unknown; grant_json: unknown }>('SELECT frame_json,grant_json FROM pe_native_turn_frames')).rows)).toEqual(beforeFrame)
  expect(first((await f.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM pe_attempts')).rows).n).toBe('1')
}))

test.each(['same-user-session', 'other-user'] as const)('accepted Writer admission refuses an origin from %s', scope => ledgerCase(async (f, n) => {
  const actor = scope === 'other-user' ? f.bob : f.alice
  const foreign = await n.tasks.create(actor.user, requestId.parse(randomUUID()), actor.token)
  const proposal = await acceptedProposal(f, n, foreign.sessionId, actor), before = await state(f)
  await expect(transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    proposal.command, n.authority, proposal.batch))).rejects.toMatchObject({ status: 409, code: 'native_input_origin_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('accepted Writer admission refuses another command Session before entering its nonce namespace', () => ledgerCase(async (f, n) => {
  const proposal = await acceptedProposal(f, n), foreign = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const before = await state(f)
  await expect(transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    { ...proposal.command, sessionId: foreign.sessionId }, n.authority, proposal.batch)))
    .rejects.toMatchObject({ status: 409, code: 'native_input_scope_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('accepted Writer admission refuses a canceled original B while A storage authority remains live', () => ledgerCase(async (f, n) => {
  const proposal = await acceptedProposal(f, n)
  await f.pool.query("UPDATE pe_operations SET error_code='cancel_requested' WHERE id=$1", [proposal.command.originOperationId])
  const before = await state(f)
  await expect(transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    proposal.command, n.authority, proposal.batch))).rejects.toMatchObject({ status: 409, code: 'native_input_origin_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('accepted Writer admission nonce replay preserves the immutable result and conflicting payloads refuse', () => ledgerCase(async (f, n) => {
  const proposal = await acceptedProposal(f, n)
  const receipt = await transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
      proposal.command, n.authority, proposal.batch)), before = await state(f)
  expect(await transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    proposal.command, n.authority, proposal.batch))).toEqual(receipt)
  await expect(transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    { ...proposal.command, target: 'next-step' }, n.authority, proposal.batch)))
    .rejects.toMatchObject({ status: 409, code: 'native_input_nonce_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('accepted Writer admission rolls back its canonical event and every new fact when late actual frame verification fails', () => ledgerCase(async (f, n) => {
  const proposal = await acceptedProposal(f, n)
  await f.pool.query("UPDATE pe_native_turn_frames SET grant_json=grant_json-'nativeContent' WHERE operation_id=$1", [n.a.operationId])
  const before = await state(f)
  await expect(transaction(f.pool, client => n.ledger.commitAcceptedAdmissionInTransaction(client,
    proposal.command, n.authority, proposal.batch))).rejects.toMatchObject({ status: 503, code: 'native_execution_frame_corrupt' })
  expect(await state(f)).toEqual(before)
}))
