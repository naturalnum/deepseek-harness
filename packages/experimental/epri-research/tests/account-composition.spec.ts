/** Research requests through the real Loader, Controller, Gateway and account database. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Controller from '@deepseek-ai/dsh-api-session-controller'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Typert from '@deepseek-ai/dsh-typert-registry'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudAccountApi, ConfigSaveCoordinator } from '@deepseek-ai/dsh-pe-cloud-api'
import { ExposurePolicy } from '@deepseek-ai/dsh-pe-cloud-api/src/exposure.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Research from '../src/index.ts'
import * as ResearchTools from '../src/tools.ts'
import * as ResearchSkills from '../src/skills.ts'
import * as ResearchWorkbench from '../src/workbench.ts'

class Replay extends LlmAdapter {
  private request = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.request++ === 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('research-state'), name: 'research_state', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Research state loaded.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Research state loaded.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

class Queries extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used by this fixture.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used by this fixture.')) }
}

async function fixture(id: string, selected = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'epri-account-'))), project = join(home, 'project')
  mkdirSync(project)
  const configPath = join(home, 'cordis.yml'), lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'research-composition', lifetime: lifetime.signal })
  const manifest = { recipeVersion: binding.recipeVersion, rpcEndpoints: selected
    ? [{ endpoint: 'epriResearch/execute', handlerId: 'native:epriResearch', guard: 'account-session' as const }] : [],
  streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 2, maxWaitersPerAccount: 2 })
  const barrier = saves.createAccount(binding)
  const profile: ProfileContext = { name: 'account', dir: home, home, cwd: project, patchPath: join(home, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), overlays: [], startedBundles: [], telemetryDisabledEnv: undefined }
  writeFileSync(profile.installAnchor, '{"name":"epri-account-test"}\n')
  writeFileSync(configPath, JSON.stringify([
    { id: 'controller', name: 'cordis:controller' },
    { id: 'research', name: 'cordis:research', config: {
      backendModule: new URL('../../../../integrations/epri-research/dist/server/cloud-plugin.mjs', import.meta.url).href,
      python: '/usr/bin/python3', maxJsonBytes: 2_097_152, maxOutputBytes: 2_097_152, graceMs: 1000,
    } },
    { id: 'research-tools', name: 'cordis:research-tools' },
    { id: 'research-skills', name: 'cordis:research-skills' },
    { id: 'research-workbench', name: 'cordis:research-workbench' },
  ]))
  let owner: Context | undefined, api: CloudAccountApi | undefined, mounting = true
  onTestFinished(async () => {
    lifetime.abort()
    if (api !== undefined) { await api.stopConfigSaves(Date.now() + 1000); await api.withdraw() }
    await owner?.fiber.dispose()
    saves.releaseAccount(barrier); saves.close()
    rmSync(home, { recursive: true, force: true })
  })
  const current = (): void => { lifetime.signal.throwIfAborted(); owner?.fiber.assertActive() }
  const ctx = await boot('epri-' + id, configPath, [], async (ctx) => {
    owner = ctx
    ctx.provide('profileContext', profile); ctx.provide('peAccount', binding)
    await ctx.plugin(Typert); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true }); await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(DefaultModel, { provider: 'fixture', model: 'keyless' })
    new Queries(ctx)
    // File receipt and workspace-list domains are not exercised by research RPC.
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
    ctx.provide('attachments', {})
    api = new CloudAccountApi(ctx, { binding, rootExposure: policy, selected: manifest, saves: barrier,
      assertMountCurrent: current, assertBusinessCurrent: () => { current(); if (mounting) throw new Error('Not published') },
      assertUnpublished: () => { if (!mounting) throw new Error('Already published') }, maxNativeInventoryEntries: 128 })
    const service = api
    const guards: Parameters<CloudAccountApi['createController']>[1] = {
      projectDirectory: { binding, prepare: async (cwd) => { if (cwd !== project) throw new Error('Foreign project') } },
      assertHandlerEnabled() {}, resolveCreate: async request => request,
      assertSessionProject: async (sid) => {
        current(); if (ctx.agents.get(sid)?.session.header.cwd !== project) throw new Error('Foreign Session')
      },
      assertActiveScope: (agent) => {
        current()
        if (ctx.agents.get(agent.id) !== agent || agent.ctx.get('peAccount') !== binding || agent.session.header.cwd !== project) {
          throw new Error('Foreign Agent')
        }
      },
    }
    Object.assign(ctx.loader.builtins, {
      research: Research,
      'research-tools': ResearchTools, 'research-skills': ResearchSkills, 'research-workbench': ResearchWorkbench,
      controller: { inject: Controller.inject, apply(scope: Context) { service.createController(scope, guards, { nativeOpen: false }) } },
    })
  })
  if (api === undefined || ctx.get('epriResearch') === undefined) throw new Error('Research Loader entry did not activate')
  api.audit(manifest); mounting = false
  ctx.llm.registerAdapter(['fixture'], new Replay())
  const agent = await ctx.agentLoop.create(SessionId('same-session'), { provider: 'fixture', model: 'keyless' }, { cwd: project })
  const peer: PeerScope = { id: brandString<PeerId>('research-' + id), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: lifetime.signal, dispose: async () => {} }
  const call = async (operation: string, args: object = {}, sid = agent.id): Promise<Record<string, unknown>> => {
    const result = await ctx.typertGateway.invoke({ namespace: 'epriResearch', method: 'execute',
      args: { sessionId: sid, operation, argsJson: JSON.stringify(args) }, peer })
    if (typeof result !== 'string') throw new Error('Research did not return JSON')
    const value: unknown = JSON.parse(result)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a research object result')
    return value as Record<string, unknown>
  }
  return { ctx, api, agent, peer, call, lifetime, home, backend: fileURLToPath(new URL('../../../../integrations/epri-research/dist/server/cloud-plugin.mjs', import.meta.url)) }
}

it('keeps identical Session, object and request ids in independent Loader account stores', async () => {
  const a = await fixture('a'), b = await fixture('b')
  const put = (content: string) => ({ id: 'p', version: '1', content: '# ' + content + '\n\n{{var|value: str}}', requestId: 'same' })
  await Promise.all([a.call('protocol_put', put('A')), b.call('protocol_put', put('B'))])
  expect(await a.call('protocol_get', { id: 'p', version: '1' })).toMatchObject({ content: put('A').content })
  expect(await b.call('protocol_get', { id: 'p', version: '1' })).toMatchObject({ content: put('B').content })
  await expect(a.call('state', {}, SessionId('foreign-session'))).rejects.toBeDefined()
  await expect(a.ctx.epriResearch.execute(a.agent.id, 'state', '{}', new AbortController().signal)).rejects.toThrow('authenticated')
  await expect(a.ctx.typertGateway.invoke({ namespace: 'epriResearch', method: 'execute',
    args: { sessionId: a.agent.id, operation: 'state', argsJson: '{}' }, peer: b.peer })).rejects.toBeDefined()
  expect(a.api.isFeatureRpc({ endpoint: 'epriResearch/execute', handlerId: 'native:epriResearch', guard: 'account-session' })).toBe(true)
  expect(a.api.isFeatureRpc({ endpoint: 'epriResearch/execute', handlerId: 'native:other', guard: 'account-session' })).toBe(false)
  a.lifetime.abort()
  await expect(a.call('protocol_put', put('closed'))).rejects.toBeDefined()
  expect(await b.call('protocol_get', { id: 'p', version: '1' })).toMatchObject({ content: put('B').content })
})

it('requires exact Root selection and removes admission when the original Loader fiber is disposed', async () => {
  const closed = await fixture('unselected', false)
  await expect(closed.call('state')).rejects.toBeDefined()
  const f = await fixture('dispose')
  await f.call('state')
  const entry = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'research')
  expect(entry?.fiber).toBeDefined()
  await entry?.fiber?.dispose()
  expect(f.ctx.get('epriResearch')).toBeUndefined()
  await expect(f.call('state')).rejects.toBeDefined()
})

it('replays a keyless research tool turn through the native loop and records the model-visible result', async () => {
  const f = await fixture('replay')
  const idle = new Promise<void>((resolve) => {
    const off = f.ctx.on('agent/status', ({ agent, status }) => { if (agent === f.agent && status === 'idle') { off(); resolve() } })
  })
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Load research state.' }], source: { kind: 'user' } }))
  await idle
  const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => ({
    ...event.data, message: { ...event.data.message, id: '<generated-message-id>' },
  }))
  expect(results).toHaveLength(1)
  expect(results).toMatchSnapshot()
  expect((await f.ctx.skills.list({ scope: f.agent })).some(skill => skill.name === 'research-science' && skill.path === undefined)).toBe(true)
})
