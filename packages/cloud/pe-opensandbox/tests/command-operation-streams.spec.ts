/** One real command operation and Node mux; only remote process snapshots and WS delivery are scripted. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ManagedCommandOperation, type CommandChannel, type CommandSnapshot } from '../src/command-operation.ts'
import { makePrepared } from '../src/agent-data/canonical.ts'
import { createProgramIssuer } from '../src/agent-data/root-role-issuer.ts'
import { decodeStreamFrame, encodeStreamFrame, ExecutionStream, type StreamFrame } from '../src/agent-data/stream.ts'
import { CommandStreams } from '../src/command-streams.ts'
import { STREAM_LIMITS } from '../src/agent-data/role-protocol.ts'

const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 32,
  maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 5000, stopWaitMs: 1000 }
const pipes = { env: { LANG: null, NODE_OPTIONS: '--max-old-space-size=16' }, controlInputBytes: 131072, controlOutputBytes: 131072 }
const initial = (): CommandSnapshot => ({ prepared: true, submitted: false, commitClosed: false,
  rangeEmpty: false, ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined,
  stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } })

function fixture(input: 'ignore' | 'pipe' | { readonly data: string } = 'pipe', control = true) {
  const caller = new AbortController(), lifetime = new AbortController()
  const gate = Promise.withResolvers<undefined>()
  const frames: StreamFrame[] = [], sequences = { 1: 0, 2: 0, 3: 0, 4: 0 }
  let stream: ExecutionStream | undefined, held = false, snapshot = initial(), streamFailures = 0
  const wire = { send: vi.fn(async (bytes: Uint8Array) => { frames.push(decodeStreamFrame(bytes)) }), close: vi.fn() }
  const get = (): ExecutionStream => { if (stream === undefined) throw new Error('Scripted stream was not prepared.'); return stream }
  const channel = {
    prepare: vi.fn<CommandChannel['prepare']>(async (spec) => {
      if (spec.executionKind !== 'pipes') throw new Error('This fixture supplies only the pipes channel.')
      const ref = createProgramIssuer('1'.repeat(64), '2'.repeat(64), () => {})(makePrepared('2'.repeat(64), 'pipes-test', spec)).ref
      stream = new ExecutionStream(ref, spec, () => { streamFailures++ }); stream.bind(wire)
      return snapshot
    }),
    attach: vi.fn<NonNullable<CommandChannel['attach']>>(async () => {
      if (held) await gate.promise
      get().events.open(); return await get().ready
    }),
    whenLocallySettled: vi.fn<NonNullable<CommandChannel['whenLocallySettled']>>(() => get().settled),
    commit: vi.fn<CommandChannel['commit']>(async () => { get().noteSubmitted(); snapshot = { ...snapshot, submitted: true }; return snapshot }),
    poll: vi.fn<CommandChannel['poll']>(async () => snapshot),
    stop: vi.fn<CommandChannel['stop']>(async () => snapshot), release: vi.fn(),
  } satisfies CommandChannel
  const authority = { lifetime: lifetime.signal, assertCurrent() { lifetime.signal.throwIfAborted() },
    acquire: vi.fn(async () => channel), unknown: vi.fn<(cause: unknown) => void>(), retired: vi.fn() }
  const spec: SubprocessSpawnSpec = { argv: ['/trusted/node', '/trusted/program.js'], cwd: '/project',
    stdio: { stdin: input, stdout: 'pipe', stderr: 'pipe', ...control ? { control: 'pipe' as const } : {} },
    graceMs: 1000, signal: caller.signal }
  const operation = new ManagedCommandOperation(spec, limits, authority, pipes)
  const receive = (channel: StreamFrame['channel'], kind: StreamFrame['kind'], payload: Uint8Array): void => {
    get().events.data(encodeStreamFrame({ channel, kind, sequence: sequences[channel]++, payload }))
  }
  const credit = (channel: 1 | 4, count: number): void => { const b = Buffer.alloc(4); b.writeUInt32BE(count); receive(channel, 3, b) }
  const eof = (channel: 2 | 3 | 4): void => { receive(channel, 2, Buffer.alloc(0)) }
  const complete = (empty = true): void => {
    snapshot = { ...snapshot, submitted: true, rangeEmpty: empty, ioClosed: empty,
      direct: { exitCode: 0, signal: null }, stdout: { ...snapshot.stdout, eof: true }, stderr: { ...snapshot.stderr, eof: true } }
  }
  onTestFinished(async () => {
    gate.resolve(undefined); operation.release()
    if (stream !== undefined) { stream.fail(); stream.events.closed() }
    operation.acknowledgePhysicalStop()
    if (!operation.isAwaitingChannel()) await operation.whenEmpty
  })
  return { operation, spec, channel, authority, caller, lifetime, frames, wire, get, receive, credit, eof, complete,
    holdAttach: () => { held = true }, releaseAttach: () => { gate.resolve(undefined) },
    streamFailures: () => streamFailures,
    setSnapshot: (value: CommandSnapshot) => { snapshot = value } }
}

it('publishes raw endpoints synchronously but requires actual attachment before preparation and commit', async () => {
  const f = fixture(), handle = f.operation.handle
  expect(handle.stdin).toBeDefined(); expect(handle.stdout).toBeDefined(); expect(handle.control).toBeDefined()
  expect(handle.collected).toEqual({}); expect(f.authority.acquire).not.toHaveBeenCalled()
  f.holdAttach(); f.operation.publish(); f.operation.begin()
  let ready = false; void f.operation.prepared.then(() => { ready = true })
  await vi.waitFor(() => { expect(f.channel.attach).toHaveBeenCalledTimes(1) })
  expect(ready).toBe(false); expect(f.channel.commit).not.toHaveBeenCalled()
  f.releaseAttach(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledTimes(1) })
  expect(f.channel.prepare).toHaveBeenCalledWith({ executionKind: 'pipes', argv: f.spec.argv, cwd: '/project',
    stdin: { mode: 'pipe' }, env: pipes.env,
    stream: { version: 'pe-execution-stream-v1', stdout: 'pipe', stderr: 'pipe', control: 'pipe',
      limits: { controlInputBytes: pipes.controlInputBytes, controlOutputBytes: pipes.controlOutputBytes } } })
})

it('bounds preparing Native control buffers independently of the cumulative control budget', async () => {
  const failed = vi.fn(), streams = new CommandStreams(false, true,
    { stdinBytes: 4096, controlInputBytes: 8388608, observedBytes: 65536 }, () => true, failed)
  const control = streams.control
  control?.write(Buffer.alloc(STREAM_LIMITS.windowBytes), () => {})
  expect(control?.writableLength).toBe(STREAM_LIMITS.windowBytes)
  const rejected = vi.fn()
  expect(control?.write(Buffer.alloc(STREAM_LIMITS.frameBytes + 1), rejected)).toBe(false)
  expect(rejected).toHaveBeenCalledWith(expect.any(Error)); expect(failed).toHaveBeenCalledWith(expect.any(Error))
  expect(control?.writableLength).toBe(STREAM_LIMITS.windowBytes)
  streams.fail(new Error('Original preparing owner ended')); await streams.joinWrites(); streams.release()
})

it('preserves early raw stdin bytes and delays its callback until the original remote delivery credit', async () => {
  const f = fixture(), bytes = Buffer.from([0, 255, 195, 169]), wrote = vi.fn()
  f.operation.handle.stdin!.write(bytes, wrote)
  f.operation.begin(); await f.operation.prepared; await setImmediate()
  expect(f.frames.filter(frame => frame.kind === 1)).toHaveLength(0)
  expect(wrote).not.toHaveBeenCalled(); expect(f.channel.commit).not.toHaveBeenCalled()
  f.operation.publish(); await vi.waitFor(() => { expect(f.frames.filter(frame => frame.kind === 1)).toHaveLength(1) })
  expect(f.frames.find(frame => frame.kind === 1)?.payload).toEqual(Uint8Array.from(bytes))
  expect(wrote).not.toHaveBeenCalled()
  f.credit(1, bytes.length); await vi.waitFor(() => { expect(wrote).toHaveBeenCalledOnce() })
  f.operation.handle.stdin!.end()
  await vi.waitFor(() => { expect(f.frames.some(frame => frame.kind === 2 && frame.channel === 1)).toBe(true) })
  expect(f.streamFailures()).toBe(0)
})

it.each(['ignore', { data: 'a\0尾' }] as const)('keeps %j stdin signed without a writable endpoint', async (input) => {
  const f = fixture(input, false)
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  expect(f.operation.handle.stdin).toBeUndefined(); expect(f.operation.handle.control).toBeUndefined()
  expect(f.channel.prepare.mock.calls[0]?.[0].stdin).toEqual(input === 'ignore' ? { mode: 'ignore' } : { mode: 'batch', base64: 'YQDlsL4=' })
})

it('preserves end(data) delivery before its ordinary input EOF and completion callback', async () => {
  const f = fixture(), ended = vi.fn(), bytes = Buffer.from([0, 255, 65])
  f.operation.handle.stdin!.end(bytes, ended)
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.frames.filter(frame => frame.kind === 1)).toHaveLength(1) })
  expect(ended).not.toHaveBeenCalled(); expect(f.frames.some(frame => frame.kind === 2)).toBe(false)
  f.credit(1, bytes.length)
  await vi.waitFor(() => { expect(ended).toHaveBeenCalledOnce() })
  expect(f.frames.filter(frame => frame.channel === 1)).toMatchObject([{ kind: 1 }, { kind: 2 }])
  expect(f.frames[0]?.payload).toEqual(Uint8Array.from(bytes))
})

it('uses only WS raw bytes, preserves unread buffers after actual close, and separates all three completion facts', async () => {
  const f = fixture('ignore'), handle = f.operation.handle, done = handle.done, bytes = Buffer.alloc(8192, 0xab)
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  for (let i = 0; i < bytes.length; i += 4096) f.receive(2, 1, bytes.subarray(i, i + 4096))
  f.receive(3, 1, Buffer.from([0, 255])); f.receive(4, 1, Buffer.from('independent fd7'))
  f.complete(); let completed = false, empty = false
  void done.then(() => { completed = true }); void f.operation.whenEmpty.then(() => { empty = true })
  await vi.waitFor(() => { expect(f.channel.poll).toHaveBeenCalled() })
  expect(completed).toBe(false); expect(empty).toBe(false)
  for (const channel of [2, 3, 4] as const) f.eof(channel)
  await expect(done).resolves.toEqual({ exitCode: 0, signal: null })
  await vi.waitFor(() => { expect(f.wire.close).toHaveBeenCalledOnce() })
  expect(empty).toBe(false); expect(f.channel.release).not.toHaveBeenCalled()
  f.get().events.closed(); await f.operation.whenEmpty
  const output: Buffer[] = []; for await (const chunk of handle.stdout!) output.push(chunk as Buffer)
  expect(Buffer.concat(output)).toEqual(bytes)
  expect(handle.stderr!.read()).toEqual(Buffer.from([0, 255]))
  expect(handle.control!.read()).toEqual(Buffer.from('independent fd7'))
  expect(f.authority.unknown).not.toHaveBeenCalled(); expect(f.channel.release).toHaveBeenCalledOnce()
  expect(f.authority.retired).not.toHaveBeenCalled(); f.operation.release(); expect(f.authority.retired).toHaveBeenCalledOnce()
})

it('keeps the original direct-exit drain deadline when range settlement arrives later', async () => {
  let now = 100
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now), timer = vi.spyOn(globalThis, 'setTimeout')
  onTestFinished(() => { clock.mockRestore(); timer.mockRestore() })
  const f = fixture('ignore')
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  const beforeExit = f.channel.poll.mock.calls.length
  f.complete(false)
  await vi.waitFor(() => { expect(f.channel.poll.mock.calls.length).toBeGreaterThan(beforeExit + 2) })
  now = 850; f.complete()
  await vi.waitFor(() => { expect(timer.mock.calls.some(call => call[1] === 250)).toBe(true) }, { timeout: 150 })
  for (const channel of [2, 3, 4] as const) f.eof(channel)
  await vi.waitFor(() => { expect(f.wire.close).toHaveBeenCalledOnce() })
  f.get().events.closed(); await f.operation.whenEmpty
  expect(f.authority.unknown).not.toHaveBeenCalled()
})

it('treats Native control.destroy as input EOF while draining its abandoned output and retaining the whole WS', async () => {
  const f = fixture('ignore'), control = f.operation.handle.control!
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  control.destroy()
  await vi.waitFor(() => { expect(f.frames.some(frame => frame.channel === 4 && frame.kind === 2)).toBe(true) })
  expect(f.wire.close).not.toHaveBeenCalled(); expect(f.streamFailures()).toBe(0)
  for (let i = 0; i < 20; i++) { f.receive(4, 1, Buffer.alloc(4096, i)); await setImmediate() }
  expect(f.streamFailures()).toBe(0)
  const credits = f.frames.filter(frame => frame.channel === 4 && frame.kind === 3)
  expect(credits.reduce((sum, frame) => sum + Buffer.from(frame.payload).readUInt32BE(), 0)).toBe(81920)
  f.complete(); for (const channel of [2, 3, 4] as const) f.eof(channel)
  await vi.waitFor(() => { expect(f.wire.close).toHaveBeenCalledOnce() })
  f.get().events.closed(); await f.operation.whenEmpty
  expect(f.authority.unknown).not.toHaveBeenCalled()
})

it('retains a disconnected raw operation until actual WS close and original physical-stop acknowledgement', async () => {
  const f = fixture(), done = f.operation.handle.done, write = vi.fn()
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  f.operation.handle.control!.write(Buffer.from('unconfirmed'), write)
  await vi.waitFor(() => { expect(f.frames.some(frame => frame.kind === 1)).toBe(true) })
  f.get().events.error(); await expect(done).rejects.toThrow()
  await vi.waitFor(() => { expect(write).toHaveBeenCalledOnce() })
  f.setSnapshot({ ...initial(), physicalStopRequired: true })
  await vi.waitFor(() => { expect(f.authority.unknown).toHaveBeenCalledOnce() })
  f.operation.release(); f.operation.acknowledgePhysicalStop()
  let empty = false; void f.operation.whenEmpty.then(() => { empty = true }); await setImmediate()
  expect(empty).toBe(false); expect(f.channel.release).not.toHaveBeenCalled(); expect(f.authority.retired).not.toHaveBeenCalled()
  f.get().events.closed(); await f.operation.whenEmpty
  expect(f.authority.retired).toHaveBeenCalledOnce(); expect(f.channel.attach).toHaveBeenCalledOnce()
  expect(f.channel.prepare).toHaveBeenCalledOnce(); expect(f.channel.commit).toHaveBeenCalledOnce()
})

it('bounds input queued before attachment and rejects raw admission without explicit qualified options', async () => {
  const f = fixture(), done = f.operation.handle.done, callback = vi.fn()
  expect(f.operation.handle.stdin!.write(Buffer.alloc(4097), callback)).toBe(false)
  await expect(done).rejects.toThrow('byte budget'); expect(callback).toHaveBeenCalledOnce()
  f.operation.begin(); await f.operation.whenEmpty
  expect(f.channel.prepare).not.toHaveBeenCalled()
  for (const stdio of [f.spec.stdio, { ...f.spec.stdio, stdout: 'inherit' as const }]) {
    expect(() => new ManagedCommandOperation({ ...f.spec, stdio }, limits, f.authority)).toThrow()
  }
})

it.each(['stdin', 'control'] as const)('reserves end(data) on %s before preparation can retain an oversized buffer', async (name) => {
  const f = fixture(), done = f.operation.handle.done, endpoint = f.operation.handle[name]!, callback = vi.fn()
  endpoint.end(Buffer.alloc(name === 'stdin' ? limits.maxStdinBytes + 1 : pipes.controlInputBytes + 1), callback)
  await expect(done).rejects.toThrow('byte budget'); expect(callback).toHaveBeenCalledOnce()
  f.operation.begin(); await f.operation.whenEmpty
  expect(f.channel.prepare).not.toHaveBeenCalled()
})

it('does not commit after cancellation while the original attachment is still pending', async () => {
  const f = fixture(), done = f.operation.handle.done
  f.holdAttach(); f.operation.publish(); f.operation.begin()
  await vi.waitFor(() => { expect(f.channel.attach).toHaveBeenCalledOnce() })
  f.caller.abort(new Error('Native cancelled during attach'))
  f.setSnapshot({ ...initial(), rangeEmpty: true, ioClosed: true,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: true } })
  f.releaseAttach(); await f.get().ready
  for (const channel of [2, 3, 4] as const) f.eof(channel)
  await expect(done).rejects.toThrow('Native cancelled during attach')
  await vi.waitFor(() => { expect(f.wire.close).toHaveBeenCalledOnce() })
  f.get().events.closed(); await f.operation.whenEmpty
  expect(f.channel.commit).not.toHaveBeenCalled(); expect(f.channel.stop).toHaveBeenCalledOnce()
})

it('joins the original failed attachment even when upgrade readiness rejects before exposing its streams', async () => {
  const f = fixture(), failure = new Error('Original upgrade failed before readiness'), done = f.operation.handle.done
  f.channel.attach.mockImplementation(async () => { f.get().events.error(); throw failure })
  f.operation.publish(); f.operation.begin()
  await expect(done).rejects.toBe(failure)
  await vi.waitFor(() => { expect(f.authority.unknown).toHaveBeenCalledWith(failure) })
  f.operation.release(); f.operation.acknowledgePhysicalStop()
  let empty = false; void f.operation.whenEmpty.then(() => { empty = true }); await setImmediate()
  expect(empty).toBe(false); expect(f.channel.whenLocallySettled).toHaveBeenCalledOnce()
  expect(f.authority.retired).not.toHaveBeenCalled(); expect(f.channel.commit).not.toHaveBeenCalled()
  f.get().events.closed(); await f.operation.whenEmpty
  expect(f.authority.retired).toHaveBeenCalledOnce()
})

it('refuses new and queued business input after Native cancellation while retaining output drain and cleanup EOF', async () => {
  const f = fixture(), control = f.operation.handle.control!, first = vi.fn(), queued = vi.fn(), later = vi.fn()
  f.operation.publish(); f.operation.begin(); await f.operation.prepared
  await vi.waitFor(() => { expect(f.channel.commit).toHaveBeenCalledOnce() })
  control.write(Buffer.from('first'), first); control.write(Buffer.from('must-not-forward'), queued)
  await vi.waitFor(() => { expect(f.frames.filter(frame => frame.kind === 1)).toHaveLength(1) })
  f.caller.abort(new Error('Native caller stopped'))
  expect(control.write(Buffer.from('after-cancel'), later)).toBe(false)
  expect(later).toHaveBeenCalledWith(expect.objectContaining({ message: 'Native command input is no longer active.' }))
  f.credit(4, 5)
  await vi.waitFor(() => { expect(first).toHaveBeenCalledOnce(); expect(queued).toHaveBeenCalledOnce() })
  expect(f.frames.filter(frame => frame.kind === 1)).toHaveLength(1)
  await vi.waitFor(() => { expect(f.frames.some(frame => frame.channel === 4 && frame.kind === 2)).toBe(true) })
  f.receive(2, 1, Buffer.from('final raw output')); f.complete()
  for (const channel of [2, 3, 4] as const) f.eof(channel)
  await vi.waitFor(() => { expect(f.wire.close).toHaveBeenCalledOnce() })
  f.get().events.closed(); await f.operation.whenEmpty
  expect(f.operation.handle.stdout!.read()).toEqual(Buffer.from('final raw output'))
  expect(f.authority.unknown).not.toHaveBeenCalled()
})
