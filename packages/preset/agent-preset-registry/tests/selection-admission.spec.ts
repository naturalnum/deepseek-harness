import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets from '../src/index.ts'
import { agentOn, contribution, declare, harness } from './harness.ts'

it('rechecks deployment admission after native recomposition and before logging the selection', async () => {
  let current = true
  const checks: string[] = []
  const recomposed = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  class GuardedPresets extends AgentPresets {
    protected override assertSelectionCurrent(_agent: Agent, id: string): void {
      checks.push(id)
      if (!current) throw new Error('selection generation ended')
    }

    override async recompose(ctx: Context, id: string) {
      const result = await super.recompose(ctx, id)
      recomposed.resolve(undefined)
      await release.promise
      return result
    }
  }
  const ctx = await harness({ registry: GuardedPresets })
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'guarded-selection', 'standard')
  const selection = ctx.agentPresets.select(agent, 'minimal')
  const failure = expect(selection).rejects.toThrow('selection generation ended')
  await recomposed.promise
  current = false
  release.resolve(undefined)
  await failure
  expect(checks).toEqual(['minimal', 'minimal'])
  expect(ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).not.toBe('minimal')
})

it('refuses a queued selection before changing its native composition', async () => {
  class ClosedPresets extends AgentPresets {
    protected override assertSelectionCurrent(): void { throw new Error('selection unavailable') }
  }
  const ctx = await harness({ registry: ClosedPresets })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'closed-selection', 'standard')
  await expect(ctx.agentPresets.select(agent, 'minimal')).rejects.toThrow('selection unavailable')
  expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
})
