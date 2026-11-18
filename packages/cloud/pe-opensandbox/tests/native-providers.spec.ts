/** Private service projection over synthetic channels; not Loader, account authorization or remote/Web acceptance. */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedCommandOperation, type CommandChannel, type CommandSnapshot } from '../src/command-operation.ts'
import { CloudShellExecutor, CloudSubprocessRuntime, type NativeExecutionProviderPort } from '../src/native-providers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(holdAllocation = false) {
  const ctx = new Context(), lifetime = new AbortController(), scopeLifetime = new AbortController()
  const invocation = new AbortController()
  const operations = new Set<ManagedCommandOperation>()
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
      const input = { ...spec, signal: AbortSignal.any([invocation.signal, ...(spec.signal === undefined ? [] : [spec.signal])]) }
      const operation = new ManagedCommandOperation(input, { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512,
        maxStdinBytes: 4096, maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2,
        maxLifetimeMs: 1000, stopWaitMs: 100 }, { lifetime: scopeLifetime.signal, acquire: allocations,
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
  return { ctx, port, shell, lifetime, scopeLifetime, invocation, operations, allocations, channel }
}

it('resolves a native skill directory suffix before preparing the original Cloud command', async () => {
  const f = fixture(), spec = f.shell.resolve({ command: 'python3 scripts/probe.py', workdir: '/project/.skills/version/' })
  const handle = await f.shell.execute(spec)
  await expect(handle.result()).resolves.toMatchObject({ exitCode: 0 })
  expect(f.channel.prepare).toHaveBeenCalledWith({ argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'python3 scripts/probe.py'],
    cwd: '/project/.skills/version', stdin: { mode: 'ignore' } })
  expect(f.shell.resolve({ command: 'refused', workdir: '/project/../foreign/' }).workdir).toBe('/project/../foreign')
  expect(f.shell.resolve({ command: 'refused', workdir: '/project//nested/' }).workdir).toBe('/project//nested')
})

it('runs native foreground Shell through the original prepared command controller and fixed literal Bash argv', async () => {
  const f = fixture(), spec = f.shell.resolve({ command: 'printf 原生' }), handle = await f.shell.execute(spec)
  await expect(handle.result()).resolves.toMatchObject({ exitCode: 0, timedOut: false, aborted: false,
    stdout: { text: '原生', truncated: false } })
  expect(f.channel.prepare).toHaveBeenCalledWith({ argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'printf 原生'],
    cwd: '/project', stdin: { mode: 'ignore' } })
  expect(f.channel.commit).toHaveBeenCalledTimes(1)
  expect(f.shell.sandboxMode).toBeUndefined()
})

it('reports a completely joined run deadline as Shell timeout while native done still rejects', async () => {
  const f = fixture()
  f.channel.commit.mockImplementation(async () => ({ prepared: true, submitted: true, commitClosed: true,
    rangeEmpty: true, ioClosed: true, physicalStopRequired: false, providerFailure: false,
    direct: undefined, stopCause: 'run-deadline',
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true },
    stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }))
  const handle = await f.shell.execute(f.shell.resolve({ command: 'synthetic original deadline', onExpiry: 'none' }))
  await expect(handle.done).resolves.toBeUndefined()
  await expect(handle.result()).resolves.toMatchObject({ exitCode: null, signal: null, timedOut: true, aborted: false })
  expect(f.port.providerFailed).not.toHaveBeenCalled()
  const [operation] = f.operations
  expect(operation).toBeDefined()
  await expect(operation!.handle.done).rejects.toMatchObject({ name: 'CommandRunDeadlineError' })
})

it.each(['caller', 'kill'] as const)('keeps the original Shell %s interruption ahead of a guest deadline', async (source) => {
  const f = fixture(), caller = new AbortController(), committed = Promise.withResolvers<CommandSnapshot>()
  f.channel.commit.mockImplementation(() => committed.promise)
  const handle = await f.shell.execute(f.shell.resolve({ command: 'synthetic original stop', signal: caller.signal, onExpiry: 'none' }))
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  if (source === 'caller') caller.abort(new Error('first caller interruption'))
  else expect(handle.kill()).toBe(true)
  committed.resolve({ prepared: true, submitted: true, commitClosed: true, rangeEmpty: true, ioClosed: true,
    physicalStopRequired: false, providerFailure: false, direct: undefined, stopCause: 'run-deadline',
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
  await handle.done
  await expect(handle.result()).resolves.toMatchObject({ exitCode: null, signal: null, timedOut: false, aborted: source === 'caller' })
  expect(f.port.providerFailed).not.toHaveBeenCalled()
})

it('keeps actual direct exit facts when the guest also reports a run deadline', async () => {
  const f = fixture()
  f.channel.commit.mockImplementation(async () => ({ prepared: true, submitted: true, commitClosed: true,
    rangeEmpty: true, ioClosed: true, physicalStopRequired: false, providerFailure: false,
    direct: { exitCode: 7, signal: null }, stopCause: 'run-deadline',
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }))
  const handle = await f.shell.execute(f.shell.resolve({ command: 'synthetic direct outcome', onExpiry: 'none' }))
  await expect(handle.result()).resolves.toMatchObject({ exitCode: 7, signal: null, timedOut: false, aborted: false })
  expect(f.port.providerFailed).not.toHaveBeenCalled()
})

it('does not reuse another command deadline as this caller interruption', async () => {
  const f = fixture(), caller = new AbortController()
  const terminal: CommandSnapshot = { prepared: true, submitted: true, commitClosed: true, rangeEmpty: true, ioClosed: true,
    physicalStopRequired: false, providerFailure: false, direct: undefined, stopCause: 'run-deadline',
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }
  f.channel.commit.mockResolvedValue(terminal)
  const first = await f.shell.execute(f.shell.resolve({ command: 'first synthetic deadline', onExpiry: 'none' }))
  await first.done
  const [original] = f.operations
  const reason = await original!.handle.done.catch((cause: unknown) => cause)
  expect(reason).toMatchObject({ name: 'CommandRunDeadlineError' })
  const committed = Promise.withResolvers<CommandSnapshot>()
  f.channel.commit.mockImplementation(() => committed.promise)
  const second = await f.shell.execute(f.shell.resolve({ command: 'caller shares first error', signal: caller.signal, onExpiry: 'none' }))
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledTimes(2) })
  caller.abort(reason); committed.resolve(terminal)
  await second.done
  await expect(second.result()).resolves.toMatchObject({ timedOut: false, aborted: true, exitCode: null, signal: null })
  expect(f.port.providerFailed).not.toHaveBeenCalled()
})

it.each(['acquire', 'prepare'] as const)('keeps another operation deadline rejected by %s out of this operation marker', async (stage) => {
  const f = fixture()
  f.channel.commit.mockImplementation(async () => ({ prepared: true, submitted: true, commitClosed: true, rangeEmpty: true, ioClosed: true,
    physicalStopRequired: false, providerFailure: false, direct: undefined, stopCause: 'run-deadline',
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }))
  const first = await f.shell.execute(f.shell.resolve({ command: 'original confirmed deadline', onExpiry: 'none' }))
  await first.done
  const [original] = f.operations
  const reason = await original!.handle.done.catch((cause: unknown) => cause)
  expect(reason).toMatchObject({ name: 'CommandRunDeadlineError' })
  if (stage === 'acquire') f.allocations.mockRejectedValue(reason)
  else f.channel.prepare.mockRejectedValue(reason)
  await expect(f.shell.execute(f.shell.resolve({ command: 'foreign failure during preparation', onExpiry: 'none' }))).rejects.toBe(reason)
  const operation = [...f.operations].find(value => value !== original)
  expect(operation).toBeDefined()
  await expect(operation!.handle.done).rejects.toBe(reason)
  expect(operation!.stopReason()?.runDeadline).toBeUndefined()
  expect(f.port.providerFailed).not.toHaveBeenCalled()
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

it.each(['caller', 'invocation', 'scope'] as const)('keeps a %s-cancelled unsubmitted command available for actual cleanup without reporting a provider failure', async (source) => {
  const f = fixture(), caller = new AbortController(), commit = Promise.withResolvers<CommandSnapshot>()
  f.channel.commit.mockImplementation(() => commit.promise)
  const handle = await f.shell.execute(f.shell.resolve({ command: 'cancel before submission', signal: caller.signal, onExpiry: 'none' }))
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  const cancellation = source === 'caller' ? caller : source === 'invocation' ? f.invocation : f.scopeLifetime
  cancellation.abort({ kind: 'user' })
  let settled = false
  void handle.done.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  commit.resolve({ prepared: true, submitted: false, commitClosed: true, rangeEmpty: true, ioClosed: true,
    physicalStopRequired: false, providerFailure: false, direct: undefined,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true },
    stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
  await handle.done
  if (source !== 'scope') {
    await expect(handle.result()).resolves.toMatchObject({ aborted: true, timedOut: false, exitCode: null })
  } else {
    expect(f.operations.size).toBe(0)
    expect(() => handle.result()).toThrow('foreign operation')
  }
  expect(f.port.providerFailed).not.toHaveBeenCalled()
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
