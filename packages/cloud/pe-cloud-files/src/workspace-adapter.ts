/** Graph-lived Workspace metadata and private registration windows; native persistence remains Registry-owned. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import WorkspaceRegistry, { WorkspaceDirectoryMetadataError } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceDirectoryMetadata } from '@deepseek-ai/dsh-workspace'
import type { DirectoryReadPort } from './directory.ts'
import type { IsolatedLeafGrant, PreparedLeafPort } from './worker-pool.ts'
import type { DirectoryCreatedIdentity, DirectoryResponsibility } from './directory-responsibility.ts'
import { DirectoryMetadataFailure } from './directory-error.ts'
import type { S2ProjectPort } from './s2-project.ts'
import { DirectoryPreparationFailure } from './leaf-frame.ts'
import type { AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Native service plus the private server-candidate entry; not re-exported by package entrypoints. */
export interface ControlledWorkspaceRegistry extends WorkspaceRegistry {
  /**
   * Register one fixed server candidate; uncertain registration retains temporary ownership.
   * @param grant Trusted once-selected leaf and original namespace window.
   * @param title Native display title, independent of the leaf.
   * @returns Actual durable native Workspace after private ownership transfer.
   */
  createProject(grant: IsolatedLeafGrant, title?: string): Promise<Workspace>
  /**
   * Register a lease-issued UUID during one actual ready borrow; keep its responsibility until native settlement.
   * @param use Original ready borrow, retained by its caller through the actual returned Promise.
   * @param grant Lease-issued fixed UUID and original protected projects parent.
   * @param title Bounded native display title; never selects a disk address.
   * @param signal Admission cancellation; started work remains with the original lane.
   * @returns Actual durable native Workspace after private responsibility transfer; unknown failures retain responsibility.
   */
  createAdmittedProject(use: AccountUse, grant: IsolatedLeafGrant, title: string | undefined, signal: AbortSignal): Promise<Workspace>
  /**
   * Obtain a fixed S2 scope from the actual native default result; no path argument grants a project.
   * @returns Same-lane native FS constructor and existing-project directory validation.
   */
  createS2Project(): Promise<S2ProjectPort>
}

/** Explicit constructor shape keeps inherited native private fields out of anonymous declarations. */
export interface ControlledWorkspaceRegistryConstructor {
  new(ctx: Context): ControlledWorkspaceRegistry
  readonly inject: readonly string[]
}

/** Private captured ticket; no caller-constructed registration receipt or approval bit. */
export interface WorkspacePreparation {
  readonly work: ReturnType<PreparedLeafPort['prepare']>
  readonly record: DirectoryResponsibility
  assertWindow(): void
  readIdentity(): Promise<DirectoryCreatedIdentity>
}

/** Existing same-lane reads and the separate unpublished registration window. */
export interface WorkspaceAdapterBackend {
  readonly directory: DirectoryReadPort
  readonly defaultGrant: IsolatedLeafGrant
  assertCurrent(): void
  assertWindow(): void
  prepareDefault(): ReturnType<PreparedLeafPort['prepare']>
  prepareRegistration(grant: IsolatedLeafGrant): WorkspacePreparation
  prepareAdmittedRegistration(grant: IsolatedLeafGrant, use: AccountUse, title: string | undefined): WorkspacePreparation
  project(workspace: Workspace, assertCurrent: () => void, assertInstalled: (ctx: Context) => void): Promise<S2ProjectPort>
}

function unavailable(cause?: unknown): WorkspaceDirectoryMetadataError {
  return new WorkspaceDirectoryMetadataError('unavailable', { cause })
}

async function metadata<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (cause) {
    if (cause instanceof WorkspaceDirectoryMetadataError) throw cause
    const reason = cause instanceof DirectoryMetadataFailure ? cause.reason
      : cause instanceof DirectoryPreparationFailure && cause.fact === 'not-created' && cause.details.errno === 20
        ? 'not-directory' : 'unavailable'
    throw new WorkspaceDirectoryMetadataError(reason, { cause })
  }
}

/**
 * Construct one graph-fixed native subclass with complete metadata and private registration ownership.
 * @param backend Existing bound lane, current graph and separate registration window; no production issuer is created.
 * @returns Native Registry subclass; default resolver policy changes, native queues and durable writes do not.
 */
export function createBoundWorkspaceRegistry(backend: WorkspaceAdapterBackend): ControlledWorkspaceRegistryConstructor {
  backend.assertWindow()
  const parent = backend.defaultGrant.parent.rootPath
  const defaultPath = `${parent === '/' ? '' : parent}/${backend.defaultGrant.leaf}`
  if (backend.defaultGrant.leaf !== 'default-workspace') throw unavailable()
  const provider: WorkspaceDirectoryMetadata = Object.freeze({
    canonicalPath: (path: string) => metadata(async () => {
      backend.assertCurrent()
      const result = await backend.directory.canonicalPath(path)
      backend.assertCurrent()
      return result
    }),
    isDirectory: (path: string) => metadata(async () => {
      backend.assertCurrent()
      const result = await backend.directory.isDirectory(path)
      backend.assertCurrent()
      return result
    }),
    ensureDirectory: (path: string) => metadata(async () => {
      backend.assertWindow()
      if (path !== defaultPath) throw unavailable()
      const prepared = backend.prepareDefault()
      await prepared.observation.waitPrepared()
      backend.assertWindow()
    }),
  })

  const assertBinding = (ctx: Context): void => {
    backend.assertCurrent()
    if (ctx.get('peAccount') !== backend.defaultGrant.binding
      || ctx.root.get('peAccount') !== backend.defaultGrant.binding || ctx.fiber.uid === null) throw unavailable()
  }
  const assertInstallation = (ctx: Context): void => { assertBinding(ctx); backend.assertWindow() }
  return class BoundWorkspaceRegistry extends WorkspaceRegistry {
    private readonly identity = Symbol('bound-workspace-registry')
    constructor(ctx: Context) {
      assertInstallation(ctx)
      super(ctx)
    }

    protected override createDirectoryMetadata(): WorkspaceDirectoryMetadata {
      assertInstallation(this.ctx)
      return provider
    }

    override async create(path: string, _title?: string): Promise<Workspace> {
      assertBinding(this.ctx)
      const existing = await super.resolveByPath(path)
      assertBinding(this.ctx)
      if (existing === undefined || this.get(existing.id) !== existing || !this.list().includes(existing)) throw unavailable()
      return existing
    }

    override async initializeDefault(_resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
      let prepared: WorkspacePreparation | undefined
      try {
        backend.assertCurrent()
        const result = await super.initializeDefault(async () => {
          backend.assertWindow()
          const captured = backend.prepareRegistration(backend.defaultGrant)
          prepared = captured
          await metadata(() => captured.work.observation.waitPrepared())
          captured.assertWindow()
          captured.record.rememberRegistrationIdentity(await captured.readIdentity())
          captured.assertWindow()
          return captured.work.control.expose()
        })
        backend.assertCurrent()
        if (prepared !== undefined) {
          if (result === undefined) prepared.record.registrationFailed()
          else await this.finishRegistration(prepared, result)
        }
        return result
      } catch (error) {
        prepared?.record.registrationFailed()
        throw error
      } finally { prepared = undefined }
    }

    /**
     * Prepare one server-selected UUID candidate, then use the real public native create result.
     * @param grant Once-selected candidate from the trusted fixture, never a client path/title-derived grant.
     * @param title Native display title; it never selects a disk name.
     * @returns The actual durable native Workspace after private responsibility transfer.
     */
    async createProject(grant: IsolatedLeafGrant, title?: string): Promise<Workspace> {
      let prepared: WorkspacePreparation | undefined
      try {
        backend.assertWindow()
        if (grant.leaf === 'default-workspace') throw unavailable()
        const captured = backend.prepareRegistration(grant)
        prepared = captured
        await metadata(() => captured.work.observation.waitPrepared())
        captured.assertWindow()
        captured.record.rememberRegistrationIdentity(await captured.readIdentity())
        captured.assertWindow()
        const result = await super.create(captured.work.control.expose(), title)
        await this.finishRegistration(captured, result)
        return result
      } catch (error) {
        prepared?.record.registrationFailed()
        throw error
      } finally { prepared = undefined }
    }

    async createAdmittedProject(
      use: AccountUse, grant: IsolatedLeafGrant, title: string | undefined, signal: AbortSignal,
    ): Promise<Workspace> {
      signal.throwIfAborted()
      assertBinding(this.ctx)
      use.assertCurrent()
      const active = use.context.get('workspaceRegistry')
      if (use.binding !== backend.defaultGrant.binding || use.context.root !== this.ctx.root
        || !(active instanceof BoundWorkspaceRegistry) || active.identity !== this.identity
        || grant.binding !== use.binding || grant.leaf === 'default-workspace') throw unavailable()
      let prepared: WorkspacePreparation | undefined
      try {
        const captured = backend.prepareAdmittedRegistration(grant, use, title)
        prepared = captured
        // Caller cancellation after admission never abandons the original native mutation Promise.
        await metadata(() => captured.work.observation.waitPrepared())
        captured.assertWindow()
        captured.record.rememberRegistrationIdentity(await captured.readIdentity())
        captured.assertWindow()
        const result = await super.create(captured.work.control.expose(), title)
        await this.finishRegistration(captured, result)
        return result
      } catch (error) {
        prepared?.record.registrationFailed()
        throw error
      } finally { prepared = undefined }
    }

    async createS2Project(): Promise<S2ProjectPort> {
      assertBinding(this.ctx)
      const workspace = await this.initializeDefault(() => Promise.resolve(defaultPath))
      if (workspace === undefined || workspace.path !== defaultPath || this.get(workspace.id) !== workspace) throw unavailable()
      const assertCurrent = (): void => {
        assertBinding(this.ctx)
        if (this.get(workspace.id) !== workspace || workspace.path !== defaultPath) throw unavailable()
      }
      return await backend.project(workspace, assertCurrent, (ctx) => {
        assertCurrent()
        if (ctx.root !== this.ctx.root) throw unavailable()
        assertBinding(ctx)
      })
    }

    private async finishRegistration(prepared: WorkspacePreparation, result: Workspace): Promise<void> {
      prepared.assertWindow()
      const path = prepared.record.intent.parent.rootPath
      const canonical = await metadata(() => backend.directory.canonicalPath(`${path === '/' ? '' : path}/${prepared.record.intent.leaf}`))
      const identity = await prepared.readIdentity()
      prepared.assertWindow()
      prepared.record.transferRegistered(this, result, canonical, identity)
    }
  }
}
