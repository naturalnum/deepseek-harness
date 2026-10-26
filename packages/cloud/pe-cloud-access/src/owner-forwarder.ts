/** One-hop HTTP/WS byte transport. The caller alone owns auth, destination approval and business semantics. */
import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { checkServerIdentity, TLSSocket, type PeerCertificate } from 'node:tls'
import type { Readable, Writable, Duplex } from 'node:stream'
import { forwardHeaders, forwardRequestHeaders, responseHead } from './forward-headers.ts'
import { ForwardFailure, type ForwardCloseObservation, type ForwardInput, type ForwardLimits,
  type ForwardObservation, type ForwardSnapshot, type ForwardTarget, type ForwardTargetConfig,
  type ForwardTerminal, type ForwardTransfer } from './forward-types.ts'

type Resource = Readable | Writable | ClientRequest | ServerResponse
interface ResourceEvents {
  close: []
  error: [unknown]
  aborted: []
  connect: []
  secureConnect: []
  socket: [Duplex]
  information: []
  response: [IncomingMessage]
  upgrade: [IncomingMessage, Duplex, Buffer]
}
type Reply = { kind: 'response'; response: IncomingMessage }
  | { kind: 'upgrade'; response: IncomingMessage; socket: Duplex; head: Buffer }
interface TlsIdentity { readonly ca: Buffer; readonly cert: Buffer; readonly key: Buffer; readonly pin: string; readonly name: string }
interface Destination { readonly url: URL; readonly identity?: TlsIdentity }
const maximumTimer = 2_147_483_647

function verifyPeer(identity: TlsIdentity, certificate: PeerCertificate): Error | undefined {
  if (checkServerIdentity(identity.name, certificate) !== undefined || !Buffer.isBuffer(certificate.raw)
    || createHash('sha256').update(certificate.raw).digest('hex') !== identity.pin) return new ForwardFailure('identity')
  return undefined
}

/** Fixed target handles cannot be reconstructed from a request URL or headers. */
export class OwnerForwarder {
  private readonly handles = new Map<string, ForwardTarget>()
  private readonly destinations = new WeakMap<ForwardTarget, Destination>()
  private readonly operations = new Set<Transfer>()
  private readonly carriers = new Set<Duplex>()
  private readonly queue: Transfer[] = []
  private readonly stopped = Promise.withResolvers<undefined>()
  private readonly limits: ForwardLimits
  private readonly reservation: number
  private active = 0
  private closing = false
  private closingResult: Promise<ForwardCloseObservation> | undefined

  constructor(limits: ForwardLimits, targets: readonly ForwardTargetConfig[]) {
    for (const name of ['maxTargets', 'maxTargetBytes', 'maxPathBytes', 'maxConcurrent', 'maxQueued', 'maxConnections',
      'maxHeaderPairs', 'maxHeaderBytes', 'maxHeadBytes', 'maxChunkBytes', 'maxBufferedBytes', 'maxPendingBytes',
      'maxBodyBytes', 'maxTunnelBytes', 'queueTimeoutMs', 'connectTimeoutMs', 'operationTimeoutMs', 'closeTimeoutMs'] as const) {
      const value = limits[name]
      if (!Number.isSafeInteger(value) || value < 1 || name.endsWith('Ms') && value > maximumTimer) {
        throw new ForwardFailure('capacity')
      }
    }
    this.reservation = 2 * limits.maxHeaderBytes + 2 * limits.maxHeadBytes + 2 * limits.maxChunkBytes
      + 8 * limits.maxBufferedBytes + 256
    if (!Number.isSafeInteger(this.reservation) || this.reservation > limits.maxPendingBytes
      || limits.maxHeaderPairs > 0x3fff_fffe || limits.maxChunkBytes > limits.maxBufferedBytes
      || targets.length < 1 || targets.length > limits.maxTargets) {
      throw new ForwardFailure('capacity')
    }
    this.limits = Object.freeze({ ...limits })
    let identityBytes = 0
    if (limits.maxTlsIdentityBytes !== undefined && (!Number.isSafeInteger(limits.maxTlsIdentityBytes)
      || limits.maxTlsIdentityBytes < 1)) throw new ForwardFailure('capacity')
    for (const target of targets) {
      if (!target.id || Buffer.byteLength(target.id) > limits.maxTargetBytes || this.handles.has(target.id)
        || Buffer.byteLength(target.origin) > limits.maxTargetBytes) throw new ForwardFailure('protocol')
      let url: URL
      try { url = new URL(target.origin) } catch (error) { throw new ForwardFailure('protocol', error) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash) throw new ForwardFailure('protocol')
      let identity: TlsIdentity | undefined
      const material = target.tlsIdentity
      if (material !== undefined) {
        if (url.protocol !== 'https:' || !/^[\da-f]{64}$/iu.test(material.serverCertificateSha256)) throw new ForwardFailure('protocol')
        const name = material.servername ?? url.hostname.replace(/^\[|\]$/gu, '')
        if (!name || Buffer.byteLength(name) > limits.maxTargetBytes || /[\u0000-\u0020\u007f/:\\]/u.test(name)
          && isIP(name) === 0 || material.servername !== undefined && isIP(name) !== 0) throw new ForwardFailure('protocol')
        const parts = [material.ca, material.cert, material.key]
        if (parts.some(part => !(part instanceof Uint8Array) || part.byteLength === 0)) throw new ForwardFailure('protocol')
        identityBytes += parts.reduce((sum, part) => sum + part.byteLength, 0) + 64 + Buffer.byteLength(name)
        if (!Number.isSafeInteger(identityBytes) || limits.maxTlsIdentityBytes === undefined
          || identityBytes > limits.maxTlsIdentityBytes) throw new ForwardFailure('capacity')
        identity = { ca: Buffer.from(material.ca), cert: Buffer.from(material.cert), key: Buffer.from(material.key),
          pin: material.serverCertificateSha256.toLowerCase(), name }
      }
      const handle = Object.freeze({ id: target.id }) as ForwardTarget
      this.handles.set(target.id, handle); this.destinations.set(handle, { url, ...(identity === undefined ? {} : { identity }) })
    }
  }

  /**
   * Return only a preconfigured opaque target; this performs no connection or identity verification.
   * @param id Identifier from the original fixed target configuration.
   * @returns This forwarder's existing opaque handle; unknown identifiers are refused.
   */
  target(id: string): ForwardTarget {
    const target = this.handles.get(id)
    if (target === undefined) throw new ForwardFailure('protocol')
    return target
  }

  /**
   * Synchronous refusal leaves the original incoming carrier with its caller.
   * @param input Original incoming carrier, approved target, and caller lifetime.
   * @returns The accepted transfer's first observation and separately retained actual settlement.
   */
  forward(input: ForwardInput): ForwardTransfer {
    if (this.closing) throw new ForwardFailure('closed')
    const destination = this.destinations.get(input.target), carrier = input.kind === 'http' ? input.request.socket : input.socket
    if (destination === undefined || this.carriers.has(carrier)) throw new ForwardFailure('protocol')
    const path = input.request.url ?? '', method = input.request.method ?? ''
    if (input.request.httpVersion !== '1.1' || !path.startsWith('/') || path.startsWith('//') || /[\u0000-\u0020\u007f#]/u.test(path)
      || Buffer.byteLength(path) > this.limits.maxPathBytes || !/^[A-Z]+$/u.test(method) || method === 'CONNECT'
      || input.request.readableEncoding !== null || input.request.readableFlowing === true) throw new ForwardFailure('protocol')
    if (input.kind === 'upgrade' && (method !== 'GET' || input.head.length > this.limits.maxHeadBytes
      || input.request.headers['transfer-encoding'] !== undefined
      || input.request.headers['content-length'] !== undefined && input.request.headers['content-length'] !== '0')) {
      throw new ForwardFailure('protocol')
    }
    if (input.trustedRequestHeaders !== undefined && input.trustedRequestHeaders.length > 0 && destination.identity === undefined) {
      throw new ForwardFailure('protocol')
    }
    const headers = forwardRequestHeaders(input.request.rawHeaders, input.trustedRequestHeaders, this.limits, input.kind === 'upgrade')
    if (this.operations.size * 2 + 2 > this.limits.maxConnections
      || (this.operations.size + 1) * this.reservation > this.limits.maxPendingBytes
      || this.queue.length >= this.limits.maxQueued) {
      throw new ForwardFailure('capacity')
    }
    const work = new Transfer(input, destination, method, path, headers, this.limits,
      () => this.closing, () =>{  this.finish(work) })
    this.operations.add(work); this.carriers.add(carrier); this.queue.push(work)
    work.attach()
    this.drain()
    return work.handle
  }

  /**
   * Read current work and capacity counters without starting traffic.
   * @returns An immutable snapshot including resources retained beyond observation deadlines.
   */
  observe(): ForwardSnapshot {
    return Object.freeze({ closing: this.closing, active: this.active, queued: this.queue.length,
      retained: this.operations.size, reservedConnections: this.operations.size * 2,
      reservedBytes: this.operations.size * this.reservation })
  }

  /**
   * Stop admission before any cancellation callback; the first observation is retained even after late close.
   * @returns The retained first close observation; unknown can precede actual closure.
   */
  close(): Promise<ForwardCloseObservation> {
    if (this.closingResult !== undefined) return this.closingResult
    this.closing = true
    const observed = Promise.withResolvers<ForwardCloseObservation>()
    this.closingResult = observed.promise
    const timer = setTimeout(() => { observed.resolve({ status: 'unknown' }) }, this.limits.closeTimeoutMs)
    void this.stopped.promise.then(() => { clearTimeout(timer); observed.resolve({ status: 'confirmed' }) })
    for (const work of this.operations) work.cancel('closed')
    if (this.operations.size === 0) this.stopped.resolve(undefined)
    return observed.promise
  }

  /** Actual local resources remain retained beyond close()'s observation deadline. */
  whenClosed(): Promise<void> { return this.stopped.promise }

  private drain(): void {
    if (this.closing) return
    for (const work of [...this.queue]) {
      if (this.active >= this.limits.maxConcurrent) break
      if (work.stopping) continue
      this.queue.splice(this.queue.indexOf(work), 1); this.active++
      work.start()
    }
  }

  private finish(work: Transfer): void {
    if (!this.operations.delete(work)) return
    this.carriers.delete(work.input.kind === 'http' ? work.input.request.socket : work.input.socket)
    if (work.started) this.active--
    else this.queue.splice(this.queue.indexOf(work), 1)
    if (this.closing && this.operations.size === 0) this.stopped.resolve(undefined)
    else this.drain()
  }
}

class Transfer {
  readonly handle: ForwardTransfer
  readonly controller = new AbortController()
  private readonly actual = Promise.withResolvers<ForwardTerminal>()
  private readonly result = Promise.withResolvers<ForwardObservation>()
  private readonly resources = new Map<Resource, Promise<void>>()
  private readonly removals: (() => void)[] = []
  private readonly downstreamHead: Buffer
  private readonly children: Promise<void>[] = []
  private readonly reply = Promise.withResolvers<Reply>()
  private readonly socketAssigned = Promise.withResolvers<undefined>()
  private readonly identityReady = Promise.withResolvers<void>()
  private identityAccepted = false
  private failure: ForwardFailure | undefined
  private request: ClientRequest | undefined
  private upstreamResponse: IncomingMessage | undefined
  private upgraded = false
  private finishing = false
  private queueTimer: ReturnType<typeof setTimeout> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private runTimer: ReturnType<typeof setTimeout> | undefined
  private closeTimer: ReturnType<typeof setTimeout> | undefined
  private bytes = 0
  private tunnelBytes = 0
  private mayHaveReceived = false
  private upstreamStatus: number | undefined
  started = false
  stopping = false

  constructor(
    readonly input: ForwardInput, private readonly target: Destination, private readonly method: string,
    private readonly path: string, private readonly headers: string[], private readonly limits: ForwardLimits,
    private readonly isClosing: () => boolean, private readonly released: () => void,
  ) {
    this.downstreamHead = input.kind === 'upgrade' ? Buffer.from(input.head) : Buffer.alloc(0)
    this.handle = Object.freeze({ result: this.result.promise, settled: this.actual.promise,
      cancel: () => { this.cancel('cancelled') } })
    void this.reply.promise.catch((_error: unknown) => {})
    void this.identityReady.promise.catch((_error: unknown) => {})
  }

  attach(): void {
    const carrier = this.input.kind === 'http' ? this.input.request.socket : this.input.socket
    this.watch(carrier)
    this.watch(this.input.request)
    if (this.input.kind === 'http') {
      const response = this.input.response
      this.watch(response)
      this.on(response, 'close', () => { if (!response.writableFinished) this.cancel('io') })
      this.on(carrier, 'close', () => { if (!response.writableFinished) this.cancel('io') })
    } else {
      carrier.pause()
      this.on(carrier, 'close', () => { if (!carrier.readableEnded || !carrier.writableFinished) this.cancel('io') })
    }
    this.input.request.pause()
    this.on(this.input.request, 'aborted', () => { this.cancel('io') })
    const aborted = (): void => { this.cancel('cancelled') }
    this.input.lifetime.signal.addEventListener('abort', aborted, { once: true })
    this.removals.push(() => { this.input.lifetime.signal.removeEventListener('abort', aborted) })
    this.queueTimer = setTimeout(() => { this.cancel('timeout') }, this.limits.queueTimeoutMs)
    if (this.input.lifetime.signal.aborted) aborted()
  }

  start(): void {
    this.started = true
    clearTimeout(this.queueTimer)
    this.runTimer = setTimeout(() => { this.cancel('timeout') }, this.limits.operationTimeoutMs)
    void Promise.resolve().then(() => this.run()).catch((error: unknown) => { this.fail(error) }).then(() => this.finish())
  }

  cancel(code: ForwardFailure['code']): void { this.fail(new ForwardFailure(code)) }

  private checkState(): void {
    if (this.stopping || this.isClosing() || this.input.lifetime.signal.aborted) throw this.failure ?? new ForwardFailure('cancelled')
  }

  private check(): void {
    this.checkState()
    this.input.lifetime.assertCurrent()
    this.checkState()
  }

  private on<Event extends keyof ResourceEvents>(
    resource: Resource, event: Event, callback: (...args: ResourceEvents[Event]) => void,
  ): void {
    resource.on(event, callback)
    this.removals.push(() => { resource.off(event, callback) })
  }

  private watch(resource: Resource): void {
    if (this.resources.has(resource)) return
    const closed = Promise.withResolvers<void>()
    this.resources.set(resource, closed.promise)
    this.on(resource, 'close', () => { closed.resolve() })
    this.on(resource, 'error', (error: unknown) => { this.fail(error) })
    if ('closed' in resource && resource.closed) closed.resolve()
    if (this.stopping || this.finishing) this.destroy(resource)
  }

  private destroy(resource: Resource): void {
    try { resource.destroy() } catch (error) { this.failure ??= new ForwardFailure('io', error) }
  }

  private fail(error: unknown): void {
    // All transfer continuations have joined before intentional resource destruction starts.
    if (this.finishing) return
    this.failure ??= error instanceof ForwardFailure ? error : this.target.identity === undefined
      ? new ForwardFailure('io', error) : new ForwardFailure(this.identityAccepted ? 'io' : 'identity')
    if (this.stopping) return
    this.stopping = true; this.observeClose(); this.controller.abort()
    this.reply.reject(this.failure); this.identityReady.reject(this.failure)
    for (const resource of this.resources.keys()) this.destroy(resource)
    if (!this.started) void this.finish()
  }

  private async run(): Promise<void> {
    try {
      this.check()
      const { url, identity } = this.target
      const hostname = url.hostname.replace(/^\[|\]$/gu, '')
      const options = {
        protocol: url.protocol, hostname, port: url.port || undefined,
        // Keep original HTTP Host without allowing it to choose TLS SNI. Default CA/hostname validation remains enabled.
        servername: identity === undefined ? isIP(hostname) ? '' : hostname : isIP(identity.name) ? '' : identity.name,
        path: this.path, method: this.method, headers: this.headers, setHost: false, agent: false, allowHalfOpen: true,
        maxHeaderSize: this.limits.maxHeaderBytes, highWaterMark: this.limits.maxChunkBytes,
        ...(identity === undefined ? {} : { ca: identity.ca, cert: identity.cert, key: identity.key, rejectUnauthorized: true,
          checkServerIdentity: (_hostname: string, certificate: PeerCertificate) => verifyPeer(identity, certificate) }),
      }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options)
      // Node silently truncates rawHeaders at this parser limit. Retain one excess pair so admission fails closed.
      request.maxHeadersCount = this.limits.maxHeaderPairs + 1
      this.request = request; this.watch(request)
      this.connectTimer = setTimeout(() => { this.cancel('timeout') }, this.limits.connectTimeoutMs)
      this.on(request, 'socket', (socket: Duplex) => {
        this.watch(socket); this.socketAssigned.resolve(undefined)
        const connected = (): void => {
          if (identity !== undefined) {
            if (!(socket instanceof TLSSocket) || !socket.authorized
              || verifyPeer(identity, socket.getPeerCertificate(true)) !== undefined) {
              this.cancel('identity'); return
            }
            this.identityAccepted = true; this.identityReady.resolve()
          }
          clearTimeout(this.connectTimer)
        }
        this.on(socket, url.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
        this.on(socket, 'close', () => {
          if (this.upgraded ? !socket.readableEnded || !socket.writableFinished : !this.upstreamResponse?.complete) this.cancel('io')
        })
      })
      this.on(request, 'close', () => { this.socketAssigned.resolve(undefined) })
      this.on(request, 'information', () => { this.cancel('protocol') })
      this.on(request, 'response', (response: IncomingMessage) => {
        this.upstreamResponse = response; this.watch(response)
        this.reply.resolve({ kind: 'response', response })
      })
      this.on(request, 'upgrade', (response: IncomingMessage, socket: Duplex, head: Buffer) => {
        this.upstreamResponse = response; this.upgraded = true
        this.watch(response); this.watch(socket); socket.pause()
        this.reply.resolve({ kind: 'upgrade', response, socket, head })
      })
      // Native TLS verifies each fresh connection; no headers/body are flushed until the actual peer passes.
      if (identity !== undefined) { await this.identityReady.promise; this.check() }
      this.mayHaveReceived = true
      if (this.input.kind === 'http') {
        request.flushHeaders()
        this.child(this.pump(this.input.request, request, false))
      } else request.end()
      const reply = await this.reply.promise
      this.check(); this.upstreamStatus = reply.response.statusCode
      if (reply.kind === 'upgrade') {
        if (this.input.kind !== 'upgrade' || reply.response.statusCode !== 101 || reply.head.length > this.limits.maxHeadBytes) {
          throw new ForwardFailure('protocol')
        }
        const headers = forwardHeaders(reply.response.rawHeaders, this.limits, true, false)
        await this.writeBuffer(this.input.socket, responseHead(101, reply.response.statusMessage ?? '', headers, this.limits), undefined)
        this.check()
        this.input.onUpgradeAccepted?.()
        this.check()
        await this.writeBuffer(reply.socket, this.downstreamHead, true)
        await this.writeBuffer(this.input.socket, reply.head, true)
        this.child(this.pump(this.input.socket, reply.socket, true))
        this.child(this.pump(reply.socket, this.input.socket, true))
      } else {
        const status = reply.response.statusCode ?? 0
        if (status < 200 || status > 599) throw new ForwardFailure('protocol')
        const headers = forwardHeaders(reply.response.rawHeaders, this.limits, false, false)
        if (this.input.kind === 'http') {
          this.input.response.sendDate = false; this.input.response.shouldKeepAlive = false
          this.input.response.writeHead(status, reply.response.statusMessage, headers)
          this.child(this.pump(reply.response, this.input.response, false))
        } else {
          await this.writeBuffer(this.input.socket, responseHead(status, reply.response.statusMessage ?? '', headers, this.limits), undefined)
          this.child(this.pump(reply.response, this.input.socket, false))
        }
      }
      const results = await Promise.allSettled(this.children)
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } catch (error) { this.fail(error) }
    finally { await Promise.allSettled(this.children) }
  }

  private child(task: Promise<void>): void {
    this.children.push(task)
    void task.catch((error: unknown) => { this.fail(error) })
  }

  private async pump(source: Readable, destination: Writable, tunnel: boolean): Promise<void> {
    while (true) {
      this.check()
      if (source.readableLength > this.limits.maxBufferedBytes) throw new ForwardFailure('capacity')
      if (source.readableLength > 0) {
        const chunk: unknown = source.read(Math.min(this.limits.maxChunkBytes, source.readableLength))
        if (!Buffer.isBuffer(chunk)) throw new ForwardFailure('protocol')
        await this.writeBuffer(destination, chunk, tunnel)
      } else if (source.readableEnded) {
        if ('rawTrailers' in source && Array.isArray(source.rawTrailers) && source.rawTrailers.length !== 0) {
          throw new ForwardFailure('protocol')
        }
        await this.end(destination)
        return
      } else {
        if (source.destroyed) throw new ForwardFailure('io')
        await this.readable(source)
      }
    }
  }

  private async writeBuffer(destination: Writable, bytes: Buffer, tunnel: boolean | undefined): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += this.limits.maxChunkBytes) {
      this.check()
      const chunk = bytes.subarray(offset, offset + this.limits.maxChunkBytes)
      if (tunnel) this.tunnelBytes += chunk.length
      else if (tunnel === false) this.bytes += chunk.length
      if (this.bytes > this.limits.maxBodyBytes || this.tunnelBytes > this.limits.maxTunnelBytes
        || destination.writableLength + chunk.length > this.limits.maxBufferedBytes) throw new ForwardFailure('capacity')
      await new Promise<void>((resolve, reject) => {
        let wrote = false, drained = true, failure: Error | undefined
        const cleanup = (): void => { destination.off('drain', drain); destination.off('close', closed); this.controller.signal.removeEventListener('abort', abort) }
        const complete = (): void => {
          if (!wrote || failure === undefined && !drained) return
          cleanup()
          if (failure !== undefined) reject(failure)
          else resolve()
        }
        const drain = (): void => { drained = true; complete() }
        const closed = (): void => { failure ??= new ForwardFailure('io'); complete() }
        const abort = (): void => { failure ??= this.failure ?? new ForwardFailure('cancelled'); complete() }
        destination.once('drain', drain); destination.once('close', closed)
        this.controller.signal.addEventListener('abort', abort, { once: true })
        try {
          drained = destination.write(chunk, (error) => {
            failure ??= error ?? undefined; wrote = true; complete()
          })
          if (destination.writableLength > this.limits.maxBufferedBytes) {
            failure ??= new ForwardFailure('capacity'); this.cancel('capacity'); complete()
          }
        } catch (error) { failure = error instanceof Error ? error : new ForwardFailure('io', error); wrote = true; complete() }
      })
    }
  }

  private readable(source: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        source.off('readable', ready); source.off('end', ready); source.off('close', closed)
        this.controller.signal.removeEventListener('abort', abort)
      }
      const ready = (): void => { cleanup(); resolve() }
      const closed = (): void => { if (source.readableEnded) ready(); else { cleanup(); reject(new ForwardFailure('io')) } }
      const abort = (): void => { cleanup(); reject(this.failure ?? new ForwardFailure('cancelled')) }
      source.once('readable', ready); source.once('end', ready); source.once('close', closed)
      this.controller.signal.addEventListener('abort', abort, { once: true })
      source.read(0)
      if (source.readableLength || source.readableEnded) ready()
      else if (this.controller.signal.aborted) abort()
    })
  }

  private end(destination: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { destination.off('finish', finished); destination.off('close', closed); this.controller.signal.removeEventListener('abort', abort) }
      const finished = (): void => { cleanup(); resolve() }
      const closed = (): void => { if (destination.writableFinished) finished(); else { cleanup(); reject(new ForwardFailure('io')) } }
      const abort = (): void => { cleanup(); reject(this.failure ?? new ForwardFailure('cancelled')) }
      destination.once('finish', finished); destination.once('close', closed)
      this.controller.signal.addEventListener('abort', abort, { once: true })
      try { destination.end() } catch (error) { cleanup(); reject(new ForwardFailure('io', error)) }
      if (destination.writableFinished) finished()
      else if (this.controller.signal.aborted) abort()
    })
  }

  private observeClose(): void {
    this.closeTimer ??= setTimeout(() => {
      this.result.resolve(Object.freeze({ status: 'unknown', reason: 'close-deadline', upstreamMayHaveReceived: this.mayHaveReceived }))
    }, this.limits.closeTimeoutMs)
  }

  private async finish(): Promise<void> {
    if (this.finishing) return
    this.finishing = true; this.stopping = true; this.controller.abort()
    clearTimeout(this.queueTimer); clearTimeout(this.connectTimer); clearTimeout(this.runTimer)
    this.observeClose()
    for (const resource of this.resources.keys()) this.destroy(resource)
    if (this.request !== undefined) await this.socketAssigned.promise
    // Creation/close callbacks may have added the original socket while request destruction was settling.
    let count: number
    do { count = this.resources.size; await Promise.all(this.resources.values()); await Promise.resolve() }
    while (this.resources.size !== count)
    for (const remove of this.removals.splice(0)) remove()
    clearTimeout(this.closeTimer)
    const outcome: ForwardTerminal = Object.freeze({ status: this.failure === undefined ? 'completed' : 'failed',
      ...(this.failure === undefined ? {} : { failure: this.failure }), upstreamMayHaveReceived: this.mayHaveReceived,
      ...(this.upstreamStatus === undefined ? {} : { upstreamStatus: this.upstreamStatus }) })
    this.released(); this.actual.resolve(outcome); this.result.resolve(outcome)
  }
}
