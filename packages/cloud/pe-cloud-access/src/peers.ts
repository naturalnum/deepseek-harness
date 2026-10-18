/** Internal C-02 login Peer ownership. Root remains closed until native account assembly exists. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Peer, HostConnectionService, type ConnectionDispatch } from '@deepseek-ai/dsh-client-connection'
import { TypertGatewayService, type NodeStreamTransport } from '@deepseek-ai/dsh-api-gateway'
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

type RequestId = Branded<'pe-request-id'>
type LoginId = AuthenticatedPrincipal['authSessionId']
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
  readonly tasks: Set<Promise<void>>
  readonly carriers: Set<{ destroy(): void }>
  readonly lifetimeEnded: () => void
  phase: 'preparing' | 'ready' | 'closing' | 'blocked'
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
}

/**
 * Internal registry for a verified login and one trusted native account epoch.
 * Preparing and uncertain cleanup retain Peer capacity. Every actual native cleanup remains observed.
 * No request cancellation is passed to runtime borrow or to an Agent.
 */
export class LoginPeerRegistry {
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
   * @param config - Validated finite admission/cleanup budgets.
   * @param auth - Actual M1 adapter.
   * @param ports - Trusted runtime and exposure callbacks.
   */
  constructor(private readonly config: AccessConfig, private readonly auth: BetterAuthAccess, private readonly ports: LoginPeerPorts) {
    this.streams = ports.streams === undefined ? undefined : new StreamCapacity(ports.streams)
  }

  /** Reserved login slots. @returns Count including preparing and uncertain cleanup. */
  get reservedPeers(): number { return this.entries.size }
  /** Reserved carrier slots. @returns Actual HTTP/upgrade operations and live upgraded sockets. */
  get reservedCarriers(): number { return this.carriers }
  /** Pending creation callers. @returns Waiting records; abandonment leaves actual creation running. */
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
        waiters: new Set(), tasks: new Set(), carriers: new Set(), phase: 'preparing', preparing: true,
        use: undefined, handle: undefined, connection: undefined, mux: undefined, cleanupFault: false, removeObserver: undefined,
        nativeCleanup: undefined, cleanup: undefined,
        timer: undefined, recheck: undefined, carrierCount: 0, streamCount: 0,
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
   * Reauthenticate this carrier before invoking the real native HTTP bridge with the fixed Peer.
   * A finite carrier reservation joins any due original-Cookie recheck before synchronous dispatch guards.
   * @param handle - Shared login Peer; root already checked client account/generation expectations.
   * @param request - Original raw Node request, preserving native JSON and stream decoding.
   * @param response - Original Node response; disconnect closes only this carrier.
   * @param maxRequestBodyBytes - Required native body budget from trusted assembly.
   * @param requestId - Server correlation id.
   * @returns Actual bridge settlement; caller timeout must not release this operation early.
   */
  handleNodeRequest(
    handle: LoginPeer, request: IncomingMessage, response: ServerResponse, maxRequestBodyBytes: number, requestId: RequestId,
  ): Promise<void> {
    const entry = this.admitCarrier(handle, requestId)
    entry.carriers.add(request)
    entry.carriers.add(response)
    const task = (async () => {
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
    })()
    return this.trackCarrier(entry, task, () => {
      entry.carriers.delete(request)
      entry.carriers.delete(response)
      this.releaseCarrier(entry)
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
    entry.carriers.add(socket)
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
      entry.mux = gateway.createNodeStreamTransport(peer, (endpoint) => {
        const id = this.requestId()
        try { this.assertCurrent(handle, id); this.ports.beforeStream(endpoint, handle); this.assertCurrent(handle, id) }
        catch (error) {
          const failure = error instanceof AuthAccessError || error instanceof RequestBindingError ? error : undefined
          if (failure === undefined) throw error // Preserve the exposure owner's native RemoteError.
          throw new RemoteError(failure.code, failure.message, failure.toJSON())
        }
      }, this.ports.streams === undefined ? undefined : {
        maxFrameBytes: this.ports.streams.maxFrameBytes,
        acquireStream: (_endpoint: string) => {
          const id = this.requestId()
          this.assertCurrent(handle, id)
          const settle = this.streams?.acquire(entry.binding.accountId, entry, id, () => {
            entry.cleanupFault = true
            // Never await transport closure from the settlement callback of that same transport.
            queueMicrotask(() => { void this.startClose(entry, id) })
          })
          if (settle === undefined) throw new AuthAccessError('cloud/account-unavailable', id)
          entry.streamCount++
          let settled = false
          return (status: 'confirmed' | 'unknown') => {
            if (settled) return
            settled = true
            settle(status)
            if (status === 'confirmed') entry.streamCount--
          }
        },
      })
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
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.beginRecheck(entry) }, this.config.sessionRecheckMs)
    entry.timer.unref()
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
    for (const carrier of entry.carriers) carrier.destroy()
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

  private async authenticateCarrier(entry: Entry, request: IncomingMessage, requestId: RequestId): Promise<void> {
    const principal = await this.auth.authenticate(request, requestId)
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

  private trackCarrier(entry: Entry, actual: Promise<void>, release: () => void): Promise<void> {
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
