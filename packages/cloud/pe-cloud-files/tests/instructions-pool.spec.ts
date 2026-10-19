/** Real worker_threads and test-only Node transport; this does not certify native membership, Linux confinement or quotas. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import type { InstructionReadReaders } from '../src/instruction-read-work.ts'
import type { FixedRootReader } from '../src/read-only.ts'
import type { ResidentResult } from '../src/work-queue.ts'

async function fixture(mode = 'normal') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'instructions-pool-')))
  const projects = join(home, 'projects'), project = join(projects, 'default-workspace')
  const privateRoot = join(home, 'private'), instructions = join(privateRoot, 'instructions')
  mkdirSync(project, { recursive: true })
  mkdirSync(instructions, { recursive: true })
  writeFileSync(join(project, 'AGENTS.md'), 'project-source\n')
  writeFileSync(join(instructions, 'AGENTS.md'), 'account-source\n')
  const identity = (rootPath: string) => {
    const info = statSync(rootPath, { bigint: true })
    // Fixed test-only mount label; the Node transport verifies dev/inode and supplies no mount proof.
    return { rootPath, rootDevice: String(info.dev), rootInode: String(info.ino), rootMountId: '1' }
  }
  const lifetime = new AbortController()
  const binding: AccountBinding = { accountId: 'instructions-component' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'test-only-node-instructions', lifetime: lifetime.signal }
  const counters = new Int32Array(new SharedArrayBuffer(36))
  const workers: Worker[] = []
  const pool = new LinuxFilesPool({
    maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: 262144, maxResidentBytesPerLane: 131072, waitTimeoutMs: 2000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 64,
    readyTimeoutMs: 2000, drainTimeoutMs: 20, helperPath: '/test-only/not-loaded.node',
    maxReadBytes: 128, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 4,
  }, () => {
    const worker = new Worker(new URL('./fixtures/instructions-pool-worker.mjs', import.meta.url), {
      workerData: { mode, gate: counters.buffer, chunkBytes: 4, maxReadBytes: 128 },
    })
    workers.push(worker)
    return worker
  })
  const actual: Promise<unknown>[] = []
  const releases: (() => void)[] = []
  const gates: (() => void)[] = []
  const releaseWorker = (): void => { Atomics.store(counters, 3, 1); Atomics.notify(counters, 3) }
  onTestFinished(async () => {
    releaseWorker()
    for (const release of gates) release()
    await Promise.allSettled(actual)
    for (const release of releases) release()
    try {
      const stopped = await pool.stop(Date.now() + 2000)
      expect(stopped.status).toBe('confirmed')
      await pool.whenClosed()
      expect(pool.inspect().exited).toBe(workers.length)
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()))
      rmSync(home, { recursive: true, force: true })
    }
  })
  await pool.start()
  const port = pool.bind(binding, identity(projects), () => {
    if (lifetime.signal.aborted) throw new Error('Fixture account ended')
  }, identity(privateRoot))
  // Privileged component input only: Root/native Registry must separately verify actual production membership.
  const workspace = { path: project } as Workspace
  const read = <T>(
    build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>, signal = lifetime.signal,
  ): Promise<ResidentResult<T>> => {
    const task = port.withInstructionReaders(workspace, 8192, build, signal, () => { signal.throwIfAborted() }).then((held) => {
      releases.push(() => { held.release() })
      return held
    })
    actual.push(task)
    void task.catch((_error: unknown) => { /* Each test asserts its public failure; teardown still joins the operation. */ })
    return task
  }
  const gate = () => {
    const hold = Promise.withResolvers<undefined>()
    gates.push(() => { hold.resolve(undefined) })
    return hold
  }
  return { home, project, instructions, privateRoot, pool, binding, read, counters, gate, releaseWorker }
}

async function text(reader: FixedRootReader, signal: AbortSignal): Promise<string> {
  const target = await reader.resolve('AGENTS.md', { signal })
  expect((await reader.stat(target, signal))?.type).toBe('file')
  let result = ''
  for await (const chunk of await reader.streamText(target, signal)) result += chunk
  return result
}

it('reads account/project sources with per-lane running=1 and retains the whole result reservation until release', async () => {
  const test = await fixture()
  let escaped: FixedRootReader | undefined
  const result = await test.read(async (readers, control) => {
    expect(test.pool.inspect()).toMatchObject({ busy: 1, work: { running: 1, queued: 0, pending: 1 } })
    expect(readers.account).toBeDefined()
    if (readers.account === undefined) throw new Error('Expected real account source')
    escaped = readers.account
    const account = await text(readers.account, control)
    const project = await text(readers.project, control)
    return Object.freeze({ account, project })
  })
  expect(result.value).toEqual({ account: 'account-source\n', project: 'project-source\n' })
  expect(Atomics.load(test.counters, 1)).toBe(2)
  expect(Atomics.load(test.counters, 4)).toBe(2)
  expect(Atomics.load(test.counters, 5)).toBe(1)
  expect(test.pool.inspect()).toMatchObject({ busy: 0, healthy: 1, work: { running: 0, queued: 0, pending: 1 } })
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(8192)
  if (escaped === undefined) throw new Error('Expected captured source reader')
  await expect(escaped.resolve('AGENTS.md')).rejects.toMatchObject({ code: 'FS_ABORTED' })
  result.release()
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 })
})

it('cancels an already queued complete snapshot without dispatching its sources or build', async () => {
  const test = await fixture()
  const hold = test.gate(), entered = Promise.withResolvers<undefined>()
  const first = test.read(async () => { entered.resolve(undefined); await hold.promise; return 'first' })
  const abort = new AbortController(), secondBuild = vi.fn(async () => 'must not run')
  const second = test.read(secondBuild, abort.signal)
  const reason = new Error('Queued snapshot cancelled')
  const rejected = expect(second).rejects.toBe(reason)
  await entered.promise
  // Both outer project identities have replied; the second complete snapshot is now queued behind the first build.
  await vi.waitFor(() => {
    expect(Atomics.load(test.counters, 8)).toBe(2)
    expect(test.pool.inspect().work).toMatchObject({ running: 1, queued: 1, pending: 2 })
  })
  const commands = Atomics.load(test.counters, 0)
  abort.abort(reason)
  await rejected
  expect(secondBuild).not.toHaveBeenCalled()
  expect(test.pool.inspect().work).toMatchObject({ running: 1, queued: 0, pending: 1 })
  expect(Atomics.load(test.counters, 0)).toBe(commands)
  expect(Atomics.load(test.counters, 5)).toBe(1)
  hold.resolve(undefined)
  const result = await first
  expect(result.value).toBe('first')
  result.release()
  expect(test.pool.inspect().work).toMatchObject({ pending: 0, residentBytes: 0 })
})

it('rejects a real account-source symlink to private credentials without reading content or leaking a reservation', async () => {
  const test = await fixture()
  rmSync(test.instructions, { recursive: true })
  mkdirSync(join(test.privateRoot, 'credentials'))
  writeFileSync(join(test.privateRoot, 'credentials', 'AGENTS.md'), 'not-an-instruction-source')
  symlinkSync('credentials', test.instructions)
  const build = vi.fn(async () => 'must not build')
  await expect(test.read(build)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  expect(build).not.toHaveBeenCalled()
  expect(Atomics.load(test.counters, 6)).toBe(2)
  expect(Atomics.load(test.counters, 1)).toBe(0)
  expect(test.pool.inspect()).toMatchObject({ healthy: 1, busy: 0,
    work: { pending: 0, residentBytes: 0, running: 0, queued: 0 } })
})

it('retains the lane, slot and budget after observer cancellation until the worker actually closes its source FD', async () => {
  const test = await fixture('delayed-cancel')
  let delivered = false
  const result = test.read(async (readers, control) => {
    if (readers.account === undefined) throw new Error('Expected account instructions')
    const target = await readers.account.resolve('AGENTS.md', { signal: control })
    const iterator = (await readers.account.streamText(target, control))[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'acco' })
    return 'snapshot awaiting actual close'
  }).then((value) => { delivered = true; return value })
  const rejected = expect(result).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 2)).toBe(1) })
  expect(Atomics.load(test.counters, 4)).toBe(0)
  expect(delivered).toBe(false)
  const unknown = await test.pool.stopEpoch(test.binding, Date.now() + 20)
  await rejected
  expect(unknown.status).toBe('unknown')
  expect(unknown.pendingOperationIds).toHaveLength(1)
  expect(test.pool.inspect()).toMatchObject({ healthy: 1, busy: 1, work: { running: 1, pending: 1 } })
  expect(test.pool.inspect().work.residentBytes).toBeGreaterThan(8192)
  test.releaseWorker()
  expect((await test.pool.stopEpoch(test.binding, Date.now() + 2000)).status).toBe('confirmed')
  expect(Atomics.load(test.counters, 4)).toBe(1)
  expect(delivered).toBe(false)
  expect(test.pool.inspect()).toMatchObject({ busy: 0, work: { running: 0, pending: 0, residentBytes: 0 } })
})
