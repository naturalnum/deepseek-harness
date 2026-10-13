/** Actual private PG journal, original publication provider and late final-fence crash windows. */
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { nativeInputRecordDigest } from '../src/native-input-ledger-records.ts'
import { headerSchema } from '../src/session-records.ts'
import { EventStore } from '../src/platform/events.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeRetainedIntentStore, type NativeRetainedIntentLimits } from '../src/platform/native-retained-intent-store.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativePreparedCancel } from '../src/platform/native-prepared-cancel.ts'
import { NativeArchiveInputCancel } from '../src/platform/native-archive-input.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { transaction } from '../src/platform/database.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { nativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { retainedNativeFacts } from './native-retained-intent-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const taskLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const assistantLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000,
  maxEventBytes: taskLimits.maxEventBytes }
const journalLimits = { maxRequestBytes: 1_048_576, maxPendingPerSession: 4,
  maxRecordsPerSession: 8, maxRetainedBytesPerSession: 4_194_304 }
const inputLimits = { maxEventBytes: taskLimits.maxEventBytes, maxHistoryEvents: taskLimits.maxHistoryEvents,
  maxHistoryBytes: taskLimits.maxHistoryBytes, maxAcceptedAuditBytes: 2_097_152,
  maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }

async function setup(f: Fixture) {
  const workerId = randomUUID(), key = randomBytes(32).toString('base64url')
  const tasks = new TaskStore(f.pool, taskLimits), events = new EventStore(tasks, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'retained publication fixture', f.alice.token)
  const grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Expected the actual retained publication grant')
  const header = headerSchema.parse((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [grant.sessionId])).rows[0]?.header)
  const native = Session.create(header.id, undefined, header)
  const publication = new NativeAssistantStore(tasks, events, assistantLimits)
  const writers = new NativeSessionWriter(tasks, { leaseMs: 30_000 })
  const frames = new NativeExecutionFrames(tasks, writers, { maxHistoryEvents: inputLimits.maxHistoryEvents,
    maxHistoryBytes: inputLimits.maxHistoryBytes, maxFrameBytes: 2_097_152, maxCohortInputs: inputLimits.maxCohortInputs })
  const verifier: ConstructorParameters<typeof NativeInputLedger>[4] = (client, request) => frames.verifyInTransaction(client, request)
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits, verifier)
  const config = { input: inputLimits, presentation: assistantLimits }
  const input = new NativeInputCommit(tasks, ledger, frames, publication, writers, config)
  const preparedCancel = new NativePreparedCancel(tasks, ledger, frames, publication, writers, config)
  const archiveCancel = new NativeArchiveInputCancel(tasks, ledger, frames, publication, writers, config)
  const turn = new NativeTurnContinuationV2(tasks, writers, verifier,
    { ...inputLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser, assistant: assistantLimits }, frames)
  const make = (limits: NativeRetainedIntentLimits) => new NativeRetainedIntentStore(tasks, writers,
    { publication, input, preparedCancel, archiveCancel, turn }, key, limits)
  const fresh = () => make(journalLimits)
  const prepare = { version: 1 as const, workerId, mutation: { family: 'publication' as const,
    request: { version: 1 as const, batchId: randomUUID(), publisherId: randomUUID(), epoch: grant.epoch,
      firstOrdinal: 1, items: [{ type: 'event' as const, event: native.append('turn/start', { turn: 1 }) }] } } }
  return { workerId, key, tasks, writers, grant, publication, prepare, fresh, make }
}
async function facts(f: Fixture) {
  const tables = ['pe_sessions', 'pe_operations', 'pe_attempts', 'pe_events', 'pe_native_writers',
    'pe_native_presentations', 'pe_native_presentation_entries', 'pe_native_turn_frames',
    'pe_native_input_commands', 'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_input_revisions',
    'pe_native_turn_transitions_v2'] as const
  const result: Record<string, Array<Record<string, unknown>>> = {}
  for (const table of tables) result[table] = (await f.pool.query<Record<string, unknown>>(
    `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows
  return result
}
async function journal(f: Fixture) {
  return (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_retained_intents ORDER BY intent_id')).rows
}

test('durable prepare seals the whole original publication before mutation and rejects a changed same-batch intent', () => cloudFixture(async (f) => {
  const n = await setup(f), store = n.fresh(), before = await facts(f)
  const prepared = await store.prepare(n.grant.token, n.prepare)
  expect(prepared).toMatchObject({ family: 'publication', state: 'prepared' })
  expect(await facts(f)).toEqual(before)
  const retained = await journal(f)
  expect(await store.prepare(n.grant.token, structuredClone(n.prepare))).toEqual(prepared)
  expect(await journal(f)).toEqual(retained)
  const sealed = (await f.pool.query<{ sealed: Buffer }>('SELECT request_sealed AS sealed FROM pe_native_retained_intents')).rows[0]?.sealed
  if (!sealed) throw new Error('Expected actual private ciphertext')
  expect(sealed.includes(Buffer.from(n.grant.token))).toBe(false)
  await expect(store.prepare(n.grant.token, { ...n.prepare, mutation: { ...n.prepare.mutation,
    request: { ...n.prepare.mutation.request, firstOrdinal: 2 } } })).rejects.toMatchObject({ status: 409, code: 'native_intent_conflict' })
  await expect(n.publication.apply(n.grant.token, n.prepare.mutation.request)).rejects.toMatchObject({ code: 'native_intent_pending' })
  expect(await facts(f)).toEqual(before)
  expect(await journal(f)).toEqual(retained)
}))

test('an actual journal ACK write failure rolls back native publication and every journal result', () => cloudFixture(async (f) => {
  const n = await setup(f), store = n.fresh()
  const prepared = await store.prepare(n.grant.token, n.prepare)
  const before = await facts(f), retained = await journal(f)
  await f.pool.query(`CREATE FUNCTION pe_test_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state='committed' THEN RAISE EXCEPTION 'owned retained ACK failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER pe_test_ack_failure BEFORE UPDATE ON pe_native_retained_intents
      FOR EACH ROW EXECUTE FUNCTION pe_test_ack_failure()`)
  await expect(store.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId }))
    .rejects.toMatchObject({ message: 'owned retained ACK failure' })
  expect(await facts(f)).toEqual(before)
  expect(await journal(f)).toEqual(retained)
  await f.pool.query('DROP TRIGGER pe_test_ack_failure ON pe_native_retained_intents; DROP FUNCTION pe_test_ack_failure()')
  const committed = await store.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId })
  expect(committed.family).toBe('publication')
  expect((await journal(f))[0]?.state).toBe('committed')
  expect((await f.pool.query('SELECT seq FROM pe_events')).rowCount).toBe(1)
}))

test('lost reply and a new store read the original tokenless ACK after actual expiry and resolve only matching synchronized results', () => cloudFixture(async (f) => {
  const n = await setup(f), store = n.fresh()
  const prepared = await store.prepare(n.grant.token, n.prepare)
  const execute = { version: 1 as const, workerId: n.workerId, intentId: prepared.intentId }
  const original = await store.execute(n.grant.token, execute)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
  const before = await facts(f), retained = await journal(f)
  expect(await n.fresh().execute(n.grant.token, execute)).toEqual(original)
  const reconciled = await n.fresh().reconcile({ version: 1, workerId: n.workerId, limit: 4 })
  expect(reconciled.items[0]?.outcome).toEqual({ state: 'committed', receipt: original, retired: true })
  expect(await facts(f)).toEqual(before)
  expect(await journal(f)).toEqual(retained)
  expect(JSON.stringify(reconciled)).not.toContain(n.grant.token)
  await expect(n.fresh().resolve({ ...execute, receiptDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'native_intent_receipt_conflict' })
  expect(await journal(f)).toEqual(retained)
  const receiptDigest = nativeInputRecordDigest(original)
  expect(await n.fresh().resolve({ ...execute, receiptDigest }))
    .toEqual({ version: 1, intentId: prepared.intentId, receiptDigest, resolved: true })
  const resolved = await journal(f)
  expect(resolved[0]).toMatchObject({ state: 'committed', request_sealed: null, request_bytes: 0, receipt_json: original })
  expect(await n.fresh().execute(n.grant.token, execute)).toEqual(original)
  expect(await n.fresh().resolve({ ...execute, receiptDigest })).toMatchObject({ resolved: true })
  expect(await facts(f)).toEqual(before)
  expect(await journal(f)).toEqual(resolved)
}))

test('an actual expired original scope abandons under locks while a journal ACK delay remains behind the original final fence', () => cloudFixture(async (f) => {
  const n = await setup(f), store = n.fresh()
  const prepared = await store.prepare(n.grant.token, n.prepare)
  const reconcile = { version: 1 as const, workerId: n.workerId, limit: 4 }
  expect((await store.reconcile(reconcile)).items[0]?.outcome).toEqual({ state: 'blocked' })
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [n.grant.sessionId])
  const before = await facts(f), retained = await journal(f)
  await f.pool.query(`CREATE FUNCTION pe_test_ack_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state='committed' THEN PERFORM pg_sleep(1.4); END IF; RETURN NEW; END; $$;
    CREATE TRIGGER pe_test_ack_delay BEFORE UPDATE ON pe_native_retained_intents
      FOR EACH ROW EXECUTE FUNCTION pe_test_ack_delay()`)
  await expect(store.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId }))
    .rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  expect(await facts(f)).toEqual(before)
  expect(await journal(f)).toEqual(retained)
  expect((await n.fresh().reconcile(reconcile)).items[0]?.outcome).toEqual({ state: 'abandoned' })
  expect(await facts(f)).toEqual(before)
  const abandoned = await journal(f)
  await expect(store.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId }))
    .rejects.toMatchObject({ status: 409, code: 'native_intent_abandoned' })
  expect(await journal(f)).toEqual(abandoned)
}))


test('a previously abandoned private row cannot starve a later committed result across bounded worker batches', () => cloudFixture(async (f) => {
  const n = await setup(f), store = n.fresh()
  const original = await store.prepare(n.grant.token, n.prepare)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
  expect((await store.reconcile({ version: 1, workerId: n.workerId, limit: 1 })).items[0]?.outcome.state).toBe('abandoned')
  const before = await journal(f)
  const next = await n.tasks.claim(n.workerId)
  if (!next) throw new Error('Expected a real new claim after the old journal barrier cleared')
  expect(next.epoch).toBeGreaterThan(n.grant.epoch)
  const prepare = { ...n.prepare, mutation: { family: 'publication' as const, request: { ...n.prepare.mutation.request,
    epoch: next.epoch, publisherId: randomUUID(), batchId: randomUUID() } } }
  const prepared = await store.prepare(next.token, prepare)
  const committed = await store.execute(next.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId })
  const reconciled = await n.fresh().reconcile({ version: 1, workerId: n.workerId, limit: 1 })
  expect(reconciled).toMatchObject({ items: [{ intentId: prepared.intentId, outcome: { state: 'committed', receipt: committed } }], more: false })
  expect((await journal(f)).find(row => row.intent_id === original.intentId)).toEqual(before[0])
}))

test('actual retained ACK bytes and permanent records enforce their explicit budgets before native facts can commit', () => cloudFixture(async (f) => {
  const n = await setup(f)
  const sealedBytes = Buffer.byteLength(JSON.stringify({ operationToken: n.grant.token, prepare: n.prepare })) + 28
  const bounded = n.make({ ...journalLimits, maxRetainedBytesPerSession: sealedBytes + 1 })
  const prepared = await bounded.prepare(n.grant.token, n.prepare)
  const before = await facts(f), saved = await journal(f)
  await expect(bounded.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId }))
    .rejects.toMatchObject({ status: 413, code: 'native_intent_retention_budget' })
  expect(await facts(f)).toEqual(before)
  expect(await journal(f)).toEqual(saved)
  const pending = n.make({ ...journalLimits, maxPendingPerSession: 1 })
  const other = { ...n.prepare, mutation: { ...n.prepare.mutation,
    request: { ...n.prepare.mutation.request, batchId: randomUUID() } } }
  await expect(pending.prepare(n.grant.token, other)).rejects.toMatchObject({ status: 413, code: 'native_intent_retention_budget' })
  const receipt = await n.fresh().execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId })
  const receiptDigest = nativeInputRecordDigest(receipt)
  await n.fresh().resolve({ version: 1, workerId: n.workerId, intentId: prepared.intentId, receiptDigest })
  const resolved = await journal(f), complete = await facts(f)
  await expect(n.make({ ...journalLimits, maxRecordsPerSession: 1 }).prepare(n.grant.token, other))
    .rejects.toMatchObject({ status: 413, code: 'native_intent_retention_budget' })
  expect(await facts(f)).toEqual(complete)
  expect(await journal(f)).toEqual(resolved)
  expect(resolved[0]?.receipt_json).toEqual(receipt)
}))

test('a cross-Session cold scan returns a bounded nonempty prefix and rejects an oversized first result', () => cloudFixture(async (f) => {
  const n = await setup(f), store = n.fresh()
  const a = await store.prepare(n.grant.token, n.prepare)
  await store.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: a.intentId })
  const created = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await n.tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'second actual scan Session', f.alice.token)
  const secondTasks = new TaskStore(f.pool, { ...taskLimits, maxActivePerUser: 2 })
  const bGrant = await secondTasks.claim(n.workerId)
  if (!bGrant || bGrant.sessionId !== created.sessionId) throw new Error('Expected a real independent second Session grant')
  const header = headerSchema.parse((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
  const native = Session.create(header.id, undefined, header)
  const body = { version: 1 as const, workerId: n.workerId, mutation: { family: 'publication' as const, request:
    { version: 1 as const, epoch: bGrant.epoch, publisherId: randomUUID(), batchId: randomUUID(), firstOrdinal: 1,
      items: [{ type: 'event' as const, event: native.append('turn/start', { turn: 1 }) }] } } }
  const b = await store.prepare(bGrant.token, body)
  await store.execute(bGrant.token, { version: 1, workerId: n.workerId, intentId: b.intentId })
  const all = await store.reconcile({ version: 1, workerId: n.workerId, limit: 4 })
  expect(all.items).toHaveLength(2)
  const requestBytes = (await f.pool.query<{ bytes: number }>('SELECT max(octet_length(request_sealed)-28)::integer AS bytes FROM pe_native_retained_intents')).rows[0]?.bytes
  if (!requestBytes) throw new Error('Expected actual sealed request byte size')
  const singleBytes = Math.max(...all.items.map(item => Buffer.byteLength(JSON.stringify({ version: 1, items: [item], more: true }))))
  const bound = Math.max(requestBytes, singleBytes) + 1
  expect(Buffer.byteLength(JSON.stringify(all))).toBeGreaterThan(bound)
  const before = await facts(f)
  const limited = n.make({ ...journalLimits, maxRequestBytes: bound })
  const prefix = await limited.reconcile({ version: 1, workerId: n.workerId, limit: 4 })
  expect(prefix.items).toHaveLength(1)
  expect(prefix.more).toBe(true)
  const first = prefix.items[0]
  if (!first || first.outcome.state !== 'committed') throw new Error('Expected a validated committed prefix')
  await limited.resolve({ version: 1, workerId: n.workerId, intentId: first.intentId,
    receiptDigest: nativeInputRecordDigest(first.outcome.receipt) })
  const rest = await limited.reconcile({ version: 1, workerId: n.workerId, limit: 4 })
  expect(rest.items).toHaveLength(1)
  expect(rest.more).toBe(false)
  await expect(n.make({ ...journalLimits, maxRequestBytes: 1 }).reconcile({ version: 1, workerId: n.workerId, limit: 4 }))
    .rejects.toMatchObject({ status: 413 })
  expect(await facts(f)).toEqual(before)
}))

test('cold reconciliation waits for a real late execution transaction before its expired final fence permits abandonment',
  () => cloudFixture(async (f) => {
    const n = await setup(f), store = n.fresh()
    const prepared = await store.prepare(n.grant.token, n.prepare)
    const lockKey = randomBytes(8).readBigInt64BE().toString(), blocker = await f.pool.connect()
    try {
      await blocker.query('SELECT pg_advisory_lock($1::bigint)', [lockKey])
      await f.pool.query(`CREATE FUNCTION pe_test_late_ack() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state='committed' THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END; $$;
        CREATE TRIGGER pe_test_late_ack BEFORE UPDATE ON pe_native_retained_intents
          FOR EACH ROW EXECUTE FUNCTION pe_test_late_ack()`)
      await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [n.grant.sessionId])
      const before = await facts(f)
      const execution = store.execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: prepared.intentId })
        .then(result => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }))
      let waiting = false
      for (let probe = 0; probe < 100; probe++) {
        waiting = !!(await f.pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event='advisory' AND query LIKE '%UPDATE pe_native_retained_intents SET state=%'`)).rowCount
        if (waiting) break
        await setTimeout(10)
      }
      expect(waiting).toBe(true)
      let reconciled = false
      const cold = n.fresh().reconcile({ version: 1, workerId: n.workerId, limit: 4 }).finally(() => { reconciled = true })
      await f.pool.query('SELECT pg_sleep(1.2)')
      expect(reconciled).toBe(false)
      await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey])
      expect((await execution).error).toMatchObject({ status: 409, code: 'lease_lost' })
      expect((await cold).items[0]).toMatchObject({ intentId: prepared.intentId, outcome: { state: 'abandoned' } })
      expect(await facts(f)).toEqual(before)
      expect((await journal(f))[0]).toMatchObject({ state: 'abandoned', receipt_json: null })
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey])
      blocker.release()
    }
  }))

test('a prepared journal blocks ordinary and archive claims until an independent worker proves the original scope abandoned',
  () => cloudFixture(async (f) => {
    const n = await setup(f), newWorker = randomUUID(), store = n.fresh()
    expect(newWorker).not.toBe(n.workerId)
    const prepared = await store.prepare(n.grant.token, n.prepare)
    await expect(store.execute(n.grant.token, { version: 1, workerId: newWorker, intentId: prepared.intentId }))
      .rejects.toMatchObject({ status: 409, code: 'native_intent_scope' })
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
    const ordinary = await retainedNativeFacts(f.pool)
    expect(await n.tasks.claim(newWorker)).toBeNull()
    expect(await retainedNativeFacts(f.pool)).toEqual(ordinary)
    const stop = await transaction(f.pool, async (client) => {
      const account = await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
      await n.tasks.owned(client, { userId: account.userId, username: account.username }, n.grant.sessionId)
      return n.tasks.requestArchiveStopInTransaction(client, f.alice.user, n.grant.sessionId)
    })
    expect(stop.status).toBe('requested')
    const archived = await retainedNativeFacts(f.pool)
    expect(await n.tasks.claimArchiveStop(newWorker)).toBeNull()
    expect(await retainedNativeFacts(f.pool)).toEqual(archived)
    const cold = await n.fresh().reconcile({ version: 1, workerId: newWorker, limit: 1 })
    expect(cold).toMatchObject({ items: [{ intentId: prepared.intentId, workerId: n.workerId,
      operationId: n.grant.operationId, operationEpoch: n.grant.epoch, outcome: { state: 'abandoned' } }], more: false })
    expect(await retainedNativeFacts(f.pool)).toEqual(archived)
    const claimed = await n.tasks.claimArchiveStop(newWorker)
    if (!claimed) throw new Error('Expected a real storage claim only after the durable pending barrier cleared')
    expect(claimed.sessionId).toBe(n.grant.sessionId)
    expect(claimed.operationId).toBe(n.grant.operationId)
    expect(claimed.epoch).toBeGreaterThan(n.grant.epoch)
    expect((await f.pool.query('SELECT worker_id FROM pe_attempts WHERE operation_id=$1 AND epoch=$2',
      [claimed.operationId, claimed.epoch])).rows).toEqual([{ worker_id: newWorker }])
    expect((await f.pool.query('SELECT state,receipt_json FROM pe_native_retained_intents')).rows)
      .toEqual([{ state: 'abandoned', receipt_json: null }])
  }))

test('shared reconciliation skips a disabled first owner and permits cross-worker resolution only after actual retirement',
  () => cloudFixture(async (f) => {
    const n = await setup(f), newWorker = randomUUID(), bobWorker = randomUUID(), store = n.fresh()
    const alice = await store.prepare(n.grant.token, n.prepare)
    await f.pool.query('UPDATE pe_users SET enabled=false,account_revision=account_revision+1 WHERE id=$1', [f.alice.user.userId])
    const aliceJournal = await journal(f)
    const created = await n.tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
    await n.tasks.accept(f.bob.user, created.sessionId, requestId.parse(randomUUID()), 'active independent owner', f.bob.token)
    const grant = await n.tasks.claim(bobWorker)
    if (!grant || grant.sessionId !== created.sessionId) throw new Error('Expected an actual grant for the enabled second owner')
    const header = headerSchema.parse((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1',
      [created.sessionId])).rows[0]?.header)
    const native = Session.create(header.id, undefined, header)
    const request = { version: 1 as const, workerId: bobWorker, mutation: { family: 'publication' as const, request:
      { version: 1 as const, epoch: grant.epoch, publisherId: randomUUID(), batchId: randomUUID(), firstOrdinal: 1,
        items: [{ type: 'event' as const, event: native.append('turn/start', { turn: 1 }) }] } } }
    const bob = await store.prepare(grant.token, request)
    const receipt = await store.execute(grant.token, { version: 1, workerId: bobWorker, intentId: bob.intentId })
    const reconcile = { version: 1 as const, workerId: newWorker, limit: 1 }
    const resolve = { version: 1 as const, workerId: newWorker, intentId: bob.intentId,
      receiptDigest: nativeInputRecordDigest(receipt) }
    const live = await retainedNativeFacts(f.pool)
    expect(await n.fresh().reconcile(reconcile)).toMatchObject({ items: [{ intentId: bob.intentId, workerId: bobWorker,
      userId: f.bob.user.userId, outcome: { state: 'committed', receipt, retired: false } }], more: false })
    await expect(n.fresh().resolve(resolve)).rejects.toMatchObject({ status: 409, code: 'native_intent_not_retired' })
    expect(await retainedNativeFacts(f.pool)).toEqual(live)
    const acquisition = { sessionId: grant.sessionId, workerId: bobWorker, token: randomBytes(32).toString('base64url') }
    const lease = await n.writers.acquire(grant.token, acquisition)
    const writer = nativeWriterIdentity.parse({ ...acquisition, epoch: lease.epoch })
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [grant.sessionId])
    const independent = await retainedNativeFacts(f.pool)
    expect((await n.fresh().reconcile(reconcile)).items[0]?.outcome).toMatchObject({ state: 'committed', retired: false })
    await expect(n.fresh().resolve(resolve)).rejects.toMatchObject({ status: 409, code: 'native_intent_not_retired' })
    expect(await retainedNativeFacts(f.pool)).toEqual(independent)
    await n.writers.release(writer)
    const retired = await retainedNativeFacts(f.pool)
    expect(await n.fresh().reconcile(reconcile)).toMatchObject({ items: [{ intentId: bob.intentId,
      workerId: bobWorker, outcome: { state: 'committed', receipt, retired: true } }], more: false })
    expect(await n.fresh().resolve(resolve)).toMatchObject({ intentId: bob.intentId, resolved: true })
    expect(await retainedNativeFacts(f.pool)).toEqual(retired)
    expect((await journal(f)).find(row => row.intent_id === alice.intentId)).toEqual(aliceJournal[0])
    expect((await journal(f)).find(row => row.intent_id === bob.intentId)).toMatchObject({ request_sealed: null, receipt_json: receipt })
    await expect(n.fresh().execute(n.grant.token, { version: 1, workerId: n.workerId, intentId: alice.intentId }))
      .rejects.toMatchObject({ status: 401, code: 'account_disabled' })
  }))
