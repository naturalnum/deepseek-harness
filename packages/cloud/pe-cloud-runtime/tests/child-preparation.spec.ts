/** Original native child factory/Session/Preset and policy; no real model or Files capability acceptance. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { childSessionMeta, applyChildComposition } from '../../../subagent/subagent/src/child-agent.ts'
import { policyFixture } from './account-policy-fixture.ts'

async function fixture() {
  const settlements: string[] = []
  const f = policyFixture([], undefined, 'private-child-preparation', undefined, undefined, undefined,
    () => ({ settle(status) { settlements.push(status) } }))
  const graph = await f.start()
  const created = await graph.ctx.sessionController.create({})
  const parent = graph.ctx.agents.get(created.sessionId)
  if (parent === undefined) throw new Error('Original parent absent')
  const options = (name: string) => ({ sessionId: SessionId(name), parentAgent: parent,
    meta: childSessionMeta(parent, 1, false), agentOptions: { ...parent.options, subagentDepth: 1 } })
  return { ...f, graph, parent, settlements, options }
}

it('runs inherited child directory setup under exact preparation identity then revokes the old selection before publication', async () => {
  const f = await fixture(), selections: Awaited<ReturnType<typeof f.graph.guards.getFileProject>>[] = []
  let setupCalls = 0, commits = 0
  const child = await f.graph.ctx.agents.withInitiator(f.parent, () => f.graph.ctx.agents.create({ ...f.options('prepared-child'),
    setup: async (owner, agent) => {
      setupCalls++
      expect(agent.ctx.fiber.state).toBe(FiberState.LOADING)
      const first = await f.graph.guards.getFileProject(owner), second = await f.graph.guards.getFileProject(owner)
      const identity = Reflect.get(first, 'directoryPreparation') as object
      expect(identity).toBeDefined(); expect(Object.isFrozen(identity)).toBe(true)
      expect(Reflect.get(second, 'directoryPreparation')).toBe(identity)
      const assertCaller = Reflect.get(identity, 'assertCaller') as (caller: typeof owner) => void
      assertCaller(owner)
      expect(() => { assertCaller(f.parent.ctx) }).toThrow()
      selections.push(first, second)
      await owner.get('workingDirectory')!.set(agent, f.project)
      await applyChildComposition(owner, f.parent, {})
      expect(agent.ctx.fiber.state).toBe(FiberState.ACTIVE)
      return { commit() { commits++; expect(() => { first.assertCurrent() }).toThrow() } }
    },
  }))
  expect(child.agent.session.header.agentPreset).toBe(f.config.presetId)
  expect(setupCalls).toBe(1); expect(commits).toBe(1)
  for (const selection of selections) {
    expect(() => { selection.assertCurrent() }).toThrow()
    const assertCaller = Reflect.get(Reflect.get(selection, 'directoryPreparation') as object, 'assertCaller') as (caller: typeof child.agent.ctx) => void
    expect(() => { assertCaller(child.agent.ctx) }).toThrow()
  }
  const ordinary = await f.graph.ctx.agents.withInitiator(child.agent, () => f.graph.guards.getFileProject(child.agent.ctx))
  expect(Reflect.get(ordinary, 'directoryPreparation')).toBeUndefined()
  expect(f.graph.adapter.calls).toBe(0)
  await child.dispose()
})

it('closes children before native storage when preparation guard is absent while ordinary root creation stays available', async () => {
  const f = await fixture(), create = vi.spyOn(f.graph.ctx.sessionPersistence, 'create')
  delete f.graph.guards.agents.withChildPreparation
  const setup = vi.fn()
  await expect(f.graph.ctx.agents.create({ ...f.options('missing-guard-child'), setup })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(create).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled()
  await expect(f.graph.ctx.sessionController.create({})).resolves.toHaveProperty('sessionId')
  expect(f.graph.adapter.calls).toBe(0)
})

it('rejects cloned child registration, sibling scope borrowing and reentrant setup registration without weakening the normal caller check', async () => {
  const f = await fixture()
  const child = await f.graph.ctx.agents.withInitiator(f.parent, () => f.graph.ctx.agents.create({ ...f.options('scope-child'),
    setup: async (owner, agent) => {
      const signal = new AbortController().signal, preparing = f.graph.guards.agents.withChildPreparation!
      await expect(preparing({ ...agent }, f.parent, signal, () => Promise.resolve())).rejects.toBeDefined()
      await expect(preparing(agent, f.parent, signal, () => Promise.resolve())).rejects.toBeDefined()
      const sibling = createScope(owner, {})
      try {
        await expect(f.graph.guards.getFileProject(sibling.ctx)).rejects.toMatchObject({ code: 'cloud/forbidden' })
        const selected = await f.graph.guards.getFileProject(owner)
        const assertCaller = Reflect.get(Reflect.get(selected, 'directoryPreparation') as object, 'assertCaller') as (caller: typeof owner) => void
        expect(() => { assertCaller(sibling.ctx) }).toThrow()
      }
      finally { await sibling.dispose() }
      await owner.get('workingDirectory')!.set(agent, f.project)
      await applyChildComposition(owner, f.parent, {})
    },
  }))
  expect(f.graph.adapter.calls).toBe(0)
  await child.dispose()
})

it.each(['caller', 'binding'] as const)('revokes a pending setup selection synchronously on %s cancellation and leaves actual setup to its original owner', async (kind) => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const caller = new AbortController()
  let selected: Awaited<ReturnType<typeof f.graph.guards.getFileProject>> | undefined, actualContinued = false
  const creating = f.graph.ctx.agents.withInitiator(f.parent, () => f.graph.ctx.agents.create({ ...f.options('cancelled-child'), signal: caller.signal,
    setup: async (owner) => {
      selected = await f.graph.guards.getFileProject(owner); entered.resolve(undefined)
      await release.promise; actualContinued = true
    },
  }))
  const rejected = expect(creating).rejects.toBeDefined()
  await entered.promise
  if (kind === 'caller') caller.abort(new Error('private caller cancellation'))
  else f.graph.lifetime.abort()
  expect(() => { selected?.assertCurrent() }).toThrow()
  await rejected
  expect(f.graph.ctx.agents.get(SessionId('cancelled-child'))).toBeUndefined()
  expect(f.graph.adapter.calls).toBe(0)
  expect(actualContinued).toBe(false)
  release.resolve(undefined)
  await vi.waitFor(() => { expect(actualContinued).toBe(true) })
  expect(() => { selected?.assertCurrent() }).toThrow()
})

it('revokes preparation when the original child scope starts disposal before setup has published', async () => {
  const f = await fixture()
  let disposal: Promise<void> | undefined, entered = false
  await expect(f.graph.ctx.agents.withInitiator(f.parent, () => f.graph.ctx.agents.create({ ...f.options('disposed-child'),
    setup: async (owner) => {
      const selected = await f.graph.guards.getFileProject(owner)
      entered = true
      disposal = owner.fiber.dispose()
      expect(() => { selected.assertCurrent() }).toThrow()
    },
  }))).rejects.toBeDefined()
  expect(entered).toBe(true)
  await disposal
  expect(f.graph.adapter.calls).toBe(0)
})
