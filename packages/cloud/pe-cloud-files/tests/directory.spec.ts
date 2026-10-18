import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import type { FilesPoolConfig } from '../src/worker-pool.ts'
import { DirectoryMetadataFailure } from '../src/directory-error.ts'

const config: FilesPoolConfig = {
  maxLanes: 2, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 16384, maxResidentBytesPerLane: 8192, waitTimeoutMs: 5000,
  workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 128,
  readyTimeoutMs: 2000, drainTimeoutMs: 30,
  helperPath: '/not-loaded/test.node', maxReadBytes: 100, maxPathBytes: 256, maxResolveRetries: 2, readChunkBytes: 2,
}
const root = { rootPath: '/approved', rootDevice: '1', rootInode: '1' }
const pools: LinuxFilesPool[] = []
const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.stop(Date.now() + 2000)))
  await Promise.all(workers.splice(0).map(worker => worker.terminate()))
})
async function setup(mode = 'normal', gate?: SharedArrayBuffer, changed: Partial<FilesPoolConfig> = {}) {
  const pool = new LinuxFilesPool({ ...config, ...changed }, () => {
    const worker = new Worker(new URL('./fixtures/directory-worker.mjs', import.meta.url), {
      workerData: { mode, gate, maxPathBytes: config.maxPathBytes },
    })
    workers.push(worker)
    return worker
  })
  pools.push(pool)
  await pool.start()
  const binding: AccountBinding = Object.freeze({
    accountId: 'A' as AccountId, epoch: '1' as OwnerEpoch, recipeVersion: 'test', lifetime: new AbortController().signal,
  })
  const port = pool.bind(binding, root, () => {})
  return { pool, port, binding }
}

describe('fixed-root read-only directory metadata', () => {
  it('returns worker physical spelling and performs sequential canonical/stat at running capacity one', async () => {
    const gate = new SharedArrayBuffer(12)
    const { pool, port, binding } = await setup('normal', gate)
    const path = await port.directory.canonicalPath('/approved/alias')
    expect(path).toBe('/physical/folder')
    expect(await port.directory.isDirectory(path)).toBe(true)
    expect(await port.directory.canonicalPath('/approved/nested/../folder')).toBe(path)
    expect(await port.directory.isDirectory('/approved/file')).toBe(false)
    expect(Atomics.load(new Int32Array(gate), 2)).toBe(4)
    expect(pool.inspect()).toMatchObject({ workers: 1, healthy: 1, busy: 0 })
    expect('ensureDirectory' in port.directory).toBe(false)
    expect((await pool.stopEpoch(binding, Date.now() + 1000)).status).toBe('confirmed')
  })

  it.each([
    ['target-missing', 'missing', 'target', 'ENOENT'],
    ['ancestor-file', 'not-directory', 'target', 'ENOTDIR'],
    ['anchor-missing', 'unavailable', 'anchor', 'ENOENT'],
    ['verify-missing', 'unavailable', 'verify', 'ENOENT'],
    ['backend-error', 'unavailable', 'target', 'EIO'],
    ['denied', 'unavailable', 'target', 'EACCES'],
  ])('keeps %s distinct from a missing target', async (mode, reason, phase, syscallCode) => {
    const { port, pool } = await setup(mode)
    await expect(port.directory.isDirectory('/approved/folder')).rejects.toMatchObject({ reason, phase, syscallCode })
    expect(pool.inspect()).toMatchObject({ healthy: 1, busy: 0 })
  })

  it('rejects out-of-root, relative, NUL, and oversized inputs without dispatching a worker', async () => {
    const gate = new SharedArrayBuffer(12)
    const { port } = await setup('normal', gate)
    for (const input of ['relative', '/approved-other/folder', '/another/folder', '/approved/\0bad', `/approved/${'x'.repeat(256)}`]) {
      await expect(port.directory.canonicalPath(input)).rejects.toMatchObject({ reason: 'unavailable', phase: 'input' })
    }
    expect(Atomics.load(new Int32Array(gate), 2)).toBe(0)
  })

  it('keeps capacity failures unavailable and refuses the operation before dispatch', async () => {
    const gate = new SharedArrayBuffer(12)
    const { port } = await setup('normal', gate, { maxResidentBytes: 129, maxResidentBytesPerLane: 1 })
    await expect(port.directory.canonicalPath('/approved/folder')).rejects.toMatchObject({
      reason: 'unavailable', phase: 'admission', cause: { code: 'cloud/capacity' },
    })
    expect(Atomics.load(new Int32Array(gate), 2)).toBe(0)
  })

  it('retains real running work after generation cancellation and never starts cancelled queued metadata', async () => {
    const gate = new SharedArrayBuffer(12)
    const state = new Int32Array(gate)
    const { pool, port, binding } = await setup('blocked', gate)
    const first = port.directory.canonicalPath('/approved/folder')
    const firstRejected = expect(first).rejects.toMatchObject({ reason: 'unavailable', cause: { code: 'cloud/stale-generation' } })
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    const queued = port.directory.isDirectory('/approved/file')
    const queuedRejected = expect(queued).rejects.toMatchObject({ reason: 'unavailable' })
    expect((await pool.stopEpoch(binding, Date.now() + 20)).status).toBe('unknown')
    await Promise.all([firstRejected, queuedRejected])
    expect(pool.inspect().busy).toBe(1)
    expect(Atomics.load(state, 2)).toBe(1)
    Atomics.store(state, 1, 1)
    Atomics.notify(state, 1)
    expect((await pool.stopEpoch(binding, Date.now() + 1000)).status).toBe('confirmed')
    expect(pool.inspect()).toMatchObject({ busy: 0, healthy: 1 })
    await expect(port.directory.isDirectory('/approved/file')).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('preserves caller cancellation cause while the actual reply remains owned', async () => {
    const gate = new SharedArrayBuffer(12)
    const state = new Int32Array(gate)
    const { pool, port, binding } = await setup('blocked', gate)
    const caller = new AbortController()
    const waiting = port.directory.canonicalPath('/approved/folder', caller.signal)
    const reason = new Error('observer stopped')
    const rejected = expect(waiting).rejects.toMatchObject({ reason: 'unavailable', cause: reason })
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    caller.abort(reason)
    await rejected
    expect(pool.inspect().busy).toBe(1)
    Atomics.store(state, 1, 1)
    Atomics.notify(state, 1)
    expect((await pool.stopEpoch(binding, Date.now() + 1000)).status).toBe('confirmed')
  })

  it.each(['invalid-phase', 'oversized', 'outside-result', 'relative-result', 'wrong-id-then-late', 'crash'])
  ('treats %s as unavailable only after actual worker exit', async (mode) => {
    const { pool, port } = await setup(mode)
    await expect(port.directory.canonicalPath('/approved/folder')).rejects.toBeInstanceOf(DirectoryMetadataFailure)
    expect(pool.inspect()).toMatchObject({ healthy: 0, exited: 1, busy: 0 })
    expect(workers).toHaveLength(1)
  })
})
