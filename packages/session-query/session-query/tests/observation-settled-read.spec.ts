import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

it.each(['open', 'read', 'close'] as const)('waits for %s and closes before certifying cancellation', async (stage) => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId(`settled-${stage}`), reason = new Error('cancel observation')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  let readCalls = 0, closeCalls = 0
  const wait = async () => { entered.resolve(undefined); await release.promise }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open(_id: unknown, _access: unknown, options: unknown) {
      const expectedSignal: unknown = expect.any(AbortSignal)
      expect(options).toMatchObject({ signal: expectedSignal })
      if (stage === 'open') await wait()
      return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
        async read(_offset: unknown, _length: unknown, options: unknown) {
          const expectedSignal: unknown = expect.any(AbortSignal)
          expect(options).toMatchObject({ signal: expectedSignal }); readCalls += 1
          if (stage === 'read') await wait()
          return { eventState: 'detached', events: [] }
        },
        async close() { closeCalls += 1; if (stage === 'close') await wait() },
      }
    },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none', settleCancellation: true })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await entered.promise
  abort.abort(reason)
  await Promise.resolve(); expect(settled).toBe(false)
  release.resolve(undefined)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQuerySettledReadAbortError')
  expect(readCalls).toBe(stage === 'open' ? 0 : 1)
  expect(closeCalls).toBe(1)
})

it.each(['open', 'read', 'close'] as const)('does not certify a real %s failure racing cancellation', async (stage) => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId(`failed-${stage}`), failure = new Error(`independent ${stage} failure`)
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const fail = async (): Promise<never> => { entered.resolve(undefined); await release.promise; throw failure }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() {
      if (stage === 'open') return fail()
      return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
        async read() { if (stage === 'read') return fail(); return { eventState: 'detached', events: [] } },
        async close() { if (stage === 'close') await fail() },
      }
    },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none', settleCancellation: true })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(failure); release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    cause: stage === 'close' ? { name: 'ColdSessionReadCleanupError', cause: failure } : failure })
})

it.each(['no-read-capability', 'no-stat-capability'] as const)('does not certify a provider with %s', async (missing) => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const id = SessionId(missing), reason = new Error('cancel')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  ctx.provide('sessionPersistence', {
    identity: Symbol('old-provider'), statSettlesOnAbort: missing !== 'no-stat-capability',
    readOperationsSettleOnAbort: missing !== 'no-read-capability',
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() { abort.abort(reason); throw reason },
  } as never)
  const error: unknown = await new SessionObservationReader(ctx).read(id, { signal: abort.signal, settleCancellation: true })
    .catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQueryError')
})

it('keeps normal observation cancellation without requesting settled read behavior', async () => {
  const ctx = new Context(), abort = new AbortController(), entered = Promise.withResolvers<undefined>()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const id = SessionId('default-cancellation'), reason = new Error('cancel')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open(_id: unknown, _access: unknown, options: { signal?: AbortSignal }) {
      expect(options.signal).toBe(abort.signal)
      entered.resolve(undefined)
      await new Promise<never>((_resolve, reject) => { options.signal?.addEventListener('abort', () => { reject(reason) }, { once: true }) })
    },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(reason)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQueryError')
})

it('retains both read and close failures when a certified read races cancellation', async () => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId('read-and-close-fail'), readFailure = new Error('read failed'), closeFailure = new Error('close failed')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() { return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
      async read() { entered.resolve(undefined); await release.promise; throw readFailure },
      async close() { throw closeFailure } } },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none', settleCancellation: true })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(readFailure); release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: {
    name: 'ColdSessionReadCleanupError', cause: closeFailure, errors: [readFailure, closeFailure],
  } })
})

it('preserves an aggregate open failure even when it is the abort reason', async () => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const id = SessionId('aggregate-open-failure'), closeFailure = new Error('source close failed')
  const failure = new AggregateError([closeFailure], 'open cleanup failed', { cause: closeFailure })
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() { abort.abort(failure); throw failure },
  } as never)
  await expect(new SessionObservationReader(ctx).read(id, { signal: abort.signal, settleCancellation: true }))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: failure })
})

it('does not certify an aggregate abort reason after an otherwise successful read', async () => {
  const ctx = new Context(), abort = new AbortController()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const id = SessionId('aggregate-read-reason'), reason = new AggregateError([new Error('cleanup failed')], 'cancel')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() { return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
      async read() { abort.abort(reason); return { eventState: 'detached', events: [] } }, async close() {} } },
  } as never)
  const error: unknown = await new SessionObservationReader(ctx).read(id, { signal: abort.signal, settleCancellation: true })
    .catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect((error as Error).constructor.name).toBe('SessionQueryError')
})

it('keeps the private cancellation marker out of a failed handle close', async () => {
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const id = SessionId('close-after-cooperative-cancel'), reason = new Error('public cancel'), closeFailure = new Error('close failed')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  ctx.provide('sessionPersistence', {
    identity: Symbol('settled-provider'), statSettlesOnAbort: true, readOperationsSettleOnAbort: true,
    async stat() { return { header, revision: SessionPersistenceRevision('fixture') } },
    async open() { return { id, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
      async read(_offset: unknown, _length: unknown, options: { signal: AbortSignal }) {
        entered.resolve(undefined); await release.promise; options.signal.throwIfAborted()
        return { eventState: 'detached', events: [] }
      },
      async close() { throw closeFailure },
    } },
  } as never)
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, settleCancellation: true })
  void pending.catch(() => {})
  await entered.promise
  abort.abort(reason); release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: {
    name: 'ColdSessionReadCleanupError', cause: closeFailure, errors: [closeFailure],
  } })
})
