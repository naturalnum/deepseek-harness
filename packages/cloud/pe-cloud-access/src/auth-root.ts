/** Root-owned Better Auth resources; no request route opens without the separate root admission audit. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Branded } from '@deepseek-ai/dsh-brand'
import pg from 'pg'
import { ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'
import { parseAuthRootConfig, type AuthRootConfig } from './root-config.ts'
import { CloudIngress } from './ingress.ts'
import { OwnerRouting } from './owner-routing.ts'
import type { IngressObservation } from './types.ts'
import type { AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { ConfigurationPeerOperation } from './peers.ts'

import { assertAuthSchemaCurrent } from './auth-schema.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    peAuth: PeAuthService
  }
}

/** Safe resource observation; initialized authentication never certifies account or request admission. */
export interface AuthRootObservation {
  readonly phase: 'starting' | 'initialized' | 'failed' | 'closing' | 'closed'
  readonly requestAdmission: 'closed'
  readonly pendingSecrets: number
  readonly pendingAuthentication: number
  readonly poolAllocated: boolean
  readonly ingress?: IngressObservation
}

/** Owns one finite authentication pool and its actual secret/library work, without publishing raw resources. */
export class PeAuthService extends Service {
  private readonly requestId = randomUUID() as Branded<'pe-request-id'>
  private readonly secrets = new Set<Promise<string>>()
  private phase: AuthRootObservation['phase'] = 'starting'
  private pool: pg.Pool | undefined
  private auth: BetterAuthAccess | undefined
  private starting: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private ingress: CloudIngress | undefined
  private ingressFinal: IngressObservation | undefined
  private ownerRouting: OwnerRouting | undefined

  private constructor(ctx: Context, private readonly config: AuthRootConfig, private readonly credentials: CredentialProvider) {
    super(ctx, 'peAuth')
    const rootClose = ctx.root.effect(() => () => this.close(), 'pe-cloud-access: retain actual authentication resources')
    ctx.effect(() => async () => {
      try { await this.close() } finally { await rootClose() }
    }, 'pe-cloud-access: close authentication before releasing dependencies')
    if (config.ingress !== undefined) {
      if (ctx.get('peAccountRuntime') === undefined) throw new AuthAccessError('cloud/account-unavailable', this.requestId)
      const unregister = ctx.peAccountRuntime.registerIngressClose({ closeActual: () => this.close() })
      ctx.effect(() => () => unregister(), 'pe-cloud-access: withdraw actual Root ingress close owner')
    }
  }

  /**
   * Resolve official credentials, create the real pool/library and inspect deployed migrations.
   * Optional ingress registers on the existing Web service after schema inspection; the actual seal still gates every request.
   * @param ctx - Root Loader scope with the official credentials service.
   * @param config - Explicit Host database and operation budgets.
   * @returns The installed resource provider after a gap-free library schema inspection.
   * @throws AuthAccessError on missing credentials, timeout, schema gaps or DB/library failure. Cleanup remains retained.
   */
  static async mountRoot(ctx: Context, config: AuthRootConfig): Promise<PeAuthService> {
    const resolved = parseAuthRootConfig(config)
    const credentials = ctx.get('credentials')
    const requestId = randomUUID() as Branded<'pe-request-id'>
    if (credentials === undefined || ctx.get('peAuth') !== undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
    const service = new PeAuthService(ctx, resolved, credentials)
    service.starting = service.start()
    try {
      await service.wait(service.starting, resolved.startupTimeoutMs)
      return service
    } catch (_error) {
      // The caller sees a fixed error; actual startup and cleanup remain owned by the service effects.
      if (service.phase === 'starting') service.phase = 'failed'
      void service.close().catch(() => { ctx.logger.error('Cloud authentication cleanup is unconfirmed; admission remains closed.') })
      throw new AuthAccessError('cloud/account-unavailable', service.requestId)
    }
  }

  /**
   * Inspect bounded resource counts without exposing secrets, SQL, raw pools or a readiness certificate.
   * @returns A frozen snapshot; request admission stays closed independently of authentication initialization.
   */
  observe(): AuthRootObservation {
    return Object.freeze({
      phase: this.phase, requestAdmission: 'closed', pendingSecrets: this.secrets.size,
      pendingAuthentication: this.auth?.pendingOperations ?? 0, poolAllocated: this.pool !== undefined,
      ...this.config.ingress === undefined ? {} : { ingress: this.ingress?.observe() ?? this.ingressFinal ?? Object.freeze({
        state: 'absent' as const, current: false, registeredRoutes: 0, pendingOperations: 0,
      }) },
    })
  }

  /**
   * Inspect the original shared ingress's registered Root Fetch entries for trusted account preparation.
   * @returns Actual current registrations; this creates neither a route nor business admission.
   */
  inspectRootFetch(): readonly ExactFetchExposure[] {
    if (this.phase !== 'initialized' || this.ingress === undefined) throw new AuthAccessError('cloud/account-unavailable', this.requestId)
    return this.ingress.inspectRootFetch()
  }

  /**
   * Delegate one native model-key invocation through the original login registry.
   * @param peer Exact Gateway invocation Peer, never a client identity.
   * @param consume Actual native work using the original retained Use and current checks.
   * @returns Actual operation settlement; this service issues no additional borrow.
   */
  withModelKeyPeerUse<T>(peer: PeerScope, consume: (use: AccountUse, assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (this.phase !== 'initialized' || this.ingress === undefined) throw new AuthAccessError('cloud/account-unavailable', this.requestId)
    return this.ingress.withModelKeyPeerUse(peer, consume)
  }

  /** Delegate a guarded configuration handoff to the same original login/Peer owner.
   * @param peer Exact native invocation Peer.
   * @param consume Factory-owned exclusive update, without another login or state authority.
   * @param mode Explicit local idle operation or terminal acceptance followed by original full closure.
   * @returns Actual update settlement and fresh same-generation borrow restoration.
   */
  withConfigurationPeer<T>(peer: PeerScope, consume: ConfigurationPeerOperation<T>, mode: 'if-idle' | 'stop-and-apply' = 'if-idle'): Promise<T> {
    if (this.phase !== 'initialized' || this.ingress === undefined) throw new AuthAccessError('cloud/account-unavailable', this.requestId)
    return this.ingress.withConfigurationPeer(peer, consume, mode)
  }

  /**
   * Stop new secret/authentication work and join actual startup, library queries, secret reads and Pool.end.
   * Caller abandonment never ends the pool early. Repeated calls join the same cleanup; failure remains unconfirmed.
   * @returns Actual resource settlement, without a timer that could certify an early release.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.phase = 'closing'
    this.closing = this.finishClose().catch(() => { throw new AuthAccessError('cloud/stop-unconfirmed', this.requestId) })
    void this.ingress?.closeActual().catch((_error: unknown) => {
      // finishClose joins the same actual ingress barrier and reports its safe failure.
    })
    return this.closing
  }

  private async start(): Promise<void> {
    const forwarding = this.config.ingress?.ownerForwarding
    if (forwarding !== undefined) {
      this.ownerRouting = await OwnerRouting.prepare(forwarding, () => { this.assertStarting() })
      this.assertStarting()
    }
    const secret = await this.resolveSecret(this.config.authSecretRef, true)
    this.assertStarting()
    const limits = this.config.pool
    this.pool = new pg.Pool({
      host: this.config.database.host, port: this.config.database.port,
      user: this.config.database.user, database: this.config.database.database,
      password: () => this.resolveSecret(this.config.database.passwordRef, false),
      ssl: this.config.database.ssl ? { rejectUnauthorized: true } : false,
      max: limits.maxConnections, min: 0, connectionTimeoutMillis: limits.connectionTimeoutMs,
      idleTimeoutMillis: limits.idleTimeoutMs, maxLifetimeSeconds: limits.maxLifetimeSeconds,
      statement_timeout: limits.statementTimeoutMs, lock_timeout: limits.lockTimeoutMs,
      idle_in_transaction_session_timeout: limits.idleTransactionTimeoutMs,
      // A client query timer can settle before PostgreSQL stops work. The server statement timeout owns SQL cancellation.
      query_timeout: 0, application_name: 'pe-cloud-access', client_encoding: 'UTF8', options: '-c search_path=public',
    })
    this.pool.on('error', () => {
      if (this.phase === 'closed' || this.phase === 'closing') return
      this.phase = 'failed'
      this.ctx.logger.error('Cloud authentication database failed; admission remains closed.')
      void this.close().catch(() => { this.ctx.logger.error('Cloud authentication cleanup is unconfirmed; admission remains closed.') })
    })
    this.auth = await BetterAuthAccess.create(this.config, this.pool, secret, async (loginId) => {
      // Before optional ingress exists, no request route can have issued a Peer.
      await this.ingress?.invalidateLogin(loginId)
    })
    this.assertStarting()
    const plan = await this.auth.planMigrations(this.requestId)
    assertAuthSchemaCurrent(plan, this.requestId)
    this.assertStarting()
    if (this.config.ingress !== undefined) {
      const web = this.ctx.get('webServer'), runtime = this.ctx.get('peAccountRuntime'), exposure = this.ctx.get('peExposure')
      if (web === undefined || runtime === undefined || !(exposure instanceof ExposureService)) {
        throw new AuthAccessError('cloud/account-unavailable', this.requestId)
      }
      this.ingress = new CloudIngress(this.ctx, this.config, this.config.ingress, this.auth, {
        web, runtime, exposure, recipeVersion: exposure.policy.manifest.recipeVersion,
        assertAuthenticationCurrent: () => {
          if (this.phase !== 'initialized') throw new AuthAccessError('cloud/account-unavailable', this.requestId)
        },
        ...(this.ownerRouting === undefined ? {} : { ownerRouting: this.ownerRouting }),
      })
      await this.ingress.install()
      this.assertStarting()
    }
    this.phase = 'initialized'
  }

  private resolveSecret(reference: string, authenticationSecret: boolean): Promise<string> {
    if (this.phase !== 'starting' && this.phase !== 'initialized') return Promise.reject(new AuthAccessError('cloud/account-unavailable', this.requestId))
    if (this.secrets.size >= this.config.maxSecretOperations) return Promise.reject(new AuthAccessError('cloud/capacity', this.requestId))
    const actual = Promise.resolve().then(async () => {
      const resolved = await this.credentials.resolve(credentialRef(reference))
      const value = resolved?.value
      if (value === undefined || value.length === 0 || value.length > this.config.maxSecretBytes
        || Buffer.byteLength(value, 'utf8') > this.config.maxSecretBytes
        || (authenticationSecret && Buffer.byteLength(value, 'utf8') < 32)) {
        throw new AuthAccessError('cloud/account-unavailable', this.requestId)
      }
      return value
    })
    this.secrets.add(actual)
    void actual.then(() => { this.secrets.delete(actual) }, () => { this.secrets.delete(actual) })
    return this.wait(actual, this.config.secretResolveTimeoutMs)
      .catch(() => { throw new AuthAccessError('cloud/account-unavailable', this.requestId) })
  }

  private assertStarting(): void {
    if (this.phase !== 'starting') throw new AuthAccessError('cloud/account-unavailable', this.requestId)
  }

  private async finishClose(): Promise<void> {
    await Promise.allSettled([this.starting])
    await this.ingress?.closeActual()
    await this.ownerRouting?.closeActual()
    this.ingressFinal = this.ingress?.observe()
    await this.auth?.close()
    await Promise.allSettled([...this.secrets])
    await this.pool?.end()
    this.pool = undefined
    this.auth = undefined
    this.ingress = undefined
    this.ownerRouting = undefined
    this.phase = 'closed'
  }

  private async wait<T>(actual: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([actual, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new AuthAccessError('cloud/account-unavailable', this.requestId)) }, timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
}
