/** Exact publisher cleanup, retired-epoch collection and settlement rollback over real PostgreSQL. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { requestId } from '../src/contracts.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { pruneNativeAssistant, releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { headerSchema } from '../src/session-records.ts'

const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const limits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000,
  maxEventBytes: eventLimits.maxEventBytes }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]

async function admitted(f: Fixture, renewPresentation = false) {
  const tasks = new TaskStore(f.pool, { ...eventLimits,
      ...(renewPresentation ? { nativeAssistantTtlMs: limits.ttlMs } : {}) }), events = new EventStore(tasks, eventLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'temporary lifecycle', f.alice.token)
  const workerId = randomUUID(), grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Expected the owned lifecycle grant')
  const header = headerSchema.parse((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
  const native = Session.create(header.id, undefined, header)
  await events.append(grant.token, [native.append('turn/start', { turn: 1 }), native.append('step/start', { turn: 1, step: 1 })])
  const publisherId = randomUUID(), store = new NativeAssistantStore(tasks, events, limits)
  await store.apply(grant.token, { version: 1, epoch: grant.epoch, publisherId, batchId: randomUUID(), firstOrdinal: 1,
    items: [{ type: 'assistant-stream', frame: { type: 'start', attemptId: 'lifecycle:1', revision: 1, turn: 1, step: 1 } }] })
  return { tasks, grant, publisherId, store, workerId }
}

async function counts(f: Fixture) {
  const result = await f.pool.query<{ parents: number; entries: number; events: number; running: number }>(`SELECT
    (SELECT count(*)::integer FROM pe_native_presentations) AS parents,
    (SELECT count(*)::integer FROM pe_native_presentation_entries) AS entries,
    (SELECT count(*)::integer FROM pe_events) AS events,
    (SELECT count(*)::integer FROM pe_operations WHERE state='running') AS running`)
  return result.rows
}

test('release authenticates the exact original publisher, is idempotent and preserves accepted work', () => cloudFixture(async (f) => {
  const n = await admitted(f), before = await counts(f)
  await expect(releaseNativeAssistant(n.tasks, n.grant.token, randomUUID())).rejects.toMatchObject({ code: 'native_assistant_publisher' })
  expect(await counts(f)).toEqual(before)
  expect(await releaseNativeAssistant(n.tasks, n.grant.token, n.publisherId)).toEqual({ released: true })
  expect(await releaseNativeAssistant(n.tasks, n.grant.token, n.publisherId)).toEqual({ released: true })
  expect(await counts(f)).toEqual([{ parents: 0, entries: 0, events: 2, running: 1 }])
}))

test('an old token cannot release a replacement epoch, even with its known publisher identity', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
  const current = await n.tasks.claim(randomUUID())
  if (!current) throw new Error('Expected the recovered current grant')
  const publisherId = randomUUID()
  await n.store.apply(current.token, { version: 1, epoch: current.epoch, publisherId, batchId: randomUUID(),
    firstOrdinal: 1, items: [] })
  await expect(releaseNativeAssistant(n.tasks, n.grant.token, publisherId)).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(releaseNativeAssistant(n.tasks, current.token, n.publisherId)).rejects.toMatchObject({ code: 'native_assistant_publisher' })
  expect(await counts(f)).toEqual([{ parents: 1, entries: 0, events: 2, running: 1 }])
  await releaseNativeAssistant(n.tasks, current.token, publisherId)
}))

test('collection skips a locked expired parent after operation expiry, then removes its entries without altering canonical work', () => cloudFixture(async (f) => {
  const n = await admitted(f), blocker = await f.pool.connect()
  await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second'")
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT session_id FROM pe_native_presentations FOR UPDATE')
    expect(await pruneNativeAssistant(n.tasks)).toBe(0)
    expect(await counts(f)).toEqual([{ parents: 1, entries: 1, events: 2, running: 1 }])
  } finally { await blocker.query('ROLLBACK'); blocker.release() }
  expect(await pruneNativeAssistant(n.tasks)).toBe(1)
  expect(await counts(f)).toEqual([{ parents: 0, entries: 0, events: 2, running: 1 }])
  expect(await pruneNativeAssistant(n.tasks)).toBe(0)
}))

test('operation renewal preserves the publisher past its old presentation deadline without reviving expired authority', () => cloudFixture(async (f) => {
  const n = await admitted(f, true), writers = new NativeSessionWriter(n.tasks, { leaseMs: eventLimits.leaseMs })
  const acquisition = { sessionId: n.grant.sessionId, workerId: n.workerId, token: randomBytes(32).toString('base64url') }
  const writer = await writers.acquire(n.grant.token, acquisition)
  const identity = { ...acquisition, epoch: writer.epoch }
  const before = await counts(f)
  const deadline = (await f.pool.query<{ oldDeadline: string }>(`UPDATE pe_native_presentations
    SET expires_at=clock_timestamp()+interval '5 seconds' WHERE session_id=$1
    RETURNING expires_at::text AS "oldDeadline"`, [n.grant.sessionId])).rows[0]
  if (!deadline) throw new Error('Expected the original presentation deadline')
  await n.tasks.renew(n.grant.token)
  await expect.poll(async () => (await f.pool.query<{ passed: boolean }>(
    'SELECT $1::timestamptz<=clock_timestamp() AS passed', [deadline.oldDeadline])).rows[0]?.passed,
  { timeout: 10_000, interval: 20 }).toBe(true)
  expect((await f.pool.query<{
    operationLive: boolean
    writerLive: boolean
  }>(`SELECT
    s.lease_until>clock_timestamp() AS "operationLive",w.expires_at>clock_timestamp() AS "writerLive"
    FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id WHERE s.id=$1`,
  [n.grant.sessionId])).rows).toEqual([{ operationLive: true, writerLive: true }])
  expect(await pruneNativeAssistant(n.tasks)).toBe(0)
  expect(await counts(f)).toEqual(before)
  const batch = { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal: 2,
    items: [{ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'lifecycle:1', revision: 2,
      index: 0, time: 100, chunk: { type: 'text-delta', index: 0, text: 'continuous' } } }] }
  const receipt = await n.store.apply(n.grant.token, batch)
  expect(receipt).toEqual({ publisherId: n.publisherId, epoch: n.grant.epoch, lastOrdinal: 2, eventCount: 2, revision: 2 })
  expect(await n.store.apply(n.grant.token, batch)).toEqual(receipt)
  expect(await counts(f)).toEqual([{ parents: 1, entries: 2, events: 2, running: 1 }])
  await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
    [n.grant.sessionId])
  await n.tasks.renew(n.grant.token)
  expect(await pruneNativeAssistant(n.tasks)).toBe(0)
  const afterExpiry = await counts(f)
  await expect(n.store.apply(n.grant.token, { ...batch, batchId: randomUUID(), firstOrdinal: 3, items: [] }))
    .rejects.toMatchObject({ code: 'native_assistant_expired' })
  expect(await counts(f)).toEqual(afterExpiry)
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.grant.sessionId])
  await writers.renew(identity)
  await expect(n.tasks.renew(n.grant.token)).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(n.store.apply(n.grant.token, { ...batch, batchId: randomUUID(), firstOrdinal: 3, items: [] }))
    .rejects.toMatchObject({ code: 'lease_lost' })
  expect(await counts(f)).toEqual(afterExpiry)
  expect(await pruneNativeAssistant(n.tasks)).toBe(1)
  expect(await pruneNativeAssistant(n.tasks)).toBe(0)
  expect(await counts(f)).toEqual([{ parents: 0, entries: 0, events: 2, running: 1 }])
}))

test('collection removes a superseded epoch and preserves an invalid future epoch for explicit diagnosis', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  await f.pool.query('UPDATE pe_sessions SET lease_epoch=lease_epoch+1 WHERE id=$1', [n.grant.sessionId])
  expect(await pruneNativeAssistant(n.tasks)).toBe(1)
  await f.pool.query('UPDATE pe_sessions SET lease_epoch=lease_epoch-1 WHERE id=$1', [n.grant.sessionId])
  await n.store.apply(n.grant.token, { version: 1, epoch: n.grant.epoch, publisherId: randomUUID(), batchId: randomUUID(),
    firstOrdinal: 1, items: [] })
  await f.pool.query("UPDATE pe_native_presentations SET epoch=epoch+1,expires_at=clock_timestamp()-interval '1 second'")
  expect(await pruneNativeAssistant(n.tasks)).toBe(0)
  expect(await counts(f)).toEqual([{ parents: 1, entries: 0, events: 2, running: 1 }])
}))

test('a final settlement clock failure rolls back operation, attempt and temporary cleanup together', () => cloudFixture(async (f) => {
  const n = await admitted(f), before = await counts(f)
  await f.pool.query(`CREATE FUNCTION expire_native_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id='${n.grant.sessionId}'; RETURN NEW; END $$`)
  await f.pool.query(`CREATE TRIGGER expire_native_settlement BEFORE UPDATE ON pe_attempts
    FOR EACH ROW EXECUTE FUNCTION expire_native_settlement()`)
  await expect(n.tasks.finish(n.grant.token, 'failed', 'owned-test')).rejects.toMatchObject({ code: 'lease_lost' })
  expect(await counts(f)).toEqual(before)
  expect((await f.pool.query<{ ended_at: Date | null }>('SELECT ended_at FROM pe_attempts WHERE operation_id=$1',
    [n.grant.operationId])).rows).toEqual([{ ended_at: null }])
  await f.pool.query('DROP TRIGGER expire_native_settlement ON pe_attempts; DROP FUNCTION expire_native_settlement()')
  await n.tasks.finish(n.grant.token, 'failed', 'owned-test')
  expect(await counts(f)).toEqual([{ parents: 0, entries: 0, events: 2, running: 0 }])
}))
