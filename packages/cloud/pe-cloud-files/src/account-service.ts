/** Graph-owned preparation installs the native Registry and its selected restricted filesystem in one account fiber. */
import type { SkillProjectPort } from './skill-project-work.ts'
import type { SkillProjectGrant, SkillWorkingCopyGrant, SkillOperationCopies } from './skill-projection.ts'
import type { SkillVersion } from './skill-versions.ts'
import type { SkillVersionPort } from './skill-versions.ts'
import type { SkillBundleInput, SkillBundleVersion, SkillBundleSource, SkillCatalog, SkillCatalogChange,
  SkillCatalogCommit, SkillBundleWorkingCopy, SkillBundlePort, SkillBundleOperationCopies } from './skill-bundles.ts'
import { Context, FiberState, Service, symbols, type Fiber } from '@deepseek-ai/cordis'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { IsolatedLeafGrant, PoolReadPort } from './worker-pool.ts'
import type { ControlledWorkspaceRegistry, ControlledWorkspaceRegistryConstructor } from './workspace-adapter.ts'
import type { S2ProjectDirectory, S2ProjectPort } from './s2-project.ts'
import { FilesFailure } from './error.ts'
import type { InstructionReadReaders } from './instruction-read-work.ts'
import type { ResidentResult } from './work-queue.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { createAccountAttachmentStore, type AccountAttachmentBackend } from './account-attachment-store.ts'
import type { StageFileResult } from './stage-bridge.ts'
import type { EnvironmentSessionId, ExecutionMountGrant } from './environment-bank.ts'

/** Trusted runtime preparation only; Loader JSON cannot select an account, path, backend or plugin. */
export interface AccountFilesPreparation {
  /** Root storage lease supplies this private fixed-purpose port; omission grants no skill storage. */
  readonly skillVersions?: () => SkillVersionPort
  /** Fixed original-lease projection issuer; no client-selected backend or path. */
  readonly skillProjection?: () => SkillProjectPort
  readonly binding: AccountBinding
  readonly port: Pick<PoolReadPort, 'createWorkspaceRegistry'>
  readonly defaultGrant: IsolatedLeafGrant
  /**
   * Select an already reviewed native provider for the actual registered project before its sole FS installs.
   * @param workspace Original native Registry object, never a path-selected project.
   * @param assertInstalled Same graph and original active Registry checks for the provider's lifetime.
   * @returns Native constructor after its actual restricted backend preparation; omission keeps metadata-only S2 behavior.
   */
  readonly createFileSystem?: (
    workspace: Workspace, assertInstalled: (owner: Context) => void,
    mapProcessPath?: (caller: Context, hostPath: string) => string | undefined,
  ) => Promise<S2ProjectPort['FileSystem']>
  /** Original lane mutation capabilities; omission keeps attachment intake and staging closed. */
  readonly attachments?: Pick<PoolReadPort, 'assertStagingAvailable' | 'stageFiles' | 'runNativeMutation'>
  /** Trusted synchronous lookup of an active request's verified copies; never a private-root prefix grant. */
  readonly attachmentProjection?: Pick<AccountAttachmentBackend, 'mapFileHostPath'> & {
    mapProcessPath(caller: Context, hostPath: string): string | undefined
  }
  /** Same-lane metadata capability for an exact native Registry object. */
  readonly projectFor?: (workspace: Workspace, assertRegistered: () => void, signal?: AbortSignal) => Promise<AccountFilesProject>
  /** Fixed storage-lease callback; omission keeps execution storage unavailable on v1 deployments. */
  readonly prepareExecutionMounts?: (
    workspace: Workspace, sessionId: EnvironmentSessionId, environmentVersion: string, assertRegistered: () => void, signal?: AbortSignal,
  ) => Promise<ResidentResult<ExecutionMountGrant>>
  /** Ready-only creation from the original borrow; the trusted lease selects the UUID and grant. */
  readonly createProject?: (
    registry: ControlledWorkspaceRegistry, use: AccountUse, title: string | undefined, signal: AbortSignal,
  ) => Promise<Workspace>
  /** Require original same-lane ABI8 content capability; omission grants no content readiness. */
  readonly assertContentAvailable?: () => void
  /**
   * Reserve and consume independent source readers for the original native project.
   * @param workspace Exact registered object; callers must first approve the actual Agent/Session relationship.
   * @param reservedBytes Complete snapshot construction and retained-result storage.
   * @param build Consumes fixed readers inside the one files-owned operation.
   * @param signal Turn/account cancellation; actual work remains with the original lane.
   * @param assertRegistered Original provider and exact Registry object check, repeated within source I/O.
   * @returns Complete result retained until release; omission keeps instruction reads unavailable.
   */
  readonly withInstructionReaders?: <T>(
    workspace: Workspace, reservedBytes: number,
    build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>, signal: AbortSignal,
    assertRegistered: () => void,
  ) => Promise<ResidentResult<T>>
  /** Require the exact installed mounting/current graph and deployment authority, independently of business readiness. */
  readonly assertMountCurrent: (binding: AccountBinding) => void
  /** Require the original unpublished installation/registration window. */
  readonly assertUnpublished: () => void
}

/** Actual native installation output; presence does not certify deployment safety or publish business readiness. */
export interface AccountFilesProject {
  readonly binding: AccountBinding
  readonly workspace: Workspace
  readonly projectDirectory: S2ProjectDirectory
}

interface Installation {
  readonly entry: Fiber
  readonly result: Promise<AccountFilesProject>
  registry?: Fiber
  filesystem?: Fiber
  scope?: S2ProjectPort
  project?: AccountFilesProject
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Runtime-prepared account files owner; native installation and business admission remain separate. */
    peCloudFiles: CloudAccountFiles
  }
}

/** One graph's real Registry/FS installation; shared pool drain and directory responsibility stay with their original owners. */
export class CloudAccountFiles extends Service {
  /** Exact runtime-installed graph binding, independent of account business readiness. */
  readonly binding: AccountBinding
  // Keep native constructor identity stable through Cordis caller-scoped method tracing.
  private readonly providers: {
    readonly skillVersions: AccountFilesPreparation['skillVersions']
    readonly skillProjection: AccountFilesPreparation['skillProjection']
    readonly Registry: ControlledWorkspaceRegistryConstructor
    readonly createFileSystem: AccountFilesPreparation['createFileSystem']
    readonly withInstructionReaders: AccountFilesPreparation['withInstructionReaders']
    readonly projectFor: AccountFilesPreparation['projectFor']
    readonly prepareExecutionMounts: AccountFilesPreparation['prepareExecutionMounts']
    readonly createProject: AccountFilesPreparation['createProject']
    readonly assertContentAvailable: AccountFilesPreparation['assertContentAvailable']
    readonly attachments: AccountFilesPreparation['attachments']
    readonly attachmentProjection: AccountFilesPreparation['attachmentProjection']
  }
  private readonly attachmentProvider: { Store?: typeof LocalAttachmentStore } = {}
  private readonly checkGraph: (owner: Context) => void
  private readonly unpublished: AccountFilesPreparation['assertUnpublished']
  private readonly identity = Symbol('account-files-owner')
  // Caller-scoped Cordis service proxies share this cell; replacing a service field would shadow it per caller.
  private readonly installation: { work?: Installation } = {}
  private readonly executionStorage = {
    projects: new WeakSet<AccountFilesProject>(), grants: new WeakMap<ExecutionMountGrant, () => void>(),
  }

  /**
   * Prepare before native Include activation using an already bound, restricted lane.
   * @param ctx Independent account prepare scope with its exact binding and native Loader.
   * @param input Trusted lane, fixed default grant and deployment/current/unpublished checks; never an HTTP borrow.
   * @throws FilesFailure for a duplicate owner, foreign binding or missing native prepare context.
   */
  constructor(ctx: Context, input: AccountFilesPreparation) {
    if (ctx.get('peCloudFiles', false) !== undefined || ctx.root.get('peCloudFiles', false) !== undefined) {
      throw new FilesFailure('files/prerequisite-missing', 'The account graph already has a files owner.')
    }
    const checkBinding = (owner: Context): void => {
      if (input.binding.lifetime.aborted || owner.root !== ctx.root
        || owner.get('peAccount') !== input.binding || owner.root.get('peAccount') !== input.binding
        || ctx.get('peAccount') !== input.binding || ctx.root.get('peAccount') !== input.binding) {
        throw new FilesFailure('cloud/stale-generation', 'The files owner and account graph have different bindings.')
      }
      ctx.fiber.assertActive()
      owner.fiber.assertActive()
    }
    const checkGraph = (owner: Context): void => {
      checkBinding(owner)
      input.assertMountCurrent(input.binding)
      checkBinding(owner)
    }
    checkGraph(ctx)
    if (ctx.get('loader') === undefined || input.defaultGrant.binding !== input.binding) {
      throw new FilesFailure('files/prerequisite-missing', 'Files preparation requires the native Loader and exact bound grant.')
    }
    input.assertUnpublished()
    const Registry = input.port.createWorkspaceRegistry(input.defaultGrant, input.assertUnpublished)
    checkGraph(ctx)
    super(ctx, 'peCloudFiles')
    this.binding = input.binding
    this.providers = { Registry, skillVersions: input.skillVersions, skillProjection: input.skillProjection, createFileSystem
    : input.createFileSystem, withInstructionReaders: input.withInstructionReaders,
    projectFor: input.projectFor, prepareExecutionMounts: input.prepareExecutionMounts,
    createProject: input.createProject, assertContentAvailable: input.assertContentAvailable,
    attachments: input.attachments, attachmentProjection: input.attachmentProjection }
    this.checkGraph = checkGraph
    this.unpublished = input.assertUnpublished
    this.assertInstalled()
    if (input.attachmentProjection !== undefined) {
      this.attachmentProvider.Store = createAccountAttachmentStore({
        binding: this.binding, assertCurrent: () => { this.assertInstalled() },
        assertInstalled: (caller) => { this.assertInstalled(caller) },
        mapFileHostPath: input.attachmentProjection.mapFileHostPath.bind(input.attachmentProjection),
      })
    }
  }

  /**
   * Return this installed graph's original fixed private skill port; no model or raw-file entry is exposed.
   * @returns The original bound port, rejecting when static storage or the native capability is absent.
   */
  skillVersions(): SkillVersionPort {
    this.assertInstalled()
    const prepare = this.providers.skillVersions
    if (prepare === undefined) throw new FilesFailure('files/prerequisite-missing', 'Private skill storage is unavailable')
    return prepare()
  }

  private skillBundlePort(): SkillBundlePort {
    const port = this.skillVersions().bundles
    if (port === undefined) throw new FilesFailure('files/prerequisite-missing', 'Managed skill bundles are unavailable.')
    return port
  }

  /**
   * Prepare a complete immutable tree through the original lane and reviewed helper.
   * @param input Complete package files or archive bytes.
   * @param signal Caller observation cancellation; actual work remains owned to settlement.
   * @returns A files-issued version whose result remains retained through release.
   */
  prepareBundle(input: SkillBundleInput, signal: AbortSignal): Promise<ResidentResult<SkillBundleVersion>> {
    return this.skillBundlePort().prepareBundle(input, signal)
  }

  /**
   * Observe the complete single catalog; schema1 is projected without migration writes.
   * @param signal Caller observation cancellation.
   * @returns A complete issued observation retained through release.
   */
  observeCatalog(signal: AbortSignal): Promise<ResidentResult<SkillCatalog>> {
    return this.skillBundlePort().observeCatalog(signal)
  }

  /**
   * CAS one installation in the original current.json, inside the caller's existing save observation.
   * @param expected Exact catalog observation issued by this files generation.
   * @param change One installation change using issued bundle authority.
   * @param signal Caller observation cancellation; confirmed durable outcomes remain observable.
   * @returns The confirmed catalog and affected entry, retained through release; unknown publication rejects without rollback.
   */
  commitCatalog(expected: SkillCatalog, change: SkillCatalogChange, signal: AbortSignal): Promise<ResidentResult<SkillCatalogCommit>> {
    return this.skillBundlePort().commitCatalog(expected, change, signal)
  }

  /**
   * Borrow one issued complete source; the callback and its resident result retain the original borrow.
   * @param version Exact issued source selected under the original save ordering.
   * @param consume Consumes source methods while their operation lease remains active.
   * @param signal Caller observation cancellation.
   * @returns The consumed value with actual reservation and source retention held until release.
   */
  withBundleSource<T>(version: SkillBundleVersion,
    consume: (source: SkillBundleSource, control: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<ResidentResult<T>> {
    return this.skillBundlePort().withBundleSource(version, consume, signal)
  }

  /**
   * Export every member of the exact authorized version as a bounded ZIP.
   * @param version Exact issued authorized source version.
   * @param signal Actual export observation cancellation.
   * @returns The complete owned archive, retained through release.
   */
  exportBundle(version: SkillBundleVersion, signal: AbortSignal): Promise<ResidentResult<Uint8Array<ArrayBuffer>>> {
    return this.skillBundlePort().exportBundle(version, signal)
  }

  /**
   * Materialize the complete tree under the original issued project, preserving existing writable copies.
   * @param project Original issued active project grant.
   * @param version The exact operation-scoped source.version lease when called inside source consumption.
   * @param signal Observation cancellation; actual copy work retains its original owner.
   * @returns An issued complete working copy after confirmed publication and protected association CAS.
   */
  materializeBundleVersion(project: SkillProjectGrant, version: SkillBundleVersion,
    signal: AbortSignal): Promise<ResidentResult<SkillBundleWorkingCopy>> {
    return this.skillBundlePort().materializeBundleVersion(project, version, signal)
  }

  private skillProjectPort(): SkillProjectPort {
    this.assertInstalled()
    const port = this.providers.skillProjection
    if (port === undefined) throw new FilesFailure('files/prerequisite-missing', 'Fixed skill projection is unavailable.')
    return port()
  }

  /**
   * Fix the actual skills parent before allocation, without creating any sandbox or binding an environment slot.
   * @param project Exact installed/projectFor object after Root's actual native caller selection.
   * @param signal Cancellation leaves all actual I/O with the original files lane.
   * @returns Parent facts retained until the original allocation/export actual joins release the result.
   */
  async prepareSkillProject(project: AccountFilesProject, signal: AbortSignal): Promise<ResidentResult<SkillProjectGrant>> {
    const current = (): void => {
      this.assertWorkspace(project.workspace)
      if (!this.executionStorage.projects.has(project) || project.binding !== this.binding) {
        throw new FilesFailure('cloud/stale-generation', 'Skill projection requires the original issued project.')
      }
    }
    current()
    return await this.skillProjectPort().prepareProject(project.workspace, current, signal)
  }

  /**
   * Fully publish a fixed two-file version or reuse its protected association while preserving user edits.
   * @param project Exact actively borrowed parent grant from this owner.
   * @param version Exact original immutable version capability.
   * @param signal Observer cancellation cannot settle running native work or ambiguous publication.
   * @returns A complete current-project resource base and persistent issued copy handle; release ends this I/O result, not the copy.
   */
  materializeSkillVersion(project: SkillProjectGrant, version: SkillVersion, signal: AbortSignal)
    : Promise<ResidentResult<SkillWorkingCopyGrant>> {
    return this.skillProjectPort().materialize(project, version, signal)
  }

  /**
   * Borrow complete issued full-tree copies through actual operation settlement, independently of the parent lease.
   * @param project Original active project grant.
   * @param copies Exact issued same-project copies.
   * @param signal Preparation observation cancellation.
   * @returns The complete operation borrow retained through actual remote, local and physical settlement.
   */
  borrowBundleWorkingCopies(project: SkillProjectGrant, copies: readonly (SkillWorkingCopyGrant | SkillBundleWorkingCopy)[],
    signal: AbortSignal): Promise<ResidentResult<SkillBundleOperationCopies>> {
    return this.skillProjectPort().borrowBundles(project, copies, signal)
  }

  /**
   * Derive the complete bounded persisted copy set, including legacy copies, and retain it for one operation.
   * @param project Original active project grant.
   * @param signal Preparation observation cancellation.
   * @returns The complete confirmed operation set retained through release.
   */
  borrowAllBundleWorkingCopies(project: SkillProjectGrant, signal: AbortSignal): Promise<ResidentResult<SkillBundleOperationCopies>> {
    return this.skillProjectPort().borrowBundles(project, undefined, signal)
  }

  /**
   * Require the original unreleased full-tree operation result before granting execution access.
   * @param value Exact original operation borrow.
   */
  assertBundleOperationCopies(value: SkillBundleOperationCopies): void { this.skillProjectPort().assertBundleBorrow(value) }

  /**
   * Revalidate protected associations and actual directories for each original operation before role issuance.
   * @param project Original allocation parent grant still retained by its export/allocation.
   * @param copies Exact issued same-project handles selected by the original trusted caller.
   * @param signal Actual preparation cancellation; the result must survive any subsequent observer cancellation.
   * @returns Bounded facts held through original whenEmpty+localSettled or joined physical-stop completion.
   */
  borrowSkillWorkingCopies(project: SkillProjectGrant, copies: readonly SkillWorkingCopyGrant[], signal: AbortSignal)
    : Promise<ResidentResult<SkillOperationCopies>> {
    return this.skillProjectPort().borrow(project, copies, signal)
  }

  /**
   * Derive and borrow every confirmed copy for this project without an API/execution-owned membership cache.
   * @param project Original active allocation parent capability.
   * @param signal Preparation cancellation; actual work and the returned result retain original ownership.
   * @returns The complete bounded set after actual association/source/directory checks; any unqualified version or excess rejects
   * the whole set.
   */
  borrowAllSkillWorkingCopies(project: SkillProjectGrant, signal: AbortSignal): Promise<ResidentResult<SkillOperationCopies>> {
    return this.skillProjectPort().borrowAll(project, signal)
  }

  /**
   * Require an exact active parent result before Root captures export/allocation facts.
   * @param grant Original issued capability from this owner.
   */
  assertSkillProjectGrant(grant: SkillProjectGrant): void { this.skillProjectPort().assertProject(grant) }
  /**
   * Require an exact current persistent copy handle; execution additionally needs a live operation borrow.
   * @param grant Original issued capability from this owner.
   */
  assertSkillWorkingCopy(grant: SkillWorkingCopyGrant): void { this.skillProjectPort().assertCopy(grant) }
  /**
   * Require the original unreleased operation result before signing/using its fixed facts.
   * @param grant Original issued capability from this owner.
   */
  assertSkillOperationCopies(grant: SkillOperationCopies): void { this.skillProjectPort().assertBorrow(grant) }

  /**
   * Select the single native provider constructor prepared for this graph.
   * @returns Native class with unchanged Config and persistence, after the staging capability check.
   */
  attachmentStore(): typeof LocalAttachmentStore {
    this.assertInstalled()
    this.providers.attachments?.assertStagingAvailable()
    const Store = this.attachmentProvider.Store
    if (this.providers.attachments === undefined || Store === undefined) {
      throw new FilesFailure('files/prerequisite-missing', 'Account attachment preparation is unavailable.')
    }
    return Store
  }

  /**
   * Copy approved native refs using the original store and this account's existing mutation lane.
   * @param workspace Actual registered project selected by the native Agent owner.
   * @param buildRefs Collect native receipts or accepted Session refs inside the positive batch reservation.
   * @param assertAuthorized Exact Agent/Session/provider checks, repeated before source I/O.
   * @param signal Actual caller cancellation, combined with the original account lifetime by the pool.
   * @returns Closed publications whose retained reservation must be released after handoff.
   */
  async stageAttachments(
    workspace: Workspace, buildRefs: () => readonly FileAttachmentRef[], assertAuthorized: () => void, signal?: AbortSignal,
  ): Promise<ResidentResult<readonly StageFileResult[]>> {
    const port = this.providers.attachments, Store = this.attachmentProvider.Store
    if (port === undefined || Store === undefined) throw new FilesFailure('files/prerequisite-missing',
      'Account attachment staging is unavailable.')
    const original = this.ctx.get('attachments')
    if (!(original instanceof Store)) throw new FilesFailure('files/prerequisite-missing',
      'The original native attachment store is unavailable.')
    const current = (): void => {
      this.assertWorkspace(workspace)
      assertAuthorized()
      const currentStore = this.ctx.get('attachments')
      if (currentStore === undefined || (Reflect.get(currentStore, symbols.original) ?? currentStore)
        !== (Reflect.get(original, symbols.original) ?? original)) {
        throw new FilesFailure('cloud/stale-generation', 'The native attachment store changed during staging.')
      }
    }
    current()
    const held = await port.stageFiles(workspace, () => buildRefs().map(ref => ({ ref, open: (control: AbortSignal) => {
      current()
      return original.readFileStream(ref, control)
    } })), current, signal)
    try { current(); signal?.throwIfAborted(); return held }
    catch (error) { held.release(); throw error }
  }

  /**
   * Admit native upload persistence on the same files mutation owner before any stream is pulled.
   * @param reservationBytes Complete finite intake/cleanup/result reservation.
   * @param assertAuthorized Original Agent and provider checks; no path-derived authority.
   * @param execute Native persistence operation whose actual settlement remains owned by the pool.
   * @param signal Observation cancellation; an unconfirmed failure retains the original positive reservation.
   * @returns The native result retained until release.
   */
  runAttachmentIntake<T>(
    reservationBytes: number, assertAuthorized: () => void, execute: (control: AbortSignal) => Promise<T>, signal?: AbortSignal,
  ): Promise<ResidentResult<T>> {
    this.assertInstalled()
    const port = this.providers.attachments
    if (port === undefined) throw new FilesFailure('files/prerequisite-missing', 'Account attachment intake is unavailable.')
    return port.runNativeMutation(reservationBytes, () => { this.assertInstalled(); assertAuthorized() }, execute, signal)
  }

  /**
   * Require this exact prepared owner and current binding without granting business admission.
   * @param owner Native scope in the original account graph; omission checks the calling service scope.
   */
  assertInstalled(owner: Context = this.ctx): void {
    this.checkGraph(owner)
    const local = owner.get('peCloudFiles'), root = owner.root.get('peCloudFiles')
    if (!(local instanceof CloudAccountFiles) || !(root instanceof CloudAccountFiles)
      || local.identity !== this.identity || root.identity !== this.identity) {
      throw new FilesFailure('cloud/stale-generation', 'The account files owner belongs to another graph.')
    }
  }

  /**
   * Install the sole original native Registry, await its default result, then prepare and install its selected native FileSystem.
   * Without a trusted provider factory, retain the metadata-only S2 implementation.
   * One Promise retains actual settlement; failure is terminal for this owner and does not certify cleanup.
   * @param owner Actual files/account Loader scope, which owns both native child fibers.
   * @returns The actual project after provider activation and directory verification; no ready or clean claim.
   */
  install(owner: Context): Promise<AccountFilesProject> {
    this.assertInstalled(owner)
    if (owner.fiber.uid === 0) throw new FilesFailure('files/prerequisite-missing',
      'Native files installation requires its account entry fiber.')
    if (this.installation.work !== undefined) {
      if (this.installation.work.entry !== owner.fiber) {
        throw new FilesFailure('files/prerequisite-missing', 'The account files owner already has its installation fiber.')
      }
      if (this.installation.work.project !== undefined) this.assertProviders(this.installation.work)
      return this.installation.work.result
    }
    this.unpublished()
    const work: Installation = { entry: owner.fiber, result: Promise.resolve().then(() => this.mount(owner, work)) }
    this.installation.work = work
    // Native Loader and runtime can stop observing while this one actual installation remains owned.
    void work.result.catch(() => {})
    return work.result
  }

  /**
   * Read the installed actual project for trusted API/runtime assembly.
   * @returns The original Workspace object and files-owned directory capability, while both native providers remain current.
   * @throws FilesFailure before successful installation, after provider disposal or for a foreign/stale graph.
   */
  project(): AccountFilesProject {
    this.assertInstalled()
    const work = this.installation.work
    if (work?.project === undefined) throw new FilesFailure('files/prerequisite-missing',
      'Native account files installation has not completed.')
    this.assertProviders(work)
    this.assertWorkspace(work.project.workspace)
    return work.project
  }

  /**
   * Require the settled original Registry/FS installation and its trusted actual content-capability check.
   * @throws FilesFailure for partial installation, replaced providers, S2 omission or unavailable ABI8 pool capability.
   */
  assertContentAvailable(): void {
    this.assertInstalled()
    const work = this.installation.work, assertContent = this.providers.assertContentAvailable
    if (work?.project === undefined || assertContent === undefined) {
      throw new FilesFailure('files/prerequisite-missing', 'Native account content installation has not completed or is unavailable.')
    }
    this.assertProviders(work)
    assertContent()
    this.assertProviders(work)
  }

  private assertWorkspace(workspace: Workspace): void {
    this.assertInstalled()
    const work = this.installation.work
    if (work === undefined) throw new FilesFailure('files/prerequisite-missing', 'The original files installation is unavailable.')
    this.assertProviders(work)
    if (work.entry.ctx.get('workspaceRegistry')?.get(workspace.id) !== workspace) {
      throw new FilesFailure('cloud/stale-generation', 'The original registered Workspace is no longer current.')
    }
  }

  /**
   * Derive metadata for the actual registered object without selecting or replacing the bootstrap default.
   * @param workspace Native Registry object already selected by trusted account admission.
   * @param signal Cancellation of bounded metadata observation.
   * @returns A fixed directory capability on the original lane; it grants no new service or registration window.
   */
  async projectFor(workspace: Workspace, signal?: AbortSignal): Promise<AccountFilesProject> {
    this.assertWorkspace(workspace)
    const derive = this.providers.projectFor
    if (derive === undefined) throw new FilesFailure('files/prerequisite-missing', 'Project selection is unavailable.')
    const current = (): void => { this.assertWorkspace(workspace) }
    const result = await derive(workspace, current, signal)
    current()
    if (result.binding !== this.binding || result.workspace !== workspace || result.projectDirectory.binding !== this.binding) {
      throw new FilesFailure('cloud/stale-generation', 'Derived project belongs to another generation.')
    }
    this.executionStorage.projects.add(result)
    return result
  }

  /**
   * Bind a persistent environment only after Root approved the exact live native Agent/Session and project relationship.
   * Session strings, copied project results and path-selected inputs cannot establish that approval.
   * @param project Original object obtained from this owner's install/project/projectFor method.
   * @param sessionId Real native Session already checked by Root's account-native guards.
   * @param environmentVersion Approved image/architecture/Python/init identity, never command environment input.
   * @param signal Observer cancellation; confirmed late metadata remains bound and unknown retains actual work.
   * @returns An opaque original grant with its resident reservation; release revokes it without freeing or deleting a slot.
   */
  async prepareExecutionMounts(
    project: AccountFilesProject, sessionId: EnvironmentSessionId, environmentVersion: string, signal?: AbortSignal,
  ): Promise<ResidentResult<ExecutionMountGrant>> {
    const current = (): void => {
      this.assertWorkspace(project.workspace)
      if (!this.executionStorage.projects.has(project) || project.binding !== this.binding
        || !project.workspace.sessionIds.includes(sessionId)) {
        throw new FilesFailure('cloud/stale-generation', 'Execution storage requires the original issued project and native membership.')
      }
    }
    current()
    signal?.throwIfAborted()
    const prepare = this.providers.prepareExecutionMounts
    if (prepare === undefined) throw new FilesFailure('files/prerequisite-missing', 'No verified environment bank is installed.')
    const held = await prepare(project.workspace, sessionId, environmentVersion, current, signal)
    try {
      current()
      signal?.throwIfAborted()
      const grant = held.value
      if (grant.binding !== this.binding || grant.sessionId !== sessionId || grant.workspaceId !== project.workspace.id) {
        throw new FilesFailure('cloud/stale-generation', 'The mount grant belongs to another native selection.')
      }
      const release = (): void => {
        if (!this.executionStorage.grants.delete(grant)) return
        this.binding.lifetime.removeEventListener('abort', release)
        held.release()
      }
      this.executionStorage.grants.set(grant, current)
      this.binding.lifetime.addEventListener('abort', release, { once: true })
      return Object.freeze({ value: grant, release })
    } catch (error) { held.release(); throw error }
  }

  /**
   * Recheck the original opaque object before allocation or user execution; Root also repeats its native Session guard.
   * @param grant Exact unreleased object issued by this files owner.
   * @throws FilesFailure after release, graph/provider replacement, lost membership or a foreign/copied object.
   */
  assertExecutionMountGrant(grant: ExecutionMountGrant): void {
    const current = this.executionStorage.grants.get(grant)
    if (current === undefined) throw new FilesFailure('cloud/stale-generation', 'The execution mount grant is not owned or was revoked.')
    current()
  }

  /**
   * Create one server-selected project while retaining the actual ready borrow through native settlement.
   * @param use Original runtime borrow; request JSON cannot supply it.
   * @param title Native display title; it never chooses a path or leaf.
   * @param signal Admission cancellation; started registration keeps its actual responsibility.
   * @returns The actual fulfilled native Workspace, after responsibility transfer.
   */
  async createProject(use: AccountUse, title: string | undefined, signal: AbortSignal): Promise<Workspace> {
    signal.throwIfAborted()
    this.assertInstalled(use.context)
    use.assertCurrent()
    if (use.binding !== this.binding) throw new FilesFailure('cloud/stale-generation', 'Project creation needs the original ready borrow.')
    const work = this.installation.work, create = this.providers.createProject
    if (work === undefined || create === undefined) throw new FilesFailure('files/prerequisite-missing',
      'Ready project creation is unavailable.')
    this.assertProviders(work)
    const registry = work.entry.ctx.get('workspaceRegistry')
    if (!(registry instanceof this.providers.Registry)) throw new FilesFailure('files/prerequisite-missing',
      'The original Registry is unavailable.')
    const result = await create(registry, use, title, signal)
    use.assertCurrent()
    this.assertWorkspace(result)
    return result
  }

  /**
   * Consume source readers only for this owner's exact registered native project.
   * The trusted caller owns exact active Agent/Session admission; no path or id grants authority here.
   * @param workspace Exact Registry object after shared native admission.
   * @param reservedBytes Complete snapshot storage held through native message handoff.
   * @param build Consumes independent source readers without another lane reservation.
   * @param signal Cancellation leaves actual work with the same files participant.
   * @returns Complete retained result after source I/O settles; stale results are released and rejected.
   */
  async withInstructionReaders<T>(
    workspace: Workspace, reservedBytes: number,
    build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>, signal: AbortSignal,
  ): Promise<ResidentResult<T>> {
    this.assertWorkspace(workspace)
    const read = this.providers.withInstructionReaders
    if (read === undefined) {
      throw new FilesFailure('files/prerequisite-missing', 'The original project instruction sources are unavailable.')
    }
    signal.throwIfAborted()
    const held = await read(workspace, reservedBytes, build, signal, () => { this.assertWorkspace(workspace) })
    try {
      signal.throwIfAborted()
      this.assertWorkspace(workspace)
      return held
    } catch (error) { held.release(); throw error }
  }

  private async mount(owner: Context, work: Installation): Promise<AccountFilesProject> {
    this.assertInstalled(owner)
    this.unpublished()
    if (owner.get('workspaceRegistry', false) !== undefined || owner.root.get('workspaceRegistry', false) !== undefined
      || owner.get('fs', false) !== undefined || owner.root.get('fs', false) !== undefined) {
      throw new FilesFailure('files/prerequisite-missing', 'Files installation requires sole native Registry and filesystem ownership.')
    }
    work.registry = owner.plugin(this.providers.Registry)
    await work.registry.await()
    this.assertInstalled(owner)
    this.unpublished()
    this.assertRegistry(work)
    const registry = owner.get('workspaceRegistry')
    if (!(registry instanceof this.providers.Registry)) throw new FilesFailure('files/prerequisite-missing',
      'The native files Registry is absent.')
    const scope = await registry.createS2Project()
    this.assertInstalled(owner)
    this.unpublished()
    this.assertRegistry(work)
    if (scope.binding !== this.binding || scope.projectDirectory.binding !== this.binding) {
      throw new FilesFailure('cloud/stale-generation', 'The native project has a different files binding.')
    }
    const workspace = registry.get(scope.workspaceId)
    if (workspace === undefined) throw new FilesFailure('files/prerequisite-missing', 'The native default Workspace is absent.')
    const FileSystem = this.providers.createFileSystem === undefined ? scope.FileSystem
      : await this.providers.createFileSystem(workspace, (consumer) => {
        this.assertInstalled(consumer)
        this.assertRegistry(work)
      }, this.providers.attachmentProjection?.mapProcessPath.bind(this.providers.attachmentProjection))
    this.assertInstalled(owner)
    this.unpublished()
    this.assertRegistry(work)
    work.scope = Object.freeze({ ...scope, FileSystem })
    work.filesystem = owner.plugin(FileSystem)
    await work.filesystem.await()
    this.assertInstalled(owner)
    this.unpublished()
    this.assertProviders(work)
    await scope.projectDirectory.prepare(workspace.path)
    this.assertInstalled(owner)
    this.unpublished()
    this.assertProviders(work)
    const projectDirectory: S2ProjectDirectory = Object.freeze({
      binding: this.binding,
      prepare: async (cwd: string) => {
        this.assertProviders(work)
        await scope.projectDirectory.prepare(cwd)
        this.assertProviders(work)
      },
    })
    work.project = Object.freeze({ binding: this.binding, workspace, projectDirectory })
    this.executionStorage.projects.add(work.project)
    return work.project
  }

  private assertRegistry(work: Installation): void {
    this.assertInstalled(work.entry.ctx)
    const registry = work.entry.ctx.get('workspaceRegistry'), root = work.entry.ctx.root.get('workspaceRegistry')
    if ((work.entry.state !== FiberState.ACTIVE && (work.project !== undefined || work.entry.state !== FiberState.LOADING))
      || work.registry?.state !== FiberState.ACTIVE
      || !(registry instanceof this.providers.Registry) || !(root instanceof this.providers.Registry)) {
      throw new FilesFailure('files/prerequisite-missing', 'The original native files Registry is inactive or replaced.')
    }
    const fibers = work.entry.ctx.registry.get(this.providers.Registry)?.fibers
    if (fibers?.length !== 1 || fibers[Symbol.iterator]().next().value?.uid !== work.registry.uid) {
      throw new FilesFailure('files/prerequisite-missing', 'The account files Registry fiber is not unique.')
    }
  }

  private assertProviders(work: Installation): void {
    this.assertRegistry(work)
    const scope = work.scope, fs = work.entry.ctx.get('fs'), root = work.entry.ctx.root.get('fs')
    if (scope === undefined || work.filesystem?.state !== FiberState.ACTIVE
      || !(fs instanceof scope.FileSystem) || !(root instanceof scope.FileSystem)) {
      throw new FilesFailure('files/prerequisite-missing', 'The original native account filesystem is inactive or replaced.')
    }
    const fibers = work.entry.ctx.registry.get(scope.FileSystem)?.fibers
    if (fibers?.length !== 1 || fibers[Symbol.iterator]().next().value?.uid !== work.filesystem.uid) {
      throw new FilesFailure('files/prerequisite-missing', 'The native account filesystem or Workspace is no longer current.')
    }
  }
}
