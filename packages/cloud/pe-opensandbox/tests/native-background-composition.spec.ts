/** Native Agent, Bash and JobRegistry composition; the external command channel is explicitly scripted. */
import { AsyncResource } from 'node:async_hooks'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeCommandAccount, type NativeCommandRoot } from '../src/native-command-account.ts'
import { CloudShellExecutor } from '../src/native-providers.ts'
import { CloudShellEnvRegistry } from '../src/native-shell-env.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'

async function fixture() {
  const ctx = new Context(), generation = new AbortController()
  const owner: { commands?: NativeCommandAccount } = {}
  onTestFinished(async () => {
    try { await owner.commands?.closeProvider(); await ctx.fiber.dispose() }
    finally { vi.restoreAllMocks() }
  })
  const binding = installAccountBinding(ctx, {
    accountId: brandString<AccountBinding['accountId']>('native-background-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'scripted-native-composition', lifetime: generation.signal,
  })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  provideWorkingDirectoryFixture(ctx, '/project')
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('native-background-agent'), {}, { cwd: '/project' })
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 5 })
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  const workspace: Workspace = {
    id: brandString<Workspace['id']>('native-background-workspace'), path: '/project', sessionIds: [agent.id],
    title: 'scripted Workspace', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
    setTitle: () => Promise.reject(new Error('No Workspace I/O in this composition.')),
    attachSession: () => Promise.reject(new Error('No Workspace I/O in this composition.')),
    insertSessionBefore: () => Promise.reject(new Error('No Workspace I/O in this composition.')),
    detachSession: () => Promise.reject(new Error('No Workspace I/O in this composition.')), status: () => Promise.resolve('ok'),
  }
  const empty = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
  const initial: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: empty, stderr: empty }
  const state = { output: '', terminal: false, cancelled: false }
  const snapshot = (): CommandSnapshot => ({ ...initial, submitted: true, commitClosed: state.terminal,
    rangeEmpty: state.terminal, ioClosed: state.terminal,
    direct: state.terminal ? { exitCode: state.cancelled ? null : 0, signal: state.cancelled ? 'SIGTERM' : null } : undefined,
    stdout: { bytes: Buffer.from(state.output), observedBytes: Buffer.byteLength(state.output), eof: state.terminal },
    stderr: { ...empty, eof: state.terminal } })
  const channel = {
    prepare: vi.fn<CommandChannel['prepare']>(() => Promise.resolve(initial)),
    commit: vi.fn<CommandChannel['commit']>(() => Promise.resolve(snapshot())),
    poll: vi.fn<CommandChannel['poll']>(() => Promise.resolve(snapshot())),
    stop: vi.fn<CommandChannel['stop']>(() => { state.cancelled = true; state.terminal = true; return Promise.resolve(snapshot()) }),
  } satisfies CommandChannel
  const capacity = { active: 0, resident: 0 }
  const root = {
    acquire: vi.fn<NativeCommandRoot['acquire']>(() => Promise.resolve(channel)),
    unknown: vi.fn<NativeCommandRoot['unknown']>(),
    reserve: vi.fn<NativeCommandRoot['reserve']>(() => {
      capacity.active++; capacity.resident++
      return { releaseActive() { capacity.active-- }, releaseResident() { capacity.resident-- } }
    }), close: vi.fn(() => Promise.resolve()),
  } satisfies NativeCommandRoot
  const commands = new NativeCommandAccount(ctx, binding, {
    assertBusinessCurrent() { generation.signal.throwIfAborted() }, getAgent: id => ctx.agents.get(id),
    projectForAgent(current) {
      current.ctx.fiber.assertActive()
      if (current !== agent) throw new Error('Expected exact native Agent.')
      return workspace
    },
    projectForSession(current) {
      agent.ctx.fiber.assertActive()
      if (current !== agent.session) throw new Error('Expected exact native Session.')
      return workspace
    },
    assertRetainedExecutionOwner(current, project) {
      generation.signal.throwIfAborted()
      if (current !== agent || project !== workspace || ctx.agents.get(current.id) !== current
        || ctx.sessions.get(current.id) !== current.session || ctx.get('peAccount') !== binding
        || current.ctx.root !== ctx.root || current.ctx.get('peAccount') !== binding
        || !workspace.sessionIds.includes(current.id)
        || current.ctx.fiber.state !== FiberState.ACTIVE && current.ctx.fiber.state !== FiberState.UNLOADING) {
        throw new Error('The exact retained execution owner is no longer registered.')
      }
    },
    files() { throw new Error('The external command channel replaces backend preparation only.') },
  }, { allowedTools: ['bash'], maxScopes: 2,
    commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
      maxTailBytes: 128, maxObservedBytes: 65536, pollIntervalMs: 5, maxWaiters: 2,
      maxLifetimeMs: 10000, stopWaitMs: 2000 } }, root)
  owner.commands = commands
  new CloudShellExecutor(ctx, commands, { bashPath: '/bin/bash', timeoutMs: 5000,
    maxTimeoutMs: 5000, maxOutputBytes: 128, graceMs: 1000 })
  new CloudShellEnvRegistry(ctx, commands)
  ctx.provide('profileContext', { name: 'host-profile', dir: '/host/private/profile',
    patchPath: '/host/private/profile/cordis.patch.yml', installAnchor: '/host/private/package.json',
    cwd: '/host/private/cwd', home: '/host/private/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
  const producer = await ctx.plugin(ToolBash)
  let sequence = 0
  const call = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`native-background-${++sequence}`), name, arguments: args, agent, signal: new AbortController().signal,
  })
  const start = async () => {
    const result = await call('bash', { command: 'printf native-background', description: 'Scripted external execution', run_in_background: true })
    expect(result.isError).toBe(false)
    const job = ctx.jobs.list(agent.id)[0]
    if (job === undefined) throw new Error('Native Bash did not register its job.')
    await vi.waitFor(() => { expect(channel.commit).toHaveBeenCalledTimes(1) })
    return job
  }
  return { ctx, agent, harness, binding, producer, commands, root, capacity, state, channel, call, start }
}

it('keeps Native background output through tools/result and releases after the registry final drain', async () => {
  const f = await fixture()
  let delayedCapture: (() => unknown) | undefined
  f.ctx.on('tools/execute', (_exec, next) => {
    const capture = f.commands.calls.capture(f.ctx)
    delayedCapture = AsyncResource.bind(() => { f.commands.calls.assertCurrent(capture.scope); return f.commands.calls.capture(f.ctx) })
    return next()
  })
  const job = await f.start()
  expect(f.commands.calls.inspect()).toBe(1)
  expect(f.capacity).toEqual({ active: 1, resident: 1 })
  expect(delayedCapture).toBeDefined()
  expect(delayedCapture).toThrow('original live native invocation')
  f.state.output = 'after tool result\n'
  await vi.waitFor(() => { expect(f.ctx.jobs.readAt(job.id, 0, f.agent.id).chunks.map(c => c.text).join('')).toContain(f.state.output) })
  expect(f.channel.stop).not.toHaveBeenCalled()
  f.state.output += 'final native drain\n'; f.state.terminal = true
  await vi.waitFor(() => { expect(f.ctx.jobs.get(job.id, f.agent.id).status).toBe('completed') })
  expect(f.ctx.jobs.readAt(job.id, 0, f.agent.id).chunks.map(c => c.text).join('')).toBe(f.state.output)
  expect(f.commands.calls.inspect()).toBe(0)
  expect(f.capacity).toEqual({ active: 0, resident: 0 })
  expect(f.root.unknown).not.toHaveBeenCalled()
})

it('uses Native job_kill and returns the original command reservations only after its range ends', async () => {
  const f = await fixture(), job = await f.start()
  const killed = await f.call('job_kill', { job_id: job.id, reason: 'native composition cleanup' })
  expect(killed.isError).toBe(false)
  await vi.waitFor(() => { expect(f.ctx.jobs.get(job.id, f.agent.id).status).toBe('killed') })
  expect(f.ctx.jobs.get(job.id, f.agent.id).detail).toContain('native composition cleanup')
  expect(f.channel.stop).toHaveBeenCalledTimes(1)
  expect(f.commands.calls.inspect()).toBe(0)
  expect(f.capacity).toEqual({ active: 0, resident: 0 })
  expect(f.root.unknown).not.toHaveBeenCalled()
})

it('does not let a foreign Agent registration borrow the original invocation lease', async () => {
  const f = await fixture()
  const foreign = await f.harness.create(SessionId('foreign-native-job-owner'), {}, { cwd: '/other-project' })
  const completed = Promise.withResolvers<JobOutcome>()
  f.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'bash') {
      f.ctx.jobs.start({ kind: 'bash', label: 'foreign producer, no Cloud execution', owner: foreign.id,
        run: () => ({ done: completed.promise, cancel: () => { completed.resolve({ status: 'killed' }) } }) })
    }
    return next()
  })
  const job = await f.start()
  f.state.output = 'own terminal output\n'; f.state.terminal = true
  await vi.waitFor(() => { expect(f.ctx.jobs.get(job.id, f.agent.id).status).toBe('completed') })
  expect(f.commands.calls.inspect()).toBe(0)
  expect(f.ctx.jobs.list(foreign.id)[0]?.status).toBe('running')
  expect(f.capacity).toEqual({ active: 0, resident: 0 })
  completed.resolve({ status: 'completed' })
})

it('keeps foreground JobRegistry output valid until the original Native final projection', async () => {
  const f = await fixture()
  f.state.output = 'native foreground through JobRegistry\n'; f.state.terminal = true
  const result = await f.call('bash', { command: 'printf foreground', description: 'Native foreground composition' })
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ kind: 'foreground', stdout: { text: f.state.output }, exitCode: 0 })
  expect(f.ctx.jobs.list(f.agent.id)).toEqual([])
  expect(f.commands.calls.inspect()).toBe(0)
  expect(f.capacity).toEqual({ active: 0, resident: 0 })
  expect(f.channel.stop).not.toHaveBeenCalled()
})

it('retains the Native job across producer unload without accepting a shadowed account caller', async () => {
  const f = await fixture(), create = vi.spyOn(f.commands, 'create')
  const job = await f.start(), created = create.mock.results[0]
  if (created?.type !== 'return') throw new Error('The original Cloud command was not created.')
  const other = f.ctx.isolate('peAccount')
  other.provide('peAccount', { ...f.binding })
  expect(() => { f.commands.assertOperationCurrent(other, created.value) }).toThrow()
  expect(f.commands.calls.inspect()).toBe(1)
  await f.producer.dispose()
  f.state.output = 'output after Native producer unload\n'; f.state.terminal = true
  await vi.waitFor(() => { expect(f.ctx.jobs.get(job.id, f.agent.id).status).toBe('completed') })
  expect(f.ctx.jobs.readAt(job.id, 0, f.agent.id).chunks.map(chunk => chunk.text).join('')).toBe(f.state.output)
  expect(f.commands.calls.inspect()).toBe(0)
  expect(f.capacity).toEqual({ active: 0, resident: 0 })
  expect(f.channel.stop).not.toHaveBeenCalled()
})

it('cancels retained jobs when the original Native Agent owner disposes', async () => {
  const f = await fixture()
  await f.start()
  await f.ctx.agentLoop.stop()
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'job/settled')).toMatchObject([
    { data: { cause: 'teardown', producerReported: true, status: 'killed' } },
  ])
  expect(f.channel.stop).toHaveBeenCalledTimes(1)
  expect(f.commands.calls.inspect()).toBe(0)
  expect(f.capacity).toEqual({ active: 0, resident: 0 })
  expect(f.root.unknown).not.toHaveBeenCalled()
})
