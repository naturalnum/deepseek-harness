/** Native Loader/Registry/FS consumers; worker I/O below is explicitly a TEST ONLY Node transport. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool } from '../src/worker-pool.ts'

async function fixture(mode = 'normal', abiVersion = 7, waitTimeoutMs = 3000) {
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
  const pool = new LinuxFilesPool({
    maxLanes: 1, maxRunning: 2, maxRunningPerLane: 2, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: 131072, maxResidentBytesPerLane: 65536, waitTimeoutMs,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 64,
    readyTimeoutMs: 2000, drainTimeoutMs: 20, helperPath: '/test-only/not-loaded.node',
    maxReadBytes: 64, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 2,
  }, () => {
    const worker = new Worker(new URL('./fixtures/text-worker.mjs', import.meta.url), { workerData: { mode, gate, abiVersion } })
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
  const Constructor = await port.createTextFileSystem(workspace, (actual) => {
    if (!installed || actual.root !== graph.root) throw new Error('test provider detached')
  })
  const fiber = await graph.plugin(Constructor)
  expect(fiber.state).toBe(FiberState.ACTIVE)
  return { graph, fs: graph.fs, fiber, pool, binding, project, port, workspace, Constructor, counters,
    release: () => { Atomics.store(counters, 2, 1); Atomics.notify(counters, 2) },
    stale: () => { current = false }, detach: () => { installed = false }, workers }
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
  await expect(test.port.createTextFileSystem(await test.graph.workspaceRegistry.create(elsewhere), () => {})).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
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
  expect(test.pool.inspect().work.queued).toBe(1)
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
