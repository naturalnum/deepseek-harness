/** Real AccountPolicy, Native Bash/Jobs and Agent teardown; only the external process channel is scripted. */
import PtcRuntime, { type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { FiberState } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { NativeCommandAccount, type NativeCommandRoot } from '../src/native-command-account.ts'
import { CloudShellExecutor } from '../src/native-providers.ts'
import { CloudShellEnvRegistry } from '../src/native-shell-env.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'

it.each(['native', 'ptc'] as const)('drains the original %s-dispatched Native job through retained AccountPolicy during AgentLoop.stop', async (mode) => {
  const fixture = policyFixture(), graph = await fixture.start(), ctx = graph.ctx
  const empty = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
  const prepared: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: empty, stderr: empty }
  const active: CommandSnapshot = { ...prepared, submitted: true }
  const terminal: CommandSnapshot = { ...active, commitClosed: true, rangeEmpty: true, ioClosed: true,
    direct: { exitCode: null, signal: 'SIGTERM' }, stdout: { ...empty, eof: true }, stderr: { ...empty, eof: true } }
  const channel = {
    prepare: vi.fn<CommandChannel['prepare']>(() => Promise.resolve(prepared)),
    commit: vi.fn<CommandChannel['commit']>(() => Promise.resolve(active)),
    poll: vi.fn<CommandChannel['poll']>(() => Promise.resolve(active)),
    stop: vi.fn<CommandChannel['stop']>(() => Promise.resolve(terminal)),
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
  const observed: FiberState[] = []
  const owner = new NativeCommandAccount(ctx, graph.binding, {
    assertBusinessCurrent() { graph.lifetime.signal.throwIfAborted(); ctx.fiber.assertActive() },
    getAgent: id => ctx.agents.get(id), projectForAgent: graph.guards.projectForAgent,
    projectForSession: graph.guards.projectForSession,
    assertRetainedExecutionOwner(agent, workspace) {
      observed.push(agent.ctx.fiber.state)
      graph.guards.assertRetainedExecutionOwner(agent, workspace)
    }, files() { throw new Error('The external command channel replaces remote allocation only.') },
  }, { allowedTools: ['bash', 'run_code'], maxScopes: 2, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16,
    maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 128, maxObservedBytes: 65536,
    pollIntervalMs: 5, maxWaiters: 2, maxLifetimeMs: 10000, stopWaitMs: 2000 } }, root)
  onTestFinished(async () => { await owner.closeProvider() })
  new CloudShellExecutor(ctx, owner, { bashPath: '/bin/bash', timeoutMs: 5000,
    maxTimeoutMs: 5000, maxOutputBytes: 128, graceMs: 1000 })
  new CloudShellEnvRegistry(ctx, owner)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 5 })
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await ctx.plugin(ToolBash)
  if (mode === 'ptc') {
    class ScriptedProgram extends PtcRuntime {
      readonly language = 'typescript'
      readonly isolation = 'scripted-external-program'
      resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: fixture.project, timeoutMs: 5000 } }
      async run(spec: PtcRunSpec): Promise<PtcRunResult> {
        const bash = spec.bindings.find(binding => binding.global === 'tools')?.functions.bash
        if (bash === undefined) throw new Error('Native PTC Bash binding absent')
        return { logs: [], value: await bash({ command: 'sleep scripted', description: 'Original nested background job', run_in_background: true }) }
      }
    }
    new ScriptedProgram(ctx)
  }
  const { sessionId } = await ctx.sessionController.create({})
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Original Native Agent absent.')
  if (mode === 'ptc') agent.ctx.tools.presentAs('ptc')
  const result = await ctx.tools.execute({ callId: ToolCallId('real-policy-background'), name: mode === 'ptc' ? 'run_code' : 'bash', agent,
    signal: new AbortController().signal,
    arguments: mode === 'ptc' ? { code: 'scripted external program invokes the Native Bash binding', description: 'Keep original nested background job' }
      : { command: 'sleep scripted', description: 'Scripted remote work under real AccountPolicy', run_in_background: true } })
  expect(result.isError).toBe(false)
  await vi.waitFor(() => { expect(channel.commit).toHaveBeenCalledTimes(1) })
  expect(owner.calls.inspect()).toBe(1)
  await ctx.agentLoop.stop()
  expect(observed).toContain(FiberState.UNLOADING)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'job/settled')).toMatchObject([
    { data: { cause: 'teardown', producerReported: true, status: 'killed' } },
  ])
  expect(channel.stop).toHaveBeenCalledTimes(1)
  expect(owner.calls.inspect()).toBe(0)
  expect(capacity).toEqual({ active: 0, resident: 0 })
  expect(ctx.agents.get(agent.id)).toBeUndefined()
  expect(root.unknown).not.toHaveBeenCalled()
})
