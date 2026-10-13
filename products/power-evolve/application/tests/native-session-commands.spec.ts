/** Native Session commands preserve real PG ownership, native event sequences and fork lineage. */
import { randomUUID } from 'node:crypto'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { appendOwnedEvents, type OwnedAppendState } from '../src/platform/native-owned-append.ts'
import { transaction } from '../src/platform/database.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { NativeSessionCommands } from '../src/platform/native-session-commands.ts'
import { NativePreferences } from '../src/platform/native-preferences.ts'
import { headerSchema, parseEvents } from '../src/session-records.ts'
import { requestId, settings } from '../src/contracts.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 67_108_864, maxHistoryEvents: 100_000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1,
  searchDeadlineMs: 5000, searchMaxSessions: 256, searchMaxEvents: 100_000, searchMaxBytes: 67_108_864,
  titleMaxBytes: 32, searchResultLimit: 1, searchSnippetChars: 60 }

test('native title normalization commits a real event and refuses foreign, leased and exhausted writes', () => cloudFixture(async ({ pool, alice, bob }) => {
  const tasks = new TaskStore(pool, limits), commands = new NativeSessionCommands(pool, limits), reads = new NativeSessionRead(pool)
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  expect(await commands.rename(alice.user, alice.token, { sessionId: session.sessionId, title: '  Durable\n  title  ' }))
    .toEqual({ title: 'Durable title', seq: 0 })
  expect((await reads.list(alice.user)).items[0]).toMatchObject({ blank: true, projections: { asOfSeq: 0, values: { title: 'Durable title' } } })
  await expect(commands.rename(bob.user, bob.token, { sessionId: session.sessionId, title: 'Foreign' })).rejects.toMatchObject({ status: 404 })
  await expect(commands.rename(alice.user, alice.token, { sessionId: session.sessionId, title: '  ' })).rejects.toMatchObject({ code: 'native_title_invalid' })
  await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'active input', alice.token)
  const active = await tasks.claim(randomUUID())
  await expect(commands.rename(alice.user, alice.token, { sessionId: session.sessionId, title: 'Busy' })).rejects.toMatchObject({ code: 'native_session_busy' })
  await tasks.finish(active!.token, 'completed', null)
  await expect(new NativeSessionCommands(pool, { ...limits, maxHistoryEvents: 1 }).rename(alice.user, alice.token,
    { sessionId: session.sessionId, title: 'Over quota' })).rejects.toMatchObject({ code: 'history_limit' })
  expect((await reads.list(alice.user)).items[0]!.projections?.values.title).toBe('Durable title')
}))

test('native forks reuse exact committed prefixes and preserve closed and open-cut lineage on restore', () => cloudFixture(async ({ pool, alice, bob }) => {
  const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits), commands = new NativeSessionCommands(pool, limits)
  const source = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const input = requestId.parse(randomUUID())
  await tasks.accept(alice.user, source.sessionId, input, 'needle 100%_literal', alice.token)
  const grant = await tasks.claim(randomUUID())
  const header = headerSchema.parse((await pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [source.sessionId])).rows[0]!.header)
  const session = Session.create(header.id, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { id: MessageId(input), role: 'user', content: [{ type: 'text', text: 'needle 100%_literal' }],
    source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await events.append(grant!.token, session.snapshotEvents())
  await tasks.finish(grant!.token, 'completed', null)
  const identity = requestId.parse(randomUUID()), request = { sessionId: source.sessionId }
  const closed = await commands.fork(alice.user, alice.token, request, identity)
  expect(await commands.fork(alice.user, alice.token, request, identity)).toEqual(closed)
  await expect(commands.fork(alice.user, alice.token, { ...request, atSeq: 1 }, identity)).rejects.toMatchObject({ status: 409 })
  await expect(commands.fork(bob.user, bob.token, request, requestId.parse(randomUUID()))).rejects.toMatchObject({ status: 404 })
  await expect(commands.fork(alice.user, alice.token, { ...request, atSeq: 50 }, requestId.parse(randomUUID()))).rejects.toMatchObject({ code: 'native_fork_unavailable' })
  const open = await commands.fork(alice.user, alice.token, { ...request, atSeq: 1 }, requestId.parse(randomUUID()))
  for (const child of [closed, open]) {
    const stored = (await pool.query<{ header: unknown; workspace_id: string }>(
      'SELECT header,workspace_id FROM pe_sessions WHERE id=$1', [child.sessionId])).rows[0]!
    const childHeader = headerSchema.parse(stored.header)
    expect(childHeader).toMatchObject({ isSeeded: true, parentSession: source.sessionId })
    const raw = (await pool.query<{ event: unknown }>(
      'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [child.sessionId])).rows.map(row => row.event)
    const seed = parseEvents(childHeader, raw)
    const marker = seed.findLast(event => event.type === 'session/end-seed' && event.data.inherited === true)!
    const restored = Session.fromRestore(childHeader.id, seed, childHeader, SessionLogOffset(marker.seq), 'shared-frozen')
    expect(restored.inheritedEventCount).toBe(marker.seq)
    expect(seed.findLast(event => event.type === 'turn/end')).toMatchObject({ type: 'turn/end', data: { reason: { kind: child === open ? 'forked' : 'completed' } } })
    expect((await new NativeSessionRead(pool).list(alice.user)).items.find(item => item.sessionId === child.sessionId))
      .toMatchObject({ parentSessionId: source.sessionId, blank: false })
  }
  expect(await commands.search(alice.user, '100%_literal')).toMatchObject({ items: [{ snippet: 'needle 100%_literal' }], hasMore: true })
  expect(await commands.search(bob.user, 'needle')).toEqual({ items: [], hasMore: false })
  expect(await commands.search(alice.user, 'not found')).toEqual({ items: [], hasMore: false })
}))

test('forks without completed turns and reused creation identities refuse before creating data', () => cloudFixture(async ({ pool, alice, identities }) => {
  const tasks = new TaskStore(pool, limits), commands = new NativeSessionCommands(pool, limits)
  const id = requestId.parse(randomUUID()), blank = await tasks.create(alice.user, id, alice.token)
  await expect(commands.fork(alice.user, alice.token, { sessionId: blank.sessionId }, requestId.parse(randomUUID())))
    .rejects.toMatchObject({ code: 'native_fork_unavailable' })
  await expect(commands.fork(alice.user, alice.token, { sessionId: blank.sessionId }, id)).rejects.toMatchObject({ code: 'request_id_conflict' })
  expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM pe_sessions')).rows[0]!.count).toBe('1')
  await identities.logout(alice.token)
  await expect(commands.rename(alice.user, alice.token, { sessionId: blank.sessionId, title: 'Revoked' })).rejects.toMatchObject({ status: 401 })
  expect(await commands.search(alice.user, 'not found')).toEqual({ items: [], hasMore: false })
}))

test('a fork inherits model intent from its exact prefix and uses that model at durable acceptance', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits), commands = new NativeSessionCommands(pool, limits)
  const preferences = new NativePreferences(pool, limits)
  await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,\'other-model\',\'Other model\',1000,true)', [alice.user.userId])
  const source = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await preferences.selectModel(alice.user, alice.token, { sessionId: source.sessionId, provider: 'power-evolve', model: 'trial-model' })
  const input = requestId.parse(randomUUID())
  await tasks.accept(alice.user, source.sessionId, input, 'first turn', alice.token)
  const grant = await tasks.claim(randomUUID())
  const header = headerSchema.parse((await pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [source.sessionId])).rows[0]!.header)
  const stored = (await pool.query<{ event: unknown }>(
    'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [source.sessionId])).rows.map(row => row.event)
  const session = Session.fromRestore(header.id, parseEvents(header, stored), header, SessionLogOffset(0), 'shared-frozen')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { id: MessageId(input), role: 'user', content: [{ type: 'text', text: 'first turn' }],
    source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await events.append(grant!.token, session.snapshotEvents().slice(1))
  await tasks.finish(grant!.token, 'completed', null)
  await preferences.selectModel(alice.user, alice.token, { sessionId: source.sessionId, provider: 'power-evolve', model: 'other-model' })
  const first = await commands.fork(alice.user, alice.token, { sessionId: source.sessionId, atSeq: 3 }, requestId.parse(randomUUID()))
  const latest = await commands.fork(alice.user, alice.token, { sessionId: source.sessionId }, requestId.parse(randomUUID()))
  for (const [child, model] of [[first, 'trial-model'], [latest, 'other-model']] as const) {
    await tasks.accept(alice.user, child.sessionId, requestId.parse(randomUUID()), 'child turn', alice.token)
    const accepted = (await pool.query<{ settings: unknown }>(
      'SELECT settings FROM pe_operations WHERE session_id=$1', [child.sessionId])).rows[0]!
    expect(settings.parse(accepted.settings).model).toBe(model)
    expect((await new NativeSessionRead(pool).list(alice.user)).items.find(item => item.sessionId === child.sessionId))
      .toMatchObject({ projections: { values: { modelSelection: { next: { provider: 'power-evolve', model, reasoningEffort: 'off' } } } } })
  }
}))

test('a gapped owned native batch rolls back its contiguous prefix and leaves the cold Session reusable', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), commands = new NativeSessionCommands(pool, limits)
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const rows = (await pool.query<OwnedAppendState>('SELECT id,header,event_count,event_bytes FROM pe_sessions WHERE id=$1',
    [created.sessionId])).rows
  const row = rows[0]
  if (!row) throw new Error('Owned append fixture did not create its Session')
  const header = headerSchema.parse(row.header), native = Session.create(header.id, undefined, header)
  const title = (value: string) => native.append('session/title', { title: value, messageSeqs: [], source: { kind: 'user' } })
  const first = title('uncommitted prefix')
  title('missing event')
  const gap = title('uncommitted suffix')
  const snapshot = async () => ({
    session: (await pool.query('SELECT * FROM pe_sessions WHERE id=$1', [created.sessionId])).rows,
    events: (await pool.query('SELECT * FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])).rows,
    preferences: (await pool.query('SELECT * FROM pe_native_preferences WHERE user_id=$1 ORDER BY namespace', [alice.user.userId])).rows,
  })
  const before = await snapshot()
  await expect(transaction(pool, async (client) => {
    const actor = await requireBrowserAccount(client, alice.token, { lock: 'update' })
    const locked = (await client.query<OwnedAppendState>(
      'SELECT id,header,event_count,event_bytes FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [created.sessionId, actor.userId])).rows[0]
    if (!locked) throw new Error('Owned append fixture lost its locked Session')
    await appendOwnedEvents(client, actor.userId, locked, [first, gap], limits)
  })).rejects.toMatchObject({ status: 503, code: 'native_event_gap' })
  expect(await snapshot()).toEqual(before)
  expect(await commands.rename(alice.user, alice.token, { sessionId: created.sessionId, title: 'committed after refusal' }))
    .toEqual({ title: 'committed after refusal', seq: 0 })
  expect((await new NativeSessionRead(pool).list(alice.user)).items[0])
    .toMatchObject({ projections: { asOfSeq: 0, values: { title: 'committed after refusal' } } })
}))
