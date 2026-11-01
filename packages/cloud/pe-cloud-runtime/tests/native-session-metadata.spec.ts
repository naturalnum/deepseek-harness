/** Original Loader, Gateway, Registry and JSONL component coverage; no production AccountUse or ready claim. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from './account-policy-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 16, maxFrameBytes: 65536,
  maxQueuedEvents: 16, maxQueuedBytes: 131072 }
const endpoints = [
  { endpoint: 'session/rename', handlerId: 'native:sessionController', guard: 'account-session' as const },
  ...['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession'].map(method => ({
    endpoint: 'workspace/' + method, handlerId: 'native:workspaceController', guard: 'account-session' as const,
  })),
]
type Graph = Awaited<ReturnType<ReturnType<typeof policyFixture>['start']>>
async function workspace(graph: Graph, method: string, sessionId: SessionId) {
  graph.api.requireRpc('workspace/' + method)
  const peer: PeerScope = { id: brandString<PeerId>('session-metadata-component'), ctx: graph.ctx,
    principal: { kind: 'owner' }, interactions: 'answer', signal: graph.lifetime.signal, dispose: async () => {} }
  return graph.ctx.typertGateway.invoke({ namespace: 'workspace', method, args: { request: { sessionId } }, peer })
}

it('persists native rename, pin and archive operations in isolated same-ID account graphs', async () => {
  const fixtureA = policyFixture(endpoints, bounds, 'metadata-a')
  const fixtureB = policyFixture(endpoints, bounds, 'metadata-b')
  const a = await fixtureA.start(), b = await fixtureB.start()
  const same = SessionId('session-shared-id'), onlyA = SessionId('session-only-a')
  expect((await a.ctx.sessionController.create({ sessionId: same })).sessionId).toBe(same)
  expect((await b.ctx.sessionController.create({ sessionId: same })).sessionId).toBe(same)
  expect((await a.ctx.sessionController.create({ sessionId: onlyA })).sessionId).toBe(onlyA)
  await expect(workspace(b, 'pinSession', onlyA)).rejects.toThrow()
  await expect(b.invoke('rename', { sessionId: onlyA, title: 'foreign' })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.invoke('rename', { sessionId: same, title: '  Account A title  ' })).resolves.toMatchObject({ title: 'Account A title' })
  await expect(b.invoke('rename', { sessionId: same, title: 'Account B title' })).resolves.toMatchObject({ title: 'Account B title' })
  await expect(workspace(a, 'pinSession', same)).resolves.toEqual({ pinnedSessionIds: [same] })
  expect(b.ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
  await expect(workspace(a, 'unpinSession', same)).resolves.toEqual({ pinnedSessionIds: [] })
  await expect(workspace(a, 'archiveSession', same)).resolves.toEqual({ archivedSessionIds: [same] })
  expect(b.ctx.workspaceRegistry.archivedSessionIds).toEqual([])
  await expect(workspace(a, 'unarchiveSession', same)).resolves.toEqual({ archivedSessionIds: [] })
  await workspace(a, 'pinSession', same)
  await workspace(a, 'archiveSession', onlyA)
  await a.ctx.sessionPersistence.flush(); await b.ctx.sessionPersistence.flush()
  await a.close(); await b.close()
  const coldA = await fixtureA.start('2'), coldB = await fixtureB.start('2')
  expect(coldA.ctx.workspaceRegistry.pinnedSessionIds).toEqual([same])
  expect(coldA.ctx.workspaceRegistry.archivedSessionIds).toEqual([onlyA])
  expect(coldB.ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
  expect(coldB.ctx.workspaceRegistry.archivedSessionIds).toEqual([])
  await expect(workspace(coldA, 'unarchiveSession', onlyA)).resolves.toEqual({ archivedSessionIds: [] })
  const readA = await coldA.ctx.sessionPersistence.open(same, 'read')
  const readB = await coldB.ctx.sessionPersistence.open(same, 'read')
  try {
    expect((await readA.read()).events.some(event => event.type === 'session/title' && event.data.title === 'Account A title')).toBe(true)
    expect((await readB.read()).events.some(event => event.type === 'session/title' && event.data.title === 'Account B title')).toBe(true)
  } finally { await readA.close(); await readB.close() }
}, 15000)

it('lets an already admitted native registry operation finish after admission closes', async () => {
  const fixture = policyFixture(endpoints, bounds, 'metadata-revoked'), graph = await fixture.start()
  const first = SessionId('queue-first'), second = SessionId('queue-second')
  await graph.ctx.sessionController.create({ sessionId: first })
  await graph.ctx.sessionController.create({ sessionId: second })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  graph.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    if (sessionId === first) { entered.resolve(undefined); await release.promise }
    return next()
  })
  const archive = workspace(graph, 'archiveSession', first)
  onTestFinished(() => { release.resolve(undefined) })
  await entered.promise
  const nativePin = vi.spyOn(graph.ctx.workspaceRegistry, 'pinSession')
  const pin = workspace(graph, 'pinSession', second)
  const results = Promise.allSettled([archive, pin])
  await vi.waitFor(() => { expect(nativePin).toHaveBeenCalledOnce() })
  graph.closeBusiness()
  await expect(workspace(graph, 'pinSession', first)).rejects.toThrow()
  release.resolve(undefined)
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(graph.ctx.workspaceRegistry.archivedSessionIds).toEqual([first])
  expect(graph.ctx.workspaceRegistry.pinnedSessionIds).toEqual([second])
}, 15000)

it('withholds a complete native pin result containing an unowned Session', async () => {
  const fixture = policyFixture(endpoints, bounds, 'metadata-result'), graph = await fixture.start()
  const own = SessionId('account-session'), foreign = SessionId('unaccounted-session')
  await graph.ctx.sessionController.create({ sessionId: own })
  const detached = graph.ctx.sessions.prepare(foreign, { meta: { cwd: fixture.privateRoot } })
  const writer = await graph.ctx.sessionPersistence.create(detached.header)
  await writer.flush(); await writer.close()
  await graph.ctx.workspaceRegistry.pinSession(foreign)
  await expect(workspace(graph, 'pinSession', own)).rejects.toThrow()
  expect(graph.ctx.workspaceRegistry.pinnedSessionIds).toEqual([own, foreign])
}, 15000)
