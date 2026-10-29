import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

it.each(['stat', 'open', 'read'] as const)('retains the original abort result from an old provider during %s', async (stage) => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const id = SessionId(`old-provider-${stage}`)
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const cancellation = new Error('original cancellation')
  const cancel = (): never => { abort.abort(cancellation); throw cancellation }
  ctx.provide('sessionPersistence', {
    identity: Symbol('old-provider'),
    async stat() {
      if (stage === 'stat') return cancel()
      return { header, revision: SessionPersistenceRevision('fixture') }
    },
    async open() {
      if (stage === 'open') return cancel()
      return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
        async read() { return cancel() }, async close() {} }
    },
  } as never)
  await expect(new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none' }))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: cancellation })
})

it('retains a cleanup error even when it is also the abort reason', async () => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const closeFailure = new Error('actual provider close failed')
  const cleanup = new AggregateError([closeFailure], 'provider cleanup failed', { cause: closeFailure })
  ctx.provide('sessionPersistence', {
    identity: Symbol('fixture'),
    async stat() { abort.abort(cleanup); throw cleanup },
  } as never)
  await expect(new SessionObservationReader(ctx).read(SessionId('same-abort-error'), { signal: abort.signal }))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: cleanup })
})

it.each(['stat', 'open', 'read'] as const)('retains an independent %s failure racing abort', async (stage) => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const entered = Promise.withResolvers<undefined>()
  const ioFailure = new Error(`independent ${stage} failure`)
  const id = SessionId(`independent-${stage}`)
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const failAfterAbort = async (): Promise<never> => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve()
      else abort.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    throw ioFailure
  }
  ctx.provide('sessionPersistence', {
    identity: Symbol('fixture'),
    async stat() {
      if (stage === 'stat') return failAfterAbort()
      return { header, revision: SessionPersistenceRevision('fixture') }
    },
    async open() {
      if (stage === 'open') return failAfterAbort()
      return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
        async read() { return failAfterAbort() }, async close() {} }
    },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none' })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(new Error('distinct cancellation'))
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: ioFailure })
})

it('retains both ordinary read and close failures without cancellation', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const id = SessionId('ordinary-read-close-failure')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const readFailure = new Error('read failed'), closeFailure = new Error('close failed')
  ctx.provide('sessionPersistence', {
    identity: Symbol('fixture'),
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() {
      return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
        async read() { throw readFailure }, async close() { throw closeFailure } }
    },
  } as never)
  await expect(new SessionObservationReader(ctx).read(id, { projectionMode: 'none' }))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: {
      name: 'ColdSessionReadCleanupError', cause: closeFailure, errors: [readFailure, closeFailure],
    } })
})

it.each([false, true])('retains actual close failure after read rejection=%s', async (readRejects) => {
  const ctx = new Context(), abort = new AbortController()
  const readEntered = Promise.withResolvers<undefined>(), closeEntered = Promise.withResolvers<undefined>()
  const releaseClose = Promise.withResolvers<undefined>()
  onTestFinished(async () => { releaseClose.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId(`cold-close-${String(readRejects)}`)
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const closeFailure = new Error('actual handle close failed')
  ctx.provide('sessionPersistence', {
    identity: Symbol('fixture'),
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() {
      return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
        async read() {
          readEntered.resolve(undefined)
          await new Promise<void>((resolve) => {
            if (abort.signal.aborted) resolve()
            else abort.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
          if (readRejects) abort.signal.throwIfAborted()
          return { eventState: 'detached', events: [] }
        },
        async close() { closeEntered.resolve(undefined); await releaseClose.promise; throw closeFailure },
      }
    },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none' })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await readEntered.promise
  const cancellation = new Error('original cancellation')
  abort.abort(cancellation)
  await closeEntered.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  releaseClose.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: {
    name: 'ColdSessionReadCleanupError', cause: closeFailure,
    errors: readRejects ? [cancellation, closeFailure] : [closeFailure],
  } })
})
