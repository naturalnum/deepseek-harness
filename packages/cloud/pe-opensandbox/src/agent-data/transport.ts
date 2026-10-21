/** Exclusive undici8.10 transport; no global dispatcher or remote ownership authority. */
import { Pool, type Dispatcher } from 'undici'
import { CARRIER_LIMITS } from './constants.ts'
import type { Route } from './types.ts'

/** One bounded request to the fixed origin; arbitrary URLs, retries and user streams are absent. */
export interface WireRequest { readonly route: Route; readonly headers: Record<string, string>; readonly body: Uint8Array }
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
  readonly #pool: Pool
  /**
   * Create one lazy exclusively owned Pool for the validated original endpoint.
   * @param origin - Fixed private origin validated from protected Root inputs.
   */
  constructor(origin: string) {
    this.#pool = new Pool(origin, { connections: CARRIER_LIMITS.concurrent, pipelining: 0,
      connectTimeout: CARRIER_LIMITS.requestMs, headersTimeout: CARRIER_LIMITS.requestMs,
      bodyTimeout: CARRIER_LIMITS.requestMs, maxHeaderSize: CARRIER_LIMITS.headers,
      maxResponseSize: CARRIER_LIMITS.reply, strictContentLength: true, allowH2: false,
      maxRequestsPerClient: 1 })
  }
  dispatch(request: WireRequest, events: WireEvents): void {
    // No global dispatcher, proxy, redirect/retry interceptor, URL supplied by an operation, or GET retry semantics.
    this.#pool.dispatch({ path: request.route, method: 'POST', headers: request.headers,
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
  async close(): Promise<void> { await this.#pool.close() }
  async destroy(): Promise<void> { await this.#pool.destroy(new Error('private_agent_transport_release')) }
}
