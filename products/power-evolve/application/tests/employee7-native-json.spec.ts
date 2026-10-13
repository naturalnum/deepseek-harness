/** Real PG exercises private checkpoint encodings and bounded native history scans without changing Session V4. */
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { requestId } from '../src/contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const encoded = z.object({ version: z.literal(2), asOfSeq: z.number(), stateJson: z.string() }).strict()
const decoded = z.object({ version: z.literal(1), asOfSeq: z.number(),
  modelSelection: z.json(), inbox: z.json(), title: z.json() }).strict()
type CloudCase = Parameters<Parameters<typeof cloudFixture>[0]>[0]

function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('Owned native JSON fixture returned no row')
  return value
}

async function nativeCase(run: (f: CloudCase, fixture: Awaited<ReturnType<typeof admitted>>) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => {
    const fixture = await admitted(f)
    await run(f, fixture)
    await fixture.tasks.finish(fixture.grant.token, 'completed', null)
  })
}

async function admitted(f: CloudCase) {
  const tasks = new TaskStore(f.pool, limits), events = new EventStore(tasks, limits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'owned native JSON review', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned native JSON writer was not claimed')
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  return { tasks, events, created, grant, native: Session.create(header.id, undefined, header), reads: new NativeSessionRead(f.pool),
    namespace: `session-projections:${created.sessionId}` }
}

function title(native: Session, text: string): void {
  native.append('session/title', { title: text, messageSeqs: [], source: { kind: 'user' } })
}

async function checkpoint(f: CloudCase, namespace: string) {
  return encoded.parse(first((await f.pool.query<{ value: unknown }>(
    'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2', [f.alice.user.userId, namespace])).rows).value)
}

async function putCheckpoint(f: CloudCase, namespace: string, value: unknown): Promise<void> {
  await f.pool.query('UPDATE pe_native_preferences SET value=$3 WHERE user_id=$1 AND namespace=$2',
    [f.alice.user.userId, namespace, value])
}

async function history(f: CloudCase, id: string) {
  return (await f.pool.query<{ seq: number; original: string }>(
    'SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [id])).rows
}

test('NUL history spanning two scan chunks classifies a later turn and preserves both bounded suffixes', () => nativeCase(async (f, n) => {
  for (let index = 0; index < 256; index++) title(n.native, `title-${index}\0\uD800 😀`)
  n.native.append('turn/start', { turn: 1 })
  n.native.append('user/message', { id: MessageId(randomUUID()), role: 'user',
    content: [{ type: 'text', text: 'message\0\uD800 \\u0000' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const original = n.native.snapshotEvents()
  await n.events.append(n.grant.token, original)
  const before = await history(f, n.created.sessionId)
  expect((await n.reads.list(f.alice.user)).items.find(item => item.sessionId === n.created.sessionId)?.blank).toBe(false)
  await expect(n.reads.adoptBlank(f.alice.user, n.created.sessionId)).rejects.toMatchObject({ status: 409, code: 'session_not_blank' })
  expect(await n.reads.after(f.alice.user, n.created.sessionId, -1)).toEqual(original.slice(0, 256))
  expect(await n.reads.after(f.alice.user, n.created.sessionId, 255)).toEqual(original.slice(256))
  const snapshot = await n.reads.snapshot(f.alice.user, { address: { kind: 'session', sessionId: n.created.sessionId } })
  expect(snapshot.records).toEqual(original.map(event => ({ type: 'event', event })))
  expect(await history(f, n.created.sessionId)).toEqual(before)
}))

test.each(['missing row', 'embedded sequence drift', 'malformed event'] as const)('second scan chunk rejects %s and original bytes become readable after repair', mode => nativeCase(async (f, n) => {
  for (let index = 0; index < 257; index++) title(n.native, `owned-${index}\0\uD800`)
  const original = n.native.snapshotEvents()
  await n.events.append(n.grant.token, original)
  const saved = await history(f, n.created.sessionId), last = first(original.slice(256))
  const originalText = first(saved.filter(record => record.seq === 256)).original
  if (mode === 'missing row') await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=256', [n.created.sessionId])
  else await f.pool.query('UPDATE pe_events SET event=$2::json WHERE session_id=$1 AND seq=256',
    [n.created.sessionId, mode === 'malformed event' ? {} : { ...last, seq: 255 }])
  const code = mode === 'malformed event' ? 'native_history_invalid' : 'native_history_gap'
  await expect(n.reads.list(f.alice.user)).rejects.toMatchObject({ status: 500, code })
  await expect(n.reads.adoptBlank(f.alice.user, n.created.sessionId)).rejects.toMatchObject({ status: 500, code })
  await expect(n.reads.after(f.bob.user, n.created.sessionId, 255)).rejects.toMatchObject({ code: 'session_not_found' })
  if (mode === 'missing row') await f.pool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,256,$2::json)', [n.created.sessionId, originalText])
  else await f.pool.query('UPDATE pe_events SET event=$2::json WHERE session_id=$1 AND seq=256', [n.created.sessionId, originalText])
  expect((await n.reads.list(f.alice.user)).items.find(item => item.sessionId === n.created.sessionId)?.blank).toBe(true)
  expect(await n.reads.adoptBlank(f.alice.user, n.created.sessionId)).toEqual(n.created)
  expect(await history(f, n.created.sessionId)).toEqual(saved)
}))

test('a lagging version 1 checkpoint catches up NUL inbox history into encoding 2 without rewriting event text', () => nativeCase(async (f, n) => {
  title(n.native, 'ASCII predecessor')
  await n.events.append(n.grant.token, n.native.snapshotEvents())
  const old = decoded.parse(JSON.parse((await checkpoint(f, n.namespace)).stateJson))
  const text = 'owned\0\uD800 😀 \\u0000'
  title(n.native, text)
  const message = { id: MessageId(randomUUID()), role: 'user' as const, content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const } }
  n.native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  await n.events.append(n.grant.token, n.native.snapshotEvents().slice(1))
  const before = await history(f, n.created.sessionId)
  await putCheckpoint(f, n.namespace, old)
  await expect(n.reads.list(f.alice.user)).rejects.toMatchObject({ status: 503, code: 'native_projection_gap' })
  const nextText = `next ${text}`
  title(n.native, nextText)
  await n.events.append(n.grant.token, n.native.snapshotEvents().slice(3))
  const saved = await checkpoint(f, n.namespace)
  expect(saved.asOfSeq).toBe(3)
  expect(saved.stateJson).not.toContain('\0')
  expect(saved.stateJson).toContain('\\u0000')
  expect(saved.stateJson).toContain('\\ud800')
  expect(decoded.parse(JSON.parse(saved.stateJson)).title).toBe(nextText)
  const listed = (await n.reads.list(f.alice.user)).items.find(item => item.sessionId === n.created.sessionId)
  expect(listed?.projections?.values.title).toBe(nextText)
  expect(listed?.projections?.values.inbox).toEqual({ 'next-turn': [message], 'next-step': [] })
  expect((await history(f, n.created.sessionId)).slice(0, 3)).toEqual(before)
}))

test('strict encoding envelopes and decoded states reject corruption and roll back append before a valid retry', () => nativeCase(async (f, n) => {
  title(n.native, 'state\0\uD800')
  await n.events.append(n.grant.token, n.native.snapshotEvents())
  const saved = await checkpoint(f, n.namespace), state = decoded.parse(JSON.parse(saved.stateJson))
  const before = await history(f, n.created.sessionId)
  title(n.native, 'retry\0\uD800')
  const suffix = n.native.snapshotEvents().slice(1)
  const corrupt: unknown[] = [
    { ...saved, unexpected: true },
    { ...saved, stateJson: JSON.stringify({ ...state, version: 2 }) },
    { ...saved, stateJson: JSON.stringify({ ...state, unexpected: true }) },
    { ...saved, stateJson: 'null' },
    { ...saved, asOfSeq: 1 },
  ]
  for (const bad of corrupt) {
    await putCheckpoint(f, n.namespace, bad)
    await expect(n.reads.list(f.alice.user)).rejects.toThrow()
    await expect(n.events.append(n.grant.token, suffix)).rejects.toThrow()
    expect(await history(f, n.created.sessionId)).toEqual(before)
    expect(first((await f.pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1',
      [n.created.sessionId])).rows).event_count).toBe(1)
  }
  await putCheckpoint(f, n.namespace, saved)
  expect(await n.events.append(n.grant.token, suffix)).toEqual({ eventCount: 2 })
  expect((await n.reads.list(f.alice.user)).items.find(item => item.sessionId === n.created.sessionId)?.projections?.values.title)
    .toBe('retry\0\uD800')
}))

test('a missing catch-up event refuses checkpoint advancement and leaves the writer transaction unchanged until repair', () => nativeCase(async (f, n) => {
  title(n.native, 'ASCII checkpoint')
  await n.events.append(n.grant.token, n.native.snapshotEvents())
  const old = decoded.parse(JSON.parse((await checkpoint(f, n.namespace)).stateJson))
  title(n.native, 'one\0\uD800'); title(n.native, 'two\0\uD800')
  await n.events.append(n.grant.token, n.native.snapshotEvents().slice(1))
  await putCheckpoint(f, n.namespace, old)
  const missing = first((await history(f, n.created.sessionId)).filter(record => record.seq === 1)).original
  await f.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=1', [n.created.sessionId])
  const damaged = await history(f, n.created.sessionId)
  title(n.native, 'three\0\uD800')
  const suffix = n.native.snapshotEvents().slice(3)
  await expect(n.events.append(n.grant.token, suffix)).rejects.toMatchObject({ status: 503, code: 'native_projection_gap' })
  expect(await history(f, n.created.sessionId)).toEqual(damaged)
  expect(first((await f.pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1',
    [n.created.sessionId])).rows).event_count).toBe(3)
  expect(first((await f.pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
    [f.alice.user.userId, n.namespace])).rows).value).toEqual(old)
  await f.pool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,1,$2::json)', [n.created.sessionId, missing])
  expect(await n.events.append(n.grant.token, suffix)).toEqual({ eventCount: 4 })
  expect((await n.reads.list(f.alice.user)).items.find(item => item.sessionId === n.created.sessionId)?.projections?.values.title)
    .toBe('three\0\uD800')
}))
