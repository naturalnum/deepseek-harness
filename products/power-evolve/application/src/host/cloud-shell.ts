/** Native Shell provider bound to one tool's durable operation; the Platform owns process admission and stop evidence. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ShellExecutor, { type ShellExecRequest, type ShellExecSpec, type ShellExecution,
  type ShellProcessStatus, type ShellRunResult, type CollectedOutput } from '@deepseek-ai/dsh-shell'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf, type Deadline } from '@deepseek-ai/dsh-timeout'
import { cloudShellObservation, cloudShellProposeRequest, type CloudShellObservation } from '../cloud-shell-contracts.ts'
import { PlatformError, type Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

/** Foreground-only capabilities and explicit cloud transport bounds. */
export interface CloudShellConfig {
  pollMs: number
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
}

type ToolOwner = { grant: Grant; callId: string; ordinal: number }
type AgentOwner = { stop: AbortController; handles: Set<ShellExecution>; admissions: Set<Promise<void>> }
type Transport = Pick<RuntimeScope, 'assertGrant' | 'call'>
const callOwners = new AsyncLocalStorage<ToolOwner>()
const terminal = new Set<CloudShellObservation['state']>(['succeeded', 'failed', 'cancelled', 'closed_unknown'])

function transient(error: unknown): boolean {
  return (error instanceof PlatformError && error.status >= 500 && error.code !== 'shell_observation_identity_mismatch')
    || (error instanceof DOMException && error.name === 'TimeoutError')
    || (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated'))
}

function outputReader(stream: () => CollectedOutput): SubprocessOutputReader {
  return { readFrom(fromByte) {
    const value = stream(), bytes = Buffer.from(value.text)
    return { text: bytes.subarray(fromByte).toString('utf8'), nextOffset: bytes.length, lossy: value.truncated }
  } }
}

/** Native foreground handle; cancellation waits for the original durable execution to stop. */
class CloudShellProcess implements ShellExecution {
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly done: Promise<void>
  readonly observed: ShellExecution['observed']
  private readonly settled: Promise<{ kind: 'result'; value: ShellRunResult } | { kind: 'error'; error: Error }>
  private completed: Promise<ShellRunResult> | undefined
  private stdout: CollectedOutput = { text: '', truncated: false }
  private stderr: CollectedOutput = { text: '', truncated: false }
  private stdoutOffset = 0
  private stderrOffset = 0
  private stopCause: 'abort' | 'timeout' | undefined
  private readonly closed = Promise.withResolvers<void>()

  constructor(private readonly runtime: Transport, private readonly grant: Grant,
    private observation: CloudShellObservation, private readonly spec: ShellExecSpec,
    private readonly config: CloudShellConfig, private readonly lifetime: Deadline, private readonly admissionError?: Error) {
    this.observed = { stdout: outputReader(() => this.stdout), stderr: outputReader(() => this.stderr) }
    this.settled = this.wait().then(value => ({ kind: 'result', value }), (error: unknown) => ({ kind: 'error',
      error: error instanceof Error ? error : new Error('cloud_shell_result_unavailable', { cause: error }) }))
    this.done = this.closed.promise
  }

  private async wait(): Promise<ShellRunResult> {
    let observationError = this.admissionError
    if (observationError !== undefined) this.stopCause = 'abort'
    const aborted = () => { this.stopCause ??= timeoutOf(this.lifetime.signal, 'CLOUD_SHELL_TIMEOUT') ? 'timeout' : 'abort' }
    this.lifetime.signal.addEventListener('abort', aborted, { once: true })
    if (this.lifetime.signal.aborted) aborted()
    try {
      while (!terminal.has(this.observation.state)) {
        const stopping = this.stopCause !== undefined
        try {
          const value = cloudShellObservation.parse(await this.runtime.call(
            stopping ? '/runtime/shell/cancel' : '/runtime/shell/status', this.grant.token,
            { executionId: this.observation.executionId, ...(stopping ? { cause: this.stopCause } : {}) }))
          if (value.executionId !== this.observation.executionId || value.command !== this.spec.command
            || value.cwd !== this.observation.cwd || value.timeoutMs !== this.observation.timeoutMs) {
            throw new PlatformError(503, 'shell_observation_identity_mismatch')
          }
          this.observation = value
        } catch (error) {
          if (!transient(error)) {
            observationError ??= error instanceof Error ? error : new Error('cloud_shell_observation_failed', { cause: error })
            this.stopCause ??= 'abort'
          }
        }
        if (!terminal.has(this.observation.state)) await delay(this.config.pollMs)
      }
      if (observationError !== undefined) throw observationError
      const value = this.observation.result
      if (value === null && this.observation.state !== 'cancelled') {
        throw new PlatformError(503, this.observation.errorCode ?? 'shell_result_unknown')
      }
      this.exitCode = value?.exitCode ?? null
      this.status = this.observation.state === 'cancelled' ? 'killed' : 'completed'
      this.stdout = this.capture(value?.stdout ?? '', value?.stdoutTruncated ?? false, this.spec.stdoutMaxBytes)
      this.stderr = this.capture(value?.stderr ?? '', value?.stderrTruncated ?? false, this.config.maxOutputBytes)
      const timedOut = value === null ? this.observation.cancelCause === 'timeout' : value.timedOut
      return { exitCode: this.exitCode, signal: null, timedOut,
        aborted: !timedOut && this.observation.state === 'cancelled',
        timeoutMs: this.observation.timeoutMs, stdout: this.stdout, stderr: this.stderr }
    } catch (error) {
      if (terminal.has(this.observation.state)) this.status = 'killed'
      this.stderr = { text: 'cloud_shell_result_unavailable', truncated: false }
      throw error
    } finally {
      this.lifetime.signal.removeEventListener('abort', aborted)
      this.lifetime[Symbol.dispose]()
      if (terminal.has(this.observation.state)) this.closed.resolve()
    }
  }

  private capture(text: string, truncated: boolean, cap: number): CollectedOutput {
    const bytes = Buffer.from(text)
    let start = Math.max(0, bytes.length - cap)
    while (start < bytes.length) {
      const byte = bytes[start]
      if (byte === undefined || (byte & 0xc0) !== 0x80) break
      start++
    }
    return { text: bytes.subarray(start).toString('utf8'), truncated: truncated || start > 0 }
  }

  result(): Promise<ShellRunResult> {
    return this.completed ??= this.settled.then((value) => {
      if (value.kind === 'error') throw value.error
      return value.value
    })
  }

  readOutput(): ShellExecution['readOutput'] extends () => infer R ? R : never {
    const stdout = this.observed.stdout.readFrom(this.stdoutOffset)
    const stderr = this.observed.stderr.readFrom(this.stderrOffset)
    this.stdoutOffset = stdout.nextOffset; this.stderrOffset = stderr.nextOffset
    return { delta: stdout.text + (stderr.text ? `\n[stderr]\n${stderr.text}` : ''), lossy: stdout.lossy || stderr.lossy }
  }

  kill(): boolean {
    if (this.status !== 'running' || this.stopCause !== undefined) return false
    this.stopCause = 'abort'
    return true
  }
}

/** Shell commands use the calling Agent's grant without a process-global current user. */
export class CloudShellExecutor extends ShellExecutor {
  private readonly resolved = new WeakMap<ShellExecSpec, { grant: Grant; callId: string; agentOwner: AgentOwner }>()
  private readonly owners = new Map<Grant, AgentOwner>()

  /** Install the provider; only native foreground Shell is supported in this slice.
   * @param ctx Trusted Host plugin context.
   * @param runtime Authenticated Platform transport.
   * @param config Explicit polling, deadline and output bounds.
   */
  constructor(ctx: Context, private readonly runtime: Transport, private readonly config: CloudShellConfig) {
    super(ctx)
  }

  /** Bind native tool dispatch to this Agent's immutable operation authority.
   * @param agent Native Agent whose scoped registrations dispose with the operation.
   * @param grant Platform-issued operation; no credential enters the command environment.
   */
  bind(agent: Agent, grant: Grant): void {
    this.runtime.assertGrant(grant)
    const owner: AgentOwner = { stop: new AbortController(), handles: new Set(), admissions: new Set() }
    this.owners.set(grant, owner)
    agent.ctx.effect(() => async () => {
      owner.stop.abort()
      for (const handle of owner.handles) handle.kill()
      await Promise.all(owner.admissions)
      await Promise.all([...owner.handles].map(handle => handle.done))
      if (this.owners.get(grant) === owner) this.owners.delete(grant)
    })
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'power-evolve:cloud-shell', order: 705, interpolate: false,
      text: 'Cloud Bash waits for the real result within its original tool call. If an execution outcome is unknown or unavailable, do not repeat the original command: it may already have changed files or external state. Inspect existing authorized state before deciding the next action.',
    }))
    agent.ctx.on('tools/execute', (exec, next) => {
      if (exec.agent !== agent) throw new PlatformError(403, 'session_not_leased')
      this.runtime.assertGrant(grant)
      return callOwners.run({ grant, callId: String(exec.callId), ordinal: 0 }, next)
    })
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const owner = callOwners.getStore()
    if (!owner) throw new PlatformError(403, 'shell_operation_missing')
    const agentOwner = this.owners.get(owner.grant)
    if (!agentOwner || agentOwner.stop.signal.aborted) throw new PlatformError(403, 'shell_operation_stopped')
    this.runtime.assertGrant(owner.grant)
    if (request.onExpiry === 'none' || request.stdin !== undefined || request.env !== undefined
      || request.sandboxPolicy !== undefined) throw new PlatformError(400, 'shell_capability_not_enabled')
    const path = request.workdir ?? '/workspace'
    const workdir = posix.resolve('/workspace', path)
    if (workdir !== '/workspace' && !workdir.startsWith('/workspace/')) throw new PlatformError(400, 'invalid_cwd')
    const timeoutMs = Math.max(1000, Math.min(Math.ceil(request.timeoutMs ?? this.config.timeoutMs), this.config.maxTimeoutMs))
    const spec: ShellExecSpec = { command: request.command, workdir, timeoutMs, onExpiry: 'kill',
      stdoutMaxBytes: Math.min(request.stdoutMaxBytes ?? this.config.maxOutputBytes, this.config.maxOutputBytes),
      sandboxPolicy: undefined, signal: request.signal }
    const callId = `${owner.callId}:shell:${owner.ordinal++}`
    cloudShellProposeRequest.parse({ callId, command: spec.command, cwd: posix.relative('/workspace', workdir), timeoutMs })
    this.resolved.set(spec, { grant: owner.grant, callId, agentOwner })
    return spec
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const owner = this.resolved.get(spec)
    if (!owner) throw new PlatformError(403, 'shell_spec_not_resolved')
    this.runtime.assertGrant(owner.grant)
    if (owner.agentOwner.stop.signal.aborted) throw new PlatformError(403, 'shell_operation_stopped')
    spec.signal?.throwIfAborted()
    const startedAt = Date.now()
    const upstream = AbortSignal.any([owner.agentOwner.stop.signal, ...spec.signal ? [spec.signal] : []])
    const lifetime = deadline(upstream, spec.timeoutMs, 'CLOUD_SHELL_TIMEOUT')
    const request = cloudShellProposeRequest.parse({ callId: owner.callId, command: spec.command,
      cwd: posix.relative('/workspace', spec.workdir), timeoutMs: spec.timeoutMs })
    // Admission is idempotent and must finish reading its receipt before cancellation can target that exact execution.
    let observation: CloudShellObservation
    let admissionError: Error | undefined
    const admitted = Promise.withResolvers<void>()
    owner.agentOwner.admissions.add(admitted.promise)
    let transferred = false
    try {
      for (;;) {
        try {
          const cancelCause = admissionError !== undefined ? 'abort' : !lifetime.signal.aborted ? undefined
            : timeoutOf(lifetime.signal, 'CLOUD_SHELL_TIMEOUT') ? 'timeout' : 'abort'
          observation = cloudShellObservation.parse(await this.runtime.call('/runtime/shell/propose', owner.grant.token,
            { ...request, ...(cancelCause === undefined ? {} : { cancelRequested: true, cancelCause }) }))
          if (observation.command !== request.command || observation.cwd !== request.cwd || observation.timeoutMs > request.timeoutMs) {
            throw new PlatformError(503, 'shell_observation_identity_mismatch')
          }
          break
        } catch (error) {
          if (!transient(error)) {
            if (error instanceof PlatformError && error.status < 500) throw error
            admissionError ??= error instanceof Error ? error : new Error('cloud_shell_admission_failed', { cause: error })
          }
          await delay(this.config.pollMs)
        }
      }
      const applied = deadline(lifetime.signal, Math.max(1, startedAt + observation.timeoutMs - Date.now()), 'CLOUD_SHELL_TIMEOUT')
      const handle = new CloudShellProcess(this.runtime, owner.grant, observation,
        { ...spec, timeoutMs: observation.timeoutMs }, this.config, applied, admissionError)
      transferred = true
      owner.agentOwner.handles.add(handle)
      void handle.done.then(() => { owner.agentOwner.handles.delete(handle); lifetime[Symbol.dispose]() })
      return handle
    } finally {
      if (!transferred) lifetime[Symbol.dispose]()
      admitted.resolve()
      owner.agentOwner.admissions.delete(admitted.promise)
    }
  }
}
