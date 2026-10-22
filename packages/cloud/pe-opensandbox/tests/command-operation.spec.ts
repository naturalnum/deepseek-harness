/** Component lifecycle tests; these synthetic snapshots do not qualify a deployed execution channel. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ManagedCommandOperation, type CommandChannel, type CommandSnapshot } from '../src/command-operation.ts'

const initial = (): CommandSnapshot => ({ prepared: true, submitted: false, commitClosed: false,
  rangeEmpty: false, ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined,
  stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false },
  stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } })
const complete = (empty = true): CommandSnapshot => ({ ...initial(), submitted: true, rangeEmpty: empty, ioClosed: empty,
  direct: { exitCode: 23, signal: null }, stdout: { bytes: Buffer.from('raw\0尾'), observedBytes: 7, eof: true },
  stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(change: Partial<SubprocessSpawnSpec> = {}) {
  const lifetime = new AbortController(), caller = new AbortController()
  const poll = Promise.withResolvers<CommandSnapshot>(), acquire = Promise.withResolvers<CommandChannel>()
  let heldAcquisition = false
  const channel = { prepare: vi.fn(async () => initial()), commit: vi.fn(async () => complete(false)),
    poll: vi.fn(() => poll.promise), stop: vi.fn(async () => complete()) } satisfies CommandChannel
  const authority = { lifetime: lifetime.signal, assertCurrent() { lifetime.signal.throwIfAborted() },
    acquire: vi.fn((signal: AbortSignal) => {
      if (!heldAcquisition) return Promise.resolve(channel)
      return new Promise<CommandChannel>((resolve, reject) => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Simulate the original native cancellation value.
        const abort = (): void => { reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        void acquire.promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) })
      })
    }), unknown: vi.fn<(cause: unknown) => void>(), retired: vi.fn<() => void>() }
  const spec: SubprocessSpawnSpec = { argv: ['/usr/local/bin/python3', '-c', 'print(23)'], cwd: '/project',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } }, graceMs: 100,
    signal: caller.signal, ...change }
  const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 32,
    maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 }
  const op = new ManagedCommandOperation(spec, limits, authority)
  cleanups.push(async () => {
    acquire.resolve(channel); poll.resolve(complete()); op.release(); op.acknowledgePhysicalStop(); await op.whenEmpty
  })
  return { op, channel, authority, caller, lifetime, poll, acquire, spec, limits,
    holdAcquisition: () => { heldAcquisition = true } }
}

it('returns a preparing native handle, then separates direct/stdio completion from whole-range exit', async () => {
  const f = fixture(), done = f.op.handle.done
  expect(f.authority.acquire).not.toHaveBeenCalled()
  f.op.publish(); f.op.begin(); await f.op.prepared
  await expect(done).resolves.toEqual({ exitCode: 23, signal: null })
  const wait = f.op.handle.waitForExit(), aborted = new AbortController()
  aborted.abort()
  await expect(f.op.handle.waitForExit(aborted.signal)).resolves.toBe(false)
  expect(f.op.handle.collected.stdout!.readFrom(0)).toEqual({ text: 'raw\0尾', nextOffset: 7, lossy: false })
  let empty = false
  void f.op.whenEmpty.then(() => { empty = true })
  expect(empty).toBe(false)
  f.poll.resolve(complete()); await expect(wait).resolves.toBe(true)
  expect(f.authority.retired).not.toHaveBeenCalled()
  f.op.release(); expect(f.authority.retired).toHaveBeenCalledTimes(1)
})

it('preserves NUL and UTF-8 batch stdin bytes independently of executable argument restrictions', async () => {
  const f = fixture({ stdio: { stdin: { data: 'a\0尾' }, stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } })
  f.op.publish(); f.op.begin(); await f.op.prepared
  expect(f.channel.prepare).toHaveBeenCalledWith(expect.objectContaining({ stdin: { mode: 'batch', base64: 'YQDlsL4=' } }))
  f.poll.resolve(complete()); await f.op.whenEmpty
})

it('cancels only the allocation observer and submits no remote prepare or commit after cancellation', async () => {
  const f = fixture(), reason = new Error('original native cancellation'), done = f.op.handle.done
  f.holdAcquisition(); f.op.publish(); f.op.begin(); f.caller.abort(reason)
  await expect(f.op.prepared).rejects.toBe(reason)
  await expect(done).rejects.toBe(reason)
  await f.op.whenEmpty
  expect(f.channel.prepare).not.toHaveBeenCalled(); expect(f.channel.commit).not.toHaveBeenCalled()
  expect(f.authority.unknown).not.toHaveBeenCalled()
  f.acquire.resolve(f.channel)
})

it('keeps a prepared Shell command behind its explicit publication gate', async () => {
  const f = fixture()
  f.op.begin(); await f.op.prepared
  expect(f.channel.commit).not.toHaveBeenCalled()
  const reason = new Error('cancel before Shell publication'), done = f.op.handle.done
  f.caller.abort(reason)
  expect(() => { f.op.publish() }).toThrow(reason)
  f.channel.stop.mockResolvedValue({ ...initial(), rangeEmpty: true, ioClosed: true, commitClosed: true,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
  f.poll.resolve(initial()); await f.op.whenEmpty
  await expect(done).rejects.toBe(reason)
  expect(f.channel.commit).not.toHaveBeenCalled()
  expect(f.channel.stop).toHaveBeenCalledTimes(1)
})

it('commits after prepared Shell publication without waiting for an unrelated pending poll', async () => {
  const f = fixture(), done = f.op.handle.done
  f.op.begin(); await f.op.prepared
  expect(f.channel.commit).not.toHaveBeenCalled()
  f.op.publish()
  await expect(done).resolves.toEqual({ exitCode: 23, signal: null })
  expect(f.channel.commit).toHaveBeenCalledTimes(1)
  f.poll.resolve(complete()); await f.op.whenEmpty
})

it('keeps a smaller native tail through repeated remote EOF snapshots while descendants exit', async () => {
  const f = fixture({ stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } } })
  f.op.publish(); f.op.begin(); await f.op.handle.done
  expect(f.op.handle.collected.stdout!.readFrom(0)).toEqual({ text: '\0尾', nextOffset: 7, lossy: true })
  f.poll.resolve(complete()); await f.op.whenEmpty
  expect(f.authority.unknown).not.toHaveBeenCalled()
})

it('keeps final output-owner revocation attached after normal range completion', async () => {
  const f = fixture()
  f.op.publish(); f.op.begin(); f.poll.resolve(complete()); await f.op.whenEmpty
  expect(f.authority.retired).not.toHaveBeenCalled()
  f.lifetime.abort(new Error('native final result projected'))
  expect(f.authority.retired).toHaveBeenCalledTimes(1)
  expect(() => f.op.handle.collected.stdout!.readFrom(0)).toThrow('owner was released')
  f.op.release(); expect(f.authority.retired).toHaveBeenCalledTimes(1)
})

it('keeps the first native cancellation reason when an attempted prepare later rejects', async () => {
  const f = fixture(), prepared = Promise.withResolvers<CommandSnapshot>(), reason = new Error('first native abort')
  const transport = new Error('later prepare failure'), done = f.op.handle.done
  f.channel.prepare.mockImplementation(() => prepared.promise)
  f.op.publish(); f.op.begin(); await vi.waitFor(() => { expect(f.channel.prepare).toHaveBeenCalledTimes(1) })
  f.caller.abort(reason); prepared.reject(transport)
  await expect(done).rejects.toBe(reason)
  await expect(f.op.prepared).rejects.toBe(reason)
  expect(f.authority.unknown).toHaveBeenCalledWith(transport)
  expect(f.authority.retired).not.toHaveBeenCalled()
  f.op.acknowledgePhysicalStop(); await f.op.whenEmpty
})

it('joins preparation before its single stop and never commits a cancelled prepared command', async () => {
  const f = fixture(), prepared = Promise.withResolvers<CommandSnapshot>(), reason = new Error('leave during prepare')
  f.channel.prepare.mockImplementation(() => prepared.promise)
  f.channel.stop.mockResolvedValue({ ...initial(), rangeEmpty: true, ioClosed: true, commitClosed: true,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
  const done = f.op.handle.done
  f.op.publish(); f.op.begin(); await vi.waitFor(() => { expect(f.channel.prepare).toHaveBeenCalledTimes(1) })
  f.caller.abort(reason)
  expect(f.channel.stop).not.toHaveBeenCalled()
  prepared.resolve(initial()); await f.op.whenEmpty
  await expect(f.op.prepared).rejects.toBe(reason)
  expect(f.channel.commit).not.toHaveBeenCalled(); expect(f.channel.stop).toHaveBeenCalledTimes(1)
  await expect(done).rejects.toBe(reason)
})

it('retains unknown remote preparation until qualified physical stop and never replays the mutation', async () => {
  const f = fixture(), failure = new Error('lost prepare response'), done = f.op.handle.done
  f.channel.prepare.mockRejectedValue(failure)
  f.op.publish(); f.op.begin(); await expect(done).rejects.toBe(failure)
  await expect(f.op.prepared).rejects.toBe(failure)
  expect(f.authority.unknown).toHaveBeenCalledWith(failure)
  await expect(f.op.handle.waitForExit()).rejects.toBe(failure)
  let empty = false
  void f.op.whenEmpty.then(() => { empty = true })
  f.op.release(); expect(empty).toBe(false); expect(f.authority.retired).not.toHaveBeenCalled()
  f.op.acknowledgePhysicalStop(); await f.op.whenEmpty
  expect(f.channel.prepare).toHaveBeenCalledTimes(1)
  expect(f.channel.commit).not.toHaveBeenCalled()
  expect(f.authority.retired).toHaveBeenCalledTimes(1)
})

it('revokes public output immediately but keeps the private stop and actual settlement alive', async () => {
  const f = fixture(), done = f.op.handle.done
  f.op.publish(); f.op.begin(); await f.op.prepared; await done
  await vi.waitFor(() => { expect(f.channel.poll).toHaveBeenCalledTimes(1) })
  f.lifetime.abort(new Error('account epoch revoked'))
  expect(() => f.op.handle.collected.stdout!.readFrom(0)).toThrow('owner was released')
  expect(f.authority.retired).not.toHaveBeenCalled()
  f.poll.resolve(complete(false)); await f.op.whenEmpty
  expect(f.channel.stop).toHaveBeenCalledTimes(1)
  expect(f.authority.retired).toHaveBeenCalledTimes(1)
})

it('bounds observers and removes cancelled observers without cancelling the managed process', async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController()
  f.op.publish(); f.op.begin(); await f.op.prepared
  const one = f.op.handle.waitForExit(first.signal), two = f.op.handle.waitForExit(second.signal)
  await expect(f.op.handle.waitForExit()).rejects.toThrow('observer capacity')
  first.abort(); await expect(one).resolves.toBe(false)
  const replacement = f.op.handle.waitForExit()
  f.poll.resolve(complete()); await expect(two).resolves.toBe(true); await expect(replacement).resolves.toBe(true)
  expect(f.channel.stop).not.toHaveBeenCalled()
})

it('rejects unsupported modes and input before allocation or synchronous handle publication', () => {
  const f = fixture()
  for (const spec of [{ ...f.spec, env: { TOKEN: 'fixture-only' } },
    { ...f.spec, cwd: '/project/../other' }, { ...f.spec, argv: ['/bin/bash', '\ud800'] },
    { ...f.spec, stdio: { ...f.spec.stdio, stdout: 'pipe' as const } },
    { ...f.spec, stdio: { ...f.spec.stdio, stdout: { maxBytes: 32, spill: { maxBytes: 64 } } } }]) {
    expect(() => new ManagedCommandOperation(spec, f.limits, f.authority)).toThrow()
  }
  expect(f.authority.acquire).not.toHaveBeenCalled()
  f.op.publish(); f.op.begin()
})

it('keeps the original controller deadline while delayed acquisition consumes its remaining budget', async () => {
  let now = 100
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const f = fixture()
  try {
    expect(f.op.remainingExecutionMs(10000)).toBe(0)
    f.holdAcquisition(); f.op.publish(); f.op.begin()
    now = 900; f.acquire.resolve(f.channel)
    await f.op.handle.done
    expect(f.op.remainingExecutionMs(10000)).toBe(200)
    now = 1099.5
    expect(f.op.remainingExecutionMs(10000)).toBe(0)
    expect(f.op.stopReason()).toBeUndefined()
    now = 1200
    expect(f.op.remainingExecutionMs(10000)).toBe(0)
  } finally { clock.mockRestore() }
})

it('anchors a role observer before the sole commit call and never restarts it on delayed submitted observation', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const f = fixture(), commit = Promise.withResolvers<CommandSnapshot>()
  f.channel.commit.mockImplementation(() => commit.promise)
  try {
    f.op.publish(); f.op.begin()
    await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledTimes(1) })
    now = 85
    expect(f.op.remainingExecutionMs(100)).toBe(15)
    commit.resolve(complete(false)); await f.op.handle.done
    expect(f.op.remainingExecutionMs(100)).toBe(15)
    now = 101
    expect(f.op.remainingExecutionMs(100)).toBe(0)
    expect(f.channel.commit).toHaveBeenCalledTimes(1)
  } finally { commit.resolve(complete(false)); clock.mockRestore() }
})


it('identifies only the original never-attempted channel wait and closes that fact on cancellation or acquisition', async () => {
  const f = fixture()
  expect(f.op.isAwaitingChannel()).toBe(false)
  f.holdAcquisition(); f.op.publish(); f.op.begin()
  expect(f.op.isAwaitingChannel()).toBe(true)
  f.acquire.resolve(f.channel); await f.op.prepared
  expect(f.op.isAwaitingChannel()).toBe(false)
  f.poll.resolve(complete()); await f.op.whenEmpty
  const cancelled = fixture(); cancelled.holdAcquisition(); cancelled.op.publish(); cancelled.op.begin()
  expect(cancelled.op.isAwaitingChannel()).toBe(true)
  cancelled.caller.abort(new Error('cancelled original'))
  expect(cancelled.op.isAwaitingChannel()).toBe(false)
  await cancelled.op.whenEmpty
})
