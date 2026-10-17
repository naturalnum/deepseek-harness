/** Internal F06 submission and observation types; no Session or settings store. */
import type { AccountBinding, AccountId, OperationId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Actual native writer categories, including required publication work. */
export type ConfigSaveKind =
  | 'default-model' | 'settings' | 'config-editor' | 'plugin-selection'
  | 'credentials' | 'skill-publish' | 'skill-projection'

/** Deployment limits; queued, running and unresolved entries all consume tracked capacity. */
export interface ConfigSaveLimits {
  readonly maxAccounts: number
  readonly maxRunning: number
  readonly maxQueued: number
  readonly maxQueuedPerAccount: number
  readonly maxTrackedOperations: number
  readonly maxTrackedOperationsPerAccount: number
  readonly maxNestedPerOperation: number
  readonly maxWaitersPerAccount: number
}

/** Permanent closure cannot be reopened in the same generation. */
export type ConfigSaveAdmission = 'open' | 'paused' | 'stopped'

/** Safe operation metadata; errors and secret values never enter receipts. */
export interface ConfigSaveOperation {
  readonly operationId: OperationId
  readonly kind: ConfigSaveKind
}

/** An unresolved actual failure, retained until external reconciliation. */
export interface ConfigSaveFailure extends ConfigSaveOperation {
  readonly outcome: 'failed' | 'unknown'
  readonly code: 'config-save/operation-failed' | 'config-save/outcome-unknown'
}

/** Account-local observation; pending includes admitted work waiting outside a native writer. */
export interface ConfigSaveSnapshot {
  readonly accountId: AccountId
  readonly epoch: OwnerEpoch
  readonly admission: ConfigSaveAdmission
  readonly pending: readonly ConfigSaveOperation[]
  readonly failures: readonly ConfigSaveFailure[]
}

/** Closed-admission save evidence; this is not a DrainParticipant receipt. */
export type ConfigSaveReceipt = Readonly<{
  accountId: AccountId
  epoch: OwnerEpoch
  admission: 'paused' | 'stopped'
  evidenceRefs: readonly string[]
}> & (
  | Readonly<{ status: 'confirmed'; pendingOperationIds: readonly []; failures: readonly [] }>
  | Readonly<{
    status: 'unknown'
    pendingOperationIds: readonly OperationId[]
    failures: readonly ConfigSaveFailure[]
    reason: 'pending' | 'failed' | 'deadline' | 'observer-cancelled'
  }>
)

/**
 * Installed before any native private queue. Registration and capacity checks
 * happen synchronously; submit includes required reload/reconcile. Nested
 * writes belonging to the executing save join it without queuing behind it.
 */
export interface NativeConfigSaveHook {
  /**
   * @param kind - actual writer category.
   * @param submit - actual operation through required application cleanup.
   * @returns the real result after all enrolled work; admission can throw synchronously with zero submit.
   */
  admit<T>(kind: ConfigSaveKind, submit: () => Promise<T>): Promise<T>
}

/** Runtime-owned control of one graph's configuration saves. */
export interface ConfigSaveBarrier extends NativeConfigSaveHook {
  readonly binding: AccountBinding
  /**
   * Keep persistence and required apply in one admission and serial turn.
   * @param kind - actual writer category.
   * @param persist - native persistence operation.
   * @param apply - mandatory application, not an optional display notification.
   * @returns the persistence result only after mandatory apply settles.
   */
  admitWithApply<T>(kind: ConfigSaveKind, persist: () => Promise<T>, apply: (value: T) => Promise<void>): Promise<T>
  /** @returns detached, sanitized pending and unresolved-failure metadata. */
  snapshot(): ConfigSaveSnapshot
  /**
   * Pause new top-level submissions synchronously; admitted continuations still finish.
   * @param deadlineAtMs - finite absolute server deadline; an elapsed deadline only stops waiting.
   * @param signal - optional observer cancellation; absence waits to the deadline.
   * @returns evidence without releasing unfinished work or its capacity.
   */
  pauseAccountChanges(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt>
  /**
   * Reopen only a paused, quiescent, failure-free graph that runtime has re-audited.
   * Terminal stop, unresolved work, failure, and an expired generation reject.
   */
  resumeAccountChanges(): void
  /**
   * Permanently stop top-level admission in this generation; repeated calls remain stopped.
   * @param deadlineAtMs - finite absolute deadline for this observer.
   * @param signal - optional observer cancellation, never cancellation of actual work.
   * @returns confirmed only after all actual work succeeds.
   */
  stopConfigSaves(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt>
}
