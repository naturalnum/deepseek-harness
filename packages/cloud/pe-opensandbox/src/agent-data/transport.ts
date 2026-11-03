/** Exclusive undici8.10 transport; no global dispatcher or remote ownership authority. */
import { Pool, WebSocket, buildConnector, type Dispatcher } from 'undici'
import type { Socket } from 'node:net'
import { CARRIER_LIMITS } from './constants.ts'
import { STREAM_LIMITS } from './role-protocol.ts'
import { LocalRefusal } from './errors.ts'
import type { Route } from './types.ts'

function headerPairs(value: NonNullable<Dispatcher.DispatchOptions['headers']>): value is Iterable<[string, string | string[] | undefined]> {
  return Symbol.iterator in value
}

/** Decline compression on the caller-to-proxy hop before the original Pool sends Undici's automatic offer. */
const rawWebSocket: Dispatcher.DispatcherComposeInterceptor = dispatch => (options, handler) => {
  const source = options.headers, headers: string[] = []
  if (Array.isArray(source) && typeof source[0] === 'string') {
    for (let i = 0; i < source.length; i += 2) {
      const key = source[i], value = source[i + 1]
      if (key === undefined || value === undefined) throw new LocalRefusal('stream_transport_headers')
      if (key.toLowerCase() !== 'sec-websocket-extensions') headers.push(key, value)
    }
  } else if (source !== undefined && source !== null) {
    const entries = headerPairs(source) ? source : Object.entries(source)
    for (const [key, value] of entries) {
      if (key.toLowerCase() === 'sec-websocket-extensions' || value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) headers.push(key, String(item))
    }
  }
  return dispatch({ ...options, headers }, handler)
}

/** One bounded request to the fixed origin; arbitrary URLs, retries and user streams are absent. */
export interface WireRequest { readonly route: Route; readonly headers: Record<string, string>; readonly body: Uint8Array }
/** One fixed-route stream upgrade with the original private credentials only in headers. */
export interface WireStreamRequest { readonly headers: Record<string, string> }
/** Actual socket events; error alone does not discharge the terminal close obligation. */
export interface WireStreamEvents {
  /** The original WebSocket handshake completed with the fixed subprotocol. */
  open(): void
  /** One binary message, bounded by the parser before its payload is buffered. */
  data(bytes: Uint8Array): void
  /** Record failure without forwarding a secret-bearing library error. */
  error(): void
  /** The actual connection closed; this is not a remote process-exit fact. */
  closed(): void
}
/** One exclusively owned connection on the same dispatcher; no reconnect or operation authority. */
export interface OwnedWireStream {
  /** Send one frame, waiting for actual local pending WS bytes to drain before another frame. */
  send(bytes: Uint8Array): Promise<void>
  /** Request original connection closure; its closed callback remains the actual join. */
  close(): void
}
/** Actual undici request events; only terminal end/error settles request ownership. */
export interface WireEvents {
  /**
   * Retain the actual request abort callback without claiming settlement.
   * @param abort - Transport cancellation request, whose completion still requires a terminal event.
   */
  start(abort: () => void): void
  /**
   * Inspect the received response framing before buffering data.
   * @param status - Parsed HTTP status.
   * @param headers - Header values constrained by the transport parser budget.
   */
  headers(status: number, headers: Record<string, string | string[] | undefined>): void
  /**
   * Receive a raw response chunk under the finite reply allowance.
   * @param chunk - Bytes emitted by the actual request, without text decoding.
   */
  data(chunk: Uint8Array): void
  /**
   * Finish response reception and settle the actual local request.
   * @param trailers - Parsed trailers, required to be empty by this protocol.
   */
  end(trailers: Record<string, string | string[] | undefined>): void
  /** Settle an actual failed request without exposing a raw library error or secret-bearing cause. */
  error(): void
}
/** Exclusive ownership transfers to one data client. Fake implementations are test-only. */
export interface OwnedTransport {
  /**
   * Submit one request without retry/redirect, retaining its terminal event obligation.
   * @param request - Fixed-origin route, private headers and finite serialized body.
   * @param events - Owner callbacks for actual response/error settlement.
   */
  dispatch(request: WireRequest, events: WireEvents): void
  /** Optional only for old test doubles; production uses the same owned dispatcher for the fixed stream route. */
  attach?(request: WireStreamRequest, events: WireStreamEvents): OwnedWireStream
  /**
   * Close this exclusively owned dispatcher gracefully.
   * @returns Actual dispatcher closure acknowledgement after queued work settles.
   */
  close(): Promise<void>
  /**
   * Destroy this dispatcher when graceful closure is failed or overdue.
   * @returns Actual destruction acknowledgement; pending requests still require their terminal events.
   */
  destroy(): Promise<void>
}

/** Real undici8.10 Pool implementation using onRequestStart; not compatible with a blind version7 downgrade. */
export class UndiciOwnedTransport implements OwnedTransport {
  readonly #pool: Dispatcher
  readonly #origin: string
  readonly #sockets = new Set<Socket>()
  readonly #streams = new Set<WebSocket>()
  #closing = false
  /**
   * Create one lazy exclusively owned Pool for the validated original endpoint.
   * @param origin - Fixed private origin validated from protected Root inputs.
   */
  constructor(origin: string, private readonly proxy: { readonly prefix: string; readonly headers: Record<string, string> }
    = { prefix: '', headers: {} }, dispatcher?: Dispatcher) {
    this.#origin = origin
    const connect = buildConnector({ timeout: CARRIER_LIMITS.requestMs, allowH2: false })
    this.#pool = dispatcher ?? new Pool(origin, { connections: CARRIER_LIMITS.httpConcurrent, pipelining: 0,
      connect: (options, callback) => {
        connect(options, (error, socket) => {
          if (error !== null) { callback(new Error('private_agent_connect_failed'), null); return }
          for (const old of this.#sockets) if (old.closed) this.#sockets.delete(old)
          this.#sockets.add(socket)
          callback(null, socket)
        })
      },
      connectTimeout: CARRIER_LIMITS.requestMs, headersTimeout: CARRIER_LIMITS.requestMs,
      bodyTimeout: CARRIER_LIMITS.requestMs, maxHeaderSize: CARRIER_LIMITS.headers,
      maxResponseSize: CARRIER_LIMITS.reply, strictContentLength: true, allowH2: false,
      maxRequestsPerClient: 1, webSocket: { maxPayloadSize: STREAM_LIMITS.frameBytes + 12, maxFragments: 1 } })
  }
  attach(request: WireStreamRequest, events: WireStreamEvents): OwnedWireStream {
    if (this.#closing || this.#streams.size >= 2) throw new LocalRefusal('stream_transport_capacity')
    const url = new URL(this.proxy.prefix + '/stream', this.#origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { protocols: [STREAM_LIMITS.version],
      headers: { ...this.proxy.headers, ...request.headers }, dispatcher: this.#pool.compose(rawWebSocket) })
    this.#streams.add(socket)
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => {
      if (socket.protocol !== STREAM_LIMITS.version || socket.extensions !== '') { events.error(); socket.close(); return }
      events.open()
    })
    socket.addEventListener('message', (event) => {
      const data: unknown = event.data
      if (!(data instanceof ArrayBuffer) || data.byteLength > STREAM_LIMITS.frameBytes + 12) {
        events.error(); socket.close(); return
      }
      events.data(new Uint8Array(data))
    })
    socket.addEventListener('error', () => { events.error() })
    socket.addEventListener('close', () => { this.#streams.delete(socket); events.closed() })
    let sending = false
    return {
      send(bytes) {
        if (sending || socket.readyState !== WebSocket.OPEN || bytes.length > STREAM_LIMITS.frameBytes + 12) {
          return Promise.reject(new LocalRefusal('stream_transport_unavailable'))
        }
        sending = true
        try { socket.send(bytes) }
        catch { sending = false; return Promise.reject(new LocalRefusal('stream_transport_unavailable')) }
        return new Promise((resolve, reject) => {
          const drain = () => {
            if (socket.readyState !== WebSocket.OPEN) { sending = false; reject(new LocalRefusal('stream_transport_unavailable')); return }
            if (socket.bufferedAmount === 0) { sending = false; resolve(); return }
            setTimeout(drain, 2)
          }
          drain()
        })
      },
      close() { socket.close() },
    }
  }
  dispatch(request: WireRequest, events: WireEvents): void {
    // No global dispatcher, proxy, redirect/retry interceptor, URL supplied by an operation, or GET retry semantics.
    this.#pool.dispatch({ path: this.proxy.prefix + request.route, method: 'POST', headers: { ...this.proxy.headers, ...request.headers },
      body: Buffer.from(request.body), idempotent: false, blocking: true,
      headersTimeout: CARRIER_LIMITS.requestMs, bodyTimeout: CARRIER_LIMITS.requestMs }, {
      onRequestStart(controller: Dispatcher.DispatchController) {
        events.start(() => { controller.abort(new Error('private_agent_request_aborted')) })
      },
      onResponseStart(_controller, status, headers) { events.headers(status, headers) },
      onResponseData(_controller, chunk) { events.data(chunk) },
      onResponseEnd(_controller, trailers) { events.end(trailers) },
      onResponseError() { events.error() },
    })
  }
  async close(): Promise<void> {
    this.#closing = true
    for (const socket of this.#streams) socket.close()
    await this.#pool.close()
    await this.#joinSockets()
  }
  async destroy(): Promise<void> {
    this.#closing = true
    for (const socket of this.#sockets) socket.destroy()
    await this.#pool.destroy(new Error('private_agent_transport_release'))
    // Upgrade moves a socket out of Pool ownership. The original transport still owns its actual close.
    for (const socket of this.#sockets) socket.destroy()
    await this.#joinSockets()
  }
  async #joinSockets(): Promise<void> {
    await Promise.all([...this.#sockets].map(socket => socket.closed ? Promise.resolve() : new Promise<void>((resolve) => {
      socket.once('close', () => { resolve() })
    })))
  }
}
