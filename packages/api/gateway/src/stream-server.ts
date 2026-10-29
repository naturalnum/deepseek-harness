/** Host WebSocket owner for multiplexed Typert Remote streams. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError, remoteErrorOf, type PeerScope, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/**
 * Open one validated Remote stream for a decoded wire request on behalf of one
 * Peer. `uplink` carries the Client's items; `control` cancels the logical
 * stream, and aborting it with a Remote failure as the reason delivers that
 * failure to the Client. `window` describes this stream's complete-frame inbox budget.
 */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
  window: RemoteUplinkWindow,
) => Promise<AsyncIterable<unknown>>

/** The opener one socket uses: its Peer is fixed at upgrade time. */
type BoundStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  control: AbortController,
  window: RemoteUplinkWindow,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

const MAX_MISSED_HEARTBEATS = 2

/** Host-owned frame and logical-stream limits for an externally admitted Node carrier. */
export interface NodeStreamTransportOptions {
  /** Positive finite integral complete WebSocket message byte limit, enforced by ws before delivery. */
  readonly maxFrameBytes: number
  /**
   * Reserve before any logical stream table or inbox allocation; a throw closes the carrier.
   * @param endpoint - decoded native logical endpoint.
   * @returns synchronous exactly-once actual settlement notification; unknown retains owner responsibility.
   * The notification must not wait for its own transport or Peer close.
   */
  readonly acquireStream: (endpoint: string) => (status: 'confirmed' | 'unknown') => void
}

/** Package-private marker separating actual stream cleanup failures from business failures. */
export class StreamCleanupError extends Error {
  /** First actual cleanup failure; nested markers retain the original failure. */
  readonly failure: unknown

  /** @param failure - first actual cleanup failure, retained without replacing its identity. */
  constructor(failure: unknown) {
    const actual = failure instanceof StreamCleanupError ? failure.failure : failure
    super('Remote stream cleanup did not complete.', { cause: actual })
    this.failure = actual
  }
}

/**
 * Identify the exact carrier cancellation or Gateway's native cancellation failure.
 * @param error - actual iterator rejection.
 * @param signal - signal whose cancellation the iterator observes.
 * @returns whether this rejection is expected cancellation rather than failed cleanup.
 */
export function isStreamCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || remoteErrorOf(error)?.code === 'gateway/cancelled')
}

/**
 * Require a provided iterator return to acknowledge completion, not another yield.
 * @param result - actual optional return result.
 * @throws StreamCleanupError when the iterator still reports unfinished cleanup.
 */
export function assertStreamReturned(result: IteratorResult<unknown> | undefined): void {
  if (result !== undefined && result.done !== true) {
    throw new StreamCleanupError(new Error('Remote stream iterator return did not complete.'))
  }
}

/** Node carrier using the native stream mux and a fixed, admitted Peer. */
export interface NodeStreamTransport {
  /**
   * Accept an upgrade after outer authentication and Host/Origin checks.
   * @param request - admitted upgrade request.
   * @param socket - socket transferred to the native mux.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void
  /**
   * Terminate sockets and await iterator cleanup; repeated calls share completion.
   * @returns fulfillment after every actual stream and Peer effect cleanup has settled.
   * @throws the first actual cleanup failure, after all other cleanup has settled.
   */
  close(): Promise<void>
}

/** Own the no-server WebSocket acceptor and every active logical stream. */
export class RemoteStreamMuxServer {
  private readonly server: WebSocketServer
  private readonly connections = new Set<Promise<void>>()
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private closing: Promise<void> | undefined
  private failure_: { readonly error: unknown } | undefined

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param heartbeatIntervalMs - interval between WebSocket Ping control frames.
   * @param streamInboxBytes - buffered uplink frame bytes one logical stream may hold before it fails.
   * @param options - optional externally owned frame and actual logical-stream resource admission.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
    private readonly streamInboxBytes: number,
    private readonly options?: NodeStreamTransportOptions,
  ) {
    if (options !== undefined && (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1)) {
      throw new Error('api gateway: maxFrameBytes must be a positive safe integer')
    }
    this.server = new WebSocketServer({ noServer: true, ...(options === undefined ? {} : { maxPayload: options.maxFrameBytes }) })
  }

  /**
   * Upgrade one admitted request and begin serving its logical streams. Every
   * stream the socket opens speaks for the Peer admitted at upgrade, and the
   * socket closes when that Peer's scope is disposed.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - carrier socket transferred to the WebSocket server.
   * @param head - bytes already read after the HTTP upgrade headers.
   * @param peer - Peer the upgrade was admitted as.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope): void {
    if (this.closing !== undefined) {
      rejectRemoteStreamUpgrade(socket, 409)
      return
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const release = bindPeer(websocket, peer)
      if (release === undefined) return
      const alive = (): void => { this.missedHeartbeats.set(websocket, 0) }
      alive()
      this.startHeartbeat()
      const bound: BoundStreamOpener = (endpoint, payload, uplink, control, window) =>
        this.open(endpoint, payload, uplink, peer, control, window)
      const connection = new RemoteStreamMuxConnection(websocket, bound, this.failure, this.streamInboxBytes, alive, this.options)
      const done = this.serve(connection, release)
      this.connections.add(done)
      void done.then(() => { this.connections.delete(done) }, (error: unknown) => {
        this.failure_ ??= { error }
        this.connections.delete(done)
      })
    })
  }

  /** Seal upgrades and join every stream and Peer cleanup, retaining the first actual failure. */
  close(): Promise<void> {
    return this.closing ??= this.closeActual()
  }

  private async serve(connection: RemoteStreamMuxConnection, release: () => unknown): Promise<void> {
    let failure: { readonly error: unknown } | undefined
    try { await connection.run() } catch (error) { failure = { error } }
    try { await release() } catch (error) { failure ??= { error } }
    if (failure !== undefined) throw failure.error
  }

  private async closeActual(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    const results = await Promise.allSettled([closed.promise, ...this.connections])
    for (const result of results) if (result.status === 'rejected') this.failure_ ??= { error: result.reason }
    if (this.failure_ !== undefined) throw this.failure_.error
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        const missed = this.missedHeartbeats.get(socket) as number
        if (missed >= MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) as number) >= MAX_MISSED_HEARTBEATS) {
              socket.terminate()
            }
          })
          continue
        }
        this.missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  readonly inbox: UplinkInbox
  /** Cancel the logical stream and end any Host read still waiting on its uplink. */
  readonly stop: (reason: Error) => void
  done: Promise<void>
}

/** The mux observed its carrier close before it attempted the queued write. */
class CarrierClosedBeforeWriteError extends Error {}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()
  private carrierClosed = false
  private failure_: { readonly error: unknown } | undefined

  constructor(
    private readonly socket: WebSocket,
    private readonly open: BoundStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly streamInboxBytes: number,
    private readonly alive: () => void,
    private readonly options?: NodeStreamTransportOptions,
  ) {}

  /**
   * Serve frames until the socket closes. A Pong, any received frame, and a
   * downlink write that waited in the local send buffer and then completed
   * count as peer activity, so a congested link that delays the Pong behind
   * data keeps its socket. A write that completes at once proves nothing
   * about the peer and does not count.
   */
  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', () => { this.carrierClosed = true; resolve() })
      this.socket.once('error', () => { this.socket.terminate() })
      this.socket.on('pong', this.alive)
      this.socket.on('message', (data, isBinary) => {
        this.alive()
        if (isBinary) {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.stop(new Error('Remote stream socket closed'))
    await Promise.allSettled(active.map(stream => stream.done))
    if (this.failure_ !== undefined) throw this.failure_.error
  }

  /**
   * Dispatch one frame. `item`, `end`, and `cancel` for a stream this connection
   * no longer owns are dropped: a finished stream leaves the table while the
   * Client's in-flight frames are still arriving. A duplicate `open` is the one
   * protocol violation that closes the socket.
   */
  private receive(text: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    const message = parseRemoteStreamClientMessage(text)
    switch (message.type) {
      case 'open': {
        this.openStream(message)
        return
      }
      case 'item': {
        this.streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
        return
      }
      case 'end': {
        this.streams.get(message.streamId)?.inbox.end()
        return
      }
      case 'cancel': {
        this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'))
        return
      }
      /* v8 ignore next 4 -- parseRemoteStreamClientMessage admits only the four frame types above. */
      default: {
        const unknown: never = message
        throw new Error(`api gateway: unknown Remote stream client message ${JSON.stringify(unknown)}`)
      }
    }
  }

  private openStream(message: Extract<RemoteStreamClientMessage, { readonly type: 'open' }>): void {
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    let settle: ReturnType<NodeStreamTransportOptions['acquireStream']> | undefined
    try { settle = this.options?.acquireStream(message.endpoint) } catch {
      this.socket.terminate()
      return
    }
    const abort = new AbortController()
    // Created before the opener resolves so items the Client sends right
    // after `open` wait in the inbox instead of being lost.
    const inbox = new UplinkInbox(this.streamInboxBytes, message.endpoint, (error) => { abort.abort(error) })
    const active: ActiveStream = {
      abort,
      inbox,
      stop: (reason) => {
        abort.abort(reason)
        inbox.fail(reason)
      },
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    const done = this.complete(message, active, settle)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, (error: unknown) => {
      this.failure_ ??= { error: error instanceof StreamCleanupError ? error.failure : error }
      remove()
    })
  }

  private async complete(
    message: Extract<RemoteStreamClientMessage, { readonly type: 'open' }>, active: ActiveStream,
    settle: ReturnType<NodeStreamTransportOptions['acquireStream']> | undefined,
  ): Promise<void> {
    let failure: { readonly error: unknown } | undefined
    try { await this.pump(message.streamId, message.endpoint, message.payload, active) } catch (error) { failure = { error } }
    try { settle?.(failure === undefined ? 'confirmed' : 'unknown') } catch (error) { failure ??= { error } }
    if (failure !== undefined) throw failure.error
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    let outcome: { readonly failed: false } | { readonly failed: true; readonly error: unknown }
    let iterator: AsyncIterator<unknown> | undefined
    let cleanup: { readonly error: unknown } | undefined
    try {
      const source = await this.open(endpoint, payload, active.inbox, active.abort, {
        maxBytes: this.streamInboxBytes,
        frameOverheadBytes: Buffer.byteLength(JSON.stringify({ type: 'item', streamId, value: null }), 'utf8') - 'null'.length,
      })
      iterator = source[Symbol.asyncIterator]()
      while (true) {
        const next = await iterator.next()
        if (next.done || active.abort.signal.aborted) break
        try {
          await this.send({ type: 'item', streamId, value: next.value })
        } catch (error) {
          // Only the mux's own close-before-write result is known to be a
          // carrier cancellation. Callback and serialization failures keep
          // their existing unknown-cleanup semantics.
          if (!active.abort.signal.aborted || !(error instanceof CarrierClosedBeforeWriteError)) throw error
          break
        }
      }
      outcome = { failed: false }
    } catch (error) {
      if (error instanceof StreamCleanupError) cleanup = { error }
      else if (iterator !== undefined && active.abort.signal.aborted && !isStreamCancellation(error, active.abort.signal)) {
        cleanup = { error: new StreamCleanupError(error) }
      }
      outcome = { failed: true, error }
    } finally {
      // Close uplink first to wake a downlink awaiting its input, then join actual return.
      active.inbox.fail(new Error('Remote stream ended'))
      try { assertStreamReturned(await iterator?.return?.()) } catch (error) { cleanup ??= { error: new StreamCleanupError(error) } }
      await active.inbox.return()
    }
    if (cleanup !== undefined) throw cleanup.error
    if (active.abort.signal.aborted) {
      // A Remote failure as the abort reason is the Gateway or this mux failing
      // the stream (a rejected or overflowing uplink item, or an item after
      // end); the Client is still waiting for that terminal frame. Any other
      // abort is a cancellation.
      const reason: unknown = active.abort.signal.reason
      if (remoteErrorOf(reason) !== undefined) await this.sendFailure(streamId, reason)
      return
    }
    if (outcome.failed) {
      await this.sendFailure(streamId, outcome.error)
      return
    }
    try {
      await this.send({ type: 'end', streamId })
    } catch (error) {
      await this.sendFailure(streamId, error)
    }
  }

  private async sendFailure(streamId: string, error: unknown): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return
    try {
      await this.send({ type: 'error', streamId, error: this.failure(error) })
    } catch {
      // A terminal frame that cannot be encoded or written leaves the
      // logical stream ambiguous, so fail the physical generation.
      this.socket.close(1011, 'Remote stream failure could not be delivered')
    }
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(this.carrierClosed
          ? new CarrierClosedBeforeWriteError('api gateway: Remote stream socket is closed')
          : new Error('api gateway: Remote stream socket is closed'))
        return
      }
      let queued = false
      this.socket.send(text, (error) => {
        if (error) {
          reject(error)
          return
        }
        if (queued) this.alive()
        resolve()
      })
      // Read after send(): bytes still buffered mean the local send buffer was
      // full, so their completion requires the peer to acknowledge data.
      queued = this.socket.bufferedAmount > 0
    }))
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}

interface UplinkEntry {
  readonly value: unknown
  readonly bytes: number
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * Bounded single-consumer uplink queue of one logical stream, the source the
 * Host method reads through `invocation.uplink()`. Buffered frame bytes are
 * capped: overflow, and an item after the Client's `end`, fail the queue and
 * report a Remote failure that the connection uses to fail the logical stream.
 */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly queue = new Deque<UplinkEntry>()
  private bytes = 0
  private ended = false
  private closed = false
  private taken = false
  private failure: Error | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly endpoint: string,
    private readonly onViolation: (error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>) => void,
  ) {}

  push(value: unknown, frameBytes: number): void {
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      this.violate(new RemoteError(
        'gateway/protocol',
        'api gateway: Remote stream uplink item after end',
        { endpoint: this.endpoint },
      ))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(new RemoteError(
        'gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        { endpoint: this.endpoint },
      ))
      return
    }
    this.queue.pushBack({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  /** Client half-close; idempotent. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  /** End the consumer's next read with `error`; idempotent, drops buffered items. */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue.clear()
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.popFront()
      if (entry !== undefined) {
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error('api gateway: Remote stream uplink inbox has one pending read')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** Consumer stopped reading: later items are dropped, a pending read ends. */
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  private violate(error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>): void {
    this.fail(error)
    this.onViolation(error)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * Close the socket when the Peer's scope is disposed. A scope that is already
 * disposed leaves no Peer for the socket to speak for, so the socket closes now.
 * @returns the registration's disposer, or `undefined` when the socket was closed.
 */
function bindPeer(websocket: WebSocket, peer: PeerScope): (() => unknown) | undefined {
  try {
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left') },
      'api-gateway: Remote stream socket bound to its Peer',
    )
  } catch {
    websocket.close(1001, 'peer left')
    return undefined
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403 | 409): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Conflict'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
