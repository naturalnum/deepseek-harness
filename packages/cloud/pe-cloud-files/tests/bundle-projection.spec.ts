/** Full-tree cold-record checks on the original projection executor; native facts are scripted. */
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { SkillBundleVersion } from '../src/skill-bundles.ts'
import { describeBundle } from '../src/bundle-codec.ts'
import { createSkillProjectWork } from '../src/skill-project-work.ts'
import { FdWorkerClient } from '../src/worker-client.ts'
import { FilesWorkQueue } from '../src/work-queue.ts'
import { skillProjectionParentBytes } from '../src/skill-projection.ts'
import { limits, projectionLimits } from './fixtures/bundle-limits.ts'

async function fixture(authorizeActive = false, revalidate = true, queuedParents = false) {
  const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url)), client = new FdWorkerClient(worker)
  onTestFinished(async () => { await client.close(); await client.exited; await worker.terminate() }); await client.ready
  const lifetime = new AbortController(), binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('A'),
    epoch: brandString<AccountBinding['epoch']>('2'), recipeVersion: 'recipe', lifetime: lifetime.signal }
  const unavailable = async (): Promise<never> => { throw new Error('This fixture does not mutate a Workspace') }
  const workspace: Workspace = { id: brandString<Workspace['id']>('workspace'), path: '/projects/p', title: 'p', createdAt: '',
    updatedAt: '', sessionIds: [], setTitle: unavailable, attachSession: unavailable, insertSessionBefore: unavailable,
    detachSession: unavailable, status: async () => 'ok' }
  const root = { rootPath: workspace.path, rootDevice: '2', rootInode: '15', rootMountId: '22' }
  const tree = { directories: ['nested'], files: [{ relativePath: 'SKILL.md', data: new TextEncoder().encode('Read nested/a.bin') },
      { relativePath: 'nested/a.bin', data: Uint8Array.of(0, 255) }] }, manifest = describeBundle(tree)
  const version: SkillBundleVersion = { binding, id: brandString<SkillBundleVersion['id']>('11111111-1111-4111-8111-111111111111'),
    format: 'bundle-tree-v1', files: manifest.files, directories: manifest.directories, treeSha256: manifest.treeSha256,
    contentBytes: manifest.contentBytes, directoryCount: 1,
    chargedBytes: manifest.contentBytes + Buffer.byteLength(JSON.stringify(manifest)),
    chargedInodes: 6 }
  const directory = (inode: string, mountId = '21') => ({ device: '2', inode, mountId, uid: 2000, gid: 2000, mode: 0o40700 })
  const context = { bootId: '11111111-1111-4111-8111-111111111111', mountNamespace: 'mnt:[123]' }
  const { binding: _binding, ...source } = version
  const record = { schema: 2, accountId: binding.accountId, workspaceId: workspace.id, project: { ...root, rootMountId: '21' },
    sourceContext: context, metadata: directory('19'), skills: directory('55'), state: 'complete', pending: null,
    copies: [{ source, directory: directory('56') }] }
  const name = `project-${createHash('sha256').update(workspace.id).digest('hex')}.json`
  let bytes = new TextEncoder().encode(JSON.stringify(record)), revision = '1:2:3:4:5'
  const hash = createHash('sha256').update(bytes).digest('hex')
  vi.spyOn(client, 'skillSourceContext').mockResolvedValue(context)
  vi.spyOn(client, 'lstat').mockImplementation(async (_root, path) => path === name
    ? { type: 'file', identity: '1:99', version: revision, size: bytes.byteLength }
    : { type: 'directory', identity: '2:55', version: 'directory' })
  vi.spyOn(client, 'skillDirectory').mockImplementation(async (_root, _uid, _gid, purpose) => ({ created: false,
    directory: purpose === 'parent-verify' ? directory('55', '22') : { ...directory('99', '11'), device: '1' } }))
  vi.spyOn(client, 'list').mockImplementation(async selected => selected.rootPath.endsWith('skill-working-copies')
    ? [{ name, type: 'file', identity: '1:99', version: revision, size: bytes.byteLength }]
    : [{ name: version.id, type: 'directory', identity: '2:56', version: 'copy' }])
  vi.spyOn(client, 'read').mockImplementation(async () => bytes.slice())
  const native = vi.spyOn(client, 'bundle').mockResolvedValue({ outcome: 'complete', closed: true, reused: true, errno: 0,
    versions: 1, chargedBytes: manifest.contentBytes, chargedInodes: 5, removed: 0, directory: directory('56', '22') })
  const legacy = vi.spyOn(client, 'projectSkillVersion').mockImplementation(async () => { throw new Error('Full trees cannot use DSP1') })
  const writes = vi.spyOn(client, 'writeText').mockImplementation(async (_r, _name, value) => {
    bytes = new TextEncoder().encode(value); const before = revision; revision = '1:2:3:4:6'
    return { operation: 'update', version: revision, before, after: revision }
  })
  const authorize = vi.fn(async () => { if (!authorizeActive) throw new Error('An uninstalled source cannot authorize a new load') })
  const confirm = vi.fn(), sourceRead = vi.fn(async () => tree)
  const queue = new FilesWorkQueue({ maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: 4 * limits.reservationBytes, maxResidentBytesPerLane: 4 * limits.reservationBytes, waitTimeoutMs: 10000 })
  const lane = queue.openLane(), results = new Set<() => void>()
  onTestFinished(async () => { for (const release of results) release(); queue.close(); await queue.whenClosed() })
  const port = createSkillProjectWork({ binding, privateRoot: { rootPath: '/private', rootDevice: '1', rootInode: '2', rootMountId: '11' },
    uid: 2000, gid: 2000, quota: { ...root, rootPath: '/projects', rootInode: '2', minimumBytes: '1048576', maximumBytes: '1048576',
      minimumInodes: '128', maximumInodes: '128', backing: { path: '/backing', device: '3', inode: '4', bytes: '1048576' } },
    limits: { ...projectionLimits, ...queuedParents ? { maxParentBorrows: 3 } : {} },
    sourceLimits: { maxVersions: 8, maxFileBytes: 4096, maxTotalBytes: 1048576, maxTotalInodes: 128,
      reservationBytes: limits.reservationBytes }, bundleLimits: limits, maxReadBytes: 65536, maxPathBytes: 4096, maxReplyBytes: 65536,
    assertCurrent: () => { lifetime.signal.throwIfAborted() }, project: async () => root,
    resolveSource: () => undefined, source: async () => { throw new Error('Full trees cannot use the two-file reader') },
    resolveBundle: (supplied) => { expect(supplied.treeSha256).toBe(version.treeSha256); return version },
    bundleSource: sourceRead, bundleAuthorize: authorize,
    ...revalidate ? { revalidation: [{ workspaceId: workspace.id, recordSha256: hash, recordRevision: '1:2:3:4:5', pending: true,
      assertRecord: (supplied: string) => { expect(supplied).toBe('1:2:3:4:5') }, confirmRecord: confirm }] } : {},
    mutate: async (work, signal, retention) => {
      if (!queuedParents) return { value: await work(client, signal), release() {} }
      const held = await lane.run(limits.reservationBytes, control => work(client, control), signal,
        retention === 'parent' ? { kind: 'lease', retainedBytes: skillProjectionParentBytes(4096) } : undefined)
      const release = (): void => { results.delete(release); held.release() }
      results.add(release)
      return { value: held.value, release }
    },
  })
  return { port, workspace, native, legacy, writes, authorize, confirm, sourceRead, tree, version, queue,
    corrupt: () => { bytes = new TextEncoder().encode(JSON.stringify({ ...record, copies: [{ ...record.copies[0],
      source: { ...source, directories: [] } }] })) } }
}

it('materializes a complete skill with two live Session parents and preserves independent copy/output and parent limits', async () => {
  const f = await fixture(true, true, true), signal = new AbortController().signal
  const one = await f.port.prepareProject(f.workspace, () => {}, signal)
  const two = await f.port.prepareProject(f.workspace, () => {}, signal)
  expect(one.value).toBe(two.value)
  expect(f.queue.inspect()).toMatchObject({ residentBytes: 2 * skillProjectionParentBytes(4096), pending: 2 })
  const skill = await f.port.prepareProject(f.workspace, () => {}, signal)
  await expect(f.port.prepareProject(f.workspace, () => {}, signal)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  const copy = await f.port.materializeBundle(skill.value, f.version, signal)
  const operation = await f.port.borrowBundles(skill.value, [copy.value], signal)
  f.port.assertBundleBorrow(operation.value)
  expect(operation.value.copies[0]?.version).toBe(f.version)
  expect(f.queue.inspect()).toMatchObject({ residentBytes: 3 * skillProjectionParentBytes(4096) + 2 * limits.reservationBytes,
    pending: 5 })
  operation.release(); copy.release(); skill.release()
  expect(f.queue.inspect()).toMatchObject({ residentBytes: 2 * skillProjectionParentBytes(4096), pending: 2 })
  // A further Session can prepare while the original two still retain their exact project grants.
  const three = await f.port.prepareProject(f.workspace, () => {}, signal)
  f.port.assertProject(one.value); f.port.assertProject(two.value); f.port.assertProject(three.value)
  three.release(); one.release(); two.release()
  expect(f.queue.inspect()).toMatchObject({ residentBytes: 0, pending: 0 })
})

it('revalidates every nested byte with the full-tree helper before original cold CAS and operation issuance', async () => {
  const f = await fixture(), parent = await f.port.prepareProject(f.workspace, () => {}, new AbortController().signal)
  const borrowed = await f.port.borrowBundles(parent.value, undefined, new AbortController().signal)
  f.port.assertBundleBorrow(borrowed.value)
  expect(borrowed.value.copies[0]?.version).toBe(f.version)
  expect(f.native).toHaveBeenCalledTimes(2)
  for (const [request] of f.native.mock.calls) expect(request).toMatchObject({ kind: 'bundle-project', tree: f.tree,
    expectedCopyInode: '56', metadata: { mountId: '22' } })
  expect(f.legacy).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled()
  expect(f.writes).toHaveBeenCalledTimes(1); expect(f.confirm).toHaveBeenCalledTimes(1)
  borrowed.release(); expect(() =>{  f.port.assertBundleBorrow(borrowed.value) }).toThrow(); parent.release()
})

it('rejects an incomplete persisted tree before source/native checks or any cold-record rewrite', async () => {
  const f = await fixture(); f.corrupt()
  await expect(f.port.prepareProject(f.workspace, () => {}, new AbortController().signal)).rejects.toThrow()
  expect(f.native).not.toHaveBeenCalled(); expect(f.sourceRead).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('rejects a retained full-tree workspace in a new mount without a Root proof before materializing any version', async () => {
  const f = await fixture(true, false)
  await expect(f.port.prepareProject(f.workspace, () => {}, new AbortController().signal))
    .rejects.toMatchObject({ outcome: 'not-published', code: 'FS_STALE_VERSION' })
  expect(f.native).not.toHaveBeenCalled()
  expect(f.sourceRead).not.toHaveBeenCalled()
  expect(f.authorize).not.toHaveBeenCalled()
  expect(f.writes).not.toHaveBeenCalled()
  expect(f.confirm).not.toHaveBeenCalled()
})

it('canonicalizes an authorized source lease before issuing and borrowing an existing copy', async () => {
  const f = await fixture(true), signal = new AbortController().signal
  const parent = await f.port.prepareProject(f.workspace, () => {}, signal)
  const lease = Object.freeze({ ...f.version })
  expect(lease).not.toBe(f.version)
  const copy = await f.port.materializeBundle(parent.value, lease, signal)
  expect(f.authorize).toHaveBeenCalledExactlyOnceWith(expect.anything(), lease, expect.any(AbortSignal))
  expect(copy.value.version).toBe(f.version)
  const operation = await f.port.borrowBundles(parent.value, [copy.value], signal)
  expect(operation.value.copies[0]).toBe(copy.value)
  operation.release(); copy.release(); parent.release()
})
