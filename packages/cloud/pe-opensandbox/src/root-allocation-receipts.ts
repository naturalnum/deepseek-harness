/** One Root worker for the original durable allocation's provider receipt lifecycle. */
import type { AllocationReceiptPersistence, CreatedSandbox, PreparedSandbox } from './allocation-owner.ts'
import { PostgresAllocationBindingStorage } from './allocation-binding-postgres.ts'
import { AllocationReceiptOutbox, type AllocationDeletionReceipt, type OriginalDeletionBinding } from './allocation-receipt-outbox.ts'
import { PostgresAllocationReceiptStorage } from './allocation-receipt-postgres.ts'
import type { PostgresAllocationStore } from './allocation-store.ts'
import type { AllocationQuery, AllocationScope, SandboxAllocation } from './allocation-types.ts'
import { SdkLifecycleFailure } from './lifecycle-types.ts'
import type { SdkAllocationBackend } from './sdk-lifecycle.ts'

function unconfirmed(): never { throw new SdkLifecycleFailure('sdk/stop-unknown') }

/** Receipt-selected Root uses the same original metadata driver and SDK lifecycle owner throughout. */
export class RootAllocationReceipts implements AllocationReceiptPersistence {
  private readonly bindings: PostgresAllocationBindingStorage
  private readonly receipts: PostgresAllocationReceiptStorage
  private readonly outbox: AllocationReceiptOutbox

  /**
   * @param driver Original private Root executor after the allocation store's registration.
   * @param store Original durable allocation table's read/transition owner.
   * @param backend Same receipt-selected original SDK backend.
   * @param assertCurrent Protected Root deployment identity.
   */
  constructor(driver: AllocationQuery, private readonly store: PostgresAllocationStore,
    private readonly backend: SdkAllocationBackend, private readonly assertCurrent: () => void) {
    if (!backend.usesDeletionReceipts) unconfirmed()
    this.bindings = new PostgresAllocationBindingStorage(driver)
    this.receipts = new PostgresAllocationReceiptStorage(driver)
    this.outbox = new AllocationReceiptOutbox(this.receipts, { acknowledge: async (receipt) => {
      this.assertCurrent()
      const row = await this.requireRow(receipt, 'released')
      const original = await this.bindings.read(receipt)
      if (original?.state !== 'released' || !this.sameProvider(original.binding, receipt)) unconfirmed()
      this.assertCurrent()
      return this.backend.acknowledgePersistedDeletion(row, receipt)
    } }, 128)
  }

  /** @returns Startup selection and adjacent migrations, after the original allocation schema is ready. */
  async start(): Promise<void> {
    await this.backend.verifyDeletionReceiptDeployment()
    await this.bindings.migrate()
    await this.receipts.migrate()
    this.assertCurrent()
  }

  async publishReady(expected: SandboxAllocation, created: CreatedSandbox, prepared: PreparedSandbox): Promise<SandboxAllocation> {
    this.assertCurrent()
    const binding = this.backend.originalDeletionBinding(created)
    if (binding === undefined) throw new SdkLifecycleFailure('sdk/ready-unconfirmed')
    await this.bindings.commitReady(expected, prepared, binding)
    const ready = await this.requireRow(expected, 'ready')
    this.assertCurrent()
    if (ready.sandboxId !== binding.sandboxId || ready.runtimeIdentity !== prepared.runtimeIdentity) unconfirmed()
    return ready
  }

  async releaseStopped(expected: SandboxAllocation, created: CreatedSandbox): Promise<SandboxAllocation> {
    this.assertCurrent()
    const binding = this.backend.originalDeletionBinding(created)
    if (binding === undefined) unconfirmed()
    return this.release(expected, binding, this.backend.finishedDeletionReceipt(created))
  }

  /**
   * Recover only a positively bound original under the existing Root startup ownership fence.
   * @param row Original nonterminal allocation as observed by the single-instance startup owner.
   * @param assertStartupCurrent Original startup lock and shutdown assertion.
   * @returns Exact released row; unknown retains the durable stopping allocation.
   */
  async recover(row: SandboxAllocation, assertStartupCurrent: () => void): Promise<SandboxAllocation> {
    const stopping = row.state === 'stopping' ? row : await this.store.transition(row, { to: 'stopping' })
    assertStartupCurrent()
    const original = await this.bindings.read(stopping)
    if (original?.state !== 'stopping') unconfirmed()
    assertStartupCurrent()
    const terminal = await this.backend.finishRecoveredDeletion(stopping, original.binding)
    assertStartupCurrent()
    return this.release(stopping, original.binding, terminal)
  }

  /**
   * Reopen the app outbox under the original startup fence without repeating a provider deletion.
   * @param assertStartupCurrent Original startup lock and shutdown assertion.
   */
  async replayPending(assertStartupCurrent: () => void): Promise<void> {
    for (const scope of await this.outbox.pending()) {
      assertStartupCurrent()
      if (await this.outbox.acknowledge(scope) !== 'acknowledged') unconfirmed()
    }
  }

  private async release(stopping: SandboxAllocation, binding: OriginalDeletionBinding,
    terminal: AllocationDeletionReceipt): Promise<SandboxAllocation> {
    const original = await this.store.get(stopping)
    if (original?.state === 'released') {
      const selected = await this.bindings.read(stopping)
      const retained = await this.receipts.read(stopping)
      if (selected?.state !== 'released' || !this.sameProvider(selected.binding, binding) || retained === undefined
        || retained.receipt.receiptDigest !== terminal.receiptDigest || !this.sameProvider(retained.receipt, terminal)) unconfirmed()
    } else {
      const selected = await this.bindings.commitStopping(stopping, binding)
      this.assertCurrent()
      await this.outbox.persistRelease(selected.binding, terminal)
    }
    const released = await this.requireRow(stopping, 'released')
    // Positive stop and application commit already settled. Transport uncertainty retains this ACK in durable pending.
    try { await this.outbox.acknowledge(released) }
    catch { /* Exact startup replay consumes the same receipt; no old release or delete is substituted. */ }
    return released
  }

  private async requireRow(scope: AllocationScope, state: SandboxAllocation['state']): Promise<SandboxAllocation> {
    const row = await this.store.get(scope)
    if (row === undefined || row.state !== state) return unconfirmed()
    return row
  }

  private sameProvider(left: OriginalDeletionBinding, right: OriginalDeletionBinding): boolean {
    return left.sandboxId === right.sandboxId && left.containerId === right.containerId
      && left.providerGeneration === right.providerGeneration && left.policyDigest === right.policyDigest
  }
}
