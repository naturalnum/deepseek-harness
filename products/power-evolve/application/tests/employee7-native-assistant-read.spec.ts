/** Real PG coherent cuts and the official assembled Client's settlement/end consumption. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { Session } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, createAssistantMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { requestId } from '../src/contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { transaction } from '../src/platform/database.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeAssistantRead, nativeAssistantPosition, type NativeAssistantReadRow,
  type NativeAssistantReadLimits } from '../src/platform/native-assistant-read.ts'
import type { NativeAssistantLimits } from '../src/native-assistant-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const taskLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const presentation: NativeAssistantLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }
const readLimits: NativeAssistantReadLimits = { maxOpeningBytes: 8_388_608, maxBaselineChunks: 1_048_576,
  maxPacketItems: 256, maxPacketBytes: 4_194_304, maxCanonicalBytes: 8_388_608 }
const jsonObject = z.record(z.string(), z.json())
type JsonRecord = z.infer<typeof jsonObject>
type CloudCase = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Admitted = Awaited<ReturnType<typeof admitted>>

function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('Owned assistant read fixture returned no row')
  return value
}

async function admitted(f: CloudCase, overrides: Partial<NativeAssistantLimits> = {}, reader: Partial<NativeAssistantReadLimits> = {}) {
  const tasks = new TaskStore(f.pool, taskLimits), events = new EventStore(tasks, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'owned coherent reader', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned coherent reader grant was not claimed')
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1',
    [created.sessionId])).rows).header)
  const limits = { ...presentation, ...overrides }
  return { tasks, events, created, grant, header, native: Session.create(header.id, undefined, header), publisherId: randomUUID(),
    store: new NativeAssistantStore(tasks, events, limits), read: new NativeAssistantRead(limits, { ...readLimits, ...reader }), limits }
}

async function locked<T>(f: CloudCase, n: Admitted, run: (client: PoolClient, row: NativeAssistantReadRow) => Promise<T>,
  owner = f.alice.user): Promise<T> {
  return transaction(f.pool, async (client) => {
    // The product caller owns authentication; this fixture supplies the authenticated fixture identity.
    const result = await client.query<{ header: unknown; event_count: number; lease_epoch: number }>(
      'SELECT header,event_count,lease_epoch FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',
      [n.created.sessionId, owner.userId])
    const saved = first(result.rows)
    return run(client, { sessionId: n.created.sessionId, header: headerSchema.parse(saved.header),
      eventCount: saved.event_count, leaseEpoch: saved.lease_epoch })
  })
}

async function nativeCase(run: (f: CloudCase, n: Admitted) => Promise<void>, overrides: Partial<NativeAssistantLimits> = {},
  reader: Partial<NativeAssistantReadLimits> = {}): Promise<void> {
  await cloudFixture(async (f) => { await run(f, await admitted(f, overrides, reader)) })
}

function batch(n: Admitted, items: readonly unknown[], firstOrdinal = 1) {
  return { version: 1, epoch: n.grant.epoch, publisherId: n.publisherId, batchId: randomUUID(), firstOrdinal, items }
}

function start(revision = 1, attemptId = 'reader:1') {
  return { type: 'assistant-stream', frame: { type: 'start', attemptId, revision, turn: 1, step: 1 } }
}

function chunk(value: unknown, revision = 2, index = 0, attemptId = 'reader:1', time = 100) {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision, index, time, chunk: value } }
}

function end(seq: number | undefined, revision = 3, index = 1, eventType = 'assistant/attempt', attemptId = 'reader:1') {
  return { type: 'assistant-stream', frame: { type: 'end', attemptId, revision, index,
    outcome: seq === undefined ? { kind: 'abandoned' } : { kind: 'committed', seq, eventType } } }
}

function events(n: Admitted, start = 0) { return n.native.snapshotEvents().slice(start).map(event => ({ type: 'event', event })) }

function settlement(n: Admitted, kind: 'attempt' | 'message' | 'interrupted') {
  const text = 'original\0\uD800 😀', accumulator = new AssistantStreamAccumulator()
  const raw: StreamChunk = { type: 'text-delta', index: 0, text }
  accumulator.push({ time: 100, chunk: raw })
  const stream = [...accumulator.snapshot()]
  n.native.append('turn/start', { turn: 1 }); n.native.append('step/start', { turn: 1, step: 1 })
  const prefix = events(n)
  if (kind === 'attempt') n.native.append('assistant/attempt', { turn: 1, step: 1, stream })
  else n.native.append('assistant/message', { turn: 1, step: 1, stream,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'owned-fixture', model: 'owned-fixture' } }),
    ...(kind === 'interrupted' ? { interrupted: true } : {}) }, { surfaceOp: 'append' })
  return { raw, stream, prefix, seq: first(n.native.snapshotEvents().slice(2)).seq,
    eventType: kind === 'attempt' ? 'assistant/attempt' : 'assistant/message' }
}

test('empty presentation reads preserve the caller transaction and tenant ownership while returning genuine revision zero', () => nativeCase(async (f, n) => {
  expect(await locked(f, n, (client, row) => n.read.open(client, row))).toEqual({ baseline: { revision: 0 }, position: null })
  await expect(locked(f, n, (client, row) => n.read.open(client, row), f.bob.user)).rejects.toThrow('returned no row')
  n.native.append('turn/start', { turn: 1 }); n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await n.events.append(n.grant.token, n.native.snapshotEvents())
  await locked(f, n, async (client, row) => {
    const next = await n.read.after(client, row, null, -1, 1)
    expect(next).toMatchObject({ kind: 'next', position: null, cursor: 0 })
    if (next.kind !== 'next') throw new Error('Expected native suffix')
    expect(next.frames).toEqual([{ type: 'event', event: n.native.snapshotEvents()[0] }])
    await client.query('UPDATE pe_sessions SET event_bytes=event_bytes+1 WHERE id=$1', [row.sessionId])
    throw new Error('caller rollback')
  }).catch((error: unknown) => { expect(error).toMatchObject({ message: 'caller rollback' }) })
  const bytes = first((await f.pool.query<{ event_bytes: string }>('SELECT event_bytes FROM pe_sessions WHERE id=$1',
    [n.created.sessionId])).rows).event_bytes
  const expectedBytes = n.native.snapshotEvents().reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
  expect(bytes).toBe(String(expectedBytes))
  expect(await locked(f, n, (client, row) => n.read.after(client, row, null, 0, 256))).toMatchObject({ kind: 'next', cursor: 1 })
}))

test('one locked opening exposes the complete actual compact prefix and its matching private ordinal', () => nativeCase(async (f, n) => {
  n.native.append('turn/start', { turn: 1 }); n.native.append('step/start', { turn: 1, step: 1 })
  const raw = { type: 'text-delta', index: 0, text: '中\0\uD800' }
  await n.store.apply(n.grant.token, batch(n, [...events(n), start(), chunk(raw)]))
  expect(await locked(f, n, (client, row) => n.read.open(client, row))).toEqual({
    baseline: { revision: 2, activeAttempt: { attemptId: 'reader:1', turn: 1, step: 1, startedAfterSeq: 1, nextIndex: 1,
      stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [], texts: [raw.text] }] } },
    position: { epoch: n.grant.epoch, publisherId: n.publisherId, ordinal: 4 },
  })
}))

test('ordered reads interleave genuine canonical settlement and end before step/end and do not repeat old event references', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  const opening = await locked(f, n, (client, row) => n.read.open(client, row)), s = settlement(n, 'message')
  n.native.append('step/end', { turn: 1, step: 1 }); n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), ...events(n, 2).slice(0, 1),
    end(s.seq, 3, 1, s.eventType), ...events(n, 3)]))
  const next = await locked(f, n, (client, row) => n.read.after(client, row, opening.position, -1, 256))
  if (next.kind !== 'next') throw new Error('Expected ordered publication')
  expect(next.frames.map(frame => frame.type === 'event' ? frame.event.type : frame.frame.type))
    .toEqual(['turn/start', 'step/start', 'start', 'chunk', 'assistant/message', 'end', 'step/end', 'turn/end'])
  expect(next).toMatchObject({ cursor: 4, position: { ordinal: 8 } })
  await n.store.apply(n.grant.token, batch(n, events(n), 9))
  const duplicate = await locked(f, n, (client, row) => n.read.after(client, row, next.position, next.cursor, 256))
  expect(duplicate).toMatchObject({ kind: 'next', cursor: 4, position: { ordinal: 13 }, frames: [] })
}))

test.each(['attempt', 'message', 'interrupted'] as const)(
  '%s settlement cut hides its already durable attempt and preserves the exact later end and step/end', kind => nativeCase(async (f, n) => {
    const s = settlement(n, kind)
    await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), ...events(n, 2)]))
    const opening = await locked(f, n, (client, row) => n.read.open(client, row))
    expect(opening.baseline).toEqual({ revision: 2 })
    const saved = await f.pool.query<{ event_json: string }>('SELECT event::text AS event_json FROM pe_events WHERE session_id=$1 ORDER BY seq',
      [n.created.sessionId])
    const records = saved.rows.map(row => ({ type: 'event', event: z.json().parse(JSON.parse(row.event_json)) }))
    const snapshot = { type: 'snapshot', header: { ...n.header, cwd: '/workspace' }, cursor: 2, records,
      hasMore: false, projections: { asOfSeq: 2, values: {} }, assistantStream: opening.baseline }
    await n.store.apply(n.grant.token, batch(n, [end(s.seq, 3, 1, s.eventType)], 6))
    const next = await locked(f, n, (client, row) => n.read.after(client, row, opening.position, 2, 256))
    expect(next).toMatchObject({ kind: 'next', position: { ordinal: 6 }, cursor: 2,
      frames: [end(s.seq, 3, 1, s.eventType)] })
    if (next.kind !== 'next') throw new Error('Expected the genuine pending end')
    n.native.append('step/end', { turn: 1, step: 1 })
    await n.store.apply(n.grant.token, batch(n, events(n, 3), 7))
    const following = await locked(f, n, (client, row) => n.read.after(client, row, next.position, next.cursor, 256))
    expect(following).toMatchObject({ kind: 'next', position: { ordinal: 7 }, cursor: 3,
      frames: [{ type: 'event', event: n.native.snapshotEvents()[3] }] })
    // Separate Client compiler evidence consumes these exact PG-produced JSON packets.
    const destination = process.env['PE_EMPLOYEE7_CLIENT_FIXTURES_DIR']
    if (destination !== undefined) {
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, `${kind}.json`), JSON.stringify({ sessionId: n.created.sessionId,
        eventType: s.eventType, snapshot, next, following }))
    }
  }))

test.each(['TTL', 'lease', 'operation', 'epoch', 'publisher', 'ring eviction'] as const)(
  '%s retires an existing generation normally instead of inventing terminal frames', mode => nativeCase(async (f, n) => {
    await n.store.apply(n.grant.token, batch(n, [start()]))
    const opening = await locked(f, n, (client, row) => n.read.open(client, row))
    if (mode === 'TTL') await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.created.sessionId])
    if (mode === 'lease') await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.created.sessionId])
    if (mode === 'operation') await f.pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [n.grant.operationId])
    if (mode === 'epoch') await f.pool.query('UPDATE pe_sessions SET lease_epoch=lease_epoch+1 WHERE id=$1', [n.created.sessionId])
    if (mode === 'publisher') {
      if (!opening.position) throw new Error('Expected the owned publisher position')
      opening.position.publisherId = randomUUID()
    }
    if (mode === 'ring eviction') {
      await n.store.apply(n.grant.token, batch(n, [chunk({ type: 'text-delta', index: 0, text: 'one' }),
        chunk({ type: 'text-delta', index: 0, text: 'two' }, 3, 1)], 2))
    }
    expect(await locked(f, n, (client, row) => n.read.after(client, row, opening.position, -1, 256))).toEqual({ kind: 'reopen' })
  }, { maxRingItems: 1 }))

test('an inactive opening falls back to native history and a newly live publisher requires a fresh official opening', () => nativeCase(async (f, n) => {
  const empty = await locked(f, n, (client, row) => n.read.open(client, row))
  await n.store.apply(n.grant.token, batch(n, [start()]))
  expect(await locked(f, n, (client, row) => n.read.after(client, row, empty.position, -1, 256))).toEqual({ kind: 'reopen' })
  await n.tasks.finish(n.grant.token, 'completed', null)
  expect(await locked(f, n, (client, row) => n.read.open(client, row))).toEqual({ baseline: { revision: 0 }, position: null })
}))

test.each(['future ordinal', 'future epoch', 'future cursor', 'ordinal gap', 'native missing', 'native embedded seq',
  'reference type', 'receipt', 'state cursor', 'state JSON', 'future revision'] as const)(
  '%s is a terminal 503 corruption refusal with no silent generation reopen', mode => nativeCase(async (f, n) => {
    await n.store.apply(n.grant.token, batch(n, []))
    const opening = await locked(f, n, (client, row) => n.read.open(client, row))
    n.native.append('turn/start', { turn: 1 })
    await n.store.apply(n.grant.token, batch(n, [...events(n), start(), chunk({ type: 'text-delta', index: 0, text: 'real' })]))
    let position = opening.position
    let cursor = -1
    if (!position) throw new Error('Expected the owned empty generation')
    if (mode === 'future ordinal') position = { ...position, ordinal: 4 }
    if (mode === 'future epoch') position = { ...position, epoch: position.epoch + 1 }
    if (mode === 'future cursor') cursor = 1
    if (mode === 'ordinal gap') await f.pool.query('DELETE FROM pe_native_presentation_entries WHERE session_id=$1 AND ordinal=2', [n.created.sessionId])
    if (mode === 'native missing') await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=0', [n.created.sessionId])
    if (mode === 'native embedded seq') await f.pool.query("UPDATE pe_events SET event=json_build_object('seq',1,'time',100,'type','turn/start','data',json_build_object('turn',1)) WHERE session_id=$1", [n.created.sessionId])
    if (mode === 'receipt') await f.pool.query("UPDATE pe_native_presentations SET last_batch_json='{broken' WHERE session_id=$1", [n.created.sessionId])
    if (mode === 'state JSON') await f.pool.query("UPDATE pe_native_presentations SET state_json='{broken' WHERE session_id=$1", [n.created.sessionId])
    if (mode === 'state cursor') {
      const saved = z.record(z.string(), z.json()).parse(JSON.parse(first((await f.pool.query<{ state_json: string }>(
        'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [n.created.sessionId])).rows).state_json))
      await f.pool.query('UPDATE pe_native_presentations SET state_json=$2 WHERE session_id=$1', [n.created.sessionId, JSON.stringify({ ...saved, cursor: -1 })])
    }
    if (mode === 'reference type' || mode === 'future revision') {
      const ordinal = mode === 'reference type' ? 1 : 3
      const savedEntry = first((await f.pool.query<{ item_json: string }>(
        'SELECT item_json FROM pe_native_presentation_entries WHERE session_id=$1 AND ordinal=$2', [n.created.sessionId, ordinal])).rows).item_json
      const old = z.object({ ordinal: z.number(), item: z.record(z.string(), z.json()) }).parse(JSON.parse(savedEntry))
      const item = mode === 'reference type' ? { ...old.item, eventType: 'turn/end' }
        : { ...old.item, frame: { ...z.record(z.string(), z.json()).parse(old.item['frame']), revision: 99 } }
      const original = JSON.stringify({ ...old, item })
      await f.pool.query('UPDATE pe_native_presentation_entries SET item_json=$3,item_bytes=$4 WHERE session_id=$1 AND ordinal=$2',
        [n.created.sessionId, ordinal, original, Buffer.byteLength(original)])
    }
    await expect(locked(f, n, (client, row) => n.read.after(client, row, position, cursor, 256))).rejects.toMatchObject({ status: 503 })
  }))

test('reader baseline item count rejects the whole authentic prefix instead of truncating its compact stream', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'one' }),
    chunk({ type: 'text-delta', index: 0, text: 'two' }, 3, 1)]))
  await expect(locked(f, n, (client, row) => n.read.open(client, row))).rejects.toMatchObject({ status: 503, code: 'native_assistant_read_budget' })
}, {}, { maxBaselineChunks: 1 }))

test('packet item count advances an exact private prefix and canonical cursor across multiple coherent reads', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  const opening = await locked(f, n, (client, row) => n.read.open(client, row))
  n.native.append('turn/start', { turn: 1 })
  await n.store.apply(n.grant.token, batch(n, [...events(n), start(), chunk({ type: 'text-delta', index: 0, text: 'once' })]))
  const firstPacket = await locked(f, n, (client, row) => n.read.after(client, row, opening.position, -1, 999))
  expect(firstPacket).toMatchObject({ kind: 'next', position: { ordinal: 2 }, cursor: 0 })
  if (firstPacket.kind !== 'next') throw new Error('Expected the bounded first packet')
  expect(firstPacket.frames).toHaveLength(2)
  const secondPacket = await locked(f, n, (client, row) => n.read.after(client, row, firstPacket.position, firstPacket.cursor, 999))
  expect(secondPacket).toMatchObject({ kind: 'next', position: { ordinal: 3 }, cursor: 0 })
  if (secondPacket.kind !== 'next') throw new Error('Expected the bounded second packet')
  expect(secondPacket.frames).toHaveLength(1)
}, {}, { maxPacketItems: 2 }))

test('a Session FOR SHARE holds the same canonical/presentation cut until the caller commits', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  const lock = await f.pool.connect()
  await lock.query('BEGIN')
  try {
    const saved = first((await lock.query<{ header: unknown; event_count: number; lease_epoch: number }>(
      'SELECT header,event_count,lease_epoch FROM pe_sessions WHERE id=$1 FOR SHARE', [n.created.sessionId])).rows)
    const row = { sessionId: n.created.sessionId, header: headerSchema.parse(saved.header),
      eventCount: saved.event_count, leaseEpoch: saved.lease_epoch }
    const opening = await n.read.open(lock, row)
    n.native.append('turn/start', { turn: 1 })
    const pending = n.store.apply(n.grant.token, batch(n, [...events(n), start()]))
    await expect.poll(async () => first((await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT s.*,o.id AS operation_id%') AS blocked`)).rows).blocked,
    { timeout: 5000, interval: 10 }).toBe(true)
    expect(await n.read.open(lock, row)).toEqual(opening)
    expect(await n.read.after(lock, row, opening.position, -1, 256)).toMatchObject({ kind: 'next', frames: [], cursor: -1 })
    await lock.query('COMMIT'); await pending
    expect(await locked(f, n, (client, current) => n.read.after(client, current, opening.position, -1, 256)))
      .toMatchObject({ kind: 'next', cursor: 0, position: { ordinal: 2 } })
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test('opening rechecks the PG clock after a real presentation lock wait crosses TTL', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start()]))
  await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()+interval '1 second' WHERE session_id=$1", [n.created.sessionId])
  const lock = await f.pool.connect()
  await lock.query('BEGIN')
  try {
    await lock.query('SELECT session_id FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE', [n.created.sessionId])
    const pending = locked(f, n, (client, row) => n.read.open(client, row))
    await expect.poll(async () => first((await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM pe_native_presentations WHERE session_id=$1 FOR SHARE%') AS blocked`)).rows).blocked,
    { timeout: 5000, interval: 10 }).toBe(true)
    await expect.poll(async () => first((await lock.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM pe_native_presentations WHERE session_id=$1',
      [n.created.sessionId])).rows).expired, { timeout: 5000, interval: 20 }).toBe(true)
    await lock.query('COMMIT')
    expect(await pending).toEqual({ baseline: { revision: 0 }, position: null })
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test('read deployment budgets refuse unsupported complete frames and strict positions reject noncanonical ordinals', () => {
  for (const limits of [{ ...readLimits, maxPacketBytes: presentation.maxItemBytes },
    { ...readLimits, maxOpeningBytes: 511 },
    { ...readLimits, maxCanonicalBytes: 1 }, { ...readLimits, maxBaselineChunks: 0 }]) {
    expect(() => new NativeAssistantRead(presentation, limits)).toThrow()
  }
  const position = { epoch: 1, publisherId: randomUUID(), ordinal: 0 }
  expect(nativeAssistantPosition.parse(position)).toEqual(position)
  for (const invalid of [{ ...position, ordinal: -0 }, { ...position, ordinal: -1 }, { ...position, grant: 'not-a-field' }]) {
    expect(() => nativeAssistantPosition.parse(invalid)).toThrow()
  }
})

async function changeState(f: CloudCase, n: Admitted, change: (saved: JsonRecord) => unknown): Promise<void> {
  const row = first((await f.pool.query<{ state_json: string }>('SELECT state_json FROM pe_native_presentations WHERE session_id=$1',
    [n.created.sessionId])).rows)
  const saved = z.record(z.string(), z.json()).parse(JSON.parse(row.state_json))
  await f.pool.query('UPDATE pe_native_presentations SET state_json=$2 WHERE session_id=$1', [n.created.sessionId, JSON.stringify(change(saved))])
}

async function changeEntry(f: CloudCase, n: Admitted, ordinal: number, change: (saved: JsonRecord) => unknown): Promise<void> {
  const row = first((await f.pool.query<{ item_json: string }>('SELECT item_json FROM pe_native_presentation_entries WHERE session_id=$1 AND ordinal=$2',
    [n.created.sessionId, ordinal])).rows)
  const value = JSON.stringify(change(z.record(z.string(), z.json()).parse(JSON.parse(row.item_json))))
  await f.pool.query('UPDATE pe_native_presentation_entries SET item_json=$3,item_bytes=$4 WHERE session_id=$1 AND ordinal=$2',
    [n.created.sessionId, ordinal, value, Buffer.byteLength(value)])
}

test.each(['type', 'turn', 'stream', 'interrupted'] as const)(
  'a pending settlement with different canonical %s is refused before its attempt can be hidden', mode => nativeCase(async (f, n) => {
    const s = settlement(n, 'message')
    await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), ...events(n, 2)]))
    const original = z.record(z.string(), z.json()).parse(first((await f.pool.query<{ event: unknown }>(
      'SELECT event FROM pe_events WHERE session_id=$1 AND seq=2', [n.created.sessionId])).rows).event)
    const data = z.record(z.string(), z.json()).parse(original['data'])
    const modified = mode === 'type' ? { seq: original['seq'], time: original['time'], type: 'assistant/attempt',
      data: { turn: data['turn'], step: data['step'], stream: data['stream'] } }
      : { ...original, data: { ...data, ...(mode === 'turn' ? { turn: 2 } : mode === 'stream' ? { stream: [] } : { interrupted: true }) } }
    await f.pool.query('UPDATE pe_events SET event=$2::json WHERE session_id=$1 AND seq=2', [n.created.sessionId, JSON.stringify(modified)])
    await expect(locked(f, n, (client, row) => n.read.open(client, row))).rejects.toMatchObject({ status: 503,
      code: 'native_assistant_settlement_invalid' })
  }))

test.each(['state bytes', 'receipt bytes', 'receipt identity', 'missing receipt', 'metadata', 'entry ordinal', 'entry future seq',
  'tail missing', 'revision tail', 'ring count', 'ring bytes', 'ring item', 'reference canonical type'] as const)(
  '%s damage or deployment overflow is explicitly refused from genuine persisted presentation', mode => nativeCase(async (f, n) => {
    n.native.append('turn/start', { turn: 1 })
    await n.store.apply(n.grant.token, batch(n, [...events(n), start(), chunk({ type: 'text-delta', index: 0, text: 'x'.repeat(1000) })]))
    // A valid empty retry receipt leaves earlier retained entries independent of the last batch.
    await n.store.apply(n.grant.token, batch(n, [], 4))
    let reader = n.read
    if (mode === 'state bytes') await f.pool.query('UPDATE pe_native_presentations SET state_json=$2 WHERE session_id=$1',
      [n.created.sessionId, ' '.repeat(n.limits.maxActiveBytes + 513)])
    if (mode === 'receipt bytes') await f.pool.query('UPDATE pe_native_presentations SET last_batch_json=$2 WHERE session_id=$1',
      [n.created.sessionId, ' '.repeat(n.limits.maxBatchBytes + 1)])
    if (mode === 'receipt identity') await f.pool.query('UPDATE pe_native_presentations SET last_batch_id=$2 WHERE session_id=$1',
      [n.created.sessionId, randomUUID()])
    if (mode === 'missing receipt') await f.pool.query('UPDATE pe_native_presentations SET last_batch_id=NULL,last_batch_json=NULL WHERE session_id=$1',
      [n.created.sessionId])
    if (mode === 'metadata') await changeState(f, n, saved => ({ ...saved, publisherId: randomUUID() }))
    if (mode === 'entry ordinal') await changeEntry(f, n, 1, saved => ({ ...saved, ordinal: 2 }))
    if (mode === 'entry future seq' || mode === 'reference canonical type') await changeEntry(f, n, 1, saved => ({ ...saved,
      item: { ...z.record(z.string(), z.json()).parse(saved['item']), ...(mode === 'entry future seq' ? { seq: 1 } : { eventType: 'turn/end' }) } }))
    if (mode === 'tail missing') await f.pool.query('DELETE FROM pe_native_presentation_entries WHERE session_id=$1 AND ordinal=3',
      [n.created.sessionId])
    if (mode === 'revision tail') await changeState(f, n, saved => ({ ...saved, revision: 3 }))
    if (mode === 'ring count') reader = new NativeAssistantRead({ ...n.limits, maxRingItems: 1 }, readLimits)
    if (mode === 'ring bytes') reader = new NativeAssistantRead({ ...n.limits, maxRingBytes: 100 }, readLimits)
    if (mode === 'ring item') reader = new NativeAssistantRead({ ...n.limits, maxItemBytes: 640, maxEventBytes: 128 },
      readLimits)
    const position = { epoch: n.grant.epoch, publisherId: n.publisherId, ordinal: 0 }
    await expect(locked(f, n, (client, row) => reader.after(client, row, position, -1, 256))).rejects.toMatchObject({ status: 503 })
  }))

test('an empty generation without a receipt remains valid and an older epoch may lag a newer canonical watermark', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  await f.pool.query('UPDATE pe_native_presentations SET last_batch_id=NULL,last_batch_json=NULL WHERE session_id=$1', [n.created.sessionId])
  expect(await locked(f, n, (client, row) => n.read.open(client, row)))
    .toMatchObject({ baseline: { revision: 0 }, position: { ordinal: 0 } })
  n.native.append('turn/start', { turn: 1 })
  await n.events.append(n.grant.token, n.native.snapshotEvents())
  await f.pool.query('UPDATE pe_sessions SET lease_epoch=lease_epoch+1 WHERE id=$1', [n.created.sessionId])
  expect(await locked(f, n, (client, row) => n.read.open(client, row))).toEqual({ baseline: { revision: 0 }, position: null })
  expect(await locked(f, n, (client, row) => n.read.after(client, row, null, -1, 1))).toMatchObject({ kind: 'next', cursor: 0 })
}))

test.each(['gap', 'empty tail', 'start barrier', 'end barrier'] as const)(
  '%s in a caller continuation cannot skip required native publication', mode => nativeCase(async (f, n) => {
    const s = settlement(n, 'attempt')
    await n.store.apply(n.grant.token, batch(n, [...s.prefix, start(), chunk(s.raw), ...events(n, 2), end(s.seq)]))
    const ordinal = mode === 'gap' ? 1 : mode === 'empty tail' ? 6 : mode === 'start barrier' ? 2 : 5
    const cursor = mode === 'start barrier' ? 0 : mode === 'end barrier' ? 1 : -1
    await expect(locked(f, n, (client, row) => n.read.after(client, row,
      { epoch: n.grant.epoch, publisherId: n.publisherId, ordinal }, cursor, 256))).rejects.toMatchObject({ status: 503 })
  }))

test('a complete opening exceeding its independent serialized budget is refused instead of truncating the prefix', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'x'.repeat(1000) })]))
  const reader = new NativeAssistantRead(n.limits, { ...readLimits, maxOpeningBytes: 512 })
  await expect(locked(f, n, (client, row) => reader.open(client, row))).rejects.toMatchObject({ status: 503, code: 'native_assistant_read_budget' })
}))

test('packet bytes advance only accepted original ordinals and preserve the following large chunk', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  const opening = await locked(f, n, (client, row) => n.read.open(client, row))
  await n.store.apply(n.grant.token, batch(n, [start(), chunk({ type: 'text-delta', index: 0, text: 'a'.repeat(600_000) })]))
  await n.store.apply(n.grant.token, batch(n, [chunk({ type: 'text-delta', index: 0, text: 'b'.repeat(600_000) }, 3, 1)], 3))
  const reader = new NativeAssistantRead(n.limits, { ...readLimits, maxPacketBytes: n.limits.maxItemBytes + 512 })
  const next = await locked(f, n, (client, row) => reader.after(client, row, opening.position, -1, 256))
  expect(next).toMatchObject({ kind: 'next', cursor: -1, position: { ordinal: 2 } })
  if (next.kind !== 'next') throw new Error('Expected the first large chunk')
  expect(next.frames).toHaveLength(2)
  expect(await locked(f, n, (client, row) => reader.after(client, row, next.position, next.cursor, 256)))
    .toMatchObject({ kind: 'next', cursor: -1, position: { ordinal: 3 }, frames: [chunk({ type: 'text-delta', index: 0, text: 'b'.repeat(600_000) }, 3, 1)] })
}))

test.each(['packet', 'canonical total', 'canonical single'] as const)(
  'native fallback enforces the %s read budget using actual canonical JSON bytes', mode => nativeCase(async (f, n) => {
    const accumulator = new AssistantStreamAccumulator()
    accumulator.push({ time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(400_000) } })
    for (let step = 1; step <= 3; step++) n.native.append('assistant/attempt', { turn: 1, step, stream: [...accumulator.snapshot()] })
    await n.events.append(n.grant.token, n.native.snapshotEvents())
    const reader = new NativeAssistantRead(n.limits, { ...readLimits, maxPacketBytes: n.limits.maxItemBytes + 512,
      maxCanonicalBytes: mode === 'canonical total' ? n.limits.maxEventBytes : readLimits.maxCanonicalBytes })
    if (mode === 'canonical single') await f.pool.query('UPDATE pe_events SET event=$2::json WHERE session_id=$1 AND seq=0',
      [n.created.sessionId, JSON.stringify({ seq: 0, time: 1, type: 'assistant/attempt', data: { stream: ['x'.repeat(n.limits.maxEventBytes)] } })])
    if (mode === 'packet') expect(await locked(f, n, (client, row) => reader.after(client, row, null, -1, 256)))
      .toMatchObject({ kind: 'next', position: null, cursor: 1 })
    else await expect(locked(f, n, (client, row) => reader.after(client, row, null, -1, 256)))
      .rejects.toMatchObject({ status: 503, code: 'native_assistant_read_budget' })
  }))

test('continuation rechecks the PG clock after an actual canonical table lock wait crosses presentation TTL', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, []))
  const opening = await locked(f, n, (client, row) => n.read.open(client, row))
  n.native.append('turn/start', { turn: 1 }); await n.store.apply(n.grant.token, batch(n, events(n)))
  await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()+interval '1 second' WHERE session_id=$1", [n.created.sessionId])
  const lock = await f.pool.connect(); await lock.query('BEGIN')
  try {
    await lock.query('LOCK TABLE pe_events IN ACCESS EXCLUSIVE MODE')
    const pending = locked(f, n, (client, row) => n.read.after(client, row, opening.position, -1, 256))
    await expect.poll(async () => first((await f.pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%octet_length(event::text)%') AS blocked`)).rows).blocked,
    { timeout: 5000, interval: 10 }).toBe(true)
    await expect.poll(async () => first((await lock.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM pe_native_presentations WHERE session_id=$1',
      [n.created.sessionId])).rows).expired, { timeout: 5000, interval: 20 }).toBe(true)
    await lock.query('COMMIT'); expect(await pending).toEqual({ kind: 'reopen' })
  } finally { await lock.query('ROLLBACK'); lock.release() }
}))

test('invalid continuation count/cursor fails before querying and an empty log preserves minus-one cursor', () => nativeCase(async (f, n) => {
  for (const [cursor, count] of [[-0, 1], [-2, 1], [-1, 0], [-1, 1.5]]) {
    await expect(locked(f, n, (client, row) => n.read.after(client, row, null, cursor ?? -1, count ?? 1)))
      .rejects.toMatchObject({ status: 400, code: 'native_assistant_position_invalid' })
  }
  expect(await locked(f, n, (client, row) => n.read.after(client, row, null, -1, 1)))
    .toEqual({ kind: 'next', position: null, cursor: -1, frames: [] })
  await n.store.apply(n.grant.token, batch(n, []))
  const opening = await locked(f, n, (client, row) => n.read.open(client, row))
  await n.store.apply(n.grant.token, batch(n, [start()]))
  expect(await locked(f, n, (client, row) => n.read.after(client, row, opening.position, -1, 1)))
    .toMatchObject({ kind: 'next', frames: [{ type: 'assistant-stream', frame: { type: 'start', startedAfterSeq: -1 } }] })
}))

test('canonical optional metadata stays exact while an abandoned outcome retains its native attempt identity', () => nativeCase(async (f, n) => {
  const firstMessage = n.native.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'source' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
  n.native.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' } }),
    { surfaceOp: { op: 'replace', startSeq: firstMessage.seq, endSeq: firstMessage.seq }, sourceEventSeqs: [firstMessage.seq] })
  const originals = n.native.snapshotEvents().map(event => ({ ...event, ignorable: true }))
  await n.events.append(n.grant.token, originals)
  const fallback = await locked(f, n, (client, row) => n.read.after(client, row, null, -1, 256))
  expect(fallback).toEqual({ kind: 'next', position: null, cursor: 1, frames: originals.map(event => ({ type: 'event', event })) })
  await n.store.apply(n.grant.token, batch(n, []))
  const opening = await locked(f, n, (client, row) => n.read.open(client, row))
  const raw = { type: 'text-delta', index: 0, text: 'unfinished' }
  await n.store.apply(n.grant.token, batch(n, [start(), chunk(raw), end(undefined)]))
  const next = await locked(f, n, (client, row) => n.read.after(client, row, opening.position, 1, 256))
  expect(next).toMatchObject({ kind: 'next', cursor: 1, position: { ordinal: 3 }, frames: [
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'reader:1', revision: 1, startedAfterSeq: 1 } }, chunk(raw), end(undefined),
  ] })
}))

test('an expired same-publisher future ordinal is corruption while a deleted generation simply reopens', () => nativeCase(async (f, n) => {
  await n.store.apply(n.grant.token, batch(n, [start()]))
  const position = { epoch: n.grant.epoch, publisherId: n.publisherId, ordinal: 2 }
  await f.pool.query("UPDATE pe_native_presentations SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [n.created.sessionId])
  await expect(locked(f, n, (client, row) => n.read.after(client, row, position, -1, 1)))
    .rejects.toMatchObject({ status: 503, code: 'native_assistant_future_ordinal' })
  await n.tasks.finish(n.grant.token, 'completed', null)
  expect(await locked(f, n, (client, row) => n.read.after(client, row, position, -1, 1))).toEqual({ kind: 'reopen' })
}))
