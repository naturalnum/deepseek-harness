/** Real PostgreSQL continuation receipts, native consumption and independent lease fencing. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Session, type UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, test } from 'vitest'
import { grant, operationId, requestId, type Grant } from '../src/contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { nativeTransitionId, nativeTurnMessageId, nativeTurnResponse, nativeTurnTransition } from '../src/native-turn-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { admittedNativeContent } from '../src/native-attachment-contracts.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnContinuation } from '../src/platform/native-turn-continuation.ts'
import { nativeInputForTurn } from '../src/platform/native-turn-input.ts'
import { closedNativeTurn, readNativeTurnHistory } from '../src/platform/native-turn-history.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { EventStore } from '../src/platform/events.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { digest } from '../src/platform/identity.ts'
import type { PoolClient } from 'pg'
import type { NativeTurnResponse } from '../src/native-turn-contracts.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Prepared = Awaited<ReturnType<typeof prepare>>
const token = () => randomBytes(32).toString('base64url')
const taskLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const assistantLimits = { maxBatchItems: 128, maxBatchBytes: 2_097_152, maxItemBytes: 1_048_576,
  maxActiveBytes: 1_048_576, maxRingItems: 128, maxRingBytes: 2_097_152, ttlMs: 30_000, maxEventBytes: 524_288 }
const turnLimits = { ...taskLimits, assistant: assistantLimits }

function first<T>(rows: readonly T[]): T {
  const value = rows[0]
  if (value === undefined) throw new Error('Owned continuation fixture returned no row')
  return value
}

async function diagnosticSchema(f: Fixture): Promise<void> {
  const ddlFile = process.env.PE_NATIVE_TURN_TEST_DDL_FILE
  const formalTables = ['pe_native_turn_frames', 'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
    'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_transitions_v2']
  const expected: Record<string, Readonly<Record<string, string>>> = {
    pe_native_turn_frames: { operation_id: 'uuid:NO', operation_epoch: 'bigint:NO', session_id: 'uuid:NO', writer_epoch: 'bigint:NO',
      request_id: 'uuid:NO', message_id: 'uuid:NO', grant_digest: 'text:NO', frame_json: 'jsonb:NO', grant_json: 'jsonb:NO',
      prepared_event_count: 'integer:NO' },
    pe_native_turn_transitions: { session_id: 'uuid:NO', writer_epoch: 'bigint:NO', transition_id: 'uuid:NO', intent_digest: 'text:NO',
      candidate_digest: 'text:NO', from_operation_id: 'uuid:YES', from_operation_epoch: 'bigint:YES', from_transition_id: 'uuid:YES',
      receipt_json: 'jsonb:NO' },
  }
  await transaction(f.pool, async (client) => {
    const versions = (await client.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
    if (versions.length !== 1 || first(versions).family !== 'cloud-native') throw new Error('Invalid legacy fixture schema metadata')
    const tables = (await client.query<{ name: string; present: boolean }>(
      "SELECT name,to_regclass('public.'||name) IS NOT NULL AS present FROM unnest($1::text[]) AS needed(name)",
      [[...formalTables, 'pe_native_turn_transitions']])).rows
    if (ddlFile !== undefined) {
      if (!ddlFile || first(versions).version !== 4 || tables.some(row => row.present)) {
        throw new Error('Private legacy DDL requires schema4 without any native frame, ledger or transition tables')
      }
      await client.query(await readFile(ddlFile, 'utf8'))
      const formal = await client.query(`SELECT name FROM unnest($1::text[]) AS needed(name)
        WHERE to_regclass('public.'||name) IS NOT NULL`, [formalTables.filter(name => name !== 'pe_native_turn_frames')])
      if (formal.rowCount) throw new Error('Private legacy DDL cannot install current ledger or v2 transitions')
    } else {
      if (first(versions).version !== CURRENT_SCHEMA_VERSION || formalTables.some(name => !tables.find(row => row.name === name)?.present)
        || tables.find(row => row.name === 'pe_native_turn_transitions')?.present) {
        throw new Error(
          `Legacy regression tests require formal schema${CURRENT_SCHEMA_VERSION} before creating their isolated test-local table`,
        )
      }
      // Only this spec's owned database adds the original v1 receipt table; formal frames remain unchanged.
      await client.query(`CREATE TABLE pe_native_turn_transitions (
        session_id uuid NOT NULL REFERENCES pe_sessions(id),
        writer_epoch bigint NOT NULL CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
        transition_id uuid NOT NULL,
        intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
        candidate_digest text NOT NULL UNIQUE CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
        from_operation_id uuid,
        from_operation_epoch bigint,
        from_transition_id uuid,
        receipt_json jsonb NOT NULL,
        PRIMARY KEY (session_id, writer_epoch, transition_id),
        UNIQUE (from_operation_id, from_operation_epoch),
        UNIQUE (session_id, writer_epoch, from_transition_id),
        FOREIGN KEY (from_operation_id, from_operation_epoch) REFERENCES pe_native_turn_frames(operation_id, operation_epoch),
        FOREIGN KEY (session_id, writer_epoch, from_transition_id)
          REFERENCES pe_native_turn_transitions(session_id, writer_epoch, transition_id),
        CHECK ((from_operation_id IS NOT NULL AND from_operation_epoch IS NOT NULL AND from_transition_id IS NULL)
          OR (from_operation_id IS NULL AND from_operation_epoch IS NULL AND from_transition_id IS NOT NULL))
      )`)
    }
    const columns = (await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.keys(expected)])).rows
    for (const [name, fields] of Object.entries(expected)) {
      const actual = columns.filter(row => row.table_name === name)
      if (actual.length !== Object.keys(fields).length
        || actual.some(row => fields[row.column_name] !== `${row.data_type}:${row.is_nullable}`)) {
        throw new Error('Legacy regression frame or receipt columns do not match the original schema')
      }
    }
  })
}

async function prepare(f: Fixture, actor = f.alice, bootstrapEpoch?: number) {
  const tasks: TaskStore = new TaskStore(f.pool, taskLimits,
    (client, session, operationToken): Promise<void> => continuation.assertExecutionInTransaction(client, session, operationToken))
  const created = await tasks.create(actor.user, requestId.parse(randomUUID()), actor.token)
  const aRequest = requestId.parse(randomUUID()), bRequest = requestId.parse(randomUUID())
  await tasks.accept(actor.user, created.sessionId, aRequest, 'A accepted input', actor.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID())
  let a = await tasks.claim(workerId)
  if (!a) throw new Error('Owned bootstrap operation was not claimed')
  if (bootstrapEpoch !== undefined) {
    const original = a
    a = await transaction(f.pool, async (client) => {
      await client.query('UPDATE pe_attempts SET epoch=$2 WHERE operation_id=$1', [original.operationId, bootstrapEpoch])
      await client.query('UPDATE pe_sessions SET lease_epoch=$2 WHERE id=$1', [original.sessionId, bootstrapEpoch])
      return tasks.restoreGrantInTransaction(client, original.operationId, original.token, bootstrapEpoch)
    })
  }
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: token() }
  const leased = await writers.acquire(a.token, acquire)
  const writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const continuation: NativeTurnContinuation = new NativeTurnContinuation(tasks, writers, turnLimits)
  const aMessage = nativeTurnMessageId.parse(randomUUID()), bMessage = nativeTurnMessageId.parse(randomUUID())
  const frame = await continuation.prepare({ writer, operationToken: a.token, messageId: aMessage })
  const bAccepted = await tasks.accept(actor.user, created.sessionId, bRequest, 'B accepted input', actor.token)
  const bId = operationId.parse(first((await f.pool.query<{ id: string }>(
    'SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [created.sessionId, bRequest])).rows).id)
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header)
  const events = new EventStore(tasks, taskLimits)
  const publisher = new NativeAssistantStore(tasks, events, assistantLimits)
  const publisherId = randomUUID()
  const bContent = admittedNativeContent.parse(first((await f.pool.query<{ admitted: unknown }>(
    'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, bRequest])).rows).admitted)
  const aInput = nativeInputForTurn(a, aMessage)
  const bInput: UserMessage = { id: bMessage, role: 'user', content: bContent,
    source: { kind: 'user', rpcId: brandString<SessionRequestId>(bRequest) } }
  native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [aInput, bInput] })
  return { tasks, writers, writer, a, aRequest, bRequest, bId, bAccepted, aMessage, bMessage,
    frame, continuation, native, publisher, publisherId, events }
}

async function publish(n: Prepared, value: Grant = n.a) {
  return n.publisher.apply(value.token, { version: 1, epoch: value.epoch, publisherId: n.publisherId,
    batchId: randomUUID(), firstOrdinal: 1,
    items: n.native.snapshotEvents().map(event => ({ type: 'event', event })) })
}

async function closeA(n: Prepared, reason: 'completed' | 'blocked' | 'aborted' = 'completed') {
  const start = n.native.append('turn/start', { turn: 1 })
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  if (reason === 'completed') {
    n.native.append('user/message', nativeInputForTurn(n.a, n.aMessage), { surfaceOp: 'append' })
    n.native.append('step/start', { turn: 1, step: 1 })
    n.native.append('step/end', { turn: 1, step: 1 })
  }
  const end = n.native.append('turn/end', { turn: 1,
    reason: reason === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: reason } })
  const receipt = await publish(n)
  const queueRevision = n.native.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced')?.seq
  if (queueRevision === undefined) throw new Error('Owned fixture did not publish inbox state')
  return nativeTurnTransition.parse({ kind: 'advance', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: receipt.eventCount, expectedQueueRevision: queueRevision,
    expectedNext: { operationId: n.bId, messageId: n.bMessage, inputRevision: 1 },
    from: { kind: 'turn', operationId: n.a.operationId, operationEpoch: n.a.epoch, operationToken: n.a.token,
      turn: 1, turnStartSeq: start.seq, turnEndSeq: end.seq, claimedMessageIds: [n.aMessage] },
    seal: { publisherId: n.publisherId, lastOrdinal: receipt.lastOrdinal, revision: receipt.revision } })
}

async function turnCase(run: (f: Fixture, n: Prepared) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => { await diagnosticSchema(f); await run(f, await prepare(f)) })
}

async function state(f: Fixture) {
  const operations = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_operations ORDER BY id')).rows
  const sessions = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_sessions ORDER BY id')).rows
  const frames = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_turn_frames ORDER BY operation_id,operation_epoch')).rows
  const transitions = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_turn_transitions ORDER BY transition_id')).rows
  const presentations = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_presentations ORDER BY session_id')).rows
  const attempts = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_attempts ORDER BY operation_id,epoch')).rows
  return { operations, sessions, frames, transitions, presentations, attempts }
}

function liveGrant(response: NativeTurnResponse): Grant {
  if (response.current.kind !== 'live') throw new Error('Expected the original live result grant')
  return response.current.grant
}

function parkedRequest(n: Prepared, value: Grant, reason: 'preparation_failed' | 'user_cancel') {
  const revision = n.native.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced')?.seq ?? -1
  return nativeTurnTransition.parse({ kind: 'park', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: n.native.snapshotEvents().length, expectedQueueRevision: revision, expectedNext: null, reason,
    from: { kind: 'prepared', operationId: value.operationId, operationEpoch: value.epoch, operationToken: value.token } })
}

async function waitBlocked(f: Fixture, fragment: string, expected = 1): Promise<void> {
  await expect.poll(async () => first((await f.pool.query<{ blocked: boolean }>(`SELECT count(*)>=$2 AS blocked FROM pg_stat_activity
    WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`, [`%${fragment}%`, expected])).rows).blocked,
  { timeout: 5000, interval: 20 }).toBe(true)
}

async function clockExpired(client: PoolClient, table: 'pe_sessions' | 'pe_native_writers', id: string): Promise<void> {
  const column = table === 'pe_sessions' ? 'id' : 'session_id', expiry = table === 'pe_sessions' ? 'lease_until' : 'expires_at'
  await expect.poll(async () => first((await client.query<{ expired: boolean }>(
    `SELECT ${expiry}<=clock_timestamp() AS expired FROM ${table} WHERE ${column}=$1`, [id])).rows).expired,
  { timeout: 5000, interval: 20 }).toBe(true)
}

async function openStep(n: Prepared): Promise<void> {
  n.native.append('turn/start', { turn: 1 })
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  n.native.append('step/start', { turn: 1, step: 1 })
  n.native.append('user/message', nativeInputForTurn(n.a, n.aMessage), { surfaceOp: 'append' })
  await n.events.append(n.a.token, n.native.snapshotEvents())
}

async function insertBarrier(f: Fixture, table: 'pe_native_turn_frames' | 'pe_native_turn_transitions'): Promise<void> {
  await f.pool.query(`CREATE FUNCTION owned_turn_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS
    $body$ BEGIN PERFORM pg_advisory_xact_lock(607,6); RETURN NEW; END $body$`)
  await f.pool.query(`CREATE TRIGGER owned_turn_insert_barrier BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION owned_turn_insert_barrier()`)
}

test('prepared failure parks the same unconsumed B and a fresh activation preserves input and original request receipt', () => turnCase(async (f, n) => {
  const advance = await closeA(n), firstResponse = await n.continuation.transition(advance), b = liveGrant(firstResponse)
  const park = parkedRequest(n, b, 'preparation_failed'), parked = await n.continuation.transition(park)
  expect(parked.current).toEqual({ kind: 'parked' })
  expect(parked.receipt.result).toMatchObject({ kind: 'parked', reason: 'preparation_failed',
    unclaimed: { operationId: n.bId, messageId: n.bMessage, action: 'retain' } })
  expect(first((await f.pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE id=$1', [n.bId])).rows).state).toBe('queued')
  expect(await n.tasks.accept(f.alice.user, n.writer.sessionId, n.bRequest, 'B accepted input', f.alice.token))
    .toEqual({ accepted: true, operationId: n.bId, state: 'queued' })
  expect(await n.tasks.claim(randomUUID())).toBeNull()
  if (advance.kind !== 'advance') throw new Error('Expected advance fixture')
  const { seal: _seal, from: _from, kind: _kind, ...common } = advance
  const activate = nativeTurnTransition.parse({ ...common, kind: 'activate', from: { kind: 'parked', transitionId: parked.receipt.transitionId },
    transitionId: randomUUID(), candidateToken: token() })
  const again = liveGrant(await n.continuation.transition(activate))
  expect(again).toMatchObject({ operationId: b.operationId, requestId: b.requestId, nativeContent: b.nativeContent,
    selection: b.selection, settings: b.settings, epoch: b.epoch + 1 })
  expect((await n.continuation.transition(advance)).current).toEqual({ kind: 'expired' })
  expect((await n.continuation.transition(park)).current).toEqual({ kind: 'expired' })
  expect((await f.pool.query('SELECT * FROM pe_native_turn_frames WHERE operation_id=$1', [n.bId])).rows).toHaveLength(2)
}))

test('user cancellation retires unclaimed B terminally and returns an exact pending removal disposition', () => turnCase(async (f, n) => {
  const advance = await closeA(n), b = liveGrant(await n.continuation.transition(advance))
  await n.tasks.cancelActive(f.alice.user, n.writer.sessionId, f.alice.token)
  const park = parkedRequest(n, b, 'user_cancel'), response = await n.continuation.transition(park)
  expect(response.receipt.result).toMatchObject({ reason: 'user_cancel', unclaimed: { messageId: n.bMessage, action: 'remove' } })
  expect(await n.tasks.accept(f.alice.user, n.writer.sessionId, n.bRequest, 'B accepted input', f.alice.token))
    .toEqual({ accepted: true, operationId: n.bId, state: 'failed' })
  expect((await n.continuation.transition(park)).receipt).toEqual(response.receipt)
  expect(first((await f.pool.query<{ code: string }>('SELECT error_code AS code FROM pe_operations WHERE id=$1', [n.bId])).rows).code).toBe('turn_user')
  expect(await n.writers.renew(n.writer)).toMatchObject({ epoch: n.writer.epoch })
}))

test('prepared execution is refused while storage can persist the actual claim and open step', () => turnCase(async (f, n) => {
  const assertExecution = () => transaction(f.pool, async (client) => {
    await n.tasks.executionAuthorized(client, n.a.token)
  })
  await expect(assertExecution()).rejects.toMatchObject({ code: 'native_turn_execution_unclaimed' })
  n.native.append('turn/start', { turn: 1 })
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  await n.events.append(n.a.token, n.native.snapshotEvents())
  await expect(assertExecution()).rejects.toMatchObject({ code: 'native_turn_execution_unclaimed' })
  const start = n.native.append('step/start', { turn: 1, step: 1 })
  const message = n.native.append('user/message', nativeInputForTurn(n.a, n.aMessage), { surfaceOp: 'append' })
  await n.events.append(n.a.token, [start, message])
  await expect(assertExecution()).resolves.toBeUndefined()
  const end = n.native.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  await n.events.append(n.a.token, [end])
  await expect(assertExecution()).rejects.toMatchObject({ code: 'native_turn_execution_unclaimed' })
}))

test.each(['pe_sessions', 'pe_native_writers'] as const)('a real receipt table lock beyond %s expiry rolls back settlement and B issuance', table => turnCase(async (f, n) => {
  const request = await closeA(n)
  const column = table === 'pe_sessions' ? 'id' : 'session_id', expiry = table === 'pe_sessions' ? 'lease_until' : 'expires_at'
  await f.pool.query(`UPDATE ${table} SET ${expiry}=clock_timestamp()+interval '1 second' WHERE ${column}=$1`, [n.writer.sessionId])
  const before = await state(f), lock = await f.pool.connect()
  let pending: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query('LOCK TABLE pe_native_turn_transitions IN SHARE MODE')
    const transition = n.continuation.transition(request)
    pending = transition
    const outcome = transition.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, value: error }))
    await waitBlocked(f, 'INSERT INTO pe_native_turn_transitions')
    await clockExpired(lock, table, n.writer.sessionId)
    await lock.query('COMMIT')
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(result.value).toMatchObject({ code: table === 'pe_sessions' ? 'native_turn_fence_expired' : 'native_writer_lost' })
    expect(await state(f)).toEqual(before)
  } finally {
    await lock.query('ROLLBACK')
    await pending?.catch((_retained: unknown) => undefined)
    lock.release()
  }
}))

test('two service instances recover one concurrent intent and conflicting successors cannot consume another operation', () => turnCase(async (f, n) => {
  const request = await closeA(n), other = new NativeTurnContinuation(n.tasks, n.writers, turnLimits)
  const results = await Promise.all([n.continuation.transition(request), other.transition(request)])
  expect(results.map(value => value.replayed).sort()).toEqual([false, true])
  expect(results[0]?.receipt).toEqual(results[1]?.receipt)
  const before = await state(f)
  await expect(other.transition({ ...request, transitionId: randomUUID(), candidateToken: token() }))
    .rejects.toMatchObject({ code: 'native_turn_source_used' })
  expect(await state(f)).toEqual(before)
}))

test('A closes and B is prepared in one transaction with original admission and independent writer ownership', () => turnCase(async (f, n) => {
  const request = await closeA(n)
  const response = nativeTurnResponse.parse(await n.continuation.transition(request))
  expect(response.replayed).toBe(false)
  expect(response.receipt.result.kind).toBe('prepared')
  expect(response.current.kind).toBe('live')
  if (response.current.kind !== 'live') throw new Error('Expected live prepared B')
  expect(response.current.frame).toMatchObject({ phase: 'prepared', operationId: n.bId, messageId: n.bMessage })
  expect(response.current.grant).toMatchObject({ operationId: n.bId, requestId: n.bRequest, token: request.candidateToken,
    settings: n.a.settings, text: 'B accepted input', epoch: n.a.epoch + 1 })
  expect(first((await f.pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE id=$1', [n.a.operationId])).rows).state).toBe('completed')
  expect(first((await f.pool.query<{ epoch: string }>('SELECT epoch::text AS epoch FROM pe_native_writers WHERE session_id=$1',
    [n.writer.sessionId])).rows).epoch).toBe(String(n.writer.epoch))
  expect((await f.pool.query('SELECT * FROM pe_native_presentations')).rows).toEqual([])
  const persisted = JSON.stringify((await f.pool.query('SELECT * FROM pe_native_turn_transitions')).rows)
  for (const secret of [n.a.token, n.writer.token, request.candidateToken]) expect(persisted).not.toContain(secret)
}))

test('same response-loss intent returns original B and does not extend its lease or consume C', () => turnCase(async (f, n) => {
  const request = await closeA(n)
  const original = await n.continuation.transition(request)
  const before = await state(f)
  const retry = await new NativeTurnContinuation(n.tasks, n.writers, turnLimits).transition(request)
  expect(retry).toEqual({ ...original, replayed: true })
  expect(await state(f)).toEqual(before)
  await expect(n.tasks.renew(n.a.token)).rejects.toMatchObject({ code: 'lease_lost' })
}))

test('an expired original B has a historical receipt and no executable bearer on retry', () => turnCase(async (f, n) => {
  const request = await closeA(n), original = await n.continuation.transition(request)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.writer.sessionId])
  const retry = await n.continuation.transition(request)
  expect(retry.receipt).toEqual(original.receipt)
  expect(retry.current).toEqual({ kind: 'expired' })
  expect(JSON.stringify(retry)).not.toContain(request.candidateToken)
  expect((await f.pool.query('SELECT * FROM pe_native_turn_transitions')).rows).toHaveLength(1)
}))

test('changed candidate or turn facts conflict with an existing intent without another claim', () => turnCase(async (f, n) => {
  const request = await closeA(n)
  await n.continuation.transition(request)
  const before = await state(f)
  await expect(n.continuation.transition({ ...request, candidateToken: token() })).rejects.toMatchObject({ code: 'native_turn_intent_conflict' })
  if (request.kind !== 'advance') throw new Error('Expected advance fixture')
  await expect(n.continuation.transition({ ...request, from: { ...request.from, turn: 2 } })).rejects.toMatchObject({ code: 'native_turn_intent_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('claimed but no user/message is settled as blocked and cannot be replayed as unclaimed work', () => turnCase(async (f, n) => {
  const request = await closeA(n, 'blocked')
  expect(n.native.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
  const observed = await n.continuation.inspect(n.writer, n.a.operationId, n.a.epoch)
  expect(observed.phase).toBe('claimed')
  const response = await n.continuation.transition(request)
  expect(response.current.kind).toBe('live')
  expect(first((await f.pool.query<{ state: string; code: string }>('SELECT state,error_code AS code FROM pe_operations WHERE id=$1',
    [n.a.operationId])).rows)).toEqual({ state: 'failed', code: 'turn_blocked' })
}))

test('canonical intent records reject extra fields, noncanonical candidate tokens and mixed cohorts', () => {
  const request = { kind: 'advance', writer: { sessionId: randomUUID(), workerId: randomUUID(), epoch: 1, token: token() },
    transitionId: randomUUID(), candidateToken: token(), expectedEventCount: 4, expectedQueueRevision: 2, expectedNext: null,
    from: { kind: 'turn', operationId: randomUUID(), operationEpoch: 1, operationToken: token(), turn: 1,
      turnStartSeq: 1, turnEndSeq: 3, claimedMessageIds: [randomUUID()] },
    seal: { publisherId: randomUUID(), lastOrdinal: 4, revision: 4 } }
  expect(nativeTurnTransition.safeParse(request).success).toBe(true)
  for (const invalid of [{ ...request, userId: randomUUID() }, { ...request, candidateToken: `${request.candidateToken}=` },
    { ...request, writer: { ...request.writer, userId: randomUUID() } },
    { ...request, from: { ...request.from, claimedMessageIds: [randomUUID(), randomUUID()] } },
    { ...request, expectedNext: { operationId: randomUUID(), messageId: randomUUID(), inputRevision: 2 } },
    { ...request, expectedQueueRevision: -2 }, { ...request, from: { ...request.from, operationEpoch: 2_147_483_648 } }]) {
    expect(nativeTurnTransition.safeParse(invalid).success).toBe(false)
  }
  expect(nativeTransitionId.safeParse('not-an-id').success).toBe(false)
  expect(nativeTurnTransition.safeParse({ kind: 'advance' }).success).toBe(false)
})

test('strict grant serialization preserves all eight trusted input sources and refuses missing source identities', () => turnCase(async (_f, n) => {
  const identity = randomUUID()
  const variants = [
    { source: 'platform_action', sourceActionId: identity, expected: { kind: 'power-evolve-action', actionId: identity } },
    { source: 'sandbox_result', sourceExecutionId: identity, expected: { kind: 'power-evolve-execution', executionId: identity } },
    { source: 'stdio_mcp_result', sourceStdioMcpCallId: identity, expected: { kind: 'power-evolve-stdio-mcp', callId: identity } },
    { source: 'ssh_execute_result', sourceSshExecuteActionId: identity, expected: { kind: 'power-evolve-ssh-execute', actionId: identity } },
    { source: 'remote_mcp_result', sourceMcpActionId: identity, expected: { kind: 'power-evolve-remote-mcp', actionId: identity } },
    { source: 'stdio_v2_result', sourceStdioV2ActionId: identity, sourceStdioV2Phase: 'call',
      expected: { kind: 'power-evolve-stdio-v2-result', actionId: identity, phase: 'call' } },
    { source: 'stdio_v2_no_start', sourceStdioV2NoStartActionId: identity, sourceStdioV2Phase: 'call',
      expected: { kind: 'power-evolve-stdio-v2-no-start', actionId: identity, phase: 'call' } },
  ]
  for (const { expected, ...fields } of variants) {
    const admitted = grant.parse({ ...n.a, ...fields, nativeContent: null })
    expect(nativeInputForTurn(admitted, n.aMessage)).toEqual({ id: n.aMessage, role: 'user', source: expected,
      content: [{ type: 'text', text: n.a.text }] })
    expect(() => nativeInputForTurn(grant.parse({ ...n.a, source: fields.source }), n.aMessage))
      .toThrow('native_turn_source_missing')
  }
  expect(() => nativeInputForTurn(grant.parse({ ...n.a, source: 'stdio_v2_result', sourceStdioV2ActionId: identity }), n.aMessage))
    .toThrow('native_turn_source_missing')
}))

test('preparation retries preserve the pinned message and claimed or settled attempts never become prepared again', () => turnCase(async (f, n) => {
  const before = await state(f)
  expect(await n.continuation.prepare({ writer: n.writer, operationToken: n.a.token, messageId: n.aMessage })).toEqual(n.frame)
  expect(await state(f)).toEqual(before)
  await expect(n.continuation.prepare({ writer: n.writer, operationToken: n.a.token, messageId: randomUUID() }))
    .rejects.toMatchObject({ code: 'native_turn_prepare_conflict' })
  await expect(n.continuation.prepare({})).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(n.continuation.transition({})).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(n.continuation.inspect(n.writer, operationId.parse(randomUUID()), 1)).rejects.toMatchObject({ code: 'native_turn_frame_missing' })
  const advance = await closeA(n)
  expect((await n.continuation.prepare({ writer: n.writer, operationToken: n.a.token, messageId: n.aMessage })).phase).toBe('claimed')
  await n.continuation.transition(advance)
  expect((await n.continuation.inspect(n.writer, n.a.operationId, n.a.epoch)).phase).toBe('settled')
}))

test.each(['event count', 'queue revision', 'message head', 'operation head', 'turn', 'turn start', 'turn end', 'claim identity',
  'publisher', 'ordinal', 'revision', 'writer token', 'operation token'] as const)(
  'a changed %s is rejected without settling A or preparing B', field => turnCase(async (f, n) => {
    const original = await closeA(n)
    if (original.kind !== 'advance' || !original.expectedNext) throw new Error('Expected owned advance fixture')
    const request = { ...original }
    let code = 'native_turn_queue_changed'
    switch (field) {
      case 'event count': request.expectedEventCount++; break
      case 'queue revision': request.expectedQueueRevision++; break
      case 'message head': request.expectedNext = { ...original.expectedNext, messageId: nativeTurnMessageId.parse(randomUUID()) }; break
      case 'operation head': request.expectedNext = { ...original.expectedNext, operationId: operationId.parse(randomUUID()) }; break
      case 'turn': request.from = { ...original.from, turn: 2 }; code = 'native_turn_claim_conflict'; break
      case 'turn start': request.from = { ...original.from, turnStartSeq: original.from.turnStartSeq + 1 }; code = 'native_turn_claim_conflict'; break
      case 'turn end': request.from = { ...original.from, turnEndSeq: original.from.turnEndSeq + 1 }; code = 'native_turn_claim_conflict'; break
      case 'claim identity': request.from = { ...original.from, claimedMessageIds: [nativeTurnMessageId.parse(randomUUID())] }; code = 'native_turn_claim_conflict'; break
      case 'publisher': request.seal = { ...original.seal, publisherId: randomUUID() }; code = 'native_turn_seal_conflict'; break
      case 'ordinal': request.seal = { ...original.seal, lastOrdinal: original.seal.lastOrdinal + 1 }; code = 'native_turn_seal_conflict'; break
      case 'revision': request.seal = { ...original.seal, revision: original.seal.revision + 1 }; code = 'native_turn_seal_conflict'; break
      case 'writer token': request.writer = { ...original.writer, token: token() }; code = 'native_writer_lost'; break
      case 'operation token': request.from = { ...original.from, operationToken: token() }; code = 'lease_lost'; break
    }
    const before = await state(f)
    await expect(n.continuation.transition(request)).rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before)
  }))

test.each(['operation bearer', 'writer bearer', 'historical candidate'] as const)(
  '%s cannot be reused as a candidate', candidate => turnCase(async (f, n) => {
    const original = await closeA(n)
    if (candidate === 'historical candidate') {
      const b = liveGrant(await n.continuation.transition(original))
      const parked = await n.continuation.transition(parkedRequest(n, b, 'preparation_failed')), before = await state(f)
      await expect(n.continuation.transition({ kind: 'activate', writer: n.writer, transitionId: randomUUID(),
        candidateToken: original.candidateToken, expectedNext: original.expectedNext,
        expectedEventCount: parked.receipt.eventCount, expectedQueueRevision: parked.receipt.queueRevision,
        from: { kind: 'parked', transitionId: parked.receipt.transitionId } }))
        .rejects.toMatchObject({ code: 'native_turn_token_conflict' })
      expect(await state(f)).toEqual(before)
    } else {
      const before = await state(f)
      await expect(n.continuation.transition({ ...original, candidateToken: candidate === 'writer bearer' ? n.writer.token : n.a.token }))
        .rejects.toMatchObject({ code: 'native_turn_token_conflict' })
      expect(await state(f)).toEqual(before)
    }
  }))

test.each(['preparation_failed', 'user_cancel'] as const)('unclaimed %s must agree with current cancellation intent', reason => turnCase(async (f, n) => {
  const advance = await closeA(n), b = liveGrant(await n.continuation.transition(advance))
  if (reason === 'preparation_failed') await n.tasks.cancelActive(f.alice.user, n.writer.sessionId, f.alice.token)
  const before = await state(f)
  await expect(n.continuation.transition(parkedRequest(n, b, reason))).rejects.toMatchObject({ code: 'native_turn_cancel_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('an unclaimed but already started preparation cannot be retired or replayed', () => turnCase(async (f, n) => {
  const advance = await closeA(n), b = liveGrant(await n.continuation.transition(advance))
  const event = n.native.append('turn/start', { turn: 2 })
  await n.events.append(b.token, [event])
  const before = await state(f)
  await expect(n.continuation.transition(parkedRequest(n, b, 'preparation_failed'))).rejects.toMatchObject({ code: 'native_turn_already_started' })
  expect(await state(f)).toEqual(before)
}))

test('B closes into C while historical A retries return the original tokenless B receipt', () => turnCase(async (f, n) => {
  const advanceA = await closeA(n), responseA = await n.continuation.transition(advanceA), b = liveGrant(responseA)
  const cRequest = requestId.parse(randomUUID()), cMessage = nativeTurnMessageId.parse(randomUUID())
  await n.tasks.accept(f.alice.user, n.writer.sessionId, cRequest, 'C original input', f.alice.token)
  const cId = operationId.parse(first((await f.pool.query<{ id: string }>(
    'SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2', [n.writer.sessionId, cRequest])).rows).id)
  const cContent = admittedNativeContent.parse(first((await f.pool.query<{ admitted: unknown }>(
    'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [n.writer.sessionId, cRequest])).rows).admitted)
  const suffix = n.native.snapshotEvents().length
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [{ id: cMessage, role: 'user',
    content: cContent, source: { kind: 'user', rpcId: brandString<SessionRequestId>(cRequest) } }] })
  const start = n.native.append('turn/start', { turn: 2 })
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  n.native.append('step/start', { turn: 2, step: 2 })
  n.native.append('user/message', nativeInputForTurn(b, n.bMessage), { surfaceOp: 'append' })
  n.native.append('step/end', { turn: 2, step: 2 })
  const end = n.native.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const seal = await n.publisher.apply(b.token, { version: 1, epoch: b.epoch, publisherId: n.publisherId,
    batchId: randomUUID(), firstOrdinal: 1, items: n.native.snapshotEvents().slice(suffix).map(event => ({ type: 'event', event })) })
  const request = nativeTurnTransition.parse({ kind: 'advance', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: seal.eventCount,
    expectedQueueRevision: n.native.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced')?.seq,
    expectedNext: { operationId: cId, messageId: cMessage, inputRevision: 1 },
    from: { kind: 'turn', operationId: b.operationId, operationEpoch: b.epoch, operationToken: b.token,
      turn: 2, turnStartSeq: start.seq, turnEndSeq: end.seq, claimedMessageIds: [n.bMessage] },
    seal: { publisherId: n.publisherId, lastOrdinal: seal.lastOrdinal, revision: seal.revision } })
  const c = liveGrant(await n.continuation.transition(request)), before = await state(f)
  expect(c).toMatchObject({ operationId: cId, requestId: cRequest, text: 'C original input', epoch: b.epoch + 1 })
  const historical = await n.continuation.transition(advanceA)
  expect(historical.receipt).toEqual(responseA.receipt)
  expect(historical.current).toEqual({ kind: 'expired' })
  expect(JSON.stringify(historical)).not.toContain(c.token)
  expect(JSON.stringify(historical)).not.toContain(b.token)
  expect(await state(f)).toEqual(before)
}))

test('an empty parked result replays without a grant and requires explicit fresh activation after pending input arrives', () => turnCase(async (f, n) => {
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1, inserted: [], outcome: 'canceled' })
  const request = await closeA(n)
  const empty = { ...request, expectedNext: null }
  const response = await n.continuation.transition(empty)
  expect(response.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
  expect(response.current).toEqual({ kind: 'parked' })
  const before = await state(f)
  expect(await n.continuation.transition(empty)).toEqual({ ...response, replayed: true })
  expect(await state(f)).toEqual(before)
  const bContent = admittedNativeContent.parse(first((await f.pool.query<{ admitted: unknown }>(
    'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [n.writer.sessionId, n.bRequest])).rows).admitted)
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: n.bMessage, role: 'user',
    content: bContent, source: { kind: 'user', rpcId: brandString<SessionRequestId>(n.bRequest) } }] })
  // Occupancy authorizes no input append by itself; activate is attempted only after another storage publisher commits the splice.
  const activate = nativeTurnTransition.parse({ kind: 'activate', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: response.receipt.eventCount, expectedQueueRevision: response.receipt.queueRevision,
    expectedNext: request.expectedNext, from: { kind: 'parked', transitionId: response.receipt.transitionId } })
  await expect(n.continuation.transition(activate)).rejects.toMatchObject({ code: 'native_turn_queue_changed' })
  expect(await state(f)).toEqual(before)
}))

test('capacity parks B and a fresh activation prepares the same B after the other Session releases capacity', () => turnCase(async (f, n) => {
  const other = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await n.tasks.accept(f.alice.user, other.sessionId, requestId.parse(randomUUID()), 'capacity occupant', f.alice.token)
  const occupied = await n.tasks.claim(randomUUID())
  if (!occupied || occupied.sessionId !== other.sessionId) throw new Error('Expected other owned Session grant')
  const limited = new NativeTurnContinuation(n.tasks, n.writers, { ...turnLimits, maxActivePerUser: 1 })
  const advance = await closeA(n), response = await limited.transition(advance)
  expect(response.receipt.result).toEqual({ kind: 'parked', reason: 'capacity' })
  expect((await limited.transition(advance)).current).toEqual({ kind: 'parked' })
  if (advance.kind !== 'advance') throw new Error('Expected advance')
  const { seal: _seal, from: _from, kind: _kind, ...common } = advance
  const activate = { ...common, kind: 'activate', from: { kind: 'parked', transitionId: response.receipt.transitionId },
    transitionId: randomUUID(), candidateToken: token() }
  const stillParked = await limited.transition(activate)
  expect(stillParked.receipt.result).toEqual({ kind: 'parked', reason: 'capacity' })
  await n.tasks.finish(occupied.token, 'completed', null)
  const released = { ...activate, transitionId: randomUUID(), candidateToken: token(),
    from: { kind: 'parked', transitionId: stillParked.receipt.transitionId } }
  expect(liveGrant(await limited.transition(released))).toMatchObject({ operationId: n.bId, requestId: n.bRequest })
  const before = await state(f)
  expect((await limited.transition(advance)).current).toEqual({ kind: 'expired' })
  await expect(limited.transition({ ...activate, transitionId: randomUUID(), candidateToken: token() }))
    .rejects.toMatchObject({ code: 'native_turn_source_used' })
  expect(await state(f)).toEqual(before)
}))

test('mixed next-step work and multi-input native claims are explicitly refused', () => turnCase(async (f, n) => {
  n.native.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [nativeInputForTurn(n.a, nativeTurnMessageId.parse(randomUUID()))] })
  const request = await closeA(n), before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_turn_cohort_unsupported' })
  expect(await state(f)).toEqual(before)
}))

test.each(['operation', 'request', 'message', 'writer', 'grant operation', 'grant request', 'grant session', 'grant epoch'] as const)(
  'durable %s metadata disagreement is rejected before grant restoration', field => turnCase(async (f, n) => {
    const column = field.startsWith('grant ') ? 'grant_json' : 'frame_json'
    const key = field === 'operation' || field === 'grant operation' ? 'operationId'
      : field === 'request' || field === 'grant request' ? 'requestId'
        : field === 'message' ? 'messageId' : field === 'writer' ? 'writerEpoch'
          : field === 'grant session' ? 'sessionId' : 'epoch'
    const value = field === 'writer' ? n.writer.epoch + 1 : field === 'grant epoch' ? n.a.epoch + 1 : randomUUID()
    await f.pool.query(`UPDATE pe_native_turn_frames SET ${column}=jsonb_set(${column},$2,$3::jsonb) WHERE operation_id=$1`,
      [n.a.operationId, [key], JSON.stringify(value)])
    const before = await state(f)
    await expect(n.continuation.inspect(n.writer, n.a.operationId, n.a.epoch)).rejects.toMatchObject({ code: 'native_turn_frame_corrupt' })
    expect(await state(f)).toEqual(before)
  }))

test.each(['sessionId', 'writerEpoch', 'transitionId'] as const)('durable receipt %s mismatch is rejected under live Writer authority', field => turnCase(async (f, n) => {
  const request = await closeA(n)
  await n.continuation.transition(request)
  await f.pool.query('UPDATE pe_native_turn_transitions SET receipt_json=jsonb_set(receipt_json,$2,$3::jsonb) WHERE transition_id=$1',
    [request.transitionId, [field], JSON.stringify(field === 'writerEpoch' ? n.writer.epoch + 1 : randomUUID())])
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_turn_receipt_corrupt' })
  expect(await state(f)).toEqual(before)
}))

test('account revocation prevents historical receipt lookup despite retained Writer and candidate credentials', () => turnCase(async (f, n) => {
  const request = await closeA(n)
  await n.continuation.transition(request)
  await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId])
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ status: 401 })
  expect(await state(f)).toEqual(before)
}))

test.each(['event count', 'event bytes', 'header identity', 'missing row', 'SQL sequence', 'native sequence', 'actual bytes'] as const)(
  'native history rejects %s corruption or exceeded budget', field => turnCase(async (f, n) => {
    await closeA(n)
    const limits = { ...turnLimits }
    let code = 'native_turn_history_gap'
    switch (field) {
      case 'event count': limits.maxHistoryEvents = 1; code = 'native_turn_history_budget'; break
      case 'event bytes': limits.maxHistoryBytes = 1; code = 'native_turn_history_budget'; break
      case 'header identity':
        await f.pool.query("UPDATE pe_sessions SET header=jsonb_set(header,'{id}',$2::jsonb) WHERE id=$1", [n.writer.sessionId, JSON.stringify(randomUUID())])
        code = 'native_turn_history_budget'; break
      case 'missing row': await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=1', [n.writer.sessionId]); break
      case 'SQL sequence': await f.pool.query('UPDATE pe_events SET seq=999 WHERE session_id=$1 AND seq=0', [n.writer.sessionId]); break
      case 'native sequence': await f.pool.query("UPDATE pe_events SET event=jsonb_set(event::jsonb,'{seq}','999'::jsonb) WHERE session_id=$1 AND seq=0", [n.writer.sessionId]); break
      case 'actual bytes':
        await f.pool.query('UPDATE pe_sessions SET event_bytes=0 WHERE id=$1', [n.writer.sessionId])
        limits.maxHistoryBytes = 50; code = 'native_turn_history_budget'; break
    }
    const before = await state(f)
    await expect(new NativeTurnContinuation(n.tasks, n.writers, limits).inspect(n.writer, n.a.operationId, n.a.epoch))
      .rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before)
  }))

test.each(['nested turn', 'orphan end', 'wrong end', 'claim outside turn', 'replacement claim', 'duplicate claim'] as const)(
  'native history rejects %s', field => turnCase(async (f, n) => {
    let code = 'native_turn_history_unbalanced'
    switch (field) {
      case 'nested turn': n.native.append('turn/start', { turn: 1 }); n.native.append('turn/start', { turn: 2 }); break
      case 'orphan end': n.native.append('turn/end', { turn: 1, reason: { kind: 'blocked' } }); break
      case 'wrong end': n.native.append('turn/start', { turn: 1 }); n.native.append('turn/end', { turn: 2, reason: { kind: 'blocked' } }); break
      case 'claim outside turn':
        n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
        code = 'native_turn_claim_invalid'; break
      case 'replacement claim':
        n.native.append('turn/start', { turn: 1 })
        n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1,
          inserted: [nativeInputForTurn(n.a, nativeTurnMessageId.parse(randomUUID()))] })
        code = 'native_turn_claim_invalid'; break
      case 'duplicate claim':
        n.native.append('turn/start', { turn: 1 })
        n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
        n.native.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
        n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [nativeInputForTurn(n.a, n.aMessage)] })
        n.native.append('turn/start', { turn: 2 })
        n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
        code = 'native_turn_input_replayed'; break
    }
    await n.events.append(n.a.token, n.native.snapshotEvents())
    const before = await state(f)
    await expect(n.continuation.inspect(n.writer, n.a.operationId, n.a.epoch)).rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before)
  }))

test.each(['unclaimed', 'open turn', 'unaccounted completed', 'mixed cohort'] as const)(
  '%s cannot settle native consumed work', field => turnCase(async (f, n) => {
    let code = 'native_turn_not_claimed'
    if (field !== 'unclaimed') {
      n.native.append('turn/start', { turn: 1 })
      n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: field === 'mixed cohort' ? 2 : 1, inserted: [] })
      if (field !== 'open turn') n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      code = field === 'open turn' ? 'native_turn_not_closed' : field === 'mixed cohort' ? 'native_turn_cohort_unsupported' : 'native_turn_unaccounted'
    }
    await n.events.append(n.a.token, n.native.snapshotEvents())
    await transaction(f.pool, async (client) => {
      await n.writers.requireInTransaction(client, n.writer)
      const history = await readNativeTurnHistory(client, n.writer.sessionId, turnLimits)
      expect(() => closedNativeTurn(history, n.aMessage)).toThrow(code)
    })
  }))

test('a persisted multi-input claim is rejected by frame reconciliation', () => turnCase(async (f, n) => {
  n.native.append('turn/start', { turn: 1 })
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 2, inserted: [] })
  await n.events.append(n.a.token, n.native.snapshotEvents())
  const before = await state(f)
  await expect(n.continuation.inspect(n.writer, n.a.operationId, n.a.epoch)).rejects.toMatchObject({ code: 'native_turn_cohort_unsupported' })
  expect(await state(f)).toEqual(before)
}))

test.each(['missing frame', 'expired writer', 'different worker', 'different digest', 'cancellation', 'expired operation'] as const)(
  'production execution authority rejects %s after an actual committed step', field => turnCase(async (f, n) => {
    await openStep(n)
    let code = 'native_turn_execution_fenced'
    switch (field) {
      case 'missing frame': await f.pool.query('DELETE FROM pe_native_turn_frames WHERE operation_id=$1', [n.a.operationId]); code = 'native_turn_frame_missing'; break
      case 'expired writer': await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.writer.sessionId]); break
      case 'different worker': await f.pool.query('UPDATE pe_attempts SET worker_id=$2 WHERE operation_id=$1', [n.a.operationId, randomUUID()]); break
      case 'different digest': await f.pool.query('UPDATE pe_native_turn_frames SET grant_digest=$2 WHERE operation_id=$1', [n.a.operationId, digest(token())]); break
      case 'cancellation': await n.tasks.cancelActive(f.alice.user, n.writer.sessionId, f.alice.token); break
      case 'expired operation': await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.writer.sessionId]); code = 'lease_lost'; break
    }
    const before = await state(f)
    await expect(transaction(f.pool, client => n.tasks.executionAuthorized(client, n.a.token))).rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before)
  }))

test('production execution authority distinguishes an open step from missing original user content or a step gap', () => turnCase(async (f, n) => {
  n.native.append('turn/start', { turn: 1 })
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  n.native.append('step/start', { turn: 1, step: 1 })
  await n.events.append(n.a.token, n.native.snapshotEvents())
  const gate = () => transaction(f.pool, client => n.tasks.executionAuthorized(client, n.a.token))
  await expect(gate()).rejects.toMatchObject({ code: 'native_turn_execution_unclaimed' })
  const wrong = n.native.append('user/message', nativeInputForTurn(n.a, nativeTurnMessageId.parse(randomUUID())), { surfaceOp: 'append' })
  await n.events.append(n.a.token, [wrong])
  await expect(gate()).rejects.toMatchObject({ code: 'native_turn_execution_unclaimed' })
  const original = n.native.append('user/message', nativeInputForTurn(n.a, n.aMessage), { surfaceOp: 'append' })
  await n.events.append(n.a.token, [original])
  await expect(gate()).resolves.toMatchObject({ operation_id: n.a.operationId })
  const end = n.native.append('step/end', { turn: 1, step: 1 })
  await n.events.append(n.a.token, [end])
  await expect(gate()).rejects.toMatchObject({ code: 'native_turn_execution_unclaimed' })
}))

test.each(['claimed without native claim', 'retired with native claim', 'settled with different end'] as const)(
  'persisted frame phase %s cannot invent or erase native consumption', field => turnCase(async (f, n) => {
    let code = 'native_turn_claim_missing'
    if (field !== 'claimed without native claim') await closeA(n)
    const claim = { turn: 1, turnStartSeq: 1, claimSeq: 2, turnEndSeq: null }
    const frame = field === 'claimed without native claim' ? { ...n.frame, phase: 'claimed', claim }
      : field === 'retired with native claim' ? { ...n.frame, phase: 'retired', reason: 'preparation_failed', eventCount: 0, requeued: true }
        : { ...n.frame, phase: 'settled', claim: { ...claim, turnEndSeq: 999 }, outcome: 'completed', errorCode: null }
    if (field === 'retired with native claim') code = 'native_turn_claim_conflict'
    if (field === 'settled with different end') code = 'native_turn_frame_corrupt'
    await f.pool.query('UPDATE pe_native_turn_frames SET frame_json=$2 WHERE operation_id=$1', [n.a.operationId, JSON.stringify(frame)])
    const before = await state(f)
    await expect(n.continuation.inspect(n.writer, n.a.operationId, n.a.epoch)).rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before)
  }))

test.each(['frame digest', 'saved grant', 'retired phase'] as const)(
  'historical live B receipt rejects changed %s', field => turnCase(async (f, n) => {
    const request = await closeA(n), b = liveGrant(await n.continuation.transition(request))
    if (field === 'frame digest') await f.pool.query('UPDATE pe_native_turn_frames SET grant_digest=$2 WHERE operation_id=$1', [b.operationId, digest(token())])
    if (field === 'saved grant') await f.pool.query("UPDATE pe_native_turn_frames SET grant_json=jsonb_set(grant_json,'{text}','\"changed B\"'::jsonb) WHERE operation_id=$1", [b.operationId])
    if (field === 'retired phase') await f.pool.query(`UPDATE pe_native_turn_frames SET frame_json=frame_json||
      '{"phase":"retired","reason":"preparation_failed","eventCount":8,"requeued":true}'::jsonb WHERE operation_id=$1`, [b.operationId])
    const before = await state(f)
    await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_turn_receipt_corrupt' })
    expect(await state(f)).toEqual(before)
  }))

test('exact operation epoch cannot overflow while settling A and preparing B', () => cloudFixture(async (f) => {
  await diagnosticSchema(f)
  const n = await prepare(f, f.alice, 2_147_483_647), request = await closeA(n), before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_turn_epoch' })
  expect(await state(f)).toEqual(before)
}))

test('a current operation whose exact attempt already ended cannot prepare another input', () => turnCase(async (f, n) => {
  await f.pool.query('UPDATE pe_attempts SET ended_at=clock_timestamp() WHERE operation_id=$1', [n.a.operationId])
  const before = await state(f)
  await expect(n.continuation.prepare({ writer: n.writer, operationToken: n.a.token, messageId: n.aMessage }))
    .rejects.toMatchObject({ code: 'lease_lost' })
  expect(await state(f)).toEqual(before)
}))

test('operation attempts must belong to the exact current Writer worker', () => turnCase(async (f, n) => {
  await f.pool.query('UPDATE pe_attempts SET worker_id=$2 WHERE operation_id=$1', [n.a.operationId, randomUUID()])
  const before = await state(f)
  await expect(n.continuation.prepare({ writer: n.writer, operationToken: n.a.token, messageId: n.aMessage }))
    .rejects.toMatchObject({ code: 'native_turn_worker_conflict' })
  expect(await state(f)).toEqual(before)
}))

test.each([false, true])('an aborted consumed turn preserves the actual cancellation disposition: %s', cancelled => turnCase(async (f, n) => {
  if (cancelled) await n.tasks.cancelActive(f.alice.user, n.writer.sessionId, f.alice.token)
  const request = await closeA(n, 'aborted')
  await n.continuation.transition(request)
  expect(first((await f.pool.query<{ state: string; code: string }>('SELECT state,error_code AS code FROM pe_operations WHERE id=$1',
    [n.a.operationId])).rows)).toEqual({ state: 'failed', code: cancelled ? 'turn_user' : 'turn_aborted' })
}))

test.each(['accepted pending content', 'claimed content', 'claim before preparation', 'frame writer', 'frame bearer'] as const)(
  'advance refuses changed %s and rolls back all settlement', field => turnCase(async (f, n) => {
    const request = await closeA(n)
    let code = 'native_turn_claim_conflict'
    switch (field) {
      case 'accepted pending content':
        await f.pool.query("UPDATE pe_events SET event=jsonb_set(event::jsonb,'{data,inserted,1,content}',$2::jsonb) WHERE session_id=$1 AND seq=0",
          [n.writer.sessionId, JSON.stringify(n.a.nativeContent)])
        code = 'native_turn_input_changed'; break
      case 'claimed content':
        await f.pool.query("UPDATE pe_events SET event=jsonb_set(event::jsonb,'{data,inserted,0,content}','[{\"type\":\"text\",\"text\":\"changed A\"}]'::jsonb) WHERE session_id=$1 AND seq=0",
          [n.writer.sessionId]); break
      case 'claim before preparation': await f.pool.query('UPDATE pe_native_turn_frames SET prepared_event_count=999 WHERE operation_id=$1', [n.a.operationId]); break
      case 'frame writer':
        await f.pool.query("UPDATE pe_native_turn_frames SET writer_epoch=$2,frame_json=jsonb_set(frame_json,'{writerEpoch}',$3::jsonb) WHERE operation_id=$1",
          [n.a.operationId, n.writer.epoch + 1, JSON.stringify(n.writer.epoch + 1)])
        code = 'native_turn_frame_conflict'; break
      case 'frame bearer': await f.pool.query('UPDATE pe_native_turn_frames SET grant_digest=$2 WHERE operation_id=$1', [n.a.operationId, digest(token())]); code = 'native_turn_frame_conflict'; break
    }
    const before = await state(f)
    await expect(n.continuation.transition(request)).rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before)
  }))

test('a historical prepared input cannot acquire a different message identity on a later attempt', () => turnCase(async (f, n) => {
  const advance = await closeA(n), b = liveGrant(await n.continuation.transition(advance))
  const parked = await n.continuation.transition(parkedRequest(n, b, 'preparation_failed'))
  const changed = nativeTurnMessageId.parse(randomUUID())
  await f.pool.query("UPDATE pe_events SET event=jsonb_set(event::jsonb,'{data,inserted,1,id}',$2::jsonb) WHERE session_id=$1 AND seq=0",
    [n.writer.sessionId, JSON.stringify(changed)])
  const before = await state(f)
  const activate = { kind: 'activate', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: parked.receipt.eventCount, expectedQueueRevision: parked.receipt.queueRevision,
    expectedNext: { operationId: n.bId, messageId: changed, inputRevision: 1 }, from: { kind: 'parked', transitionId: parked.receipt.transitionId } }
  await expect(n.continuation.transition(activate)).rejects.toMatchObject({ code: 'native_turn_input_identity_conflict' })
  expect(await state(f)).toEqual(before)
}))

test('a real B frame lock extending beyond B expiry returns no bearer on historical replay', () => turnCase(async (f, n) => {
  const request = await closeA(n), original = await n.continuation.transition(request), b = liveGrant(original)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [n.writer.sessionId])
  const before = await state(f), lock = await f.pool.connect()
  let pending: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query('SELECT operation_id FROM pe_native_turn_frames WHERE operation_id=$1 FOR UPDATE', [b.operationId])
    const retry = n.continuation.transition(request)
    pending = retry
    await waitBlocked(f, 'FROM pe_native_turn_frames WHERE operation_id=')
    await clockExpired(lock, 'pe_sessions', n.writer.sessionId)
    await lock.query('COMMIT')
    const response = await retry
    expect(response.current).toEqual({ kind: 'expired' })
    expect(response.receipt).toEqual(original.receipt)
    expect(JSON.stringify(response)).not.toContain(b.token)
    expect(await state(f)).toEqual(before)
  } finally {
    await lock.query('ROLLBACK')
    await pending?.catch((_retained: unknown) => undefined)
    lock.release()
  }
}))

test('a newly issued B expiring during a real frame insertion lock rolls back the entire A to B transition', () => turnCase(async (f, n) => {
  const request = await closeA(n), before = await state(f), lock = await f.pool.connect()
  const short = new NativeTurnContinuation(n.tasks, n.writers, { ...turnLimits, leaseMs: 1000 })
  await insertBarrier(f, 'pe_native_turn_frames')
  let pending: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query('SELECT pg_advisory_xact_lock(607,6)')
    const advance = short.transition(request)
    pending = advance
    const outcome = advance.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, value: error }))
    await waitBlocked(f, 'INSERT INTO pe_native_turn_frames')
    await lock.query('SELECT pg_sleep(1.2)')
    await lock.query('COMMIT')
    const response = await outcome
    expect(response.ok).toBe(false)
    expect(response.value).toMatchObject({ code: 'native_turn_fence_expired' })
    expect(await state(f)).toEqual(before)
  } finally {
    await lock.query('ROLLBACK')
    await pending?.catch((_retained: unknown) => undefined)
    lock.release()
  }
}))

test.each(['empty heartbeat', 'active private attempt', 'awaiting step end'] as const)(
  'unclaimed retirement handles %s under the exact original epoch', field => turnCase(async (f, n) => {
    const advance = await closeA(n), b = liveGrant(await n.continuation.transition(advance))
    await n.publisher.apply(b.token, { version: 1, epoch: b.epoch, publisherId: n.publisherId, batchId: randomUUID(),
      firstOrdinal: 1, items: field === 'active private attempt' ? [{ type: 'assistant-stream',
        frame: { type: 'start', attemptId: randomUUID(), revision: 1, turn: 2, step: 2 } }] : [] })
    if (field === 'awaiting step end') await f.pool.query(`UPDATE pe_native_presentations
      SET state_json=jsonb_set(state_json::jsonb,'{awaitingStepEnd}','{"turn":2,"step":2}'::jsonb) WHERE session_id=$1`, [n.writer.sessionId])
    const request = parkedRequest(n, b, 'preparation_failed'), before = await state(f)
    if (field === 'empty heartbeat') {
      await n.continuation.transition(request)
      expect((await f.pool.query('SELECT * FROM pe_native_presentations')).rows).toEqual([])
    } else {
      await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: 'native_turn_already_started' })
      expect(await state(f)).toEqual(before)
    }
  }))

test.each(['missing', 'expired'] as const)('publisher %s cannot seal a closed native turn', field => turnCase(async (f, n) => {
  const request = await closeA(n)
  if (field === 'missing') await f.pool.query('DELETE FROM pe_native_presentations WHERE session_id=$1', [n.writer.sessionId])
  else await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.writer.sessionId])
  const before = await state(f)
  await expect(n.continuation.transition(request)).rejects.toMatchObject({
    code: field === 'missing' ? 'native_turn_seal_missing' : 'native_assistant_expired' })
  expect(await state(f)).toEqual(before)
}))

test('activation requires an existing parked receipt and cannot use the original prepared result as an idle source', () => turnCase(async (f, n) => {
  const advance = await closeA(n), response = await n.continuation.transition(advance)
  const common = { kind: 'activate', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: response.receipt.eventCount, expectedQueueRevision: response.receipt.queueRevision,
    expectedNext: advance.expectedNext }
  const before = await state(f)
  for (const id of [randomUUID(), response.receipt.transitionId]) {
    await expect(n.continuation.transition({ ...common, from: { kind: 'parked', transitionId: id } }))
      .rejects.toMatchObject({ code: 'native_turn_parked_missing' })
  }
  expect(await state(f)).toEqual(before)
}))

test('current execution authority prevents activation of a parked receipt whose grant pointer was restored elsewhere', () => turnCase(async (f, n) => {
  const advance = await closeA(n), b = liveGrant(await n.continuation.transition(advance))
  const response = await n.continuation.transition(parkedRequest(n, b, 'preparation_failed'))
  await f.pool.query("UPDATE pe_sessions SET grant_digest=$2,lease_until=clock_timestamp()+interval '10 seconds' WHERE id=$1",
    [n.writer.sessionId, digest(token())])
  const before = await state(f)
  await expect(n.continuation.transition({ kind: 'activate', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: response.receipt.eventCount, expectedQueueRevision: response.receipt.queueRevision,
    expectedNext: advance.expectedNext,
    from: { kind: 'parked', transitionId: response.receipt.transitionId } })).rejects.toMatchObject({ code: 'native_turn_not_parked' })
  expect(await state(f)).toEqual(before)
}))

test.each(['pe_native_turn_frames', 'pe_native_turn_transitions'] as const)(
  'cross-account candidate collision while %s inserts are held rolls back the losing transition', table => cloudFixture(async (f) => {
    await diagnosticSchema(f)
    const alice = await prepare(f), bob = await prepare(f, f.bob)
    if (table === 'pe_native_turn_transitions') for (const n of [alice, bob]) {
      n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1, inserted: [], outcome: 'canceled' })
    }
    const candidateToken = token()
    const requests = await Promise.all([alice, bob].map(async n => ({ ...await closeA(n), candidateToken,
      ...table === 'pe_native_turn_transitions' ? { expectedNext: null } : {} })))
    await insertBarrier(f, table)
    const lock = await f.pool.connect(), pending: Promise<unknown>[] = []
    try {
      await lock.query('BEGIN')
      await lock.query('SELECT pg_advisory_xact_lock(607,6)')
      const outcomes = [alice, bob].map((n, index) => {
        const request = first(requests.slice(index, index + 1))
        const call = n.continuation.transition(request)
        pending.push(call)
        return call.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, value: error }))
      })
      await waitBlocked(f, table === 'pe_native_turn_frames' ? 'pe_' : `INSERT INTO ${table}`, 2)
      await lock.query('COMMIT')
      const results = await Promise.all(outcomes)
      expect(results.map(result => result.ok).sort()).toEqual([false, true])
      expect(results.find(result => !result.ok)?.value).toMatchObject({ code: 'native_turn_token_conflict' })
      expect((await f.pool.query('SELECT * FROM pe_native_turn_transitions')).rows).toHaveLength(1)
      expect((await f.pool.query("SELECT * FROM pe_operations WHERE state='completed'")).rows).toHaveLength(1)
      expect((await f.pool.query('SELECT * FROM pe_native_writers')).rows).toHaveLength(2)
    } finally {
      await lock.query('ROLLBACK')
      await Promise.all(pending.map(call => call.catch((_retained: unknown) => undefined)))
      lock.release()
    }
  }))

test('operation authority and frame inspection are bound to the exact Writer Session and epoch', () => cloudFixture(async (f) => {
  await diagnosticSchema(f)
  const alice = await prepare(f), bob = await prepare(f, f.bob), before = await state(f)
  await expect(alice.continuation.prepare({ writer: alice.writer, operationToken: bob.a.token, messageId: bob.aMessage }))
    .rejects.toMatchObject({ code: 'native_turn_operation_conflict' })
  await expect(alice.continuation.inspect(alice.writer, bob.a.operationId, bob.a.epoch))
    .rejects.toMatchObject({ code: 'native_turn_frame_conflict' })
  expect(await state(f)).toEqual(before)
}))

test.each(['operation', 'epoch'] as const)('the closed turn %s must match the actual operation bearer', field => turnCase(async (f, n) => {
  const request = await closeA(n)
  if (request.kind !== 'advance') throw new Error('Expected advance')
  const from = { ...request.from, ...field === 'operation' ? { operationId: operationId.parse(randomUUID()) }
    : { operationEpoch: request.from.operationEpoch + 1 } }
  const before = await state(f)
  await expect(n.continuation.transition({ ...request, from })).rejects.toMatchObject({ code: 'native_turn_operation_conflict' })
  expect(await state(f)).toEqual(before)
}))

test.each([false, true])('expiry during a real original attempt lock rolls back %s successor selection', empty => turnCase(async (f, n) => {
  if (empty) n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1, inserted: [], outcome: 'canceled' })
  const original = await closeA(n), request = { ...original, ...empty ? { expectedNext: null } : {} }
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [n.writer.sessionId])
  const before = await state(f), lock = await f.pool.connect()
  let pending: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query('SELECT id FROM pe_operations WHERE id=$1 FOR UPDATE', [n.a.operationId])
    const call = n.continuation.transition(request)
    pending = call
    const outcome = call.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, value: error }))
    await waitBlocked(f, 'FOR UPDATE OF o,a')
    await clockExpired(lock, 'pe_sessions', n.writer.sessionId)
    await lock.query('COMMIT')
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(result.value).toMatchObject({ code: 'lease_lost' })
    expect(await state(f)).toEqual(before)
  } finally {
    await lock.query('ROLLBACK')
    await pending?.catch((_retained: unknown) => undefined)
    lock.release()
  }
}))

test('an expired ordinarily reclaimed operation cannot replay its already consumed native input', () => turnCase(async (f, n) => {
  await closeA(n, 'blocked')
  await n.writers.release(n.writer)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.writer.sessionId])
  const workerId = nativeWriterWorkerId.parse(randomUUID()), reclaimed = await n.tasks.claim(workerId)
  if (!reclaimed || reclaimed.operationId !== n.a.operationId) throw new Error('Expected actual original operation recovery grant')
  const identity = { sessionId: reclaimed.sessionId, workerId, token: token() }
  const acquired = await n.writers.acquire(reclaimed.token, identity)
  const writer = nativeWriterIdentity.parse({ ...identity, epoch: acquired.epoch }), before = await state(f)
  await expect(n.continuation.prepare({ writer, operationToken: reclaimed.token, messageId: n.aMessage }))
    .rejects.toMatchObject({ code: 'native_turn_input_replayed' })
  expect(await state(f)).toEqual(before)
}))

test('empty activation has its own immutable parked receipt and a pending head cannot be reported as empty', () => turnCase(async (f, n) => {
  const request = await closeA(n), before = await state(f)
  await expect(n.continuation.transition({ ...request, expectedNext: null })).rejects.toMatchObject({ code: 'native_turn_queue_changed' })
  expect(await state(f)).toEqual(before)
  const canceled = n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  await n.publisher.apply(n.a.token, { version: 1, epoch: n.a.epoch, publisherId: n.publisherId, batchId: randomUUID(),
    firstOrdinal: n.native.snapshotEvents().length, items: [{ type: 'event', event: canceled }] })
  const parked = await n.continuation.transition({ ...request, expectedNext: null,
    expectedEventCount: n.native.snapshotEvents().length, expectedQueueRevision: canceled.seq,
    seal: { publisherId: n.publisherId, lastOrdinal: n.native.snapshotEvents().length, revision: 0 } })
  const response = await n.continuation.transition({ kind: 'activate', writer: n.writer, transitionId: randomUUID(), candidateToken: token(),
    expectedEventCount: parked.receipt.eventCount, expectedQueueRevision: parked.receipt.queueRevision, expectedNext: null,
    from: { kind: 'parked', transitionId: parked.receipt.transitionId } })
  expect(response.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
  expect(response.current).toEqual({ kind: 'parked' })
  expect((await f.pool.query('SELECT * FROM pe_attempts WHERE operation_id=$1', [n.bId])).rows).toEqual([])
}))

test.each(['pe_native_turn_frames', 'pe_native_turn_transitions'] as const)(
  'a PostgreSQL insertion failure in %s propagates and rolls back all preceding writes', table => turnCase(async (f, n) => {
    const request = await closeA(n), before = await state(f)
    await f.pool.query(`CREATE FUNCTION owned_turn_insert_failure() RETURNS trigger LANGUAGE plpgsql AS
      $body$ BEGIN RAISE EXCEPTION 'Owned fixture serialization failure' USING ERRCODE='40001'; END $body$`)
    await f.pool.query(`CREATE TRIGGER owned_turn_insert_failure BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION owned_turn_insert_failure()`)
    await expect(n.continuation.transition(request)).rejects.toMatchObject({ code: '40001' })
    expect(await state(f)).toEqual(before)
  }))

test('retiring the original operation during its real authorization lock refuses a successor without changing native state', () => turnCase(async (f, n) => {
  const request = await closeA(n), before = await state(f), lock = await f.pool.connect()
  let pending: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query("UPDATE pe_operations SET state='failed',error_code='turn_user' WHERE id=$1", [n.a.operationId])
    const call = n.continuation.transition(request)
    pending = call
    const outcome = call.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, value: error }))
    await waitBlocked(f, 'FOR UPDATE OF o,a')
    await lock.query('COMMIT')
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(result.value).toMatchObject({ code: 'lease_lost' })
    const after = await state(f)
    expect(after).toEqual({ ...before, operations: before.operations.map(row => row.id === n.a.operationId
      ? { ...row, state: 'failed', error_code: 'turn_user' } : row) })
  } finally {
    await lock.query('ROLLBACK')
    await pending?.catch((_retained: unknown) => undefined)
    lock.release()
  }
}))
