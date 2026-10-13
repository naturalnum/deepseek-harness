/** Actual native prepared or claimed storage prefixes for archival Scheduler recovery. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { requestId } from '../src/contracts.ts'
import { nativeExecutionFrame } from '../src/native-execution-frame-contracts.ts'
import { inputCohortId, nativeInputAdmissionCommand, nativeInputClaimCommand, originInputId } from '../src/native-input-ledger-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema, parseEvents } from '../src/session-records.ts'
import { transaction } from '../src/platform/database.ts'
import type { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import type { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import type { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import type { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { readSessionStopInTransaction } from '../src/platform/native-session-stop.ts'
import { NativeWorkspaceRead } from '../src/platform/native-workspace-read.ts'
import type { TaskStore } from '../src/platform/tasks.ts'
import type { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
interface Services {
  tasks: TaskStore
  writers: NativeSessionWriter
  ledger: NativeInputLedger
  bridge: NativeInputCommit
  publisher: NativeAssistantStore
  history: { maxHistoryEvents: number; maxHistoryBytes: number }
}

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Archival Scheduler fixture returned no owned row')
  return row
}

/** Persist an original open turn and archive it before a new Host acquires storage ownership.
 * @param f Isolated ordinary schema5 database, authenticated account and physical file service.
 * @param services Actual Platform services sharing that database.
 * @param sessionId Owned Session with its accepted original A operation.
 * @param workerId Original Host identity recorded by the actual storage claim and independent Writer.
 * @param phase Whether A remains prepared or has one permanent native claim and bound open step.
 * @param imageHistory Optional original canonical image/offload prefix produced by the owning SessionStore.
 * @returns Original events, frames, frozen Grant and immutable inputs, plus the actual archive-first stop.
 */
export async function prepareSchedulerArchiveSource(f: Fixture, services: Services, sessionId: SessionId,
  workerId: string, phase: 'prepared' | 'claimed', imageHistory?: { session: Session; prefix: readonly SessionEvent[] }) {
  const { tasks, writers, ledger, bridge, publisher } = services
  const grant = await tasks.claim(workerId)
  if (!grant || grant.sessionId !== sessionId) throw new Error('Archival Scheduler source did not claim its actual A')
  const acquire = { sessionId, workerId: nativeWriterWorkerId.parse(workerId), token: randomBytes(32).toString('base64url') }
  const lease = await writers.acquire(grant.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [sessionId])).rows).header)
  const native = imageHistory?.session ?? Session.create(header.id, undefined, header), publisherId = randomUUID()
  const turn = imageHistory ? 2 : 1
  let ack = await publisher.apply(grant.token,
    { version: 1, epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: 1,
      items: imageHistory?.prefix.map(event => ({ type: 'event' as const, event })) ?? [] })
  for (const text of ['B archival sibling', 'C archival sibling']) {
    await tasks.accept(f.alice.user, sessionId, requestId.parse(randomUUID()), text, f.alice.token)
  }
  const items = (await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client,
    { operationToken: grant.token, writer }, 8))).items
  if (items.length !== 3 || first(items).originOperationId !== grant.operationId) throw new Error('Expected original A and two real siblings')
  let prepared
  for (const [index, item] of items.entries()) {
    const expectedEventCount = native.seq
    const event = native.append('agent/inbox/spliced', { target: 'next-turn', start: index, inserted: [item.message] })
    const result = await bridge.commitAccepted(grant.token, { version: 1, writer,
      command: nativeInputAdmissionCommand.parse({ rpcNonce: `archive-source:${item.originOperationId}`, sessionId,
        originInputId: originInputId.parse(item.originOperationId), originOperationId: item.originOperationId,
        messageId: item.message.id, target: 'next-turn' }), expectedEventCount, events: [event],
      presentation: { epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: ack.lastOrdinal + 1 },
      prepareFrame: item.originOperationId === grant.operationId })
    if (result.kind !== 'admission') throw new Error('Actual archival source admission returned a different purpose')
    ack = result.presentation
    if (result.frame) prepared = result.frame
  }
  if (prepared?.phase !== 'prepared') throw new Error('Actual archival source did not persist its prepared owner')
  const expectedEventCount = native.seq, start = native.append('turn/start', { turn })
  if (phase === 'claimed') {
    const frame = { sessionId, operationId: prepared.operationId, operationEpoch: prepared.operationEpoch,
      writerEpoch: prepared.writerEpoch, frozenSnapshotDigest: prepared.frozenSnapshotDigest }
    const command = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
      boundaryKind: 'initial-turn-step', frame })
    const removal = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const claimed = await bridge.commitClaim(grant.token, { version: 1, writer, command, expectedEventCount,
      events: [start, removal],
      presentation: { epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: ack.lastOrdinal + 1 } })
    if (claimed.kind !== 'claim') throw new Error('Actual archival source did not persist its permanent claim')
    ack = claimed.presentation
    const step = native.append('step/start', { turn, step: 1 })
    ack = await publisher.apply(grant.token, { version: 1, epoch: grant.epoch, publisherId,
      batchId: randomUUID(), firstOrdinal: ack.lastOrdinal + 1, items: [{ type: 'event', event: step }] })
    const { epoch: _epoch, ...seal } = ack
    await bridge.bindStep(grant.token, { version: 1, writer,
      command: { cohortId: command.cohortId, frame, stepStartSeq: step.seq }, seal })
  } else {
    await publisher.apply(grant.token, { version: 1, epoch: grant.epoch, publisherId,
      batchId: randomUUID(), firstOrdinal: ack.lastOrdinal + 1, items: [{ type: 'event', event: start }] })
  }
  const prefix = parseEvents(header, (await f.pool.query<{ event: unknown }>(
    'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [sessionId])).rows.map(row => row.event))
  const tables = ['pe_native_input_origins', 'pe_native_input_revisions', 'pe_native_input_claims', 'pe_native_input_cohorts', 'pe_native_turn_frames']
  const original = await Promise.all(tables.map(async table => (await f.pool.query<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE session_id=$1 ORDER BY to_jsonb(${table})::text`, [sessionId])).rows))
  const frame = nativeExecutionFrame.parse(first(original[4] ?? []).frame_json)
  if (frame.phase !== phase) throw new Error('Actual archival source stored a different native phase')
  await new NativeWorkspaceRead(f.pool, f.files, 8, 256).archiveAndStop(f.alice.user, f.alice.token, sessionId, tasks, services.history)
  const stop = await transaction(f.pool, client => readSessionStopInTransaction(client, f.alice.user.userId, sessionId))
  if (stop?.status !== 'requested') throw new Error('Actual archive-first request did not retain its stop')
  await writers.release(writer)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [sessionId])
  return { grant, writer, header, prefix, frame, items, tables, original, stop }
}
