import { approvedSettingsMatch } from './approved-settings.ts'
/** Graph-owned API preparation and native providers consumed by trusted runtime assembly. */
import { Context, FiberState, Service, symbols, type Fiber } from '@deepseek-ai/cordis'
import type AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import type WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import type { AccountBinding, AccountUse, SubagentCapacityReservation } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { prepareAccountApiInstall, type AccountApiInstall } from './account-install.ts'
import { CloudApiError } from './errors.ts'
import { bindModelKeyAccess, type ModelKeyAccess } from './model-key.ts'
import { CloudSkillService, type CloudSkillPreparation } from './cloud-skills.ts'
import { CloudModelKeyService, type CloudModelKeyPreparation } from './cloud-model-key.ts'
import { CloudProjectsService, type CloudProjectsPreparation } from './cloud-projects.ts'
import { createNativeWorkspaceFiles, type NativeWorkspaceFiles } from './native-files.ts'
import { createNativeUploads, type NativeUploads, type NativeUploadPreparation } from './native-uploads.ts'
import { FILE_UPLOAD_PATH, type FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { prepareNativeFirstScreen, type FirstScreenNativeInput, type NativeFirstScreen } from './native-first-screen.ts'
import { registerFirstScreenEvents, type FirstScreenEventInput, type FirstScreenEvents } from './first-screen-events.ts'
import type { ExposurePolicy } from './exposure.ts'
import { installActualLlmGuard } from './llm-guard.ts'
import { createNativeAgentLoop, type NativeAgentFactoryGuards } from './native-agent-factory.ts'
import { createNativeController, inspectNativeController, type NativeSessionGuards } from './native.ts'
import { AccountPluginControl, type CloudPluginPreparation } from './plugin-control.ts'
import { CloudPluginService } from './cloud-plugins.ts'
import type { PluginRebuildIntent, PluginRebuildPersistence, PluginRebuildVerification } from './plugin-types.ts'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import type { ConfigSaveBarrier, ConfigSaveReceipt } from './save-hooks.ts'
import type { ApprovedModelKeyConfiguration, EndpointExposure, ExactFetchExposure, ExposureInventory, ExposureManifest } from './types.ts'

/** Trusted graph preparation inputs; no field is accepted from Loader JSON or an HTTP borrow. */
export interface AccountApiPreparation {
  readonly binding: AccountBinding
  readonly rootExposure: ExposurePolicy
  readonly selected: ExposureManifest
  readonly saves: ConfigSaveBarrier
  /** Explicit Root-approved optional native plugin control; absence grants no manager mutation. */
  readonly plugins?: CloudPluginPreparation
  /** Require the exact installed preparation/current graph, independently of business publication. */
  readonly assertMountCurrent: (binding: AccountBinding) => void
  /** Require the original graph's actual business-ready publication on every dispatch. */
  readonly assertBusinessCurrent: (binding: AccountBinding) => void
  /** Read the original shared project/Preset/default-model policy; absence keeps bootstrap assertions closed. */
  readonly assertBootstrapCurrent?: (signal: AbortSignal) => Promise<void>
  /**
   * Recheck original Root registration; trusted assembly only, never Loader/client input.
   * @returns Actual exact Fetch routes within maxNativeInventoryEntries after original registration checks.
   */
  readonly inspectRootFetch?: () => readonly ExactFetchExposure[]
  /** Positive finite bound shared by visited native runtimes/fibers, selected exposures and actual Root routes; no default. */
  readonly maxNativeInventoryEntries?: number
  /** Factory-owned unpublished mounting window; required only by prepared native auditing. */
  readonly assertUnpublished?: () => void
  /** Original factory's nonterminal exclusive local-update window; absence keeps local re-audit closed. */
  readonly assertReconfiguring?: () => void
  /** Private startup phase observation; exceptions never affect native auditing or publication. */
  readonly observeStartupPhase?: (phase: 'audit-provider' | 'bootstrap-policy' | 'nativeinventory') => void
}

type NativeKey = 'sessionController' | 'agentLoop' | 'llm'
interface NativeInstallation { readonly value: object; readonly fiber: Fiber }

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prepared account API owner; presence alone does not establish account readiness. */
    peCloudApi: CloudAccountApi
  }
}

/** One account's API providers and save controls; runtime retains assembly and drain ownership. */
export class CloudAccountApi extends Service {
  /** Exact runtime-installed graph binding; presence does not publish business readiness. */
  readonly binding: AccountBinding
  /** Native constructors fixed before their Loader activation, using this graph's existing save hooks. */
  readonly providers: Readonly<Pick<AccountApiInstall, 'configEditor' | 'credentials'> & { readonly pluginManager?: typeof PluginManager }>
  private readonly installation: AccountApiInstall
  private readonly saves: ConfigSaveBarrier
  private readonly mountCurrent: AccountApiPreparation['assertMountCurrent']
  private readonly businessCurrent: AccountApiPreparation['assertBusinessCurrent']
  private readonly rootFetch: AccountApiPreparation['inspectRootFetch']
  private readonly bootstrapCurrent: AccountApiPreparation['assertBootstrapCurrent']
  private readonly maxNativeInventoryEntries: AccountApiPreparation['maxNativeInventoryEntries']
  private readonly unpublished: AccountApiPreparation['assertUnpublished']
  private readonly reconfiguring: AccountApiPreparation['assertReconfiguring']
  private readonly startupPhase: AccountApiPreparation['observeStartupPhase']
  // These cells retain original installations across caller-scoped Cordis proxies.
  private readonly native: Partial<Record<NativeKey, NativeInstallation>> = {}
  private readonly streamGuard: { dispose?: () => void } = {}
  private readonly firstScreen: { native?: NativeFirstScreen; events?: FirstScreenEvents } = {}
  private readonly modelKey: { native?: CloudModelKeyService } = {}
  private readonly skills: { native?: CloudSkillService } = {}
  private readonly plugins: { control?: AccountPluginControl; native?: CloudPluginService } = {}
  private readonly projects: { native?: CloudProjectsService } = {}
  private readonly files: { native?: NativeWorkspaceFiles } = {}
  private readonly uploads: { native?: NativeUploads } = {}
  // Cordis traces services through caller-scoped proxies; their object identities differ.
  private readonly identity = Symbol('account-api-owner')

  /**
   * Prepare the graph before its native Include activates; this does not audit handlers or publish ready.
   * @param ctx Runtime's independent account prepare scope, with its canonical binding and Loader installed.
   * @param input Runtime-owned mount/business admission, deployment exposure and exact save barrier.
   */
  constructor(ctx: Context, input: AccountApiPreparation) {
    if (ctx.get('peCloudApi') !== undefined || ctx.root.get('peCloudApi') !== undefined) {
      throw new CloudApiError('cloud/invalid-config', 'The account graph already has an API owner.')
    }
    input.assertMountCurrent(input.binding)
    const installation = prepareAccountApiInstall(
      ctx, input.binding, input.assertMountCurrent, input.rootExposure, input.selected, input.saves,
    )
    super(ctx, 'peCloudApi')
    this.binding = input.binding
    this.mountCurrent = input.assertMountCurrent
    this.businessCurrent = input.assertBusinessCurrent
    this.rootFetch = input.inspectRootFetch
    this.bootstrapCurrent = input.assertBootstrapCurrent
    this.maxNativeInventoryEntries = input.maxNativeInventoryEntries
    this.unpublished = input.assertUnpublished
    this.reconfiguring = input.assertReconfiguring
    this.startupPhase = input.observeStartupPhase
    this.installation = installation
    this.saves = input.saves
    const plugins = input.plugins === undefined ? undefined
      : new AccountPluginControl(ctx, input.saves, input.plugins, () => { this.assertInstalled() })
    if (plugins !== undefined) this.plugins.control = plugins
    this.providers = Object.freeze({ configEditor: installation.configEditor, credentials: installation.credentials,
      ...plugins === undefined ? {} : { pluginManager: plugins.provider } })
    this.assertInstalled()
  }

  /**
   * Require this exact service and binding without granting business admission.
   * @param owner Native Loader scope; omitted checks the API owner's own scope.
   */
  assertInstalled(owner: Context = this.ctx): void {
    this.assertOwner(owner)
    this.mountCurrent(this.binding)
    this.assertOwner(owner)
  }

  /**
   * Check original native installations and the shared policy without creating or writing business resources.
   * Mount/business admission and native ownership are checked around the awaited policy metadata read.
   * Selected exposure rows and visited runtimes/fibers share the explicit preparation budget; missing or exceeded budgets reject.
   * @param owner Actual consumer scope in this account graph.
   * @param signal Optional observer cancellation, combined with the original graph lifetime.
   * @returns Original synchronous native/admission recheck for final transfer; no readiness token, catalog or account authority is issued.
   * @throws CloudApiError for absent policy, removed/replaced native installations or closed admission;
   * policy failures and cancellation retain their original identity.
   */
  async assertBootstrapCurrent(owner: Context, signal?: AbortSignal): Promise<() => void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    this.assertInstalled(owner)
    this.admit()
    const check = this.bootstrapCurrent
    if (check === undefined) this.nativeUnavailable()
    this.assertNativeCurrent(owner)
    await check(control)
    control.throwIfAborted()
    this.assertInstalled(owner)
    this.admit()
    this.assertNativeCurrent(owner)
    return () => {
      control.throwIfAborted()
      this.assertInstalled(owner)
      this.admit()
      this.assertNativeCurrent(owner)
    }
  }

  /**
   * Audit actual native handlers while the original factory still owns unpublished assembly.
   * This requires mounting authority rather than business-ready admission and publishes no account.
   * @param owner Actual consumer scope in this original graph.
   * @param signal Optional observer cancellation, combined with the graph lifetime.
   * @returns Settlement after original policy/provider checks and the actual handler inventory audit.
   * @throws CloudApiError without the original unpublished callback, native owners or bounded policy;
   * original policy/cancellation failures retain identity.
   */
  async auditPrepared(owner: Context, signal?: AbortSignal): Promise<void> {
    return this.auditNative(owner, this.unpublished, signal)
  }

  /** Re-audit the original inventory under the factory's same-generation exclusive update window.
   * @param owner Same native account root; no replacement graph is accepted.
   * @returns Actual original policy/provider/handler audit; grants no business admission.
   */
  auditReconfigured(owner: Context): Promise<void> { return this.auditNative(owner, this.reconfiguring) }

  private async auditNative(owner: Context, assertWindow: (() => void) | undefined, signal?: AbortSignal): Promise<void> {
    this.observePreparedPhase('nativeinventory')
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    const current = (): void => {
      control.throwIfAborted()
      this.assertInstalled(owner)
      if (assertWindow === undefined) this.nativeUnavailable()
      assertWindow()
      this.assertInstalled(owner)
    }
    current()
    this.installation.exposure.invalidate()
    const check = this.bootstrapCurrent, gateway = owner.get('typertGateway')
    if (check === undefined || !(gateway instanceof TypertGateway)
      || original(owner.root.get('typertGateway') ?? {}) !== original(gateway)) this.nativeUnavailable()
    this.assertNativeCurrent(owner, false)
    this.observePreparedPhase('audit-provider')
    await this.modelKey.native?.auditProvider()
    this.observePreparedPhase('bootstrap-policy')
    await check(control)
    this.observePreparedPhase('nativeinventory')
    current()
    if (original(owner.get('typertGateway') ?? {}) !== original(gateway)) this.nativeUnavailable()
    this.assertNativeCurrent(owner, false)
    const installed = this.native.sessionController, maximum = this.maxNativeInventoryEntries
    if (installed === undefined || maximum === undefined) this.nativeUnavailable()
    const controller = owner.get('sessionController')
    if (controller === undefined || original(controller) !== installed.value) this.nativeUnavailable()
    const sessionInventory = inspectNativeController(controller, this.binding.recipeVersion, maximum)
    const firstScreen = this.firstScreen.native?.inspect()
    const events = this.firstScreen.events?.inspect()
    const modelKey = this.modelKey.native?.inspect()
    const skills = this.skills.native?.inspect()
    const plugins = this.plugins.native?.inspect()
    const projects = this.projects.native?.inspect()
    const files = this.files.native?.inspect()
    const fetch = this.inspectFetchRoutes()
    const inventory: ExposureInventory = {
      recipeVersion: this.binding.recipeVersion,
      rpcEndpoints: [...sessionInventory.rpcEndpoints, ...firstScreen?.rpcEndpoints ?? [], ...projects?.rpcEndpoints ?? [],
        ...files?.rpcEndpoints ?? [], ...modelKey?.rpcEndpoints ?? [], ...skills?.rpcEndpoints ?? [], ...plugins?.rpcEndpoints ?? []],
      streamEndpoints: [...sessionInventory.streamEndpoints, ...firstScreen?.streamEndpoints ?? [],
        ...files?.streamEndpoints ?? [], ...events === undefined ? [] : [{ endpoint: events.endpoint, handlerId: 'native:typertGateway',
          guard: 'authenticated-account' as const }]],
      exactFetchRoutes: [...fetch.native, ...fetch.root],
    }
    if (inventory.rpcEndpoints.length + inventory.streamEndpoints.length + fetch.root.length > maximum) this.nativeUnavailable()
    const typert = owner.get('typert')
    if (typert === undefined) this.nativeUnavailable()
    for (const [rows, mode] of [[inventory.rpcEndpoints, 'rpc'], [inventory.streamEndpoints, 'stream']] as const) {
      for (const row of rows) {
        if (row.endpoint === '$events') continue // Reserved native Gateway registration, inspected above; it has no Remote marker.
        const descriptor = typert.local.get(row.endpoint)
        if (descriptor === undefined) {
          if (typert.local.hasSeen(row.endpoint)) this.nativeUnavailable()
          continue // Actual Gateway source discovery reads these same original native markers.
        }
        const separator = row.endpoint.indexOf('/'), namespace = row.endpoint.slice(0, separator)
        const method = row.endpoint.slice(separator + 1), service = row.handlerId.slice('native:'.length)
        if (descriptor.service !== service || descriptor.namespace !== namespace || descriptor.method !== method
          || (descriptor.implementation ?? descriptor.method) !== method || (descriptor.mode ?? 'rpc') !== mode) this.nativeUnavailable()
      }
    }
    try {
      this.installation.exposure.audit(inventory)
      current()
      this.assertNativeCurrent(owner)
    } catch (cause) {
      this.installation.exposure.invalidate()
      throw cause
    }
  }

  /**
   * Audit this view against actual native inventory supplied by trusted assembly.
   * @param inventory Mounted handlers and reviewed guards, never configuration availability flags.
   */
  audit(inventory: ExposureInventory): void {
    this.assertInstalled()
    this.installation.exposure.audit(inventory)
  }

  /** Revoke only this graph's inventory during replacement or drain. */
  invalidate(): void { this.installation.exposure.invalidate() }

  /**
   * Require a reviewed native unary endpoint after business admission.
   * @param endpoint Native unary URL endpoint.
   * @returns The audited declaration after business admission.
   */
  requireRpc(endpoint: string): EndpointExposure {
    this.admit()
    const row = this.installation.exposure.requireRpc(endpoint)
    if (endpoint.startsWith('workspaceFiles/')) this.assertWorkspaceFilesCurrent()
    if (endpoint === 'cloudProjects/create') {
      if (this.projects.native === undefined) this.nativeUnavailable()
      this.projects.native.assertCurrent()
    }
    if (endpoint === 'workspace/initializeDefault' || endpoint === 'settings/describe' || endpoint === 'settings/mutate') {
      if (this.firstScreen.native === undefined) this.nativeUnavailable()
      this.firstScreen.native.assertCurrent()
    }
    if (endpoint.startsWith('cloudModelKey/')) this.modelKey.native?.inspect()
    if (endpoint.startsWith('cloudSkills/')) {
      if (this.skills.native === undefined) this.nativeUnavailable()
      this.skills.native.inspect()
    }
    if (endpoint.startsWith('cloudPlugins/')) {
      if (this.plugins.native === undefined) this.nativeUnavailable()
      this.plugins.native.inspect()
    }
    return row
  }

  /**
   * Require a reviewed native logical-stream endpoint after business admission.
   * @param endpoint Native logical-stream endpoint.
   * @returns Its audited declaration after business admission.
   */
  requireStream(endpoint: string): EndpointExposure {
    this.admit()
    const row = this.installation.exposure.requireStream(endpoint)
    if (endpoint.startsWith('workspaceFiles/')) this.assertWorkspaceFilesCurrent()
    if (endpoint === 'workspace/follow' || endpoint === 'remoteAccess/follow') {
      if (this.firstScreen.native === undefined) this.nativeUnavailable()
      this.firstScreen.native.assertCurrent()
    }
    if (endpoint === '$events') {
      if (this.firstScreen.events === undefined) this.nativeUnavailable()
      this.firstScreen.events.inspect()
    }
    return row
  }

  /**
   * Require an exact reviewed Fetch route after business admission.
   * @param method Original HTTP method.
   * @param pathname Original canonical pathname.
   * @returns Its exact audited declaration after business admission.
   */
  requireFetch(method: string, pathname: string): ExactFetchExposure {
    this.admit()
    const row = this.installation.exposure.requireFetch(method, pathname)
    this.assertFetchCurrent(row, this.inspectFetchRoutes())
    return row
  }

  /**
   * Prepare fixed readonly native constructors; original Loader activation and complete auditing still follow.
   * @param owner Independent graph's prepare scope.
   * @param input Actual files-owned project, shared Session metadata check and explicit native limits.
   * @returns Original constructor installation, with no readiness publication or directory creation.
   */
  prepareFirstScreen(owner: Context, input: Omit<FirstScreenNativeInput, 'api' | 'binding' | 'assertSettingsFields'>): NativeFirstScreen {
    this.assertInstalled(owner)
    if (this.firstScreen.native !== undefined) this.duplicateNative()
    const fields = this.installation.exposure.manifest.allowedSettings
    if (!approvedSettingsMatch(input.settingsWrites?.fields ?? [], fields)) {
      throw new CloudApiError('cloud/invalid-config', 'The first-screen API requires its exact approved native settings policy.')
    }
    const native = prepareNativeFirstScreen(owner, { ...input, api: this, binding: this.binding,
      assertSettingsFields: (namespace, fields) => {
        this.admit()
        this.installation.exposure.assertSettingsFields(namespace, fields)
      },
    })
    this.firstScreen.native = native
    return native
  }

  /**
   * Register one key service in its Loader fiber.
   * @param owner Original Loader.
   * @param input Root policy and original login callback.
   * @returns Installed service.
   */
  prepareCloudModelKey(owner: Context, input: CloudModelKeyPreparation): CloudModelKeyService {
    this.assertInstalled(owner)
    if (this.modelKey.native !== undefined) this.duplicateNative()
    const native = new CloudModelKeyService(owner, this, input)
    this.modelKey.native = native
    return native
  }
  /**
   * Prepare one fixed skill capability; Root still supplies and audits explicit exposure separately.
   * @param owner Original account Loader scope after native skills and verified files activate.
   * @param input Same files owner, original Peer consumer and explicit finite bounds.
   * @returns Concrete native Remote. Restore before business opening; resource loads require original caller/project preparation.
   */
  prepareCloudSkills(owner: Context, input: CloudSkillPreparation): CloudSkillService {
    this.assertInstalled(owner)
    if (this.skills.native !== undefined) this.duplicateNative()
    const native = new CloudSkillService(owner, this, input, this.saves)
    this.skills.native = native
    return native
  }

  /** Prepare the fixed plugin Remote after its original guarded manager and editor activate.
   * @param owner Actual original account Loader entry.
 * @returns Exact original two-method Remote.
   */
  prepareCloudPlugins(owner: Context): CloudPluginService {
    this.assertInstalled(owner)
    if (this.plugins.native !== undefined) this.duplicateNative()
    if (this.plugins.control === undefined) this.nativeUnavailable()
    const native = new CloudPluginService(owner, this, this.plugins.control)
    this.plugins.native = native
    return native
  }

  /** Audit the actual preinstalled fixed module and original native writer before publication.
   * @returns Original importer/package/native inventory settlement.
   */
  restoreApprovedPlugins(): Promise<void> {
    this.assertInstalled()
    if (this.plugins.control === undefined || this.plugins.native === undefined) this.nativeUnavailable()
    return this.plugins.control.restore()
  }

  /** Apply a checked intent in the original stopped graph before its native hooks are withdrawn.
   * @param intent Original save-owner CAS result.
   * @param current Actual factory terminal window check.
   * @returns Actual native writer and application; neither business nor save admission reopens.
   */
  applyApprovedPluginIntent(intent: PluginRebuildIntent, current: () => void): Promise<PluginRebuildPersistence> {
    this.assertInstalled(); current()
    const terminal = (): void => {
      current(); this.assertInstalled()
      if (this.reconfiguring === undefined || this.saves.snapshot().admission !== 'stopped') this.nativeUnavailable()
      this.reconfiguring()
    }
    const control = this.plugins.control
    if (control === undefined) this.nativeUnavailable()
    terminal()
    return control.applyRebuild(intent, terminal)
  }

  /** Verify the checked old intent on this unpublished replacement graph.
   * @param intent Original terminal operation.
   * @param persisted Original native persistence result.
   * @param current Original replacement-graph check before ready CAS.
   * @returns Verified new state, with a new save owner version.
   */
  verifyApprovedPluginIntent(
    intent: PluginRebuildIntent, persisted: PluginRebuildPersistence, current: () => void,
  ): Promise<PluginRebuildVerification> {
    this.assertInstalled(); current()
    const control = this.plugins.control
    if (control === undefined) this.nativeUnavailable()
    return control.verifyRebuild(intent, persisted, () => { current(); this.assertInstalled() })
  }

  /**
   * Require the audited configured bootstrap route.
   * @param provider Root provider.
   * @param model Root model.
   */
  assertProvisionableModel(provider: string, model: string): void {
    if (this.modelKey.native === undefined) this.nativeUnavailable()
    this.modelKey.native.assertProvisionableModel(provider, model)
  }

  /**
   * Install the account's sole project allocator before native auditing and business publication.
   * @param owner Original independent account preparation scope.
   * @param input Trusted files/Registry callback; receives no client-selected path or authority.
   * @returns The additive Remote owner, registered on the original graph.
   */
  prepareCloudProjects(owner: Context, input: CloudProjectsPreparation): CloudProjectsService {
    this.assertInstalled(owner)
    if (this.projects.native !== undefined) this.duplicateNative()
    const native = new CloudProjectsService(owner, this, input)
    this.projects.native = native
    return native
  }

  /**
   * Register the sole unchanged native WorkspaceFiles in its actual Loader fiber.
   * @param owner Original Loader scope with the complete native inject list ready.
   * @param nativeConfig Original WorkspaceFiles page/list caps, resolved by its native Config.
   * @returns The original native service; existing filesystem provider and native Gateway retain authorization and I/O ownership.
   */
  createWorkspaceFiles(owner: Context, nativeConfig: ConstructorParameters<typeof WorkspaceFiles>[1]): WorkspaceFiles {
    this.assertInstalled(owner)
    if (this.files.native !== undefined) this.duplicateNative()
    const maximum = this.maxNativeInventoryEntries
    if (maximum === undefined) this.nativeUnavailable()
    const native = createNativeWorkspaceFiles(owner, this.binding, () => { this.assertInstalled(owner) }, maximum, nativeConfig)
    this.files.native = native
    owner.effect(() => () => { this.invalidate() }, 'pe-cloud-api: withdraw original WorkspaceFiles')
    return native.value
  }

  /**
   * Register the actual bounded native event subset on the original Gateway.
   * @param owner Original registration Loader fiber after readonly native providers activate.
   * @param input Exact graph profile home and all required event bounds.
   * @returns Actual registration/disposer; native Gateway owns ready and wire framing.
   */
  installFirstScreenEvents(owner: Context, input: Omit<FirstScreenEventInput, 'api' | 'native' | 'settingsNamespaces'>): FirstScreenEvents {
    this.assertInstalled(owner)
    if (this.firstScreen.events !== undefined) this.duplicateNative()
    const native = this.firstScreen.native
    if (native === undefined) this.nativeUnavailable()
    const settings = this.installation.exposure.manifest.allowedSettings
    const settingsNamespaces = Object.freeze(settings.length === 0 ? ['locale'] : settings.map(row => row.namespace))
    const events = registerFirstScreenEvents(owner, { ...input, api: this, native, settingsNamespaces })
    this.firstScreen.events = events
    return events
  }

  /**
   * Join the original cached event-source withdrawal before native teardown.
   * @returns Actual registration/disposer settlement; absent registration has no work.
   */
  async stopFirstScreenEvents(): Promise<void> { await this.firstScreen.events?.dispose() }

  /**
   * Construct the sole native Controller in its actual Loader fiber.
   * @param owner Owning native entry inside this independent graph.
   * @param guards Shared files/project/Preset and enabled-handler checks, including the fixed directory capability.
   * @param config Original native Controller configuration.
   * @returns The registered native subclass; this does not audit or publish the graph.
   */
  createController(
    owner: Context, guards: NativeSessionGuards, config: ConstructorParameters<typeof SessionController>[1],
  ): SessionController {
    this.assertInstalled(owner)
    this.requireUninstalled(owner, 'sessionController')
    const controller = createNativeController(owner, this.binding, this.businessCurrent, this.installation.exposure, guards, config)
    this.native.sessionController = { value: original(controller), fiber: owner.fiber }
    return controller
  }

  /**
   * Construct the sole original native upload owner with controlled streamed persistence.
   * @param owner Actual Loader entry, with native dependencies ready.
   * @param input Same-Agent storage admission and finite native receipt capacity.
   * @returns Native service; its streamed route remains subject to the audited exposure policy.
   */
  createFileUploads(owner: Context, input: NativeUploadPreparation): FileUploads {
    this.assertInstalled(owner)
    if (this.uploads.native !== undefined || this.maxNativeInventoryEntries === undefined) this.duplicateNative()
    const native = createNativeUploads(owner, this.binding, () => { this.assertInstalled(owner) },
      () => { this.requireFetch('POST', FILE_UPLOAD_PATH) }, this.maxNativeInventoryEntries, input)
    this.uploads.native = native
    return native.value
  }

  /**
   * Install the sole guarded native factory before business admission opens.
   * @param owner Owning native entry inside this independent graph.
   * @param guards Shared pre-write and prepared-Agent checks.
   * @param config Original native configuration, with no startup agents.
   * @param reserveSubagent Original Root capacity/settlement callback; omission keeps child entry closed.
   * @returns The real native AgentLoop provider; every operation still checks business admission.
   */
  createAgentLoop(
    owner: Context, guards: NativeAgentFactoryGuards, config: ConstructorParameters<typeof AgentLoop>[1],
    reserveSubagent?: (depth: number) => SubagentCapacityReservation,
  ): AgentLoop {
    this.assertInstalled(owner)
    this.requireUninstalled(owner, 'agentLoop')
    const loop = createNativeAgentLoop(owner, this.binding, this.businessCurrent, guards, config, reserveSubagent)
    this.native.agentLoop = { value: original(loop), fiber: owner.fiber }
    return loop
  }

  /**
   * Install actual model dispatch admission in the native LLM scope.
   * @param owner Native LLM scope in this graph.
   * @param allowed Same approved provider/model set as selection and catalog projection.
   * @returns The native effect disposer; no model request is made here.
   */
  installLlmGuard(owner: Context, allowed: (provider: string, model: string) => boolean): () => void {
    this.assertInstalled(owner)
    if (this.native.llm !== undefined) this.duplicateNative()
    // The actual constructor registers while its Loader fiber is still LOADING.
    const llm = owner.get('llm', false), installed = owner.fiber.store?.llm
    const installedValue: unknown = installed?.value
    if (!(llm instanceof LlmRuntime) || installed?.fiber !== owner.fiber || installedValue === null || typeof installedValue !== 'object'
      || original(installedValue) !== original(llm)) this.nativeUnavailable()
    const remove = installActualLlmGuard(owner, this.binding, this.businessCurrent, allowed)
    const dispose = (): void => {
      if (this.streamGuard.dispose !== dispose) return
      delete this.streamGuard.dispose
      remove()
    }
    this.native.llm = { value: original(llm), fiber: owner.fiber }
    this.streamGuard.dispose = dispose
    owner.effect(() => dispose, 'pe-cloud-api: withdraw original LLM guard')
    return dispose
  }

  /**
   * Pause new top-level configuration submissions while retaining admitted native work.
   * @param deadlineAtMs Finite observation deadline; actual submitted writes remain owned.
   * @param signal Optional observer cancellation; absence waits to the deadline.
   * @returns The existing save barrier's pause evidence.
   */
  pauseAccountChanges(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    return this.installation.pauseAccountChanges(deadlineAtMs, signal)
  }

  /** Observe actual original configuration work without granting an update window.
   * @returns The original save owner's bounded actual work, without native values. */
  inspectConfigurationSaves(): ReturnType<ConfigSaveBarrier['snapshot']> { return this.saves.snapshot() }

  /** Run the factory's exclusive native plugin writer in the original paused save turn.
   * @param submit Original writer and required application, with no observer-cancellation race.
   * @returns Actual settlement under this same barrier; missing exclusive authority rejects before submit.
   */
  withPausedPluginChange<T>(submit: () => Promise<T>): Promise<T> {
    this.assertInstalled()
    if (this.reconfiguring === undefined) this.nativeUnavailable()
    this.reconfiguring()
    return this.saves.withPausedPluginChange(submit)
  }

  /** Reopen only after runtime's actual re-audit and the barrier's quiescence check. */
  resumeAccountChanges(): void {
    this.assertInstalled()
    this.installation.resumeAccountChanges()
  }

  /**
   * Close configuration submissions and retain actual native save settlement.
   * @param deadlineAtMs Finite observation deadline; timeout does not stop actual native writes.
   * @param signal Optional observer cancellation; absence waits to the deadline.
   * @returns Existing terminal save evidence, available after business admission closes.
   */
  stopConfigSaves(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    this.invalidate()
    return this.installation.stopConfigSaves(deadlineAtMs, signal)
  }

  /** Withdraw only after confirmed terminal save settlement, before disposing native providers. */
  async withdraw(): Promise<void> {
    await this.stopFirstScreenEvents()
    await this.installation.withdraw()
  }

  /** Bind a trusted request borrow to the existing native credential installation; registers no endpoint.
   * @param use Original runtime-issued AccountUse; its caller retains release ownership through settlement.
   * @param limits Explicit deployment byte bounds, never client input.
   * @param assertRequestCurrent Original request/Peer check; production ingress must supply it.
   * Omission preserves trusted in-process calls without adding login admission.
   * @returns A request-local adapter; every call still requires actual business and exposure admission.
   */
  modelKeyAccess(use: AccountUse, limits: ApprovedModelKeyConfiguration, assertRequestCurrent?: () => void): ModelKeyAccess {
    return bindModelKeyAccess(use, this, this.installation, limits, assertRequestCurrent)
  }

  private admit(): void {
    this.assertInstalled()
    this.businessCurrent(this.binding)
    this.assertInstalled()
  }

  private requireUninstalled(owner: Context, key: Exclude<NativeKey, 'llm'>): void {
    if (this.native[key] !== undefined || owner.get(key) !== undefined || owner.root.get(key) !== undefined) this.duplicateNative()
  }

  private duplicateNative(): never {
    throw new CloudApiError('cloud/invalid-config', 'The account API already has a native installation.')
  }

  private nativeUnavailable(): never {
    throw new CloudApiError('cloud/account-unavailable', 'Bootstrap requires the original guarded native providers and shared policy.')
  }

  private assertWorkspaceFilesCurrent(): void {
    if (this.files.native === undefined) this.nativeUnavailable()
    this.files.native.assertCurrent()
  }

  private inspectFetchRoutes(): { native: readonly ExactFetchExposure[]; root: readonly ExactFetchExposure[] } {
    const maximum = this.maxNativeInventoryEntries
    if (maximum === undefined || !Number.isSafeInteger(maximum) || maximum < 1) this.nativeUnavailable()
    const root = this.rootFetch?.() ?? []
    if (root.length > maximum) this.nativeUnavailable()
    const native = this.uploads.native?.inspect().exactFetchRoutes ?? []
    if (native.length > maximum - root.length) this.nativeUnavailable()
    return { native, root }
  }

  private assertFetchCurrent(
    expected: ExactFetchExposure, actual: { native: readonly ExactFetchExposure[]; root: readonly ExactFetchExposure[] },
  ): void {
    let matches = 0
    for (const routes of [actual.native, actual.root]) {
      for (const row of routes) {
        if (row.method !== expected.method || row.path !== expected.path) continue
        if (++matches !== 1 || row.handlerId !== expected.handlerId || row.guard !== expected.guard) this.nativeUnavailable()
      }
    }
    if (matches !== 1) this.nativeUnavailable()
  }

  private observePreparedPhase(phase: 'audit-provider' | 'bootstrap-policy' | 'nativeinventory'): void {
    try { this.startupPhase?.(phase) }
    catch (_cause) { /* Private observation cannot replace the original native audit or failure. */ }
  }

  private assertNativeCurrent(owner: Context, audited = true): void {
    owner.fiber.assertActive()
    if (this.streamGuard.dispose === undefined) this.nativeUnavailable()
    const maximum = this.maxNativeInventoryEntries
    if (maximum === undefined || !Number.isSafeInteger(maximum) || maximum < 1) this.nativeUnavailable()
    let remaining = maximum
    const consume = (count: number): void => {
      if (count > remaining) this.nativeUnavailable()
      remaining -= count
    }
    const exposure = this.installation.exposure
    // Charge all selected lists before any registry traversal or endpoint lookup.
    consume(exposure.manifest.rpcEndpoints.length)
    consume(exposure.manifest.streamEndpoints.length)
    consume(exposure.manifest.exactFetchRoutes.length)
    const fetch = this.inspectFetchRoutes()
    consume(fetch.root.length)
    const counts: Record<NativeKey, number> = { sessionController: 0, agentLoop: 0, llm: 0 }
    for (const key of ['sessionController', 'agentLoop', 'llm'] as const) {
      const expected = this.native[key], local = owner.get(key), root = owner.root.get(key)
      if (expected === undefined || local === undefined || root === undefined
        || expected.fiber.state !== FiberState.ACTIVE || expected.fiber.ctx.root !== owner.root
        || original(local) !== expected.value || original(root) !== expected.value) this.nativeUnavailable()
    }
    for (const runtime of owner.registry.values()) {
      consume(1)
      for (const fiber of runtime.fibers) {
        consume(1)
        if (fiber.ctx.root !== owner.root || fiber.state !== FiberState.ACTIVE) continue
        for (const key of ['sessionController', 'agentLoop', 'llm'] as const) {
          const installed = fiber.store?.[key], expected = this.native[key]
          if (installed === undefined || installed.fiber !== fiber) continue
          const value: unknown = installed.value
          if (++counts[key] > 1 || expected === undefined || fiber !== expected.fiber || value === null || typeof value !== 'object'
            || original(value) !== expected.value) this.nativeUnavailable()
        }
      }
    }
    if (Object.values(counts).some(count => count !== 1)) this.nativeUnavailable()
    if (this.firstScreen.native !== undefined) {
      this.firstScreen.native.assertCurrent()
      if (this.firstScreen.events === undefined) this.nativeUnavailable()
      this.firstScreen.events.inspect()
    }
    this.modelKey.native?.inspect()
    this.projects.native?.assertCurrent()
    this.files.native?.assertCurrent()
    this.uploads.native?.assertCurrent()
    if (!audited) return
    for (const row of exposure.manifest.rpcEndpoints) exposure.requireRpc(row.endpoint)
    for (const row of exposure.manifest.streamEndpoints) exposure.requireStream(row.endpoint)
    for (const row of exposure.manifest.exactFetchRoutes) {
      exposure.requireFetch(row.method, row.path)
      this.assertFetchCurrent(row, fetch)
    }
  }

  private assertOwner(owner: Context): void {
    this.installation.assertInstalled(owner)
    const local = owner.get('peCloudApi'), root = owner.root.get('peCloudApi')
    if (!(local instanceof CloudAccountApi) || !(root instanceof CloudAccountApi)
      || local.identity !== this.identity || root.identity !== this.identity) {
      throw new CloudApiError('cloud/stale-generation', 'The account API belongs to another graph generation.')
    }
  }
}
