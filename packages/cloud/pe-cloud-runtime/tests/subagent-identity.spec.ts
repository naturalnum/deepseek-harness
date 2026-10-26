/** Independent native account components; no authenticated account, PG, sandbox or model API. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PeAccountRuntime } from '../src/root.ts'
import { policyFixture } from './account-policy-fixture.ts'

async function fixture(presetChildFiber?: 'active' | 'pending') {
  const root = new Context()
  const runtime = new PeAccountRuntime(root, { maxMountedAccounts: 2, maxConcurrentMounts: 2, maxConcurrentDrains: 2,
    subagentCapacity: { maxActivePerAccount: 4, maxActiveTotal: 4, maxDepth: 4 } })
  const capacity = runtime['capacity']
  const observed: ('confirmed' | 'unknown')[] = []
  const cleanup: { mounting?: ReturnType<typeof capacity.reserveMount> } = {}
  let closeBusiness = (): void => {}
  onTestFinished(async () => { if (!observed.includes('unknown')) cleanup.mounting?.releaseAccount(); await root.fiber.dispose() })
  const f = policyFixture([], undefined, 'b1-native-component', undefined, undefined, undefined, (binding, depth) => {
    const original = capacity.reserveSubagent(binding.accountId, depth)
    return { settle(status) { observed.push(status); original.settle(status); if (status === 'unknown') closeBusiness() } }
  }, presetChildFiber)
  const graph = await f.start()
  closeBusiness = () => { graph.closeBusiness() }
  const mounting = capacity.reserveMount(graph.binding.accountId); cleanup.mounting = mounting; mounting.settleMount()
  const created = await graph.ctx.sessionController.create({})
  const parent = graph.ctx.agents.get(created.sessionId)
  if (parent === undefined) throw new Error('Original root Agent absent')
  const spec = (selected: Agent = parent) => ({ provider: 'spawn', label: 'B1 real native child', delivery: 'caller' as const,
    request: { parent: selected, prompt: [{ type: 'text' as const, text: 'reply using the approved native composition' }], maxDepth: 4 },
    signal: new AbortController().signal })
  return { ...f, graph, parent, spec, root, runtime, capacity, observed, mounting }
}

it('uses A, the original cloud factory/checker, real Root capacity and native Session/Preset/Workspace for a completed spawn and cold resume', async () => {
  const f = await fixture()
  const started = await f.graph.ctx.subagents.startActivation(f.spec())
  await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
  expect(f.observed).toEqual(['confirmed'])
  expect(() => { f.capacity.assertSubagentsStopped(f.graph.binding.accountId) }).not.toThrow()
  using first = await f.graph.ctx.sessionQuery.observeSession(started.childId, { projectionMode: 'all' })
  expect(first.header.parentSession).toBe(f.parent.id)
  expect(first.header.agentPreset).toBe(f.config.presetId)
  expect(first.projections?.values.workingDirectory).toBe(f.project)
  expect(first.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  await vi.waitFor(() => { expect(f.graph.files.project().workspace.sessionIds).toContain(started.childId) })
  await f.graph.ctx.subagents.sendMessage(f.parent, started.childId, [{ type: 'text', text: 'continue the same persistent child' }], { signal: new AbortController().signal })
  await vi.waitFor(() => { expect(f.graph.ctx.agents.get(started.childId)).toBeUndefined() })
  expect(f.observed).toEqual(['confirmed', 'confirmed'])
  using second = await f.graph.ctx.sessionQuery.observeSession(started.childId, { projectionMode: 'all' })
  expect(second.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
  expect(f.graph.adapter.calls).toBeGreaterThanOrEqual(2)
})

it.each(['active', 'pending'] as const)('audits canonical preset Entries while preserving an owned %s inject fiber', async (state) => {
  const f = await fixture(state)
  const generation = scopeParentOf(scopeOf(f.parent.ctx)!)
  const fibers = [...f.graph.ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    .filter(fiber => scopeOf(fiber.ctx) === generation && fiber.entry?.options.name === 'cordis:m8z-persona')
  const root = fibers.find(fiber => fiber.entry?.fiber === fiber)
  const child = fibers.find(fiber => fiber.entry !== undefined && fiber.parent.fiber?.entry === fiber.entry)
  expect(root?.state).toBe(FiberState.ACTIVE)
  expect(child).toBeDefined()
  expect(child?.state).toBe(state === 'active' ? FiberState.ACTIVE : FiberState.PENDING)
  expect(child?.entry).toBe(root?.entry)
  const started = await f.graph.ctx.subagents.startActivation(f.spec())
  await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
  expect(f.observed).toEqual(['confirmed'])
  using observed = await f.graph.ctx.sessionQuery.observeSession(started.childId, { projectionMode: 'all' })
  expect(observed.header.parentSession).toBe(f.parent.id)
  expect(observed.header.agentPreset).toBe(f.config.presetId)
  expect(observed.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
})

it('keeps two native delegation levels on the same approved standing generation and exact Workspace', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const stream = f.graph.adapter.stream.bind(f.graph.adapter)
  let first = true
  vi.spyOn(f.graph.adapter, 'stream').mockImplementation(async function* (options) {
    if (first) { first = false; entered.resolve(undefined); await release.promise }
    yield* stream(options)
  })
  const generations = new Map<import('@deepseek-ai/dsh-session').SessionId, ReturnType<typeof scopeParentOf>>()
  f.graph.ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') generations.set(agent.id, scopeParentOf(scopeOf(agent.ctx)!)) })
  const child = await f.graph.ctx.subagents.startActivation(f.spec())
  await entered.promise
  const agent = f.graph.ctx.agents.get(child.childId)!
  await vi.waitFor(() => { expect(f.graph.files.project().workspace.sessionIds).toContain(agent.id) })
  const grandchild = await f.graph.ctx.subagents.startActivation(f.spec(agent))
  expect(generations.has(grandchild.childId)).toBe(true)
  expect(generations.get(grandchild.childId) === generations.get(child.childId)).toBe(true)
  expect(generations.get(grandchild.childId) === scopeParentOf(scopeOf(f.parent.ctx)!)).toBe(true)
  await expect(grandchild.result).resolves.toMatchObject({ stopReason: 'completed' })
  release.resolve(undefined)
  await expect(child.result).resolves.toMatchObject({ stopReason: 'completed' })
  expect(f.observed).toEqual(['confirmed', 'confirmed'])
})

it.each(['cwd', 'model', 'preset'] as const)('rejects unapproved %s before original spawn preparation and native persistence', async (invalid) => {
  const f = await fixture(), provider = f.graph.ctx.subagents.getProvider('spawn')!
  const prepare = vi.spyOn(provider, 'prepareContinuable'), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  const spec = f.spec()
  const request = { ...spec.request, ...invalid === 'cwd' ? { cwd: f.privateRoot } : {},
    ...invalid === 'model' ? { agentOptions: { provider: 'local-text', model: 'not-approved' } } : {},
    ...invalid === 'preset' ? { agentPreset: 'standard' } : {} }
  await expect(f.graph.ctx.subagents.startActivation({ ...spec, request })).rejects.toBeDefined()
  expect(prepare).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('rejects a cloned Parent object at both A and the actual cloud factory before native creation', async () => {
  const f = await fixture(), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  const clone = { ...f.parent }
  await expect(f.graph.ctx.subagents.startActivation(f.spec(clone))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('cloned-parent-child'), parentAgent: clone,
    meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.presetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' } })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(create).not.toHaveBeenCalled()
})

it('refuses a caller-supplied disposal observer before reserving or creating a child', async () => {
  const f = await fixture(), supplied = vi.fn(), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('caller-observer'), parentAgent: f.parent,
    meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.presetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' }, observeDisposal: supplied })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(create).not.toHaveBeenCalled(); expect(supplied).not.toHaveBeenCalled(); expect(f.observed).toEqual([])
})

it('rechecks exact Parent after awaited native model resolution without entering provider preparation', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const resolve = f.graph.ctx.llm.resolveModelInfo.bind(f.graph.ctx.llm)
  vi.spyOn(f.graph.ctx.llm, 'resolveModelInfo').mockImplementation(async (...args) => { entered.resolve(undefined); await release.promise; return resolve(...args) })
  const prepare = vi.spyOn(f.graph.ctx.subagents.getProvider('spawn')!, 'prepareContinuable')
  const starting = f.graph.ctx.subagents.startActivation(f.spec()), rejected = expect(starting).rejects.toBeDefined()
  await entered.promise
  const parent = f.graph.ctx.agents.get(f.parent.id)!
  await parent.ctx.fiber.dispose()
  release.resolve(undefined)
  await rejected
  expect(prepare).not.toHaveBeenCalled()
  expect(f.observed).toEqual([])
})

it.each([undefined, 'active', 'pending'] as const)('rejects a same-name Preset module replacement with %s owned inject after asynchronous checks', async (state) => {
  const f = await fixture(state), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const resolve = f.graph.ctx.llm.resolveModelInfo.bind(f.graph.ctx.llm)
  vi.spyOn(f.graph.ctx.llm, 'resolveModelInfo').mockImplementation(async (...args) => { entered.resolve(undefined); await release.promise; return resolve(...args) })
  const prepare = vi.spyOn(f.graph.ctx.subagents.getProvider('spawn')!, 'prepareContinuable')
  const starting = f.graph.ctx.subagents.startActivation(f.spec()), rejected = expect(starting).rejects.toBeDefined()
  await entered.promise
  const entry = [...f.graph.ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).map(fiber => fiber.entry)
    .find(candidate => candidate?.options.name === 'cordis:m8z-persona')
  if (entry === undefined) throw new Error('Actual native composition entry absent')
  const original = entry.moduleNamespace
  try { entry.moduleNamespace = {}; release.resolve(undefined); await rejected }
  finally { entry.moduleNamespace = original }
  expect(prepare).not.toHaveBeenCalled()
  expect(f.observed).toEqual([])
})

it.each(['provider', 'business'] as const)('rechecks %s approval after actual suffix append awaits and before either creation notification', async (revoke) => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const create = f.graph.ctx.sessionPersistence.create.bind(f.graph.ctx.sessionPersistence)
  vi.spyOn(f.graph.ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const handle = await create(...args)
    if (args[0].origin === 'subagent') {
      const append = handle.append.bind(handle)
      vi.spyOn(handle, 'append').mockImplementation(async (...entries) => { entered.resolve(undefined); await release.promise; return append(...entries) })
    }
    return handle
  })
  const notices: string[] = []
  f.graph.ctx.on('session/created', (session) => { if (session.header.origin === 'subagent') notices.push('session') })
  f.graph.ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') notices.push('agent') })
  const starting = f.graph.ctx.subagents.startActivation(f.spec()), rejected = expect(starting).rejects.toBeDefined()
  await entered.promise
  if (revoke === 'business') f.graph.closeBusiness()
  else {
    const provider = f.graph.ctx.subagents.getProvider('spawn')!
    await [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'spawn')!.update({ disabled: true })
    f.graph.ctx.subagents.registerProvider(provider)
  }
  release.resolve(undefined)
  await rejected
  expect(notices).toEqual([])
  expect(f.graph.adapter.calls).toBe(0)
  expect(f.observed).toEqual(['confirmed'])
})

it('retains a real late-setup unknown reservation and immediately closes original component business admission', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const caller = new AbortController(), failure = new Error('caller stops waiting for real child setup')
  const creating = f.graph.ctx.agents.create({ sessionId: SessionId('late-real-child'), parentAgent: f.parent,
    meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.presetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' }, signal: caller.signal,
    setup: async (owner, agent) => {
      await f.graph.ctx.agentPresets.mount(owner, f.config.presetId)
      await owner.get('workingDirectory')!.set(agent, f.project)
      entered.resolve(undefined); await release.promise; finished.resolve(undefined)
    },
  })
  const rejected = expect(creating).rejects.toBe(failure)
  await entered.promise
  caller.abort(failure)
  await rejected
  expect(f.observed).toEqual(['unknown'])
  await expect(f.graph.api.assertBootstrapCurrent(f.graph.ctx)).rejects.toThrow('business admission is closed')
  expect(f.graph.binding.lifetime.aborted).toBe(false)
  expect(() => { f.capacity.assertSubagentsStopped(f.graph.binding.accountId) }).toThrow()
  expect(() => { f.mounting.releaseAccount() }).toThrow()
  release.resolve(undefined); await finished.promise
  expect(f.observed).toEqual(['unknown'])
})

it.each(['create', 'resume'] as const)('checks actual runtime depth against the same Root hard limit before native write ownership: %s', async (operation) => {
  const f = await fixture(), child = await f.graph.ctx.subagents.startActivation(f.spec())
  await child.result
  const create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create'), open = vi.spyOn(f.graph.ctx.sessionPersistence, 'open')
  const options = { parentAgent: f.parent, agentOptions: { provider: 'local-text', model: 'plain-text', subagentDepth: 100 } }
  const starting = operation === 'create'
    ? f.graph.ctx.agents.create({ ...options, sessionId: SessionId('runtime-depth-child'),
      meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.presetId } })
    : f.graph.ctx.agents.resume({ ...options, resumeSessionId: child.childId })
  await expect(starting).rejects.toMatchObject({ code: operation === 'create' ? 'cloud/forbidden' : 'cloud/capacity' })
  expect(create).not.toHaveBeenCalled()
  expect(open.mock.calls.filter(call => call[1] === 'write')).toEqual([])
  expect(f.observed).toEqual(['confirmed'])
})

it('keeps the existing cloud factory closed when no original Root reservation callback is selected', async () => {
  const f = policyFixture(), graph = await f.start(), created = await graph.ctx.sessionController.create({})
  const parent = graph.ctx.agents.get(created.sessionId)!, create = vi.spyOn(graph.ctx.sessionPersistence, 'create')
  await expect(graph.ctx.agents.create({ sessionId: SessionId('closed-child'), parentAgent: parent,
    meta: { cwd: f.project, origin: 'subagent', parentSession: parent.id, delegationDepth: 1, agentPreset: f.config.presetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' } })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(create).not.toHaveBeenCalled()
})

it('rejects an equal-id replacement Workspace after await using the original Registry object', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const resolve = f.graph.ctx.llm.resolveModelInfo.bind(f.graph.ctx.llm)
  vi.spyOn(f.graph.ctx.llm, 'resolveModelInfo').mockImplementation(async (...args) => { entered.resolve(undefined); await release.promise; return resolve(...args) })
  const prepare = vi.spyOn(f.graph.ctx.subagents.getProvider('spawn')!, 'prepareContinuable')
  const starting = f.graph.ctx.subagents.startActivation(f.spec()), rejected = expect(starting).rejects.toBeDefined()
  await entered.promise
  const workspace = f.graph.files.project().workspace, clone = new Proxy(workspace, {})
  const get = f.graph.ctx.workspaceRegistry.get.bind(f.graph.ctx.workspaceRegistry)
  const replaced = vi.spyOn(f.graph.ctx.workspaceRegistry, 'get').mockImplementation(id => id === workspace.id ? clone : get(id))
  try { release.resolve(undefined); await rejected } finally { replaced.mockRestore() }
  expect(prepare).not.toHaveBeenCalled()
  expect(f.observed).toEqual([])
})

it('rejects another native graph parent with a different real binding at A and actual factory admission', async () => {
  const f = await fixture(), other = policyFixture([], undefined, 'other-b1-component'), graph = await other.start()
  const created = await graph.ctx.sessionController.create({}), parent = graph.ctx.agents.get(created.sessionId)!
  const create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  await expect(f.graph.ctx.subagents.startActivation(f.spec(parent))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('foreign-parent-child'), parentAgent: parent,
    meta: { cwd: f.project, origin: 'subagent', parentSession: parent.id, delegationDepth: 1, agentPreset: f.config.presetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' } })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(create).not.toHaveBeenCalled()
})

it('closes original business admission before provider work when the original current callback rejects', async () => {
  const f = await fixture(), prepare = vi.spyOn(f.graph.ctx.subagents.getProvider('spawn')!, 'prepareContinuable')
  const create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  f.graph.closeBusiness()
  await expect(f.graph.ctx.subagents.startActivation(f.spec())).rejects.toThrow('business admission is closed')
  expect(prepare).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(f.observed).toEqual([])
})

it('retains unknown for rejected original Workspace persistence without replacing the original metadata error', async () => {
  const f = await fixture(), failure = new Error('original Workspace membership outcome is unknown')
  vi.spyOn(f.graph.files.project().workspace, 'attachSession').mockRejectedValue(failure)
  await expect(f.graph.ctx.subagents.startActivation(f.spec())).rejects.toBe(failure)
  expect(f.observed).toEqual(['unknown'])
  await expect(f.graph.api.assertBootstrapCurrent(f.graph.ctx)).rejects.toThrow('business admission is closed')
  expect(() => { f.capacity.assertSubagentsStopped(f.graph.binding.accountId) }).toThrow()
  expect(() => { f.mounting.releaseAccount() }).toThrow()
})
