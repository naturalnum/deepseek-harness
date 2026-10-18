/** Package-private shared-Web ingress; actual recipe and native transport prerequisites remain authoritative. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { CloudAccountApi, CloudApiError } from '@deepseek-ai/dsh-pe-cloud-api'
import { AccountRuntimeError } from '@deepseek-ai/dsh-pe-cloud-runtime'
import type { AccountId, AccountRuntimeService, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'
import { assertAuthTransport } from './auth-trust.ts'
import { assertExpectedAccount, assertExpectedGeneration, RequestBindingError } from './binding.ts'
import { readRequestExpectation } from './expectation.ts'
import { ConnectionGenerations } from './generations.ts'
import { LoginPeerRegistry, type LoginPeer } from './peers.ts'
import type { AuthIngressConfig } from './root-config.ts'
import type { AccessConfig, AuthenticatedPrincipal, RequestExpectation, IngressObservation } from './types.ts'

type RequestId = Branded<'pe-request-id'>
interface Dependencies {
  readonly web: WebServer
  readonly runtime: AccountRuntimeService
  readonly recipeVersion: string
  readonly assertAuthenticationCurrent: () => void
}
interface Operation {
  readonly id: RequestId
  readonly request: IncomingMessage
  readonly response: ServerResponse | undefined
  readonly socket: Duplex | undefined
  readonly observer: AbortController
  readonly transferred: Promise<void>
  actual: Promise<void>
  accountId: AccountId | undefined
  timedOut: boolean
  upgraded: boolean
  use: AccountUse | undefined
  releaseFault: boolean
  cleanupUnknown: boolean
}

/** Actual route owner; only PeAuthService constructs this outside same-package tests. */
export class CloudIngress {
  private readonly generations: ConnectionGenerations
  private readonly peers: LoginPeerRegistry
  private readonly operations = new Set<Operation>()
  private readonly accountCounts = new Map<AccountId, number>()
  private readonly peerGenerations = new WeakMap<LoginPeer, Branded<'pe-connection-generation'>>()
  private readonly requests = new WeakMap<IncomingMessage, { operation: Operation; expected: RequestExpectation }>()
  private readonly unregister: Array<() => void | Promise<void>> = []
  private readonly registrations = new Set<object>()
  private state: IngressObservation['state'] = 'prepared'
  private accepting = false
  private closing: Promise<void> | undefined

  /**
   * @param ctx Owning access fiber; account graphs never receive this root Context.
   * @param config Fixed origin, carrier fields and existing Peer limits.
   * @param limits Explicit root ingress limits.
   * @param auth Original private library adapter, never returned to consumers.
   * @param dependencies Actual shared Web/runtime providers and resource-owner check.
   */
  constructor(
    private readonly ctx: Context, private readonly config: AccessConfig, private readonly limits: AuthIngressConfig,
    private readonly auth: BetterAuthAccess, private readonly dependencies: Dependencies,
  ) {
    this.generations = new ConnectionGenerations(dependencies.runtime, limits.maxGenerationBindings)
    this.peers = new LoginPeerRegistry(config, auth, {
      streams: limits,
      borrow: (binding) => {
        this.assertCurrent(this.requestId())
        return dependencies.runtime.borrowAccount(binding)
      },
      beforeHttp: (request, peer) => {
        const id = this.requestId()
        this.assertPeer(peer, id)
        this.assertRequest(request, peer, id)
      },
      beforeDispatch: (request, dispatch, peer) => {
        const id = this.requestId()
        this.assertPeer(peer, id)
        this.assertRequest(request, peer, id)
        const api = this.accountApi(peer.peer.ctx, peer.binding)
        if (dispatch.kind === 'rpc') api.requireRpc(dispatch.endpoint)
        else api.requireFetch(dispatch.method, dispatch.pathname)
        this.assertPeer(peer, id)
      },
      beforeStream: (endpoint, peer) => {
        const id = this.requestId()
        try {
          this.assertPeer(peer, id)
          this.accountApi(peer.peer.ctx, peer.binding).requireStream(endpoint)
          this.assertPeer(peer, id)
        } catch (error) { throw this.failure(error, id) }
      },
      cleanupFailed: (failure) => { this.ctx.logger.error('Cloud login Peer cleanup is unconfirmed: %j', failure) },
    })
  }

  /** Register only after the resource owner's real library schema inspection; seal is checked per invocation. */
  async install(): Promise<void> {
    if (this.accepting || this.closing !== undefined) throw new AuthAccessError('cloud/account-unavailable', this.requestId())
    try {
      this.state = 'installing'
      const routes: WebRoute[] = [
        { kind: 'prefix', path: '/cloud/auth', handler: (req, res) => this.handleHttp(req, res) },
        { kind: 'exact', path: '/cloud/bootstrap', handler: (req, res) => this.handleHttp(req, res) },
        { kind: 'exact', path: '/cloud/settings', handler: (req, res) => this.handleHttp(req, res) },
        { kind: 'prefix', path: API_PATH, handler: (req, res) => this.handleHttp(req, res) },
      ]
      for (const route of routes) {
        this.register(() => this.dependencies.web.register(route), 'pe-cloud-access: shared HTTP route')
      }
      this.register(() => this.dependencies.web.registerUpgrade({
        path: REMOTE_STREAM_MUX_PATH, handler: (req, socket, head) => this.handleUpgrade(req, socket, head),
      }), 'pe-cloud-access: shared native upgrade route')
      this.accepting = true
      this.state = 'installed'
    } catch (_error) {
      // Registration details can contain deployment paths; only retained cleanup and this fixed error escape.
      await this.closeActual()
      throw new AuthAccessError('cloud/account-unavailable', this.requestId())
    }
  }

  /**
   * Close the exact original login through the sole registry, including revocation invoked by a carrier read.
   * @param loginId Original verified login id.
   * @returns Known native resource cleanup; full closure separately joins carrier/auth work.
   */
  invalidateLogin(loginId: AuthenticatedPrincipal['authSessionId']): Promise<void> { return this.peers.invalidateLogin(loginId) }

  /** @returns Actual registrations, owner/Web identity and operation counts; never calls assertRecipeSealed. */
  observe(): IngressObservation {
    const web = this.ctx.get('webServer')
    const original = (value: object): object => {
      const target: unknown = Reflect.get(value, symbols.original)
      return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
    }
    return Object.freeze({
      state: this.state,
      current: this.state === 'installed' && this.accepting && this.registrations.size === 5
        && this.ctx.fiber.state === FiberState.ACTIVE && web !== undefined && original(web) === original(this.dependencies.web),
      registeredRoutes: this.registrations.size, pendingOperations: this.operations.size,
    })
  }

  /** Stop admission synchronously, unregister routes and join all actual ingress/Peer work before auth/pool close. */
  closeActual(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.accepting = false
    if (this.state !== 'unknown') this.state = 'closing'
    const removals = this.unregister.splice(0).map(remove => Promise.resolve().then(remove))
    for (const operation of this.operations) {
      operation.observer.abort()
      operation.request.destroy()
      operation.response?.destroy()
      operation.socket?.destroy()
    }
    this.closing = (async () => {
      const results = await Promise.allSettled([
        ...removals, ...[...this.operations].map(operation => operation.actual), this.peers.closeActual(),
      ])
      if (this.state === 'unknown' || this.registrations.size !== 0 || results.some(result => result.status === 'rejected')) {
        this.state = 'unknown'
        throw new AuthAccessError('cloud/stop-unconfirmed', this.requestId())
      }
      this.generations.close()
      this.state = 'closed'
    })()
    return this.closing
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    return this.run(request, response, undefined, async (operation) => {
      const url = this.url(request, operation.id)
      this.assertTransport(request, operation.id, 'http')
      this.assertOperation(operation)
      if (url.pathname === '/cloud/auth' || url.pathname.startsWith('/cloud/auth/')) {
        await this.auth.handleNodeRequest(request, response, operation.id, {
          maxBodyBytes: this.limits.maxAuthRequestBodyBytes, signal: operation.observer.signal,
          assertCurrent: () => { this.assertOperation(operation) },
        })
        this.assertCurrent(operation.id)
        return
      }
      if (url.pathname === '/cloud/bootstrap' && request.method === 'GET') {
        const verified = await this.auth.authenticateForBootstrap(request, operation.id, this.limits.maxBootstrapResponseBytes)
        this.assertOperation(operation)
        this.bindAccount(operation, verified.principal.accountId)
        await this.withAccount(operation, verified.principal, undefined, (use) => {
          this.accountApi(use.context, use.binding).assertInstalled(use.context)
          this.generations.current(use.binding, operation.id)
          // No actual approved catalog/capability projection is installed yet; never manufacture a successful C11 body.
          return Promise.reject(new AuthAccessError('cloud/account-unavailable', operation.id))
        })
        return
      }
      if (url.pathname === API_PATH || url.pathname.startsWith(API_PATH + '/')) {
        const principal = await this.auth.authenticate(request, operation.id)
        this.assertOperation(operation)
        const expected = readRequestExpectation(request, url, this.config.bindingFields, 'headers', operation.id)
        assertExpectedAccount(expected, principal.accountId, operation.id)
        this.requests.set(request, { operation, expected })
        this.bindAccount(operation, principal.accountId)
        await this.withAccount(operation, principal, expected, async (use) => {
          const peer = await this.peers.acquire(principal, use.binding, Date.now() + this.limits.requestTimeoutMs,
            operation.observer.signal, operation.id)
          this.assertOperation(operation)
          this.pinGeneration(peer, operation.id)
          await this.peers.handleNodeRequest(peer, request, response, this.limits.maxRequestBodyBytes, operation.id)
          this.assertCurrent(operation.id)
        })
        return
      }
      // C06 settings requires its exclusive save/reconfiguration owner, never an ordinary AccountUse callback.
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    })
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.run(request, undefined, socket, async (operation) => {
      this.assertTransport(request, operation.id, 'websocket')
      this.assertOperation(operation)
      const principal = await this.auth.authenticate(request, operation.id)
      this.assertOperation(operation)
      const expected = readRequestExpectation(request, this.url(request, operation.id), this.config.bindingFields, 'query', operation.id)
      assertExpectedAccount(expected, principal.accountId, operation.id)
      this.bindAccount(operation, principal.accountId)
      await this.withAccount(operation, principal, expected, async (use) => {
        const peer = await this.peers.acquire(principal, use.binding, Date.now() + this.limits.requestTimeoutMs,
          operation.observer.signal, operation.id)
        this.assertOperation(operation)
        this.pinGeneration(peer, operation.id)
        await this.peers.handleUpgrade(peer, request, socket, head, operation.id)
        operation.upgraded = true
        this.assertOperation(operation)
        this.releaseUse(operation)
      })
    })
  }

  private async withAccount(
    operation: Operation, principal: AuthenticatedPrincipal,
    expected: Parameters<typeof assertExpectedGeneration>[0] | undefined, consume: (use: AccountUse) => Promise<void>,
  ): Promise<void> {
    await this.dependencies.runtime.locateAccount(principal.accountId)
    this.assertOperation(operation)
    const use = await this.dependencies.runtime.acquireAccount(principal.accountId, operation.observer.signal)
    // The actual ingress operation owns even a late borrow through response/error transfer settlement.
    operation.use = use
    this.assertOperation(operation)
    this.auth.assertLoginCurrent(principal, operation.id)
    use.assertCurrent()
    if (use.binding.accountId !== principal.accountId || use.binding.recipeVersion !== this.dependencies.recipeVersion) {
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    }
    const generation = this.generations.current(use.binding, operation.id)
    if (expected !== undefined) assertExpectedGeneration(expected, generation, operation.id)
    await consume(use)
    this.assertCurrent(operation.id)
    if (!operation.upgraded) use.assertCurrent()
  }

  private run(
    request: IncomingMessage, response: ServerResponse | undefined, socket: Duplex | undefined,
    consume: (operation: Operation) => Promise<void>,
  ): Promise<void> {
    const id = this.requestId()
    if (!this.accepting || this.operations.size >= this.limits.maxOperations) {
      // No waiting record is allocated when admission is closed or full.
      response?.destroy()
      socket?.destroy()
      request.destroy()
      return Promise.resolve()
    }
    const observer = new AbortController()
    const transferred = new Promise<void>((resolve) => {
      const done = (): void => {
        response?.off('finish', done)
        response?.off('close', done)
        response?.off('error', failed)
        socket?.off('close', done)
        observer.abort()
        resolve()
      }
      const failed = (): void => { response?.destroy(); done() }
      if (response !== undefined) {
        response.once('finish', done)
        response.once('close', done)
        response.once('error', failed)
      } else socket?.once('close', done)
      if (response?.destroyed === true || response?.writableFinished === true || socket?.destroyed === true) done()
    })
    const operation: Operation = {
      id, request, response, socket, observer, transferred, actual: Promise.resolve(), accountId: undefined,
      timedOut: false, upgraded: false, use: undefined, releaseFault: false, cleanupUnknown: false,
    }
    const timedOut = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      if (operation.upgraded) return
      operation.timedOut = true
      observer.abort()
      this.sendFailure(operation, new AuthAccessError('cloud/account-unavailable', id))
      timedOut.resolve()
    }, this.limits.requestTimeoutMs)
    this.operations.add(operation)
    operation.actual = Promise.resolve().then(async () => {
      try { await consume(operation) }
      catch (error) {
        if (error instanceof AuthAccessError && error.code === 'cloud/stop-unconfirmed') {
          operation.cleanupUnknown = true
          this.state = 'unknown'
          this.accepting = false
          this.ctx.logger.error('Cloud ingress body cleanup is unconfirmed; admission remains closed.')
        }
        this.sendFailure(operation, error)
      }
      finally {
        await transferred
        request.destroy()
        clearTimeout(timer)
        if (operation.cleanupUnknown) throw new AuthAccessError('cloud/stop-unconfirmed', operation.id)
        this.releaseUse(operation)
        this.operations.delete(operation)
        this.requests.delete(request)
        if (operation.accountId !== undefined) {
          const count = (this.accountCounts.get(operation.accountId) ?? 1) - 1
          if (count === 0) this.accountCounts.delete(operation.accountId)
          else this.accountCounts.set(operation.accountId, count)
        }
      }
    })
    return Promise.race([operation.actual, timedOut.promise])
  }

  private bindAccount(operation: Operation, accountId: AccountId): void {
    this.assertOperation(operation)
    const count = this.accountCounts.get(accountId) ?? 0
    if (count >= this.limits.maxOperationsPerAccount) throw new AuthAccessError('cloud/capacity', operation.id)
    operation.accountId = accountId
    this.accountCounts.set(accountId, count + 1)
  }

  private sendFailure(operation: Operation, error: unknown): void {
    const failure = this.failure(error, operation.id)
    const body = JSON.stringify(failure.toJSON())
    const response = operation.response
    if (response !== undefined) {
      if (response.destroyed || response.writableEnded) return
      if (response.headersSent) { response.destroy(); return }
      response.writeHead(failure.status, {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body), connection: 'close',
      })
      response.end(body)
    } else {
      if (operation.socket?.destroyed === true) return
      if (operation.upgraded) { operation.socket?.destroy(); return }
      operation.socket?.end(`HTTP/1.1 ${failure.status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => { operation.socket?.destroy() })
    }
  }

  private failure(error: unknown, id: RequestId): AuthAccessError | RequestBindingError {
    if (error instanceof RequestBindingError || error instanceof AuthAccessError) return error
    else if (error instanceof CloudApiError || error instanceof AccountRuntimeError) {
      return error.code === 'cloud/stale-generation' ? new RequestBindingError(id)
        : error.code === 'cloud/capacity' ? new AuthAccessError('cloud/capacity', id)
          : error.code === 'cloud/forbidden' ? new AuthAccessError('cloud/forbidden', id)
            : error.code === 'cloud/stop-unconfirmed' ? new AuthAccessError('cloud/stop-unconfirmed', id)
              : new AuthAccessError('cloud/account-unavailable', id)
    }
    return new AuthAccessError('cloud/account-unavailable', id)
  }

  private releaseUse(operation: Operation): void {
    if (operation.releaseFault) throw new AuthAccessError('cloud/stop-unconfirmed', operation.id)
    try {
      operation.use?.release()
      operation.use = undefined
    } catch (_error) {
      this.state = 'unknown'
      this.accepting = false
      operation.releaseFault = true
      this.ctx.logger.error('Cloud ingress borrow cleanup is unconfirmed; admission remains closed.')
      throw new AuthAccessError('cloud/stop-unconfirmed', operation.id)
    }
  }

  private assertCurrent(id: RequestId): void {
    if (!this.observe().current) throw new AuthAccessError('cloud/account-unavailable', id)
    this.ctx.fiber.assertActive()
    this.dependencies.runtime.assertRecipeSealed(this.dependencies.recipeVersion)
    this.dependencies.assertAuthenticationCurrent()
  }

  private assertOperation(operation: Operation): void {
    this.assertCurrent(operation.id)
    if (operation.timedOut || operation.observer.signal.aborted) throw new AuthAccessError('cloud/account-unavailable', operation.id)
  }

  private assertTransport(request: IncomingMessage, id: RequestId, transport: 'http' | 'websocket'): void {
    const secure = 'encrypted' in request.socket && request.socket.encrypted === true
    assertAuthTransport(request.headers, request.rawHeaders, request.socket.remoteAddress, secure, this.config, id, transport)
  }

  private url(request: IncomingMessage, id: RequestId): URL {
    try {
      const url = new URL(request.url ?? '/', this.config.publicOrigin)
      if (url.origin !== this.config.publicOrigin) throw new Error()
      return url
    } catch (_error) { throw new AuthAccessError('cloud/forbidden', id) }
  }

  private accountApi(context: Context, binding: AccountUse['binding']): CloudAccountApi {
    const api = context.get('peCloudApi')
    if (!(api instanceof CloudAccountApi) || api.binding.accountId !== binding.accountId || api.binding.epoch !== binding.epoch
      || api.binding.recipeVersion !== binding.recipeVersion || api.binding.lifetime !== binding.lifetime) {
      throw new AuthAccessError('cloud/account-unavailable', this.requestId())
    }
    api.assertInstalled(context)
    return api
  }

  private pinGeneration(peer: LoginPeer, id: RequestId): void {
    const generation = this.generations.current(peer.binding, id)
    const previous = this.peerGenerations.get(peer)
    if (previous !== undefined && previous !== generation) throw new AuthAccessError('cloud/account-unavailable', id)
    this.peerGenerations.set(peer, generation)
  }

  private assertPeer(peer: LoginPeer, id: RequestId): void {
    this.assertCurrent(id)
    this.peers.assertCurrent(peer, id)
    const generation = this.peerGenerations.get(peer)
    if (generation === undefined || generation !== this.generations.current(peer.binding, id)) {
      throw new RequestBindingError(id)
    }
  }

  private assertRequest(request: IncomingMessage, peer: LoginPeer, id: RequestId): void {
    const entry = this.requests.get(request)
    if (entry === undefined) throw new AuthAccessError('cloud/account-unavailable', id)
    this.assertOperation(entry.operation)
    assertExpectedAccount(entry.expected, peer.principal.accountId, id)
    assertExpectedGeneration(entry.expected, this.generations.current(peer.binding, id), id)
  }

  private register(acquire: () => () => void, label: string): void {
    const token = {}
    this.unregister.push(this.ctx.effect(() => {
      const remove = acquire()
      this.registrations.add(token)
      return () => {
        try { remove(); this.registrations.delete(token) }
        catch (_error) {
          this.state = 'unknown'
          throw new AuthAccessError('cloud/stop-unconfirmed', this.requestId())
        }
      }
    }, label))
  }

  private requestId(): RequestId { return randomUUID() as RequestId }
}
