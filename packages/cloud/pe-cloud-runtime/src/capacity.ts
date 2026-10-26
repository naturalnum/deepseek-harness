/** Local reservations retain capacity until their operation owner explicitly settles them. */
import { AccountRuntimeError } from './errors.ts'
import type { AccountId, DrainCapacityReservation, MountCapacityReservation, RuntimeConfig,
  SubagentCapacityLimits, SubagentCapacityReservation } from './types.ts'

/** Capacity bookkeeping only; the account factory owns PG acquisition and actual work. */
export class RuntimeCapacity {
  private readonly accounts = new Set<AccountId>()
  private readonly drains = new Set<AccountId>()
  private mounting = 0
  private readonly subagentSlots = new Map<symbol, AccountId>()
  private readonly subagentLimits: SubagentCapacityLimits | undefined
  private closed = false

  /**
   * Bind reservations to one root's validated deployment limits.
   * @param config Explicit capacity limits after schema validation.
   * @param subagents Explicit immutable local hard limits; omission closes child reservations.
   */
  constructor(private readonly config: RuntimeConfig, subagents?: SubagentCapacityLimits) {
    if (subagents !== undefined) {
      if (!Number.isSafeInteger(subagents.maxActivePerAccount) || subagents.maxActivePerAccount < 1
        || !Number.isSafeInteger(subagents.maxActiveTotal) || subagents.maxActiveTotal < 1
        || !Number.isSafeInteger(subagents.maxDepth) || subagents.maxDepth < 0) {
        throw new AccountRuntimeError('cloud/invalid-config', 'Subagent hard limits require explicit finite integer capacities and depth')
      }
      this.subagentLimits = Object.freeze({ ...subagents })
    }
  }

  /** Stop new reservations without claiming that existing work has stopped. */
  close(): void { this.closed = true }

  /**
   * Hold an account slot and a concurrent-mount slot before factory work begins.
   * @param accountId Trusted account selected by access and the owner factory.
   * @returns An operation-owned reservation; neither a PG owner nor a ready graph.
   * @throws AccountRuntimeError when closed, already reserved, or over either limit.
   */
  reserveMount(accountId: AccountId): MountCapacityReservation {
    this.assertOpen()
    if (this.accounts.has(accountId)) {
      throw new AccountRuntimeError('cloud/account-starting', 'Account capacity is already reserved on this instance')
    }
    if (this.accounts.size >= this.config.maxMountedAccounts || this.mounting >= this.config.maxConcurrentMounts) {
      throw new AccountRuntimeError('cloud/capacity', 'Account mount capacity is exhausted')
    }
    this.accounts.add(accountId)
    this.mounting += 1
    let mounting = true
    let released = false
    return Object.freeze({
      accountId,
      settleMount: () => {
        if (!mounting) return
        mounting = false
        this.mounting -= 1
      },
      releaseAccount: () => {
        if (released) return
        this.assertSubagentsStopped(accountId)
        if (mounting || this.drains.has(accountId)) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'Account capacity is still held by actual mount or drain work')
        }
        released = true
        this.accounts.delete(accountId)
      },
    })
  }

  /**
   * Reserve a drain slot while keeping the account's local slot held.
   * @param accountId Account already reserved by this root's factory.
   * @returns A slot retained until its actual drain settles.
   * @throws AccountRuntimeError for missing account capacity, concurrent drain, closure, or exhaustion.
   */
  reserveDrain(accountId: AccountId): DrainCapacityReservation {
    this.assertOpen()
    if (!this.accounts.has(accountId)) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Account has no local capacity reservation')
    }
    if (this.drains.has(accountId) || this.drains.size >= this.config.maxConcurrentDrains) {
      throw new AccountRuntimeError('cloud/capacity', 'Account drain capacity is exhausted')
    }
    this.drains.add(accountId)
    let released = false
    return Object.freeze({
      accountId,
      release: () => {
        if (released) return
        released = true
        this.drains.delete(accountId)
      },
    })
  }

  /**
   * Reserve one child across every root Session owned by an already reserved account.
   * This is bookkeeping only: the caller must authorize the exact live parent,
   * graph epoch, project, model, Preset and actual create/resume before calling.
   * Native subtree capacity remains independently enforced by SubagentRuntime.
   * @param accountId Account already retained by this exact runtime owner.
   * @param depth Actual child depth derived from validated parent/history, never the user's cap.
   * @returns One reservation retained through actual native destruction; unknown cannot release it.
   * @throws AccountRuntimeError when closed, unconfigured, accountless or over a hard limit.
   */
  reserveSubagent(accountId: AccountId, depth: number): SubagentCapacityReservation {
    this.assertOpen()
    const limits = this.subagentLimits
    if (limits === undefined || !this.accounts.has(accountId)) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Subagent capacity requires explicit hard limits and an existing account reservation')
    }
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > limits.maxDepth) {
      throw new AccountRuntimeError('cloud/capacity', 'Subagent platform depth is exhausted')
    }
    let active = 0
    for (const account of this.subagentSlots.values()) if (account === accountId) active += 1
    if (active >= limits.maxActivePerAccount || this.subagentSlots.size >= limits.maxActiveTotal) {
      throw new AccountRuntimeError('cloud/capacity', 'Subagent account or platform capacity is exhausted')
    }
    const slot = Symbol()
    this.subagentSlots.set(slot, accountId)
    let settled = false
    return Object.freeze({ settle: (status: 'confirmed' | 'unknown') => {
      if (settled) return
      settled = true
      if (status === 'confirmed') this.subagentSlots.delete(slot)
    } })
  }

  /**
   * Require every child reservation to have confirmed cleanup before durable owner release.
   * @param accountId Account retained by the factory's actual close transaction.
   * @throws AccountRuntimeError while any active or unknown child reservation remains.
   */
  assertSubagentsStopped(accountId: AccountId): void {
    if (this.hasSubagents(accountId)) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Account subagent capacity is retained by unconfirmed actual cleanup')
    }
  }

  private hasSubagents(accountId: AccountId): boolean {
    for (const account of this.subagentSlots.values()) if (account === accountId) return true
    return false
  }

  private assertOpen(): void {
    if (this.closed) throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime capacity admission is closed')
  }
}
