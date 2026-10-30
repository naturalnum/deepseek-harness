/** Native Office provider identity and bounded Remote declaration audit. */
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import OfficeToPdf from '@deepseek-ai/dsh-office-to-pdf'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from './errors.ts'
import type { ExposureInventory } from './types.ts'

/** Exact native provider and its original account-graph admission. */
export interface NativeOffice {
  /** The original provider registered by its Loader fiber. */
  readonly value: OfficeToPdf
  /** Recheck the retained provider and its file dependencies. */
  assertCurrent(): void
  /** Audit the original Remote methods and admission declarations. */
  inspect(): ExposureInventory
}

function original(value: object | undefined): object | undefined {
  if (value === undefined) return undefined
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original Office provider is unavailable.')
}

/** Install and retain the native conversion owner in the account's existing filesystem graph.
 * @param ctx Original account Loader fiber.
 * @param binding Original account graph identity.
 * @param current Existing unpublished and installed-graph guard.
 * @param maximum Bound for native registry inspection.
 * @param config Native provider configuration.
 * @returns Original service and exact Remote inventory audit.
 */
export function createNativeOffice(ctx: Context, binding: AccountBinding, current: () => void, maximum: number,
  config: ConstructorParameters<typeof OfficeToPdf>[1]): NativeOffice {
  current()
  if (!Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  if (ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding || binding.lifetime.aborted
    || ctx.get('officeToPdf') !== undefined || ctx.root.get('officeToPdf') !== undefined) unavailable()
  const fs = ctx.get('fs'), files = ctx.get('workspaceFiles')
  if (fs === undefined || files === undefined || ctx.root.get('fs') === undefined || ctx.root.get('workspaceFiles') === undefined
    || original(fs) !== original(ctx.root.get('fs')) || original(files) !== original(ctx.root.get('workspaceFiles'))) unavailable()
  const value = new OfficeToPdf(ctx, config)
  const registrations = new Map<string, { value: object; fiber: Fiber }>()
  const scan = (): void => {
    let remaining = maximum
    const found = new Map<string, { value: object; fiber: Fiber }>()
    for (const runtime of ctx.registry.values()) {
      if (--remaining < 0) unavailable()
      for (const fiber of runtime.fibers) {
        if (--remaining < 0) unavailable()
        if (fiber.ctx.root !== ctx.root || fiber.state !== FiberState.ACTIVE) continue
        for (const key of ['fs', 'workspaceFiles', 'officeToPdf'] as const) {
          const entry = fiber.store?.[key], installed: unknown = entry?.value
          if (entry?.fiber !== fiber) continue
          if (installed === null || typeof installed !== 'object' || found.has(key)) unavailable()
          const unwrapped = original(installed)
          if (unwrapped === undefined) unavailable()
          found.set(key, { value: unwrapped, fiber })
        }
      }
    }
    for (const [key, expected] of [['fs', fs], ['workspaceFiles', files], ['officeToPdf', value]] as const) {
      const actual = found.get(key), retained = registrations.get(key)
      if (actual === undefined || actual.value !== original(expected)
        || retained !== undefined && (retained.value !== actual.value || retained.fiber !== actual.fiber)) unavailable()
      registrations.set(key, actual)
    }
  }
  const assertCurrent = (): void => {
    current()
    if (ctx.fiber.state !== FiberState.ACTIVE || binding.lifetime.aborted || ctx.get('peAccount') !== binding
      || ctx.root.get('peAccount') !== binding || ctx.get('officeToPdf') === undefined || ctx.root.get('officeToPdf') === undefined
      || original(ctx.get('officeToPdf')) !== original(value) || original(ctx.root.get('officeToPdf')) !== original(value)
      || ctx.get('fs') === undefined || ctx.root.get('fs') === undefined || original(ctx.get('fs')) !== original(fs)
      || original(ctx.root.get('fs')) !== original(fs) || ctx.get('workspaceFiles') === undefined
      || ctx.root.get('workspaceFiles') === undefined || original(ctx.get('workspaceFiles')) !== original(files)
      || original(ctx.root.get('workspaceFiles')) !== original(files)) unavailable()
    scan()
  }
  return { value, assertCurrent, inspect(): ExposureInventory {
    assertCurrent()
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'officeToPdf' || remote.namespace !== 'officeToPdf'
      || markers.length !== 2) unavailable()
    const entries = markers.map(marker => {
      const method = marker.exportName ?? marker.method
      if ((marker.mode ?? 'rpc') !== 'rpc' || !['render', 'generation'].includes(method)
        || Reflect.get(value, marker.method) !== Reflect.get(OfficeToPdf.prototype, marker.method)) unavailable()
      return { endpoint: `officeToPdf/${method}`, handlerId: 'native:officeToPdf',
        guard: method === 'render' ? 'account-session' as const : 'authenticated-account' as const }
    })
    if (new Set(entries.map(row => row.endpoint)).size !== 2) unavailable()
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: entries, streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
