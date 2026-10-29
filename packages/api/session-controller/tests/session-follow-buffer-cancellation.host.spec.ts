import { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

it('detaches and clears follow event buffering on abort while waiting for actual observation', async () => {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    async stat() { entered.resolve(undefined); await release.promise; return undefined },
  }) as never)
  const id = SessionId('pending-follow-buffer')
  const history = new SessionHistoryController(ctx, () => { throw new Error('No promotion expected') })
  const push = vi.spyOn(Deque.prototype, 'pushBack')
  const pushFront = vi.spyOn(Deque.prototype, 'pushFront')
  const clear = vi.spyOn(Deque.prototype, 'clear')
  const abort = new AbortController()
  const pending = history.follow({ address: { kind: 'session', sessionId: id }, assistantStream: true }, abort.signal)[Symbol.asyncIterator]().next()
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await entered.promise
  const session = { id, seq: 0, firstLiveSeq: 0, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }] }
  const agent = { id, session, status: 'running', ctx }
  const frame = { type: 'start', attemptId: 'opening-attempt', revision: 1, turn: 1, step: 1 }
  ctx.emit('session/event', { id } as never, { type: 'turn/start', seq: 0 } as never)
  ctx.emit('session/created', session as never)
  ctx.emit('agent/assistant-stream', { agent, frame } as never)
  expect(push).toHaveBeenCalledTimes(2)
  expect(pushFront).toHaveBeenCalledTimes(1)
  abort.abort(new Error('carrier cancelled'))
  expect(clear).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 10; i += 1) ctx.emit('session/event', { id } as never, { type: 'turn/start', seq: i } as never)
  ctx.emit('session/created', session as never)
  ctx.emit('agent/assistant-stream', { agent, frame } as never)
  expect(push).toHaveBeenCalledTimes(2)
  expect(pushFront).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve(undefined)
  await expect(pending).rejects.toBeDefined()
  expect(clear).toHaveBeenCalledTimes(1)
})
