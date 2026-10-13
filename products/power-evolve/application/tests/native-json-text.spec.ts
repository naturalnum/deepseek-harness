/** PostgreSQL preserves native text, including escaped NUL, through cold reads and projection checkpoints. */
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { requestId } from '../src/contracts.ts'
import { headerSchema, parseEvents } from '../src/session-records.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { NativePreferences } from '../src/platform/native-preferences.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

for (const projected of [false, true]) {
  test(`native escaped NUL survives ${projected ? 'title and inbox projections' : 'message history and turn classification'}`, () =>
    cloudFixture(async ({ pool, alice, bob }) => {
      const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
      const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'native JSON text', alice.token)
      const grant = await tasks.claim(randomUUID())
      if (!grant) throw new Error('Expected admitted native JSON text operation')
      const header = headerSchema.parse((await pool.query<{ header: unknown }>(
        'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
      const native = Session.create(header.id, undefined, header), text = 'before\0after \\u0000 😀 \uD800'
      const message = { id: MessageId(randomUUID()), role: 'user' as const,
        content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } }
      if (projected) {
        native.append('session/title', { title: text, messageSeqs: [], source: { kind: 'user' } })
        native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
      } else {
        native.append('turn/start', { turn: 1 })
        native.append('user/message', message, { surfaceOp: 'append' })
        native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }
      const original = native.snapshotEvents()
      await events.append(grant.token, original)
      const stored = await pool.query<{ event: unknown; original: string }>(
        'SELECT event,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])
      expect(stored.rows.map(row => row.event)).toEqual(original)
      expect(stored.rows.map(row => row.original)).toEqual(parseEvents(header, original).map(event => JSON.stringify(event)))
      const reads = new NativeSessionRead(pool)
      const listed = (await reads.list(alice.user)).items.find(item => item.sessionId === created.sessionId)
      expect(listed?.blank).toBe(projected)
      if (projected) {
        expect(listed?.projections?.values.title).toBe(text)
        expect(listed?.projections?.values.inbox).toEqual({ 'next-turn': [message], 'next-step': [] })
        expect(await reads.adoptBlank(alice.user, created.sessionId)).toEqual(created)
      } else {
        await expect(reads.adoptBlank(alice.user, created.sessionId)).rejects.toMatchObject({ code: 'session_not_blank' })
      }
      expect(await reads.after(alice.user, created.sessionId, -1)).toEqual(original)
      const snapshot = await reads.snapshot(alice.user, { address: { kind: 'session', sessionId: created.sessionId } })
      expect(snapshot.records).toEqual(original.map(event => ({ type: 'event', event })))
      await expect(reads.snapshot(bob.user, { address: { kind: 'session', sessionId: created.sessionId } }))
        .rejects.toMatchObject({ code: 'session_not_found' })
      await tasks.finish(grant.token, 'completed', null)
    }))
}

test('a retained version 1 checkpoint reads and advances to the JSON text encoding without changing prior events', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits), preferences = new NativePreferences(pool, limits), reads = new NativeSessionRead(pool)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const request = { sessionId: created.sessionId, provider: 'power-evolve' as const, model: 'trial-model' }
    await preferences.selectModel(alice.user, alice.token, request)
    const namespace = `session-projections:${created.sessionId}`
    const persisted = z.object({ version: z.literal(2), asOfSeq: z.number(), stateJson: z.string() }).strict().parse(
      (await pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
        [alice.user.userId, namespace])).rows[0]?.value)
    const old = z.json().parse(JSON.parse(persisted.stateJson))
    const history = await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])
    await pool.query('UPDATE pe_native_preferences SET value=$3 WHERE user_id=$1 AND namespace=$2', [alice.user.userId, namespace, old])
    expect((await reads.list(alice.user)).items[0]?.projections?.values.modelSelection)
      .toMatchObject({ next: { model: 'trial-model' } })
    await preferences.selectModel(alice.user, alice.token, request)
    expect((await reads.list(alice.user)).items[0]?.projections?.asOfSeq).toBe(1)
    expect((await pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
      [alice.user.userId, namespace])).rows[0]?.value).toMatchObject({ version: 2, asOfSeq: 1 })
    expect((await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 AND seq=0', [created.sessionId])).rows)
      .toEqual(history.rows)
  }))

for (const invalid of ['future encoding', 'malformed JSON text', 'different watermark'] as const) {
  test(`a checkpoint with ${invalid} refuses cold reads and writes while retaining history`, () =>
    cloudFixture(async ({ pool, alice }) => {
      const tasks = new TaskStore(pool, limits), preferences = new NativePreferences(pool, limits), reads = new NativeSessionRead(pool)
      const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      const request = { sessionId: created.sessionId, provider: 'power-evolve' as const, model: 'trial-model' }
      await preferences.selectModel(alice.user, alice.token, request)
      const namespace = `session-projections:${created.sessionId}`
      const persisted = z.object({ version: z.literal(2), asOfSeq: z.number(), stateJson: z.string() }).strict().parse(
        (await pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
          [alice.user.userId, namespace])).rows[0]?.value)
      const bad = { ...persisted, ...(invalid === 'future encoding' ? { version: 3 }
        : invalid === 'malformed JSON text' ? { stateJson: '{' } : { asOfSeq: 1 }) }
      const before = await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])
      await pool.query('UPDATE pe_native_preferences SET value=$3 WHERE user_id=$1 AND namespace=$2', [alice.user.userId, namespace, bad])
      await expect(reads.list(alice.user)).rejects.toThrow()
      await expect(preferences.selectModel(alice.user, alice.token, request)).rejects.toThrow()
      expect((await pool.query('SELECT seq,event::text AS original FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])).rows)
        .toEqual(before.rows)
    }))
}
