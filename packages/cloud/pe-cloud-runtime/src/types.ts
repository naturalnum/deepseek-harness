/** Runtime-owned account identities and lifecycle inputs; none are browser credentials. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

export type * from './owner-types.ts'

/** Authenticated database user id, admitted by access before runtime use. */
export type AccountId = Branded<'pe-account-id'>
/** Stable server-derived directory key; it grants no account or filesystem authority. */
export type AccountStorageKey = Branded<'pe-account-storage-key'>
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

/** Immutable absolute addresses only; files/deployment separately verify anchors, protection, and quota. */
export interface AccountLayout {
  /** Server-derived stable key, independent of graph epoch and process identity. */
  readonly storageKey: AccountStorageKey
  /** Shared root containing this account's private, projects, and environments directories. */
  readonly accountRoot: string
  /** Native account data excluded from project mounts. */
  readonly privateRoot: string
  /** Account-owned native Profile directory. */
  readonly profileRoot: string
  /** Native Profile patch file within profileRoot. */
  readonly patchPath: string
  /** Private native credential storage address. */
  readonly credentialsRoot: string
  /** Private authoritative native Session history address. */
  readonly sessionsRoot: string
  /** Private native storage backend address. */
  readonly storageRoot: string
  /** Private attachment-original storage address. */
  readonly attachmentsRoot: string
  /** Private account skill installation address. */
  readonly skillsRoot: string
  /** Private account instruction-source address. */
  readonly instructionsRoot: string
  /** Parent for server-selected project directory keys; not a ProjectScope. */
  readonly projectsRoot: string
  /** Parent for session environments; individual environment derivation is separate. */
  readonly environmentsRoot: string
  /** Process-local derived index, reconstructible from native history. */
  readonly localIndexRoot: string
}

/** Trusted same-process assembly data, never a serialized capability or a readiness declaration. */
export interface AccountMountInput {
  /** Exact generation admitted by the runtime; lifetime belongs to the graph. */
  readonly binding: AccountBinding
  /** Current server-generated process identity shared with the PostgreSQL owner store. */
  readonly instanceId: InstanceId
  /** Addresses only; possession does not authorize filesystem access. */
  readonly layout: AccountLayout
  /** Explicit account launch values; credentials go only to their required native consumers. */
  readonly environment: LaunchEnvironmentSnapshot
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

/** Safe process-control observation; it is never an account-ready certificate. */
export interface RuntimeControlObservation {
  readonly phase: 'component' | 'starting' | 'active' | 'failed' | 'closing' | 'closed'
  readonly pendingSecrets: number
  readonly accounts: number
  readonly hasFailure: boolean
}

/** Fixed C13 entry scopes; only the five root roles activate in the Root graph. */
export type RootRecipeRole = 'access/root' | 'runtime/root' | 'api/root' | 'files/root' | 'opensandbox/root'
  | 'runtime/account' | 'api/account' | 'files/account' | 'opensandbox/account' | 'instructions/session' | 'client/client'

/** Root-side immutable expectations; these declare requirements and never certify their fulfillment. */
export interface RootRecipeInput {
  readonly recipeVersion: string
  /** All eleven approved entry scopes; account/session/client declarations do not activate in Root. */
  readonly entrypoints: readonly RootRecipeRole[]
  readonly roots: readonly {
    readonly role: 'access/root' | 'runtime/root' | 'api/root' | 'files/root' | 'opensandbox/root'
    readonly entryId: string
    /** Original approved module namespace/class, compared with the actual Loader import. */
    readonly module: object
  }[]
  readonly providers: readonly {
    readonly key: 'peAuth' | 'peAccountRuntime' | 'peExposure' | 'peFilesPool' | 'peSandboxCoordinator' | 'webServer' | 'credentials' | 'clientModules'
    readonly entryId: string
    /** Original actual provider; ownership and uniqueness are read from native fibers. */
    readonly value: object
  }[]
  /** Exact frozen manifest object held by the real API root provider; no copied approval record. */
  readonly manifest: object
}

/** Safe finite issue identities; no input paths, credentials or configuration values are exposed. */
export type RootRecipeIssue = 'runtime-control-unavailable' | 'version-mismatch' | 'entrypoint-catalog-mismatch'
  | 'root-entry-missing' | 'root-entry-duplicate-or-missing' | 'root-module-replaced' | 'root-entry-inactive'
  | 'root-config-unproven' | 'account-entry-in-root' | 'provider-missing' | 'provider-replaced-or-missing'
  | 'provider-duplicate-or-missing' | 'provider-owner-mismatch' | 'provider-not-current' | 'participant-missing' | 'participant-provider-mismatch'
  | 'manifest-replaced-or-missing' | 'manifest-not-immutable' | 'storage-root-capability-missing' | 'recipe-revoked' | 'runtime-closed'

/** Observed facts only; this slice cannot produce a seal without the real storage capability. */
export interface RootRecipeObservation {
  readonly status: 'unsealed' | 'blocked' | 'revoked' | 'closed'
  readonly recipeVersion?: string
  readonly rootEntries: number
  readonly providers: number
  readonly participants: number
  readonly issues: readonly RootRecipeIssue[]
}

/** Shared service definition; providers need no dependency on Host control implementation. */
export interface AccountRuntimeService {
  /**
   * Audit actual Root facts; missing real storage keeps sealing rejected.
   * @param input Fixed requirements and original object identities, never caller readiness assertions.
   * @throws AccountRuntimeError while incomplete, revoked or closed; no successful seal is available yet.
   */
  sealRecipe(input: RootRecipeInput): void
  /**
   * Require the current complete seal before external admission.
   * @param recipeVersion Exact deployment recipe required by the caller.
   * @throws AccountRuntimeError without a current complete seal.
   */
  assertRecipeSealed(recipeVersion: string): void
  /** Revoke current audit authority before a recipe change. */
  revokeRecipe(): void
  /**
   * Inspect current identities and invalidate changed audit facts without issuing admission authority.
   * @returns Frozen bounded counts and finite safe issue identities.
   */
  inspectRecipe(): RootRecipeObservation
  /** Register the caller-owned files or execution contribution; duplicates and closed admission reject. */
  registerDrainParticipant(participant: DrainParticipant): () => void | Promise<void>
  /** Reject missing mandatory participants; success is not recipe sealing. */
  assertRequiredParticipants(): void
  /** Reserve bounded actual mount work after participant registration; no owner is claimed. */
  reserveMountCapacity(accountId: AccountId): MountCapacityReservation
  /** Retain a finite drain slot until actual settlement. */
  reserveDrainCapacity(accountId: AccountId): DrainCapacityReservation
  /** Read actual PG metadata without creating or reclaiming an owner. */
  locateAccount(accountId: AccountId): Promise<AccountOwner | undefined>
  /** Enter actual root acquisition; optional signal abandons only this observer. */
  acquireAccount(accountId: AccountId, signal?: AbortSignal): Promise<AccountUse>
  /** Borrow only the exact ready generation; never claim, mount or select a replacement graph. */
  borrowAccount(binding: AccountBinding): Promise<AccountUse>
  /** Check installed mounting/current identity independently of business readiness. */
  assertMountCurrent(binding: AccountBinding): void
  /** Require exact live ready publication without capturing a request borrow. */
  assertBusinessCurrent(binding: AccountBinding): void
  /** Return safe retained control counts without credentials or paths. */
  inspectControl(): RuntimeControlObservation
  /** Close new admission and join actual retained root control work. */
  close(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Runtime registration and acquisition definition; component-only instances reject control operations. */
    peAccountRuntime: AccountRuntimeService
  }
}
