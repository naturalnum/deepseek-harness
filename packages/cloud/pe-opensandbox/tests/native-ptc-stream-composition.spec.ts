/** Real Native NodePtcRuntime, original policy handoff, operation and mux; remote execution/WS events remain scripted. */
import { Duplex, PassThrough } from 'node:stream'
import { expect, it, onTestFinished, vi } from 'vitest'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessHandle,
  type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { ManagedCommandOperation, type CommandChannel, type CommandSnapshot } from '@deepseek-ai/dsh-pe-opensandbox/src/command-operation.ts'
import { makePrepared } from '@deepseek-ai/dsh-pe-opensandbox/src/agent-data/canonical.ts'
import { createProgramIssuer } from '@deepseek-ai/dsh-pe-opensandbox/src/agent-data/root-role-issuer.ts'
import { decodeStreamFrame, encodeStreamFrame, ExecutionStream } from '@deepseek-ai/dsh-pe-opensandbox/src/agent-data/stream.ts'
import { JsonChannel } from '../../../ptc-runtime/ptc-runtime-node/src/channel.ts'
import { fixture } from './native-sandbox-fixture.ts'

async function consumers(completeProgram = true) {
  const f = await fixture()
  const boot = Promise.withResolvers<undefined>()
  const operations: ManagedCommandOperation[] = [], streams: ExecutionStream[] = []
  const facts = { stops: 0, closed: 0, retired: 0, unknown: 0, boot: 0, controlInputEof: 0, peerEnded: 0, policy: '' }
  class ScriptedSubprocess extends SubprocessRuntime {
    override async resolveExecutable(command: string): Promise<string> { return command }
    override async terminalEnvironment() { return { platform: 'posix' as const } }
    override async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('This composition does not provide PTY.') }
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const signed = f.sandbox.consume(this.ctx, spec.argv, spec.signal)
      facts.policy = signed.filePolicy.mode
      let stream: ExecutionStream | undefined, stopped = false
      const peerInput = new PassThrough(), peerOutput = new PassThrough()
      const peer = Duplex.from({ readable: peerInput, writable: peerOutput })
      const sequences = { 1: 0, 2: 0, 3: 0, 4: 0 }
      const get = (): ExecutionStream => { if (stream === undefined) throw new Error('Original stream absent'); return stream }
      const send = (channel: 1 | 2 | 3 | 4, kind: 1 | 2 | 3, payload: Uint8Array): void => {
        get().events.data(encodeStreamFrame({ channel, kind, sequence: sequences[channel]++, payload }))
      }
      const protocol = new JsonChannel(peer, 65536, (raw) => {
        if (typeof raw !== 'object' || raw === null || !('type' in raw) || raw.type !== 'boot') return
        facts.boot++; boot.resolve(undefined)
        if (completeProgram) {
          send(2, 1, Buffer.from('raw stdout 你好'))
          send(3, 1, Buffer.from('raw stderr 🙂'))
          void protocol.send({ type: 'done', value: [42] }).catch(() => { facts.peerEnded++ })
        }
      }, () => { facts.peerEnded++ })
      peerOutput.on('data', (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.length; offset += 4096) send(4, 1, chunk.subarray(offset, offset + 4096))
      })
      let snapshot: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
        physicalStopRequired: false, providerFailure: false, direct: undefined,
        stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } }
      const channel: CommandChannel = {
        async prepare(input) {
          if (input.executionKind !== 'pipes') throw new Error('Expected original signed pipes spec')
          const request = createProgramIssuer('1'.repeat(64), '2'.repeat(64), () => {})(
            makePrepared('2'.repeat(64), 'native-ptc', input, undefined, signed.filePolicy))
          expect(request.filePolicy).toEqual(signed.filePolicy)
          stream = new ExecutionStream(request.ref, input, () => { facts.unknown++ }); streams.push(stream)
          stream.bind({
            async send(bytes) {
              const frame = decodeStreamFrame(bytes)
              if (frame.channel !== 4) return
              if (frame.kind === 1) peerInput.write(frame.payload, () => {
                const credit = Buffer.alloc(4); credit.writeUInt32BE(frame.payload.length); send(4, 3, credit)
              })
              else if (frame.kind === 2) { facts.controlInputEof++; peerInput.end() }
            },
            close() { facts.closed++; get().events.closed() },
          })
          return snapshot
        },
        async attach() { get().events.open(); return await get().ready },
        whenLocallySettled() { return get().settled },
        async commit() {
          get().noteSubmitted(); snapshot = { ...snapshot, submitted: true }
          void protocol.send({ type: 'ready' }).catch(() => { facts.peerEnded++ })
          return snapshot
        },
        async poll() { return snapshot },
        async stop() {
          if (!stopped) {
            stopped = true; facts.stops++; protocol.close()
            for (const channel of [2, 3, 4] as const) send(channel, 2, Buffer.alloc(0))
            snapshot = { ...snapshot, rangeEmpty: true, ioClosed: true, direct: { exitCode: 0, signal: null },
              stdout: { ...snapshot.stdout, eof: true }, stderr: { ...snapshot.stderr, eof: true } }
          }
          return snapshot
        },
      }
      const operation = new ManagedCommandOperation(spec, { maxArgvBytes: 4096, maxArgvEntries: 32, maxPathBytes: 512,
        maxStdinBytes: 4096, maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2,
        maxLifetimeMs: 5000, stopWaitMs: 1000 }, {
        lifetime: signed.scope.lifetime, assertCurrent() { f.calls.assertCurrent(signed.scope) },
        acquire: async () => channel, unknown() { facts.unknown++ }, retired() { facts.retired++ },
      }, { env: {}, controlInputBytes: 131072, controlOutputBytes: 131072 })
      operations.push(operation); operation.publish(); operation.begin()
      return operation.handle
    }
  }
  new ScriptedSubprocess(f.graph.ctx)
  await f.graph.ctx.plugin(NodePtcRuntime, { timeoutMs: 5000, maxTimeoutMs: 5000, graceMs: 1000,
    maxMessageBytes: 65536, maxOutputBytes: 8192, maxPendingCalls: 8, maxOldGenerationSizeMb: 16,
    launch: { kind: 'node-script', executable: '/guest/node', bootstrapPath: '/guest/readonly/ptc-bootstrap.js' } })
  onTestFinished(async () => {
    for (const stream of streams) { stream.fail(); stream.events.closed() }
    for (const operation of operations) { operation.release(); operation.acknowledgePhysicalStop() }
    await Promise.all(operations.map(operation => operation.whenEmpty))
  })
  return { ...f, facts, operations, boot, runtime: f.graph.ctx.ptcRuntime }
}

it('joins actual Native PTC success through separate stdout/stderr/fd7 and original scope retirement', async () => {
  const f = await consumers()
  const result = await f.run('candidate_ptc', signal => f.runtime.run(f.runtime.resolve({
    program: 'return 42', cwd: f.project, bindings: [], sandboxPolicy: f.policy(), signal,
  })))
  expect(result.error).toBeUndefined(); expect(result.value).toBe(42)
  expect(result.logs.join('')).toContain('raw stdout 你好'); expect(result.logs.join('')).toContain('raw stderr 🙂')
  expect(f.facts).toMatchObject({ stops: 1, closed: 1, retired: 1, unknown: 0, boot: 1, controlInputEof: 1, policy: 'workspace-write' })
  expect(f.calls.inspect()).toBe(0)
  await f.operations[0]!.whenEmpty
})

it('joins Native PTC cancellation after the original tool observer releases without replaying its program', async () => {
  const f = await consumers(false), controller = new AbortController()
  let actual: ReturnType<typeof f.runtime.run> | undefined
  const pending = f.run('candidate_ptc', (signal) => {
    actual = f.runtime.run(f.runtime.resolve({ program: 'await new Promise(()=>{})', cwd: f.project,
      bindings: [], sandboxPolicy: f.policy(), signal }))
    return actual
  }, f.agent, controller.signal)
  const aborted = expect(pending).rejects.toThrow('tool call aborted')
  await f.boot.promise; controller.abort(new Error('Native PTC cancelled'))
  await aborted
  if (actual === undefined) throw new Error('Native run missing')
  const result = await actual
  expect(result.error?.kind).toBe('abort')
  await vi.waitFor(() => { expect(f.facts).toMatchObject({ stops: 1, closed: 1, retired: 1, unknown: 0 }) })
  expect(f.calls.inspect()).toBe(0)
})
