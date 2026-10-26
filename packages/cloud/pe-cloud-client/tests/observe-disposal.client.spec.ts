/** Retired Cordis disposers keep invocation observation separate from native owner cleanup. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { observeCloudDisposal } from '../src/client/observe-disposal.ts'
import { CloudPageLifetime } from '../src/client/page-lifetime.ts'

function pageFixture() {
  const data = new Map<string, string>()
  const page = new CloudPageLifetime({
    expectation: { accountId: 'fixture-A', connectionGeneration: 'fixture-G1' },
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) },
      removeItem: (key) => { data.delete(key) } },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 100, maxValueBytes: 1000, maxTotalBytes: 5000, maxNamespaceBytes: 200 },
    transport: { baseUrl: 'https://example.test/app/',
      fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
      fetch: async () => new Response(null, { status: 204 }), createWebSocket: () => { throw new Error('unused socket') },
      limits: { maxPendingFetches: 2, maxSockets: 1, maxErrorResponseBytes: 100, closeTimeoutMs: 100 } },
  })
  return { page, data }
}

it('invokes the original disposer synchronously and waits for its returned work', async () => {
  const done = Promise.withResolvers<undefined>(), events: string[] = []
  const work = observeCloudDisposal(() => { events.push('withdraw'); return done.promise })
  events.push('returned')
  expect(events).toEqual(['withdraw', 'returned'])
  let settled = false
  void work.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  done.resolve(undefined); await work
  expect(settled).toBe(true)
})

it('observes synchronous disposal failure without changing its cause', async () => {
  const failure = new Error('fixture synchronous disposal failure')
  const work = observeCloudDisposal(() => { throw failure })
  await expect(work).rejects.toBe(failure)
})

it('observes asynchronous disposal failure without changing its cause', async () => {
  const failure = new Error('fixture asynchronous disposal failure')
  await expect(observeCloudDisposal(() => Promise.reject(failure))).rejects.toBe(failure)
})

it('accepts the actual retired Cordis Fiber disposer return', async () => {
  const ctx = new Context(), dependency = ctx.inject([], () => {})
  await dependency
  await dependency.dispose()
  expect(dependency.dispose()).toBeUndefined()
  expect(() => dependency.dispose().catch(() => {})).toThrow(TypeError)
  await expect(observeCloudDisposal(dependency.dispose)).resolves.toBeUndefined()
  await ctx.fiber.dispose()
})

it('keeps page cleanup pending on the native owner after the dependency already retired', async () => {
  const ctx = new Context(), done = Promise.withResolvers<undefined>()
  const dependency = ctx.inject([], (owner) => { owner.effect(() => () => done.promise) })
  await dependency
  const nativeStopping = dependency.dispose()
  const { page, data } = pageFixture(), reported = vi.fn()
  await page.start({ run: async () => { page.nativeOptions.persistence.setItem('draft', 'fixture-data') }, dispose: () => nativeStopping })
  page.transport.signal.addEventListener('abort', () => { void observeCloudDisposal(dependency.dispose).catch(reported) }, { once: true })
  const closing = page.dispose()
  await Promise.resolve()
  expect(reported).not.toHaveBeenCalled()
  expect(page.getSnapshot().phase).toBe('stopping')
  expect(page.persistence.getSnapshot()).toMatchObject({ phase: 'revoked', cleanup: 'not-requested' })
  expect(() => { page.nativeOptions.persistence.setItem('draft', 'late') }).toThrow()
  expect(data.size).toBe(1)
  done.resolve(undefined); await closing
  expect(page.getSnapshot().phase).toBe('stopped')
  expect(page.persistence.getSnapshot().cleanup).toBe('confirmed')
  expect(data.size).toBe(0)
  await ctx.fiber.dispose()
})

it('leaves actual native cleanup failure and the captured namespace unconfirmed', async () => {
  const { page, data } = pageFixture(), failure = new Error('fixture native cleanup failure')
  const original = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await page.start({ run: async () => { page.nativeOptions.persistence.setItem('draft', 'fixture-data') },
      dispose: () => observeCloudDisposal(() => Promise.reject(failure)) })
    await expect(page.dispose()).rejects.toThrow('Cloud page stop unconfirmed')
    expect(page.getSnapshot().phase).toBe('unconfirmed')
    expect(page.persistence.getSnapshot().cleanup).toBe('not-requested')
    expect(data.size).toBe(1)
  } finally { original.mockRestore() }
})
