/** Original WorkspaceFiles registration and bounded provider/Remote inventory checks. */
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from './errors.ts'
import type { ExposureInventory } from './types.ts'

const dependencies = ['fs', 'sandboxPolicy', 'sessions', 'typert'] as const
type NativeFileKey = typeof dependencies[number] | 'workspaceFiles'
interface Registration { readonly value: object; readonly fiber: Fiber }

/** Native instance and its actual declarations; no file implementation or independent queue. */
export interface NativeWorkspaceFiles {
  readonly value: WorkspaceFiles
  /** Recheck the captured graph, sole native registration, and all original injected providers. */
  assertCurrent(): void
  /** Read every original Remote marker, including stream mode; publishes no readiness. */
  inspect(): ExposureInventory
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original WorkspaceFiles registration or provider is unavailable.')
}

/**
 * Construct the unchanged native service in its real Loader fiber after its complete inject list is ready.
 * @param ctx Original WorkspaceFiles Loader scope; construction does not publish account ready.
 * @param binding Original graph binding.
 * @param current API owner's original mount/current check, independent of business publication.
 * @param maximum Positive finite bound for actual registry and Remote marker inspection.
 * @param config Original resolved native deployment caps.
 * @returns The native service and bounded auditing functions; native methods retain all I/O and stream ownership.
 */
export function createNativeWorkspaceFiles(
  ctx: Context, binding: AccountBinding, current: () => void,
  maximum: number, config: ConstructorParameters<typeof WorkspaceFiles>[1],
): NativeWorkspaceFiles {
  if (!Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  const graph = (): void => {
    current()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) unavailable()
  }
  const registrations = new Map<NativeFileKey, Registration>()
  const scan = (keys: readonly NativeFileKey[]): Map<NativeFileKey, Registration> => {
    graph()
    let remaining = maximum
    const consume = (): void => { if (--remaining < 0) unavailable() }
    const found = new Map<NativeFileKey, Registration>()
    for (const runtime of ctx.registry.values()) {
      consume()
      for (const fiber of runtime.fibers) {
        consume()
        if (fiber.ctx.root !== ctx.root || fiber.state !== FiberState.ACTIVE) continue
        for (const key of keys) {
          const installed = fiber.store?.[key], value: unknown = installed?.value
          if (installed?.fiber !== fiber) continue
          if (value === null || typeof value !== 'object' || found.has(key)) unavailable()
          found.set(key, { value: original(value), fiber })
        }
      }
    }
    for (const key of keys) {
      const installed = found.get(key), local = ctx.get(key), root = ctx.root.get(key)
      if (installed === undefined || local === undefined || root === undefined
        || original(local) !== installed.value || original(root) !== installed.value) unavailable()
      const expected = registrations.get(key)
      if (expected !== undefined && (expected.value !== installed.value || expected.fiber !== installed.fiber)) unavailable()
    }
    return found
  }
  for (const [key, installed] of scan(dependencies)) registrations.set(key, installed)
  if (ctx.get('workspaceFiles') !== undefined || ctx.root.get('workspaceFiles') !== undefined) {
    throw new CloudApiError('cloud/invalid-config', 'The account already has a WorkspaceFiles service.')
  }
  const value = new WorkspaceFiles(ctx, config)
  const installed = ctx.fiber.store?.workspaceFiles, registered: unknown = installed?.value
  if (installed?.fiber !== ctx.fiber || registered === null || typeof registered !== 'object'
    || original(registered) !== original(value)) unavailable()
  registrations.set('workspaceFiles', { value: original(value), fiber: ctx.fiber })
  const assertCurrent = (): void => {
    if (ctx.fiber.state !== FiberState.ACTIVE) unavailable()
    scan([...dependencies, 'workspaceFiles'])
  }
  return {
    value, assertCurrent,
    inspect(): ExposureInventory {
      assertCurrent()
      const remote = value.typertRemote, markers = remoteMethods(value)
      if (remote.service !== value || remote.serviceKey !== 'workspaceFiles' || remote.namespace !== 'workspaceFiles'
        || markers.length === 0 || markers.length > maximum) unavailable()
      const rpcEndpoints: ExposureInventory['rpcEndpoints'][number][] = []
      const streamEndpoints: ExposureInventory['streamEndpoints'][number][] = []
      const seen = new Set<string>()
      for (const marker of markers) {
        const method = marker.exportName ?? marker.method, mode = marker.mode ?? 'rpc'
        if (seen.has(method) || Reflect.get(value, marker.method) !== Reflect.get(WorkspaceFiles.prototype, marker.method)) unavailable()
        seen.add(method)
        const row = { endpoint: `workspaceFiles/${method}`, handlerId: 'native:workspaceFiles', guard: 'account-session' as const }
        if (mode === 'stream') streamEndpoints.push(row)
        else rpcEndpoints.push(row)
      }
      return { recipeVersion: binding.recipeVersion, rpcEndpoints, streamEndpoints, exactFetchRoutes: [] }
    },
  }
}
