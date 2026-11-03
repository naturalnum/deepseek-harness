/** Real Native selection queue, driver maintenance and Inbox; only the external model is scripted. */
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import AgentPresets from '../src/index.ts'
import { contribution, declare, harness } from './harness.ts'

async function fixture() {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const calls: string[] = [], pending: Promise<unknown>[] = []
  class PausedPresets extends AgentPresets {
    override async recompose(scope: Context, id: string) {
      calls.push(id)
      if (calls.length === 1) { entered.resolve(undefined); await release.promise }
      return super.recompose(scope, id)
    }
  }
  const ctx = await harness({ registry: PausedPresets })
  const owned: { agent?: Agent } = {}
  onTestFinished(async () => {
    release.resolve(undefined)
    owned.agent?.cancel({ kind: 'disposed' })
    await Promise.allSettled(pending)
    await owned.agent?.whenIdle()
    await ctx.fiber.dispose()
  })
  const adapter = new MockAdapter([textResponse('reply after native selection')])
  ctx.llm.registerAdapter(['mock'], adapter)
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = (await ctx.agents.create({ sessionId: SessionId('maintenance-selection'),
    agentOptions: { provider: 'mock', model: 'mock' }, meta: { agentPreset: 'standard' },
    setup: async (scope) => { await ctx.agentPresets.mount(scope, 'standard') },
  })).agent
  owned.agent = agent
  const select = (id: string) => {
    const promise = ctx.agentPresets.select(agent, id)
    pending.push(promise)
    return promise
  }
  return { ctx, agent, adapter, calls, entered, release, select, pending }
}

it.each(['followup', 'steer', 'send'] as const)('holds real %s input in the original Inbox until selection commits', async (delivery) => {
  const f = await fixture(), selecting = f.select('minimal')
  await f.entered.promise
  const message = createUserMessage({ content: [{ type: 'text', text: 'held ' + delivery }], source: { kind: 'user' } })
  if (delivery === 'send') f.agent.send(message, 'next-turn', true)
  else f.agent[delivery](message)
  expect(f.agent.inbox.nextTurn.length + f.agent.inbox.nextStep.length).toBe(1)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
  expect(f.adapter.requests).toHaveLength(0)
  f.release.resolve(undefined)
  await expect(selecting).resolves.toBe('minimal')
  await f.agent.whenIdle()
  const events = f.agent.session.snapshotEvents()
  const selected = events.findIndex(event => event.type === 'agent-preset/selected')
  expect(selected).toBeGreaterThanOrEqual(0)
  expect(events.findIndex(event => event.type === 'turn/start')).toBeGreaterThan(selected)
  expect(f.ctx.agentPresets.composedPreset(f.agent.ctx)).toBe('minimal')
  expect(f.adapter.requests).toHaveLength(1)
})

it('keeps a second selection in the original per-Agent queue until the first maintenance activity settles', async () => {
  const f = await fixture(), first = f.select('minimal')
  await f.entered.promise
  const second = f.select('standard')
  expect(f.calls).toEqual(['minimal'])
  f.release.resolve(undefined)
  await expect(first).resolves.toBe('minimal')
  await expect(second).resolves.toBe('standard')
  expect(f.calls).toEqual(['minimal', 'standard'])
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected').map(event => event.data.agentPreset))
    .toEqual(['minimal', 'standard'])
  expect(f.adapter.requests).toHaveLength(0)
})

it('clears cancelled queued input while joining the actual recomposition instead of abandoning it', async () => {
  const f = await fixture(), selecting = f.select('minimal')
  await f.entered.promise
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel queued input' }], source: { kind: 'user' } }))
  f.agent.cancel({ kind: 'user' })
  expect(f.agent.inbox.nextTurn).toHaveLength(0)
  expect(f.agent.inbox.nextStep).toHaveLength(0)
  f.release.resolve(undefined)
  await expect(selecting).resolves.toBe('minimal')
  await f.agent.whenIdle()
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
  expect(f.ctx.agentPresets.composedPreset(f.agent.ctx)).toBe('minimal')
  expect(f.adapter.requests).toHaveLength(0)
})

it('rechecks the original started-session lock for a second selection after a queued prompt wakes', async () => {
  const f = await fixture(), first = f.select('minimal')
  await f.entered.promise
  const second = f.select('standard'), rejected = expect(second).rejects.toMatchObject({ code: 'agent-preset/locked' })
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start after first selection' }], source: { kind: 'user' } }))
  f.release.resolve(undefined)
  await expect(first).resolves.toBe('minimal')
  await rejected
  await f.agent.whenIdle()
  expect(f.calls).toEqual(['minimal'])
  expect(f.ctx.agentPresets.composedPreset(f.agent.ctx)).toBe('minimal')
})

it('joins selection maintenance when the original AgentLoop stops', async () => {
  const f = await fixture(), selecting = f.select('minimal')
  await f.entered.promise
  const stopping = f.ctx.agentLoop.stop()
  f.pending.push(stopping)
  expect(f.ctx.agents.get(f.agent.id)).toBe(f.agent)
  f.release.resolve(undefined)
  await expect(selecting).resolves.toBe('minimal')
  await stopping
  expect(f.ctx.agents.get(f.agent.id)).toBeUndefined()
  expect(f.adapter.requests).toHaveLength(0)
})
