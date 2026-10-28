/** Native feedback persists through JSONL while account admission reaches its queued append points. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as CommandFeedback from '@deepseek-ai/dsh-command-feedback'
import MessageFeedback from '@deepseek-ai/dsh-message-feedback'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { MessageFeedbackPutResult } from '@deepseek-ai/dsh-message-feedback/types'
import { createNativeFeedbackIdentity, createNativeMessageFeedback, createNativeSessionFeedback, type NativeFeedback } from '../src/native-feedback.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'

afterEach(() => { vi.restoreAllMocks() })

const { hostIdentity } = vi.hoisted(() => ({ hostIdentity: vi.fn(() => { throw new Error('Account feedback must not use Host home identity.') }) }))
vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: hostIdentity }))

async function fixture(id: string, selected = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-feedback-'))), project = join(home, 'project')
  const sessionId = SessionId('feedback-' + id), lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-feedback', lifetime: lifetime.signal })
  const manifest = { recipeVersion: binding.recipeVersion, rpcEndpoints: selected ? [
    { endpoint: 'sessionFeedback/record', handlerId: 'native:sessionFeedback', guard: 'account-session' as const },
    ...['list', 'put', 'delete'].map(method => ({ endpoint: 'messageFeedback/' + method,
      handlerId: 'native:messageFeedback', guard: 'account-session' as const })),
  ] : [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let owner: Context | undefined, messages: NativeFeedback<MessageFeedback> | undefined
  let sessions: NativeFeedback<CommandFeedback.SessionFeedbackService> | undefined, current = true
  let writer: SessionHandle | undefined, detach: (() => void) | undefined
  const releases: Array<() => void> = [], pending: Promise<unknown>[] = [], events: SessionEvent[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.allSettled(pending)
    try { await writer?.close(); detach?.(); await owner?.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const assertCurrent = (): void => {
    if (!current || lifetime.signal.aborted) throw new CloudApiError('cloud/stale-generation', 'The original account generation ended.')
  }
  const own = (sid: SessionId) => {
    if (sid !== sessionId) throw new CloudApiError('cloud/forbidden', 'Feedback requires this account Session.')
  }
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async () => {} },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 65536,
      assertSessionRead: own },
    assertHandlerEnabled() {}, resolveCreate: async request => request, assertActiveScope() {},
    assertSessionProject: async (sid) => {
      own(sid)
      const root = owner
      if (root === undefined) throw new Error('Missing original feedback root')
      const header = root.sessions.get(sid)?.header ?? (await root.sessionPersistence.stat(sid))?.header
      if (header?.cwd !== project) throw new CloudApiError('cloud/forbidden', 'Feedback requires the original account project.')
    },
  }
  const configuration = join(home, 'cordis.yml')
  writeFileSync(configuration, JSON.stringify([
    { id: 'sessions', name: 'cordis:feedback-sessions' },
    { id: 'jsonl', name: 'cordis:feedback-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'session-feedback', name: 'cordis:feedback-session' },
    { id: 'message-feedback', name: 'cordis:feedback-message', config: { maxNoteBytes: 128 } },
    { id: 'commands', name: 'cordis:feedback-commands' },
    { id: 'command-feedback', name: 'cordis:feedback-command' },
  ]))
  const ctx = await boot('native-feedback', configuration, [], async (ctx) => {
    owner = ctx
    ctx.provide('peAccount', binding)
    ctx.provide('sessionFeedbackIdentity', createNativeFeedbackIdentity(ctx, binding, assertCurrent))
    ctx.on('session/event', (_session, event) => { events.push(event) })
    await ctx.plugin(Typert)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    Object.assign(ctx.loader.builtins, {
      'feedback-sessions': SessionStore, 'feedback-jsonl': Jsonl, 'feedback-commands': CommandRuntime,
      'feedback-session': { inject: CommandFeedback.SessionFeedbackService.inject, apply(scope: Context) {
        sessions = createNativeSessionFeedback(scope, binding, assertCurrent, policy, guards, 128)
      } },
      'feedback-message': { inject: MessageFeedback.inject, Config: MessageFeedback.Config,
        apply(scope: Context, config: ConstructorParameters<typeof MessageFeedback>[1]) {
          messages = createNativeMessageFeedback(scope, binding, assertCurrent, policy, guards, 128, config)
        } },
      'feedback-command': { inject: ['commands', 'sessionFeedback', 'sessionFeedbackIdentity'], apply: CommandFeedback.apply },
    })
  })
  if (sessions === undefined || messages === undefined) throw new Error('Native feedback did not mount')
  const sessionService = sessions, messageService = messages
  const session = ctx.sessions.prepare(sessionId, { meta: { cwd: project } })
  detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  writer = await ctx.sessionPersistence.create(session.header)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const message = createAssistantMessage({ content: [{ type: 'text', text: 'A finalized answer' }], source: { provider: 'test', model: 'test' } })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(await ctx.sessions.flush(session)).toBe(true)
  const peer: PeerScope = { id: brandString<PeerId>('feedback-' + id), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
  const invoke = <T>(namespace: string, method: string, request: object) =>
    ctx.typertGateway.invoke({ namespace, method, args: { request }, peer }) as Promise<T>
  const list = () => invoke('messageFeedback', 'list', { sessionId })
  const put = () => invoke<MessageFeedbackPutResult>('messageFeedback', 'put', { sessionId, messageId: message.id,
    rating: 'positive', note: 'native feedback', ifVersion: null })
  const cold = async () => { await writer?.close(); writer = undefined; detach?.(); detach = undefined }
  const command = async (line: string) => {
    const agent: Agent = { id: session.id, ctx, session, status: 'idle', options: {}, inbox: unsupportedInbox(),
      send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
      runMaintenance: operation => operation(new AbortController().signal) }
    return ctx.commands.execute(agent, line, [], new AbortController().signal)
  }
  const readDurable = async () => {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try { return (await handle.read()).events }
    finally { await handle.close() }
  }
  const gatePersistence = (operation: 'read' | 'flush' = 'read') => {
    const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
    releases.push(() => { released.resolve(undefined) })
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence), accesses: SessionAccess[] = []
    let closes = 0, gateOpen = true
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (sid, access) => {
      const handle = await open(sid, access)
      accesses.push(access)
      const read = handle.read.bind(handle), flush = handle.flush.bind(handle), close = handle.close.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
        const result = await read(...args)
        if (operation === 'read' && gateOpen) { entered.resolve(undefined); await released.promise }
        return result
      })
      vi.spyOn(handle, 'flush').mockImplementation(async (...args) => {
        if (operation === 'flush' && gateOpen) { entered.resolve(undefined); await released.promise }
        await flush(...args)
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => { closes++; await close() })
      return handle
    })
    return { entered: entered.promise, accesses, closes: () => closes,
      release() { gateOpen = false; released.resolve(undefined) }, track(work: Promise<unknown>) { pending.push(work) } }
  }
  return { ctx, binding, lifetime, policy, sessionId, session, message, events, peer, home, sessionService, messageService,
    invoke, list, put, command, cold, readDurable, gatePersistence, revoke: () => { current = false } }
}

it('reuses the original guarded Session feedback service and records the native log-only remark', async () => {
  const f = await fixture('session')
  expect(f.sessionService.value.typertRemote.service).toBe(f.sessionService.value)
  expect(f.sessionService.inspect().rpcEndpoints).toHaveLength(1)
  expect(await f.invoke('sessionFeedback', 'record', { sessionId: f.sessionId, text: '  same event  ', category: 'product-interaction' }))
    .toEqual({ ok: true, value: { recorded: true } })
  expect(f.events.at(-1)).toMatchObject({ type: 'feedback/record', data: { text: 'same event', category: 'product-interaction' } })
  expect(f.events.at(-1)).not.toHaveProperty('surfaceOp')
  expect(f.ctx.get('sessionFeedback')).toBeDefined()
})

it('keeps native message feedback CAS, live flush, cold read and delete on the canonical JSONL log', async () => {
  const f = await fixture('messages'), put = await f.put()
  if (!put.ok) throw new Error(put.error.code)
  expect(put.value).toMatchObject({ messageId: f.message.id, note: 'native feedback', rating: 'positive' })
  expect((await f.readDurable()).at(-1)).toMatchObject({ type: 'feedback/message-put' })
  await f.cold()
  expect(await f.list()).toEqual({ ok: true, value: { items: [put.value] } })
  expect(await f.invoke('messageFeedback', 'put', { sessionId: f.sessionId, messageId: f.message.id,
    rating: 'negative', ifVersion: null })).toMatchObject({ ok: false, error: { code: 'version-conflict', current: put.value } })
  expect(await f.invoke('messageFeedback', 'delete', { sessionId: f.sessionId, messageId: f.message.id, ifVersion: put.value.version }))
    .toEqual({ ok: true, value: { absent: true } })
  expect(await f.list()).toEqual({ ok: true, value: { items: [] } })
  expect((await f.readDurable()).at(-1)).toMatchObject({ type: 'feedback/message-delete' })
  expect(f.messageService.inspect().rpcEndpoints).toHaveLength(3)
})

it('records the original nonempty feedback command with only the current account acknowledgement identity', async () => {
  const f = await fixture('command-identity')
  const result = await f.command('/feedback keep my account isolated')
  expect(result?.result.kind).toBe('success')
  expect(result?.result.text).toContain(`Feedback recorded for session ${f.sessionId}`)
  expect(result?.result.text).toContain(`Anonymous user: ${f.ctx.get('sessionFeedbackIdentity')?.()}.`)
  expect(hostIdentity).not.toHaveBeenCalled()
  expect(await f.ctx.sessions.flush(f.session)).toBe(true)
  expect((await f.readDurable()).filter(event => event.type === 'feedback/record'))
    .toEqual([expect.objectContaining({ data: { text: 'keep my account isolated' } })])
  f.revoke()
  const before = f.events.filter(event => event.type === 'feedback/record').length
  await expect(f.command('/feedback ended account must not record')).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(f.events.filter(event => event.type === 'feedback/record')).toHaveLength(before)
  expect(hostIdentity).not.toHaveBeenCalled()
})

it('keeps the acknowledgement identity stable for the same account and separate from another account', async () => {
  const a = await fixture('identity-a'), same = await fixture('identity-a'), other = await fixture('identity-b')
  const read = (ctx: Context) => ctx.get('sessionFeedbackIdentity')?.()
  expect(read(a.ctx)).toMatch(/^[a-f0-9]{64}$/u)
  expect(read(a.ctx)).toBe(read(same.ctx))
  expect(read(a.ctx)).not.toBe(read(other.ctx))
  a.lifetime.abort()
  expect(() => read(a.ctx)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(hostIdentity).not.toHaveBeenCalled()
})

it('rejects foreign Sessions and absent endpoint selection without either native feedback event', async () => {
  const f = await fixture('foreign'), before = f.events.length
  await expect(f.invoke('sessionFeedback', 'record', { sessionId: SessionId('another-account'), text: 'foreign' }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.invoke('messageFeedback', 'list', { sessionId: SessionId('another-account') }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.events).toHaveLength(before)
  const closed = await fixture('closed', false)
  await expect(closed.put()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(closed.invoke('sessionFeedback', 'record', { sessionId: closed.sessionId })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(closed.messageService.inspect().rpcEndpoints).toEqual([])
})

it('closes the actual cold write handle and appends no feedback when generation ends during its native read', async () => {
  const f = await fixture('cold-stale')
  await f.cold()
  const before = await f.readDurable(), gate = f.gatePersistence(), work = f.put()
  gate.track(work)
  const rejected = expect(work).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await gate.entered
  f.lifetime.abort()
  gate.release()
  await rejected
  expect(gate.accesses).toEqual(['write'])
  expect(gate.closes()).toBe(1)
  expect(await f.readDurable()).toEqual(before)
  const available = await f.ctx.sessionPersistence.open(f.sessionId, 'write')
  await available.close()
})

it('rechecks a queued native mutation after an earlier read finishes instead of inheriting its earlier admission', async () => {
  const f = await fixture('queue-stale')
  await f.cold()
  const before = await f.readDurable(), gate = f.gatePersistence(), read = f.list()
  gate.track(read)
  const readRejected = expect(read).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await gate.entered
  const write = f.put()
  gate.track(write)
  const writeRejected = expect(write).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  f.revoke()
  gate.release()
  await Promise.all([readRejected, writeRejected])
  expect(gate.accesses).toEqual(['read'])
  expect(gate.closes()).toBe(1)
  expect(await f.readDurable()).toEqual(before)
})

it('finishes an already started native append and its flush/close when the generation ends before flush', async () => {
  const f = await fixture('flush-stale')
  await f.cold()
  const gate = f.gatePersistence('flush'), write = f.put()
  gate.track(write)
  const rejected = expect(write).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await gate.entered
  f.revoke()
  gate.release()
  await rejected
  expect(gate.closes()).toBe(1)
  expect((await f.readDurable()).at(-1)).toMatchObject({ type: 'feedback/message-put', data: { sessionId: f.sessionId } })
  const available = await f.ctx.sessionPersistence.open(f.sessionId, 'write')
  await available.close()
})
