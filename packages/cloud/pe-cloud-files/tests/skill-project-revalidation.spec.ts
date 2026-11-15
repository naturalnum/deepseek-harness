/** Original projection executor with scripted worker facts; no real Linux authority or production retirement is asserted. */
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { FdMutationFailure, FdWorkerClient } from '../src/worker-client.ts'
import { FilesFailure } from '../src/error.ts'
import { createSkillProjectWork, skillCopyReferences, type SkillProjectWork } from '../src/skill-project-work.ts'
import * as SkillProject from '../src/skill-project-work.ts'
import { mountRootPool } from '../src/root-lifecycle.ts'
import { RootStorageOwner } from '../src/storage-owner.ts'
import type { FilesPoolConfig } from '../src/worker-pool.ts'
import type { SkillVersion } from '../src/skill-versions.ts'

const signal = () => new AbortController().signal
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fixture(authorize = true, sameMount = false, singleInstanceActive?: () => boolean) {
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
  const lstat = vi.spyOn(client, 'lstat').mockImplementation(async (_root, name) => name === recordName
    ? { type: 'file', identity: '1794:99', version: revision, size: bytes.byteLength }
    : { type: 'directory', identity: '1795:55', version: 'directory' })
  const skillDirectory = vi.spyOn(client, 'skillDirectory').mockImplementation(async (_root, _uid, _gid, purpose) => ({
    directory: directory(purpose === 'parent-verify' ? '55' : '99', purpose === 'parent-verify' ? '1544' : '1536'), created: false }))
  const list = vi.spyOn(client, 'list').mockImplementation(async selected => selected.rootPath.endsWith('skill-working-copies')
    ? [{ name: recordName, type: 'file', identity: '1794:99', version: revision, size: bytes.byteLength }]
    : [{ name: version.id, type: 'directory', identity: '1795:56', version: 'copy' }])
  const read = vi.spyOn(client, 'read').mockImplementation(async () => bytes.slice())
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
    ...authorize ? { revalidation: [{ workspaceId: workspace.id, recordSha256: oldHash, recordRevision: '1:2:3:4:5',
      get pending() { return committedRevision === undefined }, assertRecord, confirmRecord }] } : {},
    ...singleInstanceActive === undefined ? {} : { singleInstanceActive },
  }
  return { client, lstat, skillDirectory, list, read, port: createSkillProjectWork(input), input, workspace, binding, lifetime,
    original, version, projection, write,
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
it.each(['Root', 'Workspace', 'proof'] as const)(
  'rechecks %s authority after the skill store write reserve before revalidation CAS', async (authority) => {
    const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const originalDirectory = f.skillDirectory.getMockImplementation()!, originalAssert = f.assertRecord.getMockImplementation()!
    let suspended = true, revoked = false
    const stale = new FilesFailure('cloud/stale-generation', 'The original skill revalidation authority is no longer current.')
    const refusal = () => { throw stale }
    f.skillDirectory.mockImplementation(async (...args) => {
      if (args[3] === 'store-verify' && suspended) { entered.resolve(undefined); await release.promise }
      return originalDirectory(...args)
    })
    f.assertRecord.mockImplementation((revision) => {
      originalAssert(revision)
      if (authority === 'proof' && revoked) refusal()
    })
    const port = createSkillProjectWork({ ...f.input, limits: { ...f.input.limits, maxParentBorrows: 1 }, assertCurrent() {
      f.input.assertCurrent()
      if (authority === 'Root' && revoked) refusal()
    } })
    const assertRegistered = () => { if (authority === 'Workspace' && revoked) refusal() }
    const pending = port.prepareProject(f.workspace, assertRegistered, signal())
    const refused = expect(pending).rejects.toBe(stale)
    try {
      await entered.promise
      revoked = true
    } finally { suspended = false; release.resolve(undefined) }
    await refused
    expect(f.projection).toHaveBeenCalledTimes(1)
    expect(f.skillDirectory.mock.calls.map(call => call[3])).toEqual(expect.arrayContaining(['store-read', 'store-verify']))
    expect(f.write).not.toHaveBeenCalled()
    expect(f.confirmRecord).not.toHaveBeenCalled()
    expect(f.bytes()).toEqual(encode(f.original))
    expect(f.input.revalidation?.[0]?.pending).toBe(true)
    revoked = false
    const held = await port.prepareProject(f.workspace, assertRegistered, signal())
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.confirmRecord).toHaveBeenCalledExactlyOnceWith('1:2:3:4:5', '1:2:3:4:6')
    held.release()
  },
)
it('keeps the original stale rejection without Root authority or after the bound record changes', async () => {
  const f = await fixture(false)
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.write).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled()
  const changed = await fixture(); changed.setRecord({ ...changed.original, sourceContext: { ...changed.original.sourceContext, mountNamespace: 'mnt:[124]' } })
  await expect(changed.port.prepareProject(changed.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(changed.write).not.toHaveBeenCalled()
})
it('keeps another workspace cold and charged without using its old namespace identities', async () => {
  const f = await fixture(false, true)
  const sibling = { ...f.original, workspaceId: 'sibling',
    sourceContext: { bootId: '22222222-2222-4222-8222-222222222222', mountNamespace: 'mnt:[124]' },
    copies: [{ ...f.original.copies[0]!, source: { ...f.original.copies[0]!.source, id: '22222222-2222-4222-8222-222222222222' } }] }
  let siblingBytes = encode(sibling)
  const siblingName = `project-${createHash('sha256').update('sibling').digest('hex')}.json`
  const priorLstat = f.lstat.getMockImplementation()!
  const priorRead = f.read.getMockImplementation()!
  const priorList = f.list.getMockImplementation()!
  f.lstat.mockImplementation(async (...args) => args[1] === siblingName
    ? { type: 'file', identity: '1794:100', version: 'sibling-v1', size: siblingBytes.byteLength } : priorLstat(...args))
  f.read.mockImplementation(async (...args) => args[1] === siblingName ? siblingBytes.slice() : priorRead(...args))
  f.list.mockImplementation(async (...args) => {
    const entries = await priorList(...args)
    return args[0].rootPath.endsWith('skill-working-copies')
      ? [...entries, { name: siblingName, type: 'file', identity: '1794:100', version: 'sibling-v1', size: siblingBytes.byteLength }]
      : entries
  })
  const held = await f.port.prepareProject(f.workspace, () => {}, signal())
  const borrowed = await f.port.borrowAll(held.value, signal())
  const references = await skillCopyReferences(f.input, f.client, signal())
  expect(references).toEqual(new Set([f.original.copies[0]!.source.id, sibling.copies[0]!.source.id]))
  expect(f.write).not.toHaveBeenCalled()
  expect(borrowed.value.copies).toHaveLength(1)
  borrowed.release()
  const other = { ...f.workspace, id: brandString<Workspace['id']>('sibling') }
  await expect(f.port.prepareProject(other, () => {}, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  siblingBytes = encode({ ...sibling, state: 'preparing-copy', pending: sibling.copies[0]!.source })
  await expect(f.port.borrowAll(held.value, signal())).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.write).not.toHaveBeenCalled()
  held.release()
})

it('revalidates two selected Workspaces independently and leaves the other qualification pending after a refusal', async () => {
  const f = await fixture(), name = (id: string) => `project-${createHash('sha256').update(id).digest('hex')}.json`
  const firstName = name(f.workspace.id), secondName = name('sibling')
  const sibling = { ...f.original, workspaceId: 'sibling' }
  let firstBytes = f.bytes(), secondBytes = encode(sibling), firstRevision = '1:2:3:4:5', secondRevision = '2:2:3:4:5'
  const priorLstat = f.lstat.getMockImplementation()!, priorList = f.list.getMockImplementation()!
  f.lstat.mockImplementation(async (...args) => args[1] === firstName || args[1] === secondName
    ? { type: 'file', identity: '1794:99', version: args[1] === firstName ? firstRevision : secondRevision,
      size: (args[1] === firstName ? firstBytes : secondBytes).byteLength } : priorLstat(...args))
  f.read.mockImplementation(async (_root, entry) => (entry === firstName ? firstBytes : secondBytes).slice())
  f.list.mockImplementation(async (...args) => args[0].rootPath.endsWith('skill-working-copies')
    ? [firstName, secondName].map((entry, index) => ({ name: entry, type: 'file' as const, identity: `1794:${99 + index}`,
      version: index ? secondRevision : firstRevision, size: (index ? secondBytes : firstBytes).byteLength })) : priorList(...args))
  f.write.mockImplementation(async (_root, entry, text) => {
    const before = entry === firstName ? firstRevision : secondRevision
    if (entry === firstName) { firstBytes = new TextEncoder().encode(text); firstRevision = '1:2:3:4:6' }
    else { secondBytes = new TextEncoder().encode(text); secondRevision = '2:2:3:4:6' }
    return { operation: 'update', version: entry === firstName ? firstRevision : secondRevision, before,
      after: entry === firstName ? firstRevision : secondRevision }
  })
  let secondPending = true
  const second = { workspaceId: 'sibling', recordSha256: sha(secondBytes), recordRevision: '2:2:3:4:5', get pending() { return secondPending },
    assertRecord(revision: string) { expect(revision).toBe('2:2:3:4:5') },
    confirmRecord(before: string, after: string) { expect([before, after]).toEqual(['2:2:3:4:5', '2:2:3:4:6']); secondPending = false } }
  const first = f.input.revalidation?.[0]
  if (first === undefined) throw new Error('Fixture omitted first qualification')
  const other = { ...f.workspace, id: brandString<Workspace['id']>('sibling') }, signalValue = signal()
  const refused = createSkillProjectWork({ ...f.input, revalidation: [first, { ...second, recordSha256: 'f'.repeat(64) }] })
  await expect(refused.prepareProject(other, () => {}, signalValue)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(first.pending).toBe(true); expect(second.pending).toBe(true); expect(f.write).not.toHaveBeenCalled()
  const port = createSkillProjectWork({ ...f.input, revalidation: [second, first] })
  const one = await port.prepareProject(f.workspace, () => {}, signalValue)
  expect(first.pending).toBe(false); expect(second.pending).toBe(true)
  const two = await port.prepareProject(other, () => {}, signalValue)
  expect(second.pending).toBe(false); expect(f.write).toHaveBeenCalledTimes(2)
  one.release(); two.release()
})
it('prepares a new workspace while preserving another workspace cold record', async () => {
  const f = await fixture(false, true)
  const cold = { ...f.original, workspaceId: 'cold', sourceContext: {
    bootId: '22222222-2222-4222-8222-222222222222', mountNamespace: 'mnt:[124]' } }
  const bytes = encode(cold), coldName = `project-${createHash('sha256').update('cold').digest('hex')}.json`
  const directory = (inode: string, device = '1795', mountId = '1544') => ({ device, inode, mountId, uid: 2000, gid: 2000, mode: 0o40700 })
  f.lstat.mockImplementation(async (_root, name) => name === '.pe/skills' ? undefined
    : name === coldName ? { type: 'file', identity: '1794:100', version: 'cold-v1', size: bytes.byteLength }
      : { type: 'directory', identity: '1795:55', version: 'directory' })
  f.read.mockImplementation(async () => bytes.slice())
  f.list.mockImplementation(async selected => selected.rootPath.endsWith('skill-working-copies')
    ? [{ name: coldName, type: 'file', identity: '1794:100', version: 'cold-v1', size: bytes.byteLength }] : [])
  f.skillDirectory.mockImplementation(async (_root, _uid, _gid, purpose) => ({
    directory: purpose === 'store-verify' || purpose === 'store-read' ? directory('99', '1794', '1536') : directory('55'), created: purpose === 'parent-create' }))
  vi.spyOn(f.client, 'prepareProjectMetadata').mockResolvedValue({ created: true, directory: directory('19') })
  const limited = createSkillProjectWork({ ...f.input, limits: { ...f.input.limits, maxProjects: 1 } })
  const unassociated = await limited.prepareProject(f.workspace, () => {}, signal())
  const empty = await limited.borrowAll(unassociated.value, signal())
  expect(empty.value.copies).toEqual([]); empty.release(); unassociated.release()
  expect(f.write).not.toHaveBeenCalled()
  const held = await f.port.prepareProject(f.workspace, () => {}, signal())
  expect(held.value.workspaceId).toBe(f.workspace.id)
  expect(f.write).toHaveBeenCalledTimes(2)
  expect(f.write.mock.calls.every(call => call[1] !== coldName)).toBe(true)
  expect(bytes).toEqual(encode(cold))
  held.release()
})
it('rejects a selected workspace if its recorded namespace changes after its parent was issued', async () => {
  const f = await fixture(false, true), held = await f.port.prepareProject(f.workspace, () => {}, signal())
  f.setRecord({ ...f.original, sourceContext: { ...f.original.sourceContext, mountNamespace: 'mnt:[124]' } })
  await expect(f.port.borrowAll(held.value, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  await expect(f.port.materialize(held.value, f.version, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(f.write).not.toHaveBeenCalled()
  held.release()
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
  const untouched = { workspaceId: 'other', recordSha256: 'f'.repeat(64), recordRevision: '1:2:3:4:5', pending: true,
    assertRecord() { throw Error('Unrelated proof must not be used') }, confirmRecord() { throw Error('Unrelated proof must not be used') } }
  const port = createSkillProjectWork({ ...f.input, revalidation: [...(f.input.revalidation ?? []), untouched] })
  await expect(port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.bytes()).toEqual(encode(f.original))
  expect(f.confirmRecord).not.toHaveBeenCalled()
  expect(f.input.revalidation?.[0]?.pending).toBe(true)
  expect(untouched.pending).toBe(true)
})
it('allows the next original epoch after a numeric-identical revalidation CAS changes only the native revision', async () => {
  const f = await fixture(true, true), first = await f.port.prepareProject(f.workspace, () => {}, signal())
  expect(f.bytes()).toEqual(encode(f.original))
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.confirmRecord).toHaveBeenCalledExactlyOnceWith('1:2:3:4:5', '1:2:3:4:6')
  expect(f.input.revalidation?.[0]?.pending).toBe(false)
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

it('revalidates a first selected workspace without proof while single-instance exclusion is active', async () => {
  const f = await fixture(false, false, () => true)
  const currentContext = { ...f.original.sourceContext, mountNamespace: 'mnt:[124]' }
  vi.spyOn(f.client, 'skillSourceContext').mockResolvedValue(currentContext)
  const held = await f.port.prepareProject(f.workspace, () => {}, signal())
  try {
    const saved: unknown = JSON.parse(new TextDecoder().decode(f.bytes()))
    expect(saved).toMatchObject({ project: { ...f.original.project, rootMountId: '1544' }, sourceContext: currentContext,
      metadata: { inode: '19', mountId: '1544' }, skills: { inode: '55', mountId: '1544' },
      copies: [{ source: f.original.copies[0]!.source, directory: { inode: '56', mountId: '1544' } }] })
    expect(f.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rootPath: '/private/skill-working-copies' }),
      expect.any(String), expect.any(String), { kind: 'replaceIfVersion', version: '1:2:3:4:5' }, 8192, expect.any(AbortSignal))
    expect(f.projection.mock.calls[0]?.[0]).toMatchObject({ metadata: { inode: '19', mountId: '1544' }, expectedCopyInode: '56' })
    expect(held.value.binding).toBe(f.binding)
    expect(f.assertRecord).not.toHaveBeenCalled(); expect(f.confirmRecord).not.toHaveBeenCalled()
  } finally { held.release() }
})

it('revalidates a record with no skill copies after namespace and mount changes without proof while single-instance exclusion is active', async () => {
  const f = await fixture(false, false, () => true)
  const original = { ...f.original, copies: [] }
  f.setRecord(original)
  const priorList = f.list.getMockImplementation()!
  f.list.mockImplementation(async (...args) => args[0].rootPath.endsWith('skill-working-copies') ? priorList(...args) : [])
  const currentContext = { ...original.sourceContext, mountNamespace: 'mnt:[124]' }
  vi.spyOn(f.client, 'skillSourceContext').mockResolvedValue(currentContext)
  const held = await f.port.prepareProject(f.workspace, () => {}, signal())
  try {
    expect(JSON.parse(new TextDecoder().decode(f.bytes()))).toEqual({ ...original,
      project: { ...original.project, rootMountId: '1544' }, sourceContext: currentContext,
      metadata: { ...original.metadata, mountId: '1544' }, skills: { ...original.skills, mountId: '1544' } })
    expect(f.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rootPath: '/private/skill-working-copies' }),
      expect.any(String), expect.any(String), { kind: 'replaceIfVersion', version: '1:2:3:4:5' }, 8192, expect.any(AbortSignal))
    expect(held.value.binding).toBe(f.binding)
    expect(f.projection).not.toHaveBeenCalled(); expect(f.sourceRead).not.toHaveBeenCalled()
    expect(f.assertRecord).not.toHaveBeenCalled(); expect(f.confirmRecord).not.toHaveBeenCalled()
  } finally { held.release() }
})

it('revalidates a boot-only change without proof and preserves all directory identities', async () => {
  const f = await fixture(false, true, () => true)
  const currentContext = { ...f.original.sourceContext, bootId: '22222222-2222-4222-8222-222222222222' }
  vi.spyOn(f.client, 'skillSourceContext').mockResolvedValue(currentContext)
  const held = await f.port.prepareProject(f.workspace, () => {}, signal())
  try {
    expect(JSON.parse(new TextDecoder().decode(f.bytes()))).toEqual({ ...f.original, sourceContext: currentContext })
    expect(f.write).toHaveBeenCalledTimes(1)
  } finally { held.release() }
})

it.each([undefined, false] as const)('still requires proof when single-instance exclusion is %s', async (active) => {
  const f = await fixture(false, false, active === undefined ? undefined : () => active)
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.write).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled()
})

it.each(['rootDevice', 'rootInode', 'rootPath'] as const)('does not forgive a different project %s without proof', async (field) => {
  const f = await fixture(false, false, () => true)
  const port = createSkillProjectWork({ ...f.input,
    project: async () => ({ ...f.original.project, rootMountId: '1544', [field]: field === 'rootPath' ? '/projects/other' : '999' }) })
  await expect(port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.write).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled()
})

it('retains the unknown failure for an actual copy inode mismatch without proof', async () => {
  const f = await fixture(false, false, () => true)
  f.projection.mockResolvedValue({ outcome: 'projected', closed: true, errno: 0, reused: true, copies: 1,
    metadataDirectory: { ...f.original.metadata, mountId: '1544' }, skillsDirectory: { ...f.original.skills, mountId: '1544' },
    copyDirectory: { ...f.original.copies[0]!.directory, inode: '57', mountId: '1544' } })
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown', code: 'FS_IO_ERROR' })
  expect(f.write).not.toHaveBeenCalled()
})

it('does not recover an unfinished association even with single-instance exclusion', async () => {
  const f = await fixture(false, false, () => true)
  f.setRecord({ ...f.original, state: 'preparing-copy', pending: f.original.copies[0]!.source })
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ outcome: 'unknown', code: 'FS_IO_ERROR' })
  expect(f.write).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled()
})

it('does not replace a supplied proof whose bound record has changed with single-instance exclusion', async () => {
  const f = await fixture(true, false, () => true)
  f.setRecord({ ...f.original, sourceContext: { ...f.original.sourceContext, mountNamespace: 'mnt:[124]' } })
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(f.write).not.toHaveBeenCalled(); expect(f.assertRecord).not.toHaveBeenCalled()
})

it('still rejects a namespace change after issuing a parent even when single-instance exclusion is active', async () => {
  const f = await fixture(false, true, () => true), held = await f.port.prepareProject(f.workspace, () => {}, signal())
  try {
    vi.spyOn(f.client, 'skillSourceContext').mockResolvedValue({ ...f.original.sourceContext, mountNamespace: 'mnt:[124]' })
    await expect(f.port.borrowAll(held.value, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(f.port.materialize(held.value, f.version, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(f.write).not.toHaveBeenCalled()
  } finally { held.release() }
})

it('rechecks single-instance exclusion after directory verification and before the original CAS', async () => {
  let active = true
  const f = await fixture(false, false, () => active), project = f.projection.getMockImplementation()!
  f.projection.mockImplementation(async (...args) => { const facts = await project(...args); active = false; return facts })
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.projection).toHaveBeenCalledTimes(1); expect(f.write).not.toHaveBeenCalled()
})

it('rechecks single-instance exclusion after the skill store write reserve and before the revalidation CAS', async () => {
  let active = true
  const f = await fixture(false, false, () => active), directory = f.skillDirectory.getMockImplementation()!
  f.skillDirectory.mockImplementation(async (...args) => {
    const facts = await directory(...args)
    if (args[3] === 'store-verify') active = false
    return facts
  })
  await expect(f.port.prepareProject(f.workspace, () => {}, signal())).rejects.toMatchObject({
    outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.projection).toHaveBeenCalledTimes(1)
  expect(f.skillDirectory.mock.calls.some(call => call[3] === 'store-read')).toBe(true)
  expect(f.skillDirectory.mock.calls.some(call => call[3] === 'store-verify')).toBe(true)
  expect(f.write).not.toHaveBeenCalled(); expect(f.confirmRecord).not.toHaveBeenCalled()
  expect(f.bytes()).toEqual(encode(f.original))
})

it.each([undefined, false, true] as const)('passes live runtime exclusion through Root, pool and projection when initially %s', async (initial) => {
  // Actual Root/pool/issuer wiring; worker support and storage facts are scripted, not Linux or PG evidence.
  const f = await fixture(false), ctx = new Context(), workers: Worker[] = []
  let active: boolean | undefined = initial
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  // Undefined models a runtime that does not expose the optional single-instance property.
  Object.defineProperty(runtime, 'singleInstanceActive', { configurable: true, get: () => active })
  const storageStart = vi.spyOn(RootStorageOwner.prototype, 'initializeStatic').mockResolvedValue(undefined)
  const storageCurrent = vi.spyOn(RootStorageOwner.prototype, 'assertRootCurrent').mockImplementation(() => {})
  const storageIdentity = vi.spyOn(RootStorageOwner.prototype, 'skillStorageIdentity').mockReturnValue({
    uid: f.input.uid, gid: f.input.gid, projects: f.input.quota,
    privateDomain: { ...f.input.quota, ...f.input.privateRoot, minimumBytes: '1048576', maximumBytes: '1048576',
      minimumInodes: '1000', maximumInodes: '1000' } })
  const projectionSupport = vi.spyOn(FdWorkerClient.prototype, 'supportsSkillProjection', 'get').mockReturnValue(true)
  const projection = vi.spyOn(SkillProject, 'createSkillProjectWork')
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      await Promise.all(workers.map(worker => worker.terminate()))
      projection.mockRestore(); projectionSupport.mockRestore(); storageIdentity.mockRestore()
      storageCurrent.mockRestore(); storageStart.mockRestore()
    }
  })
  const MiB = 1048576
  const config: FilesPoolConfig = {
    maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: 64 * MiB, maxResidentBytesPerLane: 32 * MiB, waitTimeoutMs: 5000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 16384,
    readyTimeoutMs: 5000, drainTimeoutMs: 1000, helperPath: '/not-opened/fd-skill.node',
    maxReadBytes: 8192, maxPathBytes: 256, maxResolveRetries: 2, readChunkBytes: 128,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000 },
    skillVersions: f.input.sourceLimits, skillProjection: { ...f.input.limits, reservationBytes: 2 * MiB },
    staticStorage: { planPath: '/not-opened/plan.json', planSha256: '0'.repeat(64),
      probeHelperPath: '/not-opened/probe.node', probeHelperSha256: '0'.repeat(64), maxProbeAssetBytes: 65536,
      rootProbeReservationBytes: 2 * MiB, maxPlanBytes: 4096, maxMountInfoBytes: 16384, probeTimeoutMs: 1000 },
  }
  await mountRootPool(ctx, config, () => {
    const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url))
    workers.push(worker); return worker
  })
  const pool = ctx.get('peFilesPool'), privateRoot = f.input.privateRoot
  if (pool === undefined || privateRoot.rootMountId === undefined) throw new Error('Missing mounted fixture pool or private identity')
  pool.bind(f.binding, f.input.quota, () => {}, { ...privateRoot, rootMountId: privateRoot.rootMountId }).skillProjection()
  expect(projection).toHaveBeenCalledTimes(1)
  const readActive = projection.mock.calls[0]?.[0].singleInstanceActive
  expect(readActive).toBeTypeOf('function')
  if (readActive === undefined) throw new Error('Root-to-projection single-instance callback is absent')
  expect(readActive()).toBe(initial === true)
  active = false; expect(readActive()).toBe(false)
  active = true; expect(readActive()).toBe(true)
  active = false; expect(readActive()).toBe(false)
  active = undefined; expect(readActive()).toBe(false)
})
