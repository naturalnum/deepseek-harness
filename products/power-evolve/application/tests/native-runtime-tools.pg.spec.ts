/** Actual PG request-header lookup refuses missing and stale native snapshots before model authorization. */
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { readNativeModelTools, registerNativeToolNames } from '../src/platform/native-tool-catalog.ts'
import { transaction } from '../src/platform/database.ts'
import { headerSchema } from '../src/session-records.ts'
import { requestId } from '../src/contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524288, maxHistoryBytes: 67108864, maxHistoryEvents: 100000, leaseMs: 30000,
  maxPendingPerUser: 8, maxActivePerUser: 1 }

test('native runtime requires its actual frozen tools and the current step header, preserving original external schemas', () => cloudFixture(async ({ pool, alice }) => {
  const authority = new NativeRuntimeAuthority(pool), tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
  const runtime = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'native', alice.token)
  const original = (await tasks.claim(runtime.runtimeId))!
  const read = (external: Parameters<typeof readNativeModelTools>[2] = []) => transaction(pool,
    async client => readNativeModelTools(client, await tasks.authorized(client, original.token), external))
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  const native = { name: 'native_registered', description: 'Original native description', parameters: { type: 'object' } }
  const external = { name: 'mcp__original__tool', description: 'Original catalog description', parameters: { type: 'object' } }
  await registerNativeToolNames(tasks, original.token, { names: [native.name], tools: [native] })
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  const snapshot = await events.runtimeSnapshot(original.token) as { header: unknown }, header = headerSchema.parse(snapshot.header)
  const session = Session.create(header.id, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'power-evolve', model: 'trial-model' }, tools: [native, external] }, reason: 'initial' })
  await events.append(original.token, session.snapshotEvents())
  expect(await read([external])).toEqual([native])
  await expect(read([{ ...external, parameters: { type: 'object', additionalProperties: false } }])).rejects.toMatchObject({ code: 'model_tool_not_authorized' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  await events.append(original.token, session.snapshotEvents())
  await expect(read([external])).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
}))
