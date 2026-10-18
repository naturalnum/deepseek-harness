/** Real native Loader/JSONL/StorageDomain, with a TEST ONLY Node-backed files worker transport. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import Storage, { storageBackendServiceKey, type StorageBackend, type KvUnit } from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WorkspaceDirectoryMetadataError, WorkspaceId, type WorkspaceDirectoryMetadata } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool, type IsolatedLeafGrant } from '../src/worker-pool.ts'
import { directoryWorkBudget } from '../src/directory-budget.ts'
import type { ControlledWorkspaceRegistry } from '../src/workspace-adapter.ts'

function committed(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'workspaceIds' in value
    && Array.isArray(value.workspaceIds) && value.workspaceIds.length > 0
    && (!('pendingMutation' in value) || value.pendingMutation === undefined)
}

async function fixture(mode = 'normal', waitTimeoutMs = 3000) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'm7c-files-')))
  const projects = join(home, 'projects'), storageRoot = join(home, 'storage'), sessionsRoot = join(home, 'sessions')
  mkdirSync(projects)
  const info = statSync(projects, { bigint: true })
  const root = Object.freeze({ rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino) })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: 'A' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'test-only-unpublished', lifetime: lifetime.signal })
  let current = true, unpublished = true
  const assertCurrent = () => { if (!current || lifetime.signal.aborted) throw new Error('test graph is stale') }
  const assertWindow = () => { assertCurrent(); if (!unpublished) throw new Error('test registration window closed') }
  // Namespace protection remains valid after publication; it does not grant another native registration window.
  const assertExclusive = () => { assertCurrent() }
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = []
  const budget = directoryWorkBudget({ parent: root, leaf: randomUUID() }, { maxPathBytes: 256, replyOverheadBytes: 32 })
  const pool = new LinuxFilesPool({
    maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 1, maxQueuedPerLane: 1,
    maxResidentBytes: budget.totalBytes + 128, maxResidentBytesPerLane: budget.totalBytes, waitTimeoutMs,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 32,
    readyTimeoutMs: 2000, drainTimeoutMs: 10, helperPath: '/test-only/not-loaded.node',
    maxReadBytes: 32, maxPathBytes: 256, maxResolveRetries: 2, readChunkBytes: 2,
  }, () => {
    const worker = new Worker(new URL('./fixtures/workspace-worker.mjs', import.meta.url), { workerData: { mode, gate } })
    workers.push(worker)
    return worker
  })
  const roots: Context[] = []
  onTestFinished(async () => {
    Atomics.store(counters, 5, 1); Atomics.notify(counters, 5)
    try {
      for (const ctx of roots) await ctx.fiber.dispose()
      await pool.stop(Date.now() + 20)
      await Promise.all(workers.map(worker => worker.terminate()))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await pool.start()
  const bound = pool.bind(binding, root, assertCurrent)
  const grant = (leaf: string): IsolatedLeafGrant => Object.freeze({ backend: 'root-owned-isolated-linux-tmpfs',
    binding, parent: root, leaf, assertExclusive })
  const defaultGrant = grant('default-workspace')
  const Registry = bound.createWorkspaceRegistry(defaultGrant, assertWindow)
  let beforeRecord: ((table: string, key: string) => Promise<void>) | undefined
  let afterCommit: (() => Promise<void>) | undefined
  // Faults/gates wrap the public backend interface; every successful write still uses the original JSON medium.
  const controlledJson = { name: 'test-json', inject: ['storage'], apply(ctx: Context) {
    const original = new JsonStorage.JsonStorageBackend(storageRoot)
    const backend: StorageBackend = {
      kv: { open: async (descriptor) => {
        const unit = await original.kv.open(descriptor)
        const wrapped: KvUnit = {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => { await beforeRecord?.(table, key); await unit.putRecord(table, key, value) },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: async (value) => { await unit.setGlobal(value); if (committed(value)) await afterCommit?.() },
          close: () => unit.close(),
        }
        return wrapped
      } },
      close: () => original.close(),
    }
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register('json', backend)
      return async () => { unregister(); await backend.close() }
    })
    ctx.provide(storageBackendServiceKey('json'), backend)
  } }
  let generation = 0
  const start = async (options: { binding?: AccountBinding; registry?: boolean } = {}) => {
    let provider: WorkspaceDirectoryMetadata | undefined
    let selections = 0
    class ObservedRegistry extends Registry {
      protected override createDirectoryMetadata(): WorkspaceDirectoryMetadata | undefined {
        provider = super.createDirectoryMetadata()
        selections++
        return provider
      }
    }
    const config = join(home, `cordis-${++generation}.yml`)
    writeFileSync(config, JSON.stringify([
      { id: 'sessions', name: 'cordis:m7c-sessions' }, { id: 'storage', name: 'cordis:m7c-storage' },
      { id: 'json', name: 'cordis:m7c-json' }, { id: 'domain', name: 'cordis:m7c-domain', config: { backend: 'json' } },
      { id: 'jsonl', name: 'cordis:m7c-jsonl', config: { root: sessionsRoot, compression: 'none' } },
      ...options.registry === false ? [] : [{ id: 'workspace', name: 'cordis:m7c-workspace' }],
    ]))
    const ctx = await boot('m7c-files', config, [], (rootContext) => {
      roots.push(rootContext)
      rootContext.provide('peAccount', options.binding ?? binding)
      Object.assign(rootContext.loader.builtins, { 'm7c-sessions': SessionStore, 'm7c-storage': Storage,
        'm7c-json': controlledJson, 'm7c-domain': DomainStorage, 'm7c-jsonl': Jsonl, 'm7c-workspace': ObservedRegistry })
    })
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'workspace')
    return { ctx, entry, registry(): ControlledWorkspaceRegistry {
      const instance = ctx.get('workspaceRegistry')
      if (instance === undefined || !(instance instanceof Registry)) throw new Error('test registry absent')
      return instance
    }, metadata(): WorkspaceDirectoryMetadata {
      if (provider === undefined) throw new Error('test metadata was not selected')
      return provider
    }, selections: () => selections, close: () => ctx.fiber.dispose() }
  }
  return { home, projects, storageRoot, sessionsRoot, pool, bound, binding, defaultGrant, grant, start, counters,
    setBeforeRecord: (callback?: (table: string, key: string) => Promise<void>) => { beforeRecord = callback },
    setAfterCommit: (callback?: () => Promise<void>) => { afterCommit = callback },
    closeWindow: () => { unpublished = false }, restoreWindow: () => { unpublished = true },
    stale: () => { current = false }, workers,
  }
}

async function persistSession(ctx: Context, id: SessionId, cwd: string): Promise<void> {
  const prepared = ctx.sessions.prepare(id, { meta: { cwd } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  try { await handle.flush() } finally { await handle.close() }
  await ctx.sessionPersistence.flush()
}

it('uses one lane through actual default persistence, repeats and cold restore without recreating its directory', async () => {
  const test = await fixture(), graph = await test.start()
  expect(graph.entry?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(graph.ctx.get('peAccount')).toBe(test.binding)
  const workspace = await graph.registry().initializeDefault(async () => { throw new Error('desktop resolver must not run') })
  expect(workspace?.path).toBe(join(test.projects, 'default-workspace'))
  expect(workspace?.title).toBe('default-workspace')
  expect(test.pool.inspect().work).toMatchObject({ lanes: 1, running: 0, residentBytes: 0, pending: 0 })
  expect(existsSync(workspace!.path)).toBe(true)
  const preparations = Atomics.load(test.counters, 0)
  expect(preparations).toBe(1)
  expect(await graph.registry().initializeDefault(async () => 'unused')).toBe(workspace)
  const id = SessionId('default-real-jsonl')
  await persistSession(graph.ctx, id, workspace!.path)
  await workspace!.attachSession(id)
  expect(await workspace!.status()).toBe('ok')
  expect(await graph.registry().resolveByPath(workspace!.path)).toBe(workspace)
  await graph.close()
  const cold = await test.start()
  expect(cold.registry().get(workspace!.id)?.sessionIds).toEqual([id])
  expect((await cold.registry().initializeDefault(async () => 'unused'))?.id).toBe(workspace!.id)
  expect(Atomics.load(test.counters, 0)).toBe(preparations)
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
  await cold.registry().delete(workspace!.id)
  await cold.close()
  const deleted = await test.start()
  expect(await deleted.registry().initializeDefault(async () => 'unused')).toBeUndefined()
  expect(Atomics.load(test.counters, 0)).toBe(preparations)
  expect(existsSync(workspace!.path)).toBe(true)
  expect(test.workers).toHaveLength(1)
})

it('transfers server UUID projects without retaining dynamic tickets and refreshes later native persisted-only headers', async () => {
  const test = await fixture(), graph = await test.start()
  for (let index = 0; index < 8; index++) {
    const leaf = randomUUID(), candidate = test.grant(leaf)
    const workspace = await graph.registry().createProject(candidate, `client/title/${index}`)
    expect(workspace.path).toBe(join(test.projects, leaf))
    expect(workspace.title).toBe(`client/title/${index}`)
    expect(existsSync(workspace.path)).toBe(true)
    expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
  }
  const discovered = graph.registry().list()[0]!
  const cwd = discovered.path
  const beforeIndex = Atomics.load(test.counters, 1)
  const id = SessionId('later-cache-miss-header')
  await persistSession(graph.ctx, id, cwd)
  await graph.registry().pinSession(id)
  expect(Atomics.load(test.counters, 1)).toBeGreaterThan(beforeIndex)
  await discovered.attachSession(id)
  expect(discovered.sessionIds).toEqual([id])
  expect(await discovered.status()).toBe('ok')
  expect(Atomics.load(test.counters, 0)).toBe(8)
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
})

it('keeps Rdir while a native early entity exists and transfers only after the actual durable return', async () => {
  const test = await fixture(), graph = await test.start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  test.setBeforeRecord(async (_table, key) => {
    // Native get exposes this exact entity before the durable write; it must not release Rdir.
    expect(graph.registry().get(WorkspaceId(key))).toBeDefined()
    entered.resolve(undefined)
    await release.promise
  })
  const pending = graph.registry().createProject(test.grant(randomUUID()))
  await entered.promise
  expect(graph.registry().list()).toEqual([])
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 1 })
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(0)
  release.resolve(undefined)
  const workspace = await pending
  expect(graph.registry().get(workspace.id)).toBe(workspace)
  expect(readFileSync(join(test.storageRoot, 'workspace.json'), 'utf8')).toContain(workspace.id)
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
})

it('holds an unchanged default responsibility until native completion and gives ordinary create no mkdir authority', async () => {
  const test = await fixture(), graph = await test.start()
  mkdirSync(join(test.projects, 'default-workspace'))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  test.setBeforeRecord(async () => { entered.resolve(undefined); await release.promise })
  const pending = graph.registry().initializeDefault(async () => 'unused')
  await entered.promise
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 1 })
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(0)
  release.resolve(undefined)
  const workspace = await pending
  expect(workspace?.path).toBe(join(test.projects, 'default-workspace'))
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
  const missing = join(test.projects, randomUUID())
  await expect(graph.registry().create(missing)).rejects.toMatchObject({ reason: 'missing' })
  await expect(graph.registry().resolveByPath(join(test.home, 'private'))).rejects.toMatchObject({ reason: 'unavailable' })
  expect(existsSync(missing)).toBe(false)
  expect(Atomics.load(test.counters, 0)).toBe(1)
})

it('keeps a timed-out native preparation unknown after its late successful actual reply', async () => {
  const test = await fixture('blocked-prepare', 100), graph = await test.start(), candidate = test.grant(randomUUID())
  const pending = graph.registry().createProject(candidate)
  await expect(pending).rejects.toMatchObject({ reason: 'unavailable' })
  expect(Atomics.load(test.counters, 4)).toBe(1)
  Atomics.store(test.counters, 5, 1); Atomics.notify(test.counters, 5)
  await vi.waitFor(() => { expect(test.pool.inspect().work.running).toBe(0) })
  const work = test.bound.derivePreparedLeaf(candidate).prepare()
  await expect(work.observation.waitPrepared()).rejects.toThrow()
  await expect(work.control.cleanup()).rejects.toThrow()
  expect(test.pool.inspect().work).toMatchObject({ pending: 1 })
  expect(graph.registry().list()).toEqual([])
  expect(Atomics.load(test.counters, 3)).toBe(0)
})

it('does not transfer or clean after the native second history check returns undefined', async () => {
  const test = await fixture('blocked-prepare'), graph = await test.start()
  const pending = graph.registry().initializeDefault(async () => 'unused')
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 4)).toBe(1) })
  await persistSession(graph.ctx, SessionId('racing-real-header'), join(test.projects, 'default-workspace'))
  Atomics.store(test.counters, 5, 1); Atomics.notify(test.counters, 5)
  expect(await pending).toBeUndefined()
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 1 })
  const original = test.bound.derivePreparedLeaf(test.defaultGrant).prepare()
  await expect(original.control.cleanup()).rejects.toThrow()
  expect(Object.keys(original.control).sort()).toEqual(['cleanup', 'expose'])
  expect(Atomics.load(test.counters, 3)).toBe(0)
  expect((await test.pool.stopEpoch(test.binding, Date.now())).status).toBe('unknown')
})

it('retains unknown on an actual native JSON record-write rejection and never swaps the candidate', async () => {
  const test = await fixture(), graph = await test.start(), candidate = test.grant(randomUUID())
  const failure = new Error('test public JSON write rejection')
  test.setBeforeRecord(async () => { throw failure })
  await expect(graph.registry().createProject(candidate)).rejects.toBe(failure)
  expect(graph.registry().list()).toEqual([])
  expect(existsSync(join(test.projects, candidate.leaf))).toBe(true)
  const work = test.bound.derivePreparedLeaf(candidate).prepare()
  await expect(work.observation.waitPrepared()).rejects.toThrow()
  await expect(work.control.cleanup()).rejects.toThrow()
  await expect(graph.registry().createProject(candidate)).rejects.toThrow()
  expect(Atomics.load(test.counters, 0)).toBe(1)
  expect(Atomics.load(test.counters, 3)).toBe(0)
  expect(test.pool.inspect().work).toMatchObject({ pending: 1 })
})

it.each(['window', 'candidate-window', 'generation', 'identity-change'])('retains unknown after durable registration when %s verification fails', async (mode) => {
  const test = await fixture(mode), graph = await test.start()
  let candidateWindow = true
  const candidate: IsolatedLeafGrant = Object.freeze({ ...test.grant(randomUUID()), assertExclusive: () => {
    if (!candidateWindow) throw new Error('test candidate window closed')
  } })
  if (mode !== 'identity-change') test.setAfterCommit(async () => {
    if (mode === 'window') test.closeWindow()
    else if (mode === 'candidate-window') candidateWindow = false
    else test.stale()
  })
  await expect(graph.registry().createProject(candidate)).rejects.toThrow()
  expect(graph.registry().list()).toHaveLength(1)
  expect(existsSync(join(test.projects, candidate.leaf))).toBe(true)
  test.restoreWindow()
  candidateWindow = true
  if (mode !== 'generation') {
    const work = test.bound.derivePreparedLeaf(candidate).prepare()
    await expect(work.observation.waitPrepared()).rejects.toThrow()
    await expect(work.control.cleanup()).rejects.toThrow()
  }
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 1 })
  expect(Atomics.load(test.counters, 3)).toBe(0)
})

it('never recovers post-create parent verification into native registration or cleanup', async () => {
  const test = await fixture('parent-failure'), graph = await test.start(), candidate = test.grant(randomUUID())
  await expect(graph.registry().createProject(candidate)).rejects.toMatchObject({ reason: 'unavailable' })
  test.closeWindow(); test.restoreWindow()
  expect(await test.bound.directory.isDirectory(join(test.projects, candidate.leaf))).toBe(true)
  const work = test.bound.derivePreparedLeaf(candidate).prepare()
  await expect(work.control.cleanup()).rejects.toThrow()
  expect(graph.registry().list()).toEqual([])
  expect(Atomics.load(test.counters, 3)).toBe(0)
  expect(test.pool.inspect().work).toMatchObject({ pending: 1 })
})

it('rejects an A adapter mounted with B or a copied binding before Workspace storage or files effects', async () => {
  const test = await fixture()
  const wrong = Object.freeze({ ...test.binding, accountId: 'B' as AccountId })
  const graph = await test.start({ binding: wrong })
  expect(graph.entry?.fiber?.state).toBe(FiberState.FAILED)
  await expect(graph.entry!.fiber!.await()).rejects.toBeInstanceOf(WorkspaceDirectoryMetadataError)
  expect(Atomics.load(test.counters, 0)).toBe(0)
  expect(Atomics.load(test.counters, 1)).toBe(0)
  expect(Atomics.load(test.counters, 2)).toBe(0)
  expect(existsSync(join(test.storageRoot, 'workspace.json'))).toBe(false)
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
  await graph.close()
  const copied = await test.start({ binding: Object.freeze({ ...test.binding }) })
  expect(copied.entry?.fiber?.state).toBe(FiberState.FAILED)
  await expect(copied.entry!.fiber!.await()).rejects.toBeInstanceOf(WorkspaceDirectoryMetadataError)
  expect(Atomics.load(test.counters, 1)).toBe(0)
})

it('retains unknown when the actual native Registry fiber closes after the durable write', async () => {
  const test = await fixture(), graph = await test.start(), registry = graph.registry(), candidate = test.grant(randomUUID())
  let disposal: Promise<void> | undefined
  test.setAfterCommit(async () => { disposal = graph.close() })
  await expect(registry.createProject(candidate)).rejects.toMatchObject({ reason: 'unavailable' })
  await disposal
  expect(registry.list()).toHaveLength(1)
  expect(existsSync(join(test.projects, candidate.leaf))).toBe(true)
  const work = test.bound.derivePreparedLeaf(candidate).prepare()
  await expect(work.control.cleanup()).rejects.toThrow()
  expect(test.pool.inspect().work).toMatchObject({ pending: 1 })
  expect(Atomics.load(test.counters, 3)).toBe(0)
})

it('rejects an A adapter in a B root even when the child service scope provides the exact A binding', async () => {
  const test = await fixture()
  const wrong = Object.freeze({ ...test.binding, accountId: 'B' as AccountId })
  const graph = await test.start({ binding: wrong, registry: false })
  const Registry = test.bound.createWorkspaceRegistry(test.defaultGrant, () => {})
  const child = graph.ctx.isolate('peAccount')
  child.provide('peAccount', test.binding)
  let failure: unknown
  await child.plugin({ name: 'foreign-workspace-scope', inject: ['peAccount'], apply(ctx: Context) {
    expect(ctx.get('peAccount')).toBe(test.binding)
    expect(ctx.root.get('peAccount')).toBe(wrong)
    try { new Registry(ctx) } catch (error) { failure = error }
  } })
  expect(failure).toBeInstanceOf(WorkspaceDirectoryMetadataError)
  expect(Atomics.load(test.counters, 0)).toBe(0)
  expect(Atomics.load(test.counters, 1)).toBe(0)
  expect(Atomics.load(test.counters, 2)).toBe(0)
  expect(existsSync(join(test.storageRoot, 'workspace.json'))).toBe(false)
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
})

it('keeps native metadata and Session consumers usable after the registration window permanently closes', async () => {
  const test = await fixture(), graph = await test.start(), registry = graph.registry()
  const workspace = await registry.initializeDefault(async () => { throw new Error('desktop resolver must not run') })
  if (workspace === undefined) throw new Error('default Workspace absent')
  const fixed = graph.metadata(), beforePrepare = Atomics.load(test.counters, 0)
  test.closeWindow()
  expect(await fixed.canonicalPath(workspace.path)).toBe(workspace.path)
  expect(await fixed.isDirectory(workspace.path)).toBe(true)
  expect(await workspace.status()).toBe('ok')
  expect(await registry.resolveByPath(workspace.path)).toBe(workspace)
  expect(await registry.initializeDefault(async () => { throw new Error('existing default must not resolve again') })).toBe(workspace)

  const attached = SessionId('after-window-close-attached')
  await persistSession(graph.ctx, attached, workspace.path)
  await workspace.attachSession(attached)
  expect(workspace.sessionIds).toEqual([attached])
  const later = SessionId('after-window-close-indexed'), beforeIndex = Atomics.load(test.counters, 1)
  await persistSession(graph.ctx, later, workspace.path)
  await registry.pinSession(later)
  expect(Atomics.load(test.counters, 1)).toBeGreaterThan(beforeIndex)
  await workspace.attachSession(later)
  expect(workspace.sessionIds).toEqual([later, attached])
  expect(graph.metadata()).toBe(fixed)
  expect(graph.selections()).toBe(1)

  const candidate = test.grant(randomUUID()), path = join(test.projects, candidate.leaf)
  await expect(registry.createProject(candidate)).rejects.toThrow('registration window closed')
  await expect(fixed.ensureDirectory(workspace.path)).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(fixed.ensureDirectory(path)).rejects.toMatchObject({ reason: 'unavailable' })
  expect(existsSync(path)).toBe(false)
  expect(Atomics.load(test.counters, 0)).toBe(beforePrepare)
  expect(test.pool.inspect().work).toMatchObject({ lanes: 1, running: 0, residentBytes: 0, pending: 0 })

  await registry.delete(workspace.id)
  expect(await registry.initializeDefault(async () => { throw new Error('deleted default must not resolve') })).toBeUndefined()
  expect(Atomics.load(test.counters, 0)).toBe(beforePrepare)
  expect(existsSync(workspace.path)).toBe(true)
  expect(test.workers).toHaveLength(1)
})

it('requires the registration window only when the real native default resolver is eligible', async () => {
  const test = await fixture(), graph = await test.start(), registry = graph.registry()
  test.closeWindow()
  await expect(registry.initializeDefault(async () => { throw new Error('desktop resolver must not run') }))
    .rejects.toThrow('registration window closed')
  expect(registry.list()).toEqual([])
  expect(existsSync(join(test.projects, 'default-workspace'))).toBe(false)
  expect(Atomics.load(test.counters, 0)).toBe(0)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })

  await persistSession(graph.ctx, SessionId('history-prevents-default-after-close'), join(test.projects, 'default-workspace'))
  expect(await registry.initializeDefault(async () => { throw new Error('ineligible native default must not resolve') })).toBeUndefined()
  expect(Atomics.load(test.counters, 0)).toBe(0)
  expect(Atomics.load(test.counters, 1)).toBe(0)
  expect(test.pool.inspect().work).toMatchObject({ residentBytes: 0, pending: 0 })
})

it('rejects all directory consumers after current-generation validity ends without dispatching more files work', async () => {
  const test = await fixture(), graph = await test.start(), registry = graph.registry()
  const workspace = await registry.initializeDefault(async () => 'unused')
  if (workspace === undefined) throw new Error('default Workspace absent')
  const id = SessionId('uncached-after-current-end')
  await persistSession(graph.ctx, id, workspace.path)
  test.closeWindow()
  const before = [...test.counters]
  test.stale()
  await expect(graph.metadata().canonicalPath(workspace.path)).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(graph.metadata().isDirectory(workspace.path)).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(workspace.status()).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(registry.resolveByPath(workspace.path)).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(workspace.attachSession(id)).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(registry.pinSession(id)).rejects.toMatchObject({ reason: 'unavailable' })
  await expect(registry.initializeDefault(async () => 'unused')).rejects.toThrow('graph is stale')
  await expect(graph.metadata().ensureDirectory(workspace.path)).rejects.toMatchObject({ reason: 'unavailable' })
  expect(workspace.sessionIds).toEqual([])
  expect([...test.counters]).toEqual(before)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
})

it('does not recover unknown responsibility when ready-phase metadata reads succeed', async () => {
  const test = await fixture(), graph = await test.start(), registry = graph.registry(), candidate = test.grant(randomUUID())
  test.setAfterCommit(async () => { test.closeWindow() })
  await expect(registry.createProject(candidate)).rejects.toThrow('registration window closed')
  const workspace = registry.list()[0]
  if (workspace === undefined) throw new Error('durably committed Workspace absent')
  const original = test.bound.derivePreparedLeaf(candidate).prepare()
  const retained = test.pool.inspect().work.residentBytes
  expect(retained).toBeGreaterThan(0)
  expect(await graph.metadata().canonicalPath(workspace.path)).toBe(workspace.path)
  expect(await graph.metadata().isDirectory(workspace.path)).toBe(true)
  expect(await workspace.status()).toBe('ok')
  expect(await registry.resolveByPath(workspace.path)).toBe(workspace)
  await expect(original.observation.waitPrepared()).rejects.toThrow()
  await expect(original.control.cleanup()).rejects.toThrow()
  await expect(registry.createProject(candidate)).rejects.toThrow('registration window closed')
  expect(test.bound.derivePreparedLeaf(candidate).prepare().observation.id).toBe(original.observation.id)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: retained, pending: 1 })
  expect(Atomics.load(test.counters, 0)).toBe(1)
  expect(Atomics.load(test.counters, 3)).toBe(0)
})

it('rechecks current validity after a queued native default lookup returns an existing Workspace', async () => {
  const test = await fixture(), graph = await test.start(), registry = graph.registry()
  const workspace = await registry.initializeDefault(async () => 'unused')
  if (workspace === undefined) throw new Error('default Workspace absent')
  const id = SessionId('native-queue-before-default-lookup')
  await persistSession(graph.ctx, id, workspace.path)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  test.setAfterCommit(async () => { entered.resolve(undefined); await release.promise })
  test.closeWindow()
  const pin = registry.pinSession(id)
  await entered.promise
  const pending = registry.initializeDefault(async () => { throw new Error('existing default must not resolve') })
  const rejected = expect(pending).rejects.toThrow('graph is stale')
  test.stale()
  release.resolve(undefined)
  await pin
  await rejected
  expect(Atomics.load(test.counters, 0)).toBe(1)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
})
