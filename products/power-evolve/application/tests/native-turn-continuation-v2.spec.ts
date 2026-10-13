/** Real PG full-cohort continuation through Root's actual v2 frame provider, ledger and publisher. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { interruptedTurnClosers, Session, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, onTestFinished, test } from 'vitest'
import type { PoolClient } from 'pg'
import { operationId, requestId, PlatformError } from '../src/contracts.ts'
import { continuationInput } from '../src/continuation-input.ts'
import { NativeAssistantPublisher } from '../src/host/native-assistant-publisher.ts'
import { nativeExecutionFrame, type NativeExecutionFrame } from '../src/native-execution-frame-contracts.ts'
import { admittedInputMessage, inputCohortId, nativeInputAdmissionCommand, nativeInputClaimCommand,
  nativeInputStepCommand, originInputId, type InputOrigin, type NativeInputFrameVerifier } from '../src/native-input-ledger-contracts.ts'
import { foldInputHistory, nativeInputRecordDigest, readInputOrigin } from '../src/native-input-ledger-records.ts'
import { nativeContinuationSavedGrantV2, nativeTurnTransitionV2, type NativeTurnTransitionV2 } from '../src/native-turn-continuation-v2-contracts.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { readSessionStopInTransaction } from '../src/platform/native-session-stop.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { ConnectorService } from '../src/platform/connectors.ts'
import { EventStore } from '../src/platform/events.ts'
import { hashPassword } from '../src/platform/identity.ts'
import { nativeAssistantBatch } from '../src/native-assistant-records.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeAttachments } from '../src/platform/native-attachments.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { SkillService } from '../src/platform/skills.ts'
import { PluginService } from '../src/platform/plugins.ts'
import type { NativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { NativeTurnAdvanceIntentV2 } from '../src/platform/native-turn-advance-intent-v2.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedTestStore, retainedNativeFacts } from './native-retained-intent-fixture.ts'

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
  if (row === undefined) throw new Error('Owned continuation v2 fixture returned no row')
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
      throw new Error('Private continuation v2 DDL requires an empty schema4 extension and all three complete files')
    }
    await f.pool.query(await readFile(frames, 'utf8'))
    await f.pool.query(await readFile(ledger, 'utf8'))
    await f.pool.query(await readFile(continuation, 'utf8'))
    const installed = await inspect()
    if (tables.some(name => !installed.find(row => row.name === name)?.present)) {
      throw new Error('Private continuation v2 DDL did not install every required table')
    }
  } else if (first(versions).version !== CURRENT_SCHEMA_VERSION || tables.some(name => !present.find(row => row.name === name)?.present)
    || present.find(row => row.name === 'pe_native_turn_transitions')?.present) {
    throw new Error('Continuation v2 tests require complete formal current cloud-native schema')
  }
}

async function prepare(f: Fixture, pending = true, sourceSessionAttachments = false, textSkill = false,
  historicalAttachments = false, deferredQueuedAdmission = false) {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const historicalFiles = historicalAttachments ? new NativeAttachments(f.pool, tasks, f.files, {
    root: join(f.root, 'recovery-history-files'), maxFilesPerSession: 8, maxBytesPerUser: 1_048_576, maxFilesPerUser: 16,
  }) : undefined
  await historicalFiles?.init()
  const uploadHistoricalFile = async (name: string) => {
    if (!historicalFiles) throw new Error('Historical file fixture was not requested')
    async function* bytes() { yield Buffer.from(name) }
    const file = await historicalFiles.upload(f.alice.user, f.alice.token, created.sessionId, bytes(), name,
      new AbortController().signal)
    return { type: 'file' as const, receiptId: file.receiptId }
  }
  const aRequest = requestId.parse(randomUUID())
  if (historicalAttachments) {
    await tasks.accept(f.alice.user, created.sessionId, aRequest, 'A original owner', f.alice.token, { kind: 'cloud' },
      [{ type: 'text', text: 'A original owner' }, await uploadHistoricalFile('A original.txt')])
  } else await tasks.accept(f.alice.user, created.sessionId, aRequest, 'A original owner', f.alice.token)
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
  const publisher = new NativeAssistantStore(tasks, events, assistantLimits), publisherId = randomUUID()
  let presentation = await publisher.apply(a.token, { version: 1, epoch: a.epoch, publisherId,
    batchId: randomUUID(), firstOrdinal: 1, items: [] })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const inputs: {
    message: ReturnType<typeof userMessage>
    operationId: ReturnType<typeof operationId.parse>
    originInputId: ReturnType<typeof originInputId.parse> }[] = []
  const add = async (id: ReturnType<typeof requestId.parse>) => {
    const operation = first((await f.pool.query<{ id: string }>('SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows)
    const content = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows).admitted
    const value = { operationId: operationId.parse(operation.id), originInputId: originInputId.parse(randomUUID()),
      message: userMessage({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId: id }, content }) }
    inputs.push(value); return value
  }
  await add(aRequest)
  for (const name of ['B', 'C']) {
    const id = requestId.parse(randomUUID())
    if (historicalAttachments && name === 'B') {
      await tasks.accept(f.alice.user, created.sessionId, id, 'B queued input', f.alice.token, { kind: 'cloud' },
        [{ type: 'text', text: 'B queued input' }, await uploadHistoricalFile('B second.txt'),
          await uploadHistoricalFile('B first.txt')])
    } else await tasks.accept(f.alice.user, created.sessionId, id, `${name} queued input`, f.alice.token)
    await add(id)
  }
  const admit = async (item: typeof inputs[number], target: 'next-turn' | 'next-step') => {
    const expectedEventCount = history.length
    const start = foldInputHistory(header, history).inbox[target].length
    const event = native.append('agent/inbox/spliced', { target, start, inserted: [item.message] })
    history.push(event)
    await transaction(f.pool, async (client) => {
      await ledger.commitAcceptedAdmissionInTransaction(client, nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(),
        sessionId: a.sessionId, originInputId: item.originInputId, originOperationId: item.operationId,
        messageId: item.message.id, target }), authority, { expectedEventCount, events: [event] })
      presentation = await publisher.commitInputInTransaction(client, a.token, expectedEventCount, nativeAssistantBatch.parse({
        version: 1, epoch: a.epoch, publisherId, batchId: randomUUID(), firstOrdinal: presentation.lastOrdinal + 1,
        items: [{ type: 'event', event }] }))
    })
  }
  if (!deferredQueuedAdmission) {
    await admit(first(inputs.slice(1)), 'next-step'); await admit(first(inputs.slice(2)), 'next-step')
  }
  await admit(first(inputs), 'next-turn')
  const prepareFrame = () => transaction(f.pool, client => frames.prepareInTransaction(client, authority, first(inputs).originInputId))
  let frame = sourceSessionAttachments ? undefined : await prepareFrame()
  if (pending) {
    if (textSkill) {
      const skills = new SkillService(f.pool, join(f.root, 'continuation-skills'))
      await skills.init()
      const id = randomUUID()
      await skills.install(f.alice.user, id, 'Receipt skill', 'Actual accepted text skill', 'Owned text instructions')
      await skills.toggle(f.alice.user, id, true)
    }
    await f.pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,1000,true)',
      [f.alice.user.userId, 'D original model'])
    await f.pool.query('UPDATE pe_users SET settings=jsonb_set(settings,\'{model}\',to_jsonb(\'D original model\'::text)) WHERE id=$1', [f.alice.user.userId])
    const files = new NativeAttachments(f.pool, tasks, f.files, { root: join(f.root, 'continuation-files'),
      maxFilesPerSession: 8, maxBytesPerUser: 1_048_576, maxFilesPerUser: 16 })
    await files.init()
    async function* bytes(text: string) { yield Buffer.from(text) }
    const uploaded = []
    for (const name of ['second.txt', 'first.txt']) uploaded.push(await files.upload(f.alice.user, f.alice.token, a.sessionId, bytes(name), name, new AbortController().signal))
    const id = requestId.parse(randomUUID())
    await tasks.accept(f.alice.user, a.sessionId, id, 'D original input', f.alice.token, { kind: 'cloud' },
      [{ type: 'text', text: 'D original input' }, ...uploaded.map(item => ({ type: 'file' as const, receiptId: item.receiptId }))])
    await admit(await add(id), 'next-turn')
  }
  frame ??= await prepareFrame()
  const cohorts: ReturnType<typeof nativeInputClaimCommand.parse>[] = []
  const claim = async (initial: boolean, empty = false) => {
    const expectedEventCount = history.length, nextStep = foldInputHistory(header, history).inbox['next-step']
    const batch = initial ? [native.append('turn/start', { turn: 1 }),
      ...(nextStep.length ? [native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: nextStep.length, inserted: [] })] : []),
      native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
      : empty ? [] : [native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })]
    history.push(...batch)
    const command = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
      boundaryKind: initial ? 'initial-turn-step' : 'continuing-step', frame: { sessionId: a.sessionId,
        operationId: a.operationId, operationEpoch: a.epoch, writerEpoch: writer.epoch,
        frozenSnapshotDigest: frame.frozenSnapshotDigest } })
    await transaction(f.pool, async (client) => {
      await ledger.commitClaimInTransaction(client, command, authority, { expectedEventCount, events: batch })
      presentation = await publisher.commitInputInTransaction(client, a.token, expectedEventCount,
        nativeAssistantBatch.parse({ version: 1, epoch: a.epoch, publisherId, batchId: randomUUID(),
          firstOrdinal: presentation.lastOrdinal + 1,
          items: batch.map(event => ({ type: 'event', event })) }))
    })
    cohorts.push(command)
  }
  const publish = async (batch: SessionEvent[]) => {
    history.push(...batch)
    presentation = await publisher.apply(a.token, { version: 1, epoch: a.epoch, publisherId,
      batchId: randomUUID(), firstOrdinal: presentation.lastOrdinal + 1, items: batch.map(event => ({ type: 'event', event })) })
  }
  const step = async (number: number) => {
    const event = native.append('step/start', { turn: 1, step: number })
    await publish([event])
    const cohort = first(cohorts.slice(number - 1))
    await transaction(f.pool, client => ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: cohort.cohortId,
      frame: cohort.frame, stepStartSeq: event.seq }), authority))
    await publish([native.append('step/end', { turn: 1, step: number })])
  }
  const acceptedOrigin = async (message: string): Promise<InputOrigin> => readInputOrigin(first((await f.pool.query<Record<string, unknown>>(`SELECT
    origin_input_id AS "originInputId",session_id AS "sessionId",origin_operation_id AS "originOperationId",original_request_id AS "originalRequestId",
    message_id AS "messageId",accepted_snapshot_digest AS "acceptedSnapshotDigest",accepted_audit_json AS "acceptedAudit"
    FROM pe_native_input_origins WHERE session_id=$1 AND message_id=$2`, [a.sessionId, message])).rows))
  const close = async (withStep = true): Promise<NativeTurnTransitionV2> => {
    await claim(true)
    if (withStep) await step(1)
    return finish(withStep)
  }
  const finish = async (completed = true): Promise<NativeTurnTransitionV2> => {
    const end = native.append('turn/end', { turn: 1, reason: { kind: completed ? 'completed' : 'blocked' } })
    await publish([end])
    const d = inputs[3], audit = d ? await acceptedOrigin(d.message.id) : undefined
    return nativeTurnTransitionV2.parse({ version: 2, kind: 'advance', writer, transitionId: randomUUID(), candidateToken: token(),
      expectedEventCount: history.length, expectedQueueRevision: history.findLast(event => event.type === 'agent/inbox/spliced')?.seq,
      expectedNext: d && audit ? { originInputId: d.originInputId, operationId: d.operationId, messageId: d.message.id,
        inputRevision: 1, inputDigest: nativeInputRecordDigest(d.message), target: 'next-turn' } : null,
      from: { frame: first(cohorts).frame, operationToken: a.token, turn: 1,
        turnStartSeq: first(history.filter(event => event.type === 'turn/start')).seq, turnEndSeq: end.seq,
        cohortIds: cohorts.map(cohort => cohort.cohortId), claimedOriginInputIds: [first(inputs.slice(1)).originInputId,
          first(inputs.slice(2)).originInputId, first(inputs).originInputId, ...inputs.slice(4).map(item => item.originInputId)] },
      seal: { publisherId, lastOrdinal: presentation.lastOrdinal, revision: presentation.revision, eventCount: presentation.eventCount } })
  }
  const continuation = new NativeTurnContinuationV2(tasks, writers, verifier, limits)
  return { tasks, writers, writer, a, authority, ledger, frames, native, history, inputs, cohorts, frame, verifier,
    publisher, publisherId, continuation, claim, step, add, admit, publish, close, finish, acceptedOrigin }
}

async function continuationCase(run: (f: Fixture, n: Prepared) => Promise<void>, pending = true): Promise<void> {
  await cloudFixture(async (f) => { await schema(f); await run(f, await prepare(f, pending)) })
}
async function state(f: Fixture) {
  const result = []
  for (const table of ['pe_sessions', 'pe_operations', 'pe_attempts', 'pe_native_writers', 'pe_native_turn_frames', 'pe_native_turn_transitions_v2',
    'pe_native_presentations', 'pe_native_presentation_entries', 'pe_native_input_origins', 'pe_native_input_claims']) {
    result.push((await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)
  }
  return result
}

test('an actual rejected Connector result retains its frozen excerpt across larger deployment limits through closed settlement', () => cloudFixture(async (f) => {
  await schema(f)
  const username = `nonuser-${randomUUID()}`, password = randomUUID()
  await seedNewUser(f.pool, username, await hashPassword(password), { model: 'trial-model', maxTokens: 1000, revision: 1 })
  const actor = await f.identities.login(username, password), approval = await f.identities.login(username, password, 'approval')
  let externalCalls = 0
  const server = createServer((_request, response) => { externalCalls++; response.writeHead(500); response.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned Connector endpoint did not acquire a TCP port')
  onTestFinished(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  })
  const oldEventBytes = 4096, newEventBytes = 16_384
  let tasks = new TaskStore(f.pool, { ...taskLimits, maxEventBytes: oldEventBytes })
  const created = await tasks.create(actor.user, requestId.parse(randomUUID()), actor.token)
  await tasks.accept(actor.user, created.sessionId, requestId.parse(randomUUID()), 'Original Connector producer', actor.token)
  const rootWorker = nativeWriterWorkerId.parse(randomUUID()), root = await tasks.claim(rootWorker)
  if (!root) throw new Error('Actual original Connector producer was not claimed')
  let writers = new NativeSessionWriter(tasks, { leaseMs: 60_000 })
  const rootAcquire = { sessionId: root.sessionId, workerId: rootWorker, token: token() }
  const rootLease = await writers.acquire(root.token, rootAcquire)
  let writer = nativeWriterIdentity.parse({ ...rootAcquire, epoch: rootLease.epoch })
  let activeGrant = root, authority = { writer, operationToken: root.token }
  let events = new EventStore(tasks, { ...historyLimits, maxEventBytes: oldEventBytes })
  let frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const verifier: NativeInputFrameVerifier = (client, command) => frames.verifyInTransaction(client, command)
  let ledger = new NativeInputLedger(tasks, writers, events, { ...ledgerLimits, maxEventBytes: oldEventBytes }, verifier)
  let store = new NativeAssistantStore(tasks, events, { ...assistantLimits, maxEventBytes: oldEventBytes })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [root.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const publisherFor = () => new NativeAssistantPublisher(activeGrant, history.length,
    { ...assistantLimits, maxQueueItems: 128, maxQueueBytes: 2_097_152 }, (credential, input) => store.apply(credential, input))
  let publisher = publisherFor()
  onTestFinished(() => publisher.close())
  publisher.heartbeat(); await publisher.flush()
  const commit = async <T>(batch: SessionEvent[], write: (client: PoolClient, expectedEventCount: number) => Promise<T>) => {
    const expectedEventCount = history.length
    history.push(...batch)
    return publisher.commitInput(expectedEventCount, batch, false, position => transaction(f.pool, async (client) => {
      const value = await write(client, expectedEventCount)
      const receipt = await store.commitInputInTransaction(client, activeGrant.token, expectedEventCount,
        nativeAssistantBatch.parse({ version: 1, epoch: position.epoch, publisherId: position.publisherId,
          batchId: randomUUID(), firstOrdinal: position.firstOrdinal, items: batch.map(event => ({ type: 'event', event })) }))
      return { value, receipt }
    }))
  }
  const publish = async (batch: SessionEvent[]) => { history.push(...batch); await publisher.append(batch) }
  const admitCurrent = async () => {
    const pending = await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client, authority, 1))
    const item = first(pending.items)
    expect(item.originOperationId).toBe(activeGrant.operationId)
    const id = originInputId.parse(randomUUID())
    const event = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [item.message] })
    await commit([event], (client, expectedEventCount) => ledger.commitAcceptedAdmissionInTransaction(client,
      nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: activeGrant.sessionId, originInputId: id,
        originOperationId: activeGrant.operationId, messageId: item.message.id, target: 'next-turn' }), authority,
      { expectedEventCount, events: [event] }))
    return { ...item, originInputId: id,
      frame: await transaction(f.pool, client => frames.prepareInTransaction(client, authority, id)) }
  }
  const openCurrent = async (turn: number, frame: NativeExecutionFrame) => {
    const batch = [native.append('turn/start', { turn }),
      native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
    const command = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
      boundaryKind: 'initial-turn-step', frame: { sessionId: activeGrant.sessionId, operationId: activeGrant.operationId,
        operationEpoch: activeGrant.epoch, writerEpoch: writer.epoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
    await commit(batch, (client, expectedEventCount) => ledger.commitClaimInTransaction(client, command, authority,
      { expectedEventCount, events: batch }))
    const start = native.append('step/start', { turn, step: 1 })
    await publish([start])
    await transaction(f.pool, client => ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({
      cohortId: command.cohortId, frame: command.frame, stepStartSeq: start.seq }), authority))
  }
  const rootInput = await admitCurrent()
  await openCurrent(1, rootInput.frame)
  const executionAuthority = new NativeExecutionAuthority(
    (client, session, bearer) => frames.readExecutionInTransaction(client, session, bearer),
    { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2_097_152 })
  const executionTasks = new TaskStore(f.pool, { ...taskLimits, maxEventBytes: oldEventBytes },
    (client, session, bearer) => executionAuthority.assertExecutionInTransaction(client, session, bearer))
  expect((await transaction(f.pool, client => executionTasks.executionAuthorized(client, root.token))).operation_id).toBe(root.operationId)
  const connectors = new ConnectorService(executionTasks, `http://127.0.0.1:${address.port}`, token(), 1000, 1000)
  onTestFinished(() => connectors.close())
  await new PluginService(f.pool).seedUsers([username]); await connectors.seedPermissions([username])
  const note = '头部' + '文'.repeat(996) + '尾部', callId = randomUUID()
  expect(note).toHaveLength(1000)
  const proposed = await connectors.prepare(root.token, callId, note)
  const action = first((await f.pool.query<{ id: string; fingerprint: string }>(
    'SELECT id,request_digest AS fingerprint FROM pe_connector_actions WHERE operation_id=$1 AND call_id=$2', [root.operationId, callId])).rows)
  expect(proposed).toMatchObject({ actionId: action.id, state: 'pending', text: note })
  expect(await connectors.decide(actor.user, action.id, action.fingerprint, false, approval.token))
    .toMatchObject({ actionId: action.id, state: 'rejected', text: note })
  const source = first((await f.pool.query<{ id: string; input: string }>(
    "SELECT id,input FROM pe_operations WHERE source='platform_action' AND source_action_id=$1", [action.id])).rows)
  const actionBefore = (await f.pool.query('SELECT * FROM pe_connector_actions WHERE id=$1', [action.id])).rows
  await publish([native.append('step/end', { turn: 1, step: 1 }),
    native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })])
  await publisher.close(); await tasks.finish(root.token, 'completed', null); await writers.release(writer)
  const resultWorker = nativeWriterWorkerId.parse(randomUUID()), result = await tasks.claim(resultWorker)
  if (!result) throw new Error('Actual rejected Connector continuation was not claimed')
  expect(result).toMatchObject({ operationId: source.id, source: 'platform_action', sourceActionId: action.id })
  expect(result.text).toBe(continuationInput(source.input, oldEventBytes))
  expect(result.text).not.toBe(source.input)
  expect(continuationInput(source.input, newEventBytes)).toBe(source.input)
  const resultAcquire = { sessionId: result.sessionId, workerId: resultWorker, token: token() }
  const resultLease = await writers.acquire(result.token, resultAcquire)
  writer = nativeWriterIdentity.parse({ ...resultAcquire, epoch: resultLease.epoch })
  activeGrant = result; authority = { writer, operationToken: result.token }; publisher = publisherFor()
  publisher.heartbeat(); await publisher.flush()
  const resultInput = await admitCurrent()
  expect(resultInput.message.source).toEqual({ kind: 'power-evolve-action', actionId: action.id })
  expect(resultInput.message.content).toEqual([{ type: 'text', text: result.text }])
  const previous = first((await f.pool.query<{ frame: unknown; grant: unknown }>(
    'SELECT frame_json AS frame,grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [result.operationId, result.epoch])).rows)
  const frozen = nativeContinuationSavedGrantV2.parse(previous.grant)
  await publisher.close(); await writers.release(writer)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 millisecond\' WHERE id=$1', [result.sessionId])
  tasks = new TaskStore(f.pool, { ...taskLimits, maxEventBytes: newEventBytes })
  writers = new NativeSessionWriter(tasks, { leaseMs: 60_000 })
  events = new EventStore(tasks, { ...historyLimits, maxEventBytes: newEventBytes })
  frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  ledger = new NativeInputLedger(tasks, writers, events, { ...ledgerLimits, maxEventBytes: newEventBytes }, verifier)
  store = new NativeAssistantStore(tasks, events, { ...assistantLimits, maxEventBytes: newEventBytes })
  const recoveredWorker = nativeWriterWorkerId.parse(randomUUID()), fresh = await tasks.claim(recoveredWorker)
  if (!fresh) throw new Error('Actual nonuser prepared continuation did not receive a new attempt')
  expect(fresh.text).toBe(source.input)
  const recoveredAcquire = { sessionId: fresh.sessionId, workerId: recoveredWorker, token: token() }
  const recoveredLease = await writers.acquire(fresh.token, recoveredAcquire)
  writer = nativeWriterIdentity.parse({ ...recoveredAcquire, epoch: recoveredLease.epoch })
  authority = { writer, operationToken: fresh.token }
  const recovered = await transaction(f.pool, client => frames.recoverPreparedInTransaction(client, authority))
  if (recovered.kind !== 'prepared') throw new Error('Actual nonuser continuation did not retain its prepared frame')
  const { token: recoveredToken, ...saved } = recovered.grant
  expect(recoveredToken).toBe(fresh.token)
  expect(saved).toEqual({ ...frozen, epoch: fresh.epoch })
  expect(saved.text).toBe(result.text)
  expect(saved.text).not.toBe(fresh.text)
  activeGrant = recovered.grant; publisher = publisherFor()
  publisher.heartbeat(); await publisher.flush()
  await openCurrent(2, recovered.frame)
  await publish([native.append('step/end', { turn: 2, step: 1 }),
    native.append('turn/end', { turn: 2, reason: { kind: 'completed' } })])
  const builder = new NativeTurnAdvanceIntentV2(tasks, writers, verifier, { ...historyLimits,
    maxAcceptedAuditBytes: ledgerLimits.maxAcceptedAuditBytes, maxRevisionBytes: ledgerLimits.maxRevisionBytes,
    maxCohortInputs: ledgerLimits.maxCohortInputs, maxCommandBytes: ledgerLimits.maxCommandBytes,
    assistant: { ...assistantLimits, maxEventBytes: newEventBytes } })
  const seal = await publisher.seal()
  const intent = await builder.prepare(fresh.token, { writer, transitionId: randomUUID(), candidateToken: token(), seal })
  const continuation = new NativeTurnContinuationV2(tasks, writers, verifier,
    { ...limits, maxEventBytes: newEventBytes, assistant: { ...assistantLimits, maxEventBytes: newEventBytes } }, frames)
  const settled = await continuation.transition(intent)
  expect(settled.receipt.settled).toEqual([{ originInputId: resultInput.originInputId, operationId: result.operationId,
    outcome: 'completed', errorCode: null }])
  expect(settled.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
  expect(settled.current).toEqual({ kind: 'parked' })
  const committed = await state(f)
  expect(await continuation.transition(intent)).toEqual({ ...settled, replayed: true })
  expect(await state(f)).toEqual(committed)
  expect(first((await f.pool.query<{ frame: unknown; grant: unknown }>(
    'SELECT frame_json AS frame,grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [result.operationId, result.epoch])).rows)).toEqual(previous)
  expect((await f.pool.query('SELECT * FROM pe_connector_actions WHERE id=$1', [action.id])).rows).toEqual(actionBefore)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_connector_actions')).rows).count).toBe(1)
  expect(first((await f.pool.query<{ attempts: number }>('SELECT attempts FROM pe_connector_actions WHERE id=$1', [action.id])).rows).attempts).toBe(0)
  expect(externalCalls).toBe(0)
  publisher.retire(seal)
}))

test.each([false, true])('a real C closed turn settles or reissues older prepared B without losing history (pending=%s)', pendingB => cloudFixture(async (f) => {
  await schema(f)
  const n = await prepare(f, false, false, false, pendingB, true)
  await n.claim(true); await n.step(1)
  await n.publish([n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })])
  await n.tasks.finish(n.a.token, 'completed', null)
  await n.writers.release(n.writer)
  const b = first(n.inputs.slice(1)), c = first(n.inputs.slice(2))
  const bWorker = nativeWriterWorkerId.parse(randomUUID()), bGrant = await n.tasks.claim(bWorker)
  if (!bGrant) throw new Error('Actual FIFO issuer did not claim original B after A settled')
  expect(bGrant.operationId).toBe(b.operationId)
  const bAcquire = { sessionId: bGrant.sessionId, workerId: bWorker, token: token() }
  const bLease = await n.writers.acquire(bGrant.token, bAcquire)
  const bWriter = nativeWriterIdentity.parse({ ...bAcquire, epoch: bLease.epoch })
  let activeGrant = bGrant, authority = { writer: bWriter, operationToken: bGrant.token }, native = n.native
  const publisherFor = (value: typeof activeGrant) => new NativeAssistantPublisher(value, n.history.length,
    { ...assistantLimits, maxQueueItems: 128, maxQueueBytes: 2_097_152 },
    (credential, input) => n.publisher.apply(credential, input))
  let publisher = publisherFor(activeGrant)
  onTestFinished(() => publisher.close())
  publisher.heartbeat(); await publisher.flush()
  const commit = async <T>(batch: SessionEvent[], write: (client: PoolClient, expectedEventCount: number) => Promise<T>) => {
    const expectedEventCount = n.history.length
    n.history.push(...batch)
    return publisher.commitInput(expectedEventCount, batch, false, position => transaction(f.pool, async (client) => {
      const value = await write(client, expectedEventCount)
      const receipt = await n.publisher.commitInputInTransaction(client, activeGrant.token, expectedEventCount,
        nativeAssistantBatch.parse({ version: 1, epoch: position.epoch, publisherId: position.publisherId,
          batchId: randomUUID(), firstOrdinal: position.firstOrdinal, items: batch.map(event => ({ type: 'event', event })) }))
      return { receipt, value }
    }))
  }
  const publish = async (batch: SessionEvent[]) => { n.history.push(...batch); await publisher.append(batch) }
  const admit = async (item: typeof b, target: 'next-step' | 'next-turn') => {
    const start = foldInputHistory(native.header, n.history).inbox[target].length
    const event = native.append('agent/inbox/spliced', { target, start, inserted: [item.message] })
    await commit([event], (client, expectedEventCount) => n.ledger.commitAcceptedAdmissionInTransaction(client,
      nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: activeGrant.sessionId,
        originInputId: item.originInputId, originOperationId: item.operationId, messageId: item.message.id, target }),
      authority, { expectedEventCount, events: [event] }))
  }
  if (pendingB) { await admit(c, 'next-turn'); await admit(b, 'next-turn') }
  else { await admit(b, 'next-step'); await admit(c, 'next-turn') }
  await transaction(f.pool, client => n.frames.prepareInTransaction(client, authority, b.originInputId))
  const bFrame = first((await f.pool.query<Record<string, unknown>>(
    'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2', [b.operationId, bGrant.epoch])).rows)
  const bAttempt = first((await f.pool.query<Record<string, unknown>>(
    'SELECT * FROM pe_attempts WHERE operation_id=$1 AND epoch=$2', [b.operationId, bGrant.epoch])).rows)
  const bOriginal = nativeContinuationSavedGrantV2.parse(bFrame.grant_json)
  if (pendingB) {
    expect(bOriginal.attachments).toHaveLength(3)
    expect((await n.acceptedOrigin(b.message.id)).acceptedAudit.attachments).toHaveLength(2)
  }
  expect(bAttempt.ended_at).toBeNull()
  await publish([native.append('turn/start', { turn: 2 })])
  await publisher.close(); await n.writers.release(bWriter)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 millisecond\' WHERE id=$1', [bGrant.sessionId])
  const tasks = new TaskStore(f.pool, taskLimits, undefined,
    (client, id, fallback) => n.frames.selectClaimInTransaction(client, id, fallback))
  const cWorker = nativeWriterWorkerId.parse(randomUUID()), cGrant = await tasks.claim(cWorker)
  if (!cGrant) throw new Error('Actual native issuer did not select next-turn C over prepared B')
  expect(cGrant.operationId).toBe(c.operationId)
  const cAcquire = { sessionId: cGrant.sessionId, workerId: cWorker, token: token() }
  const cLease = await n.writers.acquire(cGrant.token, cAcquire)
  const cWriter = nativeWriterIdentity.parse({ ...cAcquire, epoch: cLease.epoch })
  activeGrant = cGrant; authority = { writer: cWriter, operationToken: cGrant.token }
  const recovered = await transaction(f.pool, client => n.frames.recoverPreparedInTransaction(client, authority))
  if (recovered.kind !== 'prepared') throw new Error('Actual C admission did not recover its prepared scope')
  publisher = publisherFor(activeGrant)
  publisher.heartbeat(); await publisher.flush()
  const closers = interruptedTurnClosers(n.history)
  expect(closers).toMatchObject([{ type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } } }])
  await publish(closers)
  native = Session.fromRestore(native.header.id, n.history, native.header, SessionLogOffset(0), 'detached')
  await publish(native.snapshotEvents().slice(n.history.length))
  const closeCurrent = async (turn: number, frame: typeof recovered.frame) => {
    const nextStep = foldInputHistory(native.header, n.history).inbox['next-step']
    const batch = [native.append('turn/start', { turn }),
      ...(nextStep.length ? [native.append('agent/inbox/spliced', { target: 'next-step', start: 0,
        removedCount: nextStep.length, inserted: [] })] : []),
      native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
    const command = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
      boundaryKind: 'initial-turn-step', frame: { sessionId: activeGrant.sessionId, operationId: activeGrant.operationId,
        operationEpoch: activeGrant.epoch, writerEpoch: authority.writer.epoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
    await commit(batch, (client, expectedEventCount) => n.ledger.commitClaimInTransaction(client, command, authority,
      { expectedEventCount, events: batch }))
    const start = native.append('step/start', { turn, step: 1 })
    await publish([start])
    await transaction(f.pool, client => n.ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({
      cohortId: command.cohortId, frame: command.frame, stepStartSeq: start.seq }), authority))
    await publish([native.append('step/end', { turn, step: 1 }),
      native.append('turn/end', { turn, reason: { kind: 'completed' } })])
  }
  await closeCurrent(3, recovered.frame)
  const builder = new NativeTurnAdvanceIntentV2(n.tasks, n.writers, n.verifier, { ...historyLimits,
    maxAcceptedAuditBytes: ledgerLimits.maxAcceptedAuditBytes, maxRevisionBytes: ledgerLimits.maxRevisionBytes,
    maxCohortInputs: ledgerLimits.maxCohortInputs, maxCommandBytes: ledgerLimits.maxCommandBytes, assistant: assistantLimits })
  const beforeIntent = await state(f)
  const seal = await publisher.seal()
  const intent = await builder.prepare(cGrant.token, { writer: cWriter, transitionId: randomUUID(), candidateToken: token(),
    seal })
  expect(await state(f)).toEqual(beforeIntent)
  expect(intent.from.claimedOriginInputIds).toEqual(pendingB ? [c.originInputId] : [b.originInputId, c.originInputId])
  expect(intent.from.frame.operationId).toBe(c.operationId)
  if (pendingB) expect(intent.expectedNext).toMatchObject({ operationId: b.operationId, originInputId: b.originInputId, target: 'next-turn' })
  else expect(intent.expectedNext).toBeNull()
  expect(first((await f.pool.query<{ state: string; attempts: number }>(
    'SELECT state,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows)).toEqual({ state: 'running', attempts: 1 })
  const continuation = new NativeTurnContinuationV2(n.tasks, n.writers, n.verifier, limits, n.frames)
  const result = await continuation.transition(intent)
  expect(result.replayed).toBe(false)
  expect(result.receipt.settled.map(item => item.operationId)).toEqual(pendingB ? [c.operationId] : [b.operationId, c.operationId])
  expect(result.receipt.settled.every(item => item.outcome === 'completed' && item.errorCode === null)).toBe(true)
  const committed = await state(f)
  expect(await continuation.transition(intent)).toEqual({ ...result, replayed: true })
  expect(await state(f)).toEqual(committed)
  expect(first((await f.pool.query<Record<string, unknown>>(
    'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2', [b.operationId, bGrant.epoch])).rows)).toEqual(bFrame)
  const endedB = first((await f.pool.query<Record<string, unknown>>(
    'SELECT * FROM pe_attempts WHERE operation_id=$1 AND epoch=$2', [b.operationId, bGrant.epoch])).rows)
  expect(endedB.ended_at).toBeInstanceOf(Date)
  expect(endedB).toEqual({ ...bAttempt, ended_at: endedB.ended_at })
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_turn_transitions_v2')).rows).count).toBe(1)
  await expect(transaction(f.pool, client => n.tasks.authorized(client, bGrant.token))).rejects.toMatchObject({ code: 'lease_lost' })
  if (!pendingB) {
    expect(result.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
    expect(result.current).toEqual({ kind: 'parked' })
    expect(first((await f.pool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows)).toEqual({ state: 'completed', attempts: 1 })
    expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(3)
    publisher.retire(seal)
    return
  }
  if (result.current.kind !== 'live') throw new Error('Actual continuation did not issue original pending B')
  const successor = result.current.grant
  expect(successor.operationId).toBe(b.operationId)
  expect(successor.epoch).toBe(cGrant.epoch + 1)
  expect(successor.token).toBe(intent.candidateToken)
  const { token: _token, ...saved } = successor
  expect(saved).toEqual({ ...bOriginal, epoch: successor.epoch })
  expect(result.current.frame).toMatchObject({ operationId: b.operationId, operationEpoch: successor.epoch,
    writerEpoch: cWriter.epoch, candidateOriginInputId: b.originInputId, phase: 'prepared' })
  expect(first((await f.pool.query<{ state: string; attempts: number }>(
    'SELECT state,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows)).toEqual({ state: 'running', attempts: 2 })
  publisher.retire(seal)
  activeGrant = successor; authority = { writer: cWriter, operationToken: successor.token }
  publisher = publisherFor(activeGrant)
  publisher.heartbeat(); await publisher.flush()
  await closeCurrent(4, result.current.frame)
  const bSeal = await publisher.seal()
  const bIntent = await builder.prepare(successor.token,
    { writer: cWriter, transitionId: randomUUID(), candidateToken: token(), seal: bSeal })
  expect(bIntent.from.claimedOriginInputIds).toEqual([b.originInputId])
  expect(bIntent.expectedNext).toBeNull()
  const final = await continuation.transition(bIntent)
  expect(final.receipt.settled.map(item => item.operationId)).toEqual([b.operationId])
  expect(final.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
  expect(final.current).toEqual({ kind: 'parked' })
  const finalState = await state(f)
  expect(await continuation.transition(bIntent)).toEqual({ ...final, replayed: true })
  expect(await state(f)).toEqual(finalState)
  expect(first((await f.pool.query<Record<string, unknown>>(
    'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2', [b.operationId, bGrant.epoch])).rows)).toEqual(bFrame)
  expect(first((await f.pool.query<Record<string, unknown>>(
    'SELECT * FROM pe_attempts WHERE operation_id=$1 AND epoch=$2', [b.operationId, bGrant.epoch])).rows)).toEqual(endedB)
  expect(first((await f.pool.query<{ state: string; attempts: number }>(
    'SELECT state,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows)).toEqual({ state: 'completed', attempts: 2 })
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(4)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_turn_transitions_v2')).rows).count).toBe(2)
  publisher.retire(bSeal)
}))

test('full B,C,A consumption settles all three original operations and issues pending D exactly once with its original metadata', () => continuationCase(async (f, n) => {
  const request = await n.close(), d = first(n.inputs.slice(3)), audit = await n.acceptedOrigin(d.message.id)
  const original = first((await f.pool.query<{ grant: unknown }>('SELECT grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1', [n.a.operationId])).rows).grant
  await f.pool.query('UPDATE pe_users SET settings=jsonb_set(settings,\'{model}\',to_jsonb(\'changed after D acceptance\'::text)) WHERE id=$1', [f.alice.user.userId])
  const result = await n.continuation.transition(request)
  expect(result.receipt.settled.map(item => item.operationId)).toEqual([
    first(n.inputs.slice(1)).operationId, first(n.inputs.slice(2)).operationId, n.a.operationId,
  ])
  expect(result.current.kind).toBe('live')
  if (result.current.kind !== 'live') throw new Error('Expected original D bearer')
  expect(result.current.grant).toMatchObject({ operationId: d.operationId, epoch: n.a.epoch + 1,
    token: request.candidateToken, text: audit.acceptedAudit.text, settings: audit.acceptedAudit.settings,
    selection: audit.acceptedAudit.selection, remoteMcpTools: audit.acceptedAudit.remoteMcpTools,
    attachments: audit.acceptedAudit.attachments, nativeContent: audit.acceptedAudit.nativeContent })
  expect(result.current.grant.settings.model).toBe('D original model')
  expect(result.current.grant.nativeContent?.filter(block => block.type === 'file')).toHaveLength(2)

  // Decode the actual terminal producer row, then reject another accepted origin and an earlier turn coordinate.
  const settled = nativeExecutionFrame.parse(first((await f.pool.query<{ frame: unknown }>(
    'SELECT frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1', [n.a.operationId])).rows).frame)
  expect(settled.phase).toBe('settled')
  const originalFrame = structuredClone(settled), facts = await retainedNativeFacts(f.pool)
  const nativeInputs = n.native.snapshotEvents(), acceptedInputs = structuredClone(n.inputs)
  expect(nativeExecutionFrame.safeParse({ ...settled, candidateOriginInputId: first(n.inputs.slice(1)).originInputId }))
    .toMatchObject({ success: false, error: { issues: [{ code: 'custom',
      message: 'Consumed owner must match the prepared origin and its native prefix' }] } })
  expect(nativeExecutionFrame.safeParse({ ...settled, turnEndSeq: request.from.turnStartSeq }))
    .toMatchObject({ success: false, error: { issues: [{ code: 'custom', message: 'Settlement must follow the permanent owner claim' }] } })
  expect(settled).toEqual(originalFrame)
  expect(nativeExecutionFrame.parse(settled)).toEqual(originalFrame)
  expect(n.native.snapshotEvents()).toEqual(nativeInputs)
  expect(n.inputs).toEqual(acceptedInputs)
  expect(await retainedNativeFacts(f.pool)).toEqual(facts)
  expect(first((await f.pool.query<{ grant: unknown }>('SELECT grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1', [n.a.operationId])).rows).grant).toEqual(original)
  const before = await state(f), retry = await n.continuation.transition(request)
  expect(retry).toEqual({ ...result, replayed: true }); expect(await state(f)).toEqual(before)
  await expect(transaction(f.pool, client => n.tasks.authorized(client, n.a.token))).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(n.publisher.apply(n.a.token, { version: 1, epoch: n.a.epoch, publisherId: n.publisherId,
    batchId: randomUUID(), firstOrdinal: 1, items: [] })).rejects.toMatchObject({ code: 'lease_lost' })
  expect(await n.tasks.claim(randomUUID())).toBeNull()
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(2)
  const stored = JSON.stringify(first((await f.pool.query<{ receipt: unknown }>('SELECT receipt_json AS receipt FROM pe_native_turn_transitions_v2')).rows).receipt)
  for (const bearer of [n.a.token, n.writer.token, request.candidateToken]) expect(stored).not.toContain(bearer)
}))

test('a permanent full claim followed by assembly failure before any step settles consumption without requeueing B or C', () => continuationCase(async (f, n) => {
  const request = await n.close(false), result = await n.continuation.transition(request)
  expect(n.history.some(event => event.type === 'step/start' || event.type === 'user/message')).toBe(false)
  expect(result.receipt.settled.map(item => [item.outcome, item.errorCode])).toEqual(Array.from({ length: 3 }, () => ['failed', 'turn_blocked']))
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_input_claims')).rows).count).toBe(3)
  expect(await n.tasks.claim(randomUUID())).toBeNull()
}))

test('empty native pending head parks without minting an attempt or renewing the Writer', () => continuationCase(async (f, n) => {
  const request = await n.close(), before = (await f.pool.query('SELECT * FROM pe_native_writers')).rows
  const result = await n.continuation.transition(request)
  expect(result.receipt.result).toEqual({ kind: 'parked', reason: 'empty' }); expect(result.current).toEqual({ kind: 'parked' })
  expect(first((await f.pool.query<{ grant_digest: string | null; lease_until: string | null }>('SELECT grant_digest,lease_until FROM pe_sessions')).rows))
    .toEqual({ grant_digest: null, lease_until: null })
  expect((await f.pool.query('SELECT * FROM pe_native_writers')).rows).toEqual(before)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(1)
  const committed = await state(f)
  expect((await n.continuation.transition(request)).replayed).toBe(true); expect(await state(f)).toEqual(committed)
}, false))

test('real empty archival cohort settlement completes the original native stop only when the final Writer fence commits',
  () => continuationCase(async (f, n) => {
    const request = await n.close()
    const original = await transaction(f.pool, async (client) => {
      await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
      expect((await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [n.a.sessionId, f.alice.user.userId])).rowCount).toBe(1)
      return n.tasks.requestArchiveStopInTransaction(client, f.alice.user, n.a.sessionId)
    })
    await f.pool.query(`CREATE FUNCTION expire_completion_writer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second'
          WHERE session_id=(NEW.value->>'sessionId')::uuid;
        RETURN NEW;
      END $$;
      CREATE TRIGGER expire_completion_writer BEFORE UPDATE ON pe_native_preferences FOR EACH ROW
        WHEN (OLD.value->>'status'='requested' AND NEW.value->>'status'='complete')
        EXECUTE FUNCTION expire_completion_writer()`)
    const before = await state(f), marker = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_preferences')).rows
    await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_writer_lost' })
    expect(await state(f)).toEqual(before)
    expect((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_preferences')).rows).toEqual(marker)
    await f.pool.query('DROP TRIGGER expire_completion_writer ON pe_native_preferences')
    const result = await n.continuation.transition(request)
    expect(result.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
    expect(await transaction(f.pool, client => readSessionStopInTransaction(client, f.alice.user.userId, n.a.sessionId)))
      .toEqual({ ...original, status: 'complete' })
    const done = await state(f), complete = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_preferences')).rows
    expect((await n.continuation.transition(request)).replayed).toBe(true)
    expect(await state(f)).toEqual(done)
    expect((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_preferences')).rows).toEqual(complete)
  }, false))

test('two concurrent retained retries return one identical successor and one receipt without reminting', () => continuationCase(async (f, n) => {
  const request = await n.close()
  const results = await Promise.all([n.continuation.transition(request), n.continuation.transition(request)])
  expect(results.map(result => result.replayed).sort()).toEqual([false, true])
  expect(results[0]?.receipt).toEqual(results[1]?.receipt)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_turn_transitions_v2')).rows).count).toBe(1)
}))

test('competing transition identities cannot create a second successor from the same consumed A', () => continuationCase(async (f, n) => {
  const request = await n.close(), other = { ...request, transitionId: randomUUID(), candidateToken: token() }
  const results = await Promise.allSettled([n.continuation.transition(request), n.continuation.transition(other)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(2)
}))

test('a changed candidate token cannot replay a retained receipt and expiry never returns its historical bearer', () => continuationCase(async (f, n) => {
  const request = await n.close(), result = await n.continuation.transition(request)
  await expect(n.continuation.transition({ ...request, candidateToken: token() })).rejects.toMatchObject({ code: 'native_continuation_v2_intent_conflict' })
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 second\' WHERE id=$1', [n.a.sessionId])
  const before = await state(f), retry = await n.continuation.transition(request)
  expect(retry.receipt).toEqual(result.receipt); expect(retry.current).toEqual({ kind: 'expired' }); expect(await state(f)).toEqual(before)
}))

async function retainedReplayState(f: Fixture) {
  const durable = []
  for (const table of ['pe_events', 'pe_native_input_commands', 'pe_native_input_cohorts',
    'pe_native_input_revisions', 'pe_native_preferences']) {
    durable.push((await f.pool.query<Record<string, unknown>>(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)
  }
  return { state: await state(f), durable }
}

test('receipt-first v2 retains the original result after actual Writer release and replacement without restoring its bearer',
  () => continuationCase(async (f, n) => {
    const request = await n.close(), original = await n.continuation.transition(request)
    expect(original.receipt.result.kind).toBe('prepared')
    expect(original.current.kind).toBe('live')
    await n.writers.release(n.writer)
    const released = await retainedReplayState(f), replay = await n.continuation.transition(request)
    expect(replay).toEqual({ receipt: original.receipt, replayed: true, current: { kind: 'expired' } })
    expect(await retainedReplayState(f)).toEqual(released)
    const acquire = { sessionId: n.a.sessionId, workerId: n.writer.workerId, token: token() }
    const replacement = await n.writers.acquire(request.candidateToken, acquire)
    expect(replacement.epoch).toBeGreaterThan(n.writer.epoch)
    const replaced = await retainedReplayState(f), repeated = await n.continuation.transition(request)
    expect(repeated).toEqual(replay)
    expect(await retainedReplayState(f)).toEqual(replaced)
    for (const secret of [request.candidateToken, request.writer.token, request.from.operationToken]) {
      expect(JSON.stringify(repeated)).not.toContain(secret)
    }
  }))

test('receipt-first v2 rejects changed full intent, original secrets, foreign scope and unknown receipts with zero writes',
  () => continuationCase(async (f, n) => {
    const request = await n.close(), original = await n.continuation.transition(request)
    await n.writers.release(n.writer)
    const foreign = await n.tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
    const before = await retainedReplayState(f)
    const attempts = [
      { request: { ...request, seal: { ...request.seal, lastOrdinal: request.seal.lastOrdinal + 1 } },
        code: 'native_continuation_v2_intent_conflict' },
      { request: { ...request, candidateToken: token() }, code: 'native_continuation_v2_intent_conflict' },
      { request: { ...request, from: { ...request.from, operationToken: token() } }, code: 'native_continuation_v2_identity' },
      { request: { ...request, writer: { ...request.writer, token: token() } }, code: 'native_continuation_v2_intent_conflict' },
      { request: { ...request, writer: { ...request.writer, sessionId: foreign.sessionId },
        from: { ...request.from, frame: { ...request.from.frame, sessionId: foreign.sessionId } } },
      code: 'native_continuation_v2_identity' },
      { request: { ...request, transitionId: randomUUID() }, code: 'native_writer_lost' },
    ]
    for (const attempt of attempts) {
      await expect(n.continuation.transition(attempt.request)).rejects.toMatchObject({ code: attempt.code })
      expect(await retainedReplayState(f)).toEqual(before)
    }
    expect(await n.continuation.transition(request))
      .toEqual({ receipt: original.receipt, replayed: true, current: { kind: 'expired' } })
    expect(await retainedReplayState(f)).toEqual(before)
  }))

test('actual frame provider final tuple expiry retains the original v2 receipt with no bearer or writes',
  () => continuationCase(async (f, n) => {
    const request = await n.close(), original = await n.continuation.transition(request)
    expect(original.receipt.result.kind).toBe('prepared')
    expect(original.current.kind).toBe('live')
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '3 seconds' WHERE id=$1", [n.a.sessionId])
    const before = await retainedReplayState(f)
    let delayed = 0, observed: string | undefined
    const verifier: NativeInputFrameVerifier = async (client, input) => {
      const descriptor = Object.getOwnPropertyDescriptor(client, 'query'), query = client.query.bind(client)
      Object.defineProperty(client, 'query', { configurable: true,
        value: async (sql: string, values?: unknown[]) => {
          if (sql.includes('s.lease_epoch=$3 AND s.grant_digest=$4')
            && sql.includes('AND w.worker_id=$5 AND w.epoch=$6')) {
            delayed++
            // Delay only the real provider's final SQL; its actual PG clock and tuple produce the error.
            await query('SELECT pg_sleep(3.5)')
          }
          return query<Record<string, unknown>>(sql, values)
        } })
      try { return await n.frames.verifyInTransaction(client, input) }
      catch (error) {
        if (error instanceof PlatformError) observed = error.code
        throw error
      } finally {
        if (descriptor) Object.defineProperty(client, 'query', descriptor)
        else Reflect.deleteProperty(client, 'query')
      }
    }
    const continuation = new NativeTurnContinuationV2(n.tasks, n.writers, verifier, limits)
    const replay = await continuation.transition(request)
    expect(delayed).toBe(1)
    expect(observed).toBe('native_execution_frame_lease_lost')
    expect(replay).toEqual({ receipt: original.receipt, replayed: true, current: { kind: 'expired' } })
    expect(await retainedReplayState(f)).toEqual(before)
    for (const secret of [request.candidateToken, request.writer.token, request.from.operationToken]) {
      expect(JSON.stringify(replay)).not.toContain(secret)
    }
  }))

test.each(['audit', 'seal', 'cohort'] as const)('missing or changed %s proof refuses the entire transition without settling A', what => continuationCase(async (f, n) => {
  if (what === 'cohort') {
    await n.claim(true)
    await n.publish([n.native.append('step/start', { turn: 1, step: 1 }), n.native.append('step/end', { turn: 1, step: 1 })])
  }
  const request = what === 'cohort' ? await n.finish() : await n.close()
  if (what === 'audit') await f.pool.query('UPDATE pe_operations SET input=\'changed durable acceptance\' WHERE id=$1', [first(n.inputs.slice(3)).operationId])
  if (what === 'seal') request.seal.revision += 1
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ status: 409 })
  expect(await state(f)).toEqual(before)
}))

test('a late PG receipt failure rolls back settlement, successor frame and attempt, and publisher seal together', () => continuationCase(async (f, n) => {
  const request = await n.close()
  await f.pool.query(`CREATE FUNCTION fail_owned_v2_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'owned receipt failure'; END $$;
    CREATE TRIGGER owned_v2_failure BEFORE INSERT ON pe_native_turn_transitions_v2 FOR EACH ROW EXECUTE FUNCTION fail_owned_v2_receipt()`)
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toThrow('owned receipt failure')
  expect(await state(f)).toEqual(before)
}))

test('a prepared source cannot invent consumption or settlement from a turn coordinate', () => continuationCase(async (f, n) => {
  const source = await f.pool.query<{ frame: unknown }>(`SELECT frame_json AS frame FROM pe_native_turn_frames
    WHERE operation_id=$1 AND operation_epoch=$2 AND session_id=$3 AND writer_epoch=$4`,
  [n.a.operationId, n.a.epoch, n.a.sessionId, n.writer.epoch])
  expect(source.rowCount).toBe(1)
  expect(nativeExecutionFrame.parse(first(source.rows).frame).phase).toBe('prepared')
  const request = { version: 2, kind: 'advance', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: n.history.length, expectedQueueRevision: n.history.at(-1)?.seq, expectedNext: null,
    from: { frame: { sessionId: n.a.sessionId, operationId: n.a.operationId, operationEpoch: n.a.epoch,
      writerEpoch: n.writer.epoch, frozenSnapshotDigest: n.frame.frozenSnapshotDigest }, operationToken: n.a.token,
    turn: 1, turnStartSeq: 0, turnEndSeq: 1, cohortIds: [randomUUID()], claimedOriginInputIds: [first(n.inputs).originInputId] },
    seal: { publisherId: n.publisherId, lastOrdinal: 0, revision: 0, eventCount: n.history.length } }
  const before = await state(f)
  // Historical consumed-frame identity is checked before the later unclaimed-frame refusal.
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_continuation_v2_identity' })
  expect(await state(f)).toEqual(before)
}))

test('all later current-frame cohorts are proved and settled while a next-turn origin stays pending', () => continuationCase(async (f, n) => {
  await n.claim(true); await n.step(1)
  const id = requestId.parse(randomUUID())
  await n.tasks.accept(f.alice.user, n.a.sessionId, id, 'E later next-step', f.alice.token)
  const e = await n.add(id); await n.admit(e, 'next-step'); await n.claim(false); await n.step(2)
  const request = await n.finish(), result = await n.continuation.transition(request)
  expect(result.receipt.settled.map(item => item.operationId)).toEqual([
    first(n.inputs.slice(1)).operationId, first(n.inputs.slice(2)).operationId, n.a.operationId, e.operationId,
  ])
  expect(result.receipt.result.kind).toBe('prepared')
  if (result.receipt.result.kind === 'prepared') expect(result.receipt.result.frame.operationId).toBe(first(n.inputs.slice(3)).operationId)
}))

test('capacity parking settles consumed origins but preserves the unconsumed D operation and native input', () => continuationCase(async (f, n) => {
  const request = await n.close(), d = first(n.inputs.slice(3))
  const other = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await n.tasks.accept(f.alice.user, other.sessionId, requestId.parse(randomUUID()), 'another active Session', f.alice.token)
  if (!await n.tasks.claim(randomUUID())) throw new Error('Actual competing Session was not claimed')
  const before = (await f.pool.query('SELECT * FROM pe_operations WHERE id=$1', [d.operationId])).rows
  const continuation = new NativeTurnContinuationV2(n.tasks, n.writers, n.verifier, { ...limits, maxActivePerUser: 1 })
  const result = await continuation.transition(request)
  expect(result.receipt.result).toEqual({ kind: 'parked', reason: 'capacity' })
  expect((await f.pool.query('SELECT * FROM pe_operations WHERE id=$1', [d.operationId])).rows).toEqual(before)
  expect(foldInputHistory(n.native.header, n.history).inbox['next-turn']).toEqual([d.message])
}))

test('the original PG lease expiring after successor issuance rolls back the complete transfer', () => continuationCase(async (f, n) => {
  const request = await n.close()
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()+interval \'2 seconds\' WHERE id=$1', [n.a.sessionId])
  await f.pool.query(`CREATE FUNCTION delay_owned_v2_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$;
    CREATE TRIGGER owned_v2_delay BEFORE INSERT ON pe_native_turn_transitions_v2 FOR EACH ROW EXECUTE FUNCTION delay_owned_v2_receipt()`)
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_continuation_v2_expired' })
  expect(await state(f)).toEqual(before)
}))

test('A retains its actual Root-frozen Session attachment permissions while D is issued from its own immutable audit', () => cloudFixture(async (f) => {
  await schema(f)
  const n = await prepare(f, true, true), request = await n.close(), d = first(n.inputs.slice(3))
  const original = first((await f.pool.query<{ grant: { attachments: unknown[] } }>(
    'SELECT grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1', [n.a.operationId])).rows).grant
  expect(original.attachments).toHaveLength(2)
  expect((await n.acceptedOrigin(first(n.inputs).message.id)).acceptedAudit.attachments).toEqual([])
  const result = await n.continuation.transition(request)
  expect(result.receipt.result.kind).toBe('prepared')
  if (result.receipt.result.kind === 'prepared') {
    expect(result.receipt.result.grant.attachments).toEqual((await n.acceptedOrigin(d.message.id)).acceptedAudit.attachments)
  }
  expect(first((await f.pool.query<{ grant: unknown }>(
    'SELECT grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1', [n.a.operationId])).rows).grant).toEqual(original)
}))

test.each([true, false])('an empty continuing cohort is retained before a step or blocked assembly (step=%s)', withStep => continuationCase(async (f, n) => {
  await n.claim(true); await n.step(1); await n.claim(false, true)
  if (withStep) await n.step(2)
  const request = await n.finish(withStep), result = await n.continuation.transition(request)
  const cohorts = (await f.pool.query<{ claim_count: number; step_start_seq: number | null }>(
    'SELECT claim_count,step_start_seq FROM pe_native_input_cohorts ORDER BY boundary_ordinal')).rows
  expect(cohorts).toHaveLength(2)
  expect(cohorts[1]).toMatchObject({ claim_count: 0 })
  expect(cohorts[1]?.step_start_seq === null).toBe(!withStep)
  expect(result.receipt.from.cohortIds).toEqual(request.from.cohortIds)
  expect(result.receipt.settled.map(item => item.operationId)).toEqual([
    first(n.inputs.slice(1)).operationId, first(n.inputs.slice(2)).operationId, n.a.operationId,
  ])
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows).count).toBe(2)
}))

test('Writer expiry in the final awaited assertion refuses the joint transfer and rolls everything back', () => continuationCase(async (f, n) => {
  const request = await n.close()
  class ExpiringWriter extends NativeSessionWriter {
    checks = 0
    override async assertLiveInTransaction(client: PoolClient, identity: NativeWriterIdentity): Promise<void> {
      await super.assertLiveInTransaction(client, identity)
      if (++this.checks === 1) {
        await client.query('UPDATE pe_native_writers SET expires_at=clock_timestamp()+interval \'50 milliseconds\' WHERE session_id=$1', [identity.sessionId])
        await client.query('SELECT pg_sleep(0.1)')
      }
    }
  }
  const writers = new ExpiringWriter(n.tasks, { leaseMs: 60_000 })
  const continuation = new NativeTurnContinuationV2(n.tasks, writers, n.verifier, limits), before = await state(f)
  await expect(continuation.transition(request)).rejects.toMatchObject({ code: 'native_continuation_v2_expired' })
  expect(await state(f)).toEqual(before)
}))

test('successor expiry during the last replay assertion returns the historical receipt without a bearer', () => continuationCase(async (_f, n) => {
  const request = await n.close(), original = await n.continuation.transition(request)
  class ExpiringSuccessor extends NativeSessionWriter {
    override async assertLiveInTransaction(client: PoolClient, identity: NativeWriterIdentity): Promise<void> {
      await super.assertLiveInTransaction(client, identity)
      await client.query('UPDATE pe_sessions SET lease_until=clock_timestamp()+interval \'50 milliseconds\' WHERE id=$1', [identity.sessionId])
      await client.query('SELECT pg_sleep(0.1)')
    }
  }
  const writers = new ExpiringSuccessor(n.tasks, { leaseMs: 60_000 })
  const continuation = new NativeTurnContinuationV2(n.tasks, writers, n.verifier, limits)
  const retry = await continuation.transition(request)
  expect(retry.receipt).toEqual(original.receipt)
  expect(retry.current).toEqual({ kind: 'expired' })
  expect(JSON.stringify(retry)).not.toContain(request.candidateToken)
}))

test('prepared recovery retains the full ordered Session attachments beyond its original accepted audit', () => cloudFixture(async (f) => {
  await schema(f)
  const n = await prepare(f, false, false, false, true)
  const previous = first((await f.pool.query<{ frame: unknown; grant: unknown }>(
    'SELECT frame_json AS frame,grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [n.a.operationId, n.a.epoch])).rows)
  const original = nativeContinuationSavedGrantV2.parse(previous.grant)
  const audit = (await n.acceptedOrigin(first(n.inputs).message.id)).acceptedAudit
  const historical = (await n.acceptedOrigin(first(n.inputs.slice(1)).message.id)).acceptedAudit
  expect(audit.attachments).toHaveLength(1)
  expect(historical.attachments).toHaveLength(2)
  expect(original.attachments).toHaveLength(3)
  expect(original.attachments.filter(file => audit.attachments.some(item => item.attachmentId === file.attachmentId)))
    .toEqual(audit.attachments)
  expect(original.attachments).toEqual([...audit.attachments, ...historical.attachments].sort((a, b) =>
    a.attachmentId.localeCompare(b.attachmentId) || a.name.localeCompare(b.name)))
  await n.writers.release(n.writer)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 millisecond\' WHERE id=$1', [n.a.sessionId])
  const tasks = new TaskStore(f.pool, taskLimits, undefined,
    (client, id, fallback) => n.frames.selectClaimInTransaction(client, id, fallback))
  const workerId = nativeWriterWorkerId.parse(randomUUID()), next = await tasks.claim(workerId)
  if (!next) throw new Error('Original prepared A did not receive an actual recovery attempt')
  expect(next.operationId).toBe(n.a.operationId)
  expect(next.epoch).toBe(n.a.epoch + 1)
  const acquire = { sessionId: next.sessionId, workerId, token: token() }
  const lease = await n.writers.acquire(next.token, acquire)
  const writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
  const recovered = await transaction(f.pool, client => n.frames.recoverPreparedInTransaction(client,
    { operationToken: next.token, writer }))
  expect(recovered.kind).toBe('prepared')
  if (recovered.kind !== 'prepared') throw new Error('Expected the original admitted prepared frame')
  const { token: restoredToken, ...restored } = recovered.grant
  expect(restoredToken).toBe(next.token)
  expect(restoredToken).not.toBe(n.a.token)
  expect(restored).toEqual({ ...original, epoch: next.epoch })
  expect(recovered.frame).toMatchObject({ operationId: n.a.operationId, operationEpoch: next.epoch,
    writerEpoch: writer.epoch, candidateOriginInputId: n.frame.candidateOriginInputId, phase: 'prepared' })
  expect(first((await f.pool.query<{ frame: unknown; grant: unknown }>(
    'SELECT frame_json AS frame,grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [n.a.operationId, n.a.epoch])).rows)).toEqual(previous)
  expect(first((await f.pool.query<{ grant: unknown }>(
    'SELECT grant_json AS grant FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [n.a.operationId, next.epoch])).rows).grant).toEqual(restored)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_input_claims')).rows).count).toBe(0)
}))

test('a retained successor receipt cannot restore a missing accepted skill field from a schema default', () => cloudFixture(async (f) => {
  await schema(f)
  const n = await prepare(f, true, false, true), request = await n.close(), result = await n.continuation.transition(request)
  expect(result.receipt.result.kind).toBe('prepared')
  if (result.receipt.result.kind !== 'prepared') throw new Error('Expected an actual successor receipt')
  expect(result.receipt.result.grant.selection[0]?.kind).toBe('text')
  await f.pool.query(`UPDATE pe_native_turn_transitions_v2
    SET receipt_json=receipt_json #- '{result,grant,selection,0,kind}'::text[]`)
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_continuation_v2_corrupt' })
  expect(await state(f)).toEqual(before)
}))


test('the original v2 journal commits only its tokenless ACK atomically and recomputes live authority before resolved cold reads', () => continuationCase(async (f, n) => {
  const intent = await n.close()
  const bridge = new NativeInputCommit(n.tasks, n.ledger, n.frames, n.publisher, n.writers,
    { input: ledgerLimits, presentation: assistantLimits })
  const fresh = retainedTestStore({ ...n, bridge }, { input: ledgerLimits, presentation: assistantLimits }, n.continuation)
  const before = await retainedNativeFacts(f.pool)
  const prepared = await fresh().prepare(n.a.token, { version: 1, workerId: n.writer.workerId,
    mutation: { family: 'turn-transition', request: intent } })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  const execute = { version: 1 as const, workerId: n.writer.workerId, intentId: prepared.intentId }
  await f.pool.query(`CREATE FUNCTION pe_test_v2_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state='committed' THEN RAISE EXCEPTION 'actual v2 ACK failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER pe_test_v2_ack_failure BEFORE UPDATE ON pe_native_retained_intents
      FOR EACH ROW EXECUTE FUNCTION pe_test_v2_ack_failure()`)
  await expect(fresh().execute(n.a.token, execute)).rejects.toMatchObject({ message: 'actual v2 ACK failure' })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  expect((await f.pool.query('SELECT state,receipt_json FROM pe_native_retained_intents')).rows).toEqual([{ state: 'prepared', receipt_json: null }])
  await f.pool.query('DROP TRIGGER pe_test_v2_ack_failure ON pe_native_retained_intents; DROP FUNCTION pe_test_v2_ack_failure()')
  const result = await fresh().execute(n.a.token, execute)
  if (result.family !== 'turn-transition' || result.result.current.kind !== 'live') throw new Error('Expected the actual original successor live proof')
  const successorToken = result.result.current.grant.token
  const receipt = { family: 'turn-transition' as const, result: result.result.receipt }
  expect((await f.pool.query<{ receipt: unknown }>('SELECT receipt_json AS receipt FROM pe_native_retained_intents')).rows[0]?.receipt).toEqual(receipt)
  expect(JSON.stringify(receipt)).not.toContain(intent.candidateToken)
  expect(JSON.stringify(receipt)).not.toContain(n.a.token)
  expect(JSON.stringify(receipt)).not.toContain(n.writer.token)
  const committed = await retainedNativeFacts(f.pool)
  expect(await fresh().execute(n.a.token, execute)).toEqual({ family: 'turn-transition', result: { ...result.result, replayed: true } })
  expect(await retainedNativeFacts(f.pool)).toEqual(committed)
  expect((await f.pool.query('SELECT state FROM pe_operations WHERE id=$1', [n.a.operationId])).rows)
    .toEqual([{ state: 'completed' }])
  const newWorker = randomUUID(), cold = { version: 1 as const, workerId: newWorker, limit: 8 }
  const resolve = { ...execute, workerId: newWorker, receiptDigest: nativeInputRecordDigest(receipt) }
  expect(newWorker).not.toBe(n.writer.workerId)
  expect((await fresh().reconcile(cold)).items[0]?.outcome).toEqual({ state: 'committed', receipt, retired: false })
  const sealed = first((await f.pool.query<{ sealed: Buffer }>('SELECT request_sealed AS sealed FROM pe_native_retained_intents')).rows).sealed
  await expect(fresh().resolve(resolve)).rejects.toMatchObject({ status: 409, code: 'native_intent_not_retired' })
  expect(first((await f.pool.query<{ sealed: Buffer }>('SELECT request_sealed AS sealed FROM pe_native_retained_intents')).rows).sealed)
    .toEqual(sealed)
  expect(await retainedNativeFacts(f.pool)).toEqual(committed)
  await n.writers.release(n.writer)
  const retired = await retainedNativeFacts(f.pool)
  expect((await fresh().reconcile(cold)).items[0]?.outcome).toEqual({ state: 'committed', receipt, retired: true })
  expect(await fresh().resolve(resolve)).toMatchObject({ intentId: prepared.intentId, resolved: true })
  expect(first((await f.pool.query<{ sealed: Buffer | null; receipt: unknown }>(
    'SELECT request_sealed AS sealed,receipt_json AS receipt FROM pe_native_retained_intents')).rows))
    .toEqual({ sealed: null, receipt })
  expect(await fresh().execute(n.a.token, execute)).toEqual({ family: 'turn-transition',
    result: { receipt: result.result.receipt, replayed: true, current: { kind: 'expired' } } })
  await transaction(f.pool, client => n.tasks.authorized(client, successorToken))
  expect(await retainedNativeFacts(f.pool)).toEqual(retired)
}))
