/** Projection behavior with scripted directory/CAS facts; Linux isolation is covered by the native suites. */
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { createSkillProjectWork } from '../src/skill-project-work.ts'
import { FdMutationFailure, FdWorkerClient } from '../src/worker-client.ts'
import type { SkillVersion } from '../src/skill-versions.ts'

const signal = () => new AbortController().signal
async function fixture() {
  const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url)), client = new FdWorkerClient(worker)
  onTestFinished(async () => { await client.close(); await client.exited; await worker.terminate() }); await client.ready
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('capacity-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'fixture', lifetime: signal() }
  const unavailable = async (): Promise<never> => { throw new Error('No Workspace mutation belongs to this fixture') }
  const workspace = (id: string): Workspace => ({ id: brandString<Workspace['id']>(id), path: `/projects/${id}`, title: id,
    createdAt: '', updatedAt: '', sessionIds: [], setTitle: unavailable, attachSession: unavailable,
    insertSessionBefore: unavailable, detachSession: unavailable, status: async () => 'ok' })
  const root = (path: string) => ({ rootPath: path, rootDevice: '2', rootInode: '15', rootMountId: '22' })
  const directory = (inode: string) => ({ device: '2', inode, mountId: '22', uid: 2000, gid: 2000, mode: 0o40700 })
  const records = new Map<string, string>(), directories = new Set<string>(), entries = new Map<string, string[]>()
  const recordName = (id: string) => `project-${createHash('sha256').update(id).digest('hex')}.json`
  const facts = { type: 'directory' as const, identity: '2:55', version: 'dir' }
  vi.spyOn(client, 'skillSourceContext').mockResolvedValue({ bootId: '11111111-1111-4111-8111-111111111111',
    mountNamespace: 'mnt:[123]' })
  vi.spyOn(client, 'lstat').mockImplementation(async (selected, path) => {
    if (path === '.pe/skills') return directories.has(selected.rootPath) ? facts : undefined
    const record = records.get(path)
    return record === undefined ? facts : { type: 'file', identity: '1:99', version: 'v1', size: Buffer.byteLength(record) }
  })
  vi.spyOn(client, 'prepareProjectMetadata').mockResolvedValue({ directory: directory('19'), created: false })
  const native = vi.spyOn(client, 'skillDirectory').mockImplementation(async (selected, _uid, _gid, purpose) => {
    if (purpose === 'store' || purpose === 'store-verify' || purpose === 'store-read') return { created: false,
      directory: { ...directory('99'), device: '1', mountId: '11' } }
    const path = selected.rootPath.slice(0, -'/.pe'.length), created = !directories.has(path)
    directories.add(path)
    return { created, directory: directory('55') }
  })
  vi.spyOn(client, 'list').mockImplementation(async selected => selected.rootPath.endsWith('/skill-working-copies')
    ? [...records].map(([name, text]) => ({ name, type: 'file' as const, identity: '1:99', version: 'v1', size: Buffer.byteLength(text) }))
    : (entries.get(selected.rootPath.slice(0, -'/.pe/skills'.length)) ?? []).map(name => ({ name, ...facts })))
  vi.spyOn(client, 'read').mockImplementation(async (_root, name) => new TextEncoder().encode(records.get(name)))
  const writes = vi.spyOn(client, 'writeText').mockImplementation(async (_root, name, text) => {
    records.set(name, text); return { operation: 'update', version: 'v1', before: 'v0', after: 'v1' }
  })
  const version: SkillVersion = { binding, id: brandString<SkillVersion['id']>('11111111-1111-4111-8111-111111111111'),
    skillSha256: '1'.repeat(64), resourceSha256: '2'.repeat(64), skillBytes: 1, resourceBytes: 1 }
  const projection = vi.spyOn(client, 'projectSkillVersion').mockImplementation(async (request) => {
    entries.set(request.root.rootPath, [version.id])
    return { outcome: 'projected', closed: true, errno: 0, reused: request.expectedCopyInode !== '0', copies: 1,
      metadataDirectory: directory('19'), skillsDirectory: directory('55'), copyDirectory: directory('56') }
  })
  const afterMutation = vi.fn(async () => {})
  const port = createSkillProjectWork({ binding,
    privateRoot: { rootPath: '/private', rootDevice: '1', rootInode: '2', rootMountId: '11' }, uid: 2000, gid: 2000,
    quota: { ...root('/projects'), rootInode: '2', minimumBytes: '1048576', maximumBytes: '1048576',
      minimumInodes: '128', maximumInodes: '128', backing: { path: '/backing', device: '3', inode: '4', bytes: '1048576' } },
    limits: { maxProjects: 2, maxCopiesPerProject: 2, maxCopiesPerOperation: 2, maxParentBorrows: 2,
      maxOperationBorrows: 2, maxRecordBytes: 8192, maxMetadataBytes: 65536, maxMetadataInodes: 4, reservationBytes: 1048576 },
    sourceLimits: { maxVersions: 4, maxFileBytes: 1024, maxTotalBytes: 8192, maxTotalInodes: 15, reservationBytes: 1048576 },
    maxReadBytes: 8192, maxPathBytes: 256, maxReplyBytes: 32768, assertCurrent() {},
    project: async (_client, selected) => root(selected.path), resolveSource: () => version,
    source: async () => ({ skill: Uint8Array.of(1), resource: Uint8Array.of(2) }),
    mutate: async (work, control) => { const value = await work(client, control); await afterMutation(); return { value, release() {} } },
  })
  return { port, workspace, records, recordName, directories, entries, writes, native, projection, version, afterMutation }
}

it.each([false, true])('executes in a third Workspace with two charged records, including retained copies=%s', async (copies) => {
  const f = await fixture()
  for (const id of ['one', 'two']) {
    const parent = await f.port.prepareProject(f.workspace(id), () => {}, signal())
    if (copies) (await f.port.materialize(parent.value, f.version, signal())).release()
    parent.release()
  }
  expect(f.records.size).toBe(2)
  const before = f.writes.mock.calls.length
  for (const id of ['three', 'four', 'three', 'one']) {
    const parent = await f.port.prepareProject(f.workspace(id), () => {}, signal())
    const operation = await f.port.borrowAll(parent.value, signal())
    expect(operation.value.copies).toHaveLength(id === 'one' && copies ? 1 : 0)
    f.port.assertBorrow(operation.value)
    operation.release(); parent.release()
    expect(() => { f.port.assertProject(parent.value) }).toThrow()
  }
  expect(f.records.size).toBe(2); expect(f.writes).toHaveBeenCalledTimes(before)
  const third = await f.port.prepareProject(f.workspace('three'), () => {}, signal())
  await expect(f.port.materialize(third.value, f.version, signal())).rejects.toMatchObject({ outcome: 'not-published',
    code: 'FS_TOO_LARGE', cause: { code: 'cloud/capacity' } })
  third.release()
})

it('keeps live parent limits across workspaces and preserves original parents after a refusal', async () => {
  const f = await fixture(), one = await f.port.prepareProject(f.workspace('one'), () => {}, signal()),
    two = await f.port.prepareProject(f.workspace('two'), () => {}, signal())
  await expect(f.port.prepareProject(f.workspace('three'), () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_TOO_LARGE', cause: { code: 'cloud/capacity' } })
  f.port.assertProject(one.value); f.port.assertProject(two.value)
  one.release()
  const three = await f.port.prepareProject(f.workspace('three'), () => {}, signal())
  f.port.assertProject(two.value); f.port.assertProject(three.value)
  two.release(); three.release()
})

it.each([0, 2])('readopts an empty unrecorded directory with %s charged records without deleting data', async (count) => {
  const f = await fixture()
  for (let i = 0; i < count; i++) (await f.port.prepareProject(f.workspace(`prior-${i}`), () => {}, signal())).release()
  f.directories.add('/projects/unrecorded')
  const parent = await f.port.prepareProject(f.workspace('unrecorded'), () => {}, signal())
  const operation = await f.port.borrowAll(parent.value, signal())
  expect(operation.value.copies).toEqual([])
  expect(f.records.has(f.recordName('unrecorded'))).toBe(count === 0)
  expect(f.directories.has('/projects/unrecorded')).toBe(true)
  operation.release(); parent.release()
})

it('refuses nonempty unrecorded directories before publication and permits another Workspace afterwards', async () => {
  const f = await fixture(); f.directories.add('/projects/unrecorded'); f.entries.set('/projects/unrecorded', ['unexpected'])
  await expect(f.port.prepareProject(f.workspace('unrecorded'), () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_PERMISSION_DENIED', cause: { code: 'files/prerequisite-missing' } })
  expect(f.writes).not.toHaveBeenCalled()
  const next = await f.port.prepareProject(f.workspace('other'), () => {}, signal())
  f.port.assertProject(next.value); next.release()
})

it('rechecks that an unrecorded parent stays empty on every operation', async () => {
  const f = await fixture()
  for (const id of ['one', 'two']) (await f.port.prepareProject(f.workspace(id), () => {}, signal())).release()
  const parent = await f.port.prepareProject(f.workspace('three'), () => {}, signal())
  f.entries.set('/projects/three', ['unexpected'])
  await expect(f.port.borrowAll(parent.value, signal())).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_PERMISSION_DENIED' })
  expect(f.records.size).toBe(2); parent.release()
})

it('preserves native identity refusals for an empty unrecorded directory before adopting it', async () => {
  const f = await fixture(); f.directories.add('/projects/unrecorded')
  const original = f.native.getMockImplementation()!
  f.native.mockImplementation(async (...args) => {
    if (args[3] === 'parent-verify') throw new FdMutationFailure('not-published', 'FS_STALE_VERSION')
    return original(...args)
  })
  await expect(f.port.prepareProject(f.workspace('unrecorded'), () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.writes).not.toHaveBeenCalled(); expect(f.records.size).toBe(0)
})

it('preserves unknown native outcomes and pending records instead of treating them as capacity retries', async () => {
  const f = await fixture(); f.directories.add('/projects/unrecorded')
  f.native.mockRejectedValueOnce(new FdMutationFailure('unknown', 'FS_IO_ERROR'))
  await expect(f.port.prepareProject(f.workspace('unrecorded'), () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown' })
  const parent = await f.port.prepareProject(f.workspace('other'), () => {}, signal()); parent.release()
  const name = f.recordName('other'), value: object = JSON.parse(f.records.get(name)!)
  f.records.set(name, JSON.stringify({ ...value, state: 'preparing-parent', skills: null }))
  await expect(f.port.prepareProject(f.workspace('other'), () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown' })
})


it('reads full legal associations without requiring the unused write reserve, but still enforces it before a record write', async () => {
  const f = await fixture()
  for (const id of ['one', 'two']) (await f.port.prepareProject(f.workspace(id), () => {}, signal())).release()
  const original = f.native.getMockImplementation()!
  f.native.mockImplementation(async (...args) => {
    if (args[3] === 'store-verify') throw new FdMutationFailure('not-published', 'FS_TOO_LARGE')
    return original(...args)
  })
  const third = await f.port.prepareProject(f.workspace('three'), () => {}, signal())
  const borrowed = await f.port.borrowAll(third.value, signal()); borrowed.release(); third.release()
  expect(f.records.size).toBe(2)
  const one = await f.port.prepareProject(f.workspace('one'), () => {}, signal())
  await expect(f.port.materialize(one.value, f.version, signal())).rejects.toMatchObject({ outcome: 'not-published',
    code: 'FS_TOO_LARGE', cause: { resource: 'metadata' } })
  one.release()
})

it('retains a borrowed operation after its caller releases the parent, then rejects both old capabilities after settlement', async () => {
  const f = await fixture(), parent = await f.port.prepareProject(f.workspace('one'), () => {}, signal())
  const operation = await f.port.borrowAll(parent.value, signal())
  parent.release()
  for (const id of ['two', 'three', 'four']) (await f.port.prepareProject(f.workspace(id), () => {}, signal())).release()
  f.port.assertBorrow(operation.value)
  operation.release()
  const next = await f.port.prepareProject(f.workspace('one'), () => {}, signal())
  expect(next.value).not.toBe(parent.value)
  expect(() => { f.port.assertProject(parent.value) }).toThrow()
  expect(() => { f.port.assertBorrow(operation.value) }).toThrow()
  next.release()
})

it('permits retry after complete metadata was written but concurrent parent grants filled before issuance', async () => {
  const f = await fixture(), waiting = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(() => { waiting.resolve(undefined); entered.resolve(undefined) })
  f.afterMutation.mockImplementationOnce(async () => { entered.resolve(undefined); await waiting.promise })
  const first = f.port.prepareProject(f.workspace('one'), () => {}, signal())
  const refused = expect(first).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_TOO_LARGE',
    cause: { resource: 'parent-borrows' } })
  await entered.promise
  const second = await f.port.prepareProject(f.workspace('two'), () => {}, signal())
  const third = await f.port.prepareProject(f.workspace('three'), () => {}, signal())
  waiting.resolve(undefined); await refused
  expect(JSON.parse(f.records.get(f.recordName('one'))!)).toMatchObject({ state: 'complete', copies: [] })
  second.release(); third.release()
  const writes = f.writes.mock.calls.length
  const retry = await f.port.prepareProject(f.workspace('one'), () => {}, signal())
  expect(f.writes).toHaveBeenCalledTimes(writes); f.port.assertProject(retry.value); retry.release()
})
