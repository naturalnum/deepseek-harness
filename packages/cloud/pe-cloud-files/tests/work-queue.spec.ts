import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesWorkQueue } from '../src/work-queue.ts'
import type { FilesLimits } from '../src/types.ts'

const limits: FilesLimits = {
  maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1,
  maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 30, maxResidentBytesPerLane: 20, waitTimeoutMs: 10_000,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => { vi.useRealTimers() })

describe('files actual-work ownership', () => {
  it('bounds each lane while another lane proceeds and retains completed results', async () => {
    const queue = new FilesWorkQueue(limits)
    const a = queue.openLane()
    const b = queue.openLane()
    const first = deferred<string>()
    const firstStarted = deferred<null>()
    const secondStarted = vi.fn(async () => 'a2')
    const firstWait = a.run(10, async () => { firstStarted.resolve(null); return first.promise })
    await firstStarted.promise
    const secondWait = a.run(5, secondStarted)
    const bResult = await b.run(5, async () => 'b')
    expect(bResult.value).toBe('b')
    expect(secondStarted).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ running: 1, queued: 1, residentBytes: 20, pending: 3 })
    bResult.release()
    first.resolve('a1')
    const [r1, r2] = await Promise.all([firstWait, secondWait])
    expect(r1.value).toBe('a1')
    expect(r2.value).toBe('a2')
    expect(queue.inspect()).toMatchObject({ running: 0, queued: 0, residentBytes: 15, pending: 2 })
    r1.release()
    r2.release()
    r2.release()
    queue.close()
    expect(queue.inspect()).toEqual({ running: 0, queued: 0, residentBytes: 0, pending: 0, lanes: 0 })
  })

  it('rejects queued overflow before invoking work', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<null>()
    const first = lane.run(1, () => actual.promise)
    const queued = lane.run(1, async () => {})
    const refused = vi.fn(async () => {})
    await expect(lane.run(1, refused)).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(refused).not.toHaveBeenCalled()
    actual.resolve(null)
    for (const result of await Promise.all([first, queued])) result.release()
    queue.close()
  })

  it('retains running records and bytes after caller cancellation', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<string>()
    const started = deferred<AbortSignal>()
    const cancel = new AbortController()
    const wait = lane.run(12, async (signal) => { started.resolve(signal); return actual.promise }, cancel.signal)
    const runningSignal = await started.promise
    const reason = new Error('caller stopped')
    const rejected = expect(wait).rejects.toBe(reason)
    cancel.abort(reason)
    await rejected
    expect(runningSignal.aborted).toBe(true)
    lane.close()
    expect(lane.pending()).toHaveLength(1)
    expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: 12, pending: 1, lanes: 1 })
    actual.resolve('late')
    // The explicit actual completion is the observation point, not the rejected caller wait.
    await actual.promise
    await vi.waitFor(() => {
      expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: 0, pending: 0, lanes: 0 })
    })
    queue.close()
  })

  it('removes a queued cancelled operation without invoking it', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<null>()
    const active = lane.run(8, () => actual.promise)
    const cancel = new AbortController()
    const neverStart = vi.fn(async () => {})
    const queued = lane.run(6, neverStart, cancel.signal)
    const reason = new Error('queued caller stopped')
    const rejected = expect(queued).rejects.toBe(reason)
    cancel.abort(reason)
    await rejected
    expect(neverStart).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ running: 1, queued: 0, residentBytes: 8, pending: 1 })
    actual.resolve(null)
    const result = await active
    result.release()
    queue.close()
  })

  it('holds byte capacity until a successful result is released', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const held = await lane.run(20, async () => new Uint8Array(20))
    const refused = vi.fn(async () => {})
    await expect(lane.run(1, refused)).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(refused).not.toHaveBeenCalled()
    lane.close()
    expect(lane.pending()).toHaveLength(1)
    held.release()
    expect(lane.pending()).toEqual([])
    expect(queue.inspect().lanes).toBe(0)
    queue.close()
  })

  it('keeps actual running work after the finite wait deadline', async () => {
    vi.useFakeTimers()
    const queue = new FilesWorkQueue({ ...limits, waitTimeoutMs: 25 })
    const lane = queue.openLane()
    const actual = deferred<null>()
    const started = deferred<null>()
    const wait = lane.run(10, async () => { started.resolve(null); return actual.promise })
    await started.promise
    const rejected = expect(wait).rejects.toMatchObject({ code: 'files/deadline' })
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: 10, pending: 1 })
    actual.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
    queue.close()
  })

  it('does not start queued work when the root closes', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<null>()
    const started = deferred<null>()
    const active = lane.run(10, async () => { started.resolve(null); return actual.promise })
    await started.promise
    const task = vi.fn(async () => {})
    const pending = lane.run(10, task)
    const activeRejected = expect(active).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    const pendingRejected = expect(pending).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    queue.close()
    await Promise.all([activeRejected, pendingRejected])
    expect(task).not.toHaveBeenCalled()
    expect(() => queue.openLane()).toThrow()
    await expect(lane.run(0, task)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    actual.resolve(null)
    await vi.waitFor(() => { expect(queue.inspect().pending).toBe(0) })
  })

  it('reclaims failed actual work and lets the queued operation proceed', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<null>()
    const failed = lane.run(10, () => actual.promise)
    const pending = lane.run(10, async () => 42)
    const reason = new Error('backend failed')
    const rejected = expect(failed).rejects.toBe(reason)
    actual.reject(reason)
    await rejected
    const result = await pending
    expect(result.value).toBe(42)
    result.release()
    expect(queue.inspect().residentBytes).toBe(0)
    queue.close()
  })

  it('treats a synchronous backend throw as settled failure', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const reason = new Error('synchronous backend failure')
    await expect(lane.run(10, () => { throw reason })).rejects.toBe(reason)
    expect(queue.inspect()).toMatchObject({ pending: 0, residentBytes: 0, running: 0 })
    queue.close()
  })

  it('limits account lanes and cannot reopen a closed capability', async () => {
    const queue = new FilesWorkQueue({ ...limits, maxLanes: 1 })
    const first = queue.openLane()
    expect(() => queue.openLane()).toThrow()
    first.close()
    const second = queue.openLane()
    await expect(first.run(0, async () => {})).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    const result = await second.run(0, async () => {})
    result.release()
    queue.close()
  })

  it('isolates a failed settlement observer and continues scheduling another lane', async () => {
    const report = vi.fn()
    const queue = new FilesWorkQueue({ ...limits, maxRunning: 1 }, report)
    const a = queue.openLane()
    const b = queue.openLane()
    const actual = deferred<null>()
    const started = deferred<null>()
    const active = a.run(10, async () => { started.resolve(null); return actual.promise })
    await started.promise
    const waiting = b.run(10, async () => 'B proceeds')
    const error = new Error('observer failed')
    const nextObserver = vi.fn()
    a.onSettled(() => { throw error })
    a.onSettled(nextObserver)
    const rejected = expect(active).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    a.close()
    await rejected
    actual.resolve(null)
    const result = await waiting
    expect(result.value).toBe('B proceeds')
    expect(report).toHaveBeenCalledWith(error)
    expect(nextObserver).toHaveBeenCalledOnce()
    expect(queue.inspect()).toMatchObject({ running: 0, queued: 0, residentBytes: 10, pending: 1 })
    result.release()
    queue.close()
  })

  it.each(['root-close', 'caller-abort'])('does not invoke a backend after immediate %s', async (stop) => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const caller = new AbortController()
    const backend = vi.fn(async () => 'must not run')
    const wait = lane.run(10, backend, caller.signal)
    const rejected = expect(wait).rejects.toBeInstanceOf(Error)
    if (stop === 'root-close') queue.close()
    else caller.abort(new Error('caller stopped before invocation'))
    await rejected
    await vi.waitFor(() => { expect(queue.inspect().pending).toBe(0) })
    expect(backend).not.toHaveBeenCalled()
    expect(queue.inspect().residentBytes).toBe(0)
    queue.close()
  })

  it('keeps notification failures visible even if their reporter fails', () => {
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const queue = new FilesWorkQueue(limits, () => { throw new Error('reporting failed') })
      const lane = queue.openLane()
      const nextObserver = vi.fn()
      lane.onSettled(() => { throw new Error('observer failed') })
      lane.onSettled(nextObserver)
      expect(() => { lane.close() }).not.toThrow()
      expect(nextObserver).toHaveBeenCalledOnce()
      expect(fallback).toHaveBeenCalledOnce()
      queue.close()
    } finally { fallback.mockRestore() }
  })

  it('enforces global resident bytes across account lanes', async () => {
    const queue = new FilesWorkQueue(limits)
    const a = queue.openLane()
    const b = queue.openLane()
    const first = await a.run(20, async () => 'A')
    const second = await b.run(10, async () => 'B')
    const refused = vi.fn(async () => {})
    await expect(b.run(1, refused)).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(refused).not.toHaveBeenCalled()
    first.release()
    second.release()
    queue.close()
  })

  it('rejects invalid limits and oversized reservations before work', async () => {
    expect(() => new FilesWorkQueue({ ...limits, maxRunning: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => new FilesWorkQueue({ ...limits, maxRunningPerLane: 3 })).toThrow()
    expect(() => new FilesWorkQueue({ ...limits, waitTimeoutMs: 2_147_483_648 })).toThrow()
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const task = vi.fn(async () => {})
    await expect(lane.run(21, task)).rejects.toMatchObject({ code: 'cloud/capacity' })
    await expect(lane.run(-1, task)).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(task).not.toHaveBeenCalled()
    queue.close()
  })
})
