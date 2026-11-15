/** Exact implementation identity comparison for the original mounted account inventory. */
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { EndpointExposure } from './types.ts'

type Descriptor = NonNullable<ReturnType<Context['typert']['local']['get']>>

/**
 * Match one inspected endpoint to its actual Typert implementation.
 * @param row Actual installed inventory row, independently audited by its provider.
 * @param mode Original registry iteration mode.
 * @param descriptor Actual registered Typert method description.
 * @returns Whether the original Native relation or the sole approved Cloud management tuple matches.
 */
export function inventoryMethodMatches(row: EndpointExposure, mode: 'rpc' | 'stream', descriptor: Descriptor): boolean {
  const service = row.handlerId.startsWith('native:') ? row.handlerId.slice('native:'.length)
    : mode === 'rpc' && row.endpoint === 'cloudRemoteServers/action' && row.handlerId === 'cloud:remote-servers'
      && row.guard === 'authenticated-account' ? 'cloudRemoteServers' : undefined
  if (service === undefined) return false
  const separator = row.endpoint.indexOf('/'), namespace = row.endpoint.slice(0, separator)
  const method = row.endpoint.slice(separator + 1)
  return descriptor.service === service && descriptor.namespace === namespace && descriptor.method === method
    && (descriptor.implementation ?? descriptor.method) === method && (descriptor.mode ?? 'rpc') === mode
}

/** Read the original Native proxy target without narrowing or choosing fallback policy.
 * @param value Borrowed Native value; its caller retains ownership and interpretation.
 * @returns The original target, or undefined for a value with no Native proxy target.
 */
export function nativeOriginal(value: object): unknown { return Reflect.get(value, symbols.original) }

/** Iterate fibers belonging to this account before charging its existing audit budget.
 * @param ctx Original account Context.
 * @param consume Charge one same-account runtime or fiber; refusal aborts iteration.
 * @returns Original fibers, including inactive owners so callers retain their existing state checks.
 */
export function* nativeAccountFibers(ctx: Context, consume: () => void): Iterable<Fiber> {
  for (const runtime of ctx.registry.values()) {
    let charged = false
    for (const fiber of runtime.fibers) {
      if (fiber.ctx.root !== ctx.root) continue
      if (!charged) { consume(); charged = true }
      consume()
      yield fiber
    }
  }
}

/** Read the original Loader entry's current module for the account audit.
 * @param entry Borrowed Native entry; the caller retains readiness and admission checks.
 * @returns Its current Native module without copying or resolving it.
 */
export function nativeEntryModule(entry: Entry | undefined): Entry['moduleNamespace'] { return entry?.moduleNamespace }

/** Read the original Loader entry's current id for the account audit.
 * @param entry Borrowed Native entry; the caller retains readiness and admission checks.
 * @returns Its current Native id without copying or resolving it.
 */
export function nativeEntryId(entry: Entry): Entry['options']['id'] { return entry.options.id }

/** Read the original Loader entry's current name for the account audit.
 * @param entry Borrowed Native entry; the caller retains readiness and admission checks.
 * @returns Its current Native name without copying or resolving it.
 */
export function nativeEntryName(entry: Entry): Entry['options']['name'] { return entry.options.name }

/** Read the original Loader entry's current config for the account audit.
 * @param entry Borrowed Native entry; the caller retains readiness and admission checks.
 * @returns Its current Native config without copying or resolving it.
 */
export function nativeEntryConfig(entry: Entry): Entry['options']['config'] { return entry.options.config }

/** Read the original Loader entry's current disabled for the account audit.
 * @param entry Borrowed Native entry; the caller retains readiness and admission checks.
 * @returns Its current Native disabled without copying or resolving it.
 */
export function nativeEntryDisabled(entry: Entry): Entry['disabled'] { return entry.disabled }

/** Read the original Loader entry's current options for the account audit.
 * @param entry Borrowed Native entry; the caller retains readiness and admission checks.
 * @returns Its current Native options without copying or resolving it.
 */
export function nativeEntryOptions(entry: Entry): Readonly<Entry['options']> { return entry.options }

/** Read the fiber currently stored on a Loader entry.
 * @param entry Original Native entry, or absence during lookup.
 * @returns The same stored fiber; this does not create or canonicalize an owner.
 */
export function nativeLoaderFiber(entry: Entry | undefined): Entry['fiber'] { return entry?.fiber }

/** Read a Native fiber's installed callback identity.
 * @param fiber Original Native fiber, or absence before activation.
 * @returns The original callback, or undefined without a runtime.
 */
export function nativeCallback(fiber: Fiber | undefined): NonNullable<Fiber['runtime']>['callback'] | undefined {
  return fiber?.runtime?.callback
}

/** Read the schema installed on a Native runtime.
 * @param fiber Original Native fiber, or absence before activation.
 * @returns The actual schema, or undefined without one.
 */
export function nativeConfigSchema(fiber: Fiber | undefined): NonNullable<Fiber['runtime']>['Config'] | undefined {
  return fiber?.runtime?.Config
}

/** Resolve a module through the entry's original profile tree.
 * @param entry Actual Native Loader entry.
 * @param name Exact module name selected by the caller's existing checks.
 * @returns The Native import promise; the caller rechecks after awaiting.
 */
export function nativeImport(entry: Entry, name: string): ReturnType<Entry['parent']['tree']['import']> {
  return entry.parent.tree.import(name)
}

/** Read the profile tree's actual resolution base URL.
 * @param entry Original Native entry.
 * @returns The current base URL, without a second resolution owner.
 */
export function nativeEntryBaseUrl(entry: Entry): Entry['parent']['tree']['ctx']['baseUrl'] { return entry.parent.tree.ctx.baseUrl }

/** Read the profile tree owner's actual Loader entry id.
 * @param entry Original Native child entry.
 * @returns Its tree owner's id, or undefined when the owner has no entry.
 */
export function nativeTreeOwnerId(entry: Entry): string | undefined { return entry.parent.tree.ctx.fiber.entry?.id }

/** Dereference an original Native logger fiber reference for cleanup ownership comparison.
 * @param reference Original weak reference from the Native logger.
 * @returns The live original fiber, or undefined after release.
 */
export function nativeLoggedFiber(reference: WeakRef<Fiber> | undefined): Fiber | undefined { return reference?.deref() }

export { nativeFiberProvisions, nativeProvision } from '@deepseek-ai/dsh-pe-cloud-runtime/account'
