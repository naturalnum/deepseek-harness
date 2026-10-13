/** Real HTTP and isolated PG verify browser exchange, replica admission and revocation. */
import { createServer, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { BrowserAgentAuth, type AgentVerifier } from '../src/host/browser-auth.ts'
import { sendFailure, sendJson } from '../src/http.ts'
import { digest, type IdentityService } from '../src/platform/identity.ts'
import { cloudFixture } from './cloud-fixture.ts'

const platformOrigin = 'https://platform.example.test'

async function host(identities: IdentityService, configuredOrigin?: string) {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address: AddressInfo | string | null = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
  const origin = `http://127.0.0.1:${address.port}`
  const verifier: AgentVerifier = {
    async call(path, token) {
      if (path === '/identity/exchange') return { token: await identities.exchange(token) }
      if (path === '/identity/me') return identities.authenticate(token)
      throw new Error('Unexpected verifier method')
    },
  }
  const auth = new BrowserAgentAuth(configuredOrigin ?? origin, platformOrigin, verifier)
  server.on('request', (request, response) => {
    void (async () => {
      if (request.url === '/exchange') await auth.exchange(request, response)
      else if (request.url === '/clear') { auth.clear(response); sendJson(response, { ok: true }) }
      else {
        const admitted = await auth.authenticate(request, request.url === '/native/api/navigation')
        sendJson(response, { fromCookie: admitted.fromCookie, user: admitted.user })
      }
    })().catch((error: unknown) => { sendFailure(response, error) })
  })
  return { origin, async close() { server.close(); await once(server, 'close') } }
}

async function replicas<T>(identities: IdentityService, run: (a: Awaited<ReturnType<typeof host>>,
  b: Awaited<ReturnType<typeof host>>) => Promise<T>): Promise<T> {
  const a = await host(identities)
  try {
    const b = await host(identities)
    try { return await run(a, b) } finally { await b.close() }
  } finally { await a.close() }
}

function exchange(origin: string, token: string): Promise<Response> {
  return fetch(`${origin}/exchange`, { method: 'POST', headers: { origin: platformOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ token }) })
}

function credential(response: Response): string {
  const cookies = response.headers.getSetCookie()
  expect(cookies).toHaveLength(2)
  const cookie = cookies[0]
  if (cookie === undefined) throw new Error('Expected scoped cookie')
  const pair = cookie.split(';')[0]
  if (pair === undefined) throw new Error('Expected credential pair')
  return pair
}

test('exchange consumes the original Agent token and both replicas admit its replacement at the original expiry', () =>
  cloudFixture(async ({ identities, pool, alice }) => replicas(identities, async (a, b) => {
    const before = await pool.query<{ expires_at: Date }>('SELECT expires_at FROM pe_credentials WHERE digest=$1', [digest(alice.token)])
    const exchanged = await exchange(a.origin, alice.token)
    expect(exchanged.status).toBe(200)
    expect(await exchanged.json()).toEqual({ ok: true })
    expect(exchanged.headers.get('access-control-allow-origin')).toBe(platformOrigin)
    expect(exchanged.headers.get('access-control-allow-credentials')).toBe('true')
    const cookies = exchanged.headers.getSetCookie()
    expect(cookies.some(value => value.includes('Path=/native/api; HttpOnly; SameSite=Strict'))).toBe(true)
    expect(cookies.some(value => value.includes('Path=/api/powerEvolve; HttpOnly; SameSite=Strict'))).toBe(true)
    expect(cookies.every(value => !value.includes('Secure'))).toBe(true)
    const cookie = credential(exchanged), replacement = cookie.slice('pe_agent='.length)
    await expect(identities.authenticate(alice.token)).rejects.toMatchObject({ status: 401 })
    const after = await pool.query<{ expires_at: Date }>('SELECT expires_at FROM pe_credentials WHERE digest=$1', [digest(replacement)])
    expect(after.rows).toEqual(before.rows)
    for (const instance of [a, b]) {
      const admitted = await fetch(`${instance.origin}/native/api/identity`, { headers: { origin: instance.origin, cookie } })
      expect(admitted.status).toBe(200)
      expect(await admitted.json()).toMatchObject({ fromCookie: true, user: alice.user })
    }
  })))

test('concurrent exchanges on separate Hosts consume one credential once', () => cloudFixture(async ({ identities, pool, alice }) =>
  replicas(identities, async (a, b) => {
    const responses = await Promise.all([exchange(a.origin, alice.token), exchange(b.origin, alice.token)])
    expect(responses.map(response => response.status).sort((left, right) => left - right)).toEqual([200, 401])
    for (const response of responses) await response.arrayBuffer()
    const original = await pool.query('SELECT digest FROM pe_credentials WHERE digest=$1', [digest(alice.token)])
    expect(original.rows).toEqual([])
    const credentials = await pool.query('SELECT digest FROM pe_credentials WHERE user_id=$1', [alice.user.userId])
    expect(credentials.rows).toHaveLength(1)
  })))

test('duplicate cookies and mixed cookie/bearer requests reject before admitting either credential', () =>
  cloudFixture(async ({ identities, alice, bob }) => replicas(identities, async (a) => {
    const cookie = `pe_agent=${alice.token}`
    const cases = [
      { cookie: `${cookie}; ${cookie}` },
      { cookie: `${cookie}; pe_agent=${bob.token}` },
      { cookie, authorization: `Bearer ${bob.token}` },
    ]
    for (const headers of cases) {
      const response = await fetch(`${a.origin}/native/api/identity`, { headers: { origin: a.origin, ...headers } })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: 'ambiguous_credential' })
    }
    const bearer = await fetch(`${a.origin}/native/api/identity`, { headers: { authorization: `Bearer ${bob.token}` } })
    expect(await bearer.json()).toMatchObject({ fromCookie: false, user: bob.user })
    const foreign = await fetch(`${a.origin}/native/api/identity`, { headers: { authorization: `Bearer ${bob.token}`, origin: platformOrigin } })
    expect(foreign.status).toBe(403)
    await foreign.arrayBuffer()
  })))

test('cookies remain path-scoped and require a same-origin request or explicitly safe navigation', () =>
  cloudFixture(async ({ identities, alice }) => replicas(identities, async (a) => {
    const cookie = `other=value; pe_agent=${alice.token}`
    for (const site of ['same-origin', 'none']) {
      const response = await fetch(`${a.origin}/native/api/navigation`, { headers: { cookie, 'sec-fetch-site': site } })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    const cases = [
      { path: '/native/api/navigation', headers: { cookie, 'sec-fetch-site': 'cross-site' }, status: 403 },
      { path: '/native/api/identity', headers: { cookie }, status: 403 },
      { path: '/native/api/identity', headers: { origin: a.origin }, status: 401 },
      { path: '/native/api/identity', headers: { cookie: 'pe_agent=short', origin: a.origin }, status: 401 },
      { path: '/native/api-extra', headers: { cookie, origin: a.origin }, status: 401 },
      { path: '/unrelated', headers: { cookie, origin: a.origin }, status: 401 },
    ]
    for (const item of cases) {
      const response = await fetch(a.origin + item.path, { headers: item.headers })
      expect(response.status).toBe(item.status)
      await response.arrayBuffer()
    }
  })))

test('invalid exchange origin, preflight, method and JSON never consume the Agent credential', () =>
  cloudFixture(async ({ identities, pool, alice }) => replicas(identities, async (a) => {
    const valid = { origin: platformOrigin, 'content-type': 'application/json' }
    const preflight = await fetch(`${a.origin}/exchange`, { method: 'OPTIONS', headers: { origin: platformOrigin,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')
    const cases = [
      { method: 'POST', headers: { ...valid, origin: a.origin }, body: '{}', status: 403 },
      { method: 'OPTIONS', headers: { origin: platformOrigin, 'access-control-request-method': 'GET' }, status: 403 },
      { method: 'GET', headers: valid, status: 405 },
      { method: 'POST', headers: { ...valid, 'content-type': 'text/plain' }, body: '{}', status: 415 },
      { method: 'POST', headers: { origin: platformOrigin }, status: 415 },
      { method: 'POST', headers: valid, body: JSON.stringify({ token: alice.token, extra: true }), status: 400 },
      { method: 'POST', headers: valid, body: JSON.stringify({ token: 'short' }), status: 400 },
    ]
    for (const item of cases) {
      const response = await fetch(`${a.origin}/exchange`, item)
      expect(response.status).toBe(item.status)
      expect(response.headers.getSetCookie()).toEqual([])
      await response.arrayBuffer()
    }
    expect((await pool.query('SELECT digest FROM pe_credentials WHERE digest=$1', [digest(alice.token)])).rows).toHaveLength(1)
  })))

test('configured HTTPS origins issue Secure cookies and invalid deployment origins reject at construction', () =>
  cloudFixture(async ({ identities, alice }) => {
    const a = await host(identities, 'https://host.example.test')
    try {
      const exchanged = await exchange(a.origin, alice.token)
      expect(exchanged.status).toBe(200)
      expect(exchanged.headers.getSetCookie().every(cookie => cookie.endsWith('; Secure'))).toBe(true)
      await exchanged.arrayBuffer()
      const clear = await fetch(`${a.origin}/clear`)
      expect(clear.headers.getSetCookie().every(cookie => cookie.includes('; Secure; Max-Age=0'))).toBe(true)
      await clear.arrayBuffer()
    } finally { await a.close() }
    const verifier: AgentVerifier = { call: () => Promise.reject(new Error('Configuration must not call Platform')) }
    for (const invalid of ['http://remote.example.test', 'ftp://localhost', 'https://host.example.test/path',
      'https://user:secret@host.example.test']) {
      expect(() => new BrowserAgentAuth(invalid, platformOrigin, verifier)).toThrow()
    }
    expect(() => new BrowserAgentAuth('http://localhost', `${platformOrigin}/path`, verifier)).toThrow()
  }))

test('an IncomingMessage without a URL cannot admit a scoped browser cookie', async () => {
  const verifier: AgentVerifier = { call: () => Promise.reject(new Error('No credential may reach Platform')) }
  const auth = new BrowserAgentAuth('http://localhost', platformOrigin, verifier)
  const socket = new Socket(), request = new IncomingMessage(socket)
  delete request.url
  request.headers = { origin: 'http://localhost', cookie: `pe_agent=${'fixture'.repeat(8)}` }
  try { await expect(auth.authenticate(request)).rejects.toMatchObject({ status: 401, code: 'unauthorized' }) }
  finally { request.destroy(); socket.destroy() }
})

test('revocation at Platform is observed by both Hosts and clear removes both browser cookie paths', () =>
  cloudFixture(async ({ identities, alice }) => replicas(identities, async (a, b) => {
    await identities.logout(alice.token)
    for (const instance of [a, b]) {
      const response = await fetch(`${instance.origin}/native/api/identity`, { headers: { origin: instance.origin, cookie: `pe_agent=${alice.token}` } })
      expect(response.status).toBe(401)
      await response.arrayBuffer()
    }
    const clear = await fetch(`${a.origin}/clear`)
    expect(clear.headers.getSetCookie()).toEqual([
      'pe_agent=; Path=/native/api; HttpOnly; SameSite=Strict; Max-Age=0',
      'pe_agent=; Path=/api/powerEvolve; HttpOnly; SameSite=Strict; Max-Age=0',
    ])
    await clear.arrayBuffer()
  })))
