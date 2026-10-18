/** Native AgentRegistry/AgentLoop/JSONL transactions with fixture-owned admission and external I/O delays. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-working-directory'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from '../src/errors.ts'
import { createNativeAgentLoop, type NativeAgentFactoryGuards } from '../src/native-agent-factory.ts'

type CreateOptions = Parameters<AgentLoop['createAgent']>[1]
type ResumeOptions = Parameters<AgentLoop['resume']>[1]

class ExactQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Unused full-text search.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Unused full-text search.')) }
}

class LocalAdapter extends LlmAdapter {
  calls: number = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(() => { vi.restoreAllMocks() })

async function fixture(install = true) {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'factory-admission-')))
  const project = join(home, 'project')
  mkdirSync(project)
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Jsonl, { root: join(home, 'sessions') })
  new ExactQuery(ctx)
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('factory'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-m6-factory', lifetime: lifetime.signal,
  })
  ctx.provide('peAccount', binding)
  const denied = new CloudApiError('cloud/account-unavailable', 'Fixture composition is not approved.')
  const assertCurrent = vi.fn((actual: AccountBinding): void => { expect(actual).toBe(binding) })
  const model = { provider: 'factory', model: 'fixture' }
  const checkModel = (options: CreateOptions['agentOptions']): void => {
    if (options?.provider !== model.provider || options.model !== model.model) throw denied
  }
  const checkHeader = (header: NonNullable<CreateOptions['meta']>): void => {
    if (header.cwd !== project || header.origin !== undefined || header.parentSession !== undefined
      || (header.delegationDepth ?? 0) !== 0 || header.isSeeded === true || header.agentPreset !== undefined) throw denied
  }
  const guards = {
    assertCreate: vi.fn<NativeAgentFactoryGuards['assertCreate']>(async (options, signal) => {
      signal.throwIfAborted()
      checkHeader(options.meta ?? {})
      checkModel(options.agentOptions)
    }),
    assertResume: vi.fn<NativeAgentFactoryGuards['assertResume']>(async (options, signal) => {
      using observed = await ctx.sessionQuery.observeSession(options.resumeSessionId, { signal, projectionMode: 'none' })
      checkHeader(observed.header)
      checkModel(options.agentOptions)
    }),
    assertPrepared: vi.fn<NativeAgentFactoryGuards['assertPrepared']>((agent) => {
      checkHeader(agent.session.header)
      checkModel(agent.options)
      if (ctx.workingDirectory.get(agent.session) !== project) throw denied
    }),
  }
  const mount = async (config = AgentLoop.Config({ agents: [] })): Promise<AgentLoop> => {
    let loop: AgentLoop | undefined
    await ctx.plugin({
      inject: [...AgentLoop.inject, 'peAccount'],
      apply(scope) { loop = createNativeAgentLoop(scope, binding, assertCurrent, guards, config) },
    })
    if (loop === undefined) throw new Error('Fixture factory did not mount.')
    return loop
  }
  if (install) await mount()
  const createOptions = (name = 'ordinary'): CreateOptions => ({ sessionId: SessionId(name), meta: { cwd: project }, agentOptions: model })
  const cold = async (name = 'cold'): Promise<ResumeOptions> => {
    const handle = await ctx.agents.create(createOptions(name))
    await ctx.sessionPersistence.flush()
    await handle.dispose()
    return { resumeSessionId: handle.agent.id, agentOptions: model }
  }
  return { ctx, project, binding, lifetime, assertCurrent, guards, denied, model, mount, createOptions, cold }
}

it('rejects nonempty startup agents before native registration or persistence side effects', async () => {
  const f = await fixture(false)
  const setFactory = vi.spyOn(f.ctx.agents, 'setFactory')
  const create = vi.spyOn(f.ctx.sessionPersistence, 'create')
  await expect(f.mount(AgentLoop.Config({ agents: [{ id: 'unreviewed', cwd: f.project }] })))
    .rejects.toBeInstanceOf(CloudApiError)
  expect(setFactory).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(f.ctx.get('agentLoop')).toBeUndefined()
  expect(f.ctx.sessions.list()).toEqual([])
})

it('installs while business admission is closed, then denies creation before native persistence until publication is admitted', async () => {
  const f = await fixture(false)
  f.assertCurrent.mockImplementation(() => { throw f.denied })
  const persistence = vi.spyOn(f.ctx.sessionPersistence, 'create')
  await f.mount()
  expect(f.ctx.get('agentLoop')).toBeDefined()
  expect(f.assertCurrent).not.toHaveBeenCalled()
  await expect(f.ctx.agents.create(f.createOptions())).rejects.toBe(f.denied)
  expect(f.guards.assertCreate).not.toHaveBeenCalled()
  expect(persistence).not.toHaveBeenCalled()
  expect(f.ctx.sessions.list()).toEqual([])
  f.assertCurrent.mockImplementation((actual) => { expect(actual).toBe(f.binding) })
  const created = await f.ctx.agents.create(f.createOptions())
  expect(created.agent.id).toBe(SessionId('ordinary'))
  expect(persistence).toHaveBeenCalledOnce()
})

it('rejects direct create and parent/seeded metadata without entering native create', async () => {
  const f = await fixture()
  const native = vi.spyOn(AgentLoop.prototype, 'createAgent')
  const create = vi.spyOn(f.ctx.sessionPersistence, 'create')
  await expect(f.ctx.agentLoop.create(SessionId('direct'), f.model, { cwd: f.project })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const inputs: CreateOptions[] = [
    { ...f.createOptions(), meta: { cwd: f.project, origin: 'subagent' } },
    { ...f.createOptions(), meta: { cwd: f.project, parentSession: SessionId('parent') } },
    { ...f.createOptions(), meta: { cwd: f.project, delegationDepth: 1 } },
    { ...f.createOptions(), meta: { cwd: f.project, isSeeded: true } },
    { ...f.createOptions(), seed: [] },
  ]
  for (const input of inputs) await expect(f.ctx.agents.create(input)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(native).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('closes live-parent create/resume paths before shared checks or native storage', async () => {
  const f = await fixture()
  const parent = (await f.ctx.agents.create(f.createOptions('parent'))).agent
  f.guards.assertCreate.mockClear()
  const create = vi.spyOn(f.ctx.sessionPersistence, 'create')
  const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  await expect(f.ctx.agents.create({ ...f.createOptions('child'), parentAgent: parent }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.ctx.agents.resume({ resumeSessionId: parent.id, parentAgent: parent, agentOptions: f.model }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertCreate).not.toHaveBeenCalled()
  expect(f.guards.assertResume).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it.each(['subagent', 'parent', 'preset'] as const)('rejects persisted %s metadata through the shared read before write-open', async (kind) => {
  const f = await fixture()
  const id = SessionId('unreviewed-history')
  const meta = kind === 'subagent'
    ? { cwd: f.project, origin: 'subagent' as const, parentSession: SessionId('parent'), delegationDepth: 1 }
    : kind === 'parent' ? { cwd: f.project, parentSession: SessionId('parent') } : { cwd: f.project, agentPreset: 'unknown' }
  const detached = f.ctx.sessions.prepare(id, { meta })
  const handle = await f.ctx.sessionPersistence.create(detached.header)
  await handle.flush()
  await handle.close()
  const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  await expect(f.ctx.agents.resume({ resumeSessionId: id, agentOptions: f.model })).rejects.toBe(f.denied)
  expect(open.mock.calls.some(call => call[1] === 'read')).toBe(true)
  expect(open.mock.calls.some(call => call[1] === 'write')).toBe(false)
  expect(f.ctx.agents.get(id)).toBeUndefined()
})

it('runs the shared create guard before persistence and refuses unknown Preset/model inputs', async () => {
  const f = await fixture()
  const create = vi.spyOn(f.ctx.sessionPersistence, 'create')
  f.guards.assertCreate.mockRejectedValueOnce(f.denied)
  await expect(f.ctx.agents.create(f.createOptions())).rejects.toBe(f.denied)
  await expect(f.ctx.agents.create({ ...f.createOptions(), meta: { cwd: f.project, agentPreset: 'unknown' } })).rejects.toBe(f.denied)
  await expect(f.ctx.agents.create({ ...f.createOptions(), agentOptions: { provider: 'other', model: 'unknown' } })).rejects.toBe(f.denied)
  expect(create).not.toHaveBeenCalled()
})

it('preserves original setup/commit ordering and publishes exactly the prepared native Agent', async () => {
  const f = await fixture()
  const options = f.createOptions()
  const order: string[] = []
  const originalPrepared = f.guards.assertPrepared.getMockImplementation()!
  f.guards.assertPrepared.mockImplementation((agent) => {
    originalPrepared(agent)
    expect(f.ctx.agents.get(agent.id)).toBeUndefined()
    expect(f.ctx.sessions.get(agent.id)).toBeUndefined()
    order.push('guard')
  })
  const handle = await f.ctx.agents.create({ ...options, setup: async (_scope, agent) => {
    expect(f.ctx.agents.get(agent.id)).toBeUndefined()
    order.push('setup')
    return { commit(): void { order.push('commit') } }
  } })
  expect(order).toEqual(['setup', 'guard', 'guard', 'commit', 'guard'])
  expect(f.ctx.agents.get(options.sessionId)).toBe(handle.agent)
  expect(f.ctx.sessions.get(options.sessionId)).toBe(handle.agent.session)
  await handle.dispose()
  expect(f.ctx.agents.get(options.sessionId)).toBeUndefined()
  expect(f.ctx.sessions.get(options.sessionId)).toBeUndefined()
})

it.each(['setup', 'commit', 'prepared'] as const)('preserves %s failure identity and native unpublished rollback', async (phase) => {
  const f = await fixture()
  const options = f.createOptions('rollback')
  const failure = new Error('original native transaction failure')
  const disposed = vi.fn()
  if (phase === 'prepared') f.guards.assertPrepared.mockImplementationOnce(() => { throw failure })
  await expect(f.ctx.agents.create({ ...options, setup: async (scope) => {
    scope.effect(() => () => { disposed() })
    if (phase === 'setup') throw failure
    return { commit(): void { if (phase === 'commit') throw failure } }
  } })).rejects.toBe(failure)
  expect(disposed).toHaveBeenCalledOnce()
  expect(f.ctx.agents.get(options.sessionId)).toBeUndefined()
  expect(f.ctx.sessions.get(options.sessionId)).toBeUndefined()
  expect(await f.ctx.sessionPersistence.stat(options.sessionId)).toBeUndefined()
  const retry = await f.ctx.agents.create(options)
  await retry.dispose()
})

it('rechecks binding after awaited setup and after an original commit changes the graph', async () => {
  for (const phase of ['setup', 'commit'] as const) {
    const f = await fixture()
    const options = f.createOptions('stale-prepared')
    const disposed = vi.fn()
    await expect(f.ctx.agents.create({ ...options, setup: async (scope) => {
      scope.effect(() => () => { disposed() })
      if (phase === 'setup') {
        await Promise.resolve()
        f.ctx.set('peAccount', { ...f.binding, epoch: brandString<OwnerEpoch>('2') })
      }
      return { commit(): void {
        if (phase === 'commit') f.ctx.set('peAccount', { ...f.binding, epoch: brandString<OwnerEpoch>('2') })
      } }
    } })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(disposed).toHaveBeenCalledOnce()
    expect(f.ctx.agents.get(options.sessionId)).toBeUndefined()
    expect(f.ctx.sessions.get(options.sessionId)).toBeUndefined()
  }
})

it('performs a real cold JSONL resume through the shared preflight and native setup/commit', async () => {
  const f = await fixture()
  const options = await f.cold()
  const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  const order: string[] = []
  const resume = f.guards.assertResume.getMockImplementation()!
  f.guards.assertResume.mockImplementation(async (input, signal) => {
    using observed = await f.ctx.sessionQuery.observeSession(input.resumeSessionId, { signal, projectionMode: 'none' })
    expect(observed.header.cwd).toBe(f.project)
    expect(observed.header.origin).toBeUndefined()
    expect(observed.header.parentSession).toBeUndefined()
    expect(observed.header.delegationDepth).toBe(0)
    expect(observed.header.isSeeded).not.toBe(true)
    expect(observed.header.agentPreset).toBeUndefined()
    expect(input.agentOptions).toMatchObject(f.model)
    await resume(input, signal)
  })
  const prepared = f.guards.assertPrepared.getMockImplementation()!
  f.guards.assertPrepared.mockImplementation((agent) => {
    expect(agent.session.header.cwd).toBe(f.project)
    expect(agent.options).toMatchObject(f.model)
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(f.project)
    prepared(agent)
  })
  const handle = await f.ctx.agents.resume({ ...options, setup: async (_scope, agent) => {
    expect(f.ctx.agents.get(agent.id)).toBeUndefined()
    order.push('setup')
    return { commit(): void { order.push('commit') } }
  } })
  expect(order).toEqual(['setup', 'commit'])
  expect(f.guards.assertResume).toHaveBeenCalledOnce()
  expect(open.mock.calls.some(call => call[1] === 'read')).toBe(true)
  expect(open.mock.calls.filter(call => call[1] === 'write')).toHaveLength(1)
  expect(f.ctx.agents.get(options.resumeSessionId)).toBe(handle.agent)
  await handle.dispose()
  const lock = await f.ctx.sessionPersistence.open(options.resumeSessionId, 'write')
  await lock.close()
})

it('rejects resume before write-open and retains native backend failure identity', async () => {
  const f = await fixture()
  const options = await f.cold()
  const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  f.guards.assertResume.mockRejectedValueOnce(f.denied)
  await expect(f.ctx.agents.resume(options)).rejects.toBe(f.denied)
  expect(open).not.toHaveBeenCalled()
  const failure = new Error('external backend unavailable')
  f.guards.assertResume.mockResolvedValueOnce(undefined)
  open.mockRejectedValueOnce(failure)
  await expect(f.ctx.agents.resume(options)).rejects.toBe(failure)
  expect(f.ctx.agents.get(options.resumeSessionId)).toBeUndefined()
})

it('preserves native single-writer ownership for simultaneous cold resumes', async () => {
  const f = await fixture()
  const options = await f.cold()
  const results = await Promise.allSettled([f.ctx.agents.resume(options), f.ctx.agents.resume(options)])
  const success = results.filter(result => result.status === 'fulfilled')
  const failure = results.filter(result => result.status === 'rejected')
  expect(success).toHaveLength(1)
  expect(failure).toHaveLength(1)
  expect(failure[0]!.reason).toMatchObject({ name: 'SessionAlreadyOwnedError' })
  expect(f.ctx.agents.get(options.resumeSessionId)).toBe(success[0]!.value.agent)
  await success[0]!.value.dispose()
})

it('guards before native crash repair and retains repaired history when later setup rolls back', async () => {
  const f = await fixture()
  const id = SessionId('interrupted')
  const detached = f.ctx.sessions.prepare(id, { meta: { cwd: f.project } })
  const seed = await f.ctx.sessionPersistence.create(detached.header)
  await seed.append([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }])
  await seed.close()
  const options: ResumeOptions = { resumeSessionId: id, agentOptions: f.model }
  const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  await expect(f.ctx.agents.resume({ ...options, agentOptions: { provider: 'unknown', model: 'unknown' } })).rejects.toBe(f.denied)
  expect(open.mock.calls.some(call => call[1] === 'write')).toBe(false)
  const untouched = await f.ctx.sessionPersistence.open(id, 'read')
  try { expect((await untouched.read()).events.map(event => event.type)).toEqual(['turn/start']) }
  finally { await untouched.close() }
  const failure = new Error('original resume setup failed')
  await expect(f.ctx.agents.resume({ ...options, setup: () => { throw failure } })).rejects.toBe(failure)
  expect(f.ctx.agents.get(id)).toBeUndefined()
  expect(f.ctx.sessions.get(id)).toBeUndefined()
  const repaired = await f.ctx.sessionPersistence.open(id, 'write')
  try {
    const events = (await repaired.read()).events
    expect(events[0]?.type).toBe('turn/start')
    expect(events.some(event => event.type === 'turn/end')).toBe(true)
  } finally { await repaired.close() }
})

it('retains a late native write-open until actual close after caller cancellation', async () => {
  const f = await fixture()
  const options = await f.cold()
  const caller = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const nativeOpen = f.ctx.sessionPersistence.open.bind(f.ctx.sessionPersistence)
  const closed = vi.fn()
  let delayed = false
  vi.spyOn(f.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args)
    if (args[1] === 'write' && !delayed) {
      delayed = true
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closed() })
      entered.resolve(undefined)
      await release.promise
    }
    return handle
  })
  const work = f.ctx.agents.resume({ ...options, signal: caller.signal })
  void work.catch(() => {})
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  caller.abort(new Error('caller ended during write-open'))
  await expect(work).rejects.toBeInstanceOf(Error)
  expect(closed).not.toHaveBeenCalled()
  await expect(nativeOpen(options.resumeSessionId, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
  release.resolve(undefined)
  await vi.waitFor(() => { expect(closed).toHaveBeenCalledOnce() })
  expect(f.ctx.agents.get(options.resumeSessionId)).toBeUndefined()
  const recovered = await nativeOpen(options.resumeSessionId, 'write')
  await recovered.close()
})

it.each(['create', 'resume'] as const)('rejects old binding after the awaited %s preflight before native writing', async (method) => {
  const f = await fixture()
  const resumeOptions = method === 'resume' ? await f.cold() : undefined
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const guard = method === 'create' ? f.guards.assertCreate : f.guards.assertResume
  guard.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const storedCreate = vi.spyOn(f.ctx.sessionPersistence, 'create')
  const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  const work = resumeOptions === undefined ? f.ctx.agents.create(f.createOptions()) : f.ctx.agents.resume(resumeOptions)
  void work.catch(() => {})
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  f.ctx.set('peAccount', { ...f.binding, epoch: brandString<OwnerEpoch>('2') })
  release.resolve(undefined)
  await expect(work).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(storedCreate).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it.each(['caller', 'graph'] as const)('waits for actual preflight settlement on %s cancellation and never creates storage', async (kind) => {
  const f = await fixture()
  const caller = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.guards.assertCreate.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const storedCreate = vi.spyOn(f.ctx.sessionPersistence, 'create')
  let settled = false
  const work = f.ctx.agents.create({ ...f.createOptions(), signal: caller.signal })
  void work.then(() => { settled = true }, () => { settled = true })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  if (kind === 'caller') caller.abort(new Error('caller ended'))
  else f.lifetime.abort(new Error('graph ended'))
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.guards.assertCreate.mock.calls[0]![1].aborted).toBe(true)
  release.resolve(undefined)
  await expect(work).rejects.toBeInstanceOf(Error)
  expect(storedCreate).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(SessionId('ordinary'))).toBeUndefined()
})

it.each(['caller', 'graph'] as const)('propagates %s cancellation through native setup rollback and releases its real writer', async (kind) => {
  const f = await fixture()
  const caller = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const disposed = vi.fn()
  let setupSettled = false
  const options = f.createOptions()
  const work = f.ctx.agents.create({ ...options, signal: caller.signal, setup: async (scope) => {
    scope.effect(() => () => { disposed() })
    const signal = f.guards.assertCreate.mock.calls[0]![1]
    entered.resolve(undefined)
    try {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Fixture setup was cancelled.'))
        }, { once: true })
      })
    } finally { setupSettled = true }
  } })
  void work.catch(() => {})
  await entered.promise
  if (kind === 'caller') caller.abort(new Error('caller ended'))
  else f.lifetime.abort(new Error('graph ended'))
  await expect(work).rejects.toBeInstanceOf(Error)
  expect(setupSettled).toBe(true)
  expect(disposed).toHaveBeenCalledOnce()
  expect(f.ctx.agents.get(options.sessionId)).toBeUndefined()
  expect(f.ctx.sessions.get(options.sessionId)).toBeUndefined()
  expect(await f.ctx.sessionPersistence.stat(options.sessionId)).toBeUndefined()
})

it('waits for post-commit native append settlement and rejects graph-aborted publication', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const storedCreate = f.ctx.sessionPersistence.create.bind(f.ctx.sessionPersistence)
  const closed = vi.fn()
  let appended = false
  let committed = false
  let settled = false
  vi.spyOn(f.ctx.sessionPersistence, 'create').mockImplementationOnce(async (...args) => {
    const handle = await storedCreate(...args)
    const append = handle.append.bind(handle)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'append').mockImplementationOnce(async (...batch) => {
      entered.resolve(undefined)
      await release.promise
      await append(...batch)
      appended = true
    })
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closed() })
    return handle
  })
  const enterAgent = vi.spyOn(f.ctx.agents, 'enter')
  const enterSession = vi.spyOn(f.ctx.sessions, 'enter')
  const options = f.createOptions('post-commit')
  const work = f.ctx.agents.create({ ...options, setup: (_scope, agent) => {
    agent.session.append('model/selection', f.model)
    return { commit(): void { committed = true } }
  } })
  void work.then(() => { settled = true }, () => { settled = true })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  expect(committed).toBe(true)
  const reason = new Error('graph ended during native append')
  f.lifetime.abort(reason)
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(closed).not.toHaveBeenCalled()
  release.resolve(undefined)
  await expect(work).rejects.toBe(reason)
  expect(appended).toBe(true)
  expect(closed).toHaveBeenCalledOnce()
  expect(enterAgent).not.toHaveBeenCalled()
  expect(enterSession).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(options.sessionId)).toBeUndefined()
  expect(f.ctx.sessions.get(options.sessionId)).toBeUndefined()
  const writer = await f.ctx.sessionPersistence.open(options.sessionId, 'write')
  try { expect((await writer.read()).events.map(event => event.type)).toEqual(['model/selection']) }
  finally { await writer.close() }
})

it('preserves creation-only caller cancellation after publication and retains native handle ownership', async () => {
  const f = await fixture()
  const adapter = new LocalAdapter()
  f.ctx.llm.registerAdapter(['factory'], adapter)
  const caller = new AbortController()
  const handle = await f.ctx.agents.create({ ...f.createOptions('committed'), signal: caller.signal })
  const cancel = vi.spyOn(handle.agent, 'cancel')
  caller.abort(new Error('HTTP request ended after publication'))
  expect(f.ctx.agents.get(handle.agent.id)).toBe(handle.agent)
  expect(cancel).not.toHaveBeenCalled()
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(adapter.calls).toBe(1) })
  await handle.agent.whenIdle()
  expect(cancel).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(handle.agent.id)).toBe(handle.agent)
  await handle.dispose()
  expect(f.ctx.agents.get(handle.agent.id)).toBeUndefined()
})
