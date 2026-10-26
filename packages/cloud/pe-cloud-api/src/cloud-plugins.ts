/** Catalog-approved plugin Remote; the original login, factory, native writers and save owner retain all actual work. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { Remote, remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CloudAccountApi } from './account-service.ts'
import type { AccountPluginControl } from './plugin-control.ts'
import type { ExposureInventory } from './types.ts'
import type { PluginChangeRequest, PluginChangeResult, PluginCurrentRequest, PluginCurrentState } from './plugin-types.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import type { pluginRequests } from './plugin-json.ts'
import { CloudApiError } from './errors.ts'

declare module '@deepseek-ai/cordis' { interface Context { cloudPlugins: CloudPluginService } }
const methods = ['current', 'change'] as const
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
}
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The original approved plugin Remote is unavailable.') }

/** Unary controls for finite approved preinstalled plugins; no installer or raw manager endpoint is granted. */
export class CloudPluginService extends TypertRemoteService {
  private readonly requests: ReturnType<typeof pluginRequests>
  constructor(ctx: Context, private readonly api: CloudAccountApi, private readonly control: AccountPluginControl) {
    api.assertInstalled(ctx)
    if (ctx.get('cloudPlugins') !== undefined || ctx.root.get('cloudPlugins') !== undefined) unavailable()
    super(ctx, 'cloudPlugins', { namespace: 'cloudPlugins' })
    this.requests = control.requests
    ctx.effect(() => () => { api.invalidate() }, 'pe-cloud-api: withdraw original approved plugin Remote')
  }

  /** Read actual approved native inventory and an epoch-bound original save-owner version.
   * @param request Approved catalog id.
 * @param signal Original observer cancellation.
   * @returns Original native PluginInfo, approved native Config fields and opaque version; no profile bytes or digest.
   */
  @Remote('current')
  current(request: PluginCurrentRequest, signal: AbortSignal): Promise<PluginCurrentState> {
    signal.throwIfAborted(); this.inspect(); this.api.requireRpc('cloudPlugins/current')
    const invocation = this.invocation('current')
    void request
    const input = this.requests.current(invocation.request.args.request)
    return this.control.input.withModelKeyPeerUse(invocation.peer, async (use, current) => {
      const check = (): void => {
        signal.throwIfAborted(); current(); use.assertCurrent(); this.assertCurrent()
        if (use.binding !== this.api.binding || use.context.root !== this.ctx.root) unavailable()
        this.api.requireRpc('cloudPlugins/current')
      }
      check()
      const value = await this.control.current(input.id, check)
      check(); firstScreenJsonBytes(value, this.control.input.limits.maxReplyBytes)
      return value
    })
  }

  /** Edit through the original actual idle window, or explicitly schedule its complete terminal drain and new claim.
   * @param request Approved id, exact operation, original edit and explicit application mode.
   * @param signal Observer cancellation before admission; admitted native work retains its actual settlement.
   * @returns Applied only after original native apply/re-audit, or acceptance requiring reconnect and read.
   */
  @Remote('change')
  change(request: PluginChangeRequest, signal: AbortSignal): Promise<PluginChangeResult> {
    signal.throwIfAborted(); this.inspect(); this.api.requireRpc('cloudPlugins/change')
    const invocation = this.invocation('change')
    const input = this.requests.change(invocation.request.args.request)
    void request
    return this.control.input.withConfigurationPeer(invocation.peer,
      async (binding, context, login, closeObservers, handoff) => {
        signal.throwIfAborted(); login(); this.assertCurrent()
        if (binding !== this.api.binding || context.root !== this.ctx.root) unavailable()
        if (input.mode === 'stop-and-apply') {
          const check = (): void => { login(); this.assertCurrent(); this.api.requireRpc('cloudPlugins/change') }
          const prepared = await this.control.prepareRebuild(input.id, input.version, input.operation, check)
          if (!prepared.accepted) throw prepared.error
          check()
          const result = this.control.input.scheduleRebuild(binding, handoff, async (owner, current) => {
            if (owner.root !== context.root) unavailable()
            return this.control.prepareRebuild(input.id, input.version, input.operation, () => { current(); this.control.assertCurrent() })
          })
          return { kind: 'accepted-rebuild', operationId: result.operationId }
        }
        const result = await this.control.input.withIdleConfiguration(binding, closeObservers, (owner, current) => {
          if (owner.root !== context.root) unavailable()
          return this.control.change(input.id, input.version, input.operation, () => { current(); login(); this.control.assertCurrent() })
        })
        if (!result.published) throw result.error
        const value: PluginChangeResult = { kind: 'applied', value: result.value.value,
          ...result.value.native === undefined ? {} : { native: result.value.native } }
        firstScreenJsonBytes(value, this.control.input.limits.maxReplyBytes)
        return value
      }, input.mode)
  }

  /** Require this same installed Remote and native writer owners, without granting public readiness. */
  assertCurrent(): void {
    this.ctx.fiber.assertActive(); this.api.assertInstalled(this.ctx); this.control.assertCurrent()
    if (original(this.ctx.get('cloudPlugins') ?? {}) !== original(this)
      || original(this.ctx.root.get('cloudPlugins') ?? {}) !== original(this)) unavailable()
  }

  /** Inspect exact generated strict Remote descriptors and original method registrations.
   * @returns Only the two actual authenticated unary endpoints.
   */
  inspect(): ExposureInventory {
    this.assertCurrent()
    const registered = this.typertRemote, markers = remoteMethods(this), typert = this.ctx.get('typert')
    if (registered.service !== original(this) || registered.serviceKey !== 'cloudPlugins'
      || registered.namespace !== 'cloudPlugins' || markers.length !== methods.length || typert === undefined) unavailable()
    for (const method of methods) {
      const marker = markers.find(value => value.method === method), descriptor = typert.local.get(`cloudPlugins/${method}`)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(original(this), method) !== CloudPluginService.prototype[method]
        || descriptor === undefined || descriptor.service !== 'cloudPlugins' || descriptor.namespace !== 'cloudPlugins'
        || descriptor.method !== method || (descriptor.implementation ?? method) !== method || (descriptor.mode ?? 'rpc') !== 'rpc'
        || descriptor.invocation.kind !== 'direct' || descriptor.parameters.length !== 1
        || descriptor.parameters[0]?.wire !== 'request' || descriptor.parameters[0].source !== 'json'
        || descriptor.parameters[0].codec.mode !== 'strict' || descriptor.result.mode !== 'strict'
        || descriptor.cancellation?.parameter !== 'signal') unavailable()
    }
    return { recipeVersion: this.api.binding.recipeVersion, rpcEndpoints: methods.map(method => ({
      endpoint: `cloudPlugins/${method}`, handlerId: 'native:cloudPlugins', guard: 'authenticated-account' })),
    streamEndpoints: [], exactFetchRoutes: [] }
  }

  private invocation(method: typeof methods[number]) {
    const invocation = this.ctx.invocation
    if (invocation?.service !== 'cloudPlugins' || invocation.request.namespace !== 'cloudPlugins'
      || invocation.request.method !== method || Object.keys(invocation.request.args).length !== 1
      || !Object.hasOwn(invocation.request.args, 'request')) unavailable()
    return invocation
  }
}
