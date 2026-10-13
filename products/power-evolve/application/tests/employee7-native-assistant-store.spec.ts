/** Real PostgreSQL publication, grant fencing and official compact assistant presentation. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { createNativeAssistantState, nativeAssistantBaseline, nativeAssistantBytes, nativeAssistantEntry,
  parseNativeAssistantBatch, readNativeAssistantState, validateNativeAssistantLimits, type NativeAssistantLimits } from '../src/native-assistant-records.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { EventStore } from '../src/platform/events.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const presentationLimits: NativeAssistantLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: eventLimits.maxEventBytes }
type CloudCase = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Admitted = Awaited<ReturnType<typeof admitted>>

function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('Owned assistant fixture returned no row')
  return value
}

async function admitted(f: CloudCase, overrides: Partial<NativeAssistantLimits> = {}) {
  const limits = { ...presentationLimits, ...overrides }
  const tasks = new TaskStore(f.pool, eventLimits), events = new EventStore(tasks, eventLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'owned assistant publication', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned assistant writer was not claimed')
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  return { tasks, events, created, grant, native: Session.create(header.id, undefined, header),
    publisherId: randomUUID(), limits, store: new NativeAssistantStore(tasks, events, limits) }
}

async function nativeCase(run: (f: CloudCase, n: Admitted) => Promise<void>,
  overrides: Partial<NativeAssistantLimits> = {}): Promise<void> {
  await cloudFixture(async (f) => { await run(f, await admitted(f, overrides)) })
}

function batch(n: Admitted, items: readonly unknown[], firstOrdinal = 1, batchId = randomUUID()) {
  return { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId, batchId, firstOrdinal, items }
}

function start(revision = 1, attemptId = 'owned:1') {
  return { type: 'assistant-stream', frame: { type: 'start', attemptId, revision, turn: 1, step: 1 } }
}

function chunk(value: unknown, revision = 2, index = 0, attemptId = 'owned:1', time = 100) {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision, index, time, chunk: value } }
}

function end(seq: number | undefined, revision = 3, index = 1, attemptId = 'owned:1', eventType = 'assistant/attempt') {
  return { type: 'assistant-stream', frame: { type: 'end', attemptId, revision, index,
    outcome: seq === undefined ? { kind: 'abandoned' } : { kind: 'committed', eventType, seq } } }
}

function events(n: Admitted, after = 0) { return n.native.snapshotEvents().slice(after).map(event => ({ type: 'event', event })) }

async function state(f: CloudCase, n: Admitted) {
  const stored = first((await f.pool.query<{ state_json: string }>(
    'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [n.created.sessionId])).rows)
  return readNativeAssistantState(stored.state_json, n.limits)
}

async function retained(f: CloudCase, n: Admitted) {
  const rows = (await f.pool.query<{ item_json: string; item_bytes: number }>(
    'SELECT item_json,item_bytes FROM pe_native_presentation_entries WHERE session_id=$1 ORDER BY ordinal', [n.created.sessionId])).rows
  for (const row of rows) expect(row.item_bytes).toBe(Buffer.byteLength(row.item_json))
  return rows.map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json)))
}

async function persisted(f: CloudCase, n: Admitted) {
  return {
    counters: (await f.pool.query<{ event_count: number; event_bytes: string }>('SELECT event_count,event_bytes FROM pe_sessions WHERE id=$1', [n.created.sessionId])).rows,
    history: (await f.pool.query<{ seq: number; event: string }>('SELECT seq,event::text FROM pe_events WHERE session_id=$1 ORDER BY seq', [n.created.sessionId])).rows,
    checkpoint: (await f.pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
      [f.alice.user.userId, `session-projections:${n.created.sessionId}`])).rows,
    presentation: (await f.pool.query<Record<string, unknown>>(`SELECT epoch,publisher_id,last_ordinal,state_json,last_batch_id,last_batch_json
      FROM pe_native_presentations WHERE session_id=$1`, [n.created.sessionId])).rows,
    ring: await retained(f, n),
  }
}

function settled(n: Admitted, text: string, message: boolean, interrupted = false) {
  n.native.append('turn/start', { turn: 1 }); n.native.append('step/start', { turn: 1, step: 1 })
  const prefix = events(n), accumulator = new AssistantStreamAccumulator()
  const raw: StreamChunk = { type: 'text-delta', index: 0, text }
  accumulator.push({ time: 100, chunk: raw })
  const stream = [...accumulator.snapshot()]
  if (message) n.native.append('assistant/message', { turn: 1, step: 1, stream,
    message: { id: brandString<MessageId>(randomUUID()), role: 'assistant', content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'owned-fixture', model: 'owned-fixture' } },
    ...(interrupted ? { interrupted: true } : {}) }, { surfaceOp: 'append' })
  else n.native.append('assistant/attempt', { turn: 1, step: 1, stream })
  const settlement = first(events(n, prefix.length)), seq = first(n.native.snapshotEvents().slice(prefix.length)).seq
  return { prefix, raw, stream, settlement, seq }
}

test('ordered message publication atomically commits canonical history, event references and the real end before step/end', () => nativeCase(async (f, n) => {
  const s = settled(n, 'actual message', true)
  n.native.append('step/end', { turn: 1, step: 1 })
  n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const input = batch(n, [...s.prefix, start(), chunk(s.raw), s.settlement,
    end(s.seq, 3, 1, 'owned:1', 'assistant/message'), ...events(n, s.seq + 1)])
  expect(await n.store.apply(n.grant.token, input)).toEqual({ publisherId: n.publisherId, epoch: n.grant.epoch,
    lastOrdinal: 8, eventCount: 5, revision: 3 })
  expect((await retained(f, n)).map(entry => entry.item.type === 'event' ? entry.item.eventType : entry.item.frame.type))
    .toEqual(['turn/start', 'step/start', 'start', 'chunk', 'assistant/message', 'end', 'step/end', 'turn/end'])
  expect((await retained(f, n)).filter(entry => entry.item.type === 'event').every(entry => !Object.hasOwn(entry.item, 'event'))).toBe(true)
  expect(nativeAssistantBaseline(await state(f, n), n.limits)).toEqual({ revision: 3 })
  expect((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [n.created.sessionId])).rows.map(row => row.event)).toEqual(n.native.snapshotEvents())
  expect(first((await f.pool.query<{ value: { asOfSeq: number } }>('SELECT value FROM pe_native_preferences WHERE namespace=$1',
    [`session-projections:${n.created.sessionId}`])).rows).value.asOfSeq).toBe(4)
}))

test('replaying the exact last batch returns one receipt and differing contents or old ordinals leave every store unchanged', () => nativeCase(async (f, n) => {
  n.native.append('turn/start', { turn: 1 })
  const input = batch(n, [...events(n), start(), chunk({ type: 'text-delta', index: 0, text: 'once' })])
  const receipt = await n.store.apply(n.grant.token, input), saved = await persisted(f, n)
  expect(await n.store.apply(n.grant.token, structuredClone(input))).toEqual(receipt)
  expect(await persisted(f, n)).toEqual(saved)
  await expect(n.store.apply(n.grant.token, { ...input, items: [] })).rejects.toMatchObject({ code: 'native_assistant_batch_conflict' })
  await expect(n.store.apply(n.grant.token, { ...input, batchId: randomUUID() })).rejects.toMatchObject({ code: 'native_assistant_ordinal' })
  expect(await persisted(f, n)).toEqual(saved)
}))

test('an empty authenticated heartbeat retains the actual revision and never inserts a terminal event or frame', () => nativeCase(async (f, n) => {
  const firstReceipt = await n.store.apply(n.grant.token, batch(n, []))
  expect(firstReceipt).toMatchObject({ lastOrdinal: 0, revision: 0, eventCount: 0 })
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'reasoning-delta', index: 0, text: 'thinking' })]))
  const before = await state(f, n)
  expect(await n.store.apply(n.grant.token, batch(n, [], 3))).toMatchObject({ lastOrdinal: 2, revision: 2 })
  expect(await state(f, n)).toEqual(before)
  expect((await retained(f, n)).length).toBe(2)
  expect((await persisted(f, n)).history).toEqual([])
  const expiry = first((await f.pool.query<{ bounded: boolean }>(`SELECT p.expires_at<=s.lease_until
    AND p.expires_at<=clock_timestamp()+interval '20 seconds' AS bounded FROM pe_native_presentations p
    JOIN pe_sessions s ON s.id=p.session_id WHERE s.id=$1`, [n.created.sessionId])).rows)
  expect(expiry.bounded).toBe(true)
}))

test.each(['end before durable', 'step before end', 'wrong end type', 'wrong end seq', 'wrong settlement stream', 'abandoned after durable'] as const)(
  '%s refuses the whole event, projection and presentation transaction', mode => nativeCase(async (f, n) => {
    const s = settled(n, 'settled', true), before = await persisted(f, n)
    n.native.append('step/end', { turn: 1, step: 1 })
    const terminal = end(s.seq, 3, 1, 'owned:1', 'assistant/message')
    let suffix: unknown[] = [s.settlement, terminal]
    if (mode === 'end before durable') suffix = [terminal, s.settlement]
    if (mode === 'step before end') suffix = [s.settlement, ...events(n, s.seq + 1), terminal]
    if (mode === 'wrong end type') suffix = [s.settlement, end(s.seq)]
    if (mode === 'wrong end seq') suffix = [s.settlement, end(s.seq + 1, 3, 1, 'owned:1', 'assistant/message')]
    if (mode === 'wrong settlement stream') suffix = [s.settlement, terminal]
    if (mode === 'abandoned after durable') suffix = [s.settlement, end(undefined)]
    const raw = mode === 'wrong settlement stream' ? { ...s.raw, text: 'different original chunk' } : s.raw
    await expect(n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(raw), ...suffix]))).rejects.toThrow()
    expect(await persisted(f, n)).toEqual(before)
  }))

test('a real pending settlement survives reload at its actual revision and can only be followed by its matching end', () => nativeCase(async (f, n) => {
  const s = settled(n, 'pending terminal', false)
  await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), s.settlement]))
  const pending = await state(f, n)
  expect(pending.activeAttempt?.settlement).toEqual({ eventType: 'assistant/attempt', seq: s.seq, interrupted: false })
  expect(pending.activeAttempt?.stream).toEqual(s.stream)
  expect(nativeAssistantBaseline(pending, n.limits)).toEqual({ revision: 2 })
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [chunk(s.raw, 3, 1)], 6))).rejects.toMatchObject({ code: 'native_assistant_order' })
  expect(await persisted(f, n)).toEqual(before)
  const resumed = new NativeAssistantStore(n.tasks, n.events, n.limits)
  expect(await resumed.apply(n.grant.token, batch(n, [end(s.seq)], 6))).toMatchObject({ lastOrdinal: 6, revision: 3, eventCount: 3 })
  expect((await state(f, n)).activeAttempt).toBeUndefined()
}))

test('successful message waits for real step/end whereas interrupted message and attempt permit the next original attempt', () => nativeCase(async (f, n) => {
  const s = settled(n, 'success', true)
  await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), s.settlement, end(s.seq, 3, 1, 'owned:1', 'assistant/message')]))
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [start(4, 'owned:2')], 7))).rejects.toMatchObject({ code: 'native_assistant_attempt' })
  expect(await persisted(f, n)).toEqual(before)
  n.native.append('step/end', { turn: 1, step: 1 })
  expect(await n.store.apply(n.grant.token, batch(n, [...events(n, s.seq + 1), start(4, 'owned:2')], 7))).toMatchObject({ revision: 4 })
}))

test('interrupted native message retains its actual event and accepts the next Agent attempt after a matching end', () => nativeCase(async (f, n) => {
  const s = settled(n, 'interrupted', true, true)
  expect(await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), s.settlement,
    end(s.seq, 3, 1, 'owned:1', 'assistant/message'), start(4, 'owned:2')]))).toMatchObject({ revision: 4, eventCount: 3 })
  expect((await state(f, n)).activeAttempt?.attemptId).toBe('owned:2')
  expect(first((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 AND seq=$2',
    [n.created.sessionId, s.seq])).rows).event).toEqual(n.native.snapshotEvents().at(-1))
}))

test('a failed native append cannot leave a forged committed end and an original abandoned frame needs no invented event', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'prefix' })]))
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [{ type: 'event', event: { seq: 0, time: 100, type: 'forged/unknown', data: {} } },
    end(0)], 3))).rejects.toThrow()
  expect(await persisted(f, n)).toEqual(before)
  expect(await n.store.apply(n.grant.token, batch(n, [end(undefined)], 3))).toMatchObject({ eventCount: 0, revision: 3 })
  expect((await persisted(f, n)).history).toEqual([])
  expect(nativeAssistantBaseline(await state(f, n), n.limits)).toEqual({ revision: 3 })
}))

test.each(['revision gap', 'index gap', 'wrong attempt', 'double start', 'unknown chunk', 'invalid delta', 'wrong ordinal'] as const)(
  '%s leaves the complete recoverable prefix unchanged', mode => nativeCase(async (f, n) => {
    const raw = { type: 'text-delta', index: 0, text: 'recoverable' }
    await n.store.apply(n.grant.token, batch(n, [start(), chunk(raw)]))
    const before = await persisted(f, n)
    let item: unknown = chunk(raw, 3, 1)
    if (mode === 'revision gap') item = chunk(raw, 4, 1)
    if (mode === 'index gap') item = chunk(raw, 3, 2)
    if (mode === 'wrong attempt') item = chunk(raw, 3, 1, 'other:1')
    if (mode === 'double start') item = start(3, 'owned:2')
    if (mode === 'unknown chunk') item = chunk({ type: 'unknown', bytes: 'opaque' }, 3, 1)
    if (mode === 'invalid delta') item = chunk({ type: 'text-delta', index: 0, text: 17 }, 3, 1)
    await expect(n.store.apply(n.grant.token, batch(n, [item], mode === 'wrong ordinal' ? 4 : 3))).rejects.toThrow()
    expect(await persisted(f, n)).toEqual(before)
  }))

test('JSON text preserves Unicode NUL, lone surrogates, delta boundaries and known opaque raw chunks after restart', () => nativeCase(async (f, n) => {
  const texts = ['中\0\uD800 😀', '\\u0000\uDC00', 'tail']
  const accumulator = new AssistantStreamAccumulator()
  const raw: StreamChunk[] = texts.map(text => ({ type: 'text-delta', index: 0, text }))
  raw.push({ type: 'finish', reason: { kind: 'stop' } })
  raw.forEach((value, index) => accumulator.push({ time: 100 - index, chunk: value }))
  await n.store.apply(n.grant.token, batch(n, [start(), ...raw.map((value, index) => chunk(value, 2 + index, index, 'owned:1', 100 - index))]))
  const reconstructed = await state(f, n)
  expect(reconstructed.activeAttempt?.stream).toEqual(accumulator.snapshot())
  expect(reconstructed.activeAttempt?.nextIndex).toBe(4)
  expect(nativeAssistantBaseline(reconstructed, n.limits).activeAttempt?.stream).toEqual(accumulator.snapshot())
  const originalText = first((await f.pool.query<{ state_json: string }>('SELECT state_json FROM pe_native_presentations WHERE session_id=$1',
    [n.created.sessionId])).rows).state_json
  expect(originalText).toContain('\\u0000'); expect(originalText).toContain('\\ud800'); expect(originalText).not.toContain('\0')
  const fresh = new NativeAssistantStore(n.tasks, n.events, n.limits)
  n.native.append('assistant/attempt', { turn: 1, step: 1, stream: [...accumulator.snapshot()] })
  expect(await fresh.apply(n.grant.token, batch(n, [...events(n), end(0, 6, 4)], 6))).toMatchObject({ revision: 6, eventCount: 1 })
  expect(first((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1',
    [n.created.sessionId])).rows).event).toEqual(n.native.snapshotEvents()[0])
}))

test('ring eviction retains a dense suffix and the entire official compact baseline', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'one' }),
    chunk({ type: 'text-delta', index: 0, text: 'two' }, 3, 1, 'owned:1', 101),
    chunk({ type: 'text-delta', index: 0, text: 'three' }, 4, 2, 'owned:1', 102)]))
  expect((await retained(f, n)).map(entry => entry.ordinal)).toEqual([3, 4])
  expect(nativeAssistantBaseline(await state(f, n), n.limits).activeAttempt).toMatchObject({ nextIndex: 3,
    stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [1, 1], texts: ['one', 'two', 'three'] }] })
}, { maxRingItems: 2 }))

test('complete active budget refusal rolls back a staged native event instead of truncating reconnect state', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'small' })]))
  const before = await persisted(f, n)
  n.native.append('turn/start', { turn: 1 })
  await expect(n.store.apply(n.grant.token, batch(n, [...events(n), chunk({ type: 'text-delta', index: 0, text: '大'.repeat(200) }, 3, 1)], 3)))
    .rejects.toMatchObject({ status: 413, code: 'native_assistant_budget' })
  expect(await persisted(f, n)).toEqual(before)
}, { maxActiveBytes: 500 }))

test('serialized item and batch bytes, item count and exact deployment capacity are enforced before any mutation', () => nativeCase(async (f, n) => {
  const before = await persisted(f, n)
  const tooMany = batch(n, Array.from({ length: 33 }, () => start()))
  await expect(n.store.apply(n.grant.token, tooMany)).rejects.toMatchObject({ status: 413 })
  const huge = batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'x'.repeat(1_048_576) })])
  await expect(n.store.apply(n.grant.token, huge)).rejects.toMatchObject({ status: 413 })
  expect(await persisted(f, n)).toEqual(before)
  const small = batch(n, [start()]), bytes = nativeAssistantBytes(small)
  expect(parseNativeAssistantBatch(small, { ...n.limits, maxBatchBytes: bytes })).toEqual(small)
  expect(() => parseNativeAssistantBatch(small, { ...n.limits, maxBatchBytes: bytes - 1 })).toThrow()
  const oneItemBytes = nativeAssistantBytes(start())
  expect(parseNativeAssistantBatch(small, { ...n.limits, maxItemBytes: oneItemBytes })).toEqual(small)
  expect(() => parseNativeAssistantBatch(small, { ...n.limits, maxItemBytes: oneItemBytes - 1 })).toThrow()
  expect(() => validateNativeAssistantLimits({ ...n.limits, maxItemBytes: n.limits.maxEventBytes })).toThrow()
  expect(() => validateNativeAssistantLimits({ ...n.limits, maxBatchBytes: n.limits.maxEventBytes })).toThrow()
  expect(() => validateNativeAssistantLimits({ ...n.limits, ttlMs: 0 })).toThrow()
}))

test('a ring item too large for retention rolls back the generation without losing a partial frame', () => nativeCase(async (f, n) => {
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: '中'.repeat(200) })])))
    .rejects.toMatchObject({ code: 'native_assistant_budget' })
  expect(await persisted(f, n)).toEqual(before)
}, { maxRingBytes: 400 }))

test('foreign grants, declared epoch and another publisher cannot mutate the current generation', () => nativeCase(async (f, n) => {
  const other = await n.tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
  await n.tasks.accept(f.bob.user, other.sessionId, requestId.parse(randomUUID()), 'other owner', f.bob.token)
  const otherGrant = await n.tasks.claim(randomUUID())
  if (!otherGrant) throw new Error('Other owned grant was not claimed')
  await n.store.apply(n.grant.token, batch(n, [start()]))
  const before = await persisted(f, n)
  await expect(n.store.apply(f.bob.token, batch(n, [], 2))).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(n.store.apply(n.grant.token, { ...batch(n, [], 2), epoch: n.grant.epoch + 1 })).rejects.toMatchObject({ code: 'native_assistant_epoch' })
  await expect(n.store.apply(n.grant.token, { ...batch(n, [], 2), publisherId: randomUUID() })).rejects.toMatchObject({ code: 'native_assistant_publisher' })
  expect(await persisted(f, n)).toEqual(before)
  // An opaque foreign execution grant addresses only its own Session; requests contain no Session selector.
  await n.store.apply(otherGrant.token, { ...batch(n, [start()]), epoch: otherGrant.epoch })
  expect(await persisted(f, n)).toEqual(before)
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentations')).rows).toEqual([{ count: 2 }])
}))

test('a new server epoch may replace old transient state but the old captured grant remains fenced', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'old generation' })]))
  n.native.append('turn/start', { turn: 1 })
  await n.store.apply(n.grant.token, batch(n, events(n), 3))
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.created.sessionId])
  const next = await n.tasks.claim(randomUUID())
  if (!next) throw new Error('Expired owned operation was not reclaimed')
  const publisherId = randomUUID()
  await n.store.apply(next.token, { ...batch(n, [start()]), epoch: next.epoch, publisherId })
  const before = await persisted(f, n)
  expect(await state(f, n)).toMatchObject({ epoch: next.epoch, publisherId, lastOrdinal: 1, revision: 1, cursor: 0,
    activeAttempt: { startedAfterSeq: 0, nextIndex: 0, stream: [] } })
  expect((await retained(f, n)).map(entry => entry.ordinal)).toEqual([1])
  await expect(n.store.apply(n.grant.token, batch(n, [], 4))).rejects.toMatchObject({ code: 'lease_lost' })
  expect(await persisted(f, n)).toEqual(before)
}))

test('same-epoch expired state cannot be revived or reset by heartbeat or a new publisher', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start()]))
  await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.created.sessionId])
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [], 2))).rejects.toMatchObject({ code: 'native_assistant_expired' })
  await expect(n.store.apply(n.grant.token, { ...batch(n, [start()]), publisherId: randomUUID() })).rejects.toThrow()
  expect(await persisted(f, n)).toEqual(before)
}))

async function waiting(f: CloudCase, sqlFragment: string): Promise<void> {
  await expect.poll(async () => {
    const result = await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS blocked`, [`%${sqlFragment}%`])
    return first(result.rows).blocked
  }, { timeout: 5000, interval: 10 }).toBe(true)
}

test('grant expiry while waiting for a Session lock is rechecked with the PG clock before any presentation write', () => nativeCase(async (f, n) => {
  const before = await persisted(f, n), lock = await f.pool.connect()
  await lock.query('BEGIN')
  try {
    await lock.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE', [n.created.sessionId])
    const pending = n.store.apply(n.grant.token, batch(n, [start()]))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'lease_lost' })
    await waiting(f, 'SELECT s.*,o.id AS operation_id')
    await lock.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.created.sessionId])
    await lock.query('COMMIT')
    await rejected
    expect(await persisted(f, n)).toEqual(before)
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test('presentation expiry across its row-lock wait refuses an otherwise live grant without inventing a fresh baseline', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start()]))
  const before = await persisted(f, n), lock = await f.pool.connect()
  await lock.query('BEGIN')
  try {
    await lock.query('SELECT session_id FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE', [n.created.sessionId])
    const pending = n.store.apply(n.grant.token, batch(n, [chunk({ type: 'text-delta', index: 0, text: 'late' })], 2))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'native_assistant_expired' })
    await waiting(f, 'SELECT epoch,publisher_id,last_ordinal,state_json')
    await lock.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.created.sessionId])
    await lock.query('COMMIT')
    await rejected
    expect(await persisted(f, n)).toEqual(before)
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test('account revocation committed during its authority-lock wait prevents publication', () => nativeCase(async (f, n) => {
  const before = await persisted(f, n), lock = await f.pool.connect()
  await lock.query('BEGIN')
  try {
    await lock.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [f.alice.user.userId])
    const pending = n.store.apply(n.grant.token, batch(n, [start()]))
    const rejected = expect(pending).rejects.toThrow()
    await waiting(f, 'FROM pe_users WHERE id=ANY')
    await lock.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId])
    await lock.query('COMMIT')
    await rejected
    expect(await persisted(f, n)).toEqual(before)
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test('final grant fence rolls back staged native history and checkpoint after a later real database lock wait', () => nativeCase(async (f, n) => {
  n.native.append('turn/start', { turn: 1 })
  await n.store.apply(n.grant.token, batch(n, events(n)))
  const before = await persisted(f, n), lock = await f.pool.connect()
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [n.created.sessionId])
  n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await lock.query('BEGIN')
  try {
    await lock.query('SELECT namespace FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2 FOR UPDATE',
      [f.alice.user.userId, `session-projections:${n.created.sessionId}`])
    const pending = n.store.apply(n.grant.token, batch(n, events(n, 1), 2))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'lease_lost' })
    await waiting(f, 'pe_native_preferences')
    await expect.poll(async () => first((await lock.query<{ expired: boolean }>(
      'SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1', [n.created.sessionId])).rows).expired,
    { timeout: 5000, interval: 20 }).toBe(true)
    await lock.query('COMMIT')
    await rejected
    expect(await persisted(f, n)).toEqual(before)
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test.each(['version', 'revision', 'index', 'cursor', 'extra', 'malformed packed run', 'ordinal revision', 'conflicting active state',
  'future start cursor', 'future settlement', 'early settlement'] as const)(
  'persisted %s corruption is refused without replacing the stored state with revision zero', mode => nativeCase(async (f, n) => {
    await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'original' })]))
    const valid = await state(f, n)
    const attempt = valid.activeAttempt
    if (!attempt) throw new Error('Expected the owned active attempt')
    let invalid: unknown = { ...valid, version: 2 }
    if (mode === 'revision') invalid = { ...valid, revision: 0 }
    if (mode === 'index') invalid = { ...valid, activeAttempt: { ...attempt, nextIndex: 2 } }
    if (mode === 'cursor') invalid = { ...valid, cursor: 0 }
    if (mode === 'extra') invalid = { ...valid, unknown: true }
    if (mode === 'malformed packed run') invalid = { ...valid, activeAttempt: { ...attempt,
      stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [1], texts: ['wrong length'] }] } }
    if (mode === 'ordinal revision') invalid = { ...valid, revision: valid.lastOrdinal + 1 }
    if (mode === 'conflicting active state') invalid = { ...valid, awaitingStepEnd: { turn: 1, step: 1 } }
    if (mode === 'future start cursor') invalid = { ...valid, activeAttempt: { ...attempt, startedAfterSeq: 0 } }
    if (mode === 'future settlement') invalid = { ...valid, activeAttempt: { ...attempt,
      settlement: { eventType: 'assistant/attempt', seq: 0, interrupted: false } } }
    if (mode === 'early settlement') invalid = { ...valid, cursor: 0, activeAttempt: { ...attempt, startedAfterSeq: 0,
      settlement: { eventType: 'assistant/attempt', seq: 0, interrupted: false } } }
    await f.pool.query('UPDATE pe_native_presentations SET state_json=$2 WHERE session_id=$1', [n.created.sessionId, JSON.stringify(invalid)])
    const before = await persisted(f, n)
    await expect(n.store.apply(n.grant.token, batch(n, [], 3))).rejects.toThrow()
    expect(await persisted(f, n)).toEqual(before)
    await f.pool.query('UPDATE pe_native_presentations SET state_json=$2 WHERE session_id=$1', [n.created.sessionId, JSON.stringify(valid)])
    expect(await n.store.apply(n.grant.token, batch(n, [], 3))).toMatchObject({ revision: 2 })
  }))

test('replayed canonical prefixes consume only private ordinals and a canonical gap rolls back without advancing either cursor', () => nativeCase(async (f, n) => {
  n.native.append('turn/start', { turn: 1 })
  await n.store.apply(n.grant.token, batch(n, events(n)))
  const savedHistory = (await persisted(f, n)).history
  expect(await n.store.apply(n.grant.token, batch(n, events(n), 2))).toMatchObject({ lastOrdinal: 2, eventCount: 1 })
  expect((await persisted(f, n)).history).toEqual(savedHistory)
  const before = await persisted(f, n), original = first(n.native.snapshotEvents())
  await expect(n.store.apply(n.grant.token, batch(n, [{ type: 'event', event: { ...original, seq: 2 } }], 3)))
    .rejects.toMatchObject({ code: 'native_assistant_event_gap' })
  expect(await persisted(f, n)).toEqual(before)
  await expect(n.store.apply(n.grant.token, batch(n, [{ type: 'event', event: { ...original, data: { turn: 2 } } }], 3)))
    .rejects.toMatchObject({ code: 'event_conflict' })
  expect(await persisted(f, n)).toEqual(before)
}))

test('an unrelated step and attempt cannot settle the current attempt or clear a successful message awaiting its own step/end', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'current' })]))
  n.native.append('step/end', { turn: 2, step: 3 })
  n.native.append('assistant/attempt', { turn: 2, step: 3, stream: [] })
  await n.store.apply(n.grant.token, batch(n, [...events(n), end(undefined)], 3))
  expect((await state(f, n)).activeAttempt).toBeUndefined()
  expect((await persisted(f, n)).history).toHaveLength(2)
}))

test('a second settlement for the same still-open attempt rolls back both original canonical events', () => nativeCase(async (f, n) => {
  const s = settled(n, 'one pending settlement', false)
  n.native.append('assistant/attempt', { turn: 1, step: 1, stream: s.stream })
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), ...events(n, 2)])))
    .rejects.toMatchObject({ code: 'native_assistant_settlement' })
  expect(await persisted(f, n)).toEqual(before)
}))

test('byte eviction keeps the complete multi-delta compact attempt when only its newest frame fits the ring', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'one' }),
    chunk({ type: 'text-delta', index: 0, text: 'two' }, 3, 1, 'owned:1', 101)]))
  expect((await retained(f, n)).map(entry => entry.ordinal)).toEqual([3])
  expect(nativeAssistantBaseline(await state(f, n), n.limits).activeAttempt?.stream)
    .toEqual([{ type: 'text-chunks', time0: 100, index: 0, dt: [1], texts: ['one', 'two'] }])
}, { maxRingBytes: 270 }))

test('the existing exact maximum native event fits its publication wrapper and one extra event byte rolls back', () => nativeCase(async (f, n) => {
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1',
    [n.created.sessionId])).rows).header)
  const template = Session.create(header.id, undefined, header)
  template.append('session/title', { title: '', messageSeqs: [], source: { kind: 'user' } })
  const overhead = nativeAssistantBytes(first(template.snapshotEvents()))
  n.native.append('session/title', { title: 'x'.repeat(eventLimits.maxEventBytes - overhead), messageSeqs: [], source: { kind: 'user' } })
  expect(nativeAssistantBytes(first(n.native.snapshotEvents()))).toBe(eventLimits.maxEventBytes)
  expect(await n.store.apply(n.grant.token, batch(n, events(n)))).toMatchObject({ eventCount: 1, lastOrdinal: 1 })
  const before = await persisted(f, n)
  n.native.append('session/title', { title: 'x'.repeat(eventLimits.maxEventBytes - overhead + 1), messageSeqs: [], source: { kind: 'user' } })
  expect(nativeAssistantBytes(first(n.native.snapshotEvents().slice(1)))).toBe(eventLimits.maxEventBytes + 1)
  await expect(n.store.apply(n.grant.token, batch(n, events(n, 1), 2))).rejects.toMatchObject({ code: 'history_limit' })
  expect(await persisted(f, n)).toEqual(before)
}))

test.each(['id', 'epoch', 'publisher', 'ordinal', 'version', 'invalid JSON'] as const)(
  'stored last-batch %s corruption cannot fabricate a successful retry receipt', mode => nativeCase(async (f, n) => {
    const input = batch(n, [start()])
    await n.store.apply(n.grant.token, input)
    let corrupted: unknown = { ...input, batchId: randomUUID() }
    if (mode === 'epoch') corrupted = { ...input, epoch: input.epoch + 1 }
    if (mode === 'publisher') corrupted = { ...input, publisherId: randomUUID() }
    if (mode === 'ordinal') corrupted = { ...input, firstOrdinal: 2 }
    if (mode === 'version') corrupted = { ...input, version: 2 }
    await f.pool.query('UPDATE pe_native_presentations SET last_batch_json=$2 WHERE session_id=$1',
      [n.created.sessionId, mode === 'invalid JSON' ? '{broken' : JSON.stringify(corrupted)])
    const before = await persisted(f, n)
    await expect(n.store.apply(n.grant.token, input)).rejects.toThrow()
    await expect(n.store.apply(n.grant.token, batch(n, [], 2))).rejects.toThrow()
    expect(await persisted(f, n)).toEqual(before)
    await f.pool.query('UPDATE pe_native_presentations SET last_batch_json=$2 WHERE session_id=$1', [n.created.sessionId, JSON.stringify(input)])
    expect(await n.store.apply(n.grant.token, input)).toMatchObject({ revision: 1, lastOrdinal: 1 })
  }))

test('a valid empty generation without a saved receipt admits its first original batch', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  await f.pool.query('UPDATE pe_native_presentations SET last_batch_id=NULL,last_batch_json=NULL WHERE session_id=$1', [n.created.sessionId])
  expect(await n.store.apply(n.grant.token, batch(n, [start()]))).toMatchObject({ revision: 1, lastOrdinal: 1 })
  expect(readNativeAssistantState(await state(f, n), n.limits).activeAttempt?.nextIndex).toBe(0)
}))

test('a stored server epoch ahead of authorization is refused without discarding its existing entries', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start()]))
  await f.pool.query('UPDATE pe_native_presentations SET epoch=epoch+1 WHERE session_id=$1', [n.created.sessionId])
  const before = await persisted(f, n)
  await expect(n.store.apply(n.grant.token, batch(n, [], 2))).rejects.toMatchObject({ code: 'native_assistant_epoch' })
  expect(await persisted(f, n)).toEqual(before)
}))

test.each(['new grant expiry', 'existing presentation expiry'] as const)(
  '%s at the final database fence rolls back staged history, checkpoint and generation together', mode => nativeCase(async (f, n) => {
    if (mode === 'existing presentation expiry') await n.store.apply(n.grant.token, batch(n, []))
    const before = await persisted(f, n), lock = await f.pool.connect()
    if (mode === 'new grant expiry') {
      await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [n.created.sessionId])
    } else {
      await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()+interval '1 second' WHERE session_id=$1",
        [n.created.sessionId])
    }
    n.native.append('turn/start', { turn: 1 })
    await lock.query('BEGIN')
    try {
      await lock.query('LOCK TABLE pe_native_preferences IN ACCESS EXCLUSIVE MODE')
      const pending = n.store.apply(n.grant.token, batch(n, events(n)))
      const rejected = expect(pending).rejects.toMatchObject({ code: mode === 'new grant expiry' ? 'lease_lost' : 'native_assistant_expired' })
      await waiting(f, 'SELECT value FROM pe_native_preferences')
      const clockSql = mode === 'new grant expiry'
        ? 'SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1'
        : 'SELECT expires_at<=clock_timestamp() AS expired FROM pe_native_presentations WHERE session_id=$1'
      await expect.poll(async () => first((await lock.query<{ expired: boolean }>(clockSql, [n.created.sessionId])).rows).expired,
        { timeout: 5000, interval: 20 }).toBe(true)
      await lock.query('COMMIT')
      await rejected
      expect(await persisted(f, n)).toEqual(before)
    } finally { await lock.query('ROLLBACK'); lock.release() }
  }))

test('known raw chunk payloads retain opaque JSON while unsupported chunk tags still use the official refusal', () => nativeCase(async (f, n) => {
  const opaque = { type: 'finish', reason: { kind: 'adapter-future', providerPayload: ['中\0\uD800', { exact: true }] }, extension: 'keep' }
  await n.store.apply(n.grant.token, batch(n, [start(), chunk(opaque)]))
  expect((await state(f, n)).activeAttempt?.stream).toEqual([{ type: 'chunk', time: 100, chunk: opaque }])
  expect((await retained(f, n))[1]?.item).toMatchObject({ frame: { chunk: opaque } })
}))

test('strict foreign wire fields reject negative-zero, oversized ordinals and a claimed startedAfterSeq', () => {
  const empty = createNativeAssistantState(1, randomUUID(), -1)
  expect(empty.lastOrdinal).toBe(0)
  expect(nativeAssistantBaseline(empty, presentationLimits)).toEqual({ revision: 0 })
  const input = { version: 1, epoch: 1, publisherId: randomUUID(), batchId: randomUUID(), firstOrdinal: 1, items: [start()] }
  for (const invalid of [
    { ...input, firstOrdinal: 0 }, { ...input, firstOrdinal: -0 }, { ...input, version: 2 }, { ...input, grant: 'must-not-store' },
    { ...input, firstOrdinal: Number.MAX_SAFE_INTEGER },
    { ...input, items: [{ type: 'assistant-stream', frame: { ...start().frame, startedAfterSeq: -1 } }] },
    { ...input, items: [chunk({ type: 'text-delta', index: 0, text: 'x' }, 2, -0)] },
  ]) expect(() => parseNativeAssistantBatch(invalid, presentationLimits)).toThrow()
  expect(() => nativeAssistantBytes(undefined)).toThrow()
  const circular: { self?: object } = {}; circular.self = circular
  expect(() => nativeAssistantBytes(circular)).toThrow()
})
