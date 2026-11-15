/** Real authentication adapter and principal ownership with a synthetic database answer; no SQL readiness claim. */
import pg from 'pg'
import type { Auth } from 'better-auth'
import { onTestFinished, vi } from 'vitest'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { BetterAuthAccess } from '../src/auth.ts'
import type { AccessConfig, AuthenticatedPrincipal } from '../src/types.ts'
import { carrier } from './ingress-fixture.ts'

/**
 * Authenticate through the original adapter, including its principal and login borrow records.
 * @param config Original finite component budgets and transport policy.
 * @param accountId Account named by the synthetic database user/session rows.
 * @param requestId Original server correlation id.
 * @param invalidate Original Peer registry's login invalidation callback.
 * @returns Original adapter and its authenticated principal; this fixture releases only its own borrow at test completion.
 */
export async function authenticatedLoginFixture(
  config: AccessConfig, accountId: AccountId, requestId: Parameters<BetterAuthAccess['authenticate']>[1],
  invalidate: (id: AuthenticatedPrincipal['authSessionId']) => Promise<void>,
): Promise<{ auth: BetterAuthAccess; principal: AuthenticatedPrincipal }> {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1,
    connectionTimeoutMillis: 30, query_timeout: 50 })
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Physical SQL is forbidden in this component fixture') })
  const resources: { auth?: BetterAuthAccess; principal?: AuthenticatedPrincipal } = {}
  onTestFinished(async () => {
    const { auth, principal } = resources
    try {
      if (auth !== undefined) {
        if (principal !== undefined) auth.releasePrincipal(principal)
        await auth.close()
      }
    } finally { await pool.end() }
  })
  const auth = resources.auth = await BetterAuthAccess.create(config, pool, 'history-component-secret-with-thirty-two-characters', invalidate)
  const library = Reflect.get(auth, 'auth') as Auth, createdAt = new Date()
  const login = { user: { id: accountId, name: 'History', email: 'history@example.test', emailVerified: true,
    createdAt, updatedAt: createdAt }, session: { id: 'history-login', userId: accountId, token: 'synthetic-history-token',
    expiresAt: new Date(Date.now() + 60000), createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null } }
  vi.spyOn(library.api, 'getSession').mockImplementation(async (input) => {
    return new Headers(input?.headers).get('cookie') === 'login=history-login' ? login : null
  })
  const original = carrier('/api/remote.mux', 'GET', ['Origin', config.publicOrigin, 'Cookie', 'login=history-login'])
  try {
    const principal = resources.principal = await auth.authenticate(original.request, requestId)
    return { auth, principal }
  } finally { original.request.destroy(); original.response.destroy(); original.socket.destroy() }
}
