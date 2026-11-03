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
  expect(first.header.agentPreset).toBe(f.config.defaultPresetId)
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

it('reuses the Native fork completed-turn seed, own descriptor and cold continuation without re-forking newer parent turns', async () => {
  const f = await fixture()
  await f.graph.invoke('prompt', { sessionId: f.parent.id, requestId: 'native-fork-parent-first', mode: 'followup',
    content: [{ type: 'text', text: 'Complete the original parent turn.' }] })
  await f.parent.whenIdle()
  using parent = await f.graph.ctx.sessionQuery.observeSession(f.parent.id)
  const completed = parent.events.findLast(event => event.type === 'turn/end')
  if (completed === undefined) throw new Error('Native parent turn did not complete')
  const inherited = parent.events.slice(0, completed.seq + 1)
  const started = await f.graph.ctx.subagents.startActivation({ ...f.spec(), provider: 'fork' })
  await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
  using first = await f.graph.ctx.sessionQuery.observeSession(started.childId, { projectionMode: 'all' })
  expect(first.header).toMatchObject({ isSeeded: true, parentSession: f.parent.id, origin: 'subagent' })
  expect(first.inheritedEventCount).toBe(inherited.length)
  expect(first.events.slice(0, first.inheritedEventCount)).toEqual(inherited)
  expect(first.events[first.inheritedEventCount]).toMatchObject({ type: 'session/end-seed', data: { inherited: true } })
  const own = first.events.slice(first.inheritedEventCount)
  expect(own.filter(event => event.type === 'subagent/descriptor')).toMatchObject([{ data: { provider: 'fork', mode: 'continuable' } }])
  expect(own.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  expect(first.projections?.values.workingDirectory).toBe(f.project)
  expect(() => { f.capacity.assertSubagentsStopped(f.graph.binding.accountId) }).not.toThrow()
  await f.graph.invoke('prompt', { sessionId: f.parent.id, requestId: 'native-fork-parent-later', mode: 'followup',
    content: [{ type: 'text', text: 'A newer parent turn must not change the existing fork.' }] })
  await f.parent.whenIdle()
  await f.graph.ctx.subagents.sendMessage(f.parent, started.childId, [{ type: 'text', text: 'Continue the original fork.' }],
    { signal: new AbortController().signal })
  await vi.waitFor(() => { expect(f.graph.ctx.agents.get(started.childId)).toBeUndefined() })
  using restored = await f.graph.ctx.sessionQuery.observeSession(started.childId, { projectionMode: 'all' })
  expect(restored.inheritedEventCount).toBe(inherited.length)
  expect(restored.events.slice(0, restored.inheritedEventCount)).toEqual(inherited)
  expect(restored.events.slice(restored.inheritedEventCount).filter(event => event.type === 'assistant/message')).toHaveLength(2)
  expect(f.observed).toEqual(['confirmed', 'confirmed'])
  expect(() => { f.capacity.assertSubagentsStopped(f.graph.binding.accountId) }).not.toThrow()
})

it('retains the Native fork fresh-child behavior before any completed parent turn', async () => {
  const f = await fixture(), started = await f.graph.ctx.subagents.startActivation({ ...f.spec(), provider: 'fork' })
  await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
  using source = await f.graph.ctx.sessionQuery.observeSession(started.childId)
  expect(source.header.isSeeded).toBe(false)
  expect(source.inheritedEventCount).toBe(0)
  expect(source.events.filter(event => event.type === 'subagent/descriptor')).toMatchObject([{ data: { provider: 'fork' } }])
  expect(f.observed).toEqual(['confirmed'])
})

it('rejects an unreviewed provider before its preparation and retains the ordinary root seed prohibition', async () => {
  const f = await fixture(), prepare = vi.fn(async () => ({})), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  const remove = f.graph.ctx.subagents.registerProvider({ name: 'unreviewed-provider', capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, inheritsParentContext: true,
    prepareContinuable: prepare })
  try {
    await expect(f.graph.ctx.subagents.startActivation({ ...f.spec(), provider: 'unreviewed-provider' })).rejects.toBeDefined()
  } finally { remove() }
  expect(prepare).not.toHaveBeenCalled()
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('unreviewed-root-seed'), seed: [],
    meta: { cwd: f.project, agentPreset: f.config.defaultPresetId }, agentOptions: { provider: 'local-text', model: 'plain-text' } }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(create).not.toHaveBeenCalled()
  expect(f.observed).toEqual([])
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
  expect(observed.header.agentPreset).toBe(f.config.defaultPresetId)
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

it.each(['spawn', 'fork'])('rejects a cloned Parent object at both %s admission and the actual cloud factory before native creation', async (provider) => {
  const f = await fixture(), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  const clone = { ...f.parent }
  await expect(f.graph.ctx.subagents.startActivation({ ...f.spec(clone), provider })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('cloned-parent-child'), parentAgent: clone,
    meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.defaultPresetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' } })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(create).not.toHaveBeenCalled()
})

it('refuses a caller-supplied disposal observer before reserving or creating a child', async () => {
  const f = await fixture(), supplied = vi.fn(), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('caller-observer'), parentAgent: f.parent,
    meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.defaultPresetId },
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
    meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.defaultPresetId },
    agentOptions: { provider: 'local-text', model: 'plain-text' }, signal: caller.signal,
    setup: async (owner, agent) => {
      await f.graph.ctx.agentPresets.mount(owner, f.config.defaultPresetId)
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
      meta: { cwd: f.project, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1, agentPreset: f.config.defaultPresetId } })
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
    meta: { cwd: f.project, origin: 'subagent', parentSession: parent.id, delegationDepth: 1, agentPreset: f.config.defaultPresetId },
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

it.each(['spawn', 'fork'])('rejects another native graph parent with a different real binding at %s and actual factory admission', async (provider) => {
  const f = await fixture(), other = policyFixture([], undefined, 'other-b1-component'), graph = await other.start()
  const created = await graph.ctx.sessionController.create({}), parent = graph.ctx.agents.get(created.sessionId)!
  const create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  await expect(f.graph.ctx.subagents.startActivation({ ...f.spec(parent), provider })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(f.graph.ctx.agents.create({ sessionId: SessionId('foreign-parent-child'), parentAgent: parent,
    meta: { cwd: f.project, origin: 'subagent', parentSession: parent.id, delegationDepth: 1, agentPreset: f.config.defaultPresetId },
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
