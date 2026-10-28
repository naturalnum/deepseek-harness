/** Native services over the single Root command owner; no host launcher or account-selected backend. */
import type { Context } from '@deepseek-ai/cordis'
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellExecution,
  type ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessHandle, type SubprocessTerminalEnvironment,
  type SubprocessTerminalHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ManagedCommandOperation } from './command-operation.ts'
import { ManagedShellExecution, type ShellInterruption } from './shell-execution.ts'
import { ExecutionStateError } from './errors.ts'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** Root-resolved command defaults and actual image executable; no ambient cwd or environment fallback. */
export interface NativeExecutionConfig {
  /** Enable mandatory original-Session policy in Shell, Subprocess and signed native range preparation. */
  readonly enforceSessionFilePolicy?: boolean
  readonly bashPath: string
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxOutputBytes: number
  readonly graceMs: number
}

/** Account-restricted capability created by Root from the exact native binding, call and project. */
export interface NativeExecutionProviderPort {
  /** Present only on the original command owner that signs and enforces per-Session policy for all execution paths. */
  readonly enforcesSessionFilePolicy?: true | undefined
  /** @param caller Actual account service caller. */
  assertCurrent(caller: Context): void
  /** @param caller Actual native tool caller. @returns Its original registered project root. */
  projectRoot(caller: Context): string
  /**
   * @param caller Actual native caller. @param spec Complete native input.
   * @returns Reserved original operation before begin/publication.
   */
  create(caller: Context, spec: SubprocessSpawnSpec, policy?: SandboxExecutionPolicy): ManagedCommandOperation
  /** @param caller Actual native caller. @param operation Exact Root-owned original operation. */
  assertOperationCurrent(caller: Context, operation: ManagedCommandOperation): void
  /** @param operation Original operation to fence. @param cause Original failure to retain. Must not throw. */
  providerFailed(operation: ManagedCommandOperation, cause: unknown): void
  /** @returns Actual managed-range/I/O settlement after synchronously closing this provider's starts; uncertainty remains owned by Root. */
  closeProvider(): Promise<void>
}

const SHELL_TIMEOUT = 'PE_CLOUD_SHELL_TIMEOUT'

function unsupported(ctx: Context, port: NativeExecutionProviderPort, signal?: AbortSignal): never {
  port.assertCurrent(ctx); signal?.throwIfAborted()
  throw new ExecutionStateError('cloud/execution-unavailable', 'The selected cloud channel does not support this execution operation.')
}

function refuseUnsupported<Result>(ctx: Context, port: NativeExecutionProviderPort, signal?: AbortSignal): Promise<Result> {
  return new Promise(() => { unsupported(ctx, port, signal) })
}

function validateShell(spec: ShellExecSpec, config: NativeExecutionConfig): void {
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > config.maxTimeoutMs
    || !Number.isSafeInteger(spec.stdoutMaxBytes) || spec.stdoutMaxBytes < 1 || spec.stdoutMaxBytes > config.maxOutputBytes) {
    throw new RangeError('Cloud Shell timeout or collection exceeds its resolved limit.')
  }
  if (spec.sandboxPolicy !== undefined && config.enforceSessionFilePolicy !== true
    || spec.env !== undefined && Object.keys(spec.env).length > 0
    || spec.dshEnv !== undefined && Object.keys(spec.dshEnv).length > 0) {
    throw new ExecutionStateError('cloud/execution-unavailable', 'Cloud Shell requires the selected fixed environment and execution-world policy.')
  }
}

/** Shell's specified empty preparation-timeout result; it reports no fabricated subprocess exit. */
class PreparationTimedOutExecution implements ShellExecution {
  readonly observed
  private readonly actual = Promise.resolve()
  private readonly value: Promise<ShellRunResult>

  constructor(spec: ShellExecSpec, private readonly assertCurrent: () => void) {
    const reader = Object.freeze({ readFrom: (offset: number) => {
      assertCurrent()
      if (offset !== 0) throw new RangeError('An empty preparation result has only byte coordinate zero.')
      return { text: '', nextOffset: 0, lossy: false }
    } })
    this.observed = Object.freeze({ stdout: reader, stderr: reader })
    this.value = Promise.resolve({ exitCode: null, signal: null, timedOut: true, aborted: false,
      timeoutMs: spec.timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
  }

  get status(): 'killed' { this.assertCurrent(); return 'killed' }
  get exitCode(): null { this.assertCurrent(); return null }
  get signal(): null { this.assertCurrent(); return null }
  get done(): Promise<void> { this.assertCurrent(); return this.actual }
  kill(): boolean { this.assertCurrent(); return false }
  readOutput(): { delta: string; lossy: boolean } { this.assertCurrent(); return { delta: '', lossy: false } }
  result(): Promise<ShellRunResult> { this.assertCurrent(); return this.value }
}

/** Collected argv provider; unsupported consumers fail before any lookup or process allocation. */
export class CloudSubprocessRuntime extends SubprocessRuntime {
  /** @param ctx Original account provider scope. @param port Exact Root-issued native command capability. */
  constructor(ctx: Context, private readonly port: NativeExecutionProviderPort) {
    super(ctx)
    ctx.effect(() => () => port.closeProvider(), 'pe-opensandbox: stop and join native provider commands')
  }

  override resolveExecutable(_command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return refuseUnsupported(this.ctx, this.port, signal)
  }
  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return refuseUnsupported(this.ctx, this.port, signal)
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const operation = this.port.create(this.ctx, spec)
    operation.publish(); operation.begin()
    return operation.handle
  }
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return refuseUnsupported(this.ctx, this.port, spec.signal)
  }
}

/** Foreground Bash semantics over the same Root command controller used by native subprocess. */
export class CloudShellExecutor extends ShellExecutor {
  private readonly config: NativeExecutionConfig

  /**
   * @param ctx Original account provider scope. @param port Same Root owner as native subprocess.
   * @param config Explicit image/defaults/bounds.
   */
  constructor(ctx: Context, private readonly port: NativeExecutionProviderPort, config: NativeExecutionConfig) {
    super(ctx)
    for (const value of [config.timeoutMs, config.maxTimeoutMs, config.maxOutputBytes, config.graceMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Cloud Shell configuration requires finite positive bounds.')
    }
    if (!config.bashPath.startsWith('/') || config.bashPath.includes('\0')) throw new RangeError('Cloud Shell requires its verified image executable.')
    if (config.enforceSessionFilePolicy === true && port.enforcesSessionFilePolicy !== true) {
      throw new ExecutionStateError('cloud/invalid-config', 'Session file policy requires its original enforcing command owner.')
    }
    this.config = Object.freeze({ ...config })
  }

  override get sandboxMode(): SandboxMode | undefined {
    if (this.config.enforceSessionFilePolicy !== true) return undefined
    const policy = this.ctx.get('sandboxPolicy')
    if (policy === undefined || policy.defaultMode === 'danger-full-access') {
      throw new ExecutionStateError('cloud/execution-unavailable', 'The original Session file-policy provider is unavailable.')
    }
    return policy.defaultMode
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.port.assertCurrent(this.ctx); request.signal?.throwIfAborted()
    const spec: ShellExecSpec = { command: request.command, workdir: request.workdir ?? this.port.projectRoot(this.ctx),
      timeoutMs: clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'Cloud Shell timeoutMs'),
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.config.maxOutputBytes, onExpiry: request.onExpiry ?? 'kill',
      sandboxPolicy: request.sandboxPolicy,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }), ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }) }
    validateShell(spec, this.config)
    return spec
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const caller = this.ctx
    this.port.assertCurrent(caller); spec.signal?.throwIfAborted(); validateShell(spec, this.config)
    const timer = deadline(spec.signal, spec.onExpiry === 'kill' ? spec.timeoutMs : 0, SHELL_TIMEOUT)
    let operation: ManagedCommandOperation
    try {
      operation = this.port.create(caller, { argv: [this.config.bashPath, '--noprofile', '--norc', '-c', spec.command],
        cwd: spec.workdir, graceMs: this.config.graceMs, signal: timer.signal,
        stdio: { stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
          stdout: { maxBytes: spec.stdoutMaxBytes }, stderr: { maxBytes: this.config.maxOutputBytes } } }, spec.sandboxPolicy)
      operation.begin()
    } catch (cause) { timer[Symbol.dispose](); throw cause }
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => { cancelled.reject(timer.signal.reason) }
    timer.signal.addEventListener('abort', abort, { once: true })
    try {
      timer.signal.throwIfAborted()
      await Promise.race([operation.prepared, cancelled.promise])
      timer.signal.throwIfAborted()
      this.port.assertOperationCurrent(caller, operation)
      operation.publish()
      let killed = false
      const interruption = (): ShellInterruption | undefined => {
        if (killed) return 'killed'
        const stop = operation.stopReason()
        if (stop === undefined || !timer.signal.aborted || stop.reason !== timer.signal.reason) return undefined
        return timeoutOf(timer.signal, SHELL_TIMEOUT) === undefined ? 'aborted' : 'timed-out'
      }
      const shell = new ManagedShellExecution(spec, { process: operation.handle, whenEmpty: operation.whenEmpty,
        assertCurrent: () => { this.port.assertOperationCurrent(caller, operation) },
        stop: () => {
          const first = interruption() === undefined, started = operation.requestStop()
          if (first && started) killed = true
          return started
        },
        providerFailed: (cause) => { this.port.providerFailed(operation, cause) }, interruption })
      void operation.whenEmpty.then(() => { timer[Symbol.dispose]() })
      return shell
    } catch (cause) {
      operation.requestStop(timer.signal.aborted ? timer.signal.reason : cause)
      timer[Symbol.dispose]()
      if (timeoutOf(timer.signal, SHELL_TIMEOUT) !== undefined) {
        return new PreparationTimedOutExecution(spec, () => { this.port.assertOperationCurrent(caller, operation) })
      }
      throw timer.signal.aborted ? timer.signal.reason : cause
    } finally { timer.signal.removeEventListener('abort', abort) }
  }
}
