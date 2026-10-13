/** Native content search reads tenant-owned PostgreSQL JSON without losing historical text. */
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionCommands } from '../src/platform/native-session-commands.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1,
  searchDeadlineMs: 5000, searchMaxSessions: 256, searchMaxEvents: 100_000, searchMaxBytes: 67_108_864,
  titleMaxBytes: 100, searchResultLimit: 2, searchSnippetChars: 24 }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]

async function storedSession({ pool, alice }: Fixture, populate: (native: Session) => void) {
  const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'search case', alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Expected admitted search case')
  const header = headerSchema.parse((await pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
  const native = Session.create(header.id, undefined, header)
  populate(native)
  await events.append(grant.token, native.snapshotEvents())
  await tasks.finish(grant.token, 'completed', null)
  return created.sessionId
}

function userMessage(native: Session, text: string): void {
  native.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
}

function assistantMessage(native: Session, text: string): void {
  native.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
}

for (const role of ['user', 'assistant'] as const) {
  test(`search applies native Unicode61 matching to ${role} text without rewriting stored JSON`, () =>
    cloudFixture(async (fixture) => {
      const { pool, alice, bob } = fixture, text = 'before\0after \\u0000 😀 \uD800'
      const id = await storedSession(fixture, (native) => {
        if (role === 'user') userMessage(native, text)
        else assistantMessage(native, text)
      })
      const commands = new NativeSessionCommands(pool, { ...limits, searchSnippetChars: 100 })
      const original = (await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [id])).rows
      for (const query of ['AFTER', '\\u0000']) {
        expect(await commands.search(alice.user, query))
          .toEqual({ items: [{ sessionId: id, snippet: text.replaceAll('\0', '\uFFFD').toWellFormed() }], hasMore: false })
        expect(await commands.search(bob.user, query)).toEqual({ items: [], hasMore: false })
      }
      for (const query of ['😀', '\uD800']) {
        expect(await commands.search(alice.user, query)).toEqual({ items: [], hasMore: false })
        expect(await commands.search(bob.user, query)).toEqual({ items: [], hasMore: false })
      }
      expect((await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [id])).rows)
        .toEqual(original)
    }))
}

test('search finds the assembled assistant message and ignores its reasoning block', () => cloudFixture(async (fixture) => {
  const { pool, alice } = fixture
  const id = await storedSession(fixture, (native) => {
    userMessage(native, 'ordinary prompt')
    native.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'Visible answer' }],
      source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
  })
  const commands = new NativeSessionCommands(pool, limits)
  expect(await commands.search(alice.user, 'ANSWER')).toEqual({ items: [{ sessionId: id, snippet: 'Visible answer' }], hasMore: false })
  expect(await commands.search(alice.user, 'private reasoning')).toEqual({ items: [], hasMore: false })
}))

test('ordinary consumers retain official Session metadata without using it as ownership', () => cloudFixture(async (fixture) => {
  const { pool, alice, bob } = fixture
  const id = await storedSession(fixture, (native) => { userMessage(native, 'metadata needle') })
  const saved = (await pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [id])).rows[0]?.header
  const header = { ...headerSchema.parse(saved), cwd: '/legacy/workspace', origin: 'subagent',
    delegationDepth: 2, agentPreset: 'legacy-preset' }
  await pool.query('UPDATE pe_sessions SET header=$2 WHERE id=$1', [id, header])
  const reader = new NativeSessionRead(pool)
  expect((await reader.list(alice.user)).items.map(item => item.sessionId)).toEqual([id])
  const request = { address: { kind: 'session' as const, sessionId: id } }
  expect((await reader.snapshot(alice.user, request)).header).toEqual({ ...header, cwd: '/workspace' })
  expect(await new NativeSessionCommands(pool, limits).search(alice.user, 'needle'))
    .toEqual({ items: [{ sessionId: id, snippet: 'metadata needle' }], hasMore: false })
  expect(await reader.list(bob.user)).toEqual({ items: [] })
  await expect(reader.snapshot(bob.user, request)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
  expect((await pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [id])).rows[0]?.header).toEqual(header)
}))

test('search accepts original JSON spelling while verifying the canonical event byte watermark', () => cloudFixture(async (fixture) => {
  const { pool, alice, bob } = fixture
  const id = await storedSession(fixture, (native) => { userMessage(native, 'lexical needle') })
  const saved = (await pool.query<{ event_json: string; canonical_bytes: string }>(
    `SELECT e.event::text AS event_json,s.event_bytes::text AS canonical_bytes FROM pe_events e
      JOIN pe_sessions s ON s.id=e.session_id WHERE e.session_id=$1 AND e.seq=0`, [id])).rows[0]
  if (saved === undefined) throw new Error('Expected original event text')
  const original = saved.event_json
  const lexical = original.replace(/"time":(\d+)/u, ' "time" : $1e0 ')
  expect(lexical).not.toBe(original)
  expect(JSON.parse(lexical)).toEqual(JSON.parse(original))
  await pool.query('UPDATE pe_events SET event=$2::json WHERE session_id=$1 AND seq=0', [id, lexical])
  const commands = new NativeSessionCommands(pool, limits)
  expect(await commands.search(alice.user, 'needle'))
    .toEqual({ items: [{ sessionId: id, snippet: 'lexical needle' }], hasMore: false })
  expect(await commands.search(bob.user, 'needle')).toEqual({ items: [], hasMore: false })
  expect((await pool.query<{ event_json: string }>(
    'SELECT event::text AS event_json FROM pe_events WHERE session_id=$1 AND seq=0', [id])).rows[0]?.event_json).toBe(lexical)
  await expect(new NativeSessionCommands(pool, { ...limits, searchMaxBytes: Number(saved.canonical_bytes) }).search(alice.user, 'needle'))
    .rejects.toMatchObject({ status: 503, code: 'native_search_budget_exceeded' })
  await pool.query('UPDATE pe_sessions SET event_bytes=event_bytes-1 WHERE id=$1', [id])
  await expect(commands.search(alice.user, 'needle')).rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
}))

test('native phrase search selects the strongest event and bounds excerpts with native ellipses', () => cloudFixture(async (fixture) => {
  const { pool, alice } = fixture, old = 'old 100%_\\literal', latest = '😀'.repeat(20) + 'İ 100%_\\literal latest'
  const id = await storedSession(fixture, (native) => {
    userMessage(native, old)
    userMessage(native, latest)
  })
  const commands = new NativeSessionCommands(pool, limits)
  const result = await commands.search(alice.user, '100%_\\literal')
  expect(result.items).toEqual([{ sessionId: id, snippet: old }])
  const excerpt = await commands.search(alice.user, 'latest')
  expect(excerpt.items).toEqual([{ sessionId: id, snippet: '…' + Array.from(latest).slice(-23).join('') }])
  expect(Array.from(excerpt.items[0]?.snippet ?? '')).toHaveLength(24)
  expect(await commands.search(alice.user, '100X_\\literal')).toEqual({ items: [], hasMore: false })
  expect((await commands.search(alice.user, 'i')).items[0]?.snippet).toBe('…' + Array.from(latest).slice(12, 34).join('') + '…')
}))

test('a matching event before a long nonmatching suffix remains searchable', () => cloudFixture(async (fixture) => {
  const { pool, alice } = fixture
  const id = await storedSession(fixture, (native) => {
    userMessage(native, 'early needle')
    for (let index = 0; index < 300; index++) native.append('session/title', {
      title: `metadata ${index}`, messageSeqs: [], source: { kind: 'user' },
    })
    assistantMessage(native, 'later answer')
  })
  expect(await new NativeSessionCommands(pool, limits).search(alice.user, 'needle'))
    .toEqual({ items: [{ sessionId: id, snippet: 'early needle' }], hasMore: false })
}))

test('search passes a long nonmatching session prefix and keeps precise timestamp ordering and hasMore', () => cloudFixture(async (fixture) => {
  const { pool, alice, bob } = fixture, tasks = new TaskStore(pool, limits)
  for (let index = 0; index < 65; index++) await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const matches = []
  for (let index = 0; index < 3; index++) matches.push(await storedSession(fixture, (native) => { userMessage(native, `needle ${index}`) }))
  await pool.query("UPDATE pe_sessions SET updated_at='2026-01-01 00:00:00.100004+00' WHERE user_id=$1", [alice.user.userId])
  for (const [index, id] of matches.entries()) await pool.query('UPDATE pe_sessions SET updated_at=$2 WHERE id=$1',
    [id, `2026-01-01 00:00:00.10000${index + 1}+00`])
  const commands = new NativeSessionCommands(pool, limits)
  expect(await commands.search(alice.user, 'needle')).toEqual({ items: [
    { sessionId: matches[2], snippet: 'needle 2' }, { sessionId: matches[1], snippet: 'needle 1' },
  ], hasMore: true })
  expect(await commands.search(bob.user, 'needle')).toEqual({ items: [], hasMore: false })
  await expect(commands.search(alice.user, '')).rejects.toMatchObject({ status: 400, code: 'native_search_invalid' })
}))

test('a complete nonmatching session page returns no results after reaching its end', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits)
  for (let index = 0; index < 64; index++) await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  expect(await new NativeSessionCommands(pool, limits).search(alice.user, 'needle')).toEqual({ items: [], hasMore: false })
}))

for (const invalid of ['unsupported format', 'different identity', 'unknown metadata', 'relative working directory'] as const) {
  test(`search refuses a stored header with ${invalid}`, () => cloudFixture(async (fixture) => {
    const { pool, alice } = fixture
    const id = await storedSession(fixture, (native) => { userMessage(native, 'needle') })
    const saved = (await pool.query<{ header: object }>('SELECT header FROM pe_sessions WHERE id=$1', [id])).rows[0]?.header
    if (!saved) throw new Error('Expected stored search header')
    await pool.query('UPDATE pe_sessions SET header=$2 WHERE id=$1',
      [id, { ...saved, ...(invalid === 'unsupported format' ? { version: 999 }
        : invalid === 'different identity' ? { id: randomUUID() }
          : invalid === 'unknown metadata' ? { futureMetadata: true } : { cwd: 'relative/workspace' }) }])
    await expect(new NativeSessionCommands(pool, limits).search(alice.user, 'needle'))
      .rejects.toMatchObject({ status: 500, code: 'native_history_invalid' })
  }))
}

test('search refuses a negative stored event watermark without altering history', () => cloudFixture(async (fixture) => {
  const { pool, alice } = fixture
  const id = await storedSession(fixture, (native) => { userMessage(native, 'needle') })
  const original = (await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1', [id])).rows
  await pool.query('UPDATE pe_sessions SET event_count=-1 WHERE id=$1', [id])
  await expect(new NativeSessionCommands(pool, limits).search(alice.user, 'needle'))
    .rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
  expect((await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1', [id])).rows).toEqual(original)
}))

for (const corruption of ['missing row', 'different JSON sequence', 'unknown required event', 'malformed message'] as const) {
  test(`search refuses a committed chunk with ${corruption}`, () => cloudFixture(async (fixture) => {
    const { pool, alice } = fixture
    const id = await storedSession(fixture, (native) => {
      userMessage(native, 'early needle')
      userMessage(native, 'later nonmatching text')
    })
    if (corruption === 'missing row') await pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=1', [id])
    else {
      const saved = (await pool.query<{ event: { seq: number; type: string; data: object } }>(
        'SELECT event FROM pe_events WHERE session_id=$1 AND seq=1', [id])).rows[0]?.event
      if (!saved) throw new Error('Expected search event')
      const event = { ...saved, ...(corruption === 'different JSON sequence' ? { seq: 0 }
        : corruption === 'unknown required event' ? { type: 'future/required-search-record' } : { data: {} }) }
      await pool.query('UPDATE pe_events SET event=$2::json WHERE session_id=$1 AND seq=1', [id, JSON.stringify(event)])
    }
    await expect(new NativeSessionCommands(pool, limits).search(alice.user, 'needle')).rejects.toMatchObject({ status: 500 })
  }))
}
