/** Root-private data transport through the exact selected server and original physical sandbox port. */
import { Pool, type Dispatcher } from 'undici'
import { CARRIER_LIMITS } from '../agent-data/constants.ts'
import type { OwnedTransport, WireEvents, WireRequest } from '../agent-data/transport.ts'

/** Exclusive ordinary data dispatcher; Root joins it after physical stop, independently of privileged bootstrap closure. */
export class RootAgentProxyTransport implements OwnedTransport {
  readonly #pool: Dispatcher
  readonly #headers: Record<string, string>
  readonly #prefix: string
  /** @param endpoint Exact original sandbox/agent-port proxy URL already validated by bootstrap.
   * @param headers Root's private selected-server and fixed endpoint headers; never accepted from an operation.
   * @param dispatcher Exclusive replacement for component tests; production owns a fresh real Pool.
   */
  constructor(endpoint: URL, headers: Record<string, string>, dispatcher?: Dispatcher) {
    this.#prefix = endpoint.pathname
    this.#headers = { ...headers, 'OpenSandbox-Access-Renew': 'skip' }
    this.#pool = dispatcher ?? new Pool(endpoint.origin, { connections: CARRIER_LIMITS.concurrent, pipelining: 0,
      connectTimeout: CARRIER_LIMITS.requestMs, headersTimeout: CARRIER_LIMITS.requestMs,
      bodyTimeout: CARRIER_LIMITS.requestMs, maxHeaderSize: CARRIER_LIMITS.headers,
      maxResponseSize: CARRIER_LIMITS.reply, strictContentLength: true, allowH2: false, maxRequestsPerClient: 1 })
  }
  /**
   * Send the original fixed-route request through the owned selected-server dispatcher.
   * @param request Original bounded wire request and authentication headers.
   * @param events Original client settlement callbacks, including unknown-response handling.
   */
  dispatch(request: WireRequest, events: WireEvents): void {
    this.#pool.dispatch({ path: this.#prefix + request.route, method: 'POST',
      headers: { ...this.#headers, ...request.headers }, body: Buffer.from(request.body),
      idempotent: false, blocking: true, headersTimeout: CARRIER_LIMITS.requestMs, bodyTimeout: CARRIER_LIMITS.requestMs }, {
      onRequestStart(controller: Dispatcher.DispatchController) {
        events.start(() => { controller.abort(new Error('private_agent_proxy_aborted')) })
      },
      onResponseStart(_controller, status, headers) { events.headers(status, headers) },
      onResponseData(_controller, chunk) { events.data(chunk) },
      onResponseEnd(_controller, trailers) { events.end(trailers) },
      onResponseError() { events.error() },
    })
  }
  /** Close the owned dispatcher. @returns Actual close settlement; rejection never certifies remote cleanup. */
  async close(): Promise<void> { await this.#pool.close() }
  /** Destroy the owned dispatcher. @returns Actual destruction settlement; physical-stop acknowledgement remains separate. */
  async destroy(): Promise<void> { await this.#pool.destroy(new Error('private_agent_proxy_release')) }
}
