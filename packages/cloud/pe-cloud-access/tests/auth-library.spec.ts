import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { BetterAuthAccess } from '../src/auth.ts'
import type { AccessConfig, AuthenticatedPrincipal } from '../src/types.ts'

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

  it('stops new library work after close', async () => {
    const { adapter } = await create()
    await adapter.close()
    await expect(adapter.authenticate(request(), requestId)).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
  })
})
