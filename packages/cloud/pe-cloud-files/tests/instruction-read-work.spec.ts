import { describe, expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { runInstructionReadWork } from '../src/instruction-read-work.ts'
import type { InstructionReadExecute, InstructionReadWorkInput } from '../src/instruction-read-work.ts'
import type { FixedRootReader } from '../src/read-only.ts'
import { FdWorkerFailure } from '../src/worker-client.ts'
import type { FdByteStream, FdWorkerClient } from '../src/worker-client.ts'
import type { ResidentResult } from '../src/work-queue.ts'
import { FilesFailure } from '../src/error.ts'

const projectRoot = { rootPath: '/project', rootDevice: '1', rootInode: '2', rootMountId: '3' }
const privateParent = { rootPath: '/private', rootDevice: '4', rootInode: '5', rootMountId: '6' }
const config = { maxPathBytes: 1024, maxReadBytes: 128, readChunkBytes: 8,
  replyOverheadBytes: 256, maxReservationBytes: 65536 }
const file = { identity: '1:2', version: '1:2:3:4:5', type: 'file' as const, size: 4 }
const directory = { identity: '7:8', version: '7:8:0:4:5', type: 'directory' as const }
type Client = Pick<FdWorkerClient, 'stat' | 'directory' | 'stream'>

function fixture(accountSource = true) {
  const stat = vi.fn<FdWorkerClient['stat']>(async (_root, path) => path === 'instructions' ? directory : file)
  const inspect = vi.fn<FdWorkerClient['directory']>(async () => ({
    anchorPath: '/private', canonicalPath: '/private/instructions', directory: true,
  }))
  const stream = vi.fn<FdWorkerClient['stream']>(() => { throw new Error('No stream expected') })
  const client: Client = { stat, directory: inspect, stream }
  const release = vi.fn()
  const calls: { bytes: number; signal: AbortSignal }[] = []
  let held: ResidentResult<unknown> | undefined
  const execute: InstructionReadExecute = async <T>(
    bytes: number, work: (value: Client, control: AbortSignal) => Promise<T>, signal: AbortSignal,
  ): Promise<ResidentResult<T>> => {
    calls.push({ bytes, signal })
    const result = { value: await work(client, signal), release }
    held = result
    return result
  }
  const input = <T>(build: InstructionReadWorkInput<T>['build'], overrides: Partial<InstructionReadWorkInput<T>> = {}): InstructionReadWorkInput<T> => ({
    projectRoot, ...accountSource ? { privateParent } : {}, requestedResidentBytes: 1024, config, assertCurrent: () => {},
    signal: new AbortController().signal, execute, build, ...overrides,
  })
  return { stat, inspect, stream, release, calls, input, held: () => held }
}

function heldStream() {
  const finished = Promise.withResolvers<undefined>()
  const cancel = vi.fn()
  const stream: FdByteStream = { finished: finished.promise, cancel,
    next: async () => ({ done: false, value: Uint8Array.of(65) }) }
  return { stream, finished, cancel }
}

describe('one instruction snapshot reservation', () => {
  it('derives an independent account anchor from actual metadata and returns the original resident result', async () => {
    const f = fixture()
    let escaped: FixedRootReader | undefined
    const input = f.input(async (readers) => {
      expect(Object.keys(readers).sort()).toEqual(['account', 'project'])
      escaped = readers.account
      const account = await readers.account!.resolve('AGENTS.md')
      expect(readers.account!.processPath(account)).toBe('/private/instructions/AGENTS.md')
      await expect(readers.account!.resolve('/private/credentials')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      const project = await readers.project.resolve('AGENTS.md')
      return { account: readers.account!.processPath(account), project: readers.project.processPath(project) }
    })
    const result = await runInstructionReadWork(input)
    expect(result).toBe(f.held())
    expect(result.value).toEqual({ account: '/private/instructions/AGENTS.md', project: '/project/AGENTS.md' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.signal).toBe(input.signal)
    expect(f.calls[0]!.bytes).toBeGreaterThan(input.requestedResidentBytes)
    expect(f.calls[0]!.bytes).toBeLessThanOrEqual(config.maxReservationBytes)
    expect(f.inspect).toHaveBeenCalledWith(privateParent, 'instructions', 1024, input.signal)
    expect(f.stat.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [privateParent, 'instructions'],
      [{ rootPath: '/private/instructions', rootDevice: '7', rootInode: '8', rootMountId: '6' }, 'AGENTS.md'],
      [projectRoot, 'AGENTS.md'],
    ])
    await expect(escaped!.resolve('AGENTS.md')).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(f.release).not.toHaveBeenCalled()
    result.release()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('omits account preferences only after a confirmed missing stat', async () => {
    const f = fixture()
    f.stat.mockResolvedValueOnce(undefined)
    const result = await runInstructionReadWork(f.input(async (readers) => {
      expect(readers.account).toBeUndefined()
      return readers.project.processPath(await readers.project.resolve('AGENTS.md'))
    }))
    expect(result.value).toBe('/project/AGENTS.md')
    expect(f.inspect).not.toHaveBeenCalled()
    result.release()
  })

  it('does not inspect a private parent when the owner declares no account source', async () => {
    const f = fixture(false)
    const result = await runInstructionReadWork(f.input(async (readers) => {
      expect(readers.account).toBeUndefined()
      return 'project only'
    }))
    expect(f.stat).not.toHaveBeenCalled()
    expect(f.inspect).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(1)
    result.release()
  })

  it.each(['FS_IO_ERROR', 'FS_PERMISSION_DENIED', 'FS_NOT_REGULAR_FILE'] as const)('does not turn %s metadata failure into optional absence', async (code) => {
    const f = fixture()
    const build = vi.fn(async () => 'must not build')
    f.stat.mockRejectedValueOnce(new FdWorkerFailure(code))
    await expect(runInstructionReadWork(f.input(build))).rejects.toMatchObject({ code })
    expect(build).not.toHaveBeenCalled()
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('rejects a nondirectory before issuing account readers', async () => {
    const f = fixture()
    f.stat.mockResolvedValueOnce(file)
    const build = vi.fn(async () => 'must not build')
    await expect(runInstructionReadWork(f.input(build))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    expect(f.inspect).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
  })

  it.each([
    { anchorPath: '/private', canonicalPath: '/private/credentials', directory: true },
    { anchorPath: '/other', canonicalPath: '/private/instructions', directory: true },
    { anchorPath: '/private', canonicalPath: '/private/instructions', directory: false },
  ])('refuses symlink/canonical or directory mismatch without signing a parent reader: %j', async (observation) => {
    const f = fixture()
    f.inspect.mockResolvedValueOnce(observation)
    const build = vi.fn(async () => 'must not build')
    await expect(runInstructionReadWork(f.input(build))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(build).not.toHaveBeenCalled()
    expect(f.stat).toHaveBeenCalledOnce()
  })

  it('preserves an unavailable directory observation after stat rather than skipping the source', async () => {
    const f = fixture()
    const unavailable = new FilesFailure('files/deadline', 'Actual directory work is unavailable')
    f.inspect.mockRejectedValueOnce(unavailable)
    const build = vi.fn(async () => 'must not build')
    await expect(runInstructionReadWork(f.input(build))).rejects.toBe(unavailable)
    expect(build).not.toHaveBeenCalled()
  })

  it('checks current generation again after actual metadata settles', async () => {
    const f = fixture()
    let active = true
    const retired = new FilesFailure('cloud/stale-generation', 'Original owner retired')
    f.stat.mockImplementationOnce(async () => { active = false; return directory })
    const build = vi.fn(async () => 'must not build')
    await expect(runInstructionReadWork(f.input(build, {
      assertCurrent: () => { if (!active) throw retired },
    }))).rejects.toBe(retired)
    expect(f.inspect).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER])('refuses an invalid or overflowing result reservation %s before queue admission', async (requestedResidentBytes) => {
    const f = fixture()
    await expect(runInstructionReadWork(f.input(async () => 'unused', { requestedResidentBytes })))
      .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(f.calls).toEqual([])
    expect(f.stat).not.toHaveBeenCalled()
  })

  it('enforces the supplied complete reservation ceiling before execute', async () => {
    const f = fixture()
    await expect(runInstructionReadWork(f.input(async () => 'unused', {
      config: { ...config, maxReservationBytes: 1024 },
    }))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(f.calls).toEqual([])
  })

  it('does not admit an already cancelled work item', async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(runInstructionReadWork(f.input(async () => 'unused', { signal: abort.signal })))
      .rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(f.calls).toEqual([])
  })

  it('waits for a cancelled metadata reply and does not reinterpret its late absence as success', async () => {
    const f = fixture()
    const observation = Promise.withResolvers<Awaited<ReturnType<FdWorkerClient['stat']>>>()
    f.stat.mockReturnValueOnce(observation.promise)
    const abort = new AbortController()
    const build = vi.fn(async () => 'must not build')
    const result = runInstructionReadWork(f.input(build, { signal: abort.signal }))
    const rejected = expect(result).rejects.toMatchObject({ code: 'FS_ABORTED' })
    abort.abort()
    expect(f.stat.mock.lastCall?.[2].aborted).toBe(true)
    expect(build).not.toHaveBeenCalled()
    expect(f.held()).toBeUndefined()
    observation.resolve(undefined)
    await rejected
    expect(f.inspect).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
  })

  it('preserves the exact build failure when actual cleanup succeeds', async () => {
    const f = fixture(false)
    const primary = new FsError('Snapshot is too large.', 'FS_TOO_LARGE')
    await expect(runInstructionReadWork(f.input(async () => { throw primary })))
      .rejects.toBe(primary)
    expect(f.release).not.toHaveBeenCalled()
  })

  it('retains the original result reservation until actual stream close and consumer release', async () => {
    const f = fixture(false)
    const bytes = heldStream()
    f.stream.mockReturnValueOnce(bytes.stream)
    const built = Promise.withResolvers<undefined>()
    let delivered = false
    const result = runInstructionReadWork(f.input(async (readers) => {
      const iterator = (await readers.project.streamText(await readers.project.resolve('AGENTS.md')))[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: 'A' })
      built.resolve(undefined)
      return 'complete snapshot'
    })).then((value) => { delivered = true; return value })
    await built.promise
    await vi.waitFor(() => { expect(bytes.cancel).toHaveBeenCalledOnce() })
    expect(delivered).toBe(false)
    expect(f.release).not.toHaveBeenCalled()
    bytes.finished.reject(new FdWorkerFailure('FS_ABORTED'))
    const held = await result
    expect(held.value).toBe('complete snapshot')
    expect(f.calls).toHaveLength(1)
    expect(f.release).not.toHaveBeenCalled()
    held.release()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it.each(['FS_TOO_LARGE', 'FS_PERMISSION_DENIED'] as const)('keeps the original %s when build and actual cleanup both fail', async (code) => {
    const f = fixture(false)
    const bytes = heldStream()
    f.stream.mockReturnValueOnce(bytes.stream)
    const primary = new FsError('Original snapshot refusal', code)
    const result = runInstructionReadWork(f.input(async (readers) => {
      const iterator = (await readers.project.streamText(await readers.project.resolve('AGENTS.md')))[Symbol.asyncIterator]()
      await iterator.next()
      throw primary
    }))
    const rejected = result.then(() => { throw new Error('The failed snapshot must not be delivered') }, (error: unknown) => {
      expect(error).toMatchObject({ code, message: primary.message })
      expect(error).toBeInstanceOf(FsError)
      if (!(error instanceof FsError) || !(error.cause instanceof AggregateError)) throw error
      expect(error.cause.errors[0]).toBe(primary)
      expect(error.cause.errors[1]).toMatchObject({ code: 'FS_IO_ERROR' })
    })
    await vi.waitFor(() => { expect(bytes.cancel).toHaveBeenCalledOnce() })
    bytes.finished.reject(new FdWorkerFailure('FS_IO_ERROR'))
    await rejected
    expect(f.release).not.toHaveBeenCalled()
  })
})
