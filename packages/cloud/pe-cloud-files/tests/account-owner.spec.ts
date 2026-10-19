/** Real native Loader/StorageDomain/JSONL; the frozen Node worker fixture proves no Linux or deployment facts. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import FileSystem from '@deepseek-ai/dsh-fs'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CloudAccountFiles, type AccountFilesPreparation } from '../src/account-service.ts'
import * as AccountEntry from '../src/account.ts'
import { LinuxFilesPool, type IsolatedLeafGrant } from '../src/worker-pool.ts'
import { directoryWorkBudget } from '../src/directory-budget.ts'

async function fixture(mode = 'normal') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'm8r-files-owner-')))
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = [], roots: Context[] = []
  const budget = directoryWorkBudget({ parent: { rootPath: join(home, 'A', 'projects'), rootDevice: '1', rootInode: '2' },
    leaf: 'default-workspace' }, { maxPathBytes: 256, replyOverheadBytes: 32 })
  const pool = new LinuxFilesPool({ maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
    maxResidentBytes: 3 * budget.totalBytes + 128, maxResidentBytesPerLane: budget.totalBytes, waitTimeoutMs: 5000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 32,
    readyTimeoutMs: 2000, drainTimeoutMs: 10, helperPath: '/test-only/not-loaded.node',
    maxReadBytes: 32, maxPathBytes: 256, maxResolveRetries: 2, readChunkBytes: 2,
  }, () => {
    const worker = new Worker(new URL('./fixtures/workspace-worker.mjs', import.meta.url), { workerData: { gate, mode } })
    workers.push(worker)
    return worker
  })
  onTestFinished(async () => {
    Atomics.store(counters, 5, 1); Atomics.notify(counters, 5)
    try {
      for (const root of roots.toReversed()) await root.fiber.dispose()
      await pool.stop(Date.now() + 20)
      await Promise.all(workers.map(worker => worker.terminate()))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await pool.start()
  const prepare = (name: string) => {
    const dir = join(home, name), projects = join(dir, 'projects')
    mkdirSync(projects, { recursive: true })
    const info = statSync(projects, { bigint: true })
    const root = Object.freeze({ rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino) })
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({ accountId: name as AccountId, epoch: '1' as OwnerEpoch,
      recipeVersion: 'test-only-m8r', lifetime: lifetime.signal })
    let current = true, unpublished = true
    const assertMountCurrent = (actual: AccountBinding): void => {
      if (actual !== binding || !current || lifetime.signal.aborted) throw new Error('test graph no longer current')
    }
    const assertUnpublished = (): void => { assertMountCurrent(binding); if (!unpublished) throw new Error('test window closed') }
    const port = pool.bind(binding, root, () => { assertMountCurrent(binding) })
    const defaultGrant: IsolatedLeafGrant = Object.freeze({ binding, parent: root, leaf: 'default-workspace',
      backend: 'root-owned-isolated-linux-tmpfs', assertExclusive: () => { assertMountCurrent(binding) } })
    const input: AccountFilesPreparation = { binding, port, defaultGrant, assertMountCurrent, assertUnpublished }
    let owner: CloudAccountFiles | undefined, context: Context | undefined
    const start = async (options: {
      missingOwner?: boolean
      duplicateEntry?: boolean
      priorRegistry?: boolean
      createFileSystem?: AccountFilesPreparation['createFileSystem']
    } = {}) => {
      const configPath = join(dir, 'cordis.yml')
      writeFileSync(configPath, JSON.stringify([
        { id: 'sessions', name: 'cordis:m8r-sessions' }, { id: 'storage', name: 'cordis:m8r-storage' },
        { id: 'json', name: 'cordis:m8r-json', config: { root: join(dir, 'storage') } },
        { id: 'domain', name: 'cordis:m8r-domain', config: { backend: 'json' } },
        { id: 'jsonl', name: 'cordis:m8r-jsonl', config: { root: join(dir, 'sessions'), compression: 'none' } },
        ...options.priorRegistry ? [{ id: 'prior-registry', name: 'cordis:m8r-native-registry' }] : [],
        { id: 'files', name: 'cordis:m8r-account', config: {} },
        ...options.duplicateEntry ? [{ id: 'files-duplicate', name: 'cordis:m8r-account', config: {} }] : [],
      ]))
      const ctx = await boot('m8r-files-' + name, configPath, [], (scope) => {
        context = scope; roots.push(scope)
        scope.provide('peAccount', binding)
        if (!options.missingOwner) owner = new CloudAccountFiles(scope, {
          ...input, ...options.createFileSystem === undefined ? {} : { createFileSystem: options.createFileSystem },
        })
        Object.assign(scope.loader.builtins, { 'm8r-sessions': SessionStore, 'm8r-storage': Storage,
          'm8r-json': JsonStorage, 'm8r-domain': DomainStorage, 'm8r-jsonl': Jsonl,
          'm8r-native-registry': WorkspaceRegistry, 'm8r-account': AccountEntry })
      })
      const entry = [...ctx.loader.entries()].find(row => row.options.id === 'files')
      return { ctx, entry, owner: () => {
        if (owner === undefined) throw new Error('test files owner absent')
        return owner
      } }
    }
    return { start, projects, binding, input, lifetime, owner: () => owner, context: () => context,
      closeWindow: () => { unpublished = false }, stale: () => { current = false } }
  }
  return { prepare, pool, workers, counters, unblock: () => { Atomics.store(counters, 5, 1); Atomics.notify(counters, 5) } }
}

it('installs real native Registry and FS through files/account before returning the actual default project', async () => {
  const f = await fixture(), account = f.prepare('A'), graph = await account.start()
  expect(graph.entry?.fiber?.state).toBe(FiberState.ACTIVE)
  const files = graph.ctx.get('peCloudFiles')
  expect(files).toBeInstanceOf(CloudAccountFiles)
  const project = files!.project()
  expect(project.binding).toBe(account.binding)
  expect(project.projectDirectory.binding).toBe(account.binding)
  expect(graph.ctx.get('workspaceRegistry')).toBeInstanceOf(WorkspaceRegistry)
  expect(graph.ctx.get('workspaceRegistry')?.get(project.workspace.id)).toBe(project.workspace)
  expect(graph.ctx.get('fs')).toBeInstanceOf(FileSystem)
  expect(project.workspace.path).toBe(join(account.projects, 'default-workspace'))
  expect(existsSync(project.workspace.path)).toBe(true)
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect(f.pool.inspect().work).toMatchObject({ lanes: 1, running: 0, pending: 0, residentBytes: 0 })
  account.closeWindow()
  await project.projectDirectory.prepare(project.workspace.path)
  const target = await graph.ctx.fs.resolve('.')
  expect((await graph.ctx.fs.stat(target))?.type).toBe('directory')
  expect(graph.ctx.fs.processPath(target)).toBe(project.workspace.path)
  await expect(graph.ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(files!.project()).toBe(project)
  const first = files!.install(graph.entry!.fiber!.ctx), repeat = graph.owner().install(graph.entry!.fiber!.ctx)
  expect(first).toBe(repeat)
  expect(await repeat).toBe(project)
  expect(f.workers).toHaveLength(1)
})

it('keeps one native installation owner and rejects another graph, duplicate preparation and duplicate entry', async () => {
  const f = await fixture(), a = f.prepare('A'), ga = await a.start()
  const b = f.prepare('B'), gb = await b.start()
  expect(() => new CloudAccountFiles(ga.ctx, a.input)).toThrow('already has a files owner')
  expect(() => { ga.owner().assertInstalled(gb.ctx) }).toThrow()
  expect(() => ga.owner().install(gb.ctx)).toThrow()
  expect(() => ga.owner().install(ga.ctx)).toThrow('entry fiber')
  const shadow = ga.ctx.isolate('peCloudFiles')
  shadow.provide('peCloudFiles', gb.owner())
  expect(() => { ga.owner().assertInstalled(shadow) }).toThrow()
  const c = f.prepare('C'), gc = await c.start({ duplicateEntry: true })
  const duplicate = [...gc.ctx.loader.entries()].find(row => row.options.id === 'files-duplicate')
  await expect(duplicate?.fiber?.await()).rejects.toThrow('installation fiber')
  expect(gc.entry?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(Atomics.load(f.counters, 0)).toBe(3)
  expect(f.workers).toHaveLength(1)
})

it('prepares the actual Registry and refuses a fallback FS when selected provider preparation fails', async () => {
  const f = await fixture(), account = f.prepare('A')
  const rejected = new Error('selected backend unavailable')
  let selected = 0
  const graph = await account.start({ createFileSystem: async (workspace, assertInstalled) => {
    selected++
    const owner = account.context()
    if (owner === undefined) throw new Error('Missing actual prepared graph')
    assertInstalled(owner)
    expect(owner.get('workspaceRegistry')?.get(workspace.id)).toBe(workspace)
    expect(owner.get('fs')).toBeUndefined()
    throw rejected
  } })
  await expect(graph.entry?.fiber?.await()).rejects.toBe(rejected)
  expect(selected).toBe(1)
  expect(graph.ctx.get('workspaceRegistry')).toBeUndefined()
  expect(graph.ctx.get('fs')).toBeUndefined()
  expect(() => graph.owner().project()).toThrow('not completed')
})

it('rejects an unprepared native entry and nonempty Loader configuration without a filesystem', async () => {
  const f = await fixture(), account = f.prepare('A'), graph = await account.start({ missingOwner: true })
  await expect(graph.entry?.fiber?.await()).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
  expect(graph.ctx.get('fs', false)).toBeUndefined()
  expect(graph.ctx.get('workspaceRegistry', false)).toBeUndefined()
  expect(() => AccountEntry.Config({ path: account.projects })).toThrow('must be empty')
  expect(() => AccountEntry.apply(graph.ctx, { binding: account.binding })).toThrow('must be empty')
  expect(Atomics.load(f.counters, 0)).toBe(0)
})

it('refuses a preexisting actual native Registry instead of substituting its own or creating another default', async () => {
  const f = await fixture(), account = f.prepare('A'), graph = await account.start({ priorRegistry: true })
  await expect(graph.entry?.fiber?.await()).rejects.toThrow('sole native Registry')
  expect(graph.ctx.get('workspaceRegistry')).toBeInstanceOf(WorkspaceRegistry)
  expect(graph.ctx.get('fs', false)).toBeUndefined()
  expect(() => graph.owner().project()).toThrow('has not completed')
  expect(Atomics.load(f.counters, 0)).toBe(0)
})

it('retains unknown directory responsibility on actual preparation failure and never publishes a partial project', async () => {
  const f = await fixture('parent-failure'), account = f.prepare('A'), graph = await account.start()
  await expect(graph.entry?.fiber?.await()).rejects.toThrow()
  expect(() => graph.owner().project()).toThrow('has not completed')
  expect(graph.ctx.get('fs', false)).toBeUndefined()
  expect(existsSync(join(account.projects, 'default-workspace'))).toBe(true)
  expect(f.pool.inspect().work.pending).toBeGreaterThan(0)
  expect(Atomics.load(f.counters, 3)).toBe(0)
  const receipt = await f.pool.stopEpoch(account.binding, Date.now() + 10)
  expect(receipt.status).toBe('unknown')
})

it('keeps the actual pending installation and rechecks a closed registration window after await', async () => {
  const f = await fixture('blocked-prepare'), account = f.prepare('A'), booting = account.start()
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 4)).toBe(1) })
  const owner = account.owner(), ctx = account.context()
  expect(owner).toBeInstanceOf(CloudAccountFiles)
  expect(() => owner!.project()).toThrow('has not completed')
  expect(f.pool.inspect().work.running).toBe(1)
  account.closeWindow()
  f.unblock()
  const graph = await booting
  await expect(graph.entry?.fiber?.await()).rejects.toThrow()
  expect(ctx?.get('fs', false)).toBeUndefined()
  expect(() => owner!.project()).toThrow('has not completed')
  expect(f.pool.inspect().work.pending).toBeGreaterThan(0)
  expect(Atomics.load(f.counters, 3)).toBe(0)
})

it('revokes installed outputs on native FS disposal while another account keeps using the shared workers', async () => {
  const f = await fixture(), a = f.prepare('A'), ga = await a.start(), b = f.prepare('B'), gb = await b.start()
  const pa = ga.owner().project(), pb = gb.owner().project()
  const runtime = [...ga.ctx.registry.values()].find(row => row.name === 'ProjectFileSystem')
  expect(runtime?.fibers).toHaveLength(1)
  await runtime!.fibers[Symbol.iterator]().next().value!.dispose()
  expect(() => ga.owner().project()).toThrow('filesystem is inactive')
  await expect(pa.projectDirectory.prepare(pa.workspace.path)).rejects.toThrow('filesystem is inactive')
  await pb.projectDirectory.prepare(pb.workspace.path)
  await ga.entry?.fiber?.dispose()
  expect(ga.ctx.get('workspaceRegistry', false)).toBeUndefined()
  expect(ga.ctx.get('fs', false)).toBeUndefined()
  expect(f.pool.inspect().healthy).toBe(1)
  expect(f.workers).toHaveLength(1)
  a.lifetime.abort()
  expect(() => ga.owner().project()).toThrow()
  await pb.projectDirectory.prepare(pb.workspace.path)
})

it('rejects publication when the exact lifetime ends after native FS activation', async () => {
  const f = await fixture(), account = f.prepare('A'), original = account.input.assertMountCurrent
  const check = vi.spyOn(account.input, 'assertMountCurrent').mockImplementation((binding) => {
    original(binding)
    if (account.context()?.get('fs') !== undefined) account.lifetime.abort()
  })
  const graph = await account.start()
  await expect(graph.entry?.fiber?.await()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(check).toHaveBeenCalled()
  expect(() => graph.owner().project()).toThrow()
  expect(existsSync(join(account.projects, 'default-workspace'))).toBe(true)
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect(Atomics.load(f.counters, 3)).toBe(0)
})

it('revokes the installed project after actual native default deletion without accepting another Workspace receipt', async () => {
  const f = await fixture(), account = f.prepare('A'), graph = await account.start()
  const project = graph.owner().project()
  await graph.ctx.get('workspaceRegistry')!.delete(project.workspace.id)
  expect(() => graph.owner().project()).toThrow('no longer current')
  await expect(project.projectDirectory.prepare(project.workspace.path)).rejects.toThrow('no longer current')
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect(Atomics.load(f.counters, 3)).toBe(0)
})

it('does not reuse a completed installation after its original native entry restarts', async () => {
  const f = await fixture(), account = f.prepare('A'), graph = await account.start()
  const project = graph.owner().project()
  await expect(graph.entry!.fiber!.restart()).rejects.toThrow('Registry is inactive')
  expect(graph.entry?.fiber?.state).toBe(FiberState.FAILED)
  expect(graph.ctx.get('fs', false)).toBeUndefined()
  expect(() => graph.owner().project()).toThrow()
  await expect(project.projectDirectory.prepare(project.workspace.path)).rejects.toThrow()
  expect(Atomics.load(f.counters, 0)).toBe(1)
  expect(Atomics.load(f.counters, 3)).toBe(0)
})
