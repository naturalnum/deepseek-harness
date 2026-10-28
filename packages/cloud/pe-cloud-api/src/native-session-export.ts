/** Account admission for the original streaming Session-log ZIP route. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { registerSessionLogExport, SESSION_LOG_EXPORT_PATH, type Config } from '@deepseek-ai/dsh-session-log-export'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { NativeSessionGuards } from './native.ts'
import type { ExposureInventory } from './types.ts'
import type { ExposurePolicy } from './exposure.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { CloudApiError } from './errors.ts'

/** Original route and command are owned by the account Loader fiber. */
export interface NativeSessionExport {
  /** Check the registered native route lifetime and original injected providers. */
  inspect(): ExposureInventory
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The account Session export is unavailable.')
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

/**
 * Register native Session export after account/project admission, preserving native ZIP streaming and cleanup.
 * @param ctx Original account Loader entry; it owns the command and exact Fetch route.
 * @param binding Exact installed account generation.
 * @param assertCurrent Original account business admission.
 * @param policy Reviewed exact GET/HEAD route declarations.
 * @param guards Shared native Session/project validation.
 * @param maximum Existing native provider inventory limit.
 * @param config Original native export configuration.
 * @returns Registration inspection; it grants neither a path nor a login identity.
 */
export function createNativeSessionExport(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number, config: Config,
): NativeSessionExport {
  const dependencies = ['connection', 'commands', 'sessionQuery', 'sessionPersistence', 'attachments', 'sessions'] as const
  const identities = new Map<string, object>()
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('The account Session-export registration ended.')) }, 'account Session export lifetime')
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding
      || policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    for (const key of dependencies) {
      const value = ctx.get(key), root = ctx.root.get(key)
      if (value === undefined || root === undefined || original(value) !== original(root)) unavailable()
      const captured = identities.get(key)
      if (captured !== undefined && original(value) !== captured) unavailable()
    }
  }
  installed()
  for (const key of dependencies) {
    const value = ctx.get(key)
    if (value === undefined) unavailable()
    identities.set(key, original(value))
  }
  const admit = (method: string): void => {
    installed()
    assertCurrent(binding)
    const row = policy.requireFetch(method, SESSION_LOG_EXPORT_PATH)
    if (row.handlerId !== 'native:sessionLogDownload' || row.guard !== 'account-session') unavailable()
  }
  const registration = registerSessionLogExport(ctx, config, async (sessionId, request) => {
    const signal = AbortSignal.any([request.signal, binding.lifetime, lifetime.signal])
    signal.throwIfAborted()
    admit(request.method)
    await guards.assertSessionProject(sessionId)
    signal.throwIfAborted()
    admit(request.method)
    return signal
  })
  return { inspect() {
    installed()
    registration()
    firstScreenNativeOwner(ctx, 'connection', ctx.connection, maximum)
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [],
      exactFetchRoutes: ['GET', 'HEAD'].filter(method => policy.manifest.exactFetchRoutes
        .some(row => row.method === method && row.path === SESSION_LOG_EXPORT_PATH))
        .map(method => ({ method, path: SESSION_LOG_EXPORT_PATH, handlerId: 'native:sessionLogDownload', guard: 'account-session' })) }
  } }
}
