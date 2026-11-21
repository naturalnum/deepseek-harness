/** Finite service-preview credentials retaining the original Better Auth principal, never an execution capability. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedPrincipal } from './types.ts'
import type { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'
import type { ServicePreviewIdentity } from '@deepseek-ai/dsh-pe-opensandbox/types'

type RequestId = AuthAccessError['requestId']
type Authentication = Pick<BetterAuthAccess,
  'retainPrincipal' | 'releasePrincipal' | 'retainedPrincipalBytes' | 'recheckLogin' | 'assertLoginCurrent'>
const firstRetirementRetryMs = 1000
const maximumRetirementRetryMs = 30_000

/** Required Root bounds for the credential owner; these do not enlarge command or HTTP execution capacity. */
export interface ApplicationViewLimits {
  readonly maxViews: number
  readonly maxViewsPerAccount: number
  readonly maxRetainedBytes: number
  readonly maxFieldBytes: number
  readonly lifetimeMs: number
}

/** A bounded private launch proof; only its non-secret id may enter Browser URLs or saved tab state. */
export interface ApplicationViewGrant {
  readonly id: string
  readonly proof: string
  readonly expiresInSeconds: number
}

/** Immutable selection carried by a preview credential; original request owners must authorize it on every use. */
export interface ApplicationViewSelection {
  readonly service: ServicePreviewIdentity
  readonly accountId: AuthenticatedPrincipal['accountId']
  readonly connectionGeneration: string
}

/** Original credential lifetime rechecked by the actual ingress before forwarding or committing a response. */
export interface ApplicationViewUse {
  readonly signal: AbortSignal
  /** @returns After this original credential and login remain current; grants no account or service authority. */
  assertCurrent(): void
  /** @param actual Original ingress authentication/transfer/Use release terminal, never an early observation deadline. */
  retainActual(actual: Promise<void>): void
  /** Join private renderer retirement after the original view's active requests have settled. */
  retireWith(retire: () => Promise<void>): void
}

interface View {
  readonly id: string
  readonly proof: string
  readonly cookie: string
  readonly principal: AuthenticatedPrincipal
  readonly selection: ApplicationViewSelection
  readonly deadlineAtMs: number
  readonly bytes: number
  readonly lifetime: AbortSignal
  readonly onAbort: () => void
  readonly actual: Set<Promise<unknown>>
  readonly controller: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  readonly terminal: PromiseWithResolvers<void>
  phase: 'prepared' | 'authorizing' | 'ready' | 'closing' | 'closed'
  closing?: Promise<void>
  retryTimer?: ReturnType<typeof setTimeout>
  retryDelayMs: number
  retire?: () => Promise<void>
}

function equalSecret(received: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(received)
    && timingSafeEqual(Buffer.from(received, 'ascii'), Buffer.from(expected, 'ascii'))
}

/** Authentication-scoped preview grants; service allocation, request admission and physical release remain with existing owners. */
export class ServiceApplicationViews {
  private readonly views = new Map<string, View>()
  private readonly counts = new Map<AuthenticatedPrincipal['accountId'], number>()
  private retainedBytes = 0
  private open = true

  /** @param auth Original Root authentication adapter.
   * @param limits Root-validated finite credential bounds. */
  constructor(private readonly auth: Authentication, private readonly limits: ApplicationViewLimits) {}

  /**
   * Retain only the original verified login after its caller has authorized the current service selection.
   * @param principal Original authentication object, still owned by the issuing request.
   * @param service Original authorized Session/service selectors; they supply no later execution authority.
   * @param connectionGeneration Original issuing page generation.
   * @param lifetime Original registered service lifetime; never a browser-controlled signal.
   * @param requestId Original issuing request id.
   * @returns Private one-use launch proof and public host id; neither may be reported as HTTP readiness.
   */
  issue(principal: AuthenticatedPrincipal, service: ServicePreviewIdentity, connectionGeneration: string,
    lifetime: AbortSignal, requestId: RequestId): ApplicationViewGrant {
    this.auth.assertLoginCurrent(principal, requestId)
    if (!this.open || lifetime.aborted || service.accountId !== principal.accountId) throw new AuthAccessError('cloud/account-unavailable', requestId)
    for (const value of [principal.accountId, service.sessionId, service.serviceId,
      service.allocationId, String(service.epoch), connectionGeneration]) {
      if (Buffer.byteLength(value) > this.limits.maxFieldBytes) throw new AuthAccessError('cloud/capacity', requestId)
    }
    const selection = Object.freeze({ accountId: principal.accountId, connectionGeneration,
      service: Object.freeze({ ...service }) })
    const bytes = 4096 + 8 * (Buffer.byteLength(JSON.stringify(selection)) + this.auth.retainedPrincipalBytes(principal, requestId))
    if (this.views.size >= this.limits.maxViews || (this.counts.get(principal.accountId) ?? 0) >= this.limits.maxViewsPerAccount
      || this.retainedBytes + bytes > this.limits.maxRetainedBytes) throw new AuthAccessError('cloud/capacity', requestId)
    const id = randomBytes(16).toString('hex'), proof = randomBytes(32).toString('hex'), cookie = randomBytes(32).toString('hex')
    this.auth.retainPrincipal(principal, requestId)
    const onAbort = (): void => { void this.close(id).catch((_error: unknown) => {
      console.error('Cloud application preview retirement unconfirmed.')
    }) }
    const timer = setTimeout(onAbort, this.limits.lifetimeMs)
    const terminal = Promise.withResolvers<void>()
    void terminal.promise.catch((_failure: unknown) => { /* Root joins permanent cleanup failures on the original view. */ })
    const view: View = { id, proof, cookie, principal, selection, bytes, lifetime, onAbort, timer,
      deadlineAtMs: performance.now() + this.limits.lifetimeMs, actual: new Set(), controller: new AbortController(),
      phase: 'prepared', terminal, retryDelayMs: firstRetirementRetryMs }
    this.views.set(id, view)
    this.counts.set(principal.accountId, (this.counts.get(principal.accountId) ?? 0) + 1)
    this.retainedBytes += bytes
    lifetime.addEventListener('abort', onAbort, { once: true })
    if (lifetime.aborted) { onAbort(); throw new AuthAccessError('cloud/account-unavailable', requestId) }
    return { id, proof, expiresInSeconds: Math.floor(this.limits.lifetimeMs / 1000) }
  }

  /**
   * Consume a launch proof once; Root validates the fixed management Origin before calling.
   * @param id Public view hostname id.
   * @param proof Private proof received in a bounded POST body, never a URL.
   * @param requestId Original authorization request.
   * @param send Actual Set-Cookie response transfer, joined before the credential becomes ready.
   * @returns Actual response settlement; a failed handoff permanently closes this grant without replay.
   */
  async authorize(id: string, proof: string, requestId: RequestId,
    send: (cookie: string, expiresInSeconds: number, use: ApplicationViewUse) => Promise<void>): Promise<void> {
    const view = this.current(id, requestId)
    if (view.phase !== 'prepared' || !equalSecret(proof, view.proof)) throw new AuthAccessError('cloud/unauthenticated', requestId)
    view.phase = 'authorizing'
    const actual = this.authenticated(view, requestId, async () => {
      await send(view.cookie, Math.max(1, Math.floor((view.deadlineAtMs - performance.now()) / 1000)), this.use(view, requestId))
      this.assertCurrent(view, requestId)
      view.phase = 'ready'
    })
    this.track(view, actual)
    try { await actual }
    catch (error) { void this.close(id).catch((_cleanup: unknown) => {
      console.error('Cloud application preview retirement unconfirmed.')
    }); throw error }
  }

  /**
   * Authenticate a host-only credential while the original service request owner performs all business admission.
   * @param id Exact public view hostname id.
   * @param cookie Private host-only preview cookie.
   * @param requestId Original application request id.
   * @param consume Actual account/service/HTTP/response settlement, not an early deadline result.
   * @returns Actual consumer settlement; independent underlying unknown work remains with its original owner.
   */
  async withCredential(id: string, cookie: string, requestId: RequestId,
    consume: (principal: AuthenticatedPrincipal, selection: ApplicationViewSelection, use: ApplicationViewUse) => Promise<void>,
  ): Promise<void> {
    const view = this.current(id, requestId)
    if (view.phase !== 'ready' || !equalSecret(cookie, view.cookie)) throw new AuthAccessError('cloud/unauthenticated', requestId)
    const actual = this.authenticated(view, requestId, () => consume(view.principal, view.selection, this.use(view, requestId)))
    this.track(view, actual)
    await actual
  }

  /**
   * Run one view operation under the same management login that opened the view.
   * @param id Exact retained view id.
   * @param login Authenticated management login for this request.
   * @param requestId Original viewer request id.
   * @param consume Operation using the retained service binding and its revocation signal.
   * @returns Settlement of the admitted operation.
   */
  async withLogin(id: string, login: AuthenticatedPrincipal, requestId: RequestId,
    consume: (selection: ApplicationViewSelection, use: ApplicationViewUse) => Promise<void>,
  ): Promise<void> {
    const view = this.current(id, requestId)
    if (view.phase !== 'ready' || login.authSessionId !== view.principal.authSessionId || login.accountId !== view.principal.accountId) {
      throw new AuthAccessError('cloud/unauthenticated', requestId)
    }
    this.auth.assertLoginCurrent(login, requestId)
    const actual = this.authenticated(view, requestId, () => consume(view.selection, this.use(view, requestId)))
    this.track(view, actual)
    await actual
  }

  /**
   * Identify the active service binding for a Close request from the original login.
   * @param id Exact view being closed.
   * @param login Current request's authenticated login.
   * @param requestId Original close request id.
   * @returns The original service binding for an active view, or undefined for an already revoked view.
   */
  activeCloseSelection(id: string, login: AuthenticatedPrincipal, requestId: RequestId): ApplicationViewSelection | undefined {
    const view = this.ownedForClose(id, login, requestId)
    if (view.phase === 'ready' && !view.lifetime.aborted && performance.now() < view.deadlineAtMs) return view.selection
  }

  /**
   * Revoke the original login's view and request retirement of its resources.
   * @param id Exact view being closed.
   * @param login Current request's authenticated login.
   * @param requestId Original close request id.
   * @returns Retirement of the original login's view, including retries while it still holds quota.
   */
  closeForLogin(id: string, login: AuthenticatedPrincipal, requestId: RequestId): Promise<void> {
    this.ownedForClose(id, login, requestId)
    return this.close(id)
  }

  private ownedForClose(id: string, login: AuthenticatedPrincipal, requestId: RequestId): View {
    const view = this.views.get(id)
    if (!this.open || view === undefined || view.phase !== 'ready' && view.phase !== 'closing'
      || login.authSessionId !== view.principal.authSessionId || login.accountId !== view.principal.accountId) {
      throw new AuthAccessError('cloud/unauthenticated', requestId)
    }
    this.auth.assertLoginCurrent(login, requestId)
    return view
  }

  /**
   * Inspect bounded credential ownership without exposing authentication data.
   * @returns Only finite counts; no host id, selector, proof, cookie or underlying error is exposed.
   */
  observe(): { views: number; retainedBytes: number } { return { views: this.views.size, retainedBytes: this.retainedBytes } }

  /**
   * Revoke this view immediately and retain its original principal through actual users.
   * @param id Original public view id.
   * @returns After actual authentication and response users settle and its principal borrow releases.
   */
  close(id: string): Promise<void> {
    const view = this.views.get(id)
    if (view === undefined) return Promise.resolve()
    if (view.closing !== undefined) return view.closing
    view.phase = 'closing'
    clearTimeout(view.timer)
    clearTimeout(view.retryTimer)
    delete view.retryTimer
    view.lifetime.removeEventListener('abort', view.onAbort)
    const completion = Promise.withResolvers<void>()
    view.closing = completion.promise
    view.controller.abort(new Error('Application preview credential closed.'))
    void (async () => {
      while (view.actual.size > 0) await Promise.allSettled([...view.actual])
      try { await view.retire?.() }
      catch (error) {
        // Revocation and quota stay in force. Only the original retirement step may be retried.
        delete view.closing
        this.scheduleRetirement(view)
        completion.reject(error)
        return
      }
      this.auth.releasePrincipal(view.principal)
      this.views.delete(id)
      const remaining = (this.counts.get(view.principal.accountId) ?? 1) - 1
      if (remaining === 0) this.counts.delete(view.principal.accountId)
      else this.counts.set(view.principal.accountId, remaining)
      this.retainedBytes -= view.bytes
      view.phase = 'closed'
      view.terminal.resolve()
      completion.resolve()
    })().catch((error: unknown) => {
      // An unknown principal release is different from a missing renderer receipt and is never replayed.
      view.terminal.reject(error)
      completion.reject(error)
    })
    return completion.promise
  }

  private scheduleRetirement(view: View): void {
    view.retryTimer = setTimeout(() => {
      delete view.retryTimer
      void this.close(view.id).catch((_failure: unknown) => { /* The same view owns its next retry or terminal fault. */ })
    }, view.retryDelayMs)
    if (this.open) view.retryTimer.unref()
    view.retryDelayMs = Math.min(view.retryDelayMs * 2, maximumRetirementRetryMs)
  }

  /**
   * Revoke admission synchronously from the original login invalidator without waiting on its own in-flight query.
   * @param authSessionId Original library login id, never a browser-selected account id.
   */
  invalidateLogin(authSessionId: AuthenticatedPrincipal['authSessionId']): void {
    for (const view of this.views.values()) if (view.principal.authSessionId === authSessionId) {
      void this.close(view.id).catch((_error: unknown) => { console.error('Cloud application preview retirement unconfirmed.') })
    }
  }

  /**
   * Close view admission and join every original credential user.
   * @returns The original terminal drain, including bounded retries for missing renderer receipts.
   */
  async closeActual(): Promise<void> {
    this.open = false
    const results = await Promise.allSettled([...this.views.values()].map((view) => {
      void this.close(view.id).catch((_failure: unknown) => { /* The terminal includes retries and permanent faults. */ })
      return view.terminal.promise
    }))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }

  private current(id: string, requestId: RequestId): View {
    const view = this.views.get(id)
    if (view === undefined) throw new AuthAccessError('cloud/unauthenticated', requestId)
    this.assertCurrent(view, requestId)
    return view
  }

  private assertCurrent(view: View, requestId: RequestId): void {
    if (!this.open || view.phase === 'closing' || view.phase === 'closed' || view.lifetime.aborted
      || performance.now() >= view.deadlineAtMs) throw new AuthAccessError('cloud/unauthenticated', requestId)
  }

  private async authenticated(view: View, requestId: RequestId, consume: () => Promise<void>): Promise<void> {
    await this.auth.recheckLogin(view.principal, requestId, actual => this.track(view, actual))
    this.assertCurrent(view, requestId)
    this.auth.assertLoginCurrent(view.principal, requestId)
    await consume()
  }

  private use(view: View, requestId: RequestId): ApplicationViewUse {
    return { signal: view.controller.signal, retainActual: (actual) => { this.track(view, actual) }, retireWith: (retire) => {
      this.assertCurrent(view, requestId)
      if (view.retire !== undefined) throw new AuthAccessError('cloud/forbidden', requestId)
      view.retire = retire
    }, assertCurrent: () => {
      this.assertCurrent(view, requestId)
      this.auth.assertLoginCurrent(view.principal, requestId)
    } }
  }

  private track(view: View, actual: Promise<unknown>): void {
    view.actual.add(actual)
    void actual.then(() => { view.actual.delete(actual) }, (_error: unknown) => { view.actual.delete(actual) })
  }
}
