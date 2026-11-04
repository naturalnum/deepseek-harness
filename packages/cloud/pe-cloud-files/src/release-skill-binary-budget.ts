/** Files-owned finite residence for the explicit readonly release binary domain. */
import { FilesFailure } from './error.ts'

/** Explicit Root-selected binary budget, separate from unchanged mutable archive/RPC/storage quotas. */
export interface ReleaseSkillBinaryLimits {
  readonly maxArchiveBytes: number
  readonly maxResidentBytes: number
  readonly maxConcurrent: number
  readonly chunkBytes: number
  readonly timeoutMs: number
}
/** Files owns actual readonly ZIP residence until the original HTTP response finishes or closes. */
export class ReleaseSkillBinaryBudget {
  private resident = 0
  private active = 0
  private readonly unknown: unknown[] = []
  /** Detached finite policy selected by the original Root, without deployment defaults. */
  readonly limits: Readonly<ReleaseSkillBinaryLimits>
  constructor(limits: ReleaseSkillBinaryLimits) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
      || limits.chunkBytes > limits.maxArchiveBytes || limits.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(limits.maxArchiveBytes + limits.chunkBytes)
      || limits.maxResidentBytes < limits.maxArchiveBytes + limits.chunkBytes) throw new RangeError('Invalid readonly release binary limits.')
    this.limits = Object.freeze({ ...limits })
  }
  /** Observe actual held credits without releasing pending or unknown work.
   * @returns Current readonly transfer credits, including pending response settlement.
   */
  snapshot(): Readonly<{ active: number; residentBytes: number; cleanupUnknown: number }> {
    return { active: this.active, residentBytes: this.resident, cleanupUnknown: this.unknown.length }
  }
  /**
   * Reserve the complete original ZIP and one bounded outgoing chunk before any archive allocation.
   * @param bytes Exact pinned archive length.
   * @param consume Actual read and original physical response settlement.
   * @returns Actual consumer result; cancellation never releases early while that consumer is pending.
   */
  async withArchive<T>(bytes: number, consume: (retainUnknown: (cause: unknown) => void) => Promise<T>): Promise<T> {
    const charge = bytes + this.limits.chunkBytes
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.limits.maxArchiveBytes
      || this.active >= this.limits.maxConcurrent || charge > this.limits.maxResidentBytes - this.resident) {
      throw new FilesFailure('cloud/capacity', 'The readonly release binary budget is full.')
    }
    this.active++; this.resident += charge
    const state = { retained: false }
    try { return await consume((cause) => { if (!state.retained) { state.retained = true; this.unknown.push(cause) } }) }
    finally { if (!state.retained) { this.active--; this.resident -= charge } }
  }
}
