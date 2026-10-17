/** M4 feasibility: reuse the public native factory and its original setup commit. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import NativeLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'

async function fixture() {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'activation-review-')))
  const project = join(home, 'project')
  const outside = join(home, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Jsonl, { root: join(home, 'sessions') })
  const denied = new Error('shared fixture project guard denied')
  let factoryGuard = false
  // Directory equality is a test-only stand-in, not a production ProjectScope issuer.
  class ReviewedLoop extends NativeLoop {
    override async createAgent(
      owner: Context,
      options: Parameters<NativeLoop['createAgent']>[1],
    ): ReturnType<NativeLoop['createAgent']> {
      if (factoryGuard && options.meta?.cwd !== project) throw denied
      return super.createAgent(owner, { ...options, setup: async (scope, agent) => {
        const originalCommit = await options.setup?.(scope, agent)
        return { commit(): void {
          owner.fiber.assertActive()
          if (factoryGuard && agent.session.header.cwd !== project) throw denied
          originalCommit?.commit()
        } }
      } })
    }
  }
  await ctx.plugin(ReviewedLoop, { agents: [] })
  await ctx.plugin(DefaultModel, { provider: 'm4', model: 'fixture' })
  return { ctx, project, outside, denied, enableFactoryGuard: () => { factoryGuard = true } }
}

it('a public native factory subclass can guard before persistence.create and preserve native setup commit', async () => {
  const { ctx, outside, project, denied, enableFactoryGuard } = await fixture()
  enableFactoryGuard()
  const storedCreate = vi.spyOn(ctx.sessionPersistence, 'create')
  await expect(ctx.agents.create({ sessionId: SessionId('blocked-create'), meta: { cwd: outside } })).rejects.toBe(denied)
  expect(storedCreate).not.toHaveBeenCalled()
  const order: string[] = []
  const id = SessionId('setup-commit')
  const handle = await ctx.agents.create({
    sessionId: id, meta: { cwd: project }, agentOptions: { provider: 'm4', model: 'fixture' },
    setup: async (_scope, agent) => {
      expect(ctx.agents.get(id)).toBeUndefined()
      order.push('original-setup')
      return { commit(): void { expect(ctx.agents.get(agent.id)).toBeUndefined(); order.push('original-commit') } }
    },
  })
  expect(order).toEqual(['original-setup', 'original-commit'])
  expect(ctx.agents.get(id)).toBe(handle.agent)
  expect(storedCreate).toHaveBeenCalledOnce()
})
