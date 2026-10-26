/** Per-client request ownership and finite data facts; global operation/allocation authority stays with Root. */
import { skillWorld, assertSkillParent } from './skill-world.ts'
import { performance } from 'node:perf_hooks'
import { asciiJSON, preparedDigest, need, record, spec } from './canonical.ts'
import { parseReply } from './strict-json.ts'
import { checkOptions, envelope, handshake, operation, ref as checkRef } from './validate.ts'
import { AGENT_AUTH_HEADER, CARRIER_LIMITS as L } from './constants.ts'
import { ControlUncertain, RemoteRefusal } from './errors.ts'
import type { AgentDataClient, CallOptions, ClientOptions, ExpectedBinding, Handshake, Mutation,
  OperationRef, OperationSnapshot, PhysicalStopAck, PreparedRequest, Responsibility, Route } from './types.ts'
import type { OwnedTransport, WireEvents } from './transport.ts'

interface RefRecord { ref: OperationRef; mutations: Set<Mutation>; unresolved: boolean }
interface Flight { actual: Promise<void>; bodyBytes: number; abort(): void }

/** Internal constructor permits exclusive fake transport ownership for units. Public factory always owns a fresh Pool. */
export class DataClient implements AgentDataClient {
  readonly #expected: ExpectedBinding
  readonly #token: string
  readonly #transport: OwnedTransport
  readonly #expires = performance.now() + L.localLifetimeMs
  readonly #records = new Map<string, RefRecord>()
  readonly #active = new Set<Flight>()
  #verified = false; #fenced = false; #closing = false; #physicalAck = false; #physicalRequired = false
  #attempts = 0; #sent = 0; #allowance = 0; #buffered = 0; #received = 0; #sealAttempted = false
  #closed = false; #closePending = 0; #cleanupFailure = false; #cleanupDone = false
  #cleanup?: Promise<void>; #destroy?: Promise<void>; #releaseTimer?: ReturnType<typeof setTimeout>
  #fenceJoin?: Promise<void>
  /**
   * Bind protected Root expectations and transfer exclusive local dispatcher ownership.
   * @param options - Original fixed endpoint, runtime, token and expected facts.
   * @param transport - Exclusively owned transport; fake transfer is private test support only.
   */
  constructor(options: ClientOptions, transport: OwnedTransport) {
    this.#expected = checkOptions(options).expected; this.#token = options.token; this.#transport = transport
  }
  fence(): Promise<void> {
    this.#fenced = true
    return this.#fenceJoin ??= Promise.all([...this.#active].map(f => f.actual)).then(() => undefined)
  }
  responsibility(): Responsibility {
    return Object.freeze({ fenced: this.#fenced, closing: this.#closing, inFlight: this.#active.size,
      dispatcherClosed: this.#closed, closeMethodsPending: this.#closePending, cleanupFailure: this.#cleanupFailure,
      localSettled: this.#closing && this.#cleanupDone && this.#active.size === 0 && this.#closePending === 0 && this.#closed,
      attempts: this.#attempts, sentBodyBytes: this.#sent, replyBodyAllowance: this.#allowance,
      replyBuffersReservedBytes: this.#active.size * L.reply,
      inFlightRequestBodyBytes: [...this.#active].reduce((bytes, flight) => bytes + flight.bodyBytes, 0),
      bufferedReplyBytes: this.#buffered, receivedReplyBodyBytes: this.#received,
      remoteUnresolved: Object.freeze([...this.#records.values()].filter(r => r.unresolved).map(r => r.ref)),
      physicalStopAcknowledged: this.#physicalAck, physicalStopRequired: this.#physicalRequired })
  }
  notePhysicalStop(ack: PhysicalStopAck): void {
    record(ack, ['physicalSandboxId', 'runtimeIdentity', 'stopAckId', 'processesGone'])
    const processesGone: unknown = ack.processesGone
    need(ack.physicalSandboxId === this.#expected.physicalSandboxId && ack.runtimeIdentity === this.#expected.runtimeIdentity
      && processesGone === true && typeof ack.stopAckId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ack.stopAckId), 'stop_ack_binding')
    // Caller is the trusted Root broker/backend. This is not a remote HTTP acknowledgement or a proof this client can create.
    void this.fence(); this.#physicalAck = true; this.#physicalRequired = false
    for (const row of this.#records.values()) row.unresolved = false
  }
  handshake(options?: CallOptions): Promise<Handshake> { return this.#call('/handshake', {}, undefined, options) as Promise<Handshake> }
  prepare(request: PreparedRequest, options?: CallOptions): Promise<OperationSnapshot> {
    record(request, request.skillWorld === undefined ? ['ref', 'spec'] : ['ref', 'spec', 'skillWorld'])
    const reference = checkRef(request.ref, this.#expected.runtimeIdentity), normalized = spec(request.spec, this.#expected.projectRoot)
    const fixed = request.skillWorld === undefined ? undefined : skillWorld(request.skillWorld)
    if (fixed !== undefined) assertSkillParent(fixed, this.#expected.skillParent)
    need((this.#expected.skillParent === undefined) === (fixed === undefined), 'skill_parent_required')
    need(preparedDigest(normalized, fixed) === reference.specHash, 'spec_hash_mismatch')
    return this.#call('/prepare', { ...reference, spec: normalized, ...fixed === undefined ? {} : { skillWorld: fixed } }, reference, options) as Promise<OperationSnapshot>
  }
  /**
   * Attempt commit once using the original reference; this method never retries a lost response.
   * @param reference - Original runtime, ID and spec hash observed prepared by Root.
   * @param options - Earlier monotonic deadline or observer cancellation.
   * @returns Independent submission, direct and range facts for the same operation.
   */
  commit(reference: OperationRef, options?: CallOptions): Promise<OperationSnapshot> { return this.#op('/commit', reference, options) }
  /**
   * Attempt permanent cancellation once without claiming that the remote range is empty.
   * @param reference - Original runtime, ID and spec hash, including after uncertain prepare.
   * @param options - Earlier monotonic deadline or observer cancellation.
   * @returns Bound remote facts; unknown outcomes retain the original reference.
   */
  cancel(reference: OperationRef, options?: CallOptions): Promise<OperationSnapshot> { return this.#op('/cancel', reference, options) }
  /**
   * Attempt the original range stop once without replacing Root backend acknowledgement.
   * @param reference - Original runtime, ID and spec hash to stop.
   * @param options - Earlier monotonic deadline or observer cancellation.
   * @returns Independent stop and completion facts, without replay or invented exit status.
   */
  stop(reference: OperationRef, options?: CallOptions): Promise<OperationSnapshot> { return this.#op('/stop', reference, options) }
  /**
   * Query non-consuming full tails and lifecycle facts for the original operation.
   * @param reference - Original runtime, ID and spec hash to query.
   * @param options - Earlier monotonic deadline or observer cancellation.
   * @returns Original byte coordinates and independent direct/range/IO facts.
   */
  poll(reference: OperationRef, options?: CallOptions): Promise<OperationSnapshot> { return this.#op('/poll', reference, options) }
  seal(options?: CallOptions): Promise<Handshake> {
    void this.fence()
    return this.#call('/seal', {}, undefined, options) as Promise<Handshake>
  }
  #op(route: Route, value: OperationRef, options?: CallOptions): Promise<OperationSnapshot> {
    const reference = checkRef(value, this.#expected.runtimeIdentity)
    const fields = { ...reference, ...(route === '/poll' ? { stdoutOffset: 0, stderrOffset: 0 } : {}) }
    return this.#call(route, fields, reference, options) as Promise<OperationSnapshot>
  }
  #remember(reference: OperationRef): RefRecord {
    const existing = this.#records.get(reference.operationId)
    if (existing) {
      need(existing.ref.specHash === reference.specHash
        && asciiJSON(existing.ref.authorization) === asciiJSON(reference.authorization), 'local_operation_conflict')
      return existing
    }
    need(this.#records.size < 4, 'local_reference_capacity')
    const row = { ref: reference, mutations: new Set<Mutation>(), unresolved: !this.#physicalAck }
    this.#records.set(reference.operationId, row); return row
  }
  #call(route: Route, fields: Record<string, unknown>, reference?: OperationRef,
    options: CallOptions = {}): Promise<Handshake | OperationSnapshot> {
    need(!this.#closing && !this.#physicalAck, 'local_carrier_closed')
    if (route === '/prepare' || route === '/commit') need(this.#verified && !this.#fenced, 'local_admission_fenced')
    need(options.deadlineMs === undefined
      || (typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs)), 'invalid_deadline')
    const now = performance.now(), deadline = Math.min(options.deadlineMs ?? now + L.requestMs, now + L.requestMs, this.#expires)
    need(Number.isFinite(deadline) && deadline > now && !options.signal?.aborted, 'local_deadline_or_cancel')
    const encoded = Buffer.from(asciiJSON({ ...fields, runtimeIdentity: this.#expected.runtimeIdentity }), 'ascii')
    need(encoded.length <= L.body, 'body_budget')
    need(this.#active.size < L.concurrent && this.#attempts < L.attempts
      && this.#sent + encoded.length <= L.sentBodyTotal && this.#allowance + L.reply <= L.replyAllowanceTotal, 'carrier_budget')
    const row = reference ? this.#remember(reference) : undefined
    const mutation = route !== '/handshake' && route !== '/poll' ? route : undefined
    if (mutation === '/seal') { need(!this.#sealAttempted, 'mutation_already_attempted'); this.#sealAttempted = true }
    else if (mutation && row) {
      need(!row.mutations.has(mutation), 'mutation_already_attempted'); row.mutations.add(mutation); row.unresolved = true
    }
    this.#attempts++; this.#sent += encoded.length; this.#allowance += L.reply // Lifetime pessimistic body allowances never recycled.
    let resolve!: (v: Handshake | OperationSnapshot) => void, reject!: (e: unknown) => void, finish!: () => void
    const result = new Promise<Handshake | OperationSnapshot>((yes, no) => { resolve = yes; reject = no })
    const actual = new Promise<void>((yes) => { finish = yes })
    let terminal = false, delivered = false, aborted = false, abortTransport: (() => void) | undefined
    let status = 0, expectedLength: number | undefined, length = 0, invalid = false
    const body = Buffer.alloc(L.reply)
    const uncertain = () => {
      void this.fence(); if (row && !this.#physicalAck) row.unresolved = true
      if (!delivered) { delivered = true; reject(new ControlUncertain(route, reference)) }
    }
    const abort = () => {
      if (terminal) return
      aborted = true; uncertain()
      try { abortTransport?.() } catch { this.#cleanupFailure = true }
    }
    const flight: Flight = { actual, bodyBytes: encoded.length, abort }; this.#active.add(flight)
    const timer = setTimeout(abort, Math.max(1, deadline - now))
    const externalCancel = () => { abort() }
    options.signal?.addEventListener('abort', externalCancel, { once: true })
    const settled = () => {
      terminal = true; clearTimeout(timer); options.signal?.removeEventListener('abort', externalCancel)
      this.#buffered -= length
      this.#active.delete(flight); finish()
    }
    const events: WireEvents = {
      start: (fn) => { if (terminal) return; abortTransport = fn; if (aborted) { try { fn() } catch { this.#cleanupFailure = true } } },
      headers: (code, headers) => {
        if (terminal) return
        try {
          need(status === 0, 'duplicate_response'); status = code
          const cl = headers['content-length']
          need(typeof cl === 'string' && /^(0|[1-9][0-9]{0,4})$/.test(cl) && Number(cl) <= L.reply
            && headers['content-type'] === 'application/json' && headers.connection === 'close'
            && headers['transfer-encoding'] === undefined && headers['content-encoding'] === undefined, 'response_framing')
          expectedLength = Number(cl)
        } catch { invalid = true; abort() }
      },
      data: (chunk) => {
        if (terminal || invalid || aborted) return
        if (!status || length + chunk.byteLength > L.reply) { invalid = true; abort(); return }
        body.set(chunk, length); length += chunk.byteLength
        this.#buffered += chunk.byteLength; this.#received += chunk.byteLength
      },
      error: () => { if (terminal) return; uncertain(); settled() },
      end: (trailers) => {
        if (terminal) return
        settled()
        if (delivered) return // A late response cannot silently erase a caller-visible uncertain range.
        try {
          need(performance.now() < deadline && !invalid && status >= 200 && expectedLength === length
            && Object.keys(trailers).length === 0, 'response_completion')
          const value = parseReply(body.subarray(0, length)); envelope(value, this.#expected.runtimeIdentity)
          if (status !== 200) {
            record(value, ['protocolVersion', 'runtimeIdentity', 'error'])
            need(status >= 400 && status < 500 && typeof value.error === 'string'
              && /^[a-z0-9_-]{1,64}$/.test(value.error), 'unbound_refusal')
            // Never copy arbitrary response text into errors/logs.
            delivered = true; reject(new RemoteRefusal(status, 'remote_refusal')); return
          }
          let snapshot: Handshake | OperationSnapshot
          if (route === '/handshake' || route === '/seal') {
            snapshot = handshake(value, this.#expected); this.#verified = true
            if (snapshot.sealed) void this.fence()
          } else {
            record(value, ['protocolVersion', 'runtimeIdentity', 'operation'])
            need(reference, 'missing_operation_reference')
            snapshot = operation(value.operation, reference)
            if (row && snapshot.rangeEmpty && snapshot.ioClosed && !snapshot.physicalStopRequired && !this.#physicalRequired) {
              row.unresolved = false
            }
          }
          if (snapshot.physicalStopRequired && !this.#physicalAck) {
            this.#physicalRequired = true; void this.fence()
            for (const known of this.#records.values()) known.unresolved = true
          }
          delivered = true; resolve(snapshot)
        } catch { uncertain() }
      },
    }
    try {
      this.#transport.dispatch({ route, body: encoded, headers: { [AGENT_AUTH_HEADER]: this.#token,
        'content-type': 'application/json', 'content-length': String(encoded.length), connection: 'close' } }, events)
    } catch { events.error() }
    return result
  }
  #closeMethod(kind: 'close' | 'destroy'): Promise<void> {
    this.#closePending++
    return Promise.resolve().then(() => this.#transport[kind]()).then(() => { this.#closed = true }, () => {
      this.#cleanupFailure = true
      if (kind === 'close') void this.#beginDestroy()
    }).finally(() => { this.#closePending-- })
  }
  #beginDestroy(): Promise<void> { return this.#destroy ??= this.#closeMethod('destroy') }
  release(options: Pick<CallOptions, 'deadlineMs'> = {}): Promise<Responsibility> {
    void this.fence()
    const deadline = Math.min(options.deadlineMs ?? performance.now() + L.releaseMs, performance.now() + L.releaseMs)
    need(Number.isFinite(deadline), 'invalid_release_deadline')
    if (!this.#closing) {
      this.#closing = true
      const work = [...this.#active].map(f => f.actual)
      for (const f of this.#active) f.abort()
      const close = this.#closeMethod('close')
      this.#releaseTimer = setTimeout(() => { void this.#beginDestroy() }, Math.max(0, deadline - performance.now()))
      this.#cleanup = (async () => {
        await Promise.all(work); await close
        if (!this.#closed) void this.#beginDestroy()
        if (this.#destroy) await this.#destroy
        clearTimeout(this.#releaseTimer); this.#cleanupDone = true
      })()
    }
    const cleanup = this.#cleanup
    need(cleanup, 'release_not_started')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#cleanupDone) void this.#beginDestroy()
        resolve(this.responsibility())
      }, Math.max(0, deadline - performance.now()))
      void cleanup.then(() => { clearTimeout(timer); resolve(this.responsibility()) })
    })
  }
  async whenLocallySettled(): Promise<void> {
    need(this.#cleanup, 'release_not_started'); await this.#cleanup
    need(this.responsibility().localSettled, 'local_cleanup_unknown')
  }
}
