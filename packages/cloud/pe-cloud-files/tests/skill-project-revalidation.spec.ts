/** Original projection executor with scripted worker facts; no real Linux authority or production retirement is asserted. */
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { FdMutationFailure, FdWorkerClient } from '../src/worker-client.ts'
import { createSkillProjectWork, type SkillProjectWork } from '../src/skill-project-work.ts'
import type { SkillVersion } from '../src/skill-versions.ts'

const signal = () => new AbortController().signal
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fixture(authorize = true, sameMount = false) {
  const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url)), client = new FdWorkerClient(worker)
  onTestFinished(async () => { await client.close(); await client.exited; await worker.terminate() })
  await client.ready
  const lifetime = new AbortController(), binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('account'),
    epoch: brandString<AccountBinding['epoch']>('2'), recipeVersion: 'recipe', lifetime: lifetime.signal }
  const unavailable = async (): Promise<never> => { throw new Error('No Workspace mutation belongs to this fixture') }
  const workspace: Workspace = { id: brandString<Workspace['id']>('workspace'), path: '/projects/project', title: 'fixture',
    createdAt: '', updatedAt: '', sessionIds: [], setTitle: unavailable, attachSession: unavailable,
    insertSessionBefore: unavailable, detachSession: unavailable, status: async () => 'ok' }
  const root = { rootPath: workspace.path, rootDevice: '1795', rootInode: '15', rootMountId: '1544' }
  const directory = (inode: string, mountId = sameMount ? '1544' : '1448') => ({ device: '1795', inode, mountId,
    uid: 2000, gid: 2000, mode: 0o40700 })
  const skill = new TextEncoder().encode('Original source'), resource = Uint8Array.from([0, 255, 1])
  const version: SkillVersion = { binding, id: brandString<SkillVersion['id']>('11111111-1111-4111-8111-111111111111'),
    skillSha256: sha(skill), resourceSha256: sha(resource), skillBytes: skill.byteLength, resourceBytes: resource.byteLength }
  const source = { id: version.id, skillSha256: version.skillSha256, resourceSha256: version.resourceSha256,
    skillBytes: version.skillBytes, resourceBytes: version.resourceBytes }
  const context = { bootId: '11111111-1111-4111-8111-111111111111', mountNamespace: 'mnt:[123]' }
  const original = { schema: 1, accountId: binding.accountId, workspaceId: workspace.id,
    project: { ...root, rootMountId: sameMount ? '1544' : '1448' }, sourceContext: context, metadata: directory('19'), skills: directory('55'),
    state: 'complete', pending: null, copies: [{ source, directory: directory('56') }] }
  let bytes = encode(original), revision = '1:2:3:4:5'
  const oldHash = sha(bytes), recordName = 'project-' + createHash('sha256').update(workspace.id).digest('hex') + '.json'
  vi.spyOn(client, 'skillSourceContext').mockResolvedValue(context)
  vi.spyOn(client, 'lstat').mockImplementation(async (_root, name) => name === recordName
    ? { type: 'file', identity: '1794:99', version: revision, size: bytes.byteLength }
    : { type: 'directory', identity: '1795:55', version: 'directory' })
  vi.spyOn(client, 'skillDirectory').mockImplementation(async (_root, _uid, _gid, purpose) => ({
    directory: directory(purpose === 'parent-verify' ? '55' : '99', purpose === 'parent-verify' ? '1544' : '1536'), created: false }))
  vi.spyOn(client, 'list').mockImplementation(async selected => selected.rootPath.endsWith('skill-working-copies')
    ? [{ name: recordName, type: 'file', identity: '1794:99', version: revision, size: bytes.byteLength }]
    : [{ name: version.id, type: 'directory', identity: '1795:56', version: 'copy' }])
  vi.spyOn(client, 'read').mockImplementation(async () => bytes.slice())
  const projection = vi.spyOn(client, 'projectSkillVersion').mockImplementation(async request => ({ outcome: 'projected', closed: true,
    errno: 0, reused: true, copies: 1, metadataDirectory: request.metadata, skillsDirectory: directory('55', '1544'), copyDirectory: directory('56', '1544') }))
  const write = vi.spyOn(client, 'writeText').mockImplementation(async (_root, _name, text) => {
    bytes = new TextEncoder().encode(text); revision = '1:2:3:4:6'
    return { operation: 'update', version: revision, before: '1:2:3:4:5', after: revision }
  })
  let committedRevision: string | undefined
  const assertRecord = vi.fn((actual: string) => {
    expect(committedRevision).toBeUndefined(); expect(actual).toBe('1:2:3:4:5'); lifetime.signal.throwIfAborted()
  })
  const confirmRecord = vi.fn((previous: string, committed: string) => {
    expect(previous).toBe('1:2:3:4:5'); expect(committed).toBe('1:2:3:4:6'); committedRevision = committed
  })
  const sourceRead = vi.fn(async () => ({ skill: skill.slice(), resource: resource.slice() }))
  const input: SkillProjectWork = { binding, privateRoot: { rootPath: '/private', rootDevice: '1794', rootInode: '2', rootMountId: '1536' },
    uid: 2000, gid: 2000, quota: { ...root, rootPath: '/projects', rootInode: '2', minimumBytes: '8192', maximumBytes: '8192',
      minimumInodes: '100', maximumInodes: '100', backing: { path: '/backing', device: '1', inode: '2', bytes: '8192' } },
    limits: { maxProjects: 2, maxCopiesPerProject: 2, maxCopiesPerOperation: 2, maxParentBorrows: 2,
      maxOperationBorrows: 2, maxRecordBytes: 8192, maxMetadataBytes: 65536, maxMetadataInodes: 4, reservationBytes: 1048576 },
    sourceLimits: { maxVersions: 4, maxFileBytes: 1024, maxTotalBytes: 8192, maxTotalInodes: 15, reservationBytes: 1048576 },
    maxReadBytes: 8192, maxPathBytes: 256, maxReplyBytes: 32768,
    assertCurrent: () => { lifetime.signal.throwIfAborted() }, project: async () => root,
    source: sourceRead, resolveSource: supplied => supplied.id === version.id ? version : undefined,
    mutate: async (work, observer) => ({ value: await work(client, observer), release() {} }),
    ...authorize ? { revalidation: { workspaceId: workspace.id, recordSha256: oldHash,
      get pending() { return committedRevision === undefined }, assertRecord, confirmRecord } } : {},
  }
  return { client, port: createSkillProjectWork(input), input, workspace, binding, lifetime, original, projection, write,
    sourceRead, assertRecord, confirmRecord, bytes: () => bytes, setRecord: (value: unknown) => { bytes = encode(value) } }
}
it('reopens existing identities with the current mount, reuses the edited copy and commits one original native CAS before issuing grants', async () => {
  const f = await fixture(), held = await f.port.prepareProject(f.workspace, () => {}, signal())
  expect(f.projection).toHaveBeenCalledTimes(1)
  expect(f.projection.mock.calls[0]?.[0]).toMatchObject({ root: { rootMountId: '1544' }, metadata: { inode: '19', mountId: '1544' }, expectedCopyInode: '56' })
  expect(f.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rootPath: '/private/skill-working-copies' }),
    expect.any(String), expect.any(String), { kind: 'replaceIfVersion', version: '1:2:3:4:5' }, 8192, expect.any(AbortSignal))
  const saved: unknown = JSON.parse(new TextDecoder().decode(f.bytes()))
  expect(saved).toMatchObject({ project: { rootMountId: '1544' }, copies: [{ directory: { inode: '56', mountId: '1544' } }] })
  expect(held.value.binding).toBe(f.binding)
  const borrowed = await f.port.borrowAll(held.value, signal())
  expect(borrowed.value.copies[0]?.binding).toBe(f.binding)
  expect(f.write).toHaveBeenCalledTimes(1)
  borrowed.release(); held.release(); f.lifetime.abort()
  expect(() => { f.port.assertProject(held.value) }).toThrow()
})
it('keeps the original stale rejection without Root authority or after the bound record changes', async () => {
  const f = await fixture(false)
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.write).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled()
  const changed = await fixture(); changed.setRecord({ ...changed.original, sourceContext: { ...changed.original.sourceContext, mountNamespace: 'mnt:[124]' } })
  await expect(changed.port.prepareProject(changed.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(changed.write).not.toHaveBeenCalled()
})
it('refuses pending associations and an actual copy identity mismatch before CAS', async () => {
  const f = await fixture(); f.setRecord({ ...f.original, state: 'preparing-copy', pending: f.original.copies[0]!.source })
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.write).not.toHaveBeenCalled()
  const wrong = await fixture(); wrong.projection.mockResolvedValue({ outcome: 'projected', closed: true, errno: 0,
    reused: true, copies: 1, metadataDirectory: { ...wrong.original.metadata, mountId: '1544' },
    skillsDirectory: { ...wrong.original.skills, mountId: '1544' }, copyDirectory: { ...wrong.original.copies[0]!.directory, inode: '57', mountId: '1544' } })
  await expect(wrong.port.prepareProject(wrong.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown' })
  expect(wrong.write).not.toHaveBeenCalled()
})
it('retains an unknown CAS and never issues a parent or replays publication', async () => {
  const f = await fixture(); f.write.mockRejectedValueOnce(new FdMutationFailure('unknown', 'FS_IO_ERROR'))
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.bytes()).toEqual(encode(f.original))
  expect(f.confirmRecord).not.toHaveBeenCalled()
  expect(f.input.revalidation?.pending).toBe(true)
})
it('allows the next original epoch after a numeric-identical revalidation CAS changes only the native revision', async () => {
  const f = await fixture(true, true), first = await f.port.prepareProject(f.workspace, () => {}, signal())
  expect(f.bytes()).toEqual(encode(f.original))
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.confirmRecord).toHaveBeenCalledExactlyOnceWith('1:2:3:4:5', '1:2:3:4:6')
  expect(f.input.revalidation?.pending).toBe(false)
  first.release()
  const binding = { ...f.binding, epoch: brandString<AccountBinding['epoch']>('3'), lifetime: signal() }
  const next = createSkillProjectWork({ ...f.input, binding })
  await expect(next.prepareProject(f.workspace, () => {}, signal())).resolves.toBeDefined()
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(() => { next.assertProject(first.value) }).toThrow()
  const changedMount = createSkillProjectWork({ ...f.input, binding,
    project: async () => ({ ...first.value.project, rootMountId: '1545' }) })
  await expect(changedMount.prepareProject(f.workspace, () => {}, signal())).rejects.toThrow()
  expect(f.write).toHaveBeenCalledTimes(1)
})
