/** Runtime-owned account identities and lifecycle inputs; none are browser credentials. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

export type * from './owner-types.ts'

/** Authenticated database user id, admitted by access before runtime use. */
export type AccountId = Branded<'pe-account-id'>
/** PG bigint encoded as a lossless decimal string; each new graph receives a new value. */
export type OwnerEpoch = Branded<'pe-owner-epoch'>
/** Server-generated identity that changes on every process start. */
export type InstanceId = Branded<'pe-instance-id'>
/** Server-generated actual-work identity retained beyond a request's wait. */
export type OperationId = Branded<'pe-operation-id'>
/** The two mandatory root participants; config saving is tracked separately by API. */
export type ParticipantId = 'files' | 'execution'

/** Trusted immutable input for one account graph; lifetime is never a request signal. */
export interface AccountBinding {
  readonly accountId: AccountId
  readonly epoch: OwnerEpoch
  readonly recipeVersion: string
  readonly lifetime: AbortSignal
}

/** One borrowed native account graph; releasing a borrow does not cancel an Agent. */
export interface AccountUse {
  readonly binding: AccountBinding
  readonly context: Context
  /** Reject stale or closed admission immediately before invoking native business work. */
  assertCurrent(): void
  /** Idempotently release only this borrow. */
  release(): void
}

/** Persisted owner phases; heartbeat expiry does not transition an owner to unowned. */
export type AccountOwnerPhase = 'unowned' | 'mounting' | 'ready' | 'draining' | 'parked' | 'reconfiguring' | 'quarantined'

/** Runtime control metadata, separate from native Session or settings state. */
export interface AccountOwner {
  readonly accountId: AccountId
  readonly ownerInstanceId: InstanceId | null
  readonly epoch: OwnerEpoch
  readonly phase: AccountOwnerPhase
  readonly recipeVersion: string
  readonly heartbeatAt: string
  readonly updatedAt: string
}

/** Actual stop evidence for one mandatory participant and immutable generation. */
export type ParticipantReceipt = Readonly<{
  participant: ParticipantId
  accountId: AccountId
  epoch: OwnerEpoch
  evidenceRefs: readonly string[]
}> & (
  | Readonly<{ status: 'confirmed'; pendingOperationIds: readonly [] }>
  | Readonly<{ status: 'unknown'; pendingOperationIds: readonly OperationId[]; reason: string }>
)

/** Root-owned actual work tracker that retains observation after the waiting deadline. */
export interface DrainParticipant {
  readonly id: ParticipantId
  /**
   * Stop this generation's admission and queued/running work; unknown keeps cleanup ownership.
   * @param binding Exact account generation being drained.
   * @param deadlineAtMs Finite absolute server-time deadline in milliseconds.
   * @returns Actual-work evidence; confirmed requires no pending operation ids.
   */
  stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt>
}

/** Explicit deployment capacities; these fields carry no storage or readiness evidence. */
export interface RuntimeConfig {
  readonly maxMountedAccounts: number
  readonly maxConcurrentMounts: number
  readonly maxConcurrentDrains: number
}

/** Local capacity reservation for a factory; it neither acquires an owner nor publishes a graph. */
export interface MountCapacityReservation {
  readonly accountId: AccountId
  /** Release the mount-operation slot only after actual mounting has settled; retain the account slot. */
  settleMount(): void
  /** Release the account slot after mounting and any drain have settled; idempotent after release. */
  releaseAccount(): void
}

/** Local drain-operation slot, held until the actual drain has settled. */
export interface DrainCapacityReservation {
  readonly accountId: AccountId
  /** Idempotently release this slot; an HTTP deadline alone must not release it. */
  release(): void
}
