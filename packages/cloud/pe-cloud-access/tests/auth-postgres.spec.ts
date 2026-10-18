import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { Auth } from 'better-auth'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { BetterAuthAccess } from '../src/auth.ts'
import { AuthAccessError } from '../src/auth-error.ts'
import type { AccessConfig } from '../src/types.ts'

const configPath = process.env.PE_ACCESS_POSTGRES_CONFIG
const requestId = 'access-pg-test' as Branded<'pe-request-id'>

function databaseConfig(): pg.PoolConfig {
  if (configPath === undefined) throw new Error('PE_ACCESS_POSTGRES_CONFIG is required for the isolated access database')
  const input: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  if (input === null || typeof input !== 'object' || !('host' in input) || typeof input.host !== 'string'
    || !('port' in input) || typeof input.port !== 'number' || !('user' in input) || typeof input.user !== 'string'
    || !('password' in input) || typeof input.password !== 'string' || !('databases' in input)
    || input.databases === null || typeof input.databases !== 'object'
    || !('access' in input.databases) || typeof input.databases.access !== 'string') {
    throw new Error('Private access PostgreSQL configuration is invalid')
  }
  return {
    host: input.host, port: input.port, user: input.user, password: input.password, database: input.databases.access,
    max: 2, connectionTimeoutMillis: 1000, query_timeout: 2000,
  }
}

describe.skipIf(configPath === undefined)('real isolated PostgreSQL17 authentication', () => {
  it('migrates, authenticates, pins original login, revokes, expires and signs out through the real library', async () => {
    const pool = new pg.Pool(databaseConfig())
    const sockets: Socket[] = []
    let adapter: BetterAuthAccess | undefined
    const invalidated = new Set<string>()
    const requireDeleted = new Set<string>()
    const deletionConfirmed = new Set<string>()
    const emails = new Map<string, string>()
    const server = createServer((req, res) => {
      if (adapter === undefined) { res.writeHead(503); res.end(); return }
      void adapter.handleNodeRequest(req, res, requestId).catch((error: unknown) => {
        const failure = error instanceof AuthAccessError ? error : new AuthAccessError('cloud/account-unavailable', requestId)
        if (res.headersSent) { res.destroy(); return }
        res.writeHead(failure.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(failure.toJSON()))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test listener has no loopback address')
    const origin = `http://127.0.0.1:${address.port}`
    const config: AccessConfig = {
      publicOrigin: origin, deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test-only-reference',
      sessionRecheckMs: 200, authCheckTimeoutMs: 3000, maxPeers: 4, maxPeersPerAccount: 2,
      maxPeerWaiters: 32, maxPeerWaitersPerAccount: 24, maxPeerCarriers: 16, maxPeerCarriersPerAccount: 8,
      maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 500,
      maxAuthOperations: 8, maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 1,
      bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    }
    function request(cookie?: string): IncomingMessage {
      const socket = new Socket()
      sockets.push(socket)
      const req = new IncomingMessage(socket)
      req.method = 'GET'
      req.url = '/api/session/list'
      req.headers = { host: new URL(origin).host, ...(cookie === undefined ? {} : { cookie }) }
      req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)])
      return req
    }
    async function signup(label: string): Promise<string> {
      const email = `${label}-${randomUUID()}@access.example.test`
      const response = await fetch(`${origin}/cloud/auth/sign-up/email`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'Probe-password-12345!', name: label }),
      })
      expect(response.status).toBe(200)
      const cookies = response.headers.getSetCookie()
      expect(cookies.some(cookie => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie))).toBe(true)
      const pairs = cookies.map(cookie => cookie.split(';')[0]).filter(value => value !== undefined)
      const cookie = pairs.join('; ')
      emails.set(cookie, email)
      return cookie
    }
    try {
      const secret = `auth-probe-${randomUUID()}-${randomUUID()}`
      const current = await BetterAuthAccess.create(config, pool, secret, async (id) => {
        if (requireDeleted.has(id)) {
          const observed = await pool.query<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM "session" WHERE "id" = $1) AS present', [id])
          if (observed.rows[0]?.present !== false) throw new Error('Invalidation was notified before database deletion committed')
          deletionConfirmed.add(id)
        }
        invalidated.add(id)
      })
      adapter = current
      const plan = await current.planMigrations(requestId)
      const sql = await plan.compileMigrations()
      if (process.env.PE_ACCESS_WRITE_AUTH_DDL === '1' && plan.toBeCreated.length > 0) {
        const folder = new URL('../migrations/', import.meta.url)
        mkdirSync(folder, { recursive: true })
        writeFileSync(new URL('better-auth-1.7.10.sql', folder), sql.endsWith('\n') ? sql : `${sql}\n`)
      }
      await plan.runMigrations()
      expect((await current.planMigrations(requestId)).toBeCreated).toHaveLength(0)
      await expect(current.authenticate(request(), requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated', status: 401 })
      const cookieA = await signup('a')
      const cookieB = await signup('b')
      const originalRequest = request(cookieA)
      originalRequest.headers['x-pe-account'] = 'client-forged-account'
      const principalA = await current.authenticate(originalRequest, requestId)
      const principalB = await current.authenticate(request(cookieB), requestId)
      expect(principalA.accountId).not.toBe(principalB.accountId)
      expect(principalA.accountId).not.toBe('client-forged-account')
      const nativeAuth = Reflect.get(current, 'auth') as Auth
      for (const endpoint of ['sign-in/email', 'sign-up/email']) {
        const mutation = vi.spyOn(nativeAuth, 'handler')
        try {
          const refused = await fetch(`${origin}/cloud/auth/${endpoint}`, {
            method: 'POST', headers: { origin, cookie: cookieA, 'content-type': 'application/json' },
            body: JSON.stringify({ email: emails.get(cookieB), password: 'Probe-password-12345!', name: 'must-not-replace' }),
          })
          expect(refused.status).toBe(409)
          expect(await refused.json()).toMatchObject({ code: 'cloud/login-active', retry: 'never' })
          expect(refused.headers.getSetCookie()).toHaveLength(0)
          expect(mutation).not.toHaveBeenCalled()
          expect((await current.authenticate(request(cookieA), requestId)).accountId).toBe(principalA.accountId)
          expect((await current.authenticate(request(cookieB), requestId)).accountId).toBe(principalB.accountId)
        } finally { mutation.mockRestore() }
      }
      const raceCookie = await signup('replacement-race')
      const readSession = nativeAuth.api.getSession.bind(nativeAuth.api)
      const queried = Promise.withResolvers<undefined>(), releaseLookup = Promise.withResolvers<undefined>()
      const lookup = vi.spyOn(nativeAuth.api, 'getSession').mockImplementationOnce(async (input) => {
        const actual = await readSession(input)
        queried.resolve(undefined)
        await releaseLookup.promise
        return actual
      })
      const replacement = fetch(`${origin}/cloud/auth/sign-in/email`, {
        method: 'POST', headers: { origin, cookie: raceCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ email: emails.get(cookieB), password: 'Probe-password-12345!' }),
      })
      try {
        await queried.promise
        const signout = await fetch(`${origin}/cloud/auth/sign-out`, { method: 'POST', headers: { origin, cookie: raceCookie } })
        expect(signout.status).toBe(200)
      } finally { releaseLookup.resolve(undefined); lookup.mockRestore() }
      expect((await replacement).status).toBe(409)
      const oldTab = await fetch(`${origin}/cloud/auth/sign-in/email`, {
        method: 'POST', headers: { origin, cookie: raceCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ email: emails.get(cookieB), password: 'Probe-password-12345!' }),
      })
      expect(oldTab.status).toBe(409)
      expect(oldTab.headers.getSetCookie()).toHaveLength(0)
      const closed = await BetterAuthAccess.create({ ...config, disableSignUp: true }, pool, secret, async () => {})
      adapter = closed
      try {
        const refused = await fetch(`${origin}/cloud/auth/sign-up/email`, { method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ email: `closed-${randomUUID()}@access.example.test`, name: 'closed', password: 'Probe-password-12345!' }) })
        expect(refused.status).toBe(400)
        expect(refused.headers.getSetCookie()).toHaveLength(0)
        const login = await fetch(`${origin}/cloud/auth/sign-in/email`, { method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ email: emails.get(cookieB), password: 'Probe-password-12345!' }) })
        expect(login.status).toBe(200)
        expect(login.headers.getSetCookie().length).toBeGreaterThan(0)
      } finally { adapter = current; await closed.close() }
      const timed = await BetterAuthAccess.create({ ...config, authCheckTimeoutMs: 50 }, pool, secret, async () => {})
      const timedNative = Reflect.get(timed, 'auth') as Auth
      const readAnonymous = timedNative.api.getSession.bind(timedNative.api)
      const releaseAnonymous = Promise.withResolvers<undefined>(), anonymousRead = Promise.withResolvers<undefined>()
      const delayedAnonymous = vi.spyOn(timedNative.api, 'getSession').mockImplementationOnce(async (input) => {
        const actual = await readAnonymous(input)
        anonymousRead.resolve(undefined)
        await releaseAnonymous.promise
        return actual
      })
      const timedMutation = vi.spyOn(timedNative, 'handler')
      adapter = timed
      try {
        const attempt = fetch(`${origin}/cloud/auth/sign-in/email`, { method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ email: emails.get(cookieB), password: 'Probe-password-12345!' }) })
        await anonymousRead.promise
        const result = await attempt
        expect(result.status).toBe(503)
        expect(result.headers.getSetCookie()).toHaveLength(0)
        expect(timed.pendingOperations).toBeGreaterThan(0)
      } finally {
        releaseAnonymous.resolve(undefined)
        adapter = current
        await timed.close()
        delayedAnonymous.mockRestore()
      }
      expect(timedMutation).not.toHaveBeenCalled()
      timedMutation.mockRestore()
      const late = await BetterAuthAccess.create({ ...config, authCheckTimeoutMs: 500 }, pool, secret, async () => {})
      const lateNative = Reflect.get(late, 'auth') as Auth
      const actualHandler = lateNative.handler.bind(lateNative)
      const committed = Promise.withResolvers<undefined>(), releaseResult = Promise.withResolvers<undefined>()
      const lateMutation = vi.spyOn(lateNative, 'handler').mockImplementationOnce(async (input) => {
        const actual = await actualHandler(input)
        expect(actual.status).toBe(200)
        expect(actual.headers.getSetCookie().length).toBeGreaterThan(0)
        committed.resolve(undefined)
        await releaseResult.promise
        return actual
      })
      adapter = late
      try {
        const attempt = fetch(`${origin}/cloud/auth/sign-in/email`, { method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ email: emails.get(cookieB), password: 'Probe-password-12345!' }) })
        await committed.promise
        const unknown = await attempt
        expect(unknown.status).toBe(503)
        expect(unknown.headers.getSetCookie()).toHaveLength(0)
        expect(late.pendingOperations).toBeGreaterThan(0)
      } finally {
        releaseResult.resolve(undefined)
        adapter = current
        await late.close()
      }
      expect(lateMutation).toHaveBeenCalledTimes(1)
      lateMutation.mockRestore()
      expect((await current.authenticate(request(cookieB), requestId)).accountId).toBe(principalB.accountId)
      const wrongPassword = await fetch(`${origin}/cloud/auth/sign-in/email`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: emails.get(cookieA), password: 'incorrect-password' }),
      })
      expect(wrongPassword.status).toBe(401)
      const secondLogin = await fetch(`${origin}/cloud/auth/sign-in/email`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: emails.get(cookieA), password: 'Probe-password-12345!' }),
      })
      expect(secondLogin.status).toBe(200)
      const cookieA2 = secondLogin.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
      const singleLogin = { ...config, maxTrackedLogins: 1, maxTrackedLoginsPerAccount: 1 }
      const loginLimited = await BetterAuthAccess.create(singleLogin, pool, secret, async () => {})
      try {
        await loginLimited.authenticate(request(cookieA), requestId)
        await expect(loginLimited.authenticate(request(cookieB), requestId)).rejects.toMatchObject({ code: 'cloud/capacity', status: 429 })
      } finally { await loginLimited.close() }
      const accountLimited = await BetterAuthAccess.create({ ...config, maxTrackedLoginsPerAccount: 1 }, pool, secret, async () => {})
      try {
        await accountLimited.authenticate(request(cookieA), requestId)
        await expect(accountLimited.authenticate(request(cookieA2), requestId)).rejects.toMatchObject({ code: 'cloud/capacity', status: 429 })
        expect((await accountLimited.authenticate(request(cookieB), requestId)).accountId).toBe(principalB.accountId)
      } finally { await accountLimited.close() }
      originalRequest.headers.cookie = cookieB
      await current.recheckLogin(principalA, requestId)
      expect(() => { current.assertLoginCurrent(principalA, requestId) }).not.toThrow()
      await new Promise<void>((resolve) => { setTimeout(resolve, config.sessionRecheckMs + 5) })
      expect(() => { current.assertLoginCurrent(principalA, requestId) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      await current.recheckLogin(principalA, requestId)
      await current.recheckLogin(principalB, requestId)
      // Only delay the real library's already-read result; no session or principal is fabricated.
      const originalGetSession = nativeAuth.api.getSession.bind(nativeAuth.api)
      let readComplete: () => void = () => {}
      let releaseRead: () => void = () => {}
      const captured = new Promise<void>((resolve) => { readComplete = resolve })
      const held = new Promise<void>((resolve) => { releaseRead = resolve })
      const delayed = vi.spyOn(nativeAuth.api, 'getSession').mockImplementationOnce(async (input) => {
        const realResult = await originalGetSession(input)
        readComplete()
        await held
        return realResult
      })
      const lateA = current.authenticate(request(cookieA), requestId).then(
        value => ({ kind: 'resolved', value }),
        (error: unknown) => ({ kind: 'rejected', error }),
      )
      await captured
      requireDeleted.add(principalA.authSessionId)
      try {
        await current.revokeLogin('absent-fence-one' as Branded<'pe-auth-session-id'>, requestId)
        await expect(current.revokeLogin('absent-fence-two' as Branded<'pe-auth-session-id'>, requestId)).rejects.toMatchObject({
          code: 'cloud/capacity', status: 429,
        })
        const blockedSignout = await fetch(`${origin}/cloud/auth/sign-out`, { method: 'POST', headers: { origin, cookie: cookieA2 } })
        expect(blockedSignout.status).toBe(429)
        await expect(blockedSignout.json()).resolves.toMatchObject({ code: 'cloud/capacity', requestId })
        const [, concurrentB] = await Promise.all([
          current.revokeLogin(principalA.authSessionId, requestId),
          current.authenticate(request(cookieB), requestId),
          current.recheckLogin(principalB, requestId),
        ])
        expect(concurrentB.accountId).toBe(principalB.accountId)
        expect(() => { current.assertLoginCurrent(principalB, requestId) }).not.toThrow()
      } finally {
        releaseRead()
        delayed.mockRestore()
      }
      expect(await lateA).toMatchObject({ kind: 'rejected', error: { code: 'cloud/unauthenticated' } })
      await current.revokeLogin('absent-fence-two' as Branded<'pe-auth-session-id'>, requestId)
      expect((await current.authenticate(request(cookieA2), requestId)).accountId).toBe(principalA.accountId)
      expect(() => { current.assertLoginCurrent(principalA, requestId) }).toThrow(expect.objectContaining({ code: 'cloud/unauthenticated' }))
      expect(invalidated.has(principalA.authSessionId)).toBe(true)
      expect(deletionConfirmed.has(principalA.authSessionId)).toBe(true)
      await expect(current.authenticate(request(cookieA), requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
      await expect(current.recheckLogin(principalA, requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
      expect((await current.authenticate(request(cookieB), requestId)).accountId).toBe(principalB.accountId)
      requireDeleted.add(principalB.authSessionId)
      const signout = await fetch(`${origin}/cloud/auth/sign-out`, { method: 'POST', headers: { origin, cookie: cookieB } })
      expect(signout.status).toBe(200)
      expect(invalidated.has(principalB.authSessionId)).toBe(true)
      expect(deletionConfirmed.has(principalB.authSessionId)).toBe(true)
      await expect(current.authenticate(request(cookieB), requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
      const cookieC = await signup('expires')
      const principalC = await current.authenticate(request(cookieC), requestId)
      // Fault injection changes only a library-created row in this task's dedicated access test database.
      await pool.query('UPDATE "session" SET "expiresAt" = $1 WHERE "id" = $2', [new Date(Date.now() - 1000), principalC.authSessionId])
      await expect(current.recheckLogin(principalC, requestId)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
      expect(invalidated.has(principalC.authSessionId)).toBe(true)
      const cookieSlow = await signup('slow-db')
      const singleOperation = { ...config, authCheckTimeoutMs: 100, maxAuthOperations: 1 }
      const short = await BetterAuthAccess.create(singleOperation, pool, secret, async (id) => {
        invalidated.add(id)
      })
      const principalSlow = await short.authenticate(request(cookieSlow), requestId)
      const lock = await pool.connect()
      try {
        await lock.query('BEGIN')
        await lock.query('LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE')
        await expect(short.recheckLogin(principalSlow, requestId)).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
        expect(invalidated.has(principalSlow.authSessionId)).toBe(true)
        expect(short.pendingOperations).toBeGreaterThan(0)
        const waitingBeforeDenials = pool.waitingCount
        for (let count = 0; count < 20; count++) {
          await expect(short.authenticate(request(cookieSlow), requestId)).rejects.toMatchObject({ code: 'cloud/capacity', status: 429 })
        }
        expect(short.pendingOperations).toBe(1)
        expect(pool.waitingCount).toBe(waitingBeforeDenials)
      } finally {
        await lock.query('ROLLBACK')
        lock.release()
        await short.close()
      }
      expect(short.pendingOperations).toBe(0)
      expect(() => { short.assertLoginCurrent(principalSlow, requestId) }).toThrow(expect.objectContaining({ code: 'cloud/unauthenticated' }))
      const cookieD = await signup('db-failure')
      const principalD = await current.authenticate(request(cookieD), requestId)
      await pool.end()
      await expect(current.recheckLogin(principalD, requestId)).rejects.toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
      expect(invalidated.has(principalD.authSessionId)).toBe(true)
      const failedSignout = await fetch(`${origin}/cloud/auth/sign-out`, { method: 'POST', headers: { origin, cookie: cookieD } })
      expect(failedSignout.status).toBe(503)
      await expect(failedSignout.json()).resolves.toMatchObject({ code: 'cloud/account-unavailable', requestId })
      expect(() => { current.assertLoginCurrent(principalD, requestId) }).toThrow(expect.objectContaining({ code: 'cloud/unauthenticated' }))
      expect(current.pendingOperations).toBe(0)
    } finally {
      await adapter?.close()
      if (!pool.ended) await pool.end()
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  }, 20000)
})
