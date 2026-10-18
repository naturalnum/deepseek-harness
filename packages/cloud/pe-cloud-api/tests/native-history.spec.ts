/** Real Gateway/history/JSONL flows; only unrelated recipe services and graph authority use fixtures. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from '../src/errors.ts'
import { createNativeController, type NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'

class ExactQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Unused full-text search.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Unused full-text search.')) }
}

afterEach(() => { vi.restoreAllMocks() })

async function fixture(exposure: 'history' | 'closed' | 'rpc-follow' = 'history') {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'native-history-')))
  const project = join(home, 'project')
  mkdirSync(project)
  const ctx = new Context()
  const streams: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    try { for (const close of streams) await close() }
    finally { try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } }
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Jsonl, { root: join(home, 'sessions') })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(DefaultModel, { provider: 'history', model: 'fixture' })
  new ExactQuery(ctx)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1_024, maxImagesPerMessage: 1, maxMessageImageBytes: 1_024,
      maxImagePixels: 1_024, maxImageDimension: 32, mediaTypes: ['image/png'],
    },
  })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('history'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-m5-history', lifetime: lifetime.signal,
  })
  ctx.provide('peAccount', binding)
  const denied = new CloudApiError('cloud/account-unavailable', 'Fixture scope is not approved.')
  let admitted = true
  const assertCurrent = vi.fn((actual: AccountBinding): void => {
    expect(actual).toBe(binding)
    if (!admitted) throw denied
  })
  const guards = {
    projectDirectory: { binding, prepare: async () => { throw denied } },
    assertHandlerEnabled: vi.fn<NativeSessionGuards['assertHandlerEnabled']>(),
    resolveCreate: vi.fn<NativeSessionGuards['resolveCreate']>(async () => { throw denied }),
    assertActiveScope: vi.fn<NativeSessionGuards['assertActiveScope']>(() => { throw denied }),
    assertSessionProject: vi.fn<NativeSessionGuards['assertSessionProject']>(async (id) => {
      using observed = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      if (observed.header.cwd !== project) throw denied
    }),
  }
  const row = (endpoint: string) => ({ endpoint, handlerId: 'native-history', guard: 'account-session' as const })
  const manifest = {
    recipeVersion: binding.recipeVersion,
    rpcEndpoints: exposure === 'closed' ? [] : [row('session/page'), ...exposure === 'rpc-follow' ? [row('session/follow')] : []],
    streamEndpoints: exposure === 'history' ? [row('session/follow')] : [],
    exactFetchRoutes: [], allowedSettings: [],
  }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let controller: SessionController | undefined
  await ctx.plugin({
    inject: [...SessionController.inject, 'peAccount'],
    apply(scope) { controller = createNativeController(scope, binding, assertCurrent, policy, guards, { nativeOpen: false }) },
  })
  if (controller === undefined) throw new Error('Fixture Controller did not mount.')
  const peer: PeerScope = {
    id: brandString<PeerId>('native-history'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {},
  }
  const cold = async (name = 'cold-history'): Promise<SessionAddress & { kind: 'session' }> => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(name), meta: { cwd: project }, agentOptions: { provider: 'history', model: 'fixture' },
    })
    // JSONL must materialize before release: closing an unwritten empty Session erases it.
    await ctx.sessionPersistence.flush()
    await handle.dispose()
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
    return { kind: 'session', sessionId: handle.agent.id }
  }
  const page = (address: SessionAddress, throughSeq = -1, signal?: AbortSignal): Promise<unknown> => ctx.typertGateway.invoke({
    namespace: 'session', method: 'page', args: { request: { address, throughSeq } }, peer,
    ...signal === undefined ? {} : { signal },
  })
  const follow = async (address: SessionAddress) => {
    const cancel = new AbortController()
    const source = await ctx.typertGateway.stream({
      namespace: 'session', method: 'follow', args: { request: { address, assistantStream: true } }, peer, signal: cancel.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    streams.push(async () => { cancel.abort(); await iterator.return?.() })
    return { iterator, cancel }
  }
  const listeners = () => ['session/event', 'session/created', 'agent/assistant-stream']
    .map(name => ctx.events.dispatch('emit', [name]).length)
  return {
    ctx, controller, project, binding, lifetime, denied, guards, assertCurrent, policy, cold, page, follow, listeners,
    stopAdmission: () => { admitted = false },
  }
}

it.each(['page', 'follow'] as const)('rejects %s scope before any native read or activation', async (method) => {
  const f = await fixture()
  const address = { kind: 'session' as const, sessionId: SessionId('denied-history') }
  f.guards.assertSessionProject.mockRejectedValueOnce(f.denied)
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const native = vi.spyOn(SessionController.prototype, method)
  const work = method === 'page' ? f.page(address) : (await f.follow(address)).iterator.next()
  await expect(work).rejects.toBe(f.denied)
  expect(native).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

it.each(['page', 'follow'] as const)('rechecks the binding after awaited %s project admission', async (method) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.guards.assertSessionProject.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const native = vi.spyOn(SessionController.prototype, method)
  const address = { kind: 'session' as const, sessionId: SessionId('stale-history') }
  const work = method === 'page' ? f.page(address) : (await f.follow(address)).iterator.next()
  const rejected = expect(work).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  f.ctx.set('peAccount', { ...f.binding, epoch: brandString<OwnerEpoch>('2') })
  release.resolve(undefined)
  await rejected
  expect(native).not.toHaveBeenCalled()
})

it.each(['page', 'follow'] as const)('honors caller cancellation during awaited %s admission before native entry', async (method) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.guards.assertSessionProject.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const address = { kind: 'session' as const, sessionId: SessionId('cancel-during-guard') }
  const stream = method === 'follow' ? await f.follow(address) : undefined
  const cancel = stream?.cancel ?? new AbortController()
  const native = vi.spyOn(SessionController.prototype, method)
  const work = stream === undefined ? f.page(address, -1, cancel.signal) : stream.iterator.next()
  const rejected = expect(work).rejects.toMatchObject({ code: 'gateway/cancelled' })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  cancel.abort()
  release.resolve(undefined)
  await rejected
  expect(native).not.toHaveBeenCalled()
})

it('uses native page on real cold JSONL without activating and preserves its validation error', async () => {
  const f = await fixture()
  const address = await f.cold()
  const native = vi.spyOn(SessionController.prototype, 'page')
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  await expect(f.page(address)).resolves.toEqual({ records: [], hasMore: false })
  expect(native).toHaveBeenCalledOnce()
  expect(f.guards.assertSessionProject).toHaveBeenCalledWith(address.sessionId)
  expect(resume).not.toHaveBeenCalled()
  expect(f.ctx.sessions.get(address.sessionId)).toBeUndefined()
  await expect(f.page(address, 1)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(resume).not.toHaveBeenCalled()
})

it('refuses a page result when graph admission closes during the real native read', async () => {
  const f = await fixture()
  const address = await f.cold()
  f.guards.assertSessionProject.mockResolvedValueOnce(undefined)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
    const observed = await observe(...args)
    entered.resolve(undefined)
    await release.promise
    return observed
  })
  const work = f.page(address)
  const rejected = expect(work).rejects.toBe(f.denied)
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  f.stopAdmission()
  release.resolve(undefined)
  await rejected
})

it('retains inherited Remote markers and native follow snapshot, delayed cold promotion and event delivery', async () => {
  const f = await fixture()
  for (const name of ['page', 'follow']) {
    expect(remoteMethods(f.controller).filter(marker => (marker.exportName ?? marker.method) === name)).toHaveLength(1)
  }
  const address = await f.cold()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const requireStream = vi.spyOn(f.policy, 'requireStream')
  const baseline = f.listeners()
  const { iterator } = await f.follow(address)
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot', cursor: -1, records: [] } })
  expect(resume).not.toHaveBeenCalled()
  expect(f.listeners()).toEqual(baseline.map(count => count + 1))
  const next = iterator.next()
  void next.catch(() => {})
  await vi.waitFor(() => { expect(f.ctx.agents.get(address.sessionId)).toBeDefined() })
  expect(resume).toHaveBeenCalledOnce()
  await expect(next).resolves.toMatchObject({ value: { type: 'event', event: { type: 'session/end-seed', seq: 0 } } })
  const event = iterator.next()
  const agent = f.ctx.agents.get(address.sessionId)!
  agent.session.append('model/selection', { provider: 'history', model: 'fixture' })
  await expect(event).resolves.toMatchObject({ value: { type: 'event', event: { type: 'model/selection', seq: 1 } } })
  expect(requireStream).toHaveBeenCalledWith('session/follow')
  const withAgent = f.listeners()
  await iterator.return?.()
  // The resumed Agent retains its own persistence listener; only the three follower listeners leave.
  expect(f.listeners()).toEqual(withAgent.map(count => count - 1))
})

it.each(['gateway', 'controller'] as const)('does not promote when the caller aborts after the %s snapshot', async (entry) => {
  const f = await fixture()
  const address = await f.cold()
  const baseline = f.listeners()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const stream = entry === 'gateway' ? await f.follow(address) : undefined
  const cancel = stream?.cancel ?? new AbortController()
  const iterator = stream?.iterator ?? f.controller.follow({ address, assistantStream: true }, cancel.signal)[Symbol.asyncIterator]()
  if (stream === undefined) onTestFinished(async () => { cancel.abort(); await iterator.return?.() })
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
  cancel.abort()
  await expect(iterator.next()).rejects.toMatchObject(entry === 'gateway' ? { code: 'gateway/cancelled' } : { name: 'AbortError' })
  expect(resume).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(address.sessionId)).toBeUndefined()
  expect(f.listeners()).toEqual(baseline)
})

it('checks before the next native advance so a closed graph cannot begin post-snapshot promotion', async () => {
  const f = await fixture()
  const address = await f.cold()
  const baseline = f.listeners()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const { iterator } = await f.follow(address)
  await iterator.next()
  f.stopAdmission()
  await expect(iterator.next()).rejects.toBe(f.denied)
  expect(resume).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(address.sessionId)).toBeUndefined()
  expect(f.listeners()).toEqual(baseline)
})

it('checks again after an awaited native frame before delivering data', async () => {
  const f = await fixture()
  const address = await f.cold()
  const { iterator } = await f.follow(address)
  await iterator.next()
  // A real empty-history resume announces its native end-seed suffix before waiting for new events.
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { type: 'session/end-seed' } } })
  await vi.waitFor(() => { expect(f.ctx.agents.get(address.sessionId)).toBeDefined() })
  const next = iterator.next()
  void next.catch(() => {})
  f.stopAdmission()
  f.ctx.agents.get(address.sessionId)!.session.append('model/selection', { provider: 'history', model: 'fixture' })
  await expect(next).rejects.toBe(f.denied)
})

it.each(['caller', 'graph'] as const)('propagates %s cancellation into a waiting native iterator and cleans listeners', async (kind) => {
  const f = await fixture()
  const address = await f.cold()
  const { iterator, cancel } = await f.follow(address)
  await iterator.next()
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { type: 'session/end-seed' } } })
  await vi.waitFor(() => { expect(f.ctx.agents.get(address.sessionId)).toBeDefined() })
  const next = iterator.next()
  void next.catch(() => {})
  const withAgent = f.listeners()
  if (kind === 'caller') cancel.abort()
  else f.lifetime.abort()
  await expect(next).rejects.toMatchObject({ code: kind === 'caller' ? 'gateway/cancelled' : 'cloud/stale-generation' })
  expect(f.listeners()).toEqual(withAgent.map(count => count - 1))
})

it.each(['page', 'follow'] as const)('keeps undeclared %s closed before scope or native reads', async (method) => {
  const f = await fixture('closed')
  const address = { kind: 'session' as const, sessionId: SessionId('unexposed') }
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
  const work = method === 'page' ? f.page(address) : (await f.follow(address)).iterator.next()
  await expect(work).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertSessionProject).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})

it('does not accept a unary declaration as follow stream authority', async () => {
  const f = await fixture('rpc-follow')
  const { iterator } = await f.follow({ kind: 'session', sessionId: SessionId('wrong-mode') })
  await expect(iterator.next()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertSessionProject).not.toHaveBeenCalled()
})

it.each(['one-shot', 'continuable', 'unknown'] as const)('explicitly denies the unaudited subagent history mode %s', async (mode) => {
  const f = await fixture()
  const address: SessionAddress = {
    kind: 'subagent', parentSessionId: SessionId('parent'), childSessionId: SessionId('child'), mode,
  }
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
  await expect(f.page(address)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect((await f.follow(address)).iterator.next()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertSessionProject).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})
