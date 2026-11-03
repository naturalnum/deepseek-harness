/** Native Loader/preset registry and Gateway account composition; no deployed mode or model acceptance. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 32, maxFrameBytes: 65536,
  maxQueuedEvents: 32, maxQueuedBytes: 131072 }
const endpoints = ['list', 'read', 'select'].map(method => ({ endpoint: 'agentPresets/' + method,
  handlerId: 'native:agentPresets', guard: method === 'select' ? 'account-session' as const : 'authenticated-account' as const }))

async function fixture(account = 'api-presets', defaults = false) {
  const declarations = ['standard', 'ptc', 'minimal', 'cordis', 'legacy'].map((id, index) => ({
    entryId: 'declaration-' + id, selectable: index < 4,
    config: { id, name: 'Native ' + id, description: 'Original declaration ' + id, plugins: [
      { id: 'persona', name: 'cordis:m8z-persona', config: { prefix: id, complete: true, includeRuntimeContext: false } },
      { id: 'disabled-native-row', name: 'cordis:m8z-persona', disabled: { __jsExpr: 'true' },
        config: { prefix: 'disabled', complete: true, includeRuntimeContext: false } },
    ] },
  }))
  const catalog = defaults ? { recipeVersion: 'm8z', catalogVersion: 'preset-api-default-test', maxEntries: 512,
    maxStringBytes: 256, maxCatalogBytes: 8192, plugins: [{ id: 'locale', entryId: 'locale',
      moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: '0.2.1-rc.2', installable: false as const, toggleable: false }],
    skills: { mode: 'closed' as const }, credentials: { mode: 'read-only' as const },
    fields: [{ namespace: 'agent-preset-registry', field: 'selectedDefault', values: ['standard', 'ptc', 'minimal', 'cordis'] }] } : undefined
  const rpc = defaults ? [...endpoints, { endpoint: 'settings/mutate', handlerId: 'native:settingsController',
    guard: 'authenticated-account' as const }] : endpoints
  const source = policyFixture(rpc, bounds, account, undefined, catalog, undefined, undefined, undefined, [], true,
    undefined, { defaultId: 'standard', declarations })
  const graph = await source.start()
  const peer: PeerScope = { id: brandString<PeerId>('preset-peer-' + account), ctx: graph.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: graph.lifetime.signal, dispose: async () => {} }
  const invoke = (method: string, args: Readonly<Record<string, unknown>>) => graph.ctx.typertGateway.invoke({ namespace: 'agentPresets', method, args, peer })
  const create = async (id?: string) => {
    const { sessionId } = await graph.ctx.sessionController.create(id === undefined ? {} : { sessionId: SessionId(id) })
    const agent = graph.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Original Native Agent absent')
    return agent
  }
  return { ...graph, source, peer, invoke, create }
}

it('exports exactly four selectable native presets while preserving native YAML viewing of the restore-only declaration', async () => {
  const f = await fixture()
  await expect(f.invoke('list', {})).resolves.toMatchObject({ presets: [
    { id: 'cordis', isDefault: false }, { id: 'minimal', isDefault: false },
    { id: 'ptc', isDefault: false }, { id: 'standard', isDefault: true },
  ] })
  const read = await f.invoke('read', { agentPreset: 'legacy' })
  expect(read).toMatchObject({ agentPreset: 'legacy', name: 'Native legacy', description: 'Original declaration legacy' })
  expect(read).toHaveProperty('content', expect.stringContaining('disabled: !!js'))
  await expect(f.invoke('read', { agentPreset: 'unapproved' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const agent = await f.create()
  await expect(f.invoke('select', { agentId: agent.id, agentPreset: 'legacy' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
})

it('uses original Gateway wire names to select a blank Agent and keeps the native started-session lock', async () => {
  const f = await fixture(), agent = await f.create()
  await expect(f.invoke('select', { agentId: agent.id, agentPreset: 'ptc' })).resolves.toBe('ptc')
  expect(agent.session.header.agentPreset).toBe('standard')
  expect(f.ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).toBe('ptc')
  expect(f.ctx.agentPresets.composedPreset(agent.ctx)).toBe('ptc')
  const before = agent.session.snapshotEvents()
  await expect(f.invoke('select', { agentId: agent.id, agentPreset: 'ptc' })).resolves.toBe('ptc')
  expect(agent.session.snapshotEvents()).toEqual(before)
  agent.session.append('turn/start', { turn: 1 })
  await expect(f.invoke('select', { agentId: agent.id, agentPreset: 'minimal' })).rejects.toMatchObject({ code: 'agent-preset/locked' })
  expect(f.ctx.agentPresets.composedPreset(agent.ctx)).toBe('ptc')
})

it('refuses foreign and copied Agent objects before changing their native selection history', async () => {
  const a = await fixture('preset-a'), b = await fixture('preset-b'), agent = await a.create('same-visible-id')
  const foreign = await b.create('same-visible-id'), before = agent.session.snapshotEvents(), otherBefore = foreign.session.snapshotEvents()
  await expect(a.ctx.agentPresets.select(foreign, 'minimal')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.ctx.agentPresets.select(new Proxy(agent, {}), 'minimal')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(foreign.session.snapshotEvents()).toEqual(otherBefore)
})

it('rechecks account admission after the original queued selection waits', async () => {
  const f = await fixture(), agent = await f.create()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const recompose = f.ctx.agentPresets.recompose.bind(f.ctx.agentPresets)
  const paused = vi.spyOn(f.ctx.agentPresets, 'recompose').mockImplementation(async (ctx, id) => {
    entered.resolve(undefined)
    await release.promise
    return recompose(ctx, id)
  })
  const first = f.ctx.agentPresets.select(agent, 'ptc')
  await entered.promise
  const queued = f.ctx.agentPresets.select(agent, 'minimal')
  const firstFailure = expect(first).rejects.toBeDefined(), queuedFailure = expect(queued).rejects.toBeDefined()
  f.closeBusiness()
  release.resolve(undefined)
  await firstFailure; await queuedFailure
  expect(agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toHaveLength(0)
  expect(paused).toHaveBeenCalledOnce()
})

it('refuses an original Gateway read after account admission closes', async () => {
  const f = await fixture()
  f.closeBusiness()
  await expect(f.invoke('list', {})).rejects.toThrow('business admission is closed')
  await expect(f.invoke('read', { agentPreset: 'standard' })).rejects.toThrow('business admission is closed')
})

it('rechecks business admission after asynchronous approved declaration validation', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = f.guards.presets.assertPreset.bind(f.guards.presets)
  vi.spyOn(f.guards.presets, 'assertPreset').mockImplementation(async (...args) => {
    const result = await original(...args)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const request = f.invoke('read', { agentPreset: 'standard' })
  await entered.promise
  const failure = expect(request).rejects.toThrow('business admission is closed')
  f.closeBusiness()
  release.resolve(undefined)
  await failure
})

it('persists and resets the original selectedDefault through native Settings without changing an existing Agent', async () => {
  const f = await fixture('preset-defaults', true), existing = await f.create()
  const write = async (value: string | undefined): Promise<void> => {
    const namespace = 'agent-preset-registry', view = f.ctx.settings.describe().find(row => row.ns === namespace)
    if (view === undefined) throw new Error('Original Native default Settings absent')
    await f.invokeSettings(namespace, value === undefined ? [{ op: 'unset', path: ['selectedDefault'] }]
      : [{ op: 'set', path: ['selectedDefault'], value }], view.revision)
  }
  await write('minimal')
  await expect(f.invoke('list', {})).resolves.toMatchObject({ presets: [
    { id: 'cordis', isDefault: false }, { id: 'minimal', isDefault: true },
    { id: 'ptc', isDefault: false }, { id: 'standard', isDefault: false },
  ] })
  expect(existing.session.header.agentPreset).toBe('standard')
  expect(f.ctx.agentPresets.composedPreset(existing.ctx)).toBe('standard')
  const created = await f.create()
  expect(created.session.header.agentPreset).toBe('minimal')
  await expect(write('legacy')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.ctx.agentPresets.defaultId).toBe('minimal')
  await write(undefined)
  expect(f.ctx.agentPresets.defaultId).toBe('standard')
  await write('cordis')
  await f.ctx.sessionPersistence.flush()
  await f.close()
  const restored = await f.source.start('2')
  expect(restored.ctx.agentPresets.defaultId).toBe('cordis')
})

it('admits the complete original question graph within the explicit finite fixture inventory before any Session mutation', async () => {
  const rpc = [
    { endpoint: 'userQuestions/answer', handlerId: 'native:userQuestions', guard: 'account-session' as const },
    { endpoint: '$events/result', handlerId: 'native:typertGateway', guard: 'authenticated-account' as const },
  ]
  const streams = [{ endpoint: 'userQuestions/attachWait', handlerId: 'native:userQuestions', guard: 'account-session' as const }]
  const source = policyFixture(rpc, bounds, 'inventory-diagnosis', undefined, undefined, undefined, undefined, undefined, streams)
  const graph = await source.start()
  const registryVisits = [...graph.ctx.registry.values()].reduce((count, runtime) => count + 1 + [...runtime.fibers].length, 0)
  // Matches CloudAccountApi's selected declarations plus actual Runtime/Fiber visit charges.
  const manifest = source.exposureOwner.policy.manifest
  const cost = registryVisits + manifest.rpcEndpoints.length + manifest.streamEndpoints.length + manifest.exactFetchRoutes.length
  expect(cost).toBeLessThanOrEqual(graph.maxEntries)
  expect(graph.ctx.sessions.list()).toHaveLength(0)
  expect(graph.adapter.calls).toBe(0)
})

it.each(['queue', 'steer'] as const)('holds a real Gateway session/prompt %s in Native Inbox until mode selection commits', async (mode) => {
  const f = await fixture('preset-prompt-' + mode), agent = await f.create()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = f.ctx.agentPresets.recompose.bind(f.ctx.agentPresets)
  vi.spyOn(f.ctx.agentPresets, 'recompose').mockImplementation(async (scope, id) => {
    entered.resolve(undefined)
    await release.promise
    return original(scope, id)
  })
  const selecting = f.invoke('select', { agentId: agent.id, agentPreset: 'ptc' })
  try {
    await entered.promise
    await expect(f.ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', peer: f.peer,
      args: { request: { requestId: 'native-selection-prompt-' + mode, sessionId: agent.id, mode,
        content: [{ type: 'text', text: 'wait for the selected Native mode' }] } } })).resolves.toEqual({ accepted: true })
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
    expect(f.adapter.calls).toBe(0)
    release.resolve(undefined)
    await expect(selecting).resolves.toBe('ptc')
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const selected = events.findIndex(event => event.type === 'agent-preset/selected')
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(events.findIndex(event => event.type === 'turn/start')).toBeGreaterThan(selected)
    expect(f.adapter.calls).toBe(1)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([selecting])
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  }
})
