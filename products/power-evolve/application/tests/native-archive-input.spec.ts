/** Actual PG archival sibling removals, original claimed recovery and immutable uncertain-reply acknowledgements. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { nativeArchiveInputCancelCommit, nativeArchiveInputCancelIntentDigest } from '../src/native-archive-input-contracts.ts'
import { nativeExecutionFrame } from '../src/native-execution-frame-contracts.ts'
import { nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputQueueCommand, inputCohortId, originInputId,
  type NativeInputLedgerLimits } from '../src/native-input-ledger-contracts.ts'
import { foldInputHistory } from '../src/native-input-ledger-records.ts'
import { nativeSessionStopId } from '../src/native-session-stop-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import type { NativeAssistantBatch } from '../src/native-assistant-records.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { NativeArchiveInputCancel } from '../src/platform/native-archive-input.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger, NativeInputNativePlanner } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { readSessionStopInTransaction } from '../src/platform/native-session-stop.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
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
  if (row === undefined) throw new Error('Archival input fixture returned no row')
  return row
}

async function prepare(f: Fixture, expiring = false) {
  expect(first((await f.pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).version).toBe(CURRENT_SCHEMA_VERSION)
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'A owner', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Archival fixture did not claim its actual owner')
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
  const cancel = new NativeArchiveInputCancel(tasks, ledger, frames, publisher, writers,
    { input: inputLimits, presentation: presentationLimits })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), publisherId = randomUUID()
  let ack = await publisher.apply(grant.token,
    { version: 1, epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: 1, items: [] })
  for (const text of ['B sibling', 'C sibling']) {
    await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), text, f.alice.token)
  }
  const items = (await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client, authority, 16))).items
  let frame
  for (const [index, item] of items.entries()) {
    const expectedEventCount = native.seq
    const event = native.append('agent/inbox/spliced', { target: 'next-turn', start: index, inserted: [item.message] })
    const result = await bridge.commitAccepted(grant.token, { version: 1, writer,
      command: nativeInputAdmissionCommand.parse({ rpcNonce: `admit:${item.originOperationId}`, sessionId: created.sessionId,
        originInputId: originInputId.parse(item.originOperationId), originOperationId: item.originOperationId,
        messageId: item.message.id, target: 'next-turn' }), expectedEventCount, events: [event],
      presentation: { epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: ack.lastOrdinal + 1 },
      prepareFrame: item.originOperationId === grant.operationId })
    if (result.kind !== 'admission') throw new Error('Archival fixture admission returned a different purpose')
    ack = result.presentation
    if (result.frame) frame = result.frame
  }
  if (frame?.phase !== 'prepared') throw new Error('Archival fixture did not prepare its original owner')
  return { tasks, writers, writer, grant, authority, events, frames, ledger, publisher, bridge, cancel, header, native,
    publisherId, ack, frame: nativeExecutionFrame.parse(frame), items }
}

async function archive(f: Fixture, n: Harness, archived = true) {
  return transaction(f.pool, async (client) => {
    const actor = await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
    expect((await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [n.grant.sessionId, actor.userId])).rowCount).toBe(1)
    const workspaces = (await client.query<LayoutWorkspace>(
      'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [actor.userId])).rows
    const layout = await readWorkspaceLayout(client, actor.userId, workspaces)
    layout.archivedSessionIds = archived ? [n.grant.sessionId] : []
    await writeWorkspaceLayout(client, actor.userId, layout)
    if (archived) return n.tasks.requestArchiveStopInTransaction(client, f.alice.user, n.grant.sessionId)
    const retained = await readSessionStopInTransaction(client, actor.userId, n.grant.sessionId)
    if (!retained) throw new Error('Unarchive withdrew the issued archival stop')
    return retained
  })
}

async function request(n: Harness, stopId: ReturnType<typeof nativeSessionStopId.parse>, item = first(n.items.slice(1))) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
    const command = nativeInputQueueCommand.parse({ rpcNonce: `archive:${randomUUID()}`,
      payload: { sessionId: n.grant.sessionId, itemId: item.message.id, action: { kind: 'remove' } } })
    const planned = await new NativeInputNativePlanner(ctx.sessionProjections).planQueue(n.header, n.native.snapshotEvents(), command)
    return nativeArchiveInputCancelCommit.parse({ version: 1, stopId, writer: n.writer, frame: n.frame, command,
      expectedEventCount: planned.expectedEventCount, events: planned.events,
      presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 },
      seal: { publisherId: n.publisherId, lastOrdinal: n.ack.lastOrdinal, eventCount: n.ack.eventCount, revision: n.ack.revision } })
  } finally { await ctx.fiber.dispose() }
}

async function facts(f: Fixture) {
  return {
    sessions: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_sessions ORDER BY id')).rows,
    operations: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_operations ORDER BY id')).rows,
    attempts: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_attempts ORDER BY operation_id,epoch')).rows,
    events: (await f.pool.query<{ event: SessionEvent }>('SELECT event FROM pe_events ORDER BY session_id,seq')).rows,
    origins: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_origins ORDER BY origin_input_id')).rows,
    revisions: (await f.pool.query<Record<string, unknown>>(
      'SELECT * FROM pe_native_input_revisions ORDER BY origin_input_id,input_revision')).rows,
    frames: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_turn_frames ORDER BY operation_id,operation_epoch')).rows,
    claims: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_claims ORDER BY origin_input_id')).rows,
    cohorts: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_cohorts ORDER BY cohort_id')).rows,
    receipts: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_input_commands ORDER BY command_id')).rows,
    presentation: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_presentations ORDER BY session_id')).rows,
    entries: (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_presentation_entries ORDER BY session_id,ordinal')).rows,
  }
}

test('archival removal keeps its prepared owner and other sibling, preserves latest revision and replays one original lost reply',
  () => cloudFixture(async (f) => {
    const n = await prepare(f), sibling = first(n.items.slice(1))
    const original = first(foldInputHistory(n.header, n.native.snapshotEvents()).inbox['next-turn'].slice(1))
    const content = [{ type: 'text' as const, text: 'B latest edited input' }], expectedEventCount = n.native.seq
    const edit = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1,
      inserted: [{ ...original, content }], outcome: 'canceled' })
    const edited = await n.bridge.commitQueue(f.alice.token, n.grant.token, { version: 1, writer: n.writer,
      command: { rpcNonce: randomUUID(), payload: { sessionId: n.grant.sessionId, itemId: sibling.message.id,
        action: { kind: 'edit', content } } }, expectedEventCount, events: [edit],
      presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 } })
    if (edited.kind !== 'queue') throw new Error('Actual sibling edit did not return a queue receipt')
    n.ack = edited.presentation
    const stop = await archive(f, n), intent = await request(n, stop.stopId), before = await facts(f)
    await expect(n.cancel.commit(n.grant.token, await request(n, stop.stopId, first(n.items))))
      .rejects.toMatchObject({ code: 'native_input_archive_conflict' })
    await expect(n.cancel.commit(n.grant.token, { ...intent, stopId: nativeSessionStopId.parse(randomUUID()) }))
      .rejects.toMatchObject({ code: 'native_input_archive_stop_conflict' })
    await expect(n.cancel.commit(n.grant.token, { ...intent, writer: { ...n.writer, token: randomBytes(32).toString('base64url') } }))
      .rejects.toMatchObject({ code: 'native_writer_lost' })
    expect(await facts(f)).toEqual(before)
    const result = await n.cancel.commit(n.grant.token, intent), done = await facts(f)
    expect(result.input.payloadDigest).toBe(nativeArchiveInputCancelIntentDigest(n.grant.token, intent))
    expect(result.input.result).toMatchObject({ kind: 'removed', inputRevision: 2,
      archive: { purpose: 'archive', stopId: stop.stopId, presentation: result.presentation } })
    expect(done.frames).toEqual(before.frames)
    expect(done.attempts).toEqual(before.attempts)
    expect(done.origins).toEqual(before.origins)
    expect(done.revisions).toEqual(before.revisions)
    expect(done.claims).toEqual(before.claims)
    expect(done.cohorts).toEqual(before.cohorts)
    expect(foldInputHistory(n.header, done.events.map(row => row.event)).inbox['next-turn'].map(message => message.id))
      .toEqual([first(n.items).message.id, first(n.items.slice(2)).message.id])
    const source = first((await f.pool.query<{ state: string; error_code: string; attempts: number }>(
      'SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [n.grant.operationId])).rows)
    expect(source).toEqual({ state: 'running', error_code: 'cancel_requested', attempts: 1 })
    expect(first((await f.pool.query<{ state: string; error_code: string; attempts: number }>(
      'SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [sibling.originOperationId])).rows))
      .toEqual({ state: 'failed', error_code: 'turn_user', attempts: 0 })
    expect(await n.cancel.commit(n.grant.token, intent)).toEqual(result)
    expect(await facts(f)).toEqual(done)
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
    await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.grant.sessionId])
    await f.pool.query('DELETE FROM pe_native_presentations WHERE session_id=$1', [n.grant.sessionId])
    const expired = await facts(f)
    expect(await n.cancel.commit(n.grant.token, intent)).toEqual(result)
    await expect(n.cancel.commit(n.grant.token, { ...intent, stopId: nativeSessionStopId.parse(randomUUID()) }))
      .rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
    await expect(n.cancel.commit(n.grant.token, { ...intent, presentation: { ...intent.presentation, batchId: randomUUID() } }))
      .rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
    await expect(n.cancel.commit(randomBytes(32).toString('base64url'), intent)).rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
    await expect(n.cancel.commit(n.grant.token, { ...intent, command: { ...intent.command, rpcNonce: randomUUID() } }))
      .rejects.toMatchObject({ status: 409 })
    expect(await facts(f)).toEqual(expired)
  }))

test('archival maintenance reclaims only storage after unarchive, preserves an original claimed frame and refuses a claimed target',
  () => cloudFixture(async (f) => {
    const n = await prepare(f), expectedEventCount = n.native.seq
    const start = n.native.append('turn/start', { turn: 1 })
    const removal = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const claimed = await n.bridge.commitClaim(n.grant.token, { version: 1, writer: n.writer,
      command: nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
        boundaryKind: 'initial-turn-step', frame: { sessionId: n.frame.sessionId, operationId: n.frame.operationId,
          operationEpoch: n.frame.operationEpoch, writerEpoch: n.frame.writerEpoch, frozenSnapshotDigest: n.frame.frozenSnapshotDigest } }),
      expectedEventCount, events: [start, removal],
      presentation: { epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1 } })
    if (claimed.kind !== 'claim') throw new Error('Archival fixture did not create its actual permanent claim')
    n.ack = claimed.presentation
    const end = n.native.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    n.ack = await n.publisher.apply(n.grant.token, { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId,
      batchId: randomUUID(), firstOrdinal: n.ack.lastOrdinal + 1, items: [{ type: 'event', event: end }] })
    n.frame = nativeExecutionFrame.parse(first((await f.pool.query<{ frame_json: unknown }>(
      'SELECT frame_json FROM pe_native_turn_frames WHERE operation_id=$1', [n.grant.operationId])).rows).frame_json)
    expect(n.frame.phase).toBe('claimed')
    const original = await facts(f), stop = await archive(f, n)
    expect(await archive(f, n, false)).toEqual(stop)
    await n.writers.release(n.writer)
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
    const workerId = nativeWriterWorkerId.parse(randomUUID())
    expect(await n.tasks.claim(workerId)).toBeNull()
    const maintenance = new TaskStore(f.pool, taskLimits, undefined,
      (client, session, fallback) => n.frames.selectClaimInTransaction(client, session, fallback))
    const current = await maintenance.claimArchiveStop(workerId)
    if (!current) throw new Error('Archival stop did not receive its actual maintenance storage attempt')
    expect(current).toMatchObject({ operationId: n.frame.operationId, epoch: n.frame.operationEpoch + 1 })
    n.grant = current
    const acquire = { sessionId: current.sessionId, workerId, token: randomBytes(32).toString('base64url') }
    const lease = await n.writers.acquire(current.token, acquire)
    n.writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
    n.authority = { writer: n.writer, operationToken: current.token }
    n.publisherId = randomUUID()
    n.ack = await n.publisher.apply(current.token,
      { version: 1, epoch: current.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: 1, items: [] })
    const execution = new NativeExecutionAuthority((client, session, token) => n.frames.readExecutionInTransaction(client, session, token),
      { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2_097_152 })
    const business = new TaskStore(f.pool, taskLimits,
      (client, session, token) => execution.assertExecutionInTransaction(client, session, token))
    await expect(transaction(f.pool, client => business.executionAuthorized(client, current.token)))
      .rejects.toMatchObject({ code: 'native_session_archived' })
    const intent = await request(n, stop.stopId), before = await facts(f)
    await expect(n.cancel.commit(current.token, { ...intent, command: { ...intent.command,
      payload: { ...intent.command.payload, itemId: first(n.items).message.id } } }))
      .rejects.toMatchObject({ code: 'native_input_already_consumed' })
    expect(await facts(f)).toEqual(before)
    const receipt = await n.cancel.commit(current.token, intent), done = await facts(f)
    expect(receipt.presentation.epoch).toBe(current.epoch)
    expect(receipt.input.actor).toMatchObject({ kind: 'writer', writerEpoch: n.writer.epoch })
    expect(done.frames).toEqual(original.frames)
    expect(done.claims).toEqual(original.claims)
    expect(done.cohorts).toEqual(original.cohorts)
    expect(done.attempts).toEqual(before.attempts)
    expect(foldInputHistory(n.header, done.events.map(row => row.event)).inbox['next-turn'].map(message => message.id))
      .toEqual([first(n.items.slice(2)).message.id])
  }))

test('archival cancellation rolls back the actual queued failure and canonical publication when the publisher expires after commit',
  () => cloudFixture(async (f) => {
    const n = await prepare(f, true), stop = await archive(f, n), intent = await request(n, stop.stopId)
    if (!(n.publisher instanceof ExpiringPublication)) throw new Error('Actual publication expiry injection is unavailable')
    n.publisher.expireOnCancel = true
    const before = await facts(f)
    await expect(n.cancel.commit(n.grant.token, intent)).rejects.toMatchObject({ code: 'native_input_authority_lost' })
    expect(await facts(f)).toEqual(before)
  }))


test('the archive-cancel journal ACK rolls back all actual native terminal facts on failure and survives an original lost reply', () => cloudFixture(async (f) => {
  const n = await prepare(f), stop = await archive(f, n)
  const intent = await request(n, stop.stopId)
  const turn = new NativeTurnContinuationV2(n.tasks, n.writers, (client, request) => n.frames.verifyInTransaction(client, request),
    { ...inputLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser, assistant: presentationLimits }, n.frames)
  const fresh = retainedTestStore(n, { input: inputLimits, presentation: presentationLimits }, turn)
  const before = await retainedNativeFacts(f.pool)
  const prepared = await fresh().prepare(n.grant.token, { version: 1, workerId: n.writer.workerId,
    mutation: { family: 'archive-cancel', request: intent } })
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
  expect(result.family).toBe('archive-cancel')
  await n.writers.release(n.writer)
  const complete = await retainedNativeFacts(f.pool)
  expect(await fresh().execute(n.grant.token, execute)).toEqual(result)
  expect((await fresh().reconcile({ version: 1, workerId: n.writer.workerId, limit: 8 })).items[0]?.outcome)
    .toEqual({ state: 'committed', receipt: result, retired: false })
  expect(await retainedNativeFacts(f.pool)).toEqual(complete)
  expect(JSON.stringify(result)).not.toContain(n.grant.token)
  expect(JSON.stringify(result)).not.toContain(n.writer.token)
}))
