/** Account admission over the original native preset registry and selection commit. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPresetDocument, AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { CloudApiError } from './errors.ts'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'

/** Shared Runtime checks over the exact account's approved native declarations. */
export interface NativePresetGuards {
  assertCurrent(): void
  /**
   * Map an explicitly approved historical inherited default without rewriting its declaration.
   * @param id Original native inherited default, never a selectedDefault override.
   * @returns Approved selectable deployment default or the unchanged approved default; rejects all other ids.
   */
  resolveDefault(id: string): string
  assertPreset(id: string | undefined, signal?: AbortSignal, selectable?: boolean): Promise<string>
  assertSelectCurrent(agent: Agent, id: string): void
  isSelectable(id: string): boolean
}

/** Original native service and its exact account-bound RPC inventory. */
export interface NativePresets {
  readonly value: AgentPresets
  inspect(): ExposureInventory
}

/**
 * Install one native registry; declarations, switching, settings and history stay native.
 * @param ctx Actual native registry Loader entry.
 * @param binding Original account generation.
 * @param assertCurrent Original business admission check.
 * @param policy Explicit account RPC selection.
 * @param guards Runtime-owned approved preset and original Agent checks.
 * @param maximum Existing native inventory visit budget.
 * @param config Original native registry configuration.
 * @param maxFrameBytes Complete native RPC result budget.
 * @returns Guarded original registry and selected RPC inventory.
 */
export function createNativePresets(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativePresetGuards, maximum: number,
  config: ConstructorParameters<typeof AgentPresets>[1], maxFrameBytes: number,
): NativePresets {
  const unavailable = (): never => { throw new CloudApiError('cloud/account-unavailable', 'The original account preset registry is unavailable.') }
  const installation: { value?: AgentPresets } = {}
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding
      || policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (installation.value !== undefined) {
      const value = ctx.get('agentPresets')
      if ((value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value) !== installation.value) unavailable()
    }
  }
  const admit = (method: 'list' | 'read' | 'select'): void => {
    installed(); assertCurrent(binding); guards.assertCurrent()
    const row = policy.requireRpc('agentPresets/' + method)
    if (row.handlerId !== 'native:agentPresets' || row.guard !== (method === 'select' ? 'account-session' : 'authenticated-account')) unavailable()
  }
  installed()
  class AccountPresets extends AgentPresets {
    override get defaultId(): string {
      return this.config.selectedDefault.get() ?? guards.resolveDefault(this.config.default)
    }

    protected override assertSelectionCurrent(agent: Agent, id: string): void {
      admit('select')
      guards.assertSelectCurrent(agent, id)
    }

    override async remoteExportList(): Promise<AgentPresetRoster> {
      admit('list')
      await guards.assertPreset(undefined, binding.lifetime, true)
      admit('list')
      const value = await super.remoteExportList()
      admit('list')
      const result = { presets: value.presets.filter(row => guards.isSelectable(row.id)) }
      firstScreenJsonBytes(result, maxFrameBytes)
      return result
    }

    override async readDocument(agentPreset: string): Promise<AgentPresetDocument> {
      admit('read')
      await guards.assertPreset(agentPreset, binding.lifetime)
      admit('read')
      const result = await super.readDocument(agentPreset)
      admit('read'); firstScreenJsonBytes(result, maxFrameBytes)
      return result
    }

    override async select(agent: Agent, agentPreset: string): Promise<string> {
      admit('select')
      await guards.assertPreset(agentPreset, binding.lifetime, true)
      admit('select'); guards.assertSelectCurrent(agent, agentPreset)
      const result = await super.select(agent, agentPreset)
      admit('select')
      return result
    }
  }
  const value = new AccountPresets(ctx, config)
  installation.value = value
  return { value, inspect() {
    installed()
    firstScreenNativeOwner(ctx, 'agentPresets', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'agentPresets' || remote.namespace !== 'agentPresets') unavailable()
    const rpc: ExposureInventory['rpcEndpoints'][number][] = []
    for (const [method, exported] of [['remoteExportList', 'list'], ['readDocument', 'read'], ['select', 'select']] as const) {
      const marker = markers.find(row => row.method === method), endpoint = 'agentPresets/' + exported
      if (marker === undefined || (marker.exportName ?? method) !== exported || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(value, method) !== Reflect.get(AccountPresets.prototype, method)) unavailable()
      if (policy.manifest.rpcEndpoints.some(row => row.endpoint === endpoint)) rpc.push({ endpoint,
        handlerId: 'native:agentPresets', guard: exported === 'select' ? 'account-session' : 'authenticated-account' })
    }
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: rpc, streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
