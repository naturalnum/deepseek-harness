/** Real native archive completion, retained stop identities and unchanged independent Writer occupancy. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { inboxProjectionDefinition, planInboxCommand } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { grant, operationId, requestId } from '../src/contracts.ts'
import { nativeArchiveInputCancelCommit } from '../src/native-archive-input-contracts.ts'
import { nativePreparedCancelCommit } from '../src/native-prepared-cancel-contracts.ts'
import { nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputQueueCommand, inputCohortId, originInputId,
  type NativeInputLedgerLimits } from '../src/native-input-ledger-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import type { NativeAssistantBatch } from '../src/native-assistant-records.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { NativeArchiveInputCancel } from '../src/platform/native-archive-input.ts'
import { transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger, NativeInputNativePlanner } from '../src/platform/native-input-ledger.ts'
import { NativePreparedCancel } from '../src/platform/native-prepared-cancel.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { completeSessionStopInTransaction } from '../src/platform/native-session-stop-completion.ts'
import { readSessionStopInTransaction } from '../src/platform/native-session-stop.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeTurnAdvanceIntentV2 } from '../src/platform/native-turn-advance-intent-v2.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { digest } from '../src/platform/identity.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 16, maxActivePerUser: 2,
  archiveStopHistory: historyLimits }
const inputLimits: NativeInputLedgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
  maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Native stop completion fixture returned no row')
  return row
}

class ExpiringPublication extends NativeAssistantStore {
  expireOnCancel = false
  override async commitInputInTransaction(client: PoolClient, token: string, count: number, batch: NativeAssistantBatch) {
    const ack = await super.commitInputInTransaction(client, token, count, batch)
    if (this.expireOnCancel) await client.query(`UPDATE pe_native_presentations
      SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=(SELECT id FROM pe_sessions WHERE grant_digest=$1)`,
    [digest(token)])
    return ack
  }
}

async function locked<T>(f: Fixture, sessionId: Parameters<TaskStore['owned']>[2], run: (client: PoolClient) => Promise<T>) {
  return transaction(f.pool, async (client) => {
    const actor = await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
    expect((await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [sessionId, actor.userId])).rowCount).toBe(1)
    return run(client)
  })
}

async function stop(f: Fixture, tasks: TaskStore, sessionId: Parameters<TaskStore['owned']>[2], archived = true) {
  return locked(f, sessionId, async (client) => {
    const workspaces = (await client.query<LayoutWorkspace>(
      'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [f.alice.user.userId])).rows
    const layout = await readWorkspaceLayout(client, f.alice.user.userId, workspaces)
    layout.archivedSessionIds = archived ? [sessionId] : []
    await writeWorkspaceLayout(client, f.alice.user.userId, layout)
    if (archived) return tasks.requestArchiveStopInTransaction(client, f.alice.user, sessionId)
    const retained = await readSessionStopInTransaction(client, f.alice.user.userId, sessionId)
    if (!retained) throw new Error('Unarchive withdrew the original native stop')
    return retained
  })
}

async function prepare(f: Fixture) {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'real prepared owner', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Completion fixture did not receive its actual source')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const lease = await writers.acquire(grant.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
  const authority = { writer, operationToken: grant.token }
  const events = new EventStore(tasks, { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes })
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits,
    (client, request) => frames.verifyInTransaction(client, request))
  const publisher = new ExpiringPublication(tasks, events, presentationLimits), publisherId = randomUUID()
  const bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers,
    { input: inputLimits, presentation: presentationLimits })
  const cancel = new NativePreparedCancel(tasks, ledger, frames, publisher, writers,
    { input: inputLimits, presentation: presentationLimits })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header)
  const initial = await publisher.apply(grant.token,
    { version: 1, epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: 1, items: [] })
  const item = first((await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client, authority, 16))).items)
  const event = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [item.message] })
  const admitted = await bridge.commitAccepted(grant.token, { version: 1, writer, expectedEventCount: 0, events: [event],
    command: nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: grant.sessionId,
      originInputId: originInputId.parse(item.originOperationId), originOperationId: item.originOperationId,
      messageId: item.message.id, target: 'next-turn' }),
    presentation: { epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: initial.lastOrdinal + 1 }, prepareFrame: true })
  if (admitted.kind !== 'admission' || admitted.frame?.phase !== 'prepared') throw new Error('Actual native preparation did not complete')
  return { tasks, writers, writer, grant, authority, events, frames, ledger, publisher, publisherId, bridge, cancel,
    native, header, frame: admitted.frame, ack: admitted.presentation }
}

async function cancelRequest(n: Prepared) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
    const command = nativeInputQueueCommand.parse({ rpcNonce: randomUUID(),
      payload: { sessionId: n.grant.sessionId, itemId: n.frame.messageId, action: { kind: 'remove' } } })
    const plan = await new NativeInputNativePlanner(ctx.sessionProjections).planQueue(n.header, n.native.snapshotEvents(), command)
    return nativePreparedCancelCommit.parse({ version: 1, writer: n.writer, frame: n.frame, command,
      expectedEventCount: plan.expectedEventCount, events: plan.events,
      presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 },
      seal: { publisherId: n.publisherId, lastOrdinal: n.ack.lastOrdinal, eventCount: n.ack.eventCount, revision: n.ack.revision } })
  } finally { await ctx.fiber.dispose() }
}

async function snapshot(f: Fixture) {
  const rows = []
  for (const table of ['pe_sessions', 'pe_operations', 'pe_attempts', 'pe_native_writers', 'pe_events',
    'pe_native_turn_frames', 'pe_native_input_commands', 'pe_native_presentations',
    'pe_native_presentation_entries', 'pe_native_preferences']) {
    rows.push((await f.pool.query<Record<string, unknown>>(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)
  }
  return rows
}

test('accepted-only archival stop completes on actual empty history and preserves its completed identity on late repeats',
  () => cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, taskLimits)
    const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'accepted only', f.alice.token)
    const original = await locked(f, created.sessionId, async (client) => {
      const value = await tasks.requestArchiveStopInTransaction(client, f.alice.user, created.sessionId)
      expect(await completeSessionStopInTransaction(client, f.alice.user.userId, created.sessionId, value.stopId, historyLimits)).toBe(true)
      return value
    })
    const complete = await locked(f, created.sessionId,
      client => readSessionStopInTransaction(client, f.alice.user.userId, created.sessionId))
    expect(complete).toEqual({ ...original, status: 'complete' })
    const before = await snapshot(f)
    expect(await locked(f, created.sessionId, client => completeSessionStopInTransaction(client,
      f.alice.user.userId, created.sessionId, original.stopId, historyLimits))).toBe(true)
    expect(await snapshot(f)).toEqual(before)
    expect(await stop(f, tasks, created.sessionId, false)).toEqual(complete)
    expect((await f.pool.query<{ state: string; error_code: string; attempts: number }>(
      'SELECT state,error_code,attempts FROM pe_operations WHERE session_id=$1', [created.sessionId])).rows)
      .toEqual([{ state: 'failed', error_code: 'turn_user', attempts: 0 }])
    expect((await f.pool.query('SELECT 1 FROM pe_attempts')).rowCount).toBe(0)
  }))

test('prepared native pending retains its stop through unarchive and final-clock rollback before real retirement completes native cleanup',
  () => cloudFixture(async (f) => {
    const n = await prepare(f), original = await stop(f, n.tasks, n.grant.sessionId)
    expect(await locked(f, n.grant.sessionId, client => completeSessionStopInTransaction(client,
      f.alice.user.userId, n.grant.sessionId, original.stopId, historyLimits))).toBe(false)
    await expect(locked(f, n.grant.sessionId, client => completeSessionStopInTransaction(client,
      f.alice.user.userId, n.grant.sessionId, original.stopId, { ...historyLimits, maxHistoryBytes: 1 })))
      .rejects.toMatchObject({ code: 'native_input_history_budget' })
    expect(await stop(f, n.tasks, n.grant.sessionId, false)).toEqual(original)
    const request = await cancelRequest(n), before = await snapshot(f)
    n.publisher.expireOnCancel = true
    await expect(n.cancel.commit(n.grant.token, request)).rejects.toMatchObject({ code: 'native_input_authority_lost' })
    expect(await snapshot(f)).toEqual(before)
    n.publisher.expireOnCancel = false
    const writer = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_writers')).rows
    const reply = await n.cancel.commit(n.grant.token, request)
    expect(await locked(f, n.grant.sessionId, client => readSessionStopInTransaction(client, f.alice.user.userId, n.grant.sessionId)))
      .toEqual({ ...original, status: 'complete' })
    expect((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_writers')).rows).toEqual(writer)
    expect(first((await f.pool.query<{ live: boolean }>('SELECT expires_at>clock_timestamp() AS live FROM pe_native_writers')).rows).live)
      .toBe(true)
    const done = await snapshot(f)
    expect(await n.cancel.commit(n.grant.token, request)).toEqual(reply)
    expect(await locked(f, n.grant.sessionId, client => completeSessionStopInTransaction(client,
      f.alice.user.userId, n.grant.sessionId, original.stopId, historyLimits))).toBe(true)
    expect(await snapshot(f)).toEqual(done)
  }))

test('archival cancellation preserves every ended attempt and original frame of an actual capacity-parked prepared sibling',
  () => cloudFixture(async (f) => {
    const n = await prepare(f)
    const verifier = (client: PoolClient, request: Parameters<NativeExecutionFrames['verifyInTransaction']>[1]) =>
      n.frames.verifyInTransaction(client, request)
    const builder = new NativeTurnAdvanceIntentV2(n.tasks, n.writers, verifier, { ...historyLimits,
      maxAcceptedAuditBytes: inputLimits.maxAcceptedAuditBytes, maxRevisionBytes: inputLimits.maxRevisionBytes,
      maxCohortInputs: inputLimits.maxCohortInputs, maxCommandBytes: inputLimits.maxCommandBytes, assistant: presentationLimits })
    const continuation = (capacity: number) => new NativeTurnContinuationV2(n.tasks, n.writers, verifier,
      { ...inputLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: capacity, assistant: presentationLimits }, n.frames)
    const accept = async (text: string) => z.object({ accepted: z.literal(true), operationId, state: z.literal('queued') }).strict()
      .parse(await n.tasks.accept(f.alice.user, n.grant.sessionId, requestId.parse(randomUUID()), text, f.alice.token))
    const deferred = await accept('D accepted before B but not yet admitted'), b = await accept('B prepared then capacity parked')
    const admit = async (operationId: typeof n.grant.operationId, start: number, prepareFrame = false) => {
      const items = (await transaction(f.pool, client => n.ledger.readAcceptedPendingInTransaction(client, n.authority, 16))).items
      const item = items.find(value => value.originOperationId === operationId)
      if (!item) throw new Error('Actual accepted operation was absent from native admission')
      const expectedEventCount = n.native.seq
      const event = n.native.append('agent/inbox/spliced', { target: 'next-turn', start, inserted: [item.message] })
      const result = await n.bridge.commitAccepted(n.grant.token, { version: 1, writer: n.writer, expectedEventCount, events: [event],
        command: nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: n.grant.sessionId,
          originInputId: originInputId.parse(item.originOperationId), originOperationId: item.originOperationId,
          messageId: item.message.id, target: 'next-turn' }),
        presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 },
        prepareFrame })
      if (result.kind !== 'admission') throw new Error('Actual admission returned a different purpose')
      n.ack = result.presentation
      if (prepareFrame) {
        if (result.frame?.phase !== 'prepared') throw new Error('Actual owner did not prepare')
        n.frame = result.frame
      }
      return item
    }
    const close = async (turn: number) => {
      const expectedEventCount = n.native.seq
      const events = [n.native.append('turn/start', { turn }),
        n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
      const result = await n.bridge.commitClaim(n.grant.token, { version: 1, writer: n.writer, expectedEventCount, events,
        command: nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
          boundaryKind: 'initial-turn-step', frame: { sessionId: n.frame.sessionId, operationId: n.frame.operationId,
            operationEpoch: n.frame.operationEpoch, writerEpoch: n.frame.writerEpoch,
            frozenSnapshotDigest: n.frame.frozenSnapshotDigest } }),
        presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 } })
      n.ack = result.presentation
      const end = n.native.append('turn/end', { turn, reason: { kind: 'blocked' } })
      n.ack = await n.publisher.apply(n.grant.token, { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId,
        batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1, items: [{ type: 'event', event: end }] })
      return builder.prepare(n.grant.token, { writer: n.writer, transitionId: randomUUID(),
        candidateToken: randomBytes(32).toString('base64url'),
        seal: { publisherId: n.publisherId, lastOrdinal: n.ack.lastOrdinal, eventCount: n.ack.eventCount, revision: n.ack.revision } })
    }
    const heartbeat = async () => {
      n.authority = { writer: n.writer, operationToken: n.grant.token }
      n.publisherId = randomUUID()
      n.ack = await n.publisher.apply(n.grant.token,
        { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: 1, items: [] })
    }
    const sibling = await admit(b.operationId, 1), firstIntent = await close(1)
    const issued = (await continuation(2).transition(firstIntent)).receipt.result
    if (issued.kind !== 'prepared' || issued.frame.phase !== 'prepared') throw new Error('Actual v2 issuer did not prepare B')
    n.grant = grant.parse({ ...issued.grant, token: firstIntent.candidateToken }); n.frame = issued.frame
    expect(n.grant.operationId).toBe(b.operationId)
    await heartbeat()
    const oldFrame = (await f.pool.query<Record<string, unknown>>(
      'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1', [b.operationId])).rows
    const c = await accept('C precedes still-unclaimed B'), cInput = await admit(c.operationId, 1)
    const retargetContext = new Context()
    try {
      for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
        await retargetContext.plugin(plugin)
      }
      await retargetContext.plugin(AgentLoop, { agents: [] })
      // A real idle Agent owns this maintenance capture; no model, activity or capability is fabricated.
      const handle = await retargetContext.agents.create({ sessionId: n.header.id, meta: n.header,
        disposeOptions: { keepInbox: true } })
      expect(handle.agent.status).toBe('idle')
      handle.agent.session.synchronizeCommitted(n.native.snapshotEvents())
      expect(handle.agent.session.snapshotEvents()).toEqual(n.native.snapshotEvents())
      await handle.agent.runMaintenance(async (signal) => {
        const capture = handle.agent.captureInboxActivity(signal)
        const planned = planInboxCommand(Session.forPlanning(n.header.id, n.native.snapshotEvents(), n.header, SessionLogOffset(0)),
          retargetContext.sessionProjections,
          { kind: 'retarget', messageId: sibling.message.id, target: 'next-turn', wakeup: false }, capture)
        expect(planned.found).toBe(true)
        n.ack = await n.publisher.apply(n.grant.token, { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId,
          batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1, items: planned.events.map(event => ({ type: 'event', event })) })
        capture.assertCurrent()
        capture.synchronize(() => {
          handle.agent.session.synchronizeCommitted(planned.events)
          n.native.synchronizeCommitted(planned.events)
          return undefined
        })
      }, { scope: 'inbox' })
    } finally { await retargetContext.fiber.dispose() }
    await n.writers.release(n.writer)
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [n.grant.sessionId])
    const nativeTasks = new TaskStore(f.pool, taskLimits, undefined,
      (client, id, fallback) => n.frames.selectClaimInTransaction(client, id, fallback))
    const worker = nativeWriterWorkerId.parse(randomUUID()), cGrant = await nativeTasks.claim(worker)
    if (!cGrant) throw new Error('Actual native issuer did not select C')
    expect(cGrant.operationId).toBe(cInput.originOperationId)
    n.grant = cGrant
    const acquireC = { sessionId: cGrant.sessionId, workerId: worker, token: randomBytes(32).toString('base64url') }
    n.writer = nativeWriterIdentity.parse({ ...acquireC, epoch: (await n.writers.acquire(cGrant.token, acquireC)).epoch })
    n.authority = { writer: n.writer, operationToken: cGrant.token }
    const recovered = await transaction(f.pool, client => n.frames.recoverPreparedInTransaction(client, n.authority))
    if (recovered.kind !== 'prepared' || recovered.frame.phase !== 'prepared') throw new Error('Actual C did not recover prepared scope')
    n.frame = recovered.frame
    await heartbeat()
    const capacityIntent = await close(2)
    const other = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await n.tasks.accept(f.alice.user, other.sessionId, requestId.parse(randomUUID()), 'actual occupied other Session', f.alice.token)
    const occupied = await n.tasks.claim(randomUUID())
    expect(occupied?.sessionId).toBe(other.sessionId)
    expect((await continuation(1).transition(capacityIntent)).receipt.result).toEqual({ kind: 'parked', reason: 'capacity' })
    expect((await f.pool.query<Record<string, unknown>>(
      'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1', [b.operationId])).rows)
      .toEqual(oldFrame)
    const oldAttempts = (await f.pool.query<Record<string, unknown>>(
      'SELECT * FROM pe_attempts WHERE operation_id=$1', [b.operationId])).rows
    expect(oldAttempts).toHaveLength(1)
    expect(first(oldAttempts).ended_at).not.toBeNull()
    expect(first((await f.pool.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows)).toEqual({ state: 'queued', attempts: 1 })
    await n.writers.release(n.writer)
    const dWorker = nativeWriterWorkerId.parse(randomUUID()), dGrant = await n.tasks.claim(dWorker)
    if (!dGrant) throw new Error('Actual FIFO issuer did not select earlier accepted D')
    expect(dGrant.operationId).toBe(deferred.operationId)
    n.grant = dGrant
    const acquireD = { sessionId: dGrant.sessionId, workerId: dWorker, token: randomBytes(32).toString('base64url') }
    n.writer = nativeWriterIdentity.parse({ ...acquireD, epoch: (await n.writers.acquire(dGrant.token, acquireD)).epoch })
    await heartbeat(); await admit(dGrant.operationId, 1, true)
    const original = await stop(f, n.tasks, n.grant.sessionId), ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
      const command = nativeInputQueueCommand.parse({ rpcNonce: randomUUID(),
        payload: { sessionId: n.grant.sessionId, itemId: sibling.message.id, action: { kind: 'remove' } } })
      const plan = await new NativeInputNativePlanner(ctx.sessionProjections).planQueue(n.header, n.native.snapshotEvents(), command)
      const request = nativeArchiveInputCancelCommit.parse({ version: 1, stopId: original.stopId, writer: n.writer, frame: n.frame,
        command, expectedEventCount: plan.expectedEventCount, events: plan.events,
        presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 },
        seal: { publisherId: n.publisherId, lastOrdinal: n.ack.lastOrdinal, eventCount: n.ack.eventCount, revision: n.ack.revision } })
      const cancel = new NativeArchiveInputCancel(n.tasks, n.ledger, n.frames, n.publisher, n.writers,
        { input: inputLimits, presentation: presentationLimits })
      const reply = await cancel.commit(n.grant.token, request)
      expect((await f.pool.query<Record<string, unknown>>(
        'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1', [b.operationId])).rows)
        .toEqual(oldFrame)
      expect((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_attempts WHERE operation_id=$1', [b.operationId])).rows)
        .toEqual(oldAttempts)
      expect(first((await f.pool.query<{ state: string; error_code: string; attempts: number }>(
        'SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [b.operationId])).rows))
        .toEqual({ state: 'failed', error_code: 'turn_user', attempts: 1 })
      expect(await locked(f, n.grant.sessionId, client => completeSessionStopInTransaction(client,
        f.alice.user.userId, n.grant.sessionId, original.stopId, historyLimits))).toBe(false)
      const retained = await snapshot(f)
      expect(await cancel.commit(n.grant.token, request)).toEqual(reply)
      expect(await snapshot(f)).toEqual(retained)
    } finally { await ctx.fiber.dispose() }
  }))

test.each(['malformed value', 'foreign Session'] as const)('a persisted %s stop refuses archival cancellation without committing changes', kind => cloudFixture(async (f) => {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const foreign = await tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'retained accepted input', f.alice.token)
  const value = kind === 'malformed value' ? { version: 1 } : { version: 1, purpose: 'archive',
    sessionId: foreign.sessionId, stopId: randomUUID(), status: 'requested' }
  await f.pool.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)',
    [f.alice.user.userId, `session-archive-stop:${created.sessionId}`, value])
  const before = await snapshot(f)
  await expect(locked(f, created.sessionId, client => tasks.requestArchiveStopInTransaction(client, f.alice.user, created.sessionId)))
    .rejects.toMatchObject({ status: 503, code: 'native_session_stop_invalid' })
  expect(await snapshot(f)).toEqual(before)
}))

test('repeating an unfinished archival stop after unarchive retains its identity and preference revision', () => cloudFixture(async (f) => {
  const n = await prepare(f), original = await stop(f, n.tasks, n.grant.sessionId)
  expect(await stop(f, n.tasks, n.grant.sessionId, false)).toEqual(original)
  const before = await snapshot(f)
  expect(await locked(f, n.grant.sessionId,
    client => n.tasks.requestArchiveStopInTransaction(client, f.alice.user, n.grant.sessionId))).toEqual(original)
  expect(await snapshot(f)).toEqual(before)
}))
