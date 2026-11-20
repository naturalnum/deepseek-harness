/** Per-client request ownership and finite data facts; global operation/allocation authority stays with Root. */
import { skillWorld, assertSkillParent } from './skill-world.ts'
import { filePolicy } from './file-policy.ts'
import { performance } from 'node:perf_hooks'
import { asciiJSON, preparedDigest, need, record, spec } from './canonical.ts'
import { canSpend, canSpendWithStopReserve, emptyUsage, RollingCarrierBudget } from './carrier-budget.ts'
import { parseReply } from './strict-json.ts'
import { checkOptions, envelope, handshake, operation, ref as checkRef } from './validate.ts'
import { AGENT_AUTH_HEADER, CARRIER_LIMITS as L, RECORD_SETTLEMENT_VERSION, RENEWAL_AGENT_SOURCE_SHA256,
  RESIDENCE_LIMITS as R, RESIDENCE_VERSION, SERVICE_WINDOW_VERSION, SLICE_LIMITS } from './constants.ts'
import { signResidence, signServiceWindow, signSettlement } from './root-role-issuer.ts'
import { ControlUncertain, RemoteRefusal } from './errors.ts'
import { ExecutionStream } from './stream.ts'
import type { AgentDataClient, AgentDataStream, CallOptions, CarrierBudgetMode, CarrierWireUsage, ClientOptions, ExpectedBinding, Handshake, Mutation,
  OperationRef, OperationSnapshot, OperationSpec, PhysicalStopAck, PipesOperationSpec, PreparedRequest,
  ResidenceOffer, ResidenceReceipt, Responsibility, Route } from './types.ts'
import type { OwnedTransport, WireEvents } from './transport.ts'

interface RefRecord { ref: OperationRef
  mutations: Set<Mutation>
  unresolved: boolean
  prepared?: boolean
  pipes?: PipesOperationSpec
  attachAttempted?: boolean
  terminal?: boolean
  activeCollect?: boolean
  stream?: ExecutionStream
  wire?: CarrierWireUsage }
interface Flight { actual: Promise<void>; bodyBytes: number; row?: RefRecord; stream?: boolean; abort(): void }

/** Internal constructor permits exclusive fake transport ownership for units. Public factory always owns a fresh Pool. */
export class DataClient implements AgentDataClient {
  readonly #expected: ExpectedBinding
  readonly #token: string
  readonly #transport: OwnedTransport
  readonly #rolling?: RollingCarrierBudget
  readonly #legacyExpires = performance.now() + L.localLifetimeMs
  #expires = this.#legacyExpires
  #residenceSequence = 0
  #publishedResidenceSequence = 0
  #residenceVerified = false
  readonly #records = new Map<string, RefRecord>()
  readonly #active = new Set<Flight>()
  #verified = false; #fenced = false; #closing = false; #physicalAck = false; #physicalRequired = false
  #streamVerified = false; #settlementVerified = false; #serviceWindowVerified = false; #seenSequence = 0
  #attempts = 0; #sent = 0; #allowance = 0; #buffered = 0; #received = 0; #sealAttempted = false
  #closed = false; #closePending = 0; #cleanupFailure = false; #cleanupDone = false
  #cleanup?: Promise<void>; #destroy?: Promise<void>; #releaseTimer?: ReturnType<typeof setTimeout>
  #fenceJoin?: Promise<void>
  /**
   * Bind protected Root expectations and transfer exclusive local dispatcher ownership.
   * @param options - Original fixed endpoint, runtime, token and expected facts.
   * @param transport - Exclusively owned transport; fake transfer is private test support only.
   * @param mode - Optional protected Root selection for the paired renewal guest.
   */
  constructor(options: ClientOptions, transport: OwnedTransport, mode?: CarrierBudgetMode) {
    this.#expected = checkOptions(options).expected; this.#token = options.token; this.#transport = transport
    if (mode !== undefined) {
      need(this.#expected.pins.agentSourceSha256 === RENEWAL_AGENT_SOURCE_SHA256, 'rolling_carrier_guest')
      this.#rolling = new RollingCarrierBudget()
    }
  }
  fence(): Promise<void> {
    this.#fenced = true
    return this.#fenceJoin ??= Promise.all([...this.#active].filter(f => !f.stream).map(f => f.actual)).then(() => undefined)
  }
  responsibility(): Responsibility {
    return Object.freeze({ fenced: this.#fenced, closing: this.#closing, inFlight: this.#active.size,
      dispatcherClosed: this.#closed, closeMethodsPending: this.#closePending, cleanupFailure: this.#cleanupFailure,
      localSettled: this.#closing && this.#cleanupDone && this.#active.size === 0 && this.#closePending === 0 && this.#closed,
      attempts: this.#attempts, sentBodyBytes: this.#sent, replyBodyAllowance: this.#allowance,
      ...(this.#rolling === undefined ? {} : { carrierWindow: Object.freeze(this.#rolling.usage(performance.now())) }),
      replyBuffersReservedBytes: [...this.#active].filter(f => !f.stream).length * L.reply,
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
    record(request, ['ref', 'spec', ...request.skillWorld === undefined ? [] : ['skillWorld'],
      ...request.filePolicy === undefined ? [] : ['filePolicy']])
    const reference = checkRef(request.ref, this.#expected.runtimeIdentity), normalized = spec(request.spec, this.#expected.projectRoot)
    const fixed = request.skillWorld === undefined ? undefined : skillWorld(request.skillWorld)
    if (fixed !== undefined) assertSkillParent(fixed, this.#expected.skillParent)
    need((this.#expected.skillParent === undefined) === (fixed === undefined), 'skill_parent_required')
    const policy = request.filePolicy === undefined ? undefined : filePolicy(request.filePolicy)
    need(normalized.executionKind !== 'pipes' || this.#streamVerified, 'stream_capability_unavailable')
    need(normalized.executionKind !== 'pipes' || reference.authorization.role !== 'service', 'pipes_service_role')
    need(reference.authorization.role !== 'program' || normalized.executionKind === 'pipes', 'program_requires_pipes')
    need(preparedDigest(normalized, fixed, policy) === reference.specHash, 'spec_hash_mismatch')
    return this.#call('/prepare', { ...reference, spec: normalized, ...fixed === undefined ? {} : { skillWorld: fixed },
      ...policy === undefined ? {} : { filePolicy: policy } }, reference, options, normalized) as Promise<OperationSnapshot>
  }
  attach(ref: OperationRef, options: CallOptions = {}): Promise<AgentDataStream> {
    const reference = checkRef(ref, this.#expected.runtimeIdentity), row = this.#records.get(reference.operationId)
    need(!this.#closing && !this.#fenced && !this.#physicalAck && this.#streamVerified, 'stream_admission_fenced')
    need(row !== undefined && row.ref.specHash === reference.specHash
      && asciiJSON(row.ref.authorization) === asciiJSON(reference.authorization) && row.prepared && row.pipes !== undefined
      && row.ref.recordSequence === reference.recordSequence
      && reference.recordSequence === undefined
      && !row.attachAttempted && !row.mutations.has('/commit') && reference.authorization.role !== 'service', 'stream_operation_binding')
    need(this.#transport.attach !== undefined, 'stream_transport_unavailable')
    const now = performance.now(), deadline = Math.min(options.deadlineMs ?? now + L.requestMs, now + L.requestMs, this.#legacyExpires)
    need(Number.isFinite(deadline) && deadline > now && !options.signal?.aborted, 'local_deadline_or_cancel')
    const usage = this.#usage(now, row)
    need([...this.#active].filter(f => f.stream).length < 2 && canSpend(usage, 1, 0, 0), 'carrier_budget')
    if (this.#rolling !== undefined) need(canSpendWithStopReserve(usage, 0, 0), 'residence_terminal_budget')
    row.attachAttempted = true
    this.#charge(now, row, 0, 0)
    const stream = row.stream = new ExecutionStream(reference, row.pipes, () => {
      void this.fence(); if (!this.#physicalAck) row.unresolved = true
    })
    const flight: Flight = { actual: stream.settled, bodyBytes: 0, row, stream: true, abort: () => { stream.fail() } }
    this.#active.add(flight)
    const timer = setTimeout(() => { stream.fail() }, Math.max(1, deadline - now))
    const residence = setTimeout(() => { stream.fail() }, Math.max(1, this.#legacyExpires - now))
    const cancel = () => { stream.fail() }
    options.signal?.addEventListener('abort', cancel, { once: true })
    void stream.ready.then(() => { clearTimeout(timer) }, () => { clearTimeout(timer) })
    void stream.settled.then(() => {
      clearTimeout(timer); clearTimeout(residence); options.signal?.removeEventListener('abort', cancel)
      this.#active.delete(flight)
    })
    try {
      const auth = reference.authorization
      stream.bind(this.#transport.attach({ headers: { [AGENT_AUTH_HEADER]: this.#token,
        'x-pe-operation-id': reference.operationId, 'x-pe-spec-hash': reference.specHash,
        'x-pe-range-role': auth.role, 'x-pe-registration-id': auth.registrationId ?? '-', 'x-pe-role-signature': auth.signature,
        ...reference.recordSequence === undefined ? {} : { 'x-pe-record-sequence': String(reference.recordSequence) },
      } }, stream.events))
    } catch { stream.events.error(); stream.events.closed() }
    return stream.ready
  }
  joinStream(ref: OperationRef): Promise<void> {
    const reference = checkRef(ref, this.#expected.runtimeIdentity), row = this.#records.get(reference.operationId)
    need(row !== undefined && row.ref.specHash === reference.specHash
      && row.ref.recordSequence === reference.recordSequence
      && asciiJSON(row.ref.authorization) === asciiJSON(reference.authorization), 'stream_operation_binding')
    return row.stream?.settled ?? Promise.resolve()
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
  async settle(ref: OperationRef, options?: CallOptions): Promise<void> {
    const reference = checkRef(ref, this.#expected.runtimeIdentity)
    const row = this.#records.get(reference.operationId)
    need(this.#settlementVerified && reference.recordSequence !== undefined && row !== undefined
      && row.terminal && !row.unresolved && !this.#physicalRequired && !this.#fenced && !this.#cleanupFailure
      && row.pipes === undefined
      && ![...this.#active].some(flight => flight.row === row), 'local_record_unsettled')
    await this.#call('/settle', { ...reference, settlementProof: signSettlement(this.#token, reference) }, reference, options)
  }
  async extendService(ref: OperationRef, runMs: number, futurePolls: number, options: CallOptions): Promise<boolean> {
    const reference = checkRef(ref, this.#expected.runtimeIdentity), row = this.#records.get(reference.operationId)
    need(this.#serviceWindowVerified && reference.authorization.role === 'service' && row?.activeCollect
      && !row.mutations.has('/stop') && !row.mutations.has('/cancel')
      && !this.#fenced && !this.#physicalRequired && !this.#cleanupFailure
      && ![...this.#active].some(flight => flight.row === row), 'service_window_unavailable')
    need(Number.isSafeInteger(runMs) && runMs > SLICE_LIMITS.serviceRunMs && runMs <= SLICE_LIMITS.runMs
      && Number.isSafeInteger(futurePolls) && futurePolls >= 0, 'service_window_budget')
    const fields = { ...reference, runMs, windowProof: signServiceWindow(this.#token, reference, runMs) }
    const followups = futurePolls + 2 // Original stop and one seal also need carrier room.
    const pollBytes = asciiJSON({ ...reference, stdoutOffset: 0, stderrOffset: 0 }).length
    const usage = this.#usage(performance.now(), row), bytes = asciiJSON(fields).length
    if (!canSpend(usage, 1 + followups, bytes + followups * pollBytes, (1 + followups) * L.reply)
      || this.#rolling !== undefined && !canSpendWithStopReserve(usage, bytes, L.reply)
      || [...this.#active].filter(flight => !flight.stream).length >= L.concurrent) return false
    await this.#call('/extend-service', fields, reference, options)
    return true
  }
  async renewResidence(ref: OperationRef, offer: ResidenceOffer, options: CallOptions): Promise<ResidenceReceipt | undefined> {
    const original = checkRef(ref, this.#expected.runtimeIdentity), row = this.#records.get(original.operationId)
    need(this.#residenceVerified && row?.activeCollect && !row.mutations.has('/stop') && !row.mutations.has('/cancel')
      && !this.#fenced && !this.#closing && !this.#physicalRequired && !this.#cleanupFailure
      && ![...this.#active].some(flight => flight.row === row), 'residence_unavailable')
    if ([...this.#active].some(flight => flight.stream)) return undefined
    const leaseSequence = this.#residenceSequence + 1
    if (leaseSequence > R.grants || !canSpendWithStopReserve(this.#usage(performance.now(), row), R.fixedControlBytes, L.reply)
      || [...this.#active].filter(flight => !flight.stream).length >= L.concurrent) return undefined
    const fields = { ...original, ...offer, leaseSequence, residenceProof: signResidence(this.#token, original, offer, leaseSequence) }
    need(asciiJSON(fields).length <= R.fixedControlBytes && this.#publishedResidenceSequence === leaseSequence - 1,
      'residence_sequence')
    this.#residenceSequence = leaseSequence
    return this.#call('/renew-residence', fields, original, options) as Promise<ResidenceReceipt>
  }
  seal(options?: CallOptions): Promise<Handshake> {
    void this.fence()
    return this.#call('/seal', {}, undefined, options) as Promise<Handshake>
  }
  #op(route: Route, value: OperationRef, options?: CallOptions): Promise<OperationSnapshot> {
    const reference = checkRef(value, this.#expected.runtimeIdentity)
    const row = this.#records.get(reference.operationId)
    if (route === '/commit' && row?.pipes !== undefined) need(row.stream?.connected, 'stream_not_attached')
    if (route === '/stop' || route === '/cancel') row?.stream?.abandon()
    const fields = { ...reference, ...(route === '/poll' ? { stdoutOffset: 0, stderrOffset: 0 } : {}) }
    return this.#call(route, fields, reference, options) as Promise<OperationSnapshot>
  }
  #remember(reference: OperationRef, route: Route): RefRecord {
    const existing = this.#records.get(reference.operationId)
    if (existing) {
      need(existing.ref.specHash === reference.specHash
        && existing.ref.recordSequence === reference.recordSequence
        && asciiJSON(existing.ref.authorization) === asciiJSON(reference.authorization), 'local_operation_conflict')
      need(!existing.mutations.has('/settle'), 'local_settlement_started')
      return existing
    }
    need(this.#records.size < 4, 'local_reference_capacity')
    if (reference.recordSequence !== undefined) {
      need(this.#settlementVerified && route === '/prepare'
        && reference.recordSequence > this.#seenSequence, 'local_operation_sequence')
      this.#seenSequence = reference.recordSequence
    }
    const row = { ref: reference, mutations: new Set<Mutation>(), unresolved: !this.#physicalAck }
    this.#records.set(reference.operationId, row); return row
  }

  #usage(now: number, row?: RefRecord): CarrierWireUsage {
    if (this.#rolling === undefined) {
      return { attempts: this.#attempts, sentBodyBytes: this.#sent, replyBodyAllowance: this.#allowance }
    }
    const carrier = this.#rolling.usage(now), operation = row?.wire
    if (operation === undefined) return carrier
    // Expiring carrier charges cannot increase the lifetime allowance of an unsettled operation.
    return { attempts: Math.max(carrier.attempts, operation.attempts),
      sentBodyBytes: Math.max(carrier.sentBodyBytes, operation.sentBodyBytes),
      replyBodyAllowance: Math.max(carrier.replyBodyAllowance, operation.replyBodyAllowance) }
  }

  #charge(now: number, row: RefRecord | undefined, sent: number, reply: number): void {
    this.#attempts++; this.#sent += sent; this.#allowance += reply
    if (this.#rolling === undefined) return
    this.#rolling.charge(now, sent, reply)
    if (row !== undefined) {
      const operation = row.wire ?? emptyUsage()
      row.wire = { attempts: operation.attempts + 1, sentBodyBytes: operation.sentBodyBytes + sent,
        replyBodyAllowance: operation.replyBodyAllowance + reply }
    }
  }

  #call(route: Route, fields: Record<string, unknown>, reference?: OperationRef,
    options: CallOptions = {}, preparedSpec?: OperationSpec): Promise<Handshake | OperationSnapshot | ResidenceReceipt | undefined> {
    need(!this.#closing && !this.#physicalAck, 'local_carrier_closed')
    if (route === '/prepare' || route === '/commit') need(this.#verified && !this.#fenced, 'local_admission_fenced')
    need(options.deadlineMs === undefined
      || (typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs)), 'invalid_deadline')
    const now = performance.now(), deadline = Math.min(options.deadlineMs ?? now + L.requestMs, now + L.requestMs, this.#expires)
    need(Number.isFinite(deadline) && deadline > now && !options.signal?.aborted, 'local_deadline_or_cancel')
    const encoded = Buffer.from(asciiJSON({ ...fields, runtimeIdentity: this.#expected.runtimeIdentity }), 'ascii')
    need(encoded.length <= L.body, 'body_budget')
    const existing = reference === undefined ? undefined : this.#records.get(reference.operationId)
    const usage = this.#usage(now, existing)
    need([...this.#active].filter(f => !f.stream).length < L.concurrent
      && canSpend(usage, 1, encoded.length, L.reply), 'carrier_budget')
    const stopping = route === '/stop' || route === '/cancel' || route === '/seal'
      || route === '/poll' && existing?.mutations.has('/stop') === true
    if (!stopping && (this.#residenceSequence > 0 || this.#rolling !== undefined)) {
      need(canSpendWithStopReserve(usage, encoded.length, L.reply), 'residence_terminal_budget')
    }
    need(reference?.recordSequence === undefined || preparedSpec?.executionKind !== 'pipes', 'settlement_collect_required')
    const row = reference ? this.#remember(reference, route) : undefined
    if (row !== undefined && preparedSpec?.executionKind === 'pipes') row.pipes = preparedSpec
    const mutation = route !== '/handshake' && route !== '/poll' && route !== '/stream' && route !== '/renew-residence' ? route : undefined
    if (mutation === '/seal') { need(!this.#sealAttempted, 'mutation_already_attempted'); this.#sealAttempted = true }
    else if (mutation && row) {
      need(!row.mutations.has(mutation), 'mutation_already_attempted'); row.mutations.add(mutation); row.unresolved = true
    }
    this.#charge(now, row, encoded.length, L.reply)
    let resolve!: (v: Handshake | OperationSnapshot | ResidenceReceipt | undefined) => void
    let reject!: (e: unknown) => void, finish!: () => void
    const result = new Promise<Handshake | OperationSnapshot | ResidenceReceipt | undefined>((yes, no) => { resolve = yes; reject = no })
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
    const flight: Flight = { actual, bodyBytes: encoded.length, ...row === undefined ? {} : { row }, abort }
    this.#active.add(flight)
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
            if (route === '/settle' || route === '/extend-service' || route === '/renew-residence') { uncertain(); return }
            // Never copy arbitrary response text into errors/logs.
            delivered = true; reject(new RemoteRefusal(status, 'remote_refusal')); return
          }
          if (route === '/settle') {
            record(value, ['protocolVersion', 'runtimeIdentity', 'settled'])
            record(value.settled, ['operationId', 'specHash', 'recordSequence'])
            need(row !== undefined && !this.#fenced && !this.#closing && !this.#physicalRequired && !this.#cleanupFailure
              && value.settled.operationId === row.ref.operationId && value.settled.specHash === row.ref.specHash
              && value.settled.recordSequence === row.ref.recordSequence, 'settlement_reply_binding')
            this.#records.delete(row.ref.operationId)
            delivered = true; resolve(undefined); return
          }
          if (route === '/extend-service') {
            record(value, ['protocolVersion', 'runtimeIdentity', 'serviceWindow'])
            record(value.serviceWindow, ['operationId', 'specHash', 'registrationId', 'runMs'])
            need(row !== undefined && !this.#fenced && !this.#closing && !this.#physicalRequired && !this.#cleanupFailure
              && value.serviceWindow.operationId === row.ref.operationId && value.serviceWindow.specHash === row.ref.specHash
              && value.serviceWindow.registrationId === row.ref.authorization.registrationId
              && value.serviceWindow.runMs === fields.runMs, 'service_window_reply_binding')
            delivered = true; resolve(undefined); return
          }
          if (route === '/renew-residence') {
            record(value, ['protocolVersion', 'runtimeIdentity', 'residence'])
            const reply = value.residence, limit = fields.remainingMs
            record(reply, ['leaseSequence', 'operationId', 'specHash', 'registrationId', 'residentCapMs', 'runCapMs',
              'residentRemainingMs', 'runRemainingMs'])
            const duration = (remaining: unknown): remaining is number | null => remaining === null
              || typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining > 0
              && typeof limit === 'number' && remaining <= limit
            const { residentRemainingMs, runRemainingMs } = reply
            need(row !== undefined && !this.#fenced && !this.#closing && !this.#physicalRequired && !this.#cleanupFailure
              && reply.leaseSequence === this.#residenceSequence && reply.leaseSequence === fields.leaseSequence
              && reply.operationId === row.ref.operationId && reply.specHash === row.ref.specHash
              && reply.registrationId === row.ref.authorization.registrationId && reply.residentCapMs === fields.residentCapMs
              && reply.runCapMs === fields.runCapMs && duration(residentRemainingMs) && duration(runRemainingMs),
            'residence_reply_binding')
            const sequence = this.#residenceSequence
            const publish = (untilMs: number | undefined): void => {
              need(sequence === this.#residenceSequence && this.#publishedResidenceSequence === sequence - 1
                && !this.#fenced && !this.#closing && !this.#physicalRequired && !this.#cleanupFailure
                && performance.now() < deadline && performance.now() < this.#expires, 'residence_publish_closed')
              if (untilMs !== undefined) {
                need(residentRemainingMs !== null && Number.isFinite(untilMs) && untilMs <= now + residentRemainingMs
                  && untilMs <= this.#legacyExpires - L.localLifetimeMs + R.maxMs, 'residence_publish_window')
                this.#expires = Math.max(this.#expires, untilMs)
              }
              this.#publishedResidenceSequence = sequence
            }
            delivered = true; resolve(Object.freeze({ residentRemainingMs, runRemainingMs, publish })); return
          }
          let snapshot: Handshake | OperationSnapshot
          if (route === '/handshake' || route === '/seal') {
            snapshot = handshake(value, this.#expected); this.#verified = true
            this.#streamVerified = snapshot.streamLimits !== undefined
            this.#settlementVerified = snapshot.recordSettlementVersion === RECORD_SETTLEMENT_VERSION
            this.#serviceWindowVerified = snapshot.serviceWindowVersion === SERVICE_WINDOW_VERSION
            this.#residenceVerified = snapshot.residenceVersion === RESIDENCE_VERSION
            if (snapshot.sealed) void this.fence()
          } else {
            record(value, ['protocolVersion', 'runtimeIdentity', 'operation'])
            need(reference, 'missing_operation_reference')
            snapshot = operation(value.operation, reference)
            need((row?.pipes !== undefined) === (snapshot.executionKind === 'pipes'), 'operation_execution_kind')
            // A later poll may be the first reply that confirms guardian preparation.
            if (row !== undefined && (route === '/prepare' || route === '/poll')) row.prepared = snapshot.prepared && !snapshot.commitClosed
              && !snapshot.physicalStopRequired && !snapshot.providerFailure && snapshot.firstCause === null
              && snapshot.failure === null && snapshot.cleanupFailure === null && !snapshot.stream?.attached
            if (row?.stream !== undefined && route === '/commit' && snapshot.submitted && !snapshot.physicalStopRequired
              && snapshot.firstCause === null && !snapshot.providerFailure) row.stream.noteSubmitted()
            if (row !== undefined) {
              if (snapshot.rangeEmpty && snapshot.ioClosed && !snapshot.physicalStopRequired && !this.#physicalRequired) {
                row.unresolved = false
              }
              row.terminal = snapshot.submitted && snapshot.commitAttempted && snapshot.direct !== null
                && snapshot.rangeEmpty && snapshot.ioClosed && snapshot.streams.stdout.eof && snapshot.streams.stderr.eof
                && !snapshot.physicalStopRequired && !snapshot.providerFailure
                && snapshot.failure === null && snapshot.cleanupFailure === null
              row.activeCollect = reference.authorization.role !== 'program' && row.pipes === undefined
                && snapshot.submitted && snapshot.commitAttempted
                && !snapshot.commitClosed && !snapshot.rangeEmpty && !snapshot.ioClosed && snapshot.direct === null
                && !snapshot.physicalStopRequired && !snapshot.providerFailure && snapshot.firstCause === null
                && snapshot.failure === null && snapshot.cleanupFailure === null
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
