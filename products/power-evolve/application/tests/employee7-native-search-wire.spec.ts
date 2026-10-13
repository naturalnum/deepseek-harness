/** Real Host search admission, error translation and HTTP disconnects; Platform search and budget outcomes are substitutes, not PG. */
import { expect, test } from 'vitest'
import { nativeHost, nativePost } from './employee7-native-wire-fixture.ts'

for (const boundary of [
  { name: 'empty query', query: '' },
  { name: 'whitespace-only query', query: ' \t\n\u2003' },
  { name: 'embedded NUL', query: 'before\0after' },
  { name: '501 UTF-16 units', query: '😀'.repeat(250) + 'x' },
]) {
  test(`native search refuses ${boundary.name} without sending a Platform search`, () => nativeHost(async (fixture) => {
    const response = await nativePost(fixture, 'session/search', { request: { query: boundary.query } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ type: 'server-response', rpcId: 'employee7-native-wire',
      result: { ok: false, error: { code: 'gateway/bad-request' } } })
    expect(fixture.platform.calls).toEqual([{ path: '/identity/me', token: fixture.token, input: {} }])
  }))
}

test('native search accepts exactly 500 UTF-16 units and returns the actual Platform substitute result', () =>
  nativeHost(async (fixture) => {
    const query = '😀'.repeat(250)
    expect(query.length).toBe(500)
    const response = await nativePost(fixture, 'session/search', { request: { query } },
      { cookie: true, rpcId: 'employee7-search-500' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'employee7-search-500',
      result: { ok: true, value: fixture.platform.searchValue } })
    expect(fixture.platform.calls).toEqual([
      { path: '/identity/me', token: fixture.token, input: {} },
      { path: '/native/sessions/search', token: fixture.token, input: { query } },
    ])
  }))

test('native search trims visible input and refuses unknown request parameters instead of swallowing them', () =>
  nativeHost(async (fixture) => {
    const response = await nativePost(fixture, 'session/search', { request: { query: ' \t100%_\\literal\n ' } })
    expect(await response.json()).toMatchObject({ result: { ok: true, value: fixture.platform.searchValue } })
    expect(fixture.platform.calls.at(-1)).toEqual({ path: '/native/sessions/search', token: fixture.token,
      input: { query: '100%_\\literal' } })
    const before = structuredClone(fixture.platform.calls)
    const unknown = await nativePost(fixture, 'session/search', { request: { query: 'visible', limit: 1 } })
    expect(await unknown.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/bad-request' } } })
    expect(fixture.platform.calls.slice(0, before.length)).toEqual(before)
    expect(fixture.platform.calls.slice(before.length)).toEqual([{ path: '/identity/me', token: fixture.token, input: {} }])
  }))

for (const denial of [
  { name: 'budget exhaustion', status: 503, code: 'native_search_budget_exceeded', remote: 'gateway/service-unavailable' },
  { name: 'deadline expiry', status: 504, code: 'native_search_timeout', remote: 'gateway/service-unavailable' },
  { name: 'caller cancellation', status: 499, code: 'native_search_cancelled', remote: 'gateway/cancelled' },
]) {
  test(`native search maps substituted Platform ${denial.name} to a failed native result`, () => nativeHost(async (fixture) => {
    fixture.platform.searchDenial = { status: denial.status, code: denial.code }
    const response = await nativePost(fixture, 'session/search', { request: { query: 'visible' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ type: 'server-response', result: { ok: false,
      error: { code: denial.remote, details: denial.remote === 'gateway/cancelled' ? {} : { reason: denial.code } } } })
    expect(fixture.platform.calls).toEqual([
      { path: '/identity/me', token: fixture.token, input: {} },
      { path: '/native/sessions/search', token: fixture.token, input: { query: 'visible' } },
    ])
  }))
}

test('disconnecting native search cancels its real RuntimeScope fetch before the configured timeout', () =>
  nativeHost(async (fixture) => {
    fixture.platform.holdSearch = true
    const disconnected = new AbortController()
    const pending = nativePost(fixture, 'session/search', { request: { query: 'held visible query' } },
      { signal: disconnected.signal }).then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
    try {
      await expect.poll(() => fixture.platform.calls.some(call => call.path === '/native/sessions/search'),
        { timeout: 2000, interval: 10 }).toBe(true)
      expect(fixture.platform.searchDisconnected).toBe(false)
      disconnected.abort()
      expect(await pending).toMatchObject({ ok: false, error: { name: 'AbortError' } })
      // The substitute sends no headers or response. Only closing the upstream HTTP connection sets this flag.
      await expect.poll(() => fixture.platform.searchDisconnected, { timeout: 2000, interval: 10 }).toBe(true)
      expect(fixture.platform.calls.filter(call => call.path === '/native/sessions/search')).toEqual([
        { path: '/native/sessions/search', token: fixture.token, input: { query: 'held visible query' } },
      ])
    } finally {
      disconnected.abort()
      await pending
    }
  }))
