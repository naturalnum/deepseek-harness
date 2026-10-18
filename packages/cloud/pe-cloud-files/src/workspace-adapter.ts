/** Graph-lived Workspace metadata with unpublished-only registration; native business/persistence remains native-owned. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import WorkspaceRegistry, { WorkspaceDirectoryMetadataError } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceDirectoryMetadata } from '@deepseek-ai/dsh-workspace'
import type { DirectoryReadPort } from './directory.ts'
import type { IsolatedLeafGrant, PreparedLeafPort } from './worker-pool.ts'
import type { DirectoryCreatedIdentity, DirectoryResponsibility } from './directory-responsibility.ts'
import { DirectoryMetadataFailure } from './directory-error.ts'
import { DirectoryPreparationFailure } from './leaf-frame.ts'

/** Native service plus the private server-candidate entry; not re-exported by package entrypoints. */
export interface ControlledWorkspaceRegistry extends WorkspaceRegistry {
  /**
   * Register one fixed server candidate; uncertain registration retains temporary ownership.
   * @param grant Trusted once-selected leaf and original namespace window.
   * @param title Native display title, independent of the leaf.
   * @returns Actual durable native Workspace after private ownership transfer.
   */
  createProject(grant: IsolatedLeafGrant, title?: string): Promise<Workspace>
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
}

/** Existing same-lane reads and the separate unpublished registration window. */
export interface WorkspaceAdapterBackend {
  readonly directory: DirectoryReadPort
  readonly defaultGrant: IsolatedLeafGrant
  assertCurrent(): void
  assertWindow(): void
  prepareDefault(): ReturnType<PreparedLeafPort['prepare']>
  prepareRegistration(grant: IsolatedLeafGrant): WorkspacePreparation
  identity(record: DirectoryResponsibility): Promise<DirectoryCreatedIdentity>
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

  const assertInstallation = (ctx: Context): void => {
    backend.assertWindow()
    if (ctx.get('peAccount') !== backend.defaultGrant.binding
      || ctx.root.get('peAccount') !== backend.defaultGrant.binding || ctx.fiber.uid === null) throw unavailable()
  }
  return class BoundWorkspaceRegistry extends WorkspaceRegistry {
    constructor(ctx: Context) {
      assertInstallation(ctx)
      super(ctx)
    }

    protected override createDirectoryMetadata(): WorkspaceDirectoryMetadata {
      assertInstallation(this.ctx)
      return provider
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
          captured.record.rememberRegistrationIdentity(await backend.identity(captured.record))
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
        captured.record.rememberRegistrationIdentity(await backend.identity(captured.record))
        captured.assertWindow()
        const result = await super.create(captured.work.control.expose(), title)
        await this.finishRegistration(captured, result)
        return result
      } catch (error) {
        prepared?.record.registrationFailed()
        throw error
      } finally { prepared = undefined }
    }

    private async finishRegistration(prepared: WorkspacePreparation, result: Workspace): Promise<void> {
      prepared.assertWindow()
      const path = prepared.record.intent.parent.rootPath
      const canonical = await metadata(() => backend.directory.canonicalPath(`${path === '/' ? '' : path}/${prepared.record.intent.leaf}`))
      const identity = await backend.identity(prepared.record)
      prepared.assertWindow()
      prepared.record.transferRegistered(this, result, canonical, identity)
    }
  }
}
