/** Runtime-owned account identities and lifecycle inputs; none are browser credentials. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { OwnerRecoveryAudit, OwnerRecoveryExpectation, OwnerRecoveryObservation, OwnerRecoveryProof,
  RecoveredInstanceCloseResult, RecoveredInstanceExpectation, RecoveredInstanceObservation, RecoveryVerifierId } from './owner-types.ts'

export type * from './owner-types.ts'

/** One original terminal operation's native persistence and independently verified new epoch. */
export interface ConfigurationRebuildReceipt<T, V = void> {
  readonly verification?: V
  readonly operationId: OperationId
  readonly persisted: T
  readonly application: 'graph'
  readonly previousEpoch: AccountBinding['epoch']
  readonly epoch: AccountBinding['epoch']
  readonly accountId: AccountId
  readonly recipeVersion: string
}

/** Authenticated database user id, admitted by access before runtime use. */
export type AccountId = Branded<'pe-account-id'>
/** Stable server-derived directory key; it grants no account or filesystem authority. */
export type AccountStorageKey = Branded<'pe-account-storage-key'>
/** PG bigint encoded as a lossless decimal string; each new graph receives a new value. */
export type OwnerEpoch = Branded<'pe-owner-epoch'>
/** Server-generated identity that changes on every process start. */
export type InstanceId = Branded<'pe-instance-id'>
/** Trusted root deployment metadata; it has no selectable instance-id field. */
export interface InstanceDeployment {
  readonly internalAddress: string
  readonly recipeVersion: string
}
/** Only the five C-12 instance metadata fields; phase grants no account readiness. */
export interface RuntimeInstanceRecord extends InstanceDeployment {
  readonly instanceId: InstanceId
  readonly phase: 'registered' | 'closed'
  readonly heartbeatAt: string
}
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
  /** Observe the original exact epoch without changing admission; omission cannot qualify an idle update.
   * @param binding Original installed generation.
   * @returns True only when this owner has no actual work or retained uncertainty for that epoch; passive leases may remain.
   */
  isEpochIdle?(binding: AccountBinding): boolean
  /**
   * Join all Root-owned work, including allocations not mounted in an account graph.
   * Required before borrowing the Root metadata database. Repeated calls retain the same actual
   * shutdown promise; rejection or pending work prevents database release and participant withdrawal.
   * @returns Actual Root quiescence, without treating an observation deadline as completion.
   */
  closeRoot?(): Promise<void>
  /**
   * Stop this generation's admission and queued/running work; unknown keeps cleanup ownership.
   * @param binding Exact account generation being drained.
   * @param deadlineAtMs Finite absolute server-time deadline in milliseconds.
   * @returns Actual-work evidence; confirmed requires no pending operation ids.
   */
  stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt>
}

/** Root-only parameterized statements sharing runtime's finite connection and shutdown ownership. */
export interface RootMetadataDatabase {
  /**
   * Classify the actual Root adapter's zero-submission failure without importing its Host implementation.
   * @param cause Rejection from this query capability, including a revoked borrow.
   * @returns True only for the adapter's known never-submitted, settled operation.
   */
  wasNotSubmitted(cause: unknown): boolean
  /**
   * Submit one statement owned by a registered Root participant, never account/request-selected SQL.
   * The actual connection closes before settlement; a rejected submitted write can remain unknown.
   * Existing borrowers retain cleanup access during Root drain until their closeRoot work settles.
   * @param text Fixed SQL owned by the participant's metadata store.
   * @param values Bound text/null values; no target, credential or driver lifetime is exposed.
   * @returns Actual driver rows, requiring the owning store's durable-value validation.
   */
  query(text: string, values: readonly (string | null)[]): Promise<{ readonly rows: readonly unknown[] }>
}

/** Explicit deployment capacities; these fields carry no storage or readiness evidence. */
export interface RuntimeConfig {
  readonly maxMountedAccounts: number
  readonly maxConcurrentMounts: number
  readonly maxConcurrentDrains: number
  /** Explicit Root-instance child hard limits; omission keeps child reservations closed. */
  readonly subagentCapacity?: SubagentCapacityLimits
}

/** Immutable instance-local hard limits, separate from native root-subtree Settings. */
export interface SubagentCapacityLimits {
  readonly maxActivePerAccount: number
  readonly maxActiveTotal: number
  readonly maxDepth: number
}

/** One actual child residency; an unknown cleanup permanently retains its slot. */
export interface SubagentCapacityReservation {
  /**
   * Settle once from actual native cleanup, never from cancellation or a request deadline.
   * Unknown retains capacity and prevents account release; later calls cannot clear it.
   * @param status Actual prepared-Agent cleanup result, or unknown without a native receipt.
   */
  settle(status: 'confirmed' | 'unknown'): void
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

/** Current audit observations; sealed requires every original Root fact and actual files storage owner. */
export interface RootRecipeObservation {
  readonly status: 'unsealed' | 'blocked' | 'sealed' | 'revoked' | 'closed'
  readonly recipeVersion?: string
  readonly rootEntries: number
  readonly providers: number
  readonly participants: number
  readonly issues: readonly RootRecipeIssue[]
}

/** Root-selected verifier callback; account and browser data cannot register this capability. */
export interface RootRecoveryVerifier {
  readonly id: RecoveryVerifierId
  /** @param expected Exact old identity. @returns Actual protected and independently rechecked recovery evidence. */
  verify(expected: Readonly<OwnerRecoveryExpectation>): Promise<OwnerRecoveryProof>
}

/** Maintenance-only runtime capability; every operation requires the original registered execution participant. */
export interface AccountRecoveryRuntime {
  /** @returns Original Root startup settlement; this grants no account readiness or recovery proof. */
  whenReady(): Promise<void>
  /**
   * Register the single selected verifier in the Root effect scope.
   * @param participant Original execution shutdown owner.
   * @param verifier Protected publication and actual-process verifier.
   * @returns Withdrawal which first joins the participant's actual recovery work.
   */
  registerVerifier(participant: DrainParticipant, verifier: RootRecoveryVerifier): () => void | Promise<void>
  /** @param participant Original execution owner. @returns Actual recovery schema migration after allocation migration. */
  migrate(participant: DrainParticipant): Promise<void>
  /** @param participant Original execution owner. @param instanceId Exact old identity. @returns Trusted registration metadata only. */
  locateInstance(participant: DrainParticipant, instanceId: InstanceId): Promise<RuntimeInstanceRecord | undefined>
  /** @param participant Original execution owner. @param expected Exact old owner. @returns Committed recovery audit. */
  recoverAccount(participant: DrainParticipant, expected: OwnerRecoveryExpectation): Promise<OwnerRecoveryAudit>
  /** @param participant Original execution owner. @param expected Exact old audit. @returns Read-only current/postimage comparison. */
  inspectAccount(participant: DrainParticipant, expected: OwnerRecoveryExpectation): Promise<OwnerRecoveryObservation>
  /** @param participant Original execution owner. @param expected Exact old registration. @returns Audited old-instance closure. */
  closeInstance(participant: DrainParticipant, expected: RecoveredInstanceExpectation): Promise<RecoveredInstanceCloseResult>
  /** @param participant Original execution owner. @param expected Exact old registration. @returns Read-only closure comparison. */
  inspectInstance(participant: DrainParticipant, expected: RecoveredInstanceExpectation): Promise<RecoveredInstanceObservation>
}

/** Rechecked ready ownership and a registered instance; neither an atomic snapshot nor account admission. */
export interface AccountOwnerResolution {
  readonly owner: AccountOwner
  readonly instance: RuntimeInstanceRecord
}

/** Root-only read facade, separate from recovery and local account acquisition. */
export interface AccountOwnerResolver {
  /**
   * Read an existing owner and its instance, then recheck the ownership tuple without retrying.
   * @param accountId Authenticated identity supplied by trusted access composition.
   * Admission and capacity checks may throw before returning a Promise; started reads reject through that Promise.
   * The Root retains every started read through actual driver settlement; caller cancellation is not exposed.
   * @returns Existing decoded metadata after at most three original reads; no AccountUse or transport authority.
   * @throws AccountRuntimeError when metadata is absent, not ready, stopped, inconsistent or changed; original read errors propagate.
   */
  resolve(accountId: AccountId): Promise<AccountOwnerResolution>
}

/** The one actual Access ingress owner; registration grants only ordered Root shutdown. */
export interface RootIngressCloseOwner {
  /**
   * Stop admission synchronously and retain original carrier/auth/pool work through actual closure.
   * @returns The same actual closure outcome; it must never wait for RuntimeRoot.close().
   */
  closeActual(): Promise<void>
}

/** Root-owned account lifecycle and metadata service; maintenance authority never grants ordinary admission. */
export interface AccountRuntimeService {
  /** Explicit maintenance Roots expose recovery while rejecting all ordinary account admission; omission keeps recovery closed. */
  readonly recovery?: AccountRecoveryRuntime | undefined
  /** Original local startup identity for active ordinary Roots; absent for component, maintenance and stopped Roots. */
  readonly activeInstanceId?: InstanceId | undefined
  /** Active ordinary Roots expose only bounded reads; component, maintenance and stopped Roots omit this facade. */
  readonly ownerResolver?: AccountOwnerResolver | undefined
  /**
   * Register the single original Access ingress shutdown owner in the actual caller effect.
   * @param owner Original close owner, registered before it admits authentication or forwarding work.
   * @returns Withdrawal that starts and joins original closure; failed closure retains the registration.
   * Registration grants no seal, database, account, recovery or participant authority.
   */
  registerIngressClose(owner: RootIngressCloseOwner): () => void | Promise<void>
  /**
   * Borrow only an existing ready graph owned by this process and the exact observed owner tuple.
   * @param expected Original AccountOwner metadata supplied by trusted Host composition, never an AccountBinding.
   * @returns The original AccountUse after owner and Root rechecks; no claim, mount or recreation is attempted.
   * A failed recheck releases any acquired borrow. The consumer releases a successful borrow after its work settles.
   */
  borrowOwnedAccount(expected: AccountOwner): Promise<AccountUse>
  /**
   * Borrow the active Root's bounded database for an exactly registered Root shutdown owner.
   * Account graphs receive no such capability; borrowing grants no account or execution authority.
   * @param participant Original registered object with an actual idempotent closeRoot implementation.
   * @returns The immutable Root-only query capability; it cannot close or retarget the driver.
   */
  controlDatabase(participant: DrainParticipant): RootMetadataDatabase
  /**
   * Audit actual Root facts; missing real storage keeps sealing rejected.
   * @param input Fixed requirements and original object identities, never caller readiness assertions.
   * @throws AccountRuntimeError while any actual Root or storage requirement is incomplete, revoked or closed.
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
  /**
   * Register the caller-owned files or execution contribution; duplicates and closed admission reject.
   * @param participant Actual files/root or execution/root owner of the tracked work.
   * @returns Idempotent disposer owned by the caller's effect scope; withdrawal also revokes the recipe seal.
   */
  registerDrainParticipant(participant: DrainParticipant): () => void | Promise<void>
  /** Reject missing mandatory participants; success is not recipe sealing. */
  assertRequiredParticipants(): void
  /**
   * Reserve bounded actual mount work after participant registration; no owner is claimed.
   * @param accountId Trusted account whose factory owns the local reservation.
   * @returns Reservation retaining mount capacity until actual mounting settles and account capacity through graph disposal.
   */
  reserveMountCapacity(accountId: AccountId): MountCapacityReservation
  /**
   * Retain a finite drain slot until actual settlement.
   * @param accountId Account already holding this root's local account reservation.
   * @returns Drain reservation released by its owner only after actual drain settlement.
   */
  reserveDrainCapacity(accountId: AccountId): DrainCapacityReservation
  /**
   * Read actual PG metadata without creating or reclaiming an owner.
   * @param accountId Authenticated account identity selected by trusted access.
   * @returns Current PostgreSQL owner metadata, or undefined for confirmed absence.
   */
  locateAccount(accountId: AccountId): Promise<AccountOwner | undefined>
  /**
   * Enter actual root acquisition; optional signal abandons only this observer.
   * @param accountId Authenticated account selected by trusted access, never a browser expectation.
   * @param signal Optional observer cancellation; with or without it, the configured account wait deadline applies.
   * @returns Fresh borrow of the ready graph after actual storage/native audits and ready CAS rechecks.
   */
  acquireAccount(accountId: AccountId, signal?: AbortSignal): Promise<AccountUse>
  /**
   * Borrow only the exact ready generation; never claim, mount or select a replacement graph.
   * @param binding Exact runtime-installed ready generation retained by the trusted caller.
   * @returns Fresh independently released borrow; stale, unpublished and closed graphs reject.
   */
  borrowAccount(binding: AccountBinding): Promise<AccountUse>
  /**
   * Check installed mounting/current identity independently of business readiness.
   * @param binding Original installed graph binding to check, never a request borrow.
   */
  assertMountCurrent(binding: AccountBinding): void
  /**
   * Require exact live ready publication without capturing a request borrow.
   * @param binding Original installed graph binding whose ready publication and current recipe seal must hold.
   */
  assertBusinessCurrent(binding: AccountBinding): void
  /**
   * Return safe retained control counts without credentials or paths.
   * @returns Frozen control phase, bounded counts and failure presence; these observations do not grant readiness.
   */
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
