/** Unmodified native Bash and Agent loop consume cloud observations without ending the turn at admission. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import * as NativeBash from '@deepseek-ai/dsh-tool-bash'
import { expect, test } from 'vitest'
import { grant as grantSchema, PlatformError, type Grant } from '../src/contracts.ts'
import { cloudShellObservation, cloudShellProposeRequest, type CloudShellObservation } from '../src/cloud-shell-contracts.ts'
import { CloudShellExecutor } from '../src/host/cloud-shell.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

type Transport = ConstructorParameters<typeof CloudShellExecutor>[1]

function operation(sessionId = randomUUID()): Grant {
  return grantSchema.parse({ operationId: randomUUID(), sessionId, userId: randomUUID(), requestId: randomUUID(),
    text: 'run Python', token: randomUUID(), epoch: 1,
    settings: { model: 'mock', maxTokens: 4096, revision: 1 }, executionEnabled: true })
}

interface Fixture {
  ctx: Context
  shell: CloudShellExecutor
  wire: Map<string, CloudShellObservation>
  calls: { path: string; token: string; input: unknown }[]
  seen: PromiseWithResolvers<undefined>
  respond?: (path: string, value: CloudShellObservation) => Promise<unknown>
  admit?: (value: CloudShellObservation, request: ReturnType<typeof cloudShellProposeRequest.parse>) => Promise<unknown>
  makeAgent: (grant: Grant) => Promise<Awaited<ReturnType<AgentLoop['create']>>>
}

async function fixture<T>(run: (f: Fixture) => Promise<T>): Promise<T> {
  const ctx = new Context(), wire = new Map<string, CloudShellObservation>(), calls: { path: string; token: string; input: unknown }[] = []
  const seen = Promise.withResolvers<undefined>()
  const transport: Transport = {
    assertGrant: () => {},
    async call(path, token, input) {
      calls.push({ path, token, input })
      if (path === '/runtime/shell/propose') {
        const request = cloudShellProposeRequest.parse(input)
        const value = wire.get(token) ?? cloudShellObservation.parse({ executionId: randomUUID(), state: 'queued', command: request.command,
          cwd: request.cwd, timeoutMs: request.timeoutMs, result: null, errorCode: null, cancelCause: null })
        wire.set(token, value)
        if (f.admit) return f.admit(value, request)
        return value
      }
      const value = wire.get(token)
      if (!value) throw new PlatformError(404, 'execution_not_found')
      seen.resolve(undefined)
      if (f.respond) return f.respond(path, value)
      return { ...value }
    },
  }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const shell = new CloudShellExecutor(ctx, transport, { pollMs: 1, timeoutMs: 10_000, maxTimeoutMs: 30_000, maxOutputBytes: 65_536 })
  new ShellEnvRegistry(ctx, { dshHome: '/home/agent/.dsh' })
  const f: Fixture = { ctx, shell, wire, calls, seen, async makeAgent(grant) {
    const agent = await ctx.agentLoop.create(SessionId(grant.sessionId), { provider: 'mock', model: 'mock' })
    shell.bind(agent, grant)
    await agent.ctx.plugin(NativeBash, { enableRunInBackground: false, promoteOnTimeout: false })
    return agent
  } }
  try {
    return await run(f)
  } finally { await ctx.fiber.dispose() }
}

function finish(value: CloudShellObservation, exitCode = 0): void {
  value.state = exitCode === 0 ? 'succeeded' : 'failed'
  value.result = { exitCode, stdout: 'Hello, World!\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }
}

test('native Bash keeps its original call pending through preparation and renders actual stdout and exit', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant)
  let settled = false
  const pending = f.ctx.tools.execute({ name: 'bash', arguments: { command: 'python3 hello.py', description: 'Run the Python greeting' },
    callId: ToolCallId('native-python'), signal: new AbortController().signal, agent }).finally(() => { settled = true })
  await f.seen.promise
  const value = f.wire.get(grant.token)
  if (!value) throw new Error('No original cloud admission')
  expect(settled).toBe(false)
  expect(f.calls[0]).toMatchObject({ path: '/runtime/shell/propose', input: { callId: 'native-python:shell:0', cwd: '' } })
  finish(value)
  const result = await pending
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0, stdout: { text: 'Hello, World!\n' } })
  expect(f.calls.every(call => call.path.startsWith('/runtime/shell/'))).toBe(true)
}))

test('native Bash reports a nonzero command outcome without treating it as a transport error', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant)
  const pending = f.ctx.tools.execute({ name: 'bash', arguments: { command: 'exit 7', description: 'Check a command failure' },
    callId: ToolCallId('failed-command'), signal: new AbortController().signal, agent })
  await f.seen.promise
  const value = f.wire.get(grant.token)
  if (!value) throw new Error('No failed command admission')
  finish(value, 7)
  expect(await pending).toMatchObject({ isError: false, value: { kind: 'foreground', exitCode: 7 } })
}))

test('cancellation remains pending until exact terminal evidence rather than a cancel receipt', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant), abort = new AbortController()
  let settled = false
  const pending = f.ctx.tools.execute({ name: 'bash', arguments: { command: 'sleep 5', description: 'Wait for a command' },
    callId: ToolCallId('cancel-command'), signal: abort.signal, agent }).finally(() => { settled = true })
  await f.seen.promise
  const value = f.wire.get(grant.token)
  if (!value) throw new Error('No cancellable command admission')
  value.state = 'cancelling'
  abort.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  value.state = 'cancelled'
  expect(await pending).toMatchObject({ isError: true })
  expect(f.calls.some(call => call.path === '/runtime/shell/cancel')).toBe(true)
}))

test('different native Agents keep grants and tool registrations independent', () => fixture(async (f) => {
  const grants = [operation(), operation()], agents = await Promise.all(grants.map(g => f.makeAgent(g)))
  const pending = agents.map((agent, i) => f.ctx.tools.execute({ name: 'bash',
    arguments: { command: `echo ${i}`, description: 'Read this owned workspace' },
    callId: ToolCallId(`owner-${i}`), signal: new AbortController().signal, agent }))
  await f.seen.promise
  // Both calls admit before either result is made available, so the test exercises overlapping owners.
  while (f.wire.size < 2) await new Promise<void>(resolve => setImmediate(resolve))
  grants.forEach((grant, i) => {
    const value = f.wire.get(grant.token)
    if (!value) throw new Error('Missing concurrent owner')
    expect(value.command).toBe(`echo ${i}`)
    finish(value)
  })
  expect((await Promise.all(pending)).every(r => !r.isError)).toBe(true)
}))

test('a completed result observed after the local deadline retains the actual successful facts', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant)
  f.respond = async (path, value) => {
    if (path === '/runtime/shell/status') {
      await new Promise<void>(resolve => setTimeout(resolve, 1100))
      return { ...value }
    }
    finish(value)
    return { ...value }
  }
  const result = await f.ctx.tools.execute({ name: 'bash', arguments: { command: 'true', timeoutMs: 1000, description: 'Observe a completed command' },
    callId: ToolCallId('late-success'), signal: new AbortController().signal, agent })
  expect(result).toMatchObject({ isError: false, value: { exitCode: 0, timedOut: false, aborted: false } })
  expect(f.calls.at(-1)).toMatchObject({ path: '/runtime/shell/cancel', input: { cause: 'timeout' } })
}))

test('an observation identity error keeps the original command managed until exact cleanup finishes', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant), cleaning = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  f.respond = async (path, value) => {
    if (path === '/runtime/shell/status') return { ...value, command: 'foreign-command' }
    cleaning.resolve(undefined)
    await stopped.promise
    value.state = 'cancelled'; value.cancelCause = 'abort'
    return { ...value }
  }
  let settled = false
  const pending = f.ctx.tools.execute({ name: 'bash', arguments: { command: 'sleep 60', description: 'Wait for exact cleanup' },
    callId: ToolCallId('bad-observation'), signal: new AbortController().signal, agent }).finally(() => { settled = true })
  try {
    await cleaning.promise
    expect(settled).toBe(false)
    expect(f.calls.at(-1)).toMatchObject({ path: '/runtime/shell/cancel', input: { cause: 'abort' } })
  } finally { stopped.resolve(undefined) }
  expect(await pending).toMatchObject({ isError: true })
}))

test('preparation expiry uses the durable first stopping cause', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant)
  f.respond = async (path, value) => {
    if (path === '/runtime/shell/status') {
      await new Promise<void>(resolve => setTimeout(resolve, 1100))
      return { ...value }
    }
    value.state = 'cancelled'; value.cancelCause = 'timeout'
    return { ...value }
  }
  const result = await f.ctx.tools.execute({ name: 'bash', arguments: { command: 'true', timeoutMs: 1000, description: 'Wait for preparation' },
    callId: ToolCallId('preparation-timeout'), signal: new AbortController().signal, agent })
  expect(result).toMatchObject({ isError: false, value: { exitCode: null, timedOut: true, aborted: false } })
}))

test('unsupported background or outside workdir is rejected before any cloud admission', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant)
  for (const args of [{ workdir: '/private' }, { run_in_background: true }]) {
    expect(await f.ctx.tools.execute({ name: 'bash', arguments: { command: 'true', description: 'Validate execution limits', ...args },
      callId: ToolCallId(randomUUID()), signal: new AbortController().signal, agent })).toMatchObject({ isError: true })
  }
  expect(f.calls).toHaveLength(0)
  expect(() => f.shell.resolve({ command: 'true' })).toThrow('shell_operation_missing')
}))

test('a lost admission response retains the call identity and reads its cancellation without new work', () => fixture(async (f) => {
  const grant = operation(), agent = await f.makeAgent(grant), abort = new AbortController()
  let first = true
  f.admit = async (value, request) => {
    if (first) { first = false; abort.abort(); throw new TypeError('fetch failed') }
    expect(request).toMatchObject({ callId: 'lost-admission:shell:0', cancelRequested: true, cancelCause: 'abort' })
    value.state = 'cancelled'; value.cancelCause = 'abort'
    return { ...value }
  }
  const result = await f.ctx.tools.execute({ name: 'bash', arguments: { command: 'true', description: 'Read the original receipt' },
    callId: ToolCallId('lost-admission'), signal: abort.signal, agent })
  expect(result).toMatchObject({ isError: true })
  expect(f.wire.size).toBe(1)
  expect(f.calls).toHaveLength(2)
  expect(f.calls[0]?.input).toMatchObject({ callId: 'lost-admission:shell:0' })
}))

test('the original native Agent loop sees a real Bash result and continues within one turn', () => fixture(async (f) => {
  const adapter = new MockAdapter([toolCallResponse('loop-python', 'bash',
    { command: 'python3 hello.py', description: 'Run the Python greeting' }, 'Running Python.'), textResponse('Hello, World!')])
  f.ctx.llm.registerAdapter(['mock'], adapter)
  const grant = operation(), agent = await f.makeAgent(grant)
  const idle = Promise.withResolvers<undefined>()
  const dispose = f.ctx.on('agent/status', ({ agent: source, status }) => { if (source === agent && status === 'idle') idle.resolve(undefined) })
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run hello.py' }], source: { kind: 'user' } }))
    await f.seen.promise
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(false)
    const value = f.wire.get(grant.token)
    if (!value) throw new Error('No loop command admission')
    finish(value)
    await idle.promise
    const events = agent.session.snapshotEvents()
    expect(events.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'user/message')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool/result')).toHaveLength(1)
    expect(events.filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages.some(m => m.role === 'tool')).toBe(true)
  } finally { dispose() }
}))

test('a restricted plugin owner mounts native Bash through its declared service injection', async () => { await fixture(async (f) => {
  let installed = false
  await f.ctx.plugin({
    name: 'cloud-shell-restricted-owner', inject: ['tools', 'systemPrompt'],
    async apply(ctx: Context) {
      await ctx.plugin(NativeBash, { enableRunInBackground: false, promoteOnTimeout: false })
      installed = true
    },
  })
  expect(installed).toBe(true)
}) })
