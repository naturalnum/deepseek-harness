/** Actual Native NodePtcRuntime and BashTerminalBackend; external process/PTY streams are explicitly scripted, never host processes. */
import { Duplex, PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessHandle,
  type SubprocessOutcome, type SubprocessTerminalSpawnSpec, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { JsonChannel } from '../../../ptc-runtime/ptc-runtime-node/src/channel.ts'
import { encodePtcJsonWire } from '../../../ptc-runtime/ptc-runtime-node/src/json-wire.ts'
import { BashTerminalBackend } from '@deepseek-ai/dsh-terminal-bash'
import TerminalRegistry, { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from '../../../terminal/terminal-bash/src/config.ts'
import type { ConsumedNativeConfinement } from '../src/native-sandbox.ts'
import { fixture } from './native-sandbox-fixture.ts'

async function consumers(completeProgram = true, terminalReady = true) {
  const f = await fixture()
  const observed: { kind: 'program' | 'terminal'; argv: readonly string[]; signed: ConsumedNativeConfinement }[] = []
  const state = { programStops: 0, terminalStops: 0, programs: 0, terminals: 0 }
  const spawned = Promise.withResolvers<undefined>()
  class CandidateSubprocess extends SubprocessRuntime {
    override async resolveExecutable(command: string): Promise<string> { return command }
    override async terminalEnvironment() { return { platform: 'posix' as const } }
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const signed = f.sandbox.consume(this.ctx, spec.argv, spec.signal)
      observed.push({ kind: 'program', argv: spec.argv, signed }); state.programs++
      const outgoing = new PassThrough(), incoming = new PassThrough()
      const host = Duplex.from({ readable: incoming, writable: outgoing })
      const peer = Duplex.from({ readable: outgoing, writable: incoming })
      const stdout = new PassThrough(), stderr = new PassThrough(), done = Promise.withResolvers<SubprocessOutcome>()
      let stopped = false
      const protocol = new JsonChannel(peer, 65536, (raw) => {
        if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'boot' && completeProgram) {
          void protocol.send({ type: 'done', value: encodePtcJsonWire({ candidate: true }) }).catch((error: unknown) => { if (!stopped) done.reject(error) })
        }
      }, (error) => { if (!stopped) done.reject(error) })
      void protocol.send({ type: 'ready' }).catch((error: unknown) => { if (!stopped) done.reject(error) })
      spawned.resolve(undefined)
      return { stdin: undefined, stdout, stderr, control: host, collected: {}, done: done.promise,
        terminate() {
          if (stopped) return
          stopped = true; state.programStops++; stdout.end(); stderr.end()
          done.resolve({ exitCode: 0, signal: null }); protocol.close(); host.end()
        },
        waitForExit: async () => { await done.promise; return true },
      }
    }
    override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
      const signed = f.sandbox.consume(this.ctx, spec.argv, spec.signal)
      observed.push({ kind: 'terminal', argv: spec.argv, signed }); state.terminals++
      const output = new PassThrough(), done = Promise.withResolvers<SubprocessOutcome>()
      let stopped = false, prompted = false
      spawned.resolve(undefined)
      return { pid: 123, output, done: done.promise,
        write: async () => {}, resize: async () => {},
        inspectForeground: async () => {
          if (terminalReady && !prompted) { prompted = true; output.write('\x1b]133;D;0\x07dsh> ') }
          return { processGroupId: 123, inputWaiting: terminalReady }
        },
        inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
        signalForeground: async () => 123,
        terminate: async () => {
          if (stopped) return
          stopped = true; state.terminalStops++; output.end(); done.resolve({ exitCode: 0, signal: null })
        },
      }
    }
  }
  new CandidateSubprocess(f.graph.ctx)
  await f.graph.ctx.plugin(NodePtcRuntime, { timeoutMs: 5000, maxTimeoutMs: 5000, graceMs: 100,
    maxMessageBytes: 65536, maxOutputBytes: 8192, maxPendingCalls: 8, maxOldGenerationSizeMb: 16,
    launch: { kind: 'node-script', executable: '/guest/node', bootstrapPath: '/guest/readonly/ptc-bootstrap.js' } })
  await f.graph.ctx.plugin(TerminalRegistry)
  const terminalConfig: ResolvedConfig = { backendType: 'shell', shellDialect: 'bash', shellPath: '/guest/bash', shellArgs: [],
    rows: 24, cols: 80, scrollbackLines: 50, scrollbackMaxBytes: 4096, maxReadBytes: 1024,
    pollIntervalMs: 5, exactProbeAfterMs: 5, idleSilenceMs: 5, handoffGraceMs: 0, promptTailGraceMs: 0,
    timeoutMs: 5000, disposeGraceMs: 100 }
  const backend = new BashTerminalBackend(f.graph.ctx, terminalConfig)
  return { ...f, profileState: f.state, observed, state, spawned, runtime: f.graph.ctx.ptcRuntime, backend }
}

it('passes the exact confined array from Native NodePtcRuntime into spawn and the same immutable filePolicy into prepare inputs', async () => {
  const f = await consumers()
  const confine = vi.spyOn(f.sandbox, 'confine')
  const result = await f.run('candidate_ptc', signal => f.runtime.run(f.runtime.resolve({
    program: 'return {candidate:true}', cwd: f.project, bindings: [], sandboxPolicy: f.policy(), signal,
  })))
  expect(result.error).toBeUndefined()
  expect(result.value).toEqual({ candidate: true })
  expect(confine).toHaveBeenCalledTimes(1)
  expect(f.observed[0]?.signed.filePolicy).toEqual({ mode: 'workspace-write' })
  expect(f.state).toMatchObject({ programs: 1, programStops: 1 })
  expect(f.calls.inspect()).toBe(0)
})

it('uses Native PTC cancellation to terminate and join its original scripted process once', async () => {
  const f = await consumers(false), controller = new AbortController()
  let actual: ReturnType<typeof f.runtime.run> | undefined
  const running = f.run('candidate_ptc', (signal) => {
    actual = f.runtime.run(f.runtime.resolve({
      program: 'await new Promise(()=>{})', cwd: f.project, bindings: [], sandboxPolicy: f.policy(), signal,
    }))
    return actual
  }, f.agent, controller.signal)
  const rejected = expect(running).rejects.toThrow('tool call aborted')
  await f.spawned.promise
  controller.abort(new Error('candidate Native PTC cancellation'))
  await rejected
  if (actual === undefined) throw new Error('Native PTC run was not started')
  const result = await actual
  expect(result.error?.kind).toBe('abort')
  expect(f.state).toMatchObject({ programs: 1, programStops: 1 })
  expect(f.calls.inspect()).toBe(0)
})

it('refuses Native PTC before spawn when Root has no qualified enforcing profile', async () => {
  const f = await consumers()
  f.profileState.fixtureProfile = false
  const result = await f.run('candidate_ptc', signal => f.runtime.run(f.runtime.resolve({
    program: 'return 1', cwd: f.project, bindings: [], sandboxPolicy: f.policy(), signal,
  })))
  expect(result.error?.kind).toBe('sandbox-unavailable')
  expect(f.state.programs).toBe(0)
})

it('passes Native BashTerminalBackend argv unchanged and closes the original LocalPtySession', async () => {
  const f = await consumers(), confine = vi.spyOn(f.sandbox, 'confine')
  const session = await f.run('candidate_terminal', signal => f.backend.spawn({ sessionId: TerminalSessionId('candidate-pty'),
    owner: f.agent, type: 'shell', cwd: f.project, signal }))
  expect(confine).toHaveBeenCalledTimes(1)
  expect(f.observed[0]?.signed.filePolicy).toEqual({ mode: 'workspace-write' })
  await session.close('candidate only')
  expect(f.state).toMatchObject({ terminals: 1, terminalStops: 1 })
  expect(f.calls.inspect()).toBe(0)
})

it('joins Native terminal startup cleanup after cancellation without reusing its consumed argv', async () => {
  const f = await consumers(true, false), controller = new AbortController()
  const running = f.run('candidate_terminal', signal => f.backend.spawn({ sessionId: TerminalSessionId('candidate-cancel-pty'),
    owner: f.agent, type: 'shell', cwd: f.project, signal }), f.agent, controller.signal)
  const rejected = expect(running).rejects.toThrow('cancel candidate terminal')
  await f.spawned.promise
  controller.abort(new Error('cancel candidate terminal'))
  await rejected
  expect(f.state).toMatchObject({ terminals: 1, terminalStops: 1 })
  expect(f.calls.inspect()).toBe(0)
})
