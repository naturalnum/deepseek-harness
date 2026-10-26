/** Native Loader/Registry/FS consumers; worker I/O below is explicitly a TEST ONLY Node transport. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createTextProjectFileSystem } from '../src/text-project.ts'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import type { AccountFileSelection } from '../src/text-project.ts'
import type { FdContentLimits, FdWorkerInput } from '../src/worker-protocol.ts'

const contentLimits: FdContentLimits = Object.freeze({ maxEntries: 8, maxNameBytes: 64, maxReplyBytes: 8192, operationTimeoutMs: 3000 })

async function fixture(mode = 'normal', abiVersion = 7, waitTimeoutMs = 3000, content?: FdContentLimits) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'text-project-')))
  const projects = join(home, 'projects'), project = join(projects, 'default-workspace')
  mkdirSync(project, { recursive: true })
  const info = statSync(projects, { bigint: true })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: 'text-test' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'test-only-text-transport', lifetime: lifetime.signal })
  let current = true, installed = true
  const assertCurrent = (): void => { if (!current) throw new Error('test graph retired') }
  const gate = new SharedArrayBuffer(16), counters = new Int32Array(gate), workers: Worker[] = []
  const workerInputs: FdWorkerInput[] = []
  const pool = new LinuxFilesPool({
    maxLanes: 1, maxRunning: 2, maxRunningPerLane: 2, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: content === undefined ? 131072 : 1048576,
    maxResidentBytesPerLane: content === undefined ? 65536 : 524288, waitTimeoutMs,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 64,
    readyTimeoutMs: 2000, drainTimeoutMs: 20, helperPath: '/test-only/not-loaded.node',
    maxReadBytes: 64, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 2,
    ...content === undefined ? {} : { content },
  }, (input) => {
    workerInputs.push(input)
    const worker = new Worker(new URL('./fixtures/text-worker.mjs', import.meta.url),
      { workerData: { mode, gate, abiVersion: mode === 'content-mixed' && workerInputs.length === 2 ? 7 : abiVersion, content: input.content } })
    workers.push(worker)
    return worker
  })
  const contexts: Context[] = []
  onTestFinished(async () => {
    Atomics.store(counters, 2, 1); Atomics.notify(counters, 2)
    try {
      for (const ctx of contexts) await ctx.fiber.dispose()
      await pool.stop(Date.now() + 30)
      await Promise.all(workers.map(worker => worker.terminate()))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await pool.start()
  const port = pool.bind(binding, { rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino) }, assertCurrent)
  const config = join(home, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    { id: 'sessions', name: 'cordis:text-sessions' }, { id: 'storage', name: 'cordis:text-storage' },
    { id: 'json', name: 'cordis:text-json', config: { root: join(home, 'storage') } },
    { id: 'domain', name: 'cordis:text-domain', config: { backend: 'json' } },
    { id: 'jsonl', name: 'cordis:text-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'workspace', name: 'cordis:text-workspace' },
  ]))
  const graph = await boot('text-files-test', config, [], (root) => {
    contexts.push(root)
    root.provide('peAccount', binding)
    Object.assign(root.loader.builtins, { 'text-sessions': SessionStore, 'text-storage': Storage,
      'text-json': JsonStorage, 'text-domain': DomainStorage, 'text-jsonl': Jsonl, 'text-workspace': WorkspaceRegistry })
  })
  const workspace = await graph.workspaceRegistry.create(project)
  const selection = new AsyncLocalStorage<AccountFileSelection>()
  let resolverFailure: Error | undefined
  let beforeSelection: (() => Promise<void>) | undefined
  const select = async (): Promise<AccountFileSelection> => {
    await beforeSelection?.()
    if (resolverFailure !== undefined) throw resolverFailure
    return selection.getStore() ?? { workspace, assertCurrent }
  }
  const Constructor = await port.createTextFileSystem(workspace, (actual) => {
    if (!installed || actual.root !== graph.root) throw new Error('test provider detached')
  }, select)
  const fiber = await graph.plugin(Constructor)
  expect(fiber.state).toBe(FiberState.ACTIVE)
  return { graph, fs: graph.fs, fiber, pool, binding, project, port, workspace, Constructor, counters, workerInputs,
    release: () => { Atomics.store(counters, 2, 1); Atomics.notify(counters, 2) },
    stale: () => { current = false }, detach: () => { installed = false }, workers,
    selected: <T>(scope: AccountFileSelection, work: () => T): T => selection.run(scope, work),
    failResolver: (error: Error) => { resolverFailure = error },
    beforeSelection: (callback: () => Promise<void>) => { beforeSelection = callback },
    anotherProject: async () => {
      const path = join(projects, randomUUID())
      mkdirSync(path)
      return await graph.workspaceRegistry.create(path)
    },
  }
}

it('uses the native FS with stable alias targets, guarded create/update outcomes and raw text reads', async () => {
  const test = await fixture()
  const target = await test.fs.resolve('AGENTS.md')
  expect(await test.fs.stat(target)).toBeUndefined()
  const created = await test.fs.writeText(target, 'A\r\n你\rB', { kind: 'createIfAbsent' })
  expect(created).toMatchObject({ operation: 'create', before: null, after: 'A\n你\nB' })
  expect(await test.fs.readText(target)).toBe('A\r\n你\rB')
  const again = await test.fs.resolve('AGENTS.md')
  expect(again.targetKey).toBe(target.targetKey)
  symlinkSync('AGENTS.md', join(test.project, 'alias'))
  expect((await test.fs.resolve('alias')).targetKey).toBe(target.targetKey)
  const updated = await test.fs.writeText(again, 'next', { kind: 'replaceIfVersion', version: created.version })
  expect(updated).toMatchObject({ operation: 'update', before: 'A\n你\nB', after: 'next' })
  expect(updated.version).not.toBe(created.version)
  expect(await test.fs.stat(target)).toMatchObject({ type: 'file', version: updated.version, size: 4 })
  await expect(test.fs.writeText(target, 'blind', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  await expect(test.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: created.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(readFileSync(join(test.project, 'AGENTS.md'), 'utf8')).toBe('next')
  expect(test.workers).toHaveLength(2)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
})

it('keeps the configured byte cap, native text rejection and optional bounded prior context', async () => {
  const test = await fixture(), target = await test.fs.resolve('file')
  await expect(test.fs.writeText(target, '你'.repeat(22))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  expect(Atomics.load(test.counters, 0)).toBe(0)
  await test.fs.writeText(target, 'x'.repeat(64))
  expect((await test.fs.readText(target)).length).toBe(64)
  expect((await test.fs.writeText(target, 'short')).before).toBeNull()
  writeFileSync(join(test.project, 'file'), Buffer.from([65, 0, 66]))
  await expect(test.fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  expect((await test.fs.writeText(target, 'text')).before).toBeNull()
  writeFileSync(join(test.project, 'file'), Buffer.from([0xff]))
  await expect(test.fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  expect((await test.fs.writeText(target, 'valid')).before).toBeNull()
  writeFileSync(join(test.project, 'file'), 'x'.repeat(65))
  await expect(test.fs.readText(target)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  await expect(test.fs.writeText(await test.fs.resolve('absent'), 'x', { kind: 'replaceIfVersion', version: FsVersion('1:2:3:4:5') }))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
})

it('refuses foreign targets, unregistered graphs, out-of-project roots and ungranted content methods', async () => {
  const test = await fixture(), target = await test.fs.resolve('file')
  await expect(test.fs.writeText({ ...target }, 'x')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  for (const path of ['../other', '/outside', 'a/../../x']) await expect(test.fs.resolve(path)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.resolve('file', { cwd: test.project + '-other' })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  const elsewhere = join(test.project, 'nested')
  mkdirSync(elsewhere)
  await expect(test.port.createTextFileSystem(await test.graph.workspaceRegistry.create(elsewhere), () => {}, async () => ({ workspace: test.workspace, assertCurrent: () => {} }))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.listDir(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.readBytes(target, undefined, 64)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  const bare = new Context()
  expect(() => new test.Constructor(bare)).toThrow()
  test.detach()
  await expect(test.fs.writeText(target, 'x')).rejects.toThrow('test provider detached')
  expect(Atomics.load(test.counters, 0)).toBe(0)
})

it('rejects ABI6 text writes before dispatch without changing the read-only capability', async () => {
  const test = await fixture('normal', 6), target = await test.fs.resolve('file')
  await expect(test.fs.writeText(target, 'x')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(Atomics.load(test.counters, 0)).toBe(0)
  writeFileSync(join(test.project, 'file'), 'read')
  expect(await test.fs.readText(target)).toBe('read')
})

it('removes the native service on disposal and rejects retained methods and old targets after replacement', async () => {
  const test = await fixture(), target = await test.fs.resolve('file')
  await test.fiber.dispose()
  expect(test.graph.get('fs')).toBeUndefined()
  await expect(test.fs.writeText(target, 'stale provider')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(Atomics.load(test.counters, 0)).toBe(0)
  const replacement = await test.graph.plugin(test.Constructor)
  expect(replacement.state).toBe(FiberState.ACTIVE)
  await expect(test.graph.fs.writeText(target, 'old target')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  const fresh = await test.graph.fs.resolve('file')
  expect(await test.graph.fs.writeText(fresh, 'fresh provider')).toMatchObject({ operation: 'create', after: 'fresh provider' })
})

it('serializes already-admitted alias writes and rejects the second stale version after the first settles', async () => {
  const test = await fixture('block-before')
  writeFileSync(join(test.project, 'file'), 'original')
  symlinkSync('file', join(test.project, 'alias'))
  const target = await test.fs.resolve('file'), alias = await test.fs.resolve('alias'), info = await test.fs.stat(target)
  if (info === undefined) throw new Error('test file absent')
  const first = test.fs.writeText(target, 'first', { kind: 'replaceIfVersion', version: info.version })
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  const second = test.fs.writeText(alias, 'second', { kind: 'replaceIfVersion', version: info.version })
  const rejected = expect(second).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  await vi.waitFor(() => { expect(test.pool.inspect().work.running).toBe(2) })
  expect(Atomics.load(test.counters, 0)).toBe(1)
  test.release()
  await first; await rejected
  expect(readFileSync(join(test.project, 'file'), 'utf8')).toBe('first')
  expect(test.pool.inspect().work.residentBytes).toBe(0)
})

it('returns a confirmed committed outcome when cancellation arrives after publication and before its reply', async () => {
  const test = await fixture('block-after'), target = await test.fs.resolve('file'), abort = new AbortController()
  let settled = false
  const write = test.fs.writeText(target, 'payload', undefined, abort.signal)
  void write.then(() => { settled = true }, () => { settled = true })
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  expect(readFileSync(join(test.project, 'file'), 'utf8')).toBe('payload')
  abort.abort()
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(test.pool.inspect().work.running).toBe(1)
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(0)
  test.release()
  expect(await write).toMatchObject({ operation: 'create', after: 'payload' })
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
})

it('retains running cancellation until the worker confirms nonpublication and cleanup', async () => {
  const test = await fixture('block-before'), target = await test.fs.resolve('file'), abort = new AbortController()
  let settled = false
  const write = test.fs.writeText(target, 'payload', undefined, abort.signal)
  void write.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(write).rejects.toMatchObject({ code: 'FS_ABORTED', cause: { outcome: 'not-published' } })
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  abort.abort()
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(test.pool.inspect().work.running).toBe(1)
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(0)
  test.release()
  await rejected
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
  expect(test.pool.inspect().work.residentBytes).toBe(0)
  expect(Atomics.load(test.counters, 3)).toBe(1)
})

it('preserves a committed native outcome after the queue observer deadline has cancelled actual I/O', async () => {
  const test = await fixture('deadline-after', 7, 1000), target = await test.fs.resolve('file')
  let settled = false
  const write = test.fs.writeText(target, 'committed')
  void write.then(() => { settled = true }, () => { settled = true })
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 3)).toBe(1) }, { timeout: 2500 })
  expect(readFileSync(join(test.project, 'file'), 'utf8')).toBe('committed')
  expect(settled).toBe(false)
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(0)
  test.release()
  expect(await write).toMatchObject({ operation: 'create', after: 'committed' })
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
})

it('cancels an admitted waiting write before its worker invocation', async () => {
  const test = await fixture('block-before'), target = await test.fs.resolve('file')
  const first = test.fs.writeText(target, 'first'), abort = new AbortController()
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  const second = test.fs.writeText(target, 'second', undefined, abort.signal)
  const rejected = expect(second).rejects.toBeDefined()
  abort.abort()
  test.release(); await first; await rejected
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
  expect(Atomics.load(test.counters, 0)).toBe(1)
})

it('cancels a truly queued write before invoking its backend and retains only the two admitted running writes', async () => {
  const test = await fixture('block-before'), target = await test.fs.resolve('file')
  const first = test.fs.writeText(target, 'first')
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  const second = test.fs.writeText(target, 'second')
  await vi.waitFor(() => { expect(test.pool.inspect().work.running).toBe(2) })
  const abort = new AbortController()
  const queued = test.fs.writeText(target, 'queued', undefined, abort.signal)
  const rejected = expect(queued).rejects.toMatchObject({ code: 'FS_ABORTED', cause: { outcome: 'not-published' } })
  await vi.waitFor(() => { expect(test.pool.inspect().work.queued).toBe(1) })
  abort.abort(); await rejected
  expect(test.pool.inspect().work).toMatchObject({ running: 2, queued: 0, pending: 2 })
  expect(Atomics.load(test.counters, 0)).toBe(1)
  test.release(); await first; await second
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
  expect(readFileSync(join(test.project, 'file'), 'utf8')).toBe('second')
})

it('releases known nonpublication failures and rejects a retired graph before dispatch', async () => {
  const test = await fixture('known-failure'), target = await test.fs.resolve('file')
  await expect(test.fs.writeText(target, 'x')).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: { outcome: 'not-published' } })
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
  test.stale()
  await expect(test.fs.writeText(target, 'x')).rejects.toThrow()
  expect(Atomics.load(test.counters, 0)).toBe(1)
})

it.each(['unknown', 'unknown-after-cancel', 'unknown-stale', 'crash', 'bad-reply'])('retains unknown publication and refuses replay or clean drain: %s', async (mode) => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { diagnostic.mockRestore() })
  const test = await fixture(mode), target = await test.fs.resolve('file')
  const abort = new AbortController()
  const write = test.fs.writeText(target, 'x', undefined, abort.signal)
  const rejected = expect(write).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: { outcome: 'unknown' },
    message: 'File write could not be confirmed. Further writes are blocked; ask the account operator to reconcile the file before retrying.' })
  if (mode === 'unknown-after-cancel') {
    await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
    abort.abort(); test.release()
  }
  await rejected
  expect(diagnostic).toHaveBeenCalled()
  expect(test.pool.inspect().work.running).toBe(1)
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(0)
  await expect(test.fs.writeText(target, 'retry')).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: { outcome: 'unknown' } })
  expect(Atomics.load(test.counters, 0)).toBe(1)
  const receipt = await test.pool.stopEpoch(test.binding, Date.now() + 20)
  expect(receipt.status).toBe('unknown')
  expect(receipt.pendingOperationIds.length).toBeGreaterThan(0)
})


it('routes two actual registered projects through one FS and keeps equal relative names independent', async () => {
  const test = await fixture(), other = await test.anotherProject()
  const a = { workspace: test.workspace, assertCurrent: () => {} }, b = { workspace: other, assertCurrent: () => {} }
  const ta = await test.selected(a, () => test.fs.resolve('same.txt'))
  const tb = await test.selected(b, () => test.fs.resolve('same.txt'))
  expect(ta.targetKey).not.toBe(tb.targetKey)
  await Promise.all([test.selected(a, () => test.fs.writeText(ta, 'A')), test.selected(b, () => test.fs.writeText(tb, 'B'))])
  expect(await test.selected(a, () => test.fs.readText(ta))).toBe('A')
  expect(await test.selected(b, () => test.fs.readText(tb))).toBe('B')
  expect(test.fs.processPath(ta)).toBe(join(test.project, 'same.txt'))
  expect(test.fs.processPath(tb)).toBe(join(other.path, 'same.txt'))
  expect(test.fs.contains(ta, tb)).toBe(false)
  await expect(test.selected(a, () => test.fs.resolve(join(other.path, 'same.txt')))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.selected(b, () => test.fs.readText(ta))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(test.graph.registry.get(test.Constructor)?.fibers.length).toBe(1)
  expect(test.workers).toHaveLength(2)
  expect(test.pool.inspect().work.residentBytes).toBe(0)
})

it('checks captured selections on sync methods and rejects copied or foreign Workspace objects', async () => {
  const test = await fixture(), other = await test.anotherProject()
  let active = true
  const scope = { workspace: other, assertCurrent: () => { if (!active) throw new Error('captured scope ended') } }
  const target = await test.selected(scope, () => test.fs.resolve('file'))
  active = false
  expect(() => test.fs.processPath(target)).toThrow('captured scope ended')
  await expect(test.selected(scope, () => test.fs.stat(target))).rejects.toThrow('captured scope ended')
  const copied = { ...test.workspace }
  await expect(test.selected({ workspace: copied, assertCurrent: () => {} }, () => test.fs.resolve('file')))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(Atomics.load(test.counters, 0)).toBe(0)
})

it('awaits the trusted resolver before interpreting a path', async () => {
  const test = await fixture()
  const error = new Error('cold header unavailable')
  test.failResolver(error)
  await expect(test.fs.resolve('../outside')).rejects.toBe(error)
})

it('rejects a captured scope that expires while the trusted resolver awaits cold metadata', async () => {
  const test = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let active = true
  const scope = { workspace: test.workspace, assertCurrent: () => { if (!active) throw new Error('cold selection expired') } }
  test.beforeSelection(async () => { entered.resolve(undefined); await release.promise })
  const pending = test.selected(scope, () => test.fs.resolve('../outside'))
  const rejected = expect(pending).rejects.toThrow('cold selection expired')
  await entered.promise
  active = false
  release.resolve(undefined)
  await rejected
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
  expect(Atomics.load(test.counters, 0)).toBe(0)
})

it('keeps an issued target on its original directory identity after that project path is replaced', async () => {
  const test = await fixture(), target = await test.fs.resolve('file')
  writeFileSync(join(test.project, 'file'), 'original')
  renameSync(test.project, `${test.project}-old`)
  mkdirSync(test.project)
  writeFileSync(join(test.project, 'file'), 'replacement')
  await expect(test.fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.writeText(target, 'forbidden')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(readFileSync(join(test.project, 'file'), 'utf8')).toBe('replacement')
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('requires actual ABI8 handshakes and forwards every explicit content capacity', async () => {
  const test = await fixture('normal', 8, 3000, contentLimits)
  expect(test.workerInputs.map(input => input.content)).toEqual([contentLimits, contentLimits])
  expect(() => { test.port.assertContentAvailable() }).not.toThrow()
  test.stale()
  expect(() => { test.port.assertContentAvailable() }).toThrow('retired')
})

it.each(['no-config', 'content-mixed'])('rejects ABI8 capability mismatch before mounting the FS: %s', async (mode) => {
  await expect(fixture(mode, 8, 3000, mode === 'no-config' ? undefined : contentLimits))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
})

it('observes the final path without following a dangling link and selects its real project before lstat', async () => {
  const test = await fixture('normal', 8, 3000, contentLimits)
  writeFileSync(join(test.project, 'text'), 'abc')
  symlinkSync('missing', join(test.project, 'dangling'))
  expect(await test.fs.lstat('missing')).toBeUndefined()
  expect(await test.fs.lstat('text')).toMatchObject({ type: 'file', size: 3 })
  expect(await test.fs.lstat('dangling/')).toMatchObject({ type: 'symlink' })
  await expect(test.fs.lstat('../outside')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.lstat('text', { cwd: `${test.project}-other` })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  const unavailable = new Error('trusted selection unavailable')
  test.failResolver(unavailable)
  await expect(test.fs.lstat('../outside')).rejects.toBe(unavailable)
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('issues valid directory-entry targets and keeps observed links metadata-only across later replacement', async () => {
  const test = await fixture('normal', 8, 3000, contentLimits)
  mkdirSync(join(test.project, 'folder'))
  writeFileSync(join(test.project, '你.txt'), 'raw')
  symlinkSync('你.txt', join(test.project, 'alias'))
  const root = await test.fs.resolve('.'), entries = await test.fs.listDir(root)
  expect(entries.map(entry => [entry.name, entry.type])).toEqual([['alias', 'other'], ['folder', 'directory'], ['你.txt', 'file']])
  for (const entry of entries) expect(test.fs.contains(root, entry.target)).toBe(true)
  const file = entries.find(entry => entry.type === 'file')!, link = entries.find(entry => entry.name === 'alias')!
  expect(file.target.targetKey).toBe((await test.fs.resolve('你.txt')).targetKey)
  expect(await test.fs.readBytes(file.target, undefined, 3)).toEqual(new Uint8Array([114, 97, 119]))
  expect(await test.fs.stat(link.target)).toMatchObject({ type: 'other' })
  await expect(test.fs.readBytes(link.target, undefined, 64)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.readText(link.target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.readByteRange(link.target, { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.listDir(link.target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.writeText(link.target, 'forbidden')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  rmSync(join(test.project, 'alias'))
  writeFileSync(join(test.project, 'alias'), 'replacement')
  await expect(test.fs.readBytes(link.target, undefined, 64)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.watch(root, () => {}, new AbortController().signal)).rejects.toThrow('watching is unsupported')
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it.each(['entries', 'name', 'reply'])('rejects the entire directory reply at the configured %s bound', async (kind) => {
  const limits = { ...contentLimits, ...kind === 'entries' ? { maxEntries: 1 }
    : kind === 'name' ? { maxNameBytes: 1 } : { maxReplyBytes: 600 } }
  const test = await fixture('normal', 8, 3000, limits), root = await test.fs.resolve('.')
  writeFileSync(join(test.project, 'aa'), 'x')
  if (kind === 'entries') writeFileSync(join(test.project, 'b'), 'x')
  await expect(test.fs.listDir(root)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('reads exact bounded byte windows without imposing the full-file cap on a window', async () => {
  const test = await fixture('normal', 8, 3000, contentLimits)
  writeFileSync(join(test.project, 'large'), new Uint8Array(Array.from({ length: 128 }, (_, index) => index)))
  writeFileSync(join(test.project, 'empty'), '')
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
  writeFileSync(join(test.project, 'image.png'), png)
  const bytes = await test.fs.readBytes(await test.fs.resolve('image.png'), undefined, 64)
  expect(bytes).toEqual(png)
  expect(bytes.buffer.byteLength).toBe(png.byteLength)
  const target = await test.fs.resolve('large')
  expect(await test.fs.readByteRange(target, { offset: 64, length: 4 })).toEqual(new Uint8Array([64, 65, 66, 67]))
  expect(await test.fs.readByteRange(target, { offset: 126, length: 4 })).toEqual(new Uint8Array([126, 127]))
  expect(await test.fs.readByteRange(target, { offset: 1000, length: 4 })).toEqual(new Uint8Array())
  expect(await test.fs.readByteRange(target, { offset: 0, length: 0 })).toEqual(new Uint8Array())
  expect(await test.fs.readBytes(await test.fs.resolve('empty'), undefined, 0)).toEqual(new Uint8Array())
  await expect(test.fs.readBytes(target, undefined, 128)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  for (const range of [{ offset: -1, length: 1 }, { offset: 0, length: 65 }, { offset: Number.MAX_SAFE_INTEGER, length: 1 }]) {
    await expect(test.fs.readByteRange(target, range)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  }
  await expect(test.fs.readBytes(target, undefined, -1)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('refuses a file that grows past the full-byte cap after its earlier metadata observation', async () => {
  const test = await fixture('content-grow', 8, 3000, contentLimits)
  writeFileSync(join(test.project, 'file'), 'small')
  const target = await test.fs.resolve('file')
  expect((await test.fs.stat(target))?.size).toBe(5)
  await expect(test.fs.readBytes(target, undefined, 8)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('keeps list targets and raw reads on their captured original project and scope', async () => {
  const test = await fixture('normal', 8, 3000, contentLimits), other = await test.anotherProject()
  writeFileSync(join(test.project, 'file'), 'A')
  writeFileSync(join(other.path, 'file'), 'B')
  let active = true
  const a = { workspace: test.workspace, assertCurrent() { if (!active) throw new Error('entry scope expired') } }
  const b = { workspace: other, assertCurrent() {} }
  const entries = await test.selected(a, async () => test.fs.listDir(await test.fs.resolve('.')))
  const target = entries[0]!.target
  expect(await test.selected(a, () => test.fs.readBytes(target, undefined, 1))).toEqual(new Uint8Array([65]))
  await expect(test.selected(b, () => test.fs.readByteRange(target, { offset: 0, length: 1 })))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.selected(a, () => test.fs.lstat(join(other.path, 'file')))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.readBytes({ ...target }, undefined, 1)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  active = false
  expect(() => test.fs.processPath(target)).toThrow('entry scope expired')
  await expect(test.selected(a, () => test.fs.readBytes(target, undefined, 1))).rejects.toThrow('entry scope expired')
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('retains a cancelled listing reservation until its actual worker reply and closure', async () => {
  const test = await fixture('content-block', 8, 3000, contentLimits), root = await test.fs.resolve('.')
  const controller = new AbortController(), pending = test.fs.listDir(root, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  const retained = test.pool.inspect().work.residentBytes
  expect(retained).toBeGreaterThan(0)
  controller.abort()
  await rejected
  expect(test.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: retained })
  test.release()
  await vi.waitFor(() => { expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
})


/** TEST ONLY trusted selection; production Runtime owns the identity and caller assertion. */
function directoryPreparation(test: Awaited<ReturnType<typeof fixture>>, caller = test.graph) {
  let active = true
  const directoryPreparation = Object.freeze({ assertCaller(actual: Context): void {
    if (actual.fiber !== caller.fiber) throw new Error('preparation caller differs')
  } })
  const scope: AccountFileSelection = { workspace: test.workspace, directoryPreparation,
    assertCurrent: () => { if (!active) throw new Error('preparation revoked') } }
  return { scope, revoke: () => { active = false } }
}

/** Observe original fixture transport submissions; no replacement backend or private filesystem reader. */
function submissions(test: Awaited<ReturnType<typeof fixture>>) {
  const spies = test.workers.map(worker => vi.spyOn(worker, 'postMessage'))
  return () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
}

/** Hold one original transport message so authority can end before its genuine reply arrives. */
function holdSubmission(test: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<undefined>()
  let held: (() => void) | undefined, armed = true
  for (const worker of test.workers) {
    const send = worker.postMessage.bind(worker)
    vi.spyOn(worker, 'postMessage').mockImplementation((...args: Parameters<Worker['postMessage']>) => {
      if (armed) {
        armed = false
        held = () => { send(...args) }
        entered.resolve(undefined)
      } else send(...args)
    })
  }
  const release = (): void => { const send = held; held = undefined; send?.() }
  onTestFinished(release)
  return { entered: entered.promise, release }
}

it('permits one exact preparation root resolve, directory stat and processPath, then retires every old target', async () => {
  const test = await fixture(), { scope } = directoryPreparation(test)
  const target = await test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project }))
  const count = submissions(test)
  expect(await test.selected(scope, () => test.fs.stat(target))).toMatchObject({ type: 'directory' })
  expect(count()).toBe(1)
  expect(test.fs.processPath(target)).toBe(test.project)
  expect(() => test.fs.processPath(target)).toThrow()
  await expect(test.selected(scope, () => test.fs.stat(target))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project })))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(count()).toBe(1)
})

it.each(['relative', 'subpath', 'alias', 'trailing', 'outside', 'wrong-cwd', 'missing-cwd'])
('rejects preparation %s before any worker submission and does not allow retry', async (kind) => {
  const test = await fixture(), { scope } = directoryPreparation(test), count = submissions(test)
  const path = kind === 'relative' ? '.' : kind === 'subpath' ? join(test.project, 'child')
    : kind === 'alias' ? test.project + '/.' : kind === 'trailing' ? test.project + '/'
      : kind === 'outside' ? test.project + '-other' : test.project
  const opts = kind === 'missing-cwd' ? undefined : { cwd: kind === 'wrong-cwd' ? '/' : test.project }
  await expect(test.selected(scope, () => test.fs.resolve(path, opts))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project })))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(count()).toBe(0)
})

it.each(['resolve', 'stat'])('rejects an extra concurrent preparation %s and its already pending operation', async (kind) => {
  const test = await fixture(), { scope } = directoryPreparation(test)
  const target = kind === 'stat' ? await test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project })) : undefined
  const held = holdSubmission(test)
  const run = () => test.selected(scope, () => target === undefined
    ? test.fs.resolve(test.project, { cwd: test.project }) : test.fs.stat(target))
  const first = run(), rejected = expect(first).rejects.toMatchObject(kind === 'resolve'
    ? { cause: { code: 'FS_PERMISSION_DENIED' } } : { code: 'FS_PERMISSION_DENIED' })
  await held.entered
  await expect(run()).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  held.release()
  await rejected
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 })
})

it.each(['resolve', 'stat'])('rejects cancelled preparation %s even when its original I/O replies late', async (kind) => {
  const test = await fixture(), { scope } = directoryPreparation(test), cancel = new AbortController()
  const target = kind === 'stat' ? await test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project })) : undefined
  const held = holdSubmission(test)
  const pending = test.selected(scope, () => target === undefined
    ? test.fs.resolve(test.project, { cwd: test.project, signal: cancel.signal }) : test.fs.stat(target, cancel.signal))
  const rejected = expect(pending).rejects.toBeDefined()
  await held.entered
  cancel.abort(new Error('preparation cancelled'))
  held.release()
  await rejected
  await expect.poll(() => test.pool.inspect().work.pending).toBe(0)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0 })
  await expect(test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project })))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  if (target !== undefined) expect(() => test.fs.processPath(target)).toThrow()
})

it.each(['resolve', 'stat'])('rejects revoked preparation %s after late original I/O without retaining its result', async (kind) => {
  const test = await fixture(), grant = directoryPreparation(test)
  const target = kind === 'stat' ? await test.selected(grant.scope, () => test.fs.resolve(test.project, { cwd: test.project })) : undefined
  const held = holdSubmission(test)
  const pending = test.selected(grant.scope, () => target === undefined
    ? test.fs.resolve(test.project, { cwd: test.project }) : test.fs.stat(target))
  const rejected = kind === 'resolve'
    ? expect(pending).rejects.toMatchObject({ cause: { message: 'preparation revoked' } })
    : expect(pending).rejects.toThrow('preparation revoked')
  await held.entered
  grant.revoke()
  held.release()
  await rejected
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 })
  if (target !== undefined) expect(() => test.fs.processPath(target)).toThrow('preparation revoked')
})

it('requires the original target and same preparation identity from a fresh selector', async () => {
  const test = await fixture(), a = directoryPreparation(test), b = directoryPreparation(test)
  const ordinary = await test.fs.resolve('.')
  const target = await test.selected(a.scope, () => test.fs.resolve(test.project, { cwd: test.project }))
  const count = submissions(test)
  await expect(test.selected(a.scope, () => test.fs.stat({ ...target }))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.selected(a.scope, () => test.fs.stat(ordinary))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.selected(b.scope, () => test.fs.stat(target))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(test.fs.stat(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(count()).toBe(0)
})

it.each(['readText', 'streamText', 'writeText', 'readBytes', 'readByteRange', 'listDir', 'lstat', 'editText', 'watch', 'fileUrl', 'contains', 'early-processPath'])
('denies preparation %s without worker I/O', async (method) => {
  const test = await fixture('normal', 8, 3000, contentLimits), { scope } = directoryPreparation(test)
  const target = await test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project }))
  const count = submissions(test)
  const action = async (): Promise<unknown> => {
    if (method === 'readText') return test.fs.readText(target)
    if (method === 'streamText') return test.fs.streamText(target)
    if (method === 'writeText') return test.fs.writeText(target, 'forbidden')
    if (method === 'readBytes') return test.fs.readBytes(target, undefined, 1)
    if (method === 'readByteRange') return test.fs.readByteRange(target, { offset: 0, length: 1 })
    if (method === 'listDir') return test.fs.listDir(target)
    if (method === 'lstat') return test.fs.lstat(test.project, { cwd: test.project })
    if (method === 'editText') return test.fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false })
    if (method === 'watch') return test.fs.watch(target, () => {}, new AbortController().signal)
    if (method === 'fileUrl') return test.fs.fileUrl(target)
    if (method === 'contains') return test.fs.contains(target, target)
    return test.fs.processPath(target)
  }
  await expect(test.selected(scope, action)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(count()).toBe(0)
})

it('checks the real contextualized caller on async selection and every synchronous preparation target use', async () => {
  const test = await fixture()
  let child: Context | undefined
  await test.graph.plugin({ inject: ['fs'], apply: (ctx: Context) => { child = ctx } })
  if (child === undefined) throw new Error('child caller did not mount')
  const actor = child, { scope } = directoryPreparation(test, actor)
  await expect(test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project })))
    .rejects.toThrow('preparation caller differs')
  const fresh = directoryPreparation(test, actor)
  const target: FsTarget = await test.selected(fresh.scope, () => actor.fs.resolve(test.project, { cwd: test.project }))
  await test.selected(fresh.scope, () => actor.fs.stat(target))
  expect(() => test.fs.processPath(target)).toThrow('preparation caller differs')
  expect(actor.fs.processPath(target)).toBe(test.project)
})


it.each(['directory', 'file', 'missing'] as const)
('preserves the original reader %s result during preparation stat without mapping it to other', async (kind) => {
  const test = await fixture(), { scope } = directoryPreparation(test)
  await test.fiber.dispose()
  const readerTarget = Object.freeze({ targetKey: FsTargetKey('test-only-reader'), displayPath: '.' })
  const info = kind === 'missing' ? undefined : { type: kind, version: FsVersion('test-only-version') }
  const stat = vi.fn(async () => info)
  const denied = async (): Promise<never> => { throw new Error('unexpected content backend access') }
  const Constructor = createTextProjectFileSystem({
    binding: test.binding, bootstrapWorkspace: test.workspace, assertCurrent: () => {}, assertInstalled: () => {},
    resolveProject: async () => scope,
    project: async (_workspace, check) => {
      check()
      return { binding: test.binding, workspace: test.workspace, maxPathBytes: 1024,
        assertCurrent: check, assertInstalled: () => {}, canonicalPath: async () => test.project,
        reader: { resolve: async () => readerTarget, stat, processPath: () => test.project, streamText: denied },
        readText: denied, lstat: denied, listDir: denied, readBytes: denied, readByteRange: denied, writeText: denied }
    },
  })
  await test.graph.plugin(Constructor)
  const target = await test.graph.fs.resolve(test.project, { cwd: test.project })
  expect(await test.graph.fs.stat(target)).toBe(info)
  expect(stat).toHaveBeenCalledExactlyOnceWith(readerTarget, undefined)
  if (kind === 'directory') expect(test.graph.fs.processPath(target)).toBe(test.project)
  else expect(() => test.graph.fs.processPath(target)).toThrow()
})


it.each(['resolve', 'stat'])('retires preparation after a repeated completed %s before processPath', async (kind) => {
  const test = await fixture(), { scope } = directoryPreparation(test)
  const target = await test.selected(scope, () => test.fs.resolve(test.project, { cwd: test.project }))
  if (kind === 'stat') await test.selected(scope, () => test.fs.stat(target))
  const count = submissions(test)
  await expect(test.selected(scope, () => kind === 'resolve'
    ? test.fs.resolve(test.project, { cwd: test.project }) : test.fs.stat(target)))
    .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(() => test.fs.processPath(target)).toThrow()
  expect(count()).toBe(0)
})

it.each(['resolve', 'stat'])('retains the completed preparation %s signal through synchronous target use', async (kind) => {
  const test = await fixture(), { scope } = directoryPreparation(test), cancel = new AbortController()
  const target = await test.selected(scope, () => test.fs.resolve(test.project,
    { cwd: test.project, ...kind === 'resolve' ? { signal: cancel.signal } : {} }))
  await test.selected(scope, () => test.fs.stat(target, kind === 'stat' ? cancel.signal : undefined))
  const count = submissions(test)
  cancel.abort(new Error('completed preparation cancelled'))
  expect(() => test.fs.processPath(target)).toThrow()
  await expect(test.selected(scope, () => test.fs.stat(target))).rejects.toBeDefined()
  expect(count()).toBe(0)
})
