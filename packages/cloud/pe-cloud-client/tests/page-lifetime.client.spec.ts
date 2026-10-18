/** Revocation precedes actual native and carrier teardown; no cleanup on an unknown join. */
import { expect, it, vi } from 'vitest'
import { CloudPageLifetime } from '../src/client/page-lifetime.ts'

function fixture(fetcher = vi.fn(async () => new Response(null, { status: 204 }))) {
  const data = new Map<string, string>(), events: string[] = []
  const page = new CloudPageLifetime({
    expectation: { accountId: 'A', connectionGeneration: 'G1' },
    storage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
      removeItem: (key) => { events.push('clear'); data.delete(key) },
    },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 100, maxValueBytes: 1000, maxTotalBytes: 5000, maxNamespaceBytes: 200 },
    transport: {
      baseUrl: 'https://example.test/app/',
      fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
      fetch: fetcher, createWebSocket: () => { throw new Error('no sockets in this fixture') },
      limits: { maxPendingFetches: 2, maxSockets: 1, maxErrorResponseBytes: 100, closeTimeoutMs: 100 },
    },
  })
  return { page, data, events }
}

it('requires the supplied native persistence before startup and joins real native cleanup before clear', async () => {
  const { page, data, events } = fixture()
  const stopped = Promise.withResolvers<undefined>()
  const entry = {
    run: vi.fn(async () => { page.nativeOptions.persistence.setItem('draft', 'A') }),
    dispose: vi.fn(() => {
      events.push('stop')
      expect(() => { page.nativeOptions.persistence.setItem('draft', 'late') }).toThrow()
      return stopped.promise
    }),
  }
  expect(page.nativeOptions.requirePersistence).toBe(true)
  await page.start(entry)
  const closing = page.dispose()
  expect(page.dispose()).toBe(closing)
  expect(events).toEqual(['stop'])
  expect(data.size).toBe(1)
  stopped.resolve(undefined)
  await closing
  expect(events).toEqual(['stop', 'clear'])
  expect(data.size).toBe(0)
  expect(page.getSnapshot().phase).toBe('stopped')
  await expect(page.start(entry)).rejects.toThrow()
})

it.each([401, 409])('HTTP %s invalidation revokes before abort and disposes the same native page', async (status) => {
  const { page } = fixture(vi.fn(async () => status === 401
    ? new Response(null, { status }) : Response.json({ code: 'cloud/stale-generation' }, { status })))
  const stopped = Promise.withResolvers<undefined>()
  const dispose = vi.fn(() => stopped.promise)
  await page.start({ run: async () => {}, dispose })
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(page.transport.hooks.fetch!('api', {})).rejects.toThrow()
    expect(dispose).toHaveBeenCalledOnce()
    expect(page.persistence.getSnapshot().phase).toBe('revoked')
    stopped.resolve(undefined)
    await page.dispose()
    expect(page.persistence.getSnapshot().cleanup).toBe('confirmed')
  } finally { reported.mockRestore() }
})

it('retains the namespace and unconfirmed disposition after native cleanup fails', async () => {
  const { page, data, events } = fixture()
  await page.start({
    run: async () => { page.nativeOptions.persistence.setItem('draft', 'A') },
    dispose: async () => { throw new Error('native cleanup failed') },
  })
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  try { await expect(page.dispose()).rejects.toThrow('Cloud page stop unconfirmed') } finally { reported.mockRestore() }
  expect(data.size).toBe(1)
  expect(events).toEqual([])
  expect(page.getSnapshot().phase).toBe('unconfirmed')
  expect(page.persistence.getSnapshot().cleanup).toBe('not-requested')
})

it('seals and stops dependent native UI after persistence quota failure', async () => {
  const { page } = fixture()
  const stopped = Promise.withResolvers<undefined>()
  const dispose = vi.fn(() => stopped.promise)
  await page.start({ run: async () => {}, dispose })
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(() => { page.nativeOptions.persistence.setItem('draft', 'a'.repeat(1001)) }).toThrow()
    expect(dispose).toHaveBeenCalledOnce()
    stopped.resolve(undefined)
    await page.dispose()
  } finally { reported.mockRestore() }
})
