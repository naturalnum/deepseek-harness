/** Original Session projection queues under real slow readers; no new Remote arguments or business implementation. */
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Query from '@deepseek-ai/dsh-session-query'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SessionController from '../src/index.ts'
import { expect, it, onTestFinished } from 'vitest'
import { SessionControlController, type SessionControlBufferLimits } from '../src/control.ts'
import type { SessionControlFrame } from '../src/types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'm8bb/value': string }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { 'm8bb/value': string }
  interface SessionProjectionStateMap { 'm8bb/value': string }
}
const limits = { maxQueuedEvents: 2, maxQueuedBytes: 4096, maxFrameBytes: 4096 }

async function fixture() {
  const ctx = new Context(), readers: AsyncIterator<SessionControlFrame>[] = [], controls: AbortController[] = []
  await ctx.plugin(Sessions); await ctx.plugin(Projections)
  ctx.sessionProjections.register<'m8bb/value', string>({ key: 'm8bb/value', stateVersion: 1,
    stateSchema: z.string(), init: () => '', apply: (state, event) => event.type === 'm8bb/value' ? event.data : state,
    wire: { viewSchema: z.string(), view: state => state } })
  const session = ctx.sessions.create(SessionId('bounded-control')), control = new SessionControlController(ctx)
  onTestFinished(async () => {
    for (const abort of controls) abort.abort()
    for (const reader of readers) await reader.return?.()
    await ctx.fiber.dispose()
  })
  const open = (budget?: SessionControlBufferLimits) => {
    const abort = new AbortController(), reader = control.control(abort.signal, budget)[Symbol.asyncIterator]()
    controls.push(abort); readers.push(reader)
    return { reader, abort }
  }
  return { ctx, session, open, emit: (value: string) => { session.append('m8bb/value', value) } }
}

it('fails a stalled original control queue at its item limit while a healthy reader continues', async () => {
  const f = await fixture(), slow = f.open(limits).reader, healthy = f.open(limits).reader
  await slow.next(); await healthy.next()
  for (const value of ['a', 'b', 'c']) {
    f.emit(value)
    await expect(healthy.next()).resolves.toMatchObject({ value: { type: 'projection', value } })
  }
  await expect(slow.next()).rejects.toThrow('queued-event limit')
  await expect(slow.return?.()).resolves.toMatchObject({ done: true })
  f.emit('d')
  await expect(healthy.next()).resolves.toMatchObject({ value: { value: 'd' } })
})

it('charges whole native frames and frees resident bytes on normal dequeue', async () => {
  const f = await fixture()
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'projection', sessionId: f.session.id,
    key: 'm8bb/value', value: 'a', seq: 0 }))
  const reader = f.open({ ...limits, maxQueuedBytes: bytes }).reader
  await reader.next()
  f.emit('a')
  await expect(reader.next()).resolves.toMatchObject({ value: { value: 'a' } })
  f.emit('b')
  await expect(reader.next()).resolves.toMatchObject({ value: { value: 'b' } })
  f.emit('c'); f.emit('d')
  await expect(reader.next()).rejects.toThrow('resident-byte limit')
})

it('checks complete baseline and incremental frame bytes and wakes an actual pending read on failure', async () => {
  const f = await fixture(), tiny = f.open({ ...limits, maxFrameBytes: 1 }).reader
  await expect(tiny.next()).rejects.toThrow('frame exceeds')
  const reader = f.open({ ...limits, maxFrameBytes: 256 }).reader
  await reader.next()
  const reading = reader.next(), rejected = expect(reading).rejects.toThrow('frame exceeds')
  f.emit('x'.repeat(512))
  await rejected
})

it('drops bounded resident frames on cancellation and disposal but preserves omitted-budget disposal draining', async () => {
  const f = await fixture(), bounded = f.open(limits), original = f.open()
  await bounded.reader.next(); await original.reader.next()
  f.emit('a'); f.emit('b')
  bounded.abort.abort()
  await expect(bounded.reader.next()).resolves.toMatchObject({ done: true })
  await f.ctx.fiber.dispose()
  await expect(original.reader.next()).resolves.toMatchObject({ value: { value: 'a' } })
  await expect(original.reader.next()).resolves.toMatchObject({ value: { value: 'b' } })
  await expect(original.reader.next()).resolves.toMatchObject({ done: true })
})

it('rejects invalid native budgets before yielding a baseline and preserves omitted-budget buffering', async () => {
  const f = await fixture()
  for (const key of ['maxQueuedEvents', 'maxQueuedBytes', 'maxFrameBytes']) {
    const absent = { ...limits }
    Reflect.deleteProperty(absent, key)
    await expect(f.open(absent).reader.next()).rejects.toThrow('positive finite safe integers')
    for (const value of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(f.open({ ...limits, [key]: value }).reader.next()).rejects.toThrow('positive finite safe integers')
    }
  }
  const reader = f.open().reader
  await reader.next()
  for (let index = 0; index < 8; index++) f.emit(String(index))
  for (let index = 0; index < 8; index++) {
    await expect(reader.next()).resolves.toMatchObject({ value: { value: String(index) } })
  }
})

it('reads the protected buffer hook after original Controller construction without changing its Remote method', async () => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(async () => { abort.abort(); await ctx.fiber.dispose() })
  await ctx.plugin(Typert); await ctx.plugin(RemoteAccess)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(DefaultModel, { provider: 'unused', model: 'unused' })
  class ExactQuery extends Query {
    override searchSessions(): Promise<never> { return Promise.reject(new Error('Unused search')) }
    override searchEvents(): Promise<never> { return Promise.reject(new Error('Unused search')) }
  }
  new ExactQuery(ctx)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
    maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] } })
  let reads = 0
  class LimitedController extends SessionController {
    private readonly budget = { ...limits, maxFrameBytes: 1 }
    protected override controlBufferLimits(): SessionControlBufferLimits {
      reads++
      return this.budget
    }
  }
  const controller = new LimitedController(ctx, { nativeOpen: false })
  expect(reads).toBe(0)
  const markers = remoteMethods(controller).filter(row => row.method === 'control')
  expect(markers).toHaveLength(1)
  expect(markers[0]?.mode).toBe('stream')
  const reader = controller.control(abort.signal)[Symbol.asyncIterator]()
  await expect(reader.next()).rejects.toThrow('frame exceeds')
  expect(reads).toBe(1)
  await reader.return?.()
})

it('preserves an exact complete UTF-8 replacement frame and refuses one additional byte', async () => {
  const f = await fixture(), value = '中"\\\n'.repeat(32)
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'projection', sessionId: f.session.id,
    key: 'm8bb/value', value, seq: 0 }))
  const reader = f.open({ ...limits, maxFrameBytes: bytes, maxQueuedBytes: bytes * 2 }).reader
  await reader.next()
  f.emit(value)
  await expect(reader.next()).resolves.toMatchObject({ value: { type: 'projection', value } })
  f.emit(value + 'a')
  await expect(reader.next()).rejects.toThrow('frame exceeds')
})
