/** Original Native Loader/preset/Agent state; no deployment, Root readiness or SSH qualification. */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { contribution, declare, harness } from '../../../preset/agent-preset-registry/tests/harness.ts'
import { assertStandardRemoteAgent } from '../src/account-remote-standard.ts'

it.each(['standard', 'ptc', 'minimal', 'creative', 'cordis'])(
  'admits Remote only when the actual composition and committed selection are Standard (%s)', async (preset) => {
    const ctx = await harness()
    try {
      await declare(ctx, contribution(preset))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('remote-mode-' + preset),
        meta: { agentPreset: preset }, setup: async (scope) => { await ctx.agentPresets.mount(scope, preset) } })
      if (preset === 'standard') expect(() => { assertStandardRemoteAgent(ctx, agent) }).not.toThrow()
      else {
        expect(() => { assertStandardRemoteAgent(ctx, agent) }).toThrow('Remote execution requires the original Standard composition.')
        agent.session.append('agent-preset/selected', { agentPreset: 'standard' })
        expect(() => { assertStandardRemoteAgent(ctx, agent) }).toThrow('Remote execution requires the original Standard composition.')
      }
    } finally { await ctx.fiber.dispose() }
  },
)

it('refuses a Standard composition after its committed selection changes', async () => {
  const ctx = await harness()
  try {
    await declare(ctx, contribution('standard'))
    const { agent } = await ctx.agents.create({ sessionId: SessionId('remote-selected-changed'),
      meta: { agentPreset: 'standard' }, setup: async (scope) => { await ctx.agentPresets.mount(scope, 'standard') } })
    assertStandardRemoteAgent(ctx, agent)
    agent.session.append('agent-preset/selected', { agentPreset: 'ptc' })
    expect(() => { assertStandardRemoteAgent(ctx, agent) }).toThrow('Remote execution requires the original Standard composition.')
  } finally { await ctx.fiber.dispose() }
})
