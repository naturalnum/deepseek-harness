/** Internal account-bound actual-work owner; runtime and storage mounting remain separate. */
import type { AccountBinding, AccountId, DrainParticipant, ParticipantReceipt, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FilesLimits } from './types.ts'
import { FilesFailure } from './error.ts'
import { FilesWorkQueue } from './work-queue.ts'
import type { ResidentResult, WorkLane } from './work-queue.ts'
import type { DirectoryIntent, DirectoryBudgetLimits } from './directory-budget.ts'
import type { DirectoryPrepareWork, DirectoryCleanupWork, OwnedDirectoryWork } from './directory-responsibility.ts'

/** Internal port for an audited files backend, not an RPC or a native FileSystem substitute. */
export interface BoundFilesWork {
  readonly stopping: AbortSignal
  assertCurrent(): void
  run<T>(reservedBytes: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<ResidentResult<T>>
  /** Register a bounded private responsibility on this same lane; this does not authorize directory writes. */
  prepareDirectory(
    intent: DirectoryIntent, limits: DirectoryBudgetLimits, work: DirectoryPrepareWork,
  ): OwnedDirectoryWork
}

interface Generation {
  readonly binding: AccountBinding
  readonly lane: WorkLane
  readonly stopping: AbortController
}

/** Owns actual file work and temporary directory responsibility; it never grants storage authority or ready state. */
export class FilesWorkOwner implements DrainParticipant {
  readonly id: Extract<DrainParticipant['id'], 'files'> = 'files'
  private readonly queue: FilesWorkQueue
  private readonly active = new Map<AccountId, Generation>()
  private readonly retired = new WeakSet<AccountBinding>()

  constructor(limits: FilesLimits) {
    this.queue = new FilesWorkQueue(limits)
  }

  /**
   * Bind an internal lane to exact runtime input and its current-owner check.
   * A trusted factory must verify storage/roots before this can back file operations.
   * @param binding Runtime-owned immutable generation, never request JSON.
   * @param assertCurrent Runtime-owned current-owner/admission check, invoked on every submission.
   * @returns A port that cannot select another account or close the shared pool.
   */
  bind(binding: AccountBinding, assertCurrent: () => void): BoundFilesWork {
    assertCurrent()
    if (binding.lifetime.aborted || this.retired.has(binding)) this.stale()
    if (this.active.has(binding.accountId)) {
      throw new FilesFailure('cloud/stale-generation', 'files account already has a bound generation')
    }
    const lane = this.queue.openLane()
    const abort = (): void => { this.stopGeneration(binding) }
    const stopping = new AbortController()
    const generation: Generation = { binding, lane, stopping }
    this.active.set(binding.accountId, generation)
    binding.lifetime.addEventListener('abort', abort, { once: true })
    lane.onSettled(() => {
      binding.lifetime.removeEventListener('abort', abort)
      if (this.active.get(binding.accountId) === generation) this.active.delete(binding.accountId)
    })
    const current = (): void => {
      assertCurrent()
      if (binding.lifetime.aborted || this.retired.has(binding)) this.stale()
    }
    return Object.freeze({
      stopping: stopping.signal,
      assertCurrent: () => {
        current()
      },
      run: <T>(bytes: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        current()
        return lane.run(bytes, work, signal)
      },
      prepareDirectory: (
        intent: DirectoryIntent, limits: DirectoryBudgetLimits, work: DirectoryPrepareWork,
      ) => {
        current()
        const owned = lane.prepareDirectory(intent, limits, work)
        return Object.freeze({
          observation: owned.observation,
          control: Object.freeze({
            expose: () => { current(); return owned.control.expose() },
            // Existing responsibility cleanup survives business closure; it cannot issue a new intent.
            cleanup: (work: DirectoryCleanupWork, signal?: AbortSignal) => owned.control.cleanup(work, signal),
          }),
        })
      },
    })
  }

  /**
   * Stop exact-generation admission and wait only until the caller's deadline.
   * An unknown receipt retains operation ownership; a later check may confirm actual settlement.
   * @param binding Exact input previously bound by the trusted factory.
   * @param deadlineAtMs Finite absolute server-time deadline within the Node timer range.
   * @returns Confirmed only once actual work, held results and temporary directory responsibility have ended.
   */
  async stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt> {
    const generation = this.active.get(binding.accountId)
    if (generation === undefined) {
      if (this.retired.has(binding)) return this.receipt(binding, [])
      return this.stale()
    }
    if (generation.binding !== binding) return this.stale()
    const remaining = deadlineAtMs - Date.now()
    if (!Number.isSafeInteger(deadlineAtMs) || remaining > 2_147_483_647) {
      throw new FilesFailure('files/prerequisite-missing', 'files drain requires a finite bounded server deadline')
    }
    this.stopGeneration(binding)
    if (generation.lane.pending().length > 0 && remaining > 0) {
      await new Promise<void>((resolve) => {
        let unobserve = (): void => {}
        const timer = setTimeout(() => { unobserve(); resolve() }, remaining)
        unobserve = generation.lane.onSettled(() => {
          clearTimeout(timer)
          unobserve()
          resolve()
        })
      })
    }
    return this.receipt(binding, generation.lane.pending())
  }

  /** Stop root admission without claiming that unsettled resources have ended. */
  close(): void {
    const generations = [...this.active.values()]
    this.queue.close()
    for (const generation of generations) {
      this.retired.add(generation.binding)
      generation.stopping.abort()
      generation.lane.close()
    }
  }

  /** Observe actual root quiescence without treating the caller's deadline as resource completion. */
  whenClosed(): Promise<void> { return this.queue.whenClosed() }

  /**
   * List actual pending file work for the root lifecycle receipt.
   * @returns Operation ids whose actual work or held results remain owned.
   */
  pending(): readonly OperationId[] { return this.queue.pending() }

  private stopGeneration(binding: AccountBinding): void {
    const generation = this.active.get(binding.accountId)
    if (generation?.binding !== binding) return
    this.retired.add(binding)
    generation.stopping.abort()
    generation.lane.close()
  }

  private receipt(binding: AccountBinding, pending: ReturnType<WorkLane['pending']>): ParticipantReceipt {
    const base = { participant: this.id, accountId: binding.accountId, epoch: binding.epoch, evidenceRefs: [] }
    return pending.length === 0
      ? { ...base, status: 'confirmed', pendingOperationIds: [] }
      : { ...base, status: 'unknown', pendingOperationIds: pending, reason: 'actual-file-work-unsettled' }
  }

  private stale(): never {
    throw new FilesFailure('cloud/stale-generation', 'files capability does not belong to the bound generation')
  }
}
