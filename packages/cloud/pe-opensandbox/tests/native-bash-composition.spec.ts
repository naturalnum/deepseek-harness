/** Real native dispatch and production Agent/Session over scripted directory, Workspace and command collaborators. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeCommandAccount, type NativeCommandRoot } from '../src/native-command-account.ts'
import { CloudShellExecutor, CloudSubprocessRuntime } from '../src/native-providers.ts'
import { CloudShellEnvRegistry } from '../src/native-shell-env.ts'
import type { CommandChannel, CommandSnapshot, ManagedCommandOperation } from '../src/command-operation.ts'
import type { ExecutionScope } from '../src/scopes.ts'

it('projects one real native bash dispatch before releasing its original command scope and output reservation', async () => {
  const ctx = new Context(), generation = new AbortController(), output = 'native composition 原生\n'
  const owner: { commands?: NativeCommandAccount } = {}
  onTestFinished(async () => {
    try { await owner.commands?.closeProvider(); await ctx.fiber.dispose() }
    finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
  })
  vi.stubEnv('DSH_HOME', '/host/private/harness-home')
  const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('native-bash-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'scripted-native-composition', lifetime: generation.signal })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  provideWorkingDirectoryFixture(ctx, '/project')
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('native-bash-agent'), {}, { cwd: '/project' })
  expect(ctx.agents.get(agent.id)).toBe(agent)
  expect(ctx.sessions.get(agent.id)).toBe(agent.session)
  expect(agent.session).toBeInstanceOf(Session)

  const workspace: Workspace = { id: brandString<Workspace['id']>('native-bash-workspace'), path: '/project',
    sessionIds: [agent.session.id], title: 'scripted Workspace', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
    setTitle: () => Promise.reject(new Error('No Workspace I/O in this composition.')),
    attachSession: () => Promise.reject(new Error('No Workspace I/O in this composition.')),
    insertSessionBefore: () => Promise.reject(new Error('No Workspace I/O in this composition.')),
    detachSession: () => Promise.reject(new Error('No Workspace I/O in this composition.')), status: () => Promise.resolve('ok') }
  const initial: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false },
    stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } }
  const final: CommandSnapshot = { ...initial, submitted: true, commitClosed: true, rangeEmpty: true, ioClosed: true,
    direct: { exitCode: 0, signal: null }, stdout: { bytes: Buffer.from(output), observedBytes: Buffer.byteLength(output), eof: true },
    stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } }
  const channel = { prepare: vi.fn<CommandChannel['prepare']>(() => Promise.resolve(initial)),
    commit: vi.fn<CommandChannel['commit']>(() => Promise.resolve(final)),
    poll: vi.fn<CommandChannel['poll']>(() => Promise.reject(new Error('The scripted command completes at commit.'))),
    stop: vi.fn<CommandChannel['stop']>(() => Promise.reject(new Error('The scripted command is already empty.'))) } satisfies CommandChannel
  const events: string[] = [], capacity = { active: 0, resident: 0 }
  const releaseActive = vi.fn(() => { capacity.active--; events.push('active-released') })
  const releaseResident = vi.fn(() => { capacity.resident--; events.push('resident-released') })
  const root = { acquire: vi.fn<NativeCommandRoot['acquire']>(() => Promise.resolve(channel)),
    unknown: vi.fn<NativeCommandRoot['unknown']>(), reserve: vi.fn<NativeCommandRoot['reserve']>(() => {
      capacity.active++; capacity.resident++; events.push('reserved'); return { releaseActive, releaseResident }
    }), close: vi.fn(() => Promise.resolve()) } satisfies NativeCommandRoot
  const commands = new NativeCommandAccount(ctx, binding, {
    assertBusinessCurrent() { generation.signal.throwIfAborted() }, getAgent: id => ctx.agents.get(id),
    projectForAgent(current) {
      if (current !== agent) throw new Error('Expected the original production Agent.')
      return workspace
    }, projectForSession(current) {
      if (current !== agent.session) throw new Error('Expected the original production Session.')
      return workspace
    }, files() { throw new Error('Files/backend preparation is replaced by the scripted Root channel.') },
  }, { allowedTools: ['bash'], maxScopes: 2, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512,
    maxStdinBytes: 4096, maxTailBytes: 128, maxObservedBytes: 65536, pollIntervalMs: 1000,
    maxWaiters: 2, maxLifetimeMs: 10000, stopWaitMs: 2000 } }, root)
  owner.commands = commands
  const shell = new CloudShellExecutor(ctx, commands, { bashPath: '/bin/bash', timeoutMs: 5000,
    maxTimeoutMs: 5000, maxOutputBytes: 128, graceMs: 1000 })
  new CloudSubprocessRuntime(ctx, commands)
  const environment = new CloudShellEnvRegistry(ctx, commands)
  const create = vi.spyOn(commands, 'create'), resolve = vi.spyOn(shell, 'resolve'), collect = vi.spyOn(environment, 'collect')
  ctx.provide('profileContext', { name: 'host-profile', dir: '/host/private/profile',
    patchPath: '/host/private/profile/cordis.patch.yml', installAnchor: '/host/private/package.json',
    cwd: '/host/private/cwd', home: '/host/private/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
  let captured: { readonly execution: ToolExecution; readonly scope: ExecutionScope<Workspace> } | undefined
  let post: {
    readonly result: Readonly<ToolExecutionResult>
    readonly active: number
    readonly resident: number
    readonly text: string
  } | undefined
  let notified: {
    readonly execution: Readonly<ToolExecution>
    readonly result: Readonly<ToolExecutionResult>
    readonly calls: number
    readonly active: number
    readonly resident: number
  } | undefined
  const originalOperation = (): ManagedCommandOperation => {
    const result = create.mock.results[0]
    if (result?.type !== 'return') throw new Error('No original command operation was returned.')
    return result.value
  }
  ctx.on('tools/execute', (execution, next) => {
    captured = { execution, scope: commands.calls.capture(ctx).scope }
    events.push('native-execute')
    return next()
  })
  ctx.on('tools/post-execute', (_execution, result, next) => {
    post = { result, active: capacity.active, resident: capacity.resident,
      text: originalOperation().handle.collected.stdout!.readFrom(0).text }
    events.push('canonical-post')
    return next()
  })
  ctx.on('tools/result', (execution, result) => {
    notified = { execution, result, calls: commands.calls.inspect(), active: capacity.active, resident: capacity.resident }
    events.push('native-result')
  })
  await ctx.plugin(ToolBash, { enableRunInBackground: false, promoteOnTimeout: false })
  const result = await ctx.tools.execute({ callId: ToolCallId('native-bash-composition'), name: 'bash', agent,
    signal: new AbortController().signal, arguments: { command: 'printf native-composition', description: 'One scripted native composition' } })

  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ kind: 'foreground', cwd: '/project', exitCode: 0, signal: null,
    timedOut: false, aborted: false, timeoutMs: 5000, stdout: { text: output, truncated: false }, stderr: { text: '', truncated: false } })
  expect(result.content).toEqual([{ type: 'text', text: output }])
  expect(captured?.execution.agent).toBe(agent)
  expect(captured?.scope.agent).toBe(agent); expect(captured?.scope.sessionId).toBe(agent.session.id)
  expect(captured?.scope.project).toBe(workspace); expect(captured?.scope.consumerId).toBe('bash')
  expect(collect).toHaveBeenCalledTimes(1)
  expect(collect.mock.calls[0]?.[0]).toBe(captured?.execution)
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({ dshEnv: {}, workdir: '/project' })
  expect(Object.isFrozen(resolve.mock.calls[0]?.[0].dshEnv)).toBe(true)
  expect(JSON.stringify(resolve.mock.calls)).not.toContain('/host/private')
  expect(channel.prepare).toHaveBeenCalledExactlyOnceWith({ argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'printf native-composition'],
    cwd: '/project', stdin: { mode: 'ignore' } })
  expect(channel.commit).toHaveBeenCalledTimes(1); expect(channel.poll).not.toHaveBeenCalled(); expect(channel.stop).not.toHaveBeenCalled()
  expect(post).toMatchObject({ active: 0, resident: 1, text: output })
  expect(post?.result.value).toEqual(result.value)
  expect(notified?.result).toBe(result); expect(notified?.execution).toBe(captured?.execution)
  expect(Object.isFrozen(notified?.execution)).toBe(true); expect(Object.isFrozen(result.value)).toBe(true)
  expect(notified).toMatchObject({ calls: 0, active: 0, resident: 0 })
  expect(events).toEqual(['native-execute', 'reserved', 'active-released', 'canonical-post', 'resident-released', 'native-result'])
  expect(releaseActive).toHaveBeenCalledTimes(1); expect(releaseResident).toHaveBeenCalledTimes(1)
  expect(root.acquire).toHaveBeenCalledTimes(1); expect(root.unknown).not.toHaveBeenCalled()
  if (captured === undefined) throw new Error('The original native execute event was not observed.')
  const originalScope = captured.scope
  expect(() => { commands.calls.assertCurrent(originalScope) }).toThrow()
  expect(() => { commands.assertOperationCurrent(ctx, originalOperation()) }).toThrow()
  expect(() => originalOperation().handle.collected.stdout!.readFrom(0)).toThrow('owner was released')
  expect(root.acquire).toHaveBeenCalledTimes(1)
})
