/** Internal F06 submission and observation types; no Session or settings store. */
import type { AccountBinding, AccountId, OperationId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { CloudApiError } from './errors.ts'
import type { CredentialInfo, CredentialRef, CredentialSaveOperation } from '@deepseek-ai/dsh-credentials'

/** Opaque concurrency version; contains no credential value or value hash. */
export type CredentialEditToken = Branded<'CredentialEditToken'>

/** Root-reviewed reference metadata, supplied to the existing account save owner. */
export interface CredentialEditPolicy {
  readonly references: readonly CredentialRef[]
  readonly maxReferences: number
  readonly maxReferenceBytes: number
}

/** A version is valid only for the original reference in this account generation. */
export interface CredentialEditVersion {
  readonly epoch: OwnerEpoch
  readonly editToken: CredentialEditToken
}

/** Native redacted description plus the Cloud concurrency version; no secret read API. */
export interface CredentialEditView {
  readonly credential: CredentialInfo
  readonly version: CredentialEditVersion
}

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
  /** Execute the factory's exclusive plugin operation on this same paused, empty serial owner.
   * @param submit Original native save/application; nested writer hooks join this turn.
   * @returns Actual settlement; this never resumes or terminally closes account admission.
   */
  withPausedPluginChange<T>(submit: () => Promise<T>): Promise<T>
  /** Observe the one approved profile selection/config edit in the original serial turn.
   * @param observe Original bounded profile/inventory read, including its private disk revision.
   * @param assertCurrent Original request and account check inside the turn.
   * @returns Public nonsecret value with an opaque epoch-bound edit version.
   */
  describePluginEdit<T>(observe: () => Promise<{ readonly value: T; readonly revision: string }>,
    assertCurrent: () => void): Promise<{ readonly value: T
    readonly version: PluginEditVersion }>
  /** Compare and publish on this same owner; confirmed no-write refusals do not become retained save failures.
   * @param version Original server-issued profile edit version.
   * @param revision Original bounded disk revision re-read inside the actual serial turn.
   * @param publish Original guarded native writer and mandatory application.
   * @param assertCurrent Original request/exclusive window check.
   * @returns Confirmed native value and advanced edit version, or a confirmed zero-write refusal.
   */
  commitPluginEdit<T>(version: PluginEditVersion, revision: () => string,
    publish: () => Promise<PluginEditCommit<T>>, assertCurrent: () => void): Promise<PluginEditCommit<{
    readonly value: T
    readonly version: PluginEditVersion
  }>>
  /** Check an existing plugin edit before a terminal rebuild without publishing or advancing it.
   * @param version Original opaque edit.
   * @param revision Actual original profile revision read in this same serial turn.
   * @param assertCurrent Original Peer or factory handoff check.
   * @returns Zero-write check outcome; no persistence receipt is synthesized.
   */
  checkPluginEdit(version: PluginEditVersion, revision: () => string, assertCurrent: () => void): Promise<
    Readonly<{ accepted: true }> | Readonly<{ accepted: false; error: CloudApiError }>>
  /**
   * Read the native redacted description in this owner's serial turn.
   * @param ref - approved native reference in this account.
   * @param describe - original read-only native provider operation.
   * @param assertCurrent - optional read-only request check inside the serial turn; its refusal submits no native work.
   * @returns redacted native facts and a version; unresolved saves prevent issuing one.
   */
  describeCredentialEdit(
    ref: CredentialRef, describe: () => Promise<CredentialInfo>, assertCurrent?: () => void,
  ): Promise<CredentialEditView>
  /**
   * Compare the original version in this owner's serial turn.
   * @param ref - approved original native reference.
   * @param version - original epoch and opaque edit token.
   * @param assertCurrent - optional read-only request check before any native save, inside the serial turn.
   * @param save - exactly one original native save, observed through its installed hook.
   * @returns the new version only after the save and enrolled application work succeed.
   */
  commitCredentialEdit(
    ref: CredentialRef, version: CredentialEditVersion, save: () => Promise<void>, assertCurrent?: () => void,
  ): Promise<CredentialEditVersion>
  /**
   * Join the actual native provider hook; managed references require a checked edit.
   * @param operation - original native operation address, without a secret value.
   * @param submit - original native queue submission and required publication.
   * @returns the original native result, joined to the existing owner turn.
   */
  admitCredentialSave<T>(operation: CredentialSaveOperation, submit: () => Promise<T>): Promise<T>
  /**
   * Keep persistence and required apply in one admission and serial turn.
   * @param kind - actual writer category.
   * @param persist - native persistence operation.
   * @param apply - mandatory application, not an optional display notification.
   * @returns the persistence result only after mandatory apply settles.
   */
  admitWithApply<T>(kind: ConfigSaveKind, persist: () => Promise<T>, apply: (value: T) => Promise<void>): Promise<T>
  /**
   * Observe the actual skill directory object in this owner's bounded serial turn.
   * @param observe Actual files current read, including its resident-result release.
   * @param assertCurrent Original Peer/Use and installed-owner checks before files work.
   * @returns Actual value plus a token tied to the observed native FsVersion or confirmed absence.
   */
  describeSkillEdit<T>(observe: () => Promise<{ readonly value: T; readonly revision: FsVersion | null }>,
    assertCurrent: () => void): Promise<{ readonly value: T
    readonly version: SkillEditVersion }>
  /**
   * Compare an opaque skill edit and persist with its real native FsVersion in this same turn.
   * @param version Original read edit; no caller-supplied native revision is accepted.
   * @param persist Actual pointer CAS; a false result certifies no pointer publication.
   * @param apply Synchronous visible-provider/invalidate and handoff release, followed by required provider disposal settlement.
   * @param assertCurrent Original request/installed-owner check, before any prepare or write.
   * @returns Advanced token; apply failure retains original save responsibility and the persisted token.
   */
  commitSkillEdit(version: SkillEditVersion, persist: (expected: FsVersion | null) => Promise<SkillPointerCommit>,
    apply: () => void | Promise<void>, assertCurrent: () => void): Promise<SkillEditVersion>
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

/** Version of the fixed approved profile choice, held by the original configuration save owner. */
export type PluginEditToken = Branded<'PluginEditToken'>
/** Exact account epoch and opaque server token; no profile bytes or digest are disclosed. */
export interface PluginEditVersion { readonly epoch: OwnerEpoch; readonly editToken: PluginEditToken }
/** A native confirmed application or an owner-certified zero-publication refusal. */
export type PluginEditCommit<T> = Readonly<{ published: true; readonly value: T; readonly revision: string }>
  | Readonly<{ published: false; readonly error: CloudApiError }>

/** Opaque edit for the one installed skill directory object; no global configuration revision. */
export type SkillEditToken = Branded<'SkillEditToken'>
/** Same account generation and skill directory; the native FsVersion remains server-owned. */
export interface SkillEditVersion { readonly epoch: OwnerEpoch; readonly editToken: SkillEditToken }
/** A real pointer commit or a confirmed no-pointer-write refusal. */
export type SkillPointerCommit = Readonly<{ persisted: true; revision: FsVersion }>
  | Readonly<{ persisted: false; error: CloudApiError }>
