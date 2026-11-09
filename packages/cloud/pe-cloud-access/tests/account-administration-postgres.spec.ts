import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { Auth } from 'better-auth'
import { describe, expect, it, vi } from 'vitest'
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
    let retireManagementOnInvalidation = false, managementRetired = false, failInvalidation = false
    const readGates: (() => void)[] = []
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
    const request = (cookie: string): IncomingMessage => {
      const value = new IncomingMessage(new Socket())
      value.headers = { host: new URL(origin).host, origin, cookie }
      value.rawHeaders = ['Host', new URL(origin).host, 'Origin', origin, 'Cookie', cookie]
      Object.defineProperty(value.socket, 'remoteAddress', { value: '127.0.0.1' })
      return value
    }
    const cookieOf = (response: Response): string => response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
    const config: AccessConfig = {
      publicOrigin: origin, deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test',
      sessionRecheckMs: 1000, authCheckTimeoutMs: 5000, maxPeers: 16, maxPeersPerAccount: 4,
      maxPeerWaiters: 16, maxPeerWaitersPerAccount: 4, maxPeerCarriers: 16, maxPeerCarriersPerAccount: 4,
      maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 2000, maxAuthOperations: 16,
      maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 8, maxAuthInvalidations: 16,
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
        if (failInvalidation) throw new Error('Synthetic original login Peer cleanup failure')
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
      let prepared = 0, stopped = 0, unknownStop = true, expectedSessionsDuringDrain = '0'
      adapter.installAccountResources({
        templates: async () => [{ id: 'standard', available: 1 }], states: async () => [],
        prepare: async (id) => {
          expect(id).toBe(createdBody.id)
          expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [id])).rows[0]?.banned).toBe(true)
          prepared++
        },
        disable: async (id) => {
          stopped++
          expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [id])).rows[0]?.count).toBe(expectedSessionsDuringDrain)
          return unknownStop ? 'stop-unknown' : 'disabled'
        },
      })
      expect((await post('/cloud/admin/accounts', creation, a.cookie)).status).toBe(200)
      expect(prepared).toBe(1)
      expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [createdBody.id])).rows[0]?.banned).toBe(false)
      expect((await post('/cloud/admin/accounts', creation, a.cookie)).status).toBe(200)
      expect(prepared).toBe(1)
      let targetCookie = '', knownCookie = ''
      for (let index = 0; index < 25; index++) {
        const signedIn = await post('/cloud/auth/sign-in/email', { email: creation.email, password: creation.password })
        expect(signedIn.status).toBe(200)
        targetCookie = cookieOf(signedIn)
        if (index === 0) knownCookie = targetCookie
      }
      expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [createdBody.id])).rows[0]?.count).toBe('25')
      const library = Reflect.get(adapter, 'auth') as Auth
      const fenceCounts = () => {
        const current = adapter
        if (current === undefined) throw new Error('Original authentication absent')
        const exact: unknown = Reflect.get(current, 'invalidationFences')
        const accounts: unknown = Reflect.get(current, 'accountInvalidationFences')
        if (!(exact instanceof Map) || !(accounts instanceof Map)) throw new Error('Original invalidation indexes missing')
        return { exact: exact.size, accounts: accounts.size, total: exact.size + accounts.size }
      }
      const holdRead = (cookie: string) => {
        const current = adapter
        if (current === undefined) throw new Error('Original authentication absent')
        const captured = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
        readGates.push(() => { gate.resolve(undefined) })
        const real = library.api.getSession.bind(library.api)
        const observer = vi.spyOn(library.api, 'getSession').mockImplementationOnce(async (input) => {
          const result = await real(input)
          captured.resolve(undefined)
          await gate.promise
          return result
        })
        const result = current.authenticate(request(cookie), requestId).then((principal) => {
          current.releasePrincipal(principal)
          return { kind: 'accepted', accountId: principal.accountId }
        }, (cause: unknown) => ({ kind: 'rejected', cause }))
        return { captured: captured.promise, result, release: () => { gate.resolve(undefined); observer.mockRestore() } }
      }
      // Hold an actual pre-ban library/PG result; its stale banned=false object must not regain authority.
      const knownTarget = await adapter.authenticate(request(knownCookie), requestId)
      const lateTarget = holdRead(targetCookie)
      await lateTarget.captured
      for (let index = 0; index < 15; index++) {
        await adapter.revokeLogin(`bulk-held-exact-${index}` as Branded<'pe-auth-session-id'>, requestId)
      }
      expect(fenceCounts()).toEqual({ exact: 15, accounts: 0, total: 15 })
      const originalHandler = library.handler.bind(library)
      let banReply: { status: number; code: unknown } | undefined
      const observedHandler = vi.spyOn(library, 'handler').mockImplementation(async (request) => {
        const response = await originalHandler(request)
        if (new URL(request.url).pathname === '/cloud/auth/admin/ban-user') {
          const body: unknown = await response.clone().json()
          const code: unknown = body !== null && typeof body === 'object' ? Reflect.get(body, 'code') : undefined
          banReply = { status: response.status, code }
        }
        return response
      })
      // Retire the management observer while the provider removes the target login; actual drain must still finish.
      retireManagementOnInvalidation = true
      const bulkDisabled = await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: false }, a.cookie)
      const bulkReply: unknown = await bulkDisabled.json()
      observedHandler.mockRestore()
      const bulkCode: unknown = bulkReply !== null && typeof bulkReply === 'object' ? Reflect.get(bulkReply, 'code') : undefined
      expect({ library: banReply, status: bulkDisabled.status,
        code: bulkCode,
        banned: (await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [createdBody.id])).rows[0]?.banned,
        remainingSessions: (await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [createdBody.id])).rows[0]?.count,
        stopped,
      }).toEqual({ library: { status: 200, code: undefined }, status: 503,
        code: 'cloud/account-stop-unconfirmed', banned: true, remainingSessions: '0', stopped: 1 })
      expect(fenceCounts()).toEqual({ exact: 15, accounts: 1, total: 16 })
      await expect(adapter.revokeLogin('bulk-held-overflow' as Branded<'pe-auth-session-id'>, requestId))
        .rejects.toMatchObject({ code: 'cloud/capacity', status: 429 })
      adapter.releasePrincipal(knownTarget)
      lateTarget.release()
      expect(await lateTarget.result).toMatchObject({ kind: 'rejected', cause: { code: 'cloud/unauthenticated' } })
      expect(fenceCounts()).toEqual({ exact: 0, accounts: 0, total: 0 })
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

      const secondLogin = await post('/cloud/auth/sign-in/email', { email: user.email, password: 'Test-admin-password-1234!' })
      expect(secondLogin.status).toBe(200)
      const otherCookie = cookieOf(secondLogin)
      const otherLogin = holdRead(otherCookie)
      await otherLogin.captured
      expect((await post('/cloud/auth/sign-out', {}, user.cookie)).status).toBe(200)
      expect(fenceCounts()).toEqual({ exact: 1, accounts: 0, total: 1 })
      otherLogin.release()
      expect(await otherLogin.result).toMatchObject({ kind: 'accepted', accountId: user.id })
      expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [user.id])).rows[0]?.count).toBe('1')

      // A real library refusal before ban must never stop an unbanned account's resources.
      const stopsBeforeSelf = stopped
      expect((await post('/cloud/admin/accounts', { op: 'enabled', id: a.id, enabled: false }, a.cookie)).status).toBe(403)
      expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [a.id])).rows[0]?.banned).toBe(false)
      expect(stopped).toBe(stopsBeforeSelf)

      expect((await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: true }, a.cookie)).status).toBe(200)
      for (let index = 0; index < 25; index++) {
        const signedIn = await post('/cloud/auth/sign-in/email', { email: creation.email, password: creation.password })
        expect(signedIn.status).toBe(200)
        targetCookie = cookieOf(signedIn)
      }
      const password = 'Changed-only-in-isolated-PG-1234!'
      expect((await post('/cloud/admin/accounts', { op: 'password', id: createdBody.id, password }, a.cookie)).status).toBe(200)
      expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [createdBody.id])).rows[0]?.count).toBe('0')

      await expect(adapter.authenticate(request(targetCookie), requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
      const fresh = await post('/cloud/auth/sign-in/email', { email: creation.email, password })
      expect(fresh.status).toBe(200)
      const freshPrincipal = await adapter.authenticate(request(cookieOf(fresh)), requestId)
      adapter.releasePrincipal(freshPrincipal)

      // An original after-delete cleanup failure can follow a committed ban; drain still runs, failure stays visible.
      const stopsBeforeFailure = stopped
      failInvalidation = true
      const partiallyFailed = await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: false }, a.cookie)
      failInvalidation = false
      expect(partiallyFailed.status).toBe(503)
      expect(await partiallyFailed.json()).toMatchObject({ code: 'cloud/account-unavailable' })
      expect(stopped).toBe(stopsBeforeFailure + 1)
      expect((await pool.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id=$1', [createdBody.id])).rows[0]?.banned).toBe(true)
      expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [createdBody.id])).rows[0]?.count).toBe('0')
      // A full shared fence budget can still refuse deletion; a committed ban nevertheless drains and blocks old cookies.
      expect((await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: true }, a.cookie)).status).toBe(200)
      const retainedLogin = await post('/cloud/auth/sign-in/email', { email: creation.email, password })
      expect(retainedLogin.status).toBe(200)
      const retainedCookie = cookieOf(retainedLogin), unrelated = holdRead(otherCookie)
      await unrelated.captured
      for (let index = 0; index < 16; index++) {
        await adapter.revokeLogin(`full-held-exact-${index}` as Branded<'pe-auth-session-id'>, requestId)
      }
      const stopsBeforeCapacity = stopped
      expectedSessionsDuringDrain = '1'
      const capacityBan = await post('/cloud/admin/accounts', { op: 'enabled', id: createdBody.id, enabled: false }, a.cookie)
      expectedSessionsDuringDrain = '0'
      expect(capacityBan.status).toBe(429)
      expect(await capacityBan.json()).toMatchObject({ code: 'cloud/capacity' })
      expect(stopped).toBe(stopsBeforeCapacity + 1)
      expect((await pool.query<{ count: string }>('SELECT count(*) FROM "session" WHERE "userId"=$1', [createdBody.id])).rows[0]?.count).toBe('1')
      const retained = await library.api.getSession({ headers: new Headers({ cookie: retainedCookie }),
        query: { disableCookieCache: true, disableRefresh: true } })
      expect(retained?.user).toMatchObject({ id: createdBody.id, banned: true })
      await expect(adapter.authenticate(request(retainedCookie), requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
      expect(fenceCounts()).toEqual({ exact: 16, accounts: 0, total: 16 })
      unrelated.release()
      expect(await unrelated.result).toMatchObject({ kind: 'accepted', accountId: user.id })
      expect(fenceCounts()).toEqual({ exact: 0, accounts: 0, total: 0 })
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
      const closingRead = holdRead(otherCookie)
      await closingRead.captured
      await adapter.revokeLogin('close-held-exact' as Branded<'pe-auth-session-id'>, requestId)
      let closed = false
      const close = adapter.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(fenceCounts()).toEqual({ exact: 1, accounts: 0, total: 1 })
      closingRead.release()
      await closingRead.result
      await close
      expect(fenceCounts()).toEqual({ exact: 0, accounts: 0, total: 0 })
    } finally {
      failInvalidation = false
      for (const release of readGates) release()
      vi.restoreAllMocks()
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
