/** Root-owned bounded reads; no account claim, recovery authority or network admission. */
import { AccountRuntimeError } from './errors.ts'
import type { RuntimeInstanceControl } from './instance-control.ts'
import type { PostgresOwnerStore } from './owner-store.ts'
import type { AccountId, AccountOwnerResolution, AccountOwnerResolver } from './types.ts'

/** The Root retains this owner; consumers receive only its immutable resolve facade. */
export class RootOwnerResolver {
  /** Frozen read-only resolution facade; grants neither account use nor network admission. */
  readonly port: AccountOwnerResolver
  private readonly pending = new Set<Promise<AccountOwnerResolution>>()
  private closed = false
  private closing: Promise<void> | undefined

  /**
   * @param owners The original migrated owner store; only locate is retained.
   * @param instances The original migrated process registry; only locate is retained.
   * @param maximum Explicit finite actual-read capacity, independent of caller observation.
   * @param assertCurrent Check the original Root control before and after every awaited read.
   */
  constructor(
    private readonly owners: Pick<PostgresOwnerStore, 'locate'>,
    private readonly instances: Pick<RuntimeInstanceControl, 'locate'>,
    private readonly maximum: number,
    private readonly assertCurrent: (this: void) => void,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Owner resolution capacity must be a positive finite integer')
    }
    this.port = Object.freeze({ resolve: (accountId: AccountId) => this.resolve(accountId) })
  }

  /** Stop new reads and retain actual work through settlement; never cancel its SQL.
   * @returns The same close promise, including reads whose callers already left.
   */
  close(): Promise<void> {
    this.closed = true
    return this.closing ??= Promise.allSettled([...this.pending]).then(() => {})
  }

  private current(): void {
    if (this.closed) throw new AccountRuntimeError('cloud/account-unavailable', 'Owner resolution admission is closed')
    this.assertCurrent()
  }

  private resolve(accountId: AccountId): Promise<AccountOwnerResolution> {
    this.current()
    if (this.pending.size >= this.maximum) {
      throw new AccountRuntimeError('cloud/capacity', 'Owner resolution capacity is exhausted')
    }
    const actual = Promise.resolve().then(() => this.read(accountId))
    this.pending.add(actual)
    const settled = (): void => { this.pending.delete(actual) }
    void actual.then(settled, settled)
    return actual
  }

  private async read(accountId: AccountId): Promise<AccountOwnerResolution> {
    this.current()
    const owner = await this.owners.locate(accountId)
    this.current()
    if (owner === undefined || owner.ownerInstanceId === null || owner.phase !== 'ready') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'A ready account owner is unavailable')
    }
    if (owner.accountId !== accountId) {
      throw new AccountRuntimeError('cloud/stale-generation', 'Account owner metadata belongs to another account')
    }
    const instance = await this.instances.locate(owner.ownerInstanceId)
    this.current()
    if (instance === undefined || instance.phase !== 'registered') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'The account owner instance is unavailable')
    }
    if (instance.instanceId !== owner.ownerInstanceId || instance.recipeVersion !== owner.recipeVersion) {
      throw new AccountRuntimeError('cloud/stale-generation', 'Account owner and instance metadata disagree')
    }
    const current = await this.owners.locate(accountId)
    this.current()
    if (current === undefined || current.accountId !== owner.accountId || current.ownerInstanceId !== owner.ownerInstanceId
      || current.epoch !== owner.epoch || current.phase !== owner.phase || current.recipeVersion !== owner.recipeVersion) {
      throw new AccountRuntimeError('cloud/stale-generation', 'Account ownership changed during destination lookup')
    }
    return Object.freeze({ owner: current, instance })
  }
}
