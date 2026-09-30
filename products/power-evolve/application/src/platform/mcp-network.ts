/** Operator-controlled DNS and socket transport for remote MCP; no ambient proxy or redirects. */
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import type { FetchLike } from '@modelcontextprotocol/client'

/** Explicit limits cover the entire handshake, directory, call, and session cleanup. */
export interface McpTransportBudgets {
  timeoutMs: number
  idleTimeoutMs: number
  maxRequestBytes: number
  maxResponseBytes: number
  maxTotalResponseBytes: number
  maxResponseHeaderBytes: number
  maxRequests: number
  maxHeaderBytes: number
  maxHeaders: number
  maxPages: number
  maxTools: number
  maxCatalogBytes: number
}

/** A privileged exception pins every resolved address for this exact origin. */
export interface McpInternalException {
  origin: string
  addresses: readonly string[]
  allowHttp?: boolean
  ca?: string
}

/** Resolver injection and private CAs belong to operator configuration, never connection credentials. */
export interface McpNetworkPolicy {
  internalExceptions?: readonly McpInternalException[]
  resolve?: (hostname: string) => Promise<readonly { address: string; family: number }[]>
}

/** Only these codes cross the caller boundary; remote messages and secrets are omitted. */
export type McpTransportErrorCode = 'invalid_config' | 'invalid_endpoint' | 'invalid_headers'
  | 'address_denied' | 'dns_failed' | 'request_limit' | 'response_limit' | 'catalog_limit'
  | 'invalid_catalog' | 'tool_not_found' | 'endpoint_changed' | 'redirect_denied'
  | 'unsupported_response' | 'transport_error' | 'protocol_error' | 'timeout' | 'aborted'
  | 'dispatch_rejected' | 'callback_uncertain' | 'dispatch_replay_denied'

/** dispatched is conservative: an interrupted pending permission callback may already have committed. */
export class McpTransportError extends Error {
  readonly phase: 'before-dispatch' | 'after-dispatch'
  constructor(readonly code: McpTransportErrorCode, readonly dispatched: boolean) {
    super(code)
    this.name = 'McpTransportError'
    this.phase = dispatched ? 'after-dispatch' : 'before-dispatch'
  }
}

/** Throw only after confirming the permission transaction issued no dispatch intent. */
export class McpDispatchRejected extends Error {
  constructor() { super('dispatch_rejected'); this.name = 'McpDispatchRejected' }
}

const forbiddenHeaders = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'content-length', 'content-type', 'accept', 'accept-encoding', 'expect',
  'cookie', 'cookie2', 'set-cookie', 'origin', 'referer', 'forwarded', 'via', 'proxy', 'x-real-ip',
  'http2-settings', 'last-event-id'])

function canonicalAddress(address: string): { address: string; family: 4 | 6; public: boolean } {
  if (!isIP(address) || address.includes('%')) throw new McpTransportError('address_denied', false)
  const parsed = ipaddr.process(address)
  return { address: parsed.toString(), family: parsed.kind() === 'ipv4' ? 4 : 6,
    public: parsed.range() === 'unicast'
      && (parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3)) }
}

/** Validate budgets before starting timers or resolving any address.
 * @param budgets Explicit, finite deployment limits.
 * @returns A copied immutable configuration.
 */
export function validateMcpBudgets(budgets: McpTransportBudgets): Readonly<McpTransportBudgets> {
  const values = [budgets.timeoutMs, budgets.idleTimeoutMs, budgets.maxRequestBytes,
    budgets.maxResponseBytes, budgets.maxTotalResponseBytes, budgets.maxResponseHeaderBytes,
    budgets.maxRequests, budgets.maxHeaderBytes, budgets.maxHeaders, budgets.maxPages,
    budgets.maxTools, budgets.maxCatalogBytes]
  if (values.some(value => !Number.isSafeInteger(value) || value < 1)
    || budgets.timeoutMs > 2_147_483_647 || budgets.idleTimeoutMs > budgets.timeoutMs
    || budgets.maxResponseBytes > budgets.maxTotalResponseBytes) {
    throw new McpTransportError('invalid_config', false)
  }
  return Object.freeze({ ...budgets })
}

/** Authentication headers cannot override SDK routing, session, or HTTP framing.
 * @param headers Private caller headers, copied before any await.
 * @param budgets Configured header count and encoded byte limits.
 * @returns Case-normalized private headers.
 */
export function validateMcpHeaders(headers: Readonly<Record<string, string>>,
  budgets: McpTransportBudgets): Record<string, string> {
  const result: Record<string, string> = {}
  let bytes = 0
  const entries = Object.entries(headers)
  if (entries.length > budgets.maxHeaders) throw new McpTransportError('invalid_headers', false)
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x1f\x7f\u0100-\uffff]/.test(value)
      || Object.hasOwn(result, lower) || forbiddenHeaders.has(lower)
      || /^(proxy-|sec-|mcp-|x-forwarded-)/.test(lower)) {
      throw new McpTransportError('invalid_headers', false)
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (bytes > budgets.maxHeaderBytes) throw new McpTransportError('invalid_headers', false)
    Object.defineProperty(result, lower, { value, enumerable: true })
  }
  return result
}

/** One operation owns all sockets, deadline, byte counters, and its single dispatch gate. */
export class McpNetworkOperation {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  dispatched = false
  private readonly deadline: ReturnType<typeof setTimeout>
  private readonly requests = new Set<ClientRequest>()
  private readonly closed: Promise<void>[] = []
  private requestCount = 0
  private responseBytes = 0
  private disposed = false
  private readonly callerAbort: () => void

  constructor(readonly budgets: Readonly<McpTransportBudgets>, callerSignal: AbortSignal) {
    this.signal = this.controller.signal
    this.deadline = setTimeout(() => this.fail('timeout'), budgets.timeoutMs)
    this.callerAbort = () => this.fail('aborted')
    callerSignal.addEventListener('abort', this.callerAbort, { once: true })
    this.detachCaller = () => callerSignal.removeEventListener('abort', this.callerAbort)
    if (callerSignal.aborted) this.callerAbort()
  }

  private readonly detachCaller: () => void

  /** Reject the operation and destroy every owned request with a safe error.
   * @param code Stable failure category.
   */
  fail(code: McpTransportErrorCode): void {
    if (!this.signal.aborted) this.controller.abort(new McpTransportError(code, this.dispatched))
    for (const request of this.requests) request.destroy()
  }

  /** Check the operation deadline before creating or sending any request. */
  check(): void {
    if (this.signal.aborted) throw this.error(this.signal.reason)
    if (this.disposed) throw new McpTransportError('aborted', this.dispatched)
  }

  /** Convert an SDK, TLS, or callback failure without copying its private message.
   * @param error Failure from an owned operation.
   * @returns Stable category with the current dispatch state.
   */
  error(error: unknown): McpTransportError {
    const code = this.signal.aborted && this.signal.reason instanceof McpTransportError
      ? this.signal.reason.code : error instanceof McpTransportError ? error.code : 'protocol_error'
    return new McpTransportError(code, this.dispatched)
  }

  /** Bound asynchronous DNS, SDK, and external permission work by the same deadline.
   * @param work Promise whose later completion cannot bypass check().
   * @returns Its result before the deadline or caller abort.
   */
  async bounded<T>(work: Promise<T>): Promise<T> {
    let onAbort: () => void = () => {}
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.error(this.signal.reason))
      if (this.signal.aborted) onAbort()
      else this.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([work, stopped])
      this.check()
      return result
    }
    finally { this.signal.removeEventListener('abort', onAbort) }
  }

  /** Resolve all destinations once, validate each, then pin every HTTP socket to one approved IP.
   * @param endpoint Exact caller endpoint, never followed to another URL.
   * @param policy Privileged operator exceptions and resolver.
   * @param beforeCall Gate immediately before the unique tools/call HTTP request.
   * @returns SDK-compatible streaming fetch using native Node sockets.
   */
  async fetchFor(endpoint: string, policy: McpNetworkPolicy,
    beforeCall: () => Promise<void>): Promise<{ url: URL; fetch: FetchLike }> {
    this.check()
    let url: URL
    try { url = new URL(endpoint) } catch (error) {
      // URL parser messages may contain credentials.
      throw new McpTransportError('invalid_endpoint', false)
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new McpTransportError('invalid_endpoint', false)
    }
    const exceptions = (policy.internalExceptions ?? []).map(item => ({ ...item, addresses: [...item.addresses] }))
    const resolveAddresses = policy.resolve ?? (name => lookup(name, { all: true, verbatim: true }))
    const origins = new Set<string>()
    for (const exception of exceptions) {
      let origin: URL
      try { origin = new URL(exception.origin) } catch (error) {
        // Operator configuration is also kept out of error text.
        throw new McpTransportError('invalid_config', false)
      }
      if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== exception.origin
        || origins.has(exception.origin) || !exception.addresses.length) {
        throw new McpTransportError('invalid_config', false)
      }
      origins.add(exception.origin)
      exception.addresses.forEach(canonicalAddress)
    }
    const exception = exceptions.find(item => item.origin === url.origin)
    if (url.protocol !== 'https:' && !exception?.allowHttp) throw new McpTransportError('address_denied', false)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    let resolved: readonly { address: string; family: number }[]
    try {
      resolved = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
        : await this.bounded(resolveAddresses(hostname))
    } catch (error) { throw error instanceof McpTransportError ? error : new McpTransportError('dns_failed', false) }
    this.check()
    if (!resolved.length) throw new McpTransportError('dns_failed', false)
    const allowed = new Set(exception?.addresses.map(item => canonicalAddress(item).address))
    const addresses = resolved.map(item => {
      if (item.family !== isIP(item.address)) throw new McpTransportError('address_denied', false)
      const address = canonicalAddress(item.address)
      if (exception ? !allowed.has(address.address) : !address.public) {
        throw new McpTransportError('address_denied', false)
      }
      return address
    })
    const pinned = addresses[0]!
    let callAttempted = false
    const send: FetchLike = async (input, init) => {
      this.check()
      const actual = input instanceof Request ? input.url : String(input)
      if (new URL(actual).href !== url.href) throw new McpTransportError('endpoint_changed', this.dispatched)
      const method = init?.method ?? 'GET'
      const body = init?.body
      if (!['POST', 'GET', 'DELETE'].includes(method) || body !== undefined && typeof body !== 'string') {
        throw new McpTransportError('invalid_config', this.dispatched)
      }
      if (body && Buffer.byteLength(body) > this.budgets.maxRequestBytes) {
        throw new McpTransportError('request_limit', this.dispatched)
      }
      if (++this.requestCount > this.budgets.maxRequests) throw new McpTransportError('request_limit', this.dispatched)
      const headers = new Headers(init?.headers)
      if (headers.has('last-event-id')) throw new McpTransportError('dispatch_replay_denied', this.dispatched)
      let headerBytes = 0
      headers.forEach((value, name) => { headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4 })
      if (headerBytes > this.budgets.maxHeaderBytes) throw new McpTransportError('request_limit', this.dispatched)
      headers.set('accept-encoding', 'identity')
      const requestSignal = init?.signal ? AbortSignal.any([this.signal, init.signal]) : this.signal
      if (requestSignal.aborted) throw new McpTransportError('aborted', this.dispatched)
      if (method === 'POST' && typeof body === 'string') {
        const message: { method?: string } = JSON.parse(body)
        if (message.method === 'tools/call') {
          if (callAttempted) throw new McpTransportError('dispatch_replay_denied', this.dispatched)
          callAttempted = true
          await this.bounded(beforeCall())
          this.check()
          if (requestSignal.aborted) throw new McpTransportError('aborted', this.dispatched)
        }
      }
      return this.request(url, pinned, exception?.ca, method, headers, body, requestSignal)
    }
    const controlled: FetchLike = async (input, init) => {
      try { return await send(input, init) }
      catch (error) {
        this.fail(error instanceof McpTransportError ? error.code : 'protocol_error')
        throw this.error(error)
      }
    }
    return { url, fetch: controlled }
  }

  private request(url: URL, pinned: { address: string; family: 4 | 6 }, ca: string | undefined,
    method: string, headers: Headers, body: string | undefined, signal: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      let ended = false
      const fail = (code: McpTransportErrorCode) => {
        const error = new McpTransportError(code, this.dispatched)
        reject(error)
        if (!ended) { ended = true; controller?.error(error) }
        this.fail(code)
      }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method, headers: Object.fromEntries(headers), agent: false, rejectUnauthorized: true,
        ...(isIP(url.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: url.hostname }),
        ...(ca === undefined ? {} : { ca }),
        maxHeaderSize: this.budgets.maxResponseHeaderBytes,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }])
          else callback(null, pinned.address, pinned.family)
        },
      }, response => {
        const status = response.statusCode ?? 500
        if (status >= 300 && status < 400) { response.destroy(); fail('redirect_denied'); return }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); fail('unsupported_response'); return
        }
        const length = response.headers['content-length']
        if (length && Number(length) > this.budgets.maxResponseBytes) { response.destroy(); fail('response_limit'); return }
        response.pause()
        let bytes = 0
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value },
          pull() { response.resume() },
          cancel: () => { ended = true; response.destroy(); request.destroy() },
        }, { highWaterMark: 0 })
        response.on('data', (chunk: Buffer) => {
          response.pause()
          bytes += chunk.length
          this.responseBytes += chunk.length
          if (bytes > this.budgets.maxResponseBytes || this.responseBytes > this.budgets.maxTotalResponseBytes) {
            fail('response_limit'); return
          }
          if (!ended) controller?.enqueue(chunk)
        })
        response.once('end', () => { if (!ended) { ended = true; controller?.close() } })
        response.once('error', () => fail('transport_error'))
        response.once('aborted', () => fail('transport_error'))
        response.once('close', () => { if (!response.complete && !ended) fail('transport_error') })
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const noBody = [204, 205, 304].includes(status)
        if (noBody) { ended = true; response.resume() }
        resolve(new Response(noBody ? null : stream, { status, headers: responseHeaders }))
      })
      this.requests.add(request)
      this.closed.push(new Promise(done => request.once('close', done)))
      request.once('socket', socket => { this.closed.push(new Promise(done => socket.once('close', () => done()))) })
      const abort = () => fail(this.signal.aborted && this.signal.reason instanceof McpTransportError
        ? this.signal.reason.code : 'aborted')
      signal.addEventListener('abort', abort, { once: true })
      request.once('close', () => { this.requests.delete(request); signal.removeEventListener('abort', abort) })
      request.once('error', error => fail('code' in error && error.code === 'HPE_HEADER_OVERFLOW'
        ? 'response_limit' : 'transport_error'))
      request.once('upgrade', (_response, socket) => { socket.destroy(); fail('unsupported_response') })
      request.setTimeout(this.budgets.idleTimeoutMs, () => fail('timeout'))
      if (signal.aborted) { abort(); return }
      request.end(body)
    })
  }

  /** Close local streams and await every owned request and socket becoming quiescent. */
  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.deadline)
    this.detachCaller()
    this.controller.abort(new McpTransportError('aborted', this.dispatched))
    for (const request of this.requests) request.destroy()
    let observed = 0
    while (observed < this.closed.length) {
      const pending = this.closed.slice(observed)
      observed = this.closed.length
      await Promise.all(pending)
    }
  }
}
