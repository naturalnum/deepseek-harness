/** Real PG verifies native preference ownership, stale-write rejection and Session model admission. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { NativePreferences, nativePreferenceWrite, nativeModelSelect } from '../src/platform/native-preferences.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { requestId } from '../src/contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 67_108_864, maxHistoryEvents: 100_000 }
const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('native presentation changes survive a new service instance and remain tenant-owned', () => cloudFixture(async ({ pool, alice, bob }) => {
  const preferences = new NativePreferences(pool, eventLimits)
  expect(await preferences.read(alice.user, 'ui-settings-general')).toEqual({ value: {}, revision: 1 })
  const value = await preferences.write(alice.user, alice.token, nativePreferenceWrite.parse({ ns: 'ui-settings-general', mode: 'update',
    value: { welcomeNoticeVersion: '2026-09-28.1' }, expectedRevision: 1 }))
  expect(value).toEqual({ value: { welcomeNoticeVersion: '2026-09-28.1' }, revision: 2 })
  expect(await new NativePreferences(pool, eventLimits).read(alice.user, 'ui-settings-general')).toEqual(value)
  expect(await preferences.read(bob.user, 'ui-settings-general')).toEqual({ value: {}, revision: 1 })
  const writers = await Promise.allSettled([true, false].map(enabled => preferences.write(alice.user, alice.token,
    nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'replace', value: { enabled }, expectedRevision: 1 }))))
  expect(writers.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect(writers.filter(item => item.status === 'rejected')).toHaveLength(1)
  await expect(preferences.write(alice.user, bob.token, nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'replace', value: {} })))
    .rejects.toMatchObject({ status: 401 })
}))

test('settings reject invalid fields, unsafe paths, stale writes and revoked credentials without changing durable values', () => cloudFixture(async ({ pool, identities, alice }) => {
  const preferences = new NativePreferences(pool, eventLimits)
  const initial = nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'replace', value: { enabled: true }, expectedRevision: 1 })
  await preferences.write(alice.user, alice.token, initial)
  await expect(preferences.write(alice.user, alice.token, initial)).rejects.toMatchObject({ status: 409 })
  await expect(preferences.write(alice.user, alice.token, { ...initial, expectedRevision: 2, value: { enabled: 'false' } })).rejects.toThrow()
  const unset = nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'mutate', value: [{ op: 'unset', path: ['enabled'] }], expectedRevision: 2 })
  expect(await preferences.write(alice.user, alice.token, unset)).toEqual({ value: {}, revision: 3 })
  expect(nativePreferenceWrite.safeParse({ ...unset, ns: 'power-evolve-platform' }).success).toBe(false)
  await expect(preferences.write(alice.user, alice.token, { ...unset, expectedRevision: 3,
    value: [{ op: 'set', path: ['__proto__'], value: {} }] })).rejects.toMatchObject({ status: 400 })
  await identities.logout(alice.token)
  await expect(preferences.write(alice.user, alice.token, { ...initial, expectedRevision: 3 })).rejects.toMatchObject({ status: 401 })
  expect(await preferences.read(alice.user, 'ui-settings')).toEqual({ value: {}, revision: 3 })
}))

test('Session model selection snapshots the authorized model and ceiling without altering other Sessions', () => cloudFixture(async ({ pool, alice, bob }) => {
  const tasks = new TaskStore(pool, limits), preferences = new NativePreferences(pool, eventLimits)
  const a = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const b = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,\'second-model\',\'Second\',512,true)', [alice.user.userId])
  const selection = nativeModelSelect.parse({ sessionId: a.sessionId, provider: 'power-evolve', model: 'second-model' })
  expect(await preferences.selectModel(alice.user, alice.token, selection)).toEqual({ selected: { provider: 'power-evolve', model: 'second-model', reasoningEffort: 'off' } })
  await expect(preferences.selectModel(bob.user, bob.token, selection)).rejects.toMatchObject({ status: 404 })
  await expect(preferences.selectModel(alice.user, alice.token, { ...selection, model: 'ungranted' })).rejects.toMatchObject({ status: 403 })
  await expect(preferences.selectModel(alice.user, alice.token, { ...selection, provider: 'local' })).rejects.toMatchObject({ status: 403 })
  await tasks.accept(alice.user, a.sessionId, requestId.parse(randomUUID()), 'selected session', alice.token)
  await tasks.accept(alice.user, b.sessionId, requestId.parse(randomUUID()), 'default session', alice.token)
  const rows = await pool.query('SELECT session_id,settings FROM pe_operations ORDER BY input')
  expect(rows.rows).toEqual([{ session_id: b.sessionId, settings: { model: 'trial-model', maxTokens: 1000, revision: 2 } },
    { session_id: a.sessionId, settings: { model: 'second-model', maxTokens: 512, revision: 2 } }])
  await pool.query('UPDATE pe_user_models SET enabled=false WHERE user_id=$1 AND model_id=$2', [alice.user.userId, 'second-model'])
  await expect(tasks.accept(alice.user, a.sessionId, requestId.parse(randomUUID()), 'revoked', alice.token)).rejects.toMatchObject({ status: 403 })
}))

test('mutations set and remove only the named personal preference and reject nested paths before admission', () =>
  cloudFixture(async ({ pool, alice }) => {
    const preferences = new NativePreferences(pool, eventLimits)
    const write = (ns: 'ui-settings' | 'ui-settings-general', value: unknown, revision: number) => preferences.write(
      alice.user, alice.token, nativePreferenceWrite.parse({ ns, mode: 'mutate', value, expectedRevision: revision }))
    expect(await write('ui-settings', [{ op: 'set', path: ['enabled'], value: false }], 1))
      .toEqual({ value: { enabled: false }, revision: 2 })
    expect(await write('ui-settings-general', [{ op: 'set', path: ['welcomeNoticeVersion'], value: 'owned-notice' }], 1))
      .toEqual({ value: { welcomeNoticeVersion: 'owned-notice' }, revision: 2 })
    expect(await write('ui-settings-general', [{ op: 'unset', path: ['welcomeNoticeVersion'] }], 2))
      .toEqual({ value: {}, revision: 3 })
    expect(await preferences.read(alice.user, 'ui-settings')).toEqual({ value: { enabled: false }, revision: 2 })
    for (const path of [[], ['enabled', 'nested']]) {
      expect(nativePreferenceWrite.safeParse({ ns: 'ui-settings', mode: 'mutate', value: [{ op: 'unset', path }] }).success).toBe(false)
    }
  }))

test('model intent refuses a mismatched browser identity and a Session lease held by the task writer', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits), preferences = new NativePreferences(pool, eventLimits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const selection = nativeModelSelect.parse({ sessionId: session.sessionId, provider: 'power-evolve', model: 'trial-model' })
    await expect(preferences.selectModel(alice.user, bob.token, selection)).rejects.toMatchObject({ status: 401 })
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'hold the owned writer lease', alice.token)
    expect(await tasks.claim(randomUUID())).not.toBeNull()
    await expect(preferences.selectModel(alice.user, alice.token, selection)).rejects.toMatchObject({ status: 409, code: 'native_session_busy' })
    expect((await pool.query('SELECT namespace FROM pe_native_preferences WHERE user_id=$1 AND namespace LIKE $2',
      [alice.user.userId, 'session-model:%'])).rows).toEqual([{ namespace: `session-model:${session.sessionId}` }])
  }))
