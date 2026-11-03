/** Test-only kernel replacement; the actual Native worker/Bash run while production allocation and mount frontiers remain scripted. */
import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import type { OperationSpec } from '../src/agent-data/types.ts'

/** Spawn facts used only by the isolated source component's concurrency assertions. */
export interface KernelLaunch {
  readonly process: ChildProcess
  readonly spec: OperationSpec
  readonly program: boolean
}

/**
 * Replace one external range with an owned Node worker or Bash, preserving actual start/stdio/exit joins.
 * @param directory Owned temporary execution-world directory and copied self-contained Native worker source.
 * @param launched Observe the actual kernel process after start.
 * @param output Observe foreground bytes while its original range is live.
 * @returns Original CommandChannel interface; no Account/Agent/tool authority is synthesized here.
 */
export function localKernelChannel(directory: string, launched: (value: KernelLaunch) => void,
  output: (value: KernelLaunch) => void): CommandChannel {
  const empty = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
  let snapshot: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: empty, stderr: empty }
  let spec: OperationSpec | undefined, child: ChildProcess | undefined, socket: Duplex | undefined
  const stdout = new PassThrough(), stderr = new PassThrough()
  const ended = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>()
  const control = new Duplex({ read() { socket?.resume() }, write(chunk: Buffer, _encoding, done) {
    if (socket === undefined) { done(new Error('External inherited fd7 absent')); return }
    socket.write(chunk, done)
  }, final(done) { if (socket === undefined) done(); else socket.end(done) } })
  const stdin = new Writable({ write(_chunk, _encoding, done) { done(new Error('This external worker does not accept stdin')) } })
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    snapshot = { ...snapshot, rangeEmpty: true, ioClosed: true, direct: { exitCode: code, signal },
      stdout: { ...snapshot.stdout, eof: true }, stderr: { ...snapshot.stderr, eof: true } }
    stdout.end(); stderr.end(); control.push(null); ended.resolve(undefined)
  }
  return {
    async prepare(input) { spec = input; return snapshot },
    async attach() { return { ...spec?.stdin.mode === 'pipe' ? { stdin } : {}, stdout, stderr, control, outputEnded: ended.promise, settled: closed.promise,
      close() {
        if (socket === undefined || socket.closed) closed.resolve(undefined)
        else { socket.once('close', () => { closed.resolve(undefined) }); socket.destroy() }
      } } },
    async whenLocallySettled() { await closed.promise },
    async commit() {
      if (spec === undefined || child !== undefined) throw new Error('External range is not uniquely prepared')
      const program = spec.executionKind === 'pipes'
      if (program) {
        const main = `import {Socket} from 'node:net';import {runNodeMain} from ${JSON.stringify(pathToFileURL(join(directory, 'process.ts')).href)};await runNodeMain(new Socket({fd:7,readable:true,writable:true}),8192,process);`
        child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '--eval', main], {
          cwd: directory, env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
        })
        const descriptor = child.stdio.at(7)
        if (!(descriptor instanceof Duplex)) throw new Error('Actual Node fd7 absent')
        socket = descriptor
        socket.on('data', (chunk: Buffer) => { if (!control.push(chunk)) socket?.pause() })
        socket.on('error', (error) => { control.destroy(error) })
      } else {
        const executable = spec.argv[0]
        if (executable === undefined) throw new Error('Actual Bash argv absent')
        child = spawn(executable, spec.argv.slice(1), { cwd: directory, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
      }
      const launch = { process: child, spec, program }
      child.on('error', (error) => { stdout.destroy(error); stderr.destroy(error); control.destroy(error) })
      for (const [name, source, destination] of [['stdout', child.stdout, stdout], ['stderr', child.stderr, stderr]] as const) {
        source?.on('data', (chunk: Buffer) => {
          const previous = snapshot[name]
          snapshot = { ...snapshot, [name]: { bytes: Buffer.concat([previous.bytes, chunk]).subarray(-4096),
            observedBytes: previous.observedBytes + chunk.byteLength, eof: false } }
          destination.write(chunk)
          if (!program && name === 'stdout') output(launch)
        })
      }
      child.once('close', finish)
      snapshot = { ...snapshot, submitted: true }
      launched(launch)
      return snapshot
    },
    async poll() { return snapshot },
    async stop() {
      if (child === undefined) { finish(null, null) }
      else if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await ended.promise; return snapshot
    },
  }
}
