/** Focused Vitest evidence for bounded fake transport and pinned pure Python values. */
import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DataClient } from '../src/agent-data/client-internal.ts'
import { asciiJSON, digest, makePrepared, record } from '../src/agent-data/canonical.ts'
import { createForegroundIssuer, createRegisteredServiceIssuer } from '../src/agent-data/root-role-issuer.ts'
import { parseReply } from '../src/agent-data/strict-json.ts'
import { expectedWorldHash, worldArgv } from '../src/agent-data/validate.ts'
import { AGENT_AUTH_HEADER, AGENT_SOURCE_SHA256, BWRAP_SHA256, CARRIER_LIMITS, PROTOCOL,
  RENEWAL_AGENT_SOURCE_SHA256, RENEWAL_CHILD_LIMITS, RESIDENCE_LIMITS, SLICE_LIMITS } from '../src/agent-data/constants.ts'
import { CarrierPrepareCapacityError, ControlUncertain, LocalRefusal, RemoteRefusal } from '../src/agent-data/errors.ts'
import type { CarrierBudgetMode, ClientOptions, MountFact, OperationSpec, PreparedRequest } from '../src/agent-data/types.ts'
import type { OwnedTransport, WireEvents, WireRequest } from '../src/agent-data/transport.ts'
import { guardianEncodedBudget } from '../src/agent-data/encoded-budget.ts'

const TOKEN = '1'.repeat(64), RUNTIME = '2'.repeat(64), PROJECT = '/srv/project'
function options() {
  return { host: '172.20.0.2', port: 23456, token: TOKEN, expected: {
    physicalSandboxId: 'private-sandbox-fixture', runtimeIdentity: RUNTIME, projectRoot: PROJECT,
    declaredImageId: 'sha256:' + '3'.repeat(64),
    roots: { project: { device: '100', inode: '18446744073709551615', maximumBytes: '250847232', maximumInodes: '2048' },
      environment: { device: '200', inode: '9007199254740993', maximumBytes: '33554432', maximumInodes: '4096' } },
    pins: { bwrapSha256: BWRAP_SHA256, agentSourceSha256: AGENT_SOURCE_SHA256,
      userWorldArgvSha256: expectedWorldHash(PROJECT) } } } satisfies ClientOptions
}
type MountFixture = { -readonly [Key in keyof MountFact]: Key extends 'inode' ? string | number : MountFact[Key] }
function mountFixture(root: ClientOptions['expected']['roots']['project']): MountFixture {
  return { device: root.device, inode: root.inode, uid: 2000, gid: 2000,
    capacityBytes: root.maximumBytes, capacityInodes: root.maximumInodes,
    grant: { maximumBytes: root.maximumBytes, maximumInodes: root.maximumInodes } }
}
function handshakeFixture(config = options(), changes: Record<string, unknown> = {}) {
  const e = config.expected
  const protocolVersion: string = PROTOCOL
  const limits: { -readonly [Key in keyof typeof SLICE_LIMITS]: number } = { ...SLICE_LIMITS }
  return { protocolVersion, runtimeIdentity: RUNTIME,
    capabilities: ['argv', 'stdin-ignore', 'stdin-batch', 'collect'],
    pins: { ...e.pins }, declaredImageId: e.declaredImageId,
    mounts: { [PROJECT]: mountFixture(e.roots.project), '/opt/session-env': mountFixture(e.roots.environment) },
    limits, recordCount: 0,
    activeRangeCount: 0, rangeRoles: { foreground: 0, service: 0 },
    newOperationsAccepted: true, sealed: false, sealReason: null, physicalStopRequired: false, ...changes }
}
function prepared(id = 'one'): PreparedRequest {
  return createForegroundIssuer(TOKEN, RUNTIME, () => {})(makePrepared(RUNTIME, id,
    { argv: ['/bin/echo', '中文😀\x7f'], cwd: PROJECT, stdin: { mode: 'batch', base64: 'AP8=' } }))
}
function operationFixture(reference = prepared().ref, changes: Record<string, unknown> = {}) {
  const tail = () => ({ requestedOffset: 0, startOffset: 0, endOffset: 0, observedBytes: 0, base64: '', lossy: false, eof: false })
  return { protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, operation: {
    operationId: reference.operationId, specHash: reference.specHash,
    role: reference.authorization.role, registrationId: reference.authorization.registrationId, primitiveStarted: true, prepared: true,
    commitAttempted: false, commitClosed: false, submitted: false, firstCause: null, direct: null,
    directNotObserved: true, rangeEmpty: false, ioClosed: false, physicalStopRequired: false,
    failure: null, cleanupFailure: null, providerFailure: false, streams: { stdout: tail(), stderr: tail() }, ...changes } }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes }); return { promise, resolve } }
class FakeTransport implements OwnedTransport {
  readonly requests: { request: WireRequest; events: WireEvents; aborted: boolean }[] = []
  autoAbort = true; closeCalls = 0; destroyCalls = 0
  closeGate?: ReturnType<typeof deferred>; destroyGate?: ReturnType<typeof deferred>; rejectClose = false
  dispatch(request: WireRequest, events: WireEvents): void {
    const row = { request, events, aborted: false }; this.requests.push(row)
    events.start(() => { row.aborted = true; if (this.autoAbort) events.error() })
  }
  close(): Promise<void> {
    this.closeCalls++
    return this.rejectClose ? Promise.reject(new Error(TOKEN)) : this.closeGate?.promise ?? Promise.resolve()
  }
  destroy(): Promise<void> { this.destroyCalls++; return this.destroyGate?.promise ?? Promise.resolve() }
  reply(index: number, value: unknown, status = 200, custom?: string): void {
    const data = Buffer.from(custom ?? asciiJSON(value), 'ascii'), row = this.requests[index]!
    row.events.headers(status, { 'content-length': String(data.length), 'content-type': 'application/json', connection: 'close' })
    row.events.data(data); row.events.end({})
  }
}
function raw() { const transport = new FakeTransport(); return { client: new DataClient(options(), transport), transport } }
async function ready() {
  const result = raw(), p = result.client.handshake(); result.transport.reply(0, handshakeFixture()); await p; return result
}
const release = (client: DataClient) => client.release({ deadlineMs: performance.now() + 30 })

test('Python canonical Unicode/DEL/codepoint ordering and frozen world hashes match', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/agent-data/python-vectors.json', import.meta.url), 'utf8')) as {
    canonical: { value: unknown; canonical: string; sha256: string }[]
    world: { project: string; argv: string[]; sha256: string }[]
  }
  for (const vector of vectors.canonical) {
    assert.equal(asciiJSON(vector.value), vector.canonical); assert.equal(digest(vector.value), vector.sha256)
  }
  for (const vector of vectors.world) {
    assert.deepEqual(worldArgv(vector.project), vector.argv); assert.equal(expectedWorldHash(vector.project), vector.sha256)
  }
  for (const value of ['\ud800', '\udc00', 'a\ud800x']) {
    assert.throws(() => asciiJSON(value), LocalRefusal)
    assert.throws(() => makePrepared(RUNTIME, 'one', { argv: ['/bin/x', value], cwd: PROJECT, stdin: { mode: 'ignore' } }), LocalRefusal)
  }
})
test('command wire paths refuse directory suffixes and traversal before contacting the Linux agent', () => {
  for (const cwd of [PROJECT + '/', PROJECT + '//', PROJECT + '/x/../y', PROJECT + '//x']) {
    assert.throws(() => makePrepared(RUNTIME, 'invalid-path', { argv: ['/bin/true'], cwd, stdin: { mode: 'ignore' } }), LocalRefusal)
  }
  assert.equal(makePrepared(RUNTIME, 'skill', { argv: ['/bin/true'], cwd: PROJECT + '/.skills/version',
    stdin: { mode: 'ignore' } }).spec.cwd, PROJECT + '/.skills/version')
})

test('bounded strict reply JSON rejects duplicates, unsafe numbers, surrogates and non-ASCII payload', () => {
  for (const value of ['{"a":1,"a":2}', '{"n":9007199254740993}', '{"n":1.0}', '{"n":NaN}', '"\\ud800"', '{"x":1} trailing']) {
    assert.throws(() => parseReply(Buffer.from(value, 'ascii')))
  }
  assert.throws(() => parseReply(Uint8Array.of(255)))
  assert.throws(() => parseReply(Buffer.alloc(16385)))
  const decoded = parseReply(Buffer.from('{"inode":"18446744073709551615"}'))
  record(decoded, ['inode']); assert.equal(decoded.inode, '18446744073709551615')
})
test('fixed endpoint and frozen Root input pins refuse rebinding before transport use', () => {
  for (const update of [ { host: 'example.com' }, { host: '8.8.8.8' }, { port: 0 } ]) {
    const fake = new FakeTransport()
    assert.throws(() => new DataClient({ ...options(), ...update }, fake), LocalRefusal); assert.equal(fake.requests.length, 0)
  }
  const config = options(); config.expected.pins.agentSourceSha256 = '0'.repeat(64)
  assert.throws(() => new DataClient(config, new FakeTransport()), LocalRefusal)
})
test('handshake compares original runtime/payload/world/roots/limits rather than echo-learning', async () => {
  const changes: ((v: ReturnType<typeof handshakeFixture>) => void)[] = [
    (v) => { v.runtimeIdentity = '0'.repeat(64) }, (v) => { v.protocolVersion = 'future' },
    (v) => { v.pins.agentSourceSha256 = '0'.repeat(64) }, (v) => { v.pins.userWorldArgvSha256 = '0'.repeat(64) },
    (v) => { v.mounts[PROJECT].inode = Number.MAX_SAFE_INTEGER }, (v) => { v.mounts[PROJECT].inode = '18446744073709551614' },
    (v) => { v.limits.runMs = 5001 }, (v) => { v.limits.childFileBytes = 67108864 },
    (v) => { v.limits.childCpuSeconds = 75 }, (v) => { v.limits.childAddressBytes = 536870912 },
    (v) => { v.limits.childOpenFiles = 32 }, (v) => { v.limits.childProcesses = 32 },
    (v) => { v.declaredImageId = 'sha256:' + '4'.repeat(64) }]
  for (const change of changes) {
    const { client, transport } = raw(), value = handshakeFixture(); change(value)
    const pending = client.handshake(); transport.reply(0, value)
    await assert.rejects(pending, ControlUncertain); assert.equal(client.responsibility().fenced, true)
    assert.throws(() => client.prepare(prepared()), LocalRefusal); await release(client)
  }
})
test('requires the selected guest child limits and authenticated handshake extensions', async () => {
  const extensions = { recordSettlementVersion: 1, serviceWindowVersion: 1, residenceVersion: 1 }
  const config = options()
  config.expected.pins.agentSourceSha256 = RENEWAL_AGENT_SOURCE_SHA256
  const limits = { ...SLICE_LIMITS, ...RENEWAL_CHILD_LIMITS }
  const transport = new FakeTransport(), client = new DataClient(config, transport)
  const handshake = client.handshake()
  transport.reply(0, handshakeFixture(config, { limits, ...extensions }))
  assert.deepEqual((await handshake).limits, limits)
  await release(client)

  for (const [expected, changes] of [
    [config, { ...extensions, limits: { ...limits, childCpuSeconds: limits.childCpuSeconds + 1 } }],
    [config, { limits }],
    [options(), extensions],
  ] as const) {
    const wire = new FakeTransport(), rejected = new DataClient(expected, wire)
    const pending = rejected.handshake()
    wire.reply(0, handshakeFixture(expected, changes))
    await assert.rejects(pending, ControlUncertain)
    await release(rejected)
  }
})
test('prepare needs validated handshake; encoded body/auth and Root binding survive caller mutation', async () => {
  const config = options(), transport = new FakeTransport(), client = new DataClient(config, transport)
  assert.throws(() => client.prepare(prepared()), LocalRefusal)
  const h = client.handshake(); config.expected.runtimeIdentity = '0'.repeat(64); transport.reply(0, handshakeFixture()); await h
  const request = prepared(), pending = client.prepare(request)
  const sent = transport.requests[1]!.request
  assert.equal(AGENT_AUTH_HEADER, 'x-pe-execution-token')
  assert.equal(sent.headers[AGENT_AUTH_HEADER], TOKEN)
  assert.equal(Object.hasOwn(sent.headers, 'authorization'), false)
  assert.deepEqual(Object.keys(sent.headers).sort(), [AGENT_AUTH_HEADER, 'content-type', 'content-length', 'connection'].sort())
  const decoded = parseReply(sent.body)
  record(decoded, ['runtimeIdentity', 'operationId', 'specHash', 'authorization', 'spec'])
  record(decoded.spec, ['argv', 'cwd', 'stdin']); record(decoded.spec.stdin, ['mode', 'base64'])
  assert.equal(decoded.runtimeIdentity, RUNTIME); assert.equal(decoded.operationId, request.ref.operationId)
  assert.equal(decoded.specHash, digest(request.spec)); assert.equal(decoded.spec.stdin.base64, 'AP8=')
  transport.reply(1, operationFixture(request.ref)); await pending; await release(client)
})
test('lost mutation reply has one attempt, original reference survives and only poll/stop remain usable', async () => {
  const { client, transport } = await ready(), request = prepared(), p = client.prepare(request)
  transport.requests[1]!.events.error()
  await assert.rejects(p, (e: unknown) => e instanceof ControlUncertain && e.ref?.operationId === 'one' && e.ref.specHash === request.ref.specHash)
  assert.throws(() => client.prepare(request), LocalRefusal)
  assert.equal(transport.requests.length, 2); assert.equal(client.responsibility().remoteUnresolved.length, 1)
  const poll = client.poll(request.ref)
  transport.reply(2, operationFixture(request.ref, { submitted: true, commitAttempted: true })); await poll
  assert.equal(transport.requests[2]!.request.route, '/poll'); assert.equal(client.responsibility().remoteUnresolved.length, 1)
  await release(client)
})
test('each mutation verb is locally latched once; readonly queries can repeat', async () => {
  const { client, transport } = await ready(), request = prepared()
  const p = client.prepare(request); transport.reply(1, operationFixture()); await p
  assert.throws(() => client.prepare(request), LocalRefusal)
  for (const verb of ['commit', 'cancel', 'stop'] as const) {
    const pending = client[verb](request.ref), index = transport.requests.length - 1
    transport.reply(index, operationFixture(request.ref, { submitted: true, commitAttempted: true })); await pending
    assert.throws(() => client[verb](request.ref), LocalRefusal)
  }
  const seal = client.seal()
  transport.reply(transport.requests.length - 1, handshakeFixture(options(), {
    sealed: true, newOperationsAccepted: false, sealReason: 'owner-seal',
  })); await seal
  assert.throws(() => client.seal(), LocalRefusal)
  for (let i = 0; i < 2; i++) {
    const read = client.poll(request.ref); transport.reply(transport.requests.length - 1, operationFixture()); await read
  }
  await release(client)
})
test('full tail offset0 preserves binary bytes/loss and direct23 does not prove scope completion', async () => {
  const { client, transport } = await ready(), reference = prepared().ref
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)), observed = 7000
  const value = operationFixture(reference, {
    submitted: true, commitAttempted: true, direct: { waitStatus: 5888, returncode: 23 }, directNotObserved: false,
  })
  value.operation.streams.stdout = { requestedOffset: 0, startOffset: observed - bytes.length, endOffset: observed, observedBytes: observed,
    base64: bytes.toString('base64'), lossy: true, eof: false }
  const p = client.poll(reference); transport.reply(1, value); const snapshot = await p
  assert.deepEqual(Buffer.from(snapshot.streams.stdout.bytes), bytes); assert.equal(snapshot.streams.stdout.startOffset, 2904)
  assert.equal(snapshot.direct?.returncode, 23); assert.equal(snapshot.rangeEmpty, false); assert.equal(snapshot.ioClosed, false)
  assert.equal(client.responsibility().remoteUnresolved.length, 1)
  value.operation.rangeEmpty = value.operation.ioClosed = true
  value.operation.streams.stdout.eof = value.operation.streams.stderr.eof = true
  const second = client.poll(reference); transport.reply(2, value); await second
  assert.equal(client.responsibility().remoteUnresolved.length, 0); await release(client)
})
test('malformed tails/op binding/JSON/framing are uncertain and never corrected into outcomes', async () => {
  for (const change of [(v: ReturnType<typeof operationFixture>) => { v.operation.specHash = '0'.repeat(64) },
    (v: ReturnType<typeof operationFixture>) => { v.operation.streams.stdout.base64 = 'AB==' },
    (v: ReturnType<typeof operationFixture>) => { v.operation.directNotObserved = false },
    (v: ReturnType<typeof operationFixture>) => { v.operation.rangeEmpty = true }]) {
    const { client, transport } = await ready(), value = operationFixture(); change(value)
    const p = client.poll(prepared().ref); transport.reply(1, value); await assert.rejects(p, ControlUncertain); await release(client)
  }
  const { client, transport } = await ready(), p = client.poll(prepared().ref)
  transport.requests[1]!.events.headers(200, {
    'content-length': '1', 'content-type': 'application/json', connection: 'close', 'transfer-encoding': 'chunked',
  })
  await assert.rejects(p, ControlUncertain); await release(client)
})
test('unidentified404 is not absence proof; bound refusal never echoes arbitrary secret text', async () => {
  const { client, transport } = await ready(), p = client.poll(prepared().ref)
  transport.reply(1, { error: 'not_found' }, 404); await assert.rejects(p, ControlUncertain)
  const second = client.poll(prepared().ref)
  transport.reply(2, { protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, error: TOKEN }, 404)
  await assert.rejects(second, (e: unknown) => e instanceof RemoteRefusal && !String(e).includes(TOKEN) && e.code === 'remote_refusal' && !e.remoteStateProvenEmpty)
  assert.equal(client.responsibility().remoteUnresolved.length, 1); await release(client)
})
test('concurrency, lifetime byte allowances, references and serialized body budgets are finite', async () => {
  const { client, transport } = await ready(), pending: Promise<unknown>[] = []
  for (let i = 0; i < 4; i++) pending.push(client.poll(prepared(String(i)).ref))
  assert.throws(() => client.poll(prepared('0').ref), LocalRefusal)
  for (let i = 0; i < 4; i++) transport.reply(i + 1, operationFixture(prepared(String(i)).ref))
  await Promise.all(pending); assert.throws(() => client.poll(prepared('fifth').ref), LocalRefusal); await release(client)
  const other = await ready()
  for (let i = 1; i < CARRIER_LIMITS.attempts; i++) {
    const p = other.client.handshake(); other.transport.reply(i, handshakeFixture()); await p
  }
  assert.equal(other.client.responsibility().replyBodyAllowance, CARRIER_LIMITS.replyAllowanceTotal)
  assert.throws(() => other.client.handshake(), LocalRefusal); await release(other.client)
  const third = await ready(), huge = createForegroundIssuer(TOKEN, RUNTIME, () => {})(makePrepared(RUNTIME, 'huge', { argv: ['/bin/x', '\x01'.repeat(4000)], cwd: PROJECT, stdin: { mode: 'ignore' } }))
  assert.throws(() => third.client.prepare(huge), LocalRefusal)
  assert.equal(third.transport.requests.length, 1); await release(third.client)
})

async function renewalCarrier(mode?: CarrierBudgetMode) {
  const config = options(), transport = new FakeTransport()
  config.expected.pins.agentSourceSha256 = RENEWAL_AGENT_SOURCE_SHA256
  const client = new DataClient(config, transport, mode)
  const facts = handshakeFixture(config, { limits: { ...SLICE_LIMITS, ...RENEWAL_CHILD_LIMITS },
    recordSettlementVersion: 1, serviceWindowVersion: 1, residenceVersion: 1 })
  const reply = <T>(pending: Promise<T>, value: object): Promise<T> => {
    transport.reply(transport.requests.length - 1, value)
    return pending
  }
  await reply(client.handshake(), facts)
  const issue = createForegroundIssuer(TOKEN, RUNTIME, () => {})
  const request = (sequence: number, bytes = 4096) => {
    const made = makePrepared(RUNTIME, 'budget-' + sequence, { argv: ['/bin/wc', '-c'], cwd: PROJECT,
      stdin: { mode: 'batch', base64: Buffer.alloc(bytes).toString('base64') } })
    return issue({ ...made, ref: { ...made.ref, recordSequence: sequence } })
  }
  const operation = (prepared: PreparedRequest, changes: Record<string, unknown> = {}) =>
    operationFixture(prepared.ref, {
      ...(prepared.ref.recordSequence === undefined ? {} : { recordSequence: prepared.ref.recordSequence }), ...changes,
    })
  const active = (prepared: PreparedRequest) => operation(prepared, { submitted: true, commitAttempted: true })
  const start = async (prepared: PreparedRequest): Promise<void> => {
    await reply(client.prepare(prepared), operation(prepared))
    await reply(client.commit(prepared.ref), active(prepared))
  }
  const finish = async (prepared: PreparedRequest, stopped = false): Promise<void> => {
    const end = operation(prepared, { submitted: true, commitAttempted: true, direct: { waitStatus: 0, returncode: 0 },
      directNotObserved: false, rangeEmpty: true, ioClosed: true })
    end.operation.streams.stdout.eof = end.operation.streams.stderr.eof = true
    await reply(stopped ? client.stop(prepared.ref) : client.poll(prepared.ref), end)
  }
  const settle = async (prepared: PreparedRequest): Promise<void> => {
    const { operationId, specHash, recordSequence } = prepared.ref
    await reply(client.settle(prepared.ref), { protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME,
      settled: { operationId, specHash, recordSequence } })
  }
  const grant = async (prepared: PreparedRequest): Promise<void> => {
    const offer = { residentCapMs: 660_000, runCapMs: 185_000, remainingMs: 600_000 }
    const offeredAt = performance.now()
    const receipt = await reply(client.renewResidence(prepared.ref, offer, {}), {
      protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, residence: { leaseSequence: 1,
        operationId: prepared.ref.operationId, specHash: prepared.ref.specHash, registrationId: null,
        residentCapMs: offer.residentCapMs, runCapMs: offer.runCapMs,
        residentRemainingMs: offer.remainingMs, runRemainingMs: null },
    })
    assert.ok(receipt)
    receipt.publish(offeredAt + offer.remainingMs)
  }
  return { client, transport, reply, facts, request, start, finish, settle, grant, active }
}

test.each(['clean-terminal', 'unconfirmed-terminal', 'wrong-refusal'] as const)(
  'rolling residence grant uses the original authenticated refusal and next exact observation: %s', async (kind) => {
    const fixture = await renewalCarrier('rolling-v1'), { client, transport } = fixture
    const first = fixture.request(1, 32), offer = { residentCapMs: 660_000, runCapMs: 185_000, remainingMs: 400_000 }
    await fixture.start(first)
    const response = client.renewResidence(first.ref, offer, {}), index = transport.requests.length - 1
    const outcome = kind === 'clean-terminal' ? response : assert.rejects(response, ControlUncertain)
    transport.reply(index, { protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME,
      error: kind === 'wrong-refusal' ? 'residence_sequence' : 'residence_closed' }, 409)
    if (kind === 'wrong-refusal') {
      await outcome
      assert.equal(transport.requests.length, index + 1)
    } else {
      await vi.waitFor(() => assert.equal(transport.requests[index + 1]?.request.route, '/poll'))
      const proof = kind === 'clean-terminal'
        ? operationFixture(first.ref, { recordSequence: 1, submitted: true, commitAttempted: true,
            direct: { waitStatus: 0, returncode: 0 }, directNotObserved: false, rangeEmpty: true, ioClosed: true })
        : fixture.active(first)
      if (kind === 'clean-terminal') proof.operation.streams.stdout.eof = proof.operation.streams.stderr.eof = true
      transport.reply(index + 1, proof)
      assert.equal(await outcome, undefined)
    }
    if (kind === 'clean-terminal') {
      assert.equal(client.responsibility().fenced, false)
      await fixture.settle(first)
      const next = fixture.request(2, 32)
      await fixture.start(next)
      await fixture.grant(next)
      assert.equal(client.responsibility().fenced, false)
    } else {
      assert.equal(client.responsibility().fenced, true)
      assert.equal(client.responsibility().remoteUnresolved.length, 1)
    }
    await release(client)
  },
)

test('only the selected carrier crosses the old attempts and reply totals after the rolling interval', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const legacy = await renewalCarrier(), rolling = await renewalCarrier('rolling-v1')
    const first = rolling.request(1, 32), old = legacy.request(1, 32)
    for (const [fixture, operation] of [[legacy, old], [rolling, first]] as const) {
      await fixture.start(operation)
      await fixture.grant(operation)
      await fixture.finish(operation)
      await fixture.settle(operation)
    }
    now = 1
    const ordinaryCap = CARRIER_LIMITS.attempts - RESIDENCE_LIMITS.terminalAttempts
    for (let i = rolling.client.responsibility().attempts; i < ordinaryCap; i++) {
      await rolling.reply(rolling.client.handshake(), rolling.facts)
      await legacy.reply(legacy.client.handshake(), legacy.facts)
    }
    now = CARRIER_LIMITS.localLifetimeMs - 1
    for (const fixture of [legacy, rolling]) {
      assert.throws(() => fixture.client.handshake(), { code: 'residence_terminal_budget' })
      assert.equal(fixture.transport.requests.length, ordinaryCap)
    }
    now = CARRIER_LIMITS.localLifetimeMs
    assert.equal(rolling.client.responsibility().carrierWindow?.attempts, ordinaryCap - 6)
    await rolling.reply(rolling.client.handshake(), rolling.facts)
    assert.equal(rolling.client.responsibility().carrierWindow?.attempts, ordinaryCap - 5)
    assert.throws(() => legacy.client.handshake(), { code: 'residence_terminal_budget' })
    assert.equal(legacy.client.responsibility().carrierWindow, undefined)
    now++
    for (let i = 0; i < 25; i++) await rolling.reply(rolling.client.handshake(), rolling.facts)
    const totals = rolling.client.responsibility()
    assert.ok(totals.attempts > CARRIER_LIMITS.attempts && totals.replyBodyAllowance > CARRIER_LIMITS.replyAllowanceTotal)
    assert.equal(totals.carrierWindow?.attempts, 26)
    assert.throws(() => rolling.client.prepare(first), { code: 'local_operation_sequence' })
    await release(legacy.client)
    await release(rolling.client)
  } finally { clock.mockRestore() }
})

test('rolling foreground traffic leaves progress and stop capacity for the same admitted service', async () => {
  let now = 1
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const f = await renewalCarrier('rolling-v1'), { client, transport, reply } = f
    const service = createRegisteredServiceIssuer(TOKEN, RUNTIME, 'trial-preview', id => id)(
      makePrepared(RUNTIME, 'preview-service', { argv: ['/bin/sleep', '1'], cwd: PROJECT, stdin: { mode: 'ignore' } }))
    assert.equal(client.responsibility().carrierServiceReserve, undefined)
    await f.start(service)
    const reserved = client.responsibility().carrierServiceReserve
    assert.ok(reserved && reserved.attempts > 150)
    let admitted = 0
    for (let i = 1; i <= 80; i++) {
      const operation = f.request(i)
      const before = transport.requests.length
      try { await f.start(operation) } catch (cause) {
        assert.ok(cause instanceof CarrierPrepareCapacityError)
        assert.equal(transport.requests.length, before)
        break
      }
      await f.finish(operation); await f.settle(operation)
      admitted++
    }
    assert.ok(admitted > 20 && admitted < 70)
    assert.equal(client.responsibility().remoteUnresolved[0]?.operationId, 'preview-service')
    assert.equal(client.responsibility().remoteUnresolved.length, 1)
    assert.equal(client.responsibility().fenced, false)
    for (let i = 0; i < 150; i++) {
      now = 1 + i * RESIDENCE_LIMITS.minPollMs
      await reply(client.poll(service.ref), f.active(service))
    }
    const facts = client.responsibility()
    assert.equal(facts.carrierServiceReserve?.attempts, reserved.attempts - 150)
    assert.ok(facts.carrierWindow!.sentBodyBytes <= CARRIER_LIMITS.sentBodyTotal
      - RESIDENCE_LIMITS.terminalAttempts * RESIDENCE_LIMITS.fixedControlBytes)
    await f.finish(service, true)
    assert.equal(client.responsibility().carrierServiceReserve, undefined)
    assert.equal(client.responsibility().remoteUnresolved.length, 0)
    await release(client)
  } finally { clock.mockRestore() }
})

test('settled commands cross the old sent body total with every rolling window charged individually', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const fixture = await renewalCarrier('rolling-v1')
    const { client, request, start, finish, settle, grant } = fixture
    const first = request(1)
    await start(first); await grant(first); await finish(first); await settle(first)
    for (let seq = 2; seq <= 64; seq++) {
      if (seq === 33) now = CARRIER_LIMITS.localLifetimeMs
      const operation = request(seq)
      await start(operation); await finish(operation); await settle(operation)
      const facts = client.responsibility()
      assert.ok(facts.carrierWindow && facts.carrierWindow.sentBodyBytes < CARRIER_LIMITS.sentBodyTotal)
      assert.equal(facts.remoteUnresolved.length, 0)
    }
    assert.ok(client.responsibility().sentBodyBytes > CARRIER_LIMITS.sentBodyTotal)
    assert.throws(() => client.prepare(first), { code: 'local_operation_sequence' })
    await release(client)
  } finally { clock.mockRestore() }
})

test('an unresolved operation retains its charges after the carrier rolls and can spend stop reserve', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const { client, transport, reply, facts, request, start, finish, settle, grant, active } = await renewalCarrier('rolling-v1')
    const work = request(1, 32)
    await start(work); await grant(work)
    const ordinaryCap = CARRIER_LIMITS.attempts - RESIDENCE_LIMITS.terminalAttempts
    for (let i = 4; i < ordinaryCap; i++) await reply(client.poll(work.ref), active(work))
    now = CARRIER_LIMITS.localLifetimeMs
    assert.equal(client.responsibility().carrierWindow?.attempts, 0)
    assert.equal(client.responsibility().remoteUnresolved.length, 1)
    await reply(client.poll(work.ref), active(work))
    const before = transport.requests.length
    assert.throws(() => client.poll(work.ref), { code: 'residence_terminal_budget' })
    assert.equal(transport.requests.length, before)
    await reply(client.handshake(), facts)
    await finish(work, true)
    assert.equal(client.responsibility().remoteUnresolved.length, 0)
    await release(client)
    assert.equal(client.responsibility().localSettled, true)
    await assert.rejects(settle(work))
  } finally { clock.mockRestore() }
})

test('rolling admission retains the original concurrent requests and rejects the legacy guest', async () => {
  assert.throws(() => new DataClient(options(), new FakeTransport(), 'rolling-v1'), { code: 'rolling_carrier_guest' })
  const { client, transport, facts } = await renewalCarrier('rolling-v1')
  const pending = Array.from({ length: CARRIER_LIMITS.concurrent }, () => client.handshake())
  assert.throws(() => client.handshake(), { code: 'carrier_budget' })
  for (let i = 0; i < pending.length; i++) transport.reply(i + 1, facts)
  await Promise.all(pending)
  await release(client)
})

test('a rolling carrier cannot outlive its original deadline without a confirmed residence grant', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const { client, transport } = await renewalCarrier('rolling-v1')
    now = CARRIER_LIMITS.localLifetimeMs
    assert.equal(client.responsibility().carrierWindow?.attempts, 0)
    assert.throws(() => client.handshake(), { code: 'local_deadline_or_cancel' })
    assert.equal(transport.requests.length, 1)
    await release(client)
  } finally { clock.mockRestore() }
})

test('deadline/public cancel retains actual request until terminal callback and release never clears remote range', async () => {
  const { client, transport } = await ready(), reference = prepared().ref
  transport.autoAbort = false; transport.closeGate = deferred(); transport.destroyGate = deferred()
  const pending = client.poll(reference, { deadlineMs: performance.now() + 5 })
  await assert.rejects(pending, ControlUncertain); assert.equal(client.responsibility().inFlight, 1)
  const releasing = client.release({ deadlineMs: performance.now() + 5 })
  assert.throws(() => client.prepare(prepared()), LocalRefusal)
  const report = await releasing
  assert.equal(report.localSettled, false); assert.equal(report.inFlight, 1); assert.equal(report.remoteUnresolved.length, 1)
  assert.equal(report.dispatcherClosed, false)
  transport.requests[1]!.events.error(); transport.closeGate.resolve(); transport.destroyGate.resolve()
  await client.whenLocallySettled(); assert.equal(client.responsibility().remoteUnresolved.length, 1)
  assert.equal(transport.closeCalls, 1); assert.equal(transport.destroyCalls, 1)
})
test('Root physical stop acknowledgement is independent of remote emptiness and local release joining', async () => {
  const { client, transport } = await ready(), reference = prepared().ref
  transport.autoAbort = false
  const controller = new AbortController(), pending = client.poll(reference, { signal: controller.signal })
  controller.abort(); await assert.rejects(pending, ControlUncertain)
  assert.equal(client.responsibility().inFlight, 1)
  assert.throws(() => { client.notePhysicalStop({ physicalSandboxId: 'other', runtimeIdentity: RUNTIME, stopAckId: 'ack', processesGone: true }) }, LocalRefusal)
  // Trusted Root backend stop/delete does not wait for the remote agent or this client's release.
  client.notePhysicalStop({ physicalSandboxId: 'private-sandbox-fixture', runtimeIdentity: RUNTIME, stopAckId: 'backend_ack', processesGone: true })
  assert.equal(client.responsibility().remoteUnresolved.length, 0); assert.equal(client.responsibility().inFlight, 1)
  transport.requests[1]!.events.error(); assert.equal(client.responsibility().remoteUnresolved.length, 0)
  await release(client)
})
test('close rejection triggers owned destroy; errors remain sanitized and no global resource is touched', async () => {
  const { client, transport } = await ready(); transport.rejectClose = true
  const report = await release(client)
  assert.equal(report.localSettled, true); assert.equal(report.dispatcherClosed, true); assert.equal(report.cleanupFailure, true)
  assert.equal(transport.destroyCalls, 1); assert.equal(JSON.stringify(report).includes(TOKEN), false)
})
test('late successful mutation response cannot erase uncertainty or beat an expired absolute deadline', async () => {
  const { client, transport } = await ready(), request = prepared(); transport.autoAbort = false
  const pending = client.prepare(request, { deadlineMs: performance.now() + 5 })
  await assert.rejects(pending, ControlUncertain)
  const done = operationFixture(request.ref, { rangeEmpty: true, ioClosed: true, commitClosed: true })
  done.operation.streams.stdout.eof = done.operation.streams.stderr.eof = true
  transport.reply(1, done)
  assert.equal(client.responsibility().inFlight, 0); assert.equal(client.responsibility().remoteUnresolved.length, 1)
  const read = client.poll(request.ref); transport.reply(2, done); await read
  assert.equal(client.responsibility().remoteUnresolved.length, 0); await release(client)
  const other = await ready(), p = other.client.poll(request.ref, { deadlineMs: performance.now() + 2 })
  const until = performance.now() + 4; while (performance.now() < until) { /* simulate delayed timer callback, no external resource */ }
  other.transport.reply(1, operationFixture())
  await assert.rejects(p, ControlUncertain); await release(other.client)
})
test('fence gates synchronously and joins actual admitted requests while leaving control transport available', async () => {
  const { client, transport } = await ready(), pending = client.poll(prepared().ref)
  let joined = false
  const barrier = client.fence().then(() => { joined = true })
  assert.throws(() => client.prepare(prepared()), LocalRefusal)
  await Promise.resolve(); assert.equal(joined, false); assert.equal(transport.closeCalls, 0)
  transport.reply(1, operationFixture()); await pending; await barrier
  assert.equal(joined, true)
  const read = client.poll(prepared().ref); transport.reply(2, operationFixture()); await read
  await release(client)
})
test('oversized reply is aborted without buffering beyond its lifetime allowance', async () => {
  const { client, transport } = await ready(), before = client.responsibility().bufferedReplyBytes
  const pending = client.poll(prepared().ref), row = transport.requests[1]!
  row.events.headers(200, { 'content-length': '16384', 'content-type': 'application/json', connection: 'close' })
  row.events.data(Buffer.alloc(16385)); await assert.rejects(pending, ControlUncertain)
  assert.equal(row.aborted, true); assert.equal(client.responsibility().bufferedReplyBytes, before)
  assert.ok(client.responsibility().bufferedReplyBytes <= client.responsibility().replyBodyAllowance)
  await release(client)
})
test('pure preallocation budget includes the whole encoded guardian frame at four uint64 maxima', () => {
  const pins = JSON.parse(readFileSync(new URL('./fixtures/agent-data/install-profile-source-pins.json', import.meta.url), 'utf8')) as {
    protocol: string
    agentSourceSha256: string
  }
  assert.equal(PROTOCOL, pins.protocol)
  assert.equal(AGENT_SOURCE_SHA256, pins.agentSourceSha256)
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/agent-data/guardian-budget-vectors.json', import.meta.url), 'utf8')) as {
    vectors: { project: string; spec: OperationSpec; maximumEncodedBytes: number; pythonMaximumFrame: string }[]
  }
  for (const vector of vectors.vectors) {
    assert.equal(guardianEncodedBudget(vector.project, vector.spec), vector.maximumEncodedBytes)
    assert.equal(Buffer.byteLength(vector.pythonMaximumFrame, 'ascii'), vector.maximumEncodedBytes)
  }
  const base = { argv: ['/bin/echo', ''], cwd: PROJECT, stdin: { mode: 'ignore' as const } }
  const overhead = guardianEncodedBudget(PROJECT, base)
  const exactArg = 'a'.repeat(4096 - overhead)
  const exact = { ...base, argv: ['/bin/echo', exactArg] }
  assert.equal(guardianEncodedBudget(PROJECT, exact), 4096)
  assert.throws(() => guardianEncodedBudget(PROJECT, { ...exact, argv: ['/bin/echo', exactArg + 'a'] }), LocalRefusal)
  assert.throws(() => guardianEncodedBudget(PROJECT, { ...base, argv: ['/bin/echo', '\x01'.repeat(800)] }), LocalRefusal)
  const batch = { ...base, stdin: { mode: 'batch' as const, base64: Buffer.alloc(4096).toString('base64') } }
  assert.equal(guardianEncodedBudget(PROJECT, batch), overhead - 1) // "batch" is one encoded byte shorter than "ignore".
  const malformedSpec: unknown = { ...base, stdin: { mode: 'pipe' } }
  // Exercise the untrusted operation boundary with a deliberately invalid stdin mode.
  assert.throws(() => guardianEncodedBudget(PROJECT, malformedSpec as OperationSpec), LocalRefusal)
})
