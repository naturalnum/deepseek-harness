/** A stored negative watermark must fail before the search can report an empty page. */
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, test, vi } from 'vitest'
import { identity } from '../src/contracts.ts'
import { searchNativeSessions } from '../src/platform/native-session-search.ts'

test('native search refuses a negative persisted event watermark', async () => {
  const native = Session.create(SessionId(randomUUID()))
  const owner = identity.parse({ userId: randomUUID(), username: 'owned-review' })
  const pool = new Pool()
  try {
    const client = Object.assign(new Client(), { release: vi.fn() })
    const query = vi.fn(async (sql: string) => {
      const answer = (rows: unknown[]) => ({ rows, rowCount: rows.length })
      if (['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK',
        "SELECT set_config('statement_timeout',$1,true)"].includes(sql)) return answer([])
      if (sql.startsWith('SELECT id,header,event_count,event_bytes::text AS event_bytes,updated_at::text')) {
        return answer([{ id: native.id, header: native.header, event_count: -1, event_bytes: '0',
          updated_at: '2026-10-09 12:00:00.000001+08' }])
      }
      throw new Error('Unexpected query: ' + sql)
    })
    Object.defineProperty(pool, 'connect', { value: async () => client })
    Object.defineProperty(client, 'query', { value: query })
    await expect(searchNativeSessions(pool, owner, 'needle', { searchResultLimit: 2, searchSnippetChars: 24,
      maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
      searchDeadlineMs: 5000, searchMaxSessions: 256, searchMaxEvents: 100_000, searchMaxBytes: 67_108_864 }))
      .rejects.toMatchObject({ status: 500, code: 'native_history_gap' })
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT id,header,event_count,'))).toHaveLength(1)
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
    expect(client.release).toHaveBeenCalledOnce()
    expect(client.listenerCount('error')).toBe(0)
  } finally { await pool.end() }
})
