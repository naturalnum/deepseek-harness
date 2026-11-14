/** ABI8 transport validation and actual-settlement behavior. */
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { FdWorkerClient, FdWorkerFailure, FdDirectoryCloseFailure } from '../src/worker-client.ts'

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
    const listing = await value.listDirectory(root, '.', 2, 1024, signal)
    expect(listing.entries.map(entry => entry.name)).toEqual(['a', '你.txt'])
    expect(listing.truncated).toBe(false)
    expect(await value.readRange(root, 'file', 1, 2, 8, signal)).toEqual(new Uint8Array([2, 3]))
  })
  it.each([6, 7])('does not add content dispatch to ABI%s', async (abi) => {
    const value = await client('normal', abi), signal = new AbortController().signal
    expect(value.supportsContentReads).toBe(false)
    await expect(value.lstat(root, '.', signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(value.listDirectory(root, '.', 2, 1024, signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(value.readRange(root, 'file', 0, 1, 8, signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
  it('retains a valid provider truncation flag without treating the subset as complete', async () => {
    const value = await client('partial')
    const listing = await value.listDirectory(root, '.', 2, 1024, new AbortController().signal)
    expect(listing.entries.map(entry => entry.name)).toEqual(['a', '你.txt'])
    expect(listing.truncated).toBe(true)
  })
  it('preserves the complete-list contract used by internal skill tree validators', async () => {
    const full = await client(), partial = await client('partial'), signal = new AbortController().signal
    expect((await full.list(root, '.', 2, 1024, signal)).map(entry => entry.name)).toEqual(['a', '你.txt'])
    await expect(partial.list(root, '.', 2, 1024, signal)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(partial.available).toBe(true)
    expect(await partial.lstat(root, 'absent', signal)).toBeUndefined()
  })
  it('rejects the complete content group when an ABI8 worker omits directory completeness', async () => {
    const value = await client('missing-directory-version'), signal = new AbortController().signal
    expect(value.supportsContentReads).toBe(false)
    await expect(value.lstat(root, '.', signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(value.listDirectory(root, '.', 2, 1024, signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(value.readRange(root, 'file', 0, 1, 8, signal)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
  it('rejects an unknown directory capability version during the actual ready handshake', async () => {
    await expect(client('unknown-directory-version')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it.each(['duplicate', 'escape', 'surrogate', 'unsorted', 'invalid-size', 'over-count', 'over-bytes', 'identity-mismatch',
    'extra-field', 'legacy-list', 'missing-truncated', 'invalid-truncated', 'empty-partial', 'extra-listing-field'])('retires malformed %s replies after actual worker exit', async (mode) => {
    const value = await client(mode)
    await expect(value.listDirectory(root, '.', 2, 1024, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await value.exited
  })
  it.each([
    { mode: 'normal', delta: -1 }, { mode: 'normal', delta: 0 }, { mode: 'normal', delta: 1 },
    { mode: 'escaped', delta: -1 }, { mode: 'escaped', delta: 0 }, { mode: 'escaped', delta: 1 },
  ])('charges the complete multibyte listing frame at the exact boundary $mode/$delta', async ({ mode, delta }) => {
    const metadata = { identity: '1:2', version: '1:2:3:4:5', type: 'file', size: 3 }
    const bytes = Buffer.byteLength(JSON.stringify({ kind: 'list-reply', id: '0'.repeat(36),
      listing: { entries: [{ name: 'a', ...metadata }, { name: mode === 'escaped' ? '你"\n.txt' : '你.txt', ...metadata }], truncated: false } }))
    const value = await client(mode), result = value.listDirectory(root, '.', 2, bytes + delta, new AbortController().signal)
    if (delta < 0) await expect(result).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    else expect((await result).entries).toHaveLength(2)
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
    const controller = new AbortController(), result = value.listDirectory(root, '.', 2, 1024, controller.signal)
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
  it('refuses success and retires the worker after an unconfirmed closure failure', async () => {
    const value = await client('close-unknown')
    const result = value.listDirectory(root, '.', 2, 1024, new AbortController().signal)
    await expect(result).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await value.exited
    expect(value.available).toBe(false)
  })
})


describe('independent directory enumeration transport', () => {
  it('keeps ordinary content usable when paging was not selected', async () => {
    const value = await client(), signal = new AbortController().signal
    expect(value.supportsDirectoryPaging).toBe(false)
    expect(() => value.enumerateDirectory(root, '.', 64, 4096, 255, signal)).toThrow(FdWorkerFailure)
    expect((await value.listDirectory(root, '.', 2, 1024, signal)).truncated).toBe(false)
  })
  it('admits actual ready/page/EOF closure facts and reuses the same original worker', async () => {
    const value = await client('paging-normal'), signal = new AbortController().signal
    expect(value.supportsDirectoryPaging).toBe(true)
    const enumeration = value.enumerateDirectory(root, '.', 64, 4096, 255, signal)
    expect(await enumeration.ready).toBe('1:2:3:4:5:6:7')
    let closed = false
    void enumeration.closed.then(() => { closed = true })
    expect((await enumeration.pull()).entries.map(entry => entry.name)).toEqual(['a'])
    expect(closed).toBe(false)
    expect(await enumeration.pull()).toMatchObject({ eof: true, closed: true, entries: [{ name: 'b' }] })
    await enumeration.closed
    await enumeration.finished
    expect(value.available).toBe(true)
    expect(await value.lstat(root, 'absent', signal)).toBeUndefined()
  })
  it('keeps requested close pending behind the real closure-reply barrier', async () => {
    const gate = new SharedArrayBuffer(8), state = new Int32Array(gate), value = await client('paging-block-close', 8, gate)
    const enumeration = value.enumerateDirectory(root, '.', 64, 4096, 255, new AbortController().signal)
    await enumeration.ready
    const closing = enumeration.close()
    let closed = false
    void closing.then(() => { closed = true })
    try {
      await expect.poll(() => Atomics.load(state, 0)).toBe(1)
      expect(closed).toBe(false)
    } finally { Atomics.store(state, 1, 1); Atomics.notify(state, 1) }
    await closing
    await enumeration.finished
    expect(await value.lstat(root, 'absent', new AbortController().signal)).toBeUndefined()
  })
  it('reports operation failure separately from a confirmed native close', async () => {
    const value = await client('paging-operation-failure')
    const enumeration = value.enumerateDirectory(root, '.', 64, 4096, 255, new AbortController().signal)
    await enumeration.ready
    await expect(enumeration.pull()).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(enumeration.finished).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await enumeration.closed
    expect(value.available).toBe(true)
  })
  it('does not turn actual worker exit into native directory closure confirmation', async () => {
    const value = await client('paging-close-unknown')
    const enumeration = value.enumerateDirectory(root, '.', 64, 4096, 255, new AbortController().signal)
    await enumeration.ready
    await expect(enumeration.close()).rejects.toBeInstanceOf(FdDirectoryCloseFailure)
    await value.exited
    await expect(enumeration.closed).rejects.toBeInstanceOf(FdDirectoryCloseFailure)
    await expect(enumeration.finished).rejects.toBeInstanceOf(FdDirectoryCloseFailure)
  })
  it.each(['paging-version', 'paging-false-close', 'paging-empty', 'paging-extra', 'paging-duplicate',
    'paging-name', 'paging-sequence'])('retires malformed %s pages without a false closure fact', async (mode) => {
    const value = await client(mode)
    const enumeration = value.enumerateDirectory(root, '.', 64, 4096, 255, new AbortController().signal)
    await enumeration.ready
    await expect(enumeration.pull()).rejects.toBeInstanceOf(FdDirectoryCloseFailure)
    await value.exited
    await expect(enumeration.closed).rejects.toBeInstanceOf(FdDirectoryCloseFailure)
  })
  it('rejects unknown paging versions in the original handshake', async () => {
    await expect(client('paging-unknown-version')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})
