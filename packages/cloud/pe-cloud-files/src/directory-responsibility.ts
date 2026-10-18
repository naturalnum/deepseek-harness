/** Bounded temporary directory ownership; no mkdir, native registration, transfer proof or storage grant. */
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { DirectoryIntent, DirectoryWorkBudget } from './directory-budget.ts'
import { FilesFailure } from './error.ts'

/** A future audited backend supplies decimal identities bounded to 20 digits each. */
export interface DirectoryCreatedIdentity {
  readonly device: string
  readonly inode: string
}

/** Only an actual bounded backend result can confirm unchanged state or a newly owned leaf. */
export type DirectoryPrepareOutcome = { readonly kind: 'unchanged' }
  | { readonly kind: 'created'; readonly identity: DirectoryCreatedIdentity }

/** Audited component callback receives the queue's frozen intent; it is not a directory backend. */
export type DirectoryPrepareWork = (signal: AbortSignal, intent: DirectoryIntent) => Promise<DirectoryPrepareOutcome>

/** Cleanup confirmation must follow actual safe removal and descriptor closure in an audited backend. */
export type DirectoryCleanupWork = (
  identity: DirectoryCreatedIdentity, signal: AbortSignal, intent: DirectoryIntent,
) => Promise<'cleaned' | 'unknown'>

/** Cancellation affects this observation, never the independent actual operation or responsibility. */
export interface DirectoryObservation {
  readonly id: OperationId
  /** Wait for actual preparation; one pending observer is allowed and its deadline does not release ownership. */
  waitPrepared(signal?: AbortSignal): Promise<'created' | 'unchanged'>
}

/** Files-owner-only controls; these cannot prove that a published directory is unused. */
export interface DirectoryOwnerControl {
  /** Mark exposure before handing the address to any consumer; cleanup may never follow exposure. */
  expose(): string
  /** Schedule one private cleanup through the original queue; callback failure or unknown keeps the reservation. */
  cleanup(work: DirectoryCleanupWork, signal?: AbortSignal): Promise<'cleaned' | 'unknown'>
}

/** Separate the business observation from the trusted owner's irreversible exposure and cleanup controls. */
export interface OwnedDirectoryWork {
  readonly observation: DirectoryObservation
  readonly control: DirectoryOwnerControl
}

interface Observer {
  readonly operation: 'prepare' | 'cleanup'
  readonly resolve: (value: 'created' | 'unchanged' | 'cleaned' | 'unknown') => void
  readonly reject: (reason: unknown) => void
  readonly dispose: () => void
}

function unavailable(): FilesFailure {
  return new FilesFailure('files/prerequisite-missing', 'directory responsibility remains unresolved')
}

function observationFailure(reason: unknown): Error {
  return reason instanceof Error ? reason : new FilesFailure('files/aborted', 'directory observation failed', { cause: reason })
}

function createdIdentity(value: unknown): DirectoryCreatedIdentity | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'created'
    || !('identity' in value) || typeof value.identity !== 'object' || value.identity === null
    || !('device' in value.identity) || !('inode' in value.identity)
    || typeof value.identity.device !== 'string' || !/^\d{1,20}$/.test(value.identity.device)
    || typeof value.identity.inode !== 'string' || !/^\d{1,20}$/.test(value.identity.inode)) return undefined
  return Object.freeze({ device: value.identity.device, inode: value.identity.inode })
}

/** Private retained record; only its original queue may dispatch its I/O or release its reservation. */
export class DirectoryResponsibility {
  /** Bounded observer and owner controls; neither can assert a registered-project transfer. */
  readonly port: OwnedDirectoryWork
  private actual: 'pending' | 'created' | 'unchanged' | 'unknown' | 'cancelled' = 'pending'
  private identity: DirectoryCreatedIdentity | undefined
  private exposed = false
  private released = false
  private stopped = false
  private cleanupState: 'idle' | 'active' | 'cleaned' | 'unknown' = 'idle'
  private observer: Observer | undefined

  constructor(
    readonly id: OperationId,
    readonly intent: DirectoryIntent,
    readonly budget: DirectoryWorkBudget,
    private readonly timeoutMs: number,
    private readonly assertBusiness: () => void,
    private readonly scheduleCleanup: (work: DirectoryCleanupWork) => void,
    private readonly release: () => void,
  ) {
    this.port = Object.freeze({
      observation: Object.freeze({ id, waitPrepared: (signal?: AbortSignal) => this.waitPrepared(signal) }),
      control: Object.freeze({
        expose: () => {
          this.assertBusiness()
          if (this.cleanupState !== 'idle' || (this.released && this.actual !== 'unchanged')
            || this.actual === 'unknown' || this.actual === 'cancelled') throw unavailable()
          this.exposed = true
          const parent = this.intent.parent.rootPath
          return `${parent === '/' ? '' : parent}/${this.intent.leaf}`
        },
        cleanup: (work: DirectoryCleanupWork, signal?: AbortSignal) => this.cleanup(work, signal),
      }),
    })
  }

  /**
   * Mark ordinary admission stopped without cancelling an existing owner's cleanup.
   * @param reason Current observer receives the original shutdown failure; it is not stored in the record.
   */
  stop(reason: unknown): void {
    this.stopped = true
    if (this.observer?.operation === 'prepare') this.reject(reason)
  }

  /**
   * Record an actual preparation result before the queue returns its I/O reservation.
   * @param result Actual callback settlement; rejection after invocation cannot prove no creation.
   * @param invoked Whether the queue actually invoked the preparation callback.
   * @returns Notification to run after the queue has released running/I/O capacity.
   */
  prepared(result: { kind: 'success'; value: unknown } | { kind: 'failure'; reason: unknown }, invoked: boolean): () => void {
    if (!invoked) {
      this.actual = 'cancelled'
      this.releaseOnce()
    } else if (result.kind === 'success' && typeof result.value === 'object' && result.value !== null
      && 'kind' in result.value && result.value.kind === 'unchanged') {
      this.actual = 'unchanged'
      this.releaseOnce()
    } else {
      this.identity = result.kind === 'success' ? createdIdentity(result.value) : undefined
      this.actual = this.identity === undefined ? 'unknown' : 'created'
    }
    return () => {
      if (result.kind === 'failure') this.reject(result.reason)
      else if (this.actual === 'created' || this.actual === 'unchanged') this.resolve(this.actual)
      else this.reject(unavailable())
    }
  }

  /**
   * Reject an undispatched preparation and conclusively end its temporary responsibility.
   * @param reason Original cancellation; no callback was invoked or dispatched.
   */
  undispatched(reason: unknown): void {
    this.actual = 'cancelled'
    this.releaseOnce()
    this.reject(reason)
  }

  /**
   * Finish one actual cleanup attempt; thrown or unknown completion retains the responsibility.
   * @param result Actual cleanup callback settlement.
   * @returns Notification to run after the queue releases its running slot.
   */
  cleaned(result: { kind: 'success'; value: unknown } | { kind: 'failure'; reason: unknown }): () => void {
    const confirmed = result.kind === 'success' && result.value === 'cleaned'
    this.cleanupState = confirmed ? 'cleaned' : 'unknown'
    if (confirmed) this.releaseOnce()
    return () => {
      if (result.kind === 'failure') this.reject(result.reason)
      else this.resolve(confirmed ? 'cleaned' : 'unknown')
    }
  }

  /**
   * Get the exact bounded identity for an already accepted cleanup, never from a caller's path.
   * @returns Identity observed by preparation; missing identity never permits cleanup admission.
   */
  cleanupIdentity(): DirectoryCreatedIdentity {
    if (this.identity === undefined) throw unavailable()
    return this.identity
  }

  private waitPrepared(signal?: AbortSignal): Promise<'created' | 'unchanged'> {
    if (signal?.aborted) return Promise.reject(observationFailure(signal.reason))
    if (this.stopped) return Promise.reject(new FilesFailure('cloud/stale-generation', 'directory generation is stopping'))
    if (this.actual === 'created' || this.actual === 'unchanged') return Promise.resolve(this.actual)
    if (this.actual !== 'pending') return Promise.reject(unavailable())
    return this.observe('prepare', signal).then((value) => {
      if (value !== 'created' && value !== 'unchanged') throw unavailable()
      return value
    })
  }

  private cleanup(work: DirectoryCleanupWork, signal?: AbortSignal): Promise<'cleaned' | 'unknown'> {
    if (signal?.aborted) return Promise.reject(observationFailure(signal.reason))
    if (this.released || this.exposed || this.actual !== 'created' || this.cleanupState !== 'idle') {
      return Promise.reject(unavailable())
    }
    // The original queue checks shared running/queued capacity before changing this record.
    try { this.scheduleCleanup(work) } catch (error) { return Promise.reject(observationFailure(error)) }
    this.cleanupState = 'active'
    return this.observe('cleanup', signal).then((value) => {
      if (value !== 'cleaned' && value !== 'unknown') throw unavailable()
      return value
    })
  }

  private observe(operation: Observer['operation'], signal?: AbortSignal): Promise<'created' | 'unchanged' | 'cleaned' | 'unknown'> {
    if (signal?.aborted) return Promise.reject(observationFailure(signal.reason))
    if (this.observer !== undefined) return Promise.reject(new FilesFailure('cloud/capacity', 'directory observer already attached'))
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.reject(signal?.reason) }
      const timer = setTimeout(() => { this.reject(new FilesFailure('files/deadline', 'directory observation deadline expired')) }, this.timeoutMs)
      this.observer = {
        operation, resolve, reject,
        dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private resolve(value: Parameters<Observer['resolve']>[0]): void {
    const observer = this.observer
    this.observer = undefined
    observer?.dispose()
    observer?.resolve(value)
  }

  private reject(reason: unknown): void {
    const observer = this.observer
    this.observer = undefined
    observer?.dispose()
    observer?.reject(reason)
  }

  private releaseOnce(): void {
    if (this.released) return
    this.released = true
    this.release()
  }
}
