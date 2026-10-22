/** One Root-owned command; native direct completion and actual range settlement remain separate facts. */
import { setTimeout as delay } from 'node:timers/promises'
import { posix } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CollectedOutputMirror } from './collected-output.ts'

/** Authenticated raw stream facts, decoded and validated by the private channel client. */
export interface CommandStreamSnapshot {
  readonly bytes: Uint8Array
  readonly observedBytes: number
  readonly eof: boolean
}

/** Original operation snapshot; a missing direct outcome never supplies invented exit facts. */
export interface CommandSnapshot {
  readonly prepared: boolean
  readonly submitted: boolean
  readonly commitClosed: boolean
  readonly rangeEmpty: boolean
  readonly ioClosed: boolean
  readonly physicalStopRequired: boolean
  readonly providerFailure: boolean
  readonly direct: SubprocessOutcome | undefined
  readonly stdout: CommandStreamSnapshot
  readonly stderr: CommandStreamSnapshot
}

/** One immutable operation selection. Mutation methods each submit at most once, including lost replies. */
export interface CommandChannel {
  prepare(spec: Readonly<{ argv: readonly string[]; cwd: string; stdin: { readonly mode: 'ignore' } | { readonly mode: 'batch'; readonly base64: string } }>): Promise<CommandSnapshot>
  commit(): Promise<CommandSnapshot>
  poll(): Promise<CommandSnapshot>
  stop(): Promise<CommandSnapshot>
}

/** Explicit limits for the selected channel; its transport separately bounds transient wire copies. */
export interface CommandOperationLimits {
  readonly maxArgvBytes: number
  readonly maxArgvEntries: number
  readonly maxPathBytes: number
  readonly maxStdinBytes: number
  readonly maxTailBytes: number
  readonly maxObservedBytes: number
  readonly pollIntervalMs: number
  readonly maxWaiters: number
  readonly maxLifetimeMs: number
  readonly stopWaitMs: number
}

/** Root retains this authority and the reservation independently of public admission and observer cancellation. */
export interface CommandOperationAuthority {
  readonly lifetime: AbortSignal
  assertCurrent(): void
  /** Cancellation bounds this allocation observer; the separate allocation owner retains any late create. */
  acquire(signal: AbortSignal): Promise<CommandChannel>
  /** Notify the same owner only after a validated original snapshot confirms submitted. Must not throw. */
  onSubmitted?(): void
  /** Fence the allocation and request actual physical stop; failure never releases this command's reservation. */
  unknown(cause: unknown): void
  /** Called only after actual range/I/O settlement and final native output-owner release. */
  retired(): void
}

interface RangeWaiter { settle(empty: boolean, failure?: { readonly cause: unknown }): void }

/**
 * A synchronous native subprocess handle backed by one preparation/commit/poll loop.
 * Root installs the operation and reserves its complete storage before begin(). Public scope
 * revocation requests stop but retains output and cleanup until actual range/I/O settlement.
 */
export class ManagedCommandOperation {
  private readonly completion = Promise.withResolvers<SubprocessOutcome>()
  private readonly preparation = Promise.withResolvers<void>()
  private readonly empty = Promise.withResolvers<void>()
  private readonly publication = Promise.withResolvers<void>()
  private readonly allocationWait = new AbortController()
  private readonly waiters = new Set<RangeWaiter>()
  private readonly output: { stdout: CollectedOutputMirror; stderr: CollectedOutputMirror }
  private readonly spec: Parameters<CommandChannel['prepare']>[0]
  private readonly signal: AbortSignal | undefined
  private readonly detach: () => void
  private readonly graceMs: number
  private started = false
  private publicationApproved = false
  private preparationSettled = false
  private direct: SubprocessOutcome | undefined
  private eof = { stdout: false, stderr: false }
  private requestedStop: { readonly reason: unknown } | undefined
  private failed: { readonly cause: unknown } | undefined
  private localSettled = false
  private remoteAttempted = false
  private submittedObserved = false
  private rangeConfirmed = false
  private scopeReleased = false
  private retired = false
  private grace: ReturnType<typeof setTimeout> | undefined
  private lifetime: ReturnType<typeof setTimeout> | undefined
  private lifetimeDeadlineAtMs: number | undefined
  private commitStartedAtMs: number | undefined

  /** Private preparation observer and actual complete-range latch; neither rechecks revoked public admission. */
  readonly prepared: Promise<void>
  /** Resolves only after confirmed range emptiness and actual local settlement, independently of the direct child outcome. */
  readonly whenEmpty: Promise<void>
  /** Original collected-output native handle; public operations recheck the owning scope's admission. */
  readonly handle: SubprocessHandle

  /**
   * @param spec Fully resolved native input; unsupported stdio, environment and spill reject before allocation.
   * @param limits Actual finite channel limits, selected by Root configuration.
   * @param authority Original account/native owner and separately retained cleanup callbacks.
   */
  constructor(spec: SubprocessSpawnSpec, private readonly limits: CommandOperationLimits,
    private readonly authority: CommandOperationAuthority) {
    authority.assertCurrent(); authority.lifetime.throwIfAborted(); spec.signal?.throwIfAborted()
    for (const limit of Object.values(limits)) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) {
      throw new RangeError('Command limits must be finite positive timer-safe integers.')
    }
    const encoded = (value: string): boolean => Buffer.from(value).toString('utf8') === value
    const text = (value: string): boolean => !value.includes('\0') && encoded(value)
    const executable = spec.argv[0]
    if (executable === undefined || spec.argv.length > limits.maxArgvEntries || !executable.startsWith('/') || !spec.argv.every(text)
      || spec.argv.reduce((bytes, value) => bytes + Buffer.byteLength(value) + 1, 0) > limits.maxArgvBytes
      || !spec.cwd.startsWith('/') || spec.cwd.startsWith('//') || posix.normalize(spec.cwd) !== spec.cwd
      || !text(spec.cwd) || /[\u0001-\u001f\u007f]/u.test(spec.cwd) || Buffer.byteLength(spec.cwd) > limits.maxPathBytes
      || !Number.isSafeInteger(spec.graceMs) || spec.graceMs < 1 || spec.graceMs > 2147483647) {
      throw new RangeError('Cloud command argv, cwd or grace is invalid.')
    }
    const { stdin, stdout, stderr, control } = spec.stdio
    if (control !== undefined || typeof stdout === 'string' || typeof stderr === 'string' || stdin === 'pipe'
      || spec.env !== undefined && Object.keys(spec.env).length > 0) {
      throw new Error('This cloud channel requires collected output, closed or batch stdin and its fixed environment.')
    }
    if (stdout.maxBytes > limits.maxTailBytes || stderr.maxBytes > limits.maxTailBytes) {
      throw new RangeError('Cloud command collection exceeds the authenticated channel tail capacity.')
    }
    const batch = stdin === 'ignore' ? undefined : stdin.data
    if (batch !== undefined && (!encoded(batch) || Buffer.byteLength(batch) > limits.maxStdinBytes)) {
      throw new RangeError('Cloud command stdin exceeds its byte or encoding limit.')
    }
    this.output = { stdout: new CollectedOutputMirror(stdout, limits.maxObservedBytes),
      stderr: new CollectedOutputMirror(stderr, limits.maxObservedBytes) }
    this.spec = Object.freeze({ argv: Object.freeze([...spec.argv]), cwd: spec.cwd,
      stdin: Object.freeze(batch === undefined ? { mode: 'ignore' as const }
        : { mode: 'batch' as const, base64: Buffer.from(batch).toString('base64') }) })
    this.graceMs = spec.graceMs; this.signal = spec.signal
    const signal = this.signal
    this.prepared = this.preparation.promise; this.whenEmpty = this.empty.promise
    // Failures remain in the original promises even if the native consumer attaches after synchronous publication.
    void this.completion.promise.catch(() => { /* The original rejected promise remains the native outcome. */ })
    void this.prepared.catch(() => { /* Root's preparation observer retains the original rejection. */ })
    const cancelled = (): void => { this.requestStop(this.signal?.reason) }
    const released = (): void => { this.release() }
    signal?.addEventListener('abort', cancelled, { once: true })
    authority.lifetime.addEventListener('abort', released, { once: true })
    this.detach = () => {
      signal?.removeEventListener('abort', cancelled)
      authority.lifetime.removeEventListener('abort', released)
    }
    const handle: SubprocessHandle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: Object.freeze({
        stdout: Object.freeze({ readFrom: (offset: number) => { this.assertPublic(); return this.output.stdout.readFrom(offset) } }),
        stderr: Object.freeze({ readFrom: (offset: number) => { this.assertPublic(); return this.output.stderr.readFrom(offset) } }),
      }),
      done: this.completion.promise,
      terminate: () => { this.assertPublic(); this.requestStop(new Error('Native command termination requested.')) },
      waitForExit: (signal?: AbortSignal) => { this.assertPublic(); return this.waitForExit(signal) },
    }
    Object.defineProperty(handle, 'done', {
      get: () => { this.assertPublic(); return this.completion.promise }, enumerable: true,
    })
    this.handle = Object.freeze(handle)
  }

  /** Begin only after Root has installed the original operation and reserved its memory/process capacity. */
  begin(): void {
    if (this.started) throw new Error('The original command operation was already started.')
    this.started = true
    this.lifetimeDeadlineAtMs = performance.now() + this.limits.maxLifetimeMs
    this.lifetime = setTimeout(() => { this.requestStop(new Error('The command exceeded its platform lifetime.')) }, this.limits.maxLifetimeMs)
    void this.run().then(() => { this.localSettled = true; this.finishEmpty() }, (cause: unknown) => {
      this.fail(cause)
      this.localSettled = true
      this.finishEmpty()
    })
  }

  /** Approve the original user-command commit at its native handle publication point; never reopens a cancelled gate. */
  publish(): void {
    this.assertPublic()
    if (this.requestedStop !== undefined) throw this.requestedStop.reason
    this.publicationApproved = true
    this.publication.resolve()
  }

  /**
   * Request the one owned stop without depending on revoked public admission.
   * @param reason Original first interruption reason; omission records no caller-specific error.
   * @returns Whether this is the first effective stop request.
   */
  requestStop(reason?: unknown): boolean {
    if (this.rangeConfirmed || this.requestedStop !== undefined) return false
    this.requestedStop = Object.freeze({ reason })
    this.allocationWait.abort(reason)
    this.publication.resolve()
    return true
  }

  /**
   * Read the retained stop request without requesting or confirming termination.
   * @returns The first effective owned stop request; late cancellation after confirmed range completion adds none.
   */
  stopReason(): { readonly reason: unknown } | undefined { return this.requestedStop }

  /**
   * Read the original acquisition status without admitting remote work.
   * @returns Whether this controller still awaits its first channel with no cancellation or remote attempt.
   */
  isAwaitingChannel(): boolean {
    return this.started && !this.remoteAttempted && !this.localSettled && !this.scopeReleased
      && this.requestedStop === undefined && this.failed === undefined
  }

  /**
   * Project a shorter observer budget from this controller's original timer and sole commit attempt.
   * The local commit point precedes the remote gate write; submitted observation never renews it.
   * @param runMs Original registered role policy; cannot extend the controller's existing lifetime.
   * @returns Whole remaining milliseconds, or zero before commit or after either deadline.
   */
  remainingExecutionMs(runMs: number): number {
    if (this.lifetimeDeadlineAtMs === undefined || this.commitStartedAtMs === undefined) return 0
    return Math.max(0, Math.floor(Math.min(this.lifetimeDeadlineAtMs, this.commitStartedAtMs + runMs) - performance.now()))
  }

  /** Revoke public access immediately; actual cleanup and retained storage remain Root-owned. */
  release(): void {
    if (this.scopeReleased) return
    this.scopeReleased = true
    this.requestStop(this.authority.lifetime.reason)
    this.finishEmpty()
  }

  /**
   * Settle a synchronous publication failure without letting this operation acquire or submit remote work.
   * @param cause Original failure retained by the same controller.
   * @returns Whether this call began the unstarted controller's cancelled settlement.
   */
  cancelUnstarted(cause: unknown): boolean {
    if (this.started) return false
    this.requestStop(cause)
    this.release()
    this.begin()
    return true
  }

  /** Root calls only after its qualified physical stop and all local channel requests have actually settled. */
  acknowledgePhysicalStop(): void {
    this.rangeConfirmed = true
    this.publication.resolve()
    if (this.direct === undefined || !this.eof.stdout || !this.eof.stderr) {
      this.fail(new Error('The sandbox stopped without a complete direct-command outcome.'))
    }
    this.finishEmpty()
  }

  private async run(): Promise<void> {
    try {
      const channel = await this.authority.acquire(this.allocationWait.signal)
      const beforePreparation = this.stopRequest()
      if (beforePreparation !== undefined) throw beforePreparation.reason
      this.authority.assertCurrent()
      this.remoteAttempted = true
      let snapshot = await channel.prepare(this.spec), committed = false, stopAt: number | undefined
      for (;;) {
        if (this.isRangeConfirmed()) break
        if (!committed && (snapshot.submitted || snapshot.direct !== undefined)) {
          throw new Error('The remote command ran before its original commit attempt.')
        }
        this.accept(snapshot)
        if (snapshot.physicalStopRequired || snapshot.providerFailure) throw new Error('The authenticated command channel requires physical stop.')
        if (snapshot.rangeEmpty && snapshot.ioClosed) break
        if (stopAt !== undefined && Date.now() - stopAt >= this.limits.stopWaitMs) {
          throw new Error('The remote command stop remains unconfirmed.')
        }
        const stopped = this.stopRequest()
        if (stopped !== undefined && stopAt === undefined) {
          stopAt = Date.now(); snapshot = await channel.stop(); continue
        }
        if (snapshot.prepared && !this.preparationSettled && stopped === undefined) {
          this.authority.assertCurrent()
          this.preparationSettled = true; this.preparation.resolve()
        }
        if (snapshot.prepared && !this.publicationApproved && stopped === undefined) {
          await this.publication.promise
          continue
        }
        if (snapshot.prepared && this.publicationApproved && !committed && stopped === undefined) {
          this.authority.assertCurrent()
          committed = true
          this.commitStartedAtMs = performance.now()
          snapshot = await channel.commit(); continue
        }
        if (snapshot.commitClosed && !snapshot.submitted && stopped === undefined) {
          throw new Error('The original remote command commit gate closed before submission.')
        }
        await delay(this.limits.pollIntervalMs)
        if (this.isRangeConfirmed()) break
        snapshot = await channel.poll()
      }
      if (this.direct === undefined || !this.eof.stdout || !this.eof.stderr) {
        this.fail(this.requestedStop?.reason ?? new Error('The command ended without complete direct exit facts.'))
      }
    } catch (cause) {
      this.fail(this.stopRequest()?.reason ?? cause)
      if (this.remoteAttempted) this.authority.unknown(cause)
      else this.rangeConfirmed = true
    } finally {
      if (!this.preparationSettled) {
        this.preparationSettled = true
        this.preparation.reject(this.failed?.cause ?? this.requestedStop?.reason ?? new Error('Command preparation did not complete.'))
      }
    }
  }

  private accept(snapshot: CommandSnapshot): void {
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = snapshot[name], output = this.output[name]
      if (this.eof[name]) {
        const previous = output.snapshot()
        const retained = stream.bytes.subarray(Math.max(0, stream.bytes.byteLength - previous.bytes.byteLength))
        if (!stream.eof || previous.totalBytes !== stream.observedBytes || !Buffer.from(previous.bytes).equals(retained)) {
          throw new Error('A closed remote output stream changed.')
        }
      } else {
        output.replaceTail(stream.bytes, stream.observedBytes)
        if (stream.eof) { this.eof[name] = true; output.seal() }
      }
    }
    if (snapshot.direct !== undefined) {
      if (this.direct !== undefined
        && (this.direct.exitCode !== snapshot.direct.exitCode || this.direct.signal !== snapshot.direct.signal)) {
        throw new Error('The remote direct-command outcome changed.')
      }
      this.direct ??= Object.freeze({ ...snapshot.direct })
    } else if (this.direct !== undefined) throw new Error('The remote direct-command outcome disappeared.')
    if (this.direct !== undefined && this.eof.stdout && this.eof.stderr) {
      if (this.grace !== undefined) { clearTimeout(this.grace); this.grace = undefined }
      this.completion.resolve(this.direct)
    } else if (this.direct !== undefined && this.grace === undefined) {
      this.grace = setTimeout(() => { this.requestStop(new Error('Collected command pipes exceeded the native drain grace.')) }, this.graceMs)
    }
    if (snapshot.rangeEmpty && snapshot.ioClosed) this.rangeConfirmed = true
    if (snapshot.submitted && !this.submittedObserved) {
      this.submittedObserved = true
      this.authority.onSubmitted?.()
    }
  }

  private fail(cause: unknown): void {
    this.failed ??= { cause }
    this.completion.reject(this.failed.cause)
    for (const waiter of this.waiters) waiter.settle(false, this.failed)
  }

  private finishEmpty(): void {
    if (!this.localSettled || !this.rangeConfirmed) return
    if (this.lifetime !== undefined) { clearTimeout(this.lifetime); this.lifetime = undefined }
    if (this.grace !== undefined) { clearTimeout(this.grace); this.grace = undefined }
    this.empty.resolve()
    for (const waiter of this.waiters) waiter.settle(true)
    if (!this.scopeReleased || this.retired) return
    this.detach()
    this.retired = true
    this.output.stdout.release(); this.output.stderr.release()
    this.authority.retired()
  }

  private waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.localSettled && this.rangeConfirmed) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the original native cancellation or provider reason.
    if (this.failed !== undefined) return Promise.reject(this.failed.cause)
    if (this.waiters.size >= this.limits.maxWaiters) return Promise.reject(new Error('Command range observer capacity is exhausted.'))
    return new Promise((resolve, reject) => {
      const abort = (): void => { waiter.settle(false) }
      const waiter: RangeWaiter = { settle: (empty, failure) => {
        if (!this.waiters.delete(waiter)) return
        signal?.removeEventListener('abort', abort)
        if (failure === undefined) resolve(empty)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The native caller owns the original rejection value.
        else reject(failure.cause)
      } }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private stopRequest(): { readonly reason: unknown } | undefined { return this.requestedStop }
  private isRangeConfirmed(): boolean { return this.rangeConfirmed }

  private assertPublic(): void {
    if (this.scopeReleased) throw new Error('The original native command output owner was released.')
    this.authority.assertCurrent()
  }
}
