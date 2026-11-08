/** Actual Native fork and JSONL under the account policy; no deployed readiness claim. */
import { expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionForkValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { policyFixture } from './account-policy-fixture.ts'

const endpoints = ['fork', 'rename'].map(method => ({ endpoint: 'session/' + method,
  handlerId: 'native:sessionController', guard: 'account-session' as const }))
const bounds = { maxHomeBytes: 4096, maxCollectionItems: 32, maxFrameBytes: 65536,
  maxQueuedEvents: 32, maxQueuedBytes: 131072 }
function fixture(account = 'fork-account') { return policyFixture(endpoints, bounds, account) }
type Graph = Awaited<ReturnType<ReturnType<typeof fixture>['start']>>
async function turn(graph: Graph, sessionId: SessionId, requestId: string) {
  await graph.invoke('prompt', { sessionId, requestId, mode: 'followup', content: [{ type: 'text', text: requestId }] })
  await vi.waitFor(() => { expect(graph.ctx.agents.get(sessionId)?.status).toBe('idle') })
  const end = graph.ctx.sessions.get(sessionId)?.snapshotEvents().findLast(event => event.type === 'turn/end')
  if (end === undefined) throw new Error('Native turn did not close')
  return end.seq
}

it('forks an authorized exact prefix, renames and prompts the child, then cold-resumes it from original JSONL', async () => {
  const f = fixture(), graph = await f.start()
  const source = await graph.ctx.sessionController.create({})
  const atSeq = await turn(graph, source.sessionId, 'source turn')
  const sourceEvents = graph.ctx.sessions.get(source.sessionId)?.snapshotEvents()
  const fork = await graph.invoke('fork', { sessionId: source.sessionId, atSeq }) as SessionForkValue
  const child = graph.ctx.sessions.get(fork.sessionId)
  expect(child?.header).toMatchObject({ parentSession: source.sessionId, isSeeded: true, cwd: f.project })
  await expect(graph.invoke('rename', { sessionId: fork.sessionId, title: 'Fork child' })).resolves.toMatchObject({ title: 'Fork child' })
  await expect(graph.invoke('page', { address: { kind: 'session', sessionId: fork.sessionId }, throughSeq: -1 })).resolves.toBeDefined()
  await turn(graph, fork.sessionId, 'child turn')
  await graph.guards.sessions.assertSessionProject(fork.sessionId)
  const childAgent = graph.ctx.agents.get(fork.sessionId)
  if (childAgent === undefined) throw new Error('Native fork Agent absent')
  expect(graph.guards.projectForAgent(childAgent)).toBe(graph.files.project().workspace)
  expect(graph.ctx.sessions.get(source.sessionId)?.snapshotEvents()).toEqual(sourceEvents)
  const nested = await graph.invoke('fork', { sessionId: fork.sessionId }) as SessionForkValue
  expect(graph.ctx.sessions.get(nested.sessionId)?.header.parentSession).toBe(fork.sessionId)
  await graph.ctx.sessionPersistence.flush(); await graph.close()
  const cold = await f.start('2')
  expect(cold.ctx.sessions.get(fork.sessionId)).toBeUndefined()
  await cold.guards.sessions.assertSessionProject(fork.sessionId)
  await cold.guards.sessions.assertSessionProject(nested.sessionId)
  const fromCold = await cold.invoke('fork', { sessionId: fork.sessionId }) as SessionForkValue
  expect(cold.ctx.sessions.get(fromCold.sessionId)?.header.parentSession).toBe(fork.sessionId)
  const listed = await cold.ctx.sessionController.list({}, cold.binding.lifetime)
  expect(listed.items.some(row => row.sessionId === fork.sessionId)).toBe(true)
  await turn(cold, fork.sessionId, 'resumed child turn')
  expect(cold.ctx.agents.get(fork.sessionId)?.session.header).toMatchObject({ parentSession: source.sessionId, isSeeded: true })
})

function copiedFork(graph: Graph, sourceId: SessionId, childId: SessionId, cwd: string) {
  const parent = graph.ctx.agents.get(sourceId)
  if (parent === undefined || parent.session.header.agentPreset === undefined) throw new Error('Native source absent')
  const events = parent.session.snapshotEvents(), preset = parent.session.header.agentPreset
  const seed = buildForkSeed(events, SessionSeq(events.length - 1))
  return { sessionId: childId, seed, inheritedEventCount: SessionLogOffset(events.length),
    meta: { cwd, agentPreset: parent.session.header.agentPreset, parentSession: sourceId, isSeeded: true },
    agentOptions: { provider: 'local-text', model: 'plain-text' },
    setup: async (owner: Parameters<Graph['ctx']['agentPresets']['mount']>[0]) => {
      await graph.ctx.agentPresets.mount(owner, preset)
    } }
}

it('rejects a foreign source before querying it or publishing any child', async () => {
  const a = await fixture('account-a').start(), b = await fixture('account-b').start()
  const source = await a.ctx.sessionController.create({})
  const query = vi.spyOn(b.ctx.sessionQuery, 'observeSession')
  await expect(b.invoke('fork', { sessionId: source.sessionId })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(query).not.toHaveBeenCalled()
  expect(b.ctx.sessions.list()).toEqual([])
})

it('refuses a copied seed across two actual Workspaces in the same account', async () => {
  const f = fixture(), graph = await f.start()
  const path = join(dirname(f.project), 'other-project'); mkdirSync(path)
  const workspace = await graph.ctx.workspaceRegistry.create(path)
  const source = await graph.ctx.sessionController.create({ workspaceId: workspace.id })
  await turn(graph, source.sessionId, 'other project source')
  const before = graph.ctx.sessions.list().length
  await expect(graph.ctx.agents.create(copiedFork(graph, source.sessionId, SessionId('wrong-project-fork'), f.project)))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.sessions.list()).toHaveLength(before)
  expect(workspace.sessionIds).toEqual([source.sessionId])
  const own = await graph.ctx.sessionController.create({})
  await turn(graph, own.sessionId, 'authorized parent in default project')
  const forged = copiedFork(graph, own.sessionId, SessionId('forged-prefix'), f.project)
  const other = copiedFork(graph, source.sessionId, SessionId('unused'), path)
  await expect(graph.ctx.agents.create({ ...forged, seed: other.seed, inheritedEventCount: other.inheritedEventCount }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.sessions.get(forged.sessionId)).toBeUndefined()
})

it('rejects incomplete, self-parent and nonmember fork metadata before native publication', async () => {
  const f = fixture(), graph = await f.start(), source = await graph.ctx.sessionController.create({})
  await turn(graph, source.sessionId, 'malformed seed source')
  const id = SessionId('malformed-fork'), base = copiedFork(graph, source.sessionId, id, f.project)
  const create = vi.spyOn(graph.ctx.sessionPersistence, 'create')
  const { parentSession: _parent, ...withoutParent } = base.meta
  for (const meta of [
    { ...base.meta, isSeeded: false }, withoutParent,
    { ...base.meta, parentSession: id }, { ...base.meta, parentSession: SessionId('foreign-or-missing') },
    { ...base.meta, delegationDepth: 1 }, { ...base.meta, origin: 'subagent' as const },
  ]) await expect(graph.ctx.agents.create({ ...base, meta })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const { seed: _seed, ...withoutSeed } = base
  for (const input of [withoutSeed, { ...base, seed: [] }, { ...base, inheritedEventCount: SessionLogOffset(0) }]) {
    await expect(graph.ctx.agents.create(input)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  }
  expect(create).not.toHaveBeenCalled()
  expect(graph.ctx.sessions.get(id)).toBeUndefined()
})

it('rechecks the authorized parent after model admission awaits and keeps the rejected child unpublished', async () => {
  const f = fixture(), graph = await f.start(), source = await graph.ctx.sessionController.create({})
  await turn(graph, source.sessionId, 'detach source')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const id = SessionId('detached-source-fork'), operation = graph.ctx.agents.create(copiedFork(graph, source.sessionId, id, f.project))
  const rejected = expect(operation).rejects.toMatchObject({ code: 'cloud/forbidden' })
  try { await entered.promise; await graph.files.project().workspace.detachSession(source.sessionId) }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.ctx.sessions.get(id)).toBeUndefined()
  expect(graph.ctx.agents.get(id)).toBeUndefined()
})

it('refuses cold branch history after its source loses same-Workspace membership', async () => {
  const f = fixture(), first = await f.start(), source = await first.ctx.sessionController.create({})
  await turn(first, source.sessionId, 'cold detached source')
  const child = await first.invoke('fork', { sessionId: source.sessionId }) as SessionForkValue
  await first.ctx.sessionPersistence.flush(); await first.close()
  const cold = await f.start('2')
  await cold.files.project().workspace.detachSession(source.sessionId)
  await expect(cold.guards.sessions.assertSessionProject(child.sessionId)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(cold.invoke('page', { address: { kind: 'session', sessionId: child.sessionId }, throughSeq: -1 }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(cold.ctx.agents.get(child.sessionId)).toBeUndefined()
})

it('withholds a committed child when the source is detached during original Workspace attachment', async () => {
  const f = fixture(), graph = await f.start(), source = await graph.ctx.sessionController.create({})
  await turn(graph, source.sessionId, 'attachment race source')
  const workspace = graph.files.project().workspace, attach = workspace.attachSession.bind(workspace)
  let childId: SessionId | undefined
  vi.spyOn(workspace, 'attachSession').mockImplementationOnce(async (id) => {
    await attach(id)
    childId = id
    await workspace.detachSession(source.sessionId)
  })
  await expect(graph.invoke('fork', { sessionId: source.sessionId })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  if (childId === undefined) throw new Error('Native fork never reached original attachment')
  expect(graph.ctx.sessions.get(childId)?.header.parentSession).toBe(source.sessionId)
  expect(workspace.sessionIds).toContain(childId)
  expect(workspace.sessionIds).not.toContain(source.sessionId)
  await expect(graph.guards.sessions.assertSessionProject(childId)).rejects.toMatchObject({ code: 'cloud/forbidden' })
})
