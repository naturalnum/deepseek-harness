/** One bounded byte mux on the original operation's owned connection; lifecycle control stays on HTTP. */
import { Duplex } from 'node:stream'
import { ControlUncertain, LocalRefusal } from './errors.ts'
import { need } from './canonical.ts'
import { STREAM_LIMITS as L } from './role-protocol.ts'
import type { AgentDataStream, OperationRef, PipesOperationSpec } from './types.ts'
import type { OwnedWireStream, WireStreamEvents } from './transport.ts'

type Channel = 1 | 2 | 3 | 4
type Kind = 1 | 2 | 3
/** One exact binary message; channel zero cannot carry PTC or Root control authority. */
export interface StreamFrame { readonly kind: Kind; readonly channel: Channel; readonly sequence: number; readonly payload: Uint8Array }
/**
 * Encode one bounded frame; sequence is per channel and sender across all three kinds.
 * @param frame Exact validated frame fields.
 * @returns A single independent message, never a user-payload text conversion.
 */
export function encodeStreamFrame(frame: StreamFrame): Uint8Array {
  need(Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 && frame.sequence < 0xffffffff, 'stream_sequence')
  need([1, 2, 3, 4].includes(frame.channel), 'stream_channel')
  const size = frame.payload.byteLength
  need(frame.kind === 1 ? size > 0 && size <= L.frameBytes : frame.kind === 2 ? size === 0 : size === 4, 'stream_frame')
  if (frame.kind === 3) { const credit = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0); need(credit > 0 && credit <= L.windowBytes, 'stream_credit') }
  const out = Buffer.alloc(12 + size)
  out.writeUInt32BE(8 + size, 0); out[4] = frame.kind; out[5] = frame.channel; out.writeUInt32BE(frame.sequence, 8)
  out.set(frame.payload, 12)
  return out
}
/**
 * Parse exactly one mux message; malformed headers and payloads never enter Node streams.
 * @param bytes One bounded binary WS message.
 * @returns An independent payload under the original channel window.
 */
export function decodeStreamFrame(bytes: Uint8Array): StreamFrame {
  need(bytes.byteLength >= 12 && bytes.byteLength <= L.frameBytes + 12, 'stream_frame')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  need(view.getUint32(0) === bytes.byteLength - 4 && view.getUint16(6) === 0, 'stream_frame')
  const kind = view.getUint8(4), channel = view.getUint8(5), sequence = view.getUint32(8)
  need(kind === 1 || kind === 2 || kind === 3, 'stream_kind')
  need(channel === 1 || channel === 2 || channel === 3 || channel === 4, 'stream_channel')
  const payload = Uint8Array.from(bytes.subarray(12))
  const result: StreamFrame = { kind, channel, sequence, payload }
  encodeStreamFrame(result)
  return result
}

type WriteCallback = (error?: Error | null) => void
const isWriteCallback = (value: unknown): value is WriteCallback => typeof value === 'function'
interface PendingWrite { readonly bytes: Buffer; offset: number; readonly end: number; readonly callback: WriteCallback }
interface Lane {
  readonly channel: Channel
  readonly endpoint: PipeEndpoint
  readonly input: boolean
  readonly output: boolean
  readonly budget: number
  sendSequence: number
  receiveSequence: number
  accepted: number
  sent: number
  acknowledged: number
  credit: number
  received: number
  receiveCredit: number
  pendingCredit: number
  outputEof: boolean
  inputEof: boolean
  final: WriteCallback | undefined
  write: PendingWrite | undefined
  endpointClosed: boolean
}

/** Uses Native Node buffering/backpressure. Original caller write buffers are borrowed, not duplicated into an unbounded frame queue. */
class PipeEndpoint extends Duplex {
  constructor(readonly owner: ExecutionStream, readonly channel: Channel, readable: boolean) {
    super({ highWaterMark: L.windowBytes, allowHalfOpen: true, autoDestroy: false })
    if (!readable) this.push(null)
    // The original row owns the failure even when a Native consumer has already removed its listener.
    this.on('error', () => {})
  }
  override _read(): void {}
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'data') {
      const bytes = args[0]
      if (bytes instanceof Uint8Array) this.owner.consumed(this.channel, bytes.byteLength)
    }
    return super.emit(event, ...args)
  }
  override write(chunk: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
    const textEncoding = typeof encoding === 'string' ? encoding : undefined
    const cb = typeof encoding === 'function' ? encoding : callback
    if (!this.owner.accept(this.channel, chunk, textEncoding)) {
      cb?.(new LocalRefusal('stream_input_budget'))
      return false
    }
    return textEncoding === undefined ? super.write(chunk, cb) : super.write(chunk, textEncoding, cb)
  }
  override end(callback?: WriteCallback): this
  override end(chunk: unknown, callback?: WriteCallback): this
  override end(chunk: unknown, encoding: BufferEncoding, callback?: WriteCallback): this
  override end(chunk?: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): this {
    if (isWriteCallback(chunk)) return super.end(chunk)
    const textEncoding = typeof encoding === 'string' ? encoding : undefined
    const cb = typeof encoding === 'function' ? encoding : callback
    if (chunk !== undefined && chunk !== null && !this.owner.accept(this.channel, chunk, textEncoding)) {
      cb?.(new LocalRefusal('stream_input_budget')); return this
    }
    return textEncoding === undefined ? super.end(chunk, cb) : super.end(chunk, textEncoding, cb)
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
    this.owner.write(this.channel, chunk, callback)
  }
  override _final(callback: WriteCallback): void { this.owner.end(this.channel, callback) }
  override _destroy(error: Error | null, callback: WriteCallback): void { this.owner.endpointClosed(this.channel); callback(error) }
}

/** Original local socket responsibility; it cannot submit, stop, free or rebind a remote range. */
export class ExecutionStream implements AgentDataStream {
  readonly stdin?: Duplex
  readonly stdout?: Duplex
  readonly stderr?: Duplex
  readonly control?: Duplex
  readonly settled: Promise<void>
  readonly outputEnded: Promise<void>
  /** Resolves only after the original accepted upgrade and its matching endpoint binding. */
  readonly ready: Promise<AgentDataStream>
  readonly #lanes = new Map<Channel, Lane>()
  readonly #reference: OperationRef
  readonly #uncertain: () => void
  readonly #settled: () => void
  readonly #resolveReady: (stream: AgentDataStream) => void
  readonly #rejectReady: (error: Error) => void
  readonly #resolveOutput: () => void
  readonly #rejectOutput: (error: Error) => void
  #wire?: OwnedWireStream
  #opened = false; #closed = false; #closing = false; #closeRequested = false; #failed = false; #sending = false; #next = 0
  #outputComplete = false
  #submitted = false
  #wireCloseAttempted = false
  /**
   * Capture a prepared pipes row and its original client callbacks; no network work starts here.
   * @param reference Original Root-issued operation reference.
   * @param spec Original independently normalized signed pipes spec.
   * @param uncertain Fence the existing client and retain its original reference.
   */
  constructor(reference: OperationRef, spec: PipesOperationSpec, uncertain: () => void) {
    this.#reference = reference; this.#uncertain = uncertain
    const done = Promise.withResolvers<void>(), output = Promise.withResolvers<void>(), ready = Promise.withResolvers<AgentDataStream>()
    this.settled = done.promise; this.#settled = done.resolve
    this.outputEnded = output.promise; this.#resolveOutput = output.resolve; this.#rejectOutput = output.reject
    this.ready = ready.promise; this.#resolveReady = ready.resolve; this.#rejectReady = ready.reject
    // Both promises remain observable by Root; rejection before its awaiting continuation must not become unhandled.
    void this.outputEnded.catch(() => {}); void this.ready.catch(() => {})
    const add = (channel: Channel, input: boolean, output: boolean, budget: number) => {
      const endpoint = new PipeEndpoint(this, channel, output)
      this.#lanes.set(channel, { channel, endpoint, input, output, budget, sendSequence: 0, receiveSequence: 0,
        accepted: 0, sent: 0, acknowledged: 0, credit: L.windowBytes, received: 0, receiveCredit: L.windowBytes,
        pendingCredit: 0, outputEof: false, inputEof: false, endpointClosed: false, final: undefined, write: undefined })
      return endpoint
    }
    if (spec.stdin.mode === 'pipe') this.stdin = add(1, true, false, L.stdinBytes)
    if (spec.stream.stdout === 'pipe') this.stdout = add(2, false, true, 65536)
    if (spec.stream.stderr === 'pipe') this.stderr = add(3, false, true, 65536)
    if (spec.stream.control === 'pipe') this.control = add(4, true, true, spec.stream.limits.controlInputBytes)
    this.#controlOutputBytes = spec.stream.limits.controlOutputBytes
    this.#checkOutput()
  }
  readonly #controlOutputBytes: number
  /** Actual original upgrade is live; local readiness is never a process-start or range-empty fact. */
  get connected(): boolean { return this.#opened && !this.#closed && !this.#closing && !this.#failed }
  /** Original DataClient calls only after the bound HTTP commit actually reports submitted, never merely after WS upgrade. */
  noteSubmitted(): void { this.#submitted = true; this.#pump() }
  /** Actual callbacks passed once to the original OwnedTransport. */
  readonly events: WireStreamEvents = {
    open: () => {
      if (this.#closed || this.#failed || this.#closing || this.#opened) { this.fail(); return }
      this.#opened = true; this.#resolveReady(this); this.#pump()
    },
    data: (bytes) => {
      if (this.#failed || this.#closed) return
      try { this.#receive(decodeStreamFrame(bytes)) } catch { this.fail() }
    },
    error: () => { this.fail() },
    closed: () => {
      if (this.#closed) return
      if (!this.#outputComplete || [...this.#lanes.values()].some(lane => lane.write !== undefined)) this.fail()
      this.#closed = true; this.#closing = true; this.#rejectReady(new ControlUncertain('/stream', this.#reference))
      this.#joinLocalSend()
    },
  }
  /** Bind the single actual connection returned by the original dispatcher, including synchronous test callbacks.
   * @param wire Original exclusively owned WebSocket connection.
   */
  bind(wire: OwnedWireStream): void {
    need(this.#wire === undefined, 'stream_already_bound'); this.#wire = wire
    if (this.#failed || this.#closing) this.#closeWire()
    else this.#pump()
  }
  /** Observe original stop/cancel, refusing pending delivery receipts without pretending bytes were delivered. */
  abandon(): void {
    for (const lane of this.#lanes.values()) {
      const write = lane.write; lane.write = undefined
      write?.callback(new LocalRefusal('stream_input_abandoned'))
    }
  }
  /** Fence after protocol/transport failure while preserving the actual socket terminal-event join. */
  fail(): void {
    if (this.#failed || this.#closed) return
    this.#failed = true; this.#closing = true
    const error = new ControlUncertain('/stream', this.#reference)
    this.#rejectReady(error); this.#rejectOutput(error); this.#uncertain(); this.abandon()
    for (const lane of this.#lanes.values()) {
      lane.final?.(error); lane.final = undefined; lane.endpoint.destroy(error)
    }
    this.#closeWire()
  }
  close(): void {
    if (this.#closed || this.#closing || this.#closeRequested) return
    if (!this.#outputComplete || [...this.#lanes.values()].some(lane => lane.write !== undefined)) { this.fail(); return }
    this.#closeRequested = true; this.#pump()
  }
  /** Reserve lifetime caller bytes before Node can queue another original reference.
   * @param channel Original input lane.
   * @param chunk Borrowed caller input.
   * @param encoding Optional string encoding.
   * @returns Whether the complete write fits this lane’s original lifetime budget.
   */
  accept(channel: Channel, chunk: unknown, encoding?: BufferEncoding): boolean {
    const lane = this.#lanes.get(channel)
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk instanceof Uint8Array ? chunk.byteLength : -1
    if (this.#failed || this.#closing || this.#closeRequested || lane === undefined || !lane.input || lane.inputEof
      || size < 0 || lane.accepted + size > lane.budget) {
      this.fail(); return false
    }
    lane.accepted += size
    return true
  }
  /** Node invokes only one outstanding write per channel; credit acknowledges actual remote pipe acceptance.
   * @param channel Original input lane.
   * @param bytes Borrowed complete write buffer.
   * @param callback Original delivery receipt or failure observer.
   */
  write(channel: Channel, bytes: Buffer, callback: WriteCallback): void {
    const lane = this.#lanes.get(channel)
    if (this.#failed || this.#closing || lane === undefined || lane.write !== undefined) { callback(new LocalRefusal('stream_input_unavailable')); return }
    if (bytes.byteLength === 0) { callback(); return }
    lane.write = { bytes, offset: 0, end: lane.sent + bytes.byteLength, callback }
    this.#pump()
  }
  /** Preserve input half-close after its preceding write receipts, without closing any output half.
   * @param channel Original input lane.
   * @param callback Original half-close completion observer.
   */
  end(channel: Channel, callback: WriteCallback): void {
    const lane = this.#lanes.get(channel)
    if (this.#failed || this.#closing || lane === undefined || !lane.input) { callback(new LocalRefusal('stream_input_unavailable')); return }
    lane.final = callback; this.#pump()
  }
  /** Receiver credit is returned only as Native actually receives raw bytes from its original local stream.
   * @param channel Original output lane.
   * @param bytes Bytes actually delivered to the consumer.
   */
  consumed(channel: Channel, bytes: number): void {
    const lane = this.#lanes.get(channel)
    if (this.#failed || this.#closed || lane === undefined) return
    lane.pendingCredit += bytes
    if (lane.pendingCredit + lane.receiveCredit > L.windowBytes) { this.fail(); return }
    this.#pump()
  }
  /** Native control.close destroys its endpoint before its original handle.stop; do not invent range settlement.
   * @param channel Original lane whose local endpoint was destroyed.
   */
  endpointClosed(channel: Channel): void {
    const lane = this.#lanes.get(channel)
    if (lane === undefined || lane.endpointClosed || this.#closing || this.#closed) return
    lane.endpointClosed = true
    if (lane.input && !lane.inputEof && lane.write === undefined) { lane.final = () => {}; this.#pump() }
  }
  #receive(frame: StreamFrame): void {
    need(this.#opened, 'stream_before_upgrade')
    const lane = this.#lanes.get(frame.channel)
    need(lane !== undefined && frame.sequence === lane.receiveSequence && lane.receiveSequence < 0xffffffff, 'stream_sequence')
    lane.receiveSequence++
    if (frame.kind === 3) {
      need(lane.input, 'stream_direction')
      const credit = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0)
      need(credit <= lane.sent - lane.acknowledged && lane.credit + credit <= L.windowBytes, 'stream_credit')
      lane.credit += credit; lane.acknowledged += credit
      const write = lane.write
      if (write !== undefined && write.end === lane.acknowledged) { lane.write = undefined; write.callback() }
      this.#pump(); return
    }
    need(lane.output && !lane.outputEof, 'stream_direction')
    if (frame.kind === 2) { lane.outputEof = true; lane.endpoint.push(null); this.#checkOutput(); return }
    need(!lane.endpointClosed && frame.payload.length <= lane.receiveCredit, 'stream_receive_window')
    const cap = frame.channel === 4 ? this.#controlOutputBytes : lane.budget
    need(lane.received + frame.payload.length <= cap, 'stream_output_budget')
    lane.received += frame.payload.length; lane.receiveCredit -= frame.payload.length
    lane.endpoint.push(Buffer.from(frame.payload))
  }
  #checkOutput(): void {
    if (this.#outputComplete || [...this.#lanes.values()].some(lane => lane.output && !lane.outputEof)) return
    this.#outputComplete = true; this.#resolveOutput()
  }
  #joinLocalSend(): void { if (this.#closed && !this.#sending) this.#settled() }
  #closeWire(): void {
    if (this.#wire === undefined || this.#wireCloseAttempted) return
    this.#wireCloseAttempted = true
    try { this.#wire.close() }
    catch { this.fail() } // Unknown close remains retained; only original transport disposal can settle the socket.
  }
  #pump(): void {
    if (this.#sending || !this.#opened || this.#wire === undefined || this.#failed || this.#closed || this.#closing) return
    const lanes = [...this.#lanes.values()]
    let selected: Lane | undefined, kind: Kind | undefined
    let payload: Uint8Array = new Uint8Array()
    for (const lane of lanes) {
      if (lane.pendingCredit > 0) {
        selected = lane; kind = 3; const credit = lane.pendingCredit
        lane.pendingCredit = 0; lane.receiveCredit += credit
        payload = new Uint8Array(4); new DataView(payload.buffer).setUint32(0, credit); break
      }
    }
    for (let i = 0; selected === undefined && i < lanes.length; i++) {
      const index = (this.#next + i) % lanes.length, lane = lanes[index]
      if (lane === undefined) continue
      const write = lane.write
      if (this.#submitted && write !== undefined && write.offset < write.bytes.length && lane.credit > 0) {
        const count = Math.min(L.frameBytes, lane.credit, write.bytes.length - write.offset)
        selected = lane; kind = 1; payload = write.bytes.subarray(write.offset, write.offset + count)
        write.offset += count; lane.sent += count; lane.credit -= count; this.#next = (index + 1) % lanes.length
      } else if (lane.final !== undefined && !lane.inputEof && write === undefined) {
        selected = lane; kind = 2; lane.inputEof = true; this.#next = (index + 1) % lanes.length
      }
    }
    if (selected === undefined || kind === undefined) {
      if (this.#closeRequested) { this.#closing = true; this.#closeWire() }
      return
    }
    const lane = selected, callback = kind === 2 ? lane.final : undefined
    if (kind === 2) lane.final = undefined
    this.#sending = true
    let frame: Uint8Array
    try { frame = encodeStreamFrame({ channel: lane.channel, kind, sequence: lane.sendSequence++, payload }) }
    catch { this.#sending = false; callback?.(new LocalRefusal('stream_sequence')); this.fail(); return }
    void this.#wire.send(frame).then(() => {
      this.#sending = false; callback?.(); this.#pump(); this.#joinLocalSend()
    }, () => {
      this.#sending = false; callback?.(new LocalRefusal('stream_transport_unavailable')); this.fail(); this.#joinLocalSend()
    })
  }
}
