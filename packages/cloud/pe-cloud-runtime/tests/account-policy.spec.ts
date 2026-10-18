/** Concrete native policy callbacks and ordinary JSONL cold recovery; no runtime owner/ready or Web acceptance is inferred. */
import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { accountPresetConfigDigest } from '../src/account-policy.ts'
import { AccountPolicyConfigSchema } from '../src/schema.ts'
import { policyFixture } from './account-policy-fixture.ts'

it('uses the actual files Workspace, finite registered model and fixed native Preset instead of all-refusing callbacks', async () => {
  const f = policyFixture(), graph = await f.start()
  const resolved = await graph.guards.sessions.resolveCreate({})
  expect(resolved.workspaceId).toBe(graph.files.project().workspace.id)
  expect(resolved.agentPreset).toBe(f.config.presetId)
  expect(graph.guards.allowedModel('local-text', 'plain-text')).toBe(true)
  expect(graph.guards.allowedModel('local-text', 'unapproved')).toBe(false)
  const created = await graph.ctx.sessionController.create({})
  expect(graph.ctx.agents.get(created.sessionId)?.session.header.cwd).toBe(f.project)
  expect(graph.files.project().workspace.sessionIds).toContain(created.sessionId)
  await graph.guards.sessions.assertSessionProject(created.sessionId)
})

it('runs a native plain-text turn, then cold-observes and resumes the same ordinary SessionId from actual JSONL', async () => {
  const f = policyFixture(), first = await f.start()
  const created = await first.ctx.sessionController.create({})
  const finished = Promise.withResolvers<undefined>()
  first.ctx.on('session/event', (session, event) => {
    if (session.id === created.sessionId && event.type === 'turn/end') finished.resolve(undefined)
  })
  await expect(first.invoke('prompt', { sessionId: created.sessionId, requestId: 'm8z-native-turn', mode: 'followup',
    content: [{ type: 'text', text: 'hello native policy' }] })).resolves.toEqual({ accepted: true })
  await finished.promise
  await first.ctx.sessionPersistence.flush()
  expect(first.adapter.calls).toBe(1)
  expect(JSON.stringify(first.ctx.sessions.get(created.sessionId)?.snapshotEvents())).toContain('native policy reply')
  const workspaceId = first.files.project().workspace.id
  await first.close()
  const second = await f.start('2')
  using observation = await second.ctx.sessionQuery.observeSession(created.sessionId, { projectionMode: 'all' })
  expect(observation.source).toBe('prepared')
  expect(observation.header.id).toBe(created.sessionId)
  expect(observation.header.isSeeded).toBe(false)
  expect(observation.projections?.values.agentPreset).toBe(f.config.presetId)
  expect(second.files.project().workspace.id).toBe(workspaceId)
  await second.guards.sessions.assertSessionProject(created.sessionId)
  const resumed = await second.ctx.agents.resume({ resumeSessionId: created.sessionId,
    agentOptions: { provider: 'local-text', model: 'plain-text' },
    setup: async (ctx) => { await second.ctx.agentPresets.mount(ctx, f.config.presetId) },
  })
  expect(resumed.agent.id).toBe(created.sessionId)
  expect(resumed.agent.session.header.id).toBe(created.sessionId)
  expect(resumed.agent.session.header.isSeeded).toBe(false)
  await resumed.dispose()
})

it('rejects foreign project, unapproved model/Preset and a missing actual Preset composition before publication', async () => {
  const f = policyFixture(), graph = await f.start()
  await expect(graph.guards.sessions.resolveCreate({ cwd: f.privateRoot })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(graph.guards.sessions.resolveCreate({ agentPreset: 'arbitrary-preset' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const options = { sessionId: SessionId('policy-rejected'), meta: { cwd: f.project, agentPreset: f.config.presetId },
    agentOptions: { provider: 'local-text', model: 'unapproved' } }
  const create = vi.spyOn(graph.ctx.sessionPersistence, 'create')
  await expect(graph.ctx.agents.create(options)).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
  expect(create).not.toHaveBeenCalled()
  await expect(graph.ctx.agents.create({ ...options, agentOptions: { provider: 'local-text', model: 'plain-text' } }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.agents.get(options.sessionId)).toBeUndefined()
  expect(graph.ctx.sessions.get(options.sessionId)).toBeUndefined()
  expect(graph.adapter.calls).toBe(0)
})

it('rejects a wrong trusted declaration digest against the actual native Preset before opening a Session writer', async () => {
  const f = policyFixture(), graph = await f.start('1', { ...f.config, presetConfigSha256: '0'.repeat(64) })
  const create = vi.spyOn(graph.ctx.sessionPersistence, 'create')
  await expect(graph.ctx.sessionController.create({})).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(create).not.toHaveBeenCalled()
  expect(graph.ctx.sessions.list()).toEqual([])
})

it('rechecks actual provider availability after the native asynchronous model lookup', async () => {
  const f = policyFixture(), graph = await f.start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  const checking = graph.guards.agents.assertCreate({ sessionId: SessionId('provider-removed'),
    meta: { cwd: f.project, agentPreset: f.config.presetId }, agentOptions: { provider: 'local-text', model: 'plain-text' } },
  new AbortController().signal)
  const rejected = expect(checking).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
  try { await entered.promise; graph.withdrawProvider() }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.guards.allowedModel('local-text', 'plain-text')).toBe(false)
  expect(graph.adapter.calls).toBe(0)
})

it('reads actual persisted headers and Workspace relationships but rejects unsupported subagent history', async () => {
  const f = policyFixture(), graph = await f.start()
  const created = await graph.ctx.sessionController.create({})
  const detached = graph.ctx.sessions.prepare(SessionId('unsupported-child'), { meta: {
    cwd: f.project, agentPreset: f.config.presetId, origin: 'subagent', parentSession: created.sessionId, delegationDepth: 1,
  } })
  const writer = await graph.ctx.sessionPersistence.create(detached.header)
  await writer.flush(); await writer.close()
  await graph.files.project().workspace.attachSession(detached.header.id)
  expect(graph.files.project().workspace.sessionIds).toContain(detached.header.id)
  await expect(graph.guards.sessions.assertSessionProject(detached.header.id)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(graph.guards.agents.assertResume({ resumeSessionId: detached.header.id,
    agentOptions: { provider: 'local-text', model: 'plain-text' } }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
})

it('rechecks the original files Workspace after asynchronous model validation', async () => {
  const f = policyFixture(), graph = await f.start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  const checking = graph.guards.sessions.resolveCreate({})
  const rejected = expect(checking).rejects.toBeInstanceOf(Error)
  try { await entered.promise; await graph.ctx.workspaceRegistry.delete(graph.files.project().workspace.id) }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.ctx.sessions.list()).toEqual([])
})

it('revokes policy checks after an actual Loader change to the approved Preset declaration', async () => {
  const f = policyFixture(), graph = await f.start()
  await graph.guards.sessions.resolveCreate({})
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === f.config.presetEntryId)
  if (entry === undefined) throw new Error('Actual Preset entry absent')
  await entry.update({ config: { ...f.declaration, name: 'unreviewed change' } })
  await expect(graph.guards.sessions.resolveCreate({})).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(graph.ctx.sessions.list()).toEqual([])
})

it('requires finite exact route and UTF-8 limits at the configuration parser', () => {
  const f = policyFixture()
  const short = { ...f.config, presetId: 'p', presetEntryId: 'a', agentLoopEntryId: 'b', maxPolicyStringBytes: 3,
    models: [{ provider: '中', model: 'm' }] }
  expect(AccountPolicyConfigSchema(short)).toEqual(short)
  expect(() => AccountPolicyConfigSchema({ ...short, models: [{ provider: '中a', model: 'm' }] })).toThrow()
  expect(() => AccountPolicyConfigSchema({ ...short, maxModelRoutes: 0 })).toThrow()
  expect(() => AccountPolicyConfigSchema({ ...short, maxPolicyStringBytes: Infinity })).toThrow()
  expect(() => AccountPolicyConfigSchema({ ...short, models: [...short.models, ...short.models] })).toThrow()
  expect(() => AccountPolicyConfigSchema({ ...short, models: [] })).toThrow()
  expect(() => AccountPolicyConfigSchema({ ...short, presetConfigSha256: 'unbounded-expectation' })).toThrow()
})

it('hashes canonical preset JSON within the explicit byte budget and rejects executable or unbounded declarations', () => {
  const canonical = '{"id":"p","plugins":[{"config":{"a":"中","b":1},"id":"c","name":"cordis:x"}]}'
  const value = { plugins: [{ name: 'cordis:x', id: 'c', config: { b: 1, a: '中' } }], id: 'p' }
  const bytes = Buffer.byteLength(canonical)
  expect(accountPresetConfigDigest(value, bytes)).toBe(createHash('sha256').update(canonical).digest('hex'))
  expect(() => accountPresetConfigDigest(value, bytes - 1)).toThrow()
  expect(() => accountPresetConfigDigest({ plugins: [() => 'unapproved-constructor'] }, 256)).toThrow()
  expect(() => accountPresetConfigDigest({ plugins: [{ disabled: { __jsExpr: 'true' } }] }, 256)).toThrow()
  expect(() => accountPresetConfigDigest({ large: 'x'.repeat(257) }, 256)).toThrow()
})
