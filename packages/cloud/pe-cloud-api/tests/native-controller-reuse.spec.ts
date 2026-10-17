/** Actual private native Controller assembly through inherited Remote dispatch and shared guards. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionCancelRequest, SessionCreateRequest, SessionCreateValue, SessionForkValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CloudApiError } from '../src/errors.ts'
import { createNativeController, type NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'

type ActiveAgent = NonNullable<ReturnType<Context['agents']['get']>>

class ExactQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Full-text search is outside this fixture.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Full-text search is outside this fixture.')) }
}

class CountingAdapter extends LlmAdapter {
  calls: number = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'controller-reuse-')))
  const project = join(directory, 'approved-project')
  const outside = join(directory, 'outside-project')
  mkdirSync(project)
  mkdirSync(outside)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(DefaultModel, { provider: 'reuse', model: 'native-default' })
  new ExactQuery(ctx)
  // Other-domain fixture providers: no Workspace/Session authorization table.
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {}, resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  })
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1_024, maxImagesPerMessage: 1, maxMessageImageBytes: 1_024, maxImagePixels: 1_024, maxImageDimension: 32, mediaTypes: ['image/png'] },
    admitPromptContent: (content: unknown) => Promise.resolve(content),
  })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('reuse'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-reuse-review', lifetime: lifetime.signal,
  })
  ctx.provide('peAccount', binding)
  const denied = new CloudApiError('cloud/account-unavailable', 'Fixture project is not approved.')
  // One narrow shared policy for this fixture's preverified directory. The
  // synchronous path reads native objects/projections; it creates no approval cache.
  const assertDirectory = (cwd: string | undefined): void => { if (cwd !== project) throw denied }
  const assertCurrent = vi.fn((actual: AccountBinding): void => {
    expect(actual).toBe(binding)
    if (ctx.get('peAccount') !== binding || binding.lifetime.aborted) {
      throw new CloudApiError('cloud/stale-generation', 'Fixture account generation has ended.')
    }
  })
  const assertActiveScope = vi.fn((agent: ActiveAgent): void => {
    assertCurrent(binding)
    if (ctx.agents.get(agent.id) !== agent || agent.ctx.get('peAccount') !== binding) throw denied
    agent.ctx.fiber.assertActive()
    assertDirectory(agent.session.header.cwd)
    assertDirectory(ctx.workingDirectory.get(agent.session))
  })
  const guards = {
    assertHandlerEnabled: vi.fn<NativeSessionGuards['assertHandlerEnabled']>(),
    assertActiveScope,
    resolveCreate: vi.fn(async (request: SessionCreateRequest): Promise<SessionCreateRequest> => {
      if (request.workspaceId !== undefined || request.agentPreset !== undefined) throw denied
      const cwd = await realpath(request.cwd ?? project)
      assertDirectory(cwd)
      return { ...request, cwd }
    }),
    assertSessionProject: vi.fn(async (sessionId: SessionCancelRequest['sessionId']): Promise<void> => {
      using observed = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      assertDirectory(observed.header.cwd)
      const agent = ctx.agents.get(sessionId)
      if (agent !== undefined) assertActiveScope(agent)
    }),
  }
  let instances = 0
  const manifest = {
    recipeVersion: binding.recipeVersion,
    rpcEndpoints: ['create', 'prompt', 'fork', 'cancel'].map(method => ({
      endpoint: 'session/' + method, handlerId: 'native-session',
      guard: method === 'create' ? 'account-project' as const : 'account-session' as const,
    })), streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [],
  }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let controller: SessionController | undefined
  await ctx.plugin({
    inject: [...SessionController.inject, 'workingDirectory', 'peAccount'],
    apply(scope) {
      instances++
      controller = createNativeController(scope, binding, assertCurrent, policy, guards, { nativeOpen: false })
    },
  })
  if (controller === undefined) throw new Error('Fixture controller did not mount.')
  const peer: PeerScope = {
    id: brandString<PeerId>('controller-reuse'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {},
  }
  const adapter = new CountingAdapter()
  ctx.llm.registerAdapter(['reuse'], adapter)
  const invoke = (method: string, request: object): Promise<unknown> => ctx.typertGateway.invoke({
    namespace: 'session', method, args: { request }, peer,
  })
  const create = async (): Promise<SessionCreateValue> => await invoke('create', {}) as SessionCreateValue
  return {
    ctx, controller, project, outside, binding, lifetime, denied, guards, instances, adapter, invoke, create, assertCurrent, policy, peer,
  }
}

it('dispatches inherited native Remote markers to one public Controller subclass, including default create', async () => {
  const { ctx, controller, project, guards, instances, create } = await fixture()
  expect(instances).toBe(1)
  expect(ctx.sessionController).toBeInstanceOf(SessionController)
  const markers = remoteMethods(controller)
  for (const method of ['create', 'prompt', 'fork', 'cancel']) {
    expect(markers.filter(marker => (marker.exportName ?? marker.method) === method)).toHaveLength(1)
  }
  const nativeCreate = vi.spyOn(SessionController.prototype, 'create')
  const result = await create()
  expect(guards.resolveCreate).toHaveBeenCalledOnce()
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({ cwd: project })
  expect(ctx.sessions.get(result.sessionId)!.header.cwd).toBe(project)
  expect(ctx.agents.get(result.sessionId)).toBeDefined()
})

it('waits for async shared create admission and rechecks the epoch before calling native super', async () => {
  const { ctx, binding, guards, invoke } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const real = guards.resolveCreate.getMockImplementation()!
  guards.resolveCreate.mockImplementationOnce(async (request) => {
    const result = await real(request)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const nativeCreate = vi.spyOn(SessionController.prototype, 'create')
  const work = invoke('create', {})
  const rejected = expect(work).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  expect(nativeCreate).not.toHaveBeenCalled()
  expect(ctx.sessions.list()).toEqual([])
  ctx.set('peAccount', { ...binding, epoch: brandString<OwnerEpoch>('2') })
  release.resolve(undefined)
  await rejected
  expect(nativeCreate).not.toHaveBeenCalled()
})

it('guards real native prompt and fork before super, then preserves actual AgentLoop and fork creation', async () => {
  const { ctx, guards, denied, invoke, create, adapter, project } = await fixture()
  const created = await create()
  const nativePrompt = vi.spyOn(SessionController.prototype, 'prompt')
  const nativeFork = vi.spyOn(SessionController.prototype, 'fork')
  guards.assertSessionProject.mockRejectedValueOnce(denied)
  await expect(invoke('prompt', { sessionId: created.sessionId, requestId: 'denied', content: [{ type: 'text', text: 'denied' }] })).rejects.toBe(denied)
  expect(nativePrompt).not.toHaveBeenCalled()
  guards.assertSessionProject.mockRejectedValueOnce(denied)
  await expect(invoke('fork', { sessionId: created.sessionId })).rejects.toBe(denied)
  expect(nativeFork).not.toHaveBeenCalled()
  await expect(invoke('prompt', {
    sessionId: created.sessionId, requestId: 'accepted', mode: 'followup', content: [{ type: 'text', text: 'fork source' }],
  })).resolves.toEqual({ accepted: true })
  await vi.waitFor(() => {
    expect(ctx.agents.get(created.sessionId)!.status).toBe('idle')
    expect(adapter.calls).toBe(1)
    expect(ctx.sessions.get(created.sessionId)!.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
  })
  const result = await invoke('fork', { sessionId: created.sessionId }) as SessionForkValue
  expect(nativePrompt).toHaveBeenCalledOnce()
  expect(nativeFork).toHaveBeenCalledOnce()
  expect(result.sessionId).not.toBe(created.sessionId)
  expect(ctx.sessions.get(result.sessionId)!.header).toMatchObject({ cwd: project, parentSession: created.sessionId, isSeeded: true })
})

it('keeps cancel synchronous using the real attached Agent, account binding and committed WorkingDirectory only', async () => {
  const { ctx, controller, guards, invoke, create } = await fixture()
  const { sessionId } = await create()
  const agent = ctx.agents.get(sessionId)!
  const cancel = vi.spyOn(agent, 'cancel')
  const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
  const resume = vi.spyOn(ctx.agents, 'resume')
  const resolve = vi.spyOn(ctx.fs, 'resolve')
  const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
  guards.assertSessionProject.mockClear()
  guards.assertActiveScope.mockClear()
  const direct = controller.cancel({ sessionId })
  expect(direct).toEqual({ accepted: true })
  expect(direct).not.toBeInstanceOf(Promise)
  await expect(invoke('cancel', { sessionId })).resolves.toEqual({ accepted: true })
  expect(guards.assertActiveScope).toHaveBeenCalledTimes(2)
  expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  expect(guards.assertSessionProject).not.toHaveBeenCalled()
  for (const lookup of [observe, resume, resolve, ensure]) expect(lookup).not.toHaveBeenCalled()
})

it('retains native notfound for a Session without an attached Agent and performs no read or resume', async () => {
  const { ctx, guards, invoke, project } = await fixture()
  const session = ctx.sessions.create(SessionId('attached-session-without-agent'), { meta: { cwd: project } })
  const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
  const resume = vi.spyOn(ctx.agents, 'resume')
  await expect(invoke('cancel', { sessionId: session.id })).rejects.toMatchObject({ code: 'session/not-found' })
  expect(guards.assertActiveScope).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  expect(ctx.sessions.get(session.id)).toBe(session)
})

it('rejects expired bindings or an unapproved committed directory before native cancel without adding I/O', async () => {
  const { ctx, binding, guards, outside, invoke, create } = await fixture()
  const { sessionId } = await create()
  const agent = ctx.agents.get(sessionId)!
  await ctx.workingDirectory.set(agent, outside)
  const nativeCancel = vi.spyOn(SessionController.prototype, 'cancel')
  const resolve = vi.spyOn(ctx.fs, 'resolve')
  const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
  await expect(invoke('cancel', { sessionId })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(guards.assertActiveScope).toHaveBeenCalled()
  ctx.set('peAccount', { ...binding, epoch: brandString<OwnerEpoch>('2') })
  await expect(invoke('cancel', { sessionId })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(nativeCancel).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})

it('leaves native subagent cancellation rejection intact after the shared active-scope check', async () => {
  const { ctx, invoke, create, project } = await fixture()
  const parent = ctx.agents.get((await create()).sessionId)!
  const child = (await ctx.agents.create({
    sessionId: SessionId('native-subagent'), parentAgent: parent,
    meta: { cwd: project, origin: 'subagent', parentSession: parent.id, delegationDepth: 1 },
    agentOptions: { provider: 'reuse', model: 'native-default' },
  })).agent
  const cancelled = vi.spyOn(child, 'cancel')
  await expect(invoke('cancel', { sessionId: child.id })).rejects.toMatchObject({ code: 'session/agent-busy' })
  expect(cancelled).not.toHaveBeenCalled()
})

it('applies async prompt admission before the native resume attempt without creating a resume ledger', async () => {
  const { ctx, guards, denied, invoke, project } = await fixture()
  const session = ctx.sessions.create(SessionId('cold-resume-attempt'), { meta: { cwd: project } })
  const resume = vi.spyOn(ctx.agents, 'resume')
  guards.assertSessionProject.mockRejectedValueOnce(denied)
  const request = { sessionId: session.id, requestId: 'cold', content: [{ type: 'text', text: 'resume' }] }
  await expect(invoke('prompt', request)).rejects.toBe(denied)
  expect(resume).not.toHaveBeenCalled()
  // This fixture deliberately has no persistence backend: the subsequent
  // native failure establishes ordering, not successful persisted recovery.
  await expect(invoke('prompt', request)).rejects.toMatchObject({ code: 'gateway/internal' })
  expect(resume).toHaveBeenCalledOnce()
  expect(ctx.agents.get(session.id)).toBeUndefined()
})

it('keeps Controller admission alive after one request Peer ends and closes only with the graph', async () => {
  const { ctx, peer, binding, lifetime, create, assertCurrent } = await fixture()
  const request = new AbortController()
  await ctx.typertGateway.invoke({
    namespace: 'session', method: 'create', args: { request: {} }, peer: { ...peer, signal: request.signal },
  })
  request.abort()
  const later = await create()
  expect(ctx.agents.get(later.sessionId)).toBeDefined()
  expect(assertCurrent).toHaveBeenCalledWith(binding)
  expect(ctx.sessions.list()).toHaveLength(2)
  lifetime.abort()
  const nativeCreate = vi.spyOn(SessionController.prototype, 'create')
  await expect(create()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(nativeCreate).not.toHaveBeenCalled()
})

it('refuses every protected wire method when its shared handler or graph admission closes', async () => {
  const { guards, assertCurrent, invoke, create } = await fixture()
  const { sessionId } = await create()
  const methods = {
    create: {}, prompt: { sessionId, requestId: 'blocked', content: [{ type: 'text', text: 'blocked' }] },
    fork: { sessionId }, cancel: { sessionId },
  }
  const native = [
    vi.spyOn(SessionController.prototype, 'create'), vi.spyOn(SessionController.prototype, 'prompt'),
    vi.spyOn(SessionController.prototype, 'fork'), vi.spyOn(SessionController.prototype, 'cancel'),
  ]
  const disabled = new Error('handler disabled')
  guards.assertHandlerEnabled.mockImplementation(() => { throw disabled })
  for (const [method, input] of Object.entries(methods)) await expect(invoke(method, input)).rejects.toBe(disabled)
  const stopped = new Error('graph admission closed')
  assertCurrent.mockImplementation(() => { throw stopped })
  for (const [method, input] of Object.entries(methods)) await expect(invoke(method, input)).rejects.toBe(stopped)
  for (const method of native) expect(method).not.toHaveBeenCalled()
})

it('requires an explicit verified create location and preserves the shared resolver failure', async () => {
  const { guards, denied, create } = await fixture()
  const nativeCreate = vi.spyOn(SessionController.prototype, 'create')
  guards.resolveCreate.mockResolvedValueOnce({})
  await expect(create()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  guards.resolveCreate.mockRejectedValueOnce(denied)
  await expect(create()).rejects.toBe(denied)
  expect(nativeCreate).not.toHaveBeenCalled()
})

it('rechecks the exact binding after the synchronous active-scope callback before native cancellation', async () => {
  const { ctx, binding, guards, invoke, create } = await fixture()
  const { sessionId } = await create()
  const nativeCancel = vi.spyOn(SessionController.prototype, 'cancel')
  guards.assertActiveScope.mockImplementationOnce(() => {
    ctx.set('peAccount', { ...binding, epoch: brandString<OwnerEpoch>('2') })
  })
  await expect(invoke('cancel', { sessionId })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(nativeCancel).not.toHaveBeenCalled()
})
