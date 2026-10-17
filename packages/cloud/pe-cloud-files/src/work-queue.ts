/** Internal scheduling only: no path access, quota authority, worker provider, or account identity. */
import { randomUUID } from 'node:crypto'
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FilesLimits } from './types.ts'
import { FilesFailure } from './error.ts'

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
  cleanupWait: () => void
  phase: 'queued' | 'running' | 'retained' | 'settled'
  abandoned: boolean
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
 * Files-owned scheduler. Admission counts queued, running, and retained buffers.
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
      records: new Set(), settledListeners: new Set(),
    }
    this.lanes.add(lane)
    return Object.freeze({
      run: <T>(bytes: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) =>
        this.submit(lane, bytes, work, signal),
      close: () => { this.closeLane(lane) },
      pending: () => [...lane.records].map(record => record.id),
      onSettled: (listener: () => void) => {
        if (!lane.accepting && lane.records.size === 0) this.notify(listener)
        else lane.settledListeners.add(listener)
        return () => { lane.settledListeners.delete(listener) }
      },
    })
  }

  /** Stop all admission; unresolved tasks and retained results remain observable. */
  close(): void {
    this.accepting = false
    for (const lane of this.lanes) this.closeLane(lane)
    if (this.lanes.size === 0) this.finished.resolve()
  }

  /** Resolve only when root admission is closed and every actual task/result reservation has ended. */
  whenClosed(): Promise<void> { return this.finished.promise }

  /**
   * Return actual operation ids, including held results; caller deadlines never remove them.
   * @returns Ids of all unsettled operations and unreleased results across the lanes.
   */
  pending(): readonly OperationId[] { return [...this.lanes].flatMap(lane => [...lane.records].map(record => record.id)) }

  /**
   * Return actual running/queued/retained counts for internal drain integration.
   * @returns Current work, lane, and resident-reservation counts.
   */
  inspect(): Readonly<{ running: number; queued: number; residentBytes: number; pending: number; lanes: number }> {
    return {
      running: this.running,
      queued: this.queue.length,
      residentBytes: this.residentBytes,
      pending: [...this.lanes].reduce((total, lane) => total + lane.records.size, 0),
      lanes: this.lanes.size,
    }
  }

  private submit<T>(
    lane: LaneState,
    bytes: number,
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<ResidentResult<T>> {
    if (!this.accepting || !lane.accepting) {
      return Promise.reject(new FilesFailure('cloud/stale-generation', 'files generation admission is closed'))
    }
    if (signal?.aborted) return Promise.reject(callerAbortReason(signal))
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      return Promise.reject(new FilesFailure('cloud/capacity', 'files reservation must be a positive safe byte count'))
    }
    if (bytes > this.limits.maxResidentBytes - this.residentBytes
      || bytes > this.limits.maxResidentBytesPerLane - lane.residentBytes) {
      return Promise.reject(new FilesFailure('cloud/capacity', 'files resident byte budget is full'))
    }
    const canRun = this.running < this.limits.maxRunning && lane.running < this.limits.maxRunningPerLane
    if (!canRun && (this.queue.length >= this.limits.maxQueued || lane.queued >= this.limits.maxQueuedPerLane)) {
      return Promise.reject(new FilesFailure('cloud/capacity', 'files queue is full'))
    }
    return new Promise<ResidentResult<T>>((resolve, reject) => {
      const record: RecordState = {
        id: randomUUID() as OperationId, lane, reservedBytes: bytes, controller: new AbortController(),
        work,
        deliver: (value, release) => { resolve({ value: value as T, release }) },
        reject, cleanupWait: () => {}, phase: 'queued', abandoned: false,
      }
      this.residentBytes += bytes
      lane.residentBytes += bytes
      lane.records.add(record)
      const abort = (): void => {
        if (signal !== undefined) this.abandon(record, callerAbortReason(signal))
      }
      const timer = setTimeout(() => {
        this.abandon(record, new FilesFailure('files/deadline', 'files wait deadline expired; actual work may remain pending'))
      }, this.limits.waitTimeoutMs)
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
    for (const record of [...lane.records]) {
      this.abandon(record, new FilesFailure('cloud/stale-generation', 'files generation is stopping'))
    }
    this.retireLane(lane)
  }

  private retireLane(lane: LaneState): void {
    if (!lane.accepting && lane.records.size === 0) {
      this.lanes.delete(lane)
      for (const listener of lane.settledListeners) this.notify(listener)
      lane.settledListeners.clear()
      if (!this.accepting && this.lanes.size === 0) this.finished.resolve()
    }
  }

  private pump(): void {
    if (!this.accepting) return
    while (this.running < this.limits.maxRunning) {
      const index = this.queue.findIndex(record => record.lane.accepting && record.lane.running < this.limits.maxRunningPerLane)
      if (index === -1) return
      const record = this.queue.splice(index, 1)[0]
      if (record === undefined) throw new Error('files queue entry disappeared')
      record.lane.queued--
      this.start(record)
    }
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
