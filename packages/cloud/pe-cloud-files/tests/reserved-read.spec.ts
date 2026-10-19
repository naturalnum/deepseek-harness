import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { createReservedReadSession } from '../src/reserved-read.ts'
import type { ReservedReadSource } from '../src/reserved-read.ts'
import { FdWorkerClient, FdWorkerFailure } from '../src/worker-client.ts'
import type { FdByteStream } from '../src/worker-client.ts'
import type { FdMetadata, FdRootIdentity } from '../src/worker-protocol.ts'

const limits = { maxPathBytes: 1024, maxReadBytes: 128, readChunkBytes: 4 }
const root: FdRootIdentity = { rootPath: '/approved/instructions', rootDevice: '1', rootInode: '2' }
const sources: readonly ReservedReadSource[] = [
  { root },
  { root: { rootPath: '/project', rootDevice: '3', rootInode: '4' } },
]
const metadata: FdMetadata = { identity: '1:2', version: '1:2:3:4:5', type: 'file', size: 4 }

function byteStream(chunks: readonly Uint8Array<ArrayBuffer>[] = [], delayedCancel = false) {
  const finished = Promise.withResolvers<undefined>()
  let index = 0
  const next = vi.fn(async (): Promise<IteratorResult<Uint8Array<ArrayBuffer>>> => {
    const chunk = chunks[index++]
    if (chunk !== undefined) return { done: false, value: chunk }
    finished.resolve(undefined)
    return { done: true, value: undefined }
  })
  const cancel = vi.fn(() => {
    if (!delayedCancel) finished.reject(new FdWorkerFailure('FS_ABORTED'))
  })
  const stream: FdByteStream = { finished: finished.promise, next, cancel }
  return { stream, next, cancel, finished }
}

function clientWith(stream = byteStream()) {
  const stat = vi.fn<FdWorkerClient['stat']>(async () => metadata)
  const open = vi.fn<FdWorkerClient['stream']>(() => stream.stream)
  const client: Pick<FdWorkerClient, 'stat' | 'stream'> = { stat, stream: open }
  return { client, stat, open }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = ''
  for await (const chunk of stream) result += chunk
  return result
}

describe('one reserved multi-source read session', () => {
  it('uses independent fixed source anchors and the same client without another lane reservation', async () => {
    const bytes = byteStream([Uint8Array.of(65, 0xe4), Uint8Array.of(0xbd, 0xa0), Uint8Array.of(90)])
    const { client, stat, open } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const [account, project] = session.readers
    const a = await account!.resolve('AGENTS.md')
    expect(account!.processPath(a)).toBe('/approved/instructions/AGENTS.md')
    expect(await account!.stat(a)).toMatchObject({ type: 'file', size: 4 })
    expect(stat.mock.calls.slice(0, 2).map(call => call.slice(0, 2)))
      .toEqual([[root, 'AGENTS.md'], [root, 'AGENTS.md']])
    expect(await collect(await account!.streamText(a))).toBe('A你Z')
    expect(open).toHaveBeenCalledWith(root, 'AGENTS.md', 128, 4, expect.any(AbortSignal))
    const p = await project!.resolve('CLAUDE.md')
    expect(project!.processPath(p)).toBe('/project/CLAUDE.md')
    expect(stat.mock.lastCall?.slice(0, 2)).toEqual([sources[1]!.root, 'CLAUDE.md'])
    expect(Object.isFrozen(session.readers)).toBe(true)
    await session.close()
  })

  it('captures independent source anchors and limits without rebinding to later input changes', async () => {
    const sourceRoot = { ...root }
    const source = { root: sourceRoot }
    const settings = { ...limits }
    const { client, stat, open } = clientWith()
    const session = createReservedReadSession(client, [source], settings, () => {}, new AbortController().signal)
    sourceRoot.rootPath = '/foreign'
    settings.maxReadBytes = 999
    const reader = session.readers[0]!
    const target = await reader.resolve('AGENTS.md')
    expect(reader.processPath(target)).toBe('/approved/instructions/AGENTS.md')
    expect(stat.mock.lastCall?.slice(0, 2)).toEqual([root, 'AGENTS.md'])
    expect(await collect(await reader.streamText(target))).toBe('')
    expect(open.mock.lastCall?.slice(0, 4)).toEqual([root, 'AGENTS.md', 128, 4])
    await session.close()
  })

  it('rejects private siblings, other source anchors, copied targets and oversized paths before worker I/O', async () => {
    const { client, stat } = clientWith()
    const session = createReservedReadSession(client, sources, { ...limits, maxPathBytes: 32 }, () => {}, new AbortController().signal)
    const reader = session.readers[0]!
    for (const path of ['../credentials', '/approved/credentials', '/project/AGENTS.md']) {
      await expect(reader.resolve(path)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    }
    await expect(reader.resolve('x'.repeat(33))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(stat).not.toHaveBeenCalled()
    const target = await reader.resolve('AGENTS.md')
    await expect(reader.stat({ ...target })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(session.readers[1]!.stat(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(stat).toHaveBeenCalledOnce()
    await session.close()
  })

  it('seals escaped readers and never starts a stream obtained before close but consumed afterwards', async () => {
    const { client, stat, open } = clientWith()
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const reader = session.readers[0]!
    const target = await reader.resolve('AGENTS.md')
    const lazy = await reader.streamText(target)
    expect(open).not.toHaveBeenCalled()
    const closing = session.close()
    expect(session.close()).toBe(closing)
    await closing
    await expect(reader.resolve('AGENTS.md')).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(reader.stat(target)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(reader.streamText(target)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(() => reader.processPath(target)).toThrow(expect.objectContaining({ code: 'FS_ABORTED' }))
    await expect(collect(lazy)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(stat).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps close pending until a cancelled stat actually replies and rejects its late target', async () => {
    const { client, stat } = clientWith()
    const held = Promise.withResolvers<FdMetadata | undefined>()
    stat.mockReturnValueOnce(held.promise)
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const resolving = session.readers[0]!.resolve('AGENTS.md')
    const rejected = expect(resolving).rejects.toMatchObject({ code: 'FS_ABORTED' })
    let closed = false
    const closing = session.close().then(() => { closed = true })
    expect(stat.mock.lastCall?.[2].aborted).toBe(true)
    await Promise.resolve()
    expect(closed).toBe(false)
    held.resolve(metadata)
    await rejected
    await closing
    expect(closed).toBe(true)
  })

  it('cancels an idle open stream and joins finished rather than consumer return or cancellation', async () => {
    const bytes = byteStream([Uint8Array.of(65)], true)
    const { client } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const reader = session.readers[0]!
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'A' })
    await iterator.return?.()
    expect(bytes.cancel).toHaveBeenCalledOnce()
    let closed = false
    const closing = session.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    bytes.finished.reject(new FdWorkerFailure('FS_ABORTED'))
    await closing
    expect(bytes.cancel).toHaveBeenCalledOnce()
  })

  it('discards a late stream pull after close while retaining its separate actual completion', async () => {
    const bytes = byteStream([], true)
    const pull = Promise.withResolvers<IteratorResult<Uint8Array<ArrayBuffer>>>()
    bytes.next.mockReturnValueOnce(pull.promise)
    const { client } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const reader = session.readers[0]!
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
    const next = iterator.next()
    const rejected = expect(next).rejects.toMatchObject({ code: 'FS_ABORTED' })
    let closed = false
    const closing = session.close().then(() => { closed = true })
    expect(bytes.cancel).toHaveBeenCalledOnce()
    pull.resolve({ done: false, value: Uint8Array.of(65) })
    await rejected
    expect(closed).toBe(false)
    bytes.finished.reject(new FdWorkerFailure('FS_ABORTED'))
    await closing
  })

  it('keeps owner-current checks around real results and never delivers a stale snapshot chunk', async () => {
    let active = true
    const check = (): void => { if (!active) throw new Error('Original owner retired') }
    const bytes = byteStream([], true)
    const pull = Promise.withResolvers<IteratorResult<Uint8Array<ArrayBuffer>>>()
    bytes.next.mockReturnValueOnce(pull.promise)
    const { client } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, check, new AbortController().signal)
    const reader = session.readers[0]!
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
    const next = iterator.next()
    const rejected = expect(next).rejects.toThrow('Original owner retired')
    active = false
    pull.resolve({ done: false, value: Uint8Array.of(65) })
    await rejected
    expect(bytes.cancel).toHaveBeenCalledOnce()
    bytes.finished.reject(new FdWorkerFailure('FS_ABORTED'))
    await session.close()
  })

  it('propagates parent cancellation to actual I/O and seals every source reader', async () => {
    const parent = new AbortController()
    const bytes = byteStream([Uint8Array.of(65)], true)
    const { client, open } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, () => {}, parent.signal)
    const reader = session.readers[0]!
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
    await iterator.next()
    parent.abort()
    expect(open.mock.lastCall?.[4].aborted).toBe(true)
    await expect(session.readers[1]!.resolve('AGENTS.md')).rejects.toMatchObject({ code: 'FS_ABORTED' })
    const closing = session.close()
    bytes.finished.reject(new FdWorkerFailure('FS_ABORTED'))
    await closing
    await iterator.return?.()
  })

  it('keeps a caller abort local while the next source can use the same reserved session', async () => {
    const { client, stat } = clientWith()
    const held = Promise.withResolvers<FdMetadata | undefined>()
    stat.mockReturnValueOnce(held.promise)
    const caller = new AbortController()
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const waiting = session.readers[0]!.resolve('AGENTS.md', { signal: caller.signal })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'FS_ABORTED' })
    caller.abort()
    expect(stat.mock.lastCall?.[2].aborted).toBe(true)
    held.reject(new FdWorkerFailure('FS_ABORTED'))
    await rejected
    await expect(session.readers[1]!.resolve('AGENTS.md')).resolves.toMatchObject({ displayPath: 'AGENTS.md' })
    await session.close()
  })

  it('retains stream completion failure even if iteration has already returned', async () => {
    const bytes = byteStream([Uint8Array.of(65)], true)
    const { client } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const reader = session.readers[0]!
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    bytes.finished.reject(new FdWorkerFailure('FS_IO_ERROR'))
    await expect(session.close()).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('does not confirm cleanup when cancellation throws even after finished settles', async () => {
    const bytes = byteStream([Uint8Array.of(65)], true)
    bytes.cancel.mockImplementationOnce(() => { throw new Error('Cancellation failed') })
    const { client } = clientWith(bytes)
    const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
    const reader = session.readers[0]!
    const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
    await iterator.next()
    const closing = session.close()
    const rejected = expect(closing).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    bytes.finished.resolve(undefined)
    await rejected
    await iterator.return?.()
  })

  it('waits for the real worker cancellation reply before releasing the reserved client', async () => {
    const state = new Int32Array(new SharedArrayBuffer(12))
    const worker = new Worker(new URL('./fixtures/reader-worker.mjs', import.meta.url), {
      workerData: { mode: 'delayed-cancel', data: 'abcdef', chunkSize: limits.readChunkBytes, gate: state.buffer },
    })
    const client = new FdWorkerClient(worker)
    try {
      await client.ready
      const session = createReservedReadSession(client, sources, limits, () => {}, new AbortController().signal)
      const reader = session.readers[0]!
      const iterator = (await reader.streamText(await reader.resolve('AGENTS.md')))[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: 'abcd' })
      let closed = false
      const closing = session.close().then(() => { closed = true })
      await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
      expect(closed).toBe(false)
      await expect(reader.resolve('AGENTS.md')).rejects.toMatchObject({ code: 'FS_ABORTED' })
      Atomics.store(state, 1, 1)
      Atomics.notify(state, 1)
      await closing
      await iterator.return?.()
      // The original exclusive client becomes usable after the actual reply, without another pool/lane.
      await expect(client.stat(root, 'AGENTS.md', new AbortController().signal)).resolves.toMatchObject({ type: 'file' })
    } finally {
      Atomics.store(state, 1, 1)
      Atomics.notify(state, 1)
      await client.close()
    }
  })
})
