/** PostgreSQL control-store inputs and runtime teardown evidence; no Session or configuration authority is duplicated. */
import type { AccountId, InstanceId, OperationId, OwnerEpoch, ParticipantReceipt } from './types.ts'

/** Narrow adapter over a real PostgreSQL driver's parameterized query operation. */
export interface OwnerPgExecutor {
  /**
   * Execute one PostgreSQL statement with finite connection and server execution budgets.
   * Return actual driver settlement; a caller's waiting deadline must not release running SQL or its connection.
   * Rejecting a write can leave its commit unknown; the store retains bounded responsibility for that account/epoch.
   * @param text Owned SQL, including one atomic migration statement.
   * @param values Bound text/null parameters; the adapter must not interpolate them into SQL.
   * @returns Driver rows without converting bigint to Number or trusting durable JSON fields.
   */
  query(text: string, values: readonly (string | null)[]): Promise<{ readonly rows: readonly unknown[] }>
}

/** Exact persisted owner identity required by every owned-row CAS. */
export interface OwnerExpectation {
  readonly accountId: AccountId
  readonly epoch: OwnerEpoch
}

/** Claim a missing row with null, or a retained unowned/parked row with its exact prior epoch. */
export interface OwnerClaim {
  readonly accountId: AccountId
  readonly expectedEpoch: OwnerEpoch | null
  readonly recipeVersion: string
}

/** API-owned config-save evidence consumed by runtime; it is not a third participant. */
export interface OwnerConfigSaveEvidence {
  readonly accountId: AccountId
  readonly epoch: OwnerEpoch
  readonly status: 'confirmed' | 'unknown'
  readonly pendingOperationIds: readonly OperationId[]
  /** API owns failure details; runtime only requires that no unresolved failures remain. */
  readonly failures: readonly unknown[]
  readonly evidenceRefs: readonly string[]
}

/** Runtime-observed teardown results; only complete current-generation evidence permits park/release. */
export interface OwnerDrainEvidence {
  readonly accountId: AccountId
  readonly epoch: OwnerEpoch
  readonly nativeIdle: boolean
  readonly configSaves: OwnerConfigSaveEvidence
  readonly participants: readonly ParticipantReceipt[]
  readonly persistenceFlushed: boolean
  readonly contextDisposed: boolean
  readonly disposalErrors: readonly string[]
}

/** Store identity is server generated; the database driver remains root-owned. */
export interface OwnerStoreIdentity {
  readonly instanceId: InstanceId
}
