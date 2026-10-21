/** Bounded public ConnectionConfig adaptation; no SDK private fields or swallowed dispatcher-close errors. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { ConnectionConfig } from '@alibaba-group/opensandbox'
import { Agent } from 'undici'
import { SdkLifecycleFailure, type OwnedSdkTransport, type SdkLifecycleConfig } from './lifecycle-types.ts'

/** Explicit transport limits; Root supplies deployment values, including one finite connection pool. */
export interface OwnedTransportLimits {
  readonly connections: number
  readonly connectTimeoutMs: number
  readonly headersTimeoutMs: number
  readonly bodyTimeoutMs: number
  readonly keepAliveTimeoutMs: number
  readonly maxHeaderBytes: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
}

/**
 * Create one dedicated bounded HTTP dispatcher whose caller owns actual close and close failures.
 * @param limits Validated finite Root pool limits.
 * @returns Exclusive fetch/close capabilities; construction alone sends no request.
 */
export function createOwnedSdkTransport(limits: OwnedTransportLimits): OwnedSdkTransport {
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new SdkLifecycleFailure('sdk/bounds')
  const dispatcher = new Agent({ connections: limits.connections, connectTimeout: limits.connectTimeoutMs,
    headersTimeout: limits.headersTimeoutMs, bodyTimeout: limits.bodyTimeoutMs, keepAliveTimeout: limits.keepAliveTimeoutMs,
    keepAliveMaxTimeout: limits.keepAliveTimeoutMs, maxHeaderSize: limits.maxHeaderBytes, pipelining: 1 })
  return { fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    const method = request.method
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') throw new SdkLifecycleFailure('sdk/selection')
    const payload = request.body === null ? null : Buffer.from(await request.arrayBuffer())
    if (payload !== null && payload.byteLength > limits.maxRequestBytes) throw new SdkLifecycleFailure('sdk/bounds')
    // Dispatcher request has no Fetch421 retry or redirect adapter; every request is explicitly non-idempotent.
    const response = await dispatcher.request({ origin: url.origin, path: `${url.pathname}${url.search}`, method,
      headers: Object.fromEntries(request.headers), body: payload, signal: request.signal, idempotent: false })
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
      else if (value !== undefined) headers.set(name, value)
    }
    const chunks: Buffer[] = []; let bytes = 0
    try {
      for await (const chunk of response.body) {
        const value: unknown = chunk
        if (!(value instanceof Uint8Array)) throw new SdkLifecycleFailure('sdk/bounds')
        const buffer = Buffer.from(value); bytes += buffer.byteLength
        if (bytes > limits.maxResponseBytes) throw new SdkLifecycleFailure('sdk/bounds')
        chunks.push(buffer)
      }
    } finally { response.body.destroy() }
    return new Response(bytes ? Buffer.concat(chunks) : null, { status: response.statusCode, headers })
  }, close: () => dispatcher.close() }
}

/** Shared bytes/deadline across every page or readiness read in one finite operation. */
export interface WireBudget {
  readonly deadlineAtMs: number
  bytes: number
}

interface WireWork {
  readonly budget: WireBudget
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly pathname: string
  readonly expectedStatus: number
  requests: number
}

/** Public subclass used only by this adapter's LifecycleStack; endpoint/SSE/application access is not exposed. */
export class BoundedLifecycleConnection extends ConnectionConfig {
  private readonly context = new AsyncLocalStorage<WireWork>()
  private readonly pending = new Set<Promise<Response>>()
  private closing = false
  private closeActual: Promise<void> | undefined
  private readonly selected: URL

  /** @param config Fixed selected-server configuration.
   * @param transport Original dedicated transport, never shared with account clients.
   */
  constructor(private readonly config: SdkLifecycleConfig, private readonly transport: OwnedSdkTransport) {
    super({ domain: config.lifecycleBaseUrl, apiKey: config.apiKey, requestTimeoutSeconds: config.requestTimeoutMs / 1000,
      useServerProxy: true, endpointCacheDisabled: true, disableMetrics: true, debug: false })
    this.selected = new URL(config.lifecycleBaseUrl)
    new Headers({ 'OPEN-SANDBOX-API-KEY': config.apiKey })
    if (!['http:', 'https:'].includes(this.selected.protocol) || this.selected.username || this.selected.password
      || this.selected.search || this.selected.hash || this.getBaseUrl() !== config.lifecycleBaseUrl || !config.apiKey) throw new SdkLifecycleFailure('sdk/bounds')
  }

  override get fetch(): typeof globalThis.fetch {
    return (input, init) => {
      const work = this.context.getStore()
      if (this.closing || work === undefined) return Promise.reject(new SdkLifecycleFailure('sdk/closed'))
      const actual = this.request(work, input, init)
      this.pending.add(actual)
      void actual.then(() => this.pending.delete(actual), () => this.pending.delete(actual))
      return actual
    }
  }

  /** @returns Rejected promise: streaming execution is owned by Root's separate agent client. */
  override get sseFetch(): typeof globalThis.fetch { return () => Promise.reject(new SdkLifecycleFailure('sdk/selection')) }
  override get ownsTransport(): boolean { return true }

  /**
   * Execute an SDK call under the exact selected-server method/path policy and shared wire budget.
   * @param budget Original finite operation deadline and shared byte accounting.
   * @param method One allowed SDK request method.
   * @param suffix Exact SDK lifecycle path suffix.
   * @param expectedStatus Required successful status, including positive204; SDK error responses retain their status.
   * @param run Original SDK call.
   * @returns Actual SDK settlement; each intercepted response is completely consumed within the wire budget.
   */
  run<T>(budget: WireBudget, method: WireWork['method'], suffix: string, expectedStatus: number, run: () => Promise<T>): Promise<T> {
    if (this.closing || !Number.isSafeInteger(budget.deadlineAtMs) || budget.deadlineAtMs <= Date.now()) throw new SdkLifecycleFailure('sdk/closed')
    return this.context.run({ budget, method, pathname: `${this.selected.pathname}${suffix}`, expectedStatus, requests: 0 }, run)
  }

  /** @returns Actual transport settlement; rejection remains sticky and never means clean. */
  override closeTransport(): Promise<void> {
    this.closing = true
    return this.closeActual ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending])
      await this.transport.close()
    })()
  }

  private async request(work: WireWork, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.origin !== this.selected.origin || url.pathname !== work.pathname || request.method !== work.method
      || request.headers.get('OPEN-SANDBOX-API-KEY') !== this.config.apiKey || ++work.requests !== 1) throw new SdkLifecycleFailure('sdk/selection')
    const remaining = Math.min(this.config.requestTimeoutMs, work.budget.deadlineAtMs - Date.now())
    if (remaining < 1) throw new SdkLifecycleFailure('sdk/bounds')
    const controller = new AbortController(), timer = setTimeout(() => { controller.abort(new SdkLifecycleFailure('sdk/bounds')) }, remaining)
    const signal = AbortSignal.any([request.signal, controller.signal])
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await this.transport.fetch(request, { signal, redirect: 'error' })
      if (response.redirected || (response.url && response.url !== request.url)) throw new SdkLifecycleFailure('sdk/selection')
      const chunks: Uint8Array[] = []; let size = 0
      if (response.body !== null) {
        reader = response.body.getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength; work.budget.bytes += chunk.value.byteLength
          if (size > this.config.maxResponseBytes || work.budget.bytes > this.config.maxOperationBytes) {
            throw new SdkLifecycleFailure('sdk/bounds')
          }
          chunks.push(chunk.value)
        }
      }
      signal.throwIfAborted()
      if (Date.now() >= work.budget.deadlineAtMs) throw new SdkLifecycleFailure('sdk/bounds')
      if (response.status >= 200 && response.status < 300 && response.status !== work.expectedStatus) {
        throw new SdkLifecycleFailure(work.method === 'DELETE' ? 'sdk/stop-unknown' : 'sdk/selection',
          { statusCode: response.status, requestId: response.headers.get('x-request-id')?.slice(0, this.config.maxFieldBytes) })
      }
      const bytes = Buffer.concat(chunks)
      return new Response(bytes.length ? bytes : null, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      })
    } finally {
      controller.abort(); clearTimeout(timer)
      if (reader !== undefined) { try { await reader.cancel() } finally { reader.releaseLock() } }
    }
  }
}
