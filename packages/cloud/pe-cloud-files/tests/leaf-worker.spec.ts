import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import type { FilesPoolConfig, IsolatedLeafGrant } from '../src/worker-pool.ts'
import { directoryWorkBudget } from '../src/directory-budget.ts'
import { FilesWorkQueue } from '../src/work-queue.ts'
import { parseLeafFrame } from '../src/leaf-frame.ts'

const root = { rootPath: '/projects', rootDevice: '1', rootInode: '2' }
const intent = { parent: root, leaf: 'default-workspace' }
const config: FilesPoolConfig = {
  maxLanes: 2, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 1, maxQueuedPerLane: 1,
  maxResidentBytes: 16552, maxResidentBytesPerLane: 16424, waitTimeoutMs: 1000,
  workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 32,
  readyTimeoutMs: 1000, drainTimeoutMs: 20, helperPath: '/not-loaded/fd.node',
  maxReadBytes: 32, maxPathBytes: 128, maxResolveRetries: 2, readChunkBytes: 2,
}
const workers: Worker[] = [], pools: LinuxFilesPool[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.stop(Date.now() + 20)))
  await Promise.all(workers.splice(0).map(worker => worker.terminate()))
})
async function setup(mode = 'created', gate?: SharedArrayBuffer, changes: Partial<FilesPoolConfig> = {}) {
  const pool = new LinuxFilesPool({ ...config, ...changes }, () => {
    const worker = new Worker(new URL('./fixtures/leaf-worker.mjs', import.meta.url), { workerData: { mode, gate } })
    workers.push(worker)
    return worker
  })
  pools.push(pool)
  await pool.start()
  const binding: AccountBinding = Object.freeze({ accountId: 'A' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'transport-only', lifetime: new AbortController().signal })
  const bound = pool.bind(binding, root, () => {})
  let exclusive = true
  // This is a simulated trusted input for transport tests, not a real namespace/permission proof.
  const grant: IsolatedLeafGrant = { backend: 'root-owned-isolated-linux-tmpfs', binding, parent: root,
    leaf: intent.leaf, assertExclusive: () => { if (!exclusive) throw new Error('fixture window ended') } }
  const port = bound.derivePreparedLeaf(grant)
  return { pool, bound, binding, grant, port, endWindow: () => { exclusive = false }, restoreWindow: () => { exclusive = true } }
}

describe('ABI5 single-leaf transport and shared pool lifecycle', () => {
  it('retains Rdir after actual created frame and cleans on the same idle slot after business close', async () => {
    const { pool, binding, port, bound } = await setup()
    const work = port.prepare()
    expect(await work.observation.waitPrepared()).toBe('created')
    expect(pool.inspect().work).toMatchObject({ running: 0, residentBytes: 10284, pending: 1 })
    expect(await pool.stopEpoch(binding, Date.now())).toMatchObject({ status: 'unknown', pendingOperationIds: [work.observation.id] })
    expect((await pool.stop(Date.now() + 10)).status).toBe('unknown')
    expect(pool.inspect()).toMatchObject({ state: 'closing', healthy: 1, exited: 0 })
    await expect(bound.directory.isDirectory('/projects')).rejects.toMatchObject({ reason: 'unavailable' })
    expect(() => port.prepare()).toThrow()
    expect(await work.control.cleanup()).toBe('cleaned')
    await pool.whenClosed()
    expect(pool.inspect()).toMatchObject({ state: 'closed', exited: 1 })
    expect(pool.inspect().work).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
    expect(workers).toHaveLength(1)
  })

  it('progresses sequential metadata/read then cleanup at one slot and exact combined reservation', async () => {
    const { pool, port, bound } = await setup()
    const work = port.prepare()
    await work.observation.waitPrepared()
    const canonical = await bound.directory.canonicalPath('/projects/default-workspace')
    expect(canonical).toBe('/projects/default-workspace')
    expect(await bound.directory.isDirectory(canonical)).toBe(true)
    const metadata = await bound.stat('default-workspace')
    metadata.release()
    const bytes = await bound.readBytes('default-workspace/file', 3)
    bytes.release()
    expect(pool.inspect()).toMatchObject({ busy: 0, healthy: 1 })
    expect(await work.control.cleanup()).toBe('cleaned')
  })

  it('does not automatically re-admit cleanup after queue overflow', async () => {
    const gate = new SharedArrayBuffer(12), state = new Int32Array(gate)
    const { port, bound, pool } = await setup('blocked-read', gate)
    const work = port.prepare()
    await work.observation.waitPrepared()
    const first = bound.readBytes('file', 1)
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    const second = bound.readBytes('file', 1)
    await expect(work.control.cleanup()).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(Atomics.load(state, 2)).toBe(0)
    Atomics.store(state, 1, 1); Atomics.notify(state, 1)
    for (const result of await Promise.all([first, second])) result.release()
    expect(pool.inspect().busy).toBe(0)
    expect(Atomics.load(state, 2)).toBe(0)
    expect(await work.control.cleanup()).toBe('cleaned')
    expect(Atomics.load(state, 2)).toBe(1)
  })

  it('keeps an exposed leaf pending without sending a cleanup command', async () => {
    const gate = new SharedArrayBuffer(12), state = new Int32Array(gate)
    const { port, pool, binding } = await setup('created', gate)
    const work = port.prepare()
    await work.observation.waitPrepared()
    expect(work.control.expose()).toBe('/projects/default-workspace')
    await expect(work.control.cleanup()).rejects.toThrow()
    expect(Atomics.load(state, 2)).toBe(0)
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
  })

  it.each(['not-created', 'anchor-missing'])('rejects %s business and settles proved no-create responsibility', async (mode) => {
    const { pool, binding, port } = await setup(mode)
    const work = port.prepare()
    await expect(work.observation.waitPrepared()).rejects.toMatchObject({ fact: 'not-created' })
    await expect(work.observation.waitPrepared()).rejects.toMatchObject({ fact: 'not-created' })
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('confirmed')
    await expect(work.control.cleanup()).rejects.toThrow()
  })

  it('never restores cleanup after failed post-create parent verification, even when the path and window recover', async () => {
    const gate = new SharedArrayBuffer(12), state = new Int32Array(gate)
    const { pool, binding, port, bound, endWindow, restoreWindow } = await setup('known-failure', gate)
    const work = port.prepare()
    await expect(work.observation.waitPrepared()).rejects.toMatchObject({ fact: 'unknown', details: { errno: 5, phase: 5 } })
    endWindow()
    restoreWindow()
    expect(await bound.directory.isDirectory('/projects/default-workspace')).toBe(true)
    expect(port.prepare().observation.id).toBe(work.observation.id)
    expect(() => work.control.expose()).toThrow()
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
    await expect(work.control.cleanup()).rejects.toThrow()
    expect(Atomics.load(state, 2)).toBe(0)
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
  })

  it('retains private cleanup after only an observer abort and a fully verified CREATED frame', async () => {
    const gate = new SharedArrayBuffer(8), state = new Int32Array(gate)
    const { pool, binding, port } = await setup('blocked-prepare', gate)
    const work = port.prepare()
    const observer = new AbortController()
    const reason = new Error('only observation ended')
    const rejected = expect(work.observation.waitPrepared(observer.signal)).rejects.toBe(reason)
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    observer.abort(reason)
    await rejected
    Atomics.store(state, 1, 1); Atomics.notify(state, 1)
    expect(await work.observation.waitPrepared()).toBe('created')
    expect(await work.control.cleanup()).toBe('cleaned')
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('confirmed')
  })

  it.each(['unknown', 'crash', 'bad-tag', 'bad-close', 'bad-parent', 'bad-reserved', 'bad-operation', 'pooled', 'wrong-id'])
  ('retains %s as unknown without cleanup or replacement', async (mode) => {
    const { pool, binding, port } = await setup(mode)
    const work = port.prepare()
    await expect(work.observation.waitPrepared()).rejects.toThrow()
    await expect(work.control.cleanup()).rejects.toThrow()
    const receipt = await pool.stopEpoch(binding, Date.now())
    expect(receipt).toMatchObject({ status: 'unknown', pendingOperationIds: [work.observation.id] })
    expect(workers).toHaveLength(1)
    if (mode !== 'unknown') expect(pool.inspect()).toMatchObject({ exited: 1, healthy: 0 })
    else expect(pool.inspect()).toMatchObject({ healthy: 1, work: { residentBytes: 10284 } })
  })

  it('keeps cleanup unknown and never replays an executed failed attempt', async () => {
    const { pool, binding, port } = await setup('cleanup-unknown')
    const work = port.prepare()
    await work.observation.waitPrepared()
    await expect(work.control.cleanup()).rejects.toMatchObject({ details: { errno: 39, phase: 6 } })
    await expect(work.control.cleanup()).rejects.toThrow()
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
  })

  it('preserves a late created frame after generation cancellation', async () => {
    const gate = new SharedArrayBuffer(8), state = new Int32Array(gate)
    const { pool, binding, port } = await setup('blocked-prepare', gate)
    const work = port.prepare()
    const rejected = expect(work.observation.waitPrepared()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
    await rejected
    Atomics.store(state, 1, 1); Atomics.notify(state, 1)
    await vi.waitFor(() => { expect(pool.inspect().busy).toBe(0) })
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
    expect(await work.control.cleanup()).toBe('cleaned')
  })

  it('uses one actual healthy idle cleanup slot below the ordinary minimum', async () => {
    const { pool, binding, port, bound } = await setup('created', undefined,
      { workerCount: 2, minimumHealthyWorkers: 2, maxResidentBytes: 32768 })
    const work = port.prepare()
    await work.observation.waitPrepared()
    await workers[1]?.terminate()
    await vi.waitFor(() => { expect(pool.inspect().healthy).toBe(1) })
    await expect(bound.readBytes('file', 1)).rejects.toThrow()
    expect((await pool.stop(Date.now())).status).toBe('unknown')
    expect(await work.control.cleanup()).toBe('cleaned')
    await pool.whenClosed()
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('confirmed')
  })

  it('retains responsibility with zero healthy slots and no automatic replacement', async () => {
    const { pool, binding, port } = await setup()
    const work = port.prepare()
    await work.observation.waitPrepared()
    await workers[0]?.terminate()
    await vi.waitFor(() => { expect(pool.inspect().healthy).toBe(0) })
    await expect(work.control.cleanup()).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
    expect((await pool.stop(Date.now())).status).toBe('unknown')
    expect(workers).toHaveLength(1)
  })

  it('refuses another binding, parent or naming input and never treats a lost window as cleanup proof', async () => {
    const { bound, grant, port, endWindow, pool, binding } = await setup()
    expect(() => bound.derivePreparedLeaf({ ...grant, binding: { ...binding } })).toThrow()
    expect(() => bound.derivePreparedLeaf({ ...grant, parent: { ...root, rootInode: '99' } })).toThrow()
    expect(() => bound.derivePreparedLeaf({ ...grant, leaf: 'client-title' })).toThrow()
    const work = port.prepare()
    await work.observation.waitPrepared()
    endWindow()
    expect(() => work.control.expose()).toThrow('fixture window ended')
    await expect(work.control.cleanup()).rejects.toThrow('fixture window ended')
    expect((await pool.stopEpoch(binding, Date.now())).status).toBe('unknown')
  })
})

describe('leaf budget and fixed frame facts', () => {
  it('reserves exact ABI5 native/frame additions without enlarging capacity defaults', () => {
    expect(directoryWorkBudget(intent, config)).toEqual({ ioBytes: 6140, responsibilityBytes: 10284, totalBytes: 16424 })
  })

  it('does not infer no-create merely from a thrown EACCES-shaped error', async () => {
    const budget = directoryWorkBudget(intent, config)
    const queue = new FilesWorkQueue({ maxLanes: 2, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 1, maxQueuedPerLane: 1,
      waitTimeoutMs: 1000, maxResidentBytes: budget.totalBytes, maxResidentBytesPerLane: budget.totalBytes })
    const lane = queue.openLane()
    const work = lane.prepareDirectory(intent, config, () => { throw Object.assign(new Error('lost actual fact'), { code: 'EACCES' }) })
    await expect(work.observation.waitPrepared()).rejects.toThrow('lost actual fact')
    queue.close()
    expect(queue.inspect()).toMatchObject({ residentBytes: budget.responsibilityBytes, pending: 1 })
  })

  it('refuses no-create proof for ambiguous mkdir errors and permits prior definite EEXIST proof', () => {
    const frame = new Uint8Array(64), v = new DataView(frame.buffer)
    v.setUint32(0, 0x44534635); frame[4] = 1; frame[5] = 1; frame[6] = 3; frame[7] = 4
    v.setUint32(8, 5, true); v.setUint32(12, 97, true)
    v.setBigUint64(32, 1n, true); v.setBigUint64(40, 2n, true)
    v.setUint32(48, 5, true)
    expect(parseLeafFrame(frame, 1, root)).toBeUndefined()
    v.setUint32(48, 17, true)
    expect(parseLeafFrame(frame, 1, root)).toMatchObject({ tag: 3, failure: { errno: 5 } })
  })
})
