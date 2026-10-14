/** Original-Agent-bound Runtime client for the credentialed Platform execution broker. */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditRequest, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalSpawnSpec, SubprocessTerminalHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { PassThrough, Writable, Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { NativeExecutionBinding, NativeExecutionWorld } from './types.ts'
import { decodeNativeFsStream, ownNativeFsStream } from './fs-stream.ts'
import { nativeFsTarget, nativeFsInfo, nativeFsPathInfo, nativeFsWrite, nativeFsEdit, nativeProcessObservation, nativeTerminalObservation } from './wire.ts'

/** Caller-owned HTTP transport; the original token must never be logged or forwarded to payloads.
 * @param path Fixed native broker endpoint.
 * @param token Original operation bearer.
 * @param input Bounded typed JSON request.
 * @param signal Cancellation only for side-effect-free transport reads.
 * @returns Bounded parsed JSON reply.
 */
export type NativeExecutionHttpTransport = (path: string, token: string, input: unknown, signal?: AbortSignal) => Promise<unknown>
/** Explicit Runtime polling and collected-output bounds. */
export interface NativeExecutionHttpConfig { pollMs: number; maxOutputBytes: number }
interface ClientConfig { world: NativeExecutionWorld; token: string; transport: NativeExecutionHttpTransport; config: NativeExecutionHttpConfig }
const fsReply = z.object({ ok: z.boolean(), value: z.unknown().optional(), code: z.string().optional(), message: z.string().optional() }).strict()
const codes = z.enum(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE',
  'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED'])

class HttpFileSystem extends FileSystem {
  private disposed = false
  private readonly calls = new Set<Promise<unknown>>()
  private readonly readers = new Set<() => Promise<void>>()
  private closeWork: Promise<void> | undefined
  constructor(ctx: Context, private readonly client: ClientConfig) {
    super(ctx)
    ctx.effect(() => () => this.close(), 'native HTTP filesystem lifetime')
  }
  /** Join every original request and stream cleanup, retaining its original stop failure.
   * @returns The same joined cleanup promise, including its rejection.
   */
  close(): Promise<void> {
    this.disposed = true
    return this.closeWork ??= (async () => {
      const joined = await Promise.allSettled([...this.readers].map(stop => stop()).concat([...this.calls].map(async (work) => { await work })))
      const failures: unknown[] = joined.filter(result => result.status === 'rejected' && !(result.reason instanceof FsError))
        .map(result => (result as PromiseRejectedResult).reason as unknown)
      if (failures.length) throw new AggregateError(failures, 'Native HTTP filesystem disposal failed')
    })()
  }
  override get sandboxMode() { return this.client.world.mode }
  private async call<T>(request: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    // Mutation submission is never transport-retried or abandoned midway: its response includes joined stop evidence.
    if (this.disposed) throw new FsError('Native filesystem is closed.', 'FS_ABORTED')
    const work = this.client.transport('/runtime/native-world/fs', this.client.token, { world: this.client.world, request })
    this.calls.add(work)
    let raw: unknown
    try { raw = await work } finally { this.calls.delete(work) }
    const reply = fsReply.parse(raw)
    if (!reply.ok) throw new FsError(reply.message ?? 'Native filesystem failed.', codes.parse(reply.code))
    signal?.throwIfAborted()
    return schema.parse(reply.value)
  }
  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) { return this.call({ op: 'resolve', path, cwd: opts?.cwd ?? '/workspace' }, nativeFsTarget, opts?.signal) }
  override processPath(target: FsTarget) {
    const prefix = this.client.world.worldId + ':'
    if (!target.targetKey.startsWith(prefix)) throw new FsError('Target belongs to another world.', 'FS_PERMISSION_DENIED')
    return target.targetKey.slice(prefix.length)
  }
  override fileUrl(target: FsTarget) { return pathToFileURL(this.processPath(target)).href }
  override contains(parent: FsTarget, child: FsTarget) { const rel = posix.relative(this.processPath(parent), this.processPath(child)); return rel === '' || rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel) }
  override async stat(target: FsTarget, signal?: AbortSignal) {
    const info = await this.call({ op: 'stat', target }, nativeFsInfo.nullable(), signal)
    return info === null ? undefined : { version: info.version, type: info.type, ...(info.size === undefined ? {} : { size: info.size }) }
  }
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    const info = await this.call({ op: 'lstat', path, cwd: opts?.cwd ?? '/workspace' }, nativeFsPathInfo.nullable(), signal)
    return info === null ? undefined : { version: info.version, type: info.type, ...(info.size === undefined ? {} : { size: info.size }) }
  }
  override readText(target: FsTarget, signal?: AbortSignal) { return this.call({ op: 'readText', target }, z.string(), signal) }
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (this.disposed || signal?.aborted) throw new FsError('Native text read aborted.', 'FS_ABORTED')
    this.processPath(target)
    const id = randomUUID(), owner = this, output = new PassThrough(), interrupted = new AbortController(), opening = Promise.withResolvers<void>()
    output.on('error', () => {})
    const call = (path: string, body: Record<string, unknown>) => this.client.transport('/runtime/native-world/fs/stream/' + path,
      this.client.token, { world: this.client.world, id, ...body })
    let stopping: Promise<void> | undefined, stopRequested = false, pump: Promise<void> | undefined
    const stop = () => {
      stopRequested = true; interrupted.abort()
      return stopping ??= (async () => {
        try { await opening.promise; await call('stop', {}); await pump?.catch(() => undefined) }
        finally { try { await call('release', {}) } finally { output.destroy() } }
      })()
    }
    this.readers.add(stop)
    const abort = () => { void stop().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      try { z.object({ id: z.uuid() }).strict().parse(await call('start', { target })) } finally { opening.resolve() }
      if (this.disposed || signal?.aborted || stopRequested) { await stop(); throw new FsError('Native text read aborted.', 'FS_ABORTED') }
      pump = (async () => {
        let offset = 0
        try {
          for (;;) {
            if (stopRequested) return
            const current = nativeTerminalObservation.parse(await call('poll', { outputOffset: offset }))
            if (stopRequested) return
            if (current.output.lossy) throw new FsError('Native text stream bytes were lost.', 'FS_IO_ERROR')
            const data = Buffer.from(current.output.data, 'base64'); offset = current.output.nextOffset
            if (data.length && !output.write(data)) await owner.waitDrain(output, interrupted.signal)
            if (current.state === 'failed') throw new FsError('Native text stream failed.', 'FS_IO_ERROR')
            if (current.state === 'completed' && current.output.exhausted) {
              if (current.outcome?.exitCode !== 0) throw new FsError('Native text worker failed.', 'FS_IO_ERROR')
              return
            }
            await delay(owner.client.config.pollMs)
          }
        } finally { output.end() }
      })()
      void pump.catch((error: unknown) => { output.destroy(error instanceof Error ? error : new Error('Native text stream failed', { cause: error })) })
      const closeReader = async () => { try { await stop() } finally { signal?.removeEventListener('abort', abort); owner.readers.delete(stop) } }
      const source = (async function* () {
        try {
          for await (const text of decodeNativeFsStream(output, owner.client.config.maxOutputBytes, signal)) yield text
          await pump
        } catch (error) { if (signal?.aborted) throw new FsError('Native text read aborted.', 'FS_ABORTED'); throw error }
        finally { await closeReader() }
      })()
      return ownNativeFsStream(source, closeReader)
    } catch (error) {
      try { await stop() } finally { signal?.removeEventListener('abort', abort); this.readers.delete(stop) }
      throw error
    }
  }
  private waitDrain(stream: PassThrough, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finished = () => { cleanup(); resolve() }, closed = () => { cleanup(); reject(new FsError('Native text receiver closed.', 'FS_ABORTED')) }
      const cleanup = () => { stream.off('drain', finished); stream.off('close', closed); signal.removeEventListener('abort', finished) }
      stream.once('drain', finished); stream.once('close', closed); signal.addEventListener('abort', finished, { once: true })
      if (signal.aborted) finished()
    })
  }
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) { return Buffer.from(await this.call({ op: 'readBytes', target, maxBytes }, z.base64(), signal), 'base64') }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal) { return Buffer.from(await this.call({ op: 'readRange', target, ...range }, z.base64(), signal), 'base64') }
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await this.call({ op: 'listDir', target }, z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']), target: nativeFsTarget, version: z.string().transform(FsVersion).optional(), size: z.number().optional() }).strict()), signal)
    return entries.map(entry => ({ name: entry.name, type: entry.type, target: entry.target,
      ...(entry.version === undefined ? {} : { version: entry.version }), ...(entry.size === undefined ? {} : { size: entry.size }) }))
  }
  private mutation(policy?: SandboxExecutionPolicy) {
    const world = this.client.world
    if (policy && (policy.mode !== world.mode || policy.workspaceRoot !== '/workspace'
      || policy.sessionId !== undefined && policy.sessionId !== world.sessionId)) throw new FsError('Native permission generation changed.', 'FS_SANDBOX_DENIED')
  }
  override writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    this.mutation(policy); return this.call({ op: 'writeText', target, content, ...(expected === undefined ? {} : { expected }) }, nativeFsWrite, signal)
  }
  override editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    this.mutation(policy); return this.call({ op: 'editText', target, edit, ...(expected === undefined ? {} : { expected }) }, nativeFsEdit, signal)
  }
}

class HttpSubprocess extends SubprocessRuntime {
  private readonly live = new Set<SubprocessHandle | SubprocessTerminalHandle>()
  private readonly pending = new Set<Promise<void>>()
  private disposed = false
  private readonly allocationStops = new Set<() => void>()
  private readonly cleanupFailures = new Set<unknown>()
  private closeWork: Promise<void> | undefined
  constructor(ctx: Context, private readonly client: ClientConfig) {
    super(ctx)
    ctx.effect(() => () => this.close(), 'native broker HTTP teardown')
  }
  /** Stop and join original admissions before a Runtime owner can release this binding.
   * @returns The same promise; exact stop failures remain observable outside Cordis disposal.
   */
  close(): Promise<void> {
    this.disposed = true
    for (const stop of this.allocationStops) stop()
    return this.closeWork ??= (async () => {
      await Promise.all([...this.pending])
      const results = await Promise.allSettled([...this.live].map(async (handle) => {
        await handle.terminate()
        if ('waitForExit' in handle) await handle.waitForExit()
        await handle.done
      }))
      const failures: unknown[] = [...this.cleanupFailures, ...results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)]
      if (failures.length) throw new AggregateError(failures, 'Native HTTP subprocess disposal failed')
    })()
  }
  private call(kind: 'process' | 'terminal', path: string, request: Record<string, unknown>): Promise<unknown> {
    const work = this.client.transport('/runtime/native-world/' + kind + '/' + path, this.client.token, { world: this.client.world, ...request })
    if (path === 'stop' || path === 'release') void work.catch((error: unknown) => { this.cleanupFailures.add(error) })
    return work
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    if (this.disposed) throw new Error('native_world_subprocess_disposed')
    const stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const stdoutCollector = typeof spec.stdio.stdout === 'object' ? new OutputCollector(spec.stdio.stdout.maxBytes, 'stdout', undefined) : undefined
    const stderrCollector = typeof spec.stdio.stderr === 'object' ? new OutputCollector(spec.stdio.stderr.maxBytes, 'stderr', undefined) : undefined
    const id = randomUUID(), admitted = Promise.withResolvers<void>(), exited = Promise.withResolvers<void>()
    let stopping = false, outLost = false, errLost = false
    const interrupted = new AbortController()
    let readCredit = Promise.withResolvers<void>()
    let channelWork = Promise.resolve()
    const channelWrite = (path: string) => (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
      channelWork = channelWork.then(async () => {
        await admitted.promise
        const bytes = Buffer.from(chunk), quantum = Math.max(1, Math.floor(this.client.config.maxOutputBytes / 4))
        for (let offset = 0; offset < bytes.length; offset += quantum) await this.call('process', path, { id, data: bytes.subarray(offset, offset + quantum).toString('base64') })
      })
      channelWork.then(() => { callback() }, (error: unknown) => { callback(error instanceof Error ? error : new Error('Native process channel failed', { cause: error })) })
    }
    const end = (path: string) => (callback: (error?: Error | null) => void) => {
      channelWork = channelWork.then(async () => { await admitted.promise; await this.call('process', path, { id }) })
      channelWork.then(() => { callback() }, callback)
    }
    const stdin = spec.stdio.stdin === 'pipe' ? new Writable({ write: channelWrite('stdin'), final: end('stdinEnd') }) : undefined
    const control = spec.stdio.control === 'pipe' ? new Duplex({ read() { readCredit.resolve(); readCredit = Promise.withResolvers<void>() }, write: channelWrite('control'), final: end('controlEnd') }) : undefined
    const abort = () => { stopping = true; interrupted.abort(); readCredit.resolve() }
    spec.signal?.addEventListener('abort', abort, { once: true })
    const done = (async () => {
      let outOffset = 0, errOffset = 0, controlOffset = 0
      try {
        const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
        z.object({ id: z.uuid() }).strict().parse(await this.call('process', 'start', { id, spec: { argv: spec.argv, cwd: spec.cwd, env,
          graceMs: spec.graceMs, stdio: spec.stdio } }))
        admitted.resolve()
        for (;;) {
          if (stopping || this.disposed || spec.signal?.aborted) {
            await this.call('process', 'stop', { id }); return { exitCode: null, signal: 'SIGTERM' as const }
          }
          const result = nativeProcessObservation.parse(await this.call('process', 'poll', { id, stdoutOffset: outOffset, stderrOffset: errOffset, controlOffset }))
          if (result.stdout.lossy && stdout || result.stderr.lossy && stderr || result.control.lossy && control) throw new Error('native_process_pipe_output_lost')
          outLost ||= result.stdout.lossy; errLost ||= result.stderr.lossy
          const out = Buffer.from(result.stdout.data, 'base64'), err = Buffer.from(result.stderr.data, 'base64')
          if (stdout && out.length && !stdout.write(out)) await this.waitOutputDrain(stdout, interrupted.signal)
          if (stderr && err.length && !stderr.write(err)) await this.waitOutputDrain(stderr, interrupted.signal)
          stdoutCollector?.push(out); stderrCollector?.push(err)
          if (spec.stdio.stdout === 'inherit') process.stdout.write(out)
          if (spec.stdio.stderr === 'inherit') process.stderr.write(err)
          const controlBytes = Buffer.from(result.control.data, 'base64')
          if (control && controlBytes.length && !control.push(controlBytes)) await this.waitCredit(readCredit.promise, interrupted.signal)
          if (result.control.ended) control?.push(null)
          outOffset = result.stdout.nextOffset; errOffset = result.stderr.nextOffset; controlOffset = result.control.nextOffset
          if (result.state === 'failed') throw new Error(result.error ?? 'native_process_failed')
          if (result.state === 'completed' && result.stdout.exhausted && result.stderr.exhausted && result.control.exhausted) {
            if (!result.outcome) throw new Error('native_process_outcome_missing')
            return { exitCode: result.outcome.exitCode, signal: result.outcome.signal as NodeJS.Signals | null }
          }
          await delay(this.client.config.pollMs)
        }
      } catch (error) {
        admitted.reject(error)
        try { await this.call('process', 'stop', { id }) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native process failed and its exact stop is unconfirmed') }
        throw error
      } finally {
        spec.signal?.removeEventListener('abort', abort)
        try {
          await channelWork.catch(() => undefined)
          await this.call('process', 'release', { id })
        } finally {
          admitted.reject(new Error('Native process finished before admission'))
          stdout?.end(); stderr?.end(); stdin?.destroy(); control?.push(null); stdoutCollector?.seal(); stderrCollector?.seal(); exited.resolve()
        }
      }
    })()
    void admitted.promise.catch(() => {})
    const reader = (collector: OutputCollector, lost: () => boolean) => ({ readFrom(offset: number) { const result = collector.readFrom(offset); return { ...result, lossy: result.lossy || lost() } } })
    const handle: SubprocessHandle = { stdin, stdout, stderr, control, done,
      collected: { ...(stdoutCollector ? { stdout: reader(stdoutCollector, () => outLost) } : {}), ...(stderrCollector ? { stderr: reader(stderrCollector, () => errLost) } : {}) },
      terminate: abort,
      async waitForExit(signal?: AbortSignal) {
        if (signal?.aborted) return false
        const cancelled = Promise.withResolvers<boolean>(), cancel = () => { cancelled.resolve(false) }
        signal?.addEventListener('abort', cancel, { once: true })
        try { return await Promise.race([cancelled.promise, exited.promise.then(async () => { await done; return true })]) }
        finally { signal?.removeEventListener('abort', cancel) }
      },
    }
    this.live.add(handle); void done.then(() => { this.live.delete(handle) }, () => { this.live.delete(handle) }); return handle
  }
  private waitCredit(credit: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => { signal.removeEventListener('abort', finish); resolve() }
      signal.addEventListener('abort', finish, { once: true })
      void credit.then(finish)
      if (signal.aborted) finish()
    })
  }
  private waitOutputDrain(stream: PassThrough, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const drain = () => { cleanup(); resolve() }, closed = () => { cleanup(); reject(new Error('Native process output closed')) }
      const cleanup = () => { stream.off('drain', drain); stream.off('close', closed); signal.removeEventListener('abort', drain) }
      stream.once('drain', drain); stream.once('close', closed); signal.addEventListener('abort', drain, { once: true })
      if (signal.aborted) drain()
    })
  }
  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) {
    if (!command || !posix.isAbsolute(command) && command.includes('/')) throw new Error('native_cloud_invalid_executable')
    const handle = this.spawn({ argv: ['/usr/bin/python3', '-I', '-B', '-c', 'import shutil,sys; p=shutil.which(sys.argv[1]); print(p or ""); sys.exit(0 if p else 127)', command], cwd: '/workspace', env, signal, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    const outcome = await handle.done, path = handle.collected.stdout?.readFrom(0).text.trim()
    if (outcome.exitCode !== 0 || !path) throw new SubprocessExecutableNotFoundError('Executable not found in native world.')
    return path
  }
  override async terminalEnvironment(signal?: AbortSignal) { signal?.throwIfAborted(); return { platform: 'posix' as const, defaultShell: '/bin/bash' } }
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposed) throw new Error('native_world_subprocess_disposed')
    const reservation = Promise.withResolvers<void>()
    this.pending.add(reservation.promise)
    const id = randomUUID(), output = new PassThrough()
    const opening = Promise.withResolvers<void>()
    let allocationCleanup: Promise<unknown> | undefined
    const cancel = () => { allocationCleanup ??= opening.promise.then(() => this.call('terminal', 'stop', { id })); void allocationCleanup.catch(() => {}) }
    this.allocationStops.add(cancel); spec.signal?.addEventListener('abort', cancel, { once: true })
    try {
      spec.signal?.throwIfAborted()
      const { signal: _signal, ...body } = spec
      let accepted: { id: string; pid: number }
      try { accepted = z.object({ id: z.uuid(), pid: z.number().int().positive() }).strict().parse(await this.call('terminal', 'start', { id, spec: body })) } finally { opening.resolve() }
      this.allocationStops.delete(cancel); spec.signal?.removeEventListener('abort', cancel)
      const interrupted = new AbortController()
      let closing = false, stopWork: Promise<void> | undefined
      const operations = new Set<Promise<unknown>>()
      const operation = <T>(path: string, data: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
        if (closing) return Promise.reject(new Error('Native terminal is closing'))
        const work = this.call('terminal', path, { id, ...data }).then(reply => schema.parse(reply))
        operations.add(work); void work.then(() => { operations.delete(work) }, () => { operations.delete(work) }); return work
      }
      const stop = () => {
        closing = true; interrupted.abort()
        return stopWork ??= (async () => { await this.call('terminal', 'stop', { id }); await Promise.allSettled([...operations]) })()
      }
      const onAbort = () => { void stop().catch(() => {}) }
      spec.signal?.addEventListener('abort', onAbort, { once: true })
      const done: Promise<SubprocessOutcome> = (async () => {
        let offset = 0
        try {
          for (;;) {
            if (closing || this.disposed) { await stop(); return { exitCode: null, signal: 'SIGTERM' } }
            const current = nativeTerminalObservation.parse(await this.call('terminal', 'poll', { id, outputOffset: offset }))
            if (current.output.lossy) throw new Error('Native terminal output was lost')
            const data = Buffer.from(current.output.data, 'base64')
            if (data.length && !output.write(data)) await this.waitOutputDrain(output, interrupted.signal)
            offset = current.output.nextOffset
            if (current.state === 'failed') throw new Error(current.error ?? 'Native terminal failed')
            if (current.state === 'completed' && current.output.exhausted) {
              if (!current.outcome) throw new Error('Native terminal outcome unavailable')
              return { exitCode: current.outcome.exitCode, signal: current.outcome.signal as NodeJS.Signals | null }
            }
            await delay(this.client.config.pollMs)
          }
        } catch (error) { await stop(); throw error }
        finally { spec.signal?.removeEventListener('abort', onAbort); try { await this.call('terminal', 'release', { id }) } finally { output.end() } }
      })()
      const terminal: SubprocessTerminalHandle = { pid: accepted.pid, output, done,
        write: async (data) => { await operation('write', { data: Buffer.from(data).toString('base64') }, z.unknown()) },
        resize: async (cols, rows) => { await operation('resize', { cols, rows }, z.unknown()) },
        inspectForeground: async () => { const value = await operation('foreground', {}, z.object({ processGroupId: z.number().int().positive(), inputWaiting: z.boolean() }).strict().nullable()); return value ?? undefined },
        inspectActivity: () => operation('activity', {}, z.object({ state: z.enum(['idle', 'busy', 'unknown']), revision: z.number().int().nonnegative() }).strict()),
        signalForeground: value => operation('signal', { signal: value }, z.number().int().positive()),
        terminate: async () => { await stop(); await done.catch(() => undefined) },
      }
      this.live.add(terminal); void done.then(() => { this.live.delete(terminal) }, () => { this.live.delete(terminal) })
      if (this.disposed || spec.signal?.aborted) { await terminal.terminate(); throw new Error('Native terminal allocation cancelled') }
      return terminal
    } catch (error) { opening.resolve(); await this.call('terminal', 'stop', { id }); await this.call('terminal', 'release', { id }); output.end(); throw error }
    finally { this.allocationStops.delete(cancel); spec.signal?.removeEventListener('abort', cancel); try { await allocationCleanup } finally { reservation.resolve(); this.pending.delete(reservation.promise) } }
  }
}

class HttpSandbox extends SandboxProvider {
  constructor(ctx: Context, private readonly client: ClientConfig) { super(ctx) }
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const world = this.client.world
    if (policy.mode !== world.mode || policy.workspaceRoot !== world.workspaceRoot || policy.sessionId !== undefined && policy.sessionId !== world.sessionId) throw new Error('native_cloud_policy_generation_changed')
    return { argv: ['@power-evolve/native-world-policy', world.worldId, world.mode, String(world.permissionGeneration), ...argv], enforcement: 'full' as const,
      denialSignatures: ['Read-only file system', 'Permission denied'], runnerFailureRules: [] }
  }
}

/** Original-world services with explicitly observable joined cleanup. */
export interface NativeExecutionHttpBinding extends NativeExecutionBinding {
  /** Explicit joined cleanup whose failure cannot be swallowed by Cordis effect disposal. */
  close(): Promise<void>
}
/** Mount credential-free Runtime clients using only one original Agent operation bearer.
 * @param ctx Private binding lifetime owner.
 * @param world Server-issued original-Agent world.
 * @param token Original operation bearer retained by the trusted Runtime.
 * @param transport Bounded Platform HTTP transport; no retry of mutations or submissions.
 * @param config Explicit polling and output limits.
 * @returns Native services usable by the common provider resolver.
 */
export function createNativeExecutionHttpBinding(ctx: Context, world: NativeExecutionWorld, token: string,
  transport: NativeExecutionHttpTransport, config: NativeExecutionHttpConfig): NativeExecutionHttpBinding {
  const client = { world, token, transport, config }, filesystem = new HttpFileSystem(ctx, client), subprocess = new HttpSubprocess(ctx, client)
  let closeWork: Promise<void> | undefined
  const close = () => closeWork ??= (async () => {
    const results = await Promise.allSettled([filesystem.close(), subprocess.close()])
    const failures: unknown[] = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Native HTTP binding cleanup failed')
  })()
  ctx.effect(() => close, 'native HTTP binding explicit cleanup')
  return { world, filesystem, subprocess, sandbox: new HttpSandbox(ctx, client), close }
}
