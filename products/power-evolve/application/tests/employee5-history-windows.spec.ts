/** Real event budgets, committed native history windows and damaged-storage refusals. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { sendFailure } from '../src/http.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { checkpointNativeProjections } from '../src/platform/native-projections.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]

async function admitted(f: Fixture, config = limits) {
  const tasks = new TaskStore(f.pool, config), events = new EventStore(tasks, config)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'employee5 history windows', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Expected an admitted history operation')
  const header = headerSchema.parse((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
  return { tasks, events, grant, native: Session.create(header.id, undefined, header), header }
}

function appendTurn(native: Session, turn: number, text: string) {
  const start = native.append('turn/start', { turn })
  const message = native.append('user/message', { id: MessageId(randomUUID()), role: 'user',
    content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  native.append('step/start', { turn, step: 1 })
  native.append('step/end', { turn, step: 1 })
  native.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { start, message }
}

async function persist(events: EventStore, token: string, input: readonly SessionEvent[]): Promise<void> {
  // The shipped append route accepts at most 256 events per request.
  for (let offset = 0; offset < input.length; offset += 256) await events.append(token, input.slice(offset, offset + 256))
}

async function watermark(pool: Pool, id: string) {
  const result = await pool.query<{ event_count: number; event_bytes: string; checkpoint: unknown }>(`SELECT s.event_count,s.event_bytes,
    p.value AS checkpoint FROM pe_sessions s LEFT JOIN pe_native_preferences p
      ON p.user_id=s.user_id AND p.namespace='session-projections:'||s.id::text WHERE s.id=$1`, [id])
  return result.rows
}

for (const budget of ['event bytes', 'history bytes', 'history count'] as const) {
  test(`${budget} exhaustion rolls back the entire native append and leaves its projection at the prior committed cut`, () =>
    cloudFixture(async (f) => {
      const config = { ...limits,
        maxEventBytes: budget === 'event bytes' ? 1024 : limits.maxEventBytes,
        maxHistoryBytes: budget === 'history bytes' ? 1024 : limits.maxHistoryBytes,
        maxHistoryEvents: budget === 'history count' ? 1 : limits.maxHistoryEvents }
      const { tasks, events, grant, native } = await admitted(f, config)
      const prefix = native.snapshotEvents()
      await events.append(grant.token, prefix)
      const before = await watermark(f.pool, grant.sessionId)
      native.append('session/title', { title: 'L'.repeat(700), messageSeqs: [], source: { kind: 'user' } })
      if (budget === 'event bytes') {
        native.append('user/message', { id: MessageId(randomUUID()), role: 'user', content: [{ type: 'text', text: '表😀'.repeat(300) }],
          source: { kind: 'user' } }, { surfaceOp: 'append' })
      } else {
        native.append('session/title', { title: 'R'.repeat(700), messageSeqs: [], source: { kind: 'user' } })
      }
      const suffix = native.snapshotEvents().slice(prefix.length)
      await expect(events.append(grant.token, suffix)).rejects.toMatchObject({ status: 413, code: 'history_limit' })
      expect(await watermark(f.pool, grant.sessionId)).toEqual(before)
      expect((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [grant.sessionId])).rows)
        .toEqual(prefix.map(event => ({ event })))
      expect(await new EventStore(tasks, limits).runtimeSnapshot(grant.token)).toMatchObject({ events: prefix, eventCount: prefix.length })
      // An admitted larger deployment budget can commit the original rejected batch without repair or new identities.
      await new EventStore(tasks, limits).append(grant.token, suffix)
      expect(await new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, prefix.length - 1)).toEqual(suffix)
    }))
}

test('EventStore pages cold committed logs and operation failures without exposing another owner', () =>
  cloudFixture(async (f) => {
    const { tasks, events, grant, native, header } = await admitted(f)
    appendTurn(native, 1, 'cold page one')
    await events.append(grant.token, native.snapshotEvents())
    const prefix = native.snapshotEvents()
    const reader = new EventStore(new TaskStore(f.pool, limits), limits)
    expect(await reader.page(f.alice.user, grant.sessionId, -1, 2)).toEqual({ header, events: prefix.slice(0, 2),
      watermark: prefix.length - 1, operations: [{ operationId: grant.operationId, state: 'running', errorCode: null }] })
    await tasks.finish(grant.token, 'failed', 'employee5_terminal')
    expect(await new EventStore(new TaskStore(f.pool, limits), limits).page(f.alice.user, grant.sessionId, 1, 100))
      .toMatchObject({ events: prefix.slice(2), watermark: prefix.length - 1,
        operations: [{ operationId: grant.operationId, state: 'failed', errorCode: 'employee5_terminal' }] })
    await expect(reader.page(f.bob.user, grant.sessionId, -1, 100)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
  }))

test('an empty owned native Session can be reselected and streamed until its first durable turn', () =>
  cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits), reader = new NativeSessionRead(f.pool)
    const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    expect(await reader.adoptBlank(f.alice.user, created.sessionId)).toEqual(created)
    await expect(reader.adoptBlank(f.bob.user, created.sessionId)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    const blank = await reader.snapshot(f.alice.user, { address: { kind: 'session', sessionId: created.sessionId }, assistantStream: true })
    expect(blank).toMatchObject({ cursor: -1, records: [], hasMore: false, assistantStream: { revision: 0 }, projections: { asOfSeq: -1 } })
    expect(await reader.page(f.alice.user, { address: { kind: 'session', sessionId: created.sessionId }, throughSeq: -1 }))
      .toEqual({ records: [], hasMore: false })
    expect((await reader.list(f.alice.user)).items).toMatchObject([
      { sessionId: created.sessionId, blank: true, running: false, agentAvailable: false }])
    await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'first durable turn', f.alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected an operation for the empty Session')
    const header = headerSchema.parse((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
    const native = Session.create(header.id, undefined, header)
    appendTurn(native, 1, 'first durable turn')
    await new EventStore(tasks, limits).append(grant.token, native.snapshotEvents())
    await expect(reader.adoptBlank(f.alice.user, created.sessionId)).rejects.toMatchObject({ status: 409, code: 'session_not_blank' })
    expect((await new NativeSessionRead(f.pool).list(f.alice.user)).items).toMatchObject([
      { sessionId: created.sessionId, blank: false, running: true, agentAvailable: true }])
    expect((await reader.list(f.bob.user)).items).toEqual([])
    await tasks.finish(grant.token, 'completed', null)
    expect((await reader.list(f.alice.user)).items).toMatchObject([{ sessionId: created.sessionId, running: false, agentAvailable: false }])
  }))

test('native turn windows include complete requested turns and retain the committed beforeSeq cut on cold read', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const first = appendTurn(native, 1, 'turn one')
    const second = appendTurn(native, 2, 'turn two'), third = appendTurn(native, 3, 'turn three')
    await events.append(grant.token, native.snapshotEvents())
    const history = native.snapshotEvents(), address = { kind: 'session' as const, sessionId: grant.sessionId }
    const opening = await new NativeSessionRead(f.pool).snapshot(f.alice.user,
      { address, maxMessages: 10, turnWindow: { minMessages: 1, minTurns: 2 } })
    expect(opening.records).toEqual(history.slice(second.start.seq).map(event => ({ type: 'event', event })))
    expect(opening.hasMore).toBe(true)
    const earlier = await new NativeSessionRead(f.pool).page(f.alice.user, { address, throughSeq: history.length - 1,
      beforeSeq: second.start.seq, maxMessages: 10, turnWindow: { minMessages: 1, minTurns: 1 } })
    expect(earlier.records.at(-1)?.event.type).toBe('turn/end')
    expect(earlier.records).toEqual(history.slice(first.start.seq, second.start.seq).map(event => ({ type: 'event', event })))
    const capped = await new NativeSessionRead(f.pool).page(f.alice.user, { address, throughSeq: history.length - 1,
      maxMessages: 1, turnWindow: { minMessages: 1, minTurns: 2 } })
    expect(capped.records[0]?.event.seq).toBe(third.message.seq)
    await expect(new NativeSessionRead(f.pool).page(f.alice.user, { address, throughSeq: history.length }))
      .rejects.toMatchObject({ status: 400, code: 'native_page_future_cursor' })
  }))

test('sourceEventSeqs groups and polling suffixes remain complete across multiple PostgreSQL read chunks', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const first = appendTurn(native, 1, 'first cited source'), second = appendTurn(native, 2, 'second cited source')
    for (let index = 0; index < 300; index++) native.append('session/title', {
      title: `durable filler ${index}`, messageSeqs: [], source: { kind: 'user' } })
    native.append('turn/start', { turn: 3 })
    native.append('user/message', { id: MessageId(randomUUID()), role: 'user', content: [{ type: 'text', text: 'combined cited sources' }],
      source: { kind: 'user' } }, { surfaceOp: 'append', sourceEventSeqs: [first.message.seq, second.message.seq] })
    native.append('step/start', { turn: 3, step: 1 }); native.append('step/end', { turn: 3, step: 1 })
    native.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const history = native.snapshotEvents()
    await persist(events, grant.token, history)
    const cold = new NativeSessionRead(f.pool)
    const opening = await cold.snapshot(f.alice.user, { address: { kind: 'session', sessionId: grant.sessionId }, maxMessages: 1 })
    expect(opening.records).toEqual(history.slice(first.message.seq).map(event => ({ type: 'event', event })))
    expect(opening.hasMore).toBe(true)
    const prefix = await cold.after(f.alice.user, grant.sessionId, -1, 500)
    expect(prefix).toEqual(history.slice(0, 256))
    expect(await new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, 255, 500)).toEqual(history.slice(256))
    expect(await cold.after(f.alice.user, grant.sessionId, history.length - 1)).toEqual([])
  }))

test('surface replacements stay with their original source without counting as another appended message', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const original = appendTurn(native, 1, 'original surface message')
    native.append('user/message', { id: MessageId(randomUUID()), role: 'user', content: [{ type: 'text', text: 'replacement surface message' }],
      source: { kind: 'user' } }, { surfaceOp: { op: 'replace', startSeq: original.message.seq, endSeq: original.message.seq },
      sourceEventSeqs: [original.message.seq] })
    const history = native.snapshotEvents()
    await events.append(grant.token, history)
    expect((await new NativeSessionRead(f.pool).snapshot(f.alice.user,
      { address: { kind: 'session', sessionId: grant.sessionId }, maxMessages: 1 })).records)
      .toEqual(history.slice(original.message.seq).map(event => ({ type: 'event', event })))
  }))

test('native snapshot waits for the real Session writer and returns the new events and projection at one cut', () =>
  cloudFixture(async (f) => {
    const { events, grant, native, header } = await admitted(f)
    appendTurn(native, 1, 'prior committed turn')
    await events.append(grant.token, native.snapshotEvents())
    const oldCount = native.snapshotEvents().length
    const title = native.append('session/title', { title: 'writer commit cut', messageSeqs: [], source: { kind: 'user' } })
    const blocker = await f.pool.connect()
    const readerPool = new Pool({ connectionString: f.pool.options.connectionString, max: 1, idleTimeoutMillis: 0 })
    let reading: Promise<{ ok: boolean; value?: unknown; error?: unknown }> | undefined
    let settled = false
    try {
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
      const readerPid = (await readerPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
      if (blockerPid === undefined || readerPid === undefined) throw new Error('Expected two real PostgreSQL backend identities')
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE', [grant.sessionId])
      await blocker.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,$2,$3)', [grant.sessionId, title.seq, title])
      // This transaction is a persisted writer fixture; the reader and its locking are unmodified production code.
      await checkpointNativeProjections(blocker, f.alice.user.userId, header, oldCount, [title])
      await blocker.query('UPDATE pe_sessions SET event_count=$2,event_bytes=event_bytes+$3 WHERE id=$1',
        [grant.sessionId, oldCount + 1, Buffer.byteLength(JSON.stringify(title))])
      reading = new NativeSessionRead(readerPool).snapshot(f.alice.user, { address: { kind: 'session', sessionId: grant.sessionId } })
        .then((value) => { settled = true; return { ok: true, value } },
          (error: unknown) => { settled = true; return { ok: false, error } })
      await expect.poll(async () => (await f.pool.query<{ waiting: boolean }>(`SELECT wait_event_type='Lock'
        AND $2=ANY(pg_blocking_pids(pid)) AND strpos(query,'FOR SHARE')>0 AS waiting FROM pg_stat_activity WHERE pid=$1`,
      [readerPid, blockerPid])).rows[0]?.waiting, { timeout: 10_000, interval: 10 }).toBe(true)
      expect(settled).toBe(false)
      await blocker.query('COMMIT')
      expect(await reading).toMatchObject({ ok: true, value: { cursor: title.seq,
        projections: { asOfSeq: title.seq, values: { title: 'writer commit cut' } } } })
      expect(await new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, oldCount - 1)).toEqual([title])
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      if (reading) await reading
      await readerPool.end()
    }
  }))

for (const mode of ['page', 'snapshot', 'after'] as const) {
  test(`native ${mode} refuses a missing middle event instead of returning a partial committed history`, () =>
    cloudFixture(async (f) => {
      const { events, grant, native } = await admitted(f)
      const turn = appendTurn(native, 1, 'employee5 damaged middle history')
      await events.append(grant.token, native.snapshotEvents())
      await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=$2', [grant.sessionId, turn.message.seq])
      const reader = new NativeSessionRead(f.pool), address = { kind: 'session' as const, sessionId: grant.sessionId }
      const reading = mode === 'page' ? reader.page(f.alice.user, { address, throughSeq: native.snapshotEvents().length - 1 })
        : mode === 'snapshot' ? reader.snapshot(f.alice.user, { address }) : reader.after(f.alice.user, grant.sessionId, -1)
      await expect(reading).rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
    }))
}

test('native polling refuses event JSON whose sequence disagrees with its persisted PostgreSQL key', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const original = appendTurn(native, 1, 'employee5 damaged JSON sequence')
    await events.append(grant.token, native.snapshotEvents())
    const wrongSeq = native.snapshotEvents().length + 100
    await f.pool.query(`UPDATE pe_events SET event=jsonb_set(event::jsonb,'{seq}',to_jsonb($3::integer))::json
      WHERE session_id=$1 AND seq=$2`, [grant.sessionId, original.message.seq, wrongSeq])
    expect((await f.pool.query<{ seq: number; jsonSeq: number }>(
      'SELECT seq,(event->>\'seq\')::integer AS "jsonSeq" FROM pe_events WHERE session_id=$1 AND seq=$2',
      [grant.sessionId, original.message.seq])).rows).toEqual([{ seq: original.message.seq, jsonSeq: wrongSeq }])
    await expect(new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, -1))
      .rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
  }))

test('a native source group refuses a lost cited prefix even when its newest message remains committed', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const original = appendTurn(native, 1, 'source prefix before storage damage')
    native.append('turn/start', { turn: 2 })
    const derived = native.append('user/message', { id: MessageId(randomUUID()), role: 'user',
      content: [{ type: 'text', text: 'derived message still stored' }], source: { kind: 'user' } },
    { surfaceOp: 'append', sourceEventSeqs: [original.message.seq] })
    native.append('step/start', { turn: 2, step: 1 }); native.append('step/end', { turn: 2, step: 1 })
    native.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await events.append(grant.token, native.snapshotEvents())
    await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq>=$2 AND seq<$3',
      [grant.sessionId, original.message.seq, derived.seq])
    await expect(new NativeSessionRead(f.pool).page(f.alice.user, { address: { kind: 'session', sessionId: grant.sessionId },
      throughSeq: native.snapshotEvents().length - 1, maxMessages: 1 })).rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
  }))

test('native page refuses a persisted watermark whose entire event history is missing', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    appendTurn(native, 1, 'employee5 missing entire history')
    await events.append(grant.token, native.snapshotEvents())
    await f.pool.query('DELETE FROM pe_events WHERE session_id=$1', [grant.sessionId])
    await expect(new NativeSessionRead(f.pool).page(f.alice.user,
      { address: { kind: 'session', sessionId: grant.sessionId }, throughSeq: native.snapshotEvents().length - 1 }))
      .rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
  }))

for (const mode of ['page', 'snapshot', 'after'] as const) {
  test(`native ${mode} refuses a lost committed tail without extending an earlier page beyond its requested cut`, () =>
    cloudFixture(async (f) => {
      const { events, grant, native } = await admitted(f)
      appendTurn(native, 1, 'employee5 lost committed tail')
      const history = native.snapshotEvents(), tail = history.length - 1
      await events.append(grant.token, history)
      const before = await watermark(f.pool, grant.sessionId)
      await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=$2', [grant.sessionId, tail])
      expect(await watermark(f.pool, grant.sessionId)).toEqual(before)
      const reader = new NativeSessionRead(f.pool), address = { kind: 'session' as const, sessionId: grant.sessionId }
      expect(await reader.page(f.alice.user, { address, throughSeq: tail - 1 }))
        .toEqual({ records: history.slice(0, tail).map(event => ({ type: 'event', event })), hasMore: false })
      const read = (user: typeof f.alice.user) => mode === 'page' ? reader.page(user, { address, throughSeq: tail })
        : mode === 'snapshot' ? reader.snapshot(user, { address }) : reader.after(user, grant.sessionId, tail - 1)
      await expect(read(f.bob.user)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
      await expect(read(f.alice.user)).rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
    }))
}

test('native polling returns an intact 256-event prefix and refuses a missing next event at the chunk boundary', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    appendTurn(native, 1, 'employee5 intact first read chunk')
    for (let index = 0; index < 252; index++) native.append('session/title', {
      title: `chunk boundary title ${index}`, messageSeqs: [], source: { kind: 'user' } })
    const history = native.snapshotEvents()
    expect(history).toHaveLength(257)
    await persist(events, grant.token, history)
    expect(await new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, 255)).toEqual(history.slice(256))
    await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=256', [grant.sessionId])
    const reader = new NativeSessionRead(f.pool)
    expect(await reader.after(f.alice.user, grant.sessionId, -1, 500)).toEqual(history.slice(0, 256))
    expect(await reader.page(f.alice.user, { address: { kind: 'session', sessionId: grant.sessionId }, throughSeq: 255 }))
      .toEqual({ records: history.slice(0, 256).map(event => ({ type: 'event', event })), hasMore: false })
    await expect(new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, 255))
      .rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
  }))

test('native page refuses an interior source-group gap outside the newest reverse read chunk', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const original = appendTurn(native, 1, 'employee5 intact cited source')
    for (let index = 0; index < 300; index++) native.append('session/title', {
      title: `source group title ${index}`, messageSeqs: [], source: { kind: 'user' } })
    native.append('turn/start', { turn: 2 })
    native.append('user/message', { id: MessageId(randomUUID()), role: 'user',
      content: [{ type: 'text', text: 'newest message with an earlier intact source' }], source: { kind: 'user' } },
    { surfaceOp: 'append', sourceEventSeqs: [original.message.seq] })
    native.append('step/start', { turn: 2, step: 1 }); native.append('step/end', { turn: 2, step: 1 })
    native.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const history = native.snapshotEvents(), address = { kind: 'session' as const, sessionId: grant.sessionId }
    await persist(events, grant.token, history)
    expect((await new NativeSessionRead(f.pool).page(f.alice.user, { address, throughSeq: history.length - 1, maxMessages: 1 })).records)
      .toEqual(history.slice(original.message.seq).map(event => ({ type: 'event', event })))
    await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=$2', [grant.sessionId, original.message.seq + 1])
    await expect(new NativeSessionRead(f.pool).page(f.alice.user, { address, throughSeq: history.length - 1, maxMessages: 1 }))
      .rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
  }))

for (const mode of ['page', 'snapshot'] as const) {
  test(`native ${mode} refuses a JSON sequence mismatch in a bounded reverse read`, () =>
    cloudFixture(async (f) => {
      const { events, grant, native } = await admitted(f)
      const original = appendTurn(native, 1, 'employee5 reverse sequence mismatch')
      const history = native.snapshotEvents()
      await events.append(grant.token, history)
      await f.pool.query(`UPDATE pe_events SET event=jsonb_set(event::jsonb,'{seq}',to_jsonb($3::integer))::json
        WHERE session_id=$1 AND seq=$2`, [grant.sessionId, original.message.seq, history.length + 100])
      const reader = new NativeSessionRead(f.pool), address = { kind: 'session' as const, sessionId: grant.sessionId }
      const reading = mode === 'page' ? reader.page(f.alice.user, { address, throughSeq: history.length - 1 })
        : reader.snapshot(f.alice.user, { address })
      await expect(reading).rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
    }))
}

test('a malformed persisted native sequence is reported as a service failure rather than a bad client request', () =>
  cloudFixture(async (f) => {
    const { events, grant, native } = await admitted(f)
    const original = appendTurn(native, 1, 'employee5 malformed persisted sequence')
    await events.append(grant.token, native.snapshotEvents())
    await f.pool.query(`UPDATE pe_events SET event=jsonb_set(event::jsonb,'{seq}',to_jsonb(-1::integer))::json
      WHERE session_id=$1 AND seq=$2`, [grant.sessionId, original.message.seq])
    expect((await f.pool.query<{ seq: number; jsonSeq: number }>(
      'SELECT seq,(event->>\'seq\')::integer AS "jsonSeq" FROM pe_events WHERE session_id=$1 AND seq=$2',
      [grant.sessionId, original.message.seq])).rows).toEqual([{ seq: original.message.seq, jsonSeq: -1 }])
    const outcome = await new NativeSessionRead(f.pool).after(f.alice.user, grant.sessionId, -1)
      .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    if (outcome.ok) throw new Error('Expected refusal of the malformed persisted sequence')
    expect(outcome.error).toMatchObject({ status: 500, code: 'native_history_invalid' })
    // The same public converter is called by the Platform route's error handler.
    const server = createServer((_request, response) => { sendFailure(response, outcome.error) })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected an owned loopback HTTP address')
      const response = await fetch(`http://127.0.0.1:${address.port}/`)
      const body: unknown = await response.json()
      expect({ status: response.status, body }).toEqual({ status: 500, body: { error: 'native_history_invalid' } })
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  }))
