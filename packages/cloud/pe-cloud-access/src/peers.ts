/** Internal C-02 login Peer ownership. Root remains closed until native account assembly exists. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Peer, HostConnectionService, type ConnectionDispatch } from '@deepseek-ai/dsh-client-connection'
import { TypertGatewayService, type NodeStreamTransport } from '@deepseek-ai/dsh-api-gateway'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountUse, AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { BetterAuthAccess } from './auth.ts'
import { AuthAccessError } from './auth-error.ts'
import { RequestBindingError } from './binding.ts'
import { assertAuthTransport } from './auth-trust.ts'
import type { AccessConfig, AuthenticatedPrincipal } from './types.ts'
import type { AuthIngressConfig } from './root-config.ts'
import { StreamCapacity } from './stream-capacity.ts'
import type {} from '@deepseek-ai/dsh-pe-cloud-api'

type RequestId = Branded<'pe-request-id'>
type LoginId = AuthenticatedPrincipal['authSessionId']
type PeerConfig = AccessConfig & Pick<AuthIngressConfig, 'sessionRecheckLeadMs'>
type SafeDetails = ReturnType<AuthAccessError['toJSON']>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'cloud/unauthenticated': SafeDetails
    'cloud/forbidden': {}
    'cloud/login-active': SafeDetails
    'cloud/account-unavailable': {}
    'cloud/capacity': {}
    'cloud/stop-unconfirmed': SafeDetails
    'cloud/stale-generation': {}
  }
}

/** Same-process handle; no authority or generation is serialized onto native envelopes. */
export interface LoginPeer {
  readonly peer: Peer
  readonly principal: AuthenticatedPrincipal
  readonly binding: AccountBinding
}

/** Original Peer-to-factory handoff; callbacks are server-owned and no identity is accepted from JSON. */
export type ConfigurationPeerOperation<T> = (binding: AccountBinding, context: AccountUse['context'],
  assertLoginCurrent: () => void, closeObservers: () => Promise<void>, handoff: {
    readonly afterRequest: () => Promise<void>
    readonly closeAll: (deadlineAtMs: number) => Promise<void>
    readonly assertPrincipal: () => void
  }) => Promise<T>

/** Required trusted assembly callbacks; borrow must allocate a new lifecycle Use, without a request signal. */
export interface LoginPeerPorts {
  readonly borrow: (binding: AccountBinding) => Promise<AccountUse>
  readonly beforeHttp: (request: IncomingMessage, peer: LoginPeer) => void
  readonly beforeDispatch?: (request: IncomingMessage, dispatch: ConnectionDispatch, peer: LoginPeer) => void
  readonly beforeStream: (endpoint: string, peer: LoginPeer) => void
  readonly streams?: Pick<AuthIngressConfig,
    'maxFrameBytes' | 'maxLogicalStreams' | 'maxLogicalStreamsPerAccount' | 'maxLogicalStreamsPerPeer'>
  /** Default-enabled root diagnostics must persist this safe failure; callback must not throw. */
  readonly cleanupFailed: (failure: SafeDetails) => void
}

interface ReadyWaiter {
  readonly resolve: (peer: LoginPeer) => void
  readonly reject: (error: Error) => void
}

interface Entry {
  readonly key: string
  readonly binding: AccountBinding
  readonly principal: AuthenticatedPrincipal
  readonly ready: ReturnType<typeof Promise.withResolvers<LoginPeer>>
  readonly done: ReturnType<typeof Promise.withResolvers<void>>
  readonly waiters: Set<ReadyWaiter>
  readonly tasks: Set<Promise<unknown>>
  readonly carriers: Map<{ destroy(): void }, 'http' | 'websocket'>
  readonly reportedRefusalPhases: Set<'updating' | 'closing' | 'blocked'>
  readonly lifetimeEnded: () => void
  phase: 'preparing' | 'ready' | 'updating' | 'closing' | 'blocked'
  preparing: boolean
  use: AccountUse | undefined
  handle: LoginPeer | undefined
  connection: HostConnectionService | undefined
  mux: NodeStreamTransport | undefined
  cleanupFault: boolean
  removeObserver: (() => unknown) | undefined
  nativeCleanup: Promise<void> | undefined
  cleanup: Promise<void> | undefined
  timer: NodeJS.Timeout | undefined
  recheck: Promise<void> | undefined
  carrierCount: number
  streamCount: number
  businessStreamCount: number
}

/**
 * Internal registry for a verified login and one trusted native account epoch.
 * Preparing and uncertain cleanup retain Peer capacity. Every actual native cleanup remains observed.
 * No request cancellation is passed to runtime borrow or to an Agent.
 */
export class LoginPeerRegistry {
  private readonly requestCarrier = new AsyncLocalStorage<{
    readonly entry: Entry
    settlement?: Promise<unknown>
    readonly releaseRequestUse?: () => void
    readonly requestActual?: Promise<void>
  }>()
  private readonly entries: Map<string, Entry> = new Map()
  private readonly handles: WeakMap<LoginPeer, Entry> = new WeakMap()
  private readonly peerCounts: Map<AccountId, number> = new Map()
  private readonly waiterCounts: Map<AccountId, number> = new Map()
  private readonly carrierCounts: Map<AccountId, number> = new Map()
  private readonly loginCarrierCounts: Map<LoginId, number> = new Map()
  private waiters: number = 0
  private carriers: number = 0
  private accepting: boolean = true
  private closingActual: Promise<void> | undefined
  private readonly streams: StreamCapacity | undefined

  /**
   * @param config - Finite admission/cleanup budgets and explicit recheck lead; only private fixtures may use zero.
   * @param auth - Actual M1 adapter.
   * @param ports - Trusted runtime and exposure callbacks.
   */
  constructor(private readonly config: PeerConfig, private readonly auth: BetterAuthAccess, private readonly ports: LoginPeerPorts) {
    if (!Number.isSafeInteger(config.sessionRecheckLeadMs) || config.sessionRecheckLeadMs < 0
      || config.sessionRecheckLeadMs >= config.sessionRecheckMs) {
      throw new RangeError('Login Peer requires an explicit recheck lead below its maximum login age.')
    }
    this.streams = ports.streams === undefined ? undefined : new StreamCapacity(ports.streams)
  }

  /** Reserved login slots.
 * @returns Count including preparing and uncertain cleanup. */
  get reservedPeers(): number { return this.entries.size }
  /** Reserved carrier slots.
 * @returns Actual HTTP/upgrade operations and live upgraded sockets. */
  get reservedCarriers(): number { return this.carriers }
  /** Pending creation callers.
 * @returns Waiting records; abandonment leaves actual creation running. */
  get waitingCallers(): number { return this.waiters }

  /**
   * Share creation for one authenticated login/account/epoch; the first principal's cookie stays pinned.
   * @param principal - Exact real M1 authentication result, checked before admission.
   * @param binding - Immutable trusted runtime binding; no client expectation is accepted here.
   * @param deadlineAtMs - Finite server deadline for this caller only.
   * @param signal - Optional caller abandonment; absence waits to the deadline.
   * @param requestId - Server correlation id.
   * @returns The shared native Peer after creation; rejection never cancels another caller's work.
   */
  async acquire(
    principal: AuthenticatedPrincipal, binding: AccountBinding, deadlineAtMs: number,
    signal: AbortSignal | undefined, requestId: RequestId,
  ): Promise<LoginPeer> {
    this.auth.assertLoginCurrent(principal, requestId)
    if (principal.accountId !== binding.accountId) throw new AuthAccessError('cloud/forbidden', requestId)
    if (!this.accepting || binding.lifetime.aborted) throw new AuthAccessError('cloud/account-unavailable', requestId)
    this.checkDeadline(deadlineAtMs, requestId)
    if (signal?.aborted === true) throw new AuthAccessError('cloud/account-unavailable', requestId)
    if (this.waiters >= this.config.maxPeerWaiters
      || this.count(this.waiterCounts, binding.accountId) >= this.config.maxPeerWaitersPerAccount) {
      throw new AuthAccessError('cloud/capacity', requestId)
    }
    const key = JSON.stringify([binding.accountId, principal.authSessionId, binding.epoch])
    let entry = this.entries.get(key)
    if (entry === undefined) {
      if (this.entries.size >= this.config.maxPeers || this.count(this.peerCounts, binding.accountId) >= this.config.maxPeersPerAccount) {
        throw new AuthAccessError('cloud/capacity', requestId)
      }
      const owned: Entry = {
        key, binding, principal, ready: Promise.withResolvers<LoginPeer>(), done: Promise.withResolvers<void>(),
        waiters: new Set(), tasks: new Set(), carriers: new Map(), reportedRefusalPhases: new Set(),
        phase: 'preparing', preparing: true,
        use: undefined, handle: undefined, connection: undefined, mux: undefined, cleanupFault: false, removeObserver: undefined,
        nativeCleanup: undefined, cleanup: undefined,
        timer: undefined, recheck: undefined, carrierCount: 0, streamCount: 0, businessStreamCount: 0,
        lifetimeEnded: () => { void this.startClose(owned, requestId) },
      }
      entry = owned
      this.entries.set(key, owned)
      this.increment(this.peerCounts, binding.accountId, 1)
      // Readiness and full completion have independent observers even if all callers abandon.
      void owned.ready.promise.then(
        (handle) => { for (const waiter of [...owned.waiters]) waiter.resolve(handle) },
        (error: unknown) => { for (const waiter of [...owned.waiters]) waiter.reject(this.safe(error, requestId)) },
      )
      void owned.done.promise.catch((_error: unknown) => {
        // blocked state, root cleanupFailed and done waiters retain the failure; this observer only prevents
        // an unhandled rejection when nobody waits. Do not emit the cause or credentials again.
      })
      binding.lifetime.addEventListener('abort', owned.lifetimeEnded, { once: true })
      void this.prepare(owned, requestId)
    } else if (entry.phase !== 'preparing' && entry.phase !== 'ready') {
      const phase = entry.phase
      if (!entry.reportedRefusalPhases.has(phase)) {
        entry.reportedRefusalPhases.add(phase)
        try {
          console.warn('Cloud login Peer acquisition refused: %j', { phase, waiters: entry.waiters.size,
            carriers: entry.carrierCount, streams: entry.streamCount, tasks: entry.tasks.size })
        } catch (_unavailableObservation) {
          entry.reportedRefusalPhases.delete(phase) // A later refusal can retry the diagnostic.
        }
      }
      throw new AuthAccessError('cloud/account-unavailable', requestId)
    }
    this.waiters++
    this.increment(this.waiterCounts, binding.accountId, 1)
    try { return await this.waitReady(entry, deadlineAtMs, signal, requestId) }
    finally { this.waiters--; this.increment(this.waiterCounts, binding.accountId, -1) }
  }

  /**
   * Guard each native unary dispatch and each logical stream, using the original login and Use.
   * @param handle - Shared internal handle returned by acquire.
   * @param requestId - Server correlation id.
   * @throws AuthAccessError when freshness or account lifetime cannot be confirmed.
   */
  assertCurrent(handle: LoginPeer, requestId: RequestId): void {
    const entry = this.currentEntry(handle, requestId)
    try { this.auth.assertLoginCurrent(entry.principal, requestId) }
    catch (error) {
      if (error instanceof AuthAccessError && error.code === 'cloud/account-unavailable') void this.beginRecheck(entry)
      else void this.startClose(entry, requestId)
      throw this.safe(error, requestId)
    }
  }

  /**
   * Join trusted native work to the exact existing Peer entry without another borrow or release owner.
   * @param peer Original Gateway invocation Peer; ids and copied objects cannot select an entry.
   * @param current Original ingress/generation check, repeated during this same borrowed operation.
   * @param consume Actual native work, retained in this Entry's existing tasks until settlement.
   * @returns The actual result; observer loss cannot release the original Use early.
   */
  withOriginalUse<T>(peer: PeerScope, current: (handle: LoginPeer) => void,
    consume: (use: AccountUse, assertCurrent: () => void) => Promise<T>): Promise<T> {
    const id = this.requestId(), entry = [...this.entries.values()].find(value => value.handle?.peer === peer)
    const handle = entry?.handle, use = entry?.use
    if (entry === undefined || handle === undefined || use === undefined) throw new AuthAccessError('cloud/account-unavailable', id)
    const check = (): void => {
      this.assertCurrent(handle, id); current(handle); this.assertCurrent(handle, id)
      if (entry.use !== use || handle.peer !== peer) throw new AuthAccessError('cloud/account-unavailable', id)
      use.assertCurrent()
    }
    check()
    const deferred = Promise.withResolvers<T>()
    const actual = this.trackCarrier(entry, deferred.promise, () => {})
    // Existing Entry task ownership precedes the first possibly reentrant native callback.
    void (async () => { check(); const value = await consume(use, check); check(); return value })().then(deferred.resolve, deferred.reject)
    return actual
  }

  /** Transfer the original Peer borrow to the factory's actual exclusive update, without waiting on this RPC's own task.
   * @param peer Exact original invocation Peer.
   * @param current Original ingress check before handoff and after re-borrowing.
   * @param consume Factory-owned update; closing observers joins their real native resources and releases their Uses.
   * Observation closure uses the configured finite Peer budget; timeout revokes this handoff while original cleanup stays owned.
   * @param mode Explicit local idle operation or terminal acceptance followed by original full closure.
   * @returns Actual update result after a fresh same-generation Use is acquired; failure never fabricates release.
   */
  async withConfigurationPeer<T>(peer: PeerScope, current: (handle: LoginPeer) => void,
    consume: ConfigurationPeerOperation<T>, mode: 'if-idle' | 'stop-and-apply' = 'if-idle'): Promise<T> {
    const id = this.requestId(), entry = [...this.entries.values()].find(row => row.handle?.peer === peer)
    const handle = entry?.handle, use = entry?.use
    if (entry === undefined || handle === undefined || use === undefined) throw new AuthAccessError('cloud/account-unavailable', id)
    this.assertCurrent(handle, id); current(handle); use.assertCurrent()
    const binding = use.binding
    const carrier = this.requestCarrier.getStore()
    if (carrier?.entry !== entry || carrier.settlement === undefined || !entry.tasks.has(carrier.settlement)) {
      throw new AuthAccessError('cloud/account-unavailable', id)
    }
    const originalRequest = carrier.settlement
    const handoff = Object.freeze({
      afterRequest: async (): Promise<void> => { await Promise.allSettled([originalRequest]) },
      closeAll: (deadlineAtMs: number) => this.closeBinding(entry.binding, deadlineAtMs),
      assertPrincipal: (): void => { this.auth.assertLoginCurrent(entry.principal, id) },
    })
    if (mode === 'stop-and-apply') {
      const requestActual = carrier.requestActual
      if (requestActual === undefined) throw new AuthAccessError('cloud/stop-unconfirmed', id)
      // The factory first registers actual work, then waits this request's real settlement before closing the old Peer.
      const terminalHandoff = Object.freeze({ ...handoff, afterRequest: async (): Promise<void> => { await requestActual } })
      return consume(binding, use.context, () => { this.assertCurrent(handle, id); current(handle); use.assertCurrent() },
        () => Promise.reject(new RemoteError('cloud/config-busy', 'A terminal update must use its original full-close handoff.', {})), terminalHandoff)
    }
    const related = [...this.entries.values()].filter(row => row.binding.accountId === binding.accountId
      && row.binding.epoch === binding.epoch && row.binding.lifetime === binding.lifetime)
    if (related.some(row => row.phase !== 'ready' || row.preparing || row.recheck !== undefined || row.cleanupFault
      || row.businessStreamCount !== 0 || row.tasks.size > (row === entry ? 1 : 0))) {
      const peerWork = {
        nonReadyPeers: related.filter(row => row.phase !== 'ready').length,
        preparingPeers: related.filter(row => row.preparing).length,
        recheckingPeers: related.filter(row => row.recheck !== undefined).length,
        cleanupFaultPeers: related.filter(row => row.cleanupFault).length,
        businessStreamPeers: related.filter(row => row.businessStreamCount !== 0).length,
        otherTaskPeers: related.filter(row => row.tasks.size > (row === entry ? 1 : 0)).length,
      }
      throw new RemoteError('cloud/config-busy', 'The original account still owns non-observation Peer work.', { peerWork })
    }
    const context = use.context
    // Only the authenticated configuration handoff can release this HTTP request's own reference.
    carrier.releaseRequestUse?.()
    entry.phase = 'updating'
    clearTimeout(entry.timer); entry.timer = undefined
    entry.use = undefined
    use.release()
    let windowOpen = true
    const login = (): void => {
      this.auth.assertLoginCurrent(entry.principal, id)
      if (!windowOpen || entry.phase !== 'updating' || entry.handle !== handle || entry.binding.lifetime.aborted || entry.cleanupFault) {
        throw new AuthAccessError('cloud/account-unavailable', id)
      }
    }
    const closeObservers = async (): Promise<void> => {
      login()
      const mux = entry.mux
      try {
        const joins = related.filter(row => row !== entry).map((row) => {
          void this.startClose(row, id)
          return row.done.promise
        })
        for (const [carrier, kind] of entry.carriers) if (kind === 'websocket') carrier.destroy()
        // Keep the original mux on its Entry until actual closure, so terminal cleanup joins the same resource.
        const cleanup = Promise.all([...joins, mux?.close()]).then(() => {})
        await this.wait(cleanup, Date.now() + this.config.peerCloseTimeoutMs, binding.lifetime, id)
        login()
        if (entry.streamCount !== 0 || entry.businessStreamCount !== 0 || entry.cleanupFault) {
          throw new AuthAccessError('cloud/stop-unconfirmed', id)
        }
        if (entry.mux === mux) entry.mux = undefined
      } catch (cause) {
        // A late cleanup may release its own resources, but cannot regain this configuration's write/restore capability.
        windowOpen = false
        throw cause
      }
    }
    const restore = async (): Promise<void> => {
      login()
      const replacement = await this.ports.borrow(binding)
      try {
        login(); replacement.assertCurrent()
        if (replacement.context.root !== context.root || replacement.binding !== binding) {
          throw new RemoteError('cloud/stale-generation', 'The original configuration Peer generation changed.', {})
        }
        entry.use = replacement
        entry.phase = 'ready'
        if (entry.mux === undefined) {
          const gateway = replacement.context.get('typertGateway')
          if (!(gateway instanceof TypertGatewayService)) throw new AuthAccessError('cloud/account-unavailable', id)
          entry.mux = this.createMux(entry, handle, gateway)
        }
        this.schedule(entry)
        this.assertCurrent(handle, id); current(handle)
      } catch (error) {
        if (entry.use === replacement) entry.use = undefined
        if (this.entries.get(entry.key)?.phase === 'ready') entry.phase = 'updating'
        replacement.release()
        throw error
      }
    }
    try {
      const value = await consume(binding, context, login, closeObservers, handoff)
      await restore()
      return value
    } catch (error) {
      if (this.entries.get(entry.key)?.phase === 'updating') {
        try { await restore() }
        catch (_restoreFailure) {
          // Full close joins this original carrier after it rejects; awaiting it here would wait on this RPC itself.
          void this.startClose(entry, id).catch((_closeFailure: unknown) => {})
        }
      }
      throw error
    }
  }

  /**
   * Reauthenticate this carrier before invoking the real native HTTP bridge with the fixed Peer.
   * A finite carrier reservation joins any due original-Cookie recheck before synchronous dispatch guards.
   * @param handle - Shared login Peer; root already checked client account/generation expectations.
   * @param request - Original raw Node request, preserving native JSON and stream decoding.
   * @param response - Original Node response; disconnect closes only this carrier.
   * @param maxRequestBodyBytes - Required native body budget from trusted assembly.
   * @param requestId - Server correlation id.
   * @param releaseRequestUse Trusted ingress transfer of this request's own Use after configuration admission;
   * ordinary HTTP retains its reference.
   * @param requestActual Original ingress completion, including response transfer and Use release, required for terminal handoff.
   * @returns Actual bridge settlement; caller timeout must not release this operation early.
   */
  handleNodeRequest(
    handle: LoginPeer, request: IncomingMessage, response: ServerResponse, maxRequestBodyBytes: number, requestId: RequestId,
    releaseRequestUse?: () => void, requestActual?: Promise<void>,
  ): Promise<void> {
    const entry = this.admitCarrier(handle, requestId)
    entry.carriers.set(request, 'http')
    entry.carriers.set(response, 'http')
    const carrier: {
      readonly entry: Entry
      settlement?: Promise<unknown>
      readonly releaseRequestUse?: () => void
      readonly requestActual?: Promise<void>
    } = { entry,
      ...releaseRequestUse === undefined ? {} : { releaseRequestUse }, ...requestActual === undefined ? {} : { requestActual } }
    const task = this.requestCarrier.run(carrier, async () => {
      await this.authenticateCarrier(entry, request, requestId)
      this.ports.beforeHttp(request, handle)
      this.assertCurrent(handle, requestId)
      const connection = entry.connection
      if (connection === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
      await connection.handleNodeRequest(request, response, handle.peer, maxRequestBodyBytes, (dispatch) => {
        this.assertCurrent(handle, requestId)
        this.ports.beforeDispatch?.(request, dispatch, handle)
        this.assertCurrent(handle, requestId)
      })
    })
    const tracked = this.trackCarrier(entry, task, () => {
      entry.carriers.delete(request)
      entry.carriers.delete(response)
      this.releaseCarrier(entry)
    })
    carrier.settlement = tracked
    return tracked
  }

  /**
   * Retain one Root HTTP operation under the original login carrier limits and canonical principal.
   * @param handle Original shared Peer; the first verified Cookie stays pinned for rechecks.
   * @param request Original fixed-route request, used only to detect a disconnected carrier.
   * @param requestId Original ingress correlation id.
   * @param input Trusted Root callbacks: real route-specific authentication, existing cancellation and body work.
   * Its actual promise is the original ingress operation, including response transfer and Use release; rejection
   * means cleanup is unconfirmed. It is observed here, never awaited by the body that it contains.
   * @returns Authentication/body settlement; carrier capacity remains held until the separate actual operation settles.
   */
  runCarrier(handle: LoginPeer, request: IncomingMessage, requestId: RequestId, input: {
    readonly authenticate: () => Promise<AuthenticatedPrincipal>
    readonly actual: Promise<void>
    readonly destroy: () => void
    readonly consume: () => Promise<void>
  }): Promise<void> {
    const entry = this.admitCarrier(handle, requestId)
    const carrier = { destroy: input.destroy }
    entry.carriers.set(carrier, 'http')
    let confirmed = false
    const actual = input.actual.then(() => { confirmed = true }, (error: unknown) => {
      entry.cleanupFault = true
      void this.startClose(entry, requestId)
      throw error
    })
    const tracked = this.trackCarrier(entry, actual, () => {
      if (!confirmed) return // Unknown original ingress cleanup retains this carrier and the original blocked Entry.
      entry.carriers.delete(carrier)
      this.releaseCarrier(entry)
    })
    void tracked.catch((_error: unknown) => {
      // Original ingress observes its failure; Entry cleanupFault/blocked and done retain unknown responsibility.
    })
    return this.requestCarrier.run({ entry, settlement: tracked, requestActual: input.actual }, async () => {
      await this.authenticateCarrier(entry, request, requestId, input.authenticate)
      this.assertCurrent(handle, requestId)
      await input.consume()
    })
  }

  /**
   * Transfer a reauthenticated socket to the real native stream mux; stream opens guard the pinned login.
   * Admission may join an original-Cookie recheck; logical stream opens remain synchronous.
   * @param handle - Fixed login Peer selected by trusted root routing.
   * @param request - Original upgrade request with exactly one same-origin Origin, checked before auth DB work.
   * @param socket - Caller-owned until admission; caller contains early refusals, admitted failures destroy it.
   * @param head - Original upgrade bytes.
   * @param requestId - Server correlation id.
   * @returns Admission settlement; the carrier reservation lasts to actual socket close.
   */
  handleUpgrade(handle: LoginPeer, request: IncomingMessage, socket: Duplex, head: Buffer, requestId: RequestId): Promise<void> {
    const secure = 'encrypted' in request.socket && request.socket.encrypted === true
    assertAuthTransport(request.headers, request.rawHeaders, request.socket.remoteAddress, secure, this.config, requestId, 'websocket')
    const entry = this.admitCarrier(handle, requestId)
    entry.carriers.set(socket, 'websocket')
    let upgraded = false
    let settled = false
    let closed = socket.destroyed
    let released = false
    const release = (): void => {
      if (!settled || (!closed && upgraded) || released) return
      released = true
      socket.off('close', onClose)
      entry.carriers.delete(socket)
      this.releaseCarrier(entry)
    }
    const onClose = (): void => { closed = true; release() }
    socket.on('close', onClose)
    const task = (async () => {
      try {
        await this.authenticateCarrier(entry, request, requestId)
        this.assertCurrent(handle, requestId)
        if (closed || socket.destroyed || entry.mux === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
        entry.mux.handleUpgrade(request, socket, head)
        upgraded = true
      } catch (error) { socket.destroy(); throw error }
      finally { settled = true; release() }
    })()
    return this.trackCarrier(entry, task, () => {})
  }

  /**
   * Invalidation callback for M1. Stops admission and closes all currently known native resources.
   * It does not await borrow/recheck or carrier tasks: an expired-session carrier read can itself invoke this callback.
   * @param loginId - Trusted exact authentication session id.
   * @returns Known-resource cleanup; late creation stays reserved and is separately observed.
   */
  async invalidateLogin(loginId: LoginId): Promise<void> {
    const entries = [...this.entries.values()].filter(entry => entry.principal.authSessionId === loginId)
    const id = this.requestId()
    for (const entry of entries) void this.startClose(entry, id)
    const actual = Promise.all(entries.map(entry => entry.nativeCleanup ?? Promise.resolve()))
    await this.wait(actual, Date.now() + this.config.peerCloseTimeoutMs, undefined, id)
    if (entries.some(entry => entry.phase === 'blocked')) throw new AuthAccessError('cloud/stop-unconfirmed', this.requestId())
  }

  /**
   * Close one epoch and await actual late creation and native cleanup to the caller deadline.
   * @param binding - Trusted account epoch selected by runtime.
   * @param deadlineAtMs - Caller waiting deadline; timeout preserves all outstanding ownership.
   * @returns Confirmed completion only after every matching actual resource is released.
   */
  async closeBinding(binding: AccountBinding, deadlineAtMs: number): Promise<void> {
    const id = this.requestId()
    const entries = [...this.entries.values()].filter(entry =>
      entry.binding.accountId === binding.accountId && entry.binding.epoch === binding.epoch)
    for (const entry of entries) void this.startClose(entry, id)
    await this.wait(Promise.all(entries.map(entry => entry.done.promise)).then(() => {}), deadlineAtMs, undefined, id)
  }

  /**
   * Stop registry admission and close its actual work.
   * @param deadlineAtMs - Finite caller deadline.
   * @returns Confirmed closure; unknown work remains retained after rejection.
   */
  async close(deadlineAtMs: number): Promise<void> {
    await this.wait(this.closeActual(), deadlineAtMs, undefined, this.requestId())
  }

  /**
   * Stop admission and join actual creation, carriers and native cleanup without an observer deadline.
   * @returns The retained completion; failed cleanup rejects without releasing its entry or Use.
   */
  closeActual(): Promise<void> {
    if (this.closingActual !== undefined) return this.closingActual
    this.accepting = false
    this.streams?.close()
    const id = this.requestId()
    const entries = [...this.entries.values()]
    for (const entry of entries) void this.startClose(entry, id)
    this.closingActual = Promise.all(entries.map(entry => entry.done.promise)).then(() => {})
    return this.closingActual
  }

  private async prepare(entry: Entry, requestId: RequestId): Promise<void> {
    try {
      const use = await this.ports.borrow(entry.binding)
      entry.use = use
      if (!this.isPreparing(entry)) return
      // Typed ports carry a runtime-owned binding; compare its identity before graph access.
      if (use.binding.accountId !== entry.binding.accountId || use.binding.epoch !== entry.binding.epoch
        || use.binding.recipeVersion !== entry.binding.recipeVersion || use.binding.lifetime !== entry.binding.lifetime) {
        throw new AuthAccessError('cloud/account-unavailable', requestId)
      }
      use.assertCurrent()
      await this.auth.recheckLogin(entry.principal, requestId)
      if (!this.isPreparing(entry)) return
      use.assertCurrent()
      this.auth.assertLoginCurrent(entry.principal, requestId)
      const connection = use.context.get('connection')
      const gateway = use.context.get('typertGateway')
      if (!(connection instanceof HostConnectionService) || !(gateway instanceof TypertGatewayService)) {
        throw new AuthAccessError('cloud/account-unavailable', requestId)
      }
      const peer = new Peer(use.context, { principal: { kind: 'owner' }, interactions: 'answer' })
      const handle: LoginPeer = Object.freeze({ peer, binding: entry.binding, principal: entry.principal })
      entry.handle = handle
      // The account-owned exporter survives Peer disposal and reads only severity/fiber ancestry.
      entry.removeObserver = use.context.logger.exporter({ levels: { default: 0 }, export: (message) => {
        if (message.type !== 'error' || entry.phase !== 'closing') return
        let fiber = message.fiber?.deref()
        while (fiber !== undefined) {
          if (fiber === peer.ctx.fiber) { entry.cleanupFault = true; return }
          const parent = fiber.parent.fiber
          if (parent === fiber) return
          fiber = parent
        }
      } })
      entry.connection = connection
      entry.mux = this.createMux(entry, handle, gateway)
      this.handles.set(handle, entry)
      entry.phase = 'ready'
      entry.ready.resolve(handle)
      this.schedule(entry)
    } catch (error) {
      entry.ready.reject(this.safe(error, requestId))
      await this.startClose(entry, requestId)
    } finally {
      entry.preparing = false
      if (entry.phase === 'closing') await this.closeKnown(entry, requestId)
      this.finish(entry)
    }
  }

  private schedule(entry: Entry): void {
    if (entry.phase !== 'ready') return
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.beginRecheck(entry) },
      this.config.sessionRecheckMs - this.config.sessionRecheckLeadMs)
    entry.timer.unref()
  }

  private createMux(entry: Entry, handle: LoginPeer, gateway: TypertGatewayService): NodeStreamTransport {
    return gateway.createNodeStreamTransport(handle.peer, (endpoint) => {
      const id = this.requestId()
      try { this.assertCurrent(handle, id); this.ports.beforeStream(endpoint, handle); this.assertCurrent(handle, id) }
      catch (error) {
        const failure = error instanceof AuthAccessError || error instanceof RequestBindingError ? error : undefined
        if (failure === undefined) throw error // Preserve the exposure owner's native RemoteError.
        throw new RemoteError(failure.code, failure.message, failure.toJSON())
      }
    }, this.ports.streams === undefined ? undefined : {
      maxFrameBytes: this.ports.streams.maxFrameBytes,
      acquireStream: (endpoint: string) => {
        const id = this.requestId()
        this.assertCurrent(handle, id)
        const settle = this.streams?.acquire(entry.binding.accountId, entry, id, () => {
          entry.cleanupFault = true
          // Never await transport closure from the settlement callback of that same transport.
          queueMicrotask(() => { void this.startClose(entry, id) })
        })
        if (settle === undefined) throw new AuthAccessError('cloud/account-unavailable', id)
        const business = !['$events', 'workspace/follow', 'remoteAccess/follow', 'session/follow', 'session/control'].includes(endpoint)
        entry.streamCount++
        if (business) entry.businessStreamCount++
        let settled = false
        return (status: 'confirmed' | 'unknown') => {
          if (settled) return
          settled = true
          settle(status)
          if (status === 'confirmed') { entry.streamCount--; if (business) entry.businessStreamCount-- }
        }
      },
    })
  }

  private beginRecheck(entry: Entry): Promise<void> | undefined {
    if (entry.phase !== 'ready') return undefined
    if (entry.recheck !== undefined) return entry.recheck
    clearTimeout(entry.timer)
    entry.timer = undefined
    const requestId = this.requestId()
    const recheck = this.auth.recheckLogin(entry.principal, requestId).then(() => {
      this.schedule(entry)
    }, (error: unknown) => {
      // Full cleanup joins carrier tasks, which may be awaiting this result. Its owner joins cleanup separately.
      void this.startClose(entry, requestId)
      throw this.safe(error, requestId)
    }).finally(() => { entry.recheck = undefined })
    entry.recheck = recheck
    void recheck.catch((_error: unknown) => {
      // Timer-owned failures already close the entry; waiting carriers observe the same rejection.
    })
    return recheck
  }

  private startClose(entry: Entry, requestId: RequestId): Promise<void> {
    if (entry.phase === 'blocked') return Promise.resolve() // Failure is retained in done and diagnostics; no retry claim.
    entry.phase = 'closing'
    entry.binding.lifetime.removeEventListener('abort', entry.lifetimeEnded)
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.ready.reject(new AuthAccessError('cloud/account-unavailable', requestId))
    for (const carrier of entry.carriers.keys()) carrier.destroy()
    return this.closeKnown(entry, requestId)
  }

  private closeKnown(entry: Entry, requestId: RequestId): Promise<void> {
    if (entry.cleanup !== undefined) return entry.cleanup
    if (entry.use === undefined && entry.handle === undefined && entry.mux === undefined) { this.finish(entry); return Promise.resolve() }
    entry.nativeCleanup ??= (async () => {
      // Physical carriers were destroyed above. Native iterator/scope cleanup proceeds together to avoid deadlock.
      const results = await Promise.allSettled([entry.mux?.close(), entry.handle?.peer.dispose()])
      if (entry.cleanupFault || entry.streamCount !== 0 || results.some(result => result.status === 'rejected')) {
        throw new AuthAccessError('cloud/stop-unconfirmed', requestId)
      }
    })()
    const cleanup = (async () => {
      // M1's invalidation callback awaits nativeCleanup only. A carrier auth read may own that callback.
      await entry.nativeCleanup
      await Promise.allSettled(entry.tasks)
      if (entry.cleanupFault) throw new AuthAccessError('cloud/stop-unconfirmed', requestId)
      await Promise.resolve(entry.removeObserver?.())
      entry.removeObserver = undefined
      entry.use?.release()
      entry.use = undefined
      entry.handle = undefined
      entry.mux = undefined
      entry.connection = undefined
    })()
    entry.cleanup = cleanup.then(() => {
      entry.cleanup = undefined
      this.finish(entry)
    }, () => {
      entry.phase = 'blocked'
      const failure = new AuthAccessError('cloud/stop-unconfirmed', requestId)
      entry.done.reject(failure)
      try { this.ports.cleanupFailed(failure.toJSON()) }
      catch { console.error('[pe-cloud-access] Peer cleanup remains unconfirmed; admission stays closed; root diagnostics failed.') }
    })
    // A deadline reports uncertainty but cannot free this slot or restart cleanup.
    const timer = setTimeout(() => {
      if (entry.phase !== 'closing') return
      const failure = new AuthAccessError('cloud/stop-unconfirmed', requestId)
      try { this.ports.cleanupFailed(failure.toJSON()) }
      catch { console.error('[pe-cloud-access] Peer cleanup remains pending; admission stays closed; root diagnostics failed.') }
    }, this.config.peerCloseTimeoutMs)
    timer.unref()
    void entry.cleanup.finally(() => { clearTimeout(timer) })
    return entry.cleanup
  }

  private finish(entry: Entry): void {
    if (entry.phase !== 'closing' || entry.preparing || entry.cleanup !== undefined || entry.use !== undefined
      || entry.handle !== undefined || entry.mux !== undefined || entry.tasks.size !== 0
      || entry.carrierCount !== 0 || entry.streamCount !== 0) return
    this.entries.delete(entry.key)
    this.increment(this.peerCounts, entry.binding.accountId, -1)
    entry.done.resolve()
  }

  private admitCarrier(handle: LoginPeer, requestId: RequestId): Entry {
    const entry = this.currentEntry(handle, requestId)
    if (this.carriers >= this.config.maxPeerCarriers
      || this.count(this.carrierCounts, entry.binding.accountId) >= this.config.maxPeerCarriersPerAccount
      || this.count(this.loginCarrierCounts, entry.principal.authSessionId) >= this.config.maxPeerCarriersPerLogin) throw new AuthAccessError('cloud/capacity', requestId)
    this.carriers++
    this.increment(this.loginCarrierCounts, entry.principal.authSessionId, 1)
    entry.carrierCount++
    this.increment(this.carrierCounts, entry.binding.accountId, 1)
    return entry
  }

  private async authenticateCarrier(
    entry: Entry, request: IncomingMessage, requestId: RequestId,
    authenticate: () => Promise<AuthenticatedPrincipal> = () => this.auth.authenticate(request, requestId),
  ): Promise<void> {
    const principal = await authenticate()
    if (principal.accountId !== entry.principal.accountId || principal.authSessionId !== entry.principal.authSessionId) {
      throw new AuthAccessError('cloud/unauthenticated', requestId)
    }
    const handle = entry.handle
    if (handle === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
    this.currentEntry(handle, requestId)
    let recheck = entry.recheck
    if (recheck === undefined) {
      try { this.auth.assertLoginCurrent(entry.principal, requestId) }
      catch (error) {
        if (error instanceof AuthAccessError && error.code === 'cloud/account-unavailable') recheck = this.beginRecheck(entry)
        else {
          void this.startClose(entry, requestId)
          throw this.safe(error, requestId)
        }
      }
    }
    await recheck
    if (request.destroyed) throw new AuthAccessError('cloud/account-unavailable', requestId)
    this.assertCurrent(handle, requestId)
  }

  private currentEntry(handle: LoginPeer, requestId: RequestId): Entry {
    const entry = this.handles.get(handle)
    if (entry === undefined || entry.phase !== 'ready' || entry.use === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
    try {
      if (entry.binding.lifetime.aborted) throw new AuthAccessError('cloud/account-unavailable', requestId)
      entry.use.assertCurrent()
    } catch (error) {
      void this.startClose(entry, requestId)
      throw this.safe(error, requestId)
    }
    return entry
  }

  private trackCarrier<T>(entry: Entry, actual: Promise<T>, release: () => void): Promise<T> {
    const tracked = actual.finally(() => { release(); entry.tasks.delete(tracked); this.finish(entry) })
    entry.tasks.add(tracked)
    return tracked
  }

  private releaseCarrier(entry: Entry): void {
    this.carriers--
    this.increment(this.loginCarrierCounts, entry.principal.authSessionId, -1)
    entry.carrierCount--
    this.increment(this.carrierCounts, entry.binding.accountId, -1)
    this.finish(entry)
  }

  private waitReady(entry: Entry, deadlineAtMs: number, signal: AbortSignal | undefined, requestId: RequestId): Promise<LoginPeer> {
    if (entry.phase === 'ready' && entry.handle !== undefined) return Promise.resolve(entry.handle)
    return new Promise<LoginPeer>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); entry.waiters.delete(waiter) }
      const waiter: ReadyWaiter = {
        resolve: (handle) => { cleanup(); resolve(handle) },
        reject: (error) => { cleanup(); reject(error) },
      }
      const abort = (): void => { waiter.reject(new AuthAccessError('cloud/account-unavailable', requestId)) }
      const timer = setTimeout(abort, Math.min(2_147_483_647, deadlineAtMs - Date.now()))
      entry.waiters.add(waiter)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted === true) abort()
    })
  }

  private async wait<T>(actual: Promise<T>, deadlineAtMs: number, signal: AbortSignal | undefined, requestId: RequestId): Promise<T> {
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) throw new AuthAccessError('cloud/stop-unconfirmed', requestId)
    const cancelled = Promise.withResolvers<T>()
    const abort = (): void => { cancelled.reject(new AuthAccessError('cloud/stop-unconfirmed', requestId)) }
    const timer = setTimeout(abort, Math.min(2_147_483_647, deadlineAtMs - Date.now()))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) abort()
    try { return await Promise.race([actual, cancelled.promise]) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }

  private isPreparing(entry: Entry): boolean { return entry.phase === 'preparing' }

  private checkDeadline(deadlineAtMs: number, requestId: RequestId): void {
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) throw new AuthAccessError('cloud/account-unavailable', requestId)
  }
  private safe(error: unknown, requestId: RequestId): AuthAccessError {
    return error instanceof AuthAccessError ? error : new AuthAccessError('cloud/account-unavailable', requestId, { cause: error })
  }
  private requestId(): RequestId { return randomUUID() as RequestId }
  private count<Key>(map: Map<Key, number>, key: Key): number { return map.get(key) ?? 0 }
  private increment<Key>(map: Map<Key, number>, key: Key, delta: number): void {
    const count = this.count(map, key) + delta
    if (count === 0) map.delete(key)
    else map.set(key, count)
  }
}
