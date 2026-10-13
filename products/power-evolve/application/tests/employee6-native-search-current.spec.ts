/** Independent real PostgreSQL acceptance of official native current-message search. */
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToCarrier } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { buildSessionEventSearchDocuments } from '@deepseek-ai/dsh-session-query'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { expect, test, vi } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { EventStore } from '../src/platform/events.ts'
import { searchNativeSessions, type NativeSessionSearchLimits } from '../src/platform/native-session-search.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits: NativeSessionSearchLimits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
  searchResultLimit: 2, searchSnippetChars: 100, searchDeadlineMs: 5000,
  searchMaxSessions: 256, searchMaxEvents: 100_000, searchMaxBytes: 67_108_864 }
const taskLimits = { ...limits, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
interface Stored { header: SessionHeader; events: SessionEvent[] }

function user(native: Session, text: string, time = 1): SessionEvent<'user/message'> {
  return { ...native.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' }), time }
}
function assistant(native: Session, content: Parameters<typeof createAssistantMessage>[0]['content'], time = 1) {
  return { ...native.append('assistant/message', { turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content, source: { provider: 'fixture', model: 'fixture' } }) },
  { surfaceOp: 'append' }), time }
}
async function stored(fixture: Fixture, build: (native: Session) => SessionEvent[]): Promise<Stored> {
  const { pool, alice } = fixture, tasks = new TaskStore(pool, taskLimits)
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'owned current-search case', alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned case was not admitted')
  const header = headerSchema.parse((await pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1',
    [created.sessionId])).rows[0]?.header)
  const events = build(Session.create(header.id, undefined, header))
  await new EventStore(tasks, taskLimits).append(grant.token, events)
  await tasks.finish(grant.token, 'completed', null)
  return { header, events }
}
async function original(fixture: Fixture) {
  return (await fixture.pool.query<{ session_id: string; seq: number; original: string }>(
    'SELECT session_id,seq,event::text AS original FROM pe_events ORDER BY session_id,seq')).rows
}
async function official(rows: readonly Stored[], query: string, pageLimit = limits.searchResultLimit,
  snippetChars = limits.searchSnippetChars) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    for (const projection of currentSessionMessageProjections) ctx.sessions.registerMessageProjection(projection)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search', defaultLimit: pageLimit,
      maxLimit: pageLimit, snippetChars })
    for (const row of rows) {
      const events = structuredClone(row.events), before = buildSessionEventSearchDocuments(row.header.id, events)
      const inherited = events.findLastIndex(event => event.type === 'session/end-seed' && event.data.inherited === true)
      const session = ctx.sessions.prepare(row.header.id, { eventState: 'detached', seed: events,
        meta: structuredClone(row.header), inheritedEventCount: SessionLogOffset(row.header.isSeeded ? inherited : 0) })
      ctx.effect(() => ctx.sessions.enter(session))
      const observed = await ctx.sessionQuery.readSession(row.header.id)
      // A restore may add a structural resume marker; it cannot change canonical searchable documents.
      expect(buildSessionEventSearchDocuments(row.header.id, observed.events)).toEqual(before)
    }
    const page = await ctx.sessionQuery.searchSessions({ query, limit: pageLimit, eventFilters: [
      { kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] },
    ] })
    return { items: page.items.map(hit => ({ sessionId: hit.header.id, snippet: hit.bestMatch.snippet })),
      hasMore: page.nextCursor !== undefined }
  } finally { await ctx.fiber.dispose() }
}

test('PG search excludes replaced messages and preserves canonical surface order and original JSON', () => cloudFixture(async (fixture) => {
  const row = await stored(fixture, (native) => {
    const first = user(native, 'retired needle'), second = user(native, 'second'), third = user(native, 'third')
    const replace = native.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
      sourceEventSeqs: [SessionSeq(0), SessionSeq(1)] })
    const final = native.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'current answer' }],
      source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: SessionSeq(3), endSeq: SessionSeq(2) },
      sourceEventSeqs: [SessionSeq(3), SessionSeq(2)] })
    return [first, second, third, replace, final]
  })
  const before = await original(fixture)
  for (const query of ['needle', 'replacement', 'answer']) {
    const result = await searchNativeSessions(fixture.pool, fixture.alice.user, query, limits)
    expect(result).toEqual(await official([row], query))
    if (query !== 'answer') expect(result).toEqual({ items: [], hasMore: false })
  }
  expect(await original(fixture)).toEqual(before)
}))

test('PG search uses official block joining and embedded tool calls while excluding reasoning and raw streams', () => cloudFixture(async (fixture) => {
  const row = await stored(fixture, native => [assistant(native, [
    { type: 'text', text: '  alpha  ' }, { type: 'text', text: ' beta ' },
    { type: 'reasoning', text: 'private reasoning-only-token' },
    { type: 'tool-call', id: ToolCallId('owned-query-call'), name: 'catalog_lookup', arguments: '{"q":"needle"}' },
  ])])
  for (const query of ['alpha beta', 'catalog_lookup', 'needle', 'reasoning-only-token']) {
    const result = await searchNativeSessions(fixture.pool, fixture.alice.user, query, limits)
    expect(result).toEqual(await official([row], query))
    expect(result.items).toHaveLength(query === 'reasoning-only-token' ? 0 : 1)
  }
}))

test('PG search ranks each Session by its strongest current event with exact global result lookahead', () => cloudFixture(async (fixture) => {
  const strongest = await stored(fixture, native => [user(native, 'needle needle', 1), user(native, 'later needle', 1000)])
  const shortest = await stored(fixture, native => [user(native, 'needle', 100)])
  const longer = await stored(fixture, native => [user(native, 'needle longer', 200)])
  const none = await stored(fixture, native => [user(native, 'no match', 1000)])
  const result = await searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', limits)
  expect(result).toEqual(await official([strongest, shortest, longer, none], 'needle'))
  expect(result.items).toEqual([{ sessionId: strongest.header.id, snippet: 'needle needle' },
    { sessionId: shortest.header.id, snippet: 'needle' }])
  expect(result.hasMore).toBe(true)
  const complete = await searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchResultLimit: 3 })
  expect(complete.hasMore).toBe(false)
  expect(complete.items.map(hit => hit.sessionId)).toEqual([strongest.header.id, shortest.header.id, longer.header.id])
  expect(await searchNativeSessions(fixture.pool, fixture.bob.user, 'needle', { ...limits, searchMaxEvents: 1 }))
    .toEqual({ items: [], hasMore: false })
}))

test('PG search follows native Unicode61 semantics without rewriting NUL, astral or lone-surrogate JSON', () => cloudFixture(async (fixture) => {
  const row = await stored(fixture, native => [user(native, 'before\0after \\u0000 😀 \uD800 café 中文')])
  const before = await original(fixture)
  for (const query of ['AFTER', '\\u0000', 'cafe', '中文', '😀', '\uD800', '" OR *']) {
    expect(await searchNativeSessions(fixture.pool, fixture.alice.user, query, limits)).toEqual(await official([row], query))
  }
  expect(await original(fixture)).toEqual(before)
}))

test('PG search restores the actual fork inherited cut and keeps inherited/current matching stable', () => cloudFixture(async (fixture) => {
  const row = await stored(fixture, native => [user(native, 'inherited needle'),
    native.append('session/end-seed', { inherited: true }), user(native, 'owned child answer')])
  row.header = { ...row.header, isSeeded: true, parentSession: SessionId(randomUUID()) }
  await fixture.pool.query('UPDATE pe_sessions SET header=$2 WHERE id=$1', [row.header.id, row.header])
  const before = await original(fixture)
  for (const query of ['needle', 'answer']) {
    expect(await searchNativeSessions(fixture.pool, fixture.alice.user, query, limits)).toEqual(await official([row], query))
  }
  expect(await original(fixture)).toEqual(before)
}))

test('PG native ranking uses time, Session UUID and event sequence to resolve otherwise equal hits', () => cloudFixture(async (fixture) => {
  const rows = [await stored(fixture, native => [user(native, 'A needle', 7), user(native, 'B needle', 7)]),
    await stored(fixture, native => [user(native, 'C needle', 7)]),
    await stored(fixture, native => [user(native, 'D needle', 8)])]
  const result = await searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchResultLimit: 3 })
  expect(result).toEqual(await official(rows, 'needle', 3))
  expect(result.items[0]).toEqual({ sessionId: rows[2]!.header.id, snippet: 'D needle' })
  expect(result.items.slice(1).map(hit => hit.sessionId)).toEqual(rows.slice(0, 2).map(row => row.header.id).sort())
  expect(result.items.find(hit => hit.sessionId === rows[0]!.header.id)?.snippet).toBe('B needle')
  expect(result.hasMore).toBe(false)
}))

test('PG nested fork markers select the final inherited cut and reject the same log under an unseeded header', () => cloudFixture(async (fixture) => {
  const row = await stored(fixture, native => [user(native, 'ancestor needle'),
    native.append('session/end-seed', { inherited: true }), user(native, 'parent needle'),
    native.append('session/end-seed', { inherited: true }), user(native, 'child answer')])
  row.header = { ...row.header, isSeeded: true, parentSession: SessionId(randomUUID()) }
  await fixture.pool.query('UPDATE pe_sessions SET header=$2 WHERE id=$1', [row.header.id, row.header])
  const before = await original(fixture)
  for (const query of ['ancestor', 'parent', 'answer']) {
    expect(await searchNativeSessions(fixture.pool, fixture.alice.user, query, limits)).toEqual(await official([row], query))
  }
  const current = await official([row], 'answer')
  expect(current.items).toHaveLength(1)
  await fixture.pool.query('UPDATE pe_sessions SET header=jsonb_set(header,\'{isSeeded}\',\'false\') WHERE id=$1', [row.header.id])
  await expect(searchNativeSessions(fixture.pool, fixture.alice.user, 'answer', limits))
    .rejects.toMatchObject({ status: 500, code: 'native_history_invalid' })
  expect(await original(fixture)).toEqual(before)
}))

test('PG native snippets respect Unicode code-point limits and official ellipses', () => cloudFixture(async (fixture) => {
  const row = await stored(fixture, native => [user(native, '😀'.repeat(80) + 'needle ' + '🌲'.repeat(80))])
  const result = await searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchSnippetChars: 24 })
  expect(result).toEqual(await official([row], 'needle', 2, 24))
  expect(Array.from(result.items[0]!.snippet)).toHaveLength(24)
  expect(result.items[0]!.snippet).toContain('needle')
  expect(result.items[0]!.snippet.startsWith('…')).toBe(true)
  expect(result.items[0]!.snippet.endsWith('…')).toBe(true)
}))

for (const setting of ['searchMaxSessions', 'searchMaxEvents', 'searchMaxBytes', 'maxHistoryEvents', 'maxHistoryBytes', 'maxEventBytes'] as const) {
  test(`PG ${setting} exhaustion fails the whole search without a partial page`, () => cloudFixture(async (fixture) => {
    await stored(fixture, native => [user(native, 'needle'), user(native, 'second needle')])
    if (setting === 'searchMaxSessions') await stored(fixture, native => [user(native, 'needle')])
    const before = await original(fixture)
    await expect(searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, [setting]: 1 }))
      .rejects.toMatchObject({ status: 503, code: 'native_search_budget_exceeded' })
    expect(await original(fixture)).toEqual(before)
    expect((await fixture.pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
  }))
}

for (const corruption of ['negative-count', 'missing-event', 'trailing-event', 'underreported-bytes', 'invalid-surface', 'seed-without-cut'] as const) {
  test(`PG ${corruption} fails before it can produce an incomplete success`, () => cloudFixture(async (fixture) => {
    const row = await stored(fixture, native => [user(native, 'needle'), user(native, 'answer')])
    if (corruption === 'negative-count') await fixture.pool.query('UPDATE pe_sessions SET event_count=-1 WHERE id=$1', [row.header.id])
    if (corruption === 'missing-event') await fixture.pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=0', [row.header.id])
    if (corruption === 'trailing-event') await fixture.pool.query('UPDATE pe_sessions SET event_count=1 WHERE id=$1', [row.header.id])
    if (corruption === 'underreported-bytes') await fixture.pool.query('UPDATE pe_sessions SET event_bytes=1 WHERE id=$1', [row.header.id])
    if (corruption === 'invalid-surface') {
      const bad = { ...row.events[1], surfaceOp: { op: 'replace', startSeq: 999, endSeq: 999 }, sourceEventSeqs: [999] }
      await fixture.pool.query('UPDATE pe_events SET event=$2 WHERE session_id=$1 AND seq=1', [row.header.id, bad])
      await fixture.pool.query('UPDATE pe_sessions SET event_bytes=(SELECT sum(octet_length(event::text)) FROM pe_events WHERE session_id=$1) WHERE id=$1', [row.header.id])
    }
    if (corruption === 'seed-without-cut') await fixture.pool.query('UPDATE pe_sessions SET header=jsonb_set(header,\'{isSeeded}\',\'true\') WHERE id=$1', [row.header.id])
    const before = await original(fixture)
    await expect(searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', limits)).rejects.toMatchObject({ status: 500,
      code: ['invalid-surface', 'seed-without-cut'].includes(corruption) ? 'native_history_invalid' : 'native_history_gap' })
    expect(await original(fixture)).toEqual(before)
  }))
}

test('PG owner snapshot traverses all 65 equal-microsecond rows before returning a ranked result', () => cloudFixture(async (fixture) => {
  const tasks = new TaskStore(fixture.pool, taskLimits)
  for (let index = 0; index < 64; index++) await tasks.create(fixture.alice.user, requestId.parse(randomUUID()), fixture.alice.token)
  const row = await stored(fixture, native => [user(native, 'needle')])
  await fixture.pool.query("UPDATE pe_sessions SET updated_at='2026-10-09 00:00:00.123456+00' WHERE user_id=$1", [fixture.alice.user.userId])
  expect(await searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchMaxSessions: 65 }))
    .toEqual({ items: [{ sessionId: row.header.id, snippet: 'needle' }], hasMore: false })
  await expect(searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchMaxSessions: 64 }))
    .rejects.toMatchObject({ status: 503, code: 'native_search_budget_exceeded' })
}))

test('wire-invalid queries and pre-cancelled searches acquire no PostgreSQL connection', () => cloudFixture(async (fixture) => {
  const connect = vi.spyOn(fixture.pool, 'connect'), controller = new AbortController()
  try {
    for (const query of ['', ' \t ', '\0', 'x'.repeat(501)]) {
      await expect(searchNativeSessions(fixture.pool, fixture.alice.user, query, limits))
        .rejects.toMatchObject({ status: 400, code: 'native_search_invalid' })
    }
    controller.abort()
    await expect(searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', limits, controller.signal))
      .rejects.toMatchObject({ status: 499, code: 'native_search_cancelled' })
    expect(connect).not.toHaveBeenCalled()
  } finally { connect.mockRestore() }
}))

test('deadline includes saturated pool acquisition and destroys a late owned client', () => cloudFixture(async (fixture) => {
  const held = await Promise.all(Array.from({ length: 8 }, () => fixture.pool.connect()))
  let released = false
  try {
    await expect(searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchDeadlineMs: 30 }))
      .rejects.toMatchObject({ status: 504, code: 'native_search_timeout' })
    const removed = new Promise<void>((resolve) => { fixture.pool.once('remove', () => { resolve() }) })
    held[0]!.release(); released = true
    await removed
  } finally { for (const [index, client] of held.entries()) if (index !== 0 || !released) client.release() }
  expect((await fixture.pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
}))

test('caller cancellation includes saturated pool acquisition and destroys the late client', () => cloudFixture(async (fixture) => {
  const held = await Promise.all(Array.from({ length: 8 }, () => fixture.pool.connect()))
  let released = false
  try {
    const controller = new AbortController(), pending = searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', limits, controller.signal)
    await yieldToCarrier()
    expect(fixture.pool.waitingCount).toBe(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499, code: 'native_search_cancelled' })
    const removed = new Promise<void>((resolve) => { fixture.pool.once('remove', () => { resolve() }) })
    held[0]!.release(); released = true
    await removed
  } finally { for (const [index, client] of held.entries()) if (index !== 0 || !released) client.release() }
  expect((await fixture.pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
}))
