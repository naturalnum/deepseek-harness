/** Actual Loader and native account policy observation; component fixture is not production ready. */
import { expect, it } from 'vitest'
import { policyFixture } from './account-policy-fixture.ts'

it('rejects an out-of-band ConfigEditor change even when the live Loop accepted it', async () => {
  const f = policyFixture(), graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const entry = graph.ctx.configEditor.entries().find(row => row.options.id === 'agent-loop')
  if (entry === undefined) throw new Error('Original AgentLoop entry missing')
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  await graph.ctx.configEditor.edit(entry, raw => ({ ...raw, maxParallelToolCalls: 2 }))
  await graph.ctx.loader.await()
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})
