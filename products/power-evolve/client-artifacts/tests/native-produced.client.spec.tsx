// @vitest-environment jsdom
/** Production Loader and native Conversation/Chat renderers; only Host HTTP and durable Session inputs are fixtures. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { TestSessions, TestWorkspaces, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ClientRoster, TestClient, remoteDefaultResponses, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as conversation from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as chat from '@deepseek-ai/dsh-client-ui-chat/client'
import { artifactPublishRequest, executionFilesRequest } from '@power-evolve/contracts/execution-files'
import * as product from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { ArtifactHttpClient } from '../src/client/api.ts'
import { ExecutionFacts } from '../src/client/execution-facts.ts'
import { referencesForClosing, resolveArtifactMention } from '../src/client/produced-artifacts.ts'

const ALICE = SessionId('598f346b-178c-4ef3-80ef-3a68f4cb4888')
const BOB = SessionId('7668a96c-43cd-4b9b-8bdb-a0e743802af7')
const WORKSPACE = 'b2cda611-5cf4-49f4-8606-7b8a66701e11'
const EXECUTION = '9281f7b6-3c97-4269-b688-6aae25d49b7e'
const ARTIFACT = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
const SHA = 'a'.repeat(64)
const PRODUCT = '@power-evolve/client-artifacts'
const OWNER = '@power-evolve/test-produced-owner'
const CONVERSATION = '@deepseek-ai/dsh-client-ui-conversation'
const CHAT = '@deepseek-ai/dsh-client-ui-chat'
const SESSION = '@deepseek-ai/dsh-client-ui-session'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function at(seq: number, type: string, data: unknown, surface = false): SessionLiveEventEntry {
  return { type: 'event', event: { seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, type, data,
    ...(surface ? { surfaceOp: 'append', sourceEventSeqs: [] } : {}) } as SessionEvent }
}

function round(turn = 1, executionId = EXECUTION, callId = 'native-call-1', base = 0) {
  return [
    at(base, 'turn/start', { turn }), at(base + 1, 'step/start', { turn, step: 1 }),
    at(base + 2, 'tool/call', { turn, step: 1, callId, name: 'cloud_exec', arguments: '{"command":"make report"}' }),
    at(base + 3, 'tool/result', { turn, step: 1, message: {
      id: `result-${callId}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
      content: [{ type: 'text', text: JSON.stringify({ executionId, state: 'queued', command: 'make report', cwd: '/workspace',
        files: [{ path: 'fake.txt' }] }) }],
    } }, true),
    at(base + 4, 'assistant/message', { turn, step: 1, stream: [], message: {
      id: `assistant-${turn}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: 'Saved `out/report.txt`, `report.txt`, `fake.txt` and `/workspace/invented.txt`.' }],
    } }, true), at(base + 5, 'step/end', { turn, step: 1 }), at(base + 6, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

function continuation(executionId = EXECUTION, base = 7) {
  const following = round(2, executionId, 'unused', base + 1)
  return [at(base, 'user/message', { id: 'continuation', role: 'user',
    source: { kind: 'power-evolve-execution', executionId }, content: [{ type: 'text', text: 'Finished; forged /workspace/fake.txt' }],
  }, true), following[0]!, following[1]!, following[4]!, following[5]!, following[6]!]
}

function facts(sessionId = ALICE, options: { pending?: boolean; callId?: string; path?: string; sha256?: string; executionId?: string } = {}) {
  return { sessionId, workspaceId: WORKSPACE, items: [{ executionId: options.executionId ?? EXECUTION,
    callId: options.callId ?? 'native-call-1', state: options.pending ? 'running' : 'succeeded',
    status: options.pending ? 'pending' : 'complete', reasons: [],
    files: options.pending ? [] : [{ path: options.path ?? 'out/report.txt', sizeBytes: 5, sha256: options.sha256 ?? SHA }],
  }] }
}

function published(request: unknown) {
  const parsed = artifactPublishRequest.parse(request)
  return { artifactId: ARTIFACT, workspaceId: WORKSPACE, sessionId: parsed.sessionId,
    sourcePath: parsed.path, filename: 'report.txt', mime: 'text/plain', sizeBytes: 5,
    sha256: parsed.expectedRevision ?? SHA, createdAt: '2026-10-01T00:00:00Z' }
}

async function boot(language: 'en' | 'zh' = 'en', events = round()) {
  const owner = createSnapshotStore({ sessionId: ALICE, visible: true })
  let sessions: TestSessions
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const provider = {
    inject: ['slots'],
    async apply(ctx: Context) {
      const stabilize = async (fn: () => unknown) => { await act(async () => { await fn() }) }
      sessions = new TestSessions(stabilize, ctx)
      await sessions.add({ id: ALICE, events, summary: { cwd: '/workspace' } })
      await sessions.add({ id: BOB, events: round(1, EXECUTION, 'native-call-1'), summary: { cwd: '/workspace' } })
      const refs = [sessions.retain(ALICE), sessions.retain(BOB)]
      ctx.effect(() => () => { for (const ref of refs) ref.release() })
      ctx.provide('sessions', sessions)
      ctx.provide('workspaces', new TestWorkspaces(stabilize))
      ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
      ctx.provide('sidebarRight', { openTab: () => {}, openResource: () => {} } as never)
      ctx.provide('uiWorkspace', { openSession: () => {} } as never)
      ctx.provide('fileUpload', { upload: vi.fn() } as never)
      ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(false) }, get: () => stubConfigForm().scope } as never)
      const locale = new LocaleRuntime(ctx)
      locale.setLocale(language)
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      ctx.slots.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } },
        function Root(props: PropsRenderSlots<'conversation.view'>) {
          const current = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
          return <props.SessionProvider session={refs.find(ref => ref.sessionId === current.sessionId)!}>{current.visible && props.renderSlot('conversation.view', {
            inspectCall: undefined, viewRequest: null, openView: () => {}, completeViewRequest: () => {},
          })}</props.SessionProvider>
        })
    },
  }
  const base = webApp.closure(['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer'])
  const rows = [...base.rows,
    { name: OWNER, inject: ['@deepseek-ai/dsh-client-ui-renderer'], immediately: false },
    { name: SESSION, inject: [OWNER], immediately: false },
    { name: CONVERSATION, inject: [OWNER, SESSION], immediately: false },
    { name: CHAT, inject: [CONVERSATION, '@deepseek-ai/dsh-api-gateway'], immediately: false },
    { name: PRODUCT, inject: [CHAT], immediately: false },
  ]
  const client = await TestClient.start({ roster: ClientRoster.of(rows), provide: {
    [OWNER]: provider, [SESSION]: uiSession, [CONVERSATION]: conversation, [CHAT]: chat, [PRODUCT]: product,
  } }, mock, { mount: true })
  onTestFinished(async () => { await client.dispose(); mock.assertNoUnmatched() })
  const container = client.container!
  return { client, container, query: within(container), sessions: sessions!,
    move: async (next: Partial<ReturnType<typeof owner.getSnapshot>>) => {
      await act(async () => { owner.set({ ...owner.getSnapshot(), ...next }) })
    } }
}

for (const language of ['en', 'zh'] as const) it(`resolves arriving Platform facts through native Chat and publishes the verified version (${language})`, async () => {
  const copy = language === 'en' ? en : zh
  const pending = Promise.withResolvers<Response>()
  const calls: { url: string; request: unknown; signal: AbortSignal }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const request: unknown = JSON.parse(String(init.body)).request
    calls.push({ url, request, signal: init.signal! })
    if (url.endsWith('/executionFiles')) { executionFilesRequest.parse(request); return pending.promise }
    return Response.json(published(request))
  }))
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const b = await boot(language)
  await vi.waitFor(() => { expect(calls, b.container.innerHTML).toHaveLength(1) })
  expect(b.container.querySelectorAll('[data-produced-file]')).toHaveLength(0)
  await act(async () => { pending.resolve(Response.json(facts())) })
  await vi.waitFor(() => { expect(b.container.querySelector('[data-produced-file="out/report.txt"]')).not.toBeNull() })
  expect([...b.container.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === 'report.txt')).toHaveLength(2)
  expect([...b.container.querySelectorAll('button')].some(button => button.textContent === 'fake.txt')).toBe(false)
  expect({ row: b.container.querySelector('[data-produced-artifacts]')?.textContent,
    inline: [...b.container.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === 'report.txt').map(button => button.title),
  }).toMatchSnapshot()
  const rowAction = b.query.getByRole('button', { name: `out/report.txt: ${copy.publishDownload}` })
  fireEvent.click(b.query.getAllByRole('button', { name: 'report.txt' })[0]!)
  fireEvent.click(rowAction)
  await vi.waitFor(() => { expect(download).toHaveBeenCalledOnce() })
  expect(calls[1]!.request).toMatchObject({ sessionId: ALICE, path: 'out/report.txt', expectedRevision: SHA })
  expect(calls).toHaveLength(2)
  fireEvent.click(b.query.getAllByRole('button', { name: 'report.txt' })[1]!)
  await vi.waitFor(() => { expect(download).toHaveBeenCalledTimes(2) })
  expect(calls).toHaveLength(2)
  expect(b.container.querySelector('a[download]')).toBeNull()
}, 30_000)

it('cancels hidden, replaced Session and unloaded observers; late facts and publish replies cannot download', async () => {
  const calls: { request: unknown; signal: AbortSignal; reply: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const reply = Promise.withResolvers<Response>()
    calls.push({ request: JSON.parse(String(init.body)).request, signal: init.signal!, reply })
    return reply.promise
  }))
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const b = await boot()
  await vi.waitFor(() => { expect(calls).toHaveLength(1) })
  await b.move({ visible: false })
  expect(calls[0]!.signal.aborted).toBe(true)
  await b.move({ sessionId: BOB, visible: true })
  await vi.waitFor(() => { expect(calls).toHaveLength(2) })
  expect(calls[1]!.request).toEqual({ sessionId: BOB, executionIds: [EXECUTION] })
  await act(async () => { calls[0]!.reply.resolve(Response.json(facts())) })
  expect(b.container.querySelector('[data-produced-file]')).toBeNull()
  await act(async () => { calls[1]!.reply.resolve(Response.json(facts(BOB))) })
  const button = await b.query.findByRole('button', { name: `out/report.txt: ${en.publishDownload}` })
  fireEvent.click(button)
  await vi.waitFor(() => { expect(calls).toHaveLength(3) })
  await b.move({ sessionId: ALICE })
  expect(calls[2]!.signal.aborted).toBe(true)
  await act(async () => { calls[2]!.reply.resolve(Response.json(published(calls[2]!.request))) })
  expect(download).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(calls).toHaveLength(4) })
  await b.client.unload(PRODUCT)
  expect(calls[3]!.signal.aborted).toBe(true)
  await act(async () => { calls[3]!.reply.resolve(Response.json(facts())) })
  expect(b.container.querySelector('[data-produced-artifacts]')).toBeNull()
  expect(download).not.toHaveBeenCalled()
}, 30_000)

it('rejects a receipt id whose Platform call belongs elsewhere', async () => {
  const publish = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/executionFiles')) return Response.json(facts(ALICE, { callId: 'different-native-call' }))
    publish()
    return Response.json({})
  }))
  const b = await boot()
  await b.query.findByRole('alert')
  expect(b.container.querySelector('[data-produced-file]')).toBeNull()
  expect([...b.container.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'report.txt')).toBe(false)
  expect(publish).not.toHaveBeenCalled()
}, 30_000)

it('retries one version with the same request id, suppresses duplicate clicks and shows a changed source', async () => {
  const requests: unknown[] = []
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/executionFiles')) return Response.json(facts())
    requests.push(JSON.parse(String(init.body)).request)
    return requests.length === 1 ? pending.promise : Response.json({ error: 'artifact_source_changed' }, { status: 409 })
  }))
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const b = await boot()
  const button = await b.query.findByRole('button', { name: `out/report.txt: ${en.publishDownload}` })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(requests).toHaveLength(1)
  await act(async () => { pending.resolve(new Response(null, { status: 503 })) })
  await b.query.findByRole('alert')
  fireEvent.click(button)
  await vi.waitFor(() => { expect(b.container.textContent).toContain(en.sourceChanged) })
  expect(requests[0]).toEqual(requests[1])
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(download).not.toHaveBeenCalled()
  expect(b.container.querySelector('[data-produced-artifacts]')?.textContent).toMatchSnapshot()
}, 30_000)

it('keeps same-path versions on their original turns and reports partial and unavailable facts', async () => {
  const second = 'de2f8f25-1115-40a0-819e-d45af386eea8'
  const requests: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const request: unknown = JSON.parse(String(init.body)).request
    if (url.endsWith('/executionFiles')) {
      const parsed = executionFilesRequest.parse(request)
      const newer = parsed.executionIds[0] === second
      const value = facts(parsed.sessionId === ALICE ? ALICE : BOB, { executionId: newer ? second : EXECUTION,
        callId: newer ? 'native-call-2' : 'native-call-1', sha256: newer ? 'b'.repeat(64) : SHA })
      return Response.json({ ...value, items: value.items.map(item => ({ ...item, status: 'partial', reasons: ['excluded_paths'] })) })
    }
    requests.push(request)
    return Response.json(published(request))
  }))
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const b = await boot('en', [...round(), ...round(2, second, 'native-call-2', 7)])
  await vi.waitFor(() => { expect(b.container.querySelectorAll('[data-produced-file]')).toHaveLength(2) })
  const buttons = b.query.getAllByRole('button', { name: `out/report.txt: ${en.publishDownload}` })
  fireEvent.click(buttons[0]!)
  fireEvent.click(buttons[1]!)
  await vi.waitFor(() => { expect(download).toHaveBeenCalledTimes(2) })
  expect(requests.map(request => artifactPublishRequest.parse(request).expectedRevision)).toEqual([SHA, 'b'.repeat(64)])
  expect(b.container.textContent).toContain(en.factsPartial)
  expect(b.container.textContent).toContain(en.excluded_paths)
  await b.sessions.replaceEvents(ALICE, [])
  await vi.waitFor(() => { expect(b.container.querySelector('[data-produced-artifacts]')).toBeNull() })
}, 30_000)

for (const language of ['en', 'zh'] as const) it(`shows unavailable facts without claiming file absence (${language})`, async () => {
  const copy = language === 'en' ? en : zh
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessionId: ALICE, workspaceId: WORKSPACE,
    items: [{ executionId: EXECUTION, callId: 'native-call-1', state: 'uncertain', status: 'unavailable',
      files: [], reasons: ['execution_unavailable'] }] })))
  const b = await boot(language)
  await vi.waitFor(() => { expect(b.container.textContent).toContain(copy.execution_unavailable) })
  expect(b.container.querySelector('[data-produced-file]')).toBeNull()
  expect(b.container.textContent).not.toContain(copy.factsEmpty)
  expect(b.container.querySelector('[data-produced-artifacts]')?.textContent).toMatchSnapshot()
}, 30_000)

it('associates only the trusted continuation with the original execution, including a paged-out receipt', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(facts())))
  const b = await boot('en', [...round(), ...continuation()])
  await vi.waitFor(() => { expect(b.container.querySelectorAll('[data-produced-file]')).toHaveLength(1) })
  await vi.waitFor(() => { expect(b.query.getAllByRole('button', { name: 'report.txt' })).toHaveLength(4) })
  const view = b.client.ctx.uiConversation.binding(ALICE).target('chat').getSnapshot()!
  const assistant = view.nodes.values().find(node => node.kind === 'assistant-step' && node.location.kind === 'step'
    && node.location.turn.turn === 2)!
  expect(assistant.location.kind).toBe('step')
  if (assistant.location.kind !== 'step') throw new Error('Expected the native continuation step')
  const owner = { turn: assistant.location.turn, seq: assistant.anchorSeq, openFile: vi.fn() }
  expect(referencesForClosing(owner)).toEqual([])
  expect(referencesForClosing(owner, true)).toEqual([{ executionId: EXECUTION, callId: 'native-call-1', turn: 1, seq: 7 }])
  await b.sessions.replaceEvents(ALICE, continuation())
  const paged = b.client.ctx.uiConversation.binding(ALICE).target('chat').getSnapshot()!
  const next = paged.nodes.values().find(node => node.kind === 'assistant-step')!
  if (next.location.kind !== 'step') throw new Error('Expected the native continuation step')
  expect(referencesForClosing({ turn: next.location.turn, seq: next.anchorSeq, openFile: vi.fn() }, true))
    .toEqual([{ executionId: EXECUTION, callId: undefined, turn: undefined, seq: 7 }])
  await vi.waitFor(() => { expect(b.query.getAllByRole('button', { name: 'report.txt' })).toHaveLength(2) })
  expect(b.container.querySelector('[data-produced-artifacts]')).toBeNull()
  await b.sessions.replaceEvents(ALICE, [at(7, 'user/message', { id: 'ordinary', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'power-evolve-execution', executionId: EXECUTION }) }],
  }, true), ...continuation().slice(1)])
  const ordinary = b.client.ctx.uiConversation.binding(ALICE).target('chat').getSnapshot()!.nodes.values()
    .find(node => node.kind === 'assistant-step')!
  if (ordinary.location.kind !== 'step') throw new Error('Expected the native ordinary step')
  expect(referencesForClosing({ turn: ordinary.location.turn, seq: ordinary.anchorSeq, openFile: vi.fn() }, true)).toEqual([])
  await vi.waitFor(() => { expect(b.query.queryAllByRole('button', { name: 'report.txt' })).toHaveLength(0) })
}, 30_000)

it('refreshes durable facts and removes inline actions when verification becomes unavailable', async () => {
  let unavailable = false
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(unavailable ? { sessionId: ALICE, workspaceId: WORKSPACE,
    items: [{ executionId: EXECUTION, callId: 'native-call-1', state: 'succeeded', status: 'unavailable',
      files: [], reasons: ['verification_failed'] }] } : facts())))
  const b = await boot()
  await vi.waitFor(() => { expect(b.query.getAllByRole('button', { name: 'report.txt' })).toHaveLength(2) })
  unavailable = true
  fireEvent.click(b.query.getByRole('button', { name: en.refresh }))
  await vi.waitFor(() => { expect(b.container.textContent).toContain(en.verification_failed) })
  expect(b.query.queryAllByRole('button', { name: 'report.txt' })).toHaveLength(0)
  expect(b.container.querySelector('[data-produced-file]')).toBeNull()
  await b.client.reload(PRODUCT)
  await vi.waitFor(() => { expect(b.container.textContent).toContain(en.verification_failed) })
  expect(b.container.querySelectorAll('[data-produced-artifacts]')).toHaveLength(1)
}, 30_000)

it('keeps file facts on a tool-only closing and refuses non-cloud or errored receipts', async () => {
  const fetch = vi.fn(async () => Response.json(facts()))
  vi.stubGlobal('fetch', fetch)
  const b = await boot('en', round().filter(entry => entry.event.type !== 'assistant/message'))
  await vi.waitFor(() => { expect(b.container.querySelector('[data-produced-file]')).not.toBeNull() })
  const alien = round().map(entry => entry.event.type === 'tool/call'
    ? at(2, 'tool/call', { turn: 1, step: 1, callId: 'native-call-1', name: 'desktop_exec', arguments: '{}' }) : entry)
  await b.sessions.replaceEvents(ALICE, alien)
  await vi.waitFor(() => { expect(b.container.querySelector('[data-produced-artifacts]')).toBeNull() })
  expect(fetch).toHaveBeenCalledOnce()
  const failure = round().map(entry => entry.event.type === 'tool/result'
    ? at(3, 'tool/result', { ...entry.event.data, message: { ...entry.event.data.message, isError: true } }, true) : entry)
  await b.sessions.replaceEvents(ALICE, failure)
  expect(b.container.querySelector('[data-produced-artifacts]')).toBeNull()
  expect(fetch).toHaveBeenCalledOnce()
}, 30_000)

it('bounds pending polling, shares an observer, isolates Session versions and stops uncertain reads', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(facts())))
  const b = await boot()
  const node = b.client.ctx.uiConversation.binding(ALICE).target('chat').getSnapshot()!.nodes.values()
    .find(node => node.kind === 'turn-tail')!
  if (node.location.kind !== 'turn') throw new Error('Expected a native closing turn')
  const owner = { turn: node.location.turn, seq: node.anchorSeq, openFile: vi.fn() }
  let count = 0
  let pending = true
  const manager = new ExecutionFacts(new ArtifactHttpClient(async () => {
    count++
    return Response.json(pending ? facts(ALICE, { pending: true }) : { sessionId: ALICE, workspaceId: WORKSPACE,
      items: [{ executionId: EXECUTION, callId: 'native-call-1', state: 'uncertain', status: 'unavailable',
        files: [], reasons: ['execution_unavailable'] }] })
  }), vi.fn(), vi.fn(), { pollMs: 1, maxPolls: 2, requestMs: 1000 })
  onTestFinished(() => { manager.dispose() })
  const alice = manager.changesForSession(ALICE)
  const bob = manager.changesForSession(BOB)
  expect(manager.changesForSession(ALICE)).toBe(alice)
  const source = manager.forClosing(ALICE, owner)
  expect(manager.forClosing(ALICE, owner)).toBe(source)
  expect(manager.source(BOB, source.key)).toBeUndefined()
  const first = source.subscribe(vi.fn())
  const second = source.subscribe(vi.fn())
  await vi.waitFor(() => { expect(count).toBe(2) })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(count).toBe(2)
  expect(alice.getSnapshot()).toBeGreaterThan(0)
  expect(bob.getSnapshot()).toBe(0)
  first()
  pending = false
  source.refresh()
  await vi.waitFor(() => { expect(source.getSnapshot().items[0]?.status).toBe('unavailable') })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(count).toBe(3)
  second()
  source.refresh()
  expect(count).toBe(3)
}, 30_000)

it('resolves exact paths and unique basenames using the newest allowed version', () => {
  const older = { path: 'out/report.txt', sizeBytes: 5, sha256: SHA }
  const newer = { ...older, sha256: 'b'.repeat(64) }
  expect(resolveArtifactMention([older, newer], '/workspace/out/report.txt')).toBe(newer)
  expect(resolveArtifactMention([older, newer], 'report.txt')).toBe(newer)
  expect(resolveArtifactMention([older, { ...newer, path: 'nested/report.txt' }], 'report.txt')).toBeUndefined()
  for (const value of ['invented.txt', '../out/report.txt', '/other/out/report.txt', ' out/report.txt ', 'out\\report.txt']) {
    expect(resolveArtifactMention([older], value)).toBeUndefined()
  }
})
