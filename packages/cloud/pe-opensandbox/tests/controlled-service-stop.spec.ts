/** Real native rows, Registry, DataClient and Python snapshots over a synthetic kernel and transport; no Linux qualification. */
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AllocationCreateIntent } from '../src/allocation-types.ts'
import type { AgentSelection } from '../src/lifecycle-types.ts'
import { NativeCommandAccount } from '../src/native-command-account.ts'
import { CloudSubprocessRuntime } from '../src/native-providers.ts'
import type { ManagedCommandOperation } from '../src/command-operation.ts'
import { registerDevServiceConsumer, type DevServiceProfile } from '../src/dev-service-consumer.ts'
import { TrustedRuntimeRegistry } from '../src/trusted-runtime.ts'
import { DataClient } from '../src/agent-data/client-internal.ts'
import { AGENT_SOURCE_SHA256, BWRAP_SHA256, PROTOCOL, SLICE_LIMITS, expectedWorldHash, asciiJSON } from '../src/agent-data/index.ts'
import type { ClientOptions, OperationRef } from '../src/agent-data/types.ts'
import type { OwnedTransport, WireEvents, WireRequest } from '../src/agent-data/transport.ts'

type Kind = 'controlled' | 'uncontrolled' | 'namespace-gap' | 'eof-gap' | 'fault' | 'fd-close' | 'selector-close'
type Phase = 'prepared' | 'live' | 'stopping' | 'afterDrain' | 'terminal'
type Trace = Record<Phase | 'foreground', Record<string, unknown>> & { proof: { result: Record<string, unknown>; signals: number[][]; foregroundReleased: boolean } }
const traces = JSON.parse(execFileSync('python3', ['-B', fileURLToPath(new URL('./test_controlled_stop.py', import.meta.url)), '--vectors'],
  { encoding: 'utf8', env: process.env, timeout: 10000, maxBuffer: 262144 })) as Record<Kind, Trace>
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

function selection(): AgentSelection {
  const intent: AllocationCreateIntent = { allocationId: brandString<AllocationCreateIntent['allocationId']>('allocation-1'),
    accountId: brandString<AllocationCreateIntent['accountId']>('account-1'), epoch: brandString<AllocationCreateIntent['epoch']>('1'),
    sessionId: brandString<AllocationCreateIntent['sessionId']>('session-1'), workspaceId: brandString<AllocationCreateIntent['workspaceId']>('workspace-1'),
    environmentVersion: 'env-v1', provider: 'unit', projectMountVersion: 'mount-v1',
    requestedAt: new Date().toISOString(), createDeadlineAt: new Date(Date.now() + 10000).toISOString() }
  const quota = { device: '5', mountId: '10', maximumBytes: '8388608', maximumInodes: '128' }
  return { intent, sandboxId: 'sandbox-1', payloadSha256: AGENT_SOURCE_SHA256, imageDigest: `sha256:${'1'.repeat(64)}`,
    deploymentIdentity: 'selected-deployment', mount: { assertCurrent() {},
      exports: { project: '/export/project', protectedProject: '/export/project/.pe', environment: '/export/env' },
      grant: { binding: { accountId: intent.accountId, epoch: intent.epoch, recipeVersion: 'v1', lifetime: new AbortController().signal },
        sessionId: intent.sessionId, workspaceId: intent.workspaceId,
        project: { rootPath: '/project', rootDevice: '5', rootInode: '11', rootMountId: '10', quota,
          mountVersion: 'mount-v1', readOnlyPaths: ['.pe'], metadataDirectory: {
            relativePath: '.pe', device: '5', inode: '13', mountId: '10', uid: 2000, gid: 2000, mode: 0o40700 } },
        environment: { rootPath: '/bank/env', rootDevice: '6', rootInode: '12', rootMountId: '20',
          quota: { ...quota, device: '6', mountId: '20' }, targetPath: '/opt/session-env', bankId: 'bank', slotId: 'slot',
          slotGeneration: 1, environmentVersion: 'env-v1', rootReadOnly: true, writablePaths: ['home', 'venv', 'tmp'],
          layout: { home: { device: '6', inode: '14', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 },
            venv: { device: '6', inode: '15', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 },
            tmp: { device: '6', inode: '16', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 } } } } } }
}


interface Sent { route: WireRequest['route']; body: OperationRef }
interface Pending { body: OperationRef; events: WireEvents }
class SyntheticTransport implements OwnedTransport {
  readonly requests: Sent[] = []
  readonly pending = new Set<Pending>()
  heldEnd: WireEvents | undefined
  closed = false
  constructor(readonly options: ClientOptions, readonly trace: Trace) {}
  dispatch(request: WireRequest, events: WireEvents): void {
    const body = JSON.parse(Buffer.from(request.body).toString('ascii')) as OperationRef
    this.requests.push({ route: request.route, body })
    const pending = { body, events }
    events.start(() => { this.pending.delete(pending); events.error() })
    if (request.route === '/handshake') {
      const e = this.options.expected
      const mount = (root: typeof e.roots.project) => ({ device: root.device, inode: root.inode, uid: 2000, gid: 2000,
        capacityBytes: root.maximumBytes, capacityInodes: root.maximumInodes,
        grant: { maximumBytes: root.maximumBytes, maximumInodes: root.maximumInodes } })
      this.reply(events, { protocolVersion: PROTOCOL, runtimeIdentity: e.runtimeIdentity, capabilities: ['argv', 'stdin-ignore', 'stdin-batch', 'collect'],
        pins: e.pins, declaredImageId: e.declaredImageId, mounts: { '/project': mount(e.roots.project), '/opt/session-env': mount(e.roots.environment) },
        limits: SLICE_LIMITS, newOperationsAccepted: true, recordCount: 0, activeRangeCount: 0, rangeRoles: { foreground: 0, service: 0 },
        sealed: false, sealReason: null, physicalStopRequired: false })
    } else if (request.route === '/prepare') this.snapshot(pending, 'prepared')
    else if (request.route === '/commit') this.snapshot(pending, 'live')
    else if (request.route === '/stop') this.snapshot(pending, 'stopping')
    else if (request.route === '/poll') this.pending.add(pending)
    else throw new Error('Unexpected synthetic request')
  }
  snapshot(pending: Pending, phase: Phase, holdEnd = false): void {
    const { body, events } = pending
    // Bind only identity fields to the actual Root-issued reference. All completion/failure/stream facts are Python Manager output.
    const operation = { ...this.trace[phase], operationId: body.operationId, specHash: body.specHash,
      role: body.authorization.role, registrationId: body.authorization.registrationId }
    this.reply(events, { protocolVersion: PROTOCOL, runtimeIdentity: this.options.expected.runtimeIdentity, operation }, holdEnd)
  }
  reply(events: WireEvents, value: unknown, holdEnd = false): void {
    const bytes = Buffer.from(asciiJSON(value), 'ascii')
    events.headers(200, { 'content-length': String(bytes.length), 'content-type': 'application/json', connection: 'close' })
    events.data(bytes)
    if (holdEnd) this.heldEnd = events
    else events.end({})
  }
  advanceService(phase: Phase, holdEnd = false): void {
    for (const row of this.pending) if (row.body.authorization.role === 'service') {
      this.pending.delete(row); this.snapshot(row, phase, holdEnd)
    }
  }
  endService(): void { const held = this.heldEnd; this.heldEnd = undefined; if (held === undefined) throw new Error('No held response end'); held.end({}) }
  close(): Promise<void> { this.closed = true; return Promise.resolve() }
  destroy(): Promise<void> { this.closed = true; return Promise.resolve() }
}

type Result = Awaited<ReturnType<ToolRuntime['execute']>>
function reply(result: Result) {
  expect(result.isError).toBe(false)
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected service result')
  return value
}
async function fixture(kind: Kind) {
  const ctx = new Context(), selected = selection(), binding = selected.mount.grant.binding
  const id = selected.intent.sessionId
  ctx.provide('peAccount', binding); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const workspace: Workspace = { id: selected.intent.workspaceId, path: '/project', sessionIds: [id], title: 'component',
    createdAt: selected.intent.requestedAt, updatedAt: selected.intent.requestedAt,
    setTitle: async () => {}, attachSession: async () => {}, detachSession: async () => {}, insertSessionBefore: async () => {}, status: async () => 'ok' }
  const agent = { id, ctx, session: Session.create(id) } as Agent
  await ctx.plugin(Object.assign((inner: Context) => { Object.assign(agent, { ctx: inner }) }, { inject: ['tools', 'systemPrompt'] }))
  const options: ClientOptions = { host: '172.20.0.2', port: 39001, token: '3'.repeat(64), expected: {
    physicalSandboxId: selected.sandboxId, runtimeIdentity: '2'.repeat(64), projectRoot: '/project', declaredImageId: selected.imageDigest,
    pins: { agentSourceSha256: AGENT_SOURCE_SHA256, bwrapSha256: BWRAP_SHA256, userWorldArgvSha256: expectedWorldHash('/project') },
    roots: { project: { device: '5', inode: '11', maximumBytes: '8388608', maximumInodes: '128' },
      environment: { device: '6', inode: '12', maximumBytes: '8388608', maximumInodes: '128' } } } }
  const transport = new SyntheticTransport(options, traces[kind]), client = new DataClient(options, transport)
  const registry = new TrustedRuntimeRegistry({ bootstrap: async () => options,
    fence: () => ({ whenJoined: Promise.resolve(), assertDeploymentCurrent() {} }) }, 1, () => client)
  const signal = new AbortController().signal
  const prepared = registry.bindPrepared({ ...await registry.handshake(selected, signal) })
  const profile: DevServiceProfile = { kind: 'python-http-v1', port: 8000, startWaitMs: 2000, runMs: 1000,
    stopWaitMs: 1000, maxLogReadBytes: 32, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 4, maxArgBytes: 128, maxArgsBytes: 256 }
  const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 32,
    maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 4, maxLifetimeMs: 5000, stopWaitMs: 1000 }
  const reservations: { role: string; active: ReturnType<typeof vi.fn>; resident: ReturnType<typeof vi.fn> }[] = []
  const physical = Promise.withResolvers<undefined>()
  const physicalStop = vi.fn(async () => {
    const joining = registry.fenceRequests(selected, undefined, signal)
    await physical.promise
    registry.acknowledgePhysicalStop(selected, undefined)
    await joining.whenJoined
  })
  const unknown = vi.fn(() => { void owner.closeProvider() })
  const owner = new NativeCommandAccount(ctx, binding, { assertBusinessCurrent() {},
    getAgent: candidate => candidate === id ? agent : undefined,
    projectForAgent: () => workspace, projectForSession: () => workspace, files() { throw new Error('not used') } },
  { allowedTools: ['bash', 'dev_service'], maxScopes: 32, commandLimits: limits,
    services: { profile, operationLimits: limits, assertQualified(value) { expect(value).toBe(profile) },
      serviceSpec(scope, _profile, start) { return { argv: ['/opt/session-env/venv/bin/python', '-B', '/project/' + start.script, ...start.args], cwd: '/project',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } }, graceMs: 50, signal: scope.lifetime } } } },
  { reserve(scope) {
    const record = { role: scope.purpose, active: vi.fn(), resident: vi.fn() }; reservations.push(record)
    return { releaseActive: record.active, releaseResident: record.resident }
  }, async acquire(scope, _signal, registration) {
    if (scope.purpose === 'service') {
      if (registration === undefined) throw new Error('Missing original service registration')
      expect(registration.scope).toBe(scope)
      return registry.service(prepared, registration)
    }
    expect(registration).toBeUndefined(); return registry.command(prepared)
  }, unknown, close: physicalStop })
  const operations: ManagedCommandOperation[] = [], create = owner.create.bind(owner)
  vi.spyOn(owner, 'create').mockImplementation((...args) => { const op = create(...args); operations.push(op); return op })
  const runtime = new CloudSubprocessRuntime(ctx, owner)
  registerDevServiceConsumer(ctx, owner.calls, runtime, owner, profile)
  ctx.tools.register(defineTool({ name: 'bash', description: 'foreground fixture', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, async execute(_args, exec) {
      const process = runtime.spawn({ argv: ['/bin/synthetic-foreground'], cwd: '/project',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } }, graceMs: 50, signal: exec.signal })
      const outcome = await process.done; return { exitCode: outcome.exitCode }
    } }))
  let count = 0
  const call = (args: { action: string; [key: string]: unknown }) => ctx.tools.execute({ callId: ToolCallId(`service-${++count}`),
    name: 'dev_service', arguments: args.action === 'start' ? { script: 'hello.py', ...args } : args, agent, signal })
  const bash = () => ctx.tools.execute({ callId: ToolCallId(`bash-${++count}`), name: 'bash', arguments: {}, agent, signal })
  cleanups.push(async () => { physical.resolve(undefined); await owner.closeProvider(); await ctx.fiber.dispose() })
  return { owner, registry, prepared, transport, client, reservations, physical, physicalStop, unknown, operations, call, bash }
}

async function startAndStop(kind: Kind) {
  const f = await fixture(kind), started = reply(await f.call({ action: 'start' }))
  const foreground = f.bash(); let foregroundSettled = false
  void foreground.then(() => { foregroundSettled = true })
  await vi.waitFor(() => { expect(f.transport.pending.size).toBe(2) })
  const service = f.operations[0]!, front = f.operations[1]!
  const serviceDone = service.handle.done, frontDone = front.handle.done
  void serviceDone.catch(() => {}); void frontDone.catch(() => {})
  const stopping = f.call({ action: 'stop', serviceHandle: started.serviceHandle })
  f.transport.advanceService('live')
  await vi.waitFor(() => { expect(f.transport.requests.filter(r => r.route === '/stop')).toHaveLength(1) })
  await vi.waitFor(() => { expect(f.transport.pending.size).toBe(2) })
  expect(f.physicalStop).not.toHaveBeenCalled()
  for (const reservation of f.reservations) {
    expect(reservation.active).not.toHaveBeenCalled(); expect(reservation.resident).not.toHaveBeenCalled()
  }
  return { ...f, started, foreground, foregroundSettled: () => foregroundSettled, service, front, serviceDone, frontDone, stopping }
}

it('hard-stops the original service without DIRECT, retains the running foreground and only releases service active after actual local end', async () => {
  const f = await startAndStop('controlled')
  expect(traces.controlled.terminal).toMatchObject({ direct: null, directNotObserved: true, rangeEmpty: true, ioClosed: true })
  expect(traces.controlled.proof.signals).toEqual([[100, 9]])
  expect(traces.controlled.proof.foregroundReleased).toBe(false)
  f.transport.advanceService('terminal', true)
  expect(f.client.responsibility().inFlight).toBe(2)
  expect(f.reservations[0]!.active).not.toHaveBeenCalled()
  f.transport.endService()
  await vi.waitFor(() => { expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1) })
  expect(f.unknown.mock.calls.length, 'provider classification must not force Root unknown').toBe(0)
  expect(f.physicalStop.mock.calls.length).toBe(0)
  expect(reply(await f.stopping).observation).toEqual({ confirmed: true })
  await expect(f.serviceDone).rejects.toThrow('Service stop requested')
  await f.service.whenEmpty
  expect(f.unknown.mock.calls.length).toBe(0); expect(f.physicalStop.mock.calls.length).toBe(0)
  expect(f.foregroundSettled()).toBe(false)
  expect(f.reservations).toHaveLength(2)
  expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1)
  expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
  expect(f.reservations[1]!.active).not.toHaveBeenCalled(); expect(f.reservations[1]!.resident).not.toHaveBeenCalled()
  expect((await f.bash()).isError).toBe(true); expect(f.reservations).toHaveLength(2)
  const status = reply(await f.call({ action: 'status', serviceHandle: f.started.serviceHandle })).observation
  expect(status).toMatchObject({ direct: 'failed', range: 'empty' })
  expect(status).not.toHaveProperty('exitCode'); expect(status).not.toHaveProperty('signal')
  const prepared = f.transport.requests.filter(r => r.route === '/prepare'), stops = f.transport.requests.filter(r => r.route === '/stop')
  expect(stops[0]!.body.operationId).toBe(prepared[0]!.body.operationId)
  expect(prepared[0]!.body.authorization.role).toBe('service')
  expect(prepared[1]!.body.authorization.role).toBe('foreground')
  expect(prepared[0]!.body.operationId).not.toBe(prepared[1]!.body.operationId)
  expect(f.client.responsibility().remoteUnresolved.map(ref => ref.operationId)).toEqual([prepared[1]!.body.operationId])
  expect(f.transport.pending.size).toBe(1)
})

it.each<Kind>(['namespace-gap', 'eof-gap', 'fault', 'fd-close', 'selector-close', 'uncontrolled'])(
  'preserves unknown and requests whole allocation stop for %s; the Root unknown callback actually fences foreground', async (kind) => {
    const f = await startAndStop(kind)
    if (kind === 'namespace-gap' || kind === 'eof-gap') {
      f.transport.advanceService('afterDrain')
      await vi.waitFor(() => { expect(f.transport.pending.size).toBe(2) })
      expect(f.physicalStop).not.toHaveBeenCalled()
      expect(f.reservations[0]!.active).not.toHaveBeenCalled()
    }
    f.transport.advanceService('terminal')
    await vi.waitFor(() => { expect(f.physicalStop).toHaveBeenCalledTimes(1) })
    expect(f.unknown).toHaveBeenCalled()
    await expect(f.frontDone).rejects.toThrow()
    expect(() => f.registry.command(f.prepared)).toThrow('unconfirmed')
    expect(f.client.responsibility().fenced).toBe(true)
    expect(f.reservations[1]!.active).not.toHaveBeenCalled()
    expect(f.reservations[1]!.resident).not.toHaveBeenCalled()
    if (kind === 'namespace-gap' || kind === 'eof-gap' || kind === 'fd-close' || kind === 'selector-close') {
      expect(f.reservations[0]!.active).not.toHaveBeenCalled()
      expect(f.reservations[0]!.resident).not.toHaveBeenCalled()
    } else {
      // The failed service's own range is already proved empty; closing its scope can retire that row.
      expect(f.reservations[0]!.active).toHaveBeenCalledTimes(1)
      expect(f.reservations[0]!.resident).toHaveBeenCalledTimes(1)
    }
    // Explicit synthetic physical acknowledgement is the only cleanup completion in this negative path.
    f.physical.resolve(undefined); await f.owner.closeProvider(); await f.stopping; await f.foreground
    expect(f.reservations[1]!.active).toHaveBeenCalledTimes(1)
    expect(f.reservations[1]!.resident).toHaveBeenCalledTimes(1)
  })
