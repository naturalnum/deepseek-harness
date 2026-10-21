/** Private service projection over synthetic channels; not Loader, account authorization or remote/Web acceptance. */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedCommandOperation, type CommandChannel, type CommandSnapshot } from '../src/command-operation.ts'
import { CloudShellExecutor, CloudSubprocessRuntime, type NativeExecutionProviderPort } from '../src/native-providers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(holdAllocation = false) {
  const ctx = new Context(), lifetime = new AbortController(), operations = new Set<ManagedCommandOperation>()
  const snapshot: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false },
    stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } }
  const final: CommandSnapshot = { ...snapshot, submitted: true, rangeEmpty: true, ioClosed: true,
    direct: { exitCode: 0, signal: null }, stdout: { bytes: Buffer.from('原生'), observedBytes: 6, eof: true },
    stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }
  const channel = { prepare: vi.fn(async () => snapshot), commit: vi.fn(async () => final),
    poll: vi.fn(async () => snapshot), stop: vi.fn(async () => final) } satisfies CommandChannel
  const allocations = vi.fn((signal: AbortSignal): Promise<CommandChannel> => {
    if (!holdAllocation) return Promise.resolve(channel)
    return new Promise((_resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The native cancellation reason must remain unchanged.
      const cancelled = (): void => { reject(signal.reason) }
      if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true })
    })
  })
  const port: NativeExecutionProviderPort = { assertCurrent() { lifetime.signal.throwIfAborted() },
    projectRoot: () => '/project',
    create: vi.fn<NativeExecutionProviderPort['create']>((_caller, spec) => {
      const operation = new ManagedCommandOperation(spec, { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512,
        maxStdinBytes: 4096, maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2,
        maxLifetimeMs: 1000, stopWaitMs: 100 }, { lifetime: lifetime.signal, acquire: allocations,
        assertCurrent() { lifetime.signal.throwIfAborted() }, unknown() { /* Actual remote cleanup belongs to Root in production. */ },
        retired() { operations.delete(operation) } })
      operations.add(operation)
      return operation
    }),
    assertOperationCurrent(_caller, operation) {
      lifetime.signal.throwIfAborted()
      if (!operations.has(operation)) throw new Error('foreign operation')
    },
    providerFailed: vi.fn(),
    async closeProvider() {
      const owned = [...operations]
      for (const operation of owned) operation.release()
      await Promise.all(owned.map(op => op.whenEmpty))
    },
  }
  const shell = new CloudShellExecutor(ctx, port, { bashPath: '/bin/bash', timeoutMs: 20, maxTimeoutMs: 100,
    maxOutputBytes: 32, graceMs: 10 })
  cleanups.push(async () => {
    const owned = [...operations]
    lifetime.abort(new Error('fixture output owner released'))
    for (const operation of owned) operation.acknowledgePhysicalStop()
    await Promise.all(owned.map(operation => operation.whenEmpty)); await ctx.fiber.dispose()
  })
  return { ctx, port, shell, lifetime, operations, allocations, channel }
}

it('runs native foreground Shell through the original prepared command controller and fixed literal Bash argv', async () => {
  const f = fixture(), spec = f.shell.resolve({ command: 'printf 原生' }), handle = await f.shell.execute(spec)
  await expect(handle.result()).resolves.toMatchObject({ exitCode: 0, timedOut: false, aborted: false,
    stdout: { text: '原生', truncated: false } })
  expect(f.channel.prepare).toHaveBeenCalledWith({ argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'printf 原生'],
    cwd: '/project', stdin: { mode: 'ignore' } })
  expect(f.channel.commit).toHaveBeenCalledTimes(1)
  expect(f.shell.sandboxMode).toBeUndefined()
})

it('returns the specified empty settled Shell timeout while late allocation remains with its original owner', async () => {
  const f = fixture(true), spec = f.shell.resolve({ command: 'never submitted' }), handle = await f.shell.execute(spec)
  await expect(handle.done).resolves.toBeUndefined()
  await expect(handle.result()).resolves.toMatchObject({ exitCode: null, signal: null, timedOut: true, aborted: false,
    timeoutMs: 20, stdout: { text: '', truncated: false } })
  expect(f.channel.prepare).not.toHaveBeenCalled(); expect(f.channel.commit).not.toHaveBeenCalled()
  expect(f.operations.size).toBe(1)
})

it('keeps completed Shell facts when the caller cancels before its first result read', async () => {
  const f = fixture(), caller = new AbortController()
  const handle = await f.shell.execute(f.shell.resolve({ command: 'already finished', signal: caller.signal, onExpiry: 'none' }))
  await handle.done
  caller.abort(new Error('caller left after completion'))
  await expect(handle.result()).resolves.toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
})

it('preserves pre-publication native cancellation and rejects unsupported environment before reservation', async () => {
  const f = fixture(true), caller = new AbortController(), reason = new Error('original caller left')
  const pending = f.shell.execute(f.shell.resolve({ command: 'not committed', signal: caller.signal, onExpiry: 'none' }))
  caller.abort(reason); await expect(pending).rejects.toBe(reason)
  expect(f.channel.prepare).not.toHaveBeenCalled()
  const count = f.operations.size
  expect(() => f.shell.resolve({ command: 'refused', env: { EXAMPLE: 'explicit unsupported override' } })).toThrow('fixed environment')
  expect(f.operations.size).toBe(count)
})

it('returns a synchronous native subprocess handle and refuses unsupported lookups without allocating another process', async () => {
  const f = fixture(), provider = new CloudSubprocessRuntime(f.ctx, f.port)
  const spec: SubprocessSpawnSpec = { argv: ['/bin/bash', '-c', 'literal'], cwd: '/project', graceMs: 10,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } }
  const handle = provider.spawn(spec)
  expect(handle).not.toBeInstanceOf(Promise)
  await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  await expect(handle.waitForExit()).resolves.toBe(true)
  await expect(provider.resolveExecutable('python')).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(f.allocations).toHaveBeenCalledTimes(1)
})
