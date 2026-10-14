/** Real PG verifies native projection watermarks, cold reads and fenced model intent. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { nativePermissionProjection } from '../src/host/native-permission-projection.ts'
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, test } from 'vitest'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativePreferences } from '../src/platform/native-preferences.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { checkpointNativeProjections } from '../src/platform/native-projections.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { transaction } from '../src/platform/database.ts'
import { headerSchema } from '../src/session-records.ts'
import { requestId } from '../src/contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedNativeFacts } from './native-retained-intent-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 67_108_864, maxHistoryEvents: 100_000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('blank and stored Sessions expose the actual upstream folds with one committed watermark',
  () => cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits), reads = new NativeSessionRead(pool), store = new EventStore(tasks, limits)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const blank = (await reads.list(alice.user)).items[0]!
    expect(blank.agentAvailable).toBe(false)
    expect(blank.projections).toEqual({ kind: 'sequenced', asOfSeq: -1, permissionKnobs: { preset: null, sandbox: null, approval: null },
      values: { modelSelection: { next: null, lastUsed: null }, inbox: { 'next-turn': [], 'next-step': [] }, title: null } })
    const id = requestId.parse(randomUUID())
    await tasks.accept(alice.user, created.sessionId, id, 'native input', alice.token)
    const grant = await tasks.claim(randomUUID())
    expect(grant).not.toBeNull()
    const snapshot = await store.runtimeSnapshot(grant!.token)
    const header = headerSchema.parse((snapshot as { header: unknown }).header)
    const session = Session.create(header.id, undefined, header)
    const message = { id: MessageId(id), role: 'user' as const, source: { kind: 'user' as const, rpcId: brandString<SessionRequestId>(id) },
      content: [{ type: 'text' as const, text: 'native input' }] }
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    session.append('session/title', { title: 'Stored title', messageSeqs: [], source: { kind: 'user' } })
    await store.append(grant!.token, session.snapshotEvents())
    const listed = (await new NativeSessionRead(pool).list(alice.user)).items[0]!
    expect(listed.projections?.asOfSeq).toBe(1)
    expect(listed.projections?.values.title).toBe('Stored title')
    expect(listed.projections?.values.inbox).toEqual({ 'next-turn': [message], 'next-step': [] })
    const opened = await reads.snapshot(alice.user, { address: { kind: 'session', sessionId: created.sessionId } })
    expect(opened.projections).toEqual({ asOfSeq: 1, permissionKnobs: { preset: null, sandbox: null,
      approval: null }, values: listed.projections!.values })
    await expect(reads.snapshot(bob.user, { address: { kind: 'session',
      sessionId: created.sessionId } })).rejects.toMatchObject({ status: 404 })
    await store.append(grant!.token, session.snapshotEvents())
    expect((await reads.list(alice.user)).items[0]!.projections?.asOfSeq).toBe(1)
    await pool.query('UPDATE pe_native_preferences SET value=jsonb_set(value,\'{asOfSeq}\',\'5\') WHERE user_id=$1 AND namespace=$2',
      [alice.user.userId, `session-projections:${created.sessionId}`])
    await expect(reads.list(alice.user)).rejects.toMatchObject({ code: 'native_projection_gap' })
  }))

test('model intent appends a native event and refuses a live writer and exhausted history', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), preferences = new NativePreferences(pool, limits), reads = new NativeSessionRead(pool)
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const selection = { sessionId: session.sessionId, provider: 'power-evolve' as const, model: 'trial-model' }
  await preferences.selectModel(alice.user, alice.token, selection)
  expect((await reads.list(alice.user)).items[0]!.projections?.values.modelSelection).toEqual({ next: { provider: 'power-evolve', model: 'trial-model', reasoningEffort: 'off' }, lastUsed: null })
  expect((await reads.list(alice.user)).items[0]!.blank).toBe(true)
  expect(await reads.adoptBlank(alice.user, session.sessionId)).toEqual({ sessionId: session.sessionId })
  expect((await pool.query<{ event: unknown }>('SELECT event FROM pe_events')).rows[0]!.event)
    .toMatchObject({ type: 'model/selection', seq: 0, data: { provider: 'power-evolve', model: 'trial-model' } })
  await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'claim', alice.token)
  const grant = await tasks.claim(randomUUID())
  await expect(preferences.selectModel(alice.user, alice.token, selection)).rejects.toMatchObject({ code: 'native_session_busy' })
  await tasks.finish(grant!.token, 'completed', null)
  await expect(new NativePreferences(pool, { ...limits, maxHistoryEvents: 1 }).selectModel(alice.user, alice.token, selection))
    .rejects.toMatchObject({ code: 'history_limit' })
  expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM pe_events')).rows[0]!.count).toBe('1')
}))

test.each(['future checkpoint', 'missing final catch-up event'] as const)(
  '%s rolls back the actual append until its stored prefix is repaired', damage => cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits), store = new EventStore(tasks, limits), reads = new NativeSessionRead(pool)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await transaction(pool, async (client) => {
      const actor = await requireBrowserAccount(client, alice.token, { lock: 'update' })
      const locked = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [created.sessionId, actor.userId])
      expect(locked.rowCount).toBe(1)
      const owned = await tasks.owned(client, alice.user, created.sessionId)
      expect(actor.userId).toBe(alice.user.userId)
      await checkpointNativeProjections(client, actor.userId, headerSchema.parse(owned.header), 0, [])
    })
    expect((await reads.snapshot(alice.user, { address: { kind: 'session', sessionId: created.sessionId } })).projections)
      .toMatchObject({ asOfSeq: -1, values: { title: null } })
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'projection repair', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected the actual projection repair grant')
    const header = headerSchema.parse((await store.runtimeSnapshot(grant.token) as { header: unknown }).header)
    const native = Session.create(header.id, undefined, header)
    const first = native.append('session/title', { title: 'Committed prefix', messageSeqs: [], source: { kind: 'user' } })
    await store.append(grant.token, [first])
    const namespace = `session-projections:${created.sessionId}`
    const checkpoint = (await pool.query<{ value: unknown }>(
      'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2', [alice.user.userId, namespace])).rows[0]!.value
    if (damage === 'future checkpoint') {
      await pool.query(`UPDATE pe_native_preferences SET value=jsonb_set(jsonb_set(value,'{asOfSeq}','1'),
        '{stateJson}',to_jsonb(jsonb_set((value->>'stateJson')::jsonb,'{asOfSeq}','1')::text))
        WHERE user_id=$1 AND namespace=$2`, [alice.user.userId, namespace])
    } else {
      await pool.query('DELETE FROM pe_events WHERE session_id=$1 AND seq=$2', [created.sessionId, first.seq])
      await pool.query('DELETE FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2', [alice.user.userId, namespace])
    }
    const before = await retainedNativeFacts(pool)
    const next = native.append('session/title', { title: 'Repaired suffix', messageSeqs: [], source: { kind: 'user' } })
    await expect(store.append(grant.token, [next])).rejects.toMatchObject({ status: 503, code: 'native_projection_gap' })
    expect(await retainedNativeFacts(pool)).toEqual(before)
    if (damage === 'future checkpoint') {
      await pool.query('UPDATE pe_native_preferences SET value=$3 WHERE user_id=$1 AND namespace=$2',
        [alice.user.userId, namespace, checkpoint])
    } else {
      await pool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,$2,$3::json)', [created.sessionId,
        first.seq, JSON.stringify(first)])
    }
    expect(await store.append(grant.token, [next])).toEqual({ eventCount: 2 })
    expect((await reads.list(alice.user)).items[0]!.projections).toMatchObject({ asOfSeq: 1, values: { title: 'Repaired suffix' } })
    expect((await pool.query<{ seq: string }>('SELECT seq::text FROM pe_events WHERE session_id=$1 ORDER BY seq',
      [created.sessionId])).rows.map(row => row.seq)).toEqual(['0', '1'])
  }))


test('actual native permission presentation resolves the committed PG knobs through the current custom and Auto catalogs', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), reads = new NativeSessionRead(pool), store = new EventStore(tasks, limits)
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, undefined, 'standard')
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', { sandboxMode: 'workspace-write' })
    ctx.provide('approval', { config: { policy: 'ask' } })
    await ctx.plugin(PermissionPresetService, { presets: { first: { sandbox: 'workspace-write', approval: 'ask' },
      customNamed: { sandbox: 'workspace-write', approval: 'ask' }, full: { sandbox: 'danger-full-access', approval: 'never' } } })
    const empty = (await reads.list(alice.user)).items[0]!.projections
    expect(nativePermissionProjection(ctx, empty).values.permissions).toEqual({ currentValue: 'first' })
    expect(nativePermissionProjection(ctx, empty)).not.toHaveProperty('permissionKnobs')
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'owned permissions', alice.token)
    const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Owned grant missing')
    const snapshot = await store.runtimeSnapshot(grant.token), header = headerSchema.parse((snapshot as { header: unknown }).header)
    const native = Session.create(header.id, undefined, header)
    native.append('permission/preset', { preset: 'customNamed' }); native.append('sandbox/mode',
      { mode: 'workspace-write' }); native.append('approval/policy', { policy: 'ask' })
    await store.append(grant.token, native.snapshotEvents())
    const folded = (await reads.list(alice.user)).items[0]!.projections
    expect(nativePermissionProjection(ctx, folded)).toMatchObject({ asOfSeq: 2, values: { permissions: { currentValue: 'customNamed' } } })
    const disposeAuto = ctx.permissionPresets.registerAuto(() => {})
    native.append('permission/preset', { preset: 'auto' }); native.append('sandbox/mode',
      { mode: 'danger-full-access' }); native.append('approval/policy', { policy: 'never' })
    await store.append(grant.token, native.snapshotEvents())
    const auto = (await reads.list(alice.user)).items[0]!.projections
    expect(nativePermissionProjection(ctx, auto).values.permissions).toEqual({ currentValue: 'auto' })
    await disposeAuto()
    expect(nativePermissionProjection(ctx, auto).values.permissions).toEqual({ currentValue: 'full' })
    expect(nativePermissionProjection(ctx, auto).asOfSeq).toBe(5)
    expect(() => nativePermissionProjection(ctx, { asOfSeq: 5, values: {} })).toThrow('native_permission_projection_unavailable')
  } finally { await ctx.fiber.dispose() }
}))
