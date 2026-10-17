import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import type { FilesPoolConfig } from '../src/worker-pool.ts'

const pools: LinuxFilesPool[] = []
const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.stop(Date.now() + 2000)))
  await Promise.all(workers.splice(0).map(worker => worker.terminate()))
})
const config: FilesPoolConfig = {
  maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 16384, maxResidentBytesPerLane: 8192, waitTimeoutMs: 5000,
  workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128,
  replyOverheadBytes: 128, readyTimeoutMs: 2000, drainTimeoutMs: 20,
  helperPath: '/not-loaded/test.node', maxReadBytes: 100, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 2,
}
const root = { rootPath: '/approved', rootDevice: '1', rootInode: '1' }
function binding(account = 'A'): AccountBinding {
  return Object.freeze({ accountId: account as AccountId, epoch: '1' as OwnerEpoch, recipeVersion: 'test', lifetime: new AbortController().signal })
}
async function create(mode = 'normal', data: string | Uint8Array = 'A你🙂Z', gate?: SharedArrayBuffer) {
  let created = 0
  const pool = new LinuxFilesPool(config, () => {
    created++
    const worker = new Worker(new URL('./fixtures/reader-worker.mjs', import.meta.url), { workerData: { mode, data, gate, chunkSize: config.readChunkBytes } })
    workers.push(worker)
    return worker
  })
  pools.push(pool)
  await pool.start()
  const a = binding()
  const port = pool.bind(a, root, () => {})
  const reader: Pick<FileSystem, 'resolve' | 'stat' | 'streamText' | 'processPath'> = port.reader
  return { pool, a, port, reader, count: () => created }
}
async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const chunk of chunks) text += chunk
  return text
}

describe('fixed-root native instruction reader', () => {
  it('issues native targets, reads metadata and rejects foreign or copied target objects', async () => {
    const { pool, a, reader } = await create()
    const directory = await reader.resolve('.')
    expect(await reader.stat(directory)).toMatchObject({ type: 'directory', version: '1:2:9:4:5' })
    const target = await reader.resolve('AGENTS.md', { cwd: reader.processPath(directory) })
    const alias = await reader.resolve('alias')
    expect(target.targetKey).toBe(alias.targetKey)
    expect(reader.processPath(target)).toBe('/approved/AGENTS.md')
    expect(await reader.stat(target)).toMatchObject({ type: 'file', size: 9 })
    expect(await reader.stat(await reader.resolve('missing'))).toBeUndefined()
    await expect(reader.stat({ ...target })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    const other = pool.bind(binding('B'), root, () => {}).reader
    await expect(other.stat(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await pool.stopEpoch(a, Date.now() + 1000)
    expect(() => reader.processPath(target)).toThrow(/generation/)
    await expect(reader.stat(target)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('refuses paths and cwd outside the already-bound root without inferring a project', async () => {
    const { reader } = await create()
    for (const path of ['../other', '/another/AGENTS.md', 'dir/../../file']) {
      await expect(reader.resolve(path)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    }
    await expect(reader.resolve('AGENTS.md', { cwd: '/another' })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(reader.resolve('x'.repeat(config.maxPathBytes + 1))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await expect(reader.resolve('AGENTS.md', { cwd: `/approved/${'x'.repeat(config.maxPathBytes)}` }))
      .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('decodes split UTF-8 with one pull credit and keeps the slot between consumer pulls', async () => {
    const gate = new SharedArrayBuffer(12)
    const { pool, a, reader, count } = await create('normal', 'A你🙂Z', gate)
    const target = await reader.resolve('AGENTS.md')
    const stream = await reader.streamText(target)
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first).toEqual({ done: false, value: 'A' })
    expect(Atomics.load(new Int32Array(gate), 2)).toBe(1)
    await Promise.resolve()
    expect(Atomics.load(new Int32Array(gate), 2)).toBe(1)
    expect(pool.inspect().busy).toBe(1)
    let rest = ''
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      rest += next.value
    }
    expect(rest).toBe('你🙂Z')
    expect(count()).toBe(1)
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
  })

  it.each([new Uint8Array([65, 0, 66]), new Uint8Array([65, 0xff]), new Uint8Array([0xe4, 0xbd])])('rejects NUL/invalid or incomplete UTF-8 as native FS_NOT_TEXT', async (bytes) => {
    const { reader } = await create('normal', bytes)
    const target = await reader.resolve('AGENTS.md')
    await expect(collect(await reader.streamText(target))).rejects.toBeInstanceOf(FsError)
    await expect(collect(await reader.streamText(target))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('keeps actual cancellation and its reservation after the consumer returns early', async () => {
    const gate = new SharedArrayBuffer(12)
    const state = new Int32Array(gate)
    const { pool, a, reader } = await create('delayed-cancel', 'abcdef', gate)
    const stream = await reader.streamText(await reader.resolve('AGENTS.md'))
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    const unknown = await pool.stopEpoch(a, Date.now() + 20)
    expect(unknown.status).toBe('unknown')
    expect(unknown.pendingOperationIds).toHaveLength(1)
    expect(pool.inspect().busy).toBe(1)
    Atomics.store(state, 1, 1)
    Atomics.notify(state, 1)
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
    expect(pool.inspect()).toMatchObject({ busy: 0, healthy: 1 })
  })

  it('aborts the consumer wait while retaining a truly blocked worker pull until actual reply', async () => {
    const gate = new SharedArrayBuffer(12)
    const state = new Int32Array(gate)
    const { pool, a, reader } = await create('blocked-pull', 'abcdef', gate)
    const signal = new AbortController()
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md'), signal.signal))[Symbol.asyncIterator]()
    const waiting = iterator.next()
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
    signal.abort()
    await rejected
    expect((await pool.stopEpoch(a, Date.now() + 20)).status).toBe('unknown')
    expect(pool.inspect()).toMatchObject({ busy: 1, healthy: 1 })
    Atomics.store(state, 1, 1)
    Atomics.notify(state, 1)
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
    expect(pool.inspect()).toMatchObject({ busy: 0, healthy: 1 })
  })

  it('retains a paused decoder result after I/O cancellation until the iterator releases it', async () => {
    const { pool, a, reader } = await create('normal', 'abcdef')
    const abort = new AbortController()
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md'), abort.signal))[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'ab' })
    abort.abort()
    expect((await pool.stopEpoch(a, Date.now() + 30)).status).toBe('unknown')
    expect(pool.inspect().busy).toBe(1)
    await iterator.return?.()
    expect((await pool.stopEpoch(a, Date.now() + 1000)).status).toBe('confirmed')
    expect(pool.inspect()).toMatchObject({ busy: 0, healthy: 1 })
  })

  it.each(['oversized-chunk', 'crash-stream'])('retains a failed %s stream until actual worker exit', async (mode) => {
    const { pool, reader, count } = await create(mode, 'abcdef')
    const target = await reader.resolve('AGENTS.md')
    await expect(collect(await reader.streamText(target))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(pool.inspect()).toMatchObject({ healthy: 0, exited: 1 })
    expect(count()).toBe(1)
  })

  it('rejects malformed metadata and waits for actual exit', async () => {
    const { pool, reader } = await create('bad-metadata')
    await expect(reader.resolve('AGENTS.md')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(pool.inspect()).toMatchObject({ healthy: 0, exited: 1 })
  })
})
