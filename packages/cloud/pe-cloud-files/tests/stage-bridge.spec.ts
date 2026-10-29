/** Private lane/protocol integration with real native source streams; Node sink fixture establishes no Linux ABI facts. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { readFileStreamVerbatim, saveFileStreamVerbatim, saveFileVerbatim } from '@deepseek-ai/dsh-attachment-local/src/file-store.ts'
import { AccountAttachments } from '@deepseek-ai/dsh-pe-cloud-runtime/src/account-attachments.ts'
import { FileUploadIntakeUnconfirmedError } from '@deepseek-ai/dsh-client-file-upload'
import { AccountRuntimeError } from '@deepseek-ai/dsh-pe-cloud-runtime/src/errors.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import { FdMutationFailure } from '../src/worker-client.ts'
import type { StageSource } from '../src/stage-bridge.ts'
import type { FdStagingLimits } from '../src/worker-protocol.ts'

const staging: FdStagingLimits = { helperPath: '/test-only/staging.node', maxFileBytes: 8 * 1024 * 1024,
  maxBatchRefs: 4, maxBatchBytes: 32 * 1024 * 1024, maxSourceChunkBytes: 65536, operationTimeoutMs: 30000,
  reservationBytes: 2 * 1024 * 1024 }

async function fixture(mode = 'normal', enabled = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stage-bridge-'))), projects = join(home, 'projects')
  const project = join(projects, 'default-workspace'), originalRoot = join(home, 'original', 'attachments', 'v1')
  mkdirSync(project, { recursive: true })
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = []
  const pool = new LinuxFilesPool({ maxLanes: 4, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 8, maxQueuedPerLane: 4,
    maxResidentBytes: 256 * 1024 * 1024, maxResidentBytesPerLane: 64 * 1024 * 1024, waitTimeoutMs: 30000,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 8 * 1024 * 1024, replyOverheadBytes: 4096,
    readyTimeoutMs: 3000, drainTimeoutMs: 20, helperPath: '/test-only/fd.node',
    maxReadBytes: 65536, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 4096,
    ...enabled ? { staging } : {},
  }, (input) => {
    const worker = new Worker(new URL('./fixtures/stage-worker.mjs', import.meta.url), { workerData: { mode, gate, staging: input.staging } })
    workers.push(worker); return worker
  })
  onTestFinished(async () => {
    Atomics.store(counters, 2, 1); Atomics.notify(counters, 2)
    await pool.stop(Date.now() + 100)
    await Promise.all(workers.map(worker => worker.terminate()))
    rmSync(home, { recursive: true, force: true })
  })
  await pool.start()
  const binding: AccountBinding = { accountId: 'stage-A' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'test-only', lifetime: new AbortController().signal }
  const info = statSync(projects, { bigint: true })
  let current = true
  const assertCurrent = () => { if (!current) throw new Error('Fixture selection expired') }
  const port = pool.bind(binding, { rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino), rootMountId: '1' }, assertCurrent)
  // Privileged selection input only; native Registry/Agent/receipt admission belongs to Root composition tests.
  const workspace = { path: project } as Workspace
  const source = async (data: Uint8Array, name = 'file.bin') => {
    const ref = await saveFileVerbatim(originalRoot, { data, name })
    let opens = 0, closed = false
    const entry: StageSource = { ref, open: async function* (signal) {
      opens++
      try { yield* readFileStreamVerbatim(originalRoot, ref, signal) } finally { closed = true }
    } }
    return { entry, data, opens: () => opens, closed: () => closed,
      path: join(project, '.pe', 'attachments', String(ref.attachmentId).slice(7), ref.name) }
  }
  return { pool, port, project, projects, originalRoot, workspace, binding, source, counters, assertCurrent,
    release: () => { Atomics.store(counters, 2, 1); Atomics.notify(counters, 2) }, stale: () => { current = false } }
}

it('stages sequential native hard-link sources with one reservation and exact single-credit frames, then fully reuses copies', async () => {
  const test = await fixture(), first = await test.source(new Uint8Array(17003).fill(137)), second = await test.source(new Uint8Array(), 'empty.bin')
  const held = await test.port.stageFiles(test.workspace, [first.entry, second.entry], test.assertCurrent)
  expect(held.value.map(value => value.outcome)).toEqual(['published', 'published'])
  expect(readFileSync(first.path)).toEqual(Buffer.from(first.data))
  expect(first.closed()).toBe(true)
  expect(second.closed()).toBe(true)
  expect(Atomics.load(test.counters, 4)).toBe(4096)
  expect(test.pool.inspect().work).toMatchObject({ lanes: 1, running: 0, pending: 1, residentBytes: staging.reservationBytes })
  held.release()
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
  const reused = await test.port.stageFiles(test.workspace, [first.entry], test.assertCurrent)
  expect(reused.value[0]?.outcome).toBe('reused')
  expect(first.opens()).toBe(1)
  reused.release()
  await vi.waitFor(() => { expect(test.pool.inspect().work.residentBytes).toBe(0) })
})

it('does not publish bytes before the original iterator completed its final validation and close', async () => {
  const test = await fixture(), original = await test.source(new Uint8Array([0, 255, 1]))
  const late = new Error('Native source trailing integrity error')
  const entry: StageSource = { ref: original.entry.ref, open: async function* () { yield original.data; throw late } }
  await expect(test.port.stageFiles(test.workspace, [entry], test.assertCurrent)).rejects.toMatchObject({ outcome: 'not-published' })
  expect(Atomics.load(test.counters, 5)).toBe(0)
  expect(readdirSync(join(test.project, '.pe', 'attachments', String(entry.ref.attachmentId).slice(7)))).toEqual([])
  await vi.waitFor(() => { expect(test.pool.inspect().work.residentBytes).toBe(0) })
})

it('releases running capacity while a successful stage result remains retained for same-lane reads', async () => {
  const test = await fixture(), source = await test.source(new Uint8Array([7]))
  const staged = await test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent)
  try {
    expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 1, residentBytes: staging.reservationBytes })
    const read = await test.port.stat('.')
    expect(read.value?.type).toBe('directory')
    read.release()
    expect(test.pool.inspect().work.residentBytes).toBe(staging.reservationBytes)
  } finally { staged.release() }
  await vi.waitFor(() => { expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
})

it('joins the real source return after sink failure before releasing operation/slot/budget', async () => {
  const test = await fixture(), original = await test.source(new Uint8Array([1, 2]), 'known.bin')
  const returning = Promise.withResolvers<undefined>(), close = Promise.withResolvers<undefined>()
  onTestFinished(() => { close.resolve(undefined) })
  const entry: StageSource = { ref: original.entry.ref, open: async function* () {
    try { yield original.data } finally { returning.resolve(undefined); await close.promise }
  } }
  const pending = test.port.stageFiles(test.workspace, [entry], test.assertCurrent)
  const rejected = expect(pending).rejects.toMatchObject({ outcome: 'not-published' })
  await returning.promise
  expect(test.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: staging.reservationBytes })
  expect(test.pool.inspect().busy).toBe(1)
  close.resolve(undefined)
  await rejected
  await vi.waitFor(() => { expect(test.pool.inspect().work.residentBytes).toBe(0) })
})

it('does not pipeline another frame or source pull while ACK is blocked and preserves running cancellation', async () => {
  const test = await fixture('block-ack'), source = await test.source(new Uint8Array(65536))
  const controller = new AbortController()
  const pending = test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent, controller.signal)
  const rejected = expect(pending).rejects.toBeInstanceOf(Error)
  await vi.waitFor(() => { expect(Atomics.load(test.counters, 1)).toBe(1) })
  expect(Atomics.load(test.counters, 3)).toBe(1)
  controller.abort()
  expect(test.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: staging.reservationBytes })
  test.release()
  await rejected
  await vi.waitFor(() => { expect(source.closed()).toBe(true) })
  await vi.waitFor(() => { expect(test.pool.inspect().work.residentBytes).toBe(0) })
})

it('retains unknown work and blocks every subsequent mutation on that original lane', async () => {
  const test = await fixture(), source = await test.source(new Uint8Array([1]), 'unknown.bin')
  await expect(test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent)).rejects.toMatchObject({ outcome: 'unknown' })
  expect(source.closed()).toBe(true)
  expect(test.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: staging.reservationBytes })
  let invoked = false
  await expect(test.port.runNativeMutation(4096, test.assertCurrent, async () => { invoked = true }))
    .rejects.toMatchObject({ outcome: 'unknown' })
  expect(invoked).toBe(false)
  expect((await test.pool.stopEpoch(test.binding, Date.now())).status).toBe('unknown')
})

it('retires malformed stage ACK transport, joins source close and retains unknown ownership without replay', async () => {
  const test = await fixture('bad-ack'), source = await test.source(new Uint8Array(4097))
  await expect(test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent)).rejects.toMatchObject({ outcome: 'unknown' })
  expect(source.closed()).toBe(true)
  expect(source.opens()).toBe(1)
  expect(Atomics.load(test.counters, 0)).toBe(1)
  expect(Atomics.load(test.counters, 3)).toBe(1)
  expect(test.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: staging.reservationBytes })
  await expect(test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent)).rejects.toMatchObject({ outcome: 'unknown' })
  expect(source.opens()).toBe(1)
  expect(Atomics.load(test.counters, 0)).toBe(1)
})

it('uses the same mutation reservation for controlled native work and a later staged batch without nested admission', async () => {
  const test = await fixture(), source = await test.source(new Uint8Array([9]))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const native = test.port.runNativeMutation(16384, test.assertCurrent, async () => {
    entered.resolve(undefined); await release.promise; return 7
  })
  await entered.promise
  let collected = 0
  const stage = test.port.stageFiles(test.workspace, () => { collected++; return [source.entry] }, test.assertCurrent)
  await vi.waitFor(() => { expect(test.pool.inspect().work.queued).toBe(1) })
  expect(source.opens()).toBe(0)
  expect(collected).toBe(0)
  release.resolve(undefined)
  const held = await native
  expect(held.value).toBe(7)
  expect(source.opens()).toBe(0)
  held.release()
  const staged = await stage
  expect(collected).toBe(1)
  staged.release()
  await vi.waitFor(() => { expect(test.pool.inspect().work.pending).toBe(0) })
})

it('rejects missing staging and oversized input before any source or sink invocation', async () => {
  const test = await fixture('normal', false), source = await test.source(new Uint8Array([1]))
  await expect(test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent)).rejects.toThrow('no verified staging')
  expect(source.opens()).toBe(0)
  expect(Atomics.load(test.counters, 0)).toBe(0)
})

it('returns a retained empty cold batch without opening any source or sink and without occupying running capacity', async () => {
  const test = await fixture()
  const held = await test.port.stageFiles(test.workspace, () => [], test.assertCurrent)
  expect(held.value).toEqual([])
  expect(Atomics.load(test.counters, 0)).toBe(0)
  expect(test.pool.inspect().work).toMatchObject({ running: 0, residentBytes: staging.reservationBytes })
  held.release()
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 })
})

it.each([
  new AccountRuntimeError('cloud/capacity', 'Cold attachment batch exceeds capacity.'),
  new Error('Cold attachment reference is not authorized.'),
])('retains a lazy collection denial as the cause without poisoning the mutation lane: %s', async (cause) => {
  const test = await fixture(), source = await test.source(new Uint8Array([5]))
  await expect(test.port.stageFiles(test.workspace, () => {
    expect(test.pool.inspect().work).toMatchObject({ running: 1, residentBytes: staging.reservationBytes })
    throw cause
  }, test.assertCurrent)).rejects.toMatchObject({ outcome: 'not-published', cause })
  expect(source.opens()).toBe(0)
  expect(Atomics.load(test.counters, 0)).toBe(0)
  await vi.waitFor(() => { expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
  const staged = await test.port.stageFiles(test.workspace, [source.entry], test.assertCurrent)
  expect(staged.value[0]?.outcome).toBe('published')
  staged.release()
  const native = await test.port.runNativeMutation(4096, test.assertCurrent, async () => 9)
  expect(native.value).toBe(9)
  native.release()
  await vi.waitFor(() => { expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
})

it('classifies lazy batch planning rejection before any source or sink open and leaves the lane usable', async () => {
  const test = await fixture(), source = await test.source(new Uint8Array([5]))
  await expect(test.port.stageFiles(test.workspace, () => [{ ...source.entry,
    ref: { ...source.entry.ref, bytes: staging.maxFileBytes + 1 } }], test.assertCurrent))
    .rejects.toMatchObject({ outcome: 'not-published', cause: { code: 'FS_TOO_LARGE' } })
  expect(source.opens()).toBe(0)
  expect(Atomics.load(test.counters, 0)).toBe(0)
  await vi.waitFor(() => { expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 }) })
  const held = await test.port.stageFiles(test.workspace, () => [], test.assertCurrent)
  held.release()
  expect(test.pool.inspect().work).toMatchObject({ running: 0, pending: 0, residentBytes: 0 })
})

it('rejects bad names/refs and batch/size excess before dispatch', async () => {
  const test = await fixture(), source = await test.source(new Uint8Array([1]))
  for (const ref of [{ ...source.entry.ref, name: '../bad' }, { ...source.entry.ref, bytes: staging.maxFileBytes + 1 }]) {
    await expect(test.port.stageFiles(test.workspace, [{ ...source.entry, ref }], test.assertCurrent))
      .rejects.toBeInstanceOf(FdMutationFailure)
  }
  await expect(test.port.stageFiles(test.workspace, Array.from({ length: 5 }, () => source.entry), test.assertCurrent))
    .rejects.toBeInstanceOf(FdMutationFailure)
  expect(source.opens()).toBe(0)
  expect(Atomics.load(test.counters, 0)).toBe(0)
  expect(test.pool.inspect().work.pending).toBe(0)
})

it('does not replace a corrupt existing copy and exposes earlier completed publications on later failure', async () => {
  const test = await fixture(), first = await test.source(new Uint8Array([1])), second = await test.source(new Uint8Array([2]), 'known.bin')
  await expect(test.port.stageFiles(test.workspace, [first.entry, second.entry], test.assertCurrent))
    .rejects.toMatchObject({ outcome: 'not-published',
      completed: [{ relativePath: `.pe/attachments/${String(first.entry.ref.attachmentId).slice(7)}/file.bin` }] })
  writeFileSync(first.path, 'changed')
  await expect(test.port.stageFiles(test.workspace, [first.entry], test.assertCurrent)).rejects.toMatchObject({ outcome: 'not-published' })
  expect(readFileSync(first.path, 'utf8')).toBe('changed')
  expect(first.opens()).toBe(1)
})


it('retains the real mutation lane when native alias publication fails after object persistence', async () => {
  const test = await fixture(), bytes = Uint8Array.of(9, 8, 7)
  const digest = createHash('sha256').update(bytes).digest('hex')
  mkdirSync(join(test.originalRoot, 'files', digest.slice(0, 2), digest, 'collision.bin'), { recursive: true })
  const feature = Object.assign(Object.create(AccountAttachments.prototype), {
    limits: { maxUploadChunkBytes: 4, maxFileBytes: 4, intakeReservationBytes: 16384 },
    binding: test.binding,
    current: () => test.workspace,
    files: () => ({ runAttachmentIntake: (reservation: number, check: () => void,
      execute: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal) =>
      test.port.runNativeMutation(reservation, check, execute, signal) }),
  }) as AccountAttachments
  await expect(feature.storeFileStream({} as never, { name: 'collision.bin', data: (async function* () { yield bytes })() },
    input => saveFileStreamVerbatim(test.originalRoot, input))).rejects.toBeInstanceOf(FileUploadIntakeUnconfirmedError)
  expect(readFileSync(join(test.originalRoot, 'file-objects', digest.slice(0, 2), digest))).toEqual(Buffer.from(bytes))
  expect(test.pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: 16384 })
  let invoked = false
  await expect(test.port.runNativeMutation(4096, test.assertCurrent, async () => { invoked = true }))
    .rejects.toMatchObject({ outcome: 'unknown' })
  expect(invoked).toBe(false)
})
