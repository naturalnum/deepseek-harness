/** Local reservations retain capacity until their operation owner explicitly settles them. */
import { AccountRuntimeError } from './errors.ts'
import type { AccountId, DrainCapacityReservation, MountCapacityReservation, RuntimeConfig } from './types.ts'

/** Capacity bookkeeping only; the account factory owns PG acquisition and actual work. */
export class RuntimeCapacity {
  private readonly accounts = new Set<AccountId>()
  private readonly drains = new Set<AccountId>()
  private mounting = 0
  private closed = false

  /**
   * Bind reservations to one root's validated deployment limits.
   * @param config Explicit capacity limits after schema validation.
   */
  constructor(private readonly config: RuntimeConfig) {}

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

  private assertOpen(): void {
    if (this.closed) throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime capacity admission is closed')
  }
}
