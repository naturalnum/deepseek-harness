/** Account command ownership over synthetic native identities and channels; no Loader, PG or backend qualification. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ToolDispatchExecution, ToolExecutionToken, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeAccountExecutionAuthority } from '../src/coordinator.ts'
import type { CommandChannel, CommandSnapshot, ManagedCommandOperation } from '../src/command-operation.ts'
import { FilesWorkOwner } from '@deepseek-ai/dsh-pe-cloud-files/src/work-owner.ts'
import { SessionAllocationOwner } from '../src/allocation-owner.ts'
import type { PostgresAllocationStore } from '../src/allocation-store.ts'
import type { AllocationCreateIntent, AllocationExpectation, AllocationChange, SandboxAllocation } from '../src/allocation-types.ts'
import { NativeCommandAccount, type NativeCommandRoot } from '../src/native-command-account.ts'

const result: ToolExecutionResult = { isError: false, value: null, content: [] }
const initial = (): CommandSnapshot => ({ prepared: true, submitted: false, commitClosed: false,
  rangeEmpty: false, ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined,
  stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false },
  stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } })
const complete = (empty = true): CommandSnapshot => ({ ...initial(), submitted: true, rangeEmpty: empty, ioClosed: empty,
  direct: { exitCode: 0, signal: null }, stdout: { bytes: Buffer.from('canonical output'), observedBytes: 16, eof: true },
  stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
const cancelled = (): CommandSnapshot => ({ ...initial(), commitClosed: true, rangeEmpty: true, ioClosed: true,
  stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture() {
  const ctx = new Context(), generation = new AbortController(), close = Promise.withResolvers<undefined>()
  const binding: AccountBinding = Object.freeze({ accountId: 'command-account' as AccountBinding['accountId'],
    epoch: '1' as AccountBinding['epoch'], recipeVersion: 'synthetic-source-component', lifetime: generation.signal })
  ctx.provide('peAccount', binding)
  const ids = [SessionId('A'), SessionId('B')]
  const workspace: Workspace = { id: brandString<Workspace['id']>('workspace'), path: '/project', sessionIds: ids,
    title: 'synthetic project', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
    setTitle: () => Promise.resolve(), attachSession: () => Promise.resolve(), insertSessionBefore: () => Promise.resolve(),
    detachSession: () => Promise.resolve(), status: () => Promise.resolve('ok') }
  const agents = new Map(ids.map(id => [id, { ctx, id, session: Session.create(id) } as Agent]))
  let business = true, nativeProject = workspace
  const authority: NativeAccountExecutionAuthority = { assertBusinessCurrent() {
    if (!business) throw new Error('business admission closed')
  }, getAgent: id => agents.get(id), projectForAgent: () => nativeProject, projectForSession: () => nativeProject,
  files() { throw new Error('Files/acquisition assembly belongs to the separate Root callback.') } }
  const channels: ReturnType<typeof makeChannel>[] = [], operations: ManagedCommandOperation[] = []
  function makeChannel() {
    const poll = Promise.withResolvers<CommandSnapshot>(), prepare = Promise.withResolvers<CommandSnapshot>()
    const channel = { prepare: vi.fn(async () => initial()), commit: vi.fn(async () => complete(false)),
      poll: vi.fn(() => poll.promise), stop: vi.fn(async () => cancelled()) } satisfies CommandChannel
    return { channel, poll, prepare }
  }
  let channelFactory = makeChannel
  const reservations: { releaseActive: ReturnType<typeof vi.fn<() => void>>; releaseResident: ReturnType<typeof vi.fn<() => void>> }[] = []
  const root = { acquire: vi.fn<NativeCommandRoot['acquire']>(async () => {
    const entry = channelFactory(); channels.push(entry); return entry.channel
  }), unknown: vi.fn<NativeCommandRoot['unknown']>(),
  reserve: vi.fn<NativeCommandRoot['reserve']>(() => {
    const value = { releaseActive: vi.fn<() => void>(), releaseResident: vi.fn<() => void>() }
    reservations.push(value); return value
  }), close: vi.fn(() => close.promise) } satisfies NativeCommandRoot
  const owner = new NativeCommandAccount(ctx, binding, authority, { allowedTools: ['bash'], maxScopes: 4,
    commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
      maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 10000, stopWaitMs: 1000 } }, root)
  const spec: SubprocessSpawnSpec = { argv: ['/bin/bash', '-c', 'literal'], cwd: '/project', graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } }
  const exec = (id = ids[0]!): ToolDispatchExecution => ({ callId: brandString<ToolDispatchExecution['callId']>(id),
    rootCallId: brandString<ToolDispatchExecution['callId']>(id), token: Symbol(id) as ToolExecutionToken,
    name: 'bash', arguments: {}, agent: agents.get(id)!, signal: new AbortController().signal })
  const create = (input = spec): ManagedCommandOperation => {
    const operation = owner.create(ctx, input); operations.push(operation); return operation
  }
  cleanups.push(async () => {
    for (const entry of channels) { entry.prepare.resolve(initial()); entry.poll.resolve(complete()) }
    close.resolve(undefined); await owner.closeProvider(); await ctx.fiber.dispose()
  })
  return { ctx, owner, root, reservations, channels, operations, spec, exec, create, close, generation, workspace, agents,
    makeChannel, setFactory: (factory: typeof makeChannel) => { channelFactory = factory },
    closeBusiness: () => { business = false }, replaceProject: () => { nativeProject = { ...workspace } } }
}

it('rejects unsupported native input, outside cwd and the complete encoded frame before Root reservation or acquisition', async () => {
  const f = fixture(), call = f.exec()
  await f.owner.calls.run(call, async () => {
    for (const spec of [{ ...f.spec, cwd: '/elsewhere' }, { ...f.spec, env: { EXAMPLE: 'unsupported' } },
      { ...f.spec, argv: ['/bin/echo', '\x01'.repeat(800)] },
      { ...f.spec, stdio: { ...f.spec.stdio, stdin: 'pipe' as const } },
      { ...f.spec, stdio: { ...f.spec.stdio, control: 'pipe' as const } },
      { ...f.spec, stdio: { ...f.spec.stdio, stdout: { maxBytes: 32, spill: { maxBytes: 64 } } } }]) {
      expect(() => f.create(spec)).toThrow()
    }
    expect(f.root.reserve).not.toHaveBeenCalled(); expect(f.root.acquire).not.toHaveBeenCalled()
    return result
  })
  f.owner.calls.release(call.token)
})

it('holds the single Session active reservation through direct completion and releases resident output only after final projection', async () => {
  const f = fixture(), call = f.exec()
  await f.owner.calls.run(call, async () => {
    const op = f.create(); op.publish(); op.begin(); await op.handle.done
    expect(() => f.create()).toThrow('active command range')
    expect(f.root.reserve).toHaveBeenCalledTimes(1); expect(f.root.acquire).toHaveBeenCalledTimes(1)
    expect(f.reservations[0]!.releaseActive).not.toHaveBeenCalled()
    f.channels[0]!.poll.resolve(complete()); await op.whenEmpty
    expect(f.reservations[0]!.releaseActive).toHaveBeenCalledTimes(1)
    expect(f.reservations[0]!.releaseResident).not.toHaveBeenCalled()
    expect(op.handle.collected.stdout!.readFrom(0).text).toBe('canonical output')
    const next = f.create(); next.publish(); next.begin(); await next.handle.done
    f.channels[1]!.poll.resolve(complete()); await next.whenEmpty
    return result
  })
  f.owner.calls.release(call.token)
  for (const held of f.reservations) expect(held.releaseResident).toHaveBeenCalledTimes(1)
})

it('keeps original scopes across awaits and releases only the corresponding tool result in a shared project', async () => {
  const f = fixture(), a = f.exec(SessionId('A')), b = f.exec(SessionId('B'))
  let opA: ManagedCommandOperation | undefined, opB: ManagedCommandOperation | undefined
  for (const call of [a, b]) await f.owner.calls.run(call, async () => {
    await Promise.resolve()
    const op = f.create(); op.publish(); op.begin(); await op.handle.done
    f.channels.at(-1)!.poll.resolve(complete()); await op.whenEmpty
    if (call === a) opA = op; else opB = op
    return result
  })
  f.owner.assertOperationCurrent(f.ctx, opA!); f.owner.assertOperationCurrent(f.ctx, opB!)
  f.owner.calls.release(a.token)
  expect(f.reservations[0]!.releaseResident).toHaveBeenCalledTimes(1)
  expect(f.reservations[1]!.releaseResident).not.toHaveBeenCalled()
  expect(() => { f.owner.assertOperationCurrent(f.ctx, opA!) }).toThrow()
  expect(opB!.handle.collected.stdout!.readFrom(0).text).toBe('canonical output')
  f.replaceProject()
  expect(() => { f.owner.assertOperationCurrent(f.ctx, opB!) }).toThrow()
  f.owner.calls.release(b.token)
})

it('fuses native and explicit operation cancellation without releasing the original output scope', async () => {
  for (const source of ['native', 'spec'] as const) {
    const f = fixture(), call = f.exec(), native = new AbortController(), explicit = new AbortController()
    call.signal = native.signal
    f.setFactory(() => {
      const entry = f.makeChannel(); entry.channel.prepare.mockImplementation(() => entry.prepare.promise); return entry
    })
    await f.owner.calls.run(call, async () => {
      const reason = new Error(source + ' first cancellation'), op = f.create({ ...f.spec, signal: explicit.signal })
      const done = op.handle.done
      op.begin(); await vi.waitFor(() => { expect(f.channels[0]?.channel.prepare).toHaveBeenCalledTimes(1) })
      const controller = source === 'native' ? native : explicit
      controller.abort(reason)
      f.channels[0]!.prepare.resolve(initial()); await op.whenEmpty
      await expect(done).rejects.toBe(reason)
      expect(f.channels[0]!.channel.commit).not.toHaveBeenCalled()
      expect(f.reservations[0]!.releaseActive).toHaveBeenCalledTimes(1)
      expect(f.reservations[0]!.releaseResident).not.toHaveBeenCalled()
      return result
    })
    f.owner.calls.release(call.token)
  }
})

it('keeps raw channel failure private and retains both budgets until original physical stop settles the unknown range', async () => {
  const f = fixture(), call = f.exec(), secret = new Error('private-sdk-password-value')
  f.setFactory(() => { const entry = f.makeChannel(); entry.channel.prepare.mockRejectedValue(secret); return entry })
  let op: ManagedCommandOperation | undefined
  await f.owner.calls.run(call, async () => {
    op = f.create(); op.publish(); op.begin()
    await expect(op.handle.done).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
    await op.handle.done.catch((cause: unknown) => {
      expect(String(cause)).not.toContain(secret.message)
      expect(cause).not.toHaveProperty('cause')
    })
    expect(f.root.unknown).toHaveBeenCalledWith(expect.anything(), op, secret)
    expect(f.reservations[0]!.releaseActive).not.toHaveBeenCalled()
    return result
  })
  f.owner.calls.release(call.token)
  expect(f.reservations[0]!.releaseResident).not.toHaveBeenCalled()
  op!.acknowledgePhysicalStop(); await op!.whenEmpty
  expect(f.reservations[0]!.releaseActive).toHaveBeenCalledTimes(1)
  expect(f.reservations[0]!.releaseResident).toHaveBeenCalledTimes(1)
})

it('fences native calls synchronously and joins actual Root stop and late local requests without business reauthorization', async () => {
  const f = fixture(), call = f.exec()
  f.setFactory(() => {
    const entry = f.makeChannel(); entry.channel.prepare.mockImplementation(() => entry.prepare.promise); return entry
  })
  await f.owner.calls.run(call, async () => {
    const op = f.create(); op.publish(); op.begin()
    await vi.waitFor(() => { expect(f.channels[0]?.channel.prepare).toHaveBeenCalledTimes(1) })
    return result
  })
  f.closeBusiness()
  let reentrant: Promise<void> | undefined
  f.root.close.mockImplementation(() => { reentrant = f.owner.closeProvider(); return f.close.promise })
  const closing = f.owner.closeProvider()
  expect(reentrant).toBe(closing)
  expect(f.owner.closeProvider()).toBe(closing)
  expect(() => f.owner.calls.capture(f.ctx)).toThrow()
  expect(f.root.close).toHaveBeenCalledTimes(1)
  let settled = false
  void closing.then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  expect(f.reservations[0]!.releaseActive).not.toHaveBeenCalled()
  f.channels[0]!.prepare.resolve(initial())
  await f.operations[0]!.whenEmpty
  expect(settled).toBe(false)
  f.close.resolve(undefined); await closing
  expect(f.reservations[0]!.releaseActive).toHaveBeenCalledTimes(1)
  expect(f.reservations[0]!.releaseResident).toHaveBeenCalledTimes(1)
})

it('settles an unstarted Root reservation refusal without invoking allocation', async () => {
  const f = fixture(), call = f.exec()
  f.root.reserve.mockImplementation(() => { throw new Error('finite global reservation exhausted') })
  await f.owner.calls.run(call, async () => {
    expect(() => f.create()).toThrow('finite global reservation exhausted')
    await Promise.resolve(); await Promise.resolve()
    expect(f.root.acquire).not.toHaveBeenCalled(); expect(f.root.unknown).not.toHaveBeenCalled()
    return result
  })
  f.owner.calls.release(call.token)
})

it('observes original invocation and subprocess range settlement without cancelling busy work', async () => {
  const f = fixture(), call = f.exec()
  expect(f.owner.isIdle()).toBe(true)
  await f.owner.calls.run(call, async () => {
    expect(f.owner.isIdle()).toBe(false)
    const op = f.create(); op.publish(); op.begin(); await op.handle.done
    // Direct child/output completion is not complete descendant-range and process-I/O closure.
    expect(f.owner.isIdle()).toBe(false)
    expect(f.channels[0]!.channel.stop).not.toHaveBeenCalled()
    expect(f.root.close).not.toHaveBeenCalled()
    f.channels[0]!.poll.resolve(complete()); await op.whenEmpty
    expect(f.owner.isIdle()).toBe(false)
    expect(f.reservations[0]!.releaseActive).toHaveBeenCalledTimes(1)
    expect(f.reservations[0]!.releaseResident).not.toHaveBeenCalled()
    return result
  })
  f.owner.calls.release(call.token)
  expect(f.owner.isIdle()).toBe(true)
  f.closeBusiness()
  expect(f.owner.isIdle()).toBe(true)
  f.generation.abort()
  expect(f.owner.isIdle()).toBe(false)
})

it('refuses original pending subprocess acquisition even before a channel exists', async () => {
  const f = fixture(), call = f.exec()
  const acquisition = Promise.withResolvers<CommandChannel>()
  f.root.acquire.mockImplementation(() => acquisition.promise)
  await f.owner.calls.run(call, async () => {
    const op = f.create(); op.publish(); op.begin()
    expect(f.owner.isIdle()).toBe(false)
    const entry = f.makeChannel()
    acquisition.resolve(entry.channel)
    await op.handle.done
    expect(f.owner.isIdle()).toBe(false)
    entry.poll.resolve(complete()); await op.whenEmpty
    return result
  })
  f.owner.calls.release(call.token)
  expect(f.owner.isIdle()).toBe(true)
})


it('keeps both original files leases and warm compute through quiet observation and a second native command', async () => {
  const f = fixture(), binding = f.ctx.peAccount
  const files = new FilesWorkOwner({ maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2,
    maxQueuedPerLane: 2, maxResidentBytes: 64, maxResidentBytesPerLane: 64, waitTimeoutMs: 1000 })
  const port = files.bind(binding, () => {})
  const rows = new Map<string, SandboxAllocation>()
  // Only metadata and authenticated process transport are scripted; all work/lease observers are original owners.
  const store: Pick<PostgresAllocationStore, 'begin' | 'transition' | 'failNotCreated' | 'releaseStopped' | 'reconcileCommitted'> = {
    begin: vi.fn(async (intent: AllocationCreateIntent) => {
      const allocation: SandboxAllocation = { ...intent, state: 'creating', sandboxId: null,
        lastActivityAt: intent.requestedAt, lastCheckedAt: intent.requestedAt, runtimeIdentity: null,
        executionProtocolVersion: null, executionCapabilities: [], failureCode: null }
      rows.set(intent.allocationId, allocation); return { allocation, inserted: true }
    }),
    transition: vi.fn(async (expected: AllocationExpectation, change: AllocationChange) => {
      const row = rows.get(expected.allocationId)
      if (row === undefined || row.state !== expected.state) throw new Error('External metadata CAS conflict')
      const next: SandboxAllocation = { ...row, state: change.to, sandboxId: change.sandboxId ?? row.sandboxId,
        ...(change.to === 'ready' ? { runtimeIdentity: change.runtimeIdentity, executionProtocolVersion: change.executionProtocolVersion,
          executionCapabilities: change.executionCapabilities } : {}) }
      rows.set(next.allocationId, next); return next
    }),
    failNotCreated: vi.fn(async () => { throw new Error('No failed creation expected') }),
    releaseStopped: vi.fn(async (expected: AllocationExpectation) => {
      const row = rows.get(expected.allocationId)
      if (row?.state !== 'stopping') throw new Error('External metadata is not stopped')
      const next: SandboxAllocation = { ...row, state: 'released' }; rows.set(next.allocationId, next); return next
    }),
    reconcileCommitted: vi.fn(async () => { throw new Error('No uncertain metadata expected') }),
  }
  const ready = { sandboxId: 'warm-compute', runtimeIdentity: 'same-runtime', protocolVersion: 'scripted-original-channel',
    capabilities: ['argv-collect'] as const }
  const backend = { create: vi.fn(async () => ({ sandboxId: ready.sandboxId })),
    prepare: vi.fn(async () => ready), stop: vi.fn(async () => {}) }
  const allocations = new SessionAllocationOwner(store, backend, { environmentVersion: 'warm-fixture', provider: 'scripted',
    createBudgetMs: 1000, maxAllocations: 1, maxAllocationsPerAccount: 1, maxWaiters: 2, maxWaitersPerAllocation: 2 })
  const request = { binding, sessionId: f.exec().agent!.session.id, workspaceId: f.workspace.id,
    assertCurrent: () => { binding.lifetime.throwIfAborted() }, prepareMount: async () => {
      const mounts = await port.run(8, async () => Object.freeze({ mount: 'same-original-grant' }), undefined, 'lease')
      const parent = await port.run(8, async () => Object.freeze({ parent: 'same-original-project' }), undefined, 'lease')
      return { value: { mounts: mounts.value, parent: parent.value }, projectMountVersion: 'same-version',
        assertCurrent: () => { binding.lifetime.throwIfAborted() }, release: () => { parent.release(); mounts.release() } }
    } }
  f.root.acquire.mockImplementation(async () => {
    expect(await allocations.prepare(request)).toBe(ready)
    const channel = f.makeChannel(); f.channels.push(channel); return channel.channel
  })
  try {
    for (let command = 0; command < 2; command++) {
      const call = f.exec()
      await f.owner.calls.run(call, async () => {
        const operation = f.create(); operation.publish(); operation.begin(); await operation.handle.done
        expect(f.owner.isIdle()).toBe(false)
        expect(allocations.isEpochIdle(binding)).toBe(true)
        expect(files.isEpochIdle(binding)).toBe(true)
        f.channels.at(-1)!.poll.resolve(complete()); await operation.whenEmpty
        return result
      })
      f.owner.calls.release(call.token)
      expect(f.owner.isIdle()).toBe(true)
      expect(allocations.isEpochIdle(binding)).toBe(true)
      expect(files.isEpochIdle(binding)).toBe(true)
      expect(allocations.inspect().allocations).toBe(1)
      expect(files.inspect()).toMatchObject({ residentBytes: 16, pending: 2 })
      expect(backend.create).toHaveBeenCalledTimes(1); expect(backend.stop).not.toHaveBeenCalled()
      expect(binding.lifetime.aborted).toBe(false)
    }
    const io = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
    const write = port.run(4, async () => { entered.resolve(undefined); await io.promise })
    await entered.promise
    expect(files.isEpochIdle(binding)).toBe(false)
    io.resolve(undefined); const retained = await write
    expect(files.isEpochIdle(binding)).toBe(false)
    retained.release()
    expect(files.isEpochIdle(binding)).toBe(true)
  } finally { await allocations.close(); files.close(); await files.whenClosed() }
  expect(backend.stop).toHaveBeenCalledTimes(1)
  expect(files.inspect().residentBytes).toBe(0)
})


it('refuses quiet after the original invocation issuer has terminally closed', () => {
  const f = fixture()
  expect(f.owner.isIdle()).toBe(true)
  f.owner.calls.close()
  expect(f.owner.isIdle()).toBe(false)
})
