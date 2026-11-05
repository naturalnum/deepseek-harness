/** Original queue, pool and Node worker protocol; no Linux mount/ABI or production authentication qualification. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool, type WorkspaceUploadObservation } from '../src/worker-pool.ts'
import type { WorkspaceUploadSource } from '../src/stage-bridge.ts'
import { FilesWorkQueue } from '../src/work-queue.ts'
import { FdStageFailure } from '../src/worker-client.ts'

const caseId = 'a'.repeat(32), reservation = 2097152
const bytes = (role: 'A' | 'B') => Buffer.alloc(role === 'A' ? 8192 : 4096, 137)
const claim = (role: 'A' | 'B') => ({ name: `qa-${caseId}-${role}`, bytes: bytes(role).length,
  sha256: createHash('sha256').update(bytes(role)).digest('hex') })
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'files-upload-observer-'))), projects = join(home, 'projects')
  const project = join(projects, 'default-workspace'); mkdirSync(project, { recursive: true })
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = []
  const pool = new LinuxFilesPool({ maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 4, maxQueuedPerLane: 2,
    maxResidentBytes: 134217728, maxResidentBytesPerLane: 67108864, waitTimeoutMs: 30000,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 8388608, replyOverheadBytes: 4096,
    readyTimeoutMs: 3000, drainTimeoutMs: 20, helperPath: '/fixture/fd.node', maxReadBytes: 65536,
    maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 4096,
    staging: { helperPath: '/fixture/staging.node', maxFileBytes: 67108864, maxBatchRefs: 4, maxBatchBytes: 67108864,
      maxSourceChunkBytes: 65536, operationTimeoutMs: 30000, reservationBytes: reservation } }, (input) => {
    const worker = new Worker(new URL('./fixtures/stage-worker.mjs', import.meta.url), { workerData: { gate, staging: input.staging } })
    workers.push(worker); return worker
  })
  const go = Promise.withResolvers<undefined>(), opened = { A: 0, B: 0 }, closed = { A: 0, B: 0 }
  const lifetime = new AbortController(), binding: AccountBinding = { accountId: brandString<AccountId>('observer-account'),
    epoch: brandString<OwnerEpoch>('7'), recipeVersion: 'original-fixture', lifetime: lifetime.signal }
  onTestFinished(async () => {
    go.resolve(undefined); lifetime.abort(); await pool.stop(Date.now() + 100)
    await Promise.all(workers.map(worker => worker.terminate())); rmSync(home, { recursive: true, force: true })
  })
  await pool.start()
  const info = statSync(projects, { bigint: true }), workspace = { path: project } as Workspace
  const bind = (actual = binding) => pool.bind(actual, { rootPath: projects, rootDevice: String(info.dev),
    rootInode: String(info.ino), rootMountId: '1' }, () => { actual.lifetime.throwIfAborted() })
  const port = bind(), rows: WorkspaceUploadObservation[] = []
  const selection = (durationMs = 120000) => ({ accountId: binding.accountId, caseId, durationMs,
    claims: [claim('A'), claim('B')] as const })
  const source = (role: 'A' | 'B', hold = false): WorkspaceUploadSource => ({ claim: claim(role), workspaceDirectory: '.',
    open: async function* () {
      opened[role]++
      try { yield bytes(role).subarray(0, 4096); if (hold) await go.promise
        if (role === 'A') yield bytes(role).subarray(4096) } finally { closed[role]++ }
    } })
  const startA = async () => {
    const pending = port.stageWorkspaceUploads(workspace, [source('A', true)], () => {})
    await vi.waitFor(() => { expect(Atomics.load(counters, 3)).toBeGreaterThan(0) })
    return { pending }
  }
  const finish = async (pending: ReturnType<typeof port.stageWorkspaceUploads>) => {
    go.resolve(undefined); const held = await pending; held.release()
    await vi.waitFor(() => { expect(pool.inspect().work.residentBytes).toBe(0) })
    expect(readFileSync(join(project, claim('A').name))).toEqual(bytes('A'))
  }
  return { pool, port, workspace, binding, selection, rows, source, startA, finish, opened, closed, go, bind, counters }
}

it('links the actual queued B id through cancellation and releases its original 2MiB without opening B', async () => {
  const f = await fixture(); f.pool.observeWorkspaceUploads(f.selection(), (row) => { f.rows.push(row); return true })
  const { pending: a } = await f.startA(), cancel = new AbortController()
  expect(f.pool.inspect().work).toMatchObject({ running: 1, queued: 0, residentBytes: reservation })
  const b = f.port.stageWorkspaceUploads(f.workspace, [f.source('B')], () => {}, cancel.signal)
  expect(f.pool.inspect().work).toMatchObject({ running: 1, queued: 1, residentBytes: 2 * reservation })
  const queued = f.rows.find(row => row.role === 'B')!
  expect(queued).toMatchObject({ event: 'queued-before-invoke', invoked: false, reservedBytes: reservation,
    epoch: f.binding.epoch, recipeVersion: f.binding.recipeVersion })
  const cause = Error('actual queued caller cancellation'), rejected = expect(b).rejects.toMatchObject({ outcome: 'not-published', cause })
  cancel.abort(cause); await rejected
  expect(f.rows.filter(row => row.role === 'B').map(row => [row.id, row.event, row.invoked])).toEqual([
    [queued.id, 'queued-before-invoke', false], [queued.id, 'cancelled-before-invoke', false], [queued.id, 'settled', false]])
  expect(f.opened.B).toBe(0); expect(f.pool.inspect().work.residentBytes).toBe(reservation)
  expect(f.rows.every(Object.isFrozen)).toBe(true); await f.finish(a); expect(f.closed.A).toBe(1)
})

it('refuses attribution when C queues but B was never accepted, despite the same aggregate queued count', async () => {
  const f = await fixture(); f.pool.observeWorkspaceUploads(f.selection(), (row) => { f.rows.push(row); return true })
  const { pending: a } = await f.startA(), cancel = new AbortController()
  const c = f.port.stageWorkspaceUploads(f.workspace, [{ ...f.source('B'), claim: { ...claim('B'), name: 'unrelated-C' } }],
    () => {}, cancel.signal)
  expect(f.pool.inspect().work.queued).toBe(1); expect(f.rows.some(row => row.role === 'B')).toBe(false)
  const rejected = expect(c).rejects.toMatchObject({ outcome: 'not-published' }); cancel.abort(); await rejected; await f.finish(a)
})

it.each(['false', 'throw'] as const)('withdraws an unconfirmed %s sink without changing real work or old trace retention', async (mode) => {
  const f = await fixture(); let calls = 0
  f.pool.observeWorkspaceUploads(f.selection(), () => { calls++; if (mode === 'throw') throw Error('sink'); return false })
  const { pending: a } = await f.startA(); expect(calls).toBe(1)
  const stop = f.pool.observeWorkspaceUploads(f.selection(), (row) => { f.rows.push(row); return true })
  await f.finish(a); expect(f.rows).toEqual([]); stop(); stop()
})

it('expires by its own monotonic deadline, permits replacement, and cannot deliver old record events to a new sink', async () => {
  const f = await fixture(); let now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  onTestFinished(() => { clock.mockRestore() })
  f.pool.observeWorkspaceUploads(f.selection(), (row) => { f.rows.push(row); return true })
  const { pending: a } = await f.startA(); now += 120001
  const c = new AbortController(), b = f.port.stageWorkspaceUploads(f.workspace, [f.source('B')], () => {}, c.signal)
  expect(f.rows.some(row => row.role === 'B')).toBe(false)
  const fresh: WorkspaceUploadObservation[] = []
  const stop = f.pool.observeWorkspaceUploads(f.selection(), (row) => { fresh.push(row); return true })
  const rejected = expect(b).rejects.toMatchObject({ outcome: 'not-published' }); c.abort(); await rejected
  await f.finish(a); expect(fresh).toEqual([]); stop()
})

it('ignores wrong account claims and rejects invalid or duplicate registrations without affecting publication', async () => {
  const f = await fixture(), stop = f.pool.observeWorkspaceUploads(f.selection(), (row) => { f.rows.push(row); return true })
  expect(() => f.pool.observeWorkspaceUploads(f.selection(), () => true)).toThrow()
  const foreign = f.bind({ ...f.binding, accountId: brandString<AccountId>('other-account') })
  const held = await foreign.stageWorkspaceUploads(f.workspace, [f.source('B')], () => {}); held.release()
  expect(f.rows).toEqual([]); stop()
  for (const durationMs of [0, 120001, Infinity]) {
    expect(() => f.pool.observeWorkspaceUploads(f.selection(durationMs), () => true)).toThrow()
  }
})

it('preserves an original cause and actual unknown-style retained reservation when diagnostics throw', async () => {
  const queue = new FilesWorkQueue({ maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 1,
    maxQueuedPerLane: 1, maxResidentBytes: 10, maxResidentBytesPerLane: 10, waitTimeoutMs: 30000 })
  const lane = queue.openLane(), actual = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const cancel = new AbortController()
  const cause = Error('original cause'), promise = lane.run(8, async () => { entered.resolve(undefined); await actual.promise; throw cause },
    cancel.signal, undefined, 'joined', () => { throw Error('diagnostic failure') })
  await entered.promise; cancel.abort(); expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: 8, pending: 1 })
  const rejected = expect(promise).rejects.toBe(cause); actual.resolve(undefined); await rejected
  queue.close(); await queue.whenClosed(); expect(queue.inspect().residentBytes).toBe(0)
})

it('expires and clears its sink from the Root timer without any subsequent work', async () => {
  const f = await fixture(); f.pool.observeWorkspaceUploads(f.selection(5), () => true)
  await new Promise<void>((resolve) => { setTimeout(resolve, 15) })
  const dispose = f.pool.observeWorkspaceUploads(f.selection(), () => true); dispose()
})

it('clears the sink on Root stop while original work stays charged until actual closure', async () => {
  const f = await fixture(); f.pool.observeWorkspaceUploads(f.selection(), (row) => { f.rows.push(row); return true })
  const { pending: a } = await f.startA(), rejected = expect(a).rejects.toBeInstanceOf(Error)
  const before = f.rows.length, stopped = await f.pool.stop(Date.now() + 5)
  expect(stopped.status).toBe('unknown'); expect(f.pool.inspect().work.residentBytes).toBe(reservation)
  f.go.resolve(undefined); await rejected; await f.pool.whenClosed()
  expect(f.rows).toHaveLength(before); expect(f.pool.inspect().work.residentBytes).toBe(0)
})

it('invalidates duplicate B attribution without refusing either original queued operation', async () => {
  const f = await fixture(); let id: string | undefined, duplicate = false
  f.pool.observeWorkspaceUploads(f.selection(), (row) => {
    if (row.role !== 'B') return true
    if (id !== undefined && id !== row.id) { duplicate = true; return false }
    id = row.id; return true
  })
  const { pending: a } = await f.startA(), c1 = new AbortController(), c2 = new AbortController()
  const b1 = f.port.stageWorkspaceUploads(f.workspace, [f.source('B')], () => {}, c1.signal)
  const b2 = f.port.stageWorkspaceUploads(f.workspace, [f.source('B')], () => {}, c2.signal)
  expect(f.pool.inspect().work.queued).toBe(2); expect(duplicate).toBe(true)
  const refused1 = expect(b1).rejects.toMatchObject({ outcome: 'not-published' })
  const refused2 = expect(b2).rejects.toMatchObject({ outcome: 'not-published' })
  c1.abort(); c2.abort(); await Promise.all([refused1, refused2])
  expect(f.opened.B).toBe(0); await f.finish(a)
})

it('does not release a real mutation or replace its original cause when source closure is unknown after a sink failure', async () => {
  const f = await fixture(), abort = new AbortController(), original = Error('original caller reason')
  const closeFailure = Error('fixture source return unconfirmed'), source: WorkspaceUploadSource = {
    ...f.source('A'), open: async function* () {
      try { yield bytes('A').subarray(0, 4096); await f.go.promise; yield bytes('A').subarray(4096) }
      finally { throw closeFailure }
    } }
  f.pool.observeWorkspaceUploads(f.selection(), () => { throw Error('diagnostic only') })
  const work = f.port.stageWorkspaceUploads(f.workspace, [source], () => {}, abort.signal)
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 3)).toBeGreaterThan(0) })
  const observed = expect(work).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof FdStageFailure) || error.outcome !== 'unknown') return false
    return error.cause instanceof FdStageFailure && error.cause.cause === original
  })
  abort.abort(original); f.go.resolve(undefined); await observed
  expect(f.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: reservation })
  expect((await f.pool.stop(Date.now() + 5)).status).toBe('unknown')
  expect(f.pool.inspect().work.residentBytes).toBe(reservation)
})
