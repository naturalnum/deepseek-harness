import { Context } from '@deepseek-ai/cordis'
import { projectRemoteEventRequest, type TypertRemoteEventInvocation } from '@deepseek-ai/dsh-api-gateway'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createRemoteWaterfallListener } from '../src/index.ts'

function fixture(accept = true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const received: TypertRemoteEventInvocation[] = []
  const sink = { push: vi.fn((dispatch: TypertRemoteEventInvocation) => {
    if (accept) received.push(dispatch)
    return accept
  }) }
  ctx.on('user-questions/request', createRemoteWaterfallListener('user-questions/request', sink) as never)
  const agent = { id: 'original-agent', ctx: ctx.extend() }
  const next = vi.fn(() => Promise.resolve('original Host fallback'))
  const request = { agent, signal: new AbortController().signal,
    callId: 'call-1', questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }] }
  const waterfall = ctx.waterfall.bind(ctx) as (
    receiver: object, name: string, request: object, next: () => Promise<unknown>,
  ) => Promise<unknown>
  const invoke = (value: object = request) => waterfall(scopeTarget(ctx, agent), 'user-questions/request', value, next)
  const dispatch = (): TypertRemoteEventInvocation => {
    const value = received.at(-1)
    if (value === undefined) throw new Error('The original native listener did not enqueue an invocation')
    return value
  }
  return { ctx, agent, received, sink, request, next, invoke, dispatch }
}

it('reuses the native scoped carrier and Gateway projection for result settlement', async () => {
  const f = fixture(), result = f.invoke(), original = f.dispatch()
  expect(original.request).toBe(f.request)
  expect(original.context).toEqual({ value: f.agent.ctx, subject: f.agent, agentId: f.agent.id })
  const projected = projectRemoteEventRequest(original.request, original.context.subject)
  expect(projected.signal).toBe(f.request.signal)
  expect(projected.request).toEqual({ callId: 'call-1', questions: f.request.questions })
  expect(projected.request).not.toHaveProperty('agent')
  expect(projected.request).not.toHaveProperty('signal')
  original.resolve({ kind: 'result', value: { answers: [{ questionId: 'q1', option: 'Yes' }] } })
  await expect(result).resolves.toEqual({ answers: [{ questionId: 'q1', option: 'Yes' }] })
  expect(f.next).not.toHaveBeenCalled()
})

it('preserves native next delegation and rejection without replacing the continuation', async () => {
  const f = fixture(), delegated = f.invoke()
  f.dispatch().resolve({ kind: 'next' })
  await expect(delegated).resolves.toBe('original Host fallback')
  expect(f.next).toHaveBeenCalledOnce()
  const error = new Error('Source disposed with a queued native question'), rejected = f.invoke()
  const rejection = expect(rejected).rejects.toBe(error)
  f.dispatch().reject(error)
  await rejection
  expect(f.next).toHaveBeenCalledOnce()
})

it('delegates after a closed source declines admission and does not retain its invocation', async () => {
  const f = fixture(false)
  await expect(f.invoke()).resolves.toBe('original Host fallback')
  expect(f.sink.push).toHaveBeenCalledOnce()
  expect(f.received).toEqual([])
  expect(f.next).toHaveBeenCalledOnce()
})

it('allows an accepting bounded sink to reject admission without invoking the Host fallback', async () => {
  const f = fixture(), error = new Error('Original complete-frame budget exceeded')
  f.sink.push.mockImplementation((dispatch) => { dispatch.reject(error); return true })
  await expect(f.invoke()).rejects.toBe(error)
  expect(f.next).not.toHaveBeenCalled()
})

it('rejects an unrelated Agent before queue admission and delegates unscoped Host requests', async () => {
  const f = fixture()
  await expect(async () => f.invoke({ ...f.request, agent: { id: 'foreign-agent', ctx: f.ctx.extend() } }))
    .rejects.toThrow('must carry its Agent directly')
  expect(f.sink.push).not.toHaveBeenCalled()
  await expect(f.ctx.waterfall('user-questions/request', f.request as never, f.next as never)).resolves.toBe('original Host fallback')
  expect(f.sink.push).not.toHaveBeenCalled()
  expect(f.next).toHaveBeenCalledOnce()
})
