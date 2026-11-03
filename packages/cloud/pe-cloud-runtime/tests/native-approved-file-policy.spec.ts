/** Real Native approval/write tool over an owned local test file and the production cloud mutation guard. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import Approval from '@deepseek-ai/dsh-user-approval'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import type { FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createAccountFileMutationGuard } from '../src/account-permissions.ts'

async function fixture(outcome: 'allowed-once' | 'rejected' = 'allowed-once') {
  const project = mkdtempSync(join(tmpdir(), 'native-approved-fs-')), ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { rmSync(project, { recursive: true, force: true }) } })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  provideWorkingDirectoryFixture(ctx, project)
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: project })
  await ctx.plugin(Approval, { policy: 'ask' })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('approved-fs-policy'), {}, { cwd: project })
  agent.session.append('turn/start', { turn: 1 })
  const current = vi.fn(() => {
    ctx.fiber.assertActive()
    if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session) throw new Error('Original selection ended')
  })
  const guard = createAccountFileMutationGuard(ctx, agent.session, project, current), written = vi.fn()
  class PolicyFs extends LocalFs {
    override get sandboxMode() { return 'read-only' as const }
    override writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal,
      policy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> {
      guard(policy)
      written(policy)
      return super.writeText(target, content, expected, signal)
    }
  }
  await ctx.plugin(PolicyFs, { cwd: project })
  await ctx.plugin(ToolFs, { read: false, readImage: false, edit: false })
  const approval = vi.fn(() => Promise.resolve(outcome))
  ctx.on('approval/request', approval)
  const execute = (args: Record<string, unknown>) => ctx.tools.execute({ callId: ToolCallId('approved-fs-call'), name: 'write',
    agent, signal: new AbortController().signal, arguments: { file_path: 'result.txt', content: 'one approved write', ...args } })
  return { ctx, agent, project, written, approval, execute }
}

it.each(['workspace-write', 'danger-full-access'] as const)('accepts Native approved %s for one write while later ordinary writes stay read-only', async (mode) => {
  const f = await fixture()
  const result = await f.execute({ sandbox_permissions: mode, justification: 'Write this file once.' })
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided'))
    .toMatchObject([{ data: { outcome: 'allowed-once' } }])
  expect(result.isError).toBe(false)
  expect(readFileSync(join(f.project, 'result.txt'), 'utf8')).toBe('one approved write')
  expect(f.ctx.sandboxPolicy.resolve({ session: f.agent.session }).mode).toBe('read-only')
  expect((await f.execute({ content: 'must remain denied' })).isError).toBe(true)
  expect(readFileSync(join(f.project, 'result.txt'), 'utf8')).toBe('one approved write')
  expect(f.written).toHaveBeenCalledOnce()
})

it('does not mutate after a rejected Native approval', async () => {
  const f = await fixture('rejected')
  expect((await f.execute({ sandbox_permissions: 'workspace-write', justification: 'Needs permission.' })).isError).toBe(true)
  expect(f.written).not.toHaveBeenCalled()
})

it('ignores model-supplied raw policy data instead of treating it as a same-process override', async () => {
  const f = await fixture()
  expect((await f.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: f.project, sessionId: f.agent.id } })).isError)
    .toBe(true)
  expect(f.approval).not.toHaveBeenCalled()
  expect(f.written).not.toHaveBeenCalled()
})
