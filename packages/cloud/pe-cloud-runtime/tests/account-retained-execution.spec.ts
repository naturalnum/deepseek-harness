/** Original Native Agent teardown with the real account policy; no issued execution handle or deployed acceptance is inferred. */
import { FiberState } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { childSessionMeta, applyChildComposition } from '../../../subagent/subagent/src/child-agent.ts'
import { expect, it, onTestFinished } from 'vitest'
import { policyFixture } from './account-policy-fixture.ts'

async function unloading() {
  const f = policyFixture(), graph = await f.start()
  const { sessionId } = await graph.ctx.sessionController.create({})
  const agent = graph.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Original Native Agent absent')
  const workspace = graph.guards.projectForAgent(agent)
  expect(() => { graph.guards.assertRetainedExecutionOwner(agent, workspace) }).not.toThrow()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  agent.ctx.effect(() => async () => {
    entered.resolve(undefined)
    await release.promise
  }, 'fixture: retain original Native Agent cleanup')
  const stopped = graph.ctx.agentLoop.stop()
  await entered.promise
  expect(agent.ctx.fiber.state).toBe(FiberState.UNLOADING)
  expect(graph.ctx.agents.get(sessionId)).toBe(agent)
  expect(graph.ctx.sessions.get(sessionId)).toBe(agent.session)
  return { ...f, graph, agent, workspace, release, stopped }
}

it('retains the exact execution owner through Native AgentLoop.stop while ordinary business selection remains closed', async () => {
  const f = await unloading()
  expect(() => { f.graph.guards.projectForAgent(f.agent) }).toThrow()
  expect(() => { f.graph.guards.projectForSession(f.agent.session) }).toThrow()
  expect(() => { f.graph.guards.sessions.assertActiveScope(f.agent) }).toThrow()
  expect(() => { f.graph.guards.assertRetainedExecutionOwner(f.agent, f.workspace) }).not.toThrow()
  f.release.resolve(undefined)
  await f.stopped
  expect(f.agent.ctx.fiber.state).toBe(FiberState.DISPOSED)
  expect(f.graph.ctx.agents.get(f.agent.id)).toBeUndefined()
  expect(() => { f.graph.guards.assertRetainedExecutionOwner(f.agent, f.workspace) }).toThrow()
})

it('rejects copied Agent and Workspace identities while the original Native owner is unloading', async () => {
  const f = await unloading()
  expect(() => { f.graph.guards.assertRetainedExecutionOwner({ ...f.agent }, f.workspace) }).toThrow()
  expect(() => { f.graph.guards.assertRetainedExecutionOwner(f.agent, { ...f.workspace }) }).toThrow()
  expect(() => { f.graph.guards.assertRetainedExecutionOwner(f.agent, f.workspace) }).not.toThrow()
  f.release.resolve(undefined)
  await f.stopped
})

it('keeps original Workspace membership checks during Native cleanup', async () => {
  const f = await unloading()
  await f.workspace.detachSession(f.agent.id)
  expect(() => { f.graph.guards.assertRetainedExecutionOwner(f.agent, f.workspace) }).toThrow()
  f.release.resolve(undefined)
  await f.stopped
})

it('rejects an ended account epoch during Native cleanup', async () => {
  const f = await unloading()
  f.graph.lifetime.abort()
  expect(() => { f.graph.guards.assertRetainedExecutionOwner(f.agent, f.workspace) }).toThrow()
  f.release.resolve(undefined)
  await f.stopped
})

it('retains an unloading Native child only under its original live parent and shared composition', async () => {
  const f = policyFixture([], undefined, 'retained-child', undefined, undefined, undefined, () => ({ settle() {} }))
  const graph = await f.start(), { sessionId } = await graph.ctx.sessionController.create({})
  const parent = graph.ctx.agents.get(sessionId)
  if (parent === undefined) throw new Error('Original Native parent absent')
  const child = await graph.ctx.agents.withInitiator(parent, () => graph.ctx.agents.create({
    sessionId: SessionId('retained-native-child'), parentAgent: parent,
    meta: childSessionMeta(parent, 1, false), agentOptions: { ...parent.options, subagentDepth: 1 },
    setup: async (owner, agent) => {
      await owner.get('workingDirectory')!.set(agent, f.project)
      await applyChildComposition(owner, parent, {})
    },
  }))
  const workspace = graph.guards.projectForAgent(child.agent)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  child.agent.ctx.effect(() => async () => { entered.resolve(undefined); await release.promise }, 'fixture: original child cleanup')
  const disposing = child.dispose()
  await entered.promise
  expect(child.agent.ctx.fiber.state).toBe(FiberState.UNLOADING)
  expect(() => { graph.guards.projectForAgent(child.agent) }).toThrow()
  expect(() => { graph.guards.assertRetainedExecutionOwner(child.agent, workspace) }).not.toThrow()
  release.resolve(undefined)
  await disposing
  expect(() => { graph.guards.assertRetainedExecutionOwner(child.agent, workspace) }).toThrow()
})
