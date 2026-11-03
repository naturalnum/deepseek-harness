/** Real Native approval and Bash dispatch over the production policy selector; no process or kernel execution. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellExecution } from '@deepseek-ai/dsh-shell'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it, onTestFinished, vi } from 'vitest'
import { selectNativeFilePolicy } from '../src/native-file-policy.ts'

async function fixture(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  provideWorkingDirectoryFixture(ctx, '/project')
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: '/project' })
  await ctx.plugin(Approval, { policy: 'ask' })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('approved-bash-policy'), {}, { cwd: '/project' })
  agent.session.append('turn/start', { turn: 1 })
  const prepared = vi.fn<typeof selectNativeFilePolicy>()
  class PolicyExecutor extends ShellExecutor {
    override get sandboxMode() { return 'read-only' as const }
    resolve(request: ShellExecRequest): ShellExecSpec {
      return { command: request.command, workdir: '/project', stdoutMaxBytes: 128, timeoutMs: 1000,
        onExpiry: 'kill', sandboxPolicy: request.sandboxPolicy }
    }
    execute(spec: ShellExecSpec): Promise<ShellExecution> {
      const policy = selectNativeFilePolicy(ctx, agent.session, '/project', spec.sandboxPolicy)
      prepared(ctx, agent.session, '/project', spec.sandboxPolicy)
      const reader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      return Promise.resolve({ status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(), kill: () => false,
        readOutput: () => ({ delta: '', lossy: false }), observed: { stdout: reader, stderr: reader },
        result: () => Promise.resolve({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: policy.mode, truncated: false }, stderr: { text: '', truncated: false } }) })
    }
  }
  await ctx.plugin(PolicyExecutor)
  await ctx.plugin(ShellEnvRegistry, { dshHome: '/unused-native-test-home' })
  await ctx.plugin(ToolBash, { enableRunInBackground: false, promoteOnTimeout: false })
  const approval = vi.fn(() => Promise.resolve(outcome))
  ctx.on('approval/request', approval)
  const execute = (args: Record<string, unknown>) => ctx.tools.execute({ callId: ToolCallId('approved-bash-call'), name: 'bash',
    agent, signal: new AbortController().signal, arguments: { command: 'one approved command', description: 'Native escalation', ...args } })
  return { ctx, agent, prepared, approval, execute }
}

it.each(['workspace-write', 'danger-full-access'] as const)('preserves one Native approved %s Bash override without changing the Session mode', async (mode) => {
  const f = await fixture()
  const result = await f.execute({ sandbox_permissions: mode, justification: 'One explicitly approved operation.' })
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided'))
    .toMatchObject([{ data: { outcome: 'allowed-once' } }])
  expect(result.isError).toBe(false)
  expect(f.prepared).toHaveBeenCalledExactlyOnceWith(f.ctx, f.agent.session, '/project',
    { mode, workspaceRoot: '/project', sessionId: f.agent.id })
  expect(f.ctx.sandboxPolicy.resolve({ session: f.agent.session }).mode).toBe('read-only')
})

it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not reach policy preparation after Native approval %s', async (outcome) => {
  const f = await fixture(outcome)
  expect((await f.execute({ sandbox_permissions: 'workspace-write', justification: 'Needs permission.' })).isError).toBe(true)
  expect(f.prepared).not.toHaveBeenCalled()
})

it('does not turn a model-supplied raw sandboxPolicy object into an approved override', async () => {
  const f = await fixture()
  expect((await f.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/project', sessionId: f.agent.id } })).isError)
    .toBe(false)
  expect(f.approval).not.toHaveBeenCalled()
  expect(f.prepared).toHaveBeenCalledExactlyOnceWith(f.ctx, f.agent.session, '/project',
    { mode: 'read-only', workspaceRoot: '/project', sessionId: f.agent.id })
})
