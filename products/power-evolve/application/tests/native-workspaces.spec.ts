/** Native cloud directory and grouping behavior against independent real PG databases. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { cloudFixture } from './cloud-fixture.ts'
import { requestId, workspaceId } from '../src/contracts.ts'
import { cloudDirectory, cloudDirectoryName } from '../src/native-workspace-contracts.ts'
import { NativeWorkspaceRead } from '../src/platform/native-workspace-read.ts'
import { TaskStore } from '../src/platform/tasks.ts'

const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('native directory picking adopts one owned directory concurrently and survives service restart', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const service = new NativeWorkspaceRead(pool, files, 8, 256)
  expect(await service.directories(alice.user)).toMatchObject({ path: '/workspace', home: '/workspace', entries: [], truncated: false })
  expect(await service.createDirectory(alice.user, alice.token, '/workspace', 'Reports')).toBe('/workspace/Reports')
  const requests = await Promise.all([1, 2].map(() => service.adopt(alice.user, alice.token, '/workspace/Reports', requestId.parse(randomUUID()))))
  expect(requests.map(item => item.created).sort()).toEqual([false, true])
  expect(requests[0]!.workspace.workspaceId).toBe(requests[1]!.workspace.workspaceId)
  expect(requests[0]!.workspace).toMatchObject({ path: '/workspace/Reports', title: 'Reports', sessionIds: [] })
  const fresh = new NativeWorkspaceRead(pool, files, 8, 256)
  expect((await fresh.baseline(alice.user)).items.map(item => item.path)).toEqual(['/workspace', '/workspace/Reports'])
  expect(await fresh.directories(bob.user)).toMatchObject({ entries: [] })
  await expect(fresh.adopt(bob.user, bob.token, '/workspace/Reports', requestId.parse(randomUUID()))).rejects.toMatchObject({ status: 404 })
  await expect(fresh.createDirectory(alice.user, alice.token, '/workspace', 'Reports')).rejects.toMatchObject({ code: 'directory_exists' })
  const id = requests[0]!.workspace.workspaceId
  await files.put(alice.user, randomUUID(), 'note.txt', Buffer.from('kept bytes').toString('base64'), id)
  const changed = await fresh.rename(alice.user, alice.token, id, 'Renamed')
  expect(changed.workspace).toMatchObject({ path: '/workspace/Reports', title: 'Renamed' })
  await fresh.remove(alice.user, alice.token, id)
  expect((await fresh.baseline(alice.user)).items).toHaveLength(1)
  const tasks = new TaskStore(pool, taskLimits)
  await expect(tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, id)).rejects.toMatchObject({ code: 'workspace_not_found' })
  expect(Buffer.from((await files.read(alice.user, 'note.txt', id)).data, 'base64').toString()).toBe('kept bytes')
  const restored = await fresh.adopt(alice.user, alice.token, '/workspace/Reports', requestId.parse(randomUUID()))
  expect(restored).toMatchObject({ created: true, workspace: { workspaceId: id, title: 'Renamed' } })
  await expect(fresh.remove(bob.user, bob.token, id)).rejects.toMatchObject({ status: 404 })
}))

test('native manual order, archive and pins remain owned and durable', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const service = new NativeWorkspaceRead(pool, files, 8, 256), tasks = new TaskStore(pool, taskLimits)
  const home = (await service.baseline(alice.user)).items[0]!
  const a = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, home.workspaceId)
  const b = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, home.workspaceId)
  expect((await service.orderSession(alice.user, alice.token, home.workspaceId, a.sessionId, b.sessionId)).workspace.sessionIds)
    .toEqual([a.sessionId, b.sessionId])
  await service.createDirectory(alice.user, alice.token, '/workspace', 'Other')
  const other = await service.adopt(alice.user, alice.token, '/workspace/Other', requestId.parse(randomUUID()))
  expect(await service.order(alice.user, alice.token, other.workspace.workspaceId, home.workspaceId))
    .toEqual({ workspaceIds: [other.workspace.workspaceId, home.workspaceId] })
  await expect(service.orderSession(alice.user, alice.token, other.workspace.workspaceId, a.sessionId))
    .rejects.toMatchObject({ code: 'native_move_invalid' })
  await expect(service.groupSession(bob.user, bob.token, a.sessionId, 'pin')).rejects.toMatchObject({ status: 404 })
  expect(await service.groupSession(alice.user, alice.token, a.sessionId, 'pin')).toEqual({ pinnedSessionIds: [a.sessionId] })
  expect(await service.groupSession(alice.user, alice.token, b.sessionId, 'pin')).toEqual({ pinnedSessionIds: [b.sessionId, a.sessionId] })
  expect(await service.groupSession(alice.user, alice.token, a.sessionId, 'archive')).toEqual({ archivedSessionIds: [a.sessionId] })
  await expect(service.groupSession(alice.user, alice.token, a.sessionId, 'pin')).rejects.toMatchObject({ code: 'native_session_archived' })
  const current = await new NativeWorkspaceRead(pool, files, 8, 256).baseline(alice.user)
  expect(current).toMatchObject({ archivedSessionIds: [a.sessionId], pinnedSessionIds: [b.sessionId] })
  expect(current.items[1]!.sessionIds).toEqual([a.sessionId, b.sessionId])
  await service.groupSession(alice.user, alice.token, a.sessionId, 'unarchive')
  await tasks.accept(alice.user, a.sessionId, requestId.parse(randomUUID()), 'queued work', alice.token)
  await expect(service.groupSession(alice.user, alice.token, a.sessionId, 'archive')).rejects.toMatchObject({ code: 'native_session_active' })
}))

test('directory and Workspace writes refuse traversal, capacity, stale ownership and revoked credentials', () => cloudFixture(async ({ pool, files, identities, alice, bob }) => {
  const service = new NativeWorkspaceRead(pool, files, 1, 2)
  for (const path of ['/etc', '/workspace/../outside', '/workspace//double', '/workspace/child/',
    '/workspace/ leading', '/workspace/trailing ', `/workspace/${'x'.repeat(81)}`]) expect(cloudDirectory.safeParse(path).success).toBe(false)
  for (const name of ['.', '..', 'a/b', 'a\\b', ' ', 'bad\nname']) expect(cloudDirectoryName.safeParse(name).success).toBe(false)
  await service.createDirectory(alice.user, alice.token, '/workspace', 'One')
  await expect(service.createDirectory(alice.user, alice.token, '/workspace', 'Two')).rejects.toMatchObject({ code: 'directory_limit' })
  await expect(service.adopt(alice.user, alice.token, '/workspace/One', requestId.parse(randomUUID()))).rejects.toMatchObject({ code: 'workspace_limit' })
  const home = (await service.baseline(alice.user)).items[0]!
  await expect(service.rename(alice.user, bob.token, home.workspaceId, 'Foreign')).rejects.toMatchObject({ status: 401 })
  await expect(service.order(alice.user, alice.token, workspaceId.parse(randomUUID()))).rejects.toMatchObject({ status: 404 })
  await identities.logout(alice.token)
  await expect(service.rename(alice.user, alice.token, home.workspaceId, 'Revoked')).rejects.toMatchObject({ status: 401 })
  expect((await service.baseline(alice.user)).items[0]!.title).toBe('Workspace')
}))

test('stored layout refuses foreign Sessions, duplicate order and missing parents before native reads or writes', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const service = new NativeWorkspaceRead(pool, files, 8, 256), tasks = new TaskStore(pool, taskLimits)
  const home = (await service.baseline(alice.user)).items[0]!
  const own = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const foreign = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
  await service.groupSession(alice.user, alice.token, own.sessionId, 'pin')
  const saved = z.record(z.string(), z.unknown()).parse((await pool.query<{ value: unknown }>(
    'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=\'workspace-layout\'', [alice.user.userId])).rows[0]!.value)
  const invalid = [
    { ...saved, pinnedSessionIds: [foreign.sessionId] },
    { ...saved, pinnedSessionIds: [own.sessionId, own.sessionId] },
    { ...saved, archivedSessionIds: [own.sessionId] },
    { ...saved, workspaceOrder: [home.workspaceId, home.workspaceId] },
    { ...saved, sessionOrder: { [home.workspaceId]: [foreign.sessionId] } },
    { ...saved, directories: ['/workspace', '/workspace/missing/child'] },
    { version: 9 },
  ]
  for (const value of invalid) {
    await pool.query('UPDATE pe_native_preferences SET value=$2 WHERE user_id=$1 AND namespace=\'workspace-layout\'', [alice.user.userId, value])
    await expect(service.baseline(alice.user)).rejects.toMatchObject({ code: 'native_workspace_layout_invalid', status: 503 })
    await expect(service.createDirectory(alice.user, alice.token, '/workspace', 'New')).rejects.toMatchObject({ code: 'native_workspace_layout_invalid' })
  }
  await pool.query('UPDATE pe_native_preferences SET value=$2 WHERE user_id=$1 AND namespace=\'workspace-layout\'', [alice.user.userId, saved])
  expect((await service.baseline(alice.user)).pinnedSessionIds).toEqual([own.sessionId])
}))
