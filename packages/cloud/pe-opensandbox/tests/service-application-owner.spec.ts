/** Original native service rows over synthetic command/HTTP terminals; no route, socket, backend or live resource is enabled. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { NativeCommandAccount, type NativeCommandRoot, type NativeRegisteredService,
  type NativeServiceAccountConfig } from '../src/native-command-account.ts'
import { CloudSubprocessRuntime } from '../src/native-providers.ts'
import type { CommandChannel, CommandSnapshot, ManagedCommandOperation } from '../src/command-operation.ts'
import { registerDevServiceConsumer, type DevServiceProfile, type OriginalDevServiceWork } from '../src/dev-service-consumer.ts'
import { PreviewHttpError, type PreviewHttpOwner, type HttpRequestCharge } from '../src/application-http.ts'
import type { RegisteredApplicationService, ServicePreviewIdentity } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks() })
const request = { method: 'GET', resourcePath: '/', headers: [] } as const
const responseLimits = { maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 4, maxHeaderCount: 8, maxHeaderBytes: 512 }
const charge: HttpRequestCharge = { retainedPayloadBytes: 4096, headerEntries: 11, maxWireBytes: 1024, timeoutMs: 2000 }
const idle = async (): Promise<void> => {}
function observed(actual: Promise<void>) {
  const state: { settled: boolean; cause?: unknown } = { settled: false }
  const joined = actual.then(() => { state.settled = true }, (cause: unknown) => { state.settled = true; state.cause = cause })
  return { state, joined }
}
function command(holdCommit: boolean) {
  const prepared: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
    physicalStopRequired: false, providerFailure: false, direct: undefined,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } }
  let current = prepared
  const committed = Promise.withResolvers<undefined>()
  const polls: ReturnType<typeof Promise.withResolvers<CommandSnapshot>>[] = []
  const advance = (): void => { for (const poll of polls.splice(0)) poll.resolve(current) }
  const value: CommandChannel = {
    prepare: async () => prepared,
    commit: async () => { current = { ...prepared, submitted: true }; if (holdCommit) await committed.promise; return current },
    poll: () => {
      if (current.rangeEmpty) return Promise.resolve(current)
      const poll = Promise.withResolvers<CommandSnapshot>(); polls.push(poll); return poll.promise
    },
    // Controlled hard stop never invents a direct exit/signal; the later range receipt is separate.
    stop: vi.fn(async () => { current = { ...current, commitClosed: true }; return current }),
  }
  return { value, advance, completeCommit() { committed.resolve(undefined) }, empty() {
    current = { ...current, rangeEmpty: true, ioClosed: true, commitClosed: true,
      stdout: { ...current.stdout, eof: true }, stderr: { ...current.stderr, eof: true } }; committed.resolve(undefined); advance()
  } }
}

interface Attempt {
  readonly input: Parameters<PreviewHttpOwner['retainRequest']>[0]
  readonly gate: ReturnType<typeof Promise.withResolvers<undefined>>
  readonly wireGate: ReturnType<typeof Promise.withResolvers<undefined>>
  retained?: ReturnType<PreviewHttpOwner['retainRequest']>
  wire: boolean
  failure?: unknown
  finish(): void
  fail(cause: unknown): void
}
async function fixture(options: { application?: boolean; bind?: boolean; maximum?: number; account?: string; holdCommit?: boolean } = {}) {
  const ctx = new Context(), generation = new AbortController(), ids = [SessionId('A'), SessionId('B')]
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>(options.account ?? 'application-A'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'synthetic-only', lifetime: generation.signal }
  ctx.provide('peAccount', binding); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const workspace: Workspace = { id: brandString<Workspace['id']>('project'), path: '/project', sessionIds: ids,
    title: 'component', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
    setTitle: async () => {}, attachSession: async () => {}, detachSession: async () => {}, insertSessionBefore: async () => {},
    status: async () => 'ok' }
  let currentProject = workspace, businessCurrent = true
  const agents = new Map<SessionId, Agent>()
  for (const id of ids) {
    const agent = { id, ctx, session: Session.create(id) } as Agent
    await ctx.plugin(Object.assign((inner: Context) => { Object.assign(agent, { ctx: inner }) }, { inject: ['tools', 'systemPrompt'] }))
    agents.set(id, agent)
  }
  const profile: DevServiceProfile = { kind: 'python-http-v1', port: 8000, startWaitMs: 1000, runMs: 10000,
    stopWaitMs: 1000, maxLogReadBytes: 64, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 4, maxArgBytes: 128, maxArgsBytes: 256 }
  const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 64,
    maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 4, maxLifetimeMs: 20000, stopWaitMs: 3000 }
  const physical = Promise.withResolvers<undefined>()
  const processReservations: { active: ReturnType<typeof vi.fn>; resident: ReturnType<typeof vi.fn> }[] = []
  const entries: { channel: ReturnType<typeof command>; registration?: NativeRegisteredService }[] = []
  const works: OriginalDevServiceWork<Workspace>[] = [], operations: ManagedCommandOperation[] = []
  const budgets: { release: ReturnType<typeof vi.fn>; scope: NativeRegisteredService['scope']; charge: HttpRequestCharge }[] = []
  const attempts: Attempt[] = []
  const factories: { registration: NativeRegisteredService; identity: ServicePreviewIdentity; owner: PreviewHttpOwner }[] = []
  let onReserve: (() => void) | undefined, holdWire = false, reserveFailure: unknown, releaseFailure: unknown, physicalFailure: unknown
  const reserve = vi.fn<NonNullable<NativeServiceAccountConfig['application']>['reserve']>((scope, charged) => {
    if (reserveFailure !== undefined) throw reserveFailure
    const value = { scope, charge: charged, release: vi.fn(() => { if (releaseFailure !== undefined) throw releaseFailure }) }
    budgets.push(value); onReserve?.(); return value
  })
  const transport = vi.fn<NonNullable<NativeServiceAccountConfig['application']>['transport']>((registration, identity, owner) => {
    factories.push({ registration, identity, owner })
    return { async withResponse(_request, _limits, signal, consume) {
      const controller = new AbortController(), terminal = Promise.withResolvers<undefined>()
      void terminal.promise.catch((_cause: unknown) => {})
      const gate = Promise.withResolvers<undefined>(), wireGate = Promise.withResolvers<undefined>()
      const attempt: Attempt = { input: { controller, settled: terminal.promise, charge }, gate, wireGate, wire: false,
        finish() { gate.resolve(undefined) }, fail(cause) { attempt.failure = cause; gate.resolve(undefined) } }
      attempts.push(attempt)
      const abort = (): void => { controller.abort(signal.reason) }
      let failure: { cause: unknown } | undefined
      try {
        attempt.retained = owner.retainRequest(attempt.input)
        if (!holdWire) wireGate.resolve(undefined)
        await wireGate.promise
        attempt.retained.assertCurrent(); signal.throwIfAborted(); controller.signal.throwIfAborted()
        attempt.wire = true
        signal.addEventListener('abort', abort, { once: true })
        await consume({ status: 200, headers: [], read: async () => null, close: idle })
      } catch (cause) { failure = { cause } }
      finally {
        if (attempt.retained !== undefined) await gate.promise
        signal.removeEventListener('abort', abort)
        if (attempt.failure !== undefined) { terminal.reject(attempt.failure); failure = { cause: attempt.failure } }
        else terminal.resolve(undefined)
      }
      if (failure !== undefined) throw failure.cause
      controller.signal.throwIfAborted()
    } }
  })
  const unknown = vi.fn<NativeCommandRoot['unknown']>((_scope, operation, cause) => { operation.requestStop(cause) })
  const acquire = vi.fn<NativeCommandRoot['acquire']>(async (_scope, _signal, registration) => {
    if (registration !== undefined && options.bind !== false) {
      registration.bindAllocation(brandString<ServicePreviewIdentity['allocationId']>('allocation-original'))
    }
    const channel = command(options.holdCommit === true)
    entries.push({ channel, ...(registration === undefined ? {} : { registration }) }); return channel.value
  })
  const owner = new NativeCommandAccount(ctx, binding, { assertBusinessCurrent() { if (!businessCurrent) throw new Error('stale epoch') },
    getAgent: id => agents.get(id), projectForAgent: () => currentProject, projectForSession: () => currentProject,
    files() { throw new Error('not used') } },
  { allowedTools: ['dev_service'], maxScopes: 64, commandLimits: limits,
    services: { profile, operationLimits: limits, assertQualified(value) { expect(value).toBe(profile) },
      ...(options.application === false ? {} : { application: { maxRequestsPerService: options.maximum ?? 2, reserve, transport } }),
      serviceSpec(scope, _profile, start) { return { argv: ['/opt/session-env/venv/bin/python', '-B', '/project/' + start.script, ...start.args], cwd: '/project',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } }, graceMs: 100, signal: scope.lifetime } } } },
  { acquire, unknown, reserve() {
    const reservation = { active: vi.fn(), resident: vi.fn() }; processReservations.push(reservation)
    return { releaseActive: reservation.active, releaseResident: reservation.resident }
  }, async close() {
    await physical.promise
    if (physicalFailure !== undefined) throw physicalFailure
    for (const entry of entries) entry.channel.empty()
  } })
  const attach = owner.attachOriginal.bind(owner), create = owner.create.bind(owner)
  vi.spyOn(owner, 'attachOriginal').mockImplementation((...args) => { const value = attach(...args); works.push(value); return value })
  vi.spyOn(owner, 'create').mockImplementation((...args) => { const value = create(...args); operations.push(value); return value })
  const runtime = new CloudSubprocessRuntime(ctx, owner)
  registerDevServiceConsumer(ctx, owner.calls, runtime, owner, profile)
  let count = 0
  const start = async (id = ids[0]!) => {
    const result = await ctx.tools.execute({ callId: ToolCallId(`start-${++count}`), name: 'dev_service',
      arguments: { action: 'start', script: 'hello.py' }, agent: agents.get(id)!, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    const work = works.at(-1)
    if (work === undefined) throw new Error('No original native service work')
    return work
  }
  const select = (work = works[0]!) => ({ sessionId: work.lease.scope.sessionId, serviceId: work.handle })
  const borrow = (consume: (service: RegisteredApplicationService) => Promise<void>, signal = new AbortController().signal,
    deadlineAtMs = Date.now() + 10000, work = works[0]!) => owner.withApplicationService(select(work), signal, deadlineAtMs, consume)
  cleanups.push(async () => {
    for (const attempt of attempts) { attempt.wireGate.resolve(undefined); attempt.finish() }
    physical.resolve(undefined); for (const entry of entries) entry.channel.empty()
    await owner.closeProvider().catch((_cause: unknown) => { /* Failed terminal remains deliberately unknown in negative components. */ })
    await ctx.fiber.dispose()
  })
  return { ctx, owner, binding, generation, agents, workspace, entries, operations, works, start, select, borrow, attempts,
    factories, reserve, transport, budgets, acquire, physical, processReservations, unknown,
    onReserve(value: (() => void) | undefined) { onReserve = value }, holdWire() { holdWire = true },
    failReserve(cause: unknown) { reserveFailure = cause }, failRelease(cause: unknown) { releaseFailure = cause },
    failPhysical(cause: unknown) { physicalFailure = cause },
    staleEpoch() { businessCurrent = false }, replaceProject() { currentProject = { ...workspace } } }
}

it('borrows exactly the five original ids and registered port outside ALS, and releases only successful actual terminals', async () => {
  const f = await fixture(), work = await f.start(), caller = new AbortController()
  let captured: RegisteredApplicationService | undefined
  const read = observed(f.borrow(async (service) => {
    captured = service
    await service.withResponse(request, responseLimits, caller.signal, idle)
  }, caller.signal))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  expect(captured?.scope).toEqual(work.previewIdentity()); expect(Object.isFrozen(captured?.scope)).toBe(true)
  expect(captured?.port).toBe(8000); expect(captured?.lifetime).toBe(work.lease.scope.lifetime)
  expect(f.factories[0]!.registration).toBe(f.entries[0]!.registration)
  expect(f.budgets[0]!.scope).toBe(work.lease.scope); expect(f.budgets[0]!.charge).toBe(charge)
  expect(f.attempts[0]!.retained?.timeoutMs).toBe(2000)
  expect(f.acquire).toHaveBeenCalledTimes(1); expect(f.processReservations).toHaveLength(1)
  expect(read.state.settled).toBe(false); expect(f.budgets[0]!.release).not.toHaveBeenCalled()
  f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBeUndefined(); expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1)
  expect(f.unknown.mock.calls.length).toBe(0)
  expect(() => captured?.assertCurrent()).toThrow()
  await expect(captured!.withResponse(request, responseLimits, caller.signal, idle)).rejects.toThrow()
  expect(f.transport).toHaveBeenCalledTimes(1)
})

it.each(['missing', 'unbound', 'other-session', 'other-account', 'agent', 'session', 'project', 'epoch'] as const)(
  'rejects %s before request reservation, factory or wire without allocating or reviving', async (variant) => {
    const f = await fixture({ application: variant !== 'missing', bind: variant !== 'unbound' }), work = await f.start()
    let selection = f.select(work)
    if (variant === 'other-session') selection = { ...selection, sessionId: SessionId('B') }
    if (variant === 'other-account') {
      const other = await fixture({ account: 'application-B' }), otherWork = await other.start()
      selection = { ...selection, serviceId: otherWork.handle }
    }
    if (variant === 'agent') f.agents.set(SessionId('A'), { ...f.agents.get(SessionId('A'))! })
    if (variant === 'session') Object.assign(f.agents.get(SessionId('A'))!, { session: Session.create(SessionId('A')) })
    if (variant === 'project') f.replaceProject()
    if (variant === 'epoch') f.staleEpoch()
    await expect(f.owner.withApplicationService(selection, new AbortController().signal, Date.now() + 10000, idle)).rejects.toThrow()
    expect(f.reserve.mock.calls.length).toBe(0); expect(f.transport.mock.calls.length).toBe(0)
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

it('allows one withResponse per borrow, bounds simultaneous reads on the same service, and admits a replacement only after settlement', async () => {
  const f = await fixture(), work = await f.start()
  const first = observed(f.borrow(async (service) => {
    const actual = service.withResponse(request, responseLimits, new AbortController().signal, idle)
    await expect(service.withResponse(request, responseLimits, new AbortController().signal, idle)).rejects.toThrow()
    await actual
  }))
  const second = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts.filter(value => value.wire)).toHaveLength(2) })
  await expect(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle))).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(f.reserve).toHaveBeenCalledTimes(2)
  f.attempts[0]!.finish(); await first.joined
  const replacement = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[3]?.wire).toBe(true) })
  f.attempts[1]!.finish(); f.attempts[3]!.finish(); await second.joined; await replacement.joined
  expect(f.budgets).toHaveLength(3)
  for (const budget of f.budgets) expect(budget.release).toHaveBeenCalledTimes(1)
  expect(work.previewIdentity()?.serviceId).toBe(work.handle)
})

it('cannot replace original cancellation with a fresh withResponse signal, and abort alone retains request capacity', async () => {
  const f = await fixture(); await f.start()
  const caller = new AbortController(), cause = new Error('original request cancelled')
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle),
    caller.signal))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  caller.abort(cause)
  expect(f.attempts[0]!.input.controller.signal.aborted).toBe(true)
  expect(f.budgets[0]!.release).not.toHaveBeenCalled(); expect(read.state.settled).toBe(false)
  f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBe(cause); expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1)
  expect(f.unknown.mock.calls.length).toBe(0)
})

it.each(['deadline', 'project'] as const)('rechecks %s immediately before wire and preserves the original bounded timeout', async (variant) => {
  const f = await fixture(); await f.start(); f.holdWire()
  const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  vi.spyOn(performance, 'now').mockReturnValue(performance.now())
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle),
    new AbortController().signal, start + 37))
  await vi.waitFor(() => { expect(f.attempts[0]?.retained).toBeDefined() })
  expect(f.attempts[0]!.retained?.timeoutMs).toBe(37)
  if (variant === 'deadline') clock.mockReturnValue(start + 38)
  else f.replaceProject()
  f.attempts[0]!.wireGate.resolve(undefined); f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBeDefined(); expect(f.attempts[0]!.wire).toBe(false)
  expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1); expect(f.unknown.mock.calls.length).toBe(0)
  clock.mockRestore()
})

it.each(['abort', 'stop', 'close'] as const)('rolls back a known unstarted reservation after synchronous reserve→%s reentrancy', async (variant) => {
  const f = await fixture(), work = await f.start(), caller = new AbortController()
  let stop: Promise<unknown> | undefined
  f.onReserve(() => {
    if (variant === 'abort') caller.abort(new Error('reserve aborted original caller'))
    else if (variant === 'stop') stop = work.stop(new AbortController().signal)
    else stop = f.owner.closeProvider()
  })
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, caller.signal, idle), caller.signal))
  await read.joined
  expect(read.state.cause).toBeDefined(); expect(f.attempts[0]!.wire).toBe(false)
  expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1); expect(f.unknown.mock.calls.length).toBe(0)
  f.physical.resolve(undefined); f.entries[0]!.channel.empty(); await stop
})

it('rechecks the same finite set after a reentrant reserve admits another read', async () => {
  const f = await fixture({ maximum: 1 }); await f.start()
  let nested: ReturnType<typeof observed> | undefined
  f.onReserve(() => {
    f.onReserve(undefined)
    nested = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  })
  const first = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await first.joined
  expect(first.state.cause).toMatchObject({ code: 'cloud/capacity' })
  expect(f.attempts[0]!.wire).toBe(false); expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => { expect(f.attempts[1]?.wire).toBe(true) })
  expect(f.budgets[1]!.release).not.toHaveBeenCalled()
  f.attempts[1]!.finish(); await nested?.joined
})

it.each(['return', 'throw'] as const)('joins actual I/O after callback %s even when withResponse was not awaited', async (mode) => {
  const f = await fixture(); await f.start()
  const callback = Promise.withResolvers<undefined>(), failure = new Error('original callback failure')
  const read = observed(f.borrow(async (service) => {
    void service.withResponse(request, responseLimits, new AbortController().signal, idle)
    await callback.promise
    if (mode === 'throw') throw failure
  }))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  callback.resolve(undefined)
  await vi.waitFor(() => { expect(f.attempts[0]!.input.controller.signal.aborted).toBe(true) })
  expect(read.state.settled).toBe(false); expect(f.budgets[0]!.release).not.toHaveBeenCalled()
  f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBeDefined()
  if (mode === 'throw') expect(read.state.cause).toBe(failure)
  expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1); expect(f.unknown.mock.calls.length).toBe(0)
})

it('includes HTTP terminal in ordinary service stop confirmation and keeps resident output until original scope release', async () => {
  const f = await fixture(), work = await f.start()
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  const stop = work.stop(new AbortController().signal); let stopped = false
  void stop.then(() => { stopped = true })
  expect(f.attempts[0]!.input.controller.signal.aborted).toBe(true)
  f.entries[0]!.channel.empty(); await f.operations[0]!.whenEmpty
  expect(stopped).toBe(false); expect(f.processReservations[0]!.active).not.toHaveBeenCalled()
  await expect(f.borrow(idle)).rejects.toThrow()
  f.attempts[0]!.finish(); await read.joined
  expect(await stop).toEqual({ confirmed: true })
  expect(f.processReservations[0]!.active).toHaveBeenCalledTimes(1)
  expect(f.processReservations[0]!.resident).not.toHaveBeenCalled()
  await expect(f.borrow(idle)).rejects.toThrow()
  work.lease.release()
  expect(f.processReservations[0]!.resident).toHaveBeenCalledTimes(1); expect(f.unknown.mock.calls.length).toBe(0)
})

it.each(['scope', 'process', 'provider'] as const)('cancels and retains original I/O through %s close and late terminal, including a prior retirement callback', async (mode) => {
  const f = await fixture(), work = await f.start()
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  const close = mode === 'provider' ? observed(f.owner.closeProvider()) : undefined
  if (mode === 'scope') work.lease.release()
  if (mode === 'provider') f.physical.resolve(undefined)
  f.entries[0]!.channel.empty(); await f.operations[0]!.whenEmpty
  await vi.waitFor(() => { expect(f.attempts[0]!.input.controller.signal.aborted).toBe(true) })
  expect(f.budgets[0]!.release).not.toHaveBeenCalled()
  expect(f.processReservations[0]!.active).not.toHaveBeenCalled(); expect(f.processReservations[0]!.resident).not.toHaveBeenCalled()
  if (close !== undefined) expect(close.state.settled).toBe(false)
  expect(() => f.factories[0]!.owner.retainRequest(f.attempts[0]!.input)).toThrow()
  f.attempts[0]!.finish(); await read.joined; await close?.joined
  await vi.waitFor(() => { expect(f.processReservations[0]!.active).toHaveBeenCalledTimes(1) })
  if (mode !== 'process') expect(f.processReservations[0]!.resident).toHaveBeenCalledTimes(1)
  else { expect(f.processReservations[0]!.resident).not.toHaveBeenCalled(); work.lease.release() }
})

it.each(['terminal', 'budget-release'] as const)('retains failed %s on the original row after process/physical close and reports the same operation unknown', async (mode) => {
  const f = await fixture(), work = await f.start()
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  const failure = new PreviewHttpError('cloud/stop-unconfirmed')
  if (mode === 'terminal') f.attempts[0]!.fail(failure)
  else { f.failRelease(failure); f.attempts[0]!.finish() }
  await read.joined
  expect(read.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.unknown.mock.calls.length).toBe(1)
  expect(f.unknown.mock.calls[0]![0]).toBe(work.lease.scope); expect(f.unknown.mock.calls[0]![1]).toBe(f.operations[0])
  if (mode === 'terminal') expect(f.budgets[0]!.release).not.toHaveBeenCalled()
  work.lease.release(); const closing = observed(f.owner.closeProvider())
  f.physical.resolve(undefined); f.entries[0]!.channel.empty(); await closing.joined
  expect(closing.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.processReservations[0]!.active).not.toHaveBeenCalled(); expect(f.processReservations[0]!.resident).not.toHaveBeenCalled()
  expect(f.unknown.mock.calls.length).toBe(1)
  await expect(f.borrow(idle)).rejects.toThrow()
})

it('does not install or release a request when original Root reserve refuses capacity', async () => {
  const f = await fixture(); await f.start(); f.failReserve(new PreviewHttpError('cloud/capacity'))
  await expect(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle))).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(f.budgets).toHaveLength(0); expect(f.attempts[0]!.wire).toBe(false)
  expect(f.unknown.mock.calls.length).toBe(0)
})

it('rejects a prepared bound service until its original submitted snapshot has been accepted', async () => {
  const f = await fixture({ holdCommit: true }), starting = f.start()
  await vi.waitFor(() => { expect(f.entries[0]?.registration).toBeDefined() })
  const registration = f.entries[0]!.registration!
  await expect(f.owner.withApplicationService({ sessionId: SessionId('A'), serviceId: registration.registrationId },
    new AbortController().signal, Date.now() + 10000, idle)).rejects.toThrow()
  expect(f.reserve.mock.calls.length).toBe(0); expect(f.transport.mock.calls.length).toBe(0)
  f.entries[0]!.channel.completeCommit(); await starting
})

it('captures the original selector and rejects late retained-hook use without adding a request or changing target', async () => {
  const f = await fixture(), work = await f.start(), selection = f.select(work), caller = new AbortController()
  const callback = Promise.withResolvers<undefined>()
  let captured: RegisteredApplicationService | undefined
  const borrow = observed(f.owner.withApplicationService(selection, caller.signal, Date.now() + 10000, async (service) => {
    captured = service; await callback.promise
    await service.withResponse(request, responseLimits, caller.signal, idle)
  }))
  selection.sessionId = SessionId('B'); captured!.assertCurrent(); callback.resolve(undefined)
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  expect(f.factories[0]!.identity.sessionId).toBe(SessionId('A'))
  f.attempts[0]!.finish(); await borrow.joined
  expect(() => f.factories[0]!.owner.retainRequest({ controller: new AbortController(), settled: Promise.resolve(), charge })).toThrow()
  expect(f.reserve).toHaveBeenCalledTimes(1)
})

it('joins every original I/O terminal when one request is already unknown, rather than returning on the first rejection', async () => {
  const f = await fixture(); await f.start()
  const first = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  const second = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts.filter(value => value.wire)).toHaveLength(2) })
  f.attempts[0]!.fail(new PreviewHttpError('cloud/stop-unconfirmed')); await first.joined
  const closing = observed(f.owner.closeProvider()); f.physical.resolve(undefined)
  await f.operations[0]!.whenEmpty
  expect(closing.state.settled).toBe(false)
  expect(f.attempts[1]!.input.controller.signal.aborted).toBe(true)
  expect(f.budgets[1]!.release).not.toHaveBeenCalled()
  f.attempts[1]!.finish(); await second.joined; await closing.joined
  expect(closing.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.budgets[0]!.release).not.toHaveBeenCalled(); expect(f.budgets[1]!.release).toHaveBeenCalledTimes(1)
  expect(f.processReservations[0]!.resident).not.toHaveBeenCalled()
})

it('still joins local I/O after Root physical stop rejects, and does not create a physical range receipt', async () => {
  const f = await fixture(); await f.start()
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[0]?.wire).toBe(true) })
  f.failPhysical(new Error('synthetic physical stop unknown'))
  const closing = observed(f.owner.closeProvider()); f.physical.resolve(undefined)
  await vi.waitFor(() => { expect(f.unknown.mock.calls.length).toBe(1) })
  expect(closing.state.settled).toBe(false); expect(f.budgets[0]!.release).not.toHaveBeenCalled()
  f.attempts[0]!.finish(); await read.joined; await closing.joined
  expect(closing.state.cause).toBeDefined(); expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1)
  expect(f.processReservations[0]!.active).not.toHaveBeenCalled(); expect(f.processReservations[0]!.resident).not.toHaveBeenCalled()
})

it('deducts delayed submitted observation from the original service role before reserving HTTP', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const f = await fixture({ holdCommit: true }), starting = f.start()
  await vi.waitFor(() => { expect(f.entries).toHaveLength(1) })
  now = 9900; f.entries[0]!.channel.completeCommit(); await starting
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[0]?.retained).toBeDefined() })
  expect(f.attempts[0]!.retained?.timeoutMs).toBe(100)
  f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBeUndefined()
  now = 10000
  await expect(f.borrow(idle)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.budgets).toHaveLength(1); expect(f.transport).toHaveBeenCalledTimes(1)
})

it('keeps a fixed monotonic ingress bound after a backward wall clock change during reservation', async () => {
  let now = 0, wall = Date.now()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(Date, 'now').mockImplementation(() => wall)
  const f = await fixture(); await f.start()
  const until = wall + 50
  f.onReserve(() => { now = 40; wall -= 60000 })
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle),
    new AbortController().signal, until))
  await vi.waitFor(() => { expect(f.attempts[0]?.retained).toBeDefined() })
  expect(f.attempts[0]!.retained?.timeoutMs).toBe(10)
  f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBeUndefined()
})

it('rechecks role expiry before wire while cancellation retains the same reservation until actual terminal join', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const f = await fixture(); await f.start(); f.holdWire()
  const caller = new AbortController()
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, caller.signal, idle),
    caller.signal, Date.now() + 30000))
  await vi.waitFor(() => { expect(f.attempts[0]?.retained).toBeDefined() })
  now = 10000
  expect(() => f.attempts[0]!.retained?.assertCurrent()).toThrow()
  caller.abort(new Error('original request cancelled')); f.attempts[0]!.wireGate.resolve(undefined)
  await vi.waitFor(() => { expect(f.attempts[0]!.input.controller.signal.aborted).toBe(true) })
  expect(f.attempts[0]!.wire).toBe(false); expect(read.state.settled).toBe(false)
  expect(f.budgets[0]!.release).not.toHaveBeenCalled()
  f.attempts[0]!.finish(); await read.joined
  expect(read.state.cause).toBeDefined(); expect(f.budgets[0]!.release).toHaveBeenCalledTimes(1)
  expect(f.unknown).not.toHaveBeenCalled()
})

it('keeps allocation preparation inside the original controller lifetime when the service role started later', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const f = await fixture(), acquire = f.acquire.getMockImplementation()
  if (acquire === undefined) throw new Error('Expected original fixture allocation collaborator')
  f.acquire.mockImplementation((...args) => { now = 17000; return acquire(...args) })
  await f.start(); now = 18500
  const read = observed(f.borrow(service => service.withResponse(request, responseLimits, new AbortController().signal, idle)))
  await vi.waitFor(() => { expect(f.attempts[0]?.retained).toBeDefined() })
  expect(f.attempts[0]!.retained?.timeoutMs).toBe(1500)
  f.attempts[0]!.finish(); await read.joined
  now = 20000
  await expect(f.borrow(idle)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.budgets).toHaveLength(1); expect(f.unknown).not.toHaveBeenCalled()
})
