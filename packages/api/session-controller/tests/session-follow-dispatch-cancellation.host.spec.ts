import { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

it('does not re-buffer a real Session event when an earlier observer aborts during the same dispatch', async () => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    async stat() { entered.resolve(undefined); await release.promise; return undefined },
  }) as never)
  const id = SessionId('worker3-actual-session-follow')
  ctx.on('session/event', (session) => { if (session.id === id) abort.abort() }, { global: true })
  const history = new SessionHistoryController(ctx, () => { throw new Error('No promotion expected') })
  const push = vi.spyOn(Deque.prototype, 'pushBack')
  const next = history.follow({ address: { kind: 'session', sessionId: id }, assistantStream: true }, abort.signal)[Symbol.asyncIterator]().next()
  let settled = false
  void next.then(() => { settled = true }, () => { settled = true })
  void next.catch(() => {})
  await entered.promise
  const session = ctx.sessions.create(id, { meta: { cwd: '/worker3-fixture' } })
  session.append('turn/start', { turn: 1 })
  const retainedBuffer = push.mock.instances[0] as Deque<unknown> | undefined
  expect(abort.signal.aborted).toBe(true)
  expect(retainedBuffer?.size ?? 0).toBe(0)
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve(undefined)
  await expect(next).rejects.toBeDefined()
})

it.each(['session/created', 'agent/assistant-stream'] as const)(
  'ignores a captured %s callback when an earlier listener cancels follow', async (type) => {
    const ctx = new Context(), abort = new AbortController()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    onTestFinished(async () => { release.resolve(undefined); vi.restoreAllMocks(); await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      async stat() { entered.resolve(undefined); await release.promise; return undefined },
    }) as never)
    const id = SessionId(`captured-${type}`)
    if (type === 'session/created') ctx.on('session/created', () => { abort.abort() }, { global: true })
    else ctx.on('agent/assistant-stream', () => { abort.abort() }, { global: true })
    const history = new SessionHistoryController(ctx, () => { throw new Error('No promotion expected') })
    const push = vi.spyOn(Deque.prototype, 'pushBack')
    const snapshotEvents = vi.fn(() => [{ type: 'turn/start', seq: 0 }])
    const session = { id, seq: 0, firstLiveSeq: 0, snapshotEvents }
    const next = history.follow({ address: { kind: 'session', sessionId: id }, assistantStream: true }, abort.signal)[Symbol.asyncIterator]().next()
    void next.catch(() => {})
    await entered.promise
    if (type === 'session/created') ctx.emit('session/created', session as never)
    else ctx.emit('agent/assistant-stream', { agent: { id, session, ctx },
      frame: { type: 'start', attemptId: 'fixture-attempt', revision: 1, turn: 1, step: 1 } } as never)
    expect(abort.signal.aborted).toBe(true)
    if (type === 'session/created') expect(snapshotEvents).not.toHaveBeenCalled()
    else expect(push).not.toHaveBeenCalled()
    release.resolve(undefined)
    await expect(next).rejects.toBeDefined()
  },
)

it('already-aborted follow does not start a provider read and clears once', async () => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const stat = vi.fn(() => Promise.resolve(undefined))
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, { stat }) as never)
  const history = new SessionHistoryController(ctx, () => { throw new Error('No promotion expected') })
  const clear = vi.spyOn(Deque.prototype, 'clear')
  abort.abort(new Error('before request'))
  await expect(history.follow({ address: { kind: 'session', sessionId: SessionId('worker3-preabort') } }, abort.signal)[Symbol.asyncIterator]().next()).rejects.toBeDefined()
  expect(stat).not.toHaveBeenCalled()
  expect(clear).toHaveBeenCalledTimes(1)
})
