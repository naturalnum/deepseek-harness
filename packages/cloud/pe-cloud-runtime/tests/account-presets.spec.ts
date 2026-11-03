/** Real Native registry, Loader compositions, settings transactions and JSONL; not deployed mode acceptance. */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { childSessionMeta, applyChildComposition } from '../../../subagent/subagent/src/child-agent.ts'
import { policyFixture } from './account-policy-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 32, maxFrameBytes: 65536,
  maxQueuedEvents: 32, maxQueuedBytes: 131072 }
const exposure = ['list', 'read', 'select'].map(method => ({ endpoint: 'agentPresets/' + method,
  handlerId: 'native:agentPresets', guard: method === 'select' ? 'account-session' as const : 'authenticated-account' as const }))
function fixture(legacySelectable = false, reserveChild = false, defaults = false) {
  const declarations = ['standard', 'ptc', 'minimal', 'cordis', 'cloud-text'].map((id, index) => ({
    entryId: 'declaration-' + id, selectable: index < 4 || legacySelectable,
    config: { id, plugins: [
      { id: 'persona', name: 'cordis:m8z-persona', config: { prefix: id, complete: true, includeRuntimeContext: false } },
      { id: 'disabled-platform-row', name: 'cordis:m8z-persona', disabled: { __jsExpr: 'true' },
        config: { prefix: 'disabled', complete: true, includeRuntimeContext: false } },
    ] },
  }))
  const catalog = defaults ? { recipeVersion: 'm8z', catalogVersion: 'preset-default-test', maxEntries: 512,
    maxStringBytes: 256, maxCatalogBytes: 8192, plugins: [{ id: 'locale', entryId: 'locale',
      moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: '0.2.1-rc.2', installable: false as const, toggleable: false }],
    skills: { mode: 'closed' as const }, credentials: { mode: 'read-only' as const },
    fields: [{ namespace: 'agent-preset-registry', field: 'selectedDefault', values: ['standard', 'ptc', 'minimal', 'cordis'] }] } : undefined
  const rpc = defaults ? [...exposure, { endpoint: 'settings/mutate', handlerId: 'native:settingsController',
    guard: 'authenticated-account' as const }] : exposure
  return policyFixture(rpc, bounds, 'native-preset-set', undefined, catalog, undefined,
    reserveChild ? () => ({ settle() {} }) : undefined, undefined, [], true, undefined,
    { defaultId: 'standard', declarations })
}

it('admits all four explicitly approved Native compositions and filters the historical declaration from the roster', async () => {
  const f = fixture(), graph = await f.start()
  expect((await graph.ctx.agentPresets.remoteExportList()).presets.map(row => row.id)).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const { sessionId } = await graph.ctx.sessionController.create({ agentPreset: id })
    const agent = graph.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Native Agent absent')
    expect(agent.session.header.agentPreset).toBe(id)
    expect(graph.ctx.agentPresets.inspectCompositions(agent.ctx)[0]?.modules.map(row => row.moduleName)).toEqual(['cordis:m8z-persona'])
    expect(() => { graph.guards.presets.assertSession(agent) }).not.toThrow()
  }
  await expect(graph.ctx.sessionController.create({ agentPreset: 'cloud-text' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(graph.ctx.sessionController.create({ agentPreset: 'unapproved' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(graph.ctx.agentPresets.readDocument('cloud-text')).resolves.toMatchObject({ agentPreset: 'cloud-text' })
  expect(graph.adapter.calls).toBe(0)
})

it('uses the native blank switch and projected effective preset through cold recovery, retaining its creation header', async () => {
  const f = fixture(), first = await f.start()
  const { sessionId } = await first.ctx.sessionController.create({})
  const agent = first.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Native Agent absent')
  await expect(first.ctx.agentPresets.select(agent, 'ptc')).resolves.toBe('ptc')
  expect(agent.session.header.agentPreset).toBe('standard')
  expect(first.ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).toBe('ptc')
  expect(() => { first.guards.presets.assertSession(agent) }).not.toThrow()
  await expect(first.ctx.agentPresets.select(agent, 'cloud-text')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await first.ctx.sessionPersistence.flush(); await first.close()
  const second = await f.start('2')
  await expect(second.guards.sessions.assertSessionProject(sessionId)).resolves.toBeUndefined()
  const result = await second.ctx.agents.resume({ resumeSessionId: sessionId,
    agentOptions: { provider: 'local-text', model: 'plain-text' },
    setup: async (owner) => { await second.ctx.agentPresets.mount(owner, 'ptc') } })
  expect(second.ctx.agentPresets.composedPreset(result.agent.ctx)).toBe('ptc')
  expect(() => { second.guards.presets.assertSession(result.agent) }).not.toThrow()
  await result.dispose()
})

it('allows only old existing Sessions to restore a declaration that deployment made nonselectable', async () => {
  const f = fixture(true), first = await f.start()
  const { sessionId } = await first.ctx.sessionController.create({ agentPreset: 'cloud-text' })
  await first.ctx.sessionPersistence.flush(); await first.close()
  const config = { ...f.config, presets: f.config.presets.map(row => ({ ...row, selectable: row.id !== 'cloud-text' })) }
  const second = await f.start('2', config)
  await expect(second.guards.sessions.assertSessionProject(sessionId)).resolves.toBeUndefined()
  await expect(second.guards.agents.assertResume({ resumeSessionId: sessionId,
    agentOptions: { provider: 'local-text', model: 'plain-text' } }, second.lifetime.signal)).resolves.toBeUndefined()
  const result = await second.ctx.agents.resume({ resumeSessionId: sessionId,
    agentOptions: { provider: 'local-text', model: 'plain-text' },
    setup: async (owner) => { await second.ctx.agentPresets.mount(owner, 'cloud-text') } })
  expect(() => { second.guards.presets.assertSession(result.agent) }).not.toThrow()
  await expect(second.ctx.sessionController.create({ agentPreset: 'cloud-text' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await result.dispose()
})

it('preserves a different approved child composition while retaining original account and parent membership', async () => {
  const f = fixture(false, true), graph = await f.start()
  const { sessionId } = await graph.ctx.sessionController.create({})
  const parent = graph.ctx.agents.get(sessionId)
  if (parent === undefined) throw new Error('Native parent absent')
  const child = await graph.ctx.agents.withInitiator(parent, () => graph.ctx.agents.create({
    sessionId: SessionId('different-approved-child'), parentAgent: parent,
    meta: { ...childSessionMeta(parent, 1, false), agentPreset: 'minimal' },
    agentOptions: { ...parent.options, subagentDepth: 1 }, setup: async (owner, agent) => {
      await owner.get('workingDirectory')!.set(agent, f.project)
      await applyChildComposition(owner, parent, { agentPreset: 'minimal' })
    },
  }))
  expect(graph.ctx.agentPresets.composedPreset(parent.ctx)).toBe('standard')
  expect(graph.ctx.agentPresets.composedPreset(child.agent.ctx)).toBe('minimal')
  expect(() => { graph.guards.presets.assertSession(child.agent) }).not.toThrow()
  expect(graph.ctx.agents.isOwnedBy(child.agent.id, parent)).toBe(true)
  await child.dispose()
})

it('commits and resets the Native selectedDefault through the original bounded policy transaction and survives reload', async () => {
  const f = fixture(false, false, true), graph = await f.start()
  const namespace = 'agent-preset-registry', fields = [{ namespace, field: 'selectedDefault',
    values: ['standard', 'ptc', 'minimal', 'cordis'] }]
  const write = async (value: string | undefined): Promise<void> => {
    const ops = value === undefined ? [{ op: 'unset' as const, path: ['selectedDefault'] }]
      : [{ op: 'set' as const, path: ['selectedDefault'], value }]
    const revision = graph.ctx.settings.describe().find(row => row.ns === namespace)?.revision
    await graph.invokeSettings(namespace, ops, revision)
  }
  expect(graph.ctx.settings.describe().find(row => row.ns === namespace)).toBeDefined()
  await write('ptc')
  expect(graph.ctx.agentPresets.defaultId).toBe('ptc')
  expect((await graph.guards.sessions.resolveCreate({})).agentPreset).toBe('ptc')
  expect(graph.guards.allowSettingsUnset?.(namespace, 'selectedDefault', fields[0]!.values)).toBe(true)
  await write(undefined)
  expect(graph.ctx.agentPresets.defaultId).toBe('standard')
  await write('minimal')
  await graph.close()
  const cold = await f.start('2')
  expect(cold.ctx.agentPresets.defaultId).toBe('minimal')
  expect((await cold.guards.sessions.resolveCreate({})).agentPreset).toBe('minimal')
  const before = cold.ctx.sessions.list().length
  expect(() => cold.guards.beginSettingsUpdate(namespace, [{ op: 'set', path: ['selectedDefault'], value: 'cloud-text' }], fields))
    .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(cold.ctx.sessions.list()).toHaveLength(before)
})

it('rejects a changed declaration or out-of-band default update without repinning the native facts', async () => {
  const f = fixture(), graph = await f.start()
  const registry = [...graph.ctx.loader.entries()].find(row => row.options.id === 'agent-preset-registry')
  if (registry === undefined) throw new Error('Native registry entry absent')
  await graph.ctx.configEditor.edit(registry, raw => ({ ...raw, selectedDefault: 'ptc' }))
  expect(graph.ctx.agentPresets.defaultId).toBe('ptc')
  await expect(graph.guards.sessions.resolveCreate({})).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(graph.ctx.sessions.list()).toEqual([])
})

it('denies a foreign or copied Agent at the Native selection boundary without appending selection history', async () => {
  const a = await fixture().start(), b = await fixture().start()
  const { sessionId } = await a.ctx.sessionController.create({})
  const agent = a.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Native Agent absent')
  const before = agent.session.snapshotEvents()
  await expect(b.ctx.agentPresets.select(agent, 'ptc')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.ctx.agentPresets.select(new Proxy(agent, {}), 'ptc')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(a.ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
})
