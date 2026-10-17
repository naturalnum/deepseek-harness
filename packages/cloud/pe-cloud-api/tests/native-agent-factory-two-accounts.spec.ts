/** Factory-only native Loader/JSONL composition; no Workspace, owner acquisition, or ready fixture. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot } from '@deepseek-ai/dsh-app-boot'
import NativeLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { afterEach, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { CloudApiError } from '../src/errors.ts'
import { createNativeAgentLoop, type NativeAgentFactoryGuards } from '../src/native-agent-factory.ts'

type LoopConfig = ConstructorParameters<typeof NativeLoop>[1]
type MountFactory = (scope: Context, config: LoopConfig) => NativeLoop
type AgentHandle = Awaited<ReturnType<NativeLoop['createAgent']>>
type Agent = AgentHandle['agent']

/** Only the external model is deterministic; the real loop owns every request and durable event. */
class AccountAdapter extends LlmAdapter {
  calls = 0
  constructor(private readonly account: string) { super() }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    const text = 'native-reply-only-' + this.account
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Real native graph booted exclusively from a cordis.yml and approved builtins. */
function accountFixture(account: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'm6-native-two-accounts-')))
  const project = join(home, 'project-' + account)
  const storageRoot = join(home, 'sessions')
  const configuration = join(home, 'cordis.yml')
  mkdirSync(project)
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>(account), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'm6-factory-only-fixture', lifetime: lifetime.signal,
  })
  const adapter = new AccountAdapter(account)
  let context: Context | undefined
  let factory: NativeLoop | undefined
  let current = true
  let factoryInstances = 0
  const created = { sessions: 0, agents: 0 }
  const probes: {
    setFactory?: MockInstance<Context['agents']['setFactory']>
    prepare?: MockInstance<Context['sessions']['prepare']>
    create?: MockInstance<Context['sessionPersistence']['create']>
    open?: MockInstance<Context['sessionPersistence']['open']>
    projection?: MockInstance<Context['sessionProjections']['register']>
  } = {}
  onTestFinished(async () => {
    try { await context?.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const assertCurrent = (actual: AccountBinding): void => {
    if (actual !== binding || !current || lifetime.signal.aborted || context?.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'M6 fixture generation has ended.')
    }
  }
  const assertDirectory = (cwd: string | undefined): void => {
    if (cwd !== project) throw new CloudApiError('cloud/forbidden', 'M6 fixture project is not approved.')
  }
  const start = async (mountFactory: MountFactory, configuredAgents: LoopConfig['agents'] = []): Promise<Context> => {
    const fixtureLoop = {
      name: 'm6-account-loop',
      inject: [...NativeLoop.inject, 'peAccount', 'fs', 'workingDirectory', 'sessionPersistence'],
      Config: NativeLoop.Config,
      apply(scope: Context, config: LoopConfig): void {
        probes.setFactory = vi.spyOn(scope.agents, 'setFactory')
        probes.prepare = vi.spyOn(scope.sessions, 'prepare')
        probes.create = vi.spyOn(scope.sessionPersistence, 'create')
        probes.open = vi.spyOn(scope.sessionPersistence, 'open')
        probes.projection = vi.spyOn(scope.sessionProjections, 'register')
        factory = mountFactory(scope, config)
        factoryInstances++
      },
    }
    const modelProvider = {
      name: 'm6-model-provider', inject: ['llm'], Config: z.object({}),
      apply(scope: Context): void { scope.llm.registerAdapter(['m6-fixture'], adapter) },
    }
    const nativeDependencies = {
      name: 'm6-native-dependencies', inject: [], Config: z.object({}),
      async apply(scope: Context): Promise<void> {
        // The public testkit mounts the real prerequisites, including the sole AgentRegistry.
        // It deliberately does not mount AgentLoop or persistence; those remain actual Loader rows.
        await mountAgentLoopTestDependencies(scope, { workingDirectory: true })
      },
    }
    const rows = [
      { id: 'native-dependencies', name: 'cordis:m6-native-dependencies', config: {} },
      // The loop consumes persistence, so Loader's injection topology owns ordered teardown.
      { id: 'jsonl', name: 'cordis:m6-jsonl', config: { root: storageRoot, compression: 'none' } },
      { id: 'model', name: 'cordis:m6-model' },
      { id: 'account-loop', name: 'cordis:m6-account-loop', config: { agents: configuredAgents } },
    ]
    writeFileSync(configuration, JSON.stringify(rows))
    return boot('m6-native-factory', configuration, [], (root) => {
      context = root
      // Component-test input only: no RuntimeBinding constructor, PG owner, factory ready or participants.
      root.provide('peAccount', binding)
      root.on('session/created', () => { created.sessions++ })
      root.on('agent/created', () => { created.agents++ })
      Object.assign(root.loader.builtins, {
        'm6-native-dependencies': nativeDependencies, 'm6-jsonl': Jsonl,
        'm6-model': modelProvider, 'm6-account-loop': fixtureLoop,
      })
    })
  }
  return {
    account, home, project, storageRoot, binding, lifetime, adapter, created, probes,
    assertCurrent, assertDirectory, start,
    context(): Context { if (context === undefined) throw new Error('fixture has not started'); return context },
    factory(): NativeLoop { if (factory === undefined) throw new Error('fixture factory did not mount'); return factory },
    factoryInstances: () => factoryInstances,
    expire(): void { current = false; lifetime.abort() },
  }
}

/** Drive an actual native model turn, including a durable account-specific user message. */
async function finishTurn(ctx: Context, agent: Agent, tag: string): Promise<void> {
  const before = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'native-question-only-' + tag }], source: { kind: 'user' },
  }))
  await vi.waitFor(() => {
    expect(agent.status).toBe('idle')
    expect(agent.session.snapshotEvents().some(event => event.seq >= before && event.type === 'turn/end')).toBe(true)
  })
  await ctx.sessionPersistence.flush()
}

/** Read through the native public persistence seam; actual kernel-backed locks are never mocked. */
async function storedEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try { return (await handle.read()).events }
  finally { await handle.close() }
}

/** Inspect physical JSONL bytes without copying backend path rules. */
function physicalLogs(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
}

/** Original native handle disposal makes both registries cold before resume. */
async function makeCold(ctx: Context, handle: AgentHandle): Promise<void> {
  await ctx.sessionPersistence.flush()
  await handle.dispose()
  expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
  expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
}

afterEach(() => { vi.restoreAllMocks() })

/** One fixture-only future project/model policy; no Session approval cache or second store. */
function installer(fixture: ReturnType<typeof accountFixture>): MountFactory {
  return (scope, config) => {
    const assertModel = (provider: string | undefined, model: string | undefined, preset: string | undefined): void => {
      if (provider !== 'm6-fixture' || model !== fixture.account + '-model' || preset !== undefined) {
        throw new CloudApiError('cloud/forbidden', 'M6 fixture model or Preset is not approved.')
      }
    }
    const guards: NativeAgentFactoryGuards = {
      async assertCreate(options, signal) {
        signal.throwIfAborted()
        fixture.assertDirectory(options.meta?.cwd)
        assertModel(options.agentOptions?.provider, options.agentOptions?.model, options.meta?.agentPreset)
      },
      async assertResume(options, signal) {
        signal.throwIfAborted()
        // Real account-root JSONL read: no shadow Session/Workspace/approval metadata.
        const read = await scope.sessionPersistence.open(options.resumeSessionId, 'read', { signal })
        try {
          await read.read(0, undefined, { signal })
          signal.throwIfAborted()
          const header = read.header
          fixture.assertDirectory(header.cwd)
          if (header.origin !== undefined || header.parentSession !== undefined
            || header.isSeeded || header.delegationDepth !== 0) {
            throw new CloudApiError('cloud/forbidden', 'M6 fixture accepts ordinary root history only.')
          }
          assertModel(options.agentOptions?.provider, options.agentOptions?.model, header.agentPreset)
        } finally { await read.close() }
      },
      assertPrepared(agent) {
        fixture.assertDirectory(agent.session.header.cwd)
        expect(agent.ctx.root).toBe(fixture.context().root)
        assertModel(agent.options.provider, agent.options.model, agent.session.header.agentPreset)
      },
    }
    return createNativeAgentLoop(scope, fixture.binding, fixture.assertCurrent, guards, config)
  }
}

function options(fixture: ReturnType<typeof accountFixture>, sessionId: SessionId) {
  return { sessionId, meta: { cwd: fixture.project },
    agentOptions: { provider: 'm6-fixture', model: fixture.account + '-model' } }
}

it('boots A/B with one native factory and registry each, persists the same id independently, and cold-resumes both', async () => {
  const a = accountFixture('A')
  const b = accountFixture('B')
  const [ctxA, ctxB] = await Promise.all([a.start(installer(a)), b.start(installer(b))])
  expect(ctxA).not.toBe(ctxB)
  expect(ctxA.root).toBe(ctxA)
  expect(ctxB.root).toBe(ctxB)
  expect(ctxA.agents).not.toBe(ctxB.agents)
  expect(ctxA.agentLoop).not.toBe(ctxB.agentLoop)
  for (const fixture of [a, b]) {
    const ctx = fixture.context()
    expect(ctx.agents.constructor.name).toBe('AgentRegistry')
    expect(ctx.agentLoop).toBeInstanceOf(NativeLoop)
    expect(fixture.factoryInstances()).toBe(1)
    expect(fixture.probes.setFactory).toHaveBeenCalledOnce()
    const registries = [...ctx.registry.values()].filter(runtime => runtime.callback.name === 'AgentRegistry')
    expect(registries).toHaveLength(1)
    expect(registries[0]?.fibers).toHaveLength(1)
    expect([...ctx.loader.entries()].filter(entry => entry.options.name === 'cordis:m6-account-loop')).toHaveLength(1)
    expect(ctx.get('workspaceRegistry')).toBeUndefined()
    expect(ctx.get('peAccountRuntime')).toBeUndefined()
  }
  const id = SessionId('same-node-same-session-id')
  const setupA = vi.fn(async (scope: Context, agent: Agent) => {
    expect(scope.root).toBe(ctxA)
    expect(ctxA.agents.get(id)).toBeUndefined()
    return { commit: vi.fn(() => { expect(ctxA.sessions.get(agent.id)).toBeUndefined() }) }
  })
  const setupB = vi.fn(async (scope: Context, agent: Agent) => {
    expect(scope.root).toBe(ctxB)
    expect(ctxB.agents.get(id)).toBeUndefined()
    return { commit: vi.fn(() => { expect(ctxB.sessions.get(agent.id)).toBeUndefined() }) }
  })
  const [handleA, handleB] = await Promise.all([
    ctxA.agents.create({ ...options(a, id), setup: setupA }),
    ctxB.agents.create({ ...options(b, id), setup: setupB }),
  ])
  expect(handleA.agent).not.toBe(handleB.agent)
  expect(handleA.agent.id).toBe(id)
  expect(handleB.agent.id).toBe(id)
  expect(handleA.agent.session.header.cwd).toBe(a.project)
  expect(handleB.agent.session.header.cwd).toBe(b.project)
  await Promise.all([finishTurn(ctxA, handleA.agent, 'A'), finishTurn(ctxB, handleB.agent, 'B')])
  await Promise.all([makeCold(ctxA, handleA), makeCold(ctxB, handleB)])
  const [storedA, storedB] = await Promise.all([storedEvents(ctxA, id), storedEvents(ctxB, id)])
  expect(JSON.stringify(storedA)).toContain('native-reply-only-A')
  expect(JSON.stringify(storedA)).not.toContain('native-reply-only-B')
  expect(JSON.stringify(storedB)).toContain('native-reply-only-B')
  expect(JSON.stringify(storedB)).not.toContain('native-reply-only-A')
  const logsA = physicalLogs(a.storageRoot)
  const logsB = physicalLogs(b.storageRoot)
  expect(logsA).toHaveLength(1)
  expect(logsB).toHaveLength(1)
  expect(logsA[0]).toContain(a.project)
  expect(logsA[0]).not.toContain(b.project)
  expect(logsB[0]).toContain(b.project)
  expect(logsB[0]).not.toContain(a.project)
  const [resumedA, resumedB] = await Promise.all([
    ctxA.agents.resume({ resumeSessionId: id, agentOptions: options(a, id).agentOptions, setup: setupA }),
    ctxB.agents.resume({ resumeSessionId: id, agentOptions: options(b, id).agentOptions, setup: setupB }),
  ])
  expect(resumedA.agent).not.toBe(handleA.agent)
  expect(resumedB.agent).not.toBe(handleB.agent)
  expect(resumedA.agent.session.header.cwd).toBe(a.project)
  expect(resumedB.agent.session.header.cwd).toBe(b.project)
  expect(JSON.stringify(resumedA.agent.session.snapshotEvents())).not.toContain('native-reply-only-B')
  expect(JSON.stringify(resumedB.agent.session.snapshotEvents())).not.toContain('native-reply-only-A')
  await Promise.all([finishTurn(ctxA, resumedA.agent, 'A-resumed'), finishTurn(ctxB, resumedB.agent, 'B-resumed')])
  expect(a.adapter.calls).toBe(2)
  expect(b.adapter.calls).toBe(2)
  for (const setup of [setupA, setupB]) {
    expect(setup).toHaveBeenCalledTimes(2)
    for (const result of setup.mock.results) {
      if (result.type !== 'return') throw new Error('native setup unexpectedly threw')
      expect((await result.value).commit).toHaveBeenCalledOnce()
    }
  }
  await Promise.all([makeCold(ctxA, resumedA), makeCold(ctxB, resumedB)])
})

it('rejects A with a B owner or parent and rejects expired A before native I/O, while B remains usable', async () => {
  const a = accountFixture('A')
  const b = accountFixture('B')
  const [ctxA, ctxB] = await Promise.all([a.start(installer(a)), b.start(installer(b))])
  const id = SessionId('same-id-owner-isolation')
  const [handleA, handleB] = await Promise.all([ctxA.agents.create(options(a, id)), ctxB.agents.create(options(b, id))])
  await finishTurn(ctxA, handleA.agent, 'A-before-expiry')
  await makeCold(ctxA, handleA)
  const nativeCreate = vi.spyOn(NativeLoop.prototype, 'createAgent')
  const nativeResume = vi.spyOn(NativeLoop.prototype, 'resume')
  a.probes.create?.mockClear()
  a.probes.open?.mockClear()
  await expect(a.factory().createAgent(ctxB, options(a, SessionId('foreign-owner')))).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(a.factory().resume(ctxB, { resumeSessionId: id, agentOptions: options(a, id).agentOptions })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(ctxA.agents.create({ ...options(a, SessionId('foreign-parent')), parentAgent: handleB.agent })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(ctxA.agents.resume({ resumeSessionId: id, parentAgent: handleB.agent,
    agentOptions: options(a, id).agentOptions })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  a.expire()
  await expect(ctxA.agents.create(options(a, SessionId('expired-generation')))).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(ctxA.agents.resume({ resumeSessionId: id, agentOptions: options(a, id).agentOptions })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(nativeCreate).not.toHaveBeenCalled()
  expect(nativeResume).not.toHaveBeenCalled()
  expect(a.probes.create).not.toHaveBeenCalled()
  expect(a.probes.open).not.toHaveBeenCalled()
  expect(ctxA.sessions.list()).toEqual([])
  expect(ctxA.agents.list()).toEqual([])
  expect(ctxB.agents.get(id)).toBe(handleB.agent)
  await finishTurn(ctxB, handleB.agent, 'B-still-live')
  const another = await ctxB.agents.create(options(b, SessionId('B-still-creates')))
  expect(nativeCreate).toHaveBeenCalledOnce()
  expect(a.adapter.calls).toBe(1)
  expect(b.adapter.calls).toBe(1)
  await Promise.all([makeCold(ctxB, handleB), makeCold(ctxB, another)])
})

it('rejects nonempty configured agents before native factory registration, projections, Sessions, persistence or model startup', async () => {
  const fixture = accountFixture('constructor')
  const nativeCreate = vi.spyOn(NativeLoop.prototype, 'createAgent')
  const directCreate = vi.spyOn(NativeLoop.prototype, 'create')
  const nativeResume = vi.spyOn(NativeLoop.prototype, 'resume')
  const ctx = await fixture.start(installer(fixture), [{
    id: 'must-not-start', sessionId: SessionId('must-not-start'), cwd: fixture.project,
    provider: 'm6-fixture', model: fixture.account + '-model',
  }])
  // boot() warns for optional failed rows; inspect the actual native entry rejection.
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'account-loop')
  expect(entry?.fiber).toBeDefined()
  await expect(entry!.fiber!.await()).rejects.toThrow('empty startup agents list')
  expect(fixture.factoryInstances()).toBe(0)
  expect(fixture.probes.setFactory).not.toHaveBeenCalled()
  expect(fixture.probes.projection).not.toHaveBeenCalled()
  expect(fixture.probes.prepare).not.toHaveBeenCalled()
  expect(fixture.probes.create).not.toHaveBeenCalled()
  expect(fixture.probes.open).not.toHaveBeenCalled()
  expect(nativeCreate).not.toHaveBeenCalled()
  expect(directCreate).not.toHaveBeenCalled()
  expect(nativeResume).not.toHaveBeenCalled()
  expect(fixture.created).toEqual({ sessions: 0, agents: 0 })
  expect(fixture.adapter.calls).toBe(0)
})
