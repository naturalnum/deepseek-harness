/** Read-only account views of original Loader and Agent preset declarations. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { readPluginInventory, type AgentPresetPluginGroup, type AgentPresetPluginRow,
  type PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory'
import { Remote, remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CloudAccountApi } from './account-service.ts'
import type { ModelKeyPeerConsumer } from './cloud-model-key.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { firstScreenNativeOwner, type FirstScreenNativeOwner } from './native-first-screen.ts'
import type { ExposureInventory, CloudPresetReference, CloudPresetComposition } from './types.ts'
export type { CloudPresetReference, CloudPresetComposition } from './types.ts'

/** Exact original peer consumer and existing first-screen limits; no new read authority. */
export interface CloudNativeSettingsPreparation extends ModelKeyPeerConsumer {
  readonly maxNativeInventoryEntries: number
  readonly maxCollectionItems: number
  readonly maxFrameBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Original account's read-only Loader inventory and preset summaries. */
    cloudNativeSettings: CloudNativeSettingsService
  }
}

const methods = ['inventory', 'presets', 'readPreset'] as const
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}
function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original account settings view is unavailable.')
}
function publicModule(value: string): string {
  // Native inventory may name private files. This account view admits only bare package and builtin identities.
  if (!/^(?:cordis:[\w.-]+|(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*)$/u.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) unavailable()
  return value
}
function publicMeta(meta: NonNullable<AgentPresetPluginRow['meta']>): NonNullable<AgentPresetPluginRow['meta']> {
  return { ...meta.title === undefined ? {} : { title: meta.title },
    ...meta.description === undefined ? {} : { description: meta.description },
    ...meta.icon === undefined ? {} : { icon: meta.icon } }
}
function publicRow(row: AgentPresetPluginRow): AgentPresetPluginRow {
  return { entryId: row.entryId, moduleName: publicModule(row.moduleName), enabled: row.enabled, fiberPhase: row.fiberPhase,
    ...row.meta === undefined ? {} : { meta: publicMeta(row.meta) } }
}
function publicPreset(preset: AgentPresetPluginGroup): AgentPresetPluginGroup {
  return { id: preset.id, isDefault: preset.isDefault, ...preset.name === undefined ? {} : { name: preset.name },
    ...preset.broken === undefined ? {} : { broken: 'The native preset composition is unavailable.' },
    rows: preset.rows.map(publicRow) }
}

/** Original registry readers behind exact account/Peer use and bounded public projections. */
export class CloudNativeSettingsService extends TypertRemoteService {
  private readonly owner: Context
  private readonly loader: FirstScreenNativeOwner
  private readonly presetsOwner: FirstScreenNativeOwner

  /**
   * @param ctx Original account Loader entry with its own Loader and preset registry.
   * @param api Same graph's installed exposure owner.
   * @param input Trusted login consumer and finite existing read budgets.
   */
  constructor(ctx: Context, private readonly api: CloudAccountApi, private readonly input: CloudNativeSettingsPreparation) {
    for (const limit of [input.maxNativeInventoryEntries, input.maxCollectionItems, input.maxFrameBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1) unavailable()
    }
    api.assertInstalled(ctx)
    if (ctx.get('cloudNativeSettings') !== undefined || ctx.root.get('cloudNativeSettings') !== undefined) unavailable()
    const loader = ctx.get('loader'), presets = ctx.get('agentPresets')
    if (!(loader instanceof Loader) || !(presets instanceof AgentPresetRegistry)) unavailable()
    const loaderOwner = firstScreenNativeOwner(ctx, 'loader', loader, input.maxNativeInventoryEntries)
    const presetsOwner = firstScreenNativeOwner(ctx, 'agentPresets', presets, input.maxNativeInventoryEntries)
    super(ctx, 'cloudNativeSettings', { namespace: 'cloudNativeSettings' })
    this.owner = ctx; this.loader = loaderOwner; this.presetsOwner = presetsOwner
    ctx.effect(() => () => { api.invalidate() }, 'pe-cloud-api: withdraw native settings read view')
  }

  /** Read the original account Loader and declared preset rows without manager authority.
   * @param signal Caller cancellation.
   * @returns Native DTO with public metadata and account management disabled.
   */
  @Remote('inventory')
  inventory(signal: AbortSignal): Promise<PluginInventorySnapshot> {
    return this.consume('inventory', signal, async () => {
      const inventory = await readPluginInventory(this.owner)
      this.collection(inventory.entries.length)
      this.collection(inventory.agentPresets?.length ?? 0)
      const groups = inventory.agentPresets?.map((preset) => { this.collection(preset.rows.length); return publicPreset(preset) })
      return { managementAvailable: false,
        entries: inventory.entries.map(entry => ({ entryId: entry.entryId, moduleName: publicModule(entry.moduleName),
          enabled: entry.enabled, fiberPhase: entry.fiberPhase,
          ...entry.meta === undefined ? {} : { meta: publicMeta(entry.meta) } })),
        ...groups === undefined ? {} : { agentPresets: groups } }
    })
  }

  /** Read actual declared preset display metadata, without selecting or composing a Session.
   * @param signal Caller cancellation.
   * @returns Original roster with private failure diagnostics removed.
   */
  @Remote('presets')
  presets(signal: AbortSignal): Promise<AgentPresetRoster> {
    return this.consume('presets', signal, async () => {
      const roster = await this.owner.agentPresets.remoteExportList()
      this.collection(roster.presets.length)
      return { presets: roster.presets.map(row => ({ id: row.id, isDefault: row.isDefault,
        ...row.name === undefined ? {} : { name: row.name },
        ...row.description === undefined ? {} : { description: row.description },
        ...row.broken === undefined ? {} : { broken: 'The native preset composition is unavailable.' } })) }
    })
  }

  /** Read one actual composition as public module/state rows, excluding raw YAML and config values.
   * @param request Exact preset identity from this account's roster.
   * @param signal Caller cancellation.
   * @returns Original preset summary; a missing identity rejects without revealing other resources.
   */
  @Remote('readPreset')
  readPreset(request: CloudPresetReference, signal: AbortSignal): Promise<CloudPresetComposition> {
    return this.consume('readPreset', signal, async () => {
      const raw = this.ctx.invocation?.request.args.request
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1
        || !('id' in raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id !== request.id) unavailable()
      firstScreenJsonBytes(raw, this.input.maxFrameBytes)
      const inventory = await readPluginInventory(this.owner), groups = inventory.agentPresets ?? []
      this.collection(inventory.entries.length); this.collection(groups.length)
      const selected = groups.find(row => row.id === request.id)
      if (selected === undefined) throw new CloudApiError('cloud/forbidden', 'The preset is outside the current account roster.')
      this.collection(selected.rows.length)
      return publicPreset(selected)
    })
  }

  /** Require this service and both original provider registrations in the same account root. */
  assertCurrent(): void {
    this.owner.fiber.assertActive(); this.api.assertInstalled(this.owner)
    if (this.owner.get('peAccount') !== this.api.binding || this.owner.root.get('peAccount') !== this.api.binding
      || this.api.binding.lifetime.aborted || original(this.owner.get('cloudNativeSettings') ?? {}) !== original(this)
      || original(this.owner.root.get('cloudNativeSettings') ?? {}) !== original(this)) unavailable()
    for (const [key, expected] of [['loader', this.loader], ['agentPresets', this.presetsOwner]] as const) {
      const actual = this.owner.get(key)
      if (actual === undefined) unavailable()
      const fact = firstScreenNativeOwner(this.owner, key, actual, this.input.maxNativeInventoryEntries)
      if (fact.value !== expected.value || fact.fiber !== expected.fiber) unavailable()
    }
    let count = 0
    for (const entry of this.owner.loader.entries()) {
      if (++count > this.input.maxNativeInventoryEntries || entry.parent.tree.ctx.root !== this.owner.root) unavailable()
    }
  }

  /** Inspect exact concrete unary markers and generated strict cancellation descriptors.
   * @returns Only the three authenticated read endpoints.
   */
  inspect(): ExposureInventory {
    this.assertCurrent()
    const markers = remoteMethods(this), binding = this.typertRemote, typert = this.owner.get('typert')
    if (markers.length !== methods.length || binding.service !== original(this) || binding.serviceKey !== 'cloudNativeSettings'
      || binding.namespace !== 'cloudNativeSettings' || typert === undefined) unavailable()
    for (const method of methods) {
      const marker = markers.find(row => row.method === method), descriptor = typert.local.get(`cloudNativeSettings/${method}`)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(original(this), method) !== CloudNativeSettingsService.prototype[method]
        || descriptor === undefined || descriptor.service !== 'cloudNativeSettings' || descriptor.namespace !== 'cloudNativeSettings'
        || descriptor.method !== method || (descriptor.implementation ?? method) !== method || (descriptor.mode ?? 'rpc') !== 'rpc'
        || descriptor.invocation.kind !== 'direct' || descriptor.parameters.length !== (method === 'readPreset' ? 1 : 0)
        || method === 'readPreset' && (descriptor.parameters[0]?.wire !== 'request' || descriptor.parameters[0].source !== 'json'
          || descriptor.parameters[0].codec.mode !== 'strict') || descriptor.result.mode !== 'strict'
        || descriptor.cancellation?.parameter !== 'signal') unavailable()
    }
    return { recipeVersion: this.api.binding.recipeVersion,
      rpcEndpoints: methods.map(method => ({ endpoint: `cloudNativeSettings/${method}`, handlerId: 'native:cloudNativeSettings', guard: 'authenticated-account' })),
      streamEndpoints: [], exactFetchRoutes: [] }
  }

  private collection(count: number): void { if (count > this.input.maxCollectionItems) unavailable() }

  private consume<T>(method: typeof methods[number], signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    const control = AbortSignal.any([signal, this.api.binding.lifetime])
    control.throwIfAborted(); this.inspect(); this.api.requireRpc(`cloudNativeSettings/${method}`)
    const invocation = this.ctx.invocation
    if (invocation?.service !== 'cloudNativeSettings' || invocation.request.namespace !== 'cloudNativeSettings'
      || invocation.request.method !== method || Object.keys(invocation.request.args).length !== (method === 'readPreset' ? 1 : 0)
      || method === 'readPreset' && !Object.hasOwn(invocation.request.args, 'request')) unavailable()
    return this.input.withModelKeyPeerUse(invocation.peer, async (use, current) => {
      const check = (): void => {
        control.throwIfAborted(); current(); use.assertCurrent()
        if (use.binding !== this.api.binding || use.context.root !== this.owner.root) unavailable()
        this.api.assertInstalled(use.context); this.assertCurrent(); this.api.requireRpc(`cloudNativeSettings/${method}`)
      }
      check()
      const result = await read()
      check(); firstScreenJsonBytes(result, this.input.maxFrameBytes); check()
      return result
    })
  }
}
