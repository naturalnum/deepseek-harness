import { expect, it, vi } from 'vitest'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { CollectedOutputMirror } from '../src/collected-output.ts'
import { ManagedShellExecution, type PreparedShellProcess, type ShellInterruption } from '../src/shell-execution.ts'

function fixture(interruption?: ShellInterruption) {
  const native = Promise.withResolvers<SubprocessOutcome>(), empty = Promise.withResolvers<undefined>()
  const stdout = new CollectedOutputMirror({ maxBytes: 16 }, 128), stderr = new CollectedOutputMirror({ maxBytes: 16 }, 128)
  let current = true, cause = interruption, stopped = false
  const assertCurrent = () => { if (!current) throw new Error('original scope released') }
  const providerFailed = vi.fn<(cause: unknown) => void>()
  const stop = vi.fn(() => {
    if (stopped) return false
    stopped = true
    cause ??= 'killed'
    return true
  })
  const process: SubprocessHandle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    done: native.promise, collected: { stdout, stderr }, terminate: () => { stop() },
    waitForExit: () => empty.promise.then(() => true) }
  const input: PreparedShellProcess = { process, whenEmpty: empty.promise, assertCurrent, stop, providerFailed,
    interruption: () => cause }
  const spec: ShellExecSpec = { command: 'fixture only', workdir: '/project', timeoutMs: 1000,
    stdoutMaxBytes: 16, onExpiry: 'kill', sandboxPolicy: undefined }
  const handle = new ManagedShellExecution(spec, input)
  return { handle, input, spec, native, empty, stdout, stderr, stop, providerFailed,
    revoke: () => { current = false } }
}

it('waits for whole range after native direct/stdio completion and keeps output available through that boundary', async () => {
  const f = fixture()
  f.stdout.push(Buffer.from('direct child'))
  f.native.resolve({ exitCode: 23, signal: null })
  let shellDone = false
  const actual = f.handle.done.then(() => { shellDone = true })
  await f.native.promise
  await Promise.resolve()
  expect(shellDone).toBe(false)
  expect(f.handle.status).toBe('running')
  expect(f.handle.exitCode).toBe(23)
  expect(f.handle.kill()).toBe(true)
  expect(f.handle.kill()).toBe(false)
  f.empty.resolve(undefined)
  await actual
  expect(f.handle.status).toBe('killed')
  expect(f.handle.kill()).toBe(false)
  await expect(f.handle.result()).resolves.toMatchObject({ exitCode: 23, signal: null,
    timedOut: false, aborted: false, stdout: { text: 'direct child', truncated: false } })
})

it('keeps Shell done nonrejecting after provider failure but requires actual range completion before settling', async () => {
  const f = fixture(), failure = new Error('sanitized provider failure')
  const actual = f.handle.done
  let closed = false
  void actual.then(() => { closed = true })
  f.native.reject(failure)
  await Promise.resolve()
  expect(f.providerFailed).toHaveBeenCalledWith(failure)
  expect(closed).toBe(false)
  f.empty.resolve(undefined)
  await expect(actual).resolves.toBeUndefined()
  expect(f.handle.status).toBe('killed')
  await expect(f.handle.result()).rejects.toBe(failure)
})

it.each(['aborted', 'timed-out'] as const)('preserves the owning first %s cause after a range stop without a direct outcome', async (cause) => {
  const f = fixture(cause)
  f.stderr.push(Buffer.from('known tail'))
  f.native.reject(new Error('direct outcome unavailable after actual range kill'))
  f.empty.resolve(undefined)
  await f.handle.done
  await expect(f.handle.result()).resolves.toMatchObject({ exitCode: null, signal: null,
    timedOut: cause === 'timed-out', aborted: cause === 'aborted', timeoutMs: 1000,
    stderr: { text: 'known tail', truncated: false } })
})

it('separates the consuming display cursor, independent byte readers and memoized foreground result', async () => {
  const f = fixture()
  f.stdout.push(Buffer.from('abcdefghijklmnopqrst'))
  f.stderr.push(Buffer.from('err'))
  expect(f.handle.readOutput()).toMatchObject({ delta: 'efghijklmnopqrst\n[stderr]\nerr', lossy: true })
  expect(f.handle.readOutput()).toEqual({ delta: '', lossy: false })
  expect(f.handle.observed.stdout.readFrom(0)).toEqual({ text: 'efghijklmnopqrst', nextOffset: 20, lossy: true })
  f.native.resolve({ exitCode: 0, signal: null })
  f.empty.resolve(undefined)
  await f.handle.done
  const result = f.handle.result()
  expect(f.handle.result()).toBe(result)
  await expect(result).resolves.toMatchObject({ stdout: { text: 'efghijklmnopqrst', truncated: true } })
  await expect(result).resolves.not.toHaveProperty('sandbox')
})

it('refuses old handles and readers without preventing the retained private completion from settling', async () => {
  const f = fixture(), actual = f.handle.done
  f.revoke()
  expect(() => f.handle.readOutput()).toThrow('original scope released')
  expect(() => f.handle.observed.stdout.readFrom(0)).toThrow('original scope released')
  expect(() => f.handle.kill()).toThrow('original scope released')
  expect(() => f.handle.result()).toThrow('original scope released')
  expect(() => f.handle.status).toThrow('original scope released')
  expect(() => f.handle.done).toThrow('original scope released')
  f.native.resolve({ exitCode: 0, signal: null })
  f.empty.resolve(undefined)
  await expect(actual).resolves.toBeUndefined()
})

it('retains the original timeout echo and does not fabricate native sandbox policy facts', async () => {
  const f = fixture()
  f.spec.timeoutMs = 50
  f.native.resolve({ exitCode: 0, signal: null })
  f.empty.resolve(undefined)
  await expect(f.handle.result()).resolves.toMatchObject({ timeoutMs: 1000 })
  await expect(f.handle.result()).resolves.not.toHaveProperty('sandbox')
})

it.each([
  { stdout: '', stderr: 'error', expected: '[stderr]\nerror' },
  { stdout: 'line\n', stderr: 'error', expected: 'line\n[stderr]\nerror' },
  { stdout: 'line', stderr: 'error', expected: 'line\n[stderr]\nerror' },
  { stdout: 'line\n', stderr: '', expected: 'line\n' },
])('formats developer command output with a single separator: $stdout / $stderr', ({ stdout, stderr, expected }) => {
  const f = fixture()
  f.stdout.push(Buffer.from(stdout))
  f.stderr.push(Buffer.from(stderr))
  expect(f.handle.readOutput()).toEqual({ delta: expected, lossy: false })
  expect(f.handle.readOutput()).toEqual({ delta: '', lossy: false })
})


it.each([
  { first: 'line', expected: '\n[stderr]\nerror' },
  { first: 'line\n', expected: '[stderr]\nerror' },
])('separates stderr after a previous stdout read: $first', ({ first, expected }) => {
  const f = fixture()
  f.stdout.push(Buffer.from(first))
  expect(f.handle.readOutput()).toEqual({ delta: first, lossy: false })
  expect(f.handle.readOutput()).toEqual({ delta: '', lossy: false })
  f.stderr.push(Buffer.from('error'))
  expect(f.handle.readOutput()).toEqual({ delta: expected, lossy: false })
})
