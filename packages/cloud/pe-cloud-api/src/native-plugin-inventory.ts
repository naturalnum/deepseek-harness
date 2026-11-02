/** Account admission around the original read-only Loader inventory. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import PluginInventoryGateway, { type PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { CloudApiError } from './errors.ts'

declare module '@deepseek-ai/cordis' { interface Context { pluginInventory: PluginInventoryGateway } }

/** Account-bound original inventory provider and its audited endpoint. */
export interface NativePluginInventory {
  readonly value: PluginInventoryGateway
  /** Recheck the original provider before exposing its endpoint. */
  inspect(): ExposureInventory
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original account plugin inventory is unavailable.')
}

// Diagnostics can contain private paths; inventory cards do not need icon bytes.
function publicMeta(meta: NonNullable<PluginInventorySnapshot['entries'][number]['meta']>) {
  return { ...meta.title === undefined ? {} : { title: meta.title },
    ...meta.description === undefined ? {} : { description: meta.description },
    ...meta.error === undefined ? {} : { error: 'Plugin metadata unavailable.' } }
}

/** Install the native Loader inventory without granting native manager write methods.
 * @param ctx Actual independent account Loader owner.
 * @param binding Original account generation.
 * @param assertCurrent Business-ready admission for that generation.
 * @param policy Original audited RPC selection.
 * @param maximum Existing native registration bound.
 * @param maxFrameBytes Existing result frame limit.
 * @returns The native provider and its bounded inspection.
 */
export function createNativePluginInventory(ctx: Context, binding: AccountBinding,
  assertCurrent: (binding: AccountBinding) => void, policy: ExposurePolicy,
  maximum: number, maxFrameBytes: number): NativePluginInventory {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) unavailable()
  const owner: { value?: PluginInventoryGateway } = {}
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The plugin inventory belongs to an ended account generation.')
    }
    if (policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (owner.value !== undefined) {
      const current = ctx.get('pluginInventory')
      const original: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
      if (original !== owner.value) unavailable()
    }
  }
  const admit = (): void => {
    installed(); assertCurrent(binding)
    const row = policy.requireRpc('pluginInventory/list')
    if (row.handlerId !== 'native:pluginInventory' || row.guard !== 'authenticated-account') unavailable()
  }
  installed()
  class AccountPluginInventory extends PluginInventoryGateway {
    override async list(): Promise<PluginInventorySnapshot> {
      admit()
      const native = await super.list()
      if (native.entries.length > maximum || (native.agentPresets?.length ?? 0) > maximum
        || native.agentPresets?.some(group => group.rows.length > maximum) === true) unavailable()
      // Conditions are raw Loader expressions and preset errors may contain private values.
      const result: PluginInventorySnapshot = { ...native,
        entries: native.entries.map(({ meta, ...row }) => ({ ...row, ...meta === undefined ? {} : { meta: publicMeta(meta) } })),
        ...native.agentPresets === undefined ? {} : { agentPresets: native.agentPresets.map(group => ({
          ...group, ...group.broken === undefined ? {} : { broken: 'Preset could not load.' },
          rows: group.rows.map(({ condition: _condition, meta, ...row }) =>
            ({ ...row, ...meta === undefined ? {} : { meta: publicMeta(meta) } })),
        })) },
      }
      firstScreenJsonBytes(result, maxFrameBytes)
      admit()
      return result
    }
  }
  const value = new AccountPluginInventory(ctx)
  owner.value = value
  return { value, inspect() {
    installed()
    firstScreenNativeOwner(ctx, 'pluginInventory', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'pluginInventory' || remote.namespace !== 'pluginInventory'
      || markers.length !== 1 || markers[0]?.method !== 'list' || (markers[0].exportName ?? 'list') !== 'list'
      || (markers[0].mode ?? 'rpc') !== 'rpc' || value.list !== AccountPluginInventory.prototype.list) unavailable()
    return { recipeVersion: binding.recipeVersion,
      rpcEndpoints: policy.manifest.rpcEndpoints.some(row => row.endpoint === 'pluginInventory/list')
        ? [{ endpoint: 'pluginInventory/list', handlerId: 'native:pluginInventory', guard: 'authenticated-account' }] : [],
      streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
