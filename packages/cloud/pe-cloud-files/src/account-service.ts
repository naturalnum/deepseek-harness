/** Graph-owned preparation installs the native Registry and its selected restricted filesystem in one account fiber. */
import { Context, FiberState, Service, type Fiber } from '@deepseek-ai/cordis'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { IsolatedLeafGrant, PoolReadPort } from './worker-pool.ts'
import type { ControlledWorkspaceRegistry, ControlledWorkspaceRegistryConstructor } from './workspace-adapter.ts'
import type { S2ProjectDirectory, S2ProjectPort } from './s2-project.ts'
import { FilesFailure } from './error.ts'
import type { InstructionReadReaders } from './instruction-read-work.ts'
import type { ResidentResult } from './work-queue.ts'

/** Trusted runtime preparation only; Loader JSON cannot select an account, path, backend or plugin. */
export interface AccountFilesPreparation {
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
  ) => Promise<S2ProjectPort['FileSystem']>
  /** Same-lane metadata capability for an exact native Registry object. */
  readonly projectFor?: (workspace: Workspace, assertRegistered: () => void, signal?: AbortSignal) => Promise<AccountFilesProject>
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
    readonly Registry: ControlledWorkspaceRegistryConstructor
    readonly createFileSystem: AccountFilesPreparation['createFileSystem']
    readonly withInstructionReaders: AccountFilesPreparation['withInstructionReaders']
    readonly projectFor: AccountFilesPreparation['projectFor']
    readonly createProject: AccountFilesPreparation['createProject']
    readonly assertContentAvailable: AccountFilesPreparation['assertContentAvailable']
  }
  private readonly checkGraph: (owner: Context) => void
  private readonly unpublished: AccountFilesPreparation['assertUnpublished']
  private readonly identity = Symbol('account-files-owner')
  // Caller-scoped Cordis service proxies share this cell; replacing a service field would shadow it per caller.
  private readonly installation: { work?: Installation } = {}

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
    this.providers = { Registry, createFileSystem: input.createFileSystem, withInstructionReaders: input.withInstructionReaders,
      projectFor: input.projectFor, createProject: input.createProject, assertContentAvailable: input.assertContentAvailable }
    this.checkGraph = checkGraph
    this.unpublished = input.assertUnpublished
    this.assertInstalled()
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
    if (owner.fiber.uid === 0) throw new FilesFailure('files/prerequisite-missing', 'Native files installation requires its account entry fiber.')
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
    if (work?.project === undefined) throw new FilesFailure('files/prerequisite-missing', 'Native account files installation has not completed.')
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
    return result
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
    if (work === undefined || create === undefined) throw new FilesFailure('files/prerequisite-missing', 'Ready project creation is unavailable.')
    this.assertProviders(work)
    const registry = work.entry.ctx.get('workspaceRegistry')
    if (!(registry instanceof this.providers.Registry)) throw new FilesFailure('files/prerequisite-missing', 'The original Registry is unavailable.')
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
    if (!(registry instanceof this.providers.Registry)) throw new FilesFailure('files/prerequisite-missing', 'The native files Registry is absent.')
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
      })
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
