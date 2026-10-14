/** PG stores native preset creation and blank selection without changing another account or existing conversation. */
import { randomUUID } from 'node:crypto'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { TaskStore } from '../src/platform/tasks.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { selectNativePreset } from '../src/platform/native-preset-selection.ts'
import { EventStore } from '../src/platform/events.ts'
import { requestId } from '../src/contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 67_108_864, maxHistoryEvents: 100_000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('persists creation and selection in the native projection through a new reader while keeping accounts separate', () => cloudFixture(async ({ pool, alice, bob }) => {
  const tasks = new TaskStore(pool, limits)
  const own = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, undefined, 'standard')
  const foreign = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token, undefined, 'minimal')
  expect(await selectNativePreset(pool, alice.user, alice.token, { sessionId: own.sessionId, agentPreset: 'ptc' }, limits)).toBe('ptc')
  expect((await new NativeSessionRead(pool).list(alice.user)).items[0]?.projections?.values.agentPreset).toBe('ptc')
  expect((await new NativeSessionRead(pool).list(bob.user)).items[0]?.projections?.values.agentPreset).toBe('minimal')
  await expect(selectNativePreset(pool, alice.user, alice.token, { sessionId: foreign.sessionId, agentPreset: 'cordis' }, limits))
    .rejects.toMatchObject({ status: 404 })
  await tasks.accept(alice.user, own.sessionId, requestId.parse(randomUUID()), 'begin', alice.token)
  const operation = await tasks.claim(randomUUID())
  expect(operation).not.toBeNull()
  await expect(selectNativePreset(pool, alice.user, alice.token, { sessionId: own.sessionId, agentPreset: 'minimal' }, limits))
    .rejects.toMatchObject({ code: 'native_session_busy' })
  await new EventStore(tasks, limits).append(operation!.token, [{ seq: SessionSeq(1), time: Date.now(), type: 'turn/start', data: { turn: 1 } }])
  await tasks.finish(operation!.token, 'completed', null)
  await expect(selectNativePreset(pool, alice.user, alice.token, { sessionId: own.sessionId, agentPreset: 'minimal' }, limits))
    .rejects.toMatchObject({ code: 'native_preset_locked' })
}))
