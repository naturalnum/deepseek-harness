/** Real Native plan/update paths inside the account fixture; not deployed Web or timing evidence. */
import { FiberState, type Fiber } from '@deepseek-ai/cordis'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import { expect, it, vi } from 'vitest'
import { createAccountPolicy } from '../src/account-policy.ts'
import { policyFixture } from './account-policy-fixture.ts'

async function fixture() {
  const f = policyFixture(), graph = await f.start()
  const entries = [...graph.ctx.loader.entries()]
  const preset = entries.find(row => row.options.id === f.config.presets[0]?.entryId)
  const loop = entries.find(row => row.options.id === f.config.agentLoopEntryId)
  if (preset?.fiber === undefined || loop?.fiber === undefined) throw new Error('Original account entries absent')
  const policy = createAccountPolicy(graph.ctx, graph.binding, graph.files, f.config,
    f.exposureOwner.policy, graph.maxEntries)
  return { f, graph, preset, loop, policy, workspace: graph.files.project().workspace }
}

it('fully validates the fixed account plans once and reuses their Native revisions for repeated reads', async () => {
  const f = await fixture()
  const full = [vi.spyOn(f.preset, 'assertConfigUpdatePlan'), vi.spyOn(f.loop, 'assertConfigUpdatePlan')]
  await f.policy.sessions.resolveCreate({})
  for (const check of full) expect(check).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 20; index++) f.policy.assertWorkspace(f.workspace)
  for (const check of full) expect(check).toHaveBeenCalledTimes(1)
})

it.each([false, true])('rejects during the actual Fiber update waterfall (noSave: %s)', async (noSave) => {
  const f = await fixture()
  await f.policy.sessions.resolveCreate({})
  const fiber = f.loop.fiber
  if (fiber === undefined) throw new Error('Original Loop fiber absent')
  let observed = false
  const blocked = new Error('The original update observer vetoed the restart')
  f.graph.ctx.on('internal/update', function (this: Fiber, _config, _noSave, next) {
    if (this === fiber) {
      observed = true
      expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      throw blocked
    }
    next()
  }, { global: true, prepend: true })
  expect(() => { fiber.update({ agents: [], maxParallelToolCalls: 2 }, noSave) }).toThrow(blocked)
  expect(observed).toBe(true)
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects reentrant admission while an invalid Native Fiber update is being resolved', async () => {
  const f = await fixture()
  await f.policy.sessions.resolveCreate({})
  const fiber = f.loop.fiber
  if (fiber === undefined) throw new Error('Original Loop fiber absent')
  const before = fiber.configMutationRevision
  let observed = false
  f.graph.ctx.on('internal/config', function (this: Fiber, _config, next) {
    if (this === fiber) {
      observed = true
      expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }
    const resolved: unknown = next()
    return resolved
  }, { global: true, prepend: true })
  expect(() => { fiber.update({ agents: [], maxParallelToolCalls: 0 }, true) }).toThrow()
  expect(observed).toBe(true)
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(fiber.configMutationRevision).toBe(before + 1)
  expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects an out-of-band Native EntryTree update without repinning the account declaration', async () => {
  const f = await fixture()
  await f.policy.sessions.resolveCreate({})
  await f.loop.parent.tree.update(f.loop.options.id, { config: { agents: [], maxParallelToolCalls: 2 } })
  expect(f.graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects during the Native parent move before the Entry update has run', async () => {
  const f = await fixture(), tree = f.loop.parent.tree
  f.graph.ctx.loader.builtins['account-plan-group'] = Group
  const options = { id: 'account-plan-group', name: 'cordis:account-plan-group', group: true, config: [] }
  await tree.create(options)
  await f.policy.sessions.resolveCreate({})
  const originalWrite = tree.write.bind(tree)
  let observed = false
  const write = vi.spyOn(tree, 'write').mockImplementation(() => {
    if (f.loop.parent !== previous) {
      observed = true
      expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }
    originalWrite()
  })
  const previous = f.loop.parent
  try {
    await tree.update(f.loop.options.id, {}, options.id)
    expect(observed).toBe(true)
    expect(() => { f.policy.assertWorkspace(f.workspace) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  } finally { write.mockRestore() }
})

it('checks all captured revisions after the last initial full validation reenters a failed Native update', async () => {
  const f = await fixture(), full = f.loop.assertConfigUpdatePlan.bind(f.loop)
  const resolve = vi.spyOn(f.graph.ctx.agentPresets, 'resolve')
  const fiber = f.preset.fiber
  if (fiber === undefined) throw new Error('Original Preset fiber absent')
  let observed = false
  vi.spyOn(f.loop, 'assertConfigUpdatePlan').mockImplementationOnce((plan) => {
    full(plan)
    observed = true
    expect(() => { fiber.update({ id: 3, plugins: [] }, true) }).toThrow()
  })
  await expect(f.policy.sessions.resolveCreate({})).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(observed).toBe(true)
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(resolve).not.toHaveBeenCalled()
})

it('checks captured lifecycle after the last initial full validation disposes a preceding Native fiber', async () => {
  const f = await fixture(), full = f.loop.assertConfigUpdatePlan.bind(f.loop)
  const resolve = vi.spyOn(f.graph.ctx.agentPresets, 'resolve')
  const fiber = f.preset.fiber
  if (fiber === undefined) throw new Error('Original Preset fiber absent')
  let settled: Promise<void> | undefined
  vi.spyOn(f.loop, 'assertConfigUpdatePlan').mockImplementationOnce((plan) => {
    full(plan)
    settled = fiber.dispose()
  })
  await expect(f.policy.sessions.resolveCreate({})).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await settled
  expect(fiber.state).toBe(FiberState.DISPOSED)
  expect(resolve).not.toHaveBeenCalled()
})

it('rejects an ended binding during initial full validation before resolving the Preset', async () => {
  const f = await fixture(), full = f.loop.assertConfigUpdatePlan.bind(f.loop)
  const resolve = vi.spyOn(f.graph.ctx.agentPresets, 'resolve')
  vi.spyOn(f.loop, 'assertConfigUpdatePlan').mockImplementationOnce((plan) => {
    full(plan)
    f.graph.lifetime.abort()
  })
  await expect(f.policy.sessions.resolveCreate({})).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(resolve).not.toHaveBeenCalled()
})
