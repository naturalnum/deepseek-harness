/** Independent skill Remote using the existing exact Peer/Use carrier and account save owner. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { Remote, remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import type { CloudAccountApi } from './account-service.ts'
import type { ModelKeyPeerConsumer } from './cloud-model-key.ts'
import type { ConfigSaveBarrier } from './save-hooks.ts'
import { AccountManagedSkills } from './managed-skill-publication.ts'
import { managedSkillApiLimits, managedSkillCodecs } from './managed-skill-json.ts'
import type { ManagedSkillPreparation } from './managed-skill-source.ts'
import type { ManagedSkillsInstalledRequest, ManagedSkillsInstalled, ManagedSkillDetailsRequest, ManagedSkillDetails,
  ManagedSkillInstallRequest, ManagedSkillUpdateRequest, ManagedSkillUninstallRequest, ManagedSkillMutationResult,
  ManagedSkillDownloadRequest, ManagedSkillDownload } from './managed-skill-types.ts'
import { skillCodecs, skillPublicationLimits } from './skill-json.ts'
import type { ExposureInventory } from './types.ts'
import type { SkillCurrentRequest, SkillCurrentState, SkillPublicationLimits, SkillPublishRequest, SkillPublishResult } from './skill-types.ts'
import { CloudApiError } from './errors.ts'
import type { SkillResourcePreparation } from './skill-source.ts'

/** Trusted assembly only. The existing login consumer's historical name remains unchanged. */
export interface CloudSkillPreparation extends ModelKeyPeerConsumer {
  readonly files: CloudAccountFiles
  readonly limits: SkillPublicationLimits
  readonly resources?: SkillResourcePreparation
  readonly managed: ManagedSkillPreparation
}
declare module '@deepseek-ai/cordis' { interface Context { cloudSkills: CloudSkillService } }
const methods = ['current', 'publish', 'installed', 'details', 'install', 'update', 'uninstall', 'download'] as const
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The original skill capability is unavailable.') }

/** One concrete business capability; it registers no additional persistence or lifecycle owner. */
export class CloudSkillService extends TypertRemoteService {
  private readonly publication: AccountManagedSkills
  private readonly managedCodecs: ReturnType<typeof managedSkillCodecs>
  private readonly codecs: ReturnType<typeof skillCodecs>
  private readonly owner: Context
  private readonly files: CloudAccountFiles
  private readonly registry: SkillRegistry

  constructor(ctx: Context, private readonly api: CloudAccountApi, private readonly input: CloudSkillPreparation,
    saves: ConfigSaveBarrier) {
    api.assertInstalled(ctx)
    const scopedRegistry = ctx.get('skills')
    const registry: unknown = scopedRegistry === undefined ? undefined : Reflect.get(scopedRegistry, symbols.original) ?? scopedRegistry
    const managed: unknown = input.managed
    if (managed === undefined || ctx.get('cloudSkills') !== undefined || ctx.root.get('cloudSkills') !== undefined
      || !(input.files instanceof CloudAccountFiles) || input.files.binding !== api.binding || saves.binding !== api.binding
      || !(scopedRegistry instanceof SkillRegistry) || !(registry instanceof SkillRegistry)) unavailable()
    input.files.assertInstalled(ctx)
    super(ctx, 'cloudSkills', { namespace: 'cloudSkills' })
    this.owner = ctx; this.files = input.files; this.registry = registry
    this.codecs = skillCodecs(skillPublicationLimits(input.limits))
    this.managedCodecs = managedSkillCodecs(managedSkillApiLimits(input.managed.limits))
    let publication: AccountManagedSkills | undefined
    scopedRegistry.registerProvider((control) => {
      const legacy = this.files.skillVersions()
      publication = new AccountManagedSkills(ctx, control, saves, this.files, legacy, scopedRegistry,
        input.managed, input.limits, input.resources)
      return publication
    })
    if (publication === undefined) unavailable()
    this.publication = publication
    ctx.effect(() => () => { api.invalidate() }, 'pe-cloud-api: withdraw skill capability')
  }

  /** Reconstruct the current catalog during trusted assembly.
   * @returns Actual cold-pointer restore; Root calls before opening business admission.
   */
  restore(): Promise<void> { return this.publication.restore(() => { this.assertCurrent() }) }

  /**
   * Read this account's actual fixed pointer, without activating an Agent or creating a sandbox.
   * @param request Fixed sample slot only.
   * @param signal Original observer cancellation.
   * @returns Actual durable metadata and opaque edit token; no resource path.
   */
  @Remote('current')
  current(request: SkillCurrentRequest, signal: AbortSignal): Promise<SkillCurrentState> {
    return this.consume('current', request, signal, check => this.publication.current(check, signal))
  }

  /**
   * Publish exactly two complete files through actual native pointer CAS in the original save turn.
   * @param request Fixed slot, opaque edit and bounded complete file fields.
   * @param signal Cancellation cannot discard a confirmed native pointer handoff.
   * @returns Separate persistence/catalog application and optional per-load resource preparation capability.
   */
  @Remote('publish')
  publish(request: SkillPublishRequest, signal: AbortSignal): Promise<SkillPublishResult> {
    return this.consume('publish', request, signal, (check, raw) => {
      const input = this.codecs.publish.create().parse(raw)
      const owned = Uint8Array.from(Buffer.from(input.resourceBase64, 'base64'))
      return this.publication.publish(input.version, input.skillMarkdown, owned, check, signal)
    })
  }

  /**
   * List installed skills with their native selection and precedence metadata.
   * @param request Optional original workspace selector.
   * @param signal Observer cancellation.
   * @returns Complete installed catalog and one catalog edit token.
   */
  @Remote('installed')
  installed(request: ManagedSkillsInstalledRequest, signal: AbortSignal): Promise<ManagedSkillsInstalled> {
    return this.consume('installed', request, signal, (check, raw) => this.publication.installed(this.managedCodecs.installed.create().parse(raw), check, signal))
  }

  /**
   * Read one installed skill's native metadata and complete file inventory.
   * @param request Original installation id.
   * @param signal Observer cancellation.
   * @returns Complete native and file metadata.
   */
  @Remote('details')
  details(request: ManagedSkillDetailsRequest, signal: AbortSignal): Promise<ManagedSkillDetails> {
    return this.consume('details', request, signal, (check, raw) => this.publication.details(this.managedCodecs.details.create().parse(raw).skillId, check, signal))
  }

  /**
   * Install a complete skill package through the original save turn and catalog CAS.
   * @param request Complete package and catalog edit token.
   * @param signal Cancellation cannot discard a confirmed catalog handoff.
   * @returns Persistence and native application facts.
   */
  @Remote('install')
  install(request: ManagedSkillInstallRequest, signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    return this.consume('install', request, signal, (check, raw) => {
      const input = this.managedCodecs.install.create().parse(raw)
      return this.publication.install(input.version, input.bundle, check, signal)
    })
  }

  /**
   * Replace one installation's complete package through the original catalog CAS.
   * @param request Complete replacement and catalog edit token.
   * @param signal Cancellation cannot discard a confirmed catalog handoff.
   * @returns Persistence and native application facts.
   */
  @Remote('update')
  update(request: ManagedSkillUpdateRequest, signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    return this.consume('update', request, signal, (check, raw) => {
      const input = this.managedCodecs.update.create().parse(raw)
      return this.publication.update(input.skillId, input.version, input.bundle, check, signal)
    })
  }

  /**
   * Remove one installation from future native discovery and loading.
   * @param request Original installation and catalog edit token.
   * @param signal Cancellation cannot discard a confirmed catalog handoff.
   * @returns Durable removal and native application facts.
   */
  @Remote('uninstall')
  uninstall(request: ManagedSkillUninstallRequest, signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    return this.consume('uninstall', request, signal, (check, raw) => {
      const input = this.managedCodecs.uninstall.create().parse(raw)
      return this.publication.uninstall(input.skillId, input.version, check, signal)
    })
  }

  /**
   * Export the complete authorized files of one installed skill as a ZIP archive.
   * @param request Exact installed content selectors.
   * @param signal Observer cancellation.
   * @returns Complete authorized ZIP.
   */
  @Remote('download')
  download(request: ManagedSkillDownloadRequest, signal: AbortSignal): Promise<ManagedSkillDownload> {
    return this.consume('download', request, signal, (check, raw) => this.publication.download(this.managedCodecs.download.create().parse(raw), check, signal))
  }

  /** Inspect actual native registration rather than a configured availability flag.
   * @returns Exact unary inventory.
   */
  inspect(): ExposureInventory {
    this.assertCurrent()
    const registered = this.typertRemote, markers = remoteMethods(this), typert = this.owner.get('typert')
    if (registered.service !== original(this) || registered.namespace !== 'cloudSkills'
      || registered.serviceKey !== 'cloudSkills' || markers.length !== methods.length || typert === undefined) unavailable()
    for (const method of methods) {
      const marker = markers.find(value => value.method === method), descriptor = typert.local.get(`cloudSkills/${method}`)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(original(this), method) !== CloudSkillService.prototype[method]
        || descriptor === undefined || descriptor.service !== 'cloudSkills' || descriptor.namespace !== 'cloudSkills'
        || descriptor.method !== method || (descriptor.implementation ?? method) !== method || (descriptor.mode ?? 'rpc') !== 'rpc'
        || descriptor.invocation.kind !== 'direct' || descriptor.parameters.length !== 1
        || descriptor.parameters[0]?.wire !== 'request' || descriptor.parameters[0].source !== 'json'
        || descriptor.parameters[0].codec.mode !== 'strict' || descriptor.result.mode !== 'strict'
        || descriptor.cancellation?.parameter !== 'signal') unavailable()
    }
    return { recipeVersion: this.api.binding.recipeVersion, rpcEndpoints: methods.map(method =>
      ({ endpoint: `cloudSkills/${method}`, handlerId: 'native:cloudSkills', guard: 'authenticated-account' })),
    streamEndpoints: [], exactFetchRoutes: [] }
  }

  /** Require this exact installed account service and files binding; does not grant public readiness. */
  assertCurrent(): void {
    this.owner.fiber.assertActive(); this.api.assertInstalled(this.owner); this.files.assertInstalled(this.owner)
    if (this.files.binding !== this.api.binding
      || original(this.owner.get('cloudSkills') ?? {}) !== original(this)
      || original(this.owner.root.get('cloudSkills') ?? {}) !== original(this)
      || original(this.owner.get('skills') ?? {}) !== original(this.registry)) unavailable()
  }

  private consume<T>(method: typeof methods[number], _request: object, signal: AbortSignal,
    submit: (check: () => void, raw: unknown) => Promise<T>): Promise<T> {
    signal.throwIfAborted(); this.inspect(); this.api.requireRpc(`cloudSkills/${method}`)
    const invocation = this.ctx.invocation
    if (invocation?.service !== 'cloudSkills'
      || invocation.request.namespace !== 'cloudSkills' || invocation.request.method !== method) unavailable()
    const raw = invocation.request.args.request
    if (method === 'current' || method === 'publish') this.codecs[method].create().parse(raw)
    else this.managedCodecs[method].create().parse(raw)
    // This complete original ingress method is generic over its consume operation; do not invent another Peer owner.
    return this.input.withModelKeyPeerUse(invocation.peer, async (use, current) => {
      const check = (): void => {
        signal.throwIfAborted(); current(); use.assertCurrent(); this.assertCurrent()
        if (use.binding !== this.api.binding || use.context.root !== this.owner.root) unavailable()
        this.api.assertInstalled(use.context); this.api.requireRpc(`cloudSkills/${method}`)
      }
      check()
      const result = await submit(check, raw)
      current(); use.assertCurrent() // Observer cancellation cannot roll back or replay a confirmed publication.
      return result
    })
  }
}
