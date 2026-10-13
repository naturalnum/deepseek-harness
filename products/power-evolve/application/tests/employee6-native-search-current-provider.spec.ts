/** Public native SQLite API proof, independent from Platform PostgreSQL integration. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { expect, test } from 'vitest'

test('public detached Session snapshots support official strongest-hit SQLite search and NUL text', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    for (const projection of currentSessionMessageProjections) ctx.sessions.registerMessageProjection(projection)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search', snippetChars: 100 })
    const id = SessionId(randomUUID()), text = 'before\0after needle needle'
    const session = ctx.sessions.prepare(id, { eventState: 'detached', inheritedEventCount: SessionLogOffset(0),
      meta: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false },
      seed: [{ type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }] })
    ctx.effect(() => ctx.sessions.enter(session))
    const page = await ctx.sessionQuery.searchSessions({ query: 'AFTER', eventFilters: [
      { kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] },
    ] })
    expect(page.items.map(hit => hit.header.id)).toEqual([id])
    expect(page.items[0]?.bestMatch.snippet).toContain('after')
  } finally { await ctx.fiber.dispose() }
})
