/** Package-private shared-Web ingress; actual recipe and native transport prerequisites remain authoritative. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { CloudAccountApi, CloudApiError, type ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { AccountRuntimeError } from '@deepseek-ai/dsh-pe-cloud-runtime'
import type { AccountId, AccountOwner, AccountRuntimeService, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { SESSION_LOG_EXPORT_PATH } from '@deepseek-ai/dsh-session-log-export'
import type { ConfigurationPeerOperation } from './peers.ts'
import { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'
import { assertAuthTransport } from './auth-trust.ts'
import { assertExpectedAccount, assertExpectedGeneration, RequestBindingError } from './binding.ts'
import { readRequestExpectation } from './expectation.ts'
import { ConnectionGenerations } from './generations.ts'
import { LoginPeerRegistry, type LoginPeer } from './peers.ts'
import { produceCloudBootstrap } from './bootstrap-producer.ts'
import { ExecutionStateError, withAccountApplicationService } from '@deepseek-ai/dsh-pe-opensandbox'
import { PreviewAccessError } from './preview-access.ts'
import { forwardInertPreview, PreviewResponseError } from './preview-response.ts'
import { SERVICE_PREVIEW_ROUTE, readServicePreviewSelection } from './preview-route.ts'
import type { ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api/types'
import { observeIngressTransfer } from './ingress-transfer.ts'
import type { AuthIngressConfig } from './root-config.ts'
import type { OwnerRouting } from './owner-routing.ts'
import { encodeOwnerHop, readOwnerHop, OWNER_HOP_HEADER, type OwnerHop } from './owner-hop.ts'
import type { ForwardTransfer } from './forward-types.ts'
import type { AccessConfig, AuthenticatedPrincipal, RequestExpectation, IngressObservation } from './types.ts'
import { cloudFailureSites } from './failure-sites.ts'

type RequestId = Branded<'pe-request-id'>
type GuardStage = 'run.start' | 'request.url' | 'request.transport' | 'ingress.current'
  | 'auth.handler' | 'auth.authenticate' | 'auth.login-current' | 'request.binding' | 'account.bind'
  | 'account.locate' | 'account.acquire' | 'account.use-current' | 'account.binding' | 'account.generation'
  | 'bootstrap.authenticate' | 'bootstrap.produce' | 'bootstrap.current' | 'bootstrap.transfer'
  | 'peer.acquire' | 'peer.generation' | 'peer.http' | 'peer.upgrade' | 'route.unsupported'
  | 'beforeHttp.peer' | 'beforeHttp.request' | 'beforeDispatch.peer' | 'beforeDispatch.request'
  | 'beforeDispatch.api' | 'beforeDispatch.peer-current' | 'native.invoke-or-transfer'
  | 'preview.authenticate' | 'preview.selection' | 'preview.borrow' | 'preview.forward' | 'preview.transfer'
  | 'owner.hop' | 'owner.resolve' | 'owner.borrow' | 'owner.forward' | 'owner.recheck'

const FAILURE_CODES: readonly string[] = Object.freeze([
  'cloud/unauthenticated', 'cloud/forbidden', 'cloud/login-active', 'cloud/account-unavailable',
  'cloud/account-starting', 'cloud/account-quarantined', 'cloud/stop-unconfirmed', 'cloud/capacity',
  'cloud/invalid-config', 'cloud/config-conflict', 'cloud/config-busy', 'cloud/stale-generation',
  'cloud/model-not-allowed', 'cloud/invalid-project-title',
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM',
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_HTTP_HEADERS_SENT', 'ABORT_ERR',
])

// Diagnostic reads never invoke error accessors or serialize an error object.
function errorData(value: unknown, key: 'code' | 'cause' | 'requestId'): unknown {
  if (value === null || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_error) { return undefined } // A proxy cannot make diagnostics replace the original failure.
}

function failureCode(value: unknown): string {
  const code = errorData(value, 'code')
  return typeof code === 'string' && code.length <= 48 && FAILURE_CODES.includes(code) ? code : 'unknown'
}

interface Dependencies {
  readonly web: WebServer
  readonly runtime: AccountRuntimeService
  readonly recipeVersion: string
  readonly exposure?: ExposureService
  readonly assertAuthenticationCurrent: () => void
  readonly ownerRouting?: OwnerRouting
}
interface Operation {
  readonly id: RequestId
  readonly request: IncomingMessage
  readonly response: ServerResponse | undefined
  readonly socket: Duplex | undefined
  readonly observer: AbortController
  readonly transferred: Promise<void>
  readonly deadlineAtMs: number
  readonly head: Buffer | undefined
  readonly authChecks: Set<Promise<void>>
  principal: AuthenticatedPrincipal | undefined
  hop: OwnerHop | undefined
  forwarding: boolean
  forwardTransfer: ForwardTransfer | undefined
  recheckTimer: ReturnType<typeof setTimeout> | undefined
  rechecking: Promise<void> | undefined
  holdNormalFinish: boolean
  actual: Promise<void>
  accountId: AccountId | undefined
  timedOut: boolean
  upgraded: boolean
  configurationUseReleased: boolean
  use: AccountUse | undefined
  releaseFault: boolean
  cleanupUnknown: boolean
  stage: GuardStage
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
  private previewRegistration: object | undefined
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
    this.peers = new LoginPeerRegistry({ ...config, sessionRecheckLeadMs: limits.sessionRecheckLeadMs }, auth, {
      streams: limits,
      borrow: (binding) => {
        this.assertCurrent(this.requestId())
        return dependencies.runtime.borrowAccount(binding)
      },
      beforeHttp: (request, peer) => {
        const id = this.requestId()
        this.requestStage(request, 'beforeHttp.peer')
        this.assertPeer(peer, id)
        this.requestStage(request, 'beforeHttp.request')
        this.assertRequest(request, peer, id)
        this.requestStage(request, 'peer.http')
      },
      beforeDispatch: (request, dispatch, peer) => {
        const id = this.requestId()
        this.requestStage(request, 'beforeDispatch.peer')
        this.assertPeer(peer, id)
        this.requestStage(request, 'beforeDispatch.request')
        this.assertRequest(request, peer, id)
        this.requestStage(request, 'beforeDispatch.api')
        const api = this.accountApi(peer.peer.ctx, peer.binding)
        if (dispatch.kind === 'rpc') api.requireRpc(dispatch.endpoint)
        else api.requireFetch(dispatch.method, dispatch.pathname)
        this.requestStage(request, 'beforeDispatch.peer-current')
        this.assertPeer(peer, id)
        this.requestStage(request, 'native.invoke-or-transfer')
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
      if (this.limits.servicePreview !== undefined) {
        if (this.config.servicePreview === undefined) throw new AuthAccessError('cloud/account-unavailable', this.requestId())
        this.previewRegistration = this.register(() => this.dependencies.web.register({ kind: 'exact',
          path: SERVICE_PREVIEW_ROUTE.path, handler: (req, res) => this.handleHttp(req, res) }),
        'pe-cloud-access: fixed isolated service preview')
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
  invalidateLogin(loginId: AuthenticatedPrincipal['authSessionId']): Promise<void> {
    for (const operation of this.operations) {
      if (operation.forwarding && operation.principal?.authSessionId === loginId) this.cancelForward(operation)
    }
    return this.peers.invalidateLogin(loginId)
  }

  /**
   * Consume the original ready login Entry for a model-key Gateway method.
   * @param peer Exact original invocation Peer.
   * @param consume Actual account operation; the existing Peer task set retains its settlement.
   * @returns Actual native settlement, with no additional AccountUse or release callback.
   */
  withModelKeyPeerUse<T>(peer: PeerScope, consume: (use: AccountUse, assertCurrent: () => void) => Promise<T>): Promise<T> {
    const id = this.requestId()
    this.assertCurrent(id)
    return this.peers.withOriginalUse(peer, (handle) => { this.assertPeer(handle, id) }, consume)
  }

  /** Use the original login owner for a factory-owned configuration handoff.
   * @param peer Exact invocation Peer.
   * @param consume Actual runtime update; receives only original trusted identities and closure/join callbacks.
   * @param mode Explicit local idle operation or terminal acceptance followed by original full closure.
   * @returns Actual result after the same generation's fresh Use is restored.
   */
  withConfigurationPeer<T>(peer: PeerScope, consume: ConfigurationPeerOperation<T>, mode: 'if-idle' | 'stop-and-apply' = 'if-idle'): Promise<T> {
    const id = this.requestId()
    this.assertCurrent(id)
    return this.peers.withConfigurationPeer(peer, (handle) => { this.assertPeer(handle, id) }, consume, mode)
  }

  /**
   * Inspect retained ingress state without opening business admission.
   * @returns Actual registrations, owner/Web identity and operation counts; never calls assertRecipeSealed.
   */
  observe(): IngressObservation {
    const web = this.ctx.get('webServer')
    const original = (value: object): object => {
      const target: unknown = Reflect.get(value, symbols.original)
      return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
    }
    return Object.freeze({
      state: this.state,
      current: this.state === 'installed' && this.accepting && this.registrations.size === (this.limits.servicePreview === undefined ? 5 : 6)
        && this.ctx.fiber.state === FiberState.ACTIVE && web !== undefined && original(web) === original(this.dependencies.web),
      registeredRoutes: this.registrations.size, pendingOperations: this.operations.size,
    })
  }

  /**
   * Inspect actual Root Fetch registrations without opening business admission or requiring the recipe seal.
   * @returns Only the fixed preview row while its original Web registration remains installed and current.
   */
  inspectRootFetch(): readonly ExactFetchExposure[] {
    if (!this.observe().current) throw new AuthAccessError('cloud/account-unavailable', this.requestId())
    if (this.limits.servicePreview === undefined) return Object.freeze([])
    if (this.previewRegistration === undefined || !this.registrations.has(this.previewRegistration)) {
      throw new AuthAccessError('cloud/account-unavailable', this.requestId())
    }
    return Object.freeze([SERVICE_PREVIEW_ROUTE])
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
        ...(this.dependencies.ownerRouting === undefined ? [] : [this.dependencies.ownerRouting.closeActual()]),
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
      operation.stage = 'request.url'
      const url = this.url(request, operation.id)
      operation.stage = 'request.transport'
      const preview = url.pathname === SERVICE_PREVIEW_ROUTE.path && this.limits.servicePreview !== undefined
      if (operation.hop !== undefined && !(preview || url.pathname === '/cloud/bootstrap' && request.method === 'GET'
        || url.pathname === API_PATH || url.pathname.startsWith(API_PATH + '/'))) throw new AuthAccessError('cloud/forbidden', operation.id)
      this.assertTransport(request, operation.id, preview ? { kind: 'service-preview', method: request.method, url: request.url } : 'http')
      operation.stage = 'ingress.current'
      this.assertOperation(operation)
      if (preview) { await this.handlePreview(operation, url); return }
      if (url.pathname === '/cloud/auth' || url.pathname.startsWith('/cloud/auth/')) {
        operation.stage = 'auth.handler'
        await this.auth.handleNodeRequest(request, response, operation.id, {
          maxBodyBytes: this.limits.maxAuthRequestBodyBytes, signal: operation.observer.signal,
          assertCurrent: () => { operation.stage = 'ingress.current'; this.assertOperation(operation); operation.stage = 'auth.handler' },
        })
        operation.stage = 'ingress.current'
        this.assertCurrent(operation.id)
        return
      }
      if (url.pathname === '/cloud/bootstrap' && request.method === 'GET') {
        operation.stage = 'bootstrap.authenticate'
        const verified = await this.auth.authenticateForBootstrap(request, operation.id, this.limits.maxBootstrapResponseBytes)
        operation.stage = 'ingress.current'
        this.assertOperation(operation)
        operation.stage = 'account.bind'
        this.bindAccount(operation, verified.principal.accountId)
        const recheckLogin = async (): Promise<void> => {
          operation.stage = 'bootstrap.current'
          await this.recheckOperationLogin(operation, verified.principal)
        }
        await this.withAccount(operation, verified.principal, undefined, async (use) => {
          const current = (): void => {
            operation.stage = 'bootstrap.current'
            this.assertOperation(operation)
            this.auth.assertLoginCurrent(verified.principal, operation.id)
            use.assertCurrent()
            const exposure = this.ctx.get('peExposure')
            if (exposure === undefined || this.dependencies.exposure === undefined
              || (Reflect.get(exposure, symbols.original) ?? exposure)
                !== (Reflect.get(this.dependencies.exposure, symbols.original) ?? this.dependencies.exposure)) {
              throw new AuthAccessError('cloud/account-unavailable', operation.id)
            }
          }
          operation.stage = 'bootstrap.produce'
          const projected = await produceCloudBootstrap(use.context, use.binding, this.dependencies.exposure,
            () => this.ctx.get('pluginPackages'),
            verified.account, this.limits.maxBootstrapResponseBytes,
            AbortSignal.any([operation.observer.signal, use.binding.lifetime]), current,
            () => this.generations.current(use.binding, operation.id), recheckLogin)
          await recheckLogin()
          projected.assertCurrent()
          current()
          operation.stage = 'bootstrap.transfer'
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
            'content-length': Buffer.byteLength(projected.body, 'utf8') })
          response.end(projected.body)
        }, undefined, recheckLogin)
        return
      }
      if (url.pathname === API_PATH || url.pathname.startsWith(API_PATH + '/')) {
        operation.stage = 'auth.authenticate'
        const principal = await this.auth.authenticate(request, operation.id)
        operation.stage = 'ingress.current'
        this.assertOperation(operation)
        operation.stage = 'request.binding'
        const fields = this.config.bindingFields
        const exportNavigation = request.method === 'GET' && url.pathname === SESSION_LOG_EXPORT_PATH
          && (url.searchParams.has(fields.accountQuery) || url.searchParams.has(fields.generationQuery))
        if (exportNavigation && request.rawHeaders.some((value, index) => index % 2 === 0
          && (value.toLowerCase() === fields.accountHeader || value.toLowerCase() === fields.generationHeader))) {
          throw new RequestBindingError(operation.id)
        }
        const expected = readRequestExpectation(request, url, fields, exportNavigation ? 'query' : 'headers', operation.id)
        assertExpectedAccount(expected, principal.accountId, operation.id)
        this.requests.set(request, { operation, expected })
        operation.stage = 'account.bind'
        this.bindAccount(operation, principal.accountId)
        await this.withAccount(operation, principal, expected, async (use) => {
          operation.stage = 'peer.acquire'
          const peer = await this.peers.acquire(principal, use.binding, Date.now() + this.limits.requestTimeoutMs,
            operation.observer.signal, operation.id)
          await this.recheckOperationLogin(operation, principal)
          operation.stage = 'ingress.current'
          this.assertOperation(operation)
          operation.stage = 'peer.generation'
          this.pinGeneration(peer, operation.id)
          operation.stage = 'peer.http'
          await this.peers.handleNodeRequest(peer, request, response, this.limits.maxRequestBodyBytes, operation.id, () => {
            this.assertOperation(operation)
            this.assertPeer(peer, operation.id)
            this.auth.assertLoginCurrent(principal, operation.id)
            use.assertCurrent()
            if (operation.use !== use || operation.configurationUseReleased) throw new AuthAccessError('cloud/account-unavailable', operation.id)
            this.releaseUse(operation)
            operation.configurationUseReleased = true
          }, operation.actual)
          operation.stage = 'ingress.current'
          this.assertCurrent(operation.id)
        })
        return
      }
      // C06 settings requires its exclusive save/reconfiguration owner, never an ordinary AccountUse callback.
      operation.stage = 'route.unsupported'
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    })
  }

  private async handlePreview(operation: Operation, url: URL): Promise<void> {
    const limits = this.limits.servicePreview, configured = this.config.servicePreview, response = operation.response
    const exposure = this.dependencies.exposure
    if (limits === undefined || configured === undefined || response === undefined || exposure === undefined) {
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    }
    operation.stage = 'preview.selection'
    const selected = readServicePreviewSelection(operation.request, this.config, limits, operation.id)
    operation.stage = 'preview.authenticate'
    const principal = await this.auth.authenticateServicePreview(operation.request, operation.id)
    this.assertOperation(operation)
    const expected = readRequestExpectation(operation.request, url, this.config.bindingFields, 'query', operation.id)
    assertExpectedAccount(expected, principal.accountId, operation.id)
    this.bindAccount(operation, principal.accountId)
    let canonical: LoginPeer | undefined
    const loginCurrent = (): void => {
      if (canonical === undefined) this.auth.assertLoginCurrent(principal, operation.id)
      else this.assertPeer(canonical, operation.id)
    }
    await this.withAccount(operation, principal, expected, async (use) => {
      operation.stage = 'peer.acquire'
      const peer = await this.peers.acquire(principal, use.binding, operation.deadlineAtMs,
        operation.observer.signal, operation.id)
      await this.recheckOperationLogin(operation, principal)
      this.assertOperation(operation)
      operation.stage = 'peer.generation'
      this.pinGeneration(peer, operation.id)
      canonical = peer
      operation.stage = 'peer.http'
      await this.peers.runCarrier(peer, operation.request, operation.id, {
        authenticate: () => this.auth.authenticateServicePreview(operation.request, operation.id),
        actual: operation.actual,
        destroy: () => {
          operation.observer.abort(new AuthAccessError('cloud/unauthenticated', operation.id))
          operation.request.destroy(); response.destroy()
        },
        consume: async () => {
          const api = this.accountApi(use.context, use.binding), manifest = exposure.policy.manifest
          const current = (): void => {
            this.assertOperation(operation); loginCurrent(); use.assertCurrent()
            assertExpectedAccount(expected, principal.accountId, operation.id)
            assertExpectedGeneration(expected, this.generations.current(use.binding, operation.id), operation.id)
            const currentApi = this.accountApi(use.context, use.binding)
            if ((Reflect.get(currentApi, symbols.original) ?? currentApi) !== (Reflect.get(api, symbols.original) ?? api)
              || exposure.policy.manifest !== manifest) {
              throw new AuthAccessError('cloud/account-unavailable', operation.id)
            }
            this.inspectRootFetch()
          }
          current()
          operation.stage = 'preview.borrow'
          await withAccountApplicationService(use.context, selected.selection, operation.observer.signal, operation.deadlineAtMs,
            async (service) => {
              current(); service.assertCurrent()
              operation.stage = 'preview.forward'
              await forwardInertPreview({ origin: configured.origin, method: 'GET', pathname: SERVICE_PREVIEW_ROUTE.path,
                scope: service.scope, resourcePath: '/', headers: selected.headers },
              { use, api, signal: operation.observer.signal, assertCurrent: current },
              { manifest, routePath: SERVICE_PREVIEW_ROUTE.path, handlerId: SERVICE_PREVIEW_ROUTE.handlerId,
                managementOrigin: this.config.publicOrigin, previewOrigin: configured.origin, allowedServicePorts: [8000],
                maxFieldBytes: limits.maxFieldBytes, maxResourceBytes: 1,
                maxHeaderCount: limits.maxRequestHeaderCount, maxHeaderBytes: limits.maxRequestHeaderBytes },
              { ...limits.response, mode: 'inert-text-v1' },
              { withRegisteredService: async (binding, selector, selectedManifest, signal, consume) => {
                current(); signal.throwIfAborted(); service.assertCurrent()
                if (binding !== use.binding || selectedManifest !== manifest
                  || selector.accountId !== service.scope.accountId || selector.epoch !== service.scope.epoch
                  || selector.sessionId !== service.scope.sessionId || selector.allocationId !== service.scope.allocationId
                  || selector.serviceId !== service.scope.serviceId) throw new AuthAccessError('cloud/forbidden', operation.id)
                await consume({ scope: service.scope, port: service.port, lifetime: service.lifetime, manifest,
                  assertCurrent: () => { current(); service.assertCurrent() },
                  withResponse: service.withResponse.bind(service) })
                current()
              } },
              { send: async (reply, signal, assertCurrent) => {
                assertCurrent(); signal.throwIfAborted(); operation.stage = 'preview.transfer'
                operation.holdNormalFinish = true
                response.writeHead(reply.status, reply.headers); response.end(reply.body)
                await operation.transferred
                assertCurrent(); signal.throwIfAborted()
              }, close: async () => {
                if (response.closed) return
                await new Promise<void>((resolve) => {
                  const closed = (): void => { response.off('close', closed); resolve() }
                  response.once('close', closed); response.destroy()
                  if (response.closed) closed()
                })
              } })
            })
        },
      })
    }, loginCurrent)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.run(request, undefined, socket, async (operation) => {
      operation.stage = 'request.transport'
      this.assertTransport(request, operation.id, 'websocket')
      operation.stage = 'ingress.current'
      this.assertOperation(operation)
      operation.stage = 'auth.authenticate'
      const principal = await this.auth.authenticate(request, operation.id)
      operation.stage = 'ingress.current'
      this.assertOperation(operation)
      operation.stage = 'request.binding'
      const expected = readRequestExpectation(request, this.url(request, operation.id), this.config.bindingFields, 'query', operation.id)
      assertExpectedAccount(expected, principal.accountId, operation.id)
      operation.stage = 'account.bind'
      this.bindAccount(operation, principal.accountId)
      await this.withAccount(operation, principal, expected, async (use) => {
        operation.stage = 'peer.acquire'
        const peer = await this.peers.acquire(principal, use.binding, Date.now() + this.limits.requestTimeoutMs,
          operation.observer.signal, operation.id)
        await this.recheckOperationLogin(operation, principal)
        operation.stage = 'ingress.current'
        this.assertOperation(operation)
        operation.stage = 'peer.generation'
        this.pinGeneration(peer, operation.id)
        operation.stage = 'peer.upgrade'
        await this.peers.handleUpgrade(peer, request, socket, head, operation.id)
        operation.upgraded = true
        operation.stage = 'ingress.current'
        this.assertOperation(operation)
        this.releaseUse(operation)
      })
    }, head)
  }

  private async withAccount(
    operation: Operation, principal: AuthenticatedPrincipal,
    expected: Parameters<typeof assertExpectedGeneration>[0] | undefined, consume: (use: AccountUse) => Promise<void>,
    loginCurrent: () => void = () => { this.auth.assertLoginCurrent(principal, operation.id) },
    recheckLogin: () => Promise<void> = () => this.recheckOperationLogin(operation, principal),
  ): Promise<void> {
    operation.stage = 'account.locate'
    operation.principal = principal
    const runtime = this.dependencies.runtime
    const located = await runtime.locateAccount(principal.accountId)
    operation.stage = 'ingress.current'
    this.assertOperation(operation)
    operation.stage = 'auth.login-current'
    await recheckLogin()
    loginCurrent()
    let use: AccountUse
    const hop = operation.hop, localInstanceId = runtime.activeInstanceId
    if (hop !== undefined) {
      if (located === undefined || localInstanceId === undefined || hop.accountId !== principal.accountId
        || hop.recipientInstanceId !== localInstanceId || hop.epoch !== located.epoch
        || hop.recipeVersion !== this.dependencies.recipeVersion || located.ownerInstanceId !== localInstanceId
        || located.accountId !== principal.accountId || located.recipeVersion !== hop.recipeVersion || located.phase !== 'ready') {
        throw new AuthAccessError('cloud/forbidden', operation.id)
      }
      operation.stage = 'owner.borrow'
      use = await runtime.borrowOwnedAccount(located)
    } else if (located !== undefined && located.ownerInstanceId !== null && located.ownerInstanceId !== localInstanceId) {
      if (located.phase !== 'ready') throw new AuthAccessError('cloud/account-unavailable', operation.id)
      await this.forwardOwner(operation, principal, located, loginCurrent, recheckLogin)
      return
    } else {
      operation.stage = 'account.acquire'
      use = await runtime.acquireAccount(principal.accountId, operation.observer.signal)
    }
    // The actual ingress operation owns even a late borrow through response/error transfer settlement.
    operation.use = use
    operation.stage = 'ingress.current'
    this.assertOperation(operation)
    operation.stage = 'auth.login-current'
    await recheckLogin()
    loginCurrent()
    operation.stage = 'account.use-current'
    use.assertCurrent()
    if (hop !== undefined && (runtime.activeInstanceId !== localInstanceId || use.binding.epoch !== hop.epoch)) {
      throw new AuthAccessError('cloud/forbidden', operation.id)
    }
    operation.stage = 'account.binding'
    if (use.binding.accountId !== principal.accountId || use.binding.recipeVersion !== this.dependencies.recipeVersion) {
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    }
    operation.stage = 'account.generation'
    const generation = this.generations.current(use.binding, operation.id)
    if (expected !== undefined) assertExpectedGeneration(expected, generation, operation.id)
    this.logOwner('local-admitted', operation, use.binding)
    await consume(use)
    operation.stage = 'ingress.current'
    this.assertCurrent(operation.id)
    operation.stage = 'auth.login-current'
    // Normal response completion ends the observer; the original settlement guard remains Root-current.
    await this.recheckOperationLogin(operation, principal, () => { this.assertCurrent(operation.id) })
    loginCurrent()
    operation.stage = 'account.use-current'
    if (!operation.upgraded) {
      if (operation.configurationUseReleased) this.dependencies.runtime.assertBusinessCurrent(use.binding)
      else use.assertCurrent()
    }
  }

  private async recheckOperationLogin(operation: Operation, principal: AuthenticatedPrincipal,
    current: () => void = () => { this.assertOperation(operation) }): Promise<void> {
    current()
    await this.auth.recheckLogin(principal, operation.id, (actual) => {
      operation.authChecks.add(actual)
      void actual.then(() => { operation.authChecks.delete(actual) }, () => { operation.authChecks.delete(actual) })
    })
    current()
    this.auth.assertLoginCurrent(principal, operation.id)
  }

  private run(
    request: IncomingMessage, response: ServerResponse | undefined, socket: Duplex | undefined,
    consume: (operation: Operation) => Promise<void>,
    head?: Buffer,
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
    const transferred = Promise.withResolvers<void>()
    const operation: Operation = {
      id, request, response, socket, observer, transferred: transferred.promise, actual: Promise.resolve(), accountId: undefined,
      deadlineAtMs: Date.now() + this.limits.requestTimeoutMs, holdNormalFinish: false,
      timedOut: false, upgraded: false, configurationUseReleased: false, use: undefined, releaseFault: false, cleanupUnknown: false,
      stage: 'run.start',
      head, authChecks: new Set(), principal: undefined, hop: undefined, forwarding: false, forwardTransfer: undefined,
      recheckTimer: undefined, rechecking: undefined,
    }
    observeIngressTransfer(operation, transferred.resolve)
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
      try {
        operation.stage = 'owner.hop'
        const routing = this.dependencies.ownerRouting
        if (routing !== undefined) {
          const limits = routing.config.limits
          const bytes = request.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value, 'latin1') + 2, 0)
          if (request.rawHeaders.length % 2 !== 0 || request.rawHeaders.length / 2 > limits.maxHeaderPairs
            || bytes > limits.maxHeaderBytes) {
            throw new AuthAccessError('cloud/capacity', id)
          }
        }
        operation.hop = readOwnerHop(request, routing?.peerPins ?? new Set(),
          routing?.config.maxHopBytes ?? this.limits.maxRequestBodyBytes, id)
        if (operation.hop !== undefined && (operation.hop.recipientInstanceId !== this.dependencies.runtime.activeInstanceId
          || operation.hop.recipeVersion !== this.dependencies.recipeVersion)) throw new AuthAccessError('cloud/forbidden', id)
        await consume(operation)
      }
      catch (error) {
        if (this.failure(error, id).code === 'cloud/stop-unconfirmed') {
          operation.cleanupUnknown = true
          this.state = 'unknown'
          this.accepting = false
          this.ctx.logger.error('Cloud ingress body cleanup is unconfirmed; admission remains closed.')
        }
        this.sendFailure(operation, error)
      }
      finally {
        operation.forwarding = false
        clearTimeout(operation.recheckTimer)
        if (operation.forwardTransfer !== undefined) {
          operation.forwardTransfer.cancel()
          await operation.forwardTransfer.settled
        }
        await operation.rechecking
        await Promise.allSettled([...operation.authChecks])
        await transferred.promise
        observer.abort()
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

  private async forwardOwner(
    operation: Operation, principal: AuthenticatedPrincipal, owner: AccountOwner, loginCurrent: () => void,
    recheckLogin: () => Promise<void>,
  ): Promise<void> {
    const routing = this.dependencies.ownerRouting, runtime = this.dependencies.runtime
    const resolver = runtime.ownerResolver, instanceId = runtime.activeInstanceId
    if (routing === undefined || resolver === undefined || instanceId === undefined) throw new AuthAccessError('cloud/account-unavailable', operation.id)
    operation.forwarding = true
    this.scheduleForwardRecheck(operation)
    const current = (): void => {
      this.assertOperation(operation); loginCurrent()
      if (runtime.activeInstanceId !== instanceId || runtime.ownerResolver !== resolver) throw new AuthAccessError('cloud/account-unavailable', operation.id)
    }
    current(); operation.stage = 'owner.resolve'
    const resolved = await resolver.resolve(principal.accountId)
    await recheckLogin()
    current()
    if (resolved.owner.accountId !== owner.accountId || resolved.owner.ownerInstanceId !== owner.ownerInstanceId
      || resolved.owner.epoch !== owner.epoch || resolved.owner.recipeVersion !== owner.recipeVersion || resolved.owner.phase !== 'ready') {
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    }
    const target = routing.target(principal.accountId, instanceId, this.dependencies.recipeVersion, resolved)
    const marker = encodeOwnerHop({ accountId: principal.accountId, recipientInstanceId: resolved.instance.instanceId,
      epoch: resolved.owner.epoch, recipeVersion: resolved.owner.recipeVersion }, routing.config.maxHopBytes, operation.id)
    this.logOwner('forward-selected', operation, resolved.owner)
    const common = { target, request: operation.request, lifetime: { signal: operation.observer.signal, assertCurrent: current },
      trustedRequestHeaders: [OWNER_HOP_HEADER, marker] }
    operation.holdNormalFinish = true
    operation.stage = 'owner.forward'
    if (operation.response !== undefined) {
      operation.forwardTransfer = routing.transport.forward({ ...common, kind: 'http', response: operation.response })
    } else if (operation.socket !== undefined && operation.head !== undefined) {
      operation.forwardTransfer = routing.transport.forward({ ...common, kind: 'upgrade', socket: operation.socket, head: operation.head,
        onUpgradeAccepted: () => { current(); operation.upgraded = true } })
    } else throw new AuthAccessError('cloud/account-unavailable', operation.id)
    const observed = await operation.forwardTransfer.result
    await this.recheckOperationLogin(operation, principal, () => { this.assertCurrent(operation.id) })
    this.assertCurrent(operation.id); loginCurrent()
    if (observed.status === 'unknown') {
      this.ctx.logger.error('Cloud owner forwarding closure is unconfirmed; no replay was attempted: %j',
        { requestId: operation.id, upstreamMayHaveReceived: observed.upstreamMayHaveReceived })
    }
    const terminal = await operation.forwardTransfer.settled
    await this.recheckOperationLogin(operation, principal, () => { this.assertCurrent(operation.id) })
    this.assertCurrent(operation.id); loginCurrent()
    if (terminal.status !== 'completed') {
      if (terminal.upstreamMayHaveReceived) {
        this.ctx.logger.error('Cloud owner forwarding failed after possible delivery; no replay was attempted: %j', { requestId: operation.id })
      }
      throw new AuthAccessError('cloud/account-unavailable', operation.id)
    }
    this.logOwner('forward-completed', operation, resolved.owner)
  }

  private logOwner(event: 'local-admitted' | 'forward-selected' | 'forward-completed', operation: Operation,
    owner: Pick<AccountOwner, 'accountId' | 'epoch' | 'recipeVersion'> & Partial<Pick<AccountOwner, 'ownerInstanceId'>>): void {
    try {
      const path = new URL(operation.request.url ?? '/', this.config.publicOrigin).pathname
      const socket = operation.request.socket
      const row = { event, pid: process.pid, requestId: operation.id,
        route: path === '/cloud/bootstrap' ? 'bootstrap' : path === REMOTE_STREAM_MUX_PATH ? 'native-mux'
          : path === SERVICE_PREVIEW_ROUTE.path ? 'service-preview' : 'native-http',
        instanceId: this.dependencies.runtime.activeInstanceId ?? null,
        ownerInstanceId: 'ownerInstanceId' in owner ? owner.ownerInstanceId ?? null : this.dependencies.runtime.activeInstanceId ?? null,
        accountId: owner.accountId, epoch: owner.epoch, recipeVersion: owner.recipeVersion,
        rootFiberUid: operation.use?.context.root.fiber.uid ?? null, internalHop: operation.hop !== undefined,
        remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null,
        localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null }
      if (Object.values(row).some(value => typeof value === 'string' && value.length > 256)) {
        this.ctx.logger.debug('Cloud owner request observation is unknown: identifier exceeds the log bound.')
        return
      }
      this.ctx.logger.debug('Cloud owner request observation: %j', row)
    } catch (_observationError) {
      try { this.ctx.logger.warn('Cloud owner request observation is unavailable; request state is unchanged.') }
      catch (_unavailableLogger) { /* Auth, actual transfer settlement and borrow release keep their original owner. */ }
    }
  }

  private scheduleForwardRecheck(operation: Operation): void {
    if (!operation.forwarding || operation.observer.signal.aborted) return
    operation.recheckTimer = setTimeout(() => {
      operation.recheckTimer = undefined
      if (!operation.forwarding || operation.observer.signal.aborted || operation.principal === undefined) return
      const principal = operation.principal
      operation.rechecking = (async () => {
        try {
          await this.recheckOperationLogin(operation, principal)
          this.scheduleForwardRecheck(operation)
        } catch (error) {
          this.cancelForward(operation)
          this.recordFailure(operation, error)
        }
      })()
    }, this.config.sessionRecheckMs - this.limits.sessionRecheckLeadMs)
  }

  private cancelForward(operation: Operation): void {
    operation.observer.abort()
    operation.forwardTransfer?.cancel()
    operation.request.destroy(); operation.response?.destroy(); operation.socket?.destroy()
  }

  private bindAccount(operation: Operation, accountId: AccountId): void {
    this.assertOperation(operation)
    const count = this.accountCounts.get(accountId) ?? 0
    if (count >= this.limits.maxOperationsPerAccount) throw new AuthAccessError('cloud/capacity', operation.id)
    operation.accountId = accountId
    this.accountCounts.set(accountId, count + 1)
  }

  private sendFailure(operation: Operation, error: unknown): void {
    this.recordFailure(operation, error)
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

  private requestStage(request: IncomingMessage, stage: GuardStage): void {
    const entry = this.requests.get(request)
    if (entry !== undefined) entry.operation.stage = stage
  }

  private recordFailure(operation: Operation, error: unknown): void {
    try {
      const cause = errorData(error, 'cause')
      const nested = errorData(cause, 'cause')
      const originalId = error instanceof AuthAccessError || error instanceof RequestBindingError
        ? errorData(error, 'requestId') : undefined
      const requestId = typeof originalId === 'string' && originalId.length === 36
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(originalId) ? originalId : operation.id
      const fields = {
        requestId, stage: operation.stage, code: failureCode(error),
        causeCodes: [cause === undefined ? null : failureCode(cause), nested === undefined ? null : failureCode(nested)],
        sites: [...cloudFailureSites(error), ...cloudFailureSites(cause)].slice(0, 6),
        headersSent: operation.response?.headersSent ?? false,
        writableEnded: operation.response?.writableEnded ?? false,
        destroyed: operation.response?.destroyed ?? operation.socket?.destroyed ?? false,
        ...(operation.stage === 'ingress.current' ? { rootRecipe: this.recipeObservation() } : {}),
      }
      console.warn('Cloud ingress request failed: %j', fields)
      this.ctx.logger.warn('Cloud ingress request failed: %j', fields)
    } catch (_error) {
      try { console.error('Cloud ingress failure diagnostics unavailable.') }
      catch (_fallbackError) { /* Observability must not change the original response or cleanup. */ }
    }
  }

  private recipeObservation(): Omit<ReturnType<AccountRuntimeService['inspectRecipe']>, 'recipeVersion'> | undefined {
    try {
      const { status, rootEntries, providers, participants, issues } = this.dependencies.runtime.inspectRecipe()
      return { status, rootEntries, providers, participants, issues }
    } catch (_unavailableObservation) { return undefined }
  }

  private failure(error: unknown, id: RequestId): AuthAccessError | RequestBindingError {
    if (error instanceof RequestBindingError || error instanceof AuthAccessError) return error
    else if (error instanceof CloudApiError || error instanceof AccountRuntimeError || error instanceof ExecutionStateError
      || error instanceof PreviewAccessError || error instanceof PreviewResponseError) {
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

  private assertTransport(request: IncomingMessage, id: RequestId, transport: Parameters<typeof assertAuthTransport>[6]): void {
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

  private register(acquire: () => () => void, label: string): object {
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
    return token
  }

  private requestId(): RequestId { return randomUUID() as RequestId }
}
