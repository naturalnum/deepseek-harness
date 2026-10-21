/** Native Shell projection over the same Root-owned subprocess and actual range completion. */
import type { ShellExecution, ShellExecSpec, ShellProcessRead, ShellProcessStatus, ShellRunResult, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** First command interruption cause, fixed by the owning Shell deadline/cancellation controller. */
export type ShellInterruption = 'timed-out' | 'aborted' | 'killed'

/** Private preparation result; no process or cleanup authority is reconstructed from JSON. */
export interface PreparedShellProcess {
  readonly process: SubprocessHandle
  /** Actual complete-range latch; remains pending while cleanup is unknown and never rejects. */
  readonly whenEmpty: Promise<void>
  /** Present only when the provider actually implements and reports the native per-call file policy. */
  readonly sandbox?: ShellSandboxInfo
  /** Revalidate public reads/controls; cleanup uses the retained private stop callback instead. */
  assertCurrent(): void
  /** First-cause-aware stop, independent of revoked user admission. */
  stop(): boolean
  /** Record provider failure and begin retained cleanup without throwing or discarding the original work. */
  providerFailed(cause: unknown): void
  interruption(): ShellInterruption | undefined
}

/**
 * Keep subprocess direct/stdio completion distinct from Shell's whole managed range.
 * The owning adapter publishes this handle only after actual preparation and retains the
 * subprocess/output scope until the native consumer has projected its result.
 */
export class ManagedShellExecution implements ShellExecution {
  private readonly state: {
    status: ShellProcessStatus
    outcome?: SubprocessOutcome
    failure?: { readonly cause: unknown }
    stdoutOffset: number
    stderrOffset: number
    result?: Promise<ShellRunResult>
  } = { status: 'running', stdoutOffset: 0, stderrOffset: 0 }
  private readonly actual: Promise<void>
  private readonly timeoutMs: number
  readonly observed: { readonly stdout: SubprocessOutputReader; readonly stderr: SubprocessOutputReader }
  private readonly readers: { readonly stdout: SubprocessOutputReader; readonly stderr: SubprocessOutputReader }

  /**
   * @param spec Original validated, resolved Shell settings; the owner's first-cause controller owns its timer.
   * @param input Root-issued prepared subprocess and independent actual-range latch.
   * @throws Before publication when the requested collected stdout/stderr are absent.
   */
  constructor(spec: ShellExecSpec, private readonly input: PreparedShellProcess) {
    input.assertCurrent()
    this.timeoutMs = spec.timeoutMs
    const { stdout, stderr } = input.process.collected
    if (stdout === undefined || stderr === undefined) {
      const failure = new Error('Prepared cloud Shell requires both original collected streams.')
      input.providerFailed(failure)
      throw failure
    }
    this.readers = { stdout, stderr }
    this.observed = Object.freeze({
      stdout: Object.freeze({ readFrom: (offset: number) => { input.assertCurrent(); return stdout.readFrom(offset) } }),
      stderr: Object.freeze({ readFrom: (offset: number) => { input.assertCurrent(); return stderr.readFrom(offset) } }),
    })
    // The native done can reject or finish with live descendants; neither settles Shell's range.
    const direct = input.process.done.then((outcome) => { this.state.outcome = outcome }, (cause: unknown) => {
      this.state.failure = { cause }
      input.providerFailed(cause)
    })
    this.actual = Promise.all([direct, input.whenEmpty]).then(() => {
      this.state.status = this.state.failure !== undefined || input.interruption() !== undefined
        || this.state.outcome?.signal !== null ? 'killed' : 'completed'
    })
  }

  get done(): Promise<void> { this.input.assertCurrent(); return this.actual }
  get status(): ShellProcessStatus { this.input.assertCurrent(); return this.state.status }
  get exitCode(): number | null { this.input.assertCurrent(); return this.state.outcome?.exitCode ?? null }
  get signal(): NodeJS.Signals | null { this.input.assertCurrent(); return this.state.outcome?.signal ?? null }

  /** @returns Whether this call began the original owned stop; repeated/completed stops are no-ops. */
  kill(): boolean {
    this.input.assertCurrent()
    return this.state.status === 'running' && this.input.stop()
  }

  /** @returns Incremental native display output without consuming either independent observed reader. */
  readOutput(): ShellProcessRead {
    this.input.assertCurrent()
    const stdout = this.readers.stdout.readFrom(this.state.stdoutOffset)
    const stderr = this.readers.stderr.readFrom(this.state.stderrOffset)
    this.state.stdoutOffset = stdout.nextOffset
    this.state.stderrOffset = stderr.nextOffset
    return { delta: stdout.text + (stderr.text ? `\n[stderr]\n${stderr.text}` : ''), lossy: stdout.lossy || stderr.lossy,
      ...(stdout.spillPath === undefined ? {} : { stdoutSpillPath: stdout.spillPath }),
      ...(stderr.spillPath === undefined ? {} : { stderrSpillPath: stderr.spillPath }) }
  }

  /** @returns Memoized native foreground result after the complete range and original I/O have settled. */
  result(): Promise<ShellRunResult> {
    this.input.assertCurrent()
    return this.state.result ??= this.actual.then(() => {
      this.input.assertCurrent()
      const cause = this.input.interruption()
      if (this.state.failure !== undefined && cause === undefined) throw this.state.failure.cause
      const stdout = this.readers.stdout.readFrom(0), stderr = this.readers.stderr.readFrom(0)
      return { exitCode: this.state.outcome?.exitCode ?? null, signal: this.state.outcome?.signal ?? null,
        timedOut: cause === 'timed-out', aborted: cause === 'aborted', timeoutMs: this.timeoutMs,
        stdout: { text: stdout.text, truncated: stdout.lossy,
          ...(stdout.spillPath === undefined ? {} : { spillPath: stdout.spillPath }) },
        stderr: { text: stderr.text, truncated: stderr.lossy,
          ...(stderr.spillPath === undefined ? {} : { spillPath: stderr.spillPath }) },
        ...(this.input.sandbox === undefined ? {} : { sandbox: this.input.sandbox }) }
    })
  }
}
