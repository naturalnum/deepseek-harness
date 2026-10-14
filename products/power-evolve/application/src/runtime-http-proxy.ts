/** Original native HTTP bytes retain bounded queues and owned upstream transport lifetimes. */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RequestOptions } from 'node:https'
import { addAbortListener } from 'node:events'

/** Whole assets and individual native SSE frames have separate bounds. */
export interface RuntimeHttpLimits {
  readonly maxBytes: number
  readonly maxFrameBytes: number
  readonly handshakeMs: number
  readonly lifetimeMs: number
}

/** Transport-owned authentication headers and verified TLS credentials. */
export interface RuntimeHttpOptions extends RequestOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly method: 'GET' | 'HEAD'
  readonly events: boolean
  readonly limits: RuntimeHttpLimits
  readonly signal: AbortSignal
}

function closed(transport: IncomingMessage | ServerResponse | ReturnType<typeof httpRequest>): Promise<void> {
  if (transport.closed) return Promise.resolve()
  return new Promise((resolve) => { transport.once('close', resolve) })
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('Native HTTP downstream closed', { cause: reason })
}

function drain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (response.destroyed || signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const dispose = (): void => {
      response.off('drain', ready); response.off('close', ended)
      signal.removeEventListener('abort', aborted)
    }
    const ready = (): void => { dispose(); resolve() }
    const ended = (): void => { dispose(); reject(new Error('Native HTTP downstream closed')) }
    const aborted = (): void => { dispose(); reject(abortError(signal)) }
    response.once('drain', ready); response.once('close', ended)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** Forward one original asset or HMR channel, awaiting every upstream close even after caller cancellation.
 * @param response Admitted downstream response; no cookies or arbitrary upstream headers are copied.
 * @param url Server-selected fixed-origin target preserving the original resource and revision query.
 * @param options Original authentication, verified TLS and explicit transport budgets.
 * @returns Completion after request, response and downstream transports have closed.
 */
export async function proxyRuntimeHttp(response: ServerResponse, url: URL, options: RuntimeHttpOptions): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid native HTTP target')
  for (const value of Object.values(options.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid native HTTP transport budget')
  }
  options.signal.throwIfAborted()
  const controller = new AbortController(), incoming = Promise.withResolvers<IncomingMessage>()
  const { method, events, limits, signal, ...tls } = options
  let upstream: IncomingMessage | undefined, upstreamClosed: Promise<void> | undefined
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    ...tls, method, headers: { ...tls.headers, 'accept-encoding': 'identity' },
  })
  const requestClosed = closed(request), responseClosed = closed(response)
  const interrupt = (): void => {
    incoming.reject(controller.signal.reason ?? new Error('Native HTTP interrupted'))
    upstream?.destroy(); request.destroy()
  }
  controller.signal.addEventListener('abort', interrupt, { once: true })
  const parent = addAbortListener(signal, () => { controller.abort(signal.reason) })
  const downstream = (): void => { controller.abort(new Error('Native HTTP downstream closed')) }
  response.once('close', downstream)
  request.once('response', (value) => {
    upstream = value; upstreamClosed = closed(value)
    value.on('error', () => {})
    if (controller.signal.aborted) value.destroy()
    incoming.resolve(value)
  })
  request.once('error', (error) => { incoming.reject(error) })
  const timer = setTimeout(() => { controller.abort(new Error('Native HTTP handshake timed out')) }, limits.handshakeMs)
  const lifetime = setTimeout(() => { controller.abort(new Error('Native HTTP lifetime ended')) }, limits.lifetimeMs)
  request.end()
  try {
    const source = await incoming.promise
    clearTimeout(timer)
    controller.signal.throwIfAborted()
    const status = source.statusCode ?? 502
    if (status < 200 || status >= 300 && status < 400) throw new Error('Native HTTP redirects are refused')
    const contentType = source.headers['content-type'] ?? 'application/octet-stream'
    const sse = events && status === 200
    if (sse && !/^text\/event-stream(?:;|$)/iu.test(contentType)) throw new Error('Native HMR content type invalid')
    const length = source.headers['content-length']
    if (!sse && length !== undefined && (!/^\d+$/u.test(length) || Number(length) > limits.maxBytes)) {
      throw new Error('Native HTTP asset exceeds limit')
    }
    const headers: Record<string, string> = { 'content-type': contentType, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
    if (!sse && length !== undefined) headers['content-length'] = length
    response.writeHead(status, headers)
    let bytes = 0, frameBytes = 0, tail = 0
    for await (const chunk of source) {
      controller.signal.throwIfAborted()
      if (!Buffer.isBuffer(chunk)) throw new Error('Native HTTP byte chunk invalid')
      bytes += chunk.length
      if (!sse && bytes > limits.maxBytes) throw new Error('Native HTTP asset exceeds limit')
      if (sse) for (const byte of chunk) {
        frameBytes++; tail = (tail << 8 | byte) >>> 0
        if (frameBytes > limits.maxFrameBytes) throw new Error('Native HMR frame exceeds limit')
        if ((tail & 0xffff) === 0x0a0a || tail === 0x0d0a0d0a) frameBytes = 0
      }
      if (!response.write(chunk)) await drain(response, controller.signal)
    }
    if (!source.complete) throw new Error('Native HTTP response incomplete')
    response.end()
  } catch (error) {
    interrupt()
    if (response.headersSent || signal.aborted) response.destroy()
    throw error
  } finally {
    clearTimeout(timer); clearTimeout(lifetime)
    parent[Symbol.dispose](); response.off('close', downstream)
    interrupt()
    await Promise.all([requestClosed, ...(upstreamClosed ? [upstreamClosed] : [])])
    if (response.writableEnded || response.destroyed) await responseClosed
  }
}
