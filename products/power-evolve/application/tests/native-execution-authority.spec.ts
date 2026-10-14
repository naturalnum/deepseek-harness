/** Actual PG business execution through the Root v2 reader and permanent native ledger cohorts. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { operationId, requestId } from '../src/contracts.ts'
import { admittedInputMessage, inputCohortId, nativeInputAdmissionCommand, nativeInputClaimCommand,
  nativeInputStepCommand, originInputId, type NativeInputLedgerLimits } from '../src/native-input-ledger-contracts.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { foldInputHistory, readInputOrigin } from '../src/native-input-ledger-records.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeExecutionAuthority, type NativeExecutionFrameReader } from '../src/platform/native-execution-authority.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
import { SkillService } from '../src/platform/skills.ts'
import { readNativeRuntimePolicy } from '../src/platform/native-runtime-policy.ts'
import { NativeSubagents } from '../src/platform/native-subagents.ts'
import { cleanupNativeRuntime } from '../src/platform/native-runtime-cleanup.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const ledgerLimits: NativeInputLedgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
  maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const executionLimits = { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2_097_152 }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned execution fixture returned no row')
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
      throw new Error('Private execution DDL requires an empty schema4 extension and both complete files')
    }
    await f.pool.query(await readFile(frames, 'utf8'))
    await f.pool.query(await readFile(ledger, 'utf8'))
    const installed = await inspect()
    if (tables.filter(name => name !== 'pe_native_turn_transitions_v2').some(name => !installed.find(row => row.name === name)?.present)) {
      throw new Error('Private execution DDL did not install every required table')
    }
  } else if (first(versions).version !== CURRENT_SCHEMA_VERSION || tables.some(name => !present.find(row => row.name === name)?.present)
    || present.find(row => row.name === 'pe_native_turn_transitions')?.present) {
    throw new Error(`Execution tests require complete formal cloud-native schema${CURRENT_SCHEMA_VERSION}`)
  }
}

async function prepare(f: Fixture, deferredQueuedAdmission = false) {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const requests = [requestId.parse(randomUUID()), requestId.parse(randomUUID()), requestId.parse(randomUUID())]
  await tasks.accept(f.alice.user, created.sessionId, first(requests), 'A original owner', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), a = await tasks.claim(workerId)
  if (!a) throw new Error('Actual bootstrap operation was not claimed')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(a.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: a.token }
  const events = new EventStore(tasks, { maxEventBytes: taskLimits.maxEventBytes, ...historyLimits })
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits,
    (client, command) => frames.verifyInTransaction(client, command))
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const inputs: {
    message: ReturnType<typeof admittedInputMessage.parse>
    operationId: ReturnType<typeof operationId.parse>
    originInputId: ReturnType<typeof originInputId.parse>
  }[] = []
  for (const [index, id] of requests.entries()) {
    if (index !== 0) {
      if (deferredQueuedAdmission && index === 2) {
        const skills = new SkillService(f.pool, `${f.root}/claim-selection-skills`), skillId = randomUUID()
        await skills.init()
        await skills.install(f.alice.user, skillId, 'C accepted skill', 'Actual C selection', 'C original instructions')
        await skills.toggle(f.alice.user, skillId, true)
        await f.pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,1000,true)',
          [f.alice.user.userId, 'C original model'])
        await f.pool.query('UPDATE pe_users SET settings=jsonb_set(settings,\'{model}\',to_jsonb(\'C original model\'::text)) WHERE id=$1',
          [f.alice.user.userId])
        await tasks.accept(f.alice.user, created.sessionId, id, 'C queued input', f.alice.token)
        await skills.toggle(f.alice.user, skillId, false)
        await f.pool.query('UPDATE pe_users SET settings=jsonb_set(settings,\'{model}\',to_jsonb(\'changed after C acceptance\'::text)) WHERE id=$1',
          [f.alice.user.userId])
      } else await tasks.accept(f.alice.user, created.sessionId, id, `${index === 1 ? 'B' : 'C'} queued input`, f.alice.token)
    }
    const operation = first((await f.pool.query<{ id: string }>('SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows)
    const content = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, id])).rows).admitted
    inputs.push({ operationId: operationId.parse(operation.id), originInputId: originInputId.parse(randomUUID()),
      message: admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId: id }, content }) })
  }
  const admit = async (item: typeof inputs[number], target: 'next-step' | 'next-turn', storageAuthority = authority) => {
    const expectedEventCount = history.length, start = foldInputHistory(header, history).inbox[target].length
    const event = native.append('agent/inbox/spliced', { target, start, inserted: [item.message] })
    history.push(event)
    const command = nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: a.sessionId,
      originInputId: item.originInputId, originOperationId: item.operationId, messageId: item.message.id, target })
    await ledger.admit(f.alice.token, { command, authority: storageAuthority, expectedEventCount, events: [event] })
  }
  if (!deferredQueuedAdmission) {
    await admit(first(inputs.slice(1)), 'next-step'); await admit(first(inputs.slice(2)), 'next-step')
  }
  await admit(first(inputs), 'next-turn')
  const frame = await transaction(f.pool, client => frames.prepareInTransaction(client, authority, first(inputs).originInputId))
  const frameReader: NativeExecutionFrameReader = (client, session, token) => frames.readExecutionInTransaction(client, session, token)
  const executionAuthority = new NativeExecutionAuthority(frameReader, executionLimits)
  const executionTasks = new TaskStore(f.pool, taskLimits,
    (client, session, token) => executionAuthority.assertExecutionInTransaction(client, session, token))
  return { tasks, executionTasks, executionAuthority, frameReader, writers, authority, writer, a, events, frames, ledger,
    native, history, inputs, frame, admit }
}

async function executionCase(run: (f: Fixture, n: Prepared) => Promise<void>, deferredQueuedAdmission = false): Promise<void> {
  await cloudFixture(async (f) => { await schema(f); await run(f, await prepare(f, deferredQueuedAdmission)) })
}

async function claim(n: Prepared) {
  const expectedEventCount = n.history.length, nextStep = foldInputHistory(n.native.header, n.history).inbox['next-step']
  const events = [n.native.append('turn/start', { turn: 1 }),
    ...(nextStep.length ? [n.native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: nextStep.length, inserted: [] })] : []),
    n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  n.history.push(...events)
  const command = nativeInputClaimCommand.parse({ rpcNonce: 'actual-complete-cohort', cohortId: inputCohortId.parse(randomUUID()),
    boundaryKind: 'initial-turn-step', frame: { sessionId: n.a.sessionId, operationId: n.a.operationId, operationEpoch: n.a.epoch,
      writerEpoch: n.writer.epoch, frozenSnapshotDigest: n.frame.frozenSnapshotDigest } })
  await n.ledger.claim({ command, authority: n.authority, expectedEventCount, events })
  return command
}

async function openStep(f: Fixture, n: Prepared) {
  const cohort = await claim(n), event = n.native.append('step/start', { turn: 1, step: 1 })
  n.history.push(event)
  await transaction(f.pool, async (client) => {
    const session = await n.tasks.authorized(client, n.a.token)
    await n.events.appendInTransaction(client, session, [event])
    await n.ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: cohort.cohortId,
      frame: cohort.frame, stepStartSeq: event.seq }), n.authority)
  })
  return { cohort, event }
}

async function execute(f: Fixture, n: Prepared): Promise<void> {
  await transaction(f.pool, async (client) => { await n.executionTasks.executionAuthorized(client, n.a.token) })
}

test('a real full B,C,A cohort bound to the actual current step authorizes only the original A operation', () => executionCase(async (f, n) => {
  await openStep(f, n)
  await execute(f, n)
  const operations = (await f.pool.query<{ id: string; state: string }>('SELECT id,state FROM pe_operations')).rows
  for (const item of n.inputs) expect(operations.find(row => row.id === item.operationId)?.state).toBe(item.operationId === n.a.operationId ? 'running' : 'queued')
  expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_attempts')).rows).count).toBe('1')
}))

test('persisted native archive fences business while retaining native ownership and exact acceptance replay',
  () => executionCase(async (f, n) => {
    await n.tasks.accept(f.alice.user, n.a.sessionId, requestId.parse(randomUUID()), 'pending archive admission', f.alice.token)
    await openStep(f, n)
    await execute(f, n)
    const owner = first(n.inputs)
    const pending = first((await transaction(f.pool,
      client => n.ledger.readAcceptedPendingInTransaction(client, n.authority, 16))).items)
    if (owner.message.source.kind !== 'user') throw new Error('Archive fixture owner did not retain its original user request')
    const originalRequest = requestId.parse(owner.message.source.rpcId)
    const accepted = await n.tasks.accept(f.alice.user, n.a.sessionId, originalRequest, 'A original owner', f.alice.token)
    const newRequest = requestId.parse(randomUUID())
    const detached = Session.forPlanning(n.native.id, n.history, n.native.header, n.native.inheritedEventCount)
    const admissionEvent = detached.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [pending.message] })
    const admission = { authority: n.authority, expectedEventCount: n.history.length, events: [admissionEvent],
      command: nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: n.a.sessionId,
        originInputId: originInputId.parse(pending.originOperationId), originOperationId: pending.originOperationId,
        messageId: pending.message.id, target: 'next-turn' }) }
    const facts = async () => ({
      operations: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_operations ORDER BY id')).rows,
      attempts: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_attempts ORDER BY operation_id,epoch')).rows,
      events: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_events ORDER BY session_id,seq')).rows,
      origins: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_origins ORDER BY origin_input_id')).rows,
      revisions: (await f.pool.query<Record<string, unknown>>(
        'SELECT * FROM pe_native_input_revisions ORDER BY origin_input_id,input_revision')).rows,
      claims: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_claims ORDER BY origin_input_id')).rows,
      cohorts: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_cohorts ORDER BY cohort_id')).rows,
      frames: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_turn_frames ORDER BY operation_id,operation_epoch')).rows,
      commands: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_commands ORDER BY command_id')).rows,
    })
    // This owned persisted layout tests the gate; the public archive stop flow remains unavailable.
    const archive = async (archived: boolean) => transaction(f.pool, async (client) => {
      const actor = await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
      expect((await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [n.a.sessionId, actor.userId])).rowCount).toBe(1)
      const workspaces = (await client.query<LayoutWorkspace>(
        'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [actor.userId])).rows
      const layout = await readWorkspaceLayout(client, actor.userId, workspaces)
      layout.archivedSessionIds = archived ? [n.a.sessionId] : []
      await writeWorkspaceLayout(client, actor.userId, layout)
      expect((await readWorkspaceLayout(client, actor.userId, workspaces)).archivedSessionIds)
        .toEqual(archived ? [n.a.sessionId] : [])
    })
    const before = await facts()
    await archive(true)
    await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_session_archived' })
    await expect(n.tasks.accept(f.alice.user, n.a.sessionId, newRequest, 'after archive', f.alice.token))
      .rejects.toMatchObject({ status: 409, code: 'native_session_archived' })
    await expect(n.ledger.admit(f.alice.token, admission)).rejects.toMatchObject({ status: 409, code: 'native_session_archived' })
    expect(await n.tasks.accept(f.alice.user, n.a.sessionId, originalRequest, 'A original owner', f.alice.token)).toEqual(accepted)
    const storage = await transaction(f.pool, client => n.tasks.authorized(client, n.a.token))
    expect(storage).toMatchObject({ id: n.a.sessionId, operation_id: n.a.operationId, lease_epoch: n.a.epoch })
    expect(await facts()).toEqual(before)
    await n.writers.release(n.writer)
    await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 millisecond\' WHERE id=$1', [n.a.sessionId])
    const beforeClaim = await facts(), workerId = nativeWriterWorkerId.parse(randomUUID())
    expect(await n.tasks.claim(workerId)).toBeNull()
    expect(await facts()).toEqual(beforeClaim)
    await archive(false)
    const current = await n.tasks.claim(workerId)
    if (!current) throw new Error('Unarchived Session did not receive its actual ordinary attempt')
    expect(current).toMatchObject({ sessionId: n.a.sessionId, operationId: n.a.operationId, epoch: n.a.epoch + 1 })
    expect(await n.tasks.accept(f.alice.user, n.a.sessionId, newRequest, 'after archive', f.alice.token))
      .toMatchObject({ accepted: true, state: 'queued' })
    const restored = await facts()
    expect(restored.claims).toEqual(before.claims)
    expect(restored.frames).toEqual(before.frames)
    expect(restored.events).toEqual(before.events)
    expect(restored.attempts).toHaveLength(beforeClaim.attempts.length + 1)
  }))

test('prepared original capabilities alone refuse execution', () => executionCase(async (f, n) => {
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_execution_frame_not_claimed' })
}))

test('permanent claim consumption without any step remains ineligible for execution', () => executionCase(async (f, n) => {
  await claim(n)
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_execution_step_unclaimed' })
  expect(first((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_input_claims')).rows).count).toBe('3')
}))

test('native claim selection retains an unsettled consumed owner and prepared recovery refuses replay', () => executionCase(async (f, n) => {
  await claim(n)
  const b = first(n.inputs.slice(1)), c = first(n.inputs.slice(2))
  await n.admit(b, 'next-step'); await n.admit(c, 'next-turn')
  const before = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_turn_frames ORDER BY operation_id,operation_epoch')).rows
  await n.writers.release(n.writer)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 millisecond\' WHERE id=$1', [n.a.sessionId])
  const tasks = new TaskStore(f.pool, taskLimits, undefined,
    (client, session, fallback) => n.frames.selectClaimInTransaction(client, session, fallback))
  const workerId = nativeWriterWorkerId.parse(randomUUID()), current = await tasks.claim(workerId)
  if (!current) throw new Error('Consumed current A did not receive its actual reconciliation attempt')
  expect(current.operationId).toBe(n.a.operationId)
  expect(current.epoch).toBe(n.a.epoch + 1)
  const acquire = { sessionId: current.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const lease = await n.writers.acquire(current.token, acquire)
  const writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
  await expect(transaction(f.pool, client => n.frames.recoverPreparedInTransaction(client,
    { writer, operationToken: current.token }))).rejects.toMatchObject({ status: 409, code: 'native_input_recovery_required' })
  const historical = await transaction(f.pool, client => n.frames.readConsumedInTransaction(client,
    { writer, operationToken: current.token }))
  const original = first(before)
  expect(historical.operationFrame).toEqual(original.frame_json)
  expect(historical.operationFrame).toMatchObject({ phase: 'claimed', operationId: n.a.operationId,
    operationEpoch: n.a.epoch, writerEpoch: n.writer.epoch })
  expect(historical.frame.frozenSnapshot).toEqual(original.grant_json)
  expect(historical.operationDigest).toBe(original.grant_digest)
  expect(historical.workerId).toBe(n.writer.workerId)
  const { token: storageToken, ...storage } = historical.storageGrant
  expect(storageToken).toBe(current.token)
  expect(storageToken).not.toBe(n.a.token)
  expect(storage).toEqual({ ...historical.frame.frozenSnapshot, epoch: current.epoch })
  await expect(transaction(f.pool, client => n.executionTasks.executionAuthorized(client, storageToken)))
    .rejects.toMatchObject({ status: 409, code: 'native_execution_frame_missing' })
  expect((await f.pool.query('SELECT * FROM pe_native_turn_frames ORDER BY operation_id,operation_epoch')).rows).toEqual(before)
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_input_claims')).rows).count).toBe(1)
  expect(first((await f.pool.query<{ state: string; attempts: number }>(
    'SELECT state,attempts FROM pe_operations WHERE id=$1', [c.operationId])).rows)).toEqual({ state: 'queued', attempts: 0 })
  expect(first((await f.pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pe_attempts WHERE operation_id=$1', [n.a.operationId])).rows).count).toBe(2)
}, true))

test('native next-turn C claim across an empty interrupted tail preserves metadata and never authorizes an older running prepared B', () => executionCase(async (f, n) => {
  await claim(n)
  const end = n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  n.history.push(end)
  await n.events.append(n.a.token, [end])
  await n.tasks.finish(n.a.token, 'completed', null)
  await n.writers.release(n.writer)
  const b = first(n.inputs.slice(1)), c = first(n.inputs.slice(2))
  const bWorker = nativeWriterWorkerId.parse(randomUUID()), bGrant = await n.tasks.claim(bWorker)
  if (!bGrant) throw new Error('Actual FIFO claim did not issue original B after settled A')
  expect(bGrant.operationId).toBe(b.operationId)
  const bAcquire = { sessionId: bGrant.sessionId, workerId: bWorker, token: randomBytes(32).toString('base64url') }
  const bLease = await n.writers.acquire(bGrant.token, bAcquire)
  const bWriter = nativeWriterIdentity.parse({ ...bAcquire, epoch: bLease.epoch })
  const bAuthority = { writer: bWriter, operationToken: bGrant.token }
  await n.admit(b, 'next-step', bAuthority); await n.admit(c, 'next-turn', bAuthority)
  const bFrame = await transaction(f.pool, client => n.frames.prepareInTransaction(client, bAuthority, b.originInputId))
  const bStored = first((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [b.operationId, bGrant.epoch])).rows)
  const origin = async (id: typeof c.originInputId) => readInputOrigin(first((await f.pool.query<Record<string, unknown>>(`SELECT
    origin_input_id AS "originInputId",session_id AS "sessionId",origin_operation_id AS "originOperationId",original_request_id AS "originalRequestId",
    message_id AS "messageId",accepted_snapshot_digest AS "acceptedSnapshotDigest",accepted_audit_json AS "acceptedAudit"
    FROM pe_native_input_origins WHERE origin_input_id=$1`, [id])).rows))
  const bOrigin = await origin(b.originInputId), cOrigin = await origin(c.originInputId)
  expect(cOrigin.acceptedAudit.settings.model).toBe('C original model')
  expect(cOrigin.acceptedAudit.selection).toHaveLength(1)
  const interruptedStart = n.native.append('turn/start', { turn: 2 })
  n.history.push(interruptedStart)
  await n.events.append(bGrant.token, [interruptedStart])
  await n.writers.release(bWriter)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 millisecond\' WHERE id=$1', [bGrant.sessionId])
  const tasks = new TaskStore(f.pool, taskLimits, undefined,
    (client, session, fallback) => n.frames.selectClaimInTransaction(client, session, fallback))
  const cWorker = nativeWriterWorkerId.parse(randomUUID()), selected = await tasks.claim(cWorker)
  if (!selected) throw new Error('Actual native selection did not issue original next-turn C')
  expect(selected.operationId).toBe(c.operationId)
  expect(selected.epoch).toBe(bGrant.epoch + 1)
  expect(selected).toMatchObject({ requestId: cOrigin.originalRequestId, text: cOrigin.acceptedAudit.text,
    settings: cOrigin.acceptedAudit.settings, selection: cOrigin.acceptedAudit.selection,
    mcpConnections: cOrigin.acceptedAudit.mcpConnections, remoteMcpTools: cOrigin.acceptedAudit.remoteMcpTools,
    stdioV2Connections: cOrigin.acceptedAudit.stdioV2Connections, stdioMcpConnections: cOrigin.acceptedAudit.stdioMcpConnections,
    sshConnections: cOrigin.acceptedAudit.sshConnections, nativeContent: cOrigin.acceptedAudit.nativeContent })
  expect((await transaction(f.pool, client => tasks.authorized(client, selected.token))).operation_id).toBe(c.operationId)
  await expect(transaction(f.pool, client => tasks.restoreGrantInTransaction(client, b.operationId, selected.token, selected.epoch)))
    .rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  await expect(transaction(f.pool, client => tasks.authorized(client, bGrant.token))).rejects.toMatchObject({ code: 'lease_lost' })
  const cAcquire = { sessionId: selected.sessionId, workerId: cWorker, token: randomBytes(32).toString('base64url') }
  const cLease = await n.writers.acquire(selected.token, cAcquire)
  const cWriter = nativeWriterIdentity.parse({ ...cAcquire, epoch: cLease.epoch })
  const recovered = await transaction(f.pool, client => n.frames.recoverPreparedInTransaction(client,
    { writer: cWriter, operationToken: selected.token }))
  expect(recovered.kind).toBe('prepared')
  if (recovered.kind !== 'prepared') throw new Error('Expected C original pending admission to recover')
  expect(recovered.grant).toEqual(selected)
  expect(recovered.frame).toMatchObject({ operationId: c.operationId, candidateOriginInputId: c.originInputId,
    operationEpoch: selected.epoch, writerEpoch: cWriter.epoch, phase: 'prepared' })
  expect(first((await f.pool.query('SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [b.operationId, bGrant.epoch])).rows)).toEqual(bStored)
  expect(bFrame.phase).toBe('prepared')
  expect(await origin(b.originInputId)).toEqual(bOrigin)
  expect(await origin(c.originInputId)).toEqual(cOrigin)
  expect(first((await f.pool.query<{ state: string; attempts: number }>(
    'SELECT state,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows)).toEqual({ state: 'running', attempts: 1 })
  expect(first((await f.pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pe_native_input_claims WHERE origin_input_id=ANY($1::uuid[])',
    [[b.originInputId, c.originInputId]])).rows).count).toBe(0)
  expect(await tasks.cancelActive(f.alice.user, selected.sessionId, f.alice.token)).toEqual({ accepted: true })
  expect(first((await f.pool.query<{ error_code: string | null }>(
    'SELECT error_code FROM pe_operations WHERE id=$1', [c.operationId])).rows).error_code).toBe('cancel_requested')
  expect(await tasks.renew(selected.token)).toEqual({ cancelRequested: true })
  expect(first((await f.pool.query<{ state: string; attempts: number; error_code: string | null }>(
    'SELECT state,attempts,error_code FROM pe_operations WHERE id=$1', [b.operationId])).rows))
    .toEqual({ state: 'running', attempts: 1, error_code: null })
  expect(first((await f.pool.query('SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
    [b.operationId, bGrant.epoch])).rows)).toEqual(bStored)
  expect(await origin(b.originInputId)).toEqual(bOrigin)
  expect(await origin(c.originInputId)).toEqual(cOrigin)
}, true))

test('an open actual step without its cohort binding refuses execution', () => executionCase(async (f, n) => {
  await claim(n)
  const event = n.native.append('step/start', { turn: 1, step: 1 })
  await n.events.append(n.a.token, [event])
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_execution_step_unbound' })
}))

test('the original grant loses execution when its real step ends', () => executionCase(async (f, n) => {
  await openStep(f, n)
  await n.events.append(n.a.token, [n.native.append('step/end', { turn: 1, step: 1 })])
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_execution_step_unclaimed' })
}))

test.each([false, true])('a continuing current-frame cohort with new input=%s authorizes its exact second step', newInput =>
  executionCase(async (f, n) => {
    const initial = await openStep(f, n), end = n.native.append('step/end', { turn: 1, step: 1 })
    n.history.push(end)
    await n.events.append(n.a.token, [end])
    if (newInput) {
      const id = requestId.parse(randomUUID())
      await n.tasks.accept(f.alice.user, n.a.sessionId, id, 'D next-step input', f.alice.token)
      const operation = first((await f.pool.query<{ id: string }>('SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [n.a.sessionId, id])).rows)
      const content = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [n.a.sessionId, id])).rows).admitted
      const message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId: id }, content })
      const expectedEventCount = n.history.length, event = n.native.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
      n.history.push(event)
      await n.ledger.admit(f.alice.token, { command: nativeInputAdmissionCommand.parse({ rpcNonce: 'D-admission', sessionId: n.a.sessionId,
        originInputId: originInputId.parse(randomUUID()), originOperationId: operation.id, messageId: message.id, target: 'next-step' }),
      authority: n.authority, expectedEventCount, events: [event] })
    }
    const expectedEventCount = n.history.length
    const events = newInput ? [n.native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })] : []
    n.history.push(...events)
    const command = nativeInputClaimCommand.parse({ rpcNonce: 'second-cohort', cohortId: inputCohortId.parse(randomUUID()),
      frame: initial.cohort.frame, boundaryKind: 'continuing-step' })
    await n.ledger.claim({ command, authority: n.authority, expectedEventCount, events })
    const event = n.native.append('step/start', { turn: 1, step: 2 })
    n.history.push(event)
    await transaction(f.pool, async (client) => {
      const session = await n.tasks.authorized(client, n.a.token)
      await n.events.appendInTransaction(client, session, [event])
      await n.ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: command.cohortId,
        frame: command.frame, stepStartSeq: event.seq }), n.authority)
    })
    await execute(f, n)
    expect(first((await f.pool.query<{ claim_count: number; boundary_ordinal: number; owner_kind: string }>(
      'SELECT claim_count,boundary_ordinal,owner_kind FROM pe_native_input_cohorts WHERE cohort_id=$1', [command.cohortId])).rows))
      .toEqual({ claim_count: newInput ? 1 : 0, boundary_ordinal: 1, owner_kind: 'current-frame' })
  }))

test('an old consumed owner cannot authorize a later native turn and step', () => executionCase(async (f, n) => {
  await openStep(f, n)
  await n.events.append(n.a.token, [n.native.append('step/end', { turn: 1, step: 1 }),
    n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } }), n.native.append('turn/start', { turn: 2 }),
    n.native.append('step/start', { turn: 2, step: 1 })])
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_execution_step_unclaimed' })
}))

test('cancel-requested actual operation and ended actual attempt refuse execution', () => executionCase(async (f, n) => {
  await openStep(f, n)
  const facts = async () => Promise.all([
    'pe_sessions', 'pe_operations', 'pe_attempts', 'pe_events', 'pe_native_writers', 'pe_native_turn_frames',
    'pe_native_input_origins', 'pe_native_input_revisions', 'pe_native_input_claims', 'pe_native_input_cohorts',
    'pe_native_input_commands', 'pe_native_turn_transitions_v2',
  ].map(async table => ({ table, rows: (await f.pool.query<Record<string, unknown>>(
    `SELECT * FROM ${table} AS stored ORDER BY to_jsonb(stored)::text`)).rows })))
  await n.tasks.cancel(f.alice.user, n.a.sessionId, f.alice.token)
  const canceled = await facts()
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'native_execution_authority_lost' })
  expect(await facts()).toEqual(canceled)
  await f.pool.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1', [n.a.operationId])
  const ended = await facts()
  // TaskStore rejects an ended attempt before the native frame reader runs.
  await expect(execute(f, n)).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  expect(await facts()).toEqual(ended)
}))

test.each(['operation', 'writer'] as const)('the final PG clock refuses %s expiry after the actual Root frame proof', lease => executionCase(async (f, n) => {
  await openStep(f, n)
  const blocker = await f.pool.connect()
  await blocker.query('BEGIN')
  await blocker.query('SELECT pg_advisory_xact_lock(860706,6)')
  const table = lease === 'operation' ? 'pe_sessions' : 'pe_native_writers'
  const column = lease === 'operation' ? 'lease_until' : 'expires_at', key = lease === 'operation' ? 'id' : 'session_id'
  await f.pool.query(`UPDATE ${table} SET ${column}=clock_timestamp()+interval '2 seconds' WHERE ${key}=$1`, [n.a.sessionId])
  const authority = new NativeExecutionAuthority(async (client, session, token) => {
    const frame = await n.frames.readExecutionInTransaction(client, session, token)
    await client.query('SELECT pg_advisory_xact_lock(860706,6)')
    return frame
  }, executionLimits)
  const tasks = new TaskStore(f.pool, taskLimits,
    (client, session, token) => authority.assertExecutionInTransaction(client, session, token))
  const outcome = transaction(f.pool, client => tasks.executionAuthorized(client, n.a.token))
    .then(value => ({ kind: 'allowed', value }), (error: unknown) => ({ kind: 'refused', error }))
  try {
    await expect.poll(async () => first((await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock(860706,6)') AS blocked`)).rows).blocked,
    { interval: 20, timeout: 5000 }).toBe(true)
    await expect.poll(async () => first((await blocker.query<{ expired: boolean }>(`SELECT ${column}<=clock_timestamp() AS expired
      FROM ${table} WHERE ${key}=$1`, [n.a.sessionId])).rows).expired, { interval: 20, timeout: 5000 }).toBe(true)
    await blocker.query('COMMIT')
    expect(await outcome).toMatchObject({ kind: 'refused', error: { status: 409, code: 'native_execution_authority_lost' } })
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    await outcome
  }
}))


test('native children derive only from the real claimed parent and stop after PG cancellation or original parent loss', () => executionCase(async (f, n) => {
  await openStep(f, n)
  const children = new NativeSubagents(n.executionTasks, { maxChildren: 1, maxDepth: 2, lifetimeMs: 60000, leaseMs: 30000 })
  const header = headerSchema.parse({ ...n.native.header, id: randomUUID(), origin: 'subagent', parentSession: n.a.sessionId,
    delegationDepth: 1, isSeeded: false, agentPreset: 'minimal' })
  await expect(children.create(n.a.token, { ...header, delegationDepth: 2 })).rejects.toMatchObject({ code: 'native_subagent_header_invalid' })
  const child = await children.create(n.a.token, header)
  expect(child).toMatchObject({ userId: n.a.userId, sessionId: header.id, text: '', remoteMcpTools: n.a.remoteMcpTools })
  await expect(children.create(n.a.token, { ...header, id: randomUUID() })).rejects.toMatchObject({ code: 'native_subagent_limit' })
  const acquire = { sessionId: child.sessionId, workerId: n.writer.workerId, token: randomBytes(32).toString('base64url') }
  const leased = await n.writers.acquire(child.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const session = Session.create(header.id, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  await n.events.append(child.token, session.snapshotEvents())
  await transaction(f.pool, client => n.executionTasks.executionAuthorized(client, child.token))
  session.append('sandbox/mode', { mode: 'workspace-write' })
  await n.events.append(child.token, session.snapshotEvents())
  expect(await transaction(f.pool, async client => readNativeRuntimePolicy(client, await n.executionTasks.authorized(client, child.token))))
    .toMatchObject({ mode: 'read-only' })
  await n.tasks.cancel(f.alice.user, child.sessionId, f.alice.token)
  expect(await n.tasks.renew(child.token)).toMatchObject({ cancelRequested: true })
  await expect(transaction(f.pool, client => n.executionTasks.executionAuthorized(client, child.token))).rejects.toMatchObject({ code: 'native_subagent_cancelled' })
  await n.writers.release(n.writer)
  await expect(n.events.runtimeSnapshot(child.token)).rejects.toMatchObject({ code: 'native_subagent_parent_lost' })
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [child.sessionId])
  await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [child.sessionId])
  expect(await n.tasks.claim(randomUUID())).toBeNull()
  const closed = await cleanupNativeRuntime(f.pool, child.token, { operationId: child.operationId, epoch: child.epoch, writer,
    errorCode: 'native_subagent_closed' }, { ...taskLimits, ...historyLimits })
  expect(closed.cleaned).toBe(true)
  expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1', [child.operationId])).rows)
    .toEqual([{ state: 'failed', error_code: 'native_subagent_closed' }])
}))


test('a later parent mode generation revokes its original native child before another dispatch', () => executionCase(async (f, n) => {
  await openStep(f, n)
  const children = new NativeSubagents(n.executionTasks, { maxChildren: 2, maxDepth: 2, lifetimeMs: 60000, leaseMs: 30000 })
  const header = headerSchema.parse({ ...n.native.header, id: randomUUID(), origin: 'subagent', parentSession: n.a.sessionId, delegationDepth: 1, isSeeded: false })
  const child = await children.create(n.a.token, header)
  await n.events.runtimeSnapshot(child.token)
  const changed = n.native.append('sandbox/mode', { mode: 'workspace-write' })
  n.history.push(changed)
  await n.events.append(n.a.token, [changed])
  await expect(n.events.runtimeSnapshot(child.token)).rejects.toMatchObject({ code: 'native_subagent_parent_policy_changed' })
  await expect(transaction(f.pool, client => n.executionTasks.nativeWorldAuthorized(client, child.token))).rejects.toMatchObject({ code: 'native_subagent_parent_policy_changed' })
}))


test('the actual allowed child model freezes separately within the original parent token budget', () => executionCase(async (f, n) => {
  await openStep(f, n)
  await f.pool.query("INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,'delegated-model','Delegated',4096,true)", [f.alice.user.userId])
  const children = new NativeSubagents(n.executionTasks, { maxChildren: 2, maxDepth: 2, lifetimeMs: 60000, leaseMs: 30000 })
  const header = headerSchema.parse({ ...n.native.header, id: randomUUID(), origin: 'subagent', parentSession: n.a.sessionId, delegationDepth: 1, isSeeded: false })
  const child = await children.create(n.a.token, header)
  const picked = await children.configure(child.token, { provider: 'power-evolve', model: 'delegated-model', maxTokens: n.a.settings.maxTokens })
  expect(picked).toMatchObject({ model: 'delegated-model', maxTokens: n.a.settings.maxTokens })
  expect((await transaction(f.pool, client => n.executionTasks.restoreGrantInTransaction(client, child.operationId, child.token, child.epoch))).settings).toEqual(picked)
  await expect(children.configure(child.token, { provider: 'power-evolve', model: 'ungranted-model', maxTokens: n.a.settings.maxTokens })).rejects.toMatchObject({ code: 'model_not_authorized' })
  await expect(children.configure(child.token, { provider: 'power-evolve', model: 'delegated-model', maxTokens: n.a.settings.maxTokens + 1 })).rejects.toMatchObject({ code: 'native_subagent_token_ceiling' })
  const session = Session.create(header.id, undefined, header)
  session.append('turn/start', { turn: 1 })
  await n.events.append(child.token, session.snapshotEvents())
  await expect(children.configure(child.token, { provider: 'power-evolve', model: 'delegated-model', maxTokens: n.a.settings.maxTokens })).rejects.toMatchObject({ code: 'native_subagent_model_frozen' })
}))
