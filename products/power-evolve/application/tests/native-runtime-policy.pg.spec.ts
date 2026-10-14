/** Real PG ties execution policy to the exact committed native event position. */
import { randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { readNativeRuntimePolicy } from '../src/platform/native-runtime-policy.ts'
import { transaction } from '../src/platform/database.ts'
import { headerSchema } from '../src/session-records.ts'
import { requestId } from '../src/contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxHistoryBytes: 67108864, maxHistoryEvents: 100000, maxEventBytes: 524288, leaseMs: 30000,
  maxPendingPerUser: 8, maxActivePerUser: 1 }

test('mode and permission generation come from committed Session events and survive reader recreation',
  () => cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'policy', alice.token)
    const grant = (await tasks.claim(randomUUID()))!
    const read = () => transaction(pool, async client => readNativeRuntimePolicy(client, await tasks.authorized(client, grant.token)))
    expect(await read()).toEqual({ mode: 'read-only', permissionGeneration: 1 })
    const snapshot = await events.runtimeSnapshot(grant.token) as { header: unknown }
    const header = headerSchema.parse(snapshot.header), session = Session.create(header.id, undefined, header)
    session.append('sandbox/mode', { mode: 'workspace-write' })
    await events.append(grant.token, session.snapshotEvents())
    expect(await read()).toEqual({ mode: 'workspace-write', permissionGeneration: 2 })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    await events.append(grant.token, session.snapshotEvents())
    expect(await read()).toEqual({ mode: 'danger-full-access', permissionGeneration: 3 })
    session.append('sandbox/mode', { mode: 'read-only' })
    await events.append(grant.token, session.snapshotEvents())
    expect(await read()).toEqual({ mode: 'read-only', permissionGeneration: 4 })
  }))
