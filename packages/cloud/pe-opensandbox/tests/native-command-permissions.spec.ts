/** Actual native Shell/Subprocess/command-owner path over a synthetic remote channel; not kernel execution. */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ToolDispatchExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeCommandAccount, type NativeCommandRoot } from '../src/native-command-account.ts'
import { CloudShellExecutor, CloudSubprocessRuntime } from '../src/native-providers.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import type { DevServiceProfile } from '../src/dev-service-consumer.ts'

const success: ToolExecutionResult = { isError: false, value: null, content: [] }

async function fixture(enabled = true) {
  const ctx = new Context(), lifetime = new AbortController()
  let businessReady = true
  const binding: AccountBinding = { accountId: 'native-permission' as AccountBinding['accountId'],
    epoch: '1' as AccountBinding['epoch'], recipeVersion: 'native-permission-test', lifetime: lifetime.signal }
  ctx.provide('peAccount', binding)
  await ctx.plugin(Projections)
  await ctx.plugin(Sessions)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/project' })
  const session = ctx.sessions.create(SessionId('native-permission-session'), { meta: { cwd: '/project' } })
  const agent = { ctx, id: session.id, session } as Agent
  const workspace: Workspace = { id: brandString<Workspace['id']>('workspace'), path: '/project', sessionIds: [session.id],
    title: 'test workspace', createdAt: '', updatedAt: '', setTitle: async () => {}, attachSession: async () => {},
    insertSessionBefore: async () => {}, detachSession: async () => {}, status: async () => 'ok' }
  const before: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined,
    stdout: { bytes: new Uint8Array(), observedBytes: 0, eof: false }, stderr: { bytes: new Uint8Array(), observedBytes: 0, eof: false } }
  const complete: CommandSnapshot = { ...before, submitted: true, rangeEmpty: true, ioClosed: true,
    direct: { exitCode: 0, signal: null }, stdout: { ...before.stdout, eof: true }, stderr: { ...before.stderr, eof: true } }
  const prepare = vi.fn<CommandChannel['prepare']>(async () => before)
  const unknown = vi.fn<NativeCommandRoot['unknown']>()
  const root: NativeCommandRoot = { reserve: () => ({ releaseActive() {}, releaseResident() {} }),
    acquire: async () => ({ prepare, commit: async () => complete, poll: async () => complete, stop: async () => complete }),
    unknown, close: async () => {} }
  const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
    maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 }
  const profile: DevServiceProfile = { kind: 'python-http-v1', port: 8000, startWaitMs: 100, runMs: 500,
    stopWaitMs: 100, maxLogReadBytes: 32, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 4, maxArgBytes: 128, maxArgsBytes: 256 }
  const assertBusinessCurrent = (): void => {
    if (!businessReady) throw new Error('The original account is not business-ready')
  }
  const commands = new NativeCommandAccount(ctx, binding, { assertBusinessCurrent,
    getAgent: id => id === session.id ? agent : undefined, projectForAgent: () => workspace,
    projectForSession: () => workspace, files() { throw new Error('The remote allocation is mocked by this unit') } },
  { enforceSessionFilePolicy: enabled, allowedTools: ['bash', 'dev_service'], maxScopes: 2, commandLimits: limits,
    services: { profile, operationLimits: limits, assertQualified: (value) => { expect(value).toBe(profile) },
      serviceSpec() { throw new Error('This unit constructs its exact service operation explicitly') } } }, root)
  const shell = new CloudShellExecutor(ctx, commands, { enforceSessionFilePolicy: enabled, bashPath: '/bin/bash',
    timeoutMs: 100, maxTimeoutMs: 500, maxOutputBytes: 32, graceMs: 10 })
  const subprocess = new CloudSubprocessRuntime(ctx, commands)
  onTestFinished(async () => { await commands.closeProvider(); await ctx.fiber.dispose() })
  const run = async (work: () => Promise<void>, name = 'bash') => {
    const exec: ToolDispatchExecution = { callId: brandString<ToolDispatchExecution['callId']>('call'),
      rootCallId: brandString<ToolDispatchExecution['rootCallId']>('call'), token: Symbol() as ToolExecutionToken,
      name, arguments: {}, agent, signal: lifetime.signal }
    try { await commands.calls.run(exec, async () => { await work(); return success }) }
    finally { commands.calls.release(exec.token) }
  }
  return { ctx, session, shell, subprocess, commands, prepare, run, unknown, profile,
    withdrawBusiness: () => { businessReady = false } }
}

it('keeps original Shell policy in the real command owner and forwards it to signed range preparation', async () => {
  const f = await fixture()
  setSandboxMode(f.session, 'read-only')
  await f.run(async () => {
    const handle = await f.shell.execute(f.shell.resolve({ command: 'cat /project/file' }))
    await handle.result()
  })
  expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'cat /project/file'] }),
    { mode: 'read-only' })
})

it('does not let native Subprocess bypass the same Session read-only mode by omitting a Shell policy', async () => {
  const f = await fixture()
  setSandboxMode(f.session, 'read-only')
  await f.run(async () => {
    const spec: SubprocessSpawnSpec = { argv: ['/bin/sh', '-c', 'cat file'], cwd: '/project', graceMs: 10,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } }
    await f.subprocess.spawn(spec).done
  })
  expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ argv: ['/bin/sh', '-c', 'cat file'] }), { mode: 'read-only' })
})

it('rejects unsupported or foreign per-call policies before the remote preparation', async () => {
  const f = await fixture()
  await f.run(async () => {
    for (const policy of [
      { mode: 'danger-full-access' as const, workspaceRoot: '/project', sessionId: f.session.id },
      { mode: 'workspace-write' as const, workspaceRoot: '/other', sessionId: f.session.id },
    ]) {
      await expect(f.shell.execute(f.shell.resolve({ command: 'must not start', sandboxPolicy: policy })))
        .rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
    }
  })
  expect(f.prepare).not.toHaveBeenCalled()
})

it('does not permit a caller-supplied workspace-write Shell override to widen a read-only Session', async () => {
  const f = await fixture()
  setSandboxMode(f.session, 'read-only')
  await f.run(async () => {
    await expect(f.shell.execute(f.shell.resolve({ command: 'must not start', sandboxPolicy: {
      mode: 'workspace-write', workspaceRoot: '/project', sessionId: f.session.id,
    } }))).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  })
  expect(f.prepare).not.toHaveBeenCalled()
})

it('requires the actual enforcing port before advertising the native permission capability', async () => {
  const f = await fixture(false), empty = new Context()
  onTestFinished(() => empty.fiber.dispose())
  expect(() => new CloudShellExecutor(empty, f.commands, { enforceSessionFilePolicy: true, bashPath: '/bin/bash',
    timeoutMs: 100, maxTimeoutMs: 500, maxOutputBytes: 32, graceMs: 10 })).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  expect(f.prepare).not.toHaveBeenCalled()
})

it('checks quiescent original Session records before business-ready without authorizing command execution', async () => {
  const f = await fixture()
  f.withdrawBusiness()
  expect(() => { f.commands.assertSessionFilePolicyChange(f.session) }).not.toThrow()
  await expect(f.run(async () => {})).rejects.toThrow('not business-ready')
  expect(f.prepare).not.toHaveBeenCalled()
})

it('refuses a mode switch for an original command record before preparation and allows it after actual synthetic range settlement', async () => {
  const f = await fixture()
  expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).not.toThrow()
  await f.run(async () => {
    const operation = f.commands.create(f.ctx, { argv: ['/bin/true'], cwd: '/project', graceMs: 10,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } })
    expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    operation.publish(); operation.begin()
    await operation.whenEmpty
    expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).not.toThrow()
  })
  expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).not.toThrow()
})

it('retains the switch refusal after public invocation release while an original command remains unknown', async () => {
  const f = await fixture(), cause = new Error('synthetic private prepare reply failure')
  f.prepare.mockRejectedValue(cause)
  let acknowledge: (() => Promise<void>) | undefined
  await f.run(async () => {
    const operation = f.commands.create(f.ctx, { argv: ['/bin/true'], cwd: '/project', graceMs: 10,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } })
    acknowledge = async () => { operation.acknowledgePhysicalStop(); await operation.whenEmpty }
    operation.publish(); operation.begin()
    await expect(operation.handle.done).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
    expect(f.unknown).toHaveBeenCalledWith(expect.anything(), operation, cause)
  })
  expect(f.commands.calls.inspect()).toBe(0)
  expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  // The real Root owns this acknowledgement in production; this unit supplies the synthetic terminal explicitly.
  await acknowledge!()
  expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).not.toThrow()
})

it('includes a retained original service record before a process starts, and releases only its normal failed-start path', async () => {
  const f = await fixture()
  await f.run(async () => {
    const lease = f.commands.calls.retainService(f.ctx)
    f.commands.prepareStart(lease, f.profile, lease.scope.lifetime,
      { argv: ['/opt/session-env/venv/bin/python', '-B', '/project/hello.py'], cwd: '/project', graceMs: 10,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } }, signal: lease.scope.lifetime })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    f.commands.retainFailedStart(lease, undefined, new Error('Synthetic startup cancelled before any process allocation'))
    expect(() =>{  f.commands.assertSessionFilePolicyChange(f.session) }).not.toThrow()
  }, 'dev_service')
})
