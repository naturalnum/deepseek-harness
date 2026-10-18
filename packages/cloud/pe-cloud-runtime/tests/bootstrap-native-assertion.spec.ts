/** Actual Loader/API/policy reads; component lifetimes never grant production AccountUse or Root seal. */
import { FiberState, symbols, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { expect, it, vi } from 'vitest'
import { policyFixture } from './account-policy-fixture.ts'

function same(a: object, b: object): boolean {
  return (Reflect.get(a, symbols.original) ?? a) === (Reflect.get(b, symbols.original) ?? b)
}

it('reads the same actual native policy through the original traced API without preparing directories or business writes', async () => {
  const graph = await policyFixture().start()
  const project = graph.files.project()
  const policy = vi.spyOn(graph.guards, 'assertBootstrapCurrent')
  const directoryCalls = graph.directoryCalls.length
  const create = vi.spyOn(graph.ctx.sessionPersistence, 'create')
  const resolve = vi.spyOn(graph.ctx.credentials, 'resolve')
  const presets = vi.spyOn(graph.ctx.agentPresets, 'resolve')
  const metadata = vi.spyOn(graph.adapter, 'resolveModel')
  const api = graph.ctx.get('peCloudApi')
  expect(api).toBeDefined()
  await expect(api?.assertBootstrapCurrent(graph.ctx)).resolves.toBeUndefined()
  expect(policy).toHaveBeenCalledTimes(1)
  expect(presets).toHaveBeenCalled()
  expect(metadata).toHaveBeenCalledWith('local-text', 'plain-text', expect.any(AbortSignal))
  expect(graph.files.project() === project).toBe(true)
  expect(graph.directoryCalls.length).toBe(directoryCalls)
  expect(create).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled()
  expect(graph.ctx.sessions.list()).toEqual([])
  expect(graph.adapter.calls).toBe(0)
})

it('keeps a legacy preparation usable but refuses bootstrap without the original shared callback', async () => {
  const fixture = policyFixture(), graph = await fixture.start('1', fixture.config, false)
  const policy = vi.spyOn(graph.guards, 'assertBootstrapCurrent')
  graph.api.assertInstalled(graph.ctx)
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(policy).not.toHaveBeenCalled()
})

const inventoryCases: { label: string; inventory: { maxNativeInventoryEntries?: number } }[] = [
  { label: 'missing', inventory: {} },
  { label: 'invalid', inventory: { maxNativeInventoryEntries: 0 } },
  { label: 'smaller than the complete selected exposure lists', inventory: { maxNativeInventoryEntries: 1 } },
]

it.each(inventoryCases)('refuses a $label inventory budget before shared policy metadata', async ({ inventory }) => {
  const fixture = policyFixture(), graph = await fixture.start('1', fixture.config, true, inventory)
  const policy = vi.spyOn(graph.guards, 'assertBootstrapCurrent')
  const metadata = vi.spyOn(graph.adapter, 'resolveModel')
  const traversal = vi.spyOn(graph.ctx.registry, 'values')
  graph.api.assertInstalled(graph.ctx)
  try {
    await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(traversal).not.toHaveBeenCalled()
  } finally { traversal.mockRestore() }
  expect(policy).not.toHaveBeenCalled()
  expect(metadata).not.toHaveBeenCalled()
})

it('charges actual same-graph runtimes and fibers before the shared policy without removing uniqueness checks', async () => {
  const graph = await policyFixture().start()
  await graph.api.assertBootstrapCurrent(graph.ctx)
  const policy = vi.spyOn(graph.guards, 'assertBootstrapCurrent')
  const additions: Fiber[] = []
  let entries = 0
  try {
    while (entries <= graph.maxEntries && additions.length < graph.maxEntries) {
      const added = graph.ctx.plugin({ apply() {} })
      await added
      additions.push(added)
      entries = 0
      for (const runtime of graph.ctx.registry.values()) {
        entries++
        for (const _fiber of runtime.fibers) entries++
      }
    }
    expect(entries).toBeGreaterThan(graph.maxEntries)
    await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(policy).not.toHaveBeenCalled()
  } finally { for (const added of additions.toReversed()) await added.dispose() }
})

it('rejects repeat native installations before changing the actual original providers or listener', async () => {
  const graph = await policyFixture().start()
  const controller = graph.ctx.sessionController, loop = graph.ctx.agentLoop, llm = graph.ctx.llm
  const rejected = { code: 'cloud/invalid-config' }
  expect(() => graph.api.createController(graph.ctx, { ...graph.guards.sessions,
    projectDirectory: graph.files.project().projectDirectory }, { nativeOpen: false })).toThrow(expect.objectContaining(rejected))
  expect(() => graph.api.createAgentLoop(graph.ctx, graph.guards.agents, AgentLoop.Config({ agents: [] })))
    .toThrow(expect.objectContaining(rejected))
  expect(() => graph.api.installLlmGuard(graph.ctx, graph.guards.allowedModel)).toThrow(expect.objectContaining(rejected))
  expect(same(graph.ctx.sessionController, controller)).toBe(true)
  expect(same(graph.ctx.agentLoop, loop)).toBe(true)
  expect(same(graph.ctx.llm, llm)).toBe(true)
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).resolves.toBeUndefined()
  graph.withdrawLlmGuard()
  expect(same(graph.ctx.llm, llm)).toBe(true)
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(() => graph.api.installLlmGuard(graph.ctx, graph.guards.allowedModel)).toThrow(expect.objectContaining(rejected))
})

it('rejects an actual second isolated LlmRuntime even while the global original remains installed', async () => {
  const graph = await policyFixture().start(), original = graph.ctx.llm
  const extra = graph.ctx.plugin({ apply(ctx) { new LlmRuntime(ctx.isolate('llm')) } })
  await extra
  expect(extra.state).toBe(FiberState.ACTIVE)
  expect(same(graph.ctx.llm, original)).toBe(true)
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await extra.dispose()
})

it('rejects a foreign actual LlmRuntime set by its native provider owner and a foreign consumer scope', async () => {
  const graph = await policyFixture().start(), other = await policyFixture().start()
  const owner = [...graph.ctx.loader.entries()].find(row => row.options.id === 'llm')?.fiber?.ctx
  if (owner === undefined) throw new Error('Native LLM owner absent')
  const original: unknown = owner.fiber.store?.llm?.value
  if (!(original instanceof LlmRuntime)) throw new Error('Original native LLM absent')
  try {
    owner.set('llm', other.ctx.llm)
    await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  } finally { owner.set('llm', original) }
  await expect(graph.api.assertBootstrapCurrent(other.ctx)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).resolves.toBeUndefined()
})

it.each(['controller', 'agent-loop', 'llm'])('refuses after actual native %s owner disposal', async (id) => {
  const graph = await policyFixture().start()
  await graph.api.assertBootstrapCurrent(graph.ctx)
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === id)
  expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
  await entry?.fiber?.dispose()
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('rejects a real provider removal while the external native metadata read is pending', async () => {
  const graph = await policyFixture().start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const checking = graph.api.assertBootstrapCurrent(graph.ctx)
  const rejected = expect(checking).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
  try { await entered.promise; graph.withdrawProvider() }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.adapter.calls).toBe(0)
})

it('rechecks the actual default selection after the asynchronous model metadata read', async () => {
  const graph = await policyFixture().start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const checking = graph.api.assertBootstrapCurrent(graph.ctx)
  const rejected = expect(checking).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  try { await entered.promise; await graph.ctx.agentDefaultModel.saveSelection({ provider: 'local-text', model: 'changed' }) }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.adapter.calls).toBe(0)
})

it('retains caller cancellation through a pending external metadata read without inference or writes', async () => {
  const graph = await policyFixture().start(), caller = new AbortController(), reason = new Error('Metadata observer cancelled')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const checking = graph.api.assertBootstrapCurrent(graph.ctx, caller.signal)
  const rejected = expect(checking).rejects.toBe(reason)
  try { await entered.promise; caller.abort(reason) }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.ctx.sessions.list()).toEqual([])
  expect(graph.adapter.calls).toBe(0)
})

it('rechecks original API admission after its policy read and rejects a revoked exposure audit', async () => {
  const graph = await policyFixture().start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const checking = graph.api.assertBootstrapCurrent(graph.ctx)
  const rejected = expect(checking).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  try { await entered.promise; graph.api.invalidate() }
  finally { release.resolve(undefined) }
  await rejected
})

it('rechecks the actual original listener after awaited policy metadata returns', async () => {
  const graph = await policyFixture().start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const checking = graph.api.assertBootstrapCurrent(graph.ctx)
  const rejected = expect(checking).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  try { await entered.promise; graph.withdrawLlmGuard() }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.adapter.calls).toBe(0)
})

it('reads the original Workspace and native Preset expectation instead of trusting policy declarations alone', async () => {
  const fixture = policyFixture(), wrong = await fixture.start('1', { ...fixture.config, presetConfigSha256: '0'.repeat(64) })
  await expect(wrong.api.assertBootstrapCurrent(wrong.ctx)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await wrong.close()
  const graph = await fixture.start('2')
  await graph.api.assertBootstrapCurrent(graph.ctx)
  await graph.ctx.workspaceRegistry.delete(graph.files.project().workspace.id)
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toThrow()
  expect(graph.adapter.calls).toBe(0)
})
