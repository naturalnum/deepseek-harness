/** Stateful original-lane executor tests. Worker/native facts are scripted; this is not Linux execution evidence. */
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { posix } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { FilesWorkQueue } from '../src/work-queue.ts'
import { FdWorkerClient, FdMutationFailure, InvalidSkillBundleFailure } from '../src/worker-client.ts'
import { createSkillVersionWork, observeSkillCurrent } from '../src/skill-version-work.ts'
import { createSkillProjectWork } from '../src/skill-project-work.ts'
import type { SkillVersionWork } from '../src/skill-version-work.ts'
import type { SkillBundleSource, SkillBundleVersion } from '../src/skill-bundles.ts'
import type { BundleTree } from '../src/bundle-codec.ts'
import type { FdRootIdentity } from '../src/worker-protocol.ts'
import type { ResidentResult } from '../src/work-queue.ts'
import { limits, projectionLimits } from './fixtures/bundle-limits.ts'

type Node = { type: 'directory'; inode: string; version: string } | {
  type: 'file'
  inode: string
  version: string
  data: Uint8Array<ArrayBuffer>
}
const signal = (): AbortSignal => new AbortController().signal
const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const input = (name: string) => ({ kind: 'files' as const, files: [
  { relativePath: 'SKILL.md', dataBase64: Buffer.from(`---\nname: ${name}\n---\nRead nested/value.bin`).toString('base64') },
  { relativePath: 'nested/value.bin', dataBase64: Buffer.from([0, 255, name.length]).toString('base64') },
] })

async function fixture(queueWaitMs?: number) {
  const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url)), client = new FdWorkerClient(worker)
  onTestFinished(async () => { await client.close(); await client.exited; await worker.terminate() })
  await client.ready
  const lifetime = new AbortController(), binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('A'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'recipe', lifetime: lifetime.signal }
  const root: FdRootIdentity = { rootPath: '/private', rootDevice: '1', rootInode: '1', rootMountId: '11' }
  const nodes = new Map<string, Node>(); let inode = 1, revision = 1, residents = 0
  const mkdir = (path: string): void => {
    if (!nodes.has(path)) nodes.set(path, { type: 'directory', inode: String(++inode), version: 'directory' })
  }
  mkdir('/private')
  const put = (path: string, bytes: Uint8Array<ArrayBuffer>): void => {
    nodes.set(path, { type: 'file', inode: String(++inode), version: `1:${++revision}`, data: bytes.slice() })
  }
  const path = (r: FdRootIdentity, name: string): string => posix.join(r.rootPath, name)
  vi.spyOn(client, 'lstat').mockImplementation(async (r, name) => {
    const node = nodes.get(path(r, name))
    return node === undefined ? undefined : { type: node.type, identity: `1:${node.inode}`, version: node.version,
      ...node.type === 'file' ? { size: node.data.byteLength } : {} }
  })
  vi.spyOn(client, 'read').mockImplementation(async (r, name, maximum) => {
    const node = nodes.get(path(r, name))
    if (node?.type !== 'file' || node.data.byteLength > maximum) throw new FdMutationFailure('not-published', 'FS_IO_ERROR')
    return node.data.slice()
  })
  const list = vi.spyOn(client, 'list').mockImplementation(async (r, name, maximum) => {
    const directory = path(r, name), entries = [...nodes].filter(([key]) => key !== directory && posix.dirname(key) === directory)
    if (entries.length > maximum) throw new FdMutationFailure('not-published', 'FS_TOO_LARGE')
    return entries.map(([key, node]) => ({ name: posix.basename(key), type: node.type, identity: `1:${node.inode}`,
      version: node.version, ...node.type === 'file' ? { size: node.data.byteLength } : {} }))
  })
  const writes = vi.spyOn(client, 'writeText').mockImplementation(async (r, name, value, intent) => {
    const key = path(r, name), before = nodes.get(key)
    if (intent?.kind === 'createIfAbsent' ? before !== undefined : intent?.kind === 'replaceIfVersion' && before?.version !== intent.version) {
      throw new FdMutationFailure('not-published', 'FS_STALE_VERSION')
    }
    put(key, text(value)); const after = nodes.get(key)
    if (after === undefined) throw new Error('Fixture lost its own write')
    return { operation: before === undefined ? 'create' : 'update', version: after.version, before: before?.version ?? null, after: after.version }
  })
  const skillDirectory = vi.spyOn(client, 'skillDirectory').mockImplementation(async (r, _uid, _gid, purpose) => {
    if (purpose !== 'store-verify') throw new Error('This executor fixture never creates a real projection')
    const node = nodes.get(path(r, 'skill-working-copies'))
    if (node?.type !== 'directory') throw new Error('Fixture omitted its store')
    return { created: false, directory: { device: '1', inode: node.inode, mountId: '11', uid: 2000, gid: 2000, mode: 0o40700 } }
  })
  const native = vi.spyOn(client, 'bundle').mockImplementation(async (request) => {
    let removed = 0
    if (request.kind === 'bundle-prepare') {
      mkdir('/private/skills'); mkdir(`/private/skills/${request.version}`)
      for (const name of request.tree.directories) mkdir(`/private/skills/${request.version}/${name}`)
      for (const f of request.tree.files) put(`/private/skills/${request.version}/${f.relativePath}`, f.data)
    } else if (request.kind === 'bundle-reclaim') {
      const keep = new Set<string>(request.retained)
      for (const [name, node] of [...nodes]) {
        if (node.type !== 'directory' || posix.dirname(name) !== '/private/skills' || keep.has(posix.basename(name))) continue
        for (const key of [...nodes.keys()]) if (key === name || key.startsWith(`${name}/`)) nodes.delete(key)
        removed++
      }
    } else throw new Error('Projection is tested separately')
    const rows = [...nodes].filter(([key]) => key.startsWith('/private/skills/'))
    const versions = rows.filter(([key, value]) => value.type === 'directory' && posix.dirname(key) === '/private/skills').length
    return { outcome: 'complete', closed: true, reused: false, errno: 0, versions,
      chargedBytes: 2 * limits.maxCatalogBytes + rows.reduce((sum, [, node]) => sum + (node.type === 'file' ? node.data.byteLength : 0), 0),
      chargedInodes: 3 + rows.length, removed, directory: { device: '1', inode: '999', mountId: '11', uid: 2000, gid: 2000, mode: 0o40500 } }
  })
  const queue = queueWaitMs === undefined ? undefined : new FilesWorkQueue({ maxLanes: 1, maxRunning: 1,
    maxRunningPerLane: 1, maxQueued: 4, maxQueuedPerLane: 4, maxResidentBytes: limits.reservationBytes * 8,
    maxResidentBytesPerLane: limits.reservationBytes * 8, waitTimeoutMs: queueWaitMs })
  const lane = queue?.openLane()
  onTestFinished(async () => { queue?.close(); await queue?.whenClosed() })
  let afterActual: (() => void) | undefined
  let tail: Promise<void> = Promise.resolve()
  const run = <T>(callback: (client: FdWorkerClient, signal: AbortSignal) => Promise<T>,
    control: AbortSignal): Promise<ResidentResult<T>> => {
    if (lane !== undefined) return lane.run(limits.reservationBytes, async (actual) => {
      const value = await callback(client, actual)
      const notify = afterActual; afterActual = undefined; notify?.()
      return value
    }, control)
    const result = tail.then(async () => { control.throwIfAborted(); return callback(client, control) })
    tail = result.then(() => {}, () => {})
    return result.then((value) => {
      residents++; let released = false
      return { value, release: () => { if (!released) { released = true; residents-- } } }
    })
  }
  let authorize: ((client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => Promise<void>) | undefined
  let readBundle: ((client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => Promise<BundleTree>) | undefined
  let resolveBundle: ((version: Omit<SkillBundleVersion, 'binding'>) => SkillBundleVersion) | undefined
  const work: SkillVersionWork = { binding, root, uid: 2000, gid: 2000, maxReadBytes: 65536,
    limits: { maxVersions: 8, maxTotalBytes: 1048576, maxTotalInodes: 256, maxFileBytes: 4096, reservationBytes: limits.reservationBytes },
    assertCurrent: () => { lifetime.signal.throwIfAborted() }, mutate: (_kind, callback, control) => run(callback, control), read: run,
    bundles: { limits, reclaim: { projectionLimits, maxPathBytes: 4096, maxReplyBytes: 65536 },
      bind: (read, resolve, check) => { readBundle = read; resolveBundle = resolve; authorize = check },
      materialize: async () => { throw new Error('No real project exists') } },
  }
  const port = createSkillVersionWork(work), bundles = port.bundles
  if (bundles === undefined) throw new Error('Fixture did not attach bundle capability')
  const observe = () => bundles.observeCatalog(signal())
  const prepare = (name: string) => bundles.prepareBundle(input(name), signal())
  const install = async (name: string) => {
    const prepared = await prepare(name), observed = await observe()
    try { return await bundles.commitCatalog(observed.value, { kind: 'install', bundle: prepared.value }, signal()) }
    finally { prepared.release(); observed.release() }
  }
  const check = async (version: SkillBundleVersion): Promise<void> => {
    if (authorize === undefined) throw new Error('Fixture did not bind authorization')
    const bound = authorize, held = await work.read((c, s) => bound(c, version, s), signal()); held.release()
  }
  const associate = (version: SkillBundleVersion): void => {
    mkdir('/private/skill-working-copies')
    const directory = (inode: string) => ({ device: '2', inode, mountId: '22', uid: 2000, gid: 2000, mode: 0o40700 })
    const { binding: _binding, ...source } = version
    put(`/private/skill-working-copies/project-${digest('workspace')}.json`, text(JSON.stringify({ schema: 2,
      accountId: binding.accountId, workspaceId: 'workspace', project: { rootPath: '/project', rootDevice: '2', rootInode: '8', rootMountId: '22' },
      sourceContext: { bootId: '11111111-1111-4111-8111-111111111111', mountNamespace: 'mnt:[123]' },
      metadata: directory('9'), skills: directory('10'), state: 'complete', pending: null, copies: [{ source, directory: directory('11') }] })))
  }
  const resolveRetained = (version: Omit<SkillBundleVersion, 'binding'>) => {
    if (resolveBundle === undefined) throw new Error('No bundle resolver')
    return resolveBundle(version)
  }
  const readRetained = async (version: SkillBundleVersion) => {
    if (readBundle === undefined) throw new Error('No bundle reader')
    const read = readBundle, held = await work.read((c, s) => read(c, version, s), signal())
    try { return held.value } finally { held.release() }
  }
  const readRetainedOnLane = (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => {
    if (readBundle === undefined) throw new Error('No bundle reader')
    return readBundle(client, version, control)
  }
  return { port, bundles, work, client, nodes, put, writes, native, list, skillDirectory, prepare, observe, install, check, associate,
    resolveRetained, readRetained, readRetainedOnLane,
    residents: () => queue?.inspect().pending ?? residents,
    afterActual: (notify: () => void) => { afterActual = notify },
    flush: async () => { const barrier = await run(async () => undefined, signal()); barrier.release() } }
}

it('preserves schema1 sample on reads and first schema2 install, sharing the catalog CAS across both entries', async () => {
  const f = await fixture(), sample = await f.port.prepare({ skillMarkdown: 'Sample', resource: Uint8Array.of(255) }, signal())
  f.put('/private/skills/current.json', text(JSON.stringify({ schema: 1, id: sample.value.id, skillSha256: sample.value.skillSha256,
    resourceSha256: sample.value.resourceSha256, skillBytes: sample.value.skillBytes, resourceBytes: sample.value.resourceBytes })))
  const before = await f.observe(); expect(before.value.entries.map(e => e.skillId)).toEqual(['sample']); before.release()
  expect(f.writes).not.toHaveBeenCalled()
  const added = await f.install('second'), stale = await f.observe(), next = await f.prepare('updated')
  expect(added.value.catalog.entries.map(e => e.kind)).toEqual(['legacy-sample', 'managed'])
  const item = added.value.entry; if (item === null) throw new Error('Fixture install omitted its entry')
  const updated = await f.bundles.commitCatalog(added.value.catalog, { kind: 'update', skillId: item.skillId, bundle: next.value }, signal())
  await expect(f.bundles.commitCatalog(stale.value, { kind: 'uninstall', skillId: item.skillId }, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const old = await f.port.current(signal()); expect(old.value?.version.id).toBe(sample.value.id)
  await expect(observeSkillCurrent(f.work, f.client, signal())).rejects.toThrow()
  old.release(); updated.release(); next.release(); stale.release(); added.release(); sample.release()
  expect(f.residents()).toBe(0)
})

it('denies new source loads after uninstall while the exact existing source lease completes, then reclaims after release', async () => {
  const f = await fixture(), installed = await f.install('first'), entry = installed.value.entry
  if (entry === null) throw new Error('Fixture install omitted its entry')
  installed.release()
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), finishing = new Promise<void>((resolve) => { finish = resolve })
  const captured: { source?: SkillBundleSource } = {}
  const running = f.bundles.withBundleSource(entry.version, async (source) => {
    captured.source = source; enter(); await finishing
    await f.check(source.version)
    return await source.readBytes('nested/value.bin')
  }, signal())
  await Promise.race([entered, running.then(() => { throw new Error('Source callback ended before entry') })])
  const observed = await f.observe(), removed = await f.bundles.commitCatalog(observed.value,
    { kind: 'uninstall', skillId: entry.skillId }, signal()); observed.release(); removed.release()
  await expect(f.bundles.withBundleSource(entry.version, async () => 'new load', signal())).rejects.toThrow()
  await expect(f.check(entry.version)).rejects.toThrow()
  const next = await f.prepare('next'); expect(f.nodes.has(`/private/skills/${entry.version.id}`)).toBe(true); next.release()
  finish(); const completed = await running
  expect(completed.value).toEqual(Uint8Array.of(0, 255, 5))
  if (captured.source === undefined) throw new Error('Fixture source did not enter')
  await expect(f.check(captured.source.version)).rejects.toThrow()
  await expect(captured.source.readBytes('SKILL.md')).rejects.toThrow()
  completed.release()
  const after = await f.prepare('after'); expect(f.nodes.has(`/private/skills/${entry.version.id}`)).toBe(false); after.release()
  expect(f.native.mock.calls.some(([r]) => r.kind === 'bundle-reclaim' && r.retained.includes(entry.version.id))).toBe(true)
  expect(f.residents()).toBe(0)
})

it('loads the newly published source after an update while retaining the older workspace copy source', async () => {
  const f = await fixture(), installed = await f.install('old'), old = installed.value.entry
  if (old === null) throw new Error('Fixture install omitted its entry')
  f.associate(old.version)
  const prepared = await f.prepare('new'), updated = await f.bundles.commitCatalog(installed.value.catalog,
    { kind: 'update', skillId: old.skillId, bundle: prepared.value }, signal())
  if (updated.value.entry === null) throw new Error('Fixture update omitted its entry')
  const current = updated.value.entry.version
  expect(current.id).not.toBe(old.version.id)
  prepared.release(); installed.release(); updated.release()
  const loaded = await f.bundles.withBundleSource(current, source => source.readText('SKILL.md'), signal())
  expect(loaded.value).toContain('name: new')
  loaded.release()
  await expect(f.bundles.withBundleSource(old.version, async () => 'old', signal()))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const later = await f.prepare('next')
  expect(f.nodes.has(`/private/skills/${old.version.id}`)).toBe(true)
  later.release()
  expect(f.residents()).toBe(0)
})

it('reissues a retained historical source from the protected association in a new issuer without making it current', async () => {
  const f = await fixture(), installed = await f.install('old'), old = installed.value.entry
  if (old === null) throw new Error('Fixture install omitted its entry')
  f.associate(old.version)
  const prepared = await f.prepare('new'), updated = await f.bundles.commitCatalog(installed.value.catalog,
    { kind: 'update', skillId: old.skillId, bundle: prepared.value }, signal())
  if (updated.value.entry === null) throw new Error('Fixture update omitted its entry')
  const nextId = updated.value.entry.version.id
  prepared.release(); installed.release(); updated.release()
  const binding: AccountBinding = { ...f.work.binding, epoch: brandString<AccountBinding['epoch']>('2'),
    lifetime: new AbortController().signal }
  const successor = createSkillVersionWork({ ...f.work, binding }), bundles = successor.bundles
  if (bundles === undefined) throw new Error('New issuer omitted bundle capability')
  const current = await bundles.observeCatalog(signal())
  expect(current.value.entries[0]?.version.id).toBe(nextId)
  const record = f.nodes.get(`/private/skill-working-copies/project-${digest('workspace')}.json`)
  if (record?.type !== 'file') throw new Error('Missing protected association fixture')
  const persisted = JSON.parse(new TextDecoder().decode(record.data)) as { copies: Array<{ source: Omit<SkillBundleVersion, 'binding'> }> }
  const retained = f.resolveRetained(persisted.copies[0]!.source)
  expect(retained.id).toBe(old.version.id); expect(retained.binding).toBe(binding)
  expect(new TextDecoder().decode((await f.readRetained(retained)).files[0]!.data)).toContain('name: old')
  await expect(f.check(retained)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const active = await bundles.withBundleSource(current.value.entries[0]!.version, source => source.readText('SKILL.md'), signal())
  expect(active.value).toContain('name: new'); active.release(); current.release()
  f.put(`/private/skills/${retained.id}/tree/SKILL.md`, text('tampered'))
  await expect(f.readRetained(retained)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(f.residents()).toBe(0)
})

it.each([false, true])('revalidates a retained old project copy after an update (source tampered: %s)', async (tampered) => {
  const f = await fixture(), installed = await f.install('old'), old = installed.value.entry
  if (old === null) throw new Error('Fixture install omitted its entry')
  f.associate(old.version)
  const prepared = await f.prepare('new'), updated = await f.bundles.commitCatalog(installed.value.catalog,
    { kind: 'update', skillId: old.skillId, bundle: prepared.value }, signal())
  if (updated.value.entry === null) throw new Error('Fixture update omitted its entry')
  const activeId = updated.value.entry.version.id
  installed.release(); prepared.release(); updated.release()
  const binding: AccountBinding = { ...f.work.binding, epoch: brandString<AccountBinding['epoch']>('2'),
    lifetime: new AbortController().signal }
  const successor = createSkillVersionWork({ ...f.work, binding }), bundles = successor.bundles
  if (bundles === undefined) throw new Error('New issuer omitted bundle capability')
  const current = await bundles.observeCatalog(signal())
  expect(current.value.entries[0]?.version.id).toBe(activeId); current.release()
  const recordPath = `/private/skill-working-copies/project-${digest('workspace')}.json`, record = f.nodes.get(recordPath)
  if (record?.type !== 'file') throw new Error('Fixture association missing')
  const recordSha256 = createHash('sha256').update(record.data).digest('hex'), recordRevision = record.version
  if (tampered) f.put(`/private/skills/${old.version.id}/tree/SKILL.md`, text('tampered'))
  const root = { rootPath: '/project', rootDevice: '2', rootInode: '8', rootMountId: '23' }
  const directory = (inode: string) => ({ device: '2', inode, mountId: '23', uid: 2000, gid: 2000, mode: 0o40700 })
  const existingDirectory = f.skillDirectory.getMockImplementation()!
  f.skillDirectory.mockImplementation(async (...args) => args[3] === 'parent-verify'
    ? { created: false, directory: directory('10') } : existingDirectory(...args))
  const existingList = f.list.getMockImplementation()!
  f.list.mockImplementation(async (...args) => args[0].rootPath === '/project/.pe/skills'
    ? [{ name: old.version.id, type: 'directory', identity: '2:11', version: 'copy' }] : existingList(...args))
  vi.spyOn(f.client, 'skillSourceContext').mockResolvedValue({
    bootId: '11111111-1111-4111-8111-111111111111', mountNamespace: 'mnt:[124]' })
  f.native.mockClear()
  f.native.mockImplementation(async (request) => {
    if (request.kind !== 'bundle-project') throw new Error('Only original copy verification belongs here')
    expect(request.version).toBe(old.version.id); expect(request.expectedCopyInode).toBe('11')
    expect(new TextDecoder().decode(request.tree.files.find(file => file.relativePath === 'SKILL.md')?.data)).toContain('name: old')
    return { outcome: 'complete', closed: true, reused: true, errno: 0, versions: 1, chargedBytes: 0,
      chargedInodes: 1, removed: 0, directory: directory('11') }
  })
  let consumed = false
  const workspace: Workspace = { id: brandString<Workspace['id']>('workspace'), path: '/project', title: 'fixture',
    createdAt: '', updatedAt: '', sessionIds: [], setTitle: async () => { throw Error('unused') },
    attachSession: async () => { throw Error('unused') }, insertSessionBefore: async () => { throw Error('unused') },
    detachSession: async () => { throw Error('unused') }, status: async () => 'ok' }
  const port = createSkillProjectWork({ binding, privateRoot: f.work.root, uid: 2000, gid: 2000,
    quota: { ...root, rootPath: '/', minimumBytes: '1048576', maximumBytes: '1048576', minimumInodes: '128',
      maximumInodes: '128', backing: { path: '/backing', device: '1', inode: '2', bytes: '1048576' } },
    limits: projectionLimits, sourceLimits: f.work.limits, bundleLimits: limits, maxReadBytes: 65536,
    maxPathBytes: 4096, maxReplyBytes: 65536, assertCurrent: () => { f.work.assertCurrent() },
    project: async () => root, resolveSource: () => undefined, source: async () => { throw Error('unused') },
    bundleSource: f.readRetainedOnLane, resolveBundle: f.resolveRetained,
    revalidation: [{ workspaceId: workspace.id, recordSha256, recordRevision, get pending() { return !consumed },
      assertRecord: (actual) => { expect(actual).toBe(recordRevision) }, confirmRecord: (before) => {
        expect(before).toBe(recordRevision); consumed = true } }],
    mutate: (callback, control) => f.work.mutate('prepare', callback, control),
  })
  if (tampered) {
    await expect(port.prepareProject(workspace, () => {}, signal())).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(consumed).toBe(false); expect(f.native).not.toHaveBeenCalled()
    expect(f.nodes.get(recordPath)).toEqual(record); expect(f.residents()).toBe(0)
    return
  }
  const parent = await port.prepareProject(workspace, () => {}, signal())
  expect(consumed).toBe(true); expect(f.native).toHaveBeenCalledOnce()
  expect(f.nodes.has(`/private/skills/${old.version.id}/tree/SKILL.md`)).toBe(true)
  const after = await bundles.observeCatalog(signal())
  expect(after.value.entries[0]?.version.id).toBe(activeId)
  after.release(); parent.release(); expect(f.residents()).toBe(0)
})

it('retains uninstalled source dependencies from durable full-tree copy records and rejects forged catalog objects', async () => {
  const f = await fixture(), installed = await f.install('persisted'), entry = installed.value.entry
  if (entry === null) throw new Error('Fixture install omitted its entry')
  f.associate(entry.version)
  const removed = await f.bundles.commitCatalog(installed.value.catalog, { kind: 'uninstall', skillId: entry.skillId }, signal())
  removed.release(); installed.release()
  const next = await f.prepare('next'); next.release()
  expect(f.nodes.has(`/private/skills/${entry.version.id}/tree/nested/value.bin`)).toBe(true)
  const current = await f.observe()
  expect(() => f.bundles.commitCatalog({ ...current.value }, { kind: 'uninstall', skillId: entry.skillId }, signal())).toThrow()
  current.release(); expect(f.residents()).toBe(0)
})


it.each(['abort', 'deadline'] as const)('releases an undelivered prepared reference after %s and actual late success without rolling back data', async (kind) => {
  const f = await fixture(kind === 'deadline' ? 30 : 1000), observer = new AbortController()
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const original = f.native.getMockImplementation()
  if (original === undefined) throw new Error('Fixture lost its native implementation')
  f.native.mockImplementation(async (request, actualControl) => {
    const facts = await original(request, actualControl)
    if (request.kind === 'bundle-prepare') { entered.resolve(undefined); await finish.promise }
    return facts
  })
  const preparing = f.bundles.prepareBundle(input('abandoned'), observer.signal)
  const rejected = expect(preparing).rejects.toThrow()
  await entered.promise
  if (kind === 'abort') observer.abort(new Error('Observer abandoned'))
  await rejected
  const first = f.native.mock.calls.find(([r]) => r.kind === 'bundle-prepare')?.[0].version
  if (first === undefined) throw new Error('Fixture never prepared its source')
  expect(f.nodes.has(`/private/skills/${first}`)).toBe(true)
  finish.resolve(undefined); await f.flush()
  f.native.mockImplementation(original)
  const next = await f.prepare('live')
  try { expect(f.nodes.has(`/private/skills/${first}`)).toBe(false) } finally { next.release() }
  expect(f.residents()).toBe(0)
})

it('settles an undelivered prepare when cancellation occurs in the callback-to-queue-delivery microtask window', async () => {
  const f = await fixture(1000), observer = new AbortController()
  f.afterActual(() => { queueMicrotask(() => { observer.abort(new Error('Delivery abandoned after actual callback')) }) })
  await expect(f.bundles.prepareBundle(input('gap'), observer.signal)).rejects.toThrow()
  await f.flush()
  const first = f.native.mock.calls.find(([r]) => r.kind === 'bundle-prepare')?.[0].version
  if (first === undefined) throw new Error('Fixture never completed its source')
  expect(f.nodes.has(`/private/skills/${first}`)).toBe(true)
  const next = await f.prepare('live')
  try { expect(f.nodes.has(`/private/skills/${first}`)).toBe(false) } finally { next.release() }
  expect(f.residents()).toBe(0)
})

it('settles an undelivered source borrow before the next live GC and never invokes its consumer', async () => {
  const f = await fixture(1000), installed = await f.install('source'), entry = installed.value.entry
  if (entry === null) throw new Error('Fixture omitted its source entry')
  installed.release()
  const observer = new AbortController(), consumer = vi.fn(async () => 'must not enter')
  f.afterActual(() => { queueMicrotask(() => { observer.abort(new Error('Snapshot delivery abandoned')) }) })
  await expect(f.bundles.withBundleSource(entry.version, consumer, observer.signal)).rejects.toThrow()
  await f.flush(); expect(consumer).not.toHaveBeenCalled()
  const observed = await f.observe(), removed = await f.bundles.commitCatalog(observed.value,
    { kind: 'uninstall', skillId: entry.skillId }, signal())
  observed.release(); removed.release()
  const next = await f.prepare('live')
  try { expect(f.nodes.has(`/private/skills/${entry.version.id}`)).toBe(false) } finally { next.release() }
  expect(f.residents()).toBe(0)
})


it('delivered prepare remains pinned after observer cancellation until its actual resident result is released', async () => {
  const f = await fixture(1000), observer = new AbortController()
  const prepared = await f.bundles.prepareBundle(input('delivered'), observer.signal)
  observer.abort(new Error('Observer ended after delivery'))
  const next = await f.prepare('next')
  try { expect(f.nodes.has(`/private/skills/${prepared.value.id}`)).toBe(true) } finally { next.release(); prepared.release() }
  const after = await f.prepare('after')
  try { expect(f.nodes.has(`/private/skills/${prepared.value.id}`)).toBe(false) } finally { after.release() }
  expect(f.residents()).toBe(0)
})


it('rejects a ZIP without root SKILL.md in the original files lane without changing the installed catalog', async () => {
  const f = await fixture(2000), before = await f.install('existing')
  const previous = before.value.catalog.entries.map(entry => [entry.skillId, entry.version.id])
  before.release()
  const nativeCalls = f.native.mock.calls.filter(([request]) => request.kind === 'bundle-prepare').length
  const archive = zipSync({ 'note.txt': text('not a skill') })
  const failure: unknown = await f.bundles.prepareBundle({ kind: 'zip', dataBase64: Buffer.from(archive).toString('base64') }, signal())
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(InvalidSkillBundleFailure)
  expect(failure).toMatchObject({ outcome: 'not-published', code: 'FS_PERMISSION_DENIED' })
  const after = await f.observe()
  try { expect(after.value.entries.map(entry => [entry.skillId, entry.version.id])).toEqual(previous) }
  finally { after.release() }
  expect(f.native.mock.calls.filter(([request]) => request.kind === 'bundle-prepare')).toHaveLength(nativeCalls)
  await f.flush()
})
