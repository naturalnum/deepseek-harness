/** Graph-owned API preparation and native providers consumed by trusted runtime assembly. */
import { Context, FiberState, Service, symbols, type Fiber } from '@deepseek-ai/cordis'
import type AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { prepareAccountApiInstall, type AccountApiInstall } from './account-install.ts'
import { CloudApiError } from './errors.ts'
import type { ExposurePolicy } from './exposure.ts'
import { installActualLlmGuard } from './llm-guard.ts'
import { createNativeAgentLoop, type NativeAgentFactoryGuards } from './native-agent-factory.ts'
import { createNativeController, inspectNativeController, type NativeSessionGuards } from './native.ts'
import type { ConfigSaveBarrier, ConfigSaveReceipt } from './save-hooks.ts'
import type { EndpointExposure, ExactFetchExposure, ExposureInventory, ExposureManifest } from './types.ts'

/** Trusted graph preparation inputs; no field is accepted from Loader JSON or an HTTP borrow. */
export interface AccountApiPreparation {
  readonly binding: AccountBinding
  readonly rootExposure: ExposurePolicy
  readonly selected: ExposureManifest
  readonly saves: ConfigSaveBarrier
  /** Require the exact installed preparation/current graph, independently of business publication. */
  readonly assertMountCurrent: (binding: AccountBinding) => void
  /** Require the original graph's actual business-ready publication on every dispatch. */
  readonly assertBusinessCurrent: (binding: AccountBinding) => void
  /** Read the original shared project/Preset/default-model policy; absence keeps bootstrap assertions closed. */
  readonly assertBootstrapCurrent?: (signal: AbortSignal) => Promise<void>
  /** Positive finite bound shared by visited native runtimes, fibers and selected exposure rows; no default. */
  readonly maxNativeInventoryEntries?: number
  /** Factory-owned unpublished mounting window; required only by prepared native auditing. */
  readonly assertUnpublished?: () => void
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
  readonly providers: Readonly<Pick<AccountApiInstall, 'configEditor' | 'credentials'>>
  private readonly installation: AccountApiInstall
  private readonly mountCurrent: AccountApiPreparation['assertMountCurrent']
  private readonly businessCurrent: AccountApiPreparation['assertBusinessCurrent']
  private readonly bootstrapCurrent: AccountApiPreparation['assertBootstrapCurrent']
  private readonly maxNativeInventoryEntries: AccountApiPreparation['maxNativeInventoryEntries']
  private readonly unpublished: AccountApiPreparation['assertUnpublished']
  // These cells retain original installations across caller-scoped Cordis proxies.
  private readonly native: Partial<Record<NativeKey, NativeInstallation>> = {}
  private readonly streamGuard: { dispose?: () => void } = {}
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
    this.bootstrapCurrent = input.assertBootstrapCurrent
    this.maxNativeInventoryEntries = input.maxNativeInventoryEntries
    this.unpublished = input.assertUnpublished
    this.installation = installation
    this.providers = Object.freeze({ configEditor: installation.configEditor, credentials: installation.credentials })
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
   * @returns Settlement of the current checks; no readiness token, catalog or account authority is issued.
   * @throws CloudApiError for absent policy, removed/replaced native installations or closed admission;
   * policy failures and cancellation retain their original identity.
   */
  async assertBootstrapCurrent(owner: Context, signal?: AbortSignal): Promise<void> {
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
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    const current = (): void => {
      control.throwIfAborted()
      this.assertInstalled(owner)
      if (this.unpublished === undefined) this.nativeUnavailable()
      this.unpublished()
      this.assertInstalled(owner)
    }
    current()
    this.installation.exposure.invalidate()
    const check = this.bootstrapCurrent, gateway = owner.get('typertGateway')
    if (check === undefined || !(gateway instanceof TypertGateway)
      || original(owner.root.get('typertGateway') ?? {}) !== original(gateway)) this.nativeUnavailable()
    this.assertNativeCurrent(owner, false)
    await check(control)
    current()
    if (original(owner.get('typertGateway') ?? {}) !== original(gateway)) this.nativeUnavailable()
    this.assertNativeCurrent(owner, false)
    const installed = this.native.sessionController, maximum = this.maxNativeInventoryEntries
    if (installed === undefined || maximum === undefined) this.nativeUnavailable()
    const controller = owner.get('sessionController')
    if (controller === undefined || original(controller) !== installed.value) this.nativeUnavailable()
    const inventory = inspectNativeController(controller, this.binding.recipeVersion, maximum)
    const typert = owner.get('typert')
    if (typert === undefined) this.nativeUnavailable()
    for (const [rows, mode] of [[inventory.rpcEndpoints, 'rpc'], [inventory.streamEndpoints, 'stream']] as const) {
      for (const row of rows) {
        const descriptor = typert.local.get(row.endpoint)
        if (descriptor === undefined) {
          if (typert.local.hasSeen(row.endpoint)) this.nativeUnavailable()
          continue // Actual Gateway source discovery reads these same original native markers.
        }
        const method = row.endpoint.slice('session/'.length)
        if (descriptor.service !== 'sessionController' || descriptor.namespace !== 'session' || descriptor.method !== method
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
    return this.installation.exposure.requireRpc(endpoint)
  }

  /**
   * Require a reviewed native logical-stream endpoint after business admission.
   * @param endpoint Native logical-stream endpoint.
   * @returns Its audited declaration after business admission.
   */
  requireStream(endpoint: string): EndpointExposure {
    this.admit()
    return this.installation.exposure.requireStream(endpoint)
  }

  /**
   * Require an exact reviewed Fetch route after business admission.
   * @param method Original HTTP method.
   * @param pathname Original canonical pathname.
   * @returns Its exact audited declaration after business admission.
   */
  requireFetch(method: string, pathname: string): ExactFetchExposure {
    this.admit()
    return this.installation.exposure.requireFetch(method, pathname)
  }

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
   * Install the sole guarded native factory before business admission opens.
   * @param owner Owning native entry inside this independent graph.
   * @param guards Shared pre-write and prepared-Agent checks.
   * @param config Original native configuration, with no startup agents.
   * @returns The real native AgentLoop provider; every operation still checks business admission.
   */
  createAgentLoop(owner: Context, guards: NativeAgentFactoryGuards, config: ConstructorParameters<typeof AgentLoop>[1]): AgentLoop {
    this.assertInstalled(owner)
    this.requireUninstalled(owner, 'agentLoop')
    const loop = createNativeAgentLoop(owner, this.binding, this.businessCurrent, guards, config)
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
  withdraw(): Promise<void> { return this.installation.withdraw() }

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
    if (!audited) return
    for (const row of exposure.manifest.rpcEndpoints) exposure.requireRpc(row.endpoint)
    for (const row of exposure.manifest.streamEndpoints) exposure.requireStream(row.endpoint)
    for (const row of exposure.manifest.exactFetchRoutes) exposure.requireFetch(row.method, row.path)
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
