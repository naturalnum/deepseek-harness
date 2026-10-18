/** One real library authentication supplies principal and bounded account metadata; no bootstrap route or graph fixture. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { Auth } from 'better-auth'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { BetterAuthAccess } from '../src/auth.ts'
import { AuthAccessError } from '../src/auth-error.ts'
import type { AccessConfig } from '../src/types.ts'

const configPath = process.env.PE_ACCESS_POSTGRES_CONFIG
const requestId = 'authenticated-account-test' as Branded<'pe-request-id'>
const cleanups: (() => Promise<void>)[] = []

function poolConfig(): pg.PoolConfig {
  if (configPath === undefined) throw new Error('Assigned access PostgreSQL configuration required')
  const input: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  if (input === null || typeof input !== 'object' || !('host' in input) || typeof input.host !== 'string'
    || !('port' in input) || typeof input.port !== 'number' || !('user' in input) || typeof input.user !== 'string'
    || !('password' in input) || typeof input.password !== 'string' || !('databases' in input)
    || input.databases === null || typeof input.databases !== 'object'
    || !('access' in input.databases) || typeof input.databases.access !== 'string') throw new Error('Invalid assigned access PG configuration')
  return { host: input.host, port: input.port, user: input.user, password: input.password, database: input.databases.access,
    max: 2, connectionTimeoutMillis: 1000, query_timeout: 2000, statement_timeout: 1500 }
}

function config(): AccessConfig {
  return {
    publicOrigin: 'http://127.0.0.1:4100', deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test-reference',
    sessionRecheckMs: 60_000, authCheckTimeoutMs: 2000, maxPeers: 2, maxPeersPerAccount: 1,
    maxPeerWaiters: 2, maxPeerWaitersPerAccount: 1, maxPeerCarriers: 2, maxPeerCarriersPerAccount: 1,
    maxPeerCarriersPerLogin: 1, peerCloseTimeoutMs: 1000,
    maxAuthOperations: 4, maxTrackedLogins: 8, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 8,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
}

async function setup(overrides: Partial<AccessConfig> = {}) {
  const pool = new pg.Pool(poolConfig())
  const sockets: Socket[] = []
  const emails: string[] = []
  const gates: (() => void)[] = []
  const lifecycle: { adapter?: BetterAuthAccess } = {}
  cleanups.push(async () => {
    for (const release of gates) release()
    for (const socket of sockets) socket.destroy()
    try {
      await lifecycle.adapter?.close()
      if (emails.length > 0) {
        await pool.query('DELETE FROM "user" WHERE "email" = ANY($1::text[])', [emails])
        const remaining = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM "user" WHERE "email" = ANY($1::text[])', [emails])
        expect(remaining.rows[0]?.count).toBe('0')
      }
    } finally { await pool.end() }
  })
  const invalidated: string[] = []
  const settings = { ...config(), ...overrides }
  const auth = await BetterAuthAccess.create(settings, pool, `projection-${randomUUID()}-${randomUUID()}`, async (id) => {
    invalidated.push(id)
  })
  lifecycle.adapter = auth
  await (await auth.planMigrations(requestId)).runMigrations()
  const library = Reflect.get(auth, 'auth') as Auth
  const request = (cookie: string): IncomingMessage => {
    const socket = new Socket()
    sockets.push(socket)
    const req = new IncomingMessage(socket)
    req.url = '/cloud/bootstrap'
    req.method = 'GET'
    req.headers = { host: '127.0.0.1:4100', cookie }
    req.rawHeaders = ['Host', '127.0.0.1:4100', 'Cookie', cookie]
    return req
  }
  const signup = async (name: string): Promise<string> => {
    const email = `projection-${randomUUID()}@access.example.test`
    emails.push(email)
    const response = await library.handler(new Request(settings.publicOrigin + '/cloud/auth/sign-up/email', {
      method: 'POST', headers: { origin: settings.publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: `test-${randomUUID()}-Password1!`, name }),
    }))
    expect(response.status).toBe(200)
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  }
  const holdNextRead = () => {
    const captured = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    gates.push(() => { gate.resolve(undefined) })
    const real = library.api.getSession.bind(library.api)
    const spy = vi.spyOn(library.api, 'getSession').mockImplementationOnce(async (input) => {
      const actual = await real(input)
      captured.resolve(undefined)
      await gate.promise
      return actual
    })
    return { captured: captured.promise, release: () => { gate.resolve(undefined) }, spy }
  }
  return { auth, pool, library, invalidated, request, signup, holdNextRead }
}

function safeFailure(error: unknown): AuthAccessError {
  if (!(error instanceof AuthAccessError)) throw new Error('Expected the existing safe authentication failure')
  return error
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

describe.skipIf(configPath === undefined)('real authenticated account projection', () => {
  it('projects the one real DB login, pins its original cookie and keeps the existing principal fields', async () => {
    const fixture = await setup()
    const cookieA = await fixture.signup('Verified display A')
    const cookieB = await fixture.signup('Verified display B')
    const req = fixture.request(cookieA)
    req.method = 'POST'
    req.headers['x-display-name'] = 'Forged header display'
    req.push(JSON.stringify({ name: 'Forged body display', accountId: 'forged-client-id' }))
    req.push(null)
    const getSession = vi.spyOn(fixture.library.api, 'getSession')
    const result = await fixture.auth.authenticateForBootstrap(req, requestId, 64)
    expect(getSession).toHaveBeenCalledOnce()
    expect(getSession.mock.calls[0]?.[0]?.headers).toBeInstanceOf(Headers)
    expect(getSession.mock.calls[0]?.[0]?.query).toEqual({ disableCookieCache: true, disableRefresh: true })
    expect(result.account).toEqual({ id: result.principal.accountId, displayName: 'Verified display A' })
    expect(Object.keys(result.principal)).toEqual(['accountId', 'authSessionId'])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.account)).toBe(true)
    expect(Object.isFrozen(result.principal)).toBe(true)
    expect(Reflect.set(result.account, 'displayName', 'changed')).toBe(false)
    fixture.auth.assertLoginCurrent(result.principal, requestId)
    req.headers.cookie = cookieB
    await fixture.auth.recheckLogin(result.principal, requestId)
    fixture.auth.assertLoginCurrent(result.principal, requestId)
    expect(result.account.displayName).toBe('Verified display A')
    const b = await fixture.auth.authenticateForBootstrap(fixture.request(cookieB), requestId, 64)
    expect(b.account.displayName).toBe('Verified display B')
    expect(b.account.id).not.toBe(result.account.id)
  })

  it('reads a changed name only on new authentication, preserving prior snapshots and legacy authenticate', async () => {
    const fixture = await setup()
    const cookie = await fixture.signup('Before rename')
    const before = await fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 64)
    await fixture.pool.query('UPDATE "user" SET "name" = $1 WHERE "id" = $2', ['After rename', before.principal.accountId])
    const getSession = vi.spyOn(fixture.library.api, 'getSession')
    const after = await fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 64)
    expect(getSession).toHaveBeenCalledOnce()
    expect(after.account.displayName).toBe('After rename')
    expect(before.account.displayName).toBe('Before rename')
    getSession.mockClear()
    const legacy = await fixture.auth.authenticate(fixture.request(cookie), requestId)
    expect(getSession).toHaveBeenCalledOnce()
    expect(legacy).toEqual({ accountId: before.principal.accountId, authSessionId: before.principal.authSessionId })
    expect(Object.keys(legacy)).toEqual(['accountId', 'authSessionId'])
    fixture.auth.assertLoginCurrent(legacy, requestId)
  })

  it('accepts the exact multibyte limit and denies UTF-8 or character excess without revoking the login', async () => {
    const fixture = await setup()
    const cookie = await fixture.signup('界界')
    const exact = await fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 6)
    expect(exact.account.displayName).toBe('界界')
    for (const limit of [5, 1]) {
      const error = await fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, limit).then(
        () => { throw new Error('Expected bounded projection denial') }, safeFailure,
      )
      expect(error.toJSON()).toMatchObject({ code: 'cloud/capacity', requestId, retry: 'after-status-check' })
      expect(JSON.stringify(error.toJSON())).not.toContain('界界')
      expect(JSON.stringify(error.toJSON())).not.toContain(exact.principal.accountId)
    }
    expect(fixture.invalidated).toEqual([])
    const legacy = await fixture.auth.authenticate(fixture.request(cookie), requestId)
    fixture.auth.assertLoginCurrent(legacy, requestId)
  })

  it('rejects revoked and expired real sessions without returning account metadata', async () => {
    const fixture = await setup()
    const cookie = await fixture.signup('Revoked display')
    const result = await fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 64)
    await fixture.auth.revokeLogin(result.principal.authSessionId, requestId)
    await expect(fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 64))
      .rejects.toMatchObject({ code: 'cloud/unauthenticated', status: 401 })
    expect(() => { fixture.auth.assertLoginCurrent(result.principal, requestId) }).toThrow()
    const expiring = await fixture.signup('Expiring display')
    const active = await fixture.auth.authenticate(fixture.request(expiring), requestId)
    await fixture.pool.query('UPDATE "session" SET "expiresAt" = $1 WHERE "id" = $2', [new Date(Date.now() - 1000), active.authSessionId])
    await expect(fixture.auth.authenticateForBootstrap(fixture.request(expiring), requestId, 64))
      .rejects.toMatchObject({ code: 'cloud/unauthenticated', status: 401 })
  })

  it('does not publish an older real account read after a concurrent database revocation', async () => {
    const fixture = await setup()
    const cookie = await fixture.signup('Delayed revoked display')
    const principal = await fixture.auth.authenticate(fixture.request(cookie), requestId)
    const held = fixture.holdNextRead()
    const late = fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 64).then(
      value => ({ kind: 'resolved', value }), (error: unknown) => ({ kind: 'rejected', error }),
    )
    await held.captured
    await fixture.auth.revokeLogin(principal.authSessionId, requestId)
    held.release()
    const result = await late
    expect(result.kind).toBe('rejected')
    if (!('error' in result)) throw new Error('Revoked projection unexpectedly published')
    expect(safeFailure(result.error).code).toBe('cloud/unauthenticated')
    expect(held.spy).toHaveBeenCalledOnce()
    expect(fixture.auth.pendingOperations).toBe(0)
  })

  it('retains the actual query slot after timeout until the real library read settles', async () => {
    const fixture = await setup({ authCheckTimeoutMs: 100, maxAuthOperations: 1 })
    const cookie = await fixture.signup('Delayed valid display')
    const held = fixture.holdNextRead()
    const result = fixture.auth.authenticateForBootstrap(fixture.request(cookie), requestId, 64)
    await held.captured
    await expect(result).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
    expect(fixture.auth.pendingOperations).toBe(1)
    await expect(fixture.auth.authenticate(fixture.request(cookie), requestId)).rejects.toMatchObject({ code: 'cloud/capacity', status: 429 })
    held.release()
    await vi.waitFor(() => { expect(fixture.auth.pendingOperations).toBe(0) })
    expect(held.spy).toHaveBeenCalledOnce()
  })
})
