/** Internal scheduling only: no path access, quota authority, worker provider, or account identity. */
import { randomUUID } from 'node:crypto'
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FilesLimits } from './types.ts'
import { FilesFailure } from './error.ts'
import { directoryWorkBudget } from './directory-budget.ts'
import type { DirectoryIntent, DirectoryBudgetLimits } from './directory-budget.ts'
import { DirectoryResponsibility } from './directory-responsibility.ts'
import type { DirectoryPrepareWork, DirectoryCleanupWork, OwnedDirectoryWork, DirectoryObservation } from './directory-responsibility.ts'

/** Retains the complete reservation until the consumer releases its result. */
export interface ResidentResult<T> {
  readonly value: T
  release(): void
}

/** Internal capability minted by one queue; never derived from a request identity. */
export interface WorkLane {
  /**
   * Reserve finite capacity for one operation and any result retained by the service.
   * @param reservedBytes Positive safe integer covering the operation's buffers and overhead.
   * @param work Backend work whose actual settlement remains owned after caller cancellation.
   * @param signal Cancels this caller's wait and signals actual work to stop.
   * @returns A result whose reservation remains held until release.
   */
  run<T>(reservedBytes: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<ResidentResult<T>>
  /** Register responsibility and preparation I/O atomically; no storage authority is issued. */
  prepareDirectory(
    intent: DirectoryIntent, limits: DirectoryBudgetLimits, work: DirectoryPrepareWork,
  ): OwnedDirectoryWork
  /** Package-private registration attachment; no transfer is exposed on the observation or generic control. */
  captureRegistration(observation: DirectoryObservation): DirectoryResponsibility
  close(): void
  pending(): readonly OperationId[]
  onSettled(listener: () => void): () => void
}

interface LaneState {
  accepting: boolean
  running: number
  queued: number
  residentBytes: number
  readonly records: Set<RecordState>
  readonly directories: Set<DirectoryResponsibility>
  readonly settledListeners: Set<() => void>
}

interface RecordState {
  readonly id: OperationId
  readonly lane: LaneState
  readonly reservedBytes: number
  readonly controller: AbortController
  readonly work: (signal: AbortSignal) => Promise<unknown>
  readonly deliver: (value: unknown, release: () => void) => void
  readonly reject: (reason: unknown) => void
  readonly owned?: { readonly responsibility: DirectoryResponsibility; readonly operation: 'prepare' | 'cleanup' }
  cleanupWait: () => void
  phase: 'queued' | 'running' | 'retained' | 'settled'
  abandoned: boolean
  invoked: boolean
}

function callerAbortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new FilesFailure('files/aborted', 'files caller aborted', { cause: reason })
}

function reportSettlementFailure(_error: unknown): void {
  console.error('cloud files settlement observer failed; its owner must review lifecycle cleanup')
}

/**
 * Files-owned scheduler. Admission counts queued/running buffers and retained results or directory responsibility.
 * Caller abort rejects its wait, while running work remains owned until actual settlement.
 */
export class FilesWorkQueue {
  private accepting = true
  private readonly lanes = new Set<LaneState>()
  private readonly queue: RecordState[] = []
  private running = 0
  private residentBytes = 0
  private readonly finished = Promise.withResolvers<void>()

  constructor(
    private readonly limits: FilesLimits,
    private readonly reportObserverError: (error: unknown) => void = reportSettlementFailure,
  ) {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new FilesFailure('files/prerequisite-missing', `files budget ${key} must be a positive safe integer`)
      }
    }
    if (limits.waitTimeoutMs > 2_147_483_647
      || limits.maxRunningPerLane > limits.maxRunning
      || limits.maxQueuedPerLane > limits.maxQueued
      || limits.maxResidentBytesPerLane > limits.maxResidentBytes) {
      throw new FilesFailure('files/prerequisite-missing', 'files budgets exceed their global or timer limits')
    }
  }

  /**
   * Create an internal lane; the runtime adapter must bind it to one immutable account generation.
   * @returns A lane sharing this queue's finite running, queued, and resident budgets.
   */
  openLane(): WorkLane {
    if (!this.accepting) throw new FilesFailure('cloud/stale-generation', 'files admission is closed')
    if (this.lanes.size >= this.limits.maxLanes) this.capacity()
    const lane: LaneState = {
      accepting: true, running: 0, queued: 0, residentBytes: 0,
      records: new Set(), directories: new Set(), settledListeners: new Set(),
    }
    this.lanes.add(lane)
    return Object.freeze({
      run: <T>(bytes: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) =>
        this.submit(lane, bytes, work, signal),
      prepareDirectory: (
        intent: DirectoryIntent, limits: DirectoryBudgetLimits, work: DirectoryPrepareWork,
      ) =>
        this.prepareDirectory(lane, intent, limits, work),
      captureRegistration: (observation: DirectoryObservation) => {
        this.assertBusiness(lane)
        for (const record of lane.directories) {
          if (record.port.observation !== observation) continue
          record.beginRegistration()
          return record
        }
        throw new FilesFailure('cloud/stale-generation', 'directory registration does not belong to this lane')
      },
      close: () => { this.closeLane(lane) },
      pending: () => this.lanePending(lane),
      onSettled: (listener: () => void) => {
        if (!lane.accepting && this.lanePending(lane).length === 0) this.notify(listener)
        else lane.settledListeners.add(listener)
        return () => { lane.settledListeners.delete(listener) }
      },
    })
  }

  /** Stop business admission; only cleanup of existing responsibilities remains eligible. */
  close(): void {
    this.accepting = false
    for (const lane of this.lanes) this.closeLane(lane)
    if (this.lanes.size === 0) this.finished.resolve()
  }

  /** Resolve only when root admission is closed and every actual task/result reservation has ended. */
  whenClosed(): Promise<void> { return this.finished.promise }

  /**
   * Return actual operation ids, held results and unresolved directory responsibility; deadlines never remove them.
   * @returns Ids of all unsettled operations and unreleased results across the lanes.
   */
  pending(): readonly OperationId[] { return [...this.lanes].flatMap(lane => this.lanePending(lane)) }

  /**
   * Return actual running/queued/retained counts for internal drain integration.
   * @returns Current work, lane, and resident-reservation counts.
   */
  inspect(): Readonly<{ running: number; queued: number; residentBytes: number; pending: number; lanes: number }> {
    return {
      running: this.running,
      queued: this.queue.length,
      residentBytes: this.residentBytes,
      pending: this.pending().length,
      lanes: this.lanes.size,
    }
  }

  private submit<T>(
    lane: LaneState,
    bytes: number,
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<ResidentResult<T>> {
    try {
      this.assertBusiness(lane)
      if (signal?.aborted) throw callerAbortReason(signal)
      if (!Number.isSafeInteger(bytes) || bytes < 1) {
        throw new FilesFailure('cloud/capacity', 'files reservation must be a positive safe byte count')
      }
      this.admit(lane, bytes)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new FilesFailure('files/prerequisite-missing', 'files admission failed', { cause: error }))
    }
    return this.enqueue(lane, bytes, work, signal)
  }

  private assertBusiness(lane: LaneState): void {
    if (!this.accepting || !lane.accepting) {
      throw new FilesFailure('cloud/stale-generation', 'files generation admission is closed')
    }
  }

  private admit(lane: LaneState, bytes: number): void {
    if (bytes > this.limits.maxResidentBytes - this.residentBytes
      || bytes > this.limits.maxResidentBytesPerLane - lane.residentBytes) {
      throw new FilesFailure('cloud/capacity', 'files resident byte budget is full')
    }
    const canRun = this.running < this.limits.maxRunning && lane.running < this.limits.maxRunningPerLane
    if (!canRun && (this.queue.length >= this.limits.maxQueued || lane.queued >= this.limits.maxQueuedPerLane)) {
      throw new FilesFailure('cloud/capacity', 'files queue is full')
    }
  }

  private prepareDirectory(
    lane: LaneState, intent: DirectoryIntent, limits: DirectoryBudgetLimits,
    work: DirectoryPrepareWork,
  ): OwnedDirectoryWork {
    this.assertBusiness(lane)
    const budget = directoryWorkBudget(intent, limits)
    let existing: DirectoryResponsibility | undefined
    for (const record of lane.directories) {
      if (record.intent.leaf === intent.leaf && (record.intent.parent.rootPath === intent.parent.rootPath
        || (record.intent.parent.rootDevice === intent.parent.rootDevice && record.intent.parent.rootInode === intent.parent.rootInode))) {
        existing = record
        break
      }
    }
    if (existing !== undefined) {
      if (existing.intent.parent.rootDevice !== intent.parent.rootDevice || existing.intent.parent.rootInode !== intent.parent.rootInode) {
        throw new FilesFailure('cloud/stale-generation', 'directory location already has an unresolved identity')
      }
      return existing.port
    }
    this.admit(lane, budget.totalBytes)
    const fixed = Object.freeze({ parent: Object.freeze({ ...intent.parent }), leaf: intent.leaf })
    const responsibility = new DirectoryResponsibility(
      randomUUID() as OperationId, fixed, budget, this.limits.waitTimeoutMs,
      () => { this.assertBusiness(lane) },
      (cleanup) => { this.cleanupDirectory(lane, responsibility, cleanup) },
      () => {
        lane.directories.delete(responsibility)
        this.residentBytes -= budget.responsibilityBytes
        lane.residentBytes -= budget.responsibilityBytes
        this.retireLane(lane)
      },
    )
    lane.directories.add(responsibility)
    this.residentBytes += budget.responsibilityBytes
    lane.residentBytes += budget.responsibilityBytes
    // The synchronous combined admission precedes both registration and the first callback microtask.
    void this.enqueue(lane, budget.ioBytes, signal => work(signal, fixed), undefined,
      { responsibility, operation: 'prepare' }).catch((_error: unknown) => {
      // The independent responsibility already observes actual completion after shutdown rejects this internal wait.
    })
    return responsibility.port
  }

  private cleanupDirectory(lane: LaneState, responsibility: DirectoryResponsibility, work: DirectoryCleanupWork): void {
    if (!this.lanes.has(lane) || !lane.directories.has(responsibility)) {
      throw new FilesFailure('cloud/stale-generation', 'directory responsibility is no longer owned')
    }
    // Cleanup uses its retained scratch; only shared running/queued capacity needs admission.
    this.admit(lane, 0)
    void this.enqueue(lane, 0, signal => work(responsibility.cleanupIdentity(), signal, responsibility.intent), undefined,
      { responsibility, operation: 'cleanup' }).catch((_error: unknown) => {
      // Actual cleanup completion is delivered through the retained responsibility, not this internal wait.
    })
  }

  private enqueue<T>(
    lane: LaneState, bytes: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
    owned?: RecordState['owned'],
  ): Promise<ResidentResult<T>> {
    const canRun = this.running < this.limits.maxRunning && lane.running < this.limits.maxRunningPerLane
    return new Promise<ResidentResult<T>>((resolve, reject) => {
      const record: RecordState = {
        id: owned?.responsibility.id ?? randomUUID() as OperationId, lane, reservedBytes: bytes, controller: new AbortController(),
        work,
        deliver: (value, release) => { resolve({ value: value as T, release }) },
        reject, cleanupWait: () => {}, phase: 'queued', abandoned: false, invoked: false,
        ...owned === undefined ? {} : { owned },
      }
      this.residentBytes += bytes
      lane.residentBytes += bytes
      lane.records.add(record)
      const abort = (): void => {
        if (signal !== undefined) this.abandon(record, callerAbortReason(signal))
      }
      const timer = owned === undefined ? setTimeout(() => {
        this.abandon(record, new FilesFailure('files/deadline', 'files wait deadline expired; actual work may remain pending'))
      }, this.limits.waitTimeoutMs) : undefined
      record.cleanupWait = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (canRun) this.start(record)
      else {
        lane.queued++
        this.queue.push(record)
      }
    })
  }

  private start(record: RecordState): void {
    record.phase = 'running'
    this.running++
    record.lane.running++
    // Register ownership before invoking a backend that may throw synchronously.
    void Promise.resolve().then(() => {
      if (record.controller.signal.aborted) throw callerAbortReason(record.controller.signal)
      record.invoked = true
      return record.work(record.controller.signal)
    }).then(
      (value) => { this.complete(record, { kind: 'success', value }) },
      (reason: unknown) => { this.complete(record, { kind: 'failure', reason }) },
    )
  }

  private complete(record: RecordState, result: { kind: 'success'; value: unknown } | { kind: 'failure'; reason: unknown }): void {
    this.running--
    record.lane.running--
    record.cleanupWait()
    if (record.owned !== undefined) {
      const { responsibility, operation } = record.owned
      const notify = operation === 'prepare' ? responsibility.prepared(result, record.invoked) : responsibility.cleaned(result)
      this.release(record)
      record.deliver(undefined, () => {})
      this.pump()
      notify()
      return
    }
    if (result.kind === 'failure') {
      if (!record.abandoned) record.reject(result.reason)
      this.release(record)
    } else if (record.abandoned) {
      this.release(record)
    } else {
      record.phase = 'retained'
      record.deliver(result.value, () => { this.release(record) })
    }
    this.pump()
  }

  private abandon(record: RecordState, reason: unknown): void {
    if (record.phase !== 'queued' && record.phase !== 'running') return
    if (record.abandoned) return
    record.abandoned = true
    record.cleanupWait()
    record.reject(reason)
    record.controller.abort(reason)
    if (record.phase === 'queued') {
      const index = this.queue.indexOf(record)
      if (index !== -1) this.queue.splice(index, 1)
      record.lane.queued--
      record.owned?.responsibility.undispatched(reason)
      this.release(record)
      this.pump()
    }
  }

  private release(record: RecordState): void {
    if (record.phase === 'settled') return
    record.phase = 'settled'
    record.lane.records.delete(record)
    this.residentBytes -= record.reservedBytes
    record.lane.residentBytes -= record.reservedBytes
    this.retireLane(record.lane)
  }

  private closeLane(lane: LaneState): void {
    lane.accepting = false
    const reason = new FilesFailure('cloud/stale-generation', 'files generation is stopping')
    for (const responsibility of lane.directories) responsibility.stop(reason)
    for (const record of [...lane.records]) {
      if (record.owned?.operation !== 'cleanup') this.abandon(record, reason)
    }
    this.retireLane(lane)
  }

  private retireLane(lane: LaneState): void {
    if (!lane.accepting && lane.records.size === 0 && lane.directories.size === 0) {
      this.lanes.delete(lane)
      for (const listener of lane.settledListeners) this.notify(listener)
      lane.settledListeners.clear()
      if (!this.accepting && this.lanes.size === 0) this.finished.resolve()
    }
  }

  private pump(): void {
    while (this.running < this.limits.maxRunning) {
      const index = this.queue.findIndex(record =>
        (record.owned?.operation === 'cleanup' || (this.accepting && record.lane.accepting))
        && record.lane.running < this.limits.maxRunningPerLane)
      if (index === -1) return
      const record = this.queue.splice(index, 1)[0]
      if (record === undefined) throw new Error('files queue entry disappeared')
      record.lane.queued--
      this.start(record)
    }
  }

  private lanePending(lane: LaneState): OperationId[] {
    return [...new Set([...lane.records, ...lane.directories].map(record => record.id))]
  }

  private capacity(): never {
    throw new FilesFailure('cloud/capacity', 'files account lane budget is full')
  }

  private notify(listener: () => void): void {
    try { listener() } catch (error) {
      try { this.reportObserverError(error) } catch (_reportError) {
        console.error('cloud files observer error reporting failed; review lifecycle cleanup')
      }
    }
  }
}
