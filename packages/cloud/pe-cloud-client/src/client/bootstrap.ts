/** One real bootstrap request; decoding belongs to the bootstrap DTO's owner. */
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudClientConfig } from '../types.ts'
import { ClientFailure } from './errors.ts'
import { readResponse } from './read-response.ts'

function failureOf(reason: unknown, cancelled: boolean): Error {
  return reason instanceof Error ? reason : new ClientFailure(cancelled ? 'closed' : 'bootstrap-rejected', reason)
}

/** Observable request outcome is separate from actual carrier settlement. */
export interface BootstrapSnapshot {
  readonly phase: 'loading' | 'decoded' | 'failed' | 'cancelled'
  readonly settled: boolean
  readonly cleanup: 'pending' | 'confirmed' | 'unconfirmed'
}

/** Inputs keep the owner's decoder without defining a second bootstrap DTO. */
export interface BootstrapInput<T> {
  readonly baseUrl: string
  readonly config: Pick<CloudClientConfig, 'bootstrapPath' | 'bootstrapTimeoutMs' | 'maxBootstrapResponseBytes'>
  readonly fetch: RpcFetch
  readonly decode: (input: unknown) => T
}

/** An aborted or timed-out request stays tracked until the real carrier settles. */
export class BootstrapAttempt<T> {
  private readonly abort = new AbortController()
  private snapshot: BootstrapSnapshot = { phase: 'loading', settled: false, cleanup: 'pending' }
  /** Cancellation rejects promptly; Error identity is preserved, other reasons are retained as cause. */
  readonly result: Promise<T>
  /** Resolves only after fetch, bounded body consumption, and cancellation cleanup settle. */
  readonly settled: Promise<void>

  /**
   * @param input - real same-origin fetch, explicit limits, and the owning DTO decoder.
   * @param signal - page lifetime; cancellation does not assert backend work has ended.
   */
  constructor(input: BootstrapInput<T>, signal: AbortSignal) {
    const forwardAbort = (): void => { this.abort.abort(signal.reason) }
    signal.addEventListener('abort', forwardAbort, { once: true })
    if (signal.aborted) forwardAbort()
    const timer = setTimeout(() => {
      this.abort.abort(new ClientFailure('bootstrap-timeout'))
    }, input.config.bootstrapTimeoutMs)
    const aborted = new Promise<never>((_resolve, reject) => {
      const notify = (): void => {
        this.snapshot = {
          phase: this.abort.signal.reason instanceof ClientFailure ? 'failed' : 'cancelled',
          settled: false,
          cleanup: 'pending',
        }
        reject(failureOf(this.abort.signal.reason, true))
      }
      this.abort.signal.addEventListener('abort', notify, { once: true })
      if (this.abort.signal.aborted) notify()
    })
    const work = this.run(input).catch((error: unknown) => {
      throw failureOf(error, this.abort.signal.aborted)
    })
    this.settled = work.then(() => {
      this.snapshot = { phase: 'decoded', settled: true, cleanup: 'confirmed' }
    }, (error: unknown) => {
      this.snapshot = {
        phase: this.abort.signal.aborted && !(this.abort.signal.reason instanceof ClientFailure) ? 'cancelled' : 'failed',
        settled: true,
        cleanup: error instanceof ClientFailure && error.code === 'close-unconfirmed' ? 'unconfirmed' : 'confirmed',
      }
    }).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
    })
    this.result = Promise.race([work, aborted])
  }

  /**
   * Read the bootstrap request and cleanup disposition.
   * @returns request disposition without any account details or response bytes.
   */
  getSnapshot(): BootstrapSnapshot {
    return this.snapshot
  }

  /** Abort this request; callers still inspect settled before claiming cleanup. */
  cancel(): void {
    if (this.snapshot.settled) return
    this.abort.abort(new ClientFailure('closed'))
  }

  private async run(input: BootstrapInput<T>): Promise<T> {
    this.abort.signal.throwIfAborted()
    const base = new URL(input.baseUrl)
    const target = new URL(input.config.bootstrapPath, base)
    if (!['http:', 'https:'].includes(base.protocol) || target.origin !== base.origin
      || !target.pathname.startsWith(base.pathname) || base.search !== '' || base.hash !== ''
      || base.username !== '' || base.password !== '' || !base.pathname.endsWith('/')) {
      throw new ClientFailure('target-denied')
    }
    const response = await input.fetch(target, {
      method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: this.abort.signal,
    })
    if (this.abort.signal.aborted) {
      await this.discard(response, this.abort.signal.reason)
      this.abort.signal.throwIfAborted()
    }
    if (!response.ok) {
      await this.discard(response)
      throw new ClientFailure(response.status === 401 ? 'unauthenticated' : 'bootstrap-rejected')
    }
    const bytes = await readResponse(response, input.config.maxBootstrapResponseBytes, this.abort.signal)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      throw new ClientFailure('bootstrap-invalid', error)
    }
    this.abort.signal.throwIfAborted()
    const decoded = input.decode(value)
    this.abort.signal.throwIfAborted()
    return decoded
  }

  private async discard(response: Response, reason?: unknown): Promise<void> {
    try {
      await response.body?.cancel(reason)
    } catch (error) {
      throw new ClientFailure('close-unconfirmed', error)
    }
  }
}
