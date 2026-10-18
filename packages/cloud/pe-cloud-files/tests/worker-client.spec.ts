import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import type { FilesPoolConfig } from '../src/worker-pool.ts'

const config: FilesPoolConfig = {
  maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1,
  maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 16384, maxResidentBytesPerLane: 8192, waitTimeoutMs: 5000,
  workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128,
  replyOverheadBytes: 128, readyTimeoutMs: 2000, drainTimeoutMs: 50,
  helperPath: '/not-loaded/test.node', maxReadBytes: 100, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 16,
}
const root = { rootPath: '/not-opened', rootDevice: '1', rootInode: '1' }
const pools: LinuxFilesPool[] = []
const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.stop(Date.now() + 2000)))
  await Promise.all(workers.splice(0).map(worker => worker.terminate()))
})
function binding(account = 'A', epoch = '1'): AccountBinding {
  return Object.freeze({
    accountId: account as AccountId, epoch: epoch as OwnerEpoch, recipeVersion: 'test',
    lifetime: new AbortController().signal,
  })
}
function createPool(mode = 'normal', gate = new SharedArrayBuffer(8), changed: Partial<FilesPoolConfig> = {}) {
  let created = 0
  const pool = new LinuxFilesPool({ ...config, ...changed }, () => {
    created++
    const worker = new Worker(new URL('./fixtures/transport-worker.mjs', import.meta.url), { workerData: { mode, gate } })
    workers.push(worker)
    return worker
  })
  pools.push(pool)
  return { pool, count: () => created }
}

describe('prebuilt files root pool', () => {
  it('prebuilds exactly N workers and reuses them across account reads and drains', async () => {
    const { pool, count } = createPool()
    const a = binding()
    expect(() => pool.bind(a, root, () => {})).toThrow()
    await pool.start()
    expect(count()).toBe(config.workerCount)
    expect(pool.inspect()).toMatchObject({ state: 'running', healthy: 2, busy: 0 })
    const port = pool.bind(a, root, () => {})
    for (let i = 0; i < 8; i++) {
      const result = await port.readBytes('file.txt', 5)
      expect([...result.value]).toEqual([1, 2, 3])
      result.release()
    }
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
    const b = binding('B')
    const next = pool.bind(b, { ...root, rootPath: '/another-root' }, () => {})
    const result = await next.readBytes('file.txt', 5)
    result.release()
    expect(count()).toBe(config.workerCount)
    expect(pool.inspect().healthy).toBe(2)
    expect(await pool.stop(Date.now() + 1000)).toMatchObject({ status: 'confirmed', pendingWorkerIds: [], pendingOperationIds: [] })
    expect(pool.inspect()).toMatchObject({ state: 'closed', exited: 2, rootReservedBytes: 0 })
  })

  it('retains actual blocked work past account drain deadline and reuses the shared pool after settlement', async () => {
    const gate = new SharedArrayBuffer(8)
    const { pool, count } = createPool('blocked', gate)
    await pool.start()
    const a = binding()
    const port = pool.bind(a, root, () => {})
    const waiting = port.readBytes('file.txt', 10)
    const state = new Int32Array(gate)
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect((await pool.stopEpoch(a, Date.now() + 20)).status).toBe('unknown')
    await rejected
    expect(pool.inspect()).toMatchObject({ state: 'running', workers: 2, healthy: 2, busy: 1 })
    expect(count()).toBe(2)
    Atomics.store(state, 1, 1)
    Atomics.notify(state, 1)
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
    expect(pool.inspect()).toMatchObject({ healthy: 2, busy: 0 })
    const b = binding('B')
    const bResult = await pool.bind(b, root, () => {}).readBytes('file.txt', 5)
    bResult.release()
    expect(count()).toBe(2)
  })

  it.each(['wrong-id', 'wrong-id-then-late', 'crash'])('never replaces a failed %s slot or forgets its actual exit', async (mode) => {
    const { pool, count } = createPool(mode, undefined, { workerCount: 1, maxRunning: 1 })
    await pool.start()
    const a = binding()
    const port = pool.bind(a, root, () => {})
    await expect(port.readBytes('file.txt', 10)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(pool.inspect()).toMatchObject({ healthy: 0, exited: 1 })
    await expect(port.readBytes('file.txt', 10)).rejects.toThrow(/healthy-worker/)
    expect(count()).toBe(1)
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
    expect((await pool.stop(Date.now() + 1000)).status).toBe('confirmed')
  })

  it('bounds root shutdown and retains delivered result ownership after workers actually exit', async () => {
    const { pool } = createPool()
    await pool.start()
    const a = binding()
    const result = await pool.bind(a, root, () => {}).readBytes('file.txt', 10)
    const receipt = await pool.stop(Date.now() + 30)
    expect(receipt.status).toBe('unknown')
    expect(receipt.pendingOperationIds).toHaveLength(1)
    expect(pool.inspect().rootReservedBytes).toBeGreaterThan(0)
    result.release()
    await pool.whenClosed()
    expect(await pool.stop(Date.now())).toMatchObject({ status: 'confirmed', pendingWorkerIds: [], pendingOperationIds: [] })
  })

  it('keeps pending worker ids when the root deadline expires before actual exit', async () => {
    const { pool } = createPool()
    await pool.start()
    const receipt = await pool.stop(Date.now())
    expect(receipt.status).toBe('unknown')
    expect(receipt.pendingWorkerIds.length).toBeGreaterThan(0)
    expect(pool.inspect().rootReservedBytes).toBeGreaterThan(0)
    await pool.whenClosed()
    expect(pool.inspect()).toMatchObject({ state: 'closed', exited: 2, rootReservedBytes: 0 })
  })

  it.each(['no-ready', 'old-abi', 'old-abi3'])('rejects %s startup without publishing a healthy replacement pool', async (mode) => {
    const { pool, count } = createPool(mode, undefined, { readyTimeoutMs: 30 })
    await expect(pool.start()).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await pool.whenClosed()
    expect(count()).toBe(2)
    expect(pool.inspect()).toMatchObject({ state: 'closed', healthy: 0, exited: 2 })
    await expect(pool.start()).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('rejects budgets that cannot reserve the prebuilt workers', () => {
    expect(() => createPool('normal', undefined, { maxResidentBytes: 200 })).toThrow()
    expect(() => createPool('normal', undefined, { workerCount: 1 })).toThrow()
    expect(() => createPool('normal', undefined, { minimumHealthyWorkers: 3 })).toThrow()
  })
})
