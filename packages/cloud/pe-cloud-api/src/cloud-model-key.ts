/** Account-owned model-key Remote; the original Peer Use and save barrier retain all work. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { Remote, remoteMethods, TypertRemoteService, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { CloudAccountApi } from './account-service.ts'
import type { ModelKeyAccess } from './model-key.ts'
import { modelKeyCodecs, type ModelKeyReference,
  type ModelKeySet, type ModelKeyUnset, type ModelKeyState, type ModelKeySaved } from './model-key-json.ts'
import { CloudApiError } from './errors.ts'
import { ModelKeyProvider } from './model-key-provider.ts'
import type { ApprovedModelKeyConfiguration, ExposureInventory, ModelKeyMetadata } from './types.ts'

/** Original login registry callback; it borrows nothing and never releases the retained AccountUse. */
export interface ModelKeyPeerConsumer {
  /**
   * @param peer Exact original Gateway invocation Peer.
   * @param consume Actual native operation, awaited by the original carrier/task owner.
   * @returns Actual operation settlement; current checks keep the same original login and generation.
   */
  withModelKeyPeerUse<T>(peer: PeerScope, consume: (use: AccountUse, assertCurrent: () => void) => Promise<T>): Promise<T>
}

/** Trusted native preparation; no account identity, reference or callback comes from request JSON. */
export interface CloudModelKeyPreparation extends ModelKeyPeerConsumer {
  readonly limits: ApprovedModelKeyConfiguration
  readonly maxNativeInventoryEntries: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Approved native reference Remote; native credentials/settings write endpoints remain closed. */
    cloudModelKey: CloudModelKeyService
  }
}
const methods = ['metadata', 'describe', 'set', 'unset'] as const
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}
function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original model-key service or request is unavailable.')
}

/** One independent capability; original native persistence, ordering and failure retention stay with AccountSaves. */
export class CloudModelKeyService extends TypertRemoteService {
  private readonly provider: ModelKeyProvider
  private readonly owner: Context
  private readonly codecs: ReturnType<typeof modelKeyCodecs>

  /**
   * @param ctx Actual original account Loader entry after the native Typert registry activates.
   * @param api Same graph's original API owner and audited exposure.
   * @param input Root's fixed bounds and original login registry callback.
   */
  constructor(ctx: Context, private readonly api: CloudAccountApi, private readonly input: CloudModelKeyPreparation) {
    api.assertInstalled(ctx)
    if (ctx.get('cloudModelKey') !== undefined || ctx.root.get('cloudModelKey') !== undefined) unavailable()
    super(ctx, 'cloudModelKey', { namespace: 'cloudModelKey' })
    this.provider = new ModelKeyProvider(ctx, input.limits, input.maxNativeInventoryEntries)
    this.owner = ctx
    this.codecs = modelKeyCodecs(input.limits, input.limits.bindings.map(binding => binding.ref))
    ctx.effect(() => () => { api.invalidate() }, 'pe-cloud-api: withdraw original model-key service')
  }

  /**
   * Read actual metadata through the original Peer/Use.
   * @param signal Original observer signal.
   * @returns Bounded readonly native metadata.
   */
  @Remote('metadata')
  metadata(signal: AbortSignal): Promise<ModelKeyMetadata> {
    signal.throwIfAborted(); this.inspect(); this.api.requireRpc('cloudModelKey/metadata')
    const invocation = this.ctx.invocation
    if (invocation?.service !== 'cloudModelKey' || invocation.request.namespace !== 'cloudModelKey'
      || invocation.request.method !== 'metadata') unavailable()
    return this.input.withModelKeyPeerUse(invocation.peer, (use, current) => new Promise<ModelKeyMetadata>((resolve) => {
      const check = (): void => {
        current(); signal.throwIfAborted(); use.assertCurrent()
        if (use.binding !== this.api.binding || use.context.root !== this.owner.root) unavailable()
        this.api.assertInstalled(use.context); this.assertCurrent(); this.api.requireRpc('cloudModelKey/metadata')
      }
      check()
      const metadata = this.provider.metadata()
      check(); resolve(metadata)
    }))
  }
  /**
   * Audit before bootstrap policy checks.
   * @returns Actual native module import settlement.
   */
  auditProvider(): Promise<void> { this.assertCurrent(); return this.provider.audit() }
  /**
   * Require the audited configured bootstrap route.
   * @param provider Root provider.
   * @param model Root model.
   */
  assertProvisionableModel(provider: string, model: string): void {
    this.assertCurrent(); this.provider.assertProvisionable(provider, model)
  }

  /**
   * Read redacted state for an explicit edit.
   * @param request Root-approved native reference.
   * @param signal Original observer signal.
   * @returns Redacted state and version.
   */
  @Remote('describe')
  describe(request: ModelKeyReference, signal: AbortSignal): Promise<ModelKeyState> {
    return this.consume('describe', request, signal, (access, raw) => access.describe(raw))
  }
  /**
   * Persist the approved Key in the original save turn.
   * @param request Approved reference, secret and captured version.
   * @param signal Original observer signal.
   * @returns Confirmed persistence.
   */
  @Remote('set')
  set(request: ModelKeySet, signal: AbortSignal): Promise<ModelKeySaved> {
    return this.consume('set', request, signal, (access, raw) => access.set(raw))
  }
  /**
   * Remove the approved Key in the original save turn.
   * @param request Approved reference and captured version.
   * @param signal Original observer signal.
   * @returns Confirmed removal.
   */
  @Remote('unset')
  unset(request: ModelKeyUnset, signal: AbortSignal): Promise<ModelKeySaved> {
    return this.consume('unset', request, signal, (access, raw) => access.unset(raw))
  }

  /** Require this same installed service, independently of public readiness. */
  assertCurrent(): void {
    this.owner.fiber.assertActive()
    this.api.assertInstalled(this.owner)
    if (original(this.owner.get('cloudModelKey') ?? {}) !== original(this)
      || original(this.owner.root.get('cloudModelKey') ?? {}) !== original(this)) unavailable()
  }

  /**
   * Inspect actual installed unary registrations.
   * @returns Actual fixed Remote markers and strict descriptors; never a configured availability claim.
   */
  inspect(): ExposureInventory {
    this.assertCurrent()
    const binding = this.typertRemote, markers = remoteMethods(this), typert = this.owner.get('typert')
    if (binding.service !== original(this) || binding.serviceKey !== 'cloudModelKey' || binding.namespace !== 'cloudModelKey'
      || markers.length !== methods.length || typert === undefined) unavailable()
    for (const method of methods) {
      const marker = markers.find(value => value.method === method), descriptor = typert.local.get(`cloudModelKey/${method}`)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(original(this), method) !== CloudModelKeyService.prototype[method]
        || descriptor === undefined || descriptor.service !== 'cloudModelKey' || descriptor.namespace !== 'cloudModelKey'
        || descriptor.method !== method || (descriptor.implementation ?? method) !== method || (descriptor.mode ?? 'rpc') !== 'rpc'
        || descriptor.invocation.kind !== 'direct' || descriptor.parameters.length !== (method === 'metadata' ? 0 : 1)
        || (method !== 'metadata' && (descriptor.parameters[0]?.wire !== 'request' || descriptor.parameters[0].source !== 'json'
          || descriptor.parameters[0].codec.mode !== 'strict')) || descriptor.result.mode !== 'strict'
        || descriptor.cancellation?.parameter !== 'signal') unavailable()
    }
    return { recipeVersion: this.api.binding.recipeVersion,
      rpcEndpoints: methods.map(method => ({ endpoint: `cloudModelKey/${method}`, handlerId: 'native:cloudModelKey',
        guard: 'authenticated-account' })), streamEndpoints: [], exactFetchRoutes: [] }
  }

  private consume<T>(method: 'describe' | 'set' | 'unset', request: ModelKeyReference, signal: AbortSignal,
    consume: (access: ModelKeyAccess, raw: unknown) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    this.inspect()
    this.api.requireRpc(`cloudModelKey/${method}`)
    const invocation = this.ctx.invocation
    if (!this.input.limits.bindings.some(binding => binding.ref === request.ref) || invocation?.service !== 'cloudModelKey'
      || invocation.request.namespace !== 'cloudModelKey' || invocation.request.method !== method) unavailable()
    // The native generated codec may strip extra object keys. Check the original carrier value before any save turn.
    const raw = invocation.request.args.request
    this.codecs[method].create().parse(raw)
    return this.input.withModelKeyPeerUse(invocation.peer, async (use, current) => {
      const check = (): void => {
        signal.throwIfAborted(); current(); use.assertCurrent()
        if (use.binding !== this.api.binding || use.context.root !== this.owner.root) unavailable()
        this.api.assertInstalled(use.context); this.assertCurrent(); this.provider.metadata(); this.api.requireRpc(`cloudModelKey/${method}`)
      }
      check()
      const result = await consume(this.api.modelKeyAccess(use, this.input.limits, check), raw)
      check()
      return result
    })
  }
}
