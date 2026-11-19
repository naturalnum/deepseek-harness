/** Private Root receipt coordination after the original writer and provider have settled. */
import type { AllocationScope } from './allocation-types.ts'

/** Binding supplied by the original allocation owner after its local stop checks. */
export interface OriginalDeletionBinding extends AllocationScope {
  readonly sandboxId: string
  readonly containerId: string
  readonly providerGeneration: string
  readonly policyDigest: string
}

/** Opaque digest of the authenticated provider's positive terminal receipt. */
export interface AllocationDeletionReceipt extends OriginalDeletionBinding {
  readonly receiptDigest: string
}

/** Exact receipt retained with a released allocation, including after its ACK. */
export interface PersistedDeletionReceipt {
  readonly state: 'released'
  readonly ack: 'pending' | 'acknowledged'
  readonly receipt: AllocationDeletionReceipt
}

/** Durable application adapter sharing the allocation CAS's actual database authority. */
export interface AllocationReceiptStorage {
  /**
   * Commit the exact stopping-to-released CAS, immutable receipt and one pending slot atomically.
   * Existing exact receipts are idempotent. A failed CAS or full outbox has no side effects.
   * @param receipt - verified original binding and terminal digest, including the current allocation epoch.
   * @param capacity - maximum durable pending slots, enforced in the transaction across all writers for this outbox.
   * @returns driver settlement status; a rejection may result from a lost committed response.
   */
  release(receipt: AllocationDeletionReceipt, capacity: number): Promise<'recorded' | 'conflict' | 'capacity'>

  /**
   * Read committed evidence from the same durability authority, independent of mutation replies.
   * @param scope - complete original allocation key.
   * @returns the exact retained receipt joined to a released row, or undefined when no receipt exists.
   */
  read(scope: AllocationScope): Promise<PersistedDeletionReceipt | undefined>

  /**
   * Read the current outbox identities for restart/retry using the application's trusted scope.
   * @param limit - configured bound; a capacity violation must fail instead of hiding pending records.
   * @returns at most limit complete original allocation keys; each is read again before sending an ACK.
   */
  pending(limit: number): Promise<readonly AllocationScope[]>

  /**
   * CAS the exact pending receipt to acknowledged and free its outbox slot in the same durable commit.
   * The receipt and its binding remain available for exact readback.
   * @param receipt - authenticated ACK result already checked against the durable original binding.
   * @returns actual driver settlement; on rejection the committed status remains unknown until read back.
   */
  markAcknowledged(receipt: AllocationDeletionReceipt): Promise<void>
}

/** Private transport to the original selected provider's authenticated receipt owner. */
export interface AllocationReceiptTransport {
  /**
   * Acknowledge one already persisted receipt; retries use the same identity and digest.
   * @param receipt - original binding and terminal digest read from the application's durable store.
   * @returns the exact authenticated confirmation from that provider generation.
   */
  acknowledge(receipt: AllocationDeletionReceipt): Promise<AllocationDeletionReceipt>
}

type ReceiptFailure = 'invalid-evidence' | 'capacity' | 'conflict' | 'release-unconfirmed' | 'ack-unconfirmed' | 'unavailable'

/** Sanitized receipt handling status; no provider payload, identifiers or driver text. */
export class AllocationReceiptError extends Error {
  /** @param code - bounded handling status. */
  constructor(readonly code: ReceiptFailure) {
    super(`Allocation deletion receipt ${code}.`)
    this.name = 'AllocationReceiptError'
  }
}

const maxPendingReceipts = 128

function fixedIdentifier(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 4096
    && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:-]/.test(value)
}

function sha256(value: unknown): boolean {
  return typeof value === 'string' && value.length === 64 && !/[^0-9a-f]/.test(value)
}

function scopeKey(scope: AllocationScope): string {
  return JSON.stringify([scope.allocationId, scope.accountId, scope.sessionId, scope.workspaceId, scope.epoch])
}

function copyScope(scope: AllocationScope): AllocationScope {
  if (typeof scope !== 'object' || scope === null) throw new AllocationReceiptError('invalid-evidence')
  const { allocationId, accountId, sessionId, workspaceId, epoch } = scope
  if (![allocationId, accountId, sessionId, workspaceId].every(fixedIdentifier)) {
    throw new AllocationReceiptError('invalid-evidence')
  }
  if (typeof epoch !== 'string' || !/^[1-9]/.test(epoch) || /[^0-9]/.test(epoch) || epoch.length > 19
    || BigInt(epoch) > 9_223_372_036_854_775_807n) throw new AllocationReceiptError('invalid-evidence')
  return Object.freeze({ allocationId, accountId, sessionId, workspaceId, epoch })
}

function copyBinding(binding: OriginalDeletionBinding): OriginalDeletionBinding {
  const scope = copyScope(binding)
  const { sandboxId, containerId, providerGeneration, policyDigest } = binding
  if (!fixedIdentifier(sandboxId) || ![containerId, providerGeneration, policyDigest].every(sha256)) {
    throw new AllocationReceiptError('invalid-evidence')
  }
  return Object.freeze({ ...scope, sandboxId, containerId, providerGeneration, policyDigest })
}

function copyReceipt(receipt: AllocationDeletionReceipt): AllocationDeletionReceipt {
  const binding = copyBinding(receipt)
  const { receiptDigest } = receipt
  if (!sha256(receiptDigest)) throw new AllocationReceiptError('invalid-evidence')
  return Object.freeze({ ...binding, receiptDigest })
}

function sameBinding(left: OriginalDeletionBinding, right: OriginalDeletionBinding): boolean {
  return scopeKey(left) === scopeKey(right) && left.sandboxId === right.sandboxId
    && left.containerId === right.containerId && left.providerGeneration === right.providerGeneration
    && left.policyDigest === right.policyDigest
}

function sameReceipt(left: AllocationDeletionReceipt, right: AllocationDeletionReceipt): boolean {
  return sameBinding(left, right) && left.receiptDigest === right.receiptDigest
}

/** Coordinates durable release and idempotent ACK without owning deletion or writer grants. */
export class AllocationReceiptOutbox {
  /**
   * @param storage - bounded app database adapter, shared with the original allocation authority.
   * @param transport - authenticated original receipt transport with a bounded actual request.
   * @param capacity - fixed trusted pending slot count, at most 128.
   */
  constructor(private readonly storage: AllocationReceiptStorage, private readonly transport: AllocationReceiptTransport,
    private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > maxPendingReceipts) {
      throw new AllocationReceiptError('capacity')
    }
  }

  /**
   * Persist an exact positive terminal receipt after Root has settled the original writer.
   * Mutation replies never substitute for independent committed readback.
   * @param expected - binding from the original owner, independently established from its lifecycle records.
   * @param terminal - positive terminal receipt from the authenticated provider verifier.
   * @returns the durable exact evidence and its ACK state.
   */
  async persistRelease(expected: OriginalDeletionBinding, terminal: AllocationDeletionReceipt): Promise<PersistedDeletionReceipt> {
    const receipt = copyReceipt(terminal)
    if (!sameBinding(copyBinding(expected), receipt)) throw new AllocationReceiptError('invalid-evidence')
    const outcome = await this.storage.release(receipt, this.capacity).catch(() => 'unknown' as const)
    const observed = await this.read(copyScope(receipt))
    if (observed !== undefined) {
      if (!sameReceipt(observed.receipt, receipt)) throw new AllocationReceiptError('conflict')
      return observed
    }
    if (outcome === 'capacity' || outcome === 'conflict') throw new AllocationReceiptError(outcome)
    throw new AllocationReceiptError('release-unconfirmed')
  }

  /**
   * Obtain a bounded snapshot of pending scopes after startup or retry.
   * @returns validated immutable original keys, each eligible for a separate read before ACK.
   */
  async pending(): Promise<readonly AllocationScope[]> {
    const rows = await this.storage.pending(this.capacity).catch(() => { throw new AllocationReceiptError('unavailable') })
    if (!Array.isArray(rows) || rows.length > this.capacity) throw new AllocationReceiptError('capacity')
    const scopes = Array.from(rows, copyScope)
    if (new Set(scopes.map(scopeKey)).size !== scopes.length) throw new AllocationReceiptError('conflict')
    return Object.freeze(scopes)
  }

  /**
   * ACK the independently read durable receipt, then persist the authenticated response.
   * A missing row, lost reply or mismatched response never releases the local outbox slot.
   * @param scope - complete allocation key, generally obtained from the application's durable pending scan.
   * @returns durable acknowledged status, or missing when no exact persisted release exists.
   */
  async acknowledge(scope: AllocationScope): Promise<'acknowledged' | 'missing'> {
    const original = copyScope(scope)
    const committed = await this.read(original)
    if (committed === undefined) return 'missing'
    if (committed.ack === 'acknowledged') return committed.ack
    const confirmed = await this.transport.acknowledge(committed.receipt).catch(() => undefined)
    if (confirmed === undefined || !sameReceipt(committed.receipt, copyReceipt(confirmed))) {
      throw new AllocationReceiptError('ack-unconfirmed')
    }
    await this.storage.markAcknowledged(committed.receipt).catch(() => { /* exact readback resolves the outcome */ })
    const observed = await this.read(original)
    if (observed?.ack !== 'acknowledged' || !sameReceipt(observed.receipt, committed.receipt)) {
      throw new AllocationReceiptError('ack-unconfirmed')
    }
    return observed.ack
  }

  private async read(scope: AllocationScope): Promise<PersistedDeletionReceipt | undefined> {
    const value = await this.storage.read(scope).catch(() => { throw new AllocationReceiptError('unavailable') })
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || value.state !== 'released'
      || (value.ack !== 'pending' && value.ack !== 'acknowledged')) {
      throw new AllocationReceiptError('invalid-evidence')
    }
    const receipt = copyReceipt(value.receipt)
    if (scopeKey(receipt) !== scopeKey(scope)) throw new AllocationReceiptError('conflict')
    return Object.freeze({ state: 'released', ack: value.ack, receipt })
  }
}
