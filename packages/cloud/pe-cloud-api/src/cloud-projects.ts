/** Account-owned project allocation through the original files and Workspace owners. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { Remote, remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceValue } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { CloudAccountApi } from './account-service.ts'
import { CloudApiError } from './errors.ts'
import type { CloudProjectCreateRequest, ExposureInventory } from './types.ts'

/** Trusted allocation callback captures the original AccountUse and files owner; no client paths or grants. */
export interface CloudProjectsPreparation {
  /** Create the directory through files, then register it in the original Workspace Registry. */
  readonly createProject: (title: string | undefined, signal: AbortSignal) => Promise<WorkspaceValue>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Account-fixed project creation Remote; does not replace native workspace/create(path). */
    cloudProjects: CloudProjectsService
  }
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

function projectTitle(request: unknown): string | undefined {
  if (request === null || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'title')) {
    throw new CloudApiError('cloud/invalid-project-title', 'Project creation accepts only an optional display title.')
  }
  const value: unknown = Reflect.get(request, 'title')
  if (value !== undefined && typeof value !== 'string') {
    throw new CloudApiError('cloud/invalid-project-title', 'Project creation accepts only an optional display title.')
  }
  const title = value?.trim()
  if (title !== undefined && (title.length === 0 || new TextEncoder().encode(title).byteLength > 256)) {
    throw new CloudApiError('cloud/invalid-project-title', 'Project title must contain 1 to 256 UTF-8 bytes.')
  }
  return title
}

/** One additive Remote capability; directory allocation and native persistence stay with their owners. */
export class CloudProjectsService extends TypertRemoteService {
  private readonly createProject: CloudProjectsPreparation['createProject']
  private readonly owner: Context

  /**
   * @param ctx Original account preparation scope, never a request-derived Context.
   * @param api Original account API admission and exposure owner.
   * @param input Captured trusted allocator; actual settlement remains joined after cancellation.
   */
  constructor(ctx: Context, private readonly api: CloudAccountApi, input: CloudProjectsPreparation) {
    api.assertInstalled(ctx)
    if (ctx.get('cloudProjects') !== undefined || ctx.root.get('cloudProjects') !== undefined) {
      throw new CloudApiError('cloud/invalid-config', 'The account already has a project creation service.')
    }
    super(ctx, 'cloudProjects', { namespace: 'cloudProjects' })
    this.owner = ctx
    this.createProject = input.createProject
    ctx.effect(() => () => { api.invalidate() }, 'pe-cloud-api: withdraw project creation')
  }

  /**
   * Allocate one project with an optional display title; paths and identities are server-owned.
   * @param request Optional title, trimmed and limited to 256 UTF-8 bytes; explicit blank titles reject before allocation.
   * @param signal Caller cancellation, combined with the captured graph lifetime.
   * @returns The original durable Workspace projection after the allocator settles and admission is rechecked.
   * @throws CloudApiError before allocation for invalid title or unavailable admission; original allocation failures remain unchanged.
   * Cancellation after allocation does not promise rollback. The callback is always awaited; callers must not replay unknown results.
   */
  @Remote('create')
  async create(request: CloudProjectCreateRequest, signal: AbortSignal): Promise<WorkspaceValue> {
    const control = AbortSignal.any([signal, this.api.binding.lifetime])
    control.throwIfAborted()
    this.assertCurrent()
    this.api.requireRpc('cloudProjects/create')
    const title = projectTitle(request)
    const value = await this.createProject(title, control)
    control.throwIfAborted()
    this.assertCurrent()
    this.api.requireRpc('cloudProjects/create')
    return value
  }

  /** Require the exact original service in both local and root lookups; replacement cannot inherit this callback. */
  assertCurrent(): void {
    this.owner.fiber.assertActive()
    this.api.assertInstalled(this.owner)
    if (original(this.owner.get('cloudProjects') ?? {}) !== original(this)
      || original(this.owner.root.get('cloudProjects') ?? {}) !== original(this)) {
      throw new CloudApiError('cloud/account-unavailable', 'The original project creation service is unavailable.')
    }
  }

  /**
   * Inspect the actual Remote marker and installed service for the API's bounded native inventory.
   * @returns Exactly the guarded project-creation endpoint; does not publish readiness.
   */
  inspect(): ExposureInventory {
    this.assertCurrent()
    const binding = this.typertRemote, markers = remoteMethods(this)
    if (binding.service !== original(this) || binding.serviceKey !== 'cloudProjects' || binding.namespace !== 'cloudProjects'
      || markers.length !== 1 || markers[0]?.method !== 'create' || (markers[0].exportName ?? 'create') !== 'create'
      || (markers[0].mode ?? 'rpc') !== 'rpc' || Reflect.get(original(this), 'create') !== CloudProjectsService.prototype.create) {
      throw new CloudApiError('cloud/account-unavailable', 'Project creation requires its original Remote registration.')
    }
    return { recipeVersion: this.api.binding.recipeVersion,
      rpcEndpoints: [{ endpoint: 'cloudProjects/create', handlerId: 'native:cloudProjects', guard: 'authenticated-account' }],
      streamEndpoints: [], exactFetchRoutes: [] }
  }
}
