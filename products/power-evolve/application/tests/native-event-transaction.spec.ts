/** Canonical event and checkpoint publication inside the caller's real PostgreSQL transaction. */
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 100,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('two ordered appends use one advancing watermark and publish their final checkpoint at commit', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const store = new EventStore(tasks, limits)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'ordered event transaction', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected the owned operation grant')
    const header = headerSchema.parse((await pool.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
    const native = Session.create(header.id, undefined, header)
    native.append('turn/start', { turn: 1 })
    const first = native.snapshotEvents()
    native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const all = native.snapshotEvents()
    await transaction(pool, async (client) => {
      const row = await tasks.authorized(client, grant.token)
      expect(await store.appendInTransaction(client, row, first)).toEqual({ eventCount: first.length })
      expect(row.event_count).toBe(first.length)
      expect(await store.appendInTransaction(client, row, all.slice(first.length))).toEqual({ eventCount: all.length })
      expect(await store.appendInTransaction(client, row, all)).toEqual({ eventCount: all.length })
      expect(row.event_bytes).toBe(String(all.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)))
      expect((await pool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1', [created.sessionId])).rows)
        .toEqual([{ count: 0 }])
    })
    expect((await pool.query<{ event: unknown }>(
      'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])).rows.map(row => row.event))
      .toEqual(all)
    expect((await pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [created.sessionId])).rows)
      .toEqual([{ event_count: all.length }])
    expect((await pool.query<{ as_of: number }>(
      "SELECT (value->>'asOfSeq')::integer AS as_of FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2",
      [alice.user.userId, `session-projections:${created.sessionId}`])).rows).toEqual([{ as_of: all.length - 1 }])
  }))

test('a later presentation failure rolls back the staged event, watermark and checkpoint together', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const store = new EventStore(tasks, limits)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'atomic rollback', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected the owned operation grant')
    const header = headerSchema.parse((await pool.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
    const native = Session.create(header.id, undefined, header)
    native.append('turn/start', { turn: 1 })
    const failure = new Error('presentation rejected')
    await expect(transaction(pool, async (client) => {
      const row = await tasks.authorized(client, grant.token)
      await store.appendInTransaction(client, row, native.snapshotEvents())
      throw failure
    })).rejects.toBe(failure)
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
      [created.sessionId])).rows).toEqual([{ count: 0 }])
    expect((await pool.query<{ event_count: number; event_bytes: string }>(
      'SELECT event_count,event_bytes FROM pe_sessions WHERE id=$1', [created.sessionId])).rows)
      .toEqual([{ event_count: 0, event_bytes: '0' }])
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
      [alice.user.userId, `session-projections:${created.sessionId}`])).rows).toEqual([{ count: 0 }])
    expect(await store.append(grant.token, native.snapshotEvents())).toEqual({ eventCount: native.snapshotEvents().length })
  }))
