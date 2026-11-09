import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { BetterAuthAccess } from '../src/auth.ts'
import { AuthAccessError } from '../src/auth-error.ts'
import type { AccessConfig } from '../src/types.ts'

const configPath = process.env.PE_ACCOUNT_ADMIN_POSTGRES_CONFIG
const requestId = 'isolated-account-administration' as Branded<'pe-request-id'>

describe.skipIf(configPath === undefined)('real account administration with PostgreSQL and Better Auth 1.7.10', () => {
  it('keeps registration closed, rejects ordinary users and serializes removal of the final administrator', async () => {
    if (configPath === undefined) throw new Error('Isolated database configuration required')
    const input: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (input === null || typeof input !== 'object'
      || !('host' in input) || typeof input.host !== 'string'
      || !('port' in input) || typeof input.port !== 'number'
      || !('user' in input) || typeof input.user !== 'string'
      || !('password' in input) || typeof input.password !== 'string') {
      throw new Error('Private account administration PostgreSQL configuration is invalid')
    }
    const connection: pg.PoolConfig = { host: input.host, port: input.port, user: input.user,
      password: input.password, database: 'dsh_account_management' }
    const pool = new pg.Pool({ ...connection, max: 2, connectionTimeoutMillis: 2000, statement_timeout: 5000 })
    let adapter: BetterAuthAccess | undefined
    let retireManagementOnInvalidation = false, managementRetired = false
    const server = createServer((request, response) => {
      void (async () => {
        if (adapter === undefined) throw new Error('Test authentication absent')
        if (request.url === '/cloud/admin/accounts') {
          let body = ''; for await (const chunk of request) body += String(chunk)
          const result = await adapter.administer(request, JSON.parse(body), requestId, () => {
            if (managementRetired) throw new AuthAccessError('cloud/account-unavailable', requestId)
          })
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result))
        } else await adapter.handleNodeRequest(request, response, requestId)
      })().catch((error: unknown) => {
        const failure = error instanceof AuthAccessError ? error : new AuthAccessError('cloud/account-unavailable', requestId)
        response.writeHead(failure.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(failure.toJSON()))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test listener unavailable')
    const origin = `http://127.0.0.1:${address.port}`
    const config: AccessConfig = {
      publicOrigin: origin, deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test',
      sessionRecheckMs: 1000, authCheckTimeoutMs: 5000, maxPeers: 16, maxPeersPerAccount: 4,
      maxPeerWaiters: 16, maxPeerWaitersPerAccount: 4, maxPeerCarriers: 16, maxPeerCarriersPerAccount: 4,
      maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 2000, maxAuthOperations: 32,
      maxTrackedLogins: 32, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 32,
      bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    }
    const administration = { maxAccounts: 100, maxPageSize: 20, initialAdministratorIds: [] as string[] }
    const secret = 'isolated-admin-test-' + randomUUID() + randomUUID()
    const post = (path: string, body: object, cookie = '') => fetch(origin + path, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const signup = async (label: string) => {
      const email = `${label}-${randomUUID()}@admin.example.test`
      const response = await post('/cloud/auth/sign-up/email', { email, name: label, password: 'Test-admin-password-1234!' })
      expect(response.status).toBe(200)
      const value = await response.json() as { user: { id: string } }
      return { id: value.user.id, email, cookie: response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ') }
    }
    try {
      adapter = await BetterAuthAccess.create({ ...config, accountAdministration: administration }, pool, secret, async () => {})
      const plan = await adapter.planMigrations(requestId)
      await plan.runMigrations()
      // This database is exclusively provisioned for this test feature, never the running trial database.
      expect((await pool.query<{ database: string }>('SELECT current_database() AS database')).rows[0]?.database).toBe('dsh_account_management')
      await pool.query('TRUNCATE "user" CASCADE')
      const a = await signup('administrator-a'), b = await signup('administrator-b'), user = await signup('ordinary')
      await adapter.close()
      adapter = await BetterAuthAccess.create({ ...config, disableSignUp: true,
        accountAdministration: { ...administration, initialAdministratorIds: [a.id, b.id] } }, pool, secret, async () => {
        if (retireManagementOnInvalidation) managementRetired = true
      })
      await adapter.initializeAdministrators(() => {})
      expect((await post('/cloud/auth/sign-up/email', { email: 'closed@example.test', name: 'Closed', password: 'Long-test-password-123' })).status).toBe(400)
      expect((await post('/cloud/admin/accounts', { op: 'list', search: '', offset: 0 }, user.cookie)).status).toBe(403)
      expect((await post('/cloud/auth/admin/create-user', {}, a.cookie)).status).toBe(403)
      const creation = { op: 'create', email: 'pending-'+randomUUID()+'@example.test', displayName: 'Pending',
        password: 'Long-test-password-123', role: 'user', templateId: 'standard', requestId: randomUUID() }
      const created = await post('/cloud/admin/accounts', creation, a.cookie)
      expect(created.status).toBe(200)
      const createdBody = await created.json() as { id: string; resourceState: string }
      expect(createdBody.resourceState).toBe('not-provisioned')
      const repeated = await post('/cloud/admin/accounts', creation, a.cookie)
      expect((await repeated.json() as { id: string }).id).toBe(createdBody.id)
      expect((await post('/cloud/admin/accounts', { ...creation, displayName: 'Changed payload' }, a.cookie)).status).toBe(403)
      expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [createdBody.id])).rows[0]?.banned).toBe(true)
      let prepared = 0, stopped = 0, unknownStop = true
      adapter.installAccountResources({
        templates: async () => [{ id: 'standard', available: 1 }], states: async () => [],
        prepare: async (id) => {
          expect(id).toBe(createdBody.id)
          expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [id])).rows[0]?.banned).toBe(true)
          prepared++
        },
        disable: async (id) => {
          stopped++
          expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [id])).rows[0]?.count).toBe('0')
          return unknownStop ? 'stop-unknown' : 'disabled'
        },
      })
      expect((await post('/cloud/admin/accounts', creation, a.cookie)).status).toBe(200)
      expect(prepared).toBe(1)
      expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [createdBody.id])).rows[0]?.banned).toBe(false)
      expect((await post('/cloud/admin/accounts', creation, a.cookie)).status).toBe(200)
      expect(prepared).toBe(1)
      expect((await post('/cloud/auth/sign-in/email', { email: creation.email, password: creation.password })).status).toBe(200)
      // Retire the management observer while the provider removes the target login; actual drain must still finish.
      retireManagementOnInvalidation = true
      expect((await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: false }, a.cookie)).status).toBe(503)
      expect(managementRetired).toBe(true)
      expect(stopped).toBe(1)
      retireManagementOnInvalidation = false; managementRetired = false
      expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [createdBody.id])).rows[0]?.banned).toBe(true)
      expect((await post('/cloud/admin/accounts', creation, a.cookie)).status).toBe(200)
      expect(prepared).toBe(1)
      const unconfirmed = await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: false }, a.cookie)
      expect(unconfirmed.status).toBe(503)
      expect(await unconfirmed.json()).toMatchObject({ code: 'cloud/account-stop-unconfirmed', retry: 'after-status-check' })
      unknownStop = false
      expect((await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: false }, a.cookie)).status).toBe(200)
      const results = await Promise.all([
        post('/cloud/admin/accounts', { op: 'role', id: a.id, role: 'user' }, a.cookie),
        post('/cloud/admin/accounts', { op: 'role', id: b.id, role: 'user' }, b.cookie),
      ])
      expect(results.map(result => result.status).sort()).toEqual([200, 409])
      expect((await pool.query<{ count: string }>('SELECT count(*) FROM "user" WHERE role=$1 AND coalesce(banned,false)=false', ['admin'])).rows[0]?.count).toBe('1')

      const active = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE role=$1 AND coalesce(banned,false)=false', ['admin'])
      expect(active.rows).toHaveLength(1)
      const sole = [a, b].find(account => account.id === active.rows[0]?.id)
      const other = [a, b].find(account => account.id !== active.rows[0]?.id)
      if (sole === undefined || other === undefined) throw new Error('Original fixture administrators missing')
      const stopsBefore = stopped
      const deniedDisable = await post('/cloud/admin/accounts', { op: 'enabled', id: sole.id, enabled: false }, sole.cookie)
      expect(deniedDisable.status).toBe(409)
      expect(await deniedDisable.json()).toMatchObject({ code: 'cloud/last-administrator' })
      expect((await pool.query<{ role: string; banned: boolean }>('SELECT role, banned FROM "user" WHERE id=$1', [sole.id])).rows[0])
        .toMatchObject({ role: 'admin', banned: false })
      expect(stopped).toBe(stopsBefore)

      expect((await post('/cloud/admin/accounts', { op: 'role', id: other.id, role: 'admin' }, sole.cookie)).status).toBe(200)
      const signIn = async (account: typeof a) => {
        const response = await post('/cloud/auth/sign-in/email', { email: account.email, password: 'Test-admin-password-1234!' })
        expect(response.status).toBe(200)
        const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
        expect(cookie).not.toBe('')
        return { ...account, cookie }
      }
      const [first, second] = await Promise.all([signIn(sole), signIn(other)])
      const activeCount = async () => (await pool.query<{ count: string }>(
        'SELECT count(*) FROM "user" WHERE role=$1 AND coalesce(banned,false)=false', ['admin'])).rows[0]?.count
      expect(await activeCount()).toBe('2')
      const mixed = await Promise.all([
        post('/cloud/admin/accounts', { op: 'role', id: first.id, role: 'user' }, first.cookie),
        post('/cloud/admin/accounts', { op: 'enabled', id: second.id, enabled: false }, second.cookie),
      ].map(async (response) => {
        const settled = await response
        expect(await activeCount()).toBe('1')
        return settled.status
      }))
      expect(mixed.sort()).toEqual([200, 409])
      expect(await activeCount()).toBe('1')
    } finally {
      await adapter?.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      expect(server.listening).toBe(false)
      await pool.end()
    }
  }, 20000)
})
