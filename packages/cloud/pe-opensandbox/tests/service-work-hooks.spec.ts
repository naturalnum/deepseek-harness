/** Original work rows/controllers over synthetic transport; no target process or resource qualification. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { DevelopmentServiceId, ServicePreviewIdentity } from '@deepseek-ai/dsh-pe-opensandbox/types'
import { NativeCommandAccount, type NativeRegisteredService, type NativeCommandRoot } from '../src/native-command-account.ts'
import { CloudSubprocessRuntime } from '../src/native-providers.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import { registerDevServiceConsumer, type DevServiceProfile } from '../src/dev-service-consumer.ts'
import { ExecutionStateError } from '../src/errors.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const prepared = (): CommandSnapshot => ({ prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
  physicalStopRequired: false, providerFailure: false, direct: undefined,
  stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } })
const live = (): CommandSnapshot => ({ ...prepared(), submitted: true })
const exited = (empty = true): CommandSnapshot => ({ ...live(), direct: { exitCode: 0, signal: null }, rangeEmpty: empty, ioClosed: empty,
  stdout: { bytes: Buffer.from('hello'), observedBytes: 5, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })

function channel() {
  const prepareGate = Promise.withResolvers<CommandSnapshot>(), commitGate = Promise.withResolvers<CommandSnapshot>()
  const polls: ReturnType<typeof Promise.withResolvers<CommandSnapshot>>[] = []
  let current = live(), holdPrepare = false, holdCommit = false, committed = false, descendants = false, commitFailure: Error | undefined
  const value = {
    prepare: vi.fn((_spec: Parameters<CommandChannel['prepare']>[0]) => holdPrepare ? prepareGate.promise : Promise.resolve(prepared())),
    commit: vi.fn(() => {
      committed = true
      return commitFailure !== undefined ? Promise.reject(commitFailure) : holdCommit ? commitGate.promise : Promise.resolve(current)
    }),
    poll: vi.fn(() => {
      if (current.rangeEmpty) return Promise.resolve(current)
      const pending = Promise.withResolvers<CommandSnapshot>(); polls.push(pending); return pending.promise
    }),
    stop: vi.fn(() => {
      current = committed ? exited(!descendants) : { ...prepared(), commitClosed: true, rangeEmpty: true, ioClosed: true,
        stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }
      return Promise.resolve(current)
    }),
  }
  return { value, prepareGate, commitGate,
    holdPrepare: () => { holdPrepare = true }, holdCommit: () => { holdCommit = true },
    holdDescendants: () => { descendants = true },
    commitExit: () => { current = exited() }, failCommit: () => { commitFailure = new Error('fixture lost original reply') },
    advance(snapshot = current) { current = snapshot; for (const pending of polls.splice(0)) pending.resolve(snapshot) },
    finish() {
      current = exited(); prepareGate.resolve(prepared()); commitGate.resolve(current)
      for (const pending of polls.splice(0)) pending.resolve(current)
    } }
}

type Result = Awaited<ReturnType<ToolRuntime['execute']>>
function reply(result: Result) {
  expect(result.isError).toBe(false)
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected service result')
  return value
}
async function fixture(next: () => ReturnType<typeof channel> = channel) {
  const ctx = new Context(), generation = new AbortController(); contexts.push(ctx)
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('service-component'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'component-only', lifetime: generation.signal }
  ctx.provide('peAccount', binding); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const ids = [SessionId('A'), SessionId('B')]
  const workspace: Workspace = { id: brandString<Workspace['id']>('shared-project'), path: '/native/projects/original', sessionIds: ids,
    title: 'component', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
    setTitle: () => Promise.resolve(), attachSession: () => Promise.resolve(), detachSession: () => Promise.resolve(),
    insertSessionBefore: () => Promise.resolve(), status: () => Promise.resolve('ok') }
  const agents = new Map<SessionId, Agent>()
  for (const id of ids) {
    const agent = { id, ctx, session: Session.create(id) } as Agent
    await ctx.plugin(Object.assign((inner: Context) => { Object.assign(agent, { ctx: inner }) }, { inject: ['tools', 'systemPrompt'] }))
    agents.set(id, agent)
  }
  const profile: DevServiceProfile = { kind: 'python-http-v1', port: 8000, startWaitMs: 2000, runMs: 1000,
    stopWaitMs: 1000, maxLogReadBytes: 32, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 4, maxArgBytes: 128, maxArgsBytes: 256 }
  const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 32,
    maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 4, maxLifetimeMs: 3000, stopWaitMs: 100 }
  const reservations: { active: ReturnType<typeof vi.fn>; resident: ReturnType<typeof vi.fn> }[] = []
  const entries: { entry: ReturnType<typeof channel>; registration?: NativeRegisteredService }[] = []
  const unknown = vi.fn(), physical = Promise.withResolvers<undefined>()
  let failReserve = false, count = 0
  const owner = new NativeCommandAccount(ctx, binding, { assertBusinessCurrent() {}, getAgent: id => agents.get(id),
    projectForAgent: () => workspace, projectForSession: () => workspace, files() { throw new Error('not used') } },
  { allowedTools: ['bash', 'dev_service'], maxScopes: 32, commandLimits: limits,
    services: { profile, operationLimits: limits, assertQualified(value) { expect(value).toBe(profile) },
      serviceSpec(scope, _profile, start) { return { argv: ['/opt/session-env/venv/bin/python', '-B', scope.project.path + '/' + start.script, ...start.args], cwd: scope.project.path,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } }, graceMs: 50, signal: scope.lifetime } } } },
  { reserve: vi.fn(() => {
    if (failReserve) throw new Error('fixture capacity refusal')
    const record = { active: vi.fn(), resident: vi.fn() }; reservations.push(record)
    return { releaseActive: record.active, releaseResident: record.resident }
  }), acquire: vi.fn<NativeCommandRoot['acquire']>(async (scope, _signal, registration) => {
    if (scope.purpose === 'service') { expect(registration?.scope).toBe(scope); registration?.assertCurrent() }
    else expect(registration).toBeUndefined()
    const entry = next(); entries.push({ entry, ...(registration === undefined ? {} : { registration }) }); return entry.value
  }), unknown, close: async () => { await physical.promise; for (const item of entries) item.entry.finish() } })
  const runtime = new CloudSubprocessRuntime(ctx, owner)
  registerDevServiceConsumer(ctx, owner.calls, runtime, owner, profile)
  ctx.tools.register(defineTool({ name: 'bash', description: 'foreground fixture', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, async execute(_args, exec) {
      const process = runtime.spawn({ argv: ['/usr/bin/true'], cwd: workspace.path,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } }, graceMs: 50, signal: exec.signal })
      const outcome = await process.done; return { exitCode: outcome.exitCode }
    } }))
  cleanups.push(async () => { physical.resolve(undefined); for (const item of entries) item.entry.finish(); await owner.closeProvider() })
  const rawCall = (args: unknown, signal = new AbortController().signal, id = ids[0]!) => ctx.tools.execute({ callId: ToolCallId(`call-${++count}`),
    name: 'dev_service', arguments: args, agent: agents.get(id)!, signal })
  const call = (args: { action: string; [key: string]: unknown }, signal?: AbortSignal, id?: SessionId) =>
    rawCall(args.action === 'start' ? { script: 'hello.py', ...args } : args, signal, id)
  return { ctx, owner, runtime, profile, binding, workspace, agents, entries, reservations, unknown, physical, call, rawCall,
    failReserve: () => { failReserve = true },
    bash: () => ctx.tools.execute({ callId: ToolCallId(`bash-${++count}`), name: 'bash', arguments: {},
      agent: agents.get(ids[0]!)!, signal: new AbortController().signal }) }
}

it('reserves once before public spawn, carries true registration, permits one foreground beside service, and recovers missing start handle', async () => {
  const f = await fixture(), started = reply(await f.call({ action: 'start' }))
  const id = started.serviceHandle; expect(typeof id).toBe('string'); expect(f.reservations).toHaveLength(1)
  const registration = f.entries[0]!.registration; expect(registration).toBeDefined()
  expect(registration!.registrationId).toBe(id)
  const identity: ServicePreviewIdentity = registration!.projectIdentity(brandString<ServicePreviewIdentity['allocationId']>('allocation-component'))
  const branded: DevelopmentServiceId = identity.serviceId; expect(branded).toBe(id)
  expect(reply(await f.call({ action: 'status' })).serviceHandle).toBe(id)
  expect((await f.call({ action: 'status' }, undefined, SessionId('B'))).isError).toBe(true)
  const bash = f.bash(); await vi.waitFor(() =>{  expect(f.entries).toHaveLength(2) })
  expect(f.entries[1]!.registration).toBeUndefined(); f.entries[1]!.entry.finish(); expect((await bash).isError).toBe(false)
  expect(f.reservations[0]!.active).not.toHaveBeenCalled()
  const stop = f.call({ action: 'stop', serviceHandle: id }); f.entries[0]!.entry.advance()
  expect(reply(await stop).observation).toEqual({ confirmed: true })
  expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1)
  expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
  expect(reply(await f.call({ action: 'log', serviceHandle: id, stream: 'stdout', fromByte: 0 })).observation)
    .toEqual({ text: 'hello', nextOffset: 5, lossy: false })
  const second = reply(await f.call({ action: 'start' })); expect(second.serviceHandle).not.toBe(id)
  expect((await f.call({ action: 'status' })).isError).toBe(true)
})

it('same commit snapshot direct exit/EOF is consumed before submitted observation, never reported as running or HTTP-ready', async () => {
  const f = await fixture(() => { const entry = channel(); entry.commitExit(); return entry })
  const value = reply(await f.call({ action: 'start' }))
  expect(value.observation).toMatchObject({ phase: 'process-submitted', processSubmitted: true, httpReady: false, direct: 'exited', exitCode: 0 })
  expect(JSON.stringify(value)).not.toContain('running')
})

it('projects only final bounded task fields into native metadata while canonical value has no infrastructure identity', async () => {
  const f = await fixture(), result = await f.call({ action: 'start' })
  const value = reply(result)
  expect(result.meta).toEqual({ kind: 'cloud-dev-service-v1', serviceHandle: value.serviceHandle, action: 'start', processSubmitted: true })
  expect(JSON.stringify(result)).not.toMatch(/allocationId|accountId|connectionGeneration|epoch|https?:/)
  expect((await f.call({ action: 'status' })).meta).toEqual({ kind: 'cloud-dev-service-v1', serviceHandle: value.serviceHandle,
    action: 'status', processSubmitted: true })
})

it('derives metadata from a legal final policy value, and suppresses blocked or invalid replacements', async () => {
  const f = await fixture(); let replacement: ToolExecutionSuccess['value'] | undefined
  f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
    if (replacement === 'block') return { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    if (replacement !== undefined) return { kind: 'accept', value: replacement }
    return next()
  })
  const original = reply(await f.call({ action: 'start' }))
  const handle = original.serviceHandle
  if (typeof handle !== 'string') throw new Error('Expected the original service handle')
  const legal = { action: 'status', serviceHandle: handle, observation: { serviceId: handle,
    processSubmitted: true, httpReady: false, direct: 'pending', range: 'pending' } }
  replacement = legal
  expect((await f.call({ action: 'status' })).meta).toMatchObject({ action: 'status', serviceHandle: original.serviceHandle })
  for (const value of ['wrong', { action: 'start', serviceHandle: handle },
    { ...legal, serviceHandle: 'x'.repeat(65) },
    { ...legal, action: 'log' },
    { ...legal, observation: { processSubmitted: true, httpReady: true } },
    { ...legal, allocationId: 'must-not-publish' }]) {
    replacement = value
    expect((await f.call({ action: 'status' })).meta).toBeNull()
  }
  replacement = { ...legal, serviceHandle: 'different-handle', observation: { ...legal.observation, serviceId: 'different-handle' } }
  expect((await f.call({ action: 'status', serviceHandle: original.serviceHandle })).meta).toBeNull()
  replacement = 'block'; const blocked = await f.call({ action: 'status' })
  expect(blocked.isError).toBe(true); expect(blocked.meta).toBeUndefined()
})

it('publishes no preview metadata for already exited, failed, log, stop or uncertain outcomes', async () => {
  const ended = await fixture(() => { const entry = channel(); entry.commitExit(); return entry })
  expect((await ended.call({ action: 'start' })).meta).toBeNull()
  const f = await fixture(), start = reply(await f.call({ action: 'start' }))
  expect((await f.call({ action: 'log', serviceHandle: start.serviceHandle, stream: 'stdout', fromByte: 0 })).meta).toBeNull()
  const stopping = f.call({ action: 'stop', serviceHandle: start.serviceHandle })
  await vi.waitFor(() => {
    if (f.entries[0]!.entry.value.stop.mock.calls.length === 0) f.entries[0]!.entry.advance(live())
    expect(f.entries[0]!.entry.value.stop).toHaveBeenCalledTimes(1)
  })
  expect((await stopping).meta).toBeNull()
  const failed = await fixture(() => { const entry = channel(); entry.failCommit(); return entry })
  const result = await failed.call({ action: 'start' }); expect(result.isError).toBe(true); expect(result.meta).toBeUndefined()
})

it('caller cancellation after snapshot-confirmed submission leaves service lifetime and original registration active', async () => {
  const f = await fixture(), caller = new AbortController()
  const value = reply(await f.call({ action: 'start' }, caller.signal)); caller.abort(new Error('start caller left'))
  f.entries[0]!.registration!.assertCurrent()
  expect(reply(await f.call({ action: 'status', serviceHandle: value.serviceHandle })).observation).toMatchObject({ processSubmitted: true })
  expect(f.entries[0]!.entry.value.stop).not.toHaveBeenCalled()
})

it('startup abort before submitted keeps the same attached/late row until actual range settlement', async () => {
  const f = await fixture(() => { const entry = channel(); entry.holdPrepare(); return entry }), caller = new AbortController()
  const start = f.call({ action: 'start' }, caller.signal)
  await vi.waitFor(() =>{  expect(f.entries[0]?.entry.value.prepare).toHaveBeenCalledTimes(1) })
  caller.abort(new Error('startup cancelled')); const cancelled = await start
  expect(cancelled.isError).toBe(true); expect(cancelled.meta).toBeUndefined()
  expect(f.reservations).toHaveLength(1); expect(f.reservations[0]!.active).not.toHaveBeenCalled()
  expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
  f.entries[0]!.entry.prepareGate.resolve(prepared())
  await vi.waitFor(() =>{  expect(f.reservations[0]!.resident).toHaveBeenCalledTimes(1) })
  expect(f.entries[0]!.entry.value.commit).not.toHaveBeenCalled()
  expect(f.entries[0]!.entry.value.stop).toHaveBeenCalledTimes(1)
  expect(f.unknown).not.toHaveBeenCalled()
})

it('lost commit reply retains unknown role capacity; epoch close joins original physical work before resident release', async () => {
  const f = await fixture(() => { const entry = channel(); entry.failCommit(); return entry })
  expect((await f.call({ action: 'start' })).isError).toBe(true)
  expect(f.unknown).toHaveBeenCalledTimes(1); expect(f.reservations[0]!.active).not.toHaveBeenCalled()
  expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
  expect((await f.call({ action: 'start' })).isError).toBe(true); expect(f.reservations).toHaveLength(1)
  expect((await f.bash()).isError).toBe(true); expect(f.reservations).toHaveLength(1)
  const closed = f.owner.closeProvider(); let settled = false; void closed.then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false); expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
  f.physical.resolve(undefined); await closed; expect(f.reservations[0]!.resident).toHaveBeenCalledTimes(1)
})

it('synchronous publication failure leaves the attached operation on its original row until cancelled local settlement', async () => {
  const f = await fixture()
  const create = f.owner.create.bind(f.owner)
  vi.spyOn(f.owner, 'create').mockImplementation((caller, spec) => {
    const operation = create(caller, spec)
    vi.spyOn(operation, 'publish').mockImplementation(() => { throw new ExecutionStateError('cloud/execution-unavailable', 'Service startup was interrupted.') })
    return operation
  })
  expect((await f.call({ action: 'start' })).isError).toBe(true)
  expect(f.reservations).toHaveLength(1); expect(f.entries).toHaveLength(0)
  await vi.waitFor(() =>{  expect(f.reservations[0]!.resident).toHaveBeenCalledTimes(1) })
  expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1)
})

it('ordinary stop remains pending after direct exit and EOF until the same original descendants/I/O range is empty', async () => {
  const f = await fixture(() => { const entry = channel(); entry.holdDescendants(); return entry })
  const start = reply(await f.call({ action: 'start' }))
  const stopped = f.call({ action: 'stop', serviceHandle: start.serviceHandle })
  let settled = false; void stopped.then(() => { settled = true })
  await vi.waitFor(() => {
    if (f.entries[0]!.entry.value.stop.mock.calls.length === 0) f.entries[0]!.entry.advance(live())
    expect(f.entries[0]!.entry.value.stop).toHaveBeenCalledTimes(1)
  })
  expect(settled).toBe(false); expect(f.reservations[0]!.active).not.toHaveBeenCalled()
  f.entries[0]!.entry.advance(exited(true))
  expect(reply(await stopped).observation).toEqual({ confirmed: true })
  expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1); expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
})

it('a preparing lease row is included in closeProvider and releases its zero-process reservation without any acquire', async () => {
  const f = await fixture(); let closing: Promise<void> | undefined
  const prepare = f.owner.prepareStart.bind(f.owner)
  vi.spyOn(f.owner, 'prepareStart').mockImplementation((...args) => {
    prepare(...args)
    closing = f.owner.closeProvider()
  })
  expect((await f.call({ action: 'start' })).isError).toBe(true)
  expect(f.entries).toHaveLength(0); expect(f.reservations).toHaveLength(1)
  expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1); expect(f.reservations[0]!.resident).toHaveBeenCalledTimes(1)
  expect(closing).toBeDefined(); f.physical.resolve(undefined); await closing
})

it('constructor refusal before operation binding releases only its original preparing row and never acquires remotely', async () => {
  const f = await fixture(), spec = f.owner.serviceSpec.bind(f.owner)
  vi.spyOn(f.owner, 'serviceSpec').mockImplementation((scope, profile, start) => {
    const value = spec(scope, profile, start)
    return { ...value, stdio: { ...value.stdio, stdout: 'pipe' } }
  })
  expect((await f.call({ action: 'start' })).isError).toBe(true)
  expect(f.entries).toHaveLength(0); expect(f.reservations).toHaveLength(1)
  expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1); expect(f.reservations[0]!.resident).toHaveBeenCalledTimes(1)
})

it('resolves a project Python script with literal args under the original project and defaults omitted args explicitly to empty', async () => {
  const f = await fixture(), resolve = vi.spyOn(f.owner, 'serviceSpec')
  const literals = ['$(literal)', 'semi;colon', 'space value', 'line\nbreak']
  reply(await f.rawCall({ action: 'start', script: 'web/server.py', args: literals }))
  expect(resolve.mock.calls[0]![2]).toEqual({ script: 'web/server.py', args: literals })
  expect(f.entries[0]!.entry.value.prepare.mock.calls[0]![0]).toMatchObject({
    argv: ['/opt/session-env/venv/bin/python', '-B', '/native/projects/original/web/server.py', ...literals],
    cwd: '/native/projects/original', stdin: { mode: 'ignore' },
  })
  const other = await fixture(), otherResolve = vi.spyOn(other.owner, 'serviceSpec')
  reply(await other.rawCall({ action: 'start', script: 'server.py' }))
  expect(otherResolve.mock.calls[0]![2]).toEqual({ script: 'server.py', args: [] })
})

function observeAttached(owner: NativeCommandAccount): () => ReturnType<NativeCommandAccount['attachOriginal']> {
  const cell: { work?: ReturnType<NativeCommandAccount['attachOriginal']> } = {}
  const attach = owner.attachOriginal.bind(owner)
  vi.spyOn(owner, 'attachOriginal').mockImplementation((...args) => {
    const work = attach(...args); cell.work = work; return work
  })
  return () => {
    if (cell.work === undefined) throw new Error('The original service handle has not been attached.')
    return cell.work
  }
}

it('keeps the private preview identity absent until the exact original registration binds its allocation once', async () => {
  const f = await fixture(), attached = observeAttached(f.owner)
  const start = reply(await f.call({ action: 'start' }))
  const work = attached()
  expect(work.previewIdentity()).toBeUndefined()
  const registration = f.entries[0]!.registration!
  const allocationId = brandString<ServicePreviewIdentity['allocationId']>('actual-root-selected-allocation')
  registration.bindAllocation(allocationId)
  registration.bindAllocation(allocationId)
  expect(work.previewIdentity()).toEqual({ accountId: f.binding.accountId, epoch: f.binding.epoch,
    sessionId: f.agents.values().next().value!.id, allocationId, serviceId: start.serviceHandle })
  expect(Object.isFrozen(work.previewIdentity())).toBe(true)
  expect(() => { registration.bindAllocation(brandString<ServicePreviewIdentity['allocationId']>('replacement')) }).toThrow(ExecutionStateError)
  expect(work.previewIdentity()!.allocationId).toBe(allocationId)
  expect(JSON.stringify(start)).not.toContain(allocationId)
  expect(JSON.stringify(start)).not.toContain('accountId')
})

it('refuses a first allocation binding after original service stop and preserves absence of identity', async () => {
  const f = await fixture(), attached = observeAttached(f.owner)
  const start = reply(await f.call({ action: 'start' }))
  const stopping = f.call({ action: 'stop', serviceHandle: start.serviceHandle })
  await vi.waitFor(() => {
    if (f.entries[0]!.entry.value.stop.mock.calls.length === 0) f.entries[0]!.entry.advance(live())
    expect(f.entries[0]!.entry.value.stop).toHaveBeenCalledTimes(1)
  })
  reply(await stopping)
  const registration = f.entries[0]!.registration!
  expect(() => { registration.bindAllocation(brandString<ServicePreviewIdentity['allocationId']>('too-late')) }).toThrow(ExecutionStateError)
  expect(attached().previewIdentity()).toBeUndefined()
})

it.each([
  { action: 'start' },
  { action: 'start', script: '/tmp/server.py' },
  { action: 'start', script: '../server.py' },
  { action: 'start', script: 'web/../server.py' },
  { action: 'start', script: './server.py' },
  { action: 'start', script: 'web//server.py' },
  { action: 'start', script: 'web\\server.py' },
  { action: 'start', script: 'server.py\0' },
  { action: 'start', script: 'server.txt' },
  { action: 'start', script: '\ud800.py' },
  { action: 'start', script: 'x'.repeat(254) + '.py' },
  { action: 'start', script: 'server.py', args: 'literal' },
  { action: 'start', script: 'server.py', args: [5] },
  { action: 'start', script: 'server.py', args: ['\0'] },
  { action: 'start', script: 'server.py', args: ['\ud800'] },
  { action: 'start', script: 'server.py', args: ['1', '2', '3', '4', '5'] },
  { action: 'start', script: 'server.py', args: ['x'.repeat(129)] },
  { action: 'start', script: 'server.py', args: ['x'.repeat(128), 'x'.repeat(128)] },
  { action: 'start', script: 'server.py', port: 9000 },
  { action: 'start', script: 'server.py', env: { PATH: '/host' } },
  { action: 'start', script: 'server.py', argv: ['/host/python'] },
])('rejects invalid start input before retaining scope, reservation, or remote work: %j', async (input) => {
  const f = await fixture(), retain = vi.spyOn(f.owner.calls, 'retainService'), resolve = vi.spyOn(f.owner, 'serviceSpec')
  expect((await f.rawCall(input)).isError).toBe(true)
  expect(retain).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled()
  expect(f.reservations).toHaveLength(0); expect(f.entries).toHaveLength(0)
})
