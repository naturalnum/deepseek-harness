/** Native command/account/tool cancellation with a synthetic allocation channel; no SSH or physical cleanup claim. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { remoteServerApproval } from '@deepseek-ai/dsh-pe-cloud-api'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { AccountRemoteServers, installRemoteServerTools } from '@deepseek-ai/dsh-remote-server-cloud'
import type { RemoteServer } from '@deepseek-ai/dsh-remote-server-cloud'
import Approval from '@deepseek-ai/dsh-user-approval'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { SessionAllocationOwner } from '../src/allocation-owner.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import { ExecutionStateError } from '../src/errors.ts'
import { runRemoteSsh, type RemoteSshConfig } from '../src/remote-ssh.ts'
import { remoteManagedFixture } from './remote-managed-fixture.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.restoreAllMocks()
})

async function fixture(timeoutMs = 10000) {
  const ctx = new Context(), generation = new AbortController(), managed = await remoteManagedFixture()
  const submitted = Promise.withResolvers<undefined>(), stopped = Promise.withResolvers<undefined>()
  let ioClosed = false, complete = false, stops = 0, captured: unknown, toolSignal: AbortSignal | undefined
  vi.spyOn(SessionAllocationOwner.prototype, 'prepare').mockImplementation(async request => ({
    sandboxId: String(request.sessionId), runtimeIdentity: '1'.repeat(64), protocolVersion: 'synthetic-range', capabilities: ['argv-collect'],
  }))
  vi.spyOn(SessionAllocationOwner.prototype, 'stop').mockResolvedValue(undefined)
  vi.spyOn(managed.runtimes, 'needsContinuation').mockReturnValue(false)
  vi.spyOn(managed.runtimes, 'skillProject').mockReturnValue(undefined)
  const command = vi.spyOn(managed.runtimes, 'command').mockImplementation(() => {
    const blank = { bytes: new Uint8Array(), observedBytes: 0, eof: false }
    let view: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
      physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: blank, stderr: blank }
    const snapshot = (): CommandSnapshot => !ioClosed && !complete ? view : { ...view, rangeEmpty: true, ioClosed: true,
      direct: complete ? { exitCode: 0, signal: null } : undefined,
      stdout: { ...blank, eof: true }, stderr: { ...blank, eof: true } }
    return {
      async prepare() { return view },
      async commit() { view = { ...view, submitted: true }; submitted.resolve(undefined); return snapshot() },
      async poll() { return snapshot() },
      async stop() { stops++; stopped.resolve(undefined); return snapshot() },
    } satisfies CommandChannel
  })
  cleanup.push(async () => { ioClosed = true; await managed.close(); await ctx.fiber.dispose() })
  const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('interruption-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'interruption-fixture', lifetime: generation.signal })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  provideWorkingDirectoryFixture(ctx, '/project')
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/project' })
  await ctx.plugin(LocalFileSystem)
  let reference = ''
  const model = new MockAdapter([
    () => toolCallResponse('cancel-call', 'remote_exec', { server: reference, command: 'sleep 8' }),
    () => toolCallResponse('next-call', 'remote_exec', { server: reference, command: 'true' }),
    textResponse('Next command completed.'),
  ])
  ctx.llm.registerAdapter(['fixture-model'], model)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('remote-interruption'), { provider: 'fixture-model', model: 'fixture' }, { cwd: '/project' })
  await ctx.plugin(Approval, { policy: 'ask' })
  ctx.on('approval/request', async () => 'allowed-once')
  const workspace: Workspace = { id: brandString<Workspace['id']>('interruption-project'), path: '/project', sessionIds: [agent.id],
    title: '', createdAt: '', updatedAt: '', setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {},
    detachSession: async () => {}, status: async () => 'ok' }
  const port = managed.bind(ctx, binding, { assertBusinessCurrent: () => { generation.signal.throwIfAborted() },
    getAgent: id => ctx.agents.get(id), projectForAgent: () => workspace, projectForSession: () => workspace,
    assertRetainedExecutionOwner() { throw new Error('No background work in this fixture') },
    files() { throw new Error('Synthetic allocation channel owns fixture filesystem') } })
  managed.installProviders(ctx, port)
  let records: readonly RemoteServer[] = []
  const collection = new AccountRemoteServers(ctx, binding, { maxServers: 1, maxCommandBytes: 4096,
    policy: { alwaysAsk: true, readOnlyAllowlist: [] }, assertCurrent: () => { generation.signal.throwIfAborted() },
    read: () => records, write: async (next) => { records = next }, deleteCredential: async () => {} })
  await collection.add({ alias: 'target', host: 'target', user: 'fixture', port: 2222, description: '', tags: [], alwaysAsk: true })
  reference = collection.list()[0]!.reference
  const config: RemoteSshConfig = { pythonPath: '/usr/bin/python3', sshPath: '/usr/bin/ssh', timeoutMs, probeTimeoutMs: timeoutMs,
    connectTimeoutSeconds: 1, outputMaxBytes: 4096, stopWaitMs: 2000 }
  installRemoteServerTools(ctx, collection, { maxReplyBytes: 65536, assertCurrent: () => { generation.signal.throwIfAborted() },
    approval: exec => remoteServerApproval(ctx, binding, exec, () => { generation.signal.throwIfAborted() }),
    async run(exec, target, value, current, probe) {
      toolSignal = exec.signal
      try { return await runRemoteSsh(ctx, target, { privateKey: 'fixture-private-not-a-key', knownHosts: 'fixture-known-hosts' },
        value, exec.signal, config, current, probe) }
      catch (cause) { captured = cause; throw cause }
    },
  })
  const invoke = (signal: AbortSignal) => {
    agent.session.append('turn/start', { turn: 1 })
    return ctx.tools.execute({ name: 'remote_exec', arguments: { server: reference, command: 'sleep 8' },
      callId: ToolCallId('direct-call'), agent, signal }).finally(() => {
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
  }
  const idle = (): Promise<void> => new Promise((resolve) => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { off(); resolve() } })
  })
  return { agent, ctx, managed, binding, command, submitted: submitted.promise, stopped: stopped.promise, invoke, idle,
    closeIo: () => { ioClosed = true }, complete: () => { complete = true },
    captured: () => captured, signal: () => toolSignal, stops: () => stops, model }
}

it('shows the remote-running warning while retaining aborted/user and the original local IO stop owner', async () => {
  const f = await fixture(), ended = f.idle()
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the remote command.' }], source: { kind: 'user' } }))
  await Promise.race([f.submitted, ended.then(() => { throw new Error(JSON.stringify(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result'))) })])
  const reason = { kind: 'user' } as const
  f.agent.cancel(reason)
  await f.stopped
  expect(f.managed.owner.isEpochIdle(f.binding)).toBe(false)
  expect(f.captured()).toBeUndefined()
  f.closeIo()
  await ended
  expect(f.captured()).toBeInstanceOf(Error)
  const captured = f.captured()
  expect(captured instanceof Error && captured.cause).toBe(reason)
  expect(f.signal()?.reason).toBe(reason)
  const events = f.agent.session.snapshotEvents()
  expect(events.find(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const result = events.find(event => event.type === 'tool/result')
  expect(JSON.stringify(result)).toContain('本地等待已取消，远端程序可能仍在运行。')
  expect(JSON.stringify(result)).not.toContain('[object Object]')
  expect(JSON.stringify(events)).not.toContain('fixture-private-not-a-key')
  expect(result?.data).toHaveProperty('message.isError', true)
  expect(events.filter(event => event.type === 'tool/result' || event.type === 'turn/end')
    .map(event => event.type === 'tool/result'
      ? { type: event.type, message: event.data.message.content, isError: event.data.message.isError }
      : { type: event.type, reason: event.data.reason })).toMatchSnapshot('native user cancellation and Remote warning')
  expect(f.stops()).toBe(1)
  expect(f.managed.owner.isEpochIdle(f.binding)).toBe(true)
  expect(f.model.requests).toHaveLength(1)
  f.complete()
  const nextEnded = f.idle()
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the next small command.' }], source: { kind: 'user' } }))
  await nextEnded
  expect(f.command).toHaveBeenCalledTimes(2)
  expect(f.managed.owner.isEpochIdle(f.binding)).toBe(true)
  expect(f.model.requests).toHaveLength(3)
  const nextEvents = f.agent.session.snapshotEvents()
  expect(nextEvents.filter(event => event.type === 'tool/result').at(-1)?.data).toHaveProperty('message.isError', false)
  expect(JSON.stringify(nextEvents.filter(event => event.type === 'tool/result').at(-1))).toContain('completed')
  expect(nextEvents.filter(event => event.type === 'turn/end').at(-1)?.data).toHaveProperty('reason.kind', 'completed')
})

it('warns for the actual SSH timeout reason and preserves it as cause after local IO settlement', async () => {
  const f = await fixture(30), result = f.invoke(new AbortController().signal)
  await Promise.race([f.stopped, result.then((value) => { throw new Error(JSON.stringify(value)) })])
  expect(f.managed.owner.isEpochIdle(f.binding)).toBe(false)
  f.closeIo()
  expect((await result).content).toEqual([{ type: 'text', text: 'Error: 本地等待已超时，远端程序可能仍在运行。' }])
  expect(f.captured()).toHaveProperty('cause', expect.any(TimeoutReason))
  expect(f.captured()).toHaveProperty('cause.code', 'remote-ssh-timeout')
  expect(f.managed.owner.isEpochIdle(f.binding)).toBe(true)
})

it.each([{ kind: 'parent' }, new Error('Account lifetime ended')])('keeps other original interruption causes unchanged: %s', async (reason) => {
  const f = await fixture(), cancellation = new AbortController(), result = f.invoke(cancellation.signal)
  await Promise.race([f.submitted, result.then((value) => { throw new Error(JSON.stringify(value)) })])
  cancellation.abort(reason)
  await f.stopped
  f.closeIo()
  await result
  expect(f.captured()).toBe(reason)
  expect(f.managed.owner.isEpochIdle(f.binding)).toBe(true)
})

it('does not relabel an independent cleanup failure merely because the user signal is aborted', async () => {
  const f = await fixture(), cancellation = new AbortController()
  const failure = new ExecutionStateError('cloud/stop-unconfirmed', 'Original cleanup is unconfirmed.')
  const subprocess = f.ctx.get('subprocess')!
  const spawn = subprocess.spawn.bind(subprocess)
  vi.spyOn(subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    return { ...handle, done: handle.done.catch(() => { throw failure }) }
  })
  const result = f.invoke(cancellation.signal)
  await Promise.race([f.submitted, result.then((value) => { throw new Error(JSON.stringify(value)) })])
  cancellation.abort({ kind: 'user' })
  await f.stopped
  f.closeIo()
  expect((await result).content).toEqual([{ type: 'text', text: 'Error: Original cleanup is unconfirmed.' }])
  expect(f.captured()).toBe(failure)
})
