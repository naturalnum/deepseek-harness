/** One-shot selected-server HTTP I/O retained by the original execution request owner. */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { isIP, Socket, type SocketConstructorOpts } from 'node:net'
import type { DuplexOptions } from 'node:stream'
import type { ApplicationReadRequest, ApplicationReadLimits, ApplicationReadResponse, RegisteredApplicationService } from './types.ts'

/** Explicit transport budgets; readable thresholds are combined with a fixed native read buffer. */
export interface HttpTransportLimits {
  readonly readBufferBytes: number
  readonly prefetchBytes: number
  readonly maxWireBytes: number
  readonly maxRequestHeaderBytes: number
  readonly maxPathBytes: number
  readonly timeoutMs: number
  readonly maxBufferPoolBytes: number
}
/** Captured only by Root from its original protected deployment selection. */
export interface SelectedServerHttpInput {
  readonly lifecycleBaseUrl: string
  readonly apiKey: string
  readonly limits: HttpTransportLimits
  /** @returns After the original selected-deployment lease is confirmed current. */
  assertCurrent(): void
}
/** Original execution owner supplies the exact registered sandbox and application port. */
export interface RegisteredHttpTarget {
  readonly sandboxId: string
  readonly port: number
  /** Original Root's conservative resident deadline in this Node process's monotonic clock; never a wire timestamp. */
  readonly deadlineAtMs: number
  /** @returns After original service/allocation registration and native scope are confirmed current. */
  assertCurrent(): void
}
/** Payload-buffer reservation; metadata entry count is separately charged by the original owner. */
export interface HttpRequestCharge {
  readonly retainedPayloadBytes: number
  readonly headerEntries: number
  readonly maxWireBytes: number
  readonly timeoutMs: number
}
/** The actual managed-service I/O record supplies this hook; the adapter owns no capacity table. */
export interface PreviewHttpOwner {
  /**
   * Synchronously reserve the original request/byte capacity and install this controller before returning.
   * A resolved settled promise proves local request/response/socket/read and consumer settlement; rejection
   * or a pending promise retains original unknown responsibility. Never release merely on signal abort.
   * @param input Original controller, terminal promise and complete bounded payload charge.
   * @returns Original current check and positive remaining HTTP timeout, no greater than the requested timeout.
   */
  retainRequest(input: { readonly controller: AbortController; readonly settled: Promise<void>; readonly charge: HttpRequestCharge }): {
    readonly timeoutMs: number
    /** @returns After the original retained request record is confirmed current. */
    assertCurrent(): void
  }
}
/** Fixed public error; underlying socket/parser details remain Root-private. */
export class PreviewHttpError extends Error {
  /**
   * @param code Existing ingress handling classification.
   * @param cause Private original I/O failure; omitted when no underlying failure exists.
   */
  constructor(readonly code: 'cloud/forbidden' | 'cloud/capacity' | 'cloud/account-unavailable' | 'cloud/stop-unconfirmed', cause?: unknown) {
    super('Service preview HTTP request refused.', { cause })
  }
}
function need(value: unknown, code: PreviewHttpError['code'] = 'cloud/forbidden'): asserts value {
  if (!value) throw new PreviewHttpError(code)
}
function positive(value: number): void {
  need(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'cloud/capacity')
}
function stopUnconfirmed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  const code: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  return code === 'cloud/stop-unconfirmed'
}
const allowedHeaders = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range'])

/**
 * Capture Root's selected server and exact registered target; no returned field reveals URLs, ports or secrets.
 * @param selection Protected server selection and original lease check.
 * @param target Original execution-owned sandbox/service target.
 * @param owner Original request-capacity and controller installer, not a replacement owner.
 * @returns Only the service's bounded HTTP response method; no login, registry, listener or shared agent.
 */
export function createSelectedServerHttp(selection: SelectedServerHttpInput, target: RegisteredHttpTarget,
  owner: PreviewHttpOwner): Pick<RegisteredApplicationService, 'withResponse'> {
  const base = new URL(selection.lifecycleBaseUrl), key = selection.apiKey, limits = Object.freeze({ ...selection.limits })
  const assertSelected = selection.assertCurrent.bind(selection), assertTarget = target.assertCurrent.bind(target)
  need(base.protocol === 'http:' && base.href === selection.lifecycleBaseUrl && base.pathname === '/v1'
    && !base.username && !base.password && !base.search && !base.hash && isIP(base.hostname) === 4)
  const [a, b] = base.hostname.split('.').map(Number)
  need(a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b !== undefined && b >= 16 && b <= 31)
  need(Number(base.port) >= 1024 && Number(base.port) <= 65535)
  need(key.length > 0 && key.length <= 1024 && /^[\x21-\x7e]+$/.test(key))
  for (const bound of Object.values(limits)) positive(bound)
  need(limits.readBufferBytes <= limits.prefetchBytes && limits.readBufferBytes <= limits.maxWireBytes)
  need(Buffer.poolSize <= limits.maxBufferPoolBytes, 'cloud/capacity')
  const sandboxId = target.sandboxId, port = target.port, residentDeadlineAtMs = target.deadlineAtMs
  need(/^[A-Za-z0-9_-]{1,256}$/.test(sandboxId) && Number.isInteger(port) && port >= 1024 && port <= 65535)
  need(Number.isFinite(residentDeadlineAtMs))
  const prefix = `${base.pathname}/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${port}`
  return Object.freeze({
    async withResponse(request: ApplicationReadRequest, responseLimits: ApplicationReadLimits, signal: AbortSignal,
      consume: (response: ApplicationReadResponse) => Promise<void>): Promise<void> {
      // The fixed 1.1.1 route does not register HEAD; never substitute GET or try a second request.
      need(request.method === 'GET')
      const resource = request.resourcePath, parsed = new URL(resource, 'http://application.invalid')
      need(resource.startsWith('/') && !resource.startsWith('//') && !/[\\#\u0000-\u0020\u007f]/u.test(resource)
        && parsed.origin === 'http://application.invalid' && parsed.pathname + parsed.search === resource
        && !/%(?:25|2f|5c)/i.test(parsed.pathname))
      const path = prefix + resource
      need(Buffer.byteLength(path) <= limits.maxPathBytes, 'cloud/capacity')
      for (const bound of [responseLimits.maxBodyBytes, responseLimits.maxChunkBytes, responseLimits.maxChunks,
        responseLimits.maxHeaderCount, responseLimits.maxHeaderBytes]) positive(bound)
      need(responseLimits.maxHeaderCount <= 128)
      const headers: Record<string, string> = { host: base.host, connection: 'close', 'OPEN-SANDBOX-API-KEY': key,
        'OpenSandbox-Access-Renew': 'skip' }
      need(request.headers.length <= responseLimits.maxHeaderCount, 'cloud/capacity')
      for (const [name, value] of request.headers) {
        need(allowedHeaders.has(name) && !Object.hasOwn(headers, name) && /^[\x20-\x7e]*$/.test(value))
        need(value.length <= limits.maxRequestHeaderBytes, 'cloud/capacity'); headers[name] = value
      }
      const requestBytes = Buffer.byteLength(`GET ${path} HTTP/1.1\r\n`
        + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n')
      need(requestBytes <= limits.maxRequestHeaderBytes, 'cloud/capacity')
      const retainStartedAtMs = performance.now()
      const timeoutMs = Math.floor(Math.min(limits.timeoutMs, residentDeadlineAtMs - retainStartedAtMs))
      need(timeoutMs > 0, 'cloud/account-unavailable')
      const controller = new AbortController(), terminal = Promise.withResolvers<void>()
      // The original owner observes the same promise; this handler prevents an unhandled-rejection side channel.
      void terminal.promise.catch((_error: unknown) => {})
      let retained: ReturnType<PreviewHttpOwner['retainRequest']>
      try {
        retained = owner.retainRequest({ controller, settled: terminal.promise, charge: {
          retainedPayloadBytes: responseLimits.maxBodyBytes + 1 + responseLimits.maxChunkBytes
            + 2 * limits.prefetchBytes + 4 * limits.readBufferBytes
            + 8 * (limits.maxRequestHeaderBytes + responseLimits.maxHeaderBytes) + 2 * limits.maxBufferPoolBytes,
          headerEntries: responseLimits.maxHeaderCount + request.headers.length + 4,
          maxWireBytes: limits.maxWireBytes, timeoutMs,
        } })
      } catch (error) { terminal.resolve(); throw error } // No socket, buffer or request exists yet.
      let req: ClientRequest | undefined, message: IncomingMessage | undefined, socket: Socket | undefined
      const reqClosed = Promise.withResolvers<void>(), messageClosed = Promise.withResolvers<void>()
      const socketClosed = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<IncomingMessage>()
      void ready.promise.catch((_error: unknown) => {})
      let wireBytes = 0, returnedBytes = 0, reading: Promise<Uint8Array | null> | undefined, closing: Promise<void> | undefined
      let transportClosing: Promise<void> | undefined, deadlineAt: number | undefined
      let failure: { error: unknown } | undefined
      const cancel = (): void => {
        req?.destroy(); message?.destroy(); socket?.destroy(); ready.reject(controller.signal.reason)
      }
      const externalAbort = (): void => { controller.abort(signal.reason) }
      const fail = (error: unknown): void => { if (!controller.signal.aborted) controller.abort(error) }
      const current = (): void => {
        if (deadlineAt !== undefined && performance.now() >= deadlineAt) fail(new PreviewHttpError('cloud/account-unavailable'))
        controller.signal.throwIfAborted(); assertSelected(); assertTarget(); retained.assertCurrent()
        if (deadlineAt !== undefined && performance.now() >= deadlineAt) fail(new PreviewHttpError('cloud/account-unavailable'))
        controller.signal.throwIfAborted()
        need(Buffer.poolSize <= limits.maxBufferPoolBytes, 'cloud/capacity')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const finishTransport = (): Promise<void> => {
        transportClosing ??= (async () => {
          cancel()
          if (req !== undefined) await reqClosed.promise
          if (message !== undefined) await messageClosed.promise
          if (socket !== undefined) await socketClosed.promise
          if (timer !== undefined) clearTimeout(timer)
        })()
        return transportClosing
      }
      const close = (reason?: unknown): Promise<void> => {
        closing ??= (async () => {
          const pending = reading
          if (reason !== undefined) fail(reason)
          else if (pending !== undefined || message !== undefined && !message.readableEnded) fail(new PreviewHttpError('cloud/forbidden'))
          await finishTransport()
          await Promise.allSettled(pending === undefined ? [] : [pending])
        })()
        return closing
      }
      controller.signal.addEventListener('abort', cancel, { once: true })
      signal.addEventListener('abort', externalAbort, { once: true })
      try {
        positive(retained.timeoutMs); need(retained.timeoutMs <= timeoutMs, 'cloud/capacity')
        if (signal.aborted) externalAbort()
        deadlineAt = Math.min(retainStartedAtMs + retained.timeoutMs, residentDeadlineAtMs)
        const remainingMs = Math.floor(deadlineAt - performance.now())
        need(remainingMs > 0, 'cloud/account-unavailable')
        timer = setTimeout(() => { fail(new PreviewHttpError('cloud/account-unavailable')) }, remainingMs)
        current()
        const readBuffer = Buffer.alloc(limits.readBufferBytes)
        req = httpRequest({ host: base.hostname, port: Number(base.port), method: 'GET', path, headers,
          maxHeaderSize: responseLimits.maxHeaderBytes, insecureHTTPParser: false, joinDuplicateHeaders: false,
          createConnection() {
            const socketOptions: SocketConstructorOpts & DuplexOptions = { readableHighWaterMark: limits.prefetchBytes,
              writableHighWaterMark: limits.maxRequestHeaderBytes,
              onread: {
                buffer: () => readBuffer.subarray(0, Math.min(readBuffer.length, Math.max(1, limits.maxWireBytes - wireBytes + 1))),
                callback(bytes, buffer): boolean {
                  wireBytes += bytes
                  if (wireBytes > limits.maxWireBytes) { fail(new PreviewHttpError('cloud/capacity')); return false }
                  // Copy the reusable native buffer before HTTP retains any body/header slices.
                  const copy = Buffer.alloc(bytes); copy.set(buffer.subarray(0, bytes))
                  const accepted = created.push(copy)
                  if (created.readableLength > limits.prefetchBytes + limits.readBufferBytes
                    || message !== undefined && message.readableLength > limits.prefetchBytes + limits.readBufferBytes) {
                    fail(new PreviewHttpError('cloud/capacity')); return false
                  }
                  return accepted
                },
              } }
            const created: Socket = new Socket(socketOptions)
            socket = created; created.once('close', () => { socketClosed.resolve() })
            created.once('connect', () => { try { current() } catch (error) { fail(error) } })
            created.on('error', (error: Error) => { fail(new PreviewHttpError('cloud/account-unavailable', error)) })
            return created
          } })
        req.maxHeadersCount = responseLimits.maxHeaderCount + 1
        req.once('close', () => { reqClosed.resolve() })
        req.on('error', (error: Error) => { fail(new PreviewHttpError('cloud/account-unavailable', error)) })
        const capture = (incoming: IncomingMessage): void => {
          message = incoming; incoming.once('close', () => { messageClosed.resolve() })
          incoming.on('error', (error: Error) => { fail(new PreviewHttpError('cloud/account-unavailable', error)) })
          if (incoming.rawHeaders.length > responseLimits.maxHeaderCount * 2
            || incoming.readableHighWaterMark !== limits.prefetchBytes) fail(new PreviewHttpError('cloud/capacity'))
        }
        req.once('response', (incoming) => { capture(incoming); ready.resolve(incoming) })
        req.once('upgrade', (incoming, upgraded) => { capture(incoming); fail(new PreviewHttpError('cloud/forbidden')); upgraded.destroy() })
        current(); need(socket !== undefined); socket.connect({ host: base.hostname, port: Number(base.port) }); req.end()
        const incoming = await ready.promise
        current()
        const responseHeaders: Array<readonly [string, string]> = []
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index], value = incoming.rawHeaders[index + 1]
          need(name !== undefined && value !== undefined); responseHeaders.push([name, value])
        }
        const read = async (maximum: number): Promise<Uint8Array | null> => {
          positive(maximum); need(maximum <= responseLimits.maxChunkBytes && closing === undefined)
          for (;;) {
            current()
            const value: unknown = incoming.read(Math.min(maximum, Math.max(1, incoming.readableLength)))
            if (value !== null) {
              need(Buffer.isBuffer(value) && value.length <= maximum)
              returnedBytes += value.length
              need(returnedBytes <= responseLimits.maxBodyBytes + 1, 'cloud/capacity'); return value
            }
            if (incoming.readableEnded) {
              await finishTransport(); controller.signal.throwIfAborted(); need(incoming.complete, 'cloud/account-unavailable')
              return null
            }
            need(!incoming.destroyed, 'cloud/account-unavailable')
            await new Promise<void>((resolve) => {
              const cleanup = (): void => {
                incoming.off('readable', wake); incoming.off('end', wake); incoming.off('close', wake)
                controller.signal.removeEventListener('abort', abort)
              }
              const wake = (): void => { cleanup(); resolve() }
              const abort = (): void => { cleanup(); resolve() }
              incoming.once('readable', wake); incoming.once('end', wake); incoming.once('close', wake)
              controller.signal.addEventListener('abort', abort, { once: true })
              if (controller.signal.aborted) abort()
              else if (incoming.readableLength > 0 || incoming.readableEnded || incoming.destroyed) wake()
            })
          }
        }
        need(incoming.statusCode !== undefined)
        const owned: ApplicationReadResponse = { status: incoming.statusCode, headers: responseHeaders,
          read(maximum) {
            need(reading === undefined)
            const actual = read(maximum); reading = actual
            void actual.then(() => { reading = undefined }, (_error: unknown) => { reading = undefined })
            return actual
          },
          close,
        }
        await consume(owned)
        controller.signal.throwIfAborted()
      } catch (error) { failure = { error } }
      finally {
        try {
          await close(failure?.error)
          if (failure !== undefined && stopUnconfirmed(failure.error)) terminal.reject(failure.error)
          else terminal.resolve()
        }
        catch (error) {
          failure = { error: new PreviewHttpError('cloud/stop-unconfirmed', error) }; terminal.reject(failure.error)
        }
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', externalAbort); controller.signal.removeEventListener('abort', cancel)
      }
      if (failure === undefined && controller.signal.aborted) failure = { error: controller.signal.reason }
      if (failure !== undefined) throw failure.error
    },
  })
}
