/** Original queue/worker transport with TEST ONLY synthetic geometry; this establishes no Linux quota or fsync result. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import { environmentRecordLeaf, environmentWorkBytes } from '../src/environment-bank.ts'
import { sessionEnvironmentRecordLeaf } from '../src/environment-directories.ts'
import type { EnvironmentBankAuthority, EnvironmentSessionId } from '../src/environment-bank.ts'
import type { StaticStorageDomain, StorageProbeFacts } from '../src/storage-types.ts'

async function fixture(mode = 'normal', slots = 2, sessionDirectories = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'environment-bank-')))
  const projects = join(home, 'projects'), project = join(projects, 'default-workspace'), privateRoot = join(home, 'private')
  mkdirSync(project, { recursive: true }); mkdirSync(privateRoot)
  const lifetime = new AbortController(), binding: AccountBinding = { accountId: 'env-A' as AccountBinding['accountId'],
    epoch: '1' as AccountBinding['epoch'], recipeVersion: 'test-only-env', lifetime: lifetime.signal }
  const storageFacts: Record<string, StorageProbeFacts> = {}
  const domain = (path: string, mountId: string): StaticStorageDomain => {
    const st = statSync(path, { bigint: true })
    storageFacts[path] = { flags: 31, uid: 2000, gid: 2000, mode: 0o40700, appUid: 2000, appGid: 2000,
      device: String(st.dev), inode: String(st.ino), mountId, filesystem: '61267', blockBytes: '4096', blocks: '1024',
      freeBlocks: '1000', availableBlocks: '1000', inodes: '2048', freeInodes: '2000', size: '0', allocatedBytes: '0', links: '1' }
    return { rootPath: path, rootDevice: String(st.dev), rootInode: String(st.ino), rootMountId: mountId,
      minimumBytes: '4194304', maximumBytes: '4194304', minimumInodes: '2048', maximumInodes: '2048',
      backing: { path: '/test-only/not-probed', device: '1', inode: '1', bytes: '4194304' } }
  }
  const authority: EnvironmentBankAuthority = { appUid: 2000, appGid: 2000, projects: domain(projects, '1'),
    bank: { bankId: 'bank-A', ...sessionDirectories ? { mode: 'session-directories' as const } : {}, slots: Array.from({ length: slots }, (_, i) => {
      const path = join(home, `env-${i}`); mkdirSync(path)
      return { slotId: `slot-${i}`, domain: domain(path, String(i + 2)) }
    }) } }
  const pathFor = (index: number) => join(privateRoot, environmentRecordLeaf(authority.bank, authority.bank.slots[index]!))
  for (const [index, slot] of authority.bank.slots.entries()) writeFileSync(pathFor(index), JSON.stringify({
    schema: 1, bankId: authority.bank.bankId, slotId: slot.slotId, slotGeneration: 1, state: 'free' }), { mode: 0o600 })
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = []
  const limits = { maxLanes: 1, maxRunning: 2, maxRunningPerLane: 2, maxQueued: 8, maxQueuedPerLane: 8,
    maxResidentBytes: 32 * 1024 * 1024, maxResidentBytesPerLane: 16 * 1024 * 1024, waitTimeoutMs: 10000,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 4096,
    readyTimeoutMs: 3000, drainTimeoutMs: 30, helperPath: '/test-only/fd.node',
    maxReadBytes: 2048, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 256,
    content: { maxEntries: 8, maxNameBytes: 255, maxReplyBytes: 4096, operationTimeoutMs: 5000 } }
  const pools: LinuxFilesPool[] = []
  const startPool = async () => {
    const pool = new LinuxFilesPool(limits, (input) => {
      const worker = new Worker(new URL('./fixtures/text-worker.mjs', import.meta.url), {
        workerData: { mode, gate, abiVersion: 8, content: input.content, storageFacts, sessionDirectories,
          ...mode === 'metadata-legacy' ? {} : { projectMetadataVersion: 1 },
          ...mode === 'layout-legacy' ? {} : { environmentLayoutVersion: 1 } } })
      workers.push(worker); return worker
    })
    pools.push(pool)
    await pool.start()
    return pool
  }
  onTestFinished(async () => {
    Atomics.store(counters, 2, 1); Atomics.notify(counters, 2)
    for (const pool of pools) await pool.stop(Date.now() + 30)
    await Promise.all(workers.map(worker => worker.terminate()))
    rmSync(home, { recursive: true, force: true })
  })
  const pool = await startPool(), info = statSync(privateRoot, { bigint: true })
  const workspace = { path: project, id: 'workspace-A' as Workspace['id'] } as Workspace
  const bind = (target: LinuxFilesPool, owner: AccountBinding) => {
    const current = () => { owner.lifetime.throwIfAborted() }
    const port = target.bind(owner, authority.projects, current,
      { rootPath: privateRoot, rootDevice: String(info.dev), rootInode: String(info.ino), rootMountId: '9' })
    const prepare = (id = 'session-A', version = 'image-python-init-v1', selected = workspace, signal?: AbortSignal) =>
      port.prepareExecutionMounts(selected, id as EnvironmentSessionId, version, authority, current, signal)
    return { port, prepare }
  }
  const cold = async () => {
    const stopped = await pool.stop(Date.now() + 1000)
    if (stopped.status !== 'confirmed') throw new Error('Fixture pool did not actually stop; no cold replacement is permitted')
    const nextLifetime = new AbortController(), nextBinding = { ...binding,
        epoch: '2' as AccountBinding['epoch'], lifetime: nextLifetime.signal }, nextPool = await startPool()
    return { pool: nextPool, binding: nextBinding, ...bind(nextPool, nextBinding) }
  }
  const sessionPathFor = (id = 'session-A') => join(privateRoot,
    sessionEnvironmentRecordLeaf(authority.bank, id as EnvironmentSessionId))
  return { pool, ...bind(pool, binding), binding, workspace, authority, pathFor, sessionPathFor,
    counters, lifetime, limits, privateRoot, cold,
    release: () => { Atomics.store(counters, 2, 1); Atomics.notify(counters, 2) } }
}

it('serializes concurrent first use to one durable binding, then reuses it while running capacity is free', async () => {
  const f = await fixture(), [a, b] = await Promise.all([f.prepare(), f.prepare()])
  expect(a.value.environment.slotId).toBe(b.value.environment.slotId)
  expect(a.value.environment.slotGeneration).toBe(1)
  expect(a.value.project.readOnlyPaths).toEqual(['.pe'])
  expect(a.value.project.metadataDirectory).toMatchObject({ relativePath: '.pe', mode: 0o40700, uid: 2000, gid: 2000 })
  expect(String(statSync(join(a.value.project.rootPath, '.pe'), { bigint: true }).ino)).toBe(a.value.project.metadataDirectory.inode)
  expect(a.value.environment.targetPath).toBe('/opt/session-env')
  expect(a.value.environment.rootReadOnly).toBe(true)
  expect(a.value.environment.writablePaths).toEqual(['home', 'venv', 'tmp'])
  for (const name of ['home', 'venv', 'tmp'] as const) {
    expect(a.value.environment.layout[name]).toMatchObject({ uid: 2000, gid: 2000, mode: 0o40700,
      device: a.value.environment.rootDevice, mountId: a.value.environment.rootMountId })
    expect(a.value.environment.layout[name].inode)
      .toBe(String(statSync(join(a.value.environment.rootPath, name), { bigint: true }).ino))
  }
  expect(JSON.stringify(a.value)).not.toContain(f.privateRoot)
  expect(Atomics.load(f.counters, 0)).toBe(1)
  const bytes = readFileSync(f.pathFor(0), 'utf8')
  expect(JSON.parse(bytes)).toMatchObject({ state: 'bound', sessionId: 'session-A' })
  expect(f.pool.inspect().work).toMatchObject({ running: 0, pending: 2,
    residentBytes: 2 * environmentWorkBytes(2, f.limits) })
  const read = await f.port.stat('.')
  expect(read.value?.type).toBe('directory'); read.release()
  a.release(); b.release()
  const next = await f.prepare(); next.release()
  expect(readFileSync(f.pathFor(0), 'utf8')).toBe(bytes)
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect(f.pool.inspect().work.residentBytes).toBe(0)
})

it('recovers the same persistent Session slot after a confirmed cold pool rebuild and gives another Session a different slot', async () => {
  const f = await fixture(), first = await f.prepare()
  const original = first.value.environment, record = readFileSync(f.pathFor(0), 'utf8')
  writeFileSync(join(original.rootPath, 'retained.txt'), 'same session environment')
  writeFileSync(join(original.rootPath, 'home', 'settings'), 'retained HOME')
  writeFileSync(join(original.rootPath, 'venv', 'pyvenv.cfg'), 'retained venv')
  first.release()
  const cold = await f.cold(), restored = await cold.prepare()
  expect(restored.value.binding.epoch).toBe('2')
  expect(restored.value.environment).toEqual(original)
  expect(readFileSync(f.pathFor(0), 'utf8')).toBe(record)
  expect(readFileSync(join(restored.value.environment.rootPath, 'retained.txt'), 'utf8')).toBe('same session environment')
  expect(readFileSync(join(restored.value.environment.rootPath, 'home', 'settings'), 'utf8')).toBe('retained HOME')
  expect(readFileSync(join(restored.value.environment.rootPath, 'venv', 'pyvenv.cfg'), 'utf8')).toBe('retained venv')
  expect(Atomics.load(f.counters, 0)).toBe(1)
  restored.release()
  const other = await cold.prepare('session-B')
  expect(other.value.environment.slotId).not.toBe(original.slotId)
  other.release()
  expect(Atomics.load(f.counters, 0)).toBe(2)
})

it('isolates Session slots and refuses capacity, changed projects and incompatible versions without rewriting ownership', async () => {
  const f = await fixture(), first = await f.prepare(), second = await f.prepare('session-B')
  expect(first.value.environment.slotId).not.toBe(second.value.environment.slotId)
  first.release(); second.release()
  const before = readFileSync(f.pathFor(0), 'utf8')
  await expect(f.prepare('session-C')).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_TOO_LARGE' })
  await expect(f.prepare('session-A', 'incompatible')).rejects.toMatchObject({ outcome: 'not-published' })
  await expect(f.prepare('session-A', undefined, { ...f.workspace, id: 'other-workspace' as Workspace['id'] }))
    .rejects.toMatchObject({ outcome: 'not-published' })
  expect(readFileSync(f.pathFor(0), 'utf8')).toBe(before)
  expect(Atomics.load(f.counters, 0)).toBe(2)
})

it('does not quarantine a bank after the selected slot probe confirms FS_ABORTED before metadata publication', async () => {
  const f = await fixture('probe-abort-once')
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published', cause: { code: 'FS_ABORTED' } })
  expect(Atomics.load(f.counters, 0)).toBe(0)
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  const held = await f.prepare()
  expect(held.value.environment.slotId).toBe('slot-0')
  held.release()
  expect(Atomics.load(f.counters, 0)).toBe(1)
})

it('refuses execution storage on a legacy ABI8 helper without inventing metadata-directory readiness', async () => {
  const f = await fixture('metadata-legacy')
  await expect(f.prepare()).rejects.toThrow('no verified fixed project metadata capability')
  expect(existsSync(join(f.workspace.path, '.pe'))).toBe(false)
  expect(Atomics.load(f.counters, 0)).toBe(0)
  expect(f.pool.inspect().work.residentBytes).toBe(0)
})

it.each(['file', 'symlink', 'mode'])('refuses an existing unsafe .pe %s without replacing it or binding an environment', async (kind) => {
  const f = await fixture(), path = join(f.workspace.path, '.pe')
  if (kind === 'file') writeFileSync(path, 'existing user file')
  else if (kind === 'symlink') symlinkSync(f.privateRoot, path, 'dir')
  else mkdirSync(path, { mode: 0o755 })
  const before = lstatSync(path, { bigint: true })
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published' })
  expect(lstatSync(path, { bigint: true }).ino).toBe(before.ino)
  expect(Atomics.load(f.counters, 0)).toBe(0)
})

it('refuses a definite metadata mkdir quota failure before private slot publication', async () => {
  const f = await fixture('metadata-known-failure')
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published', syscallCode: 'ENOSPC' })
  expect(existsSync(join(f.workspace.path, '.pe'))).toBe(false)
  expect(Atomics.load(f.counters, 0)).toBe(0)
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
})

it.each(['metadata-unknown', 'metadata-unclosed', 'metadata-bad-frame'])('retains actual unknown preparation after %s and never binds a slot', async (mode) => {
  const f = await fixture(mode)
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  expect(Atomics.load(f.counters, 0)).toBe(0)
  await vi.waitFor(() => { expect(f.pool.inspect().exited).toBe(1) })
  await expect(f.prepare('session-B')).rejects.toMatchObject({ outcome: 'unknown' })
  expect(Atomics.load(f.counters, 0)).toBe(0)
})

it('retains a late confirmed .pe after cancellation, joins the reply, and leaves private slot records free', async () => {
  const f = await fixture('metadata-block-after'), controller = new AbortController(), reason = new Error('observer left during metadata prepare')
  const pending = f.prepare('session-A', undefined, undefined, controller.signal), rejected = expect(pending).rejects.toBe(reason)
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 1)).toBe(1) })
  controller.abort(reason); await rejected
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  const identity = statSync(join(f.workspace.path, '.pe'), { bigint: true }).ino
  expect(Atomics.load(f.counters, 0)).toBe(0)
  f.release()
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  const held = await f.prepare()
  expect(held.value.project.metadataDirectory.inode).toBe(String(identity)); held.release()
  expect(Atomics.load(f.counters, 0)).toBe(1)
})

it('refuses an older helper missing fixed environment layout before any directory or slot effect', async () => {
  const f = await fixture('layout-legacy')
  await expect(f.prepare()).rejects.toThrow('no verified fixed environment layout capability')
  expect(existsSync(join(f.workspace.path, '.pe'))).toBe(false)
  expect(Atomics.load(f.counters, 0)).toBe(0)
  expect(f.pool.inspect().work.residentBytes).toBe(0)
})

it.each(['home', 'venv', 'tmp'])('refuses unsafe fixed environment %s without replacing the entry', async (name) => {
  for (const kind of ['file', 'symlink', 'mode']) {
    const f = await fixture(), path = join(f.authority.bank.slots[0]!.domain.rootPath, name)
    if (kind === 'file') writeFileSync(path, 'preserved user data')
    else if (kind === 'symlink') symlinkSync(f.privateRoot, path, 'dir')
    else mkdirSync(path, { mode: 0o755 })
    const before = lstatSync(path, { bigint: true })
    await expect(f.prepare()).rejects.toMatchObject({ outcome: name === 'home' ? 'not-published' : 'unknown' })
    expect(lstatSync(path, { bigint: true }).ino).toBe(before.ino)
    expect(Atomics.load(f.counters, 0)).toBe(0)
  }
})

it('rejects a known layout quota failure before binding the selected private slot', async () => {
  const f = await fixture('layout-known-failure')
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published', syscallCode: 'ENOSPC' })
  expect(Atomics.load(f.counters, 0)).toBe(0)
  expect(JSON.parse(readFileSync(f.pathFor(0), 'utf8'))).toMatchObject({ state: 'free' })
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
})

it.each(['layout-unknown', 'layout-unclosed', 'layout-bad-frame'])('holds the original work and refuses grants after %s', async (mode) => {
  const f = await fixture(mode)
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  await vi.waitFor(() => { expect(f.pool.inspect().exited).toBe(1) })
  expect(Atomics.load(f.counters, 0)).toBe(0)
  await expect(f.prepare('session-B')).rejects.toMatchObject({ outcome: 'unknown' })
})

it('retains late prepared layout identities on cancellation while leaving private slot ownership free', async () => {
  const f = await fixture('layout-block-after'), controller = new AbortController(), reason = new Error('layout observer left')
  const pending = f.prepare('session-A', undefined, undefined, controller.signal), rejected = expect(pending).rejects.toBe(reason)
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 1)).toBe(1) })
  controller.abort(reason); await rejected
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  const path = f.authority.bank.slots[0]!.domain.rootPath
  const identities = ['home', 'venv', 'tmp'].map(name => statSync(join(path, name), { bigint: true }).ino)
  writeFileSync(join(path, 'home', 'keep'), 'preserved')
  expect(Atomics.load(f.counters, 0)).toBe(0)
  f.release()
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  const held = await f.prepare()
  expect((['home', 'venv', 'tmp'] as const).map(name => BigInt(held.value.environment.layout[name].inode))).toEqual(identities)
  expect(readFileSync(join(path, 'home', 'keep'), 'utf8')).toBe('preserved')
  held.release()
  expect(Atomics.load(f.counters, 0)).toBe(1)
})

it.each(['missing', 'invalid', 'duplicate'])('closes the bank on %s ownership instead of guessing or selecting another slot', async (kind) => {
  const f = await fixture()
  if (kind === 'missing') unlinkSync(f.pathFor(0))
  else if (kind === 'invalid') writeFileSync(f.pathFor(0), '{}')
  else for (const [index, slot] of f.authority.bank.slots.entries()) writeFileSync(f.pathFor(index), JSON.stringify({
    schema: 1, bankId: f.authority.bank.bankId, slotId: slot.slotId, slotGeneration: 1, state: 'bound',
    sessionId: 'session-A', workspaceId: 'workspace-A', environmentVersion: 'image-python-init-v1' }))
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published' })
  await expect(f.prepare('new-session')).rejects.toMatchObject({ outcome: 'not-published' })
  expect(Atomics.load(f.counters, 0)).toBe(0)
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
})

it('retains unknown metadata publication and the original operation budget without giving another slot', async () => {
  const f = await fixture('unknown')
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  await expect(f.prepare('session-B')).rejects.toMatchObject({ outcome: 'unknown' })
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect((await f.pool.stopEpoch(f.binding, Date.now())).status).toBe('unknown')
})

it('keeps a late confirmed binding after observer cancellation and releases running only after the actual reply', async () => {
  const f = await fixture('block-after'), controller = new AbortController(), reason = new Error('caller left')
  const pending = f.prepare('session-A', undefined, undefined, controller.signal)
  const rejected = expect(pending).rejects.toBe(reason)
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 1)).toBe(1) })
  controller.abort(reason)
  await rejected
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  f.release()
  await vi.waitFor(() => { expect(f.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
  const retained = await f.prepare()
  expect(retained.value.environment.slotId).toBe('slot-0'); retained.release()
  expect(Atomics.load(f.counters, 0)).toBe(1)
})

it('joins prepublication cancellation without freeing actual work early or inventing a bound slot', async () => {
  const f = await fixture('block-before'), controller = new AbortController(), reason = new Error('cancel before publish')
  const pending = f.prepare('session-A', undefined, undefined, controller.signal)
  const rejected = expect(pending).rejects.toBe(reason)
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 1)).toBe(1) })
  controller.abort(reason)
  await rejected
  expect(f.pool.inspect().work).toMatchObject({ running: 1, residentBytes: environmentWorkBytes(2, f.limits) })
  expect(JSON.parse(readFileSync(f.pathFor(0), 'utf8'))).toMatchObject({ state: 'free' })
  f.release()
  await vi.waitFor(() => { expect(f.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
  const held = await f.prepare()
  expect(held.value.environment.slotId).toBe('slot-0'); held.release()
  expect(Atomics.load(f.counters, 0)).toBe(2)
})

it('rejects an insufficient complete peak reservation and an oversized version without publishing metadata', async () => {
  const f = await fixture()
  const exact = environmentWorkBytes(2, f.limits)
  expect(environmentWorkBytes(2, { ...f.limits, maxResidentBytesPerLane: exact })).toBe(exact)
  expect(() => environmentWorkBytes(2, { ...f.limits, maxResidentBytesPerLane: exact - 1 })).toThrow()
  expect(() => environmentWorkBytes(2, { ...f.limits, maxResidentBytesPerLane: 1 })).toThrow()
  await expect(f.prepare('session-A', 'x'.repeat(f.limits.maxPathBytes + 1))).rejects.toMatchObject({ outcome: 'not-published' })
  expect(Atomics.load(f.counters, 0)).toBe(0)
  const good = await f.prepare(); good.release()
})

it('gives more than two Sessions distinct child roots in two fixed pools without changing old slot ownership', async () => {
  const f = await fixture('normal', 2, true), old = [readFileSync(f.pathFor(0), 'utf8'), readFileSync(f.pathFor(1), 'utf8')]
  const roots = new Set<string>(), pools = new Set<string>()
  for (const id of ['session-A', 'session-B', 'session-C', 'session-D', 'session-E']) {
    const held = await f.prepare(id), environment = held.value.environment
    roots.add(environment.rootPath); pools.add(environment.slotId)
    expect(environment.rootPath).toMatch(/\/env-\d\/[a-f0-9-]{36}$/)
    expect(environment.quota.maximumBytes).toBe('4194304')
    for (const name of ['home', 'venv', 'tmp'] as const) expect(environment.layout[name]).toMatchObject({
      mode: 0o40700, device: environment.rootDevice, mountId: environment.rootMountId })
    writeFileSync(join(environment.rootPath, 'home', 'identity'), id)
    const saved = JSON.parse(readFileSync(f.sessionPathFor(id), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ schema: 2, sessionId: id, workspaceId: 'workspace-A', identity: {
      device: environment.rootDevice, inode: environment.rootInode } })
    expect(saved.leaf).toBe(environment.rootPath.split('/').at(-1))
    held.release()
  }
  expect(roots.size).toBe(5); expect(pools.size).toBe(2)
  expect(Atomics.load(f.counters, 4)).toBe(5)
  expect([readFileSync(f.pathFor(0), 'utf8'), readFileSync(f.pathFor(1), 'utf8')]).toEqual(old)
  for (const id of ['session-A', 'session-B', 'session-C', 'session-D', 'session-E']) {
    const held = await f.prepare(id)
    expect(readFileSync(join(held.value.environment.rootPath, 'home', 'identity'), 'utf8')).toBe(id)
    held.release()
  }
  expect(Atomics.load(f.counters, 5)).toBe(5)
})

it('rechecks the same schema-two inode across a confirmed pool rebuild without allocating another directory', async () => {
  const f = await fixture('normal', 2, true), first = await f.prepare(), original = first.value.environment
  writeFileSync(join(original.rootPath, 'venv', 'pyvenv.cfg'), 'original venv')
  const saved = readFileSync(f.sessionPathFor(), 'utf8'); first.release()
  const cold = await f.cold(), restored = await cold.prepare()
  expect(restored.value.environment).toEqual(original)
  expect(restored.value.binding.epoch).toBe('2')
  expect(readFileSync(f.sessionPathFor(), 'utf8')).toBe(saved)
  expect(readFileSync(join(original.rootPath, 'venv', 'pyvenv.cfg'), 'utf8')).toBe('original venv')
  expect(Atomics.load(f.counters, 5)).toBe(1)
  restored.release()
})

it('refuses an unmigrated legacy bound Session while allowing a new Session in that same fixed pool', async () => {
  const f = await fixture('normal', 1, true), slot = f.authority.bank.slots[0]!
  const old = JSON.stringify({ schema: 1, bankId: f.authority.bank.bankId, slotId: slot.slotId, slotGeneration: 1,
    state: 'bound', sessionId: 'session-A', workspaceId: 'workspace-A', environmentVersion: 'image-python-init-v1' })
  writeFileSync(f.pathFor(0), old); writeFileSync(join(slot.domain.rootPath, 'old-user-data'), 'preserved')
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published', cause: {
    message: 'This retained Session environment requires explicit directory migration.' } })
  expect(existsSync(f.sessionPathFor())).toBe(false); expect(Atomics.load(f.counters, 5)).toBe(0)
  const fresh = await f.prepare('session-B')
  expect(fresh.value.environment.slotId).toBe(slot.slotId)
  expect(readFileSync(join(slot.domain.rootPath, 'old-user-data'), 'utf8')).toBe('preserved')
  expect(readFileSync(f.pathFor(0), 'utf8')).toBe(old)
  fresh.release()
})

it('accepts only an explicitly migrated legacy Session directory with its positive inode and original pool generation', async () => {
  const f = await fixture('normal', 1, true), slot = f.authority.bank.slots[0]!
  const old = JSON.stringify({ schema: 1, bankId: f.authority.bank.bankId, slotId: slot.slotId, slotGeneration: 1,
    state: 'bound', sessionId: 'session-A', workspaceId: 'workspace-A', environmentVersion: 'image-python-init-v1' })
  writeFileSync(f.pathFor(0), old)
  for (const name of ['home', 'venv', 'tmp']) mkdirSync(join(slot.domain.rootPath, name), { mode: 0o700 })
  writeFileSync(join(slot.domain.rootPath, 'home', 'legacy-settings'), 'old data')
  const leaf = '00000000-0000-4000-8000-000000000001', child = join(slot.domain.rootPath, leaf)
  mkdirSync(child, { mode: 0o700 })
  for (const name of ['home', 'venv', 'tmp']) renameSync(join(slot.domain.rootPath, name), join(child, name))
  const identity = statSync(child, { bigint: true })
  const migrated = JSON.stringify({ schema: 2, bankId: f.authority.bank.bankId, sessionId: 'session-A', workspaceId: 'workspace-A',
    environmentVersion: 'image-python-init-v1', slotId: slot.slotId, slotGeneration: 1, leaf,
    identity: { device: String(identity.dev), inode: String(identity.ino) } })
  writeFileSync(f.sessionPathFor(), migrated)
  const held = await f.prepare()
  expect(held.value.environment.rootPath).toBe(child)
  expect(readFileSync(join(child, 'home', 'legacy-settings'), 'utf8')).toBe('old data')
  expect(readFileSync(f.pathFor(0), 'utf8')).toBe(old)
  expect(readFileSync(f.sessionPathFor(), 'utf8')).toBe(migrated)
  expect(Atomics.load(f.counters, 5)).toBe(0)
  held.release()
})

it('resumes the same durable logical UUID in a fresh epoch using actual closed directory facts', async () => {
  const f = await fixture('normal', 1, true), slot = f.authority.bank.slots[0]!
  const leaf = '00000000-0000-4000-8000-000000000002', child = join(slot.domain.rootPath, leaf)
  mkdirSync(child, { mode: 0o700 }); mkdirSync(join(child, 'home'), { mode: 0o700 })
  writeFileSync(join(child, 'home', 'pending-data'), 'existing unfinished layout')
  const identity = statSync(child, { bigint: true })
  writeFileSync(f.sessionPathFor(), JSON.stringify({ schema: 2, bankId: f.authority.bank.bankId,
    sessionId: 'session-A', workspaceId: 'workspace-A', environmentVersion: 'image-python-init-v1',
    slotId: slot.slotId, slotGeneration: 1, leaf, identity: null }))
  const cold = await f.cold(), held = await cold.prepare()
  expect(held.value.environment.rootPath).toBe(child)
  expect(held.value.environment.rootInode).toBe(String(identity.ino))
  expect(readFileSync(join(child, 'home', 'pending-data'), 'utf8')).toBe('existing unfinished layout')
  expect(JSON.parse(readFileSync(f.sessionPathFor(), 'utf8')) as Record<string, unknown>).toMatchObject({ leaf,
    identity: { device: String(identity.dev), inode: String(identity.ino) } })
  expect(Atomics.load(f.counters, 4)).toBe(0); expect(Atomics.load(f.counters, 5)).toBe(1)
  held.release()
})

it('retains a logical UUID after a known leaf ENOSPC and never creates an SDK environment without a files grant', async () => {
  const f = await fixture('session-leaf-enospc', 2, true), sdkCreate = vi.fn()
  const attempt = async () => { const held = await f.prepare(); try { sdkCreate(held.value) } finally { held.release() } }
  await expect(attempt()).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_TOO_LARGE',
    cause: { code: 'cloud/capacity' } })
  const saved = readFileSync(f.sessionPathFor(), 'utf8')
  expect((JSON.parse(saved) as Record<string, unknown>).identity).toBeNull()
  await expect(attempt()).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_TOO_LARGE' })
  expect(readFileSync(f.sessionPathFor(), 'utf8')).toBe(saved)
  expect(Atomics.load(f.counters, 4)).toBe(0)
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect(sdkCreate).not.toHaveBeenCalled()
})

it('refuses measured pool exhaustion before any new Session record or leaf creation', async () => {
  const f = await fixture('session-pool-full', 2, true)
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published', code: 'FS_TOO_LARGE',
    cause: { code: 'cloud/capacity' } })
  expect(existsSync(f.sessionPathFor())).toBe(false)
  expect(Atomics.load(f.counters, 0)).toBe(0); expect(Atomics.load(f.counters, 5)).toBe(0)
})

it('retains unknown identity publication and never chooses a second UUID or grants another Session', async () => {
  const f = await fixture('session-identity-unknown', 2, true)
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'unknown' })
  const saved = readFileSync(f.sessionPathFor(), 'utf8')
  expect((JSON.parse(saved) as Record<string, unknown>).identity).not.toBeNull()
  expect(Atomics.load(f.counters, 4)).toBe(1)
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'unknown' })
  await expect(f.prepare('session-B')).rejects.toMatchObject({ outcome: 'unknown' })
  expect(readFileSync(f.sessionPathFor(), 'utf8')).toBe(saved)
  expect(existsSync(f.sessionPathFor('session-B'))).toBe(false)
  expect(Atomics.load(f.counters, 4)).toBe(1)
  expect((await f.pool.stopEpoch(f.binding, Date.now())).status).toBe('unknown')
})

it('refuses a replaced pinned Session inode before populating the replacement directory', async () => {
  const f = await fixture('normal', 2, true), first = await f.prepare(), original = first.value.environment
  const saved = readFileSync(f.sessionPathFor(), 'utf8'); first.release()
  renameSync(original.rootPath, `${original.rootPath}-preserved`)
  mkdirSync(original.rootPath, { mode: 0o700 })
  expect(String(statSync(original.rootPath, { bigint: true }).ino)).not.toBe(original.rootInode)
  await expect(f.prepare()).rejects.toMatchObject({ outcome: 'not-published', cause: {
    message: 'Retained Session environment directory identity changed.' } })
  expect(existsSync(join(original.rootPath, 'home'))).toBe(false)
  expect(readFileSync(f.sessionPathFor(), 'utf8')).toBe(saved)
  expect(Atomics.load(f.counters, 5)).toBe(1)
  await expect(f.prepare('session-B')).rejects.toMatchObject({ outcome: 'not-published' })
})
