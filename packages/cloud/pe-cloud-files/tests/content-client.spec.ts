/** ABI8 transport validation and actual-settlement behavior. */
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { FdWorkerClient, FdWorkerFailure } from '../src/worker-client.ts'

const root = { rootPath: '/project', rootDevice: '1', rootInode: '2' }
const clients: FdWorkerClient[] = []
async function client(mode = 'normal', abiVersion = 8, gate?: SharedArrayBuffer): Promise<FdWorkerClient> {
  const value = new FdWorkerClient(new Worker(new URL('./fixtures/content-worker.mjs', import.meta.url), {
    workerData: { mode, abiVersion, gate },
  }))
  clients.push(value)
  await value.ready
  return value
}
afterEach(async () => { await Promise.all(clients.splice(0).map(value => value.close())) })

describe('ABI8 content transport', () => {
  it('accepts nofollow symlink metadata and definite absence', async () => {
    const value = await client()
    expect(value.supportsContentReads).toBe(true)
    expect(value.supportsTextWrites).toBe(true)
    expect(await value.lstat(root, 'link', new AbortController().signal)).toMatchObject({ type: 'symlink', size: 3 })
    expect(await value.lstat(root, 'absent', new AbortController().signal)).toBeUndefined()
  })
  it('returns bounded sorted basename metadata and exact positional bytes', async () => {
    const value = await client(), signal = new AbortController().signal
    expect((await value.list(root, '.', 2, 1024, signal)).map(entry => entry.name)).toEqual(['a', '你.txt'])
    expect(await value.readRange(root, 'file', 1, 2, 8, signal)).toEqual(new Uint8Array([2, 3]))
  })
  it.each([6, 7])('does not add content dispatch to ABI%s', async (abi) => {
    const value = await client('normal', abi), signal = new AbortController().signal
    expect(value.supportsContentReads).toBe(false)
    await expect(value.lstat(root, '.', signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(value.list(root, '.', 2, 1024, signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(value.readRange(root, 'file', 0, 1, 8, signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
  it.each(['duplicate', 'escape', 'surrogate', 'unsorted', 'invalid-size', 'over-count', 'over-bytes', 'identity-mismatch', 'extra-field'])('retires malformed %s replies after actual worker exit', async (mode) => {
    const value = await client(mode)
    await expect(value.list(root, '.', 2, 1024, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await value.exited
  })
  it.each(['range-overrun', 'range-backing'])('rejects an oversized range result or backing buffer: %s', async (mode) => {
    const value = await client(mode)
    await expect(value.readRange(root, 'file', 0, 2, 8, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it.each([[-1, 1], [0, -1], [Number.MAX_SAFE_INTEGER, 1], [0, 9]])('rejects invalid offset/length %s/%s before dispatch', async (offset, length) => {
    const value = await client()
    await expect(value.readRange(root, 'file', offset, length, 8, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(await value.lstat(root, 'absent', new AbortController().signal)).toBeUndefined()
  })
  it('keeps an aborted request pending until its actual closure reply', async () => {
    const gate = new SharedArrayBuffer(8), state = new Int32Array(gate), value = await client('blocked', 8, gate)
    const controller = new AbortController(), result = value.list(root, '.', 2, 1024, controller.signal)
    const observed = result.then(() => 'resolved', (error: unknown) => error instanceof FdWorkerFailure ? error.code : 'unexpected')
    try {
      await expect.poll(() => Atomics.load(state, 0)).toBe(1)
      controller.abort()
      let settled = false
      void observed.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(false)
    } finally { Atomics.store(state, 1, 1); Atomics.notify(state, 1) }
    expect(await observed).toBe('FS_ABORTED')
  })
})
