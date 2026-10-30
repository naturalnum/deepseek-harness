/** Concrete native policy callbacks and ordinary JSONL cold recovery; no runtime owner/ready or Web acceptance is inferred. */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CloudApiError, ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { expect, it, onTestFinished, vi } from 'vitest'
import { accountPresetConfigDigest, createAccountPolicy } from '../src/account-policy.ts'
import { AccountPolicyConfigSchema } from '../src/schema.ts'
import { policyFixture } from './account-policy-fixture.ts'

it.each(['rpc', 'stream', 'office'] as const)('rejects %s file exposure during Runtime bootstrap when the original Node files owner has no content grant', async (mode) => {
  const f = policyFixture(), graph = await f.start(), manifest = f.exposureOwner.policy.manifest
  const row = { endpoint: mode === 'office' ? 'officeToPdf/render' : mode === 'rpc' ? 'workspaceFiles/read' : 'workspaceFiles/changes',
    handlerId: mode === 'office' ? 'native:officeToPdf' : 'native:workspaceFiles', guard: 'account-session' as const }
  const root = new Context()
  onTestFinished(async () => { await root.fiber.dispose() })
  const exposure = new ExposureService(root, { ...manifest,
    rpcEndpoints: [...manifest.rpcEndpoints, ...mode !== 'stream' ? [row] : []],
    streamEndpoints: [...manifest.streamEndpoints, ...mode === 'stream' ? [row] : []],
  }).policy
  const selected = createAccountPolicy(graph.ctx, graph.binding, graph.files, f.config, exposure, graph.maxEntries)
  const content = vi.spyOn(graph.files, 'assertContentAvailable')
  await expect(selected.assertBootstrapCurrent(graph.binding.lifetime)).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
  expect(content).toHaveBeenCalledTimes(1)
  await expect(graph.guards.assertBootstrapCurrent(graph.binding.lifetime)).resolves.toBeUndefined()
  expect(content).toHaveBeenCalledTimes(1)
})

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

it('selects the requested original registered project while retaining the bootstrap default and fixed Preset/model', async () => {
  const f = policyFixture(), graph = await f.start(), a = graph.files.project().workspace
  const secondPath = join(dirname(f.project), 'second-project')
  mkdirSync(secondPath)
  const b = await graph.ctx.workspaceRegistry.create(secondPath, 'Second project')
  await expect(graph.guards.sessions.resolveCreate({ workspaceId: b.id })).resolves.toMatchObject({
    workspaceId: b.id, agentPreset: f.config.presetId,
  })
  const created = await graph.ctx.sessionController.create({ workspaceId: b.id })
  const agent = graph.ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('Actual native Agent absent')
  expect(graph.guards.projectForAgent(agent)).toBe(b)
  expect(graph.guards.projectForSession(agent.session)).toBe(b)
  expect(graph.guards.projectForObservedHeader(agent.id, agent.session.header)).toBe(b)
  expect(agent.session.header.cwd).toBe(b.path)
  expect(b.sessionIds).toContain(agent.id)
  expect(a.sessionIds).not.toContain(agent.id)
  expect(graph.files.project().workspace).toBe(a)
  await graph.guards.sessions.assertSessionProject(agent.id)
  expect(graph.adapter.calls).toBe(0)
  expect(graph.directoryCalls).toContain(b.path)
  await expect(graph.guards.getFileProject(graph.ctx)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await b.detachSession(agent.id)
  expect(() => graph.guards.projectForAgent(agent)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
})

it('retains native cross-project attachment refusal and rejects detached history before observation', async () => {
  const f = policyFixture(), graph = await f.start(), a = graph.files.project().workspace
  const secondPath = join(dirname(f.project), 'second-project')
  mkdirSync(secondPath)
  const b = await graph.ctx.workspaceRegistry.create(secondPath)
  const created = await graph.ctx.sessionController.create({})
  await expect(b.attachSession(created.sessionId)).rejects.toThrow('its cwd resolves to')
  expect(a.sessionIds).toContain(created.sessionId)
  const observe = vi.spyOn(graph.ctx.sessionQuery, 'observeSession')
  await a.detachSession(created.sessionId)
  await expect(graph.guards.sessions.assertSessionProject(created.sessionId)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(observe).not.toHaveBeenCalled()
})

it('requires the exact current Workspace object rather than another account native object or a deleted project', async () => {
  const a = await policyFixture([], undefined, 'workspace-a').start()
  const b = await policyFixture([], undefined, 'workspace-b').start()
  expect(() => { a.guards.assertWorkspace(b.files.project().workspace) })
    .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  const workspace = a.files.project().workspace
  await a.ctx.workspaceRegistry.delete(workspace.id)
  expect(() => { a.guards.assertWorkspace(workspace) }).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
})

it("rejects another account's missing native history and commands before querying it and preserves the denial on the wire", async () => {
  const a = await policyFixture([], undefined, 'account-a').start()
  const b = await policyFixture([], undefined, 'account-b').start()
  const foreign = await a.ctx.sessionController.create({})
  const own = await b.ctx.sessionController.create({})
  await expect(b.invoke('page', { address: { kind: 'session', sessionId: own.sessionId }, throughSeq: -1 }))
    .resolves.toBeDefined()
  expect(b.files.project().workspace.sessionIds).not.toContain(foreign.sessionId)
  const observe = vi.spyOn(b.ctx.sessionQuery, 'observeSession')
  const operations = [
    () => b.invoke('page', { address: { kind: 'session', sessionId: foreign.sessionId }, throughSeq: -1 }),
    () => b.invoke('prompt', { sessionId: foreign.sessionId, requestId: 'foreign-prompt', mode: 'followup',
      content: [{ type: 'text', text: 'Must not be enqueued.' }] }),
    () => b.guards.agents.assertResume({ resumeSessionId: foreign.sessionId,
      agentOptions: { provider: 'local-text', model: 'plain-text' } }, new AbortController().signal),
  ]
  for (const operation of operations) {
    const failure: unknown = await operation().then(() => { throw new Error('Foreign operation was accepted') },
      (error: unknown) => error)
    expect.soft(failure).toBeInstanceOf(CloudApiError)
    expect.soft(failure).toMatchObject({ code: 'cloud/forbidden' })
    expect.soft(b.ctx.typertGateway.wireStream.failure(failure)).toMatchObject({ code: 'cloud/forbidden' })
  }
  expect(observe.mock.calls.length).toBe(0)
  expect(b.adapter.calls).toBe(0)
})

it('creates the same explicit new SessionId independently in two accounts but rejects existing nonmember history', async () => {
  const a = await policyFixture([], undefined, 'account-a').start()
  const b = await policyFixture([], undefined, 'account-b').start()
  const sessionId = SessionId('same-account-local-session-id')
  await expect(a.ctx.sessionController.create({ sessionId })).resolves.toMatchObject({ sessionId })
  await expect(b.ctx.sessionController.create({ sessionId })).resolves.toMatchObject({ sessionId })
  expect(a.binding.accountId).not.toBe(b.binding.accountId)
  expect(a.files.project().workspace.path).not.toBe(b.files.project().workspace.path)
  await expect(b.guards.sessions.resolveCreate({ sessionId })).resolves.toMatchObject({ sessionId })
  await b.files.project().workspace.detachSession(sessionId)
  await expect(b.guards.sessions.resolveCreate({ sessionId })).rejects.toMatchObject({ code: 'cloud/forbidden' })
})

it('retains missing-member query failures for history and explicit creation instead of treating them as new ids', async () => {
  const graph = await policyFixture().start(), { sessionId } = await graph.ctx.sessionController.create({})
  const missing = new SessionQueryError('Native member history is missing.', 'SESSION_QUERY_SESSION_NOT_FOUND')
  const observe = vi.spyOn(graph.ctx.sessionQuery, 'observeSession').mockRejectedValue(missing)
  await expect(graph.guards.sessions.assertSessionProject(sessionId)).rejects.toBe(missing)
  await expect(graph.guards.sessions.resolveCreate({ sessionId })).rejects.toBe(missing)
  observe.mockRestore()
})

it.each([
  new SessionQueryError('Native history read failed.', 'SESSION_QUERY_PERSISTENCE_FAILED'),
  new Error('Unknown native history failure.'),
])('retains the original query error through member history and both creation probes: %s', async (error) => {
  const graph = await policyFixture().start(), { sessionId: member } = await graph.ctx.sessionController.create({})
  const fresh = SessionId('new-io-failure')
  const observe = vi.spyOn(graph.ctx.sessionQuery, 'observeSession').mockRejectedValue(error)
  await expect(graph.guards.sessions.assertSessionProject(member)).rejects.toBe(error)
  await expect(graph.guards.sessions.resolveCreate({ sessionId: member })).rejects.toBe(error)
  await expect(graph.guards.sessions.resolveCreate({ sessionId: fresh })).rejects.toBe(error)
  expect(observe.mock.calls.length).toBe(3)
  observe.mockRestore()
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
  await expect(graph.guards.sessions.resolveCreate({ sessionId: detached.header.id })).rejects.toMatchObject({ code: 'cloud/forbidden' })
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
