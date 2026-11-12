/** Account-native permission catalog over the original durable preset/command implementation. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import PermissionPresetService, { type Config as PermissionConfig, type PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/types'
import type { Session } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { CloudApiError } from './errors.ts'

/** Original preset service and its exact guarded catalog registration. */
export interface NativePermissions {
  readonly value: PermissionPresetService
  /** Check original native service/method identities without authorizing business use. */
  inspect(): ExposureInventory
}

const MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
type Mode = typeof MODES[number]

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original account permission service is unavailable.')
}

function supported(value: string): value is Mode { return MODES.some(mode => mode === value) }

function nativeApproval(mode: Mode): ApprovalPolicy { return mode === 'danger-full-access' ? 'never' : 'ask' }

/**
 * Construct native permission controls only over the original enforcing provider pair.
 * Read-only and Workspace Write retain native interactive approval; Full access
 * retains native approval never inside the account execution world and its quota.
 * @param ctx Original account Loader fiber.
 * @param binding Exact installed generation.
 * @param assertCurrent Original account business admission check.
 * @param policy Exact audited account exposure.
 * @param maximum Existing native registry inventory bound.
 * @param config Explicit native three-preset configuration, including its native volatile default.
 * @param maxFrameBytes Existing native first-screen result bound.
 * @param assertEnforcement Recheck the actual issued execution port and Files enforcement from the same flag.
 * @param assertCanSwitch Refuse changes while original command/service/descendant work still owns prior permissions.
 * @returns Original native preset service and bounded RPC inventory.
 */
export function createNativePermissions(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, maximum: number, config: PermissionConfig, maxFrameBytes: number,
  assertEnforcement: () => void, assertCanSwitch: (session: Session, mode: Mode) => void,
): NativePermissions {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1
    || Object.keys(config.presets).length !== MODES.length) unavailable()
  for (const mode of MODES) {
    const spec = config.presets[mode]
    if (spec?.sandbox !== mode || spec.approval !== nativeApproval(mode)) unavailable()
  }
  const originalService: { value?: PermissionPresetService } = {}
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The permission service belongs to an ended account generation.')
    }
    if (policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    assertEnforcement()
    if (originalService.value !== undefined) {
      const current = ctx.get('permissionPresets')
      const original: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
      if (original !== originalService.value) unavailable()
    }
  }
  const admit = (): void => {
    installed(); assertCurrent(binding)
    const row = policy.requireRpc('permissionPresets/catalog')
    if (row.handlerId !== 'native:permissionPresets' || row.guard !== 'authenticated-account') unavailable()
  }
  installed()
  class AccountPermissions extends PermissionPresetService {
    protected override assertCanSwitch(session: Session, name: string): void {
      installed()
      if (!supported(name) || ctx.get('sessions')?.get(session.id) !== session) {
        throw new CloudApiError('cloud/forbidden', 'Permission changes require the original Session in this account.')
      }
      assertCanSwitch(session, name)
    }

    override resolve(name: string): PresetSpec {
      if (!supported(name)) throw new CloudApiError('cloud/forbidden', 'This permission mode is not available in the account sandbox.')
      const result = super.resolve(name)
      if (result.sandbox !== name || result.approval !== nativeApproval(name)) unavailable()
      return result
    }

    override catalog(): PermissionCatalog {
      admit()
      const result = super.catalog()
      if (!supported(result.defaultPreset) || result.options.length !== MODES.length
        || result.defaultOptions.length !== MODES.length || result.options.some(row => !supported(row.value))
        || result.defaultOptions.some(row => !supported(row.value))) unavailable()
      firstScreenJsonBytes(result, maxFrameBytes)
      admit()
      return result
    }

    override set(session: Session, name: string): void {
      admit()
      if (ctx.get('sessions')?.get(session.id) !== session) {
        throw new CloudApiError('cloud/forbidden', 'Permission changes require the original Session in this account.')
      }
      this.resolve(name)
      super.set(session, name)
    }

    override registerAuto(_admit: () => void): () => Promise<void> {
      throw new CloudApiError('cloud/forbidden', 'Automatic full-access review is not enabled in this account sandbox.')
    }
  }
  const value = new AccountPermissions(ctx, config)
  originalService.value = value
  return { value, inspect() {
    installed()
    firstScreenNativeOwner(ctx, 'permissionPresets', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'permissionPresets' || remote.namespace !== 'permissionPresets'
      || markers.length > maximum) unavailable()
    const matches = markers.filter(marker => marker.method === 'catalog'), marker = matches[0]
    if (matches.length !== 1 || marker === undefined || (marker.exportName ?? 'catalog') !== 'catalog'
      || markers.filter(row => (row.exportName ?? row.method) === 'catalog').length !== 1
      || (marker.mode ?? 'rpc') !== 'rpc' || value.catalog !== AccountPermissions.prototype.catalog) unavailable()
    for (const method of ['set', 'resolve', 'registerAuto', 'assertCanSwitch'] as const) {
      if (Reflect.get(value, method) !== Reflect.get(AccountPermissions.prototype, method)) unavailable()
    }
    return { recipeVersion: binding.recipeVersion,
      rpcEndpoints: policy.manifest.rpcEndpoints.some(row => row.endpoint === 'permissionPresets/catalog')
        ? [{ endpoint: 'permissionPresets/catalog', handlerId: 'native:permissionPresets', guard: 'authenticated-account' }] : [],
      streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
