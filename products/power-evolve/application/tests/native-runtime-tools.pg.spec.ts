/** Actual PG request series retain their Header across steps without admitting another operation or inherited seed. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Session, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { expect, test } from 'vitest'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSubagents } from '../src/platform/native-subagents.ts'
import { readNativeModelTools, registerNativeToolNames } from '../src/platform/native-tool-catalog.ts'
import { transaction } from '../src/platform/database.ts'
import { headerSchema } from '../src/session-records.ts'
import { requestId } from '../src/contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { admittedInputMessage, nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputStepCommand, originInputId } from '../src/native-input-ledger-contracts.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524288, maxHistoryBytes: 67108864, maxHistoryEvents: 100000, leaseMs: 30000,
  maxPendingPerUser: 8, maxActivePerUser: 2 }
const historyLimits = { maxHistoryBytes: limits.maxHistoryBytes, maxHistoryEvents: limits.maxHistoryEvents }
const inputLimits = { ...historyLimits, maxEventBytes: limits.maxEventBytes, maxCohortInputs: 128,
  maxAcceptedAuditBytes: 2097152, maxRevisionBytes: 262144, maxCommandBytes: 4194304 }
const nativeTool = { name: 'native_registered', description: 'Original native description', parameters: { type: 'object' } }
const external = { name: 'mcp__original__tool', description: 'Original catalog description', parameters: { type: 'object' } }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned Header fixture returned no row')
  return row
}

/** Claim and bind the original admission through the production Frame, ledger and Writer services. */
async function prepare(f: Fixture) {
  const tasks = new TaskStore(f.pool, limits), events = new EventStore(tasks, limits)
  const runtime = await new NativeRuntimeAuthority(f.pool).issue({ userId: f.alice.user.userId,
    runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const rpcId = requestId.parse(randomUUID())
  await tasks.accept(f.alice.user, created.sessionId, rpcId, 'Original Header owner', f.alice.token)
  const original = await tasks.claim(runtime.runtimeId)
  if (!original) throw new Error('Owned Header operation was not claimed')
  const workerId = nativeWriterWorkerId.parse(runtime.runtimeId), writers = new NativeSessionWriter(tasks, { leaseMs: 30000 })
  const acquire = { sessionId: original.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(original.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: original.token }
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const session = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2097152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits,
    (client, command) => frames.verifyInTransaction(client, command))
  const admitted = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [header.id, rpcId])).rows).admitted
  const message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId }, content: admitted })
  const origin = originInputId.parse(randomUUID()), admission = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  history.push(admission)
  await ledger.admit(f.alice.token, { command: nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: header.id,
    originInputId: origin, originOperationId: original.operationId, messageId: message.id, target: 'next-turn' }),
  authority, expectedEventCount: 0, events: [admission] })
  const frame = await transaction(f.pool, client => frames.prepareInTransaction(client, authority, origin))
  const execution = new NativeExecutionAuthority((client, owned, token) => frames.readExecutionInTransaction(client, owned, token),
    { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2097152 })
  const business = new TaskStore(f.pool, limits, (client, owned, token) => execution.assertExecutionInTransaction(client, owned, token))
  const initial = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: randomUUID(), boundaryKind: 'initial-turn-step',
    frame: { sessionId: header.id, operationId: original.operationId, operationEpoch: original.epoch,
      writerEpoch: writer.epoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
  const claimed = [session.append('turn/start', { turn: 1 }),
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  await ledger.claim({ command: initial, authority, expectedEventCount: history.length, events: claimed }); history.push(...claimed)
  const append = async (event: SessionEvent) => { await events.append(original.token, [event]); history.push(event) }
  const step = async (number: number, command = initial) => {
    const event = session.append('step/start', { turn: 1, step: number })
    await transaction(f.pool, async (client) => {
      const owner = await tasks.authorized(client, original.token)
      await events.appendInTransaction(client, owner, [event])
      await ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: command.cohortId,
        frame: command.frame, stepStartSeq: event.seq }), authority)
    }); history.push(event)
  }
  await step(1)
  return { tasks, business, events, writers, writer, original, authority, session, history, ledger, initial, append, step }
}

function header(session: Session) {
  return session.append('request/header', { header: { config: { provider: 'power-evolve', model: 'trial-model' },
    tools: [nativeTool, external] }, reason: 'initial' })
}

const registration = { names: [nativeTool.name], tools: [nativeTool] }

test('native runtime requires its committed source and retains the original native and external schemas across a real continuing step', () => cloudFixture(async (f) => {
  const n = await prepare(f)
  const read = (admitted: Parameters<typeof readNativeModelTools>[2] = []) => transaction(f.pool,
    async client => readNativeModelTools(client, await n.business.executionAuthorized(client, n.original.token), admitted))
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  await registerNativeToolNames(n.business, n.original.token, registration)
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  const event = header(n.session)
  await expect(registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: event.seq }))
    .rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  await n.append(event)
  // A committed Header alone cannot activate legacy names-only authorization for a native Runtime.
  await expect(read([external])).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  await registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: event.seq })
  expect(await read([external])).toEqual([nativeTool])
  await expect(read([{ ...external, parameters: { type: 'object', additionalProperties: false } }]))
    .rejects.toMatchObject({ code: 'model_tool_not_authorized' })
  await n.append(n.session.append('step/end', { turn: 1, step: 1 }))
  const continuation = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: randomUUID(),
    frame: n.initial.frame, boundaryKind: 'continuing-step' })
  await n.ledger.claim({ command: continuation, authority: n.authority, expectedEventCount: n.history.length, events: [] })
  await n.step(2, continuation)
  expect(await read([external])).toEqual([nativeTool])
  await registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: event.seq })
  expect(await read([external])).toEqual([nativeTool])
  expect((await f.pool.query('SELECT boundary_ordinal,owner_kind FROM pe_native_input_cohorts WHERE cohort_id=$1', [continuation.cohortId])).rows)
    .toEqual([{ boundary_ordinal: 1, owner_kind: 'current-frame' }])
}))

test.each(['fresh', 'inherited', 'missing-marker'] as const)('derived child Header source %s requires its explicit creation or inherited seed source and a new committed child request', mode => cloudFixture(async (f) => {
  const n = await prepare(f), parentHeader = header(n.session)
  await n.append(parentHeader)
  await registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: parentHeader.seq })
  const childHeader = headerSchema.parse({ ...n.session.header, id: randomUUID(), origin: 'subagent',
    parentSession: n.original.sessionId, delegationDepth: 1, isSeeded: mode !== 'fresh', cwd: '/workspace' })
  const child = await new NativeSubagents(n.business, { maxChildren: 1, maxDepth: 2, lifetimeMs: 60000, leaseMs: 30000 })
    .create(n.original.token, childHeader)
  const acquire = { sessionId: child.sessionId, workerId: n.writer.workerId, token: randomBytes(32).toString('base64url') }
  await n.writers.acquire(child.token, acquire)
  const seed = mode === 'fresh' ? undefined : buildForkSeed(n.session.snapshotEvents(), parentHeader.seq)
  const native = Session.create(childHeader.id, seed, childHeader, seed === undefined ? undefined : SessionLogOffset(parentHeader.seq + 1))
  native.append('turn/start', { turn: 1 }); native.append('step/start', { turn: 1, step: 1 })
  await n.events.append(child.token, native.snapshotEvents())
  const read = () => transaction(f.pool, async client => readNativeModelTools(client,
    await n.business.executionAuthorized(client, child.token), [external]))
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  if (mode !== 'fresh') {
    await expect(registerNativeToolNames(n.business, child.token, { ...registration, headerSeq: parentHeader.seq }))
      .rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  }
  const ownHeader = header(native)
  await n.events.append(child.token, native.snapshotEvents())
  if (mode === 'missing-marker') {
    // Deliberate corruption of this owned test database proves that absence never supplies a zero seed boundary.
    await f.pool.query("DELETE FROM pe_events WHERE session_id=$1 AND event->>'type'='session/end-seed'", [child.sessionId])
    const before = (await f.pool.query('SELECT * FROM pe_native_preferences ORDER BY namespace')).rows
    await expect(registerNativeToolNames(n.business, child.token, { ...registration, headerSeq: ownHeader.seq }))
      .rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
    expect((await f.pool.query('SELECT * FROM pe_native_preferences ORDER BY namespace')).rows).toEqual(before)
  } else {
    await registerNativeToolNames(n.business, child.token, { ...registration, headerSeq: ownHeader.seq })
    expect(await read()).toEqual([nativeTool])
    const saved = first((await f.pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE namespace=$1',
      [`runtime-tools:${child.operationId}:${child.epoch}`])).rows).value
    expect(saved).toMatchObject({ headerSeq: ownHeader.seq, source: { kind: mode === 'fresh' ? 'subagent-create' : 'subagent-seed', operationId: child.operationId,
      epoch: child.epoch, preparedEventCount: mode === 'fresh' ? 0 : parentHeader.seq + 2 } })
  }
}))
