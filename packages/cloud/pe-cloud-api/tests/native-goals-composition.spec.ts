/** Original goal domain and human command share one account-bound Loader/Gateway service. */
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Goals from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import * as GoalCommand from '@deepseek-ai/dsh-command-goal'
import { createNativeCommands } from '../src/native-commands.ts'
import { createNativeGoals, type NativeGoals } from '../src/native-goals.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'

async function fixture(id: string, selected = true) {
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-goals', lifetime: lifetime.signal })
  const manifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: [
      ...['list', 'execute'].map(method => ({ endpoint: 'commands/' + method, handlerId: 'native:commands', guard: 'account-session' as const })),
      ...selected ? ['get', 'create', 'edit', 'pause', 'resume', 'complete', 'clear'].map(method => ({ endpoint: 'goals/' + method,
        handlerId: 'native:goals', guard: 'account-session' as const })) : [],
    ], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let owner: Context | undefined, native: NativeGoals | undefined, current = true
  const events: SessionEvent[] = []
  onTestFinished(async () => { await owner?.fiber.dispose() })
  const assertCurrent = (): void => {
    if (!current || lifetime.signal.aborted) throw new CloudApiError('cloud/stale-generation', 'The account generation has ended.')
    owner?.fiber.assertActive()
  }
  const assertActiveScope = (agent: Agent): void => {
    assertCurrent()
    if (agent.ctx.get('peAccount') !== binding || owner?.agents.get(agent.id) !== agent || agent.session.header.cwd !== '/account-project') {
      throw new CloudApiError('cloud/forbidden', 'The project is outside this account.')
    }
  }
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async () => {} },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 65536,
      assertSessionRead() {} },
    assertHandlerEnabled() {}, resolveCreate: async request => request, assertSessionProject: async () => {}, assertActiveScope,
  }
  const ctx = await boot('native-goals', fileURLToPath(new URL('./fixtures/native-goals.cordis.yml', import.meta.url)), [], async (ctx) => {
    owner = ctx
    ctx.on('session/event', (_session, event) => { events.push(event) })
    ctx.provide('peAccount', binding)
    await ctx.plugin(Typert)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await mountAgentLoopTestHarness(ctx)
    Object.assign(ctx.loader.builtins, {
      'account-goals': { inject: Goals.inject, Config: Goals.Config,
        apply(scope: Context, config: ConstructorParameters<typeof Goals>[1]) {
          native = createNativeGoals(scope, binding, assertCurrent, policy, guards, 128, config)
        } },
      'goal-command-registry': { inject: ['agents'], apply(scope: Context) {
        createNativeCommands(scope, binding, assertCurrent, policy, guards, 128)
      } },
      'original-goal-command': GoalCommand,
    })
  })
  if (native === undefined) throw new Error('The original guarded goal service did not mount')
  const service = native
  const agent = (await ctx.agents.create({ sessionId: SessionId('goal-session-' + id), meta: { cwd: '/account-project' } })).agent
  const peer: PeerScope = { id: brandString<PeerId>('goals-' + id), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
  const goal = <T>(method: string, args: object = {}) => ctx.typertGateway.invoke({ namespace: 'goals', method,
    args: { agentId: agent.id, ...args }, peer }) as Promise<T>
  const execute = (line: string) => ctx.typertGateway.invoke({ namespace: 'commands', method: 'execute',
    args: { agentId: agent.id, line, submittedAttachments: [] }, peer })
  return { ctx, service, agent, peer, events, binding, lifetime, policy, goal, execute, revoke: () => { current = false } }
}

it('uses the original /goal command, projected state and UI Remote mutations on the same native domain', async () => {
  const f = await fixture('lifecycle')
  await expect(f.goal('get')).resolves.toBeUndefined()
  expect(await f.execute('/goal deliver a working task')).toMatchObject({ result: { kind: 'success' } })
  const created = await f.goal<GoalView>('get')
  expect(created).toMatchObject({ objective: 'deliver a working task', phase: 'active', activation: 'armed', maxGoalRounds: 4, revision: 1 })
  const edited = await f.goal<GoalView>('edit', { ref: { id: created.id, revision: created.revision }, request: { objective: 'updated task' } })
  expect(edited).toMatchObject({ objective: 'updated task', revision: 2 })
  const paused = await f.goal<GoalView>('pause', { ref: { id: edited.id, revision: edited.revision } })
  expect(paused).toMatchObject({ phase: 'paused', activation: 'disarmed', revision: 3 })
  const resumed = await f.goal<GoalView>('resume', { ref: { id: paused.id, revision: paused.revision } })
  expect(resumed).toMatchObject({ phase: 'active', activation: 'armed', revision: 4 })
  const cleared = await f.goal('clear', { ref: { id: resumed.id, revision: resumed.revision } })
  expect(cleared).toEqual({ id: created.id, revision: 5 })
  await expect(f.goal('get')).resolves.toBeUndefined()
  expect(f.ctx.sessionProjections.stateOf(f.agent.session, 'goal')?.current).toBeNull()
  expect(f.events.filter(event => event.type === 'goal/change').map(event => event.data.operation))
    .toEqual(['create', 'edit', 'pause', 'resume', 'clear'])
  expect(f.service.inspect().rpcEndpoints).toHaveLength(7)
})

it('preserves native create/complete RPC aliases, revision conflicts and domain round validation', async () => {
  const f = await fixture('cas')
  const created = await f.goal<{ ref: { id: string; revision: number } }>('create', { request: { objective: 'same domain', maxGoalRounds: 3 } })
  const complete = await f.goal<GoalView>('complete', { ref: created.ref })
  expect(complete).toMatchObject({ phase: 'complete', activation: 'disarmed', revision: 2 })
  const before = f.events.length
  await expect(f.goal('edit', { ref: created.ref, request: { objective: 'stale' } })).rejects.toBeDefined()
  await expect(f.goal('create', { request: { objective: 'invalid', maxGoalRounds: 0 } })).rejects.toBeDefined()
  expect(f.events).toHaveLength(before)
})

it('denies foreign Agent objects and foreign wire ids without modifying either account goal', async () => {
  const a = await fixture('a'), b = await fixture('b')
  await b.execute('/goal keep this goal')
  const beforeA = a.events.length, beforeB = b.events.length
  expect(() => a.service.value.get(b.agent)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(() => a.service.value.create(b.agent, { objective: 'foreign' })).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await expect(a.ctx.typertGateway.invoke({ namespace: 'goals', method: 'get', args: { agentId: b.agent.id }, peer: a.peer })).rejects.toBeDefined()
  expect(a.events).toHaveLength(beforeA)
  expect(b.events).toHaveLength(beforeB)
  await expect(b.goal('get')).resolves.toMatchObject({ objective: 'keep this goal' })
})

it.each(['lifetime', 'admission', 'exposure'] as const)('keeps %s closure ahead of native goal mutation', async (ended) => {
  const f = await fixture(ended)
  const created = await f.goal<{ ref: { id: string; revision: number } }>('create', { request: { objective: 'old goal' } })
  const before = f.events.length
  if (ended === 'lifetime') f.lifetime.abort()
  else if (ended === 'admission') f.revoke()
  else f.policy.invalidate()
  await expect(f.goal('edit', { ref: created.ref, request: { objective: 'must not write' } })).rejects.toBeDefined()
  expect(f.events).toHaveLength(before)
  // Teardown still disarms original continuation authority after business closure.
  expect(f.service.value.disarm(f.agent)).toMatchObject({ activation: 'disarmed' })
})

it('does not expose inherited Remote methods when no goal endpoints are selected', async () => {
  const f = await fixture('closed', false)
  await expect(f.goal('get')).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.goal('create', { request: { objective: 'closed' } })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.events.filter(event => event.type === 'goal/change')).toHaveLength(0)
  expect(f.service.inspect().rpcEndpoints).toEqual([])
})
