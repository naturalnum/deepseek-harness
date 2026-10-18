import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { BetterAuthAccess } from '../src/auth.ts'
import type { AccessConfig, AuthenticatedPrincipal } from '../src/types.ts'
import type { Auth, BetterAuthOptions } from 'better-auth'
import { AuthAccessError } from '../src/auth-error.ts'
import { carrier } from './ingress-fixture.ts'

const requestId = 'server-auth-test' as Branded<'pe-request-id'>
const adapters: BetterAuthAccess[] = []
const pools: pg.Pool[] = []
const sockets: Socket[] = []

function config(): AccessConfig {
  return {
    publicOrigin: 'http://127.0.0.1:4100', deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test-reference',
    sessionRecheckMs: 50, authCheckTimeoutMs: 500, maxPeers: 4, maxPeersPerAccount: 2,
    maxPeerWaiters: 32, maxPeerWaitersPerAccount: 24, maxPeerCarriers: 16, maxPeerCarriersPerAccount: 8,
    maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 500,
    maxAuthOperations: 8, maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 8,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
}

function request(extra: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket()
  sockets.push(socket)
  const req = new IncomingMessage(socket)
  req.method = 'GET'
  req.url = '/api/session/list'
  req.headers = { host: '127.0.0.1:4100', ...extra }
  req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)])
  return req
}

async function create(): Promise<{ adapter: BetterAuthAccess; invalidate: ReturnType<typeof vi.fn> }> {
  // Port 1 is deliberately unavailable; no successful login or fake database principal is supplied.
  const pool = new pg.Pool({ connectionString: 'postgresql://test:test@127.0.0.1:1/unavailable', max: 1, connectionTimeoutMillis: 50, query_timeout: 50 })
  pools.push(pool)
  const invalidate = vi.fn(async (): Promise<void> => {})
  const adapter = await BetterAuthAccess.create(config(), pool, 'integration-test-secret-with-thirty-two-characters-12345', invalidate)
  adapters.push(adapter)
  return { adapter, invalidate }
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()))
  await Promise.all(pools.splice(0).map(pool => pool.end()))
  for (const socket of sockets.splice(0)) socket.destroy()
})

describe('pinned Better Auth/PostgreSQL adapter denial paths', () => {
  it.each(['/cloud/auth/sign-in/email', '/cloud/auth/sign-up/email/'])(
    'does not enter the library mutation at %s when the original Cookie lookup is unavailable', async (path) => {
      const { adapter } = await create()
      const native = Reflect.get(adapter, 'auth') as Auth
      const session = vi.spyOn(native.api, 'getSession')
      const mutate = vi.spyOn(native, 'handler')
      const { request, response, socket } = carrier(path, 'POST', ['Content-Type', 'application/json', 'Content-Length', '2'])
      request.push(Buffer.from('{}'))
      request.push(null)
      try {
        await adapter.handleNodeRequest(request, response, requestId, { maxBodyBytes: 128, signal: new AbortController().signal })
        expect(response.statusCode).toBe(503)
        expect(session).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true, disableRefresh: true } }))
        expect(mutate).not.toHaveBeenCalled()
        expect(response.getHeader('set-cookie')).toBeUndefined()
      } finally { request.destroy(); response.destroy(); socket.destroy() }
    })

  it('reports sign-out-required with a typed status/code and never suggests a retry', () => {
    const failure = new AuthAccessError('cloud/login-active', requestId)
    expect({ status: failure.status, body: failure.toJSON() }).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "cloud/login-active",
          "message": "Sign out before starting another login in this browser.",
          "requestId": "server-auth-test",
          "retry": "never",
        },
        "status": 409,
      }
    `)
  })

  it('passes explicit disableSignUp to the original pinned library while omission preserves compatibility', async () => {
    const { adapter } = await create()
    const initial = Reflect.get(adapter, 'options') as BetterAuthOptions
    expect(initial.emailAndPassword).toEqual({ enabled: true, disableSignUp: false })
    const pool = new pg.Pool({ host: '127.0.0.1', port: 1, max: 1, connectionTimeoutMillis: 30 })
    pools.push(pool)
    const closed = await BetterAuthAccess.create({ ...config(), disableSignUp: true }, pool,
      'integration-test-secret-with-thirty-two-characters-12345', async () => {})
    adapters.push(closed)
    const configured = Reflect.get(closed, 'options') as BetterAuthOptions
    expect(configured.emailAndPassword).toEqual({ enabled: true, disableSignUp: true })
  })
  it('joins the actual Better Auth Node response before releasing a failed PostgreSQL authentication request', async () => {
    const { adapter } = await create()
    const { request, response, socket } = carrier('/cloud/auth/get-session')
    try {
      await adapter.handleNodeRequest(request, response, requestId, { maxBodyBytes: 128, signal: new AbortController().signal })
      expect(response.writableFinished).toBe(true)
      expect(response.statusCode).toBe(503)
      expect(Buffer.concat(socket.output).toString('utf8')).toContain('cloud/account-unavailable')
      expect(adapter.pendingOperations).toBe(0)
    } finally { request.destroy(); response.destroy(); socket.destroy() }
  })

  it('does not turn client account claims into a principal when PostgreSQL is unavailable', async () => {
    const { adapter } = await create()
    await expect(adapter.authenticate(request({ 'x-pe-account': 'forged-account' }), requestId)).rejects.toMatchObject({
      code: 'cloud/account-unavailable', status: 503,
    })
    await expect(adapter.authenticate(request({ cookie: 'better-auth.session_token=invalid.signature' }), requestId)).rejects.toMatchObject({
      code: 'cloud/account-unavailable', status: 503,
    })
    expect(adapter.pendingOperations).toBe(0)
  })

  it('rejects Host/Origin/forwarded-header spoofing before authentication', async () => {
    const { adapter } = await create()
    for (const headers of [{ host: 'other.example' }, { origin: 'https://other.example' }, { 'x-forwarded-host': '127.0.0.1:4100' }]) {
      expect(() => adapter.authenticate(request(headers), requestId)).toThrow(expect.objectContaining({ code: 'cloud/forbidden', status: 403 }))
    }
  })

  it('does not accept a client-constructed principal for a login recheck', async () => {
    const { adapter } = await create()
    const forged: AuthenticatedPrincipal = {
      accountId: 'forged-account' as AccountId, authSessionId: 'forged-session' as Branded<'pe-auth-session-id'>,
    }
    await expect(adapter.recheckLogin(forged, requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated', status: 401 })
    expect(() => { adapter.assertLoginCurrent(forged, requestId) }).toThrow(expect.objectContaining({ code: 'cloud/unauthenticated' }))
  })

  it('reports a real PostgreSQL connection failure without pretending that revocation succeeded', async () => {
    const { adapter, invalidate } = await create()
    await expect(adapter.revokeLogin('missing-session' as Branded<'pe-auth-session-id'>, requestId)).rejects.toMatchObject({
      code: 'cloud/account-unavailable', status: 503,
    })
    expect(invalidate).not.toHaveBeenCalled()
    expect(adapter.pendingOperations).toBe(0)
  })

  it('keeps bootstrap projection denial and unavailable errors safe without inventing identity', async () => {
    const { adapter } = await create()
    for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => adapter.authenticateForBootstrap(request(), requestId, limit))
        .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable', status: 503 }))
    }
    expect(adapter.pendingOperations).toBe(0)
    expect(() => adapter.authenticateForBootstrap(request({ origin: 'https://other.example' }), requestId, 64))
      .toThrow(expect.objectContaining({ code: 'cloud/forbidden', status: 403 }))
    await expect(adapter.authenticateForBootstrap(request({ cookie: 'invalid.signature' }), requestId, 64))
      .rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
    await adapter.close()
    await expect(adapter.authenticateForBootstrap(request(), requestId, 64))
      .rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
  })

  it('stops new library work after close', async () => {
    const { adapter } = await create()
    await adapter.close()
    await expect(adapter.authenticate(request(), requestId)).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
  })
})
