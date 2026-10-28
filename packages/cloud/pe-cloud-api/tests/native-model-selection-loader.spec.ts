/** Loader/Gateway model selection keeps native durable intent, saves, and generation admission. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog, ModelSelection, SessionSelectModelRequest, SessionSelectModelValue } from '@deepseek-ai/dsh-api-session-controller/types'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished } from 'vitest'
import { CloudApiError } from '../src/errors.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { installNativeConfigSaveHook } from '../src/native-save-hook.ts'
import { createNativeController, inspectNativeController, type NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'

class NativeQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is outside this fixture.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is outside this fixture.')) }
}

class ModelAdapter extends LlmAdapter {
  beforeResolve?: () => Promise<void>
  streams = 0

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['flash', 'other'].map(id => ({ provider, id, name: id })))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.beforeResolve?.()
    return { provider, id: model, name: model, reasoning: {
      efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    } }
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.streams++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(account = 'a', selected = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-native-models-')))
  const project = join(home, 'project'), dir = join(home, 'profiles', 'models')
  mkdirSync(project)
  mkdirSync(dir, { recursive: true })
  initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"native-model-selection-loader-fixture"}\n')
  const configuration = join(dir, 'cordis.yml'), patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(configuration, '[]\n')
  writeFileSync(patchPath, JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:models-editor' },
    { id: 'settings', name: 'cordis:models-settings' },
    { id: 'default-model', name: 'cordis:models-default', config: { provider: 'approved', model: 'flash' } },
    { id: 'dependencies', name: 'cordis:models-dependencies' },
    { id: 'controller', name: 'cordis:models-controller', config: { nativeOpen: false } },
  ] }]) + '\n')
  const profile: ProfileContext = { name: 'models', startedBundles: [], dir, patchPath,
    installAnchor: join(home, 'package.json'), cwd: project, home, overlays: [], telemetryDisabledEnv: undefined }
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(account), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-model-selection-loader', lifetime: lifetime.signal })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 2, maxWaitersPerAccount: 4 })
  const barrier = saves.createAccount(binding), adapter = new ModelAdapter()
  const manifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: [{ endpoint: 'session/create', handlerId: 'native:sessionController', guard: 'account-project' as const },
      ...selected ? [
        { endpoint: 'session/modelCatalog', handlerId: 'native:sessionController', guard: 'authenticated-account' as const },
        { endpoint: 'session/selectModel', handlerId: 'native:sessionController', guard: 'account-session' as const },
      ] : []], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  const owner: { ctx?: Context; removeHook?: () => Promise<void> } = {}
  const selections: { sessionId: SessionId; data: ModelSelection }[] = []
  const release: Array<() => void> = [], pending: Promise<unknown>[] = []
  let current = true
  const assertCurrent = () => {
    if (!current || lifetime.signal.aborted) throw new CloudApiError('cloud/stale-generation', 'The account generation has ended.')
  }
  onTestFinished(async () => {
    for (const resolve of release) resolve()
    await Promise.allSettled(pending)
    try {
      const stopped = await barrier.stopConfigSaves(Date.now() + 10000)
      expect(stopped.status).toBe('confirmed')
      await owner.removeHook?.()
      saves.releaseAccount(barrier)
      saves.close()
    } finally {
      await owner.ctx?.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })
  const assertActiveScope = (agent: Agent) => {
    assertCurrent()
    if (agent.ctx.get('peAccount') !== binding || owner.ctx?.agents.get(agent.id) !== agent || agent.session.header.cwd !== project) {
      throw new CloudApiError('cloud/forbidden', 'The Session is outside this account project.')
    }
  }
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async (cwd) => { if (cwd !== project) throw new Error('Foreign directory') } },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 131072,
      assertSessionRead: () => {} },
    ...selected ? { modelSelection: { allowedProvider: provider => provider === 'approved',
      allowedModel: (provider, model) => provider === 'approved' && model === 'flash' } } : {},
    assertHandlerEnabled: (id) => { if (id !== 'native:sessionController') throw new Error('Foreign handler') },
    resolveCreate: async request => ({ ...request, cwd: project }),
    assertSessionProject: async (id) => {
      const ctx = owner.ctx
      if (ctx === undefined) throw new Error('Missing original account')
      using observed = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      if (observed.header.cwd !== project) throw new CloudApiError('cloud/forbidden', 'The Session is outside this account project.')
    },
    assertActiveScope,
  }
  const ctx = await boot('native-model-selection-loader', configuration, readProfilePatches('native-model-selection-loader', profile), (root) => {
    owner.ctx = root
    root.provide('profileContext', profile)
    root.provide('peAccount', binding)
    root.provide('appReady', { onReady: (callback: () => void) => { callback(); return () => {} } })
    root.on('session/event', (session, event) => {
      if (event.type === 'model/selection') selections.push({ sessionId: session.id, data: event.data })
    })
    root.inject(['configEditor'], (scope) => { owner.removeHook = installNativeConfigSaveHook(scope, barrier) })
    Object.assign(root.loader.builtins, {
      'models-editor': ConfigEditor, 'models-settings': Settings, 'models-default': DefaultModel,
      'models-dependencies': { async apply(scope: Context) {
        await scope.plugin(TypertRegistry)
        await scope.plugin(RemoteAccess)
        await scope.plugin(Gateway)
        await mountAgentLoopTestDependencies(scope, { workingDirectory: true })
        await mountAgentLoopTestHarness(scope)
        await scope.plugin(NativeQuery)
        scope.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
        scope.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => undefined,
          bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }) })
        scope.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
          maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] },
        admitPromptContent: (content: unknown) => Promise.resolve(content) })
        const llm = scope.get('llm')
        if (llm === undefined) throw new Error('Native LLM did not mount')
        llm.registerAdapter(['approved', 'foreign'], adapter)
      } },
      'models-controller': { inject: [...SessionController.inject, 'peAccount'], Config: SessionController.Config,
        apply(scope: Context, config: ConstructorParameters<typeof SessionController>[1]) {
          createNativeController(scope, binding, assertCurrent, policy, guards, config)
        } },
    })
  })
  const peer: PeerScope = { id: brandString<PeerId>('native-model-' + account), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
  const invoke = <T>(method: string, args: Readonly<Record<string, unknown>>): Promise<T> =>
    ctx.typertGateway.invoke({ namespace: 'session', method, args, peer }) as Promise<T>
  const create = async () => {
    const result = await invoke<{ sessionId: SessionId }>('create', { request: {} })
    const agent = ctx.agents.get(result.sessionId)
    if (agent === undefined) throw new Error('Native Agent creation did not publish')
    return agent
  }
  const select = (request: SessionSelectModelRequest) => invoke<SessionSelectModelValue>('selectModel', { request })
  const gate = () => {
    const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
    release.push(() => { resume.resolve(undefined) })
    adapter.beforeResolve = async () => { entered.resolve(undefined); await resume.promise }
    return { entered: entered.promise, release: () => { delete adapter.beforeResolve; resume.resolve(undefined) },
      track(work: Promise<unknown>) { pending.push(work) } }
  }
  return { ctx, binding, lifetime, adapter, barrier, policy, profile, guards, create, select, gate,
    revoke: () => { current = false }, catalog: () => invoke<ModelCatalog>('modelCatalog', {}),
    events: (agent: Agent) => selections.filter(event => event.sessionId === agent.id),
  }
}

it('serves approved native catalog metadata through Loader/Gateway without creating an Agent', async () => {
  const f = await fixture()
  const catalog = await f.catalog()
  expect(catalog.groups).toEqual([{ id: 'approved', name: 'approved', models: [{ id: 'flash', name: 'flash',
    reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }] }])
  expect(f.ctx.sessions.list()).toHaveLength(0)
  expect(f.adapter.streams).toBe(0)
  expect(inspectNativeController(f.ctx.sessionController, f.binding.recipeVersion, 128).rpcEndpoints)
    .toEqual(expect.arrayContaining([
      { endpoint: 'session/modelCatalog', handlerId: 'native:sessionController', guard: 'authenticated-account' },
      { endpoint: 'session/selectModel', handlerId: 'native:sessionController', guard: 'account-session' },
    ]))
})

it('commits native Session selection and drains its original background default save before returning the fixture', async () => {
  const f = await fixture(), agent = await f.create()
  expect(await f.select({ sessionId: agent.id, provider: 'approved', model: 'flash', reasoningEffort: 'off' }))
    .toEqual({ selected: { provider: 'approved', model: 'flash', reasoningEffort: 'off' } })
  expect(f.events(agent)).toHaveLength(1)
  expect(f.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending)
    .toEqual({ provider: 'approved', model: 'flash', reasoningEffort: 'off' })
  const receipt = await f.barrier.pauseAccountChanges(Date.now() + 10000)
  expect(receipt.status).toBe('confirmed')
  expect(f.barrier.snapshot().pending).toEqual([])
  expect(readFileSync(f.profile.patchPath, 'utf8')).toContain('off')
  f.barrier.resumeAccountChanges()
})

it('rejects foreign routes and invalid native reasoning efforts without selection or default writes', async () => {
  const f = await fixture(), agent = await f.create(), before = readFileSync(f.profile.patchPath, 'utf8')
  await expect(f.select({ sessionId: agent.id, provider: 'foreign', model: 'flash' })).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
  await expect(f.select({ sessionId: agent.id, provider: 'approved', model: 'other' })).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
  await expect(f.select({ sessionId: agent.id, provider: 'approved', model: 'flash', reasoningEffort: 'invalid' }))
    .rejects.toMatchObject({ code: 'session/model-unavailable' })
  expect(f.events(agent)).toEqual([])
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe(before)
  expect(f.barrier.snapshot().pending).toEqual([])
})

it('rejects another account Session through the same native method names while preserving its own model selection', async () => {
  const a = await fixture('a'), b = await fixture('b'), agentA = await a.create(), agentB = await b.create()
  await expect(a.select({ sessionId: agentB.id, provider: 'approved', model: 'flash' })).rejects.toBeDefined()
  expect(a.events(agentA)).toEqual([])
  expect(b.events(agentB)).toEqual([])
  expect(await b.select({ sessionId: agentB.id, provider: 'approved', model: 'flash', reasoningEffort: 'high' }))
    .toEqual({ selected: { provider: 'approved', model: 'flash', reasoningEffort: 'high' } })
})

it.each(['lifetime', 'admission'] as const)('rejects %s ending during actual native model resolution at the commit point', async (ending) => {
  const f = await fixture(), agent = await f.create(), before = readFileSync(f.profile.patchPath, 'utf8'), gate = f.gate()
  const work = f.select({ sessionId: agent.id, provider: 'approved', model: 'flash', reasoningEffort: 'off' })
  gate.track(work)
  const rejected = expect(work).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await gate.entered
  if (ending === 'lifetime') f.lifetime.abort()
  else f.revoke()
  gate.release()
  await rejected
  expect(f.events(agent)).toEqual([])
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe(before)
  expect(f.barrier.snapshot().pending).toEqual([])
})

it('keeps both inherited native model methods closed when their policy and exposure are absent', async () => {
  const f = await fixture('closed', false), agent = await f.create()
  await expect(f.catalog()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.select({ sessionId: agent.id, provider: 'approved', model: 'flash' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(inspectNativeController(f.ctx.sessionController, f.binding.recipeVersion, 128).rpcEndpoints
    .some(row => row.endpoint === 'session/modelCatalog' || row.endpoint === 'session/selectModel')).toBe(false)
  expect(f.events(agent)).toEqual([])
})
