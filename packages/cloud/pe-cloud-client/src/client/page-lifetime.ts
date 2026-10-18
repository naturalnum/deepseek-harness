/** Pre-activation owner of one native page, captured carrier and persistence port. */
import type { ClientPersistence } from '@deepseek-ai/dsh-client-store'
import type { RequestExpectation } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { ClientFailure } from './errors.ts'
import { CloudPagePersistence, type CloudPersistenceLimits, type CloudPersistenceStorage } from './persistence.ts'
import { BoundTransport, type BoundTransportInput } from './transport.ts'

/** Existing native entry lifecycle; the owner constructs it with nativeOptions before start. */
export interface CloudNativeEntry {
  /**
   * @param onFailure - receives a fatal startup failure before account UI is admitted.
   * @returns actual startup completion.
   */
  run(onFailure?: (reason: unknown) => void): Promise<void>
  /** @returns actual native startup, subscriptions and graph cleanup completion. */
  dispose(): Promise<void>
}

/** Owner-validated bootstrap result and explicit storage/carrier dependencies. */
export interface CloudPageLifetimeInput {
  readonly expectation: RequestExpectation
  readonly storage: CloudPersistenceStorage
  readonly persistenceLimits: CloudPersistenceLimits
  readonly transport: Omit<BoundTransportInput, 'expectation' | 'beforeClose'>
}

/** Local browser cleanup facts; stopped does not assert server drain. */
export interface CloudPageSnapshot {
  readonly phase: 'idle' | 'running' | 'stopping' | 'stopped' | 'unconfirmed'
}

/**
 * Construct before AppWebEntry, install transport.hooks before native Connection,
 * and pass nativeOptions to AppWebEntry. No authentication or bootstrap DTO is inferred.
 */
export class CloudPageLifetime {
  /** Captured carrier for the native connection installer and navigation consumers. */
  readonly transport: BoundTransport
  /** Owner-only cache cleanup and observable failure state. */
  readonly persistence: CloudPagePersistence
  /** Narrow AppWebEntry input; cannot silently fall back to ordinary storage. */
  readonly nativeOptions: { readonly persistence: ClientPersistence; readonly requirePersistence: true }
  private entry: CloudNativeEntry | undefined
  private running: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private phase: CloudPageSnapshot['phase'] = 'idle'

  /** @param input - decoded fixed identity, finite limits and actual browser carriers. */
  constructor(input: CloudPageLifetimeInput) {
    const expectation = Object.freeze({ ...input.expectation })
    this.persistence = new CloudPagePersistence({
      expectation, storage: input.storage, limits: input.persistenceLimits,
      onFailure: () => { this.invalidate() },
    })
    this.nativeOptions = Object.freeze({ persistence: this.persistence.port, requirePersistence: true })
    this.transport = new BoundTransport({
      ...input.transport, expectation,
      beforeClose: () => {
        this.persistence.revoke()
        this.invalidate()
      },
    })
  }

  /**
   * Read local page cleanup state.
   * @returns the local page disposition, excluding account identity or cache contents.
   */
  getSnapshot(): CloudPageSnapshot { return { phase: this.phase } }

  /**
   * Start exactly one existing native entry, constructed with nativeOptions.
   * The caller installs transport.hooks before calling this method.
   * @param entry - unstarted native graph; repeated calls join the same entry only.
   * @returns actual startup completion, rejecting fatal startup or a closed page.
   */
  start(entry: CloudNativeEntry): Promise<void> {
    if (this.stopping !== undefined) return Promise.reject(new ClientFailure('closed'))
    if (this.running !== undefined) {
      if (entry !== this.entry) return Promise.reject(new ClientFailure('closed'))
      return this.running
    }
    if (this.phase !== 'idle') return Promise.reject(new ClientFailure('closed'))
    this.entry = entry
    this.phase = 'running'
    let failure: unknown
    let failed = false
    this.running = entry.run((reason) => { failure = reason; failed = true; this.invalidate() }).then(() => {
      if (failed) throw failure
    }, (reason: unknown) => { this.invalidate(); throw reason })
    return this.running
  }

  /**
   * Revoke first, then stop and join the carrier and native graph before clearing.
   * A failed join leaves the cache uncleared and the page unconfirmed. Repeated
   * calls share the same observation; a hung native disposer remains pending.
   * @returns confirmed local cleanup; rejects with the actual stop/cleanup failure.
   */
  dispose(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    this.persistence.revoke()
    this.phase = 'stopping'
    const completion = Promise.withResolvers<void>()
    this.stopping = completion.promise
    void this.finish().then(completion.resolve, (reason: unknown) => {
      this.phase = 'unconfirmed'
      completion.reject(reason)
    })
    return this.stopping
  }

  private invalidate(): void {
    void this.dispose().catch((error: unknown) => { console.error('Cloud page cleanup unconfirmed:', error) })
  }

  private async finish(): Promise<void> {
    const results = await Promise.allSettled([this.transport.close(), this.entry?.dispose()])
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Cloud page stop unconfirmed')
    this.persistence.clear()
    this.phase = 'stopped'
  }
}
