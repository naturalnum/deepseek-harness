/** Actual native first-screen component reads and event lifetimes; no production Root or AccountUse is issued. */
import { readdirSync } from 'node:fs'
import { symbols } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from './account-policy-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 16, maxFrameBytes: 65536,
  maxQueuedEvents: 16, maxQueuedBytes: 131072 }
type Graph = Awaited<ReturnType<ReturnType<typeof policyFixture>['start']>>

async function stream(graph: Graph, endpoint: string) {
  const control = new AbortController()
  const peer: PeerScope = { id: brandString<PeerId>('first-screen-component'), ctx: graph.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: control.signal, dispose: async () => { control.abort() } }
  // Same external opener admission used by C04; the original Gateway owns dispatch, Peer and wire frames.
  graph.api.requireStream(endpoint)
  const source = await graph.ctx.typertGateway.wireStream.open(endpoint, { args: {} },
    (async function *() { yield* [] })(), peer, control.signal)
  const iterator = source[Symbol.asyncIterator]()
  const close = async () => { control.abort(); await iterator.return?.() }
  onTestFinished(close)
  return { iterator, close, control }
}

it('reads actual default Workspace, locale, Session list/control and the stock Peer-derived RemoteAccess baseline', async () => {
  const fixture = policyFixture([], bounds), graph = await fixture.start()
  const project = graph.files.project(), files = readdirSync(fixture.privateRoot)
  const initialize = vi.spyOn(graph.ctx.workspaceRegistry, 'initializeDefault')
  const result = await graph.ctx.workspaceController.initializeDefault(graph.lifetime.signal)
  expect(result?.workspace).toMatchObject({ workspaceId: project.workspace.id, path: project.workspace.path })
  expect(graph.ctx.workspaceRegistry.get(project.workspace.id)).toBe(project.workspace)
  expect(initialize).toHaveBeenCalledTimes(1)
  expect(readdirSync(fixture.privateRoot)).toEqual(files)
  const settings = graph.ctx.settingsController.describe()
  expect(settings).toMatchObject({ writable: false, hasDocument: false, namespaces: [{ ns: 'locale', value: { preference: 'en' } }] })
  expect(settings.namespaces).toHaveLength(1)
  expect(graph.api.requireRpc('settings/describe').guard).toBe('authenticated-account')
  expect(() => graph.api.requireRpc('settings/update')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(() => graph.api.requireRpc('session/modelCatalog')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  const workspace = await stream(graph, 'workspace/follow')
  expect(await workspace.iterator.next()).toMatchObject({ value: { type: 'baseline', value: { items: [
    { workspaceId: project.workspace.id, path: project.workspace.path, sessionIds: [] },
  ] } } })
  const access = await stream(graph, 'remoteAccess/follow')
  expect(await access.iterator.next()).toMatchObject({ value: { type: 'baseline', owner: true } })
  const control = await stream(graph, 'session/control')
  expect(await control.iterator.next()).toMatchObject({ value: { type: 'baseline', value: { projections: {} } } })
  await expect(graph.ctx.sessionController.list({}, graph.lifetime.signal)).resolves.toEqual({ items: [] })
  expect(graph.adapter.calls).toBe(0)
})

it('accepts original Session creation notifications before Workspace membership, then streams actual Gateway emits and ready home', async () => {
  const fixture = policyFixture([], bounds), graph = await fixture.start()
  const eventStream = await stream(graph, '$events')
  expect(await eventStream.iterator.next()).toMatchObject({ value: { type: 'ready', host: { home: graph.profileHome } } })
  const observations: boolean[] = []
  graph.ctx.on('api-session/added', (summary) => {
    observations.push(graph.files.project().workspace.sessionIds.includes(summary.sessionId))
    graph.guards.assertSessionRead?.(summary.sessionId, summary)
  })
  const created = await graph.ctx.sessionController.create({})
  expect(observations).toContain(false)
  expect(graph.files.project().workspace.sessionIds).toContain(created.sessionId)
  expect(await eventStream.iterator.next()).toMatchObject({ value: { type: 'emit', event: 'api-session/added', args: [
    { sessionId: created.sessionId, cwd: fixture.project },
  ] } })
  await expect(graph.ctx.sessionController.list({}, graph.lifetime.signal)).resolves.toMatchObject({ items: [
    { sessionId: created.sessionId, cwd: fixture.project },
  ] })
  const control = await stream(graph, 'session/control')
  const baseline = await control.iterator.next()
  expect(baseline).toMatchObject({ value: { type: 'baseline' } })
  expect(JSON.stringify(baseline.value)).toContain(created.sessionId)
  expect(JSON.stringify(baseline.value)).toContain(fixture.project)
  expect(graph.events?.inspect().home).toBe(graph.profileHome)
  expect(graph.adapter.calls).toBe(0)
})

it('keeps same-name accounts independent and reuses the original cold Workspace/JSONL relationship', async () => {
  const fixtureA = policyFixture([], bounds), fixtureB = policyFixture([], bounds)
  const a = await fixtureA.start(), b = await fixtureB.start()
  const created = await a.ctx.sessionController.create({})
  expect(() => { b.guards.assertSessionRead?.(created.sessionId) }).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(() => { a.api.assertInstalled(b.ctx) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  await a.ctx.sessionPersistence.flush()
  const workspaceId = a.files.project().workspace.id
  await a.close()
  const cold = await fixtureA.start('2')
  expect(cold.files.project().workspace.id).toBe(workspaceId)
  expect(cold.ctx.sessions.get(created.sessionId)).toBeUndefined()
  await expect(cold.ctx.sessionController.list({}, cold.lifetime.signal)).resolves.toMatchObject({ items: [
    { sessionId: created.sessionId, agentAvailable: false },
  ] })
  expect(cold.ctx.agents.get(created.sessionId)).toBeUndefined()
  expect(b.api.requireStream('$events').handlerId).toBe('native:typertGateway')
})

it('revokes prepared audit on locale fiber removal or a changed original method', async () => {
  const graph = await policyFixture([], bounds).start()
  const replacement = vi.spyOn(graph.ctx.settingsController, 'describe').mockImplementation(() => {
    throw new Error('Replaced native method must not run')
  })
  await expect(graph.api.auditPrepared(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(replacement).not.toHaveBeenCalled()
  replacement.mockRestore()
  await graph.api.auditPrepared(graph.ctx)
  const locale = [...graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')
  if (locale?.fiber === undefined) throw new Error('Original locale fiber absent')
  await locale.fiber.dispose()
  expect(() => graph.api.requireStream('$events')).toThrow()
  await expect(graph.api.auditPrepared(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const failure = await graph.events?.dispose().catch((error: unknown) => error)
  graph.expectEventDisposalFailure(failure)
})

it('retains a bounded event-source overflow failure and closes actual registration instead of dropping events', async () => {
  const graph = await policyFixture([], { ...bounds, maxQueuedEvents: 1 }).start()
  const events = graph.events
  if (events === undefined) throw new Error('Actual native event registration absent')
  // Synchronous native emissions outrun the source consumer and exercise the queue reservation.
  const locale = brandString<SettingsNamespace>('locale')
  for (let revision = 100; revision < 104; revision++) graph.ctx.emit('settings/document-updated', locale, revision)
  expect(() => events.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  const failure = await events.dispose().then(() => { throw new Error('Overflow disposal must retain failure') }, (error: unknown) => error)
  graph.expectEventDisposalFailure(failure)
  await expect(events.dispose()).rejects.toBe(failure)
  expect(() => graph.api.requireStream('$events')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects foreign actual native Session metadata without granting an id or cwd scope', async () => {
  const fixture = policyFixture([], bounds), graph = await fixture.start()
  const live = graph.ctx.sessions.prepare(SessionId('unapproved-cold'), { meta: { cwd: fixture.privateRoot } })
  const writer = await graph.ctx.sessionPersistence.create(live.header)
  await writer.flush(); await writer.close()
  expect(() => graph.guards.assertSessionRead?.(live.id)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await expect(graph.ctx.sessionController.list({}, graph.lifetime.signal)).rejects.toMatchObject({ code: 'cloud/forbidden' })
})

it('enforces explicit native collection and full-frame bounds after original reads', async () => {
  const graph = await policyFixture([], { ...bounds, maxCollectionItems: 1 }).start()
  await graph.ctx.sessionController.create({})
  await graph.ctx.sessionController.create({})
  await expect(graph.ctx.sessionController.list({}, graph.lifetime.signal)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const workspace = await stream(graph, 'workspace/follow')
  await expect(workspace.iterator.next()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const control = await stream(graph, 'session/control')
  await expect(control.iterator.next()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const tiny = await policyFixture([], { ...bounds, maxFrameBytes: 1 }).start()
  await expect(tiny.ctx.workspaceController.initializeDefault(tiny.lifetime.signal))
    .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await expect(tiny.ctx.sessionController.list({}, tiny.lifetime.signal)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('joins actual event withdrawal before disposing native owners and closes audited openers', async () => {
  const graph = await policyFixture([], bounds).start(), events = graph.events
  if (events === undefined) throw new Error('Original event registration absent')
  const eventStream = await stream(graph, '$events')
  await eventStream.iterator.next()
  await graph.api.stopFirstScreenEvents()
  await expect(graph.api.stopFirstScreenEvents()).resolves.toBeUndefined()
  expect(await eventStream.iterator.next()).toMatchObject({ done: true })
  expect(() => graph.api.requireStream('$events')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => events.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('joins an audited original event registration after binding abort without rereading closed files admission', async () => {
  const graph = await policyFixture([], bounds).start(), events = graph.events
  if (events === undefined) throw new Error('Original event registration absent')
  const eventStream = await stream(graph, '$events')
  expect(await eventStream.iterator.next()).toMatchObject({ value: { type: 'ready' } })
  expect(graph.ctx.sessions.list()).toEqual([])
  expect(graph.adapter.calls).toBe(0)

  graph.lifetime.abort()
  expect(() => graph.files.project()).toThrow()
  await expect(graph.api.stopFirstScreenEvents()).resolves.toBeUndefined()
  expect(await eventStream.iterator.next()).toMatchObject({ done: true })
  await expect(events.dispose()).resolves.toBeUndefined()
  await expect(graph.close()).resolves.toBeUndefined()
  await expect(graph.observeNativeDisposal()).resolves.toEqual({ status: 'confirmed', errorEvents: 0, warningEvents: 0, overflow: false })
  expect(graph.ctx.get('loader')).toBeUndefined()
})

it('refuses a supplied home that differs from the actual native profile instead of substituting another path', async () => {
  const fixture = policyFixture([], { ...bounds, expectedHome: '/foreign-first-screen-home' })
  await expect(fixture.start()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('passes the complete control frame budget into the original native baseline queue through the protected hook', async () => {
  const graph = await policyFixture([], { ...bounds, maxFrameBytes: 1 }).start()
  const source = graph.ctx.sessionController.control(graph.lifetime.signal)[Symbol.asyncIterator]()
  // This RangeError is raised by the original native baseline check before the Cloud result checker sees a frame.
  await expect(source.next()).rejects.toBeInstanceOf(RangeError)
  const repeated = graph.ctx.sessionController.control(graph.lifetime.signal)[Symbol.asyncIterator]()
  await expect(repeated.next()).rejects.toThrow('Session control frame exceeds its explicit byte limit')
  await source.return?.(); await repeated.return?.()
  expect(graph.api.requireStream('session/control').guard).toBe('account-session')
  expect(graph.events?.inspect().queuedEvents).toBe(0)
  expect(graph.adapter.calls).toBe(0)
})

it('bounds the original downstream event client after each real source emission settles and keeps healthy streams ready', async () => {
  const graph = await policyFixture([], { ...bounds, maxQueuedEvents: 1 }).start()
  const events = graph.events, workspace = graph.files.project().workspace
  const sessions: unknown = Reflect.get(graph.ctx.sessions, symbols.original)
  expect(typeof sessions).toBe('object')
  if (events === undefined) throw new Error('Actual event source absent')
  const slow = await stream(graph, '$events'), healthy = await stream(graph, '$events')
  await slow.iterator.next(); await healthy.iterator.next()
  const locale = brandString<SettingsNamespace>('locale')
  for (const revision of [101, 102]) {
    graph.ctx.emit('settings/document-updated', locale, revision)
    // Real native delivery to another client acknowledges consumption of the original source before the next emit.
    await expect(healthy.iterator.next()).resolves.toMatchObject({ value: {
      type: 'emit', event: 'settings/document-updated', args: [locale, revision],
    } })
    expect(events.inspect().queuedEvents).toBe(0)
    expect(events.inspect().queuedBytes).toBe(0)
  }
  await expect(slow.iterator.next()).rejects.toThrow('Remote event client exceeds its explicit queued-event limit')
  await slow.close()
  expect(graph.api.requireStream('$events').guard).toBe('authenticated-account')
  const later = await stream(graph, '$events')
  await expect(later.iterator.next()).resolves.toMatchObject({ value: { type: 'ready', host: { home: graph.profileHome } } })
  graph.ctx.emit('settings/document-updated', locale, 103)
  for (const opened of [healthy, later]) {
    await expect(opened.iterator.next()).resolves.toMatchObject({ value: { type: 'emit', args: [locale, 103] } })
  }
  expect(events.inspect().queuedEvents).toBe(0)
  expect(graph.files.project().workspace).toBe(workspace)
  expect(Reflect.get(graph.ctx.sessions, symbols.original) === sessions).toBe(true)
  expect(graph.adapter.calls).toBe(0)
})
