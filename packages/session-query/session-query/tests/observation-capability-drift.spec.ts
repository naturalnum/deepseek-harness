import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

it.each(['false-to-true', 'true-to-false'] as const)('keeps stat cancellation unknown across %s capability drift', async (change) => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const reason = new Error('cancel'), id = SessionId(`stat-${change}`)
  let enabled = change === 'true-to-false'
  ctx.provide('sessionPersistence', {
    identity: Symbol('drifting-provider'), get statSettlesOnAbort() { return enabled },
    async stat() { entered.resolve(undefined); await release.promise; return undefined },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(reason); enabled = !enabled; release.resolve(undefined)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQueryError')
})

it('keeps stat cancellation unknown when its provider is replaced during the call', async () => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId('stat-replaced'), reason = new Error('cancel')
  const first = { identity: Symbol('first'), statSettlesOnAbort: true,
    async stat() { entered.resolve(undefined); await release.promise; return undefined } }
  const unprovide = ctx.provide('sessionPersistence', first as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal })
  void pending.catch(() => {})
  await entered.promise
  unprovide()
  ctx.provide('sessionPersistence', { ...first, identity: Symbol('replacement') } as never)
  abort.abort(reason); release.resolve(undefined)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQueryError')
})

it('keeps stat cancellation unknown without a valid provider identity', async () => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId('stat-missing-identity'), reason = new Error('cancel')
  ctx.provide('sessionPersistence', {
    statSettlesOnAbort: true,
    async stat() { entered.resolve(undefined); await release.promise; return undefined },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(reason); release.resolve(undefined)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQueryError')
})
