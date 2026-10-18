/** Graph-owned API preparation and native providers consumed by trusted runtime assembly. */
import { Context, Service } from '@deepseek-ai/cordis'
import type AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { prepareAccountApiInstall, type AccountApiInstall } from './account-install.ts'
import { CloudApiError } from './errors.ts'
import type { ExposurePolicy } from './exposure.ts'
import { installActualLlmGuard } from './llm-guard.ts'
import { createNativeAgentLoop, type NativeAgentFactoryGuards } from './native-agent-factory.ts'
import { createNativeController, type NativeSessionGuards } from './native.ts'
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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prepared account API owner; presence alone does not establish account readiness. */
    peCloudApi: CloudAccountApi
  }
}

/** One account's API providers and save controls; runtime retains assembly and drain ownership. */
export class CloudAccountApi extends Service {
  readonly binding: AccountBinding
  /** Native constructors fixed before their Loader activation, using this graph's existing save hooks. */
  readonly providers: Readonly<Pick<AccountApiInstall, 'configEditor' | 'credentials'>>
  private readonly installation: AccountApiInstall
  private readonly mountCurrent: AccountApiPreparation['assertMountCurrent']
  private readonly businessCurrent: AccountApiPreparation['assertBusinessCurrent']
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
   * Audit this view against actual native inventory supplied by trusted assembly.
   * @param inventory Mounted handlers and reviewed guards, never configuration availability flags.
   */
  audit(inventory: ExposureInventory): void {
    this.assertInstalled()
    this.installation.exposure.audit(inventory)
  }

  /** Revoke only this graph's inventory during replacement or drain. */
  invalidate(): void { this.installation.exposure.invalidate() }

  /** @param endpoint Native unary URL endpoint. @returns The audited declaration after business admission. */
  requireRpc(endpoint: string): EndpointExposure {
    this.admit()
    return this.installation.exposure.requireRpc(endpoint)
  }

  /** @param endpoint Native logical-stream endpoint. @returns Its audited declaration after business admission. */
  requireStream(endpoint: string): EndpointExposure {
    this.admit()
    return this.installation.exposure.requireStream(endpoint)
  }

  /**
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
    return createNativeController(owner, this.binding, this.businessCurrent, this.installation.exposure, guards, config)
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
    return createNativeAgentLoop(owner, this.binding, this.businessCurrent, guards, config)
  }

  /**
   * Install actual model dispatch admission in the native LLM scope.
   * @param owner Native LLM scope in this graph.
   * @param allowed Same approved provider/model set as selection and catalog projection.
   * @returns The native effect disposer; no model request is made here.
   */
  installLlmGuard(owner: Context, allowed: (provider: string, model: string) => boolean): () => void {
    this.assertInstalled(owner)
    return installActualLlmGuard(owner, this.binding, this.businessCurrent, allowed)
  }

  /**
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

  private assertOwner(owner: Context): void {
    this.installation.assertInstalled(owner)
    const local = owner.get('peCloudApi'), root = owner.root.get('peCloudApi')
    if (!(local instanceof CloudAccountApi) || !(root instanceof CloudAccountApi)
      || local.identity !== this.identity || root.identity !== this.identity) {
      throw new CloudApiError('cloud/stale-generation', 'The account API belongs to another graph generation.')
    }
  }
}
