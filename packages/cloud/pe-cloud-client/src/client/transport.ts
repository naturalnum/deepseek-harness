/** Captured access expectations around native HTTP/WS carriers; no mux or RPC DTO ownership. */
import type {
  ClientTransportHooks, ConnectionWebSocket, ConnectionWebSocketFactory, RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client'
import type { BindingFieldNames, RequestExpectation } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { CloudClientConfig, CloudServicePreviewPolicy } from '../types.ts'
import { parseServicePreviewPolicy } from '../preview-policy.ts'
import type { CloudServicePreviewSelection } from './service-preview.ts'
import { servicePreviewUrl } from './preview-url.ts'
import type { BootstrapAttempt } from './bootstrap.ts'
import { ClientFailure, type ClientFailureCode } from './errors.ts'
import { readResponse, cancelResponseReader } from './read-response.ts'

/** The page captures these inputs only after the owner's real bootstrap decoder succeeds. */
export interface BoundTransportInput {
  readonly baseUrl: string
  readonly expectation: RequestExpectation
  readonly fields: BindingFieldNames
  /** Optional exact Root navigation policy; never widens ordinary HTTP/WS targets. */
  readonly servicePreview?: Readonly<CloudServicePreviewPolicy>
  readonly fetch: RpcFetch
  readonly createWebSocket: ConnectionWebSocketFactory
  readonly limits: Pick<CloudClientConfig, 'maxPendingFetches' | 'maxSockets' | 'maxErrorResponseBytes' | 'closeTimeoutMs'>
  /**
   * Recheck the captured identity after socket closure; omission leaves native reconnect behavior unchanged.
   * Identity rejection closes the carrier; transient failures preserve it. Cleanup uncertainty remains a close
   * failure, and actual settlement owns the single check slot.
   */
  readonly revalidate?: (signal: AbortSignal) => BootstrapAttempt<void>
  /** Revoke page persistence synchronously before any carrier is stopped. */
  readonly beforeClose?: (reason: ClientFailureCode) => void
}

interface SocketUse {
  readonly socket: ConnectionWebSocket
  readonly done: Promise<void>
}

/** Carrier disposition only; closed does not assert Agent cancellation or account drain. */
export interface TransportSnapshot {
  readonly phase: 'open' | 'closing' | 'closed' | 'unconfirmed'
  readonly reason: ClientFailureCode | undefined
  readonly pendingFetches: number
  readonly sockets: number
}

/** A single immutable account/generation lifetime, installed before native Connection starts. */
export class BoundTransport {
  /** Captured page admission lifetime; abortion grants no carrier or server cleanup receipt. */
  get signal(): AbortSignal { return this.abort.signal }
  private readonly base: URL
  private readonly expectation: Readonly<RequestExpectation>
  private readonly fields: Readonly<BindingFieldNames>
  private readonly preview: Readonly<CloudServicePreviewPolicy> | undefined
  private readonly limits: BoundTransportInput['limits']
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<Response>>()
  private readonly sockets = new Set<SocketUse>()
  private readonly cleanupFailures: unknown[] = []
  private phase: TransportSnapshot['phase'] = 'open'
  private reason: ClientFailureCode | undefined
  private closing: Promise<void> | undefined
  private revalidation: Promise<void> | undefined
  private readonly beforeClose: BoundTransportInput['beforeClose']
  private readonly revalidate: BoundTransportInput['revalidate']
  /** Native installer input; the original Connection still owns envelopes and correlation. */
  readonly hooks: ClientTransportHooks

  /** @param input - owner-validated expectations/field names and real native carrier factories. */
  constructor(input: BoundTransportInput) {
    this.beforeClose = input.beforeClose
    this.revalidate = input.revalidate
    this.base = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(this.base.protocol) || !this.base.pathname.endsWith('/')
      || this.base.search !== '' || this.base.hash !== '' || this.base.username !== '' || this.base.password !== '') {
      throw new ClientFailure('target-denied')
    }
    this.expectation = Object.freeze({ ...input.expectation })
    this.fields = Object.freeze({ ...input.fields })
    this.preview = input.servicePreview === undefined ? undefined : parseServicePreviewPolicy(input.servicePreview)
    if (this.preview !== undefined && this.preview.managementOrigin !== this.base.origin) throw new ClientFailure('target-denied')
    this.limits = Object.freeze({ ...input.limits })
    const send = input.fetch
    const createSocket = input.createWebSocket
    this.hooks = Object.freeze({
      fetch: (target: string | URL, init: RequestInit) => this.fetch(send, target, init),
      createWebSocket: (url: string) => this.openSocket(createSocket, url),
      streamBaseUrl: this.base.href,
    })
  }

  /**
   * Read the captured carrier's cleanup state and owned resource counts.
   * @returns resource counts without identities, cookies, or body content.
   */
  getSnapshot(): TransportSnapshot {
    return { phase: this.phase, reason: this.reason, pendingFetches: this.pending.size, sockets: this.sockets.size }
  }

  /**
   * Bind a navigation/download URL with the same captured expectations as HTTP and WS.
   * @param input - relative or same-origin URL beneath the app mount.
   * @returns an absolute URL with dedicated owner-selected query fields.
   */
  navigationUrl(input: string | URL): string {
    this.assertOpen()
    return this.bindQuery(this.target(input, false)).href
  }

  /**
   * Build a preview navigation URL only while this transport is open and has an explicit preview policy.
   * @param selection Original Session/handle pair.
   * @returns Exact preview GET URL using this carrier's immutable C02 values.
   */
  servicePreviewNavigationUrl(selection: CloudServicePreviewSelection): string {
    this.assertOpen()
    if (this.preview === undefined) throw new ClientFailure('target-denied')
    return servicePreviewUrl(selection, this.preview, this.fields, this.expectation)
  }

  /**
   * Reject new operations synchronously, then abort and join pending carriers and identity checks within the close budget.
   * A missed deadline retains unconfirmed state until the actual carriers settle.
   * @param reason - local disposition; omitted for an ordinary page lifetime end.
   * @returns the single close observation, rejecting when stop cannot be confirmed in budget.
   */
  close(reason: ClientFailureCode = 'closed'): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    this.phase = 'closing'
    this.reason = reason
    try { this.beforeClose?.(reason) } catch (error) { this.cleanupFailures.push(error) }
    this.abort.abort(new ClientFailure(reason))
    const uses = [...this.sockets]
    for (const { socket } of uses) {
      if (socket.readyState === 3) continue
      try {
        socket.close()
      } catch (error) {
        this.cleanupFailures.push(error)
      }
    }
    const work = Promise.allSettled([
      ...this.pending,
      ...this.revalidation === undefined ? [] : [this.revalidation],
      ...uses.filter(use => use.socket.readyState !== 3).map(use => use.done),
    ]).then(() => {
      if (this.cleanupFailures.length > 0) throw new ClientFailure('close-unconfirmed', new AggregateError(this.cleanupFailures))
      this.phase = 'closed'
    })
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new ClientFailure('close-unconfirmed')) }, this.limits.closeTimeoutMs)
    })
    void Promise.race([work, deadline]).finally(() => { clearTimeout(timer) }).then(completion.resolve, completion.reject)
    // Keep the automatic 401/stale invalidation observable even without an awaiting UI consumer.
    void this.closing.catch((_error: unknown) => { if (this.phase !== 'closed') this.phase = 'unconfirmed' })
    return this.closing
  }

  private assertOpen(): void {
    if (this.phase !== 'open') throw new ClientFailure(this.reason ?? 'closed')
  }

  private target(input: string | URL, socket: boolean): URL {
    const target = new URL(input, this.base)
    const protocol = socket ? (this.base.protocol === 'https:' ? 'wss:' : 'ws:') : this.base.protocol
    const authority = target.host === this.base.host
    if (!authority || target.protocol !== protocol || !target.pathname.startsWith(this.base.pathname)
      || target.username !== '' || target.password !== '' || target.hash !== '') {
      throw new ClientFailure('target-denied')
    }
    return target
  }

  private bindQuery(target: URL): URL {
    const pairs = [
      [this.fields.accountQuery, this.expectation.accountId],
      [this.fields.generationQuery, this.expectation.connectionGeneration],
    ] as const
    for (const [name, value] of pairs) {
      const prior = target.searchParams.getAll(name)
      if (prior.length > 1 || (prior.length === 1 && prior[0] !== value)) throw new ClientFailure('binding-conflict')
      target.searchParams.set(name, value)
    }
    return target
  }

  private fetch(send: RpcFetch, input: string | URL, init: RequestInit): Promise<Response> {
    this.assertOpen()
    if (this.pending.size >= this.limits.maxPendingFetches) throw new ClientFailure('capacity')
    const target = this.target(input, false)
    // A copied navigation URL must not smuggle a different expectation into a header-bound request.
    this.bindQuery(new URL(target))
    target.searchParams.delete(this.fields.accountQuery)
    target.searchParams.delete(this.fields.generationQuery)
    const headers = new Headers(init.headers)
    for (const [name, value] of [
      [this.fields.accountHeader, this.expectation.accountId],
      [this.fields.generationHeader, this.expectation.connectionGeneration],
    ] as const) {
      const prior = headers.get(name)
      if (prior !== null && prior !== value) throw new ClientFailure('binding-conflict')
      headers.set(name, value)
    }
    const signal = init.signal == null ? this.abort.signal : AbortSignal.any([init.signal, this.abort.signal])
    signal.throwIfAborted()
    const operation = this.send(send, target, { ...init, headers, signal, credentials: 'same-origin', redirect: 'error' }, signal)
      .finally(() => { this.pending.delete(operation) })
    this.pending.add(operation)
    return operation
  }

  private async send(send: RpcFetch, target: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await send(target, init)
    if (signal.aborted) {
      await this.discard(response, signal)
      signal.throwIfAborted()
    }
    if (response.status === 401) {
      void this.close('unauthenticated')
      await this.discard(response, signal)
      throw new ClientFailure('unauthenticated')
    }
    if (response.status !== 409) return response
    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = await readResponse(response, this.limits.maxErrorResponseBytes, signal)
    } catch (error) {
      if (error instanceof ClientFailure && error.code === 'close-unconfirmed') this.cleanupFailures.push(error)
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (_error: unknown) {
      // Non-cloud/native 409 responses remain available to the native transport unchanged.
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    if (typeof value === 'object' && value !== null && 'code' in value && value.code === 'cloud/stale-generation') {
      void this.close('stale-generation')
      throw new ClientFailure('stale-generation')
    }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  private async discard(response: Response, signal: AbortSignal): Promise<void> {
    if (response.body === null) return
    try {
      const reader = response.body.getReader()
      try { await cancelResponseReader(reader, signal.aborted ? signal.reason : undefined, signal) }
      finally { reader.releaseLock() }
    } catch (error) {
      this.cleanupFailures.push(error)
      throw new ClientFailure('close-unconfirmed', error)
    }
  }

  private revalidateBinding(): void {
    const revalidate = this.revalidate
    if (this.phase !== 'open' || revalidate === undefined || this.revalidation !== undefined) return
    const completion = Promise.withResolvers<void>()
    this.revalidation = completion.promise
    const check = async (): Promise<void> => {
      const attempt = revalidate(this.abort.signal)
      let failure: unknown
      try { await attempt.result } catch (error) {
        failure = error
        if (this.phase === 'open' && error instanceof ClientFailure
          && (error.code === 'unauthenticated' || error.code === 'stale-generation')) {
          // close joins this check; the check must never await that same close.
          void this.close(error.code)
        }
      }
      await attempt.settled
      if (attempt.getSnapshot().cleanup === 'unconfirmed') throw new ClientFailure('close-unconfirmed', failure)
    }
    void check().catch((error: unknown) => {
      this.cleanupFailures.push(error)
      if (this.phase === 'open') void this.close('close-unconfirmed')
    }).finally(() => {
      this.revalidation = undefined
      completion.resolve()
    })
  }

  private openSocket(createSocket: ConnectionWebSocketFactory, input: string): ConnectionWebSocket {
    this.assertOpen()
    if (this.sockets.size >= this.limits.maxSockets) throw new ClientFailure('capacity')
    const socket = createSocket(this.bindQuery(this.target(input, true)).href)
    const stopped = Promise.withResolvers<void>()
    const use: SocketUse = { socket, done: stopped.promise }
    const closed = (): void => {
      socket.removeEventListener('close', closed)
      this.sockets.delete(use)
      stopped.resolve()
      this.revalidateBinding()
    }
    this.sockets.add(use)
    socket.addEventListener('close', closed, { once: true })
    if (socket.readyState === 3) closed()
    return socket
  }
}
