/** Better Auth 1.7.10/PostgreSQL adapter; root admission remains a separate assembly requirement. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isIP } from 'node:net'
import type { Auth, BetterAuthOptions, Session } from 'better-auth'
import type { Pool } from 'pg'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { parseAccessConfig } from './config.ts'
import type { AccessConfig, AuthenticatedPrincipal, CloudBootstrap } from './types.ts'
import { AuthAccessError } from './auth-error.ts'
import { assertAuthTransport } from './auth-trust.ts'
import { trackBody, type TrackedBody } from './body-stream.ts'
import { getSessionCookie } from 'better-auth/cookies'

type NodeAuth = typeof import('better-auth/node')
type AuthFactory = typeof import('better-auth')['betterAuth']
type ApiErrorFactory = typeof import('better-auth')['APIError']
type LoginInvalidator = (authSessionId: Branded<'pe-auth-session-id'>) => Promise<void>
type LibraryLogin = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>
interface LoginState {
  readonly id: Branded<'pe-auth-session-id'>
  readonly accountId: AccountId
  expiresAtMs: number
  invalidated: boolean
  fenceOrdinal: bigint | undefined
}
interface LoginCheck {
  readonly headers: Headers
  verifiedAtMs: number
  state: LoginState
}
interface AuthInvocation {
  readonly requestId: Branded<'pe-request-id'>
  failure: 'cloud/capacity' | 'cloud/account-unavailable' | undefined
  timedOut: boolean
}
interface AuthNodeLimits {
  readonly maxBodyBytes: number
  readonly signal: AbortSignal
  readonly assertCurrent?: () => void
}

/**
 * Owns library-backed identity extraction and revocation, without owning native Peer or Session state.
 * The caller owns the finite PG pool and root request admission. Construction does not migrate or listen.
 */
export class BetterAuthAccess {
  private readonly config: AccessConfig
  private readonly auth: Auth
  private readonly options: BetterAuthOptions
  private readonly node: NodeAuth
  private readonly apiError: ApiErrorFactory
  private readonly onLoginInvalidated: LoginInvalidator
  private readonly principals: WeakMap<AuthenticatedPrincipal, LoginCheck> = new WeakMap()
  private readonly pending: Map<Promise<void>, bigint> = new Map()
  private readonly logins: Map<Branded<'pe-auth-session-id'>, LoginState> = new Map()
  private readonly accountLoginCounts: Map<AccountId, number> = new Map()
  private readonly invalidationFences: Map<Branded<'pe-auth-session-id'>, bigint> = new Map()
  private readonly invocation: AsyncLocalStorage<AuthInvocation> = new AsyncLocalStorage()
  private ordinal: bigint = 0n
  private accepting: boolean = true
  private readonly bridges = new Set<Promise<void>>()

  private constructor(
    config: AccessConfig & { readonly disableSignUp?: boolean }, database: Pool, secret: string, invalidate: LoginInvalidator,
    factory: AuthFactory, apiError: ApiErrorFactory, node: NodeAuth,
  ) {
    this.config = parseAccessConfig(config)
    this.node = node
    this.apiError = apiError
    this.onLoginInvalidated = invalidate
    this.options = {
      database,
      secret,
      baseURL: this.config.publicOrigin,
      basePath: '/cloud/auth',
      trustedOrigins: [this.config.publicOrigin],
      emailAndPassword: { enabled: true, disableSignUp: config.disableSignUp ?? false },
      session: { cookieCache: { enabled: false } },
      advanced: {
        useSecureCookies: new URL(this.config.publicOrigin).protocol === 'https:',
        trustedProxyHeaders: false,
        ...this.config.servicePreview === undefined ? {} : {
          crossSubDomainCookies: { enabled: true, domain: this.config.servicePreview.cookieDomain },
        },
        defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
        ipAddress: { ipAddressHeaders: ['x-pe-auth-remote-ip'] },
      },
      logger: { level: 'error', log: (level): void => {
        if (level !== 'error') return
        const invocation = this.invocation.getStore()
        if (invocation !== undefined && invocation.failure === undefined) invocation.failure = 'cloud/account-unavailable'
      } },
      telemetry: { enabled: false },
      databaseHooks: { session: { delete: {
        before: (session): Promise<void> => {
          this.reserveInvalidation(session.id as Branded<'pe-auth-session-id'>)
          return Promise.resolve()
        },
        after: async (session): Promise<void> => { await this.invalidateLogin(session.id as Branded<'pe-auth-session-id'>) },
      } } },
    }
    this.auth = factory(this.options)
  }

  /**
   * Load the pinned real library; no alternative authentication implementation is supplied.
   * @param config - Validated root deployment inputs.
   * @param database - Caller-owned finite PostgreSQL pool with finite connection/query timeouts.
   * @param secret - Secret resolved by the trusted root from authSecretRef; never persisted here.
   * @param invalidate - Idempotently close the native Peers of this exact login after invalidation.
   * @returns the real library adapter, without mounting any route or claiming readiness.
   * @throws Error if dependencies are unavailable or the loaded Better Auth version differs from 1.7.10.
   */
  static async create(
    config: AccessConfig & { readonly disableSignUp?: boolean }, database: Pool, secret: string, invalidate: LoginInvalidator,
  ): Promise<BetterAuthAccess> {
    const [{ betterAuth, APIError }, node] = await Promise.all([import('better-auth'), import('better-auth/node')])
    const adapter = new BetterAuthAccess(config, database, secret, invalidate, betterAuth, APIError, node)
    if ((await adapter.auth.$context).version !== '1.7.10') throw new Error('cloud access requires Better Auth 1.7.10')
    return adapter
  }

  /** Actual unfinished library work remains counted after a caller times out. */
  get pendingOperations(): number { return this.pending.size }

  /**
   * Query the database-backed login on every account request.
   * @param request - Original request; raw cookie/header values enter Better Auth, not client account fields.
   * @param requestId - Server-generated correlation id.
   * @returns an immutable principal from the library's verified user/session rows.
   * @throws AuthAccessError for forbidden transport, missing/expired login, capacity, DB failure or timeout.
   */
  authenticate(request: IncomingMessage, requestId: Branded<'pe-request-id'>): Promise<AuthenticatedPrincipal> {
    return this.authenticateAndProject(request, requestId, (_login, principal) => principal)
  }

  /**
   * Read the same database-backed login for the fixed isolated preview GET only.
   * This adapter method is internal to Root ingress and is not exposed by PeAuthService or a client RPC.
   * @param request - Original request; Host, method and canonical preview path are checked without rewriting.
   * @param requestId - Server-generated correlation id.
   * @returns The original library-tracked principal, without authorizing any preview target or management API.
   * @throws AuthAccessError for forbidden transport, missing/expired login, capacity, DB failure or timeout.
   */
  authenticateServicePreview(request: IncomingMessage, requestId: Branded<'pe-request-id'>): Promise<AuthenticatedPrincipal> {
    return this.authenticateAndProject(request, requestId, (_login, principal) => principal, 'service-preview')
  }

  /**
   * Authenticate once and project the same verified user's bounded display metadata for future bootstrap assembly.
   * Neither the projection nor its wrapper is retained in a Peer principal record.
   * @param request - Original request whose cookie is captured before the library query.
   * @param requestId - Server-generated correlation id; errors contain no user id or display name.
   * @param maxDisplayNameBytes - Explicit positive safe-integer UTF-8 limit, e.g. the bootstrap maxStringBytes.
   * @returns Frozen wrapper containing the normal adapter-tracked principal and a frozen C-11 account projection.
   * @throws AuthAccessError with existing authentication failure semantics; an oversized name is capacity,
   * while an invalid deployment limit is account-unavailable. No route, generation or account readiness is published.
   */
  authenticateForBootstrap(
    request: IncomingMessage, requestId: Branded<'pe-request-id'>, maxDisplayNameBytes: number,
  ): Promise<Readonly<{ principal: AuthenticatedPrincipal; account: CloudBootstrap['account'] }>> {
    if (!Number.isSafeInteger(maxDisplayNameBytes) || maxDisplayNameBytes <= 0) {
      throw new AuthAccessError('cloud/account-unavailable', requestId)
    }
    return this.authenticateAndProject(request, requestId, (login, principal) => {
      const displayName = login.user.name
      if (displayName.length > maxDisplayNameBytes || Buffer.byteLength(displayName, 'utf8') > maxDisplayNameBytes) {
        throw new AuthAccessError('cloud/capacity', requestId)
      }
      return Object.freeze({ principal, account: Object.freeze({ id: principal.accountId, displayName }) })
    })
  }

  private authenticateAndProject<T>(
    request: IncomingMessage, requestId: Branded<'pe-request-id'>,
    project: (login: LibraryLogin, principal: AuthenticatedPrincipal) => T,
    transport: 'management' | 'service-preview' = 'management',
  ): Promise<T> {
    const headers = this.trustedHeaders(request, requestId, transport)
    return this.withDeadline(async (ordinal) => {
      const login = await this.readLogin(headers, ordinal, requestId)
      const principal: AuthenticatedPrincipal = Object.freeze({
        accountId: login.user.id as AccountId,
        authSessionId: login.session.id as Branded<'pe-auth-session-id'>,
      })
      const result = project(login, principal)
      const state = this.loginState(login, requestId)
      this.principals.set(principal, { headers, verifiedAtMs: performance.now(), state })
      return result
    }, requestId)
  }

  /**
   * Recheck a previously authenticated login using its captured cookie, never a later browser cookie.
   * @param principal - Exact object previously returned by this adapter.
   * @param requestId - Server-generated correlation id.
   * @throws AuthAccessError on expiry, revocation, capacity, failure or timeout.
   * Admitted verification failure invokes the login invalidator. A Peer watcher must run within sessionRecheckMs
   * and close its exact Peer on every rejection, including admission/capacity denial; the owning ingress registry schedules it.
   */
  async recheckLogin(principal: AuthenticatedPrincipal, requestId: Branded<'pe-request-id'>): Promise<void> {
    if (!this.accepting) throw new AuthAccessError('cloud/account-unavailable', requestId)
    const record = this.record(principal, requestId)
    await this.withDeadline(async (ordinal) => {
      const login = await this.readLogin(record.headers, ordinal, requestId)
      if (login.user.id !== principal.accountId || login.session.id !== principal.authSessionId || record.state.invalidated) {
        throw new AuthAccessError('cloud/unauthenticated', requestId)
      }
      record.state = this.loginState(login, requestId)
      record.verifiedAtMs = performance.now()
    }, requestId, async () => {
      record.state.invalidated = true
      await this.invalidateLogin(principal.authSessionId, record.state)
    })
  }

  /**
   * Synchronously stop dispatch when the original login is expired or awaits a fresh DB recheck.
   * @param principal - Exact object previously returned by this adapter.
   * @param requestId - Server-generated correlation id.
   * @throws AuthAccessError until a due recheck completes; success does not replace AccountUse.assertCurrent.
   */
  assertLoginCurrent(principal: AuthenticatedPrincipal, requestId: Branded<'pe-request-id'>): void {
    const record = this.record(principal, requestId)
    if (record.state.expiresAtMs <= Date.now()) throw new AuthAccessError('cloud/unauthenticated', requestId)
    if (!this.accepting || performance.now() - record.verifiedAtMs >= this.config.sessionRecheckMs) {
      throw new AuthAccessError('cloud/account-unavailable', requestId)
    }
  }

  /**
   * Revoke an internal login id through Better Auth's own adapter and deletion hooks.
   * @param authSessionId - Trusted server-side authentication session id; not an account or DSH SessionId.
   * @param requestId - Server-generated correlation id.
   * @throws AuthAccessError when deletion cannot be confirmed; no Agent task is cancelled here.
   */
  revokeLogin(authSessionId: Branded<'pe-auth-session-id'>, requestId: Branded<'pe-request-id'>): Promise<void> {
    return this.withDeadline(async () => {
      this.reserveInvalidation(authSessionId)
      const context = await this.auth.$context
      const session = await context.adapter.findOne<Session>({ model: 'session', where: [{ field: 'id', value: authSessionId }] })
      if (session !== null) await context.internalAdapter.deleteSession(session.token)
      // Deletion hooks cover successful library deletions; absence still closes any retained login Peer.
      if (session === null) await this.invalidateLogin(authSessionId)
    }, requestId)
  }

  /**
   * Delegate /cloud/auth and descendants to Better Auth's Node bridge with the original body.
   * @param request - Node request, before any general JSON parser consumes it.
   * @param response - Node response owned by the library bridge.
   * @param requestId - Server-generated correlation id.
   * @param limits - Optional internal caller byte limit and observer signal; production ingress always supplies both.
   * @throws AuthAccessError before delegation on trust/path failure; caller owns partial-response containment.
   */
  async handleNodeRequest(
    request: IncomingMessage, response: ServerResponse, requestId: Branded<'pe-request-id'>,
    limits?: AuthNodeLimits,
  ): Promise<void> {
    const headers = this.trustedHeaders(request, requestId)
    const url = new URL(request.url ?? '/', this.config.publicOrigin)
    if (url.origin !== this.config.publicOrigin || (url.pathname !== '/cloud/auth' && !url.pathname.startsWith('/cloud/auth/'))) {
      throw new AuthAccessError('cloud/forbidden', requestId)
    }
    if (!this.accepting || limits?.signal.aborted === true) throw new AuthAccessError('cloud/account-unavailable', requestId)
    const actual = this.transferNodeRequest(request, response, requestId, headers, url, limits)
    this.bridges.add(actual)
    try { await actual } finally { this.bridges.delete(actual) }
  }

  /**
   * Obtain the library-generated migration plan without running it or hand-writing authentication DDL.
   * @param requestId - Server-generated deployment operation correlation id.
   * @returns Better Auth's own executable/SQL compilation plan; the caller owns executing that plan.
   * @throws Error when DB inspection or a safe migration plan is unavailable.
   */
  async planMigrations(requestId: Branded<'pe-request-id'>): Promise<Awaited<ReturnType<typeof import('better-auth/db/migration')['getMigrations']>>> {
    return this.withDeadline(async () => {
      const { getMigrations } = await import('better-auth/db/migration')
      return getMigrations(this.options)
    }, requestId)
  }

  /** Stop new auth work and await actual library settlement; the caller still owns the PG pool. */
  async close(): Promise<void> {
    this.accepting = false
    await Promise.allSettled([...this.bridges, ...this.pending.keys()])
  }

  private async transferNodeRequest(
    request: IncomingMessage, response: ServerResponse, requestId: Branded<'pe-request-id'>, headers: Headers, url: URL,
    limits: AuthNodeLimits | undefined,
  ): Promise<void> {
    let input: TrackedBody | undefined
    let output: TrackedBody | undefined
    const transferred = Promise.withResolvers<void>()
    const cancelBodies = async (): Promise<void> => {
      const results = await Promise.allSettled([input?.cancel(), output?.cancel()])
      if (results.some(result => result.status === 'rejected')) throw new AuthAccessError('cloud/stop-unconfirmed', requestId)
    }
    const onClosed = (): void => {
      transferred.resolve()
      void cancelBodies().catch((_error: unknown) => {
        // The actual bridge below joins these same original reader cancellations and exposes their safe failure.
      })
    }
    const onAbort = (): void => {
      request.destroy()
      if (!response.writableEnded) response.destroy()
      onClosed()
    }
    response.once('finish', onClosed)
    response.once('close', onClosed)
    response.once('error', onAbort)
    limits?.signal.addEventListener('abort', onAbort, { once: true })
    const handler = this.node.toNodeHandler(async (incoming) => {
      const signal = limits === undefined ? incoming.signal : AbortSignal.any([incoming.signal, limits.signal])
      const init: RequestInit & { duplex: 'half' } = { method: incoming.method, headers, signal, duplex: 'half' }
      if (incoming.body !== null) {
        input = trackBody(incoming.body, limits?.maxBodyBytes, requestId)
        init.body = input.stream
      }
      let result: Response
      let received: Response | undefined
      const discard = async (value: Response): Promise<void> => {
        try { await value.body?.cancel() }
        catch (_error) { throw new AuthAccessError('cloud/stop-unconfirmed', requestId) }
      }
      try {
        result = await this.withDeadline(async () => {
          const current = (): void => {
            signal.throwIfAborted()
            const invocation = this.invocation.getStore()
            if (!this.accepting || invocation?.timedOut === true) {
              throw new AuthAccessError('cloud/account-unavailable', requestId)
            }
            if (invocation?.failure !== undefined) throw new AuthAccessError(invocation.failure, requestId)
            limits?.assertCurrent?.()
          }
          current()
          const path = url.pathname.replace(/\/+$/, '')
          if (incoming.method === 'POST' && (path === '/cloud/auth/sign-in/email' || path === '/cloud/auth/sign-up/email')) {
            // A stale presented session cookie also needs explicit sign-out: a late old-tab request cannot start a replacement.
            const presented = getSessionCookie(headers) !== null
            const login = await this.auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
            current()
            if (login !== null || presented) throw new AuthAccessError('cloud/login-active', requestId)
          }
          current()
          const result = await this.auth.handler(new Request(url, init))
          try { current() } catch (error) { await discard(result); throw error }
          limits?.assertCurrent?.()
          return result
        }, requestId)
        received = result
        limits?.assertCurrent?.()
        const failure = input?.failure ?? (result.status === 429 ? new AuthAccessError('cloud/capacity', requestId)
          : result.status >= 500 ? new AuthAccessError('cloud/account-unavailable', requestId) : undefined)
        if (failure !== undefined) {
          await discard(result)
          received = undefined
          limits?.assertCurrent?.()
          result = this.errorResponse(failure)
        }
      } catch (error) {
        if (error instanceof AuthAccessError && error.code === 'cloud/stop-unconfirmed') throw error
        if (received !== undefined) await discard(received)
        result = this.errorResponse(this.failure(error, requestId))
      }
      if (result.body === null) return result
      output = trackBody(result.body, undefined, requestId)
      return new Response(output.stream, { status: result.status, statusText: result.statusText, headers: result.headers })
    })
    try {
      await handler(request, response)
      // The pinned Node bridge starts response pumping before its Promise returns.
      await transferred.promise
      await cancelBodies()
      await Promise.all([input?.settled, output?.settled])
    } catch (error) {
      request.destroy()
      response.destroy()
      await cancelBodies()
      throw this.failure(error, requestId)
    } finally {
      response.off('finish', onClosed)
      response.off('close', onClosed)
      response.off('error', onAbort)
      limits?.signal.removeEventListener('abort', onAbort)
    }
  }

  private record(principal: AuthenticatedPrincipal, requestId: Branded<'pe-request-id'>): LoginCheck {
    const record = this.principals.get(principal)
    if (record === undefined || record.state.invalidated) throw new AuthAccessError('cloud/unauthenticated', requestId)
    return record
  }

  private trustedHeaders(
    request: IncomingMessage, requestId: Branded<'pe-request-id'>, transport: 'management' | 'service-preview' = 'management',
  ): Headers {
    const secure = 'encrypted' in request.socket && request.socket.encrypted === true
    assertAuthTransport(request.headers, request.rawHeaders, request.socket.remoteAddress, secure, this.config, requestId,
      transport === 'service-preview' ? { kind: 'service-preview', method: request.method, url: request.url } : 'http')
    const headers = this.node.fromNodeHeaders(request.headers)
    for (const name of [...headers.keys()]) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip' || name === 'x-pe-auth-remote-ip') headers.delete(name)
    }
    const address = request.socket.remoteAddress
    if (address !== undefined && isIP(address) !== 0) headers.set('x-pe-auth-remote-ip', address)
    return headers
  }

  private async readLogin(headers: Headers, ordinal: bigint, requestId: Branded<'pe-request-id'>): Promise<LibraryLogin> {
    const login = await this.auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (login === null || login.session.userId !== login.user.id || login.user.id === '' || login.session.id === ''
      || !Number.isFinite(login.session.expiresAt.getTime()) || login.session.expiresAt.getTime() <= Date.now()) {
      throw new AuthAccessError('cloud/unauthenticated', requestId)
    }
    const id = login.session.id as Branded<'pe-auth-session-id'>
    const knownFence = this.logins.get(id)?.fenceOrdinal
    const unknownFence = this.invalidationFences.get(id)
    if ((knownFence !== undefined && ordinal <= knownFence) || (unknownFence !== undefined && ordinal <= unknownFence)) {
      throw new AuthAccessError('cloud/unauthenticated', requestId)
    }
    return login
  }

  private async invalidateLogin(authSessionId: Branded<'pe-auth-session-id'>, originalState?: LoginState): Promise<void> {
    const state = this.logins.get(authSessionId) ?? originalState
    if (state !== undefined) {
      state.invalidated = true
      state.fenceOrdinal = this.ordinal
    } else {
      this.reserveInvalidation(authSessionId)
    }
    try { await this.onLoginInvalidated(authSessionId) }
    catch (error) {
      const invocation = this.invocation.getStore()
      if (invocation !== undefined) invocation.failure = 'cloud/account-unavailable'
      throw error
    }
  }

  private async withDeadline<T>(
    operation: (ordinal: bigint) => Promise<T>, requestId: Branded<'pe-request-id'>, onFailure?: () => Promise<void>,
  ): Promise<T> {
    if (!this.accepting) throw new AuthAccessError('cloud/account-unavailable', requestId)
    if (this.pending.size >= this.config.maxAuthOperations) throw new AuthAccessError('cloud/capacity', requestId)
    const ordinal = ++this.ordinal
    const actualStatus: { settled: boolean } = { settled: false }
    const invocation: AuthInvocation = { requestId, failure: undefined, timedOut: false }
    const actual = Promise.resolve().then(() => this.invocation.run(invocation, async () => {
      const result = await operation(ordinal)
      // Better Auth sign-out may contain deletion errors; a failed cloud hook cannot become a successful response.
      if (invocation.failure !== undefined) throw new AuthAccessError(invocation.failure, invocation.requestId)
      return result
    }))
    void actual.then(() => { actualStatus.settled = true }, () => { actualStatus.settled = true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        invocation.timedOut = true
        reject(new AuthAccessError('cloud/account-unavailable', requestId))
      }, this.config.authCheckTimeoutMs)
    })
    const waited = Promise.race([actual, timeout]).catch(async (error: unknown) => {
      await onFailure?.()
      throw this.failure(error, requestId)
    }).finally(() => { clearTimeout(timer) })
    const completion: Promise<void> = Promise.allSettled([actual, waited]).then(() => {
      this.pending.delete(completion)
      this.pruneInvalidations()
    })
    this.pending.set(completion, ordinal)
    try {
      const result = await waited
      await completion
      return result
    } catch (error) {
      if (actualStatus.settled) await completion
      throw this.failure(error, requestId)
    }
  }

  private failure(error: unknown, requestId: Branded<'pe-request-id'>): AuthAccessError {
    if (error instanceof this.apiError && error.statusCode === 429) return new AuthAccessError('cloud/capacity', requestId)
    return error instanceof AuthAccessError ? error : new AuthAccessError('cloud/account-unavailable', requestId)
  }

  private reserveInvalidation(id: Branded<'pe-auth-session-id'>): void {
    const known = this.logins.get(id)
    if (known !== undefined) { known.fenceOrdinal = this.ordinal; return }
    if (!this.invalidationFences.has(id) && this.invalidationFences.size >= this.config.maxAuthInvalidations) {
      const invocation = this.invocation.getStore()
      if (invocation !== undefined) invocation.failure = 'cloud/capacity'
      throw this.apiError.from('TOO_MANY_REQUESTS', { code: 'cloud/capacity', message: 'Authentication invalidation capacity is full.' })
    }
    this.invalidationFences.set(id, this.ordinal)
  }

  private loginState(login: LibraryLogin, requestId: Branded<'pe-request-id'>): LoginState {
    this.pruneInvalidations()
    for (const state of this.logins.values()) {
      if (!state.invalidated && state.fenceOrdinal === undefined && state.expiresAtMs <= Date.now()) this.removeLogin(state)
    }
    const id = login.session.id as Branded<'pe-auth-session-id'>
    const accountId = login.user.id as AccountId
    let existing = this.logins.get(id)
    const fenceOrdinal = existing?.fenceOrdinal
    if (existing?.invalidated === true) { this.removeLogin(existing); existing = undefined }
    if (existing !== undefined) {
      if (existing.accountId !== accountId) throw new AuthAccessError('cloud/unauthenticated', requestId)
      existing.expiresAtMs = login.session.expiresAt.getTime()
      return existing
    }
    const accountCount = this.accountLoginCounts.get(accountId) ?? 0
    if (this.logins.size >= this.config.maxTrackedLogins || accountCount >= this.config.maxTrackedLoginsPerAccount) {
      throw new AuthAccessError('cloud/capacity', requestId)
    }
    const state: LoginState = { id, accountId, expiresAtMs: login.session.expiresAt.getTime(), invalidated: false, fenceOrdinal }
    this.logins.set(id, state)
    this.accountLoginCounts.set(accountId, accountCount + 1)
    return state
  }

  private removeLogin(state: LoginState): void {
    if (this.logins.get(state.id) !== state) return
    this.logins.delete(state.id)
    const count = (this.accountLoginCounts.get(state.accountId) ?? 1) - 1
    if (count === 0) this.accountLoginCounts.delete(state.accountId)
    else this.accountLoginCounts.set(state.accountId, count)
  }

  private pruneInvalidations(): void {
    let minimum: bigint | undefined
    for (const ordinal of this.pending.values()) if (minimum === undefined || ordinal < minimum) minimum = ordinal
    for (const [id, fence] of this.invalidationFences) {
      if (minimum === undefined || minimum > fence) this.invalidationFences.delete(id)
    }
    for (const state of this.logins.values()) {
      if (state.fenceOrdinal === undefined || (minimum !== undefined && minimum <= state.fenceOrdinal)) continue
      if (state.invalidated) this.removeLogin(state)
      else state.fenceOrdinal = undefined
    }
  }

  private errorResponse(error: AuthAccessError): Response {
    return Response.json(error.toJSON(), { status: error.status })
  }
}
