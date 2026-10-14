/** Trusted Platform broker: native Fs and Subprocess share storage while payloads run in separate gVisor ranges. */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion as fsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditRequest, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { PassThrough, Duplex } from 'node:stream'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { nativeFsInfo as infoSchema, nativeFsPathInfo as pathInfoSchema, nativeFsTarget as targetSchema,
  nativeFsWrite as writeResultSchema, nativeFsEdit as editResultSchema } from '../native-execution/wire.ts'
import type { NativeExecutionBinding, NativeExecutionWorld } from '../native-execution/types.ts'
import type { NativeExecutionAuthorityStore } from './native-execution-authority-store.ts'
import { NativeExecutionPods, type NativeExecutionPod } from './native-execution-pods.ts'

const POLICY_MARKER = '@power-evolve/native-world-policy'
const entriesSchema = z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']),
  target: targetSchema, version: z.string().optional(), size: z.number().optional() }).strict())
const fsReply = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
    'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED',
    'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED']), message: z.string() }).strict()])
import { decodeNativeFsStream, ownNativeFsStream } from '../native-execution/fs-stream.ts'
import { NativeExecutionRelay } from './native-execution-relay.ts'


/** Platform-only transport settings, with explicit process and wire bounds. */
export interface NativeExecutionBrokerConfig {
  kubectlExecutable: string
  kubeconfigPath: string
  fsWorkerPath: string
  processWorkerPath: string
  maxRequestBytes: number
  maxReplyBytes: number
  maxProcessMs: number
  authorityPollMs: number
  transportGraceMs: number
}

/** Trusted control transport never executes model-controlled argv in the Platform process. */
export class NativeExecutionBroker {
  private readonly live = new Set<SubprocessHandle | SubprocessTerminalHandle>()
  private readonly pending = new Set<Promise<void>>()
  private readonly pendingCancels = new Set<() => void>()
  private readonly cleanupFailures: unknown[] = []
  private disposed = false
  constructor(readonly authority: NativeExecutionAuthorityStore, readonly pods: NativeExecutionPods,
    private readonly transport: SubprocessRuntime, readonly config: NativeExecutionBrokerConfig) {}

  /** Mount already-issued, original-Agent-bound native services in a private Context.
   * @param ctx Service lifetime owner; never shared with another Agent binding.
   * @param token Original operation bearer, retained only by trusted control code.
   * @param world Platform-issued execution identity.
   * @returns Fs, Subprocess and Sandbox implementations in the same frozen world.
   */
  binding(ctx: Context, token: string, world: NativeExecutionWorld): NativeExecutionBinding {
    const config = { broker: this, token, world }
    const filesystem = new BoundFileSystem(ctx, config), subprocess = new BoundSubprocess(ctx, config),
      sandbox = new BoundSandbox(ctx, config)
    return { world, filesystem, subprocess, sandbox }
  }

  private isDisposed(): boolean { return this.disposed }

  /** Run one native filesystem request, waiting for the precise worker Pod to stop before returning.
   * @param token Original operation bearer.
   * @param world Captured Agent identity.
   * @param request Native filesystem wire operation.
   * @param schema Expected reply fields.
   * @param signal Cancels execution and joins the original Pod.
   * @returns Native result; writes are dispatched once and never retried.
   */
  async filesystem<T>(token: string, world: NativeExecutionWorld, request: unknown, schema: z.ZodType<T>,
    signal?: AbortSignal): Promise<T> {
    const data = JSON.stringify(request)
    if (Buffer.byteLength(data) > this.config.maxRequestBytes) throw new FsError('Filesystem request exceeds its byte bound.',
      'FS_TOO_LARGE')
    const operation = z.object({ op: z.string() }).loose().parse(request).op
    const storageRead = operation !== 'writeText' && operation !== 'editText'
    const apply = async () => {
      const handle = this.spawn(token, world, { argv: ['node', this.config.fsWorkerPath], cwd: '/workspace',
        stdio: { stdin: { data }, stdout: { maxBytes: this.config.maxReplyBytes }, stderr: { maxBytes: 4096 } },
        graceMs: this.config.transportGraceMs, signal }, 'filesystem', storageRead)
      const result = await handle.done
      if (result.exitCode !== 0) throw new FsError('Filesystem worker did not complete.', signal?.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR',
        { cause: new Error(handle.collected.stderr?.readFrom(0).text ?? 'No worker diagnostic was retained.') })
      const output = handle.collected.stdout?.readFrom(0)
      if (!output || output.lossy) throw new FsError('Filesystem reply exceeds its byte bound.', 'FS_TOO_LARGE')
      const envelope = fsReply.parse(JSON.parse(output.text))
      if (!envelope.ok) throw new FsError(envelope.message, envelope.code)
      return schema.parse(envelope.value)
    }
    if (storageRead) return await apply()
    const target = z.object({ target: z.object({ targetKey: z.string() }).loose() }).loose().parse(request).target
    return await this.authority.mutate(token, world, target.targetKey, apply)
  }

  /** Open the fixed native text reader in its own credential-free original range.
   * @param token Original Agent bearer.
   * @param world Captured storage world.
   * @param target Canonical target without the external world-key prefix.
   * @param signal Caller cancellation, joined before reader release.
   * @param admissionId Original optional HTTP nonce for cleanup after reply loss.
   * @returns Native raw stream handle; callers must close and join it on iterator return.
   */
  openFilesystemStream(token: string, world: NativeExecutionWorld, target: { targetKey: string; displayPath: string },
    signal?: AbortSignal, admissionId?: string): SubprocessHandle {
    const data = JSON.stringify({ op: 'streamText', target })
    return this.spawn(token, world, { argv: ['node', this.config.fsWorkerPath], cwd: '/workspace', signal,
      stdio: { stdin: { data }, stdout: 'pipe', stderr: { maxBytes: this.config.maxReplyBytes } },
      graceMs: this.config.transportGraceMs }, 'filesystem', true, admissionId)
  }

  /** Start one exact Pod-managed process and return native streams immediately.
   * @param token Original bearer.
   * @param world Captured Agent world.
   * @param spec Fully specified native spawn request.
   * @param kind Durable process classification.
   * @param storageRead Allows only the fixed native filesystem utility to initialize storage before the first claimed step.
   * @param admissionId Original caller nonce persisted as the immutable process identity.
   * @returns Deferred native handle; outcome waits for whole-Pod quiescence.
   */
  spawn(token: string, world: NativeExecutionWorld, spec: SubprocessSpawnSpec,
    kind: 'process' | 'filesystem' = 'process', storageRead = false, admissionId?: string): SubprocessHandle {
    if (this.isDisposed()) throw new Error('native_execution_broker_disposed')
    spec.signal?.throwIfAborted()
    const argv = this.unwrap(world, spec.argv)
    this.cwd(spec.cwd)
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) throw new Error('native_cloud_invalid_grace')
    const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const ready = Promise.withResolvers<NativeExecutionRelay>(), stopped = Promise.withResolvers<void>()
    let relay: NativeExecutionRelay | undefined, range: NativeExecutionPod | undefined, local: SubprocessHandle | undefined
    let stopCause: 'abort' | 'authority' | 'dispose' | 'completed' | 'failure' | undefined
    let stopping: Promise<void> | undefined
    const currentCause = (): typeof stopCause => stopCause
    const stop = (cause: NonNullable<typeof stopCause>) => {
      stopCause ??= cause
      const original = range, causeAtStop = stopCause
      if (original && !stopping) stopping = (async () => {
        if (stopCause !== 'completed' && relay) {
          await this.settleWithin(relay.terminate(), spec.graceMs)
          await this.settleWithin(relay.done, spec.graceMs)
        }
        try { await this.pods.stop(original, causeAtStop) }
        finally {
          relay?.interrupt(); local?.terminate()
          if (local) await local.waitForExit()
          await relay?.done.catch(() => undefined)
        }
      })()
      return stopping
    }
    const abort = () => { void stop('abort')?.catch(() => {}) }
    const control = spec.stdio.control === 'pipe' ? new Duplex({ read() {},
      write(chunk: Buffer, _encoding, callback) {
        ready.promise.then(remote => new Promise<void>((resolve, reject) => {
          if (!remote.control) { reject(new Error('Native control unavailable')); return }
          remote.control.write(chunk, (error?: Error | null) => { if (error) reject(error); else resolve() })
        })).then(() => { callback() },
          (error: unknown) => { callback(error instanceof Error ? error : new Error('Native control write failed', { cause: error })) })
      }, final(callback) {
        ready.promise.then(remote => new Promise<void>((resolve) => { remote.control?.end(resolve) }))
          .then(() => { callback() }, callback)
      },
    }) : undefined
    spec.signal?.addEventListener('abort', abort, { once: true })
    const done = (async () => {
      let monitor: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined
      let authorityWork: Promise<void> | undefined
      try {
        const assert = () => this.authority.assert(token, world, storageRead ? 'storage-read' : 'execution')
        const binding = await assert()
        if (currentCause() || spec.signal?.aborted || this.isDisposed()) return { exitCode: null, signal: 'SIGTERM' as const }
        range = await this.pods.create(world, binding, kind, { argv, cwd: spec.cwd, env: spec.env, stdio: spec.stdio }, assert, admissionId)
        if (currentCause() || spec.signal?.aborted || this.isDisposed()) { await stop(currentCause() ?? 'abort'); return { exitCode: null,
          signal: 'SIGTERM' as const } }
        await assert()
        local = this.transport.spawn({ argv: this.processArgv(range, argv, spec), cwd: '/',
          env: this.transportEnvironment(), graceMs: this.config.transportGraceMs,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.config.maxReplyBytes } } })
        relay = new NativeExecutionRelay(local, spec, this.config.maxRequestBytes)
        ready.resolve(relay)
        stdin?.pipe(relay.stdin ?? new PassThrough())
        relay.stdout?.pipe(stdout ?? new PassThrough())
        relay.stderr?.pipe(stderr ?? new PassThrough())
        if (control && relay.control) {
          relay.control.on('data', (chunk: Buffer) => { if (!control.push(chunk)) relay?.control?.pause() })
          control.on('resume', () => { relay?.control?.resume() })
          relay.control.on('end', () => { control.push(null) })
        }
        monitor = setInterval(() => {
          if (authorityWork) return
          authorityWork = assert().then(() => undefined, async () => { await stop('authority') })
            .finally(() => { authorityWork = undefined })
          void authorityWork.catch(() => {})
        }, this.config.authorityPollMs)
        deadline = setTimeout(abort, this.config.maxProcessMs)
        let outcome: Awaited<SubprocessHandle['done']>
        try { outcome = await relay.done }
        catch (error) { if (!currentCause()) throw error; outcome = { exitCode: null, signal: 'SIGTERM' } }
        await stop(currentCause() ?? 'completed')
        if (currentCause() === 'authority') throw new Error('native_world_authority_lost')
        const result = currentCause() === 'abort' || currentCause() === 'dispose' ? { exitCode: null, signal: 'SIGTERM' as const } : outcome
        await this.pods.recordOutcome(range, result)
        return result
      } catch (error) {
        ready.reject(error)
        if (range) await stop(currentCause() ?? 'failure')
        throw error
      } finally {
        clearInterval(monitor); clearTimeout(deadline)
        spec.signal?.removeEventListener('abort', abort)
        try {
          await authorityWork
          local?.terminate()
          if (local) await local.waitForExit()
        } finally {
          ready.reject(new Error('Native process finished before admission'))
          stdin?.destroy(); stdout?.end(); stderr?.end(); control?.push(null)
          stopped.resolve()
        }
      }
    })()
    void ready.promise.catch(() => {})
    const handle: SubprocessHandle = { stdin, stdout, stderr, control, done,
      collected: {
        ...(typeof spec.stdio.stdout === 'object' ? { stdout: { readFrom(offset: number) {
          return relay?.collected.stdout?.readFrom(offset) ?? { text: '', nextOffset: 0, lossy: false }
        } } } : {}),
        ...(typeof spec.stdio.stderr === 'object' ? { stderr: { readFrom(offset: number) {
          return relay?.collected.stderr?.readFrom(offset) ?? { text: '', nextOffset: 0, lossy: false }
        } } } : {}),
      },
      terminate: abort,
      async waitForExit(signal?: AbortSignal) {
        if (signal?.aborted) return false
        const cancelled = Promise.withResolvers<boolean>()
        const cancel = () => { cancelled.resolve(false) }
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          return await Promise.race([cancelled.promise, stopped.promise.then(async () => { if (stopping) await stopping; return true })])
        } finally { signal?.removeEventListener('abort', cancel) }
      },
    }
    this.live.add(handle)
    void done.then(() => { this.live.delete(handle) }, () => { this.live.delete(handle) })
    return handle
  }

  /** Allocate an actual guest PTY; all asynchronous inspection/write calls are retained until whole-range termination.
   * @param token Original bearer.
   * @param world Captured Agent world.
   * @param spec Native terminal specification.
   * @param admissionId Original caller nonce for restart-safe exact cleanup.
   * @returns Guest PID, raw terminal output, actual foreground operations and exact joined Pod cleanup.
   */
  async terminal(token: string, world: NativeExecutionWorld, spec: SubprocessTerminalSpawnSpec,
    admissionId?: string): Promise<SubprocessTerminalHandle> {
    if (this.isDisposed()) throw new Error('native_execution_broker_disposed')
    const reservation = Promise.withResolvers<void>()
    this.pending.add(reservation.promise)
    try {
      spec.signal?.throwIfAborted()
      const argv = this.unwrap(world, spec.argv)
      this.cwd(spec.cwd)
      const assert = () => this.authority.assert(token, world), binding = await assert()
      const range = await this.pods.create(world, binding, 'terminal', { argv, cwd: spec.cwd, env: spec.env }, assert, admissionId)
      let local: SubprocessHandle | undefined, relay: NativeExecutionRelay | undefined
      const cancelled = Promise.withResolvers<never>()
      void cancelled.promise.catch(() => {})
      let allocationStop: Promise<void> | undefined
      const cancelAllocation = () => {
        cancelled.reject(new Error('native_execution_terminal_allocation_cancelled'))
        allocationStop ??= (async () => {
          try { await this.pods.stop(range, this.disposed ? 'dispose' : 'abort') }
          catch (error) { this.cleanupFailures.push(error); throw error }
          finally {
            relay?.interrupt(); local?.terminate(); if (local) await local.waitForExit()
            await relay?.done.catch(() => undefined)
          }
        })()
        void allocationStop.catch(() => {})
      }
      this.pendingCancels.add(cancelAllocation)
      spec.signal?.addEventListener('abort', cancelAllocation, { once: true })
      try {
        await assert()
        if (this.isDisposed() || spec.signal?.aborted) throw new Error('native_execution_terminal_allocation_cancelled')
        local = this.transport.spawn({ argv: this.processArgv(range, argv, spec), cwd: '/', env: this.transportEnvironment(),
          graceMs: this.config.transportGraceMs, stdio: { stdin: 'pipe', stdout: 'pipe',
            stderr: { maxBytes: this.config.maxReplyBytes } } })
        relay = new NativeExecutionRelay(local, { stdio: { stdin: 'ignore', stdout: 'pipe',
          stderr: { maxBytes: this.config.maxReplyBytes } } }, this.config.maxRequestBytes)
        const pid = await Promise.race([relay.ready, cancelled.promise]), remote = relay, transport = local
        if (this.isDisposed() || spec.signal?.aborted) { cancelAllocation(); await allocationStop
          throw new Error('native_execution_terminal_allocation_cancelled') }
        this.pendingCancels.delete(cancelAllocation); spec.signal?.removeEventListener('abort', cancelAllocation)
        const operations = new Set<Promise<unknown>>()
        let stopping: Promise<void> | undefined, closing = false, authorityWork: Promise<void> | undefined
        const stop = (cause: 'abort' | 'authority' | 'dispose' | 'completed' | 'failure') => {
          closing = true
          return stopping ??= (async () => {
            if (cause !== 'completed') { await this.settleWithin(remote.terminate(), spec.graceMs)
              await this.settleWithin(remote.done, spec.graceMs) }
            try { await this.pods.stop(range, cause) }
            finally {
              remote.interrupt(); transport.terminate(); await transport.waitForExit()
              await remote.done.catch(() => undefined)
              await Promise.allSettled([...operations])
            }
          })()
        }
        const isClosing = (): boolean => closing
        const tracked = <T>(fn: () => Promise<T>): Promise<T> => {
          if (closing) return Promise.reject(new Error('Native terminal is closing'))
          const operation = (async () => { await assert(); if (isClosing()) throw new Error('Native terminal is closing')
            return await fn() })()
          operations.add(operation); void operation.then(() => { operations.delete(operation) }, () => { operations.delete(operation) })
          return operation
        }
        const monitor = setInterval(() => {
          if (authorityWork || closing) return
          authorityWork = assert().then(() => undefined,
            async () => { await stop('authority') }).finally(() => { authorityWork = undefined })
          void authorityWork.catch(() => {})
        }, this.config.authorityPollMs)
        const deadline = setTimeout(() => { void stop('abort').catch(() => {}) }, this.config.maxProcessMs)
        const done = (async () => {
          try {
            const result = await remote.done
            await stop('completed'); await this.pods.recordOutcome(range, result); return result
          } catch (error) { await stop('failure'); throw error }
          finally { clearInterval(monitor); clearTimeout(deadline); await authorityWork }
        })()
        const output = remote.stdout
        if (!output) throw new Error('Native terminal output unavailable')
        const terminal: SubprocessTerminalHandle = { pid, output, done,
          write: data => tracked(() => remote.write(data)), resize: (cols, rows) => tracked(() => remote.resize(cols, rows)),
          inspectForeground: () => tracked(() => remote.inspectForeground()),
          inspectActivity: () => tracked(() => remote.inspectActivity()),
          signalForeground: signal => tracked(() => remote.signalForeground(signal)),
          terminate: () => stop('abort'),
        }
        this.live.add(terminal); void done.then(() => { this.live.delete(terminal) }, () => { this.live.delete(terminal) })
        if (this.isDisposed() || spec.signal?.aborted) { await stop('dispose')
          throw new Error('native_execution_terminal_allocation_cancelled') }
        return terminal
      } catch (error) {
        try { await (allocationStop ??= this.pods.stop(range, 'failure')) }
        finally {
          relay?.interrupt(); local?.terminate(); if (local) await local.waitForExit()
          await relay?.done.catch(() => undefined)
        }
        throw error
      } finally { this.pendingCancels.delete(cancelAllocation); spec.signal?.removeEventListener('abort', cancelAllocation) }
    } finally { reservation.resolve(); this.pending.delete(reservation.promise) }
  }

  private async settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })]) }
    finally { clearTimeout(timer) }
  }

  private processArgv(range: NativeExecutionPod, argv: readonly string[],
    spec: SubprocessSpawnSpec | SubprocessTerminalSpawnSpec): string[] {
    const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent', LANG: 'C.UTF-8' }
    for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) Reflect.deleteProperty(env, key)
    else env[key] = value }
    const terminal = 'terminalType' in spec
    const request = JSON.stringify({ argv, cwd: spec.cwd, env, graceMs: spec.graceMs, terminal,
      maxFrameBytes: this.config.maxRequestBytes, ...(terminal ? { rows: spec.rows, cols: spec.cols,
        terminalType: spec.terminalType, shellActivity: spec.shellActivity === true }
        : { stdin: typeof spec.stdio.stdin === 'object' ? 'pipe' : spec.stdio.stdin, control: spec.stdio.control === 'pipe' }) })
    if (Buffer.byteLength(request) > this.config.maxRequestBytes) throw new Error('native_cloud_invalid_process_request')
    return [this.config.kubectlExecutable, '--kubeconfig', this.config.kubeconfigPath, '--namespace', this.pods.config.namespace,
      'exec', '-i', range.name, '-c', 'payload', '--', '/usr/bin/python3', '-I', '-B', this.config.processWorkerPath, request]
  }

  /** Close new admission and cancel retained unpublished PTY allocations synchronously. */
  closeAdmission(): void {
    this.disposed = true
    for (const cancel of this.pendingCancels) cancel()
    for (const handle of this.live) {
      const stopped = Promise.resolve(handle.terminate())
      void stopped.catch((error: unknown) => { this.cleanupFailures.push(error) })
    }
  }

  /** Join every live exact managed range before releasing trusted transport ownership. */
  async dispose(): Promise<void> {
    this.closeAdmission()
    await Promise.all([...this.pending])
    const results = await Promise.allSettled([...this.live].map(async (handle) => {
      await handle.terminate()
      if ('waitForExit' in handle) await handle.waitForExit()
      await handle.done.catch(() => undefined)
    }))
    const failures: unknown[] = [...this.cleanupFailures,
      ...results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)]
    if (failures.length) throw new AggregateError(failures, 'Native execution broker disposal failed')
  }

  private cwd(path: string) {
    const resolved = posix.resolve(path)
    if (!['/workspace', '/home/agent', '/tmp'].some(root => resolved === root || resolved.startsWith(root + '/'))) {
      throw new Error('native_cloud_cwd_outside_world')
    }
  }
  private unwrap(world: NativeExecutionWorld, argv: readonly string[]) {
    if (argv[0] !== POLICY_MARKER) return [...argv]
    if (argv[1] !== world.worldId || argv[2] !== world.mode || argv[3] !== String(world.permissionGeneration) || argv.length < 5) {
      throw new Error('native_cloud_policy_generation_changed')
    }
    return argv.slice(4)
  }
  private transportEnvironment() {
    return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', KUBECONFIG: this.config.kubeconfigPath }
  }

}

interface BoundConfig { broker: NativeExecutionBroker; token: string; world: NativeExecutionWorld }

class BoundFileSystem extends FileSystem {
  private isDisposed(): boolean { return this.disposed }
  private readonly readers = new Set<SubprocessHandle>()
  private readonly calls = new Set<Promise<unknown>>()
  private disposed = false
  constructor(ctx: Context, private readonly binding: BoundConfig) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposed = true
      const stops = [...this.readers].map(async (handle) => { handle.terminate(); await handle.waitForExit() })
      const joined = await Promise.allSettled([...stops, ...this.calls])
      const failed = joined.filter(result => result.status === 'rejected' && !(result.reason instanceof FsError))
        .map(result => (result as PromiseRejectedResult).reason as unknown)
      if (failed.length) throw new AggregateError(failed, 'Native filesystem disposal failed')
    }, 'native filesystem lifetime')
  }
  override get sandboxMode() { return this.binding.world.mode }
  private key(path: string) { return FsTargetKey(this.binding.world.worldId + ':' + path) }
  private target(target: FsTarget) {
    const prefix = this.binding.world.worldId + ':'
    if (!target.targetKey.startsWith(prefix)) throw new FsError('Target belongs to another execution world.', 'FS_PERMISSION_DENIED')
    return { targetKey: target.targetKey.slice(prefix.length), displayPath: target.displayPath }
  }
  private call<T>(request: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
    if (this.isDisposed()) return Promise.reject(new FsError('Native filesystem is closed.', 'FS_ABORTED'))
    const work = this.binding.broker.filesystem(this.binding.token, this.binding.world, request, schema, signal)
    this.calls.add(work); void work.then(() => { this.calls.delete(work) }, () => { this.calls.delete(work) }); return work
  }
  private mutation(policy?: SandboxExecutionPolicy) {
    const world = this.binding.world
    if (world.mode === 'read-only' || policy && (policy.mode !== world.mode || policy.workspaceRoot !== world.workspaceRoot
      || policy.sessionId !== undefined && policy.sessionId !== world.sessionId)) throw new FsError('Native world policy denied the mutation.', 'FS_SANDBOX_DENIED')
  }
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
    const result = await this.call({ op: 'resolve', path, cwd: opts?.cwd ?? '/workspace' }, targetSchema, opts?.signal)
    return { targetKey: this.key(result.targetKey), displayPath: result.displayPath }
  }
  override processPath(target: FsTarget) { return this.target(target).targetKey }
  override fileUrl(target: FsTarget) { return pathToFileURL(this.processPath(target)).href }
  override contains(parent: FsTarget, child: FsTarget) {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
  }
  override async stat(target: FsTarget, signal?: AbortSignal) {
    const result = await this.call({ op: 'stat', target: this.target(target) }, infoSchema.nullable(), signal)
    return result === null ? undefined : { version: fsVersion(result.version), type: result.type,
      ...(result.size === undefined ? {} : { size: result.size }) }
  }
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    const result = await this.call({ op: 'lstat', path, cwd: opts?.cwd ?? '/workspace' }, pathInfoSchema.nullable(), signal)
    return result === null ? undefined : { version: fsVersion(result.version), type: result.type,
      ...(result.size === undefined ? {} : { size: result.size }) }
  }
  override readText(target: FsTarget, signal?: AbortSignal) { return this.call({ op: 'readText', target: this.target(target) },
    z.string(), signal) }
  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (this.isDisposed()) return Promise.reject(new FsError('Native filesystem is closed.', 'FS_ABORTED'))
    const maximum = this.binding.broker.config.maxReplyBytes,
      handle = this.binding.broker.openFilesystemStream(this.binding.token, this.binding.world, this.target(target), signal)
    this.readers.add(handle)
    let closeWork: Promise<void> | undefined
    const close = () => closeWork ??= (async () => {
      try { handle.terminate(); await handle.waitForExit(); await handle.done.catch(() => undefined) }
      finally { this.readers.delete(handle) }
    })()
    const source = (async function* () {
      try {
        if (!handle.stdout) throw new FsError('Native text reader has no output.', 'FS_IO_ERROR')
        for await (const chunk of decodeNativeFsStream(handle.stdout, maximum, signal)) yield chunk
        const outcome = await handle.done
        if (outcome.exitCode !== 0) throw new FsError('Native text reader failed.', 'FS_IO_ERROR')
      } finally { await close() }
    })()
    return Promise.resolve(ownNativeFsStream(source, close))
  }
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) {
    return Buffer.from(await this.call({ op: 'readBytes', target: this.target(target), maxBytes }, z.base64(), signal), 'base64')
  }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal) {
    return Buffer.from(await this.call({ op: 'readRange', target: this.target(target), offset: range.offset, length: range.length }, z.base64(), signal), 'base64')
  }
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await this.call({ op: 'listDir', target: this.target(target) }, entriesSchema, signal)
    return entries.map(entry => ({ name: entry.name, type: entry.type,
      target: { targetKey: this.key(entry.target.targetKey), displayPath: entry.target.displayPath },
      ...(entry.version === undefined ? {} : { version: fsVersion(entry.version) }),
      ...(entry.size === undefined ? {} : { size: entry.size }) }))
  }
  override writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    this.mutation(policy)
    return this.call({ op: 'writeText', target: this.target(target), content, ...(expected === undefined ? {} : { expected }) },
      writeResultSchema.transform(result => ({ ...result, version: fsVersion(result.version) })), signal)
  }
  override editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal,
    policy?: SandboxExecutionPolicy) {
    this.mutation(policy)
    return this.call({ op: 'editText', target: this.target(target), edit, ...(expected === undefined ? {} : { expected }) },
      editResultSchema.transform(result => ({ ...result, version: fsVersion(result.version) })), signal)
  }
}

class BoundSubprocess extends SubprocessRuntime {
  private isDisposed(): boolean { return this.disposed }
  private readonly allocationAbort = new AbortController()
  private readonly live = new Set<SubprocessHandle | SubprocessTerminalHandle>()
  private readonly pending = new Set<Promise<void>>()
  private disposed = false
  constructor(ctx: Context, private readonly binding: BoundConfig) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposed = true
      this.allocationAbort.abort()
      await Promise.all([...this.pending])
      await Promise.all([...this.live].map(async (handle) => { await handle.terminate()
        if ('waitForExit' in handle) await handle.waitForExit(); await handle.done.catch(() => undefined) }))
    }, 'native world subprocess teardown')
  }
  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) {
    if (!command || !posix.isAbsolute(command) && command.includes('/')) throw new Error('native_cloud_invalid_executable')
    const script = 'import os,sys,shutil; p=shutil.which(sys.argv[1]); print(p or ""); sys.exit(0 if p else 127)'
    const handle = this.spawn({ argv: ['/usr/bin/python3', '-I', '-B', '-c', script, command], cwd: '/workspace', env,
      signal, graceMs: this.binding.broker.config.transportGraceMs, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 } } })
    const result = await handle.done, path = handle.collected.stdout?.readFrom(0).text.trim()
    if (result.exitCode !== 0 || !path) throw new SubprocessExecutableNotFoundError('Executable not found in native world.')
    return path
  }
  override async terminalEnvironment(signal?: AbortSignal) { signal?.throwIfAborted()
    await this.binding.broker.authority.assert(this.binding.token, this.binding.world); return { platform: 'posix' as const,
      defaultShell: '/bin/bash' } }
  override spawn(spec: SubprocessSpawnSpec) {
    if (this.isDisposed()) throw new Error('native_world_subprocess_disposed')
    const handle = this.binding.broker.spawn(this.binding.token, this.binding.world, spec)
    this.live.add(handle); void handle.done.then(() => this.live.delete(handle), () => this.live.delete(handle)); return handle
  }
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec) {
    if (this.isDisposed()) throw new Error('native_world_subprocess_disposed')
    const reservation = Promise.withResolvers<void>()
    this.pending.add(reservation.promise)
    try {
      const handle = await this.binding.broker.terminal(this.binding.token, this.binding.world, { ...spec,
        signal: spec.signal ? AbortSignal.any([spec.signal, this.allocationAbort.signal]) : this.allocationAbort.signal })
      if (this.isDisposed()) { await handle.terminate(); throw new Error('native_world_subprocess_disposed') }
      this.live.add(handle); void handle.done.then(() => this.live.delete(handle), () => this.live.delete(handle)); return handle
    } finally { reservation.resolve(); this.pending.delete(reservation.promise) }
  }
}

class BoundSandbox extends SandboxProvider {
  constructor(ctx: Context, private readonly binding: BoundConfig) { super(ctx) }
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const world = this.binding.world
    await this.binding.broker.authority.assert(this.binding.token, world)
    if (policy.mode !== world.mode || policy.workspaceRoot !== world.workspaceRoot
      || policy.sessionId !== undefined && policy.sessionId !== world.sessionId) throw new Error('native_cloud_policy_generation_changed')
    return { argv: [POLICY_MARKER, world.worldId, world.mode, String(world.permissionGeneration), ...argv],
      enforcement: 'full' as const, denialSignatures: ['Read-only file system', 'Permission denied'], runnerFailureRules: [] }
  }
}
