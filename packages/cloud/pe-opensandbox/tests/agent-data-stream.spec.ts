/** Real Node pipe semantics and original client ownership over an explicitly fake WS byte transport. */
import { setImmediate } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { guardianEncodedBudget } from '../src/agent-data/encoded-budget.ts'
import { expect, it, onTestFinished } from 'vitest'
import { asciiJSON, digest, makePrepared, spec } from '../src/agent-data/canonical.ts'
import { createProgramIssuer } from '../src/agent-data/root-role-issuer.ts'
import { STREAM_LIMITS } from '../src/agent-data/role-protocol.ts'
import { ControlUncertain, LocalRefusal } from '../src/agent-data/errors.ts'
import { decodeStreamFrame, encodeStreamFrame, ExecutionStream, type StreamFrame } from '../src/agent-data/stream.ts'
import { DataClient } from '../src/agent-data/client-internal.ts'
import { AGENT_SOURCE_SHA256, BWRAP_SHA256, PROTOCOL, SLICE_LIMITS } from '../src/agent-data/constants.ts'
import { expectedWorldHash, handshake, operation } from '../src/agent-data/validate.ts'
import type { ClientOptions, PipesOperationSpec } from '../src/agent-data/types.ts'
import type { OwnedTransport, OwnedWireStream, WireEvents, WireRequest, WireStreamEvents, WireStreamRequest } from '../src/agent-data/transport.ts'

const TOKEN = '1'.repeat(64), RUNTIME = '2'.repeat(64), PROJECT = '/srv/project'
function pipes(changes: Partial<PipesOperationSpec> = {}): PipesOperationSpec {
  return { executionKind: 'pipes', argv: ['/trusted/node/bin/node', '/trusted/program.js'], cwd: PROJECT,
    stdin: { mode: 'pipe' }, env: { LANG: null, NODE_OPTIONS: '--max-old-space-size=64' },
    stream: { version: 'pe-execution-stream-v1', stdout: 'pipe', stderr: 'pipe', control: 'pipe',
      limits: { controlInputBytes: 8388608, controlOutputBytes: 8388608 } }, ...changes }
}
function reference(input = pipes()) {
  return createProgramIssuer(TOKEN, RUNTIME, () => {})(makePrepared(RUNTIME, 'program', input))
}
function config(): ClientOptions {
  return { host: '127.0.0.1', port: 23000, token: TOKEN, expected: {
    physicalSandboxId: 'original-test-sandbox', runtimeIdentity: RUNTIME, projectRoot: PROJECT,
    declaredImageId: 'sha256:' + '3'.repeat(64),
    roots: { project: { device: '1', inode: '2', maximumBytes: '8388608', maximumInodes: '128' },
      environment: { device: '2', inode: '3', maximumBytes: '8388608', maximumInodes: '128' } },
    pins: { bwrapSha256: BWRAP_SHA256, agentSourceSha256: AGENT_SOURCE_SHA256, userWorldArgvSha256: expectedWorldHash(PROJECT) } } }
}
function hello(streaming = true) {
  const e = config().expected
  const mount = (r: ClientOptions['expected']['roots']['project']) => ({ device: r.device, inode: r.inode, uid: 2000, gid: 2000,
    capacityBytes: r.maximumBytes, capacityInodes: r.maximumInodes,
    grant: { maximumBytes: r.maximumBytes, maximumInodes: r.maximumInodes } })
  return { protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, capabilities: ['argv', 'stdin-ignore', 'stdin-batch', 'collect',
    ...streaming ? ['stdin-pipe', 'pipes', 'control-pipe'] : []],
  pins: e.pins, declaredImageId: e.declaredImageId,
  mounts: { [PROJECT]: mount(e.roots.project), '/opt/session-env': mount(e.roots.environment) }, limits: SLICE_LIMITS,
  newOperationsAccepted: true, recordCount: 0, activeRangeCount: 0,
  rangeRoles: { foreground: 0, service: 0, ...streaming ? { program: 0 } : {} }, sealed: false,
  sealReason: null, physicalStopRequired: false, ...streaming ? { streamLimits: STREAM_LIMITS } : {} }
}
function facts(ref = reference().ref) {
  const tail = () => ({ requestedOffset: 0, startOffset: 0, endOffset: 0, observedBytes: 0, base64: '', lossy: false, eof: false })
  return { operationId: ref.operationId, specHash: ref.specHash, role: ref.authorization.role, registrationId: null,
    primitiveStarted: true, prepared: true, commitAttempted: false, commitClosed: false, submitted: false, firstCause: null,
    direct: null, directNotObserved: true, rangeEmpty: false, ioClosed: false, physicalStopRequired: false,
    failure: null, cleanupFailure: null, providerFailure: false, streams: { stdout: tail(), stderr: tail() },
    executionKind: 'pipes', stream: { attached: false, connected: false, ioClosed: false, controlInputBytes: 0, controlOutputBytes: 0 } }
}
const data = (channel: StreamFrame['channel'], sequence: number, bytes = Buffer.from([0, 255, 65])) =>
  encodeStreamFrame({ kind: 1, channel, sequence, payload: bytes })
const eof = (channel: StreamFrame['channel'], sequence: number) =>
  encodeStreamFrame({ kind: 2, channel, sequence, payload: new Uint8Array() })
const credit = (channel: StreamFrame['channel'], sequence: number, bytes: number) => {
  const payload = Buffer.alloc(4); payload.writeUInt32BE(bytes)
  return encodeStreamFrame({ kind: 3, channel, sequence, payload })
}
class ByteWire implements OwnedWireStream {
  readonly frames: StreamFrame[] = []
  closes = 0
  send(bytes: Uint8Array): Promise<void> { this.frames.push(decodeStreamFrame(bytes)); return Promise.resolve() }
  close(): void { this.closes++ }
}
function mux(input = pipes()) {
  let failures = 0
  const stream = new ExecutionStream(reference(input).ref, input, () => { failures++ }), wire = new ByteWire()
  stream.bind(wire); stream.events.open(); stream.noteSubmitted()
  onTestFinished(() => { stream.fail(); stream.events.closed() })
  return { stream, wire, failures: () => failures }
}

it('keeps collect canonical bytes unchanged and signs every pipes/environment/control-budget field', () => {
  const collect = { argv: ['/bin/true'], cwd: PROJECT, stdin: { mode: 'ignore' } }
  expect(asciiJSON(spec(collect))).toBe(asciiJSON(collect))
  const request = reference(), changed = reference(pipes({ env: { LANG: null, NODE_OPTIONS: '--max-old-space-size=32' } }))
  expect(request.ref.authorization).toMatchObject({ role: 'program', registrationId: null })
  expect(request.ref.specHash).not.toBe(changed.ref.specHash)
  expect(request.ref.authorization.signature).not.toBe(changed.ref.authorization.signature)
  expect(digest(request.spec)).toBe(request.ref.specHash)
})
it('matches actual guest pure canonical/hash/role and complete guardian-frame byte calculations', () => {
  const request = reference(), directory = fileURLToPath(new URL('../runtime/agent/', import.meta.url))
  const program = `import sys,json
sys.path.insert(0,sys.argv[1])
from wire import canonical,prepared_digest,verify_role,dumps
from paths import ENV,ENV_ROOT
body=json.load(sys.stdin)
norm,_,_=canonical(body['spec'])
verify_role(body,'${TOKEN}')
env=dict(ENV)
for key,value in norm['env'].items():
 if value is None: env.pop(key,None)
 else: env[key]=value
root=(18446744073709551615,18446744073709551615)
frame={'argv':norm['argv'],'env':env,'roots':{norm['cwd']:root,ENV_ROOT:root},'projectRoot':norm['cwd'],'cwd':norm['cwd'],'stdinMode':norm['stdin']['mode'],'executionKind':'pipes','stream':norm['stream']}
print(json.dumps({'canonical':dumps(norm).decode('ascii'),'digest':prepared_digest(norm),'guardianBytes':len(json.dumps(frame,separators=(',',':')).encode())}))`
  const stdout = execFileSync('python3', ['-B', '-c', program, directory], {
    input: asciiJSON({ ...request.ref, spec: request.spec }), encoding: 'utf8', maxBuffer: 65536, timeout: 3000,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(JSON.parse(stdout)).toEqual({ canonical: asciiJSON(request.spec), digest: request.ref.specHash,
    guardianBytes: guardianEncodedBudget(PROJECT, request.spec) })
  expect(() => guardianEncodedBudget(PROJECT, pipes({ env: { FILL: 'x'.repeat(3550) } }))).toThrow(LocalRefusal)
})
it('rejects guardian-owned marker, oversized environment and unsigned extra pipes fields', () => {
  expect(() => spec(pipes({ env: { DSH_SUBPROCESS_CONTROL: 'pipe' } }))).toThrow(LocalRefusal)
  expect(() => spec(pipes({ env: { HUGE: 'x'.repeat(4096) } }))).toThrow(LocalRefusal)
  expect(() => spec({ ...pipes(), unknown: true })).toThrow(LocalRefusal)
  expect(() => spec(pipes({ stream: { ...pipes().stream, limits: { controlInputBytes: 8388609, controlOutputBytes: 1 } } })))
    .toThrow(LocalRefusal)
})
it('admits only complete old collect or exact new streaming handshake shapes', () => {
  expect(handshake(hello(false), config().expected).streamLimits).toBeUndefined()
  expect(handshake(hello(), config().expected).streamLimits).toEqual(STREAM_LIMITS)
  expect(() => handshake({ ...hello(), streamLimits: undefined }, config().expected)).toThrow(LocalRefusal)
  expect(() => handshake({ ...hello(), rangeRoles: { foreground: 0, service: 0 } }, config().expected)).toThrow(LocalRefusal)
  expect(() => handshake({ ...hello(), recordCount: 2, activeRangeCount: 2,
    rangeRoles: { foreground: 0, service: 1, program: 1 } }, config().expected)).toThrow(LocalRefusal)
})
it('accepts pipes empty raw tails as coordinates only and keeps kernel/range facts separate from stream drain', () => {
  const payload = facts()
  payload.streams.stdout = { ...payload.streams.stdout, observedBytes: 13, startOffset: 13, endOffset: 13, lossy: true }
  payload.rangeEmpty = true; payload.streams.stdout.eof = true; payload.streams.stderr.eof = true
  expect(operation(payload, reference().ref)).toMatchObject({ rangeEmpty: true, ioClosed: false,
    streams: { stdout: { bytes: Buffer.alloc(0), observedBytes: 13 } } })
})
it('rejects padding, incorrect length and oversized binary messages before entering the pipes', () => {
  const valid = data(4, 0)
  for (const mutate of [(b: Uint8Array) => { b[6] = 1 }, (b: Uint8Array) => { b[3] = 1 }, (b: Uint8Array) => { b[5] = 0 }]) {
    const bytes = Uint8Array.from(valid); mutate(bytes); expect(() => decodeStreamFrame(bytes)).toThrow(LocalRefusal)
  }
  expect(() => decodeStreamFrame(new Uint8Array(4109))).toThrow(LocalRefusal)
})
it('splits a large Native write and waits for real delivery credit under the independent 64KiB window', async () => {
  const f = mux(), bytes = Buffer.alloc(131072, 0xab)
  let completed = false
  f.stream.control?.write(bytes, () => { completed = true })
  await setImmediate()
  expect(f.wire.frames.filter(frame => frame.kind === 1)).toHaveLength(16)
  expect(completed).toBe(false)
  f.stream.events.data(credit(4, 0, 65536)); await setImmediate()
  expect(f.wire.frames.filter(frame => frame.kind === 1)).toHaveLength(32)
  expect(completed).toBe(false)
  f.stream.events.data(credit(4, 1, 65536)); await setImmediate()
  expect(completed).toBe(true)
  expect(Buffer.concat(f.wire.frames.map(frame => Buffer.from(frame.payload)))).toEqual(bytes)
})
it('slow unread stdout does not consume the fd7 credit lane', async () => {
  const f = mux()
  for (let i = 0; i < 16; i++) f.stream.events.data(data(2, i, Buffer.alloc(4096, i)))
  f.stream.events.data(data(4, 0)); await setImmediate()
  expect(f.wire.frames).toHaveLength(0)
  expect(f.stream.control?.read()).toEqual(Buffer.from([0, 255, 65])); await setImmediate()
  expect(f.wire.frames).toMatchObject([{ kind: 3, channel: 4 }])
  expect(f.stream.stdout?.readableLength).toBe(65536)
})
it('lets fd7 cumulative output cross the 64KiB window while preserving stdout lifetime limits', async () => {
  const f = mux()
  for (let i = 0; i < 32; i++) {
    f.stream.events.data(data(4, i, Buffer.alloc(4096, i)))
    const bytes: unknown = f.stream.control?.read()
    expect(bytes).toHaveLength(4096)
    await setImmediate()
  }
  expect(f.failures()).toBe(0)
  for (let i = 0; i < 17; i++) {
    f.stream.events.data(data(2, i, Buffer.alloc(4096)))
    f.stream.stdout?.read(); await setImmediate()
  }
  expect(f.failures()).toBe(1)
})
it('resolves decoded EOF before consumer drain and preserves buffered bytes after a normal actual close', async () => {
  const f = mux()
  for (const channel of [2, 3, 4] as const) { f.stream.events.data(data(channel, 0)); f.stream.events.data(eof(channel, 1)) }
  await f.stream.outputEnded
  f.stream.close(); await setImmediate()
  let settled = false; void f.stream.settled.then(() => { settled = true })
  expect(settled).toBe(false)
  f.stream.events.closed(); await f.stream.settled
  expect(f.failures()).toBe(0)
  expect(f.stream.stdout?.read()).toEqual(Buffer.from([0, 255, 65]))
  expect(f.stream.stderr?.read()).toEqual(Buffer.from([0, 255, 65]))
  expect(f.stream.control?.read()).toEqual(Buffer.from([0, 255, 65]))
})
it('half-closes control input without closing its output or whole connection', async () => {
  const input = pipes({ stdin: { mode: 'ignore' }, stream: { ...pipes().stream, stdout: 'ignore', stderr: 'ignore' } })
  const f = mux(input)
  f.stream.control?.end(); await setImmediate()
  expect(f.wire.frames).toMatchObject([{ kind: 2, channel: 4 }]); expect(f.wire.closes).toBe(0)
  f.stream.events.data(data(4, 0)); expect(f.stream.control?.read()).toEqual(Buffer.from([0, 255, 65]))
  f.stream.events.data(eof(4, 1)); await f.stream.outputEnded
})
it.each(['credit', 'sequence', 'window', 'after-eof'] as const)('retains actual closure after invalid %s', async (bad) => {
  const f = mux()
  if (bad === 'credit') f.stream.events.data(credit(4, 0, 1))
  if (bad === 'sequence') f.stream.events.data(data(4, 1))
  if (bad === 'window') for (let i = 0; i < 17; i++) f.stream.events.data(data(2, i, Buffer.alloc(4096)))
  if (bad === 'after-eof') { f.stream.events.data(eof(4, 0)); f.stream.events.data(data(4, 1)) }
  await expect(f.stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
  expect(f.failures()).toBe(1)
  let settled = false; void f.stream.settled.then(() => { settled = true }); await setImmediate()
  expect(settled).toBe(false)
  f.stream.events.closed(); await f.stream.settled
})
it('rejects pending Native write receipt on disconnect without replay or pretending closure has joined', async () => {
  const f = mux(), result = Promise.withResolvers<Error | null | undefined>()
  f.stream.control?.write(Buffer.from('pending'), result.resolve)
  f.stream.events.error()
  expect(await result.promise).toBeInstanceOf(LocalRefusal)
  await expect(f.stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
  expect(f.wire.frames.filter(frame => frame.kind === 1)).toHaveLength(1)
  f.stream.events.closed(); await f.stream.settled
})
it('applies stdin and signed fd7 cumulative limits at original write admission', async () => {
  const f = mux(pipes({ stream: { ...pipes().stream, limits: { controlInputBytes: 10, controlOutputBytes: 10 } } }))
  expect(f.stream.control?.write(Buffer.alloc(11), () => {})).toBe(false)
  await expect(f.stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
  const g = mux(); expect(g.stream.stdin?.write(Buffer.alloc(4097), () => {})).toBe(false)
  await expect(g.stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
})

class Transport implements OwnedTransport {
  readonly wire = new ByteWire()
  readonly requests: { request: WireRequest; events: WireEvents }[] = []
  upgrade?: { request: WireStreamRequest; events: WireStreamEvents }
  dispatch(request: WireRequest, events: WireEvents): void {
    this.requests.push({ request, events }); events.start(() => { events.error() })
  }
  attach(request: WireStreamRequest, events: WireStreamEvents): OwnedWireStream { this.upgrade = { request, events }; return this.wire }
  async close(): Promise<void> { this.upgrade?.events.closed() }
  async destroy(): Promise<void> { this.upgrade?.events.closed() }
  reply(value: unknown): void {
    const row = this.requests.at(-1)
    if (row === undefined) throw new Error('Missing request')
    const bytes = Buffer.from(asciiJSON(value))
    row.events.headers(200, { 'content-type': 'application/json', 'content-length': String(bytes.length), connection: 'close' })
    row.events.data(bytes); row.events.end({})
  }
}
it('requires actual attach before commit, authenticates headers, never retries and joins the original transport', async () => {
  const transport = new Transport(), client = new DataClient(config(), transport), prepared = reference()
  onTestFinished(async () => { await client.release() })
  const h = client.handshake(); transport.reply(hello()); await h
  const p = client.prepare(prepared); transport.reply({ protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, operation: facts() }); await p
  expect(() => client.commit(prepared.ref)).toThrow(LocalRefusal)
  const attached = client.attach(prepared.ref), upgrade = transport.upgrade
  expect(upgrade?.request.headers).toMatchObject({ 'x-pe-execution-token': TOKEN, 'x-pe-operation-id': 'program',
    'x-pe-range-role': 'program', 'x-pe-registration-id': '-', 'x-pe-role-signature': prepared.ref.authorization.signature })
  upgrade?.events.open(); const stream = await attached
  stream.control?.write(Buffer.from('boot'), () => {})
  await setImmediate(); expect(transport.wire.frames).toHaveLength(0)
  const committed = client.commit(prepared.ref)
  transport.reply({ protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, operation: { ...facts(), submitted: true,
    commitAttempted: true, stream: { ...facts().stream, attached: true, connected: true } } }); await committed
  await setImmediate(); expect(transport.wire.frames).toMatchObject([{ kind: 1, channel: 4 }])
  upgrade?.events.error()
  await expect(stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
  expect(() => client.attach(prepared.ref)).toThrow(LocalRefusal)
  expect(client.responsibility().remoteUnresolved).toEqual([prepared.ref])
  expect(client.responsibility().inFlight).toBe(1)
  upgrade?.events.closed(); await stream.settled
  await client.release(); await client.whenLocallySettled()
  expect(client.responsibility().localSettled).toBe(true)
})

it('does not send a pipes prepare or attempt attach after a collect-only handshake', async () => {
  const transport = new Transport(), client = new DataClient(config(), transport)
  onTestFinished(async () => { await client.release() })
  const h = client.handshake(); transport.reply(hello(false)); await h
  expect(() => client.prepare(reference())).toThrow(LocalRefusal)
  expect(() => client.attach(reference().ref)).toThrow(LocalRefusal)
  expect(transport.requests).toHaveLength(1)
  expect(transport.upgrade).toBeUndefined()
})

it('retains a failed upgrade actual join even though attach never returned its stream', async () => {
  const transport = new Transport(), client = new DataClient(config(), transport), prepared = reference()
  onTestFinished(async () => { await client.release() })
  const h = client.handshake(); transport.reply(hello()); await h
  const p = client.prepare(prepared); transport.reply({ protocolVersion: PROTOCOL, runtimeIdentity: RUNTIME, operation: facts() }); await p
  const attached = client.attach(prepared.ref)
  transport.upgrade?.events.error()
  await expect(attached).rejects.toBeInstanceOf(ControlUncertain)
  await client.fence()
  let joined = false
  const join = client.joinStream(prepared.ref).then(() => { joined = true })
  await setImmediate(); expect(joined).toBe(false)
  transport.upgrade?.events.closed(); await join
  expect(joined).toBe(true)
})

it('reserves end(chunk) input before Node can bypass the public write method', async () => {
  const f = mux(), g = mux(pipes({ stream: { ...pipes().stream,
    limits: { controlInputBytes: 3, controlOutputBytes: 3 } } }))
  f.stream.stdin?.end(Buffer.alloc(4097), () => {})
  await expect(f.stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
  expect(f.wire.frames).toHaveLength(0)
  g.stream.control?.end(Buffer.alloc(4), () => {})
  await expect(g.stream.outputEnded).rejects.toBeInstanceOf(ControlUncertain)
  expect(g.wire.frames).toHaveLength(0)
})
it('does not double-reserve an exact-budget end(chunk) and preserves data-before-EOF order', async () => {
  const f = mux(pipes({ stream: { ...pipes().stream, limits: { controlInputBytes: 3, controlOutputBytes: 3 } } }))
  f.stream.control?.end(Buffer.from('abc'))
  await setImmediate()
  expect(f.wire.frames).toMatchObject([{ kind: 1, channel: 4 }])
  f.stream.events.data(credit(4, 0, 3)); await setImmediate()
  expect(f.wire.frames).toMatchObject([{ kind: 1, channel: 4 }, { kind: 2, channel: 4 }])
})
