/** Account-owned observation and drain of unchanged native Office work. */
import { OfficeToPdfError } from '@deepseek-ai/dsh-office-to-pdf'

type FailurePhase = 'conversion' | 'classification' | 'owner-unloaded' | 'provider-close' | 'deadline' | 'close-observer' | 'provider-log'

/** Cleanup could not be confirmed; the account must retain its original resources. */
export class OfficeStopUnconfirmed extends Error {
  /** Existing account-drain failure classification. */
  readonly code = 'cloud/stop-unconfirmed'

  /** @param cause Original failure retained for the account's internal diagnosis. */
  constructor(cause?: unknown) {
    super('Office shutdown or cleanup remains unconfirmed.', { cause })
    this.name = 'OfficeStopUnconfirmed'
  }
}

/** Keeps native readers alive independently of an HTTP caller's cancellation. */
export class OfficeWork {
  private readonly tasks = new Set<Promise<void>>()
  private accepting = true
  private providerClosing = false
  private fault: { readonly cause: unknown } | undefined
  private actualClose: Promise<void> | undefined
  private closeObservation: Promise<void> | undefined

  /**
   * @param maximum Original native reader capacity, also bounding retained calls.
   * @param admit Original account and provider checks before starting a call.
   * @param dispose Preparation for original account-owned disposal after retained conversions settle.
   * @param knownFailure Whether a completed native call failed without uncertain cleanup.
   * @param report Independent fixed diagnostic when cleanup becomes uncertain.
   */
  constructor(private readonly maximum: number, private readonly admit: () => void,
    private readonly dispose: () => Promise<void>, private readonly knownFailure: (cause: unknown) => boolean,
    private readonly report: (phase: FailurePhase) => void) {}

  /**
   * Retain the actual native reader; cancellation ends only this caller's wait.
   * @param invoke Native conversion without the observer's cancellation signal.
   * @param signal Optional caller cancellation; omission waits for the actual result.
   * @param knownFailure Optional call-specific classification, including a source read before conversion.
   * @returns Native output or the observer's cancellation; actual work remains owned either way.
   */
  run<T>(invoke: () => Promise<T>, signal?: AbortSignal,
    knownFailure: (cause: unknown) => boolean = this.knownFailure): Promise<T> {
    try {
      signal?.throwIfAborted()
      if (!this.accepting || this.fault !== undefined) throw this.unavailable()
      this.admit()
      if (this.tasks.size >= this.maximum) throw new OfficeToPdfError('busy', 'The document converter has reached its admission limit.')
    } catch (cause) {
      // Preserve the original native admission failure or arbitrary AbortSignal reason.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(cause)
    }
    const done = Promise.withResolvers<void>(), result = Promise.withResolvers<T>()
    this.tasks.add(done.promise)
    void result.promise.catch((_cause: unknown) => { /* Cancellation may have removed the only observer. */ })
    const finish = (): void => { this.tasks.delete(done.promise); done.resolve() }
    const rejected = (cause: unknown): void => {
      try {
        let known = false
        try { known = knownFailure(cause) }
        catch (classificationFailure) { this.cleanupFailed(classificationFailure, 'classification') }
        if (!known) this.cleanupFailed(cause, 'conversion')
        result.reject(cause)
      } finally { finish() }
    }
    try {
      void invoke().then((value) => {
        try {
          if (this.fault === undefined) result.resolve(value)
          else result.reject(this.unavailable())
        } finally { finish() }
      }, rejected)
    } catch (cause) { rejected(cause) }
    if (signal === undefined) return result.promise
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        // AbortSignal owns its reason; callers receive that exact value.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason)
        signal.removeEventListener('abort', abort)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void result.promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    })
  }

  /** Check conversion quiescence before configuration changes.
   * @returns Whether no admitted Office work or unknown cleanup remains.
   */
  isIdle(): boolean { return this.accepting && this.tasks.size === 0 && this.fault === undefined }

  /** Record an unload that bypassed the account's ordered shutdown. */
  ownerUnloaded(): void {
    if (!this.providerClosing) this.cleanupFailed(new Error('Office provider was unloaded outside its account shutdown.'), 'owner-unloaded')
  }

  /** Close conversion admission and retain the first unresolved cleanup failure.
   * @param cause Original failure; repeated failures cannot replace its identity.
   * @param phase Fixed internal failure location; external text is never emitted.
   */
  cleanupFailed(cause: unknown, phase: FailurePhase = 'provider-log'): void {
    this.accepting = false
    if (this.fault !== undefined) return
    this.fault = { cause }
    try { this.report(phase) }
    catch (_reportFailure) { console.error('Office cleanup is unconfirmed; account resources remain retained.') }
  }

  /**
   * Stop admission, join actual calls, then authorize original account-owned disposal.
   * @param deadlineAtMs Existing account shutdown deadline; expiry retains the actual close.
   * @returns The same finite conversion-drain observation; final provider disposal remains account-owned.
   */
  stop(deadlineAtMs: number): Promise<void> {
    if (this.closeObservation !== undefined) return this.closeObservation
    this.accepting = false
    this.actualClose = (async () => {
      await Promise.all([...this.tasks])
      this.providerClosing = true
      try { await this.dispose() }
      catch (cause) { this.cleanupFailed(cause, 'provider-close') }
      if (this.fault !== undefined) throw new OfficeStopUnconfirmed(this.fault.cause)
    })()
    void this.actualClose.catch((_cause: unknown) => { /* Original close stays retained after observation expiry. */ })
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const failure = new OfficeStopUnconfirmed()
        this.cleanupFailed(failure, 'deadline')
        reject(failure)
      }, Math.max(0, deadlineAtMs - Date.now()))
      timer.unref()
    })
    this.closeObservation = Promise.race([this.actualClose, expired]).then(() => {
      if (this.fault !== undefined) throw new OfficeStopUnconfirmed(this.fault.cause)
    }, (cause: unknown) => {
      this.cleanupFailed(cause, 'close-observer')
      throw cause
    }).finally(() => { clearTimeout(timer) })
    void this.closeObservation.catch((_cause: unknown) => { /* The original account drain observes this result. */ })
    return this.closeObservation
  }

  private unavailable(): OfficeToPdfError {
    return new OfficeToPdfError('unavailable', 'The account Office converter is unavailable.')
  }
}
