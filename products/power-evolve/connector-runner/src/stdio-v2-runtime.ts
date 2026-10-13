/** Trusted cloud STDIO admission and independent writer-stop confirmation; HTTP authentication remains external. */
import { posix } from 'node:path'
import { stdioExecutorOwnerV2, stdioLimitsV2, type StdioDispatchV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCanonicalJsonV2 } from '@power-evolve/contracts/stdio-mcp-json'
import { stdioSha256V2 } from './stdio-v2-digest.ts'
import { parseStdioStartV2, runStdioDispatchV2, validateStdioStartV2,
  type StdioExecutionEnvironmentV2, type StdioStartV2 } from './stdio-v2-dispatch.ts'
import type { StdioV2Facts, StdioV2Outcome } from './stdio-v2.ts'

/** Deployment-owned cloud identity, budgets and independent UID cleanup; no ambient environment or defaults. */
export interface StdioCloudRuntimeOptionsV2 {
  limits: StdioLimitsV2
  maxReplyBytes: number
  environment: StdioExecutionEnvironmentV2
  executorOwner: Extract<StdioDispatchV2['permit']['executorOwner'], { kind: 'cloud' }>
  /** Verify cwd traversal using the existing dropped-privilege helper.
   * @param cwd The frozen task's grant-relative Workspace path; the driver alone resolves its absolute spawn cwd.
   * @param signal Cancellation while checking; user code must not start after it aborts.
   * @returns Whether the configured UID may traverse the original path.
   */
  authorizeCwd: (cwd: string, signal: AbortSignal) => Promise<boolean>
  /** Observe all configured UID writers stopped independently of direct-child close or cancellation.
   * @returns True only for complete writer-stop confirmation; false or rejection retains the reservation.
   */
  cleanup: () => Promise<boolean>
}

/** Queryable original execution facts; provider cleanup is distinct from complete UID writer-stop confirmation. */
export interface StdioRuntimeViewV2 {
  formatVersion: 2
  instanceId: StdioCloudRuntimeOptionsV2['executorOwner']['runnerInstanceId']
  actionId: StdioDispatchV2['task']['actionId']
  executionRef: StdioDispatchV2['executionRef']
  taskDigest: StdioDispatchV2['taskDigest']
  dispatchDigest: StdioDispatchV2['taskDigest']
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  writerStopConfirmed: boolean
  outcome?: StdioV2Outcome
  errorCode?: string
}

/** Redacted admission errors for the trusted HTTP adapter; rejected inputs grant no start authority. */
export class StdioRuntimeErrorV2 extends Error {
  /** @param code Stable public error code without input paths, program output or credentials. */
  constructor(readonly code: string) { super(code); this.name = 'StdioRuntimeErrorV2' }
}

interface Entry {
  packet: StdioStartV2
  view: StdioRuntimeViewV2
  controller: AbortController
  done?: Promise<void>
}

function failed(code: string, attempted: boolean, facts?: StdioV2Facts): StdioV2Outcome {
  return { state: 'failed', errorCode: code, facts: facts ? { ...facts, stderr: '' } : {
    programStartAttempted: attempted, toolsCallAttempted: false, effectMayHaveOccurred: attempted,
    childPid: null, childExitObserved: false, childCloseObserved: false, exitCode: null, signal: null,
    cleanupConfirmed: !attempted, protocolBytes: 0, protocolMessages: 0, stderrBytes: 0, stderr: '',
  } }
}

function admissionError(error: unknown): StdioRuntimeErrorV2 {
  return new StdioRuntimeErrorV2(error instanceof Error && /^stdio_v2_[a-z0-9_]+$/u.test(error.message)
    ? error.message : 'stdio_v2_start_invalid')
}

function absolute(value: string): boolean {
  return posix.isAbsolute(value) && posix.normalize(value) === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

/** One in-memory original execution owner; a cold instance cannot reconstruct once authority from query receipts. */
export class StdioCloudRuntimeV2 {
  private readonly options: StdioCloudRuntimeOptionsV2
  private readonly entries = new Map<string, Entry>()
  private active: Entry | undefined
  private closed = false
  private closing?: Promise<boolean>
  private stopUnconfirmed = false

  constructor(options: StdioCloudRuntimeOptionsV2, private readonly driver = runStdioDispatchV2) {
    let limits: StdioLimitsV2, owner: StdioCloudRuntimeOptionsV2['executorOwner']
    try { limits = stdioLimitsV2.parse(options.limits); owner = stdioExecutorOwnerV2.options[0].parse(options.executorOwner) }
    catch (_configurationRejected) { throw new StdioRuntimeErrorV2('stdio_v2_runtime_configuration_invalid') }
    const environment = options.environment
    if (!Number.isSafeInteger(options.maxReplyBytes) || options.maxReplyBytes < 1
      || !absolute(environment.workspaceRoot) || !absolute(environment.env.HOME)
      || Object.keys(environment.env).sort().join(',') !== 'HOME,LANG,PATH'
      || Object.values(environment.env).some(value => !value || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
      || environment.identity.kind !== 'unix' || environment.identity.uid !== 1000 || environment.identity.gid !== 1000) {
      throw new StdioRuntimeErrorV2('stdio_v2_runtime_configuration_invalid')
    }
    this.options = { ...options, limits, executorOwner: owner, environment: structuredClone(environment) }
    // Reject configurations unable to represent even complete identity plus a conservative lost-result failure.
    const minimum = { formatVersion: 2, instanceId: owner.runnerInstanceId, actionId: '00000000-0000-4000-8000-000000000000',
      executionRef: { kind: 'cloud', executionId: '00000000-0000-4000-8000-000000000000' },
      taskDigest: '0'.repeat(64), dispatchDigest: '0'.repeat(64), state: 'unknown', writerStopConfirmed: false,
      errorCode: 'stdio_v2_cleanup_unconfirmed' }
    try {
      this.encode({ ...minimum, outcome: failed('stdio_v2_cleanup_unconfirmed', true) })
      this.encode({ ...minimum, outcome: failed('stdio_v2_cleanup_unconfirmed', false) })
    }
    catch (_failureTooLarge) { throw new StdioRuntimeErrorV2('stdio_v2_runtime_configuration_invalid') }
  }

  /** Reserve once before yielding, then return running facts; identical original dispatch retries only query.
   * @param input Complete authenticated start packet; false or expired receipts cannot admit a new execution.
   * @returns An independent current view, without waiting for the user program or granting a second start.
   */
  start(input: unknown): Promise<StdioRuntimeViewV2> {
    return new Promise((resolve) => { resolve(this.admit(input)) })
  }

  private admit(input: unknown): StdioRuntimeViewV2 {
    let packet: StdioStartV2, dispatchDigest: StdioRuntimeViewV2['dispatchDigest']
    try {
      packet = parseStdioStartV2(input, this.options.limits)
      dispatchDigest = stdioSha256V2('dispatch', packet.dispatch, this.inputBudget())
    } catch (error) { throw admissionError(error) }
    const id = packet.dispatch.executionRef.executionId, previous = this.entries.get(id)
    if (previous) {
      if (previous.view.dispatchDigest !== dispatchDigest) throw new StdioRuntimeErrorV2('stdio_v2_dispatch_conflict')
      return this.snapshot(previous.view)
    }
    if (this.closed) throw new StdioRuntimeErrorV2('stdio_v2_runtime_closed')
    if (this.busy()) throw new StdioRuntimeErrorV2('stdio_v2_runtime_busy')
    try { packet = validateStdioStartV2(packet, this.options.limits, this.options.executorOwner, Date.now()) }
    catch (error) { throw admissionError(error) }
    // Both start parsers enforce the Cloud-only executionRef schema before reservation.
    const dispatch = packet.dispatch, entry: Entry = { packet, controller: new AbortController(), view: {
      formatVersion: 2, instanceId: this.options.executorOwner.runnerInstanceId, actionId: dispatch.task.actionId,
      executionRef: dispatch.executionRef, taskDigest: dispatch.taskDigest, dispatchDigest,
      state: 'running', writerStopConfirmed: false,
    } }
    this.entries.set(id, entry); this.active = entry
    // Install the tracked job before invoking any callback, including a synchronous reentrant callback.
    entry.done = Promise.resolve().then(() => this.run(entry))
    return this.snapshot(entry.view)
  }

  /** Query retained facts without starting, retrying or releasing a writer.
   * @param executionId Original execution identity in this runner instance.
   * @returns An independent view, or undefined when this instance never admitted that identity.
   */
  get(executionId: string): StdioRuntimeViewV2 | undefined {
    const entry = this.entries.get(executionId)
    return entry ? this.snapshot(entry.view) : undefined
  }

  /** Abort one original invocation; independent cleanup still runs before writer release.
   * @param executionId Original execution identity; terminal facts are retained unchanged.
   * @returns The current independent view, or undefined for an unowned identity.
   */
  cancel(executionId: string): StdioRuntimeViewV2 | undefined {
    const entry = this.entries.get(executionId)
    if (entry?.view.state === 'running') entry.controller.abort()
    return this.get(executionId)
  }

  /** Report whether a writer reservation or unconfirmed shutdown blocks fresh admission.
   * @returns True until independent writer-stop evidence permits release.
   */
  busy(): boolean { return this.active !== undefined || this.stopUnconfirmed }

  /** Close admission, abort the active invocation and wait for independent UID stop evidence.
   * @returns False when quiescence is unconfirmed; the original reservation and unknown facts remain queryable.
   */
  close(): Promise<boolean> {
    this.closed = true
    this.active?.controller.abort()
    return this.closing ??= Promise.resolve().then(() => this.finishClose())
  }

  private inputBudget() {
    const limits = this.options.limits
    return { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
  }

  private encode(view: unknown): void {
    // This budget covers the whole Runtime view JSON, including its wrapper and all raw result fields.
    stdioCanonicalJsonV2(view, { ...this.inputBudget(), maxBytes: this.options.maxReplyBytes })
  }

  private snapshot(view: StdioRuntimeViewV2): StdioRuntimeViewV2 {
    this.encode(view)
    return structuredClone(view)
  }

  private bounded(view: StdioRuntimeViewV2, attempted: boolean): StdioRuntimeViewV2 {
    try { return this.snapshot(view) }
    catch (_unrepresentableResult) {
      // No truncated success: retain stop/effect facts while explicitly dropping oversized result/stderr bytes.
      const next: StdioRuntimeViewV2 = { ...view, outcome: failed('stdio_v2_reply_limit', attempted, view.outcome?.facts),
        state: view.writerStopConfirmed ? view.state === 'cancelled' ? 'cancelled' : 'failed' : 'unknown',
        errorCode: view.writerStopConfirmed ? 'stdio_v2_reply_limit' : 'stdio_v2_cleanup_unconfirmed' }
      try { return this.snapshot(next) }
      catch (_failureFactsTooLarge) {
        next.outcome = failed('stdio_v2_reply_limit', attempted || view.outcome?.facts.effectMayHaveOccurred === true)
        return this.snapshot(next)
      }
    }
  }

  private async quiet(): Promise<boolean> {
    try {
      const confirmed: unknown = await this.options.cleanup()
      return confirmed === true
    }
    catch (_cleanupRejected) { return false }
  }

  private async run(entry: Entry): Promise<void> {
    let attempted = false, outcome: StdioV2Outcome
    const signal = entry.controller.signal
    const cancelled = () => signal.aborted
    try {
      if (cancelled()) throw new StdioRuntimeErrorV2('stdio_v2_cancelled')
      if (!await this.options.authorizeCwd(entry.packet.dispatch.task.invocation.cwd, signal)) {
        throw new StdioRuntimeErrorV2('stdio_v2_cwd_denied')
      }
      if (cancelled()) throw new StdioRuntimeErrorV2('stdio_v2_cancelled')
      // A slow traversal check cannot carry the original reply beyond its expiry into program startup.
      validateStdioStartV2(entry.packet, this.options.limits, this.options.executorOwner, Date.now())
      attempted = true
      outcome = await this.driver(structuredClone(entry.packet.dispatch), structuredClone(this.options.environment), signal)
    } catch (error) {
      outcome = failed(attempted ? 'stdio_v2_driver_failed' : error instanceof StdioRuntimeErrorV2
        ? error.code : error instanceof Error && /^stdio_v2_[a-z0-9_]+$/u.test(error.message)
          ? error.message : 'stdio_v2_cwd_failed', attempted)
    }
    const quiet = await this.quiet()
    const view: StdioRuntimeViewV2 = { ...entry.view, outcome, writerStopConfirmed: quiet,
      state: quiet ? signal.aborted ? 'cancelled' : outcome.state : 'unknown' }
    if (!quiet) {
      view.errorCode = 'stdio_v2_cleanup_unconfirmed'
      entry.view = this.bounded(view, attempted)
      this.stopUnconfirmed = true
      return
    }
    if (signal.aborted) view.errorCode = 'stdio_v2_cancelled'
    else if (outcome.state === 'failed') view.errorCode = outcome.errorCode
    entry.view = this.bounded(view, attempted)
    if (this.active === entry) this.active = undefined
  }

  private async finishClose(): Promise<boolean> {
    const entry = this.active
    if (entry) { await entry.done; return entry.view.writerStopConfirmed }
    const quiet = await this.quiet()
    this.stopUnconfirmed = !quiet
    return quiet
  }
}
