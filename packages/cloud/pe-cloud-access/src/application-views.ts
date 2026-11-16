/** Finite service-preview credentials retaining the original Better Auth principal, never an execution capability. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedPrincipal } from './types.ts'
import type { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'
import type { ServicePreviewIdentity } from '@deepseek-ai/dsh-pe-opensandbox/types'

type RequestId = AuthAccessError['requestId']
type Authentication = Pick<BetterAuthAccess,
  'retainPrincipal' | 'releasePrincipal' | 'retainedPrincipalBytes' | 'recheckLogin' | 'assertLoginCurrent'>

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
  phase: 'prepared' | 'authorizing' | 'ready' | 'closing' | 'closed'
  closing?: Promise<void>
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
    const view: View = { id, proof, cookie, principal, selection, bytes, lifetime, onAbort, timer,
      deadlineAtMs: performance.now() + this.limits.lifetimeMs, actual: new Set(), controller: new AbortController(), phase: 'prepared' }
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
    view.lifetime.removeEventListener('abort', view.onAbort)
    const completion = Promise.withResolvers<void>()
    view.closing = completion.promise
    view.controller.abort(new Error('Application preview credential closed.'))
    void (async () => {
      while (view.actual.size > 0) await Promise.allSettled([...view.actual])
      this.auth.releasePrincipal(view.principal)
      this.views.delete(id)
      const remaining = (this.counts.get(view.principal.accountId) ?? 1) - 1
      if (remaining === 0) this.counts.delete(view.principal.accountId)
      else this.counts.set(view.principal.accountId, remaining)
      this.retainedBytes -= view.bytes
      view.phase = 'closed'
    })().then(completion.resolve, completion.reject)
    return view.closing
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
   * @returns After all original view users settle; it does not stop or release execution work.
   */
  async closeActual(): Promise<void> {
    this.open = false
    await Promise.all([...this.views.keys()].map(id => this.close(id)))
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
    return { signal: view.controller.signal, retainActual: (actual) => { this.track(view, actual) }, assertCurrent: () => {
      this.assertCurrent(view, requestId)
      this.auth.assertLoginCurrent(view.principal, requestId)
    } }
  }

  private track(view: View, actual: Promise<unknown>): void {
    view.actual.add(actual)
    void actual.then(() => { view.actual.delete(actual) }, (_error: unknown) => { view.actual.delete(actual) })
  }
}
