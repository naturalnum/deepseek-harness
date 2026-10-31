/** Cloud-owned settlement for the original Office reader and its observer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficeWork } from '../src/office-work.ts'

const attempt = <T>(invoke: () => Promise<T>): Promise<T> => Promise.resolve().then(invoke)

describe('OfficeWork', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('returns an observer cancellation while retaining actual work and its capacity until settlement', async () => {
    const deferred = Promise.withResolvers<string>(), release = deferred.resolve
    const dispose = vi.fn(async () => {}), report = vi.fn(), invoke = vi.fn(() => deferred.promise)
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    const abort = new AbortController()
    const observed = work.run(invoke, abort.signal)
    const rejected = expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    try {
      abort.abort()
      await rejected
      expect(invoke).toHaveBeenCalledOnce()
      expect(invoke).toHaveBeenCalledWith()
      const excess = vi.fn(async () => 'must not start')
      await expect(attempt(() => work.run(excess))).rejects.toBeDefined()
      expect(excess).not.toHaveBeenCalled()
      let settled = false
      const stop = work.stop(Date.now() + 1_000).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(false)
      expect(dispose).not.toHaveBeenCalled()
      release('done')
      await stop
      expect(dispose).toHaveBeenCalledOnce()
      expect(report).not.toHaveBeenCalled()
    } finally { release('done') }
  })

  it('retains a cleanup failure that arrives after the observer cancelled', async () => {
    const deferred = Promise.withResolvers<string>(), dispose = vi.fn(async () => {}), report = vi.fn()
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    const abort = new AbortController(), failure = Object.assign(new Error('late cleanup failure'), { code: 'EACCES' })
    const observed = work.run(() => deferred.promise, abort.signal)
    const rejected = expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    try {
      abort.abort()
      await rejected
      deferred.reject(failure)
      await expect(work.stop(Date.now() + 1_000)).rejects.toBeDefined()
      expect(report).toHaveBeenCalled()
      const later = vi.fn(async () => 'must not start')
      await expect(attempt(() => work.run(later))).rejects.toBeDefined()
      expect(later).not.toHaveBeenCalled()
    } finally { deferred.resolve('done') }
  })

  it('does not make a confirmed clean cancellation permanently unknown', async () => {
    const deferred = Promise.withResolvers<number>(), dispose = vi.fn(async () => {}), report = vi.fn()
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    const abort = new AbortController()
    const observed = work.run(() => deferred.promise, abort.signal)
    const rejected = expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    try {
      abort.abort()
      await rejected
      deferred.resolve(7)
      await vi.advanceTimersByTimeAsync(0)
      await expect(work.run(async () => 8)).resolves.toBe(8)
      await expect(work.stop(Date.now() + 1_000)).resolves.toBeUndefined()
      expect(dispose).toHaveBeenCalledOnce()
      expect(report).not.toHaveBeenCalled()
    } finally { deferred.resolve(7) }
  })

  it('keeps an observation timeout unknown even if original work settles later', async () => {
    const deferred = Promise.withResolvers<string>(), dispose = vi.fn(async () => {}), report = vi.fn()
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    const observed = work.run(() => deferred.promise)
    try {
      const stop = work.stop(Date.now() + 25)
      const rejected = expect(stop).rejects.toBeDefined()
      await vi.advanceTimersByTimeAsync(25)
      await rejected
      expect(report).toHaveBeenCalled()
      expect(dispose).not.toHaveBeenCalled()
      deferred.resolve('late')
      await expect(observed).rejects.toBeDefined()
      await expect(work.stop(Date.now() + 1_000)).rejects.toBeDefined()
      const after = vi.fn(async () => 'must not start')
      await expect(attempt(() => work.run(after))).rejects.toBeDefined()
      expect(after).not.toHaveBeenCalled()
    } finally { deferred.resolve('late') }
  })

  it('does not confirm failed disposal or re-admit work', async () => {
    const failure = new Error('disposal failed'), report = vi.fn(), dispose = vi.fn(async () => { throw failure })
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    await expect(work.stop(Date.now() + 1_000)).rejects.toBeDefined()
    expect(report).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    const later = vi.fn(async () => 'must not start')
    await expect(attempt(() => work.run(later))).rejects.toBeDefined()
    expect(later).not.toHaveBeenCalled()
    await expect(work.stop(Date.now() + 1_000)).rejects.toBeDefined()
  })

  it('keeps a never-settling dispose unknown after the deadline and any late completion', async () => {
    const deferred = Promise.withResolvers<undefined>(), report = vi.fn(), dispose = vi.fn(() => deferred.promise)
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    try {
      const stop = work.stop(Date.now() + 25)
      const rejected = expect(stop).rejects.toBeDefined()
      await vi.advanceTimersByTimeAsync(25)
      await rejected
      expect(dispose).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalled()
      deferred.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      await expect(work.stop(Date.now() + 1_000)).rejects.toBeDefined()
    } finally { deferred.resolve(undefined) }
  })

  it('fails closed on unexpected owner withdrawal and explicit cleanup failure', async () => {
    const report = vi.fn(), dispose = vi.fn(async () => {})
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    work.ownerUnloaded()
    expect(report).toHaveBeenCalled()
    await expect(attempt(() => work.run(async () => 'must not start'))).rejects.toBeDefined()
    await expect(work.stop(Date.now() + 1_000)).rejects.toBeDefined()
    const report2 = vi.fn(), work2 = new OfficeWork(1, () => {}, dispose, () => false, report2)
    work2.cleanupFailed(new Error('effect cleanup failed'))
    expect(report2).toHaveBeenCalled()
    await expect(attempt(() => work2.run(async () => 'must not start'))).rejects.toBeDefined()
    await expect(work2.stop(Date.now() + 1_000)).rejects.toBeDefined()
  })

  it('allows another request after a failure the original owner explicitly proves known', async () => {
    const known = new Error('known refusal'), report = vi.fn(), dispose = vi.fn(async () => {})
    const work = new OfficeWork(1, () => {}, dispose, cause => cause === known, report)
    await expect(work.run(async () => { throw known })).rejects.toBe(known)
    await expect(work.run(async () => 'ok')).resolves.toBe('ok')
    await expect(work.stop(Date.now() + 1_000)).resolves.toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })

  it('uses the call-specific known-failure predicate without weakening the default', async () => {
    const known = new Error('proved pre-conversion refusal'), report = vi.fn(), dispose = vi.fn(async () => {})
    const work = new OfficeWork(1, () => {}, dispose, () => false, report)
    await expect(work.run(async () => { throw known }, undefined, cause => cause === known)).rejects.toBe(known)
    await expect(work.run(async () => 'ok')).resolves.toBe('ok')
    await expect(work.stop(Date.now() + 1_000)).resolves.toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })

  it('closes admission synchronously when stop starts', async () => {
    const deferred = Promise.withResolvers<undefined>(), dispose = vi.fn(() => deferred.promise)
    const work = new OfficeWork(1, () => {}, dispose, () => false, vi.fn())
    const stop = work.stop(Date.now() + 1_000)
    try {
      const invoke = vi.fn(async () => 'must not start')
      await expect(attempt(() => work.run(invoke))).rejects.toBeDefined()
      expect(invoke).not.toHaveBeenCalled()
      deferred.resolve(undefined)
      await expect(stop).resolves.toBeUndefined()
    } finally { deferred.resolve(undefined) }
  })
})
